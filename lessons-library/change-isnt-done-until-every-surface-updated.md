# A change isn't done until every surface is updated

**Trigger:** You renamed something, changed a signature, or reworked a flow/copy.

**Failure mode:** The change ripples further than the diff. Docs, config, fixtures, mock factories, marketing copy, notifications, and E2E specs that assert the old copy/flow still reference the old shape — so half the system is inconsistent and tests pass on stale assumptions.

**Correct behavior:**
- Enumerate every surface the change touches: code call-sites, docs, config, fixtures, mock factories, user-facing copy, notifications.
- Update all call-sites AND their test assertions AND mock/factory definitions.
- Update E2E specs that assert the changed copy or flow.
- Land all of it in the SAME PR, not as follow-ups.

**Check:** Grep for the old name/string across the whole repo — zero hits outside history?

**Seen in:** recurring across multiple production projects.
