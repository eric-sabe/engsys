# Agent Implementation Workflow

Implement tracker issues using Git worktrees for isolation. The default unit is a **phase PR**: all issues in one project phase become individual commits in one branch, one worktree, one PR.

If a project has no phases, implement all selected issues in one PR. If there is only one issue, the PR naturally contains one issue. Do not split into one PR per issue unless the human explicitly asks.

Work-item operations (claim, fetch state, record findings, link/close) go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) via its contract operations (`get-issue`, `update-issue`, `comment-issue`, `link-pr`). The skill maps them onto the active backend; the GitHub `gh` commands shown below are what it runs on a GitHub project. PR creation (`gh pr create`), CI, and worktree/git mechanics stay on GitHub regardless of tracker.

## Start Command Authorization

When a human says `Start on Project <number>`, `Start on issue <number>`, `Implement Project <number>`, or equivalent implementation wording while pointing at this workflow, treat that as explicit authorization to complete the normal agent implementation cycle:

- scope the batch
- create the worktree and branch
- edit files
- create the issue-scoped implementation commits
- run validation
- run the local code review and resolve findings
- push the agent branch
- open the PR and record the review findings

Do not pause after validation solely to ask whether commits, push, or PR creation are allowed. This workflow is the authorization for those routine implementation steps.

Still require a separate explicit human instruction before merging PRs, pushing to `main`, force-pushing anything except the active agent branch with `--force-with-lease` during documented rebase recovery, or running destructive cleanup outside the completed/merged workflow.

---

## Phase 0: Scope the Batch

Before creating the worktree:

- Review `docs/agent-lessons/` so recent mistakes and tool lessons are fresh in context.
- Fetch the current issue/project state from the tracker via the skill's `get-issue` / `query-board` operations, not stale local notes.
- Identify the implementation batch:
  - phased project: one phase = one PR
  - unphased project: all selected issues = one PR
  - single issue: one issue = one PR
- Assign every issue in the batch to yourself via the skill's `update-issue` operation.
- Build a commit plan: each issue gets its own implementation commit referencing that issue number.

```bash
# GitHub realization of update-issue (claim):
gh issue edit <number> --add-assignee "@me"
```

---

## Phase 1: Setup

```bash
# From the main repo root, ensure main is current
git fetch origin && git checkout main && git pull --ff-only origin main

# If pull --ff-only fails (local main diverged from origin/main due to squash merges),
# reset local main before creating the worktree:
#   git reset --hard origin/main
# OR create the worktree directly from origin/main (safest):
#   git worktree add ../worktrees/<slug> -b agent/<slug> origin/main

# Create the worktree AND branch in one command (-b flag is CRITICAL)
git worktree add ../worktrees/<phase-or-project-slug> -b agent/<phase-or-project-slug> origin/main

cd ../worktrees/<phase-or-project-slug>
# install deps + run any codegen the project requires (see CLAUDE.md)
```

Use a branch slug that describes the batch, not just the first issue. Examples:

- `agent/project-11-phase-2-enrichment`
- `agent/settings-billing-metrics`
- `agent/957-tenant-switching` for a single-issue PR

> **Project bootstrap:** a fresh worktree has no installed dependencies and may need codegen (client generation, schema build, etc.). Run the project's bootstrap (`CLAUDE.md` § setup) inside the worktree before building.

---

## Phase 2: Implement

- Edit files inside the worktree only.
- Complete one issue at a time and commit it before moving to the next issue.
- Each implementation commit must reference the issue it satisfies: `feat(<scope>): add invite endpoint (#131)`.
- **File-overlap exception:** when two issues legitimately touch the same source files (same controller, DTO, service), forcing a split creates a broken intermediate commit. Co-commit those issues instead and cite all issue numbers in the subject: `feat(<scope>): PATCH /auth/me + PATCH /auth/me/default-tenant (#1565, #1566)`. The PR body's `Closes #` lines still auto-close all issues on merge.
- Keep review-fix commits (from the local review or later human review) as follow-ups after the issue commits.
- Use the `tmp/` folder for commit messages and PR bodies — **never HEREDOC**.

```bash
# Write the commit message to a file, then commit
git commit -F tmp/commit-msg-<issue-number>.txt
```

---

## Phase 3: Verify + Review Before Push

When all issue commits are complete, validate locally **and run the local code review** before pushing or opening the PR. Go in clean: a clean local review means the first CI run is also the last.

```bash
git fetch origin                       # local main is often stale in a worktree
<the project's pre-push gate / precheck>   # build, lint, format, unit tests, path-gated gates
<a local code review against origin/main>  # built-in /code-review skill, or the project's CLI reviewer
```

