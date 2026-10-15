// Tests for subagent-memory-inject.mjs — run by
// `node --test core/.claude-plugin/subagent-memory-inject.test.mjs`.
// §13 (docs/memory-spec.md): the injection hook returns {} on error and on timeout.
import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
// node:sqlite needs Node >= 22.5 (see index-db.test.mjs). On a Node without it the hook still
// fails open correctly — the one test that asserts a REAL non-empty brief is skipped, not failed.
let SQLITE_AVAILABLE = true;
try { require('node:sqlite'); } catch { SQLITE_AVAILABLE = false; }
import { fileURLToPath } from 'node:url';
import { hermeticGit } from '../lib/git-env.mjs';
import {
	extractAgentType,
	extractPrompt,
	main,
	resolveTouchedPaths,
	runMemoryBrief,
} from './subagent-memory-inject.mjs';

const SCRIPT = fileURLToPath(new URL('./subagent-memory-inject.mjs', import.meta.url));

function stdinOf(text) {
	return Readable.from([text]);
}

describe('extractAgentType / extractPrompt', () => {
	// Per the verified Claude Code 2.1.285 payload shape (docs/memory-spec.md §12, engsys#140 W1):
	// SubagentStart carries `agent_type` directly — there is no `subagent_type` or `tool_input`
	// nesting at this event, and no prompt field at all. The old multi-field guessing is removed.
	test('reads the agent_type field', () => {
		assert.equal(extractAgentType({ agent_type: 'engsys:isabelle' }), 'engsys:isabelle');
	});
	test('returns null for a missing/malformed shape instead of throwing', () => {
		assert.equal(extractAgentType({}), null);
		assert.equal(extractAgentType(null), null);
		assert.equal(extractAgentType({ subagent_type: 'nyx' }), null, 'subagent_type is not a real field at SubagentStart — must not be guessed');
	});
	test('extractPrompt is always the empty string on the real (promptless) payload shape', () => {
		assert.equal(extractPrompt({}), '');
		assert.equal(extractPrompt({ tool_input: { description: 'desc' } }), '', 'tool_input is not nested under a SubagentStart payload — must not be guessed');
	});
});

describe('resolveTouchedPaths', () => {
	test('prefers an explicit touched_paths array on the payload', () => {
		const paths = resolveTouchedPaths({ touched_paths: ['a.ts', 'b.ts'] }, { cwd: '/nonexistent' });
		assert.deepEqual(paths, ['a.ts', 'b.ts']);
	});
	test('falls back to [] when git is unavailable/fails, never throws', () => {
		const fakeExec = () => { throw new Error('nope'); };
		assert.deepEqual(resolveTouchedPaths({}, { cwd: '/nonexistent', exec: fakeExec }), []);
	});

	test('no uncommitted changes (HEAD diff empty) falls back to a merge-base diff, never a raw origin/main diff', () => {
		const calls = [];
		const fakeExec = (cmd, args) => {
			calls.push(args);
			if (args.includes('merge-base')) return 'abc123\n';
			if (args.includes('diff') && calls.filter((c) => c.includes('diff')).length === 1) return ''; // the first (HEAD-only) probe: nothing uncommitted
			if (args.includes('diff')) return 'changed-file.ts\n'; // the merge-base diff
			throw new Error('unexpected call');
		};
		const paths = resolveTouchedPaths({}, { cwd: '/repo', exec: fakeExec });
		assert.deepEqual(paths, ['changed-file.ts']);
		assert.ok(calls.some((a) => a.includes('merge-base') && a.includes('origin/main')));
		assert.ok(!calls.some((a) => a.includes('diff') && a.includes('origin/main')), 'must never diff directly against origin/main');
	});

	test('a failing merge-base (e.g. no origin/main) yields [] rather than throwing', () => {
		const fakeExec = (cmd, args) => {
			if (args.includes('merge-base')) throw new Error('no such ref');
			return '';
		};
		assert.deepEqual(resolveTouchedPaths({}, { cwd: '/repo', exec: fakeExec }), []);
	});
});

