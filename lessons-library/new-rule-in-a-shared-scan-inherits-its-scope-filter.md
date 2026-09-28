# A rule added to a shared scan inherits that scan's audience filter

**Trigger:** You add a new rule or feature to an existing evaluator, sweep, or enumeration (a scheduled scan over users, tenants, records) instead of writing a new one.

**Failure mode:** The existing scan filters its population for a reason that fits its original feature (for example, only non-terminal funnel stages, which is right for onboarding nudges). The new rule's true audience is a different population (a usage meter's audience is the *active* users the filter excludes). The rule can never fire for the cohort it exists for, and nothing errors. An efficiency filter for one feature is a silent coverage hole for another.

**Correct behavior:**
- When adding a rule to a shared scan, state the new rule's audience explicitly and compare it with the scan's existing scope filter.
- If they differ, give the rule its own enumeration (or a filter override) rather than bending the shared one.
- Add a test whose fixture sits in the new rule's audience but outside the old filter; it fails until the coverage hole is closed.

**Check:** Could a record that should trigger the new rule be dropped by an upstream filter before the rule sees it?

**Seen in:** recurring in scheduled evaluators and notification pipelines.
