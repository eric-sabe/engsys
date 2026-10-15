// Tests for subagent-memory-inject.mjs — run by
// `node --test core/.claude-plugin/subagent-memory-inject.test.mjs`.
// §13 (docs/memory-spec.md): the injection hook returns {} on error and on timeout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
	test('reads the top-level agent_type field', () => {
		assert.equal(extractAgentType({ agent_type: 'isabelle' }), 'isabelle');
	});
	test('falls back through subagent_type and tool_input variants', () => {
		assert.equal(extractAgentType({ subagent_type: 'nyx' }), 'nyx');
		assert.equal(extractAgentType({ tool_input: { subagent_type: 'aaron' } }), 'aaron');
	});
	test('returns null for an unrecognized shape instead of throwing', () => {
		assert.equal(extractAgentType({}), null);
		assert.equal(extractAgentType(null), null);
	});
	test('extractPrompt falls back to the empty string', () => {
		assert.equal(extractPrompt({}), '');
		assert.equal(extractPrompt({ prompt: 'do the thing' }), 'do the thing');
		assert.equal(extractPrompt({ tool_input: { description: 'desc' } }), 'desc');
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
});

describe('main — fail-open contract', () => {
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
		const exitCode = (await main({ stdin: stdinOf(stdinText), write: (s) => chunks.push(s) })) ?? 0;
		return { stdout: chunks.join(''), exitCode };
	}
});

describe('CLI end to end', () => {
	test('a well-formed SubagentStart payload against this real checkout returns a non-empty brief', () => {
		const payload = JSON.stringify({ cwd: fileURLToPath(new URL('../..', import.meta.url)), agent_type: 'isabelle', prompt: 'worktree bootstrap pnpm install' });
		const out = execFileSync('node', [SCRIPT], { input: payload, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
		const parsed = JSON.parse(out);
		assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
		assert.match(parsed.hookSpecificOutput.additionalContext, /lesson:/);
	});

	test('garbage stdin never crashes the process (exit 0, {})', () => {
		const out = execFileSync('node', [SCRIPT], { input: '{{{not json', encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
		assert.equal(out, '{}');
	});
});
