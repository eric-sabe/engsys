---
name: git-workflow-agents
description: Implement GitHub issues using isolated Git worktrees to prevent conflicts when multiple AI agents work in parallel. Use when implementing issues, creating feature branches, or when the user mentions worktrees, parallel work, or agent implementation workflow.
---

# Git Workflow for Agents

This skill guides AI agents through implementing GitHub issues in **isolated worktrees** to prevent source tree conflicts during parallel work.

## Why Worktrees?

Git worktrees provide independent working directories while sharing the same `.git` repository, preventing:

- File conflicts between agents
- Branch collisions
- Build interference
- Test pollution
- Context confusion

## Quick Start: Implementing an Issue

### Phase 1: Session Initialization

#### Step 1: Claim the Issue

```bash
# Preferred: gh CLI
gh issue edit 42 --repo <owner>/<repo> --add-assignee @me
```

The `github` MCP server (in [.mcp.json](../../../.mcp.json)) is a fallback for when `gh` auth or network fails. Project board operations (priorities, fields, statuses) **must** still use `gh project` / `gh api graphql` — the MCP server doesn't support ProjectV2.

#### Step 2: Create Worktree and Branch

**CRITICAL**: Create branch and worktree together using `-b` flag:

```bash
# Navigate to main repo
cd <repo-root>   # e.g. /Users/<you>/git/<project>

# Update main branch
git fetch origin
git checkout main
git pull origin main

# Create worktree AND branch together (required)
git worktree add ../worktrees/issue-<number>-<slug> -b agent/<issue>-<slug>

# Example:
git worktree add ../worktrees/issue-42-tenant-validation -b agent/42-tenant-validation
```

**Common Mistake to Avoid:**

```bash
# ❌ WRONG - Don't create branch first
git checkout -b agent/42-tenant-validation
git worktree add ../worktrees/issue-42-tenant-validation agent/42-tenant-validation

# ✅ CORRECT - Use -b flag
git worktree add ../worktrees/issue-42-tenant-validation -b agent/42-tenant-validation
```

#### Step 3: Initialize Environment

```bash
# Navigate to worktree
cd ../worktrees/issue-42-tenant-validation

# Copy environment config from the main checkout
cp ../../<project>/.env.local .env.local

# Install dependencies (isolated) — use the project's package/dependency manager
<install-deps-command>

# Verify setup
<build-command>
```

#### Step 4: Confirm Isolation

```bash
# Verify branch
git branch --show-current
# Should output: agent/42-tenant-validation

# Verify worktrees
git worktree list
# Should show both main repo and your worktree
```

### Phase 2: Implementation

**Work entirely in your worktree**. Standard development cycle:

**Make Changes:**

- Edit files using Write/StrReplace tools
- Run tests: `<test-command>`
- Build: `<build-command>`
- Lint: `<lint-command>`

**CRITICAL Pre-Push Verification:**

Before pushing, ALWAYS verify (see root CLAUDE.md § Pre-push gate and the `pre-push` skill):

```bash
<build-command>   # Must pass
<lint-command>    # Must pass
<test-command>    # Must pass (if applicable)
```

**Commit Strategy:**

```bash
# Commit frequently to checkpoint work
git add -A
git commit -m "feat(scope): implement core change (#42)"

# Continue working, commit again
git commit -m "test(scope): add edge case tests (#42)"

# Continue, commit docs
git commit -m "docs(scope): update docs (#42)"

# NOW verify everything and push all commits together
<build-command>; <lint-command>  # Verify first
git push  # Pushes all commits - triggers CI ONCE
```

**When to Batch Commits (Preferred):**

- Related feature work across multiple commits
- Implementation + tests + docs
- Sequential fixes for same issue

**When to Push Immediately:**

- Critical security fixes
- Breaking production issues
- Changes others are waiting on

**Stay Current with Main:**

```bash
# Rebase regularly to avoid drift
git fetch origin main
git rebase origin/main

# Resolve conflicts if any
# Then: git rebase --continue
```

### Phase 3: Completion

#### Step 1: Final Validation

Before pushing, verify everything:

```bash
# Required checks
<build-command>      # No build/compile errors
<lint-command>       # No linting errors
<test-command>       # All tests pass

# For changes that require codegen (schema/data layer, generated clients, etc.)
<codegen-command>    # Regenerate any generated artifacts
<build-command>      # Verify dependent packages still build
```

