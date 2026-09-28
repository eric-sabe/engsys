# Run a clean-baseline control before calling failures "known flakes"

**Trigger:** A branch fails tests that pattern-match known flakiness ("a handful of spurious failures locally, CI is authoritative") and you are about to override the gate and ship.

**Failure mode:** "Known flake" is a hypothesis, not a category. If the branch plausibly touches the failure mechanism (a shared rate limit, timing, fixtures, a new request on every page load), the diff may have grown the failure count while the folklore says it is noise. A "flake cluster" can also hide a real pre-existing bug that gets waved through with the rest.

**Correct behavior:**
- Run the same suite, under the same conditions, on a clean checkout of the base branch in a scratch worktree. Same failures there: branch-independent. Fewer failures there: your diff contributes, so investigate before pushing.
- Triage each failure individually before overriding; do not bulk-classify.
- Bootstrap the baseline fully (install, codegen, builds) before it runs. A suite that dies at server startup is a setup gap, not a result.
- Record the baseline evidence on the PR so the override is documented, not judgment.
- If the flake class forces overrides regularly, file it as a harness bug with the evidence and a fix plan instead of letting overriding become routine.

**Check:** Can you point to a control run on the base branch that shows the identical failure set?

**Seen in:** recurring wherever local full-suite runs are flaky and a bypass exists.