If any gate fails, fix locally and re-run. The project's pre-push gate (and the local pre-push hook, if it has one) is the contract; see `/pre-push`.

For the review: fix **Critical** and **Warning** findings, **Info** at discretion, then re-run once to confirm clean. Cap the loop at ~2 passes — don't grind. Keep the findings — you'll post them on the PR in Phase 4.

---

## Phase 4: Push + Create PR (draft-first)

After local verification passes, push once and create the PR as **draft**.

```bash
git push -u origin agent/<phase-or-project-slug>
```

Write the PR body to `tmp/` first:

```bash
# 1. Write the PR body using the Write tool -> tmp/pr-body-<phase-or-project-slug>.md
#    Include: summary, issue list, Closes keywords, test plan

# 2. Create the PR as DRAFT (defers any expensive ready-for-review CI matrix)
gh pr create \
  --base main \
  --draft \
  --title "<type>(<scope>): <batch description>" \
  --body-file tmp/pr-body-<phase-or-project-slug>.md \
  --label "<labels>"

# 3. Clean up the tmp file
rm tmp/pr-body-<phase-or-project-slug>.md
```

If the project gates expensive CI (E2E / a11y / flake matrices) behind the ready-for-review transition, draft-first defers it until you flip the PR ready.

Link/close the work items per the skill's `link-pr` operation. On GitHub that means one closing keyword per issue in the PR body — GitHub only closes the first issue when multiple are comma-separated on one line (`Closes #1, #2, #3` closes only `#1`):

```markdown
Closes #1
Closes #2
Closes #3
```

**Record the review findings on the work item.** After the PR is created, post the Phase 3 review findings via the skill's `comment-issue` operation, as one comment that contains a stable marker (e.g. `<!-- local-review-findings -->`). This is the durable record the [closeout ceremony](project-closeout-ceremony.md) mines for recurring mistake families. Write the body to `tmp/` first; on GitHub the skill posts it on the PR:

```bash
gh pr comment <pr-number> --body-file tmp/review-findings-<pr>.md
```

```markdown
<!-- local-review-findings -->

**Local code review** (pre-push) — <N> findings

- **[Critical]** <title> — fixed in <sha>
- **[Warning]** <title> — fixed in <sha>
- **[Warning]** <title> — not changed: <reason>
- **[Info]** <title> — deferred (see #<issue>)
```

If the review surfaced zero findings, still post the comment with "0 findings" so closeout has a complete corpus.

---

## Phase 5: Mark Ready for Review

The PR is draft and already locally reviewed (Phase 3). Once the local review is resolved, the pre-push gate is green, and the cheap draft CI passes, mark the PR ready:

```bash
gh pr ready <pr-number>
```

If the project's full CI matrix fires on the `ready_for_review` transition, be confident before flipping it — don't mark ready with unresolved Critical/Warning findings or a red gate; that's what draft is for.

If a finding exposes a product or architecture decision rather than a clear fix, **stop and ask the human** instead of guessing.

---

## Phase 6: Reflect + Update Agent Memory

After final review-response commits are made, reflect before handing the PR to the human.

Ask:

- Did I struggle to call the right tools?
- Did I miss a critical rule, project doc, issue detail, service boundary, or architecture context?
- Did tests, CI, the local review, or the human catch something I should have caught earlier?
- What went wrong that future me can avoid?

Actions:

- Create or update LLM-optimized notes in `docs/agent-lessons/`.
- Update the relevant agent profile (`.claude/agents/*.md`) if role behavior should change.
- Create or update rules, prompt docs, or other instructions when the lesson should be automatically applied.
- If the lesson generalizes beyond this project, open a PR back to the engsys `lessons-library/`.
- Commit these learning/instruction changes as a final PR commit.

Write lessons for machine retrieval, not human reading: short headings, trigger phrases, failure mode, correct behavior, commands/files to check, and links to authoritative docs.

---

## Phase 7: Human Review + Merge

After the local review findings are handled and learning updates are committed:

- Push the final branch.
- Ensure the PR body and test plan are current.
- Wait for all required CI workflows to pass.
- Human in the loop performs the final review.
- Human squash-merges the PR when satisfied.

Agents do not merge their own implementation PRs unless the human explicitly asks.

---

## Phase 8: Cleanup After Merge

After the PR is squash-merged:

```bash
# From the main repo root
git checkout main
git pull --ff-only origin main

# Empty the worktree directory first if needed (node_modules/dist/build artifacts can block removal)
git worktree remove ../worktrees/<phase-or-project-slug> --force
git branch -d agent/<phase-or-project-slug>
git worktree prune
```

If the branch was already deleted remotely by the tracker, local branch deletion is still required. If `git branch -d` refuses because a squash merge changed commit IDs, verify the PR is merged, then use `git branch -D agent/<phase-or-project-slug>`.

