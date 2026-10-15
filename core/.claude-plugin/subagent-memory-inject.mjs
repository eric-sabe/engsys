#!/usr/bin/env node
// subagent-memory-inject.mjs — SubagentStart + PreToolUse(Agent|Task) hook for the engsys core PLUGIN:
// push the memory brief (core/scripts/memory-brief.mjs) into a subagent's context before it starts.
// Design: docs/memory-spec.md §6, §12 (verified runtime facts), §13 (tests).
//
// FAIL-OPEN BY DESIGN (spec §6): any error, any timeout, or an empty brief all produce the exact
// same output, `{}` — this hook NEVER blocks a dispatch and NEVER throws into the harness.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarness, parseHookInput } from '../lib/harness-io.mjs';
import { isMainEntry } from '../lib/is-main.mjs';
import { isValidPointerKey, resolveCacheDir } from '../lib/memory/index-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_BRIEF = path.resolve(HERE, '..', 'scripts', 'memory-brief.mjs');
const TIMEOUT_MS = 2000;
const MIN_SPAWN_MS = 300;
const PENDING_TTL_MS = 30_000;

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

/** Extract repo-relative file path hints mentioned in a task prompt (#142). */
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

/** Extract a candidate worktree path from `tool_input` (`worktree`/`cwd`) or an absolute path in `prompt` (#142). */
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

