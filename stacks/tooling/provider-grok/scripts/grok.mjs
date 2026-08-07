// grok.mjs — provider adapter: xAI Grok, review / critique / investigate lane.
//
// The concrete harness is deliberately unconfirmed (docs/multi-provider-spec.md
// § 10, M2 kickoff decision): candidates are the Grok plugin path or a thin
// xAI-API runner. Until one is wired AND emits the receipt footer, Grok is a
// best-effort critique assistant, not a worker channel — so this adapter
// refuses loudly rather than pretending. An unavailable gate must never
// degrade into a green one.

export const name = 'grok';
export const family = 'xai';

export function check() {
	return {
		ready: false,
		detail: 'harness not confirmed yet (spec § 10). Wire the Grok plugin or a thin xAI-API runner into this adapter at M2, then it can carry review/critique.',
	};
}

export function run() {
	return {
		ok: false,
		status: null,
		detail: 'the grok adapter has no confirmed harness yet — dispatch the next provider in the chain (spec § 10, M2).',
	};
}
