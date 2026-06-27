# Dependabot triage playbook

**Trigger:** A pile of Dependabot PRs and security alerts has accumulated and you need to clear it without breaking the build.

**Failure mode:** Merging blindly in arbitrary order causes conflicts, chases ghost alerts already fixed, and lands risky majors next to coordinated changes — turning a routine chore into a multi-day breakage.

**Correct behavior (6 phases, in order):**
- Phase 0 — Kill noise: regenerate the lockfile to clear ghost/transitive alerts already resolved.
- Phase 1 — Merge the patch group together.
- Phase 2 — Address residual real CVEs.
- Phase 3 — Take safe major bumps.
- Phase 4 — Risky majors, one per PR.
- Phase 5 — Docker base-image coordination, last.

**Check:** After each phase, is the build green before starting the next?

**Seen in:** recurring across multiple production projects.
