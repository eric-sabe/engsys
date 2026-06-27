# Claim, then act, for irreversible operations

**Trigger:** A destructive or exactly-once operation (charge, send, delete, provision) that must never run twice.

**Failure mode:** Validate-then-destroy leaves a window where two callers both pass validation and both execute. Assuming the provider is idempotent without confirming it means duplicates slip through.

**Correct behavior:**
- Atomically stamp the claim marker FIRST, in the same statement/transaction, before doing the irreversible act.
- Only proceed if your stamp won the claim.
- Execute the irreversible act after the claim is held.
- Clear the marker on failure so legitimate retries can re-claim.
- Never assume provider-side idempotency; confirm it or enforce your own key.

**Check:** If two requests race, does exactly one win the claim and exactly one side-effect occur?

**Seen in:** recurring across multiple production projects.