describe('runMemoryBrief', () => {
	test('a very long prompt is truncated before it becomes an argv element (avoids E2BIG)', () => {
		let capturedArgs = null;
		const fakeExec = (cmd, args) => { capturedArgs = args; return JSON.stringify({ text: '', lessonKeys: [], pointerKeys: [], bytes: 0 }); };
		const longPrompt = 'x'.repeat(200000);
		runMemoryBrief({ cwd: '.', prompt: longPrompt, exec: fakeExec });
		const promptArg = capturedArgs.find((a) => a.startsWith('--prompt='));
		assert.ok(promptArg.length < 20000, `expected a truncated --prompt= argv element, got ${promptArg.length} chars`);
	});

	test('--paths= is capped by UTF-8 BYTE length, not UTF-16 string length — a multi-byte-heavy path list still gets capped under the real argv byte limit (round 4 nit)', () => {
		let capturedArgs = null;
		const fakeExec = (cmd, args) => { capturedArgs = args; return JSON.stringify({ text: '', lessonKeys: [], pointerKeys: [], bytes: 0 }); };
		// Each segment is 3 UTF-16 code units but 9 UTF-8 bytes (U+6587, "文", repeated) — a
		// length-based cap would let 3x too much through before tripping.
		const touchedPaths = Array.from({ length: 20000 }, () => '文文文/x');
		runMemoryBrief({ cwd: '.', touchedPaths, exec: fakeExec });
		const pathsArg = capturedArgs.find((a) => a.startsWith('--paths='));
		assert.ok(pathsArg, 'at least some paths must still get through');
		assert.ok(Buffer.byteLength(pathsArg, 'utf8') <= 65536 + 9, `expected the joined --paths= value capped at ~65536 UTF-8 bytes, got ${Buffer.byteLength(pathsArg, 'utf8')}`);
	});

	test('returns null on a non-zero exit instead of throwing', () => {
		const fakeExec = () => { throw Object.assign(new Error('boom'), { status: 1 }); };
		assert.equal(runMemoryBrief({ cwd: '.', exec: fakeExec }), null);
	});
	test('returns null on a timeout instead of throwing', () => {
		const fakeExec = () => { throw Object.assign(new Error('timeout'), { signal: 'SIGKILL', killed: true }); };
		assert.equal(runMemoryBrief({ cwd: '.', exec: fakeExec }), null);
	});
	test('returns null on unparseable (non-JSON) output', () => {
		const fakeExec = () => 'not json';
		assert.equal(runMemoryBrief({ cwd: '.', exec: fakeExec }), null);
	});
	test('returns the parsed result on success', () => {
		const fakeExec = () => JSON.stringify({ text: 'hi', lessonKeys: ['a'], pointerKeys: [], bytes: 2 });
		const result = runMemoryBrief({ cwd: '.', exec: fakeExec });
		assert.equal(result.text, 'hi');
	});

	test('spawns with process.execPath, not a bare "node" resolved off PATH', () => {
		let capturedCmd = null;
		const fakeExec = (cmd) => { capturedCmd = cmd; return JSON.stringify({ text: '', lessonKeys: [], pointerKeys: [], bytes: 0 }); };
		runMemoryBrief({ cwd: '.', exec: fakeExec });
		assert.equal(capturedCmd, process.execPath);
	});
});

describe('main — fail-open contract', () => {
	// A NON-git temp dir for `defaultCwd` — these tests fall back to it (no `cwd` in the, unparsed,
	// stdin), and it must resolve to "no cache dir, no index, empty brief" deterministically. Using
	// `process.cwd()` here (this engsys checkout) would instead pick up THIS BRANCH's real diff
	// against origin/main via resolveTouchedPaths' merge-base fallback — which is nonempty on any
	// branch with actual changes, and scores real lessons, breaking the "always {}" expectation on
	// every PR that touches more than a trivial diff.
	const isolatedCwd = mkdtempSync(join(tmpdir(), 'inject-isolated-'));
	after(() => rmSync(isolatedCwd, { recursive: true, force: true }));

	test('malformed stdin JSON yields {} and exit 0, never throws', async () => {
		const code = await captureAndRun('not json at all');
		assert.equal(code.exitCode, 0);
		assert.equal(code.stdout, '{}');
	});

	test('empty stdin yields {}', async () => {
		const code = await captureAndRun('');
		assert.equal(code.stdout, '{}');
	});

	test('valid input but memory-brief failing (simulated via bad cwd) still yields {}, never throws', async () => {
		const code = await captureAndRun(JSON.stringify({ cwd: '/definitely/does/not/exist', agent_type: 'isabelle' }));
		assert.equal(code.stdout, '{}');
	});

	async function captureAndRun(stdinText) {
		const chunks = [];
		const exitCode = (await main({ stdin: stdinOf(stdinText), write: (s) => chunks.push(s), defaultCwd: isolatedCwd })) ?? 0;
		return { stdout: chunks.join(''), exitCode };
	}
});

