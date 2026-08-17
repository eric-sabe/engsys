# Maintenance Monster — protocol (for every other session)

Maintenance Monster (`<ns>-maintain`) is Merge Monster's sibling: it owns
the security/dependency watch surface (Dependabot PRs + alerts, GHAS/CodeQL,
Secret Scan, the push-only Trivy image scan) in this repo. Full design:
`docs/maintenance-monster.md` in [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/maintenance-monster.md). This doc is the contract for other sessions —
what its baton means, what it produces, and how to reach it.

## The baton

Its own pinned **🔧 Maintenance Monster ledger** issue — distinct from Merge
Monster's ledger — with the same heartbeat-freshness contract:

- Heartbeat **fresher than `stale_lock_minutes`** (see
  `.claude/maintenance-monster.yml`, default 45 min) → the watchdog session is
  the sole owner of Dependabot and the rest of the watch surface in this repo.
  Don't triage Dependabot PRs yourself, don't dismiss a Trivy/CodeQL finding,
  and don't touch `mnt:*` labels — that's its job.
- Heartbeat stale or the ledger issue closed → it isn't running; normal manual
  triage discipline applies (the repo's Dependabot triage playbook, if it carries one — config
  `triage_playbook` — is still the phase model).

## What it produces (and doesn't)

- **Phase 1 (current default): read-only.** It watches, dedups, triages, and
  **reports** — findings land in its ledger/journal with a disposition and
  reasoning, and it escalates anything that needs a human. It opens **no
  fix PRs** in this phase.
- **Phase 2+ (once armed via `phase: auto_drive`):** it opens fix PRs for the
  auto-fix and expert-assisted classes, labels them **`mm:ready`** (with an
  `mm-handoff` `session: <ns>-maintain`), and hands them to the merge orchestrator
  — it **never merges**. The `<ns>-mm` session pilots those PRs through ready → CI →
  merge exactly like any other hand-off.

Producer/consumer, no baton fight: each session owns its own ledger, and
Maintenance Monster respects Merge Monster's merge baton by definition — it
never touches the merge step.

## Dependabot ownership

The watchdog is the **sole owner of Dependabot** in this repo. Merge
Monster's `dependabot.auto_merge` is retired (empty in `.claude/merge-monster.yml`)
so the two never race for the same PR. If you see a raw, untriaged Dependabot
PR, it's Maintenance Monster's to classify — don't merge it yourself while its
heartbeat is fresh.

## Suppression / accepted-risk findings

A dismissed or ignored finding (a `dependabot.yml` ignore, a Trivy/CodeQL
dismissal) always ships with a tracking issue + rationale, and only takes
effect once the **operator** applies the `risk-accepted` label to that issue.
Maintenance Monster (or `nyx`) proposes the suppression; it never applies the
label itself. No `risk-accepted` label, no suppression — treat any
unsuppressed finding as still live regardless of what a session claims.

## How it escalates

`mnt:escalated` label + a diagnosis comment on the tracking issue (or PR, in
Phase 2+) + a message to the configured escalation Slack channel (empty config → GitHub-only) — the
same channel Merge Monster escalates to, so it's one place to watch. Nudges
back to the finding's driving session use the same `<ns>-*`-prefixed
cross-session messaging Merge Monster uses (see `docs/agent-messaging.md` in
[engsys](https://github.com/eric-sabe/engsys/blob/main/docs/agent-messaging.md)).

## Watching progress

- Live queue: `logs/maintenance-monster/state.md` (or the configured
  `state_dir`)
- Decisions log: `logs/maintenance-monster/journal-YYYY-MM.md`
- From anywhere: the pinned **🔧 Maintenance Monster ledger** issue
  (heartbeat, session digests, escalations)

## Kill switch

Close the ledger issue. Maintenance Monster finishes or safely parks any
in-flight triage, posts a digest, and idles. Reopen to re-arm.
