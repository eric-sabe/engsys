// deepseek.mjs — provider adapter: DeepSeek via the env-remapped `claude` CLI
// (Anthropic-compatible endpoint). Operator decision 2026-08-07 — full tool-use
// harness, two mandatory defenses (docs/multi-provider-spec.md § 6.2):
//
//   1. ENV ISOLATION. The child environment is built from an allowlist, never
//      inherited: the worker must not see the conductor's session, settings
//      overrides, or credentials beyond the DeepSeek key.
//   2. THE ALIAS TRAP. DeepSeek's compat endpoint silently maps unknown model
//      names to deepseek-v4-flash. A Flash run billed as a Pro review is a
//      false green with extra steps, so the responding model is asserted, not
//      assumed — and an unverifiable model is a refusal, not a shrug.

import { checkClaudeCli, runClaudeCli } from './_claude-cli.mjs';

export const name = 'deepseek';
export const family = 'deepseek';

const BASE_URL = 'https://api.deepseek.com/anthropic';

// From scratch, not filtered: an allowlist misses new sensitive vars safely,
// a blocklist misses them dangerously.
function childEnv(model) {
	const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
	const env = {};
	for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
	env.ANTHROPIC_BASE_URL = BASE_URL;
	env.ANTHROPIC_AUTH_TOKEN = process.env.DEEPSEEK_API_KEY || '';
	env.ANTHROPIC_MODEL = model;
	env.ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-v4-flash';
	return env;
}

export function check() {
	const cli = checkClaudeCli();
	if (!cli.ready) return cli;
	if (!process.env.DEEPSEEK_API_KEY) {
		return { ready: false, detail: 'DEEPSEEK_API_KEY is not set (fund platform.deepseek.com and export the key).' };
	}
	return { ready: true, detail: `${cli.detail}, remapped to ${BASE_URL}` };
}

export function run(opts) {
	if (!process.env.DEEPSEEK_API_KEY) {
		return { ok: false, status: null, detail: 'DEEPSEEK_API_KEY is not set.' };
	}
	const r = runClaudeCli({ ...opts, env: childEnv(opts.model) });
	if (!r.ok) return r;
	if (r.isError) return { ...r, ok: false, detail: 'claude reported an error result.' };

	// The alias-trap assertion. `[1m]` requests the long-context option and is
	// not part of the model's identity.
	const want = String(opts.model).replace(/\[1m\]$/, '');
	const got = (r.modelsReported || []).map((m) => m.replace(/\[1m\]$/, ''));
	if (!got.length) {
		return { ...r, ok: false, detail: 'the responding model could not be verified — DeepSeek silently aliases unknown names to flash, so an unverifiable model cannot count.' };
	}
	if (!got.includes(want)) {
		return { ...r, ok: false, detail: `requested ${want} but ${got.join(', ')} answered — the alias trap. Fix the model id in providers config.` };
	}
	return r;
}
