// grok.mjs — provider adapter: xAI Grok, review / critique / investigate lane.
//
// TWO ROUTES, one contract (operator decision 2026-08-07):
//
//   cli  — the Grok Build CLI (`grok`), SUBSCRIPTION-billed (SuperGrok tiers).
//          This is the same engine xAI's grok-build Claude Code plugin shells
//          out to, invoked the way that plugin invokes it: read-only sandbox,
//          plan permission mode, plain output. Tool-capable: Grok can open the
//          package and read the repo itself, so the frame works as designed.
//          Login state is a `grok` session (`grok models` succeeds); binary
//          overridable via $GROK_BINARY.
//   api  — the xAI API (XAI_API_KEY), METERED. No tools, so the adapter
//          inlines the whole package plus the base...HEAD diff into one
//          request (size-capped, loud refusal when over).
//
// Route selection: providers.workers.grok.via = 'cli' | 'api' | 'auto'
// (default auto). Auto prefers the subscription CLI — flat-rate and
// tool-capable — and falls back to the API key. Either way the run must end
// in the same RECEIPT + footer; worker-run validates identically.
//
// Both routes may be unable to RUN the gates (read-only sandbox / no tools);
// the brief's honesty rule requires disclosing that, and routing never makes
// a Grok verdict the sole gate on execution-dependent work.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'grok';
export const family = 'xai';

const API = 'https://api.x.ai/v1';
const MAX_CONTENT_CHARS = 400_000; // API route only: one request carries everything.

const grokBinary = () => process.env.GROK_BINARY || 'grok';

function cliStatus() {
	// `grok models` succeeding is the login probe the official plugin uses.
	// 60s, not 20s: Grok Build indexes the repo's Claude Code config on its
	// FIRST run in a directory, and in a large repo that cold start blew a 20s
	// probe — the doctor reported a logged-in CLI as NOT READY, then READY on
	// the warm re-run. A readiness probe that fails on cold cache is a flaky
	// instrument; warm runs answer in ~3s either way.
	const probe = spawnSync(grokBinary(), ['models'], { encoding: 'utf8', timeout: 60_000 });
	if (probe.error?.code === 'ENOENT') {
		return { ready: false, detail: `the \`${grokBinary()}\` CLI is not on PATH (install: curl -fsSL https://x.ai/cli/install.sh | bash; or set GROK_BINARY).` };
	}
	if (probe.status !== 0) {
		return { ready: false, detail: `\`${grokBinary()} models\` exited ${probe.status} — run \`grok\` and sign in with your SuperGrok subscription.` };
	}
	return { ready: true, detail: `grok CLI logged in (subscription route, read-only sandbox)` };
}

