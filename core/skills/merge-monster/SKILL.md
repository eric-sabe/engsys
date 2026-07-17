---
name: merge-monster
description: Run the Merge Monster merge-orchestrator session — own the merge baton, order the PR queue, pilot PRs through ready→CI→merge, auto-handle easy Dependabot PRs, dispatch fix agents, escalate with diagnosis. Use when the user says "start merge monster", "run the merge orchestrator", or "/merge-monster".
---

# 🧌 Merge Monster — orchestrator session

You are the merge baton-holder for this repository. While your heartbeat is
fresh, nothing else merges. Full design: `docs/merge-monster.md` in engsys
(spec travels with the skill; the config travels with the repo).

## Prerequisites

- `.claude/merge-monster.yml` exists (start from `config.example.yml` next to
  this file). **Read it first** — it defines the repo, ledger issue, conflict
  magnets, migration globs, merge methods, local gate, and escalation channel.
- Labels + ledger issue exist (`<skill-dir>/scripts/mm-setup.sh --repo
  <owner/name>` is idempotent; run it if unsure). `<skill-dir>` is this
  skill's directory (`.claude/skills/merge-monster` when installed).
- `gh` authed with `repo` scope; `jq` on PATH.

## Session startup

1. Read the config. `mkdir -p <state_dir>` and load prior `state.md` /
   journal if present (you may be resuming).
2. Reconcile reality: run `<skill-dir>/scripts/mm-snapshot.sh --repo <repo>`
   and rebuild the queue from live labels — never trust a stale queue file
   over GitHub.
3. Heartbeat: `<skill-dir>/scripts/mm-heartbeat.sh --repo <repo> --issue
   <ledger_issue> --status "session start"`. Comment a session-start digest
   on the ledger issue (queue depth, planned order).
4. Arm the event bus — a **persistent Monitor** running:

   ```bash
   bash <skill-dir>/scripts/mm-watch.sh --repo <repo> \
     --state-dir <state_dir> --interval <poll_interval> \
     --default-branch <default_branch> --ledger <ledger_issue>
   ```

5. Schedule the fallback tick: **ScheduleWakeup** at `heartbeat_minutes`
   (repeat every cycle). The Monitor is the primary wake signal; this tick
   refreshes the heartbeat, rewrites `state.md`, picks up Dependabot idle
   work, and restarts the Monitor if it died.

## The loop — on every wake (event or tick)

1. **Re-snapshot** (`mm-snapshot.sh`) and rebuild the queue. Ordering is a
   function of current state, applied top-down:
   1. unblock the default branch (red main / CI-infra fixes jump the queue)
   2. declared order: `<!-- mm-handoff -->` `depends_on`, stacked bases
      before children, project phase order
   3. security fixes before features
   4. conflict-magnet touchers before wide quiet PRs (churn minimization)
   5. migration-bearing PRs → `mm:blocked (migration)` + operator ping; they
      wait for an ack, never block others
   6. tiebreak: FIFO by ready-time, small-and-old before big-and-fresh
   7. Dependabot only when the human queue is empty
   8. exactly one PR in `mm:active` at a time
2. **Act on events:**
   - `READY #N` → run **preflight** (below). Pass → `mm:queued` + position
     comment. Fail → remove `mm:ready`, comment exactly what's missing.
   - `CHECK #N ...` → all required checks terminal? green → merge; red →
     **failure handling** (below).
   - `CONFLICT #N` → dispatch a rebase agent (below) when it nears the front.
   - `DEPENDABOT #N` → classify per policy; queue for idle handling or
     escalate.
   - `MAIN_RED` → stop feeding the pipeline; diagnose (revert candidate?
     fix agent? escalate) — this outranks everything.
   - `STOP` → shutdown (below).
3. **Advance the pipeline:** if nothing is `mm:active` and the queue has a
   passing head, in this order: rebase if conflicting, then mark ready
   (`gh pr ready N` — the CI trigger, done as late as possible, one PR at a
   time), and only after ready succeeds label `mm:active` and write its
   number to `<state_dir>/active`. If any step fails, undo what succeeded
   (remove the label, clear the active file, back to draft if needed),
   journal it, and take the next PR — never leave `mm:active` state pointing
   at a PR you aren't actually piloting.
4. **Write the ledger** (every wake): rewrite `<state_dir>/state.md` (queue
   table: position, PR, state, one-line reason; active PR; last events);
   append decisions to `journal-YYYY-MM.md` **and** `.jsonl`
   (`{ts, event, pr, decision, reasoning}`); refresh the heartbeat.

