---
name: maintenance-monster
description: Run the Maintenance Monster watchdog session — own the security/dependency baton, continuously watch Dependabot PRs + alerts, GHAS/CodeQL, Secret Scan, and the push-only Trivy image scan, dedup + triage each finding, and (from Phase 2 on) drive safe fixes into mm:ready PRs for Merge Monster to merge; escalate the rest. Phase 1 is read-only — watch, triage, and report only. Use when the user says "start maintenance monster", "run the maintenance watchdog", or "/maintenance-monster".
---

# Maintenance Monster — Watchdog Session

You are the security/dependency baton-holder (`refs/engsys/batons/maintain`) for this repository, sibling to [`<engsys-root>/skills/merge-monster/SKILL.md`](../merge-monster/SKILL.md). **Phase 1 (`phase: read_only`, default) is read-only** (classify, report, and escalate only; one opt-in exception for approved `fp_policies` dismissals via `mnt-fp-dismiss.sh`). Detailed phase mechanics and standing false-positive policy rules live in [`references/phase-details.md`](references/phase-details.md).

## Prerequisites

- Config at `.claude/maintenance-monster.yml` in-repo, or `maintenance-monster.yml` in the fleet config dir. Record its absolute path at the top of `state.md`.
- Labels + ledger issue exist (`<skill-dir>/scripts/mnt-setup.sh --repo <repo>`).

## Session startup

> **Invoke each script as its own Bash call, by literal path.** No `cd`, no shell variables, no `&&`/`;` chaining, and no `mkdir`.

1. Read the config and load prior `<state_dir>/state.md` / journal if present.
2. **Take the baton before touching GitHub**: `<skill-dir>/scripts/mnt-baton.sh startup --repo <repo> --state-dir <state_dir>`. Act on `decision` (`acquired`/`resumed` → continue; `held_elsewhere`/`wait_self` → stand by; `not_home` → stop).
3. **Reconcile reality**: run `<skill-dir>/scripts/mnt-snapshot.sh --repo <repo> --default-branch <default_branch>` and rebuild the findings queue. Then read your cross-fleet inbox (multi-fleet, read-only): `node <engsys-root>/fleet/msg.mjs inbox <your session> --mark-read`. Read each pointer with `node <engsys-root>/fleet/msg.mjs read <url>` and re-read that PR or issue on GitHub. With `fp_policies:` configured, run `<skill-dir>/scripts/mnt-fp-candidates.sh --repo <repo> --config <config-file> --state-dir <state_dir> --all` once.
4. **Heartbeat**: `<skill-dir>/scripts/mnt-heartbeat.sh --repo <repo> --issue <ledger_issue> --state-dir <state_dir> --status "session start"`. Post a session-start digest and advertise `session: <ns>-maintain`.
5. **Arm the event bus** (one Monitor, `timeout_ms: 1800000`):
   ```bash
   bash <skill-dir>/scripts/mnt-watch.sh --repo <repo> \
     --state-dir <state_dir> --interval <poll_interval> \
     --default-branch <default_branch> --ledger <ledger_issue> \
     --config <config>
   ```
   Re-arm on expiry with no other calls if no event lines arrived.
6. **Schedule the fallback tick** (`ScheduleWakeup` at `heartbeat_minutes`):
   ```bash
   <skill-dir>/scripts/mnt-tick.sh --repo <repo> --state-dir <state_dir> --issue <ledger_issue> --default-branch <default_branch> --config <config>
   ```

## The loop — on every wake (event or tick)

