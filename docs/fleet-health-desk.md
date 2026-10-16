# Fleet Health Desk (FHD)

The **Fleet Health Desk (FHD)** (`core/fleet/health/`, `fleet health`) is the dependency weather station for an engsys fleet. Owned by **Maintenance Monster** while holding the `maintain` baton (`refs/engsys/batons/maintain`), FHD probes external and shared dependencies, correlates friction reports from worker and orchestrator sessions, maintains a single canonical status board on GitHub, and broadcasts actionable weather advisories across every session and watch bus.

---

## 1. Architecture Overview

FHD is organized into five zero-dependency modules under [`core/fleet/health/`](../core/fleet/health/):

1. **[`registry.mjs`](../core/fleet/health/registry.mjs)** — Parses and validates `fleet-health.yml`, enforces adapter/tier/observability schemas, verifies that `depends_on` forms an acyclic DAG, and blocks `PUSH_OVERRIDE` from appearing in any `impact`, `runbook`, or `advice` field.
2. **[`adapters.mjs`](../core/fleet/health/adapters.mjs)** — Executes four probe adapter types:
   - `statuspage`: Fetches Atlassian Statuspage `summary.json` / `status.json` with conditional `If-None-Match` (`ETag` / HTTP `304`) caching and optional `components` filtering. Non-200 or malformed JSON returns `'unknown'` (never `'up'`).
   - `observed`: Evaluates passive error/friction counters recorded in `<stateDir>/fhd/observed/<service>.jsonl` over a rolling `window_seconds`.
   - `http-health`: Probes an HTTP(S) health endpoint and optionally checks a JSON field (`expect_json_field` / `expect_json_value`).
   - `synthetic-cmd`: Runs a bounded read-only CLI check, separating host-local missing auth/context (`auth_check` / credential expiry patterns) from genuine vendor-wide outages.
3. **[`engine.mjs`](../core/fleet/health/engine.mjs)** — Evaluates asymmetric hysteresis (`trip_fails` consecutive failures to trip `degraded`/`down`; `recover_clean` consecutive clean probes + statuspage clear to recover to `up`), preserves `last_known_state` when a probe breaks (`state: 'unknown'`), and propagates `depends_on` edges so downstream services get `suppressed_by: <upstream>` during an upstream outage.
4. **[`board.mjs`](../core/fleet/health/board.mjs)** — Renders and parses the `<!-- fleet-health --> ... <!-- /fleet-health -->` block (with machine-readable `<!-- fleet-health-json: {...} -->` metadata and dual ISO-8601 UTC + operator-time timestamps), manages conditional ETag board caching (`fetchBoardCached`), applies updates to the GitHub board issue via fenced `mnt-act.sh guard`, and triggers `core/fleet/notify.mjs` (`--incident fhd-<service>`) on confirmed, non-suppressed transitions.
5. **[`incidents.mjs`](../core/fleet/health/incidents.mjs)** — Handles structured friction reports (`fleet health report`), sanitizes free-text `--symptom` strings with `defang()` (`core/lib/untrusted.mjs`), routes cross-fleet reports via `fleet-msg`, collapses `N` reports within a correlation window into a single incident, runs a rate-limited verification probe, and classifies `vendor-wide` (`FHD_REPORT_CORRELATED`) vs `session-local` (`FHD_LOCAL_GUIDANCE`).

---

## 2. Configuration (`fleet-health.yml`)

```yaml
version: 1
board_issue: 42

services:
  github-api:
    name: "GitHub API"
    tier: always-on
    observability: green
    adapter: statuspage
    url: "https://www.githubstatus.com/api/v2/summary.json"
    components: ["API Requests", "Git Operations"]
    poll_interval_seconds: 60
    thresholds:
      trip_fails: 2
      recover_clean: 2
    impact:
      hold_merges: true
      pause_claims: true
      dispatch_warn: true
    runbook:
      advice: "Hold PR merges and new issue claims until GitHub API recovers."

  github-actions:
    name: "GitHub Actions"
    tier: core
    observability: green
    adapter: statuspage
    url: "https://www.githubstatus.com/api/v2/summary.json"
    components: ["Actions"]
    poll_interval_seconds: 120
    thresholds:
      trip_fails: 2
      recover_clean: 2
    depends_on: [github-api]
    impact:
      hold_merges: true
      pause_claims: false
      dispatch_warn: true
    runbook:
      advice: "Hold merges and avoid re-running failed workflows until Actions is green."
      actions:
        list-queued:
          command: "gh run list --status queued --limit 10"
          requires_gate: false
        cancel-stuck:
          command: "gh run list --status in_progress --json databaseId"
          requires_gate: true
```

