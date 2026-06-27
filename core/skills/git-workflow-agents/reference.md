# Git Workflow for Agents - Reference

This is auxiliary, stack-agnostic reference material for the worktree workflow. The authoritative
guidance is [SKILL.md](SKILL.md). Commands here use placeholders like `<install-deps-command>`,
`<build-command>`, `<test-command>`, and `<project>` — substitute your project's actual tooling.
Examples are shown in bash; translate to your shell as needed.

## Helper Script Sketch

A `create-worktree` helper takes an issue number and slug, then:

```bash
# Usage: create-worktree <issue-number> <slug>
ISSUE="$1"; SLUG="$2"
BRANCH="agent/${ISSUE}-${SLUG}"
WORKTREE="../worktrees/issue-${ISSUE}-${SLUG}"

cd <repo-root>
git fetch origin
git checkout main
git pull origin main

# Create worktree AND branch together
git worktree add "$WORKTREE" -b "$BRANCH"

cd "$WORKTREE"
[ -f ../../<project>/.env.local ] && cp ../../<project>/.env.local .env.local
<install-deps-command>
echo "Worktree ready at $WORKTREE on branch $BRANCH"
```

A `cleanup-worktrees` helper lists worktrees, empties each directory (so removal does not fail with
"Directory not empty" — git won't delete non-git files like dependency dirs or build output), then
removes them and prunes stale references and merged `agent/` branches:

```bash
cd <repo-root>
git worktree list
# For each non-primary worktree: empty its dir, then `git worktree remove <path> --force`
git worktree prune
git branch --merged main | grep 'agent/' | xargs -r git branch -d
```

## Single vs. Multi-Package Workflows

For a single package/module, install and build just that target. For a monorepo touching several
packages, install all workspaces and use the package manager's filter/scope mechanism to build only
the affected packages plus their dependents. The principle is the same regardless of language:
**build the changed package and everything that depends on it.**

## Database / Schema Migration Strategies

When a change includes a schema or data-layer migration, coordinate so parallel agents don't
corrupt a shared database.

- **Strategy 1 — Coordination (recommended for dev):** one agent creates and commits the migration;
  others rebase on `origin/main` and apply pending migrations to their local DB before continuing.
- **Strategy 2 — Separate databases per worktree:** override the DB connection string in each
  worktree's `.env.local`, create a uniquely-named database per worktree, and run migrations there.
- **Strategy 3 — Isolated dev database:** point each worktree at its own remote dev database.

After a migration lands, regenerate any generated client/codegen artifacts and rebuild dependent
packages.

## Infrastructure Validation

If the project uses infrastructure-as-code, validate locally before committing using the project's
IaC tool (Terraform `plan`/`validate`, Bicep `build` + deployment `what-if`/`validate`,
CloudFormation `validate-template`, Pulumi `preview`, etc.). Preview the diff against the target
environment before deploying. Never make changes through a cloud console that bypass the IaC.

## Troubleshooting

### Worktree creation fails

`fatal: '<branch>' is already checked out at '<path>'` — the branch is checked out elsewhere.

```bash
git worktree list                 # find where it's checked out
git worktree remove <path>        # remove if stale
# or pick a new branch name
git worktree add ../worktrees/issue-42-foo-v2 -b agent/42-foo-v2
```

### Worktree won't remove

`contains modified or untracked files` — commit/stash first, or force:

```bash
git worktree remove --force <worktree-path>
```

`Directory not empty` — git does not delete non-git files (dependency dirs, build output). Empty the
directory first, then remove:

```bash
rm -rf ../worktrees/issue-42-foo/*
git worktree remove ../worktrees/issue-42-foo
```

### Build fails after switching worktrees

Stale dependencies are the usual cause. Clean and reinstall:

```bash
rm -rf <deps-dir> <lockfile>
<install-deps-command>
<build-command>
```

### Tests fail with database errors

Point tests at a dedicated test database (separate connection string in `.env.local`/`.env.test`),
reset/seed it, and isolate the test DB per worktree if agents run in parallel.

### Merge conflicts during rebase

```bash
git fetch origin main
git rebase origin/main
# resolve conflicts, then:
git add <resolved-files>
git rebase --continue
# if it gets messy:
git rebase --abort
```

If the rebase stops on a commit already merged to main (expected for stacked branches):

```bash
git rebase --skip
```

After a successful rebase, force-push safely:

```bash
git push --force-with-lease origin agent/<branch>
```

### Disk-space pressure from many worktrees

Prefer a package manager that hard-links/dedupes dependencies, install only the workspaces you need,
and clean build artifacts and removed worktrees aggressively (`git worktree prune`).

## Advanced Workflows

### Cleaning up commit history

```bash
git rebase -i origin/main         # squash/reword/drop commits
git push --force-with-lease       # only if the branch isn't shared
```

### Cherry-picking / sharing work between worktrees

```bash
# In source worktree: find the commit
git log --oneline
# In target worktree: apply it
git cherry-pick <commit-hash>
```

Sharing via committed-and-pushed commits (then `git fetch` + cherry-pick) is safer than copying
working-tree files.

### Switching issues mid-work

Commit WIP (`wip: save progress (#42)`), optionally push to preserve it, create/switch to the other
issue's worktree, and return later by `cd`-ing back.

## GitHub via gh CLI (preferred) and MCP (fallback)

Prefer `gh` CLI for issues, PRs, Actions, and project boards. Examples:

```bash
gh issue create --repo <owner>/<repo> --title "..." --body-file tmp/issue-body.md --label "bug"
gh issue view 42 --repo <owner>/<repo>
gh pr create --base main --head agent/42-foo --title "fix(scope): ..." --body-file tmp/pr-body-42.md
```

The `github` MCP server (configured in `.mcp.json`) is a fallback for when `gh` auth or network
fails. ProjectV2 (project boards) must always use `gh project` / `gh api graphql` — MCP does not
support them.

## Git Worktree Command Reference

```bash
git worktree list                         # list
git worktree list --porcelain             # machine-readable
git worktree add <path> -b <branch>       # new branch + worktree (preferred)
git worktree add <path> <branch>          # existing branch (if not checked out elsewhere)
git worktree add <path> -b <branch> <sha> # from a specific commit
git worktree remove <path>                # remove
git worktree remove --force <path>        # ignore uncommitted changes
git worktree prune                        # drop stale references
git worktree prune --dry-run              # preview
```

To "move" a worktree: note its branch, `git worktree remove` the old path, then `git worktree add`
at the new path.

## Diffing your branch against main

```bash
git diff main...HEAD              # changes in your branch only (merge-base)
git diff main..HEAD              # all differences between the two tips
git diff --name-only main...HEAD # file names only
git diff --stat main...HEAD      # summary stats
```

## FAQ

- **Multiple worktrees for one issue?** No — one issue, one worktree. Use commits to checkpoint and
  share progress.
- **Committed in the main checkout by mistake?** Note the hash, `git reset --hard origin/main` in the
  main checkout, then `git cherry-pick <hash>` in the worktree.
- **Run the same service in two worktrees at once?** Yes, but assign different ports (e.g. via a
  `PORT` env var) to avoid collisions.
- **Worktrees for small fixes?** Only when isolation/parallelism justifies the setup overhead;
  otherwise a plain branch in the main checkout is fine.
