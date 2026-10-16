# Git Workflow for Agents — Extended Reference & Troubleshooting

This reference contains extended worktree helpers, stacked-branch workflows, database migration coordination, and troubleshooting scenarios for [`SKILL.md`](../SKILL.md).

## Helper Script Sketches

### `create-worktree`

```bash
# Usage: create-worktree <issue-number> <slug>
ISSUE="$1"; SLUG="$2"
# Multi-fleet (FLEET_ID set): claim the issue first — node <engsys-root>/lib/claim.mjs acquire
# <owner/repo>#"$ISSUE". No-op in single-fleet mode; a foreign fleet's active claim refuses (exit 4).
BRANCH="agent/${FLEET_ID:+$FLEET_ID/}${ISSUE}-${SLUG}"
WORKTREE="../worktrees/issue-${ISSUE}-${SLUG}"

cd <repo-root>
git fetch origin
git checkout main
git pull origin main

git worktree add "$WORKTREE" -b "$BRANCH"

cd "$WORKTREE"
[ -f ../../<project>/.env.local ] && cp ../../<project>/.env.local .env.local
<install-deps-command>
echo "Worktree ready at $WORKTREE on branch $BRANCH"
```

### `cleanup-worktrees`

Empty each directory before removal so `git worktree remove` does not fail with `"Directory not empty"` when non-git files (`node_modules`, `dist`, `.venv`) remain:

```bash
cd <repo-root>
for wt in issue-42-foo issue-43-bar; do
  rm -rf "../worktrees/$wt/"*
  git worktree remove "../worktrees/$wt" --force
done
git worktree prune
git branch --merged main | grep 'agent/' | xargs -r git branch -d
# Multi-fleet: node <engsys-root>/lib/claim.mjs release <owner/repo>#<number>
```

## Handling Complications

### Database / Schema Migrations

Multiple agents running migrations simultaneously can corrupt a shared database:

1. **Coordination (recommended for dev)**: One agent creates and commits the migration; others rebase on `origin/main` and apply pending migrations locally.
2. **Separate databases per worktree**: Override `DATABASE_URL` in `.env.local` per worktree.
3. **Isolated dev database**: Point each worktree at its own isolated test/dev database or container.

After any schema change, regenerate client/codegen artifacts (`<codegen-command>`) and rebuild dependent packages.

### Stacked Branches

When Phase B depends on Phase A:

```bash
git worktree add ../worktrees/issue-<B>-slug agent/<A>-slug -b agent/<B>-slug
```

Merge PRs in dependency order (`A -> B -> C`). After each merge:

1. `git fetch origin` in the next worktree
2. `git rebase origin/main` (if it stops on an already-merged commit: `git rebase --skip`)
3. Verify: `git log --oneline origin/main..HEAD`
4. Push safely: `git push --force-with-lease origin agent/<branch>` (never `git push --force`)

### Shared Cloud Resources

- Namespace queues/topics/buckets with issue-number prefixes (`issue-42-...`).
- Prefer local emulators where available.
- All infrastructure changes must go through IaC (`Terraform`, `Bicep`, `CDK`, `Pulumi`) — never manual console edits.

## Session Lifecycle Checklist

- **Starting Work**: Issue claimed (`gh issue edit --add-assignee @me` + `claim.mjs acquire`), worktree created with `-b`, `.env*` copied, dependencies installed, codegen run, baseline build green.
- **During Implementation**: Edits confined to worktree, conventional commits referencing `(#<issue>)`, complex commit/PR bodies written to `tmp/` (`--file` / `--body-file`, never HEREDOC), rebased on `origin/main`.
- **Completing Work**: Build, lint, typecheck, and tests green locally before pushing; commits batched logically; PR created with `Closes #<issue>`.
- **After Merge**: Worktree emptied and removed, local/remote branch cleaned up, fleet claim released.
