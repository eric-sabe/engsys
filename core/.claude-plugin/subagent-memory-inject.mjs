#!/usr/bin/env node
// subagent-memory-inject.mjs — SubagentStart hook for the engsys core PLUGIN: push the memory
// brief (core/scripts/memory-brief.mjs) into a subagent's context before it starts.
// Design: docs/memory-spec.md §6, §12 (verified runtime facts), §13 (tests).
//
// FAIL-OPEN BY DESIGN (spec §6): any error, any timeout, or an empty brief all produce the exact
// same output, `{}` — this hook NEVER blocks a dispatch and NEVER throws into the harness. It is
// deliberately kept separate from any enforcement hook (e.g. singleton-write-guard.mjs), which
// fails CLOSED; this one does the opposite on purpose.
//
// SubagentStart's `additionalContext` is delivered to the subagent as a SYSTEM-role reminder
// (§12) — the reason memory-brief.mjs only ever renders Class A text plus Class B STRUCTURED
// pointers here. See the security note at the top of memory-brief.mjs for the full argument; this
// file's only job is to get that already-safe text (or nothing) into the hook's stdout, log the
// injection, and never make a network call.
//
// Input shape: Claude Code's SubagentStart hook payload is not fully pinned down across versions,
// so every field is read defensively with multiple candidate paths, and a missing/odd shape
// degrades to "no agent_type / no prompt" rather than throwing — memory-brief.mjs still returns a
// reasonable (if less targeted) brief, or the empty one.
//
// Logging: `{ts, agent_type, lesson_keys, pointer_keys, bytes, ms}` appended to
// `<cacheDir>/injections.jsonl` (docs/memory-spec.md §3.3, §6). A logging failure never affects
// the hook's output.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHookInput, recordHookTelemetry } from '../lib/harness-io.mjs';
import { isMainEntry } from '../lib/is-main.mjs';
import { isValidPointerKey, resolveCacheDir } from '../lib/memory/index-db.mjs';
import { claimDispatch, noteDispatch } from './handback-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_BRIEF = path.resolve(HERE, '..', 'scripts', 'memory-brief.mjs');
const TIMEOUT_MS = 2000;
// engsys#290: ENGSYS_MEMORY_BRIEF_BUDGET_MS overrides TIMEOUT_MS, for tests and diagnostics only: a caller that checks
// the brief's content rather than its speed (the end-to-end tests, the xray self-test) and would otherwise fail whenever
// the host is loaded. Don't set it for real sessions: hooks.json gives this hook 5 s, so a budget above about 4.5 s
// trades this hook's own timeout (logged as spawn_failed) for a harness kill with no log line. Clamped to
// [MIN_SPAWN_MS, 60 s]; anything unparseable keeps TIMEOUT_MS.
const MAX_BUDGET_MS = 60_000;
// Below this, less budget remains than a bare `node` process typically needs just to start —
// spawning memory-brief anyway would only burn that startup cost en route to a guaranteed timeout.
const MIN_SPAWN_MS = 300;

const PENDING_TTL_MS = 30_000;

/** The hook's wall-clock budget: TIMEOUT_MS, or a valid ENGSYS_MEMORY_BRIEF_BUDGET_MS (engsys#290). */
export function briefBudgetMs(env = process.env) {
	const raw = env.ENGSYS_MEMORY_BRIEF_BUDGET_MS;
	if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return TIMEOUT_MS;
	return Math.min(MAX_BUDGET_MS, Math.max(MIN_SPAWN_MS, Number(raw.trim())));
}

function firstString(...candidates) {
	for (const c of candidates) if (typeof c === 'string' && c.length) return c;
	return null;
}

function bareAgent(agentType) {
	if (typeof agentType !== 'string' || !agentType) return '';
	const parts = agentType.split(':');
	return parts[parts.length - 1];
}

function safeIdToken(s) {
	return String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'none';
}

/** Extract repo-relative file path hints mentioned in a task prompt (#142). Excludes URLs and
 * bare words without a `/` + extension. */
