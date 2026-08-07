// codex.mjs — provider adapter: OpenAI Codex CLI (`codex exec`).
// Generalized from campos27's codex-implement.mjs / codex-review.mjs spawn
// path; the protocol validation those runners carried now lives provider-
// independently in worker-run.mjs.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const name = 'codex';
export const family = 'openai';

export function check() {
	const probe = spawnSync('codex', ['--version'], { encoding: 'utf8' });
	if (probe.error?.code === 'ENOENT') {
		return { ready: false, detail: 'the `codex` CLI is not on PATH (npm i -g @openai/codex, then `codex login`).' };
	}
	if (probe.status !== 0) {
		return { ready: false, detail: `\`codex --version\` exited ${probe.status} — check \`codex login\` has an active session.` };
	}
	return { ready: true, detail: String(probe.stdout || '').trim() };
}

export function run({ frame, worktree, model, effort, timeoutSec, transcriptPath, lastMessagePath }) {
	const run = spawnSync(
		'codex',
		[
			'exec',
			'-m',
			model,
			'-c',
			`model_reasoning_effort=${effort}`,
			'--sandbox',
			'workspace-write',
			'--skip-git-repo-check',
			// The verdict/receipt must come from the FINAL MESSAGE, not a
			// transcript grep — the transcript echoes the frame's own footer
			// example back, and a grep can be satisfied by a run that merely
			// repeated its instructions.
			'--output-last-message',
			lastMessagePath,
			'-',
		],
		{
			cwd: worktree,
			input: frame,
			encoding: 'utf8',
			timeout: timeoutSec * 1000,
			killSignal: 'SIGKILL',
			maxBuffer: 128 * 1024 * 1024,
		},
	);
	writeFileSync(transcriptPath, `${run.stdout || ''}${run.stderr || ''}`);
	if (run.error) {
		return { ok: false, status: run.status, signal: run.signal, detail: `\`codex exec\` could not run: ${run.error.message}` };
	}
	const tokens = readFileSync(transcriptPath, 'utf8').match(/tokens used\s*\n?\s*([\d,]+)/)?.[1] ?? null;
	return { ok: true, status: run.status, signal: run.signal, tokens };
}
