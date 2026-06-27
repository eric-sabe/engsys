# Worktrees need bootstrap from origin/main

**Trigger:** Creating a fresh worktree (or having a subagent work in one) and tests immediately fail or outputs go missing.

**Failure mode:** A worktree branched off a diverged local tree inherits the divergence. A fresh worktree lacks env files, hook shims, and generated clients/builds, so tests fail for environmental reasons. Subagents resolve relative paths against the MAIN checkout, so their outputs land in the wrong tree.

**Correct behavior:**
- Create worktrees off origin/main when local has diverged.
- Bootstrap the worktree before running tests: env files, hook shims, regenerated clients/builds.
- Pass subagents ABSOLUTE worktree paths, never relative ones.
- Verify outputs actually landed in the worktree, not the main checkout.

**Check:** Does a clean test run pass in the worktree, and are new files physically inside it?

**Seen in:** recurring across multiple production projects.
