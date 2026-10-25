// Tests for subagent-memory-inject.mjs — run by
// `node --test core/.claude-plugin/subagent-memory-inject.test.mjs`.
// §13 (docs/memory-spec.md): the injection hook returns {} on error and on timeout.
import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	consumePendingDispatch,
	extractAgentType,
	extractPrompt,
	extractTargetAgentType,
	main,
	recordPendingDispatch,
	resolveTouchedPaths,
	runMemoryBrief,
} from './subagent-memory-inject.mjs';

// engsys#262: the operator's memory.yml is ENGSYS_MEMORY_CONFIG, else $CLAUDE_CONFIG_DIR/memory.yml, else
// ~/.claude/memory.yml — so the developer's (or a fleet session's) own file would leak into every test here that
// doesn't set one. Start from none: no explicit path, no config dir, and an empty HOME.
delete process.env.ENGSYS_MEMORY_CONFIG;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = mkdtempSync(join(tmpdir(), 'memory-test-home-'));

const SCRIPT = fileURLToPath(new URL('./subagent-memory-inject.mjs', import.meta.url));
// engsys#286: the hooks also note/claim dispatches for the hand-back guard; keep that state out of the shared tmpdir.
process.env.ENGSYS_HANDBACK_DIR = mkdtempSync(join(tmpdir(), 'inject-handbacks-'));

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

describe('extractTargetAgentType (engsys v2.0.1 M5)', () => {
	test('reads tool_input.subagent_type — the agent ABOUT TO BE DISPATCHED — never the caller\'s own top-level agent_type', () => {
		assert.equal(
			extractTargetAgentType({ agent_type: 'isabelle', tool_input: { subagent_type: 'engsys:nyx' } }),
			'engsys:nyx',
			'must resolve the target (nyx), not the caller (isabelle)',
		);
	});
	test('falls back to tool_input.agent_type, then fails closed to the empty string', () => {
		assert.equal(extractTargetAgentType({ tool_input: { agent_type: 'engsys:bert' } }), 'engsys:bert');
		assert.equal(extractTargetAgentType({ tool_input: {} }), '');
		assert.equal(extractTargetAgentType({}), '');
		assert.equal(extractTargetAgentType(null), '');
	});
	test('engsys v2.0.1 round 2 (F7): trims and Unicode-NFKC-normalizes the target name', () => {
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: '  engsys:isabelle  ' } }),
			'engsys:isabelle',
		);
		// U+FF49 FULLWIDTH LATIN SMALL LETTER I etc. NFKC-normalizes to ASCII "isabelle".
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'ｉｓａｂｅｌｌｅ' } }),
			'isabelle',
		);
	});
	test('engsys v2.0.1 round 3 (F5): strips Unicode \\p{Cf} zero-width/format characters, which NFKC alone does not remove', () => {
		// U+200B ZERO WIDTH SPACE spliced into the middle of an otherwise normal name.
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'isa​belle' } }),
			'isabelle',
		);
		// U+200E LEFT-TO-RIGHT MARK and U+202A LEFT-TO-RIGHT EMBEDDING, both \p{Cf}.
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: '‎engsys:isabelle‪' } }),
			'engsys:isabelle',
		);
	});
	test('engsys#192: strips \\p{Default_Ignorable_Code_Point} characters that are NOT \\p{Cf} (combining grapheme joiner, variation selector, Hangul filler)', () => {
		// Guard the premise: each of these is default-ignorable but not a Cf format character.
		for (const ch of ['\u034F', '\uFE0F', '\u3164']) {
			assert.ok(/\p{Default_Ignorable_Code_Point}/u.test(ch), `U+${ch.codePointAt(0).toString(16)} is default-ignorable`);
			assert.ok(!/\p{Cf}/u.test(ch), `U+${ch.codePointAt(0).toString(16)} is not Cf`);
		}
		// U+034F COMBINING GRAPHEME JOINER spliced into a name that would otherwise miss an exclusion.
		assert.equal(extractTargetAgentType({ tool_input: { subagent_type: 'ny\u034Fx' } }), 'nyx');
		assert.equal(extractTargetAgentType({ tool_input: { subagent_type: 'engsys:ny\uFE0Fx' } }), 'engsys:nyx');
		// ... and in a subagent_type/agent_type pair it must not manufacture a false disagreement.
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'is\u034Fabelle', agent_type: 'isabelle' } }),
			'isabelle',
		);
		// Positive control: an ordinary visible name is untouched.
		assert.equal(extractTargetAgentType({ tool_input: { subagent_type: 'engsys:nyx' } }), 'engsys:nyx');
	});
	test('engsys v2.0.1 round 3 (F5): subagent_type vs agent_type disagreement compares BARE names — a namespace-prefix spelling difference is not a conflict', () => {
		// Positive control: same bare name, one namespaced, one not -> no conflict, resolves.
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'engsys:isabelle', agent_type: 'isabelle' } }),
			'engsys:isabelle',
		);
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'isabelle', agent_type: 'engsys:isabelle' } }),
			'isabelle',
		);
		// A genuine disagreement — even after stripping namespaces — still fails closed.
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'engsys:isabelle', agent_type: 'nyx' } }),
			'',
		);
	});
	test('engsys v2.0.1 round 2 (F7): fails closed when subagent_type and agent_type disagree, but passes through when they agree (positive control)', () => {
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'engsys:isabelle', agent_type: 'engsys:nyx' } }),
			'',
			'disagreeing identities on the same dispatch must never resolve to either one',
		);
		assert.equal(
			extractTargetAgentType({ tool_input: { subagent_type: 'engsys:isabelle', agent_type: 'engsys:isabelle' } }),
			'engsys:isabelle',
			'agreeing identities resolve normally',
		);
	});
	test('engsys v2.0.1 round 2 (F7): when rawStdin is supplied, the target is parsed through harness-io\'s parseHookInput, not re-derived from the already-parsed object', () => {
		const rawStdin = JSON.stringify({
			hook_event_name: 'PreToolUse',
			tool_name: 'Agent',
			tool_input: { subagent_type: 'engsys:isabelle' },
		});
		assert.equal(extractTargetAgentType({ tool_input: {} }, { rawStdin }), 'engsys:isabelle');
	});
});

