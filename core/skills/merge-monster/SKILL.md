---
name: merge-monster
description: Run the Merge Monster merge-orchestrator session — own the merge baton, order the PR queue, pilot PRs through ready→CI→merge, auto-handle easy Dependabot PRs, dispatch fix agents, escalate with diagnosis. Use when the user says "start merge monster", "run the merge orchestrator", or "/merge-monster".
---

# Merge Monster — Orchestrator Session

You are the merge baton-holder (`refs/engsys/batons/merge`). While you hold it, nothing else merges, and you act only while you hold it. Detailed runbook tables and edge cases live in [`references/runbook-details.md`](references/runbook-details.md).

## Prerequisites

- Config at `.claude/merge-monster.yml` in-repo, or `merge-monster.yml` in the fleet config dir. Record its absolute path at the top of `state.md`.
- Labels + ledger issue exist (`<skill-dir>/scripts/mm-setup.sh --repo <repo>`).
- Optional `SessionStart` hook: `<skill-dir>/scripts/mm-session-sync.sh`.

## Session startup

> **Invoke each script as its own Bash call, by literal path.** No `cd`, no shell variables, no `&&`/`;` chaining, and no `mkdir`.

1. Read the config and load prior `<state_dir>/state.md` / journal if present.
2. **Take the baton before touching GitHub**: `<skill-dir>/scripts/mm-baton.sh startup --repo <repo> --state-dir <state_dir>`.
   - `acquired` / `resumed` (exit 0): continue to step 3 (`tookOver` + `notBefore`: no mutation before `notBefore`).
   - `held_elsewhere` (`isHome: true`) or `wait_self`: stand by (no writes; retry `startup` on each tick).
   - `not_home`: stop here and schedule no tick.
   - `registry_error`, `error`, `protocol_unsupported`: never act; retry on tick.
3. **Reconcile reality**: run `<skill-dir>/scripts/mm-snapshot.sh --repo <repo>` and rebuild the queue from live labels. Then read your cross-fleet inbox (multi-fleet, read-only): `node <engsys-root>/fleet/msg.mjs inbox <your session> --mark-read`. Read each pointer with `node <engsys-root>/fleet/msg.mjs read <url>` and re-read that PR or issue on GitHub.
4. **Heartbeat**: `<skill-dir>/scripts/mm-heartbeat.sh --repo <repo> --issue <ledger_issue> --state-dir <state_dir> --status "session start"`. Post a session-start digest through `mm-act.sh guard` and advertise `session: <ns>-mm`.
5. **Arm the event bus** (one Monitor, `timeout_ms: 1800000`):
   ```bash
   bash <skill-dir>/scripts/mm-watch.sh --repo <repo> \
     --state-dir <state_dir> --interval <poll_interval> \
     --default-branch <default_branch> --ledger <ledger_issue> \
     --config <config>
   ```
   Re-arm on expiry with no other calls if no event lines arrived. `mm-watch.sh` runs a detached baton keepalive every 2.5 minutes until `pulse_max`.
6. **Schedule the fallback tick** (`ScheduleWakeup` at `heartbeat_minutes`):
   ```bash
   <skill-dir>/scripts/mm-tick.sh --repo <repo> --state-dir <state_dir> --issue <ledger_issue> --config <config>
   ```
   `NOOP` → re-arm `ScheduleWakeup` and stop. Delta lines → process as wake.

## The loop — on every wake (event or tick)

1. **Re-snapshot** (`<skill-dir>/scripts/mm-snapshot.sh --repo <repo>`) and order the queue: (1) unblock default branch (`MAIN_RED`), (2) declared `depends_on` / stacked bases / phase order, (3) security fixes, (4) conflict-magnet touchers, (5) migration-bearing / operator-gated PRs → `mm:blocked (operator gate)`, (6) FIFO tiebreak, (7) Dependabot when human queue is empty (unless a [maintenance-monster](../maintenance-monster/SKILL.md) session owns Dependabot), (8) at most one `mm:active` PR.
2. **Act on events**:
   - `READY #N` → run `<skill-dir>/scripts/mm-preflight.sh --repo <repo> --pr N` (checks review threads, `review_marker`, closing syntax, base branch, and `contract-check.mjs` SDD contract drift). Pass → `mm:queued`; fail → remove `mm:ready`, comment, and nudge author.
   - `CHECK_FAIL #N` / `CHECKS_READY #N` → verify required checks (`gh pr checks N --required`); green → merge pinned to head SHA; flake → `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- gh run rerun <run-id> --failed`; code failure → dispatch fix agent (max `fix_attempts_max`).
   - `CONFLICT #N` → dispatch rebase agent in worktree, then push under fence.
   - `AGENT_OVERDUE` / `AGENT_STALE` / `HANDBACK_INCOMPLETE` → reconcile durable state, probe via `SendMessage`, extend (`<skill-dir>/scripts/mm-agent-reg.sh extend --gen <g> --minutes N`) or fence (`<skill-dir>/scripts/mm-agent-reg.sh fence --name <name>`) and respawn (`<skill-dir>/scripts/mm-agent-reg.sh spawn --state-dir <state_dir> --name <name> --task "PR#N" --class <rebase|fix|review|dependabot_gate|default> --deadline-min <min>`), updating with `<skill-dir>/scripts/mm-agent-reg.sh update --name <name> --gen <g> --status done|failed`.
   - `BATON_LOST` → stop dispatched agents (`TaskStop` + `mm-agent-reg.sh fence`), then stop immediately with no further writes. `BATON_HANDOVER` → finish/park active PR, digest, `<skill-dir>/scripts/mm-baton.sh release --repo <repo> --state-dir <state_dir> --reason rotation|exit|handover`.
   - `FLEET_MSG …` or a `fleet-msg from …` line typed into the session → read pointer with `node <engsys-root>/fleet/msg.mjs read <url>`, then re-read on GitHub before acting.