## Preflight (verify the enqueuer's claims)

`<skill-dir>/scripts/mm-preflight.sh --repo <repo> --pr N` — `gh pr view --json`
has no `reviewThreads` field (thread resolution is GraphQL-only); this script
stitches `isDraft,mergeable,mergeStateStatus,baseRefName,body,comments,files,commits`
from `gh pr view` together with a `reviewThreads` GraphQL query into one object.

- all review threads resolved (the ruleset will block otherwise)
- `ready_requirements.review_marker` comment present, if configured
- issue-closing syntax: one `Closes #N` per line (comma-lists only close the
  first)
- base branch correct; no zombie required checks from a force-push
- classify: migration-bearing? (`migration_globs` ∩ changed files, or
  handoff `migration: true`) · conflict-magnet? · security? · batch or
  single-commit? (picks merge method)

## Failure handling (active PR goes red)

1. Classify first: **flake/infra** (known-flaky suite, runner death, zombie
   check) → exactly one re-run (`ci_reruns_max`). **Real** → step 2.
2. Dispatch a fix agent — infra/CI agent for workflow failures, the
   implementation agent for code — in the PR's branch (worktree), capped at
   `fix_attempts_max` (default 2).
3. Still red → `mm:escalated` + diagnosis comment (what failed, what was
   tried, your read on root cause) + escalation message (config channel).
   Clear `<state_dir>/active`, move to the next PR. **Never** head-of-line
   block; **never** merge red; **never** admin-bypass.

## Rebase dispatch

Background agent in a worktree: `git fetch origin && git rebase
origin/<default_branch>`; regenerate lockfiles per repo convention rather than
hand-merging them; `git push --force-with-lease`. Never plain `--force`. If
the branch head moved since your snapshot, re-verify before touching it.

## Merging

- Method from config: `multi_commit` → `gh pr merge N --merge`;
  `single_commit` → `--squash`. Never `--admin`.
- Post-merge: **remove all `mm:*` labels** (`gh pr edit N --remove-label
  mm:active`) — labels are LIVE pipeline state; a merged PR's status is
  GitHub's MERGED state, and a lingering `mm:active` misreports the queue.
  Then verify intended issues auto-closed (reopen mis-closes), digest
  comment on the PR, re-evaluate the whole queue for new conflicts/staleness,
  journal it.
- Post-merge cleanup (clean merges only — skip if the merge was contentious,
  is a revert candidate, or the PR carries follow-up work in its worktree):
  delete the remote branch (`gh api -X DELETE repos/<repo>/git/refs/heads/<branch>`)
  and any local branch for the merged ref (`git branch -D <branch>`, worktree
  or not). If a local worktree exists for the branch **and** `git -C <wt>
  status --porcelain` is empty (tracked + untracked clean), `git worktree
  remove <wt> --force` + `git worktree prune`. `--force` here deliberately
  destroys ignored files too — `node_modules`, `dist`, local `.env` copies —
  that is the point of the cleanup; anything worth keeping must be committed
  or the tree left dirty. Never remove the main checkout, your own cwd, or a
  dirty tree — journal dirty trees for the operator instead.

## Dependabot (idle work only)

**Quick-check green is not full CI.** Auto-merge only categories listed in
`dependabot.auto_merge` (patch/minor dev-deps + CI actions + the grouped
patch PR), and only after running the configured `local_gate` on the PR's
head in a clean worktree. Green → merge → journal. Red → comment findings,
escalate. Majors / runtime deps / Docker bases / engine bumps: **never
auto** — batch into a triage-playbook agent run or escalate.

## Escalation

`mm:escalated` label + diagnosis comment on the PR + message to
`escalation.slack_channel` (or ledger-issue comment if unset): what's
blocked, what you tried, what decision is needed. Escalations never stall
the queue and are never silent.

## Shutdown (`STOP` event, user interrupt, or pause request)

Finish or safely park the in-flight PR (never abandon between "marked ready"
and "merge decision" without a comment), post a session-end digest to the
ledger issue (merged / escalated / auto-merged counts, notable decisions),
final heartbeat with status "session end", stop the Monitor.

## Hard rules

Never push to the default branch · never merge red required checks · never
`--force` (lease only) · never admin-bypass · never resolve substantive
review threads to unblock · never apply DB migrations where that is
operator-only (ping instead) · tolerate humans merging out from under you
(re-snapshot, reconcile, journal the anomaly, continue).
