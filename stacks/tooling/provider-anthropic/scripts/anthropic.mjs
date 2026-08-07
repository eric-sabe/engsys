// anthropic.mjs — provider adapter: a fresh `claude` CLI session as a WORKER,
// under the same package/receipt contract as every other provider. This is the
// explicit fallback, not ambient conductor behavior: it makes "Anthropic
// reviews Codex's work" symmetric with every other lane, and gives the review
// chain a terminal fallback that still ends in a parseable verdict.
//
// The campos27 idle-without-report failure (subagent starts reading, then
// silence, no error, 15–20 min burned) is handled the same way as everywhere
// else: timeout + no-receipt ⇒ exit 2 in worker-run, never patience.

import { checkClaudeCli, runClaudeCli } from './_claude-cli.mjs';

export const name = 'anthropic';
export const family = 'anthropic';

// Strip any remap the conductor's shell may carry: an inherited
// ANTHROPIC_BASE_URL pointed at another vendor would silently make the
// "Anthropic reviewer" not Anthropic — the exact independence lie the
// cross-family rule exists to prevent.
function childEnv() {
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (/^ANTHROPIC_(BASE_URL|AUTH_TOKEN|MODEL|SMALL_FAST_MODEL|DEFAULT_)/.test(k)) delete env[k];
	}
	delete env.CLAUDE_CODE_SUBAGENT_MODEL;
	return env;
}

export function check() {
	return checkClaudeCli();
}

export function run(opts) {
	const r = runClaudeCli({ ...opts, env: childEnv() });
	if (!r.ok) return r;
	if (r.isError) return { ...r, ok: false, detail: 'claude reported an error result.' };
	const foreign = (r.modelsReported || []).filter((m) => !/claude|sonnet|opus|haiku|fable/i.test(m));
	if (foreign.length) {
		return { ...r, ok: false, detail: `a non-Anthropic model answered (${foreign.join(', ')}) — remap bleed; this run is not the Anthropic lane.` };
	}
	return r;
}
