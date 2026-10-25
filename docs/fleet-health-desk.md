# Fleet Health Desk (FHD)

The **Fleet Health Desk (FHD)** (`core/fleet/health/`, `fleet health`) is the dependency weather station for an engsys fleet. Owned by **Maintenance Monster** while holding the `maintain` baton (`refs/engsys/batons/maintain`), FHD probes external and shared dependencies, correlates friction reports from worker and orchestrator sessions, maintains a single canonical status board on GitHub, and broadcasts actionable weather advisories across every session and watch bus.

---

## 1. Architecture Overview

FHD is organized into five zero-dependency modules under [`core/fleet/health/`](../core/fleet/health/):

1. **[`registry.mjs`](../core/fleet/health/registry.mjs)** — Parses and validates `fleet-health.yml`, enforces adapter/tier/observability schemas, verifies that `depends_on` forms an acyclic DAG, and blocks `PUSH_OVERRIDE` from appearing in any `impact`, `runbook`, or `advice` field.
2. **[`adapters.mjs`](../core/fleet/health/adapters.mjs)** — Executes five probe adapter types:
   - `statuspage`: Fetches Atlassian Statuspage `summary.json` / `status.json` with conditional `If-None-Match` (`ETag` / HTTP `304`) caching and optional `components` filtering. Non-200 or malformed JSON returns `'unknown'` (never `'healthy'`).
   - `observed`: Evaluates passive error/friction counters recorded in `<stateDir>/fhd/observed/<service>.jsonl` over a rolling `window_minutes`.
   - `http-health`: Probes an HTTP(S) health endpoint and optionally checks a JSON field (`expect_json`) or regex (`expect_match`).
   - `synthetic-command`: Runs one of a fixed set of read-only check kinds (`probe.check` + typed `probe.params`, defined in [`probe-kinds.mjs`](../core/fleet/health/probe-kinds.mjs)), separating host-local missing auth/context (`auth_check` / credential expiry patterns) from genuine vendor-wide outages.
   - `fleet-report-only`: Relies on correlated friction reports from fleet sessions (`fleet health report`).
3. **[`engine.mjs`](../core/fleet/health/engine.mjs)** — Evaluates asymmetric hysteresis (`trip_fails` consecutive failures to trip `degraded`/`down`; `recover_clean` consecutive clean probes + statuspage clear to recover to `healthy`), preserves `last_known_state` when a probe breaks (`state: 'unknown'`), and propagates `depends_on` edges so downstream services get `suppressed_by: <upstream>` during an upstream outage.
4. **[`board.mjs`](../core/fleet/health/board.mjs)** — Renders and parses the `<!-- fleet-health --> ... <!-- /fleet-health -->` block (with machine-readable `<!-- fleet-health-json: {...} -->` metadata and dual ISO-8601 UTC + operator-time timestamps), manages conditional ETag board caching (`fetchBoardCached`), applies updates to the GitHub board issue via fenced `mnt-act.sh guard` only when the board fingerprint changes (or before `stale_minutes` expires), and triggers `core/fleet/notify.mjs` (`--incident fhd-<service>`) on confirmed, non-suppressed transitions.
5. **[`incidents.mjs`](../core/fleet/health/incidents.mjs)** — Handles structured friction reports (`fleet health report`), sanitizes free-text `--symptom` strings with `defang()` (`core/lib/untrusted.mjs`), routes cross-fleet reports via `fleet-msg`, collapses `N` reports within a correlation window into a single incident, runs a rate-limited verification probe, and classifies `vendor-wide` (`FHD_REPORT_CORRELATED`) vs `session-local` (`FHD_LOCAL_GUIDANCE`).

---

## 2. Configuration (`fleet-health.yml`)

### Where the registry lives

The desk loads `fleet-health.yml` only from the fleet instance repo (`<instance>/fleet-health.yml` or `<instance>/config/fleet-health.yml`) or the fleet state dir (`<FLEET_STATE>/fleet-health.yml`). The fleet launcher writes `FLEET_STATE` (an absolute `<instance>/.fleet`) into every session's env; `FLEET_INSTANCE` is honored when set. An explicit `--file`, `--health-config` or `FLEET_HEALTH_FILE` must point inside one of those directories. A project repo's working tree, its `.claude/` directory and its monster config (`fhd_config`) are never read. With no trusted registry, the desk runs no probes and does nothing. (`fleet health validate --file <any path>` still parses any file, since it runs nothing.)

### Commands: kinds, not command lines

