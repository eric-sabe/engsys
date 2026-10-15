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
import { resolveCacheDir } from '../lib/memory/index-db.mjs';

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
export function extractAgentType(input) {
	return firstString(input?.agent_type, input?.subagent_type, input?.tool_input?.subagent_type, input?.tool_input?.agent_type);
}

/** Best-effort task-prompt extraction. */
export function extractPrompt(input) {
	return firstString(input?.prompt, input?.task, input?.tool_input?.prompt, input?.tool_input?.description, input?.tool_input?.task) ?? '';
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
	if (prompt) args.push(`--prompt=${prompt}`);
	if (touchedPaths?.length) args.push(`--paths=${touchedPaths.join(',')}`);
	try {
		const out = exec('node', args, {
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
	const cwd = (typeof input?.cwd === 'string' && input.cwd) || defaultCwd;
	const agentType = extractAgentType(input);

	let briefText = '';
	let logKeys = { lesson_keys: [], pointer_keys: [], bytes: 0 };
	try {
		const prompt = extractPrompt(input);
		const touchedPaths = resolveTouchedPaths(input, { cwd });
		// Give memory-brief only what's LEFT of the 2s total budget after resolveTouchedPaths' own
		// (separately timed) git calls, so the two stages together can never exceed TIMEOUT_MS plus
		// node startup — not TIMEOUT_MS on top of whatever resolveTouchedPaths already spent. Below
		// MIN_SPAWN_MS there isn't even enough budget left for node's own startup, so the spawn is
		// SKIPPED outright (saves that startup cost too) rather than launched to a guaranteed timeout.
		const remainingMs = TIMEOUT_MS - (now() - t0);
		const result = remainingMs >= MIN_SPAWN_MS ? runMemoryBrief({ agentType, prompt, touchedPaths, cwd, timeoutMs: remainingMs }) : null;
		if (result) {
			briefText = result.text ?? '';
			logKeys = { lesson_keys: result.lessonKeys ?? [], pointer_keys: result.pointerKeys ?? [], bytes: result.bytes ?? Buffer.byteLength(briefText, 'utf8') };
		}
	} catch {
		briefText = '';
	}

	logInjection(cwd, { ts: new Date(now()).toISOString(), agent_type: agentType, ...logKeys, ms: now() - t0 });

	if (!briefText) {
		write('{}');
		return 0;
	}
	write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: briefText } }));
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code ?? 0))
		.catch(() => {
			// The absolute last line of defense: even a bug in main() above must still fail open.
			try { process.stdout.write('{}'); } catch { /* nothing left to do */ }
			process.exit(0);
		});
}