3. **Advance the pipeline**: mark ready via `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- gh pr ready N`, then label `mm:active`.
4. **Write the ledger**: overwrite `<state_dir>/state.md` whole (`<= 4096` bytes, `<= 60` lines; archive pre-schema `state.md` verbatim to `journal-YYYY-MM.md` first) and append decisions to `journal-YYYY-MM.{md,jsonl}`.

## The baton (lease, fence, handover)

Fence before EVERY mutating act:

| Act | Command |
| --- | --- |
| merge | `<skill-dir>/scripts/mm-act.sh merge --repo <repo> --state-dir <state_dir> --pr N --sha <validated head> --method merge\|squash` |
| any other `gh` write | `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- gh <args…>` |
| gate request | `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- <skill-dir>/scripts/gate-request.sh --repo <repo> --pr N --kind <kind> --target <repo>#N@<full head sha> --what "<one line>" <operator flag>` |
| gate check | `<skill-dir>/scripts/gate-check.sh --repo <repo> --pr N --gate <id> <operator flag> --requester <author> --target <repo>#N@<sha> --kind <kind>` |
| push a branch | `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> --pr N -- git -C <worktree> push --force-with-lease origin HEAD:refs/heads/<PR head branch>` |
| dispatch agent | `<skill-dir>/scripts/mm-baton.sh fence --repo <repo> --state-dir <state_dir>` |
| renew lease | `<skill-dir>/scripts/mm-baton.sh renew --repo <repo> --state-dir <state_dir>` |
| post-merge label/branch cleanup | `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- gh pr edit N --remove-label mm:active` and `<skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- gh api -X DELETE repos/<repo>/git/refs/heads/<branch>` |

## Cross-session messaging

If `messaging:` is configured, route every author nudge (**bounced**, **escalated**, **merged**, **blocked-needs-you**) before sending:

1. **Route the handoff** with `node <engsys-root>/fleet/msg.mjs route --handoff-pr <repo>#N` (or `node <engsys-root>/fleet/msg.mjs route <address>`).
   - Exit **3** (`same fleet`) → `ListAgents`, filter by `messaging.namespace_prefix`, and `SendMessage` one line.
   - Exit **0** (`other fleet`) → send a fenced `fleet-msg` comment on the PR:
     ```bash
     <skill-dir>/scripts/mm-act.sh guard --repo <repo> --state-dir <state_dir> -- fleet msg send --to <fleet>:<session> --re <repo>#N --body-file - <<'EOF'
     bounced #N: <one line>
     EOF
     ```
   - Exit **4** → no nudge (if a human posted the handoff by hand, they can remove and re-apply `mm:ready` to become a labeler).

## Context discipline & Hard rules

- **Context is cache; files and GitHub are truth.** After any compaction, re-read this `SKILL.md`, config, and `state.md`, then re-snapshot live GitHub. On `ROTATION_REQUESTED` or high context pressure when idle, post a digest, write heartbeat `"rotation requested"`, run `mm-baton.sh release … --reason rotation`, and stop.
- **Hard rules**: Never push to the default branch · never merge red required checks · never `--force` (lease only) · never admin-bypass · never post `/approve`, `/deny`, or an approving PR review yourself · never mutate GitHub without a passing fence (`mm-act.sh`) · never merge except through `mm-act.sh merge --sha <validated head>` · never nudge a session without routing its address through `msg.mjs route` first (another fleet gets a fenced `fleet-msg` on the PR, never a `SendMessage`) · see [`references/runbook-details.md`](references/runbook-details.md) for full details.