A `synthetic-command` probe and an `invoke` entry never carry a command line. Each names a kind from [`probe-kinds.mjs`](../core/fleet/health/probe-kinds.mjs), which builds a literal argv array from typed params. Nothing reaches a shell, and every run gets a scrubbed environment: `PATH`, `HOME`, locale and temp variables, plus only the credential group its kind needs (`GH_*`/`GITHUB_TOKEN` for the `gh-*` kinds, `AZURE_*` for `az-account-show`, `DOCKER_*` for `docker-info`). Runs start in the OS temp dir, not the repo.

| Probe check (`probe.check`) | Runs | Params |
| --- | --- | --- |
| `gh-auth-status` | `gh auth status [--hostname H]` | `hostname` |
| `gh-api-get` | `gh api --method GET <path>` | `path` (required) |
| `az-account-show` | `az account show --output none` | none |
| `coderabbit-auth-status` | `coderabbit auth status` | none |
| `docker-info` | `docker info --format {{.ServerVersion}}` | none |
| `tool-version` | `<tool> --version` | `tool` (required): git, gh, node, az, docker, claude, coderabbit |

`auth_check` takes a check kind name or `{ check, params }`.

| Invoke kind (`invoke.kind`) | Runs | Params |
| --- | --- | --- |
| `gh-run-list` | `gh run list [--repo R] [--status S] [--limit N]` | `repo`, `status`, `limit` (1–100) |
| `gh-api-get` | `gh api --method GET <path>` | `path` (required) |

Every invoke kind requires an operator approval gate (`--approved-gate <id>`, checked by `gate-check.mjs` against the fixed target `fleet-health:invoke:<service>`, kind `config`). `requires_gate` can add a gate but never remove one, and `fleet health invoke` takes no extra command-line arguments.

### Example

```yaml
version: 1
board:
  repo: acme/app
  issue: 42
  stale_minutes: 30
  trusted_editor_ids: [123456789] # numeric GitHub user ID of the fleet App bot that publishes the board

services:
  github-api:
    name: "GitHub API"
    kind: external
    observability: central
    probe:
      adapter: statuspage
      tier: passive
      url: "https://www.githubstatus.com/api/v2/summary.json"
      components: ["API Requests", "Git Operations"]
    poll_seconds: 60
    thresholds:
      trip_fails: 2
      recover_clean: 2
    impact:
      hold_merges: true
      pause_claims: true
      dispatch_warn: true
      advice: "Hold PR merges and new issue claims until GitHub API recovers."
    runbook: "Hold PR merges and new issue claims until GitHub API recovers."

  github-actions:
    name: "GitHub Actions"
    kind: external
    observability: central
    probe:
      adapter: statuspage
      tier: passive
      url: "https://www.githubstatus.com/api/v2/summary.json"
      components: ["Actions"]
    poll_seconds: 120
    thresholds:
      trip_fails: 2
      recover_clean: 2
    depends_on: [github-api]
    impact:
      hold_merges: true
      pause_claims: false
      dispatch_warn: true
      advice: "Hold merges and avoid re-running failed workflows until Actions is green."
    invoke:
      kind: gh-run-list
      params: { status: queued, limit: 10 }
    runbook: "Hold merges and avoid re-running failed workflows until Actions is green."
```

### Safety Invariants

- **No `PUSH_OVERRIDE`**: FHD never emits or permits `PUSH_OVERRIDE` in `fleet-health.yml` or on any watch bus.
- **Broken probes fail to `unknown`**: If a Statuspage returns HTTP 500 or invalid JSON, the adapter returns `state: 'unknown'` and the engine preserves `last_known_state` rather than falsely declaring the service `'healthy'`.
- **Trusted inputs only**: the registry comes from the fleet instance repo or `FLEET_STATE` (above); a fetched board body is accepted only when its last editor's numeric GitHub user ID is in `board.trusted_editor_ids` (read with the GraphQL `editor`/`author` of the same revision). An empty allowlist accepts no fetched board.
- **Auth-local vs. vendor-wide split**: A `synthetic-command` probe whose `auth_check` fails (or whose stderr matches missing credentials/context) sets `auth_local_failure: true` and keeps the service out of vendor-wide `'down'` state.
- **Downstream alarm suppression**: When `github-api` is `degraded` or `down`, dependent services (`depends_on: [github-api]`) are marked `suppressed_by: "github-api"` and never fire separate Slack or watch-bus alarms.

---

## 3. Status Board & Session Weather Checks

### GitHub Status Board Block