---

## Stacked Branches

Prefer one phase PR from `main`. Use stacked branches only when one batch must build on unreleased work from another branch.

```bash
git worktree add ../worktrees/<child-slug> agent/<parent-slug> -b agent/<child-slug>
```

This creates a dependency: the parent PR must merge before the child PR can merge cleanly.

After the parent PR merges:

```bash
cd ../worktrees/<child-slug>
git fetch origin
git rebase origin/main
```

Git may skip commits that are now on main. If it stops on a duplicate already-merged commit, skip it:

```bash
git rebase --skip
```

After a clean rebase:

```bash
git log --oneline origin/main..HEAD
git push --force-with-lease origin agent/<child-slug>
```

---

## Rules

| Rule                       | Detail                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Batch by phase**         | One phase/project batch = one branch, one worktree, one PR                                                                                                                                      |
| **Commit by issue**        | Each issue gets its own implementation commit with a `#issue` reference. **File-overlap exception** (Phase 2): co-commit issues that touch the same files, cite all issue numbers in the subject. The PR body's `Closes #` lines still auto-close every issue on merge. |
| **Validate before PR**     | Run the project's pre-push gate / precheck (build, lint, tests, plus path-gated checks for E2E, migrations, IaC, containers). The local pre-push hook runs it automatically if the project has one. See `/pre-push`. |
| **Draft-first PR**         | Always `gh pr create --draft`. Mark **Ready for review** (`gh pr ready`) only after the local review is resolved and the gate is green — that triggers any expensive ready-for-review CI matrix. |
| **Local review**          | Run a local code review **before push** (Phase 3); fix Critical + Warning, re-run clean (~2 passes max). After opening the PR, post findings onto the work item (skill `comment-issue`) as one marked comment for closeout to mine.        |
| **Reflect before handoff** | Update `docs/agent-lessons/`, the agent profile, and rules/instructions when the PR reveals a reusable lesson; PR generalizable lessons back to the engsys lessons-library.                      |
| **tmp/ always**            | Commit messages, PR bodies, issue bodies — never HEREDOC or pipe                                                                                                                                |
| **No commit pause**        | A start/implement command for this workflow authorizes routine commits, branch push, PR creation, and local-review fixes                                                                        |

---

## Completion Checklist

```text
[ ] docs/agent-lessons/ reviewed before starting
[ ] Batch scope selected: phase, unphased project, or single issue
[ ] Worktree and branch created for the batch (from origin/main, -b flag)
[ ] Every issue assigned to the implementer
[ ] Each issue has its own implementation commit referencing #N (or a single co-commit citing all overlapping issue numbers per the file-overlap exception)
[ ] Pre-push gate passes (build, lint, tests, and path-gated gates)
[ ] Local review run; Critical + Warning findings resolved, re-run clean
[ ] Branch pushed to origin
[ ] PR created as DRAFT, work items linked/closed per link-pr (GitHub: one Closes line per issue)
[ ] Review findings posted onto the work item via comment-issue, as a marked comment (or "0 findings")
[ ] PR marked Ready for review (gh pr ready <n>)
[ ] Reflection completed and learning/profile/rule updates committed if needed
[ ] CI green and PR ready for human review
[ ] Human squash-merged the PR
[ ] main checked out and pulled
[ ] Worktree removed, local branch deleted, worktrees pruned
```

---

## Troubleshooting

**Worktree creation fails** — You probably created the branch first. Delete it and use the `-b` flag:

```bash
git branch -d agent/<phase-or-project-slug>
git worktree add ../worktrees/<phase-or-project-slug> -b agent/<phase-or-project-slug> origin/main
```

**Worktree remove fails — "Directory not empty"** — Empty the worktree directory before `git worktree remove` (e.g. leftover `node_modules`, `dist`, build output). From the repo root:

```bash
rm -rf ../worktrees/<phase-or-project-slug>/*
git worktree remove ../worktrees/<phase-or-project-slug> --force
git worktree prune
```

**Build errors about generated code** — Codegen wasn't run. Re-run the project's codegen step inside the worktree.

**Merge conflicts** — Rebase on main:

```bash
git fetch origin && git rebase origin/main
```

If the rebase stops on a commit that was already merged to main, skip it:

```bash
git rebase --skip
```

Never `git rebase --abort` just because of "already applied" warnings; that is expected when rebasing stacked branches.

**Local main diverged from origin/main** — Fix with rebase, not merge:

```bash
git fetch origin && git rebase origin/main
```

**Batch feels too large** — Stop and ask the human before splitting. The default remains one PR per phase or unphased project, not one PR per issue.
