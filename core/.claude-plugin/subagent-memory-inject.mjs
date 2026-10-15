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
export function resolveTouchedPaths(input, { cwd, exec = execFileSync } = {}) {
	if (Array.isArray(input?.touched_paths)) return input.touched_paths.filter((p) => typeof p === 'string');
	for (const base of ['HEAD', 'origin/main']) {
		try {
			const out = exec('git', ['-C', cwd, 'diff', '--name-only', base], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			const paths = out.split('\n').filter(Boolean);
			if (paths.length) return paths;
		} catch {
			/* try the next base, or give up below */
		}
	}
	return [];
}

/** Run memory-brief.mjs --json as a child process with a hard wall-clock budget. Returns
 * `{ text, lessonKeys, pointerKeys, bytes }`, or null on ANY failure (non-zero exit, timeout,
 * spawn error, unparseable output) — all treated identically as "no brief". Never throws. */
export function runMemoryBrief({ agentType, prompt, touchedPaths, cwd, timeoutMs = TIMEOUT_MS, scriptPath = MEMORY_BRIEF, exec = execFileSync } = {}) {
	const args = [scriptPath, '--json', '--repo-root', cwd];
	if (agentType) args.push('--agent-type', agentType);
	if (prompt) args.push('--prompt', prompt);
	if (touchedPaths?.length) args.push('--paths', touchedPaths.join(','));
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

export async function main({ stdin = process.stdin, now = () => Date.now(), write = (s) => process.stdout.write(s) } = {}) {
	const t0 = now();
	let input = null;
	try {
		let raw = '';
		for await (const chunk of stdin) raw += chunk;
		input = JSON.parse(raw);
	} catch {
		input = null;
	}
	const cwd = (typeof input?.cwd === 'string' && input.cwd) || process.cwd();
	const agentType = extractAgentType(input);

	let briefText = '';
	let logKeys = { lesson_keys: [], pointer_keys: [], bytes: 0 };
	try {
		const prompt = extractPrompt(input);
		const touchedPaths = resolveTouchedPaths(input, { cwd });
		const result = runMemoryBrief({ agentType, prompt, touchedPaths, cwd });
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
