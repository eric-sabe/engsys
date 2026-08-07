// grok.mjs — provider adapter: xAI Grok as a PACKAGED-DIFF lane (review /
// critique / investigate) over the OpenAI-compatible xAI API.
//
// Harness decision (2026-08-07, closing spec § 10): the thin xAI-API runner.
// Chosen on ground truth — no Grok plugin exists on this machine, and a plugin
// dependency would gate the whole lane on a third-party install. The trade is
// explicit: Grok gets NO tools. It cannot open files or run gates, so the
// adapter inlines the entire package plus the diff into one request, and the
// brief's honesty rule does the rest (a reviewer must disclose what it could
// not run). Its verdict is one family's read of the packaged evidence —
// exactly what the adversarial lane needs, and never the sole gate.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'grok';
export const family = 'xai';

const API = 'https://api.x.ai/v1';
// One request carries everything; past this the packaged-diff lane is the
// wrong tool and pretending otherwise would silently truncate the evidence.
const MAX_CONTENT_CHARS = 400_000;

export async function check() {
	if (!process.env.XAI_API_KEY) {
		return { ready: false, detail: 'XAI_API_KEY is not set (console.x.ai → API keys, then export it in ~/.zshenv).' };
	}
	try {
		const res = await fetch(`${API}/models`, {
			headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 401 || res.status === 403) return { ready: false, detail: `xAI API rejected the key (HTTP ${res.status}).` };
		if (!res.ok) return { ready: false, detail: `xAI API answered HTTP ${res.status}.` };
		return { ready: true, detail: 'xAI API reachable, key accepted (packaged-diff lane — no tools, gates disclosed as not run)' };
	} catch (e) {
		return { ready: false, detail: `xAI API unreachable: ${e?.message || e}` };
	}
}

export async function run({ frame, worktree, packageDir, model, timeoutSec, transcriptPath, lastMessagePath }) {
	if (!process.env.XAI_API_KEY) return { ok: false, status: null, detail: 'XAI_API_KEY is not set.' };

	// No tools means the package must travel IN the prompt: every file the
	// manifest lists, then the diff itself for diff-scoped roles.
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
			detail: `package + diff is ${content.length} chars (cap ${MAX_CONTENT_CHARS}) — too large for the packaged-diff lane. Use a tool-capable provider for this one.`,
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
