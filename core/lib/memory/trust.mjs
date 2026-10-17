// core/lib/memory/trust.mjs — the ONE brief-time Class B trust gate (engsys v2.0.1 round 2, F1).
//
// Before this fix there were TWO gate functions (memory-sync.mjs's isEventTrustedByConfig and
// memory-brief.mjs's isEventTrusted) that had drifted apart — the one actually exercised at
// brief-build time (memory-brief's) still auto-trusted `kind: 'commit'` and still read
// `operator_emails`/`operator_logins`. There is now exactly one gate, imported by both modules.
//
// Trust is numeric-ID only, everywhere:
//   - bot:      author_id (or editor_id) in trusted_bot_user_ids
//   - operator: author_id (or editor_id) in operator_user_ids
//   - member/owner: author_id (or editor_id) in trusted_member_user_ids ∪ operator_user_ids
//   - commit:   routed through the SAME gate as every other kind — no special case. A commit
//     that didn't meet extractEventFromCommit's strict operator criteria is ingested as
//     "unlabeled" (no author_kind, author_id: null, no body) and passes here only via the
//     legacy/unlabeled fallback below — exactly the same path a benign subject-only pointer
//     always used, carrying no body/rationale for the gate to need to protect.
//   - a ref-sourced event that hasn't been through verifyMemoryRefTip is marked
//     `author_kind: 'untrusted_ref'` by loadClassBEvents and is rejected here unconditionally —
//     it matches no known kind and is NOT the legacy/unlabeled shape (no kind at all), so the
//     fallback below does not apply to it.
//
// Removing an ID from trusted_bot_user_ids/operator_user_ids/trusted_member_user_ids immediately
// drops any previously-synced event whose trust depended on it — this function re-evaluates
// against the CURRENT config every time it's called, never caching a past verdict.

/**
 * Evaluate brief-time trust of a Class B event against `config` (docs/memory-spec.md §7.3).
 * When `config` is omitted, returns `true` (caller is explicitly opting out of the gate, e.g. a
 * unit test fixture). Never throws.
 */
export function isEventTrusted(event, config) {
	if (!event || typeof event !== 'object') return false;
	if (!config) return true;
	if (event.kind === 'journal') return true;

	const trustedBots = new Set((config.trusted_bot_user_ids ?? []).map(Number));
	const operators = new Set((config.operator_user_ids ?? []).map(Number));
	const trustedMembers = new Set((config.trusted_member_user_ids ?? []).map(Number));

	function checkKindAndId(kind, id) {
		if (kind === 'bot') return id !== null && trustedBots.has(id);
		if (kind === 'operator') return id !== null && operators.has(id);
		if (kind === 'owner' || kind === 'member') {
			return id !== null && (trustedMembers.has(id) || operators.has(id));
		}
		// Legacy/unlabeled events (no author_kind at all, e.g. a benign subject-only commit
		// pointer, or an old test fixture): allow. An EXPLICIT but unrecognized kind — including
		// the `untrusted_ref` sentinel loadClassBEvents stamps on unverified ref-sourced events —
		// is rejected, never silently allowed.
		if (!kind && id === null) return true;
		return false;
	}

	const authorKind = String(event.author_kind || '');
	const authorId = event.author_id != null ? Number(event.author_id) : null;
	if (!checkKindAndId(authorKind, authorId)) return false;

	const wasEdited =
		event.last_edited_at != null ||
		event.was_edited === true ||
		Boolean(event.created_at && event.updated_at && event.created_at !== event.updated_at);
	if (wasEdited && event.editor_id == null && event.editor_kind == null) return false;

	if (event.editor_kind != null || event.editor_id != null) {
		const editorId = event.editor_id != null ? Number(event.editor_id) : null;
		if (event.editor_kind != null) {
			// The editor's kind was explicitly recorded (evaluateNodeEligibility does this) — gate
			// it exactly like any other actor.
			if (!checkKindAndId(String(event.editor_kind), editorId)) return false;
		} else if (editorId !== authorId) {
			// No editor_kind on record: trust the editor only if it's the SAME actor as the author
			// (trivially fine) or itself a known trusted-by-ID actor in one of the allowlists.
			if (!trustedBots.has(editorId) && !operators.has(editorId) && !trustedMembers.has(editorId)) {
				return false;
			}
		}
	}

	return true;
}