export function sharesGitCommonDir(dirA, dirB, { exec = execFileSync } = {}) {
	if (!dirA || !dirB) return false;
	try {
		const commonA = exec('git', ['-C', dirA, 'rev-parse', '--path-format=absolute', '--git-common-dir'], GIT_CALL_OPTS).trim();
		const commonB = exec('git', ['-C', dirB, 'rev-parse', '--path-format=absolute', '--git-common-dir'], GIT_CALL_OPTS).trim();
		return Boolean(commonA && commonA === commonB);
	} catch {
		return false;
	}
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

export function recordPendingDispatch(input, { cwd, now = () => Date.now() } = {}) {
	try {
		const cacheDir = resolveCacheDir(cwd);
		if (!cacheDir) return null;
		const pendingDir = path.join(cacheDir, 'pending-dispatch');
		fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(pendingDir, 0o700); } catch { /* best effort */ }
		const ts = now();
		sweepExpiredDispatches(pendingDir, ts);

		const parsed = parseHookInput(input, process.env);
		const toolInput = parsed.toolInput ?? {};
		const sessionId = safeIdToken(firstString(parsed.sessionId, input?.session_id) ?? 'default');
		const rawAgent = firstString(toolInput?.subagent_type, toolInput?.agent_type, parsed.agentType) ?? 'any';
		const agentKey = safeIdToken(bareAgent(rawAgent) || 'any');
		const prompt = [firstString(toolInput?.description), firstString(parsed.prompt, toolInput?.prompt)].filter(Boolean).join('\n').slice(0, 8192);
		const promptPaths = extractPathsFromPrompt(prompt);
		const worktree = extractWorktreeFromInput(toolInput, prompt);
		const record = { ts, sessionId, agentKey, prompt, promptPaths, worktree };
		const file = path.join(pendingDir, `${sessionId}--${agentKey}--${ts}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
		fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
		try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
		return file;
	} catch {
		return null;
	}
}

export function consumePendingDispatch(input, { cwd, now = () => Date.now() } = {}) {
	try {
		const cacheDir = resolveCacheDir(cwd);
		if (!cacheDir) return null;
		const pendingDir = path.join(cacheDir, 'pending-dispatch');
		const ts = now();
		sweepExpiredDispatches(pendingDir, ts);
		let files;
		try { files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
		if (files.length === 0) return null;

		const sessionId = safeIdToken(firstString(input?.session_id, input?.sessionId) ?? 'default');
		const agentKey = safeIdToken(bareAgent(extractAgentType(input)) || 'any');
		const prefixes = [`${sessionId}--${agentKey}--`, `${sessionId}--any--`];
		for (const prefix of prefixes) {
			const match = files.find((f) => f.startsWith(prefix));
			if (!match) continue;
			const full = path.join(pendingDir, match);
			let parsed = null;
			try {
				parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
			} catch { parsed = null; }
			try { fs.rmSync(full, { force: true }); } catch { /* best effort */ }
			if (parsed && ts - (parsed.ts ?? 0) <= PENDING_TTL_MS) return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export function extractAgentType(input) {
	return firstString(input?.agent_type, input?.agentType);
}

export function extractPrompt(input) {
	return firstString(input?.prompt) ?? '';
}

export function resolveTouchedPaths(input, { cwd, exec = execFileSync } = {}) {
	if (Array.isArray(input?.touched_paths)) return input.touched_paths.filter((p) => typeof p === 'string');
	try {
		const out = exec('git', ['-C', cwd, 'diff', '--name-only', 'HEAD'], GIT_CALL_OPTS);
		const paths = out.split('\n').filter(Boolean);
		if (paths.length) return paths;
	} catch {
		/* fall through */
	}
	try {
		const base = exec('git', ['-C', cwd, 'merge-base', 'HEAD', 'origin/main'], GIT_CALL_OPTS).trim();
		if (!base) return [];
		const out = exec('git', ['-C', cwd, 'diff', '--name-only', base, 'HEAD'], GIT_CALL_OPTS);
		return out.split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

export function runMemoryBrief({ agentType, prompt, touchedPaths, cwd, timeoutMs = TIMEOUT_MS, scriptPath = MEMORY_BRIEF, exec = execFileSync } = {}) {
	const args = [scriptPath, '--json', `--repo-root=${cwd}`];
	if (agentType) args.push(`--agent-type=${agentType}`);
	if (prompt) args.push(`--prompt=${prompt.slice(0, 8192)}`);
	if (touchedPaths?.length) {
		let joined = '';
		for (const p of touchedPaths) {
			const next = joined ? `${joined},${p}` : p;
			if (Buffer.byteLength(next, 'utf8') > 65536) break;
			joined = next;
		}
		if (joined) args.push(`--paths=${joined}`);
	}
	try {
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
		return null;
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

export async function main({ argv = process.argv.slice(2), stdin = process.stdin, now = () => Date.now(), write = (s) => process.stdout.write(s), defaultCwd = process.cwd() } = {}) {
	const t0 = now();
	let input = null;
	try {
		let raw = '';
		for await (const chunk of stdin) raw += chunk;
		input = JSON.parse(raw);
	} catch {
		input = null;
	}
	const rawCwd = (typeof input?.cwd === 'string' && input.cwd) || defaultCwd;
	let cwd = rawCwd;
	try {
		const top = execFileSync('git', ['-C', rawCwd, 'rev-parse', '--show-toplevel'], GIT_CALL_OPTS).trim();
		if (top) cwd = top;
	} catch { /* keep rawCwd */ }

	if (argv[0] === 'pre-agent' || input?.hook_event_name === 'PreToolUse' || input?.hookEventName === 'preToolUse') {
		if (input) recordPendingDispatch(input, { cwd, now });
		write('{}');
		return 0;
	}

	const agentType = extractAgentType(input);
	let briefText = '';
	let logKeys = { lesson_keys: [], pointer_keys: [], bytes: 0 };
	let skippedBudget = false;
	let spawnFailed = false;
	try {
		const pending = input ? consumePendingDispatch(input, { cwd, now }) : null;
		const prompt = extractPrompt(input) || pending?.prompt || '';
		let diffCwd = cwd;
		if (pending?.worktree && sharesGitCommonDir(cwd, pending.worktree)) {
			try {
				const wtTop = execFileSync('git', ['-C', pending.worktree, 'rev-parse', '--show-toplevel'], GIT_CALL_OPTS).trim();
				if (wtTop) diffCwd = wtTop;
			} catch { /* fall back to cwd */ }
		}
		const gitTouched = resolveTouchedPaths(input, { cwd: diffCwd });
		const touchedPaths = [...new Set([...gitTouched, ...(pending?.promptPaths ?? [])])];
		const remainingMs = TIMEOUT_MS - (now() - t0);
		skippedBudget = remainingMs < MIN_SPAWN_MS;
		const result = skippedBudget ? null : runMemoryBrief({ agentType, prompt, touchedPaths, cwd: diffCwd, timeoutMs: remainingMs });
		spawnFailed = !skippedBudget && !result;
		if (result) {
			briefText = result.text ?? '';
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
	write(JSON.stringify({
		additionalContext: briefText,
		hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: briefText },
	}));
	return 0;
}

if (isMainEntry(import.meta.url)) {
	main()
		.then((code) => process.exit(code ?? 0))
		.catch(() => {
			try { process.stdout.write('{}'); } catch { /* nothing left to do */ }
			process.exit(0);
		});
}