export function extractPathsFromPrompt(prompt) {
	if (typeof prompt !== 'string' || !prompt) return [];
	const withoutUrls = prompt.replace(/https?:\/\/\S+/g, ' ');
	const matches = withoutUrls.match(/(?:^|[\s`"'([{])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,10})(?=$|[\s`"')\]}:,;])/g) ?? [];
	const seen = new Set();
	for (const raw of matches) {
		const cleaned = raw.replace(/^[\s`"'([{]+/, '').replace(/^\.\//, '');
		if (cleaned && !cleaned.startsWith('..') && !cleaned.includes('//')) seen.add(cleaned);
	}
	return [...seen];
}

/** Extract a candidate worktree path from `tool_input` (`worktree`/`cwd`) or an absolute path in
 * `prompt` (#142). The candidate is only trusted later if `sharesGitCommonDir(parentCwd, candidate)`
 * confirms it belongs to the same repository. */
export function extractWorktreeFromInput(toolInput, prompt = '') {
	const direct = firstString(toolInput?.worktree, toolInput?.cwd);
	if (direct) return direct;
	if (typeof prompt !== 'string' || !prompt) return null;
	const absMatches = prompt.match(/(?:^|[\s`"'(])(\/[A-Za-z0-9_./-]+)(?=$|[\s`"')\]}:,;])/g) ?? [];
	for (const raw of absMatches) {
		const p = raw.replace(/^[\s`"'(]+/, '').replace(/\/+$/, '');
		if (p && p.split('/').length >= 3) {
			try {
				if (fs.statSync(p).isDirectory()) return p;
			} catch { /* ignore non-existent paths */ }
		}
	}
	return null;
}

const GIT_CALL_OPTS = { encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] };

/**
 * Resolve `candidateDir` to its registered git worktree root iff it is listed in
 * `git -C trustedRepoDir worktree list --porcelain` (#142). Never runs `git -C` on
 * `candidateDir` itself, preventing an unverified path from triggering a repo-local git config.
 */
export function resolveRegisteredWorktree(trustedRepoDir, candidateDir, { exec = execFileSync } = {}) {
	if (!trustedRepoDir || !candidateDir) return null;
	let realCandidate;
	try {
		realCandidate = fs.realpathSync(candidateDir);
	} catch {
		return null;
	}
	try {
		const out = exec('git', ['-C', trustedRepoDir, 'worktree', 'list', '--porcelain'], GIT_CALL_OPTS);
		for (const line of out.split('\n')) {
			if (!line.startsWith('worktree ')) continue;
			const wtPath = line.slice('worktree '.length).trim();
			if (!wtPath) continue;
			let realWt;
			try {
				realWt = fs.realpathSync(wtPath);
			} catch {
				continue;
			}
			if (realCandidate === realWt || realCandidate.startsWith(realWt + path.sep)) {
				return realWt;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/** True iff `dirB` is a registered worktree of `dirA` (#142). Prevents a prompt-mentioned path
 * from pointing `resolveTouchedPaths` at an unrelated repo or running `git -C` on an untrusted dir. */
export function sharesGitCommonDir(dirA, dirB, { exec = execFileSync } = {}) {
	return Boolean(resolveRegisteredWorktree(dirA, dirB, { exec }));
}

function sweepExpiredDispatches(pendingDir, nowMs) {
	let files;
	try { files = fs.readdirSync(pendingDir); } catch { return; }
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		const p = path.join(pendingDir, f);
		try {
			const st = fs.statSync(p);
			if (nowMs - st.mtimeMs > PENDING_TTL_MS) fs.rmSync(p, { force: true });
		} catch { /* best effort */ }
	}
}

/** Stash a short-lived pending dispatch record at `PreToolUse` (`Agent|Task`) so the subsequent
 * `SubagentStart` hook can recover the task prompt, prompt path hints, and target worktree (#142). */
export function recordPendingDispatch(input, { cwd, now = () => Date.now(), cacheDir: knownCacheDir } = {}) {
	try {
		const cacheDir = knownCacheDir !== undefined ? knownCacheDir : resolveCacheDir(cwd);
		if (!cacheDir) return null;
		const pendingDir = path.join(cacheDir, 'pending-dispatch');
		fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(pendingDir, 0o700); } catch { /* best effort */ }
		const ts = now();
		sweepExpiredDispatches(pendingDir, ts);

		const toolInput = input?.tool_input ?? {};
		const sessionId = safeIdToken(firstString(input?.session_id) ?? 'default');
		const rawAgent = firstString(toolInput?.subagent_type, toolInput?.agent_type, input?.agent_type) ?? 'any';
		const agentKey = safeIdToken(bareAgent(rawAgent) || 'any');
		const prompt = [firstString(toolInput?.description), firstString(toolInput?.prompt)].filter(Boolean).join('\n').slice(0, 8192);
		const promptPaths = extractPathsFromPrompt(prompt);
		const worktree = extractWorktreeFromInput(toolInput, prompt);
		// engsys#262: a TEAMMATE dispatch (`tool_input.name`) reaches SubagentStart with its teammate
		// name as `agent_type` (e.g. `bert-p2`), not the dispatched `subagent_type` — the record keeps
		// both, so SubagentStart can match it by name and recover the real agent type.
		const name = firstString(toolInput?.name);
		const record = { ts, sessionId, agentKey, agentType: rawAgent === 'any' ? null : rawAgent, name: name ? safeIdToken(name) : null, prompt, promptPaths, worktree };
		const file = path.join(pendingDir, `${sessionId}--${agentKey}--${ts}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
		fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
		try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
		return file;
	} catch {
		return null;
	}
}

/** Pop the pending dispatch for this SubagentStart (#142, engsys#262), first match wins:
 *   1. the oldest record whose teammate `name` equals `agent_type` — a teammate dispatch, where
 *      SubagentStart reports the teammate name (`bert-p2`) instead of the type (`engsys:bert`). Checked
 *      FIRST, so a teammate named like a bare type (`isabelle`, dispatched as nyx) can't take the real
 *      isabelle dispatch's record by type;
 *   2. the oldest record filed under `(session_id, bareAgent(agent_type))` — a plain dispatch, where
 *      SubagentStart's `agent_type` IS the dispatched `subagent_type`; an untyped (`any`) record too
 *      when the session holds no typed one, or when the start carries no agent type.
 * Nothing else: a start that matches neither gets no record (and so no prompt), never another
 * dispatch's — parallel dispatches would otherwise swap prompts, paths and worktrees.
 * Returns the parsed record plus `matchedBy` (`'name'` | `'type'`). */
export function consumePendingDispatch(input, { cwd, now = () => Date.now(), cacheDir: knownCacheDir } = {}) {
	try {
		const cacheDir = knownCacheDir !== undefined ? knownCacheDir : resolveCacheDir(cwd);
		if (!cacheDir) return null;
		const pendingDir = path.join(cacheDir, 'pending-dispatch');
		const ts = now();
		sweepExpiredDispatches(pendingDir, ts);
		let files;
		try { files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
		if (files.length === 0) return null;

		const sessionId = safeIdToken(firstString(input?.session_id) ?? 'default');
		const startAgent = extractAgentType(input);
		const agentKey = safeIdToken(bareAgent(startAgent) || 'any');
		const sessionFiles = files.filter((f) => f.startsWith(`${sessionId}--`));
		const read = (f) => {
			try { return JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf8')); } catch { return null; }
		};
		const live = (parsed) => parsed && ts - (parsed.ts ?? 0) <= PENDING_TTL_MS;
		const take = (f, parsed, matchedBy) => {
			try { fs.rmSync(path.join(pendingDir, f), { force: true }); } catch { /* best effort */ }
			return live(parsed) ? { ...parsed, matchedBy } : null;
		};

		// A teammate start reports its bare teammate name; a real typed start reports a namespaced type
		// (`engsys:nyx`). Only a bare start may match by name: otherwise a teammate named `engsys:nyx` (or
		// `engsys_nyx`, which safeIdToken produces from it) would capture the real Nyx start, which would then
		// adopt that teammate's dispatched type and lose Nyx's Class B exclusion (#262 re-review).
		const startName = startAgent && !startAgent.includes(':') ? safeIdToken(startAgent) : null;
		if (startName) {
			const byName = sessionFiles
				.map((f) => ({ f, parsed: read(f) }))
				.filter(({ parsed }) => live(parsed) && parsed.name === startName)
				.sort((x, y) => x.parsed.ts - y.parsed.ts)[0];
			if (byName) return take(byName.f, byName.parsed, 'name');
		}

		const hasTypedForSession = sessionFiles.some((f) => !f.startsWith(`${sessionId}--any--`));
		const prefixes = agentKey === 'any' || !hasTypedForSession
			? [`${sessionId}--${agentKey}--`, `${sessionId}--any--`]
			: [`${sessionId}--${agentKey}--`];
		for (const prefix of prefixes) {
			const match = sessionFiles.find((f) => f.startsWith(prefix));
			if (!match) continue;
			const hit = take(match, read(match), 'type');
			if (hit) return hit;
		}
		return null;
	} catch {
		return null;
	}
}

/** Best-effort `agent_type` extraction from a SubagentStart payload whose exact shape may vary. */
// Verified against the Claude Code 2.1.285 binary (docs/memory-spec.md §12, engsys#140 W1): a
// SubagentStart payload is `{...base, hook_event_name, agent_id, agent_type}` — `base` carries
// `cwd` (read separately in main()). There is NO task-prompt field at this event; PreToolUse
// (`subagent-memory-inject.mjs pre-agent`) stashes a short-lived pending dispatch record so
// SubagentStart can recover the prompt, prompt path hints, and target worktree (#142).
export function extractAgentType(input) {
	return firstString(input?.agent_type);
}

/** engsys v2.0.1 (M5, round 2 F7): in pre-agent (PreToolUse `Agent|Task`) mode, the Class B
 * exclusion check must key off the agent ABOUT TO BE DISPATCHED (`tool_input.subagent_type`/
 * `tool_input.agent_type`), never `input.agent_type`, which at this event is the CALLING
 * session's own agent type. Using the caller would let a non-excluded session (e.g. the
 * orchestrator) dispatch an excluded agent (Nyx, any `security: true` agent) and have the
 * exclusion check pass on the wrong identity.
 *
 * Round 2 hardening:
 *   - parses `tool_input` through harness-io's `parseHookInput` (passed `rawStdin`, the exact
 *     bytes read from stdin) rather than this module re-deriving the shape itself — ONE place
 *     normalizes toolArgs/toolCall across harnesses, and this is that place's result, not a
 *     second guess at it;
 *   - trims and Unicode-NFKC-normalizes the target name (a homoglyph or an added combining mark
 *     could otherwise slip past an exact-string exclusion-set lookup downstream);
 *   - fails closed (returns `''`) when `tool_input.subagent_type` and `tool_input.agent_type`
 *     are BOTH present and DISAGREE — a dispatch payload asserting two different identities for
 *     the same field is itself a signal something is wrong, not a case to silently pick a winner
 *     on.
 * Fails closed throughout: an unresolvable target returns `''` (empty string), which callers
 * must treat as "unknown — exclude", never as "no agent — allow". */
export function extractTargetAgentType(input, { rawStdin = null } = {}) {
	// round 3 (F5): also strips Unicode `\p{Cf}` format characters (zero-width space/joiner, bidi
	// control marks, …) — NFKC alone does not remove these, and one hiding inside an otherwise
	// normal-looking name could survive an exact-string exclusion-set lookup downstream.
	// engsys#192: and `\p{Default_Ignorable_Code_Point}`, a superset that also covers non-Cf
	// invisibles such as U+034F COMBINING GRAPHEME JOINER, variation selectors and Hangul fillers.
	const normalize = (s) => (typeof s === 'string' ? s.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').trim() : '');
	// round 3 (F5): the subagent_type/agent_type DISAGREEMENT check compares BARE names (the
	// `engsys:` namespace prefix stripped) — `engsys:isabelle` vs `isabelle` is the same target
	// under a different spelling, not a conflict to fail closed on.
	const bare = (s) => {
		const parts = s.split(':');
		return parts[parts.length - 1].toLowerCase();
	};
	let toolInput = input?.tool_input;
	if (typeof rawStdin === 'string' && rawStdin.trim()) {
		try {
			toolInput = parseHookInput(rawStdin, process.env).toolInput;
		} catch { /* fall back to input?.tool_input above */ }
	}
	toolInput = toolInput ?? {};
	const subagentType = normalize(toolInput.subagent_type);
	const agentTypeField = normalize(toolInput.agent_type);
	if (subagentType && agentTypeField && bare(subagentType) !== bare(agentTypeField)) {
		return ''; // disagree (even after namespace-stripping) -> fail closed, never guess
	}
	return subagentType || agentTypeField || '';
}

/** No verified prompt field exists at SubagentStart (see the note above) — reads `input.prompt`
 * only in case a future payload adds one; never guesses through a nested `tool_input`. */
export function extractPrompt(input) {
	return firstString(input?.prompt) ?? '';
}

/** Touched paths: an explicit list on the payload, else `git diff --name-only <base>` in `cwd`
 * when a worktree/repo is resolvable. `base` tries HEAD first (uncommitted work), then
 * `origin/main`. Never throws; an unresolvable repo yields []. */
export function resolveTouchedPaths(input, { cwd, exec = execFileSync } = {}) {
	if (Array.isArray(input?.touched_paths)) return input.touched_paths.filter((p) => typeof p === 'string');
	try {
		const out = exec('git', ['-C', cwd, 'diff', '--name-only', 'HEAD'], GIT_CALL_OPTS);
		const paths = out.split('\n').filter(Boolean);
		if (paths.length) return paths;
	} catch {
		/* no uncommitted changes, or not resolvable — fall through to the merge-base diff below */
	}
	try {
		// NOT `git diff --name-only origin/main` directly: on a stale/diverged checkout that would
		// also list every upstream commit the local branch doesn't have yet, anchoring lessons and
		// pointers to files this dispatch never touched. Diff against the MERGE-BASE instead, so
		// only this branch's own commits since it forked from origin/main are "touched".
		const base = exec('git', ['-C', cwd, 'merge-base', 'HEAD', 'origin/main'], GIT_CALL_OPTS).trim();
		if (!base) return [];
		const out = exec('git', ['-C', cwd, 'diff', '--name-only', base, 'HEAD'], GIT_CALL_OPTS);
		return out.split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

/** Run memory-brief.mjs --json as a child process with a hard wall-clock budget. Returns
 * `{ text, lessonKeys, pointerKeys, bytes }`, or null on ANY failure (non-zero exit, timeout,
 * spawn error, unparseable output) — all treated identically as "no brief". Never throws. */
export function runMemoryBrief({ agentType, startAgentType, prompt, touchedPaths, cwd, timeoutMs = TIMEOUT_MS, scriptPath = MEMORY_BRIEF, exec = execFileSync } = {}) {
	// The `=` form for every value that could itself start with `--` (a task prompt, a touched
	// path) — memory-brief.mjs's space-separated form would read such a value as the NEXT flag and
	// silently drop it (memory-brief.mjs's parseArgs doc comment has the full rationale).
	const args = [scriptPath, '--json', `--repo-root=${cwd}`];
	if (agentType) args.push(`--agent-type=${agentType}`);
	if (startAgentType && startAgentType !== agentType) args.push(`--start-agent-type=${startAgentType}`);
	// Truncated: one argv element over Linux's MAX_ARG_STRLEN (128 KiB) makes the spawn itself fail
	// with E2BIG — fails open to {} either way, but silently, for exactly the long, detailed task
	// prompts where a targeted brief would matter most. BM25 only needs a prefix of the prompt.
	if (prompt) args.push(`--prompt=${prompt.slice(0, 8192)}`);
	// Capped the same way as --prompt= above and for the same reason: a large refactor/rename
	// can list thousands of touched paths, and an uncapped join can itself blow past argv's
	// MAX_ARG_STRLEN (E2BIG) -- exactly the large-change case where a brief matters most.
	if (touchedPaths?.length) {
		let joined = '';
		for (const p of touchedPaths) {
			const next = joined ? `${joined},${p}` : p;
			// Buffer.byteLength, not .length — a non-ASCII filename's UTF-16 code-unit count
			// undercounts the UTF-8 byte size that actually matters against MAX_ARG_STRLEN
			// (round 4 nit).
			if (Buffer.byteLength(next, 'utf8') > 65536) break;
			joined = next;
		}
		if (joined) args.push(`--paths=${joined}`);
	}
	try {
		// process.execPath, not a bare 'node' resolved off PATH: a hook's PATH is whatever the
		// harness/shell gave it, which may not have the SAME node this hook itself is running
		// under (a different version, or none at all on a minimal PATH) — execPath is always
		// exactly the interpreter currently executing this file.
		const out = exec(process.execPath, args, {
			encoding: 'utf8',
			timeout: timeoutMs,
			killSignal: 'SIGKILL',
			env: { ...process.env, NODE_NO_WARNINGS: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const parsed = JSON.parse(out);
		if (typeof parsed?.text !== 'string') return null;
		return parsed;
	} catch {
		return null; // non-zero exit, timeout (ETIMEDOUT), spawn failure, or bad JSON — same outcome
	}
}

function logInjection(cacheDir, record) {
	try {
		if (!cacheDir) return;
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.appendFileSync(path.join(cacheDir, 'injections.jsonl'), `${JSON.stringify(record)}\n`);
	} catch {
		/* logging must never affect the hook's output */
	}
}

export async function main({ argv = process.argv.slice(2), stdin = process.stdin, now = () => Date.now(), write = (s) => process.stdout.write(s), defaultCwd = process.cwd() } = {}) {
	const t0 = now();
	let input = null;
	let rawStdin = '';
	try {
		for await (const chunk of stdin) rawStdin += chunk;
		input = JSON.parse(rawStdin);
	} catch {
		input = null;
	}
	// Claude Code reports the session directory as `cwd`, which in a monorepo can be a
	// subdirectory (e.g. packages/api) rather than the work-tree root. memory-brief.mjs's
	// Class A reads (git ls-tree/cat-file against docs/agent-lessons, the overlay, ADRs) and
	// resolveTouchedPaths' own top-level-relative paths both assume repoRoot IS the top level
	// — resolve it once here so every downstream git call agrees on the same root.
	const rawCwd = (typeof input?.cwd === 'string' && input.cwd) || defaultCwd;
	let cwd = rawCwd;
	try {
		const top = execFileSync('git', ['-C', rawCwd, 'rev-parse', '--show-toplevel'], GIT_CALL_OPTS).trim();
		if (top) cwd = top;
	} catch { /* not a repo, or git unavailable — keep rawCwd; memory-brief fails open from there */ }

	// engsys#290: the hook needs the cache dir up to twice (the pending record, then the log); resolve it once, on first
	// use, so a slow git costs its timeout once, not twice.
	let cacheDirMemo;
	const hookCacheDir = () => {
		if (cacheDirMemo === undefined) cacheDirMemo = resolveCacheDir(cwd);
		return cacheDirMemo;
	};

	// PreToolUse (`Agent|Task`) mode (#142): stash the dispatch prompt, prompt path hints, and any
	// target worktree path under `<cacheDir>/pending-dispatch/` so the immediately following
	// SubagentStart hook can consume it. Always fails open with `{}`.
	const isPreAgent = argv[0] === 'pre-agent' || input?.hook_event_name === 'PreToolUse' || input?.hookEventName === 'preToolUse';
	if (isPreAgent) {
		// engsys#286: the hand-back guard acts only on agents this session dispatched; tell it about this one first
		// (no git needed), whatever happens to the memory brief's own record below.
		if (input) noteDispatch(input, { now });
		if (input) recordPendingDispatch(input, { cwd, now, cacheDir: hookCacheDir() });
		recordHookTelemetry({
			hook: 'subagent-memory-inject',
			event: 'PreToolUse',
			decision: 'stashed',
			detail: `agent=${extractTargetAgentType(input, { rawStdin }) || 'unknown'}`,
		});
		if (!process.env.ENGSYS_HARNESS || process.env.ENGSYS_HARNESS === 'claude') {
			write('{}');
			return 0;
		}
	}

	// engsys v2.0.1 (M5): on a non-Claude harness, PreToolUse is the only dispatch-time hook, so a
	// brief may be built here too. The exclusion/selection decision must be keyed on the agent
	// ABOUT TO BE DISPATCHED (`tool_input.subagent_type`), never the calling session's own
	// `agent_type` — see `extractTargetAgentType`. Fails CLOSED on a MISSING/EMPTY target only (no
	// `subagent_type`/`agent_type` at all on `tool_input`): returns `{}` immediately rather than
	// falling through with an agentType of `null`/`'any'`, which `resolveExcludedAgents`/
	// `isClassBExcluded` would otherwise treat as "no agent to exclude" and hand Class B content
	// to. An UNRECOGNIZED (but non-empty) target still reaches the ordinary allow-unless-excluded
	// path below, same as any other agent name `isClassBExcluded` doesn't know — that's the
	// existing policy, not something this fix changes.
	let agentType = isPreAgent ? extractTargetAgentType(input, { rawStdin }) : extractAgentType(input);
	if (isPreAgent && !agentType) {
		write('{}');
		return 0;
	}

	// engsys#286: mark this agent as dispatched by this session (or not) FIRST, so a brief that overran the hook's own
	// timeout can't kill the hook before the mark is written (the guard would then skip a real agent). It is a cheap
	// file write, and it is kept out of the brief's budget: the budget clock (budgetStart) is moved on by exactly the
	// time the claim took.
	let budgetStart = t0;
	if (!isPreAgent && input) {
		const c0 = now();
		claimDispatch(input, { now });
		budgetStart = t0 + (now() - c0);
	}

	let briefText = '';
	let logKeys = { lesson_keys: [], pointer_keys: [], bytes: 0 };
	// Diagnostics for "the brief disappeared with no clear reason" (resolveTouchedPaths' own git
	// calls, and memory-brief's per-superseder `git show` calls inside buildBrief, both eat into
	// the same 2s budget `runMemoryBrief`'s timeout enforces) — distinguishes "never even tried"
	// from "tried and got nothing back" (almost always a timeout, since every other memory-brief
	// failure path is caught and logged there, not silently swallowed).
	let skippedBudget = false;
	let spawnFailed = false;
	let startAgentType = null;
	try {
		// cr review (round 2): on the non-Claude pre-agent path, `consumePendingDispatch` must look
		// up the record `recordPendingDispatch` filed under the TARGET identity (`agentType`,
		// resolved above) — not whatever `extractAgentType(input)` (the caller, or nothing, at this
		// event) would derive internally. Without this, the prefixes never matched and the pending
		// dispatch (prompt, prompt paths, worktree) was silently lost on every non-Claude harness.
		const lookupInput = isPreAgent && input ? { ...input, agent_type: agentType } : input;
		const pending = lookupInput ? consumePendingDispatch(lookupInput, { cwd, now, cacheDir: hookCacheDir() }) : null;
		// engsys#262: a teammate start reports its teammate name as agent_type; the record matched BY
		// that name carries the dispatched subagent_type, which is what lesson `roles` and the Class B
		// exclusion set are keyed on (a `nyx-221` teammate is still Nyx).
		// engsys#264: the start's own identity still goes to memory-brief, which excludes Class B if
		// EITHER identity is excluded — a bare excluded type (a project `nyx`) that matched a teammate
		// literally named `nyx` must not shed its exclusion by adopting that teammate's type.

		if (!isPreAgent && pending?.matchedBy === 'name' && typeof pending.agentType === 'string' && pending.agentType) {
			startAgentType = agentType;
			agentType = pending.agentType;
		}
		const prompt = extractPrompt(input) || pending?.prompt || '';
		let diffCwd = cwd;
		if (pending?.worktree) {
			const matchedWt = resolveRegisteredWorktree(cwd, pending.worktree);
			if (matchedWt) diffCwd = matchedWt;
		}
		const gitTouched = resolveTouchedPaths(input, { cwd: diffCwd });
		const touchedPaths = [...new Set([...gitTouched, ...(pending?.promptPaths ?? [])])];
		// Give memory-brief only what's LEFT of the 2s total budget after resolveTouchedPaths' own
		// (separately timed) git calls, so the two stages together can never exceed TIMEOUT_MS plus
		// node startup — not TIMEOUT_MS on top of whatever resolveTouchedPaths already spent. Below
		// MIN_SPAWN_MS there isn't even enough budget left for node's own startup, so the spawn is
		// SKIPPED outright (saves that startup cost too) rather than launched to a guaranteed timeout.
		const remainingMs = briefBudgetMs() - (now() - budgetStart);
		skippedBudget = remainingMs < MIN_SPAWN_MS;
		const result = skippedBudget ? null : runMemoryBrief({ agentType, startAgentType, prompt, touchedPaths, cwd: diffCwd, timeoutMs: remainingMs });
		spawnFailed = !skippedBudget && !result;
		if (result) {
			briefText = result.text ?? '';
			// engsys#140 Nyx F8: pointer_keys are re-validated against the same key allowlist
			// `validatePointerEvent` enforces before they're even logged — defense in depth; a key
			// that somehow reached here invalid is dropped from the log line, not just from the brief.
			const safePointerKeys = (result.pointerKeys ?? []).filter(isValidPointerKey);
			logKeys = { lesson_keys: result.lessonKeys ?? [], pointer_keys: safePointerKeys, bytes: result.bytes ?? Buffer.byteLength(briefText, 'utf8') };
		}
	} catch {
		briefText = '';
	}

	const elapsedMs = now() - t0;
	logInjection(hookCacheDir(), { ts: new Date(now()).toISOString(), agent_type: agentType, ...(startAgentType ? { start_agent_type: startAgentType } : {}), ...logKeys, ms: elapsedMs, skipped_budget: skippedBudget, spawn_failed: spawnFailed });
	recordHookTelemetry({
		hook: 'subagent-memory-inject',
		event: 'SubagentStart',
		decision: briefText ? 'context' : 'pass',
		bytes: logKeys.bytes || 0,
		ms: elapsedMs,
		detail: `agent=${agentType || 'any'} lessons=${(logKeys.lesson_keys || []).length} pointers=${(logKeys.pointer_keys || []).length}`,
	});

	if (!briefText) {
		write('{}');
		return 0;
	}
	write(JSON.stringify({ additionalContext: briefText, hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: briefText } }));
	return 0;
}

if (isMainEntry(import.meta.url)) {
	main()
		.then((code) => process.exit(code ?? 0))
		.catch(() => {
			// The absolute last line of defense: even a bug in main() above must still fail open.
			try { process.stdout.write('{}'); } catch { /* nothing left to do */ }
			process.exit(0);
		});
}
