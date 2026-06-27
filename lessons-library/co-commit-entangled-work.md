# Co-commit entangled work

**Trigger:** You're splitting work into one-commit-per-issue, but several issues touch the same files; or rebasing a stacked PR after an upstream squash-merge.

**Failure mode:** Forcing artificial 1:1 commit-per-issue when issues share files produces commits that don't build in isolation. Rebasing over a squash-merge re-applies already-merged commits, creating conflicts and phantom changes.

**Correct behavior:**
- Co-commit issues that share files when splitting would break the build; cite ALL issue numbers in the subject.
- Don't force artificial one-commit-per-issue at the cost of a buildable history.
- When rebasing a stacked PR after an upstream squash-merge, skip already-applied commits.
- Verify the final diff contains ONLY new work, nothing already merged.

**Check:** Does each commit build, and is the final rebased diff free of already-merged changes?

**Seen in:** recurring across multiple production projects.
