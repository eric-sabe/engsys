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
import { isMainEntry } from '../lib/is-main.mjs';
import { isValidPointerKey, resolveCacheDir } from '../lib/memory/index-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_BRIEF = path.resolve(HERE, '..', 'scripts', 'memory-brief.mjs');
const TIMEOUT_MS = 2000;
// Below this, less budget remains than a bare `node` process typically needs just to start —
// spawning memory-brief anyway would only burn that startup cost en route to a guaranteed timeout.
const MIN_SPAWN_MS = 300;

function firstString(...candidates) {
	for (const c of candidates) if (typeof c === 'string' && c.length) return c;
	return null;
}

/** Best-effort `agent_type` extraction from a SubagentStart payload whose exact shape may vary. */
// Verified against the Claude Code 2.1.285 binary (docs/memory-spec.md §12, engsys#140 W1): a
// SubagentStart payload is `{...base, hook_event_name, agent_id, agent_type}` — `base` carries
// `cwd` (read separately in main()). There is NO task-prompt field at this event; the earlier
// multi-field guessing across `subagent_type`/`tool_input.*` never matched anything real and is
// removed. Targeting at SubagentStart is therefore path-based (touched_paths / git diff) plus
// role-based (agent_type), not prompt-text BM25 — §5 of the spec notes this.
export function extractAgentType(input) {
	return firstString(input?.agent_type);
}

/** No verified prompt field exists at SubagentStart (see the note above) — reads `input.prompt`
 * only in case a future payload adds one; never guesses through a nested `tool_input`. */
export function extractPrompt(input) {
	return firstString(input?.prompt) ?? '';
}

/** Touched paths: an explicit list on the payload, else `git diff --name-only <base>` in `cwd`
 * when a worktree/repo is resolvable. `base` tries HEAD first (uncommitted work), then
 * `origin/main`. Never throws; an unresolvable repo yields []. */
// A short, hard timeout on every git call here — this must never eat into the hook's overall 2s
// budget (a lock wait or a huge repo could otherwise block the dispatch before memory-brief runs).
const GIT_CALL_OPTS = { encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] };

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
export function runMemoryBrief({ agentType, prompt, touchedPaths, cwd, timeoutMs = TIMEOUT_MS, scriptPath = MEMORY_BRIEF, exec = execFileSync } = {}) {
	// The `=` form for every value that could itself start with `--` (a task prompt, a touched
	// path) — memory-brief.mjs's space-separated form would read such a value as the NEXT flag and
	// silently drop it (memory-brief.mjs's parseArgs doc comment has the full rationale).
	const args = [scriptPath, '--json', `--repo-root=${cwd}`];
	if (agentType) args.push(`--agent-type=${agentType}`);
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

function logInjection(cwd, record) {
	try {
		const cacheDir = resolveCacheDir(cwd);
		if (!cacheDir) return;
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.appendFileSync(path.join(cacheDir, 'injections.jsonl'), `${JSON.stringify(record)}\n`);
	} catch {
		/* logging must never affect the hook's output */
	}
}

export async function main({ stdin = process.stdin, now = () => Date.now(), write = (s) => process.stdout.write(s), defaultCwd = process.cwd() } = {}) {
	const t0 = now();
	let input = null;
	try {
		let raw = '';
		for await (const chunk of stdin) raw += chunk;
		input = JSON.parse(raw);
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
	const agentType = extractAgentType(input);

	let briefText = '';
	let logKeys = { lesson_keys: [], pointer_keys: [], bytes: 0 };
	// Diagnostics for "the brief disappeared with no clear reason" (resolveTouchedPaths' own git
	// calls, and memory-brief's per-superseder `git show` calls inside buildBrief, both eat into
	// the same 2s budget `runMemoryBrief`'s timeout enforces) — distinguishes "never even tried"
	// from "tried and got nothing back" (almost always a timeout, since every other memory-brief
	// failure path is caught and logged there, not silently swallowed).
	let skippedBudget = false;
	let spawnFailed = false;
	try {
		const prompt = extractPrompt(input);
		const touchedPaths = resolveTouchedPaths(input, { cwd });
		// Give memory-brief only what's LEFT of the 2s total budget after resolveTouchedPaths' own
		// (separately timed) git calls, so the two stages together can never exceed TIMEOUT_MS plus
		// node startup — not TIMEOUT_MS on top of whatever resolveTouchedPaths already spent. Below
		// MIN_SPAWN_MS there isn't even enough budget left for node's own startup, so the spawn is
		// SKIPPED outright (saves that startup cost too) rather than launched to a guaranteed timeout.
		const remainingMs = TIMEOUT_MS - (now() - t0);
		skippedBudget = remainingMs < MIN_SPAWN_MS;
		const result = skippedBudget ? null : runMemoryBrief({ agentType, prompt, touchedPaths, cwd, timeoutMs: remainingMs });
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

	logInjection(cwd, { ts: new Date(now()).toISOString(), agent_type: agentType, ...logKeys, ms: now() - t0, skipped_budget: skippedBudget, spawn_failed: spawnFailed });

	if (!briefText) {
		write('{}');
		return 0;
	}
	write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: briefText } }));
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
