# A new time predicate silently guts every "now"-stamped fixture

**Trigger:** You add a temporal admissibility condition to a join or filter (a freshness gate, recency window, effective-date filter) comparing timestamps from two different sources, and tests build both sides with `new Date()` or `now()` defaults.

**Failure mode:** Fixture factories create one side "now" and the other with an older default window (for example, snapshots opening 30 days ago). The moment the predicate lands, every existing fixture pair becomes inadmissible. Suites either fail wholesale or, worse, keep passing vacuously wherever the assertion was "suppressed" or "empty".

**Correct behavior:**
- Immediately audit the factories feeding both sides of the join for now-based defaults.
- Fix the **fixture primitive**, not each spec: give the factory an explicit "written at" option whose default models the honest timeline (for example, predictions backdated before the window opens). Existing specs then keep testing what they claim, and only a deliberate touch trips the new gate, which the predicate's own spec does.
- Most ORMs let you set created and updated columns explicitly on insert; use raw SQL only to backdate a row written through a real production path, since any ORM update re-bumps an auto-updated column.

**Check (tripwire):** A new `WHERE` clause comparing two timestamps that come from different fixture factories.

**Seen in:** recurring when gating rules are added to established data-pipeline tests.
