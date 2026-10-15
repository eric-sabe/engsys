---
name: git-workflow-agents
description: Implement issues in isolated Git worktrees and create Conventional Commits without conflicts when multiple AI agents work in parallel. Use when implementing issues, creating feature branches, committing changes, or when the user mentions worktrees, "/commit", or agent implementation workflow.
---

# Git Workflow & Conventional Commits for Agents

This skill guides AI agents through implementing issues in **isolated Git worktrees** and authoring **Conventional Commits** without source tree conflicts during parallel work.

## Phase 1: Session Initialization

### Step 1: Claim the Issue

```bash
gh issue edit 42 --repo <owner>/<repo> --add-assignee @me
```

Everything GitHub goes through `gh` (`gh issue`, `gh pr`, `gh project`, `gh api graphql`) — never a GitHub MCP server.

**Multi-fleet (`FLEET_ID` set):** claim the issue from the fleet queue before creating the worktree:

```bash
node <engsys-root>/lib/claim.mjs acquire <owner/repo>#42
```

Exits `4` if another fleet holds an active claim (stop and do not implement). Single-fleet mode (no `FLEET_ID`) is a no-op (`exit 0`).

### Step 2: Create Worktree and Branch Together (`-b`)

```bash
cd <repo-root>
git fetch origin
git checkout main
git pull origin main

# Always create worktree AND branch together with -b:
git worktree add ../worktrees/issue-<number>-<slug> -b agent/${FLEET_ID:+$FLEET_ID/}<issue>-<slug>
```

Never run `git checkout -b` in the main checkout before `git worktree add`.

### Step 3: Initialize Environment & Confirm Isolation

```bash
cd ../worktrees/issue-42-tenant-validation
cp ../../<project>/.env.local .env.local
<install-deps-command>
<codegen-command>
<build-command>
git branch --show-current   # agent/42-tenant-validation
git worktree list
```

If a gate step reads secrets from the process environment, export `.env.local` first (`set -a && source .env.local && set +a`).

## Phase 2: Implementation & Conventional Commits

### Conventional Commit Format

```text
<type>[optional scope]: <description> (#<issue>)

[optional body]

[optional footer(s)]
```

| Type       | Purpose                        |
| ---------- | ------------------------------ |
| `feat`     | New feature                    |
| `fix`      | Bug fix                        |
| `docs`     | Documentation only             |
| `style`    | Formatting/style (no logic)    |
| `refactor` | Code refactor (no feature/fix) |
| `perf`     | Performance improvement        |
| `test`     | Add/update tests               |
| `build`    | Build system/dependencies      |
| `ci`       | CI/config changes              |
| `chore`    | Maintenance/misc               |
| `revert`   | Revert commit                  |

Breaking changes append `!` after type/scope (`feat!: ...`) or include a `BREAKING CHANGE:` footer.

### Staging & Committing (`tmp/` File Rule — Never HEREDOC)

1. Inspect changes with `git diff --staged`, `git diff`, and `git status --porcelain`.
2. Stage logical groups (`git add path/to/file1 path/to/file2`). **Never commit secrets** (`.env`, `credentials.json`, private keys).
3. For single-line commits:
   ```bash
   git commit -m "feat(scope): implement core change (#42)"
   ```
4. For multi-line commit messages, **always write the message to `tmp/commit-msg-<issue>.txt` using the file-write tool and pass `-F` / `--file`** (never use shell HEREDOCs or pipes):
   ```bash
   git commit -F tmp/commit-msg-42.txt
   ```

### Git Safety Protocol

- **NEVER** update git config or skip hooks (`--no-verify`) unless explicitly requested.
- **NEVER** force-push to `main`/`master`; on feature branches after rebase, always use `git push --force-with-lease`.
- If a commit fails due to pre-commit hooks, fix the issue and create a **new** commit rather than amending a published commit.
- Batch related commits (`feat` + `test` + `docs`) and run the local pre-push gate before pushing once.

## Phase 3: Pre-Push Verification & Pull Request

1. **Run the full local gate before pushing** (see `pre-push` skill):
   ```bash
   <codegen-command>
   <build-command>
   <lint-command>
   <test-command>
   ```
2. **Push branch**:
   ```bash
   git push -u origin agent/${FLEET_ID:+$FLEET_ID/}42-tenant-validation
   ```
3. **Create PR via `--body-file`** (write `tmp/pr-body-42.md` first with summary, `Closes #42`, and test plan):
   ```bash
   gh pr create \
     --base main \
     --head agent/${FLEET_ID:+$FLEET_ID/}42-tenant-validation \
     --title "feat(scope): short description (#42)" \
     --body-file tmp/pr-body-42.md
   ```

## Phase 4: Cleanup After Merge

```bash
cd <repo-root>
rm -rf ../worktrees/issue-42-tenant-validation/*
git worktree remove --force ../worktrees/issue-42-tenant-validation
git worktree prune
git branch -d agent/42-tenant-validation
node <engsys-root>/lib/claim.mjs release <owner/repo>#42   # no-op in single-fleet mode
```

## Extended Reference

For stacked branches, database migration coordination across worktrees, shared cloud resource isolation, and troubleshooting, see [`references/workflow-details.md`](references/workflow-details.md) and [`reference.md`](reference.md).
