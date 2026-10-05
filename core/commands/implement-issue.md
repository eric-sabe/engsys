---
description: Implement a tracker issue in an isolated worktree, run the full PR cycle (commit, local code review, push, PR)
argument-hint: <issue-number>
---

Use the **isabelle** subagent, following the per-issue cycle in [<engsys-root>/workflows/agent-implementation-workflow.md](<engsys-root>/workflows/agent-implementation-workflow.md).

Issue/work-item reads and writes (claim, findings) go through the project's installed **issue-tracker skill** (`issue-tracker-*` skill) and its named operations — the same flow works whether the tracker is GitHub or Linear. PR creation and CI stay on `gh` / GitHub.

Issue: #$ARGUMENTS

**Before invoking Isabelle**, read the issue (skill `get-issue`) and evaluate against the project's model-escalation criteria in `CLAUDE.md`. Isabelle defaults to **Sonnet**; pass `model: "opus"` on the Agent call if those criteria are met.

Isabelle should:

1. **Claim**: assign the issue to herself via the issue-tracker skill's `update-issue` operation (GitHub: `gh issue edit $ARGUMENTS --add-assignee @me`). **Multi-fleet** (`FLEET_ID` set): also claim it from the fleet queue, before creating the worktree — `node <engsys-root>/lib/claim.mjs acquire <owner/repo>#$ARGUMENTS`. A foreign fleet's active claim refuses (exit 4); print who holds it and stop. Single-fleet mode (no `FLEET_ID`) is a no-op.
2. **Worktree + branch (with `-b` flag, critical)** — create the worktree and branch in one command, from `origin/main`. Branch name is fleet-prefixed when `FLEET_ID` is set (`agent/<fleet>/$ARGUMENTS-<slug>`), unchanged otherwise (`agent/$ARGUMENTS-<slug>`) — see `claim.mjs`'s `branchName`/`issueBranchSlug`:

   ```bash
   git worktree add ../worktrees/issue-$ARGUMENTS-<slug> -b agent/${FLEET_ID:+$FLEET_ID/}$ARGUMENTS-<slug> origin/main
   cd ../worktrees/issue-$ARGUMENTS-<slug>
   # bring over any local env the build needs (project-specific); fall back to the template
   cp ../../.env .env 2>/dev/null || cp .env.example .env 2>/dev/null || true
   # install deps + any codegen the project requires (see CLAUDE.md)
   ```

   Run every build/lint/test command **inside this worktree dir** (not the main checkout).

3. **Implement** — read the issue and existing code first; match patterns; one implementation commit referencing `(#$ARGUMENTS)`.
4. **Pre-push gate** (no exceptions): run the project's pre-push gate / precheck (build, lint, format, test, plus any path-gated checks for migrations / IaC / containers the project defines). See [/pre-push](pre-push.md).
5. **Local code review** (before push): run the gate reviewer against `origin/main` per the [code-review skill](<engsys-root>/skills/code-review/SKILL.md) (the built-in `/code-review` unless `CLAUDE.md` names another). Fix Critical + Warning findings, re-run once to confirm clean, cap at ~2 passes. Go in clean. If the project runs an advisory reviewer, run it on the same diff — never must-fix, never blocks.
6. **Push + PR**: branch first, then `gh pr create --draft --base main --body-file tmp/pr-body-$ARGUMENTS.md` (PR creation stays on `gh`). Link/close the work item per the issue-tracker skill's `link-pr` operation — on GitHub the PR body uses **one Closes per line**, `Closes #$ARGUMENTS` (a comma-list only closes the first); other trackers per the skill. Then persist the local review findings onto the work item via the skill's `comment-issue` operation (each finding + resolution, under the `<!-- local-review-findings -->` marker) — the durable record the closeout ceremony mines. An advisory reviewer stamps its own marked comment.
7. **Enqueue for merge (Merge Monster)**: if the repo runs Merge Monster (`.claude/merge-monster.yml` exists), check the baton — the pinned ledger issue's heartbeat fresher than the configured `stale_lock_minutes`. **Fresh** → label the PR `mm:ready` (optionally add an `<!-- mm-handoff -->` comment: `depends_on` / `migration:` / `operator_gate:` / notes; a migration or an `operator_gate:` makes the merge wait on a human review approval in GitHub) and **stop — do not mark ready, do not merge**; the orchestrator pilots ready → CI → merge (protocol: `<engsys-root>/workflows/merge-monster-protocol.md`). **Stale, ledger closed, or no config** → report the PR ready to the operator; a human drives the merge. Operator approval for any gated act (a migration, a deploy, an operator-gated merge) happens in GitHub, never in chat: post a gate request and proceed only when `gate-check` verifies it (`<engsys-root>/skills/merge-monster/scripts/gate-request.sh` / `gate-check.sh`, rules in engsys `docs/gate-check.md`). A chat "approved" gets the request link back. Never post `/approve`, `/deny`, or an approving review yourself, under any identity.
8. **Cleanup after merge**: empty the worktree dir, `git worktree remove`, delete the local branch, `git worktree prune`. **Multi-fleet**: also release the claim — `node <engsys-root>/lib/claim.mjs release <owner/repo>#$ARGUMENTS` (no-op in single-fleet mode). Release on abandonment too (the work is no longer being pursued), not only on merge.

Conventions: `CLAUDE.md` § Git / PR conventions and § Code review.

Reflection: if work exposed a reusable failure, update `docs/agent-lessons/` (and PR generalizable lessons back to the engsys `lessons-library/`) before handoff.