describe('main — pre-agent mode on a non-Claude harness (engsys v2.0.1 M5)', () => {
	const prevHarness = process.env.ENGSYS_HARNESS;
	after(() => {
		if (prevHarness === undefined) delete process.env.ENGSYS_HARNESS;
		else process.env.ENGSYS_HARNESS = prevHarness;
	});

	test('fails closed to {} when the dispatch carries no resolvable tool_input.subagent_type, even though the caller agent_type IS resolvable (the exact M5 bug: using the caller instead of the target)', async () => {
		process.env.ENGSYS_HARNESS = 'copilot';
		let written = '';
		const code = await main({
			argv: ['pre-agent'],
			stdin: stdinOf(JSON.stringify({
				hook_event_name: 'PreToolUse',
				agent_type: 'engsys:isabelle', // the CALLING session — must be ignored for this decision
				tool_input: {}, // no subagent_type at all — the target is unresolvable
			})),
			write: (s) => { written += s; },
			defaultCwd: tmpdir(),
		});
		assert.equal(code, 0);
		assert.equal(written, '{}');
	});

	test('positive control: a resolvable target agent_type proceeds past the fail-closed gate (does not short-circuit to {} before even trying)', { skip: !SQLITE_AVAILABLE }, () => {
		process.env.ENGSYS_HARNESS = 'copilot';
		const cwd = mkdtempSync(join(tmpdir(), 'inject-m5-'));
		try {
			// A real (if minimal) git repo, so resolveCacheDir resolves and logInjection actually
			// writes a line — the `{}` fail-closed branch returns BEFORE logInjection is ever
			// called, so a line landing here (with the TARGET's agent_type on it) is direct proof
			// the gate was passed, not just that the output happened to parse as JSON.
			const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
			hermeticGit(cwd, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
			writeFileSync(join(cwd, 'README.md'), 'init\n');
			hermeticGit(cwd, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
			hermeticGit(cwd, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });

			const out = execFileSync('node', [SCRIPT, 'pre-agent'], {
				input: JSON.stringify({
					hook_event_name: 'PreToolUse',
					agent_type: 'engsys:nyx', // caller — irrelevant to this decision
					tool_input: { subagent_type: 'engsys:isabelle' }, // resolvable target
				}),
				encoding: 'utf8',
				env: { ...process.env, ENGSYS_HARNESS: 'copilot', NODE_NO_WARNINGS: '1' },
				cwd,
			});
			assert.doesNotThrow(() => JSON.parse(out));

			const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
			const injectionsLog = join(common, 'engsys-memory', 'injections.jsonl');
			const lastLine = readFileSync(injectionsLog, 'utf8').trim().split('\n').pop();
			const record = JSON.parse(lastLine);
			assert.equal(record.agent_type, 'engsys:isabelle', 'the gate must have passed using the TARGET agent_type, not the caller (engsys:nyx)');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('cr review (round 2): the pending-dispatch prompt/paths are recoverable on a non-Claude harness — consumePendingDispatch must be looked up under the TARGET identity recordPendingDispatch filed it under, not the caller', { skip: !SQLITE_AVAILABLE }, () => {
		const cwd = mkdtempSync(join(tmpdir(), 'inject-f-pending-'));
		try {
			const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
			hermeticGit(cwd, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
			mkdirSync(join(cwd, 'docs', 'agent-lessons'), { recursive: true });
			writeFileSync(
				join(cwd, 'docs', 'agent-lessons', 'pending-lesson.md'),
				'---\nglobs: []\nstacks: []\nroles: []\nkeywords: ["idempotency"]\nsecurity: false\nsupersedes: []\n---\n\n# Idempotency lesson\n\n**Trigger:** idempotency work.\n',
			);
			writeFileSync(join(cwd, 'README.md'), 'init\n');
			hermeticGit(cwd, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
			hermeticGit(cwd, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });

			const env = { ...process.env, ENGSYS_HARNESS: 'copilot', NODE_NO_WARNINGS: '1' };
			const out = execFileSync('node', [SCRIPT, 'pre-agent'], {
				input: JSON.stringify({
					session_id: 'sess-f-pending',
					hook_event_name: 'PreToolUse',
					agent_type: 'engsys:nyx', // caller — must be ignored
					tool_input: {
						subagent_type: 'engsys:isabelle', // target — must be what the lookup keys on
						description: 'Fix idempotency bug',
						prompt: 'Please address idempotency carefully.',
					},
				}),
				encoding: 'utf8',
				env,
				cwd,
			});
			const parsed = JSON.parse(out);
			// This fixture repo isn't allowlisted/indexed the same way a real one would be, so the
			// brief falls back to the plugin's own bundled lessons-library — but it still scores
			// against OUR stashed prompt, not an empty one. Proof the dispatch was recovered: the
			// selected lessons are strongly idempotency-related, matching "idempotency" in the
			// stashed prompt, not a generic/unscored set.
			assert.match(
				parsed.hookSpecificOutput?.additionalContext ?? '',
				/idempoten/i,
				'the dispatch prompt stashed under the target identity must be recovered and used for brief selection in the SAME non-Claude pre-agent call',
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
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

	test('PreToolUse pre-agent stashes prompt, prompt paths, and isolated worktree so SubagentStart resolves the subagent worktree diff and prompt even when parent cwd is clean (#142)', { skip: !SQLITE_AVAILABLE }, () => {
		const parent = mkdtempSync(join(tmpdir(), 'inject-parent-'));
		const origin = mkdtempSync(join(tmpdir(), 'inject-origin-'));
		const wt = mkdtempSync(join(tmpdir(), 'inject-wt-'));
		rmSync(wt, { recursive: true, force: true }); // git worktree add creates it
		try {
			const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
			hermeticGit(origin, [...GIT_OPTS, 'init', '-q', '--bare'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'remote', 'add', 'origin', 'https://github.com/fixture/repo.git'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'remote', 'set-url', '--push', 'origin', origin], { isolateConfig: true });
			mkdirSync(join(parent, 'docs', 'agent-lessons'), { recursive: true });
			writeFileSync(
				join(parent, 'docs', 'agent-lessons', 'wt-lesson.md'),
				'---\nglobs: ["services/payments/**"]\nstacks: []\nroles: []\nkeywords: ["idempotency"]\nsecurity: false\nsupersedes: []\n---\n\n# Payments idempotency lesson\n\n**Trigger:** Touching services/payments/charge.ts.\n',
			);
			writeFileSync(join(parent, 'README.md'), 'init\n');
			hermeticGit(parent, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'push', '-q', '-f', 'origin', 'HEAD:main'], { isolateConfig: true });
			hermeticGit(parent, [...GIT_OPTS, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { isolateConfig: true });

			// Create an isolated subagent worktree where `services/payments/charge.ts` is modified,
			// while `parent` itself stays completely clean on main.
			hermeticGit(parent, [...GIT_OPTS, 'worktree', 'add', '-q', '-b', 'agent/sub-wt', wt, 'HEAD'], { isolateConfig: true });
			mkdirSync(join(wt, 'services', 'payments'), { recursive: true });
			writeFileSync(join(wt, 'services', 'payments', 'charge.ts'), 'export const charge = 1;\n');
			hermeticGit(wt, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
			hermeticGit(wt, [...GIT_OPTS, 'commit', '-q', '-m', 'touch charge.ts in subagent worktree'], { isolateConfig: true });

			const env = { ...process.env, NODE_NO_WARNINGS: '1', ENGSYS_MEMORY_REPOS: 'fixture/repo' };
			const prePayload = JSON.stringify({
				session_id: 'sess-142',
				cwd: parent,
				hook_event_name: 'PreToolUse',
				tool_name: 'Agent',
				tool_input: {
					subagent_type: 'engsys:isabelle',
					description: 'Review subagent worktree changes',
					prompt: `Review the changes in worktree ${wt} carefully.`,
				},
			});
			const preOut = execFileSync('node', [SCRIPT, 'pre-agent'], { input: prePayload, encoding: 'utf8', env });
			assert.equal(preOut, '{}');

			// Now SubagentStart fires with parent `cwd` (clean!) and NO `prompt` or `touched_paths`.
			const startPayload = JSON.stringify({
				session_id: 'sess-142',
				cwd: parent,
				hook_event_name: 'SubagentStart',
				agent_id: 'a-1',
				agent_type: 'engsys:isabelle',
			});
			const startOut = execFileSync('node', [SCRIPT], { input: startPayload, encoding: 'utf8', env });
			const parsed = JSON.parse(startOut);
			assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SubagentStart');
			assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /lesson:wt-lesson/, 'SubagentStart must resolve the subagent worktree diff via the PreToolUse pending-dispatch record');
		} finally {
			rmSync(wt, { recursive: true, force: true });
			rmSync(parent, { recursive: true, force: true });
			rmSync(origin, { recursive: true, force: true });
		}
	});
});

// engsys#262: a teammate dispatch (Agent with `name`) reaches SubagentStart with the teammate NAME as
// agent_type (`bert-p2`), never the dispatched subagent_type (`engsys:bert`) the pending record is filed under.
describe('pending dispatch for a teammate-name agent_type (engsys#262)', () => {
	const repos = [];
	after(() => { for (const d of repos) rmSync(d, { recursive: true, force: true }); });
	function repo() {
		const dir = mkdtempSync(join(tmpdir(), 'inject-262-'));
		repos.push(dir);
		hermeticGit(dir, ['init', '-q'], { isolateConfig: true });
		return dir;
	}
	const dispatch = (cwd, toolInput, ts) => recordPendingDispatch({ session_id: 's-262', tool_input: toolInput }, { cwd, now: () => ts });
	const start = (cwd, agentType, ts) => consumePendingDispatch({ session_id: 's-262', agent_type: agentType }, { cwd, now: () => ts });

	test('matched by the recorded teammate name, carrying the dispatched subagent_type', () => {
		const cwd = repo();
		dispatch(cwd, { subagent_type: 'engsys:isabelle', prompt: 'other work' }, 1000);
		dispatch(cwd, { subagent_type: 'engsys:bert', name: 'bert-p2', prompt: 'investigate the brief' }, 1001);
		const got = start(cwd, 'bert-p2', 1002);
		assert.equal(got?.matchedBy, 'name');
		assert.equal(got?.agentType, 'engsys:bert');
		assert.match(got?.prompt ?? '', /investigate the brief/);
		const plain = start(cwd, 'engsys:isabelle', 1003);
		assert.equal(plain?.matchedBy, 'type', 'positive control: a plain typed dispatch still matches by type');
		assert.match(plain?.prompt ?? '', /other work/);
	});

	test('a teammate named like a namespaced type never captures the real start (re-review: Nyx stays Nyx)', () => {
		for (const name of ['engsys:nyx', 'engsys_nyx']) {
			const cwd = repo();
			dispatch(cwd, { subagent_type: 'engsys:isabelle', name, prompt: 'isabelle work' }, 1000);
			dispatch(cwd, { subagent_type: 'engsys:nyx', prompt: 'security review' }, 1001);
			const nyx = start(cwd, 'engsys:nyx', 1002);
			assert.equal(nyx?.matchedBy, 'type', `${name}: the real nyx start matches its own record by type`);
			assert.match(nyx?.prompt ?? '', /security review/, `${name}: nyx keeps its own prompt`);
			assert.notEqual(nyx?.agentType, 'engsys:isabelle', `${name}: nyx never adopts isabelle`);
		}
	});

	test('parallel dispatches never swap records: an untyped dispatch beside a nyx one (review finding 1)', () => {
		const cwd = repo();
		dispatch(cwd, {
			description: 'untyped', prompt: 'general work in /tmp',
		}, 1000);
		dispatch(cwd, { subagent_type: 'engsys:nyx', prompt: 'security review of services/auth/guard.ts' }, 1001);
		// the untyped dispatch starts as general-purpose: no record of its own while a typed one is pending
		assert.equal(start(cwd, 'general-purpose', 1002), null, 'never nyx\'s record');
		const nyx = start(cwd, 'engsys:nyx', 1003);
		assert.equal(nyx?.matchedBy, 'type');
		assert.match(nyx?.prompt ?? '', /security review/, 'nyx gets its own prompt, not the untyped one');
		assert.deepEqual(nyx?.promptPaths, ['services/auth/guard.ts']);
	});

	test('parallel dispatches never swap records: Explore beside a typed dispatch (review finding 1)', () => {
		const cwd = repo();
		dispatch(cwd, { subagent_type: 'Explore', prompt: 'explore the repo' }, 1000);
		dispatch(cwd, { subagent_type: 'engsys:isabelle', prompt: 'implement the fix' }, 1001);
		assert.match(start(cwd, 'engsys:isabelle', 1002)?.prompt ?? '', /implement the fix/);
		assert.match(start(cwd, 'Explore', 1003)?.prompt ?? '', /explore the repo/);
		assert.equal(start(cwd, 'bert-p2', 1004), null, 'an unmatched teammate start takes nothing that is left');
	});

	test('a teammate start with no name on record gets no record rather than another dispatch\'s', () => {
		const cwd = repo();
		dispatch(cwd, { subagent_type: 'engsys:isabelle', prompt: 'isabelle work' }, 1000);
		dispatch(cwd, { subagent_type: 'engsys:bert', prompt: 'bert work' }, 1001);
		assert.equal(start(cwd, 'bert-p2', 1002), null);
		assert.match(start(cwd, 'engsys:isabelle', 1003)?.prompt ?? '', /isabelle work/, '…and both records are still there for their own starts');
		assert.match(start(cwd, 'engsys:bert', 1004)?.prompt ?? '', /bert work/);
	});

	test('the exact name match runs before the type match: a teammate named like a bare type takes its own record (review finding 2)', () => {
		const cwd = repo();
		dispatch(cwd, { subagent_type: 'engsys:isabelle', prompt: 'the real isabelle' }, 1000);
		dispatch(cwd, { subagent_type: 'engsys:nyx', name: 'isabelle', prompt: 'nyx teammate named isabelle' }, 1001);
		const teammate = start(cwd, 'isabelle', 1002);
		assert.equal(teammate?.matchedBy, 'name');
		assert.equal(teammate?.agentType, 'engsys:nyx', 'it is Nyx (Class B-excluded), not isabelle');
		assert.match(teammate?.prompt ?? '', /nyx teammate/);
		const real = start(cwd, 'engsys:isabelle', 1003);
		assert.equal(real?.matchedBy, 'type');
		assert.match(real?.prompt ?? '', /the real isabelle/);
	});

	test('expired records are never matched, by name or by type', () => {
		const cwd = repo();
		dispatch(cwd, { subagent_type: 'engsys:bert', name: 'bert-p2', prompt: 'stale' }, 1000);
		assert.equal(start(cwd, 'bert-p2', 1000 + 31_000), null);
	});

	test('end to end: a teammate dispatched as engsys:nyx is briefed and logged as nyx, not as its teammate name', { skip: !SQLITE_AVAILABLE }, () => {
		const parent = mkdtempSync(join(tmpdir(), 'inject-262-e2e-'));
		const origin = mkdtempSync(join(tmpdir(), 'inject-262-origin-'));
		repos.push(parent, origin);
		const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
		hermeticGit(origin, [...GIT_OPTS, 'init', '-q', '--bare'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'remote', 'add', 'origin', 'https://github.com/fixture/repo.git'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'remote', 'set-url', '--push', 'origin', origin], { isolateConfig: true });
		mkdirSync(join(parent, 'docs', 'agent-lessons'), { recursive: true });
		writeFileSync(
			join(parent, 'docs', 'agent-lessons', 'nyx-only.md'),
			'---\nglobs: []\nstacks: []\nroles: ["nyx"]\nkeywords: []\nsecurity: false\nsupersedes: []\n---\n\n# Nyx role lesson\n\n**Trigger:** A security review.\n',
		);
		hermeticGit(parent, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'push', '-q', '-f', 'origin', 'HEAD:main'], { isolateConfig: true });
		hermeticGit(parent, [...GIT_OPTS, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { isolateConfig: true });
		const env = { ...process.env, NODE_NO_WARNINGS: '1', ENGSYS_MEMORY_REPOS: 'fixture/repo' };
		execFileSync('node', [SCRIPT, 'pre-agent'], {
			input: JSON.stringify({ session_id: 's-e2e', cwd: parent, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'engsys:nyx', name: 'nyx-221', prompt: 'review the diff' } }),
			encoding: 'utf8', env,
		});
		const out = execFileSync('node', [SCRIPT], {
			input: JSON.stringify({ session_id: 's-e2e', cwd: parent, hook_event_name: 'SubagentStart', agent_id: 'a-1', agent_type: 'nyx-221' }),
			encoding: 'utf8', env,
		});
		assert.match(JSON.parse(out).hookSpecificOutput?.additionalContext ?? '', /lesson:nyx-only/, 'the nyx-scoped lesson reaches the nyx teammate');
		const rows = readFileSync(join(parent, '.git', 'engsys-memory', 'injections.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
		assert.equal(rows.at(-1).agent_type, 'engsys:nyx', 'logged (and Class B-excluded) as nyx');
	});
});
