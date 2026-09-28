# Give every "pick one row" a total order, including the kill-switch path

**Trigger:** Any pick over multiple candidate rows (`.find()`, sort then `[0]`, `max`, a reduction keeping "the latest per key") where the comparison key (a score, a timestamp) can legitimately tie. Also: adding a sort or blend with a weight or flag that can be zeroed to restore old behavior.

**Failure mode:**
- A comparison on the primary key alone has no defined result on a tie. The database's order for equal values is not guaranteed, so the "winner" flips between reads, deploys, and planner changes with no data change. Timestamps at millisecond precision tie routinely under batched or concurrent writes.
- **Kill switch that leaks.** The primary score collapsed correctly to the legacy value when the new weight was zero, but the *tiebreak* kept using the new signal, so a row with a real estimate still outranked an equal-legacy row with none. A golden snapshot "reproduced exactly" only because the fixture was all-null.
- A regression test for the tiebreak used rows that tied on every field asserted, so it could not fail even with the bug present.

**Correct behavior:**
- Append a stable, unique field (`id`) as the final tiebreak of every pick, reduction, and sort. Treat ties as the common case, not an edge case.
- The disabled path of a kill switch must restore the exact old comparator, tiebreak included; do not share comparator logic with the enabled path.
- Test a tie directly: two rows identical on every field the old logic compares, differing only on the field the fix uses, asserting the chosen winner. A fixture where old and new logic agree does not discriminate.

**Check:** For each pick, does the comparator end in a unique field, and does a fixture exist where everything else ties?

**Seen in:** recurring in ranking, dedup, and "latest snapshot per key" code.