Maintenance Monster updates the delimited block on the configured `board.issue`:

```markdown
<!-- fleet-health -->
<!-- fleet-health-json: {"version":1,"last_updated":"2026-10-15T18:00:00Z",...} -->
### Fleet Health Desk — Weather Board
...
<!-- /fleet-health -->
```

`updateIssueBodyWithBoard()` replaces only the region between `<!-- fleet-health -->` and `<!-- /fleet-health -->` and refuses to edit the issue if duplicate or malformed markers exist.

### Hook Injection (`core/.claude-plugin/weather-check.mjs`)

The hook reads only `<FLEET_STATE>/fhd/board-cache.json` (the desk mirrors every board it builds or verifies there) and is silent outside a fleet session. What it injects is built only from each service's id (`^[a-z0-9-]{1,40}$`), its state (`healthy|up|degraded|down|unknown`) and the `hold_merges` / `pause_claims` booleans; a board's `advice`, `name` and other text never reach session context.

- **`SessionStart` (`weather-check.mjs session-start`)**:
  - Silent (`exit 0`, zero output) when FHD is unconfigured or all services are `healthy`.
  - Emits `"Fleet Health Desk: weather unknown (board stale since <ts>)"` when `board.last_updated` exceeds `stale_minutes` (default 30 minutes), or lies more than a minute in the future.
  - Emits 1–2 concise lines with operator-formatted timestamps (`core/lib/operator-time.mjs`): `<id> is DOWN|DEGRADED`, then `Weather advisory: hold merges, pause new issue claims.` when those gates are set.
- **`UserPromptSubmit` (`weather-check.mjs prompt`)**:
  - Compares the current board fingerprint against `<FLEET_STATE>/fhd/fhd-seen-<session>.json` (scoped by `$ENGSYS_SESSION`).
  - Emits a single-line update only when a non-suppressed service state has changed since last seen by that session.

### Watch Bus Events (`mm-watch.sh` & `mnt-watch.sh`)

Every line carries fixed words only (engsys#181): the service id, the state enum, a reason code and the gate words. Probe output (the first line of a command's or an API's response), advice and runbook text stay on the board and in the local state files; `fleet health status` shows them. The reason code is the probe's raw status when it is a plain token (`auth_local_failure`, `timeout`, `exit_<n>`, an HTTP code, a Statuspage indicator), else `probe`.

- `FHD_TRIP <service> <state> reason=<code>[ — hold merges][, pause claims]`: Emitted by `mnt-watch.sh` when a non-suppressed service trips to `degraded` or `down` (or becomes unsuppressed while failing).
- `FHD_RECOVER <service> healthy`: Emitted by `mnt-watch.sh` when a non-suppressed service recovers to `healthy`.
- `FHD_CHANGE <service> <state>[ reason=<code>][ — hold merges][, pause claims]`: Emitted once per non-suppressed state change. The probe tick adds the reason code; lines from a fetched board carry only the id, state and the gate words.
- `FHD_REPORT_CORRELATED <service> <incident-id> vendor-wide reports=<N> state=<state>`: Emitted when friction reports correlate into a confirmed vendor-wide incident.
- `FHD_LOCAL_GUIDANCE <target-session> <service> reason=<auth_local_failure|session_local|per_session> — <fixed guidance>`: Emitted when friction reports occur while live verification proves the vendor is healthy (or when local auth/context is missing). The guidance is fixed text pointing at `fleet health status`.

---

## 4. CLI Reference (`fleet health`)

```bash
fleet health validate [--file <fleet-health.yml>] [--json]
fleet health registry-path
fleet health status [--file <fleet-health.yml>] [--state-dir <dir>] [--render-board] [--json]
fleet health tick [--file <fleet-health.yml>] [--state-dir <dir>] [--repo <o/r>] [--issue <N>] [--publish-github] [--notify]
fleet health watch-board [--repo <o/r>] [--issue <N>] [--state-dir <dir>] [--role <merge|maintain>]
fleet health check <service> [--live] [--json]
fleet health report --service <id> --symptom "<text>" [--session <name>] [--to <fleet>:<session>] [--correlate] [--json]
fleet health simulate <service> --state <healthy|up|degraded|down|clear> [--notify]
fleet health invoke <service> [--approved-gate <id>] [--json]
fleet health self-probe [--stale-minutes 30] [--json]
fleet health digest [--days 7] [--json]
fleet health watch-add <service> --observability <green|yellow|red> --adapter <type> --tier <passive|on-ambiguity> ...
fleet health watch-remove <service>
```
