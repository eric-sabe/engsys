# Git hook shims are not wired in a fresh worktree, and lint autofix strays

**Trigger:** `git push` (or commit) from a linked worktree fails inside the hook with "cannot find `_/husky.sh`" (or a similar missing shim), before any override variable is consulted. Or a commit from a worktree contains files you never meant to touch.

**Failure mode:**
- The hook manager's shim directory is created by an install step in the main checkout and is not linked into a new worktree, which shares only the common `.git`. The hook aborts while bootstrapping, so a documented emergency bypass (an env var checked *after* the shim loads) never gets a chance. The bypass is for a failing gate, not a missing shim.
- A lint autofix run in a worktree can silently edit unrelated files (for example, stripping a legitimate suppression comment from a script), which then breaks lint on merge.

**Correct behavior:**
- Durable fix: have the worktree bootstrap script link or recreate the shim directory (idempotently), so hooks work normally afterward.
- Until then, run the exact gate the hook would have run, by hand, first (the subset your diff needs: docs lint for docs-only, the full precheck for code), confirm green, and only then push with `--no-verify`. It skips the broken shim, not the checks. Never `--no-verify` past a gate you have not run.
- Before every commit in a worktree, run `git diff --name-only`. Every file listed must be one the change intends. Restore strays with `git checkout -- <file>` and confirm intentional suppressions survived.

**Check:** Does `ls .husky/_` (or your hook manager's shim path) exist in this worktree, and does the diff list only intended files?

**Seen in:** recurring in worktree-based agent workflows with hook managers. See also `worktrees-need-bootstrap-from-origin-main`.
