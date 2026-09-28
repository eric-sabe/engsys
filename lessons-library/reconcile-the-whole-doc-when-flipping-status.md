# Flipping a doc's status means reconciling its whole body

**Trigger:** You change a document's status or framing at the top: a decision record moves Proposed to Accepted or Superseded, "deferred" becomes "shipped", "planned" becomes "implemented", or you add a "reconciled on..." note.

**Failure mode:** The header asserts the new state while the body still describes the old one: the plan section says deferred, the consequences list a removed service as present, a recommendation predates the ship and is now false. The doc contradicts itself and reads as **authoritative but wrong**, which is worse than never flipping it. A second variant over-claims the verification: the status line says every line was re-traced when it wasn't.

**Correct behavior:**
- Bring the entire body into agreement, not just the header: decision, implementation order or plan, current state, consequences (positive and negative), recommendation tables, and inline "TODO / pending / will ship" phrasing.
- For a "mark as shipped" pass, verify each body claim against the code before keeping it. A recommendation that predates the ship (a cookie policy, an endpoint shape, a removed component) may no longer be true.
- Do not claim more verification than you did.

**Check:** Before pushing, re-grep the edited file for the old status word and the stale-state vocabulary (`deferred|proposed|planned|pending|TODO|not yet|will be`, plus the old names of things that changed). Every surviving hit is either a contradiction to fix or a deliberate historical reference clearly marked as past tense.

**Seen in:** the dominant finding family in every docs-reconciliation pass reviewed, including the highest-severity ones.
