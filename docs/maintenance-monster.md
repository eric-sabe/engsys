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
  silently**, and never without a human sign-off recorded on the issue. The
  one exception is a **standing false-positive policy**
  ([below](#standing-false-positive-policies)): for a code-scanning rule the
  operator has reviewed, the sign-off is the reviewed policy, not each alert.

## Standing false-positive policies

Some code-scanning rules re-open a fresh alert on every new PR that touches the
same harmless pattern, and each one blocks a merge until a human dismisses it.
Sign-off per alert is toil with no security value, but a blanket auto-dismiss is
unsafe: **a heuristic cannot prove that a rule has no true positives.** (A new
password field, hashed with a built-in hash into a differently named column,
would slip past a grep for "bcrypt".) So the sign-off moves from each alert to a
**reviewed standing policy**, and the judgment about each alert stays with the
monster, on the code:

| Step | Who | What it proves |
| --- | --- | --- |
| Policy review | the operator, once, as a reviewed change to the config | the rule is a false positive *for these shapes*, and which structural facts must hold for that to stay true |
| `mnt-fp-candidates.sh` | script, read-only | the tripwire holds at the alert's commit **and** at the default branch |
| Per-alert judgment | the monster | this alert's code clearly matches a `known_fp_shapes` entry |
| `mnt-fp-dismiss.sh` | script, the only mutating path | re-checks the above for that one alert, then dismisses with an auditable comment |

### The policy

```yaml
fp_policies:
  - id: password-hash-on-passwordless # stable slug, [a-z0-9-]
    rule: js/insufficient-password-hash # exact code-scanning rule id
    tool: CodeQL # optional; default any tool
    approved_by: "<who> <yyyy-mm-dd> <link to the reviewed change that added this policy>" # REQUIRED
    known_fp_shapes: # prose the monster checks each alert's code against (at least one)
      - HMAC-SHA256 signing/verification of a canonical request string with a shared secret
      - hashing a high-entropy generated secret (API key, token) for lookup
      - test, fixture or seed code
    paths: # optional: the alert's file must match include and not match exclude
      include: ["**/*.ts"]
      exclude: []
    tripwire: # ALL must hold at the alert's commit AND at the default branch
      - { type: absent_regex, glob: "**/schema.prisma", pattern: "password", ignore_case: true }
      - { type: absent_dependency, manifests: "**/package.json", names: [bcrypt, bcryptjs, argon2, scrypt, pbkdf2] }
      - { type: absent_path, glob: "**/password*.ts" }
```

- **Tripwire types** are exactly `absent_regex` (no file matching `glob` contains
  a match for the JavaScript regular expression `pattern`, tested with the `m`
  flag; `ignore_case` is optional), `absent_dependency` (no `names` entry in `dependencies`,
  `devDependencies` or `optionalDependencies` of any `package.json` matching
  `manifests`) and `absent_path` (no file matches `glob`). A `glob` matches the
  full repo-relative path: `*` and `?` stay inside one directory, `**/` spans
  any number of directories, including none. A glob that matches no files at
  all makes an `absent_*` check pass; `files_scanned` in the JSON output shows
  how many files each check actually looked at.
- **Invalid policies are errors, never candidates.** A policy is invalid, and
  `mnt-fp-candidates.sh` reports `ERROR` and produces no `CANDIDATE` for it, when
  the `id` is not a slug, `approved_by` is missing or blank, `known_fp_shapes` is
  empty, `approved_by` still holds a template placeholder (any `<…>` token, such as
  `<who>` or `<link …>`), `tripwire` is empty or has an unknown `type`, a check lacks a required
  key or a regex does not compile, a key is unknown (a typo such as `tripwires:`
  must not silently disable a check), or two policies share an `id`. The other
  policies in the file are unaffected.
- **Reading the config.** The rest of the monster's scripts take flags and never
  read YAML. `fp_policies` needs nested lists, so `scripts/mnt-fp.mjs` (zero
  dependencies) reads exactly that block plus the top-level `default_branch` and
  `state_dir`. It understands block and flow collections, quoted and plain
  scalars and comments; it rejects anchors, tags and block scalars, so a policy
  that uses them is invalid instead of misread. Quote a shape that contains
  `": "`.

### Where alerts are read: the default branch and every open PR

The toil this removes is on **pull requests**: the ruleset's code-scanning gate
blocks a PR on a new high-severity alert in that PR's own analysis, so by the time
an alert reaches the default branch, the PR was already blocked and someone
already dismissed it by hand. `mnt-fp-candidates.sh` therefore reads the default
branch's open alerts and, for each open PR (from `gh pr list --state open`, widened
until the list is no longer full), that PR's alerts at `ref=refs/pull/<n>/merge`,
falling back to `refs/pull/<n>/head` when the merge ref is 404 or empty. Results
are deduped by alert number; an alert that shows up on several refs keeps each
instance, and the tripwire must hold at **every** instance's commit. `--prs
all|none|<n,n>` (default `all`) chooses which PRs to scan.

An instance commit missing locally is fetched with `git fetch origin <sha>`, then,
for a PR instance, from `refs/pull/<n>/merge` / `/head` into scratch refs under
`refs/mnt-fp/`. `mnt-fp-dismiss.sh` re-fetches the same way when the alert's
instance is on a PR ref. It re-checks the alert GitHub returns for that number
(its `most_recent_instance`), whereas the candidate list checked every instance it
found, so the list is the stricter of the two. Scanning N PRs costs one to two `gh`
calls each.

### The two gates, and why both

A tripwire is checked at the **alert's own commit** and at the **default
branch**. Checking only the default branch would wrongly clear a PR that
introduces the very thing the policy assumes absent, on its own branch, while
`main` is still clean. Checking only the alert's commit would let a policy keep
firing after the assumption broke on `main`. Both must hold, for every check.

The candidates script fetches the default branch explicitly
(`git fetch origin "+refs/heads/$B:refs/remotes/origin/$B"`) and **fails closed
if that fetch fails**: a stale `origin/main` is never read. It fetches an alert's
commit if the clone lacks it, runs child `git` with the repo-location variables
(`GIT_DIR` and friends) removed so a hook's environment cannot redirect it, and
treats any `gh` or `git` error as `ERROR`. The scope of an error matches what it
can affect. A problem shared by every alert of a policy fails the **whole policy
closed** (no `CANDIDATE` for it): an invalid policy, a failed fetch of the default
branch, a default-branch tripwire that cannot be evaluated, or an unreadable
default-branch alert list. A problem with **one alert** (`ERROR alert <n>: …`, e.g. a
PR that was force-pushed so its commit is gone) or **one PR** (`ERROR pr <n>: …`, its
alerts could not be listed) is reported for that alert or PR only, and the others
still evaluate.

### Outputs

`mnt-fp-candidates.sh --repo owner/name --config FILE [--policy ID] [--json]`,
one line per alert:

```
CANDIDATE <alert#> <policy> <path>:<line> <sha> [pr=<n>]
TRIPWIRE_FAILED <alert#> <policy> <check> <commit|main> <detail> [pr=<n>]
OUT_OF_SCOPE <alert#> <policy> <path> <why> [pr=<n>]
ERROR <reason>
```

`pr=<n>` is appended when the alert instance is on that pull request. Flags beyond
those above: `--prs all|none|<n,n>` (default `all`), `--repo-dir DIR` (the local
clone; default the current directory) and `--default-branch NAME`.

`--json` prints one array instead, each element carrying `status`, `alert`,
`policy`, `html_url`, `severity`, `pr`, `path`, `line`, `sha`, every `instances[]`
and the per-check `tripwire` results (`type`, `index`, `where`, `sha`, `pr`, `ok`,
`detail`).

`mnt-fp-dismiss.sh --repo R --config FILE --alert N --policy ID --shape "…"
--evidence "…"` first re-runs that alert's evaluation (the tripwire may have
tripped since the list was made). It dismisses only if the result is still a
`CANDIDATE` **and** `--shape` equals one of the policy's `known_fp_shapes`
verbatim. The PATCH sets `state=dismissed`, `dismissed_reason="false positive"`
and `dismissed_comment` to `fp-policy <id>: <shape> — <evidence>`, cut to GitHub's
280-character limit. It appends a line to `<state_dir>/fp-dispositions.jsonl`
(checked writable before the PATCH). It **refuses**, with a non-zero exit and no
PATCH, when the tripwire now fails, the alert is out of scope or already closed,
the policy is invalid, the shape does not match, or a `git`/`gh` call fails.

### What the monster does with it

On each CodeQL tick it runs the candidates script. For a `CANDIDATE` it reads the
flagged code at the alert's commit and dismisses **only** if the code clearly
matches a known shape; unsure means the ordinary propose-with-`risk-accepted`
path. On `TRIPWIRE_FAILED` it escalates once and dismisses nothing under that
policy until the operator either retires the policy (the rule now has true
positives) or lands a reviewed fix to the check. On `ERROR` it dismisses nothing
that tick. The weekly digest lists every policy dismissal from the journal for
audit. The monster never edits a policy: `approved_by` is the operator's
standing sign-off, and only a reviewed change may add or alter one.

### Permissions and approval

Dismissing needs the GitHub App permission **Code scanning alerts: Read and
write** (`security_events: write`), an *optional* permission required only for
`fp_policies` dismissals; the read-only lanes need only `security_events: read`.
See [the fleet identity kit](../core/fleet/identity/README.md) for adding it to
the App and to `GH_APP_REQUIRED_PERMS`. On HTTP 403 the dismiss script says so.

`mnt-fp-candidates.sh` never mutates, so the plugin's PreToolUse hook and the
copy-mode settings template auto-approve it, like the other bookkeeping scripts.
`mnt-fp-dismiss.sh` mutates, so it is **not** auto-approved: attended sessions
prompt for it.

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
migrations/deploys — that applies here too). Editing an `fp_policies` entry is
also operator-only: the monster never changes a policy.

An operator decision on any of these is a GitHub action verified by `gate-check`
([gate-check.md](gate-check.md)): `/approve <gate-id>` on the tracking issue for
a risk acceptance, a review approval for an expert-assisted fix PR. The
`risk-accepted` label is the record of a verified approval; a label, chat
message, or Slack reply alone approves nothing.

## Guardrails

- **No silent suppression.** A dismissed/ignored finding always leaves a tracked
  issue + rationale, and the operator sign-off is recorded as a **`risk-accepted`
  label** on that issue (auditable, greppable, closeout-mineable) — the label is
  the gate: no `risk-accepted`, no suppression. Maintenance Monster (or nyx)
  proposes; only the operator applies the label. The exception is an alert
  covered by an approved `fp_policies` entry, dismissed through
  `mnt-fp-dismiss.sh`; that leaves the dismissal comment, a journal line and a
  weekly-digest entry instead of an issue.
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
# fp_policies: optional standing false-positive policies, see below
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
