# git core.bare flip breaks all worktrees

**Trigger:** Every git command in the main checkout and all its worktrees suddenly fails with `fatal: this operation must be run in a work tree`, or commits from a worktree show an author nobody set (a test/CI-looking name or a `.local`/`.invalid` email). It started after a push, or after a test run under a git hook.

**Failure mode:** A test (or tool) shelled out to `git init` / `git config` with no scrubbed environment. Git hooks export `GIT_DIR` (and `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...): `git push` runs the pre-push hook with them set, and the precheck script and test runner the hook starts inherit them. Git honors `GIT_DIR` over the child's `cwd`, so the "throwaway temp repo" setup rewrote the developer's REAL repository config. Linked worktrees share that config, so one push corrupts every checkout on the machine: `core.bare = true` breaks all of them, and an injected `[user]` section silently mis-authors later commits. It reproduces only under the hook; a plain local test run never exports `GIT_DIR`, so the bug is invisible until a push.

**Correct behavior:**
- Make every git call in tests and tools **hermetic**: strip the repo-location variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_PREFIX`) from the child's env so git acts on its `cwd`. For throwaway repos also isolate config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`).
- Never set author identity with `git config` in a test; pass it per invocation (`-c user.name=... -c user.email=...`) or via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`.
- Add three guardrails: a regression test that exports `GIT_DIR` at a scratch repo and asserts its config is byte-identical after the helper runs (with an un-scrubbed control so it can't pass vacuously); a meta-test that fails the suite when any test spawns raw `git init`/`git config`; a pre-push guard that fails if `core.bare` is `true` or the repo identity matches a test-injected pattern.
- Remediate by editing the SHARED config (`git rev-parse --git-common-dir`), backing it up first: `git config --file "$CFG" core.bare false` and `--remove-section user` if injected. Then look for mis-authored commits; already-pushed ones need an operator decision to re-author. The repair is temporary until the hermetic fix is on the branch that gets pushed.

**Check:** `git config --local --get core.bare` is not `true`, `git config --local --get user.email` is not a test identity, and a test that exports `GIT_DIR=<some repo>/.git` then runs your git helper leaves that repo's `.git/config` byte-identical. Recipes and the helper: the `hermetic-git-tests` skill and `core/lib/git-env.mjs`.

**Seen in:** recurring wherever tests that build temp git repos run from a pre-push hook.
