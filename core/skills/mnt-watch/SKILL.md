---
name: mnt-watch
description: Manage the Fleet Health Desk (FHD) watched service registry (`fleet-health.yml`) — triage dependency observability (green/yellow/red), draft 9-question watch specifications, dry-run probes, run game-day simulations, and gate registry changes through human operator approval on GitHub. Use when the user says "/mnt-watch", "watch a service", "add to fleet health", "check fleet health", or "simulate an outage".
---

# `/mnt-watch` — Fleet Health Desk Registry & Watch Management

Manage the Fleet Health Desk (`<engsys-root>/fleet/health.sh` / `fleet health`) watched dependency registry (`fleet-health.yml`). Detailed architecture and schema reference live in [`docs/fleet-health-desk.md`](../../../docs/fleet-health-desk.md) and [`<engsys-root>/skills/maintenance-monster/references/phase-details.md`](../maintenance-monster/references/phase-details.md).

## Subcommands

- **`/mnt-watch list`** — Show all watched services, current health state, hysteresis counters, and active advice:
  ```bash
  node <engsys-root>/fleet/health/cli.mjs status --file <fleet-health.yml> --state-dir <state_dir>
  ```
- **`/mnt-watch add <service>`** — Triage observability, answer the 9-question watch specification, dry-run the probe, and open an operator `config` approval gate on GitHub.
- **`/mnt-watch remove <service>`** — Verify no downstream service lists `<service>` in `depends_on`, then request an operator `config` approval gate before removing it from `fleet-health.yml`.
- **`/mnt-watch test <service>`** — Run a live probe and schema check for `<service>`:
  ```bash
  node <engsys-root>/fleet/health/cli.mjs check <service> --file <fleet-health.yml> --state-dir <state_dir> --live
  ```
- **`/mnt-watch simulate <service> <up|degraded|down|clear>`** — Run an end-to-end game-day drill (state override, DAG suppression, board render, `weather-check.mjs` hook cache, and optional Slack/fallback notification):
  ```bash
  node <engsys-root>/fleet/health/cli.mjs simulate <service> --state <state> --file <fleet-health.yml> --state-dir <state_dir>
  ```

## Observability Triage (Green / Yellow / Red)

Before adding any dependency to `fleet-health.yml`, classify its observability:

1. **Green (`observability: green`)** — Has a dedicated, cheap, machine-readable health surface:
   - Public Statuspage (`adapter: statuspage`), unauthenticated HTTP health endpoint (`adapter: http-health`), or structured passive friction counter (`adapter: observed`).
   - Safe for `tier: always-on` or `tier: core`.
2. **Yellow (`observability: yellow`)** — Requires an authenticated CLI call or synthetic probe (`adapter: synthetic-cmd`):
   - Must define an `auth_check` (or rely on FHD's built-in auth/context error classifier) so a host-local expired token or missing kubeconfig never trips a false vendor-wide outage.
   - Prefer `tier: on-ambiguity` (probed only when passive friction reports arrive or during recovery) or conservative `poll_interval_seconds`.
3. **Red (`observability: red`) — REFUSE FAKE CHECKS**:
   - No honest, low-cost probe surface exists (e.g., probing would trigger billable jobs, mutate production state, or only test local network reachability).
   - **Rule**: Refuse to add `observability: red` services to `fleet-health.yml` (`fleet health watch-add` exits 1 on `red`). Instead, open an engineering tracking issue to build an honest health endpoint or structured log counter first.

## The 9-Question Watch Specification (`watch-add`)

Every new watched service entry must answer all 9 questions:

1. **Q1 — Service ID & Name**: Lowercase slug (`^[a-z][a-z0-9-]{1,38}$`, e.g., `github-actions`) and human display name.
2. **Q2 — Failure Modes**: Which concrete outages or degradations affect fleet sessions (e.g., stuck workflow queues, HTTP 502/503, rate-limit exhaustion)?
3. **Q3 — Observability Class**: `green`, `yellow`, or `red` (refuse `red`).
4. **Q4 — Adapter & Probe Surface**: `statuspage` (`url`, optional `components`), `observed` (`window_seconds`, `degraded_count`, `down_count`), `http-health` (`url`, `expected_status`), or `synthetic-cmd` (`command`, `auth_check`).
5. **Q5 — Tier & Cadence**: `always-on`, `core`, or `on-ambiguity`, plus `poll_interval_seconds`.
6. **Q6 — Asymmetric Hysteresis**: `thresholds.trip_fails` (consecutive bad probes to trip `degraded`/`down`) and `thresholds.recover_clean` (consecutive clean probes + statuspage clear to recover to `up`).
7. **Q7 — Dependency DAG (`depends_on`)**: Upstream services whose outage causes this service to fail (e.g., `github-actions` depends on `github-api`), enabling root-cause tagging and downstream alarm suppression (`suppressed_by`).
8. **Q8 — Fleet Impact Flags**: `impact.hold_merges` (Merge Monster holds merges), `impact.pause_claims` (workers pause new issue claims), `impact.dispatch_warn` (warn before dispatching subagents).
9. **Q9 — Runbook & Advice**: Concise operator/agent advice (`runbook.advice`, never containing `PUSH_OVERRIDE`) and optional gated actions (`runbook.actions.<name>.requires_gate`).

## Workflow for Adding or Removing a Watch

1. **Generate the spec & YAML snippet**:
   ```bash
   node <engsys-root>/fleet/health/cli.mjs watch-add <service> \
     --name "<Display Name>" \
     --observability <green|yellow> \
     --adapter <statuspage|observed|http-health|synthetic-cmd> \
     --tier <always-on|core|on-ambiguity> \
     --url "<url>" \
     --advice "<concise guidance>"
   ```
2. **Dry-run & validate**:
   Add the candidate block to a scratch copy or worktree `fleet-health.yml` and validate both schema/DAG and live probe execution:
   ```bash
   node <engsys-root>/fleet/health/cli.mjs validate --file <fleet-health.yml>
   node <engsys-root>/fleet/health/cli.mjs check <service> --file <fleet-health.yml> --state-dir <state_dir> --live
   ```
3. **Gate through human operator approval on GitHub**:
   Never mutate a production `fleet-health.yml` without an operator approval gate (`kind: config`). Post the gate request via `watch-add --request-gate` or `gate-check.mjs request`:
   ```bash
   node <engsys-root>/lib/gate-check.mjs request \
     --repo <owner/repo> --issue <board_or_ledger_issue> \
     --kind config --target "fleet-health:<service>" \
     --what "Add watched service <service> to fleet-health.yml"
   ```
4. **Verify approval before merging/committing**:
   Wait for a human operator to comment `/approve <gate-id>` on the GitHub issue, verify exit `0` with `node <engsys-root>/lib/gate-check.mjs check`, and only then commit the `fleet-health.yml` update.

## Hard Rules

- Never add an `observability: red` service or invent a fake probe just to check a box.
- Never include `PUSH_OVERRIDE` in any `fleet-health.yml` `impact`, `runbook`, or `advice` field (`registry.mjs` rejects it at parse time).
- Never bypass `gate-check.mjs` (`--kind config`) when adding or removing watched services in a live fleet.
- Always run `fleet health watch-remove <service>` before removing a service to ensure no downstream `depends_on` edges break.