**If any check fails:**

- ❌ DO NOT PUSH
- Fix issues locally
- Re-run checks until all pass
- Then push

#### Step 2: Push Branch

```bash
git push -u origin agent/42-tenant-validation
```

#### Step 3: Create Pull Request

Use tmp/ folder for PR body (NEVER use HEREDOC):

```bash
# 1. Create PR body using Write tool in tmp/pr-body-42.md
# Include:
# - Summary of changes
# - Closes #42
# - Testing checklist

# 2. Create PR
gh pr create \
  --base main \
  --head agent/42-tenant-validation \
  --title "fix(scope): short description" \
  --body-file tmp/pr-body-42.md
```

#### Step 4: Auto-Close Issue

If PR body includes `Closes #42`, GitHub auto-closes the issue when PR merges.

### Phase 4: Cleanup (After PR Merge)

Empty the worktree directory before `git worktree remove`, or it may fail with "Directory not empty" (common on Windows with leftover node_modules, dist).

```bash
# Navigate to main repo
cd <repo-root>   # e.g. /Users/<you>/git/<project>

# Empty worktree directory first (avoids "Directory not empty" on Windows; harmless on mac)
rm -rf ../worktrees/issue-42-tenant-validation/*

# Remove worktree
git worktree remove ../worktrees/issue-42-tenant-validation

# Force remove if uncommitted changes or if empty failed
git worktree remove --force ../worktrees/issue-42-tenant-validation

# Delete local branch (optional)
git branch -d agent/42-tenant-validation

# Delete remote branch if not auto-deleted
git push origin --delete agent/42-tenant-validation
```

## Critical Rules

### 1. Use tmp/ Folder for Complex Content

**NEVER use HEREDOC or pipes** for commit messages, PR bodies, or issue content:

```bash
# ✅ GOOD - Use tmp/ folder
# 1. Write content to tmp/commit-msg-42.txt using Write tool
# 2. Then commit:
git commit --file tmp/commit-msg-42.txt

# ✅ GOOD - PR body
# 1. Write to tmp/pr-body-42.md using Write tool
# 2. Then create PR:
gh pr create --title "fix: description" --body-file tmp/pr-body-42.md

# ❌ BAD - HEREDOC or pipes
git commit -m "$(cat <<'EOF'
Long message
EOF
)"
```

### 2. Verify Before Pushing

From root CLAUDE.md § Pre-push gate:

- Run the project's build, lint, and test commands locally
- Fix all issues before pushing
- Don't use CI as your linter
- Saves GitHub Actions minutes (finite resource)

### 3. Batch Commits Before Pushing

- Group related changes (feature + tests + docs)
- Push once for multiple commits
- Don't push individual lint fixes

### 4. IaC-First for Infrastructure

If the project provisions infrastructure, all infrastructure changes MUST go through
infrastructure-as-code (Terraform, Bicep, CloudFormation, Pulumi, etc.) rather than manual
console edits. Validate the IaC locally before committing, using the project's chosen tool. See
the project's infrastructure CLAUDE.md / stack fragment for the exact commands.

### 5. Tool preference order

See root CLAUDE.md § Tool preference order:

- Use `gh` CLI first (issues, PRs, Actions, Projects, GraphQL, `--format json`).
- The `github` MCP server (in `.mcp.json`) is a fallback for when `gh` auth/network fails.
- ProjectV2 (project boards) **always** use `gh project` / `gh api graphql` — MCP does not support them.

## Directory Structure

```text
<repo-root>/                       # e.g. /Users/<you>/git/
├── <project>/                       # Main repository (trunk)
│   ├── .git/                        # Shared git data
│   ├── src/
│   ├── infrastructure/
│   └── ...
│
└── worktrees/                       # Parallel agent workspaces
    ├── issue-42-tenant-validation/
    │   ├── src/
    │   ├── <deps-dir>/              # Isolated dependencies (node_modules, .venv, target, …)
    │   └── .env.local               # Copied from main
    │
    └── issue-57-add-export-api/
        └── ...
```

## Handling Complications

### Database Migrations

**Problem**: Multiple agents running migrations simultaneously can corrupt a shared DB.

**Solutions:**

1. Coordinate - only one agent runs migrations at a time
2. Separate databases per worktree (override the DB connection string in `.env.local`)
3. Use an isolated dev database per worktree