### Safety Invariants

- **No `PUSH_OVERRIDE`**: FHD never emits or permits `PUSH_OVERRIDE` in `fleet-health.yml` or on any watch bus.
- **Broken probes fail to `unknown`**: If a Statuspage returns HTTP 500 or invalid JSON, the adapter returns `state: 'unknown'` and the engine preserves `last_known_state` rather than falsely declaring the service `'up'`.
- **Auth-local vs. vendor-wide split**: A `synthetic-cmd` probe whose `auth_check` fails (or whose stderr matches missing credentials/context) sets `auth_local_failure: true` and keeps the service out of vendor-wide `'down'` state.
- **Downstream alarm suppression**: When `github-api` is `degraded` or `down`, dependent services (`depends_on: [github-api]`) are marked `suppressed_by: "github-api"` and never fire separate Slack or watch-bus alarms.

---

## 3. Status Board & Session Weather Checks

### GitHub Status Board Block

Maintenance Monster updates the delimited block on the configured `board_issue`:

```markdown
<!-- fleet-health -->
<!-- fleet-health-json: {"version":1,"last_updated":"2026-10-15T18:00:00.000Z",...} -->
### Fleet Health Desk — Weather Board
...
<!-- /fleet-health -->
```

`updateIssueBodyWithBoard()` replaces only the region between `<!-- fleet-health -->` and `<!-- /fleet-health -->` and refuses to edit the issue if duplicate or malformed markers exist.

### Hook Injection (`core/.claude-plugin/weather-check.mjs`)

- **`SessionStart` (`weather-check.mjs session-start`)**:
  - Silent (`exit 0`, zero output) when FHD is unconfigured or all services are `up`.
  - Emits `"Fleet Health Desk: weather unknown (board stale since <ts>)"` when `board.last_updated` exceeds `stale_minutes` (default 30 minutes).
  - Emits 1–2 concise lines with operator-formatted timestamps (`core/lib/operator-time.mjs`) and advice when any non-suppressed service is `degraded` or `down`.
- **`UserPromptSubmit` (`weather-check.mjs prompt`)**:
  - Compares the current board fingerprint against `<cacheDir>/fhd-seen-<session>.json` (scoped by `$ENGSYS_SESSION`).
  - Emits a single-line update only when a non-suppressed service state has changed since last seen by that session.

### Watch Bus Events (`mm-watch.sh` & `mnt-watch.sh`)

- `FHD_CHANGE <service> <state> — <advice>`: Emitted once per state change on the status board.
- `FHD_TRANSITION <service> <from> -> <to> — <advice>`: Emitted by `mnt-watch.sh` when a probe tick confirms a non-suppressed transition.
- `FHD_REPORT_CORRELATED <id> <service> vendor-wide reports=<N> — <summary>`: Emitted when friction reports correlate into a confirmed vendor-wide incident.
- `FHD_LOCAL_GUIDANCE <service> session-local reports=<N> — <advice>`: Emitted when friction reports occur while live verification proves the vendor is healthy.

---

## 4. CLI Reference (`fleet health`)

```bash
fleet health validate [--file <fleet-health.yml>] [--json]
fleet health status [--file <fleet-health.yml>] [--state-dir <dir>] [--render-board] [--json]
fleet health tick [--file <fleet-health.yml>] [--state-dir <dir>] [--repo <o/r>] [--issue <N>] [--publish-github] [--notify]
fleet health watch-board [--repo <o/r>] [--issue <N>] [--state-dir <dir>] [--role <merge|maintain>]
fleet health check <service> [--live] [--json]
fleet health report --service <id> --symptom "<text>" [--session <name>] [--context <pr/job>] [--correlate]
fleet health simulate <service> --state <up|degraded|down|clear> [--notify]
fleet health invoke <service> <action> [--approved-gate <id>]
fleet health self-probe [--stale-minutes 30] [--json]
fleet health digest [--days 7] [--json]
fleet health watch-add <service> --observability <green|yellow|red> --adapter <type> ...
fleet health watch-remove <service>
```
