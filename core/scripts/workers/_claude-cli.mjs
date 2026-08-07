// _claude-cli.mjs — shared plumbing for adapters that run the `claude` CLI as
// a worker harness (provider-anthropic, provider-deepseek). Installed with the
// core worker scripts; pack adapters import it relatively.
//
// The worker is a CHILD claude session, never the conductor's: explicit env,
// explicit tool policy, non-interactive `-p` with JSON output so the final
// message and the responding model are parseable rather than inferred.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export function checkClaudeCli() {
	const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
	if (probe.error?.code === 'ENOENT') return { ready: false, detail: 'the `claude` CLI is not on PATH.' };
	if (probe.status !== 0) return { ready: false, detail: `\`claude --version\` exited ${probe.status}.` };
	return { ready: true, detail: `claude ${String(probe.stdout || '').trim()}` };
}

// Tool policy: workers may read, search, run project commands, and (for
// implement/review) edit — the tree fingerprint and clean-tree checks in
// worker-run enforce what must survive. What no worker may ever do is publish:
// no push, no commit, no PR/issue writes, no remote changes.
const DISALLOWED = [
	'Bash(git push:*)',
	'Bash(git commit:*)',
	'Bash(git remote:*)',
	'Bash(git reset:*)',
	'Bash(gh pr:*)',
	'Bash(gh issue:*)',
	'Bash(gh repo:*)',
	'Bash(gh api:*)',
].join(',');

export function runClaudeCli({ frame, worktree, model, effort, role, timeoutSec, transcriptPath, lastMessagePath, env }) {
	const allowed = (role === 'implement' || role === 'review' ? ['Edit', 'Write'] : [])
		.concat(['Read', 'Grep', 'Glob', 'Bash'])
		.join(',');
	const childEnv = { ...env, CLAUDE_CODE_EFFORT_LEVEL: effort };
	const run = spawnSync(
		'claude',
		['-p', '--output-format', 'json', '--model', model, '--allowedTools', allowed, '--disallowedTools', DISALLOWED],
		{
			cwd: worktree,
			input: frame,
			encoding: 'utf8',
			env: childEnv,
			timeout: timeoutSec * 1000,
			killSignal: 'SIGKILL',
			maxBuffer: 128 * 1024 * 1024,
		},
	);
	writeFileSync(transcriptPath, `${run.stdout || ''}${run.stderr || ''}`);
	if (run.error) {
		return { ok: false, status: run.status, signal: run.signal, detail: `\`claude -p\` could not run: ${run.error.message}` };
	}

	// The final message must come from the structured result, not a stdout
	// scrape — `-p --output-format json` emits one JSON object whose `result`
	// is the worker's last message and whose `modelUsage` names who answered.
	let obj = null;
	try {
		obj = JSON.parse(run.stdout);
	} catch {
		const lastBrace = (run.stdout || '').lastIndexOf('\n{');
		if (lastBrace !== -1) {
			try {
				obj = JSON.parse(run.stdout.slice(lastBrace));
			} catch {
				/* fall through */
			}
		}
	}
	if (!obj || typeof obj.result !== 'string') {
		return {
			ok: false,
			status: run.status,
			signal: run.signal,
			detail: 'claude produced no parseable JSON result — the final message cannot be trusted from a stdout scrape.',
		};
	}
	writeFileSync(lastMessagePath, obj.result);
	const modelsReported = Object.keys(obj.modelUsage || {});
	if (!modelsReported.length && obj.model) modelsReported.push(obj.model);
	return {
		ok: true,
		status: run.status,
		signal: run.signal,
		tokens: obj.usage?.output_tokens ?? null,
		modelsReported,
		isError: obj.is_error === true || obj.subtype === 'error',
	};
}
