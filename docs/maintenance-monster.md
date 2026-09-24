# Maintenance Monster — security & dependency watchdog (design)

> **Provenance:** design + worked example from the first production
> deployment (2026-08). The normative, project-agnostic contract lives in the
> skills (`core/skills/merge-monster`, `maintenance-monster`,
> `subagent-liveness`, `agent-sessions`). The example uses the namespace
> `acme-` and repo `acme/app` — read `acme-<role>` as `<your-namespace>-<role>`;
> issue/PR numbers are illustrative.

Status (historical — what shipped first): **Phase 0 + Phase 1 (read-only)
build.** The live phase is always the `phase:` key in the repo's
`maintenance-monster.yml`; read that, not this line. The `acme-maintain` session
runs the `/maintenance-monster` skill built alongside this spec; Phase 1 is
watch + triage + **report** only (no auto-PRs). Held unmerged until the next
Claude Code **session reset** (when `acme-maintain` is launched by the
[launch script](../core/skills/agent-sessions/scripts/launch-agent-sessions.sh)). The four operator
decisions are **resolved** — see [Resolved decisions](#resolved-decisions).
Parallels [Merge Monster](../core/workflows/merge-monster-protocol.md) and reuses the
agent-comms primitives in [agent-messaging.md](agent-messaging.md).

## The gap today

Dependency and security maintenance is reactive and fragmented. Dependabot opens
PRs; GHAS / CodeQL alerts pile up on the security tab; the push-only Trivy
image-scan reds `main` on newly-disclosed CVEs (e.g. #3046 → #3052 this cycle);
`pnpm audit` advisories accrue. The repo's Dependabot triage
playbook (config `triage_playbook`) captures _how_ to handle these, but
it runs on-demand when a human remembers. Merge Monster only sweeps "easy"
Dependabot PRs in idle time and escalates the rest — it is a _merger_, not a
proactive _owner_ of the security surface.

**Maintenance Monster is that owner.** It continuously watches the surface and
triages each finding with the expert agents; in **Phase 1 (current) it reports
only**, and from **Phase 2** it drives the resulting fixes into the normal PR
process. Either way it escalates to a human when a call is theirs to make.

## Relationship to Merge Monster — producer / consumer, no baton fight

The two are deliberately separate and composable:

- **Maintenance Monster produces** — it opens fix PRs and labels them `mm:ready`
  (with an `mm-handoff` `session: acme-maintain`). It **never merges.**
- **Merge Monster consumes** — it pilots those `mm:ready` PRs through
  ready → CI → merge like any other.

Each holds its **own** baton (its own ledger issue, distinct from MM's) so
their heartbeats don't collide. Maintenance Monster respects MM's merge baton by
definition: it hands off and never touches the merge step.

**Dependabot ownership (resolved):** `acme-maintain` is the **sole owner of
Dependabot**. MM's `dependabot.auto_merge` config is **retired** (removed from
`.claude/merge-monster.yml` in this PR) so the two never race for the same PR —
MM merges Dependabot PRs only once Maintenance has triaged them and labeled them
`mm:ready`, exactly like any other hand-off. Trade-off accepted: when
`acme-maintain` is down, nothing auto-handles Dependabot until it is back —
the surface moves slowly and the continuous watchdog (below) keeps that window
short.

## Watch surface

| Source            | Signal                                                                 | How                                  |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Dependabot PRs    | open / grouped / security-vs-version                                   | `gh pr list --label dependencies`    |
| Dependabot alerts | dependency vulnerability advisories                                    | `gh api .../dependabot/alerts`       |
| GHAS / CodeQL     | code-scanning alerts (the `code_scanning` ruleset)                     | `gh api .../code-scanning/alerts`    |
| Secret scanning   | gitleaks CI failures (GH-native push-protection is **not** subscribed) | `Secret Scan` workflow_run           |
| Trivy image scan  | HIGH/CRITICAL image CVEs — **push-only**, reds `main`                  | `services-ci` on push/dispatch       |
| `pnpm audit`      | residual transitive CVEs                                               | the repo's advisory-audit script     |
| Base images       | stale registry base images                                             | the repo's base-image sync script    |

## The loop (parallel to `mm-watch`)

1. **Watch** — poll the surfaces above on a configurable interval; emit events
   (`DEPENDABOT_PR`, `DEP_ALERT`, `CODEQL_ALERT`, `TRIVY_RED`, `SECRET_ALERT`,
   `BASE_STALE`) onto its own event bus.
2. **Dedup** — collapse to the underlying advisory/finding; never open a second
   PR for something already in flight (dedup on advisory id / existing branch).
3. **Triage** — classify by severity, exploitability, blast radius, and
   fix-availability, then route to the right expert (below).
4. **Dispose** — into one of the four classes below.
5. **Drive** — **auto-fix:** branch, apply, local CLI review + `pnpm precheck`,
   open the PR, label `mm:ready` + `mm-handoff`, nudge `acme-mm`.
   **Expert-assisted:** same, but open as a plain draft and add `mm:ready`
   **only after** a human has reviewed. **Escalate:** `mnt:escalated` +
   diagnosis + operator ping (no PR driven).
6. **Ledger** — heartbeat, queue table, and decision journal, exactly like MM.

## Disposition classes

Anchored to the triage playbook's phase model. **Anything that does not clearly
match a class escalates — it never falls through to auto** (the config makes this
default explicit).

- **Auto-fix** (drive without a human): patch/minor dev-dep bumps; the npm
  patch-group; scoped `pnpm.overrides` for transitive CVEs (selector **and**
  target bounded to the vulnerable range so it auto-disables — playbook Phase 2);
  pure CI-action majors; lockfile-noise cleanup.
- **Expert-assisted** (agent drafts, human reviews before `mm:ready`): risky
  majors (read changelog + grep usage), Docker base-image bumps (the coordinated
  10-Dockerfile + engines + CI-ref PR — Phase 5), runtime-dep upgrades.
- **Escalate** (human decides first): breaking-change majors, engine bumps,
  anything touching prod IaC or secrets, and any finding where adopt-vs-defer is
  a product/risk judgment.
- **Suppress — with sign-off** (accepted risk / false positive): a defer needs a
  tracking issue **and** a scoped `dependabot.yml` ignore (Phase 4) or a
  justified Trivy/CodeQL dismissal (a repo dismissal script), **never
  silently**, and never without a human sign-off recorded on the issue.

## Expert routing

| Category                                     | Agent      |
| -------------------------------------------- | ---------- |
| Is it actually exploitable? threat model     | `nyx`      |
| CI / Docker / base image / workflow deps     | `aaron`    |
| Code fixes, dep upgrades, lockfile overrides | `isabelle` |
| Bug root-cause behind a CodeQL finding       | `bert`     |

## Human gates (never auto)

Mirrors the playbook's "never auto" set: major version bumps, runtime deps,
Docker base images, engine bumps; any suppression / accepted-risk call; anything
touching prod IaC, secrets, or migrations (agents are deny-ruled from prod
migrations/deploys — that applies here too).

## Guardrails

- **No silent suppression.** A dismissed/ignored finding always leaves a tracked
  issue + rationale, and the operator sign-off is recorded as a **`risk-accepted`
  label** on that issue (auditable, greppable, closeout-mineable) — the label is
  the gate: no `risk-accepted`, no suppression. Maintenance Monster (or nyx)
  proposes; only the operator applies the label.
- **Validate the fix against the _right_ gate, bound to the fix commit.** Trivy
  image-scan runs on **push/dispatch, not PR** — a green PR does not prove a CVE
  fix. Dispatch `gh workflow run services-ci.yml --ref "$FIX_REF" -f
force_all=true` (never rely on the default-branch default when `--ref` is
  omitted), record the run's resolved head SHA, and accept the scan **only when
  that SHA matches the fix commit** — a mutable branch ref alone is not enough.
  Or `docker build` + `trivy` locally. (See the Trivy-push-only lesson.)
- **Idempotent + capped.** No duplicate PRs; a `max_concurrent_fix_prs` cap so a
  vuln wave doesn't become a PR storm; bounded fix attempts before escalation.
- **Scoped overrides only.** Bound both selector and target to the vulnerable
  range; unbounded overrides silently force future incompatible majors.

## Coordination & messaging

Reuses [agent-messaging.md](agent-messaging.md): on queuing a fix
PR it nudges `acme-mm`; on a bounce/escalation from MM it receives the nudge
back. Same `acme-*` namespace fence and validate-before-act discipline.

## Config sketch — `.claude/maintenance-monster.yml`

```yaml
repo: acme/app
session_name: acme-maintain # advertised in its own ledger (discovery)
ledger_issue: <new pinned issue, distinct from MM — created by mnt-setup.sh>
state_dir: logs/maintenance-monster
heartbeat_minutes: 30
stale_lock_minutes: 45 # continuous watchdog: own Monitor + heartbeat, mirrors MM
phase: read_only # Phase 1: watch + triage + report; no auto-PRs (raise to auto_drive later)
watch:
  dependabot_prs: { poll: 300 }
  dependabot_alerts: { poll: 900 }
  codeql_alerts: { poll: 900 }
  secret_scan: { on: push } # Secret Scan workflow_run
  trivy_main_red: { on: push } # push-only image scan (see guardrail)
  base_images: { poll: 86400 } # slow-moving; daily is plenty
auto_fix:
  [
    patch_dev,
    minor_dev,
    patch_ci,
    ci_action_major,
    grouped_patch,
    lockfile_cleanup,
    scoped_override,
  ]
expert_assist: [risky_major, docker_base, runtime_dep]
escalate:
  [
    breaking_major,
    engine_bump,
    prod_iac,
    secret,
    migration,
    product_risk_judgment,
  ]
unknown_disposition: escalate # fail-safe: anything unclassified escalates, never auto
routing: { security: nyx, ci: aaron, code: isabelle, rca: bert }
max_concurrent_fix_prs: 3
fix_attempts_max: 2
suppression: { signoff_label: risk-accepted } # operator-only; the gate for any dismissal
escalation: {
    slack_channel: "#eng-escalation",
    channel_id: C0XXXXXXXXX,
  } # shared with MM
messaging: # reuses merge-monster-messaging.md
  notify_mm: true # SendMessage acme-mm when a fix PR is queued
  mm_session_name: acme-mm # nudge target (also discoverable via MM's ledger)
  namespace_prefix: acme-
  inbound: accept # required crossSessionInbound value for the autonomous session
```

Pipeline state lives in **`mnt:*`** labels (`mnt:triaging`, `mnt:fix-queued`,
`mnt:escalated`, `risk-accepted`), created idempotently by `mnt-setup.sh`
alongside the ledger issue — the exact analogue of `mm-setup.sh`'s `mm:*` set.
In **Phase 1 (read-only)** the `auto_fix` / `expert_assist` classes are
_classified and reported_ but not driven; they gate what Phase 2 will auto-open.

## State / ledger

Its own pinned ledger issue (the baton), `logs/maintenance-monster/`
(`state.md`, `journal-YYYY-MM.{md,jsonl}`, `active`), heartbeat, and event
`Monitor` — the same shapes as `logs/merge-monster/`, so the closeout ceremony
can mine its journal too.

## Rollout

1. **Phase 0 + 1 — this PR.** The spec, the `/maintenance-monster` skill, the
   `mnt-*` scripts, the config, and the `mnt:*` labels + ledger setup. Phase 1
   behavior is **read-only**: watch + triage + **report** (ledger digests +
   escalations); no auto-PRs. Proves triage quality against real findings before
   it writes anything. Merged at the next session reset with the messaging PR.
2. **Phase 2 — auto-drive the safe classes** (patch/minor dev-deps, patch-group,
   scoped overrides) into `mm:ready` PRs, with the force_all Trivy validation.
   Flip `phase: auto_drive` in the config; no code change.
3. **Phase 3 — expert-assisted PRs** for risky majors / base images, plus the
   suppression-with-sign-off workflow.

## Resolved decisions

Settled with the operator (2026-08-15); baked into the config and guardrails
above.

1. **Dependabot ownership → sole owner.** MM's `dependabot.auto_merge` is
   **retired**; `acme-maintain` owns Dependabot end-to-end and hands
   `mm:ready` PRs to MM. Accepted trade-off: a coverage gap while maintenance is
   down (short, given the continuous watchdog).
2. **Escalation channel → shared.** Uses MM's `#eng-escalation`
   (`C0XXXXXXXXX`) — one place to watch.
3. **Suppression sign-off → `risk-accepted` label.** Operator-only label on the
   tracking issue is the gate for any dismissal; Maintenance/nyx proposes, the
   operator applies it.
4. **Cadence → continuous watchdog.** Always-on `acme-maintain` with its own
   persistent `Monitor` + heartbeat/baton, mirroring Merge Monster, rather than a
   scheduled sweep.

## Starting material

The repo's Dependabot triage playbook (the phase model), the Merge Monster
skill (as the orchestrator template), and the repo's existing advisory-audit,
base-image sync/prune, and scanner-dismissal scripts.
