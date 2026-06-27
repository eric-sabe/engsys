---
description: Close out a finished project — verify all PRs merged, clean up worktrees/branches, close the project board once every issue is closed, mine all local code-review findings (+ static-analysis alerts) for recurring mistake families, and memorialize durable lessons.
argument-hint: <project-number>
---

Run the **Project Closeout Ceremony** for project #$ARGUMENTS. Full reference: [.claude/workflows/project-closeout-ceremony.md](.claude/workflows/project-closeout-ceremony.md). Run this once the project's last PR has merged (or on a deliberate long pause).

Work-item reads (board status, finding records) and closing the board go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) via `list-issues` / `get-issue` / `query-board` / `close-board`. PR state and CI alerts stay on `gh` / GitHub.

Execute the ceremony's seven steps in order:

1. **Verify everything merged** — `gh pr view <n> --json state` for every project + follow-up PR (all `MERGED`; squash-merge means `git branch --merged` lies — trust PR state). Board items all `Done`/`In Review` (skill `query-board`). If anything is still open/In Progress, stop and report — the project isn't closed.
2. **Clean up** — remove ONLY this project's worktrees (`git worktree remove --force` + `prune`), delete merged local branches, delete dangling remote branches (`git push origin --delete` — UI merges don't auto-delete), restore the main checkout to `main`. Leave unrelated/locked worktrees.
3. **Close the project board** — once Step 1 confirms the PRs merged, close the board **only if every issue on it is closed**, via the skill's `close-board` operation. The board's own status field is unreliable, so the skill gates on real issue state (intersect the board's issues with the still-open issues — the intersection must be empty). Any issue still open → do NOT close; stop and report (the project isn't done). Reversible.
4. **Mine ALL local-review findings** — pull every local code-review findings record across the project into one corpus via the skill's `list-issues` / `get-issue` operations (on GitHub the findings live as the marked comment each PR posts — `gh pr view <n> --json comments`, all PR numbers; the skill handles where they live on other trackers), plus any static-analysis / security-scanning alerts still produced in CI. (Review is local-only — there are no cloud review threads to mine; the durable record is the findings comment each PR/work item posts.) Classify by mistake **family**, not individual fix. For each: recurrence count + distinct PRs (≥2 = a pattern); already in `docs/agent-lessons/` (or the engsys lessons-library)? (if yes but it still recurred → strengthen, don't just re-file); severity (prioritize families that produced real Critical/Major bugs over nitpicks).
5. **Memorialize (team-facing, in the repo)** — new recurring family → new lesson under `docs/agent-lessons/`; documented-but-recurring → strengthen the existing lesson + its Start-of-PR check; workflow/agent/command gap → update the relevant `.claude/commands/*.md` / `.claude/agents/*.md` / `CLAUDE.md`. **Generalizable lessons** (not specific to this project's stack/domain) → also open a PR back to the engsys `lessons-library/` so other projects inherit them. Commit on `agent/project-$ARGUMENTS-reflection-lessons` → one docs PR.
6. **Update personal memory** — orchestration/verification/tooling judgment that's about how YOU operate goes in your memory dir; append to existing feedback files, point at the repo checklist.
7. **Final report** — PRs merged + lesson contributions, cleanup done, **whether the board was closed (or which issues block it)**, new/strengthened lessons (with the recurrence count justifying each), personal-memory updates, outstanding deferred/operator-gated work.

Hard rules:

- Repo-vs-personal split per `CLAUDE.md` § Memory & rules: anything that should change behavior for **anyone** in the repo goes in the repo (`docs/agent-lessons/` / workflow / `CLAUDE.md`), not personal memory. Anything generalizable beyond this project goes to the engsys `lessons-library/`.
- Generalize the **family**, don't just confirm the inline fix — fixing a comment inline is not learning.
- Issue bodies / commit messages / PR bodies via `tmp/` files, never HEREDOC.
- Docs-only commits: if a local markdown-lint hook can't spawn, `--no-verify` is acceptable; the pre-push local review is the markdown backstop.
