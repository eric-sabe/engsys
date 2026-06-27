# Implement Project Workflow

Walk a tracker ProjectV2 board phase-by-phase, opening one PR per phase, pausing on material review findings. Builds on [agent-implementation-workflow.md](agent-implementation-workflow.md) — that doc still governs the per-phase mechanics (worktree, commits, local review, push, PR). This doc only adds the outer loop that reads the project board and decides what to do next.

Invocation: `/implement-project <number>` (e.g. `/implement-project 21`).

This workflow is the explicit authorization for the routine implementation cycle — see [agent-implementation-workflow.md § Start Command Authorization](agent-implementation-workflow.md).

Board reads/writes (Phase/Priority/Owner/Status) and work-item operations go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) via its contract operations (`query-board`, `set-board-field`, `update-issue`, `comment-issue`, `link-pr`). The skill maps them onto the active backend; the GitHub `gh` / `gh api graphql` commands shown below are what it runs on a GitHub project. PR creation (`gh pr create`) and CI stay on GitHub.

---

## Preconditions

The project **must** have a `Phase` single-select field with `P<n>: <name>` options (e.g. `P0: Foundation`, `P1: Core`). Without it, this command cannot batch.

If the project lacks a `Phase` field, stop and report:

> "Project #<num> has no `Phase` field. Run Jody first to retrofit (see [generate-project.md § 5](generate-project.md)), or implement issues one at a time via `/implement-issue <num>`."

Do not attempt to invent phases on the fly — that's Jody's job and requires the design loop.

---

## Phase 0: Read the Board