### Merge Conflicts

**Solutions:**

1. Rebase early and often: `git rebase origin/main`
2. Keep PRs small and focused
3. Standard git conflict resolution in your worktree

**If rebase stops on a commit already merged to main** (you'll see "skipped previously applied commit" in the output — this is expected for stacked branches), skip it and continue:

```bash
git rebase --skip
```

**After successful rebase, always force-push:**

```bash
git push --force-with-lease origin agent/<branch>
```

Never use `git push --force` — `--force-with-lease` is safer (fails if someone else pushed).

### Stacked Branches

When a group of issues must build on each other (e.g. Phase 1 depends on Phase 0), create each worktree based on the previous branch rather than main:

```bash
# B depends on A
git worktree add ../worktrees/issue-<B>-slug agent/<A>-slug -b agent/<B>-slug
```

**Merge order matters** — merge PRs in dependency order: A → B → C. After each merge:

1. `git fetch origin` in the next worktree
2. `git rebase origin/main` — git skips commits now on main automatically
3. If it stops on an already-merged commit: `git rebase --skip`
4. Verify: `git log --oneline origin/main..HEAD` — should show only your new work
5. `git push --force-with-lease`

### Cleanup After All PRs Merged

```bash
# Bring local main current (rebase, not merge, to stay linear)
cd /path/to/main/repo
git fetch origin
git rebase origin/main

# Empty each worktree dir first, then remove (avoids "Directory not empty" on Windows)
for wt in issue-42-foo issue-43-bar; do
  # PowerShell: rm -rf "../worktrees/$wt/*"
  git worktree remove ../worktrees/$wt --force
done
git worktree prune

# Delete all local agent branches at once
git branch | grep "agent/" | xargs git branch -D
```

### Shared Cloud Resources

**Solutions:**

1. All dev worktrees share dev-environment resources
2. Namespace isolation: use issue-number prefixes in queue/topic/bucket names
3. Use local emulators where available (local DB, local queue, local cache)

## Session Lifecycle Checklist

**Starting Work:**

- [ ] Issue assigned to me
- [ ] Branch created: `agent/<issue>-<slug>`
- [ ] Worktree created with `-b` flag
- [ ] `.env.local` copied from main
- [ ] Dependencies installed
- [ ] Build passes
- [ ] Working in worktree, not main repo

**During Implementation:**

- [ ] All edits in my worktree
- [ ] Commits reference issue: `(#42)`
- [ ] Using tmp/ folder for complex content
- [ ] Rebasing on `origin/main` regularly
- [ ] Tests pass after significant changes
- [ ] Following IaC-first for infrastructure
- [ ] Running build/lint locally before pushing
- [ ] Batching related commits together

**Completing Work:**

- [ ] Final build passes
- [ ] Final tests pass
- [ ] Type/static checks pass (if applicable)
- [ ] Lint passes
- [ ] All verification BEFORE pushing
- [ ] Commits batched logically
- [ ] Branch pushed to origin
- [ ] PR created with tmp/ body
- [ ] PR includes `Closes #<issue>`

**After Merge:**

- [ ] Worktree removed
- [ ] Local branch deleted
- [ ] Remote branch deleted (if needed)
- [ ] tmp/ files cleaned up

## Additional Resources

For detailed information on:

- Database migration strategies
- Service-specific workflows
- Helper scripts
- Troubleshooting scenarios

See [reference.md](reference.md)

## Integration with Issue Tracking

This workflow integrates with root [CLAUDE.md](../../../CLAUDE.md) § Filing issues:

| Phase          | Issue Tracking          | Git Workflow                    |
| -------------- | ----------------------- | ------------------------------- |
| Discovery      | User reports issue      | —                               |
| Investigation  | AI investigates         | —                               |
| Issue Creation | AI creates GitHub issue | —                               |
| Implementation | —                       | AI creates worktree, implements |
| Completion     | AI closes issue         | AI creates PR, cleans up        |

**Handoff**: Once issue exists with clear solution, this workflow takes over.

## Remember

**Key Principles:**

- One issue, one branch, one worktree
- Use tmp/ folder for complex content
- Prefer `gh` CLI (`github` MCP is a fallback only)
- Follow IaC-first principle
- **Always verify locally before pushing**
- **Batch commits before pushing**
- Clean up promptly after merge

**This workflow enables parallel agent work without conflicts.**
