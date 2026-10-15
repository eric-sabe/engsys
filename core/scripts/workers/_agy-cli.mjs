// _agy-cli.mjs — shared plumbing for adapters that run the Antigravity (`agy`) CLI
// as a worker harness (#149).

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export function checkAgyCli(env = process.env) {
	const candidates = env.ENGSYS_AGY_BIN ? [env.ENGSYS_AGY_BIN] : ['agy', 'antigravity'];
	for (const bin of candidates) {
		const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', env });
		if (probe.error?.code === 'ENOENT') continue;
		if (probe.status !== 0) return { ready: false, detail: `\`${bin} --version\` exited ${probe.status}.` };
		return { ready: true, detail: `${bin} ${String(probe.stdout || '').trim()}`, bin };
	}
	return { ready: false, detail: 'neither `agy` nor `antigravity` CLI is on PATH.' };
}

export function runAgyCli({ frame, worktree, model, role, timeoutSec, transcriptPath, lastMessagePath, env = process.env }) {
	const checkRes = checkAgyCli(env);
	const bin = checkRes.bin || env.ENGSYS_AGY_BIN || 'agy';
	const args = ['chat', '--mode', 'agent', '--print'];
	if (model) args.push('--model', model);
	if (role !== 'implement' && role !== 'review') args.push('--read-only');
	args.push(frame);

	const run = spawnSync(bin, args, {
		cwd: worktree,
		encoding: 'utf8',
		env,
		timeout: (timeoutSec || 3600) * 1000,
		killSignal: 'SIGKILL',
		maxBuffer: 128 * 1024 * 1024,
	});
	const stdout = String(run.stdout || '');
	const stderr = String(run.stderr || '');
	writeFileSync(transcriptPath, `${stdout}${stderr}`);
	if (run.error) {
		return { ok: false, status: run.status, signal: run.signal, detail: `\`${bin} chat\` could not run: ${run.error.message}` };
	}

	let finalText = stdout;
	let tokens = null;
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && typeof parsed.result === 'string') {
			finalText = parsed.result;
			tokens = parsed.usage?.output_tokens ?? null;
		}
	} catch {
		/* plain text output */
	}

	if (!finalText.trim()) {
		return {
			ok: false,
			status: run.status,
			signal: run.signal,
			detail: 'agy produced an empty final message.',
		};
	}
	writeFileSync(lastMessagePath, finalText);
	return {
		ok: true,
		status: run.status,
		signal: run.signal,
		tokens,
		modelsReported: model ? [model] : [],
		isError: false,
	};
}

export const check = () => checkAgyCli();
export const run = (opts) => runAgyCli(opts);
