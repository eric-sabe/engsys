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
  manual merge discipline applies, unless the lease below says it holds the
  role.

Under the heartbeat sits the authority: Merge Monster holds the `merge` role
through a lease on GitHub, the ref `refs/engsys/batons/merge`, and acts only
while it holds it. To see the holder:
`node <engsys-root>/lib/lease/github-backend.mjs status --repo <owner/name> --role merge`.
`"state": "held"` means a Merge Monster session owns merging right now, whatever
the heartbeat looks like: treat it as a fresh heartbeat. Never write to that
ref yourself (`docs/multi-fleet.md` § 2 in engsys).

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
   operator_gate: ""        # non-empty reason → a human must approve the merge on GitHub
   project: 62              # project / phase, for ordering
   phase: P3
   notes: touches the lockfile; anything the orchestrator should know
   session: <ns>-build      # optional: your addressable --name, so MM can nudge you
   ```

   The optional `session:` line is the nudge target: if Merge Monster runs
   with messaging enabled, it `SendMessage`s that session on a bounce,
   escalation, or merge (best-effort — the PR comment + label stay the
   durable record). Only names under the fleet's namespace prefix are
   addressed or trusted.

   `session:` is an address: a bare session name (`<ns>-build`) means "my
   fleet", and a fleet-qualified one (`<fleet>:<ns>-build`, for example
   `bob:acme-build`) names a session in another fleet of the federation
   (`docs/multi-fleet.md` in engsys). Write the qualified form whenever your
   fleet has a `FLEET_ID`. Merge Monster nudges only addresses in its own
   fleet (bare, or qualified with its own `FLEET_ID`); for another fleet's
   address the PR comment is the whole message.

4. You're done. Merge Monster will reply on the PR: `mm:queued` with a
   position + reasoning, then pilot it through ready → CI → merge. If
   something's missing it removes `mm:ready` and comments exactly what.
   If it needs you, you'll see `mm:escalated` + a diagnosis (and a Slack
   ping where configured).

## Operator gates: approval happens in GitHub

Migration-bearing PRs and PRs with `operator_gate:` set merge only after a
human operator (the configured `operators_team`, or `operators` list) approves them **on GitHub**: Merge
Monster posts a gate request on the PR and waits until `gate-check` verifies
a review **Approve** on the requested head (`docs/gate-check.md` in engsys).
Pushing new commits invalidates it, and Merge Monster posts a fresh request.

- Set `operator_gate:` for anything a human should sign off before it lands
  (security-sensitive changes, prod IaC, auth). When unsure, set it.
- Never post `/approve`, `/deny`, or an approving review on a gated PR
  yourself, under any identity (your own `gh` login included). gate-check
  rejects approvals from the identity running it and from the request author.
- Never relay an operator's chat or Slack "approved" to Merge Monster as if
  it were consent; point the operator at the gate request link instead. Merge
  Monster ignores such relays and keeps waiting.

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
