# Project Closeout Ceremony

Run this **every time a project's last PR merges** (the final phase of `/implement-project`, or any multi-PR effort that reaches "all phases merged"). It is the deliberate close-out: clean up the workspace, mine the review feedback for _recurring_ mistakes, and memorialize durable lessons so the next project starts smarter. The per-phase reflection line in `/implement-project` is a stub — this is the full ceremony.

**Trigger:** the project's last open PR is MERGED (operator confirms, or `gh pr view` shows MERGED for every phase + follow-up PR). Also run it after a deliberate project-pause if no more phases are coming soon.

Work-item reads (board status, finding records) and closing the board go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) via `list-issues` / `get-issue` / `query-board` / `close-board`. PR state, PR comments, and CI alerts stay on `gh` / GitHub (PRs are a code-host concern).

**Why it exists:** review comments tend to get addressed inline, one at a time — yet a post-hoc mining pass routinely reveals several were the _same mistake family repeating across PRs_ (e.g. cross-method TOCTOU 4×, missing migration constraints 4×). Fixing inline isn't learning; generalizing the family into the checklist is. This ceremony forces that step instead of leaving it to chance.

---

## Step 1 — Verify everything merged

- `gh pr view <n> --json state` for every project + follow-up PR → confirm all `MERGED` (squash-merge makes `git branch --merged` report 0; trust PR state, not merge-base).
- Confirm the project board items are all `Done` / `In Review` (skill `query-board`). Any still `In Progress` → the project isn't closed; stop and report what's outstanding.

## Step 2 — Clean up worktrees & branches

- Remove **only this project's** worktrees: `git worktree remove <path> --force` (force handles leftover `node_modules`/`dist`/build output); then `git worktree prune`. Leave unrelated/locked worktrees alone.
- Delete the merged local branches (`git branch -D <branch>`) and any dangling remote branches (`git push origin --delete <branch>` — UI-merged PRs don't auto-delete the remote branch).
- `git checkout main && git pull --ff-only origin main` in the main checkout if it was parked on a feature branch.

## Step 3 — Close the project board (when every issue is closed)

Once Step 1 confirms the PRs are merged, close the project board — but **only if every issue on it is closed** — via the installed issue-tracker skill's `close-board` operation. Don't trust the board's own status field for this (on GitHub ProjectV2 the `item-list` `state` field is unreliable, often null/`?`); the skill gates on the **real** issue state, intersecting the board's issue numbers with the still-open issues and requiring the intersection to be empty.

- **Gate:** if _any_ issue is still open, do **not** close the board — the project isn't actually done (same stop-and-report rule as Step 1). Closing a board over a live issue hides work.
- Draft cards / notes (non-issue board items) do **not** gate the close — only real issues do.
- Reversible: closing archives the board from the active view (GitHub: `gh project close --undo` reopens it; Linear: set the project state back). It never deletes the project or its items.

The concrete commands live in the tracker skill's `close-board` (GitHub closes the ProjectV2; Linear marks the project Completed) — keep this step backend-agnostic.

## Step 4 — Mine ALL review findings (the core of the ceremony)

Don't rely on memory of what you fixed inline. The durable record is the marked review-findings comment each PR/work item posts after its local review (plus any static-analysis / security-scanning alerts CI still produces). Pull them from **every** work item in the project into one corpus via the skill's `list-issues` / `get-issue` operations. On GitHub the findings live as the marked comment on each PR — pull them directly with `gh`:

```bash
for pr in <all-project-PR-numbers>; do
  gh pr view "$pr" --json comments \
    --jq '.comments[] | select(.body | contains("<!-- local-review-findings -->")) | .body'
done
```

(If a PR is missing its findings comment, note the gap — that PR went out without a recorded review, which is itself a process finding worth a lesson.)

Then classify by **mistake family**, not by individual fix. For each family ask:

- How many times did it recur, across how many distinct PRs? (≥2 PRs = a real pattern.)
- Is it already in `docs/agent-lessons/` (or the engsys lessons-library)? If yes but it still recurred → the lesson exists but wasn't _applied at authoring time_; strengthen the trigger/check, don't just re-file.
- Was it Critical/Major, or a nitpick? Prioritize the families that produced real bugs.

## Step 5 — Memorialize (team-facing, in the repo)

Automatic behaviors that apply to **anyone** in the repo go in the repo, not personal memory:

- A **new, recurring** failure family → a new `docs/agent-lessons/<slug>.md` (trigger / failure mode / correct behavior / check / source).
- A family already documented but still recurring → strengthen the existing lesson + add the new variant + a Start-of-PR-check line.
- A reusable workflow/agent/command gap exposed by the run → update the relevant `.claude/workflows/*.md`, `.claude/agents/*.md`, or `CLAUDE.md`.
- **Generalizable lessons** (not tied to this project's stack/domain) → also open a PR back to the engsys `lessons-library/` so other projects inherit them.
- Commit on an `agent/project-<num>-reflection-lessons` branch → one docs PR. (Docs-only; if a local markdown-lint hook can't spawn, `--no-verify` is acceptable — the pre-push local review is the md backstop.)

## Step 6 — Update personal memory (judgment/orchestration that's yours)

Insights about _how you operate_ (orchestration cadence, verification habits, tooling gotchas) go in your memory dir, not the repo. Append to existing feedback files rather than creating duplicates; point them at the strengthened repo checklist rather than copying it.

## Step 7 — Final report

Print: PRs merged + their lesson contributions, worktrees/branches cleaned, **whether the project board was closed (or why not — which issues are still open)**, new/strengthened lessons (with the recurrence count that justified each), personal-memory updates, and any deferred follow-ups or operator-gated work still outstanding.

---

## Cross-References

- [implement-project-workflow.md](implement-project-workflow.md) — the phase loop this closes out
- [agent-implementation-workflow.md](agent-implementation-workflow.md) — where the marked review-findings comment is posted
- `CLAUDE.md` § Memory & rules (repo-vs-personal split) and § Post-merge cleanup (worktree removal mechanics)
