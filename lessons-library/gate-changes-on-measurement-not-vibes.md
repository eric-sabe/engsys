# Gate changes on measurement, not vibes

**Trigger:** You're about to adopt a "best practice" or standard technique, or write a claim about a measurable property.

**Failure mode:** Intuition and reputation mislead. A technique that's standard everywhere can measurably degrade YOUR corpus. Writing "this meets contrast requirements" or "this improves hit-rate" without computing the number ships a false claim.

**Correct behavior:**
- Gate changes on an eval / golden-set, not on intuition or "everyone does this."
- If a standard technique degrades your actual metric, reject it (or keep it behind a flag).
- Compute the real metric (e.g. contrast ratio, hit-rate, accuracy) before asserting it.
- Keep the eval cheap enough to run on every relevant change.

**Check:** Is there a number from your own corpus backing this change, measured before and after?

**Seen in:** recurring across multiple production projects.