Use the issue-tracker skill's **`query-board`** operation to fetch the project's fields + items grouped by Phase. On GitHub the skill runs `gh api graphql` (the `github` MCP doesn't support ProjectV2), querying `projectV2(number:)` for: field definitions (`ProjectV2SingleSelectField { id name options }`) and items (`content { ... on Issue { number title state url } }` plus their `fieldValues`).

```bash
gh api graphql -f query='
  query($owner: String!, $num: Int!) {
    user(login: $owner) {            # or organization(login: $owner)
      projectV2(number: $num) {
        id title
        fields(first: 30) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
        items(first: 100) {
          nodes {
            id
            content { ... on Issue { number title state url repository { nameWithOwner } } }
            fieldValues(first: 20) {
              nodes { ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2SingleSelectField { name } } name } }
            }
          }
        }
      }
    }
  }' -f owner=<OWNER> -F num=<PROJECT_NUMBER>
```

Group items by their `Phase` value. Skip items whose `Status` is `Done` or whose underlying issue `state` is `CLOSED`. Within each phase, preserve original board order (use `Priority` as a tiebreaker when present).

Phase order is determined by the numeric prefix in the `P<n>: …` option name. Treat `P-1` as before `P0`. Treat `P1.5` as between `P1` and `P2`.

---

## Phase 1: Pick the Next Batch

The "next batch" is the lowest-numbered phase that still has at least one open issue.

Print the operator a short plan before starting:

```text
Project #21 "Metrics v2 — KPI Dashboard"
Next phase: P1: Schema & DTOs (4 issues open, 0 already merged)
  - #1562 ...
  - #1563 ...
After this phase: P2: Settings UI (6 issues), P3: Hardening (2 issues)
```

Do not pause for operator approval — the slash command itself is the authorization. But if any pre-flight check is failing (auth scope, dirty main, uncommitted local changes), stop and report.

---

## Phase 2: Walk One Phase

For the chosen phase, follow [agent-implementation-workflow.md](agent-implementation-workflow.md) end-to-end:

1. Assign every issue in the phase to `@me` (skill `update-issue`).
2. Create the worktree + branch: `agent/project-<num>-phase-<n>-<slug>` (e.g. `agent/project-21-phase-1-schema-dtos`), from `origin/main`.
3. Set the board `Status` to `In Progress` on every item in this phase (skill `set-board-field`; on GitHub GraphQL `updateProjectV2ItemFieldValue`).
4. Implement issues sequentially — **one commit per issue** with `(#<num>)` in the subject. Match the patterns of nearby code; do not refactor opportunistically.
5. Run the project's pre-push gate / precheck (build, lint, unit tests, and path-gated checks for E2E, migrations, IaC, containers). See `/pre-push`.
6. **Run a local code review against `origin/main` before push.** Fix Critical + Warning findings, re-run once to confirm clean, cap at ~2 passes.
7. Push once, open one **draft** PR via `gh pr create --draft` (PR creation stays on GitHub), linking/closing each work item per the skill's `link-pr` operation (GitHub: `Closes #<num>` on its own line for every issue in the phase), then post the local review findings onto the work item via the skill's `comment-issue` operation (on GitHub, the marked PR comment).
8. Once the local review is clean and the gate is green, mark **Ready for review** (`gh pr ready <n>`) to trigger any expensive ready-for-review CI matrix.

---

## Phase 3: Triage Review Findings, Then Decide

Triage every finding from the Phase 2 local review (done before push). For each:

- **Material**: a real bug, security risk, missed edge case, broken assumption, or anything that would change shipped behavior. Fix it before push; re-run the review.
- **Cosmetic**: nit-level (naming, formatting, doc wording). Fix if the change is trivially safe and obviously correct; otherwise note it in the findings comment.
- **Wrong**: the review misread the code. Note why in the findings comment.

After resolving all findings, classify the _batch outcome_:

| Outcome                                                    | Next action                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No material findings (clean or only cosmetic)              | Continue autonomously: jump to Phase 4, then loop back to Phase 1 for the next phase       |
| ≥1 material finding fixed, review confirms clean on re-run | Continue autonomously                                                                      |
| Material finding exposes a product/architecture decision   | **Stop**. Note it in the findings comment, report to the operator, do not start the next phase |
| Review errored / couldn't run                              | **Stop**. Report to the operator with the PR URL and what's missing                        |

"Pause on review findings" means: pause only when a finding is material AND it reveals something the operator should weigh in on. Cosmetic and trivial fixes do not stop the loop. Use judgment; when in doubt, pause.

---

## Phase 3.5: Objective Independent Review (before any merge)

This is the merge gate the `/implement-project` command enforces. Once the phase PR is open and the implementer's local review is clean, the **orchestrator** (not the implementer) launches a *fresh, independent* reviewer subagent — general-purpose on **Opus**, with **no stake in the code**. It must:

- re-run the full pre-push gate from scratch (confirm or refute the author's numbers);
- verify **each** issue's acceptance criteria against the diff;
- probe security/correctness;
- hunt for regressions and reconciliation artifacts (duplicate/dead code, dropped work, stray exports).

It ends with a decisive **`VERDICT: CLEAN`** (no Critical/Warning — safe to merge) or **`VERDICT: FINDINGS`** (severity-tagged, `file:line`). **Never merge a phase PR that has not passed this gate.**

- **CLEAN** → safe to merge; proceed to Phase 4.
- **FINDINGS** → route back to the implementer to fix + re-review, or **stop** and report if it exposes a product/architecture decision.

---

## Phase 4: Mark Phase Done, Loop

After the PR is opened, the local review resolved, and the objective review returns CLEAN:

1. Update the board `Status` to `Done` on every item in the completed phase (skill `set-board-field`) — **but only after the phase PR has merged** if the board has an "Auto-close issue" workflow enabled (otherwise `Status=Done` can prematurely close the linked issue while its PR is still a draft). If you need an interim state, use `Status: In Review`.
2. Do **not** wait for the PR to merge before *starting* the next phase (each phase is a separate branch from `main`; rebasing across them after merges is normal) — unless the auto-close caveat above forces you to gate on merge.
3. Loop to Phase 1 and pick the next unfinished phase.

Stop when every phase has `Status: Done` (or `In Review`) on all its items. Report a one-line summary per phase with PR links.

---

## Stop Conditions (Always Pause)

Stop and report to the operator if any of these fire mid-loop:

- Pre-flight: missing `project` auth scope, dirty main, uncommitted local changes, `gh auth` failed.
- A phase missing entirely (e.g. an issue in the project has no `Phase` value) — fix the project, don't paper over it.
- An issue body too vague for safe implementation — file a clarification comment on the issue and stop.
- The pre-push gate fails and the fix isn't obvious within ~15 min of work.
- A material review finding requires product/architecture judgment.
- Any destructive or non-routine action would be needed (force push beyond `--force-with-lease` on the agent branch, `git reset --hard`, removing unrelated files).
- Three consecutive autonomous phases complete without a manual operator check-in — courtesy pause.

---

## What This Workflow Does Not Do

- Does not merge PRs without a CLEAN objective review. Human-in-the-loop merges every batch (or the orchestrator only with explicit operator authorization).
- Does not refactor existing code beyond the issues' scope.
- Does not file new issues for out-of-scope work it discovers — that goes through the deferring-work flow as a Jody hand-off.
- Does not skip the local review, even when phases are small.
- Does not retry the same failing pre-push gate more than twice without escalating.

---

## Completion Report

After the final phase (or after stopping), print:

```text
Project #<num> "<title>" — implementation summary

Phases completed (PRs awaiting merge):
  P0: <name>  #PR_A  (4 issues, review clean)
  P1: <name>  #PR_B  (3 issues, 1 review fix applied)

Phases remaining:
  P2: <name>  (5 issues, not started)

Stopped because: <reason or "all phases complete">
Next action: <human merges P0/P1, then re-run /implement-project <num> for P2>
```

When the operator confirms the project's **last** PR has merged (all phases done), run the **Project Closeout Ceremony** — don't treat the completion report as the end. See [project-closeout-ceremony.md](project-closeout-ceremony.md) / `/project-closeout <num>`: verify all PRs merged, clean up this project's worktrees + branches, mine ALL marked review-findings PR comments (+ any static-analysis alerts) across the project for recurring mistake _families_, and memorialize durable lessons (repo `docs/agent-lessons/` for team-wide patterns; the engsys lessons-library for generalizable ones; personal memory for orchestration judgment).

---

## Cross-References

- [agent-implementation-workflow.md](agent-implementation-workflow.md) — per-phase mechanics (worktree, commits, local review, PR)
- [project-closeout-ceremony.md](project-closeout-ceremony.md) — the mandatory close-out after the last PR merges
- [generate-project.md § 5](generate-project.md) — how the `Phase` field gets created in the first place
- `CLAUDE.md` § Pre-push gate, § Git / PR conventions
