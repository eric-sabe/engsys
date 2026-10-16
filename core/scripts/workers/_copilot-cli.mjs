// _copilot-cli.mjs — shared plumbing for adapters that run the GitHub `copilot` CLI
// as a worker harness (#149).
//
// Runs `copilot -p "<frame>" --model <model> --yolo --no-ask-user --silent` in the
// target worktree and captures the structured or plain-text final message.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export function checkCopilotCli(env = process.env) {
	const bin = env.ENGSYS_COPILOT_BIN || 'copilot';
	const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', env });
	if (probe.error?.code === 'ENOENT') return { ready: false, detail: `the \`${bin}\` CLI is not on PATH.` };
	if (probe.status !== 0) return { ready: false, detail: `\`${bin} --version\` exited ${probe.status}.` };
	return { ready: true, detail: `copilot ${String(probe.stdout || '').trim()}` };
}

const DENIED_TOOLS = [
	'shell(git push:*)',
	'shell(*git push*)',
	'shell(git commit:*)',
	'shell(*git commit*)',
	'shell(git remote:*)',
	'shell(*git remote*)',
	'shell(git reset:*)',
	'shell(*git reset*)',
	'shell(gh pr:*)',
	'shell(*gh pr*)',
	'shell(gh issue:*)',
	'shell(*gh issue*)',
	'shell(gh repo:*)',
	'shell(*gh repo*)',
	'shell(gh api:*)',
	'shell(*gh api*)',
];

export function runCopilotCli({ frame, worktree, model, effort, role, timeoutSec, transcriptPath, lastMessagePath, env = process.env }) {
	const bin = env.ENGSYS_COPILOT_BIN || 'copilot';
	const denyArgs = DENIED_TOOLS.flatMap((t) => ['--deny-tool', t]);
	if (role !== 'implement') {
		denyArgs.push('--deny-tool', 'write', '--deny-tool', 'edit');
	}
	const childEnv = { ...env, COPILOT_REASONING_EFFORT: effort || 'high' };
	const run = spawnSync(
		bin,
		['-p', frame, '--model', model, '--yolo', '--no-ask-user', '--silent', ...denyArgs],
		{
			cwd: worktree,
			encoding: 'utf8',
			env: childEnv,
			timeout: (timeoutSec || 3600) * 1000,
			killSignal: 'SIGKILL',
			maxBuffer: 128 * 1024 * 1024,
		},
	);
	const stdout = String(run.stdout || '');
	const stderr = String(run.stderr || '');
	writeFileSync(transcriptPath, `${stdout}${stderr}`);
	if (run.error) {
		return { ok: false, status: run.status, signal: run.signal, detail: `\`${bin} -p\` could not run: ${run.error.message}` };
	}
	if (run.status !== 0) {
		return {
			ok: false,
			status: run.status,
			signal: run.signal,
			detail: `\`${bin} -p\` exited ${run.status ?? `signal ${run.signal}`}.`,
		};
	}

	let finalText = stdout;
	let tokens = null;
	let modelsReported = model ? [model] : [];
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && typeof parsed.result === 'string') {
			finalText = parsed.result;
			tokens = parsed.usage?.output_tokens ?? null;
			if (parsed.model) modelsReported = [parsed.model];
		}
	} catch {
		/* plain text output from --silent */
	}

	if (!finalText.trim()) {
		return {
			ok: false,
			status: run.status,
			signal: run.signal,
			detail: 'copilot produced an empty final message.',
		};
	}
	writeFileSync(lastMessagePath, finalText);
	return {
		ok: true,
		status: run.status,
		signal: run.signal,
		tokens,
		modelsReported,
		isError: false,
	};
}

export const check = () => checkCopilotCli();
export const run = (opts) => runCopilotCli(opts);