1. **Re-snapshot** (`<skill-dir>/scripts/mnt-snapshot.sh --repo <repo> --default-branch <default_branch>`) and rebuild the findings queue.
2. **Act on events**:
   - `DEPENDABOT_PR #N`, `DEP_ALERT`, `CODEQL_ALERT`, `SECRET_ALERT`, `TRIVY_RED` → dedup and triage (`SECRET_ALERT` and `TRIVY_RED` jump ahead of the queue).
   - For `CODEQL_ALERT` matching `fp_policies:`, run `<skill-dir>/scripts/mnt-fp-candidates.sh --repo <repo> --config <config-file> --state-dir <state_dir>` and dismiss verified matches via `<skill-dir>/scripts/mnt-fp-dismiss.sh --repo <repo> --config <config-file> --alert <alert#> --policy <policy> --shape "<shape>" --evidence "<evidence>"`.
   - `AGENT_OVERDUE` / `AGENT_STALE` / `HANDBACK_INCOMPLETE` → probe-then-classify via `<engsys-root>/skills/merge-monster/scripts/mm-agent-reg.sh`.
   - `BATON_LOST maintain <code>` → stop dispatched agents (`TaskStop` + `mm-agent-reg.sh fence`), then stop immediately. `BATON_HANDOVER maintain <fleet>` → finish/park triage, digest, `<skill-dir>/scripts/mnt-baton.sh release --repo <repo> --state-dir <state_dir> --reason rotation|exit|handover`.
   - `FLEET_MSG …` or a `fleet-msg from …` line typed into the session → read pointer with `node <engsys-root>/fleet/msg.mjs read <url>`, then re-read on GitHub before acting.
3. **Triage & dispose** into `Auto-fix`, `Expert-assisted` (`nyx`, `aaron`, `isabelle`, `bert`; dispatch `nyx` without `model:`), `Escalate`, or `Suppress` (behind a verified `risk-accepted` operator gate), and rewrite `<state_dir>/state.md` whole (`<= 4096` bytes, `<= 60` lines).
4. **Drive** (gated on `phase:`): in `phase: read_only`, report and escalate only; in `phase: auto_drive`, open fix PRs with `<!-- mm-handoff -->`, label `mm:ready`, and nudge Merge Monster.

## The baton (lease, fence, handover)

| Act | Command |
| --- | --- |
| any `gh` write | `<skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> -- gh <args…>` |
| gate request | `<skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> -- <engsys-root>/skills/merge-monster/scripts/gate-request.sh <args…>` |
| gate check | `<engsys-root>/skills/merge-monster/scripts/gate-check.sh --repo <repo> (--issue N \| --pr N) --gate <id> <operator flag> --requester <author> --target <target> --kind <kind>` |
| CI dispatch | `<skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> -- gh workflow run <workflow> --ref <fix ref>` |
| push new fix branch | `<skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> --new-branch -- git -C <worktree> push origin HEAD:refs/heads/<branch>` |
| push existing PR branch | `<skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> --pr N -- git -C <worktree> push --force-with-lease origin HEAD:refs/heads/<branch>` |
| dispatch fix agent | `<skill-dir>/scripts/mnt-baton.sh fence --repo <repo> --state-dir <state_dir>` |

## Cross-session messaging

Every nudge is routed first with `node <engsys-root>/fleet/msg.mjs route <address>`:

1. **To Merge Monster** (Phase 2+ when queuing a fix PR): route `messaging.mm_session_name` in the merge role's home fleet with `node <engsys-root>/fleet/msg.mjs route acme-mm --repo <repo> --role merge`.
2. **To an implementer**: route the PR's handoff block with `node <engsys-root>/fleet/msg.mjs route --handoff-pr <repo>#N`.
3. **Send**: Exit **3** (`same fleet`) → `ListAgents`, filter by `messaging.namespace_prefix`, and `SendMessage` one line. Exit **0** (`other fleet`) → send a fenced `fleet-msg` on the PR or issue:
   ```bash
   <skill-dir>/scripts/mnt-act.sh guard --repo <repo> --state-dir <state_dir> -- fleet msg send --to <fleet>:<session> --re <repo>#N --body-file - <<'EOF'
   queued fix PR #N for <advisory>: mm:ready
   EOF
   ```

## Context discipline & Hard rules

- **Context is cache; files and GitHub are truth.** Same contract as **§ Context discipline in [`<engsys-root>/skills/merge-monster/SKILL.md`](../merge-monster/SKILL.md)**.
- **Hard rules**: Never open a fix PR or apply a label outside Phase 1's read-only scope · dismiss only through an approved `fp_policies` entry and `mnt-fp-dismiss.sh` · never merge anything · never post `/approve`, `/deny`, or an approving PR review yourself · never nudge a session without routing its address through `msg.mjs route` first · never write to GitHub without a passing fence (`mnt-act.sh`) · see [`references/phase-details.md`](references/phase-details.md) for full details.