describe('CLI end to end', () => {
	test('a well-formed SubagentStart payload against this real checkout returns a non-empty brief', { skip: !SQLITE_AVAILABLE }, () => {
		// No `prompt` field — the real SubagentStart payload shape (docs/memory-spec.md §12) never
		// carries one; a test fixture that adds one hides exactly the gap cr review's round-3 pass
		// caught (most unscoped bundled lessons scoring 0 with no prompt to derive BM25 terms from).
		//
		// `touched_paths` IS given explicitly (round 4, independent review Warning): leaving it out
		// let resolveTouchedPaths() fall back to this process's own `git diff`/merge-base against
		// origin/main, which is empty once this branch is actually merged (HEAD == origin/main) —
		// the test would then deterministically fail on `main` with no code regression at all.
		// Explicit touched_paths short-circuits that git call entirely (hermetic regardless of the
		// live branch/diff state), and its segments ("git", "core", "bare", "flip", "worktrees")
		// deliberately match a real bundled lesson's keywords so the BM25 fallback has something to
		// find.
		const payload = JSON.stringify({
			cwd: fileURLToPath(new URL('../..', import.meta.url)),
			agent_type: 'isabelle',
			touched_paths: ['scripts/git-core-bare-flip-worktrees-fixture.ts'],
		});
		const out = execFileSync('node', [SCRIPT], { input: payload, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
		const parsed = JSON.parse(out);
		assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
		assert.match(parsed.hookSpecificOutput.additionalContext, /lesson:/);
	});

	test('…and the same payload still returns a non-empty brief with origin/main == HEAD (no diff at all), proving the test above does not depend on this branch\'s live diff', { skip: !SQLITE_AVAILABLE }, () => {
		// Simulates exactly the post-merge state the independent review flagged: a repo whose
		// working tree/HEAD has no uncommitted changes and no divergence from origin/main at all,
		// so the OLD (pre-fix) test — which relied on resolveTouchedPaths' git-diff fallback —
		// would have found touchedPaths == [] here and failed deterministically.
		const dir = mkdtempSync(join(tmpdir(), 'subagent-inject-nodiff-'));
		const origin = mkdtempSync(join(tmpdir(), 'subagent-inject-nodiff-origin-'));
		try {
			const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
			hermeticGit(origin, [...GIT_OPTS, 'init', '-q', '--bare'], { isolateConfig: true });
			hermeticGit(dir, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
			hermeticGit(dir, [...GIT_OPTS, 'remote', 'add', 'origin', origin], { isolateConfig: true });
			mkdirSync(join(dir, 'docs', 'agent-lessons'), { recursive: true });
			writeFileSync(join(dir, 'README.md'), 'fixture\n');
			hermeticGit(dir, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
			hermeticGit(dir, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });
			hermeticGit(dir, [...GIT_OPTS, 'push', '-q', '-f', 'origin', 'HEAD:main'], { isolateConfig: true }); // origin/main == HEAD, no diff at all
			const payload = JSON.stringify({ cwd: dir, agent_type: 'isabelle', touched_paths: ['scripts/git-core-bare-flip-worktrees-fixture.ts'] });
			const out = execFileSync('node', [SCRIPT], { input: payload, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
			const parsed = JSON.parse(out);
			assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
			assert.match(parsed.hookSpecificOutput.additionalContext, /lesson:/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(origin, { recursive: true, force: true });
		}
	});

	test('garbage stdin never crashes the process (exit 0, {})', () => {
		// Run from an isolated non-git tmpdir for the same reason as the isolatedCwd above: garbage
		// stdin means main() falls back to the SPAWNED process's OWN cwd, which execFileSync's `cwd`
		// option controls here — defaulting to this repo checkout would make the result depend on
		// this branch's live diff against origin/main instead of being deterministically {}.
		const dir = mkdtempSync(join(tmpdir(), 'inject-cli-isolated-'));
		try {
			const out = execFileSync('node', [SCRIPT], { input: '{{{not json', encoding: 'utf8', cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
			assert.equal(out, '{}');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