async function apiStatus() {
	if (!process.env.XAI_API_KEY) {
		return { ready: false, detail: 'XAI_API_KEY is not set (console.x.ai → API keys).' };
	}
	try {
		const res = await fetch(`${API}/models`, {
			headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) return { ready: false, detail: `xAI API rejected the key (HTTP ${res.status}).` };
		if (!res.ok) return { ready: false, detail: `xAI API answered HTTP ${res.status}.` };
		return { ready: true, detail: 'xAI API key accepted (metered packaged-diff route, no tools)' };
	} catch (e) {
		return { ready: false, detail: `xAI API unreachable: ${e?.message || e}` };
	}
}

// Route resolution is explicit and reported, never silent: which route a
// verdict came from changes what the verdict could have seen.
async function resolveRoute(conf = {}) {
	const via = conf.via || 'auto';
	if (via === 'cli') return { route: 'cli', status: cliStatus() };
	if (via === 'api') return { route: 'api', status: await apiStatus() };
	const cli = cliStatus();
	if (cli.ready) return { route: 'cli', status: cli };
	const api = await apiStatus();
	if (api.ready) return { route: 'api', status: api };
	return {
		route: null,
		status: { ready: false, detail: `neither route is ready — subscription CLI: ${cli.detail} · API: ${api.detail}` },
	};
}

export async function check(conf = {}) {
	const r = await resolveRoute(conf);
	if (!r.status.ready) return r.status;
	return { ready: true, detail: `via ${r.route} — ${r.status.detail}` };
}

function runCli({ frame, worktree, model, effort, timeoutSec, transcriptPath, lastMessagePath }) {
	// Mirrors the invocation the official grok-build plugin uses for its
	// review flows: explore agent, plan mode, read-only sandbox, plain output.
	// Effort maps into the CLI's low|medium|high.
	const effortMap = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
	const run = spawnSync(
		grokBinary(),
		[
			'-p',
			frame,
			'--agent',
			'explore',
			'--permission-mode',
			'plan',
			'--sandbox',
			'read-only',
			'--cwd',
			worktree,
			'--output-format',
			'plain',
			'--model',
			model,
			'--effort',
			effortMap[effort] || 'high',
		],
		{ cwd: worktree, encoding: 'utf8', timeout: timeoutSec * 1000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 * 1024 },
	);
	writeFileSync(transcriptPath, `${run.stdout || ''}${run.stderr || ''}`);
	if (run.error) {
		return { ok: false, status: run.status, signal: run.signal, detail: `\`${grokBinary()}\` could not run: ${run.error.message}` };
	}
	const message = (run.stdout || '').trim();
	if (!message) {
		return { ok: false, status: run.status, signal: run.signal, detail: 'grok CLI produced no output — the final message cannot be empty.' };
	}
	// Plain output ends with the model's final message; worker-run's last-line
	// parsing tolerates any narration above it and refuses anything that does
	// not CONCLUDE with the footer.
	writeFileSync(lastMessagePath, message);
	return { ok: true, status: run.status, signal: run.signal, tokens: null };
}

async function runApi({ frame, worktree, packageDir, model, timeoutSec, transcriptPath, lastMessagePath }) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'));
	} catch (e) {
		return { ok: false, status: null, detail: `could not read package manifest: ${e?.message || e}` };
	}
	const parts = [
		frame,
		'',
		'NOTE: you have no tools in this lane. Every package file is inlined below —',
		'"open"/"read" instructions above refer to these sections. You cannot run',
		'verify.md; per the brief, disclose that you did not run the gates.',
	];
	for (const rel of Object.keys(manifest.files).sort()) {
		parts.push('', `=== PACKAGE FILE: ${rel} ===`, readFileSync(join(packageDir, rel), 'utf8'));
	}
	if (manifest.base) {
		let diff;
		try {
			diff = execFileSync('git', ['-C', worktree, 'diff', `${manifest.base}...HEAD`], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch (e) {
			return { ok: false, status: null, detail: `could not compute the diff ${manifest.base}...HEAD: ${(e.stderr || e.message || '').toString().trim()}` };
		}
		parts.push('', `=== DIFF ${manifest.base}...HEAD ===`, diff || '(no changes)');
	}
	const content = parts.join('\n');
	if (content.length > MAX_CONTENT_CHARS) {
		return {
			ok: false,
			status: null,
			detail: `package + diff is ${content.length} chars (cap ${MAX_CONTENT_CHARS}) — too large for the packaged-diff route. Use the subscription CLI route or a tool-capable provider.`,
		};
	}

	let res, body;
	try {
		res = await fetch(`${API}/chat/completions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
			signal: AbortSignal.timeout(timeoutSec * 1000),
		});
		body = await res.text();
	} catch (e) {
		return { ok: false, status: null, detail: `xAI API call failed: ${e?.message || e}` };
	}
	writeFileSync(transcriptPath, body);
	if (!res.ok) return { ok: false, status: null, detail: `xAI API answered HTTP ${res.status} — transcript has the body.` };

	let obj;
	try {
		obj = JSON.parse(body);
	} catch {
		return { ok: false, status: null, detail: 'xAI API returned unparseable JSON.' };
	}
	const message = obj?.choices?.[0]?.message?.content;
	if (typeof message !== 'string' || !message.trim()) {
		return { ok: false, status: null, detail: 'xAI API returned no message content.' };
	}
	writeFileSync(lastMessagePath, message);
	// Same identity discipline as every lane: the responding model must be the
	// requested family, or this is not the xAI read it claims to be.
	const answered = String(obj.model || '');
	if (answered && !/grok/i.test(answered)) {
		return { ok: false, status: null, detail: `requested ${model} but "${answered}" answered.` };
	}
	return { ok: true, status: 0, signal: null, tokens: obj?.usage?.completion_tokens ?? null };
}

export async function run(opts) {
	const r = await resolveRoute(opts.providerConfig || {});
	if (!r.route || !r.status.ready) return { ok: false, status: null, detail: r.status.detail };
	console.log(`worker-run: grok route=${r.route} (${r.route === 'cli' ? 'subscription' : 'metered API'})`);
	return r.route === 'cli' ? runCli(opts) : runApi(opts);
}
