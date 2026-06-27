# Read layer must tolerate un-backfilled rows

**Trigger:** A fix ships new code plus a backfill migration for existing rows.

**Failure mode:** Code goes live before the backfill finishes. During that deploy window the read layer encounters legacy rows missing the new field/shape and crashes or misbehaves — an outage caused by the fix itself.

**Correct behavior:**
- Assume the read layer will see not-yet-backfilled legacy rows during the deploy window.
- Default/coalesce missing values safely at read time.
- Don't require the backfilled shape until the backfill is confirmed complete.
- Sequence: ship tolerant read code, run backfill, only then tighten if needed.

**Check:** Does the new read path work correctly against a row in the OLD shape?

**Seen in:** recurring across multiple production projects.
