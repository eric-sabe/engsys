---
description: Walk a tracker project phase-by-phase, opening one PR per phase. Pauses on material code-review findings, otherwise continues autonomously.
argument-hint: <project-number>
---

Use the **isabelle** subagent, following the per-issue cycle in [/implement-issue](implement-issue.md) and the outer loop in [.claude/workflows/implement-project-workflow.md](.claude/workflows/implement-project-workflow.md).

Board reads/writes (Phase/Priority/Owner/Status) go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) and its `query-board` / `set-board-field` operations — the same flow works whether the tracker is GitHub or Linear. PR creation and CI stay on `gh` / GitHub.

Project: #$ARGUMENTS

Isabelle should:

1. **Read the board** — use the issue-tracker skill's `query-board` operation to fetch fields + items (GitHub: `gh api graphql`). The project **must** have a `Phase` single-select field with `P<n>: <name>` options. If missing, stop and tell the operator to run [/generate-project](generate-project.md) (Jody) first.
2. **Pick the next batch** — lowest-numbered phase with open issues. Print the plan (phase name, issue list, remaining phases). Do not wait for approval; the slash command is the authorization.
3. **Walk one phase** — follow the [/implement-issue](implement-issue.md) cycle end-to-end: claim issues (issue-tracker skill `update-issue`), create worktree `agent/project-$ARGUMENTS-phase-<n>-<slug>`, set Status=In Progress (skill `set-board-field`), one commit per issue with `(#<num>)` references, full pre-push gate, **run a local code review with the built-in `/code-review` skill before push** (fix Critical + Warning, re-run clean), push once, create the PR on `gh pr create` and link/close work items per the skill's `link-pr` operation (GitHub: `Closes #<num>` one per line), then persist the local review findings onto the work item with the skill's `comment-issue` operation.
4. **Triage review findings** (done locally before push) — classify each:
   - **Material** (real bug / security / behavior change) → fix, re-run review
   - **Cosmetic** → fix if trivially safe, otherwise note in the findings comment
   - **Wrong** → note why in the findings comment
5. **Objective independent review (orchestrator — before any merge)** — once Isabelle's phase PR is open and her local review is clean, the **orchestrator** (not Isabelle) launches a *fresh, independent* reviewer subagent — general-purpose on **Opus**, with **no stake in the code** — to objectively review the PR. It must: re-run the full gate from scratch (confirm/refute the author's numbers), verify **each** issue's acceptance criteria against the diff, probe security/correctness, and hunt for regressions and reconciliation artifacts (duplicate/dead code, dropped work, stray exports). It ends with a decisive **`VERDICT: CLEAN`** (no Critical/Warning — safe to merge) or **`VERDICT: FINDINGS`** (severity-tagged, `file:line`). Never merge a phase PR that has not passed this gate.
6. **Continue or pause** — after the objective review returns:
   - **CLEAN** → get the phase PR merged: if the repo runs Merge Monster and its baton is fresh, label it `mm:ready` + an `<!-- mm-handoff -->` comment (`project`/`phase`, `depends_on:` the previous phase's PR#) and **wait for the orchestrator's merge**; otherwise the human merges (or the orchestrator, only with explicit operator authorization). Once merged, mark phase items Status=Done (skill `set-board-field`), loop back to step 2 for the next phase.
     - ⚠️ **Status=Done can auto-close the linked issue _pre-merge_.** If the board has the built-in **"Auto-close issue"** workflow enabled, setting an item's **Status=Done** immediately **closes the linked issue — even while its PR is still an unmerged draft**. Only flip Status=Done **after** the phase PR has actually merged — or, better, **disable that board workflow** so issue-closed tracks the real merge. Phases that must stay open through review/sign-off (e.g. a security-gated phase) will otherwise need their issues reopened.
   - **FINDINGS** (Critical/Warning) → route back to Isabelle to fix + re-review, or **stop** and report if it exposes a product/architecture decision
   - Local *or* objective review errored / couldn't run → **stop** and report
   - Three consecutive autonomous phases done → **courtesy pause**, report progress, ask operator before continuing
7. **Done** — when every phase has Status=Done (or In Review), print the completion summary with PR links per phase.

Hard rules:

- **No merge without a `CLEAN` objective review** (step 5). Merges go through Merge Monster when its baton is fresh (enqueue via `mm:ready`); otherwise the human merges every batch — or the orchestrator, only with explicit operator authorization.
- Does **not** invent phases. If the `Phase` field is empty or missing, stop (no item may carry an empty Phase).
- One phase = one branch = one worktree = one PR. Per `CLAUDE.md` § Git / PR conventions.
- Work-item linking per the skill's `link-pr` operation (GitHub: one `Closes #<num>` per line — a comma-list only closes the first issue).
- Use `tmp/` for commit messages and PR bodies — never HEREDOC.

Reflection on pause: if the loop exposed a reusable failure or missing Jody field, update the relevant `CLAUDE.md` / `docs/agent-lessons/` before handoff.

**When the project's LAST PR merges** (all phases done): run the full **Project Closeout Ceremony** — [/project-closeout $ARGUMENTS](project-closeout.md). Verify all PRs merged → clean up worktrees/branches → mine ALL local-review findings PR comments (+ any static-analysis alerts) across the project for recurring mistake families → memorialize durable lessons. Don't stop at the completion report.
