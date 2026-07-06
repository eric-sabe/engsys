# Merge Monster — enqueue protocol (for every other session)

When a Merge Monster session is running, it owns merging in this repo. This
doc is the contract for sessions that *finish PRs* while it runs. Full design:
`docs/merge-monster.md` in engsys.

## The baton rule

Before marking a PR ready or merging, check the pinned **🧌 Merge Monster
ledger** issue:

- Heartbeat **fresher than the configured staleness window** (see
  `stale_lock_minutes` in `.claude/merge-monster.yml`, default 45 min) →
  **do not mark-ready, do not merge.** Label your PR `mm:ready` and walk away.
- Heartbeat stale or issue closed → Merge Monster is not running; the normal
  manual merge discipline applies.

## How to enqueue

1. Finish properly first — `mm:ready` is a claim Merge Monster verifies:
   - local review clean, evidence comment posted (if the repo requires one)
   - local pre-push gate green
   - review threads resolved; PR body correct (one `Closes #N` per line)
2. Add the **`mm:ready`** label to your PR (leave it in draft — Merge Monster
   controls the ready transition, which is the CI trigger).
3. Optionally (encouraged) add a handoff comment:

   ```markdown
   <!-- mm-handoff -->
   depends_on: [123]        # PR numbers that must merge first
   migration: false         # does this PR carry a DB migration?
   project: 62              # project / phase, for ordering
   phase: P3
   notes: touches the lockfile; anything the orchestrator should know
   ```

4. You're done. Merge Monster will reply on the PR: `mm:queued` with a
   position + reasoning, then pilot it through ready → CI → merge. If
   something's missing it removes `mm:ready` and comments exactly what.
   If it needs you, you'll see `mm:escalated` + a diagnosis (and a Slack
   ping where configured).

## What you must not do while the baton is fresh

- Mark PRs ready (that triggers CI — Merge Monster serializes this)
- Merge anything, including "quick" Dependabot PRs
- Force-push a branch labeled `mm:active` (it's being piloted; coordinate via
  a PR comment first)

## Watching progress

- Live queue: `logs/merge-monster/state.md` (or the configured `state_dir`)
- Decisions log: `logs/merge-monster/journal-YYYY-MM.md`
- From anywhere: the pinned ledger issue (heartbeat, session digests,
  escalations)

## Kill switch

Close the ledger issue. Merge Monster finishes or safely parks its in-flight
PR, posts a digest, and idles. Reopen to re-arm.
