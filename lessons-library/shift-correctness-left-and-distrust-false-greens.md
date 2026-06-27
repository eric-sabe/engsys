# Shift correctness left, distrust false greens

**Trigger:** You're relying on CI to catch correctness late, or a check is green and you're treating that as proof it ran.

**Failure mode:** Cheap correctness checks deferred to CI cost slow feedback and burn expensive matrix jobs on draft PRs. Worse, a gate that didn't actually RUN shows green: unregistered test specs, missing trigger types, empty gates all pass vacuously.

**Correct behavior:**
- Move fast correctness checks from CI to pre-push hooks.
- Don't fire expensive matrix jobs on draft PRs.
- Treat a green check as suspect until you confirm the job actually executed work.
- Verify execution (specs registered, triggers present, gate non-empty), not just the green badge.

**Check:** Did this gate actually run assertions, or did it pass because it had nothing to do?

**Seen in:** recurring across multiple production projects.
