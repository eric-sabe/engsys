# Running an always-on fleet with engsys

This is the human guide to the **engsys fleet kit** (`core/fleet/`): a small set of host scripts that stand
up, pin, sync, restart and supervise a fleet of long-running Claude Code sessions on one always-on
machine. It covers the decisions you make once (install mode, one repo or several, where your config
lives, identity), setting up a host, and the day-2 loop (upgrade, roll back, change models).

Examples use the placeholder organization `acme`: a fleet slug `acme`, a bot `acme-fleet[bot]`, a
product repo `owner/repo` and sessions named `acme-mm`, `acme-build`, and so on. Replace them with yours.

If you want an agent to do the mechanical parts for you, run `/engsys:fleet-bootstrap` (see
[`core/commands/fleet-bootstrap.md`](../core/commands/fleet-bootstrap.md)). It gathers the facts, runs
`engsys fleet init`, and stops at every step that needs a human (creating the GitHub App, generating
keys, changing org settings).

**Contents**

1. [What a fleet is](#1-what-a-fleet-is)
2. [Choosing an install mode: copy or plugin](#2-choosing-an-install-mode-copy-or-plugin)
3. [One repo or several](#3-one-repo-or-several)
4. [The instance-layer pattern](#4-the-instance-layer-pattern)
5. [Identity](#5-identity)
6. [Host setup](#6-host-setup)
7. [Day-2 operations](#7-day-2-operations)
8. [Models](#8-models)
9. [Verified plugin mechanics](#9-verified-plugin-mechanics)
10. [Troubleshooting](#10-troubleshooting)
11. [Reference](#11-reference)

---

## 1. What a fleet is

A fleet is a set of named agent sessions (`HARNESS=claude` by default, or `HARNESS=copilot` for GitHub Copilot CLI / `HARNESS=antigravity` for interactive Antigravity workspaces; see [`docs/specs/multi-harness-support.md`](specs/multi-harness-support.md)), each in its own tmux window, running on one machine
that stays on. Four kinds of thing make it up.

**Monsters** are the unattended, ledger-bearing roles. Each holds a "baton" for one job and reports
through a **ledger**, a pinned GitHub issue whose body carries a `last: <ISO8601Z> — status: <text>`
heartbeat line. Closing the ledger issue is the kill switch.

| Monster | Session | Job | Skill |
|---|---|---|---|
| Merge Monster | `<ns>-mm` | owns the merge baton: orders the queue, pilots PRs through ready, CI and merge | [`merge-monster`](../core/skills/merge-monster/SKILL.md), design in [`merge-monster.md`](merge-monster.md) |
| Maintenance Monster | `<ns>-maintain` | owns the security and dependency baton: Dependabot, alerts, scans, triage, safe fixes | [`maintenance-monster`](../core/skills/maintenance-monster/SKILL.md), design in [`maintenance-monster.md`](maintenance-monster.md) |
| Resource Broker (optional) | `<ns>-broker` | arbitrates a pool of scarce host resources (for example local E2E environments) among sessions: grants slots, reaps stale grants, nudges waiters, runs host-maintenance windows | [`resource-broker`](../core/skills/resource-broker/SKILL.md), on the [`durable-lease`](../core/skills/durable-lease/SKILL.md) primitive |
| any further baton-holder | `<ns>-<role>` | its own skill and ledger, same contract | yours |

**Interactive roles** are attended sessions a person steers, usually through remote control from
another device: for example `<ns>-build`, `<ns>-investigate`, `<ns>-design`. They work in git worktrees
next to the checkout, run in `--permission-mode auto`, and have no heartbeat.

**The supervisor** is a launchd job that runs every 5 minutes with **no LLM in the restart path**. It
relaunches a monster that crashed or has finished a requested rotation, never touches a live one, and
never touches one whose ledger is closed. The decision table is in the
[`agent-sessions` skill](../core/skills/agent-sessions/SKILL.md#autonomous-rotation-fleet-supervisor).
It only manages the sessions listed in `fleet/supervisor.conf.tmpl`; that list is what the kit means
by "monsters".

**Who watches the supervisor.** It pages for everything else, so it can't report its own absence: on
macOS an unanswered privacy prompt can stop launchd from starting any of the fleet's jobs while the
monsters, which run in tmux, keep heartbeating (ff-engsys-fleet#48). Every `fleet supervise` run
therefore first writes `.fleet/supervisor.tick`, and the maintenance monster checks it on every tick
(`mnt-supervisor-watch.sh`, run by `mnt-tick.sh`). When the stamp is older than 3 x the job's
`StartInterval` (15 minutes at the default 300 s; `supervisor_stale_intervals` or
`supervisor_stale_minutes` in the maintenance monster's config overrides it), it sends one
`fleet notify --level alert --incident fleet-supervisor-stalled` with the recovery steps (check
`launchctl print gui/$UID/com.<org>.fleet.fleet-supervisor`, answer the prompts, `launchctl kickstart -k`)
and resolves it once the supervisor ticks again. A host where the supervisor job isn't installed, or
was booted out with `fleet install-jobs --unload`, is never alerted on. This check lives on the same host,
so a host that is asleep or down needs a watcher from outside as well (the instance's own heartbeat watch
on its status issue, for example).

**Ledgers** are the fleet's shared memory and its control surface. Everything a monster knows, it
reconciles from live GitHub on startup, so a session can be killed and relaunched at any time with no
local state to migrate. That property is what makes rotation, upgrades and rollbacks cheap.

**Shared host resources** (a local test database, a port range, a GPU) are taken through a **durable
lease** (`core/lib/lease/`): a file-backed lease with heartbeat expiry and a fencing token, plus a resource
**pool** of slots whose provisioning is your command. Gates, agents and the broker share one store (by
default `<main checkout>/logs/leases`, so every worktree of the repo sees it). `engsys fleet init
--resource-broker` adds the broker monster and a starter pool file. Details: the
[`durable-lease`](../core/skills/durable-lease/SKILL.md) and
[`resource-broker`](../core/skills/resource-broker/SKILL.md) skills.

Messaging between sessions is scoped to the OS user, not the project, so every session name starts
with the fleet **namespace** (`acme-`). Peers only trust names under their own prefix, and monsters
validate every message against live GitHub before acting on it. Details:
[`agent-messaging.md`](agent-messaging.md).

### What the kit adds

The `agent-sessions` skill already owns the launcher and the supervisor. The fleet kit is the layer that
runs them for you from an **instance repo** (section 4):

| Command | What it does |
|---|---|
| `fleet status` | pins vs host, and which sessions are behind |
| `fleet status --federation [--json]` | every fleet (operator, enabled, status issue, fleet and broker heartbeat ages, relay) and every baton (home, standby, live holder, expiry, `!` when the holder's fleet is not the home). Read-only; a row that cannot be read shows `?` and a note |
| `fleet xray [--role <r>\|--session <s>] [--timeline] [--diagnose] [--watch] [--json]` | 10-subsystem runtime inspection, live 9-hook synthetic self-test, session/monster deep-dive, chronological behavior timeline, and automated root-cause diagnosis & remediation playbook |
| `fleet pin` | release your instance plugin and open the pin PR (section 7) |
| `fleet sync` | make the host match the pins: checkouts and plugins (including `HARNESS_FALLBACK` plugin caches). Touches no running session; in per-session mode a running session's own dir is left to its restart (§ 7, What sync does) |
| `fleet restart` | cycle sessions onto what is installed, when you choose |
| `fleet launch [<name>]` | render templates and start missing sessions |
| `fleet supervise` | one supervisor tick (what the launchd job runs) |
| `fleet verify` | check that the plugin files guarding the merge and maintain monsters match the pinned engsys release (section 7) |
| `fleet config-dir init` | create and seed the fleet's own Claude config dir, `FLEET_CLAUDE_CONFIG_DIR` (section 6.1) |
| `fleet install-jobs` | render and (re)load the launchd jobs |
| `fleet msg route\|send\|inbox\|read` | route a nudge (SendMessage or fleet-msg); send a cross-fleet message; print a session's undelivered ones; read one (multi-fleet, § 6.10) |
| `fleet relay` | one poll of the cross-fleet relay (what the `fleet-relay` job runs) |
| `fleet init` | scaffold a new instance repo (`engsys fleet init`) |

Sync and restart are deliberately separate. Sync changes what is *installed*; running sessions keep
what they loaded. You restart when it is convenient.

---

## 2. Choosing an install mode: copy or plugin

engsys reaches a project in two ways, from the same sources.

| | **Copy mode** (`engsys install --into .`) | **Plugin mode** (Claude Code marketplace) |
|---|---|---|
| What lands in the repo | `.claude/` files, a lockfile, a generated `CLAUDE.md` | nothing; a few lines in `.claude/settings.json` |
| Version pin | `engsys.version` in `engsys.config.yaml` | a git tag in `extraKnownMarketplaces.<name>.source.ref` |
| Upgrade | `engsys update` per project, then review the diff | change one ref; `fleet sync` reinstalls |
| `<engsys-root>` in engsys content | `.claude/` in that project | the plugin's cache directory, per version |
| Names | bare (`/merge-monster`) | namespaced (`/engsys:merge-monster`, agents `engsys:<agent>`) |
| Project facts | rendered into `CLAUDE.md` | the project's own `CLAUDE.md`; conventions injected at session start |
| Multi-provider worker layer | supported | not yet |
| Fleet kit (`fleet sync`, pins) | not supported; run the launcher and supervisor by hand | designed for it |

**Recommendation: use plugin mode for a fleet.** Reasons that matter for an unattended machine:

- **One place to pin, one place to change.** Every session opened in the pin repo (human or fleet)
  reads the same refs, and the host follows them. There is no per-repo copy to drift.
- **Upgrades are a reviewed one-line change.** A ref bump is a PR you can canary (section 7) and roll
  back by reverting.
- **Running sessions survive an upgrade.** The plugin cache is keyed by version and old directories stay
  on disk, so sessions keep working until you restart them (section 9).
- **An instance plugin composes.** Your context, per-repo monster configs and org skills ship as a second
  plugin next to engsys, pinned the same way (section 4).

Copy mode remains right for a single repo without a fleet, and whenever you need the multi-provider
worker layer. If you run a copy-mode fleet anyway, the launcher and supervisor still work from
`.claude/skills/agent-sessions/scripts/`; follow the manual setup in the
[`agent-sessions` skill](../core/skills/agent-sessions/SKILL.md) and note that the kit's `fleet sync` and
pin commands do not apply to it.

One rule holds in both modes: **host scripts run from the pinned engsys checkout (`ENGSYS_DIR`), never
from the plugin cache.** The cache path changes with every version, and a launchd job cannot follow it.
The kit's launchd templates, its supervisor and its launcher all point into `ENGSYS_DIR`.

For the plugin settings block and the plugin-mode conventions (hooks, the `<engsys-root>` convention,
auto-approval of engsys's own bookkeeping scripts), see "Option C" in the [README](../README.md) and
[`architecture.md`](architecture.md) section 10.

---

## 3. One repo or several

**A fleet is not tied to one repo.** One fleet, one tmux session and one supervisor can serve several
repos. Three pieces decide how.

### Where sessions run

Every roster line names a `<workdir>`. An empty workdir means the launcher's working directory, which the
kit sets to `PIN_DIR` (the pin repo's checkout). For a multi-repo fleet give every session an explicit
absolute workdir, one per target repo:

```
# <name>|<workdir>|<prompt>|<extra flags>[|<env file>]
acme-mm-api|~/git/api|/engsys:merge-monster fleet config dir: __CONFIG_DIR_API__|--remote-control --dangerously-skip-permissions
acme-mm-web|~/git/web|/engsys:merge-monster fleet config dir: __CONFIG_DIR_WEB__|--remote-control --dangerously-skip-permissions
acme-build|||--add-dir __WORKTREES_DIR__ --remote-control --permission-mode auto
```

In plugin mode the monster commands are namespaced (`/engsys:merge-monster`); in copy mode they are bare
(`/merge-monster`). Names must start with the namespace (`acme-`); beyond that, you choose. A repo that needs its own merge
orchestrator gets its own monster session and its own ledger.

### Per-repo monster configs

Each monster reads `.claude/<monster>.yml` from the repo it runs in, and an in-repo config always wins.
When a repo does not carry one, the monster reads it from the **fleet config dir** named in its session
context. In a multi-repo fleet that directory is per repo, and it normally lives in your instance
plugin:

```
<instance>/plugin/repos/<owner>/<repo>/merge-monster.yml
<instance>/plugin/repos/<owner>/<repo>/maintenance-monster.yml
<instance>/plugin/repos/<owner>/<repo>/context.md
```

The scaffold's `fleet-context` SessionStart hook injects `fleet config dir: <path>` and the repo's
`context.md` for sessions started in that repo; you can also pass the directory in the roster prompt, as
above (`/engsys:merge-monster fleet config dir: /abs/path`). Start each config from the skill's
`config.example.yml`; `mm-setup.sh` and `mnt-setup.sh` print the `repo:` and `ledger_issue:` lines to paste.

### The supervisor's view

The supervisor conf lists one line per ledger-bearing session. Set a default `REPO=owner/name` and, for
a multi-repo fleet, give each line a fourth field:

```
REPO=owner/repo
# <session>|<ledger issue>|<stale minutes>[|<owner/name>[|<marker>]]
acme-mm-api|41|60|owner/api
acme-mm-web|17|60|owner/web
acme-maintain|42|60|owner/api
```

An optional fifth field names the block the heartbeat is read from: only a `last:` line between
`<!-- <marker> -->` and `<!-- /<marker> -->` counts. It is for an issue that carries several
heartbeats, such as a fleet status issue (§ 6.11). You rarely write it yourself: in multi-fleet mode
`fleet supervise` adds it to the resource broker's line.

A sixth field, `merge` or `maintain`, marks a singleton monster (`acme-mm|7|60|||merge`; leave the
fourth and fifth empty to skip them). `fleet supervise` adds it to every merge and maintain line from
the roster, so you never write it either. For those sessions the supervisor reads the role's holder
from the github lease before any relaunch (`core/lib/lease/baton.mjs supervise`, or `BATON_CMD=` in the
conf): it relaunches only when this fleet is the role's home and nobody holds a live baton, waits while
any session holds one (another fleet's, or this session's own earlier launch), and treats a lease or
registry read it cannot complete as a wait plus one `fleet notify --level alert --incident
baton-read-<name>`, resolved on the next clean read. It also relaunches such a session when the old
home has handed the role over (a `handover` heartbeat, process gone) and when the session sits idle at
its prompt with a stale heartbeat and a forfeited baton. Design: [`multi-fleet.md` § 10 P1](multi-fleet.md#p1-real-batons).

When Claude Code's login on the host stops working, every session the supervisor relaunches answers
its first prompt with `Login expired · Please run /login` and waits. The supervisor reads that line in
the panes and holds every relaunch until the login works again; it kills nothing in the meantime. You
get one `fleet notify --level action --incident claude-auth-expired` asking you to run `/login` in any
session (or `cd "$(mktemp -d)" && claude /login` in a terminal), the status issue's heartbeat and `fleet status` show
`auth: expired since <time>`, and the first tick after the login works resolves the alert and
relaunches each held session once. Details: the agent-sessions skill and the header of
`fleet-supervisor.sh` (engsys#103).

A relaunch that fails is escalated once on the session's ledger and alerted once with `fleet notify --level
alert --incident launch-failed-<name>`, carrying the launcher's error line. That includes a launch whose keys
were sent but whose session never started (engsys#236): the launcher types only `. <launch file>` into the new
window (the full command is in a one-shot 0600 file in `<instance>/.fleet/launch/`), then waits up to
`LAUNCH_START_TIMEOUT_SEC` seconds (default 30; 0 = don't wait) for the file to be gone and the pane to leave its
shell. If it doesn't, the launcher says `launch did not start`, closes the window and exits non-zero, and the
supervisor logs `RELAUNCH FAILED (…)` instead of `relaunched`. The alert is resolved by the first successful
relaunch, or as soon as the session is seen running however it was started. Set `LAUNCH_START_TIMEOUT_SEC` in the
environment of `fleet launch` (and of the supervisor's job, which launches through it).

When a seat hits its usage or rate limit (`You've hit your limit · resets …`, `Usage limit reached`), the
supervisor does not move any supervised session to another harness: the fleet is Claude-only, whatever
`HARNESS_FALLBACK` says. It posts one `fleet notify --level alert --incident seat-limit`, resolved once no
supervised pane shows the limit, and every relaunch stays on the primary harness. The supervisor also
holds a limited session and resumes it on its own: it reads the reset time from the limit line
(`resets Oct 20, 9pm (America/New_York)`), records `logs/fleet-supervisor/<session>.limit-hold`, and meanwhile
raises no stale-heartbeat comment and relaunches nothing for that session. After the reset plus
`LIMIT_RESUME_MARGIN_SEC` (default 120) it re-prompts an idle pane, or relaunches one that exited, then posts one
info notice (the alert's resolve). A session that hits the limit again within 30 minutes of a resume backs off
(10 minutes, doubling, up to 4 hours). If the reset time cannot be read, or `LIMIT_RESUME=off`, the behaviour is
the alert only. Only Claude Code's own
limit line, as the last message of a pane the fleet launched (`fleet launch` and the supervisor record
each supervised session's pane), counts: text in tool output or in
another pane never does. (`HARNESS_FALLBACK` only makes `fleet sync` pre-stage those harnesses' plugin
caches; starting an interactive session on one is an operator's decision at the terminal.)

### Where the pins live

**One place: the pin repo's `.claude/settings.json`**, at `extraKnownMarketplaces.<name>.source.ref`
(`engsys`, and your own instance marketplace if you have one). `PIN_REPO` / `PIN_DIR` in `fleet.conf`
name it. Pick the repo your team is most often in; every session opened there reads the pins, and the
fleet host follows them.

Other repos in the fleet do not need to pin anything for the *fleet's* sake. `fleet sync` installs the
plugins at user scope, so they apply to every session the fleet user runs, whatever its workdir. Those
repos may pin the same marketplaces for the benefit of humans' own machines, but keep the refs in
step with the pin repo, or you will have two versions in play.

---

## 4. The instance-layer pattern

engsys stays generic. Everything specific to your organization lives in an **instance repo** that you
own, and optionally an **instance plugin** inside it. The split:

| Layer | Owns | Changes by |
|---|---|---|
| **engsys core** | machinery: host scripts (`core/fleet`), the launcher and supervisor, identity, monster skills, safety libraries, gates | engsys releases, adopted by tag pin |
| **Instance repo** | **config**: `fleet/fleet.conf`, roster, env templates, supervisor conf, launchd overrides | a PR to the instance repo, released with `fleet pin` |
| **Instance plugin** (optional, in the same repo) | **context** and **org skills**: the org's standing context, per-repo configs, org-specific skills and hooks | the same PR and release |
| **Product repos** | product code, tests, the product's own `CLAUDE.md`, and the pins in `.claude/settings.json` | product PRs |

### What an instance looks like

```
<instance>/
  fleet/fleet.conf                 # KEY=VALUE; ~/.config/<FLEET_ORG>/fleet.local.conf overrides per machine
  fleet/roster.tmpl                # the launcher roster; the optional 5th field names a per-session env
  fleet/env/<lane>.env.tmpl        # each rendered to .fleet/env/<lane>.env; `session` is the default lane
  fleet/supervisor.conf.tmpl       # optional; enables the supervisor job and defines the monsters
  jobs/launchd/*.plist.tmpl        # optional extra or overriding jobs (a same-named file overrides the default)
  scripts/fleet                    # thin shim: exec "$ENGSYS_DIR/core/fleet/bin/fleet" --instance <root> "$@"
  .claude-plugin/marketplace.json  # optional instance plugin
  plugin/…                         #   context, repos/<owner>/<repo>/ configs, org skills
  docs/TRANSITION.md               # ownership register: who holds which seat, key, secret
  .fleet/                          # machine-local rendered state (gitignored)
```

`engsys fleet init` creates this (section 6). Templates use `__NAME__` placeholders, resolved from
`fleet.conf` (see the reference in section 11).

### What goes where

- **Fleet behavior**, meaning the roster, models, permission modes, which monsters exist, their stale
  thresholds, launchd jobs, the identity wiring, belongs in **`fleet/`** in the instance repo.
- **What sessions know**, meaning your org's standing context, per-repo monster configs, org-specific
  skills, belongs in the **instance plugin**.
- **What is true of every project** belongs upstream in engsys. If you find yourself copying engsys
  behavior into your instance, generalize it and send it upstream instead.
- **Product code and product docs** stay in product repos.

### Never change fleet behavior inside a product repo

The product repo is what the agents *edit*. If a PR to it can alter the roster, a model pin, a permission
mode, or a monster's config, then an unattended session can change how the fleet behaves through the
same PR path it uses for ordinary work, without the review and canary that fleet changes get. So:

- The product repo holds exactly one fleet-related thing: the **pin refs** in `.claude/settings.json`,
  and the pin PR is verified to change *only* those refs.
- Every behavior change goes through the instance repo, is released as a tag (`fleet pin`), and reaches
  sessions only when someone restarts them.
- An in-repo `.claude/<monster>.yml` does win over the fleet config dir. Use that for genuinely per-repo
  policy the repo's own reviewers should own (a merge method, a list of conflict-prone paths), never for
  fleet-wide behavior.

---

## 5. Identity

A fleet should not run on a person's login. Two identities cover it.

### GitHub: a GitHub App bot

The fleet acts as a **GitHub App** installation (for example `acme-fleet[bot]`), so that no personal
credential sits in the automation path, agent commits and merges are attributable to the bot, and
handing the fleet to someone else is a membership change rather than an account transfer.

**Env-scoped, never global.** The bot identity exists only inside the fleet's own processes:

- git reads config from `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` at the highest
  precedence. The kit puts the App credential helper and the bot's author name and email there.
- `gh` is a shim on `PATH` for fleet sessions only; it mints a short-lived installation token per call.
- Nothing is written to `~/.gitconfig`, the Keychain or anyone's `gh auth login`. A person's own git and
  `gh` on the same account behave exactly as before, outside fleet processes.
- **No operator's personal GitHub credential may exist on a fleet host or in a fleet session** (no
  operator `gh auth login`, no operator PAT in any env file). Operator approvals happen on GitHub and
  `gate-check` excludes only the identity it runs as, so a second credential within an agent's reach
  could approve as that operator undetected ([gate-check.md](gate-check.md#configuration-and-permissions)).

Set `GH_APP_ENV` in `fleet.conf` to the path of the machine-local App env file. Set = the identity kit is
on: `fleet launch` appends the git identity lines to **every** rendered env file, the host scripts use the
shim, and `fleet install-jobs` installs the 30-minute `gh-app-login` health job. Unset = the machine's
own `gh` and git identity is used unchanged.

One thing the kit does **not** do for you: a session's `gh` reaches the shim only if the shim directory is
first on that session's `PATH`, and a pre-existing tmux server does not inherit the launcher's exports. Put
this in `fleet/env/session.env.tmpl` (and let any other lane's env source it):

```sh
unset GH_TOKEN GITHUB_TOKEN     # never inherit a person's token from the launching shell
PATH="__ENGSYS_DIR__/core/fleet/identity/bin:$PATH"
```

`fleet launch` itself appends the env-scoped git identity and `GH_APP_ENV_FILE` to every rendered env file.

The step-by-step (creating the App, the permission table, the two "Projects" rows, the env file, key
rotation, `--check`) is in
[`core/fleet/identity/README.md`](../core/fleet/identity/README.md). Do not duplicate it; two points are
worth repeating here because they cost hours when missed:

- **The App permissions page has two "Projects" rows.** Only the one under **Organization permissions**
  covers org ProjectV2 boards. The repository-level row is for legacy repo boards. The wrong one leaves
  every org board invisible to the bot (`gh project list` prints "No projects found").
- **Permission changes must be accepted** on the installation (org **Settings, GitHub Apps, Installed
  GitHub Apps**, then **Review request**). Until then nothing changes. Verify with
  `GH_APP_ENV_FILE=<env file> node core/fleet/identity/gh-app-token.mjs --check` (exit 3 means the token
  works but permissions are short).

### Cloud: an optional service principal

If sessions call a cloud API, give the fleet its own machine identity too, never an operator's
interactive login. For Azure, the pack ships `az-sp-login.sh`: a **service principal with a certificate
credential** and an isolated `AZURE_CONFIG_DIR`, run as a launchd job and as a roster `PREFLIGHT=`. It is
documented in
[`stacks/cloud/azure/fleet/README.md`](../stacks/cloud/azure/fleet/README.md). SDK-based tools do not
need the CLI login at all: they read `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_CLIENT_CERTIFICATE_PATH` from the environment, which you provide through the session env template.
Grant the principal least-privilege roles (read plus the specific inference or pull roles a lane needs).

### Credentials are re-issued, never copied

A new host never receives a copy of the old host's keys. The person setting it up generates a **new**
GitHub App private key and a **new** service-principal certificate (and any other tool credential, such as
a review CLI's API key), then revokes the old host's once the new host is verified. Nothing secret moves
between machines and nothing belongs to a predecessor. Record each credential's *name and creator*
(never its value) in `docs/TRANSITION.md`, so a handoff has a checklist.

### Keep a reviewer app installed where a CLI depends on it

Some review CLIs authenticate through a GitHub App installed on your org even when cloud reviews are
switched off or the App is suspended. Removing that App can break the CLI with an "invalid organization"
style error. If your pre-merge review command (`REVIEW_CMD`, or your own gate) depends on such an app,
leave it installed, suspended if you like, and treat it as required until proven otherwise.

---

## 6. Host setup

This is the generic path from a bare Mac to a running fleet. Budget two to three hours. Do not skip the
checks. Linux with systemd is a follow-up: the scripts are bash, but `fleet install-jobs` renders launchd
jobs only.

### 6.1 Dedicated user or shared account

| | **A. Dedicated macOS user (recommended)** | **B. Your own account** |
|---|---|---|
| Keychain, Claude login, `gh`, `az`, git config | the fleet's own | yours; the fleet stays out of them |
| Handoff | hand over the macOS account | redo setup for the next person |
| Cost | the fleet user must stay logged in | more moving parts; one login per account for tools that keep one |

Either way, the fleet never writes global git config and never touches your `gh` login. The only real
overlap is host ports and Docker if your local test stack uses them.

For **B**, give the fleet its own Claude Code config directory, so its login (the fleet's seat), user
settings and plugins stay separate from yours. Your own user-scope plugins load into every Claude Code
session that reads `~/.claude`, fleet sessions included, and their hooks run there, so `fleet verify`
reports them as a mismatch until the fleet has its own directory (or you allow them, below).

**One-time setup of a separate Claude config dir:**

1. Create and seed it: `fleet config-dir init --dir ~/.config/acme/claude`. It makes the directory
   (mode 700) and writes a `settings.json` with only the keys unattended sessions need, copied from your
   `~/.claude/settings.json`: `skipDangerousModePermissionPrompt`, `skipAutoPermissionPrompt`,
   `effortLevel` and the `env` key `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, plus `hasCompletedOnboarding`
   in its `.claude.json`. It also always writes `syncClaudeAiSkills: false` and `syncClaudeAiPlugins: false`,
   so the first login doesn't sync the account's claude.ai skills and plugins into this directory (they
   would show up as user-scope items in `fleet verify` and cost prompt tokens every turn). Re-running
   `init` on an existing directory, or `fleet sync`, adds just those two keys to its `settings.json` if
   they are missing, or sets them to `false` if they were `true`, and leaves every other key alone; `~/.claude` is never touched. No plugins, hooks, MCP servers, permissions, models or `autoMode` are copied.
   Without these a relaunched monster can stop at a first-run or permission dialog. The monsters run with
   `--dangerously-skip-permissions`, so auto-mode classifier config doesn't apply to them; if the fleet's
   interactive sessions ever need one, add a fleet-specific `autoMode` to `<dir>/settings.json` by hand.
2. Log in with the fleet's seat: `CLAUDE_CONFIG_DIR=~/.config/acme/claude claude`, then `/login` and
   `/exit`. Check it with `CLAUDE_CONFIG_DIR=~/.config/acme/claude claude auth status --text`. Run these from an
   empty directory (`cd "$(mktemp -d)"`), **not from `~`**: there `claude` reads `~/.claude/settings.json` as the
   project settings of `$HOME` and installs the plugins they declare into the fleet dir at project scope for
   `$HOME` (engsys#235). The same goes for every `CLAUDE_CONFIG_DIR=<dir> claude` login below; every login command
   the kit prints starts with `cd "$(mktemp -d)" && ` for that reason (engsys#304).
3. Accept workspace trust for the pin checkout once, with the monsters' flags:
   `cd <PIN_DIR> && CLAUDE_CONFIG_DIR=~/.config/acme/claude claude --dangerously-skip-permissions`, accept,
   `/exit`.
4. Set `FLEET_CLAUDE_CONFIG_DIR=~/.config/acme/claude` in `fleet/fleet.conf` (or in
   `~/.config/acme/fleet.local.conf` for this host only). Only these files set it: an environment value is
   ignored.
5. Run `fleet sync`. It installs the pinned marketplaces and plugins into that directory
   (`CLAUDE_CONFIG_DIR=<dir> claude plugin …`) and prints `claude config dir: <dir>, logged in`.
6. Restart the sessions: `fleet restart --all` (or `fleet launch` for a first start). Every session the
   fleet launches (monsters, interactive and security sessions, and the supervisor's relaunches) gets
   `CLAUDE_CONFIG_DIR=<dir>`, and `fleet verify` checks that directory instead of `~/.claude`.

**Only the monsters on the fleet dir: `FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised`.** By default (`all`)
every session the fleet launches runs on the fleet's dir. With `supervised` (set it in `fleet.conf` or
`fleet.local.conf`; the environment is ignored), only the roster lines this host positively classifies as
interactive run with `CLAUDE_CONFIG_DIR` unset, on `~/.claude` with your own plugins, skills, MCP servers
and auto-memory. Every other line keeps the fleet dir, so an unknown or oddly spelled one fails toward the
verified dir: merge, maintain, broker and any other monster (prompts matched in any case, with `_` or spaces
between the words), any ledger-bearing session, and security-tier lines (an env file named `security` or
`nyx` in any case, the roster's default `ENV_FILE` included, or any `--model` in the Claude Opus 4.8
family). The launcher applies the same rule again: a line it arms as a monster, the broker, a supervised
session or the security tier never gets `~/.claude`, whatever it was told. It decides the dir last, after
the env file, and launches `command claude` after `unset -f claude`, so an accidental assignment or a
function named `claude` in an env file can't move a session to another dir; an env file sourced by an
interactive role unsets it as well. That is a guard against mistakes, not against a hostile env file: env
files are trusted, PR-reviewed shell code, and a `PATH` wrapper, a `DEBUG` trap, `enable -n` or
`NODE_OPTIONS` in one can still change what runs.

`fleet sync` then reconciles the pinned marketplaces and plugins in both dirs, `~/.claude` at user scope.
In `~/.claude` it moves a marketplace to its pinned ref (Claude Code does that by removing and re-adding
the marketplace, which uninstalls its plugins) only when that marketplace has nothing installed but the
fleet's own: its pinned plugins at user scope, or at project scope for `PIN_DIR` itself. If you have another
plugin of it, or another project's project-scope install of one, sync leaves it, warns naming them, and
reports drift; then uninstall those, or remove and re-add the marketplace yourself (`marketplace update`
does not move a ref-pinned marketplace). Nothing else in `~/.claude` is
touched. `fleet sync --check`, `fleet status` and `fleet xray` report drift and login per dir.

`fleet verify` checks the fleet dir as before and, under `supervised`, also the engsys plugin installed in
`~/.claude`, against the same release: the interactive roles dispatch security reviews (Nyx) whose verdicts
gate merges, and those load the engsys plugin from `~/.claude`. A mismatch there holds the monsters like any
other. Your other plugins, skills and MCP servers in `~/.claude` are not checked.

The tradeoff, plainly: under `supervised` the interactive roles still carry the fleet's GitHub identity (the
App token, through the gh shim and the fleet git identity) while they load your personal, unverified
plugins, skills and MCP servers. A `nyx-review` verdict posted from an interactive role is only as
trustworthy as that role's unverified `~/.claude`. Choose `supervised` only if you accept that for the attended
roles, or turn on signed security verdicts below.

**Signed security verdicts: `FLEET_SECURITY_VERDICT_KEY=on` (eric-sabe/engsys#197).** A *defence-in-depth* layer,
**not a security boundary**. With it on, `fleet launch` creates an HMAC key at `<fleet state>/security-verdict.key`
(mode 0600, never replaced) and tells only security-lane sessions where it is (`ENGSYS_SECURITY_VERDICT_KEY_FILE`,
set by the session launcher for a session whose env file is `security.env` or `nyx.env` only, and unset for every other session whatever its model, engsys#229). A
security-lane session posts its verdict with `node <engsys-root>/lib/security-verdict.mjs post --repo O/N --pr N --sha
<head> --verdict PASS|FINDINGS --body-file F`, which refuses outside a security-lane session and for any SHA that is
not the PR's current head, and signs an HMAC-SHA256 over repo, PR, head SHA, verdict, timestamp, nonce and a hash of the
review text. Merge-monster verifies it when its config sets `ready_requirements.signed_security_verdict: true`
(**opt-in, default off**, so existing fleets are unchanged): once on, verdicts are ranked by their signed timestamp
(never the comment's `createdAt`, so re-posting an old verdict changes nothing) and the latest authentic one decides.
A signed FINDINGS verdict for any head fails the READY preflight and is sticky: a new push does not clear it, only a
fresh signed verdict for the current head does. A PASS counts only for the head it was signed for. Unsigned, forged or
tampered comments with the exact marker `<!-- nyx-review -->` are ignored when an authentic verdict decides and fail
the preflight when none does (fail closed by design: a claimed verdict that does not verify never passes silently);
an unreadable or group-readable key always fails. What it does not do: the key file is
readable by every process running as the fleet's macOS user, so an attended session with a shell can read it and sign a
verdict. It stops accidental and naive forgery, not a hostile session on the same account. A Nyx reviewer dispatched
from an interactive role cannot post a valid verdict; the review has to run in the security lane. The signing grant is
narrower than the security model: the merge monster runs Opus 4.8 and reads attacker-authored PR content, so it is not given the
key path and cannot mint a PASS (`post` refuses), but it still verifies, because `mm-preflight.sh` reads the key file by path.
The maintenance monster runs on the security env file, so it holds the signing grant, but it signs verdicts only on PRs it did not author: a PR the maintenance monster wrote itself waits for an operator (its skill's § Security review requests: any `<!-- mm-handoff -->` block on the PR naming the session marks it as its own; the launcher does not tell authors apart). The key path
reaches a session only on its own launch line, never the launcher's or the tmux server's environment. The real
boundary is a separate GitHub identity for the security lane (eric-sabe/engsys#220); the keystone-side gate that reads these
verdicts is wired separately.

**Signed memory refs: `FLEET_MEMORY_SIGNING_KEY=on` (F5, FeedFrwd/ff-engsys-fleet#60).** Monsters publish history to
`refs/engsys/memory/*` (docs/memory-spec.md §9), and a reader has to know which fleet wrote a ref. GitHub's own metadata
can't say: commits made through the API are committed by `web-flow`, with the App's bot only as the email-derived author.
So each fleet signs what it writes with its own Ed25519 key, and readers trust a ref only if it verifies against that
fleet's public key in the operator's memory.yml.

- **Per-host setup.** Set `FLEET_MEMORY_SIGNING_KEY=on` in `fleet.conf` (default off). The next `fleet launch` creates
  `<fleet state>/memory-signing.key` (Ed25519, PKCS#8 PEM, mode 0600, never replaced). Only merge and maintain lines are
  told where it is (`ENGSYS_MEMORY_SIGNING_KEY_FILE`, set by the session launcher after the env file and unset on every
  other line). The path reaches a session only on its launch line, so a merge or maintain monster already running
  must be restarted (`fleet restart <name>`) to get it. If the key can't be created, launch warns and continues;
  memory-sync then writes nothing.
- **Needs a fleet id.** Memory refs are written per fleet, so with `FLEET_ID` unset (single-fleet mode) nothing is
  ever written, key or not.
- **Publish the public key.** `fleet memory-pubkey` prints this host's key as a one-key list, for example
  `fleet_memory_pubkeys:\n  eric: [<base64>]`. Add it to the fleet's list in its reviewed `memory.yml` (a fleet with
  several hosts lists one key per host; a single string is accepted too) in a fleet PR, together with that file's
  `VERIFY_ALLOWED_USER_FILES` hash (#230 pins the file). A fleet with no valid key is untrusted. Each fleet writes only its own namespace, `refs/engsys/memory/fleet/<fleet>/` (`events` from its maintain baton holder, plus `merge` and `maintain` tails; engsys#266), and a reader trusts a ref there only if that fleet signed it. There is no shared cross-fleet events ref.
- **Reading other fleets' refs** (engsys#266). The maintain baton holder's heartbeat runs a staged fetch
  (`memory-sync --consume`): a tip reaches the local refs only if it verifies and descends from the last verified tip, so
  a force-push back to an older signed tip (a rollback) is rejected and logged (`memory-sync: consume: … rejected`, in
  `<state_dir>/memory-sync.warn`). The last verified tips are kept in the local refs and in
  `<state_dir>/memory-ref-tips.json`; a host with neither trusts the first verified tip it sees (logged). To weight
  another fleet's history down, set `peer_fleet_weight` (0–1, default 0.5) in `memory.yml`, which changes its hash.
  With no key in `fleet_memory_pubkeys` the fetch doesn't run at all. A fleet whose refs exist but whose key isn't
  listed yet is reported once (`rejected (unknown_fleet)`), not every heartbeat.
- **Turn-on order.** 1) Merge the `memory.yml` PR that adds every fleet's `fleet_memory_pubkeys` (with its new
  `VERIFY_ALLOWED_USER_FILES` hash, #230) and roll it out to each host. 2) Then turn memory sync on
  (`ENGSYS_MEMORY_SYNC`, `FLEET_MEMORY_SIGNING_KEY=on`) and restart the monsters. The other way round, each fleet's first
  writes are refused as `unknown_fleet` by the others until the keys land, and a host's first fetch after the keys
  arrive trusts whatever tip is current (trust on first use).
- **Blast radius of one fleet key.** A stolen key (any process running as that fleet's user) can sign only that fleet's
  own namespace, `refs/engsys/memory/fleet/<fleet>/`. Other fleets read it as that fleet's history, weighted by
  `peer_fleet_weight`, as structured Class B pointers only (no free text reaches a brief). It cannot sign another
  fleet's refs, and it cannot roll a ref back past what readers already verified. To cut it off, remove the fleet's key
  from every `memory.yml` (a reviewed PR): its stream drops at the next brief.
- **No key, no write.** memory-sync refuses `--publish` and `--tail` without a usable key (missing, a symlink, not
  owned by the fleet user, readable by group or other, or not Ed25519). The heartbeat carries on, and the reason is
  latched in `<state_dir>/memory-sync.warn` (and printed on the heartbeat's stderr when it changes) until it is fixed.
- **Rotation** is a new key plus memory.yml PRs. Stop the monsters, move the old key aside, `fleet launch` (it creates a
  new one), `fleet memory-pubkey`, and add the new key to the fleet's list beside the old one: both verify during the
  overlap, and the next heartbeat re-signs each tip with the new key (an unchanged tip too). Remove the old key in a second PR once the tips are
  re-signed.
- **What it does not do.** The key is readable by every process running as the fleet's macOS user, the same caveat as
  the verdict key: an attended session with a shell can read it and sign. It stops anyone holding only repo
  `contents: write` (or the bot's token on another host) from writing a ref readers trust; it is not an OS boundary.

**Which PRs need a verdict is decided by `mm-preflight.sh`, not by the merge session** (engsys#229). Run with any of `ENGSYS_MM_CONFIG` (the
fleet's launch context should export it), `.claude/merge-monster.yml` in the cwd and `--config <merge-monster.yml>`
(every one that exists counts and the strictest wins, so `--config` can add requirements but never replace the others) plus the **fleet-config-dir copy**: the instance plugin's `repos/<owner>/<repo>/merge-monster.yml`, which `core/lib/mm-config.mjs` finds through the Claude config dirs it can see (`$CLAUDE_CONFIG_DIR`, `$FLEET_CLAUDE_CONFIG_DIR`, the per-session dirs beside it, `$ENGSYS_CONFIG_DIR_SESSIONS/*` and `~/.claude`, all searched, so repointing one variable hides nothing): every `installPath` in `plugins/installed_plugins.json`, else the `plugins/cache/*/*/*/` roots; directory names match case-insensitively. If `ENGSYS_MM_CONFIG` is unreadable (its version directory was pruned) but a readable copy is discovered, the copy is used with a warning. `mm-preflight.sh --capabilities` prints `security-verdict` and `security-sensitive-globs` and exits 0 without touching GitHub (an older kit exits 2 on the unknown flag): that is the probe. A repo with such a `repos/<owner>/<repo>/` directory is fleet-managed: with no readable `merge-monster.yml` there and none in the repo it fails closed (`security_config_unreadable`), even when `--config` is passed. For a `merge`-role line the launcher also exports `ENGSYS_MM_CONFIG` pointing at that copy (looked up in the session's own config dir, then the launcher's) and unsets it on every other line. It reads `security_sensitive_globs`
and `security_sensitive_label` (default `security`), lists the PR's files over REST (paginated; `filename` and
`previous_filename`, so both sides of a rename match) and requires a signed PASS whenever the label is on the PR or any
file matches a glob. Omitting `--require-security-verdict` cannot lower that; a config that sets
`ready_requirements.signed_security_verdict: true` also turns the gate on without `--security-verdict`. The glob dialect:
`*` and `?` stay in one segment, `**` crosses segments, `**/x` matches a root-level `x`, everything else (parentheses,
brackets, dots) is literal, no braces. It fails closed: an unreadable config (`security_config_unreadable`), a file list
shorter than the PR's `changed_files` (`security_file_list_unreadable`), an unreadable key (`key_unavailable`); a PR with
more than 3000 files, which GitHub does not list in full, requires the verdict. Residual: a repo that is not fleet-managed,
has no in-repo config and gets no exported `ENGSYS_MM_CONFIG` keeps the old opt-in behaviour.
The capability to probe for is `mm-preflight.sh --capabilities` (it also prints `security-review-request` from the
release that added the request flow below).

**Requesting a verdict (engsys#231, #240, #241).** A PR that needs a verdict and has none at all (or whose only blocking verdict is a FINDINGS signed for an earlier
head, after a fix push) is not a failed PR:
`mm-preflight.sh` exits **3** with reason `security_review_required` (the full snapshot still on stdout). The merge
monster then adds the review request label (merge config `security_review_label`, default `security-review-requested`;
it must differ from `security_sensitive_label`), keeps the PR parked with `mm:ready` on, and, when the PR is
operator-gated, posts its gate request right away, so approvals given while it waits count. The maintenance monster
holding the signing key lists labeled PRs (`mnt-security-reviews.sh`), runs Nyx at the head, posts the signed verdict
through its fence (`mnt-act.sh guard -- node …/security-verdict.mjs post … --body-file tmp/<file>`; the guard accepts
only this engsys's own script and confines the body like a `fleet msg send`) and removes the label. The merge
monster's bus wakes on the label's removal or a new `<!-- nyx-review -->` comment, and its tick re-runs preflight for
every labeled or parked PR each time as a backstop. The label is a request, never a trust signal: removing it does
not let a PR through.

**A request nobody answers (engsys#246).** If the security lane is down, stuck, usage-limited, missing its key or
skipping the PR as self-authored, the merge monster's tick escalates the request once per PR and head:
`fleet notify --level action --author <PR author> --incident security-review-stale-<owner>__<repo>-<N>`, a DM to the
operator of the fleet that opened the PR (this host's operator for a human's PR). It fires after
`security_review_escalate_minutes` at the current head (merge config, default 30; `0` turns it off), and at once when
the lane is clearly unavailable: the maintain baton is free or expired, or the lane left its self-authored skip note or
its no-signing-key note for the current head (`<!-- security-review-no-signer head="…" -->`) on the PR; only the
fleet's own bots' comments count. A new head restarts the clock; the verdict
landing, or the PR merging, closing or leaving the queue, resolves the incident.

**The monster batons.** A session the fleet launched (`ENGSYS_SESSION` and `ENGSYS_SESSION_RUN` set) may
take, renew or act on the merge or maintain baton only when the launcher armed it for that role
(`ENGSYS_SINGLETON_ROLE`) and, under `supervised`, only on the fleet's config dir; `mm-baton.sh` /
`mnt-baton.sh` refuse otherwise. A monster you start by hand, in a session the fleet did not launch, passes
`--session <name>` and is not affected. This is defence in depth, not a boundary: an interactive fleet
session holds the App token outside the singleton-write guard, so it could bypass the baton altogether.

While the dir is set but not logged in, `fleet verify` reports "not verified" and alerts
(`wrapper-integrity-unverified`), which holds every merge and maintain launch and relaunch, so a
rotation never relaunches a monster into a login prompt; `fleet sync --check` (in `fleet status`) reports
it as drift.

**One Claude login per session: `FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on`.** One shared fleet dir means one
Keychain credential and one rotating refresh token for every long-lived session on it. At the access token's
expiry (about every eight hours) those processes race the refresh; the loser gets `invalid_grant` and **writes an
emptied credential over the winner's** ([anthropics/claude-code#88583](https://github.com/anthropics/claude-code/issues/88583),
open and still present in 2.1.292). On 2026-10-18 that logged out all three monsters of a fleet at once (engsys#205).
`setup-token` is not a way out: its token cannot establish Remote Control sessions, which every fleet session needs.
So no two long-lived sessions may share a login:

- Set it next to `FLEET_CLAUDE_CONFIG_DIR` in `fleet/fleet.conf` or `fleet.local.conf` (only those files set it;
  `off` / unset is the shared dir, exactly as before). Each session that uses the fleet's dir gets its own,
  `<FLEET_CLAUDE_CONFIG_DIR>.sessions/<session name>` (for `~/.config/acme/claude`: `~/.config/acme/claude.sessions/acme-mm`),
  so its own Keychain item and refresh token. Under `FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised` the interactive
  roles keep `~/.claude` and get no dir. A name with a slash, a leading dot or `..` never gets a dir; nothing can
  leave the base.
- **One-time setup:** `fleet config-dir init` creates and seeds every session's dir (the same seed as the shared dir,
  `syncClaudeAiSkills` / `syncClaudeAiPlugins` false included; re-running it is safe) and prints, for each dir that
  is not logged in, the commands to run: `cd "$(mktemp -d)" && CLAUDE_CONFIG_DIR=<its dir> claude`, `/login` with the fleet's seat, `/exit`,
  and the workspace-trust step from section 6.1 step 3 for that dir. Then `fleet sync` (installs the pinned plugins
  into every session dir), `fleet verify`, `fleet restart --all`. `fleet config-dir init --session <name>` does one.
- **Adopting it on a running fleet (engsys#212): the flag goes in last.** The order matters, because with the flag on
  and a session's dir missing, `fleet verify` cannot run for that session and its monster is held:
  1. `fleet config-dir init --per-session` (add `--session <name>` for one) creates every session's dir while the flag is
     still off. (Without `--per-session` and without the flag, `init` seeds the one shared dir instead.)
  2. Log each session in once and accept workspace trust once, **from a terminal in the Mac's own GUI session, not
     over SSH**: `cd "$(mktemp -d)" && CLAUDE_CONFIG_DIR=<its dir> claude`, `/login`, `/exit`, then
     `cd <PIN_DIR> && CLAUDE_CONFIG_DIR=<its dir> claude --dangerously-skip-permissions`, trust, `/exit`. Over SSH the
     login Keychain can't be read (engsys#210), so `claude auth status` reports "not logged in" for a login that
     works, and `/login` there would replace it; `fleet config-dir init` over SSH says "login state unknown" and
     prints no login commands.
  3. Set `FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on`.
  4. `fleet sync`, then `fleet verify`, then restart each monster (`fleet restart --all`, or one at a time).
  Turned on early anyway? `fleet sync` and `fleet status` warn at once with "these sessions have no
  config dir or no login yet" and the steps above; `fleet verify` warns up front about sessions with no dir and
  reports a logged-out dir in that session's block. The integrity alert for a missing dir names
  `fleet config-dir init --session <name>` instead of waiting for it to clear: a missing dir never does.
- **Re-login after a wipe is one session, not all:** `cd "$(mktemp -d)" && CLAUDE_CONFIG_DIR=<that dir> claude`, `/login`, `/exit`. The
  supervisor holds only that session and the alert (`claude-auth-expired-<session>`) names the dir and the command.
- **Add a session:** add it to the roster, then `fleet config-dir init --session <name>`, log it in, `fleet sync`.
  Until it has a logged-in dir, `fleet launch` holds that session with the command to run; it never starts into a
  login prompt.
- `fleet verify` checks every session dir (plugins against the release, user-scope items, login) and prints a block
  per dir; the verdict, the alert (`wrapper-integrity-<session>`) and the hold are per session, so one tampered or
  logged-out dir holds only its session (`fleet verify --session <name>` asks about one).
- **Sync and status leave a running session's dir alone (engsys#253).** `fleet sync` does not run `claude` on the
  own dir of a session that is running (`claude auth status`, `plugin list`, `marketplace …` and `plugin install` are
  each a second process on its login). It reports that dir as "session running, not synced now — restart to pick up"
  and records it in `.fleet/sync-deferred`. The dir is synced when the session restarts, before the new process
  starts (§ 7, What sync does). `fleet status` (`fleet sync --check`) reads a running session's dir from its files
  and does not check its login. The supervisor's pane watch catches an expired login.
- **Fleet commands add no refreshers.** `claude auth status --json` and `claude plugin list --json` both contact
  api.anthropic.com, even in a dir with no login (observed against an empty temp config dir with a local proxy:
  two CONNECTs each), so on a logged-in dir they are extra processes on a credential its session is also
  refreshing. They are therefore serialized per dir (`.fleet/locks/`), a logged-in answer is reused for `--max-age`
  minutes, and the supervisor's test request runs only once a session is already logged out, and then on that
  session's own dir. Whether they refresh a still-valid token could not be settled without a real login; the lock
  keeps fleet commands off each other either way, but cannot stop a session's own refresh from overlapping one.

`fleet status` (through `fleet sync --check`) and `fleet xray` report the directory in use and whether it
is logged in; neither prints the account or any token. With `FLEET_CLAUDE_CONFIG_DIR` unset, the fleet uses
`~/.claude` and drops a `CLAUDE_CONFIG_DIR` it inherits, so what `fleet verify` checks is what the sessions
load. If your Claude Code version shares the login across config directories (both show the same
account), use setup A instead. Tools that keep a single login per macOS account (some review CLIs) have the
same limit: logging in as the fleet replaces your own.

**The secondary option: allow specific user-scope plugins.** If the fleet does share `~/.claude` with you,
`VERIFY_ALLOWED_USER_PLUGINS` in `fleet.conf` (space-separated `name@marketplace`) lists the user-scope
plugins you accept in fleet sessions. `fleet verify` reports each listed one as `verify: info allowed …`
instead of a mismatch; any plugin not listed is still a mismatch. Allowing a plugin is a real decision:
its hooks and skills run inside the merge and maintain sessions, which hold the fleet's GitHub identity.

### 6.2 The machine

- **Create the fleet user (A only):** System Settings, Users & Groups, Add User. Standard user, account
  name `fleet`, strong password in your password manager.
- **Keep it awake:** `sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1`, then check
  `pmset -g`.
- **Remote access:** turn on Remote Login (ssh) and Screen Sharing.
- **Keep the fleet user logged in.** Its launchd jobs and tmux sessions run only while it has a GUI login.
  Log in as `fleet`, then use Fast User Switching to return to your own account; do not log `fleet` out.
  After a reboot log it back in over Screen Sharing (FileVault disables automatic login, so this is
  manual). If the fleet stops after a reboot, this is the first thing to check.

### 6.3 Tools

Install as an admin, once per machine:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install git gh jq tmux node
brew install --cask claude-code
```

| Tool | Why | Watch for |
|---|---|---|
| **node, in `/opt/homebrew/bin`** | identity scripts, hooks, the installer | launchd jobs search `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` only, and `fleet install-jobs` warns when a tool a job needs doesn't resolve there. **Do not install node with nvm or fnm**; a launchd job will not find it. Use Homebrew `node` (or a versioned `node@NN` formula, linked). |
| git >= 2.31 | env-based identity needs it | `git --version` |
| gh, jq, tmux | fleet scripts, launcher, supervisor | |
| **Claude Code on the Homebrew stable channel** | the sessions | Install with `brew install --cask claude-code` and **do not enable auto-update**. Unattended sessions should change version on purpose: `brew upgrade --cask claude-code`. The launcher needs a reasonably recent version (see its header); the plugin mechanics in section 9 were verified on 2.1.280. |
| your project's other tools | package manager, cloud CLI, review CLI, test infrastructure | whatever your gate needs |

### 6.4 The fleet user's shell

```bash
cat >> ~/.zprofile <<'EOF'
eval "$(/opt/homebrew/bin/brew shellenv)"
alias fleet=~/git/acme-fleet/scripts/fleet
EOF
source ~/.zprofile
```

Do not set a global git `user.name` or `user.email` for the fleet user. Fleet processes carry the bot
identity; anything else should fail loudly instead of committing as someone.

### 6.5 Sign in to Claude Code

As the fleet user run `claude`, `/login` with **the fleet's seat** (not a personal one), then `/exit`.
`/status` in a session should show your organization.

### 6.6 Clone the repos

The pinned engsys checkout is where every host script runs from:

```bash
git clone https://github.com/eric-sabe/engsys ~/git/engsys        # ENGSYS_DIR; fleet sync moves it to the pinned tag
```

Your instance repo and the pin repo are usually private. Clone them **once** with a short-lived login of
your own, then remove that login; after the identity step the fleet fetches as the App:

```bash
gh auth login --hostname github.com --git-protocol https --web
git clone https://github.com/acme/acme-fleet ~/git/acme-fleet
git clone https://github.com/owner/repo ~/git/repo                # PIN_DIR
gh auth logout --hostname github.com
printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain erase
```

`gh auth status` should then say you are not logged in.

### 6.7 The order of steps

1. **`engsys fleet init`** scaffolds the instance repo. Do it on any machine; commit and push the result.
2. **Identity.** A human creates the GitHub App and generates keys; you place the env file and run
   `--check`.
3. **Ledgers and labels** with the monsters' setup scripts.
4. **Pins.** The pin repo's `.claude/settings.json` gets the marketplace refs (a PR, or one-time direct
   push if you must bootstrap).
5. **`fleet sync`** makes the host match the pins.
6. **`fleet launch`** starts the sessions.
7. **`fleet install-jobs`** loads the supervisor and identity health jobs.

#### Step 1: scaffold

```bash
engsys fleet init --into ~/git/acme-fleet --org acme --namespace acme \
  --pin-repo owner/repo --pin-dir ~/git/repo \
  --instance-marketplace acme --identity github-app --cloud none
```

| Flag | Meaning |
|---|---|
| `--into <dir>` | the instance repo directory to render into |
| `--org <slug>` | `FLEET_ORG`: names `~/.config/<org>/`, `~/.cache/<org>/`, `~/Library/Logs/<org>-fleet/` and launchd labels `com.<org>.fleet.<job>` |
| `--namespace <ns>` | the session-name prefix (`acme` gives `acme-mm`, `acme-build`, ...) |
| `--pin-repo <owner/repo>` | the repo whose `.claude/settings.json` holds the pins |
| `--pin-dir <path>` | where that repo is checked out on the host |
| `--instance-marketplace <name>` | optional. Also scaffold an instance plugin under this marketplace name |
| `--identity github-app\|none` | wire in the GitHub App identity kit (`GH_APP_ENV`) or not |
| `--cloud azure\|none` | wire in the Azure service-principal login or not |
| `--engsys-dir <path>` | the host's pinned engsys checkout (`ENGSYS_DIR`); default `~/git/engsys` |
| `--worktrees-dir <path>` | agent worktrees (`WORKTREES_DIR`); default `<pin-dir's parent>/worktrees` |
| `--dry-run` | print what would be written; write nothing |
| `--force` | overwrite existing scaffold files (without it, init refuses and lists the collisions) |

It renders `fleet/fleet.conf`, `fleet/roster.tmpl` (the merge and maintenance monsters plus build,
investigate and design roles), `fleet/env/session.env.tmpl` (model alias pins) and
`fleet/env/security.env.tmpl`, `fleet/supervisor.conf.tmpl`, the `scripts/fleet` shim, `.gitignore`,
`docs/TRANSITION.md` and a README. With `--instance-marketplace` it also renders the plugin skeleton:
`marketplace.json`, `plugin.json`, a generic SessionStart `fleet-context` hook (it injects
`fleet config dir:`, the repo's `context.md` and `context/org.md`), `context/org.md`, and
`repos/<owner>/<repo>/` configs copied from the monsters' `config.example.yml` files. Without
`--instance-marketplace` there is no hook to inject the config dir, so the monster configs go to
`fleet/repos/<owner>/<repo>/` and the roster passes `fleet config dir: …` in the monsters' prompts. It
prints the next steps, which are the ones below.

`fleet init` is also reachable as `fleet init ...` from the kit's dispatcher; that simply calls
`engsys fleet init`. Edit the roster to taste, commit, and push.

#### Step 2: identity

Follow [`core/fleet/identity/README.md`](../core/fleet/identity/README.md): a human org owner creates the
App, installs it on the repos the fleet operates on (only selected repos), and generates a private key.
Then, on the host:

```bash
install -d -m 700 ~/.config/acme ~/.gh-app
mv ~/Downloads/acme-fleet.*.private-key.pem ~/.gh-app/acme-fleet.pem && chmod 600 ~/.gh-app/acme-fleet.pem
$EDITOR ~/.config/acme/gh-app.env && chmod 600 ~/.config/acme/gh-app.env     # shape in the identity README, section 3
GH_APP_ENV_FILE=~/.config/acme/gh-app.env node ~/git/engsys/core/fleet/identity/gh-app-token.mjs --check
```

You need a `--check` that ends in success and no "permission short" lines. Set `GH_APP_ENV` in `fleet.conf`
(or in `~/.config/acme/fleet.local.conf` for this machine only) to the env file's path. For a cloud
principal, follow the azure pack README and point a roster `PREFLIGHT=` line and the session env at it.

#### Step 3: ledgers and labels

Each monster keeps a ledger issue and a set of labels in the repo it serves. The setup scripts are
idempotent, so re-running is safe; they fail closed rather than create a duplicate ledger. Run them as the
fleet identity so the ledger is owned by the bot:

```bash
export GH_APP_ENV_FILE=~/.config/acme/gh-app.env PATH=~/git/engsys/core/fleet/identity/bin:$PATH
bash ~/git/engsys/core/skills/merge-monster/scripts/mm-setup.sh  --repo owner/repo
bash ~/git/engsys/core/skills/maintenance-monster/scripts/mnt-setup.sh --repo owner/repo
```

Each prints `repo:` and `ledger_issue:` lines. Put the ledger numbers in `fleet/supervisor.conf.tmpl`
(the number is the second field of the monster's line) and paste the `repo:`/`ledger_issue:` lines into the
monster configs under the instance plugin's `repos/<owner>/<repo>/`. Commit and push the instance repo.
Repeat for every repo a monster serves.

#### Step 4: pins

In the pin repo's `.claude/settings.json`, declare both marketplaces at tags and enable the plugins you
want:

```json
{
  "extraKnownMarketplaces": {
    "engsys": { "source": { "source": "github", "repo": "eric-sabe/engsys", "ref": "vX.Y.Z" }, "autoUpdate": false },
    "acme":   { "source": { "source": "github", "repo": "acme/acme-fleet", "ref": "v0.1.0" }, "autoUpdate": false }
  },
  "enabledPlugins": {
    "engsys@engsys": true,
    "engsys-typescript@engsys": true,
    "acme@acme": true
  }
}
```

Tag the instance repo (`git tag v0.1.0`, push the tag) so the ref exists. From this point `fleet pin`
(section 7) maintains these refs for you.

#### Step 5: sync

```bash
~/git/acme-fleet/scripts/fleet sync
```

It fast-forwards `PIN_DIR`, checks out the instance repo and `ENGSYS_DIR` at their pins (re-executing from
the new code each time), and installs every plugin the pin repo enables. `fleet status` should report the
host in sync, with every session `missing` because none has launched yet.

#### Step 6: launch

```bash
fleet launch && tmux attach -t acme -r     # Ctrl-b d to detach; -r keeps you read-only
```

`fleet launch` renders `fleet/env/*.env.tmpl` into `.fleet/env/` and the roster into `.fleet/roster`,
then runs the engsys launcher from `PIN_DIR`. It launches missing sessions and refuses a name that already
exists as a tmux window, so it is safe to re-run. Identity preflights (`PREFLIGHT=` lines in the roster)
warn and never block a launch. Pass a name (`fleet launch acme-build`) to start one session.

#### Step 7: jobs

```bash
fleet install-jobs --dry-run      # print what would be written
fleet install-jobs
```

Three jobs, all rendered from `core/fleet/jobs/launchd/*.plist.tmpl` with the label
`com.<org>.fleet.<job>`: **`fleet-supervisor`** (every 5 minutes; installed only when
`fleet/supervisor.conf.tmpl` exists), **`gh-app-login`** (every 30 minutes; installed only when
`GH_APP_ENV` is set) and **`fleet-relay`** (every 60 seconds; installed only in multi-fleet mode, with
`FLEET_ID` set and a federation file, § 6.10, on a host that runs at least one roster session;
otherwise a loaded copy is booted out). Each is `plutil -lint`ed, then booted out and bootstrapped, so there are never two
copies. A same-named file in the instance's `jobs/launchd/` overrides the default, and you can add jobs
(for example an `az-sp-login` refresh). `--only <job>` acts on one; `--unload` boots everything out.
Logs are in `~/Library/Logs/<org>-fleet/`.

#### Verify

- `fleet status` shows every session running and current, none BEHIND.
- `launchctl list | grep com.acme` shows the jobs.
- One small issue goes end to end through your implement command and its commits are authored by
  `acme-fleet[bot]`; the merge monster merges it.

### 6.8 Retiring a host

Stop it first (`fleet install-jobs --unload && tmux kill-session -t acme`). Then revoke **its**
credentials, with the new host already verified: delete the old GitHub App private key in the App settings
(match by fingerprint against `openssl rsa -in <pem> -pubout -outform der | openssl dgst -sha256 -binary | base64`),
delete the old service-principal certificate by key id, revoke any review-CLI API key, and wipe
`~/.gh-app`, `~/.config/<org>` and `~/.cache/<org>` on the old machine. Add a line to
`docs/TRANSITION.md`.

### 6.9 Slack (optional)

`fleet notify` is the fleet's own Slack voice: merge-monster, maintenance-monster and the resource
broker post escalations through it instead of an operator's personal Slack connector (every post then
appears as the fleet's own bot, not as whoever happens to be signed in). It's optional: without it,
escalations fall back to a GitHub comment on their own, with no further configuration needed.

**One Slack app per fleet**, created in the org's workspace (for example "Acme Fleet (acme)"), scopes
`chat:write` and `im:write` (to DM an operator), no read scopes, because approvals come from GitHub,
never a Slack reply. Manifest:

```yaml
display_information:
  name: Acme Fleet (acme)
oauth_config:
  scopes:
    bot: [chat:write, im:write]
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
```

Install it to the workspace, invite the bot to the escalation channel, then put its bot token in a
`chmod 600` env file under `~/.config/<org>/`, for example `~/.config/acme/slack.env`:

```sh
SLACK_BOT_TOKEN=xoxb-...          # the app's Bot User OAuth Token
SLACK_CHANNEL_ID=C0XXXXXXXXX      # the escalation channel the bot was invited to
SLACK_OPERATOR_ID=UXXXXXXXXX      # optional: this host's operator, DMed when the registry names no slack_operator for FLEET_ID
FLEET_ID=acme                     # optional: prefixes every post, e.g. "[acme] ..."; fleet.conf's FLEET_ID wins when set
```

Only the token and channel are required. Routing (engsys#238, no channel ping): `action` and `alert`
DM this host's operator (`federation.yml` `fleets.<FLEET_ID>.slack_operator`, else `SLACK_OPERATOR_ID`);
`--for <fleet-id|github-login>` DMs another operator; `--author <PR author>` DMs the PR's fleet operator;
`--level alert --everyone` posts in the channel with no mention and DMs every enabled fleet's operator;
`info` and `--no-mention` post in the channel, pinging nobody. Never `@here`, never a user group:
`SLACK_OPERATORS_GROUP_ID` is retired and ignored when an older env file still sets it. Gate requests DM
the operator of the fleet that authored the PR (`multi-fleet.md` § 7). To resolve incident latches whose
PR already merged or closed: `fleet notify --sweep --repo <owner/name>` (dry run), then `--apply`.

Point `fleet.conf`'s `SLACK_ENV` at that path (and optionally `NOTIFY_FALLBACK_ISSUE=owner/repo#N` for
the GitHub-comment fallback). Never commit the file, and never reuse another bot's token: see
`docs/multi-fleet.md` § 7 for why. Verify with a real post (never 🚨/🔴; see the message-format rules
there too):

```bash
fleet --instance <dir> notify --level info "fleet notify is wired up"
```

Tests (offline, no real Slack or gh): `node --test core/fleet/notify.test.mjs` (the pure functions and
the CLI against a stub Slack server) and `bash core/fleet/test/notify.test.sh` (the `bin/fleet` → `fleet.conf`
→ `notify.sh` wiring); both run under `npm test`.

### 6.10 Registry (multi-fleet)

Skip this while one fleet works your repos. When a second fleet (another operator, another host) joins,
each fleet gets an id and the instance repo gets a registry saying who exists and which fleet holds each
singleton role. Design and rationale: [`multi-fleet.md`](multi-fleet.md) § 1.

**`FLEET_ID`** in `fleet/fleet.conf` (or `fleet.local.conf`) names this fleet: 2-21 characters, a
lowercase letter, then lowercase letters, digits or hyphens (`alice`, `bob`, `acme-eu`). Every fleet
command rejects any other value. `fleet launch` writes it into every session env, so monsters and
scripts can read `$FLEET_ID`. Unset means single-fleet mode: nothing changes.

**`federation.yml`** at the instance root (or the path in `FEDERATION_FILE`, relative to the instance
root unless absolute) is the registry. Change it by PR, like any fleet config:

```yaml
version: 1
operators_team: acme/fleet-operators   # or operators: [alice:1234567] for a user-owned repo
fleets:
  alice:
    operator: alice                    # GitHub login of the fleet's human
    host: alice-host
    github_app: acme-fleet-alice       # App slug; the bot login is acme-fleet-alice[bot]
    github_app_id: 1000001             # the App's numeric id (its settings page); required with 2+ enabled fleets
    cloud_identity: fleet-alice
    slack_operator: U0000000001        # Slack member id: fleet notify DMs this operator
    status_issue: 11                   # this fleet's status issue in the instance repo
    timezone: America/New_York         # IANA zone for times shown to people (default UTC)
    clock: 12h                         # 12h or 24h (default 24h)
    enabled: true                      # false = this fleet's kill switch
  bob:
    operator: bob
    enabled: true
repos:
  acme/app:
    merge:    { home: alice, ledger: 101, standby: [bob], failover: escalate }
    maintain: { home: alice, ledger: 102, standby: [bob] }
```

The loader (`core/fleet/lib/federation.mjs`) rejects, with every problem listed:

- `version` other than `1`, an unknown key at any level, or a fleet id that fails the `FLEET_ID` rule;
- a malformed `operators_team` or `operators` entry (the same rules as
  [gate-check](gate-check.md#configuration-and-permissions), which reads the same operator source);
- a role other than `merge` or `maintain` (build, investigate and design are per fleet and never listed);
- a `home` or `standby` that is not a declared fleet, a standby that repeats or equals `home`;
- a `ledger` or `status_issue` that is not a positive integer, and a `failover` other than `escalate`
  (the default) or `auto`.

Every fleet field except `enabled` (default `true`) is optional, and so is `ledger`, because a new
instance has no ledger issues yet. `standby` defaults to `[]`.

The file is YAML, but the repo carries no YAML dependency, so the loader reads a strict subset: block
maps, block lists of plain values, one-line flow maps and lists, quoted or plain strings, integers,
`true`/`false`/`null` and comments. It rejects anything else with the line number instead of guessing:
anchors and aliases, tags, block scalars (`|`, `>`), flow collections across lines, maps inside block
lists, several documents, tabs in indentation, and plain values a YAML parser could read differently
(`yes`, `no`, `on`, `off`, `1.5`, `010`, `0x1f`). Quote such a value to mean the string.

**Commands** (through `scripts/fleet`, which resolves `FLEET_ID` and the file from `fleet.conf`):

| Command | Output |
|---|---|
| `fleet federation validate [file] [--online]` | `ok: … (N fleets, M repo roles)`; exit 1 listing every problem. With `FLEET_ID` set, the id must be a declared fleet. No file: `single-fleet mode`, exit 0. `--online` (engsys#238) also asks GitHub that each `github_app` slug is a live App whose id is `github_app_id`: owner routing and the cross-fleet sender check match a bot by slug, so a stale slug misroutes or rejects that fleet's PRs and messages. No network or no `gh` is a warning, not a failure |
| `fleet federation get <path>` | one value, for example `get repos.acme/app.merge.home` prints `alice`; maps and lists print as JSON. Defaults are filled in (`failover` reads `escalate` when unset) |
| `fleet federation home <owner/repo> <merge\|maintain>` | the home fleet id |
| `fleet federation address <addr>` | `{"fleet":…,"session":…}` (below) |
| `fleet federation status` | the block `fleet status` prints first |
| `fleet federation status-issue` | this fleet's status issue as `owner/repo#N`: `fleets.<FLEET_ID>.status_issue` in the instance repo, which is `FLEET_INSTANCE_REPO` (fleet.conf) or else the instance checkout's origin. Exit 3 in single-fleet mode, 1 when the registry names no status issue for this fleet |

`get` and `home` exit 3 when the path or role is not declared, or when there is no file at all; 1 means
an invalid file or bad arguments.

**`fleet status`** now starts with `fleet: <id>` and, with a registry, one line per repo role: its home
(marked `(this fleet)` when it is yours), ledger, standbys and failover. `fleet launch` checks the
registry and warns when it is invalid or does not list `FLEET_ID`. With `FLEET_ID` set, the registry also
decides which monsters this host may start (§ 6.11): a merge or maintain monster whose home is another
fleet is not on this host, and an unreadable registry keeps every merge and maintain monster off it.

**Addresses.** A session in a federation is addressed `<fleet>:<session>`, for example
`alice:acme-build`. A bare name (`acme-build`) means "my fleet". The `mm-handoff` block's `session:`
field takes either form, and Merge Monster nudges only addresses in its own fleet
([merge-monster protocol](../core/workflows/merge-monster-protocol.md)).

**Starting with a registry.** `engsys fleet init … --fleet alice` writes `FLEET_ID=alice` into
`fleet/fleet.conf` and a one-fleet `federation.yml` with `alice` as home for merge and maintain of the
pin repo. Its TODO comments mark what to fill in: the fleet's fields, `operators_team` (or
`operators`), and each role's `ledger` once the setup scripts print the ledger numbers. On an existing
instance, add `FLEET_ID` and the file by hand.

**Cross-fleet messages.** Sessions in the same fleet use `SendMessage`. A message to a session in
another fleet is a GitHub comment carrying a `fleet-msg` header, which the other fleet's relay picks up
(design: [`multi-fleet.md`](multi-fleet.md) § 4):

```bash
fleet msg route bob:acme-build          # where a nudge goes: exit 3 = SendMessage, 0 = fleet msg send
fleet msg send --to bob:acme-build --re acme/app#412 --body-file tmp/bounce.md
fleet msg inbox acme-build              # undelivered messages for a session; --mark-read marks them
fleet msg read <comment-url>            # fetch one, re-check it, print the body as untrusted data
fleet relay                              # one poll by hand (the fleet-relay job runs it every minute)
```

`send` posts on the `--re` PR or issue, or on the target fleet's `status_issue` when there is no
`--re`, as this host's GitHub identity. The receiving relay accepts it only when that identity is the
sending fleet's App (`github_app`, and `github_app_id` once two fleets are enabled), so post with the
fleet's App, not a personal login. `--to` naming your own fleet exits 3 with
`same fleet: use SendMessage to <session>`. `route` applies the same rule without sending anything, and
every sender (the monsters, the role skills) routes an address through it before nudging (engsys#78); with
`--repo <owner/repo> --role merge|maintain` a bare name is placed in that role's home fleet. A merge or
maintain monster sends through its fence (`mm-act.sh guard … -- fleet msg send …`); its write guard denies
the bare command, and the fence takes the body only from stdin (`--body-file -`) or a file under the
session's `tmp/`.

The relay records each accepted message in `<instance>/.fleet/inbox/<session>.jsonl`, as a pointer (who
sent it, which PR or issue, the comment URL), never the text. It sends no keystrokes. The engsys
plugin's inbox hook shows a session its waiting pointers when it starts and on each prompt, and a
monster also gets a `FLEET_MSG` line on its watch bus. Inside a session, `fleet msg` runs as
`node <engsys>/core/fleet/msg.mjs inbox|read` (the hook prints the path). Every role skill also runs
`msg.mjs inbox <session> --mark-read` at startup, and treats a typed `fleet-msg from …` line the same way:
a pointer to re-read on GitHub. `fleet status` prints the
relay's last poll and any undelivered messages. The log is `~/Library/Logs/<org>-fleet/fleet-relay.log`,
one line per accepted or rejected message, rotated to `.1` past 1 MB.

The `FLEET_ID` in `fleet.conf` is the one `fleet notify` prefixes posts with. A `FLEET_ID` in the
Slack env file is then unnecessary; if both are set and differ, `fleet notify` warns and uses
`fleet.conf`'s.

#### Operator time format

Each fleet sets how dates and times read to its operator: a time zone and a 12-hour or 24-hour clock.
Set `timezone: America/New_York` and `clock: 12h` under the fleet in `federation.yml` (or, in single-fleet
mode, `OPERATOR_TIMEZONE` and `OPERATOR_CLOCK` in `fleet.conf`). Default is UTC and 24h. `fleet federation
validate` rejects an unknown zone; at run time a bad zone falls back to UTC with a warning.

It changes only text a person reads: the session-start and re-ground context line, `fleet notify` (Slack
shows each reader their own zone through a date token; the fallback text and the GitHub comment use the
fleet's format), supervisor ledger comments, `fleet status --federation`, and the gate-request comment.
Everything a script parses stays ISO 8601 UTC: heartbeat `last:` lines, baton commits, ledger markers,
logs and `--json`. `fleet time <iso|epoch|now> [--date|--time|--relative]` renders one time the same way,
for example `Oct 5, 3:44 PM EDT` or `5 Oct 15:44 CEST`.

### 6.11 Host roles: which sessions run on this host

Every host of an instance reads the same `fleet/roster.tmpl`. A host that must not run some of those
sessions says so in its own `~/.config/<FLEET_ORG>/fleet.local.conf`, which is never committed. The
usual case is a second fleet's host, which must not start or supervise the merge and maintenance
monsters while another fleet holds those batons ([`multi-fleet.md`](multi-fleet.md) § 10, P0).

A session is **not on this host** when the first of these that applies says so:

1. **The registry.** With `FLEET_ID` set and a `federation.yml`, a session whose roster prompt runs the
   merge or maintenance monster is excluded when the registry's `home` for that role is another fleet.
   The monster's repo is its `fleet/supervisor.conf.tmpl` 4th field, else that file's `REPO=`, else
   `PIN_REPO`. This needs no config, and nothing in `fleet.local.conf` overrides it: to run the monster
   here, move `home` by PR. A registry that can't be read (invalid, `FLEET_ID` not declared under
   `fleets`, or `node` missing) excludes every merge and maintain monster: a host that can't tell who
   holds a baton starts neither, and the supervisor raises one alert about it (below). And when the
   registry sets `enabled: false` for this fleet (the per-fleet kill switch), every monster is off:
   merge, maintain, broker and any other supervised session. Interactive roles still run.
2. **`ROSTER_EXCLUDE=`**: a denylist. An entry that matches always wins.
3. **`ROLES=`**: an allowlist. When set, a session that no entry matches is excluded. Prefer it on a
   host with a narrow job: a session added to the roster later stays off that host until you list it.

Entries are comma or space separated, and each matches a session by any of:

| Entry | Matches |
|---|---|
| `acme-build` | the session of that name |
| `build` | the session named `<NAMESPACE>-build` |
| `merge`, `maintain`, `broker` | sessions whose roster prompt runs that monster (`merge-monster`, `maintenance-monster`, `resource-broker`) |
| `monster` | all of those, plus every session listed in `fleet/supervisor.conf.tmpl` |
| `interactive` | every other session |

With neither key set and no registry in play, every session runs on every host, exactly as before.
Values come only from `fleet.conf` and `fleet.local.conf`, never from the caller's environment.

**What honors it:**

| Command | On this host |
|---|---|
| `fleet launch` | starts only the sessions that run here (the launcher gets `.fleet/roster.host`) and prints `skip: <name> is not on this host (<reason>)` for the rest |
| `fleet launch <name>` | refuses an excluded name with its reason. `--force-excluded` starts it anyway, for one deliberate launch; nothing else passes that flag |
| `fleet launch --check <name>` | exit 0 when the session runs here, else 1 and the reason |
| `fleet restart --all`, `--stale`, `<name>` | never cycles an excluded session |
| `fleet status` | lists an excluded session as `not on this host (<reason>)`, not `missing`, and warns about what the filter can't decide (below) |
| `fleet install-jobs`, `fleet sync` | install the supervisor job only when at least one supervised session runs here. Otherwise they boot out a loaded copy and delete its plist, so launchd won't load it at the next login. `fleet sync` checks this on every run, and reinstalls the jobs when the roster, the supervisor conf or the registry changes |
| `fleet supervise` (the supervisor job) | drops excluded sessions from `.fleet/supervisor.conf`, does nothing when none are left, and adds `HOST_CHECK_CMD=… launch --check`. The supervisor asks that command before it reads any session's ledger, so even a stale conf never relaunches, or comments about, a session this host doesn't run. A check that fails for any reason skips the session. Merge and maintain lines also get their role, so a relaunch also needs the lease to be free (§ The supervisor's view) |

**When an unreadable registry pauses the monsters**, the supervisor posts one
`fleet notify --level alert --incident fleet-registry-unreadable` (§ 6.9) with the validator's first
error, which sessions are paused, and what to do: fix `federation.yml` by PR, or, in an emergency,
`fleet launch <name> --force-excluded`. It posts once per incident, even on a host with nothing else to
supervise, and resolves the incident on the first tick after the registry reads clean again. A failed
post is logged and retried next tick and never stops the tick. `enabled: false` raises no alert: it is
deliberate. `fleet launch --host-health` prints the same alert (exit 1) or exits 0.

`fleet status` warns, without excluding anything, when a supervised session's prompt names no known
monster (so the registry can't place it; list it in `ROSTER_EXCLUDE` if this host must not run it),
when the registry declares no role for a monster's repo, and when a `ROLES` or `ROSTER_EXCLUDE` entry
matches no session.

**Example: a second fleet host.** The instance's roster has `acme-mm`, `acme-maintain`, `acme-broker`,
`acme-build`, `acme-investigate` and `acme-design`, and `federation.yml` makes fleet `alice` home for
merge and maintain of `acme/app`. Bob's host sets `FLEET_ID=bob` and, in
`~/.config/acme/fleet.local.conf`:

```bash
# bob's host: the per-fleet roles and its own broker. merge + maintain stay off by the registry anyway.
ROLES=build,investigate,design,broker
```

Then on bob's host:

```text
$ fleet launch
skip: acme-mm is not on this host (merge home for acme/app is fleet alice)
skip: acme-maintain is not on this host (maintain home for acme/app is fleet alice)
launched: acme-broker  (…)
launched: acme-build  (…)
…
$ fleet install-jobs
installed + loaded: com.acme.fleet.fleet-supervisor  -> …
```

The supervisor is installed here only because `acme-broker` runs here and is supervised. With
`ROLES=build,investigate,design` the host supervises nothing, so `fleet install-jobs` and every later
`fleet sync` keep the supervisor job unloaded. Edit `fleet.local.conf`, then run `fleet install-jobs` to
apply the change to the jobs. Starting sessions never needs a separate step: `fleet launch` reads the
filter each time.

**Each host's broker reports on its own fleet's status issue.** The broker is never excluded by the
registry, so alice's host and bob's host each run `acme-broker` over their own pool. Both read the same
`resource-broker.yml` and the same `acme-broker|13|60` line in `fleet/supervisor.conf.tmpl`, but in
multi-fleet mode neither uses ledger 13:

- the broker scripts heartbeat, label and comment on the fleet's status issue
  (`fleet federation status-issue`), inside a `<!-- broker-heartbeat -->` block that sits beside the
  supervisor's own `<!-- fleet-heartbeat -->` block on the same issue;
- `fleet supervise` rewrites the broker's line to `acme-broker|12|60|acme/acme-fleet|broker-heartbeat`
  (bob's status issue), so the supervisor reads only the broker's block;
- lease owners and the owner fence get the fleet id as a prefix (`bob-acme-broker`, `^bob-acme-…`)
  unless the config sets `lease.fleet_qualify: false`. Each host's lease store is a local path, so the
  two pools never share records either way.

If a fleet's status issue can't be resolved (no `status_issue` for it, an unreadable registry, or no
instance repo), the broker scripts stop and `fleet supervise` comments the broker's line out with a
warning. Neither falls back to the shared ledger. The resource-broker skill has the details
(*Multi-fleet*).

---

## 7. Day-2 operations

Everything below runs **on the fleet host**, from the instance repo's checkout. Add the `fleet` alias
once (section 6.4).

| Step | Command | What it does | Touches running sessions? |
|---|---|---|---|
| **status** | `fleet status` | fleet id and registry homes (§ 6.10), pins vs host (checkouts, marketplaces, plugins) and which sessions are behind | no |
| **pin** | `fleet pin --engsys vX.Y.Z` · `fleet pin --release next` · both | release your instance plugin (a release PR to merge first, then a re-run tags it), open the pin PR, get it reviewed and labeled, wait for the merge, then sync | no |
| **sync** | `fleet sync` | make the host match the merged pins | no |
| **restart** | `fleet restart --stale` · `fleet restart acme-build` | cycle sessions onto what is installed, whenever you are ready | **yes** |

`fleet status` prints the fleet id and registry homes (§ 6.10), runs `fleet sync --check` (exit 1 when the host is behind the pins), then the session
table: name, kind (monster or interactive), state (`missing`, `exited`, `busy`, `idle`, or `not on this
host` with its reason, § 6.11), start time and
`BEHIND` or `current`. **BEHIND** means the session's `claude` process started before the last change
`fleet sync` made (`.fleet/last-change`).

### What sync does

The pins are in the pin repo's `.claude/settings.json` (section 3). `fleet sync`, idempotently:

1. fast-forwards `PIN_DIR` (if it cannot, because the checkout is on another branch or diverged, it warns
   and uses the pins from `origin/<default branch>` instead; put the checkout back on the default branch);
2. checks out the instance repo at its pin and re-executes (skipped when there is no
   `INSTANCE_MARKETPLACE`);
3. checks out `ENGSYS_DIR` at the engsys pin and re-executes, because the kit's own code lives there;
4. reconciles each pinned marketplace's plugins (remove, add `#<ref>`, install each enabled plugin), and
   installs any enabled plugin that is missing;
5. reinstalls the launchd jobs if their templates, `fleet.conf`, the roster, the supervisor conf or the
   registry changed, and unloads a supervisor job left installed on a host that supervises nothing
   (§ 6.11);
6. stamps `.fleet/last-change` and appends to `.fleet/sync.log`.

`fleet sync --check` reports drift only. Sync refuses to run over uncommitted changes to tracked files in
either checkout (it names the checkout). It never restarts anything.

Every `claude plugin …` and `claude auth status` call sync makes runs from its own empty temp dir (never from a
project, and never under `$HOME`, even with a `TMPDIR` there), at user scope (engsys#112, engsys#235). The same goes
for the read-only `claude auth status` calls of `fleet config-dir init`, `fleet verify` and `fleet launch`, and for the
supervisor's test request: they run from `TMPDIR`, or from `/tmp` when `TMPDIR` is under `$HOME` (engsys#305).

**Project-scope installs for `$HOME` (engsys#235).** A `claude` run from `~` on a fleet dir records project-scope
installs whose `projectPath` is `$HOME` (it reads `~/.claude/settings.json` as that "project's" settings). When a
marketplace that only project settings declare has to move, those installs used to count as another project's, and
the move was refused. `$HOME` is not a project: in a fleet config dir (never `~/.claude` itself) sync now drops them
from `<dir>/plugins/installed_plugins.json` itself, a file-only edit with no `claude` on the session's login, after
a backup beside it (`installed_plugins.json.engsys235-<UTC time>.bak`), and says so in a WARNING naming the plugins
and the backup. `$HOME` is matched as written, with trailing slashes, or through a symlink either side. A real other
project among them still refuses the move, and the file is left untouched; the message names the `$HOME` ones as
strays that sync removes once the rest is gone, so never run `claude` from `~` to remove them.

**One failing dir does not stop the others (engsys#235).** With several config dirs (per-session mode, or scope
`supervised`), a dir whose plugin step fails (a refused marketplace move, a failed install, a settings rewrite) is
reported as `NOT synced` with its reason, and sync goes on with the next dir. The run then fails at the end, naming
every dir that failed (`the plugin step failed in: …`); what did sync is stamped in `.fleet/last-change`. Step 5
still runs first (engsys#305): one bad dir does not hold back a launchd job reinstall or the supervisor-job cleanup.

**Running sessions' own dirs (per-session mode, engsys#253).** Step 4 skips the own dir of a session that is running
(a claude process in its tmux window). Any `claude` call there, even `auth status` or `plugin list`, is a second
process on that session's login and can rotate its refresh token out from under it
([anthropics/claude-code#88583](https://github.com/anthropics/claude-code/issues/88583)). Sync reads that dir's files
to see whether it is behind. If it is already at the pins, sync says so and moves on. If it is behind, sync prints
`session running, not synced now — restart to pick up` and records the session in `.fleet/sync-deferred`. The dir
is synced when the session is down, before its new process starts:

- `fleet launch <name>` (what `fleet restart` and the supervisor relaunch through) runs
  `fleet sync --session <name> --no-jobs` for a deferred session before the integrity check. If that sync fails, the
  launch is refused, and the next supervisor tick tries again.
- The supervisor's per-session check (`fleet verify --auto-sync --session <name>`) does the same once the session is
  down. So a monster that exits after its rotation request is not held by a dir that was only waiting.
- A session left that way for longer than `SYNC_DEFER_ALERT_HOURS` (fleet.conf, default 24) gets one
  `fleet notify --level action` (incident `sync-deferred-<name>`, linked to the status issue or the first ledger),
  posted by the supervisor's tick and resolved once the session has restarted.
- While the session still runs, a periodic `fleet verify --max-age` of its deferred dir passes, with no alert, when
  every problem it finds is an install at another version than the pin (`version` lines, what a deferred pin change
  looks like) and each of those installs matches its own release, file by file (the old tag, from GitHub); it prints
  them. Any other problem (a hook, settings, user-scope config, memory, a changed file of the old version) is alerted
  and held as always; an old release that can't be read is "not verified". An old release whose tag GitHub no longer
  has (deleted, engsys#260) is "behind, cannot re-verify": everything else is still checked (a problem there is a
  mismatch), and with none the session is not held, and one alert is posted (incident
  `wrapper-integrity-deferred-gone[-<name>]`, resolved by the next check without it). The version comes from the
  dir's own files, so a forged one (a release that never was) looks the same, and the alert says so. Holding it would last until
  someone ran `fleet restart` by hand, and the relaunch is what fixes it. A moved (re-cut) old tag is not told apart
  from tampering: its changed files are a mismatch. The session runs what it loaded at start. A held gate would also stop the supervisor from
  cycling a monster that sits idle after its rotation request. This leaves no gap: the launch syncs the dir and
  verifies it again, without `--max-age`, before the session starts. Residual risk: `.fleet/sync-deferred` is host
  state. A process running as the fleet's user could add a live session to it and quiet that session's
  version-mismatch alert until the session restarts. Such a process could already edit `fleet.conf` or the verify cache.

`fleet status` (`fleet sync --check`) reads a running session's dir from its files (`plugins/installed_plugins.json`,
`plugins/known_marketplaces.json`, the settings) and skips its login check. It lists a running dir that is behind as
`running, behind the pins until restarted`, not as host drift. `fleet sync --include-running` syncs the running dirs
anyway, the way sync did before. Use it only when a restart is not an option: it can log a session out.
`fleet sync --session <name>` syncs one stopped session's dir at the pins as they stand, with no checkout moves and
no job reloads. A shared dir (`FLEET_CLAUDE_CONFIG_DIR` without per-session mode, or `~/.claude`) is synced and
checked as before: its sessions share one login and race each other anyway. One exception: `~/.claude` under scope
`supervised` while an interactive role runs on it. `fleet status` reads its files then, and an unattended sync
(`--no-jobs`, what the supervisor's `fleet verify --auto-sync` runs) leaves it alone, says so, and records it in
`.fleet/sync-deferred.user-claude`. No restart syncs it, so the supervisor's next tick posts one
`fleet notify --level action` (incident `sync-deferred-user-claude`, linked like the session ones) asking you to run
`fleet sync`, resolved once `~/.claude` is synced. Meanwhile `fleet verify` does not hold the monsters for it
(engsys#302), in a launch's check as in the periodic one, when every problem it finds in `~/.claude` is an install at
another version than the pin and each of those installs matches its own release, file by file, the same test as for a
running session's deferred dir. A changed file of the old version, an old release that can't be checked (its tag gone
included) or any other problem stays a mismatch and holds, as before. The trade-off (as in engsys#253): until that
`fleet sync`, the interactive roles, and the security reviews they dispatch, run on an older release, one that still
matches its own tag.

**A re-cut pinned tag** (engsys#214, #216). A pinned release tag can be moved on origin (a re-cut). Sync asks
origin (`git ls-remote`, the peeled tag) whether the checkout's local copy of the pinned tag is still origin's
commit, for the engsys checkout, the engsys worktree under `FLEET_ISOLATE_ENGSYS_WORKTREE=1` and the instance
repo alike (one shared check, `fleet_pin_recut`). On a difference it re-fetches the pinned tag, and only that
tag, from origin, moves the checkout to the new commit and re-executes; `--check` reports it as drift
(`stale local copy of <tag>`). Offline (`ls-remote` fails) it warns and keeps going on the local copy.
Origin is the trust root and adopting a re-cut is intended, but a release tag moving under a pinned fleet could
also be a mistake or a compromised push, so adopting it sends a `fleet notify` alert (engsys#217): the tag and the
old and new commit ids, nothing else (no paths, no probe output). It goes out from the kit that is running,
before the checkout moves to the re-cut code, so the new code can't be what decides whether it is sent. It is
latched once per tag and commit pair in `.fleet/pin-recut.alerted`, written only after delivery; an alert that
could not be delivered stays in `.fleet/pin-recut.pending` and the next sync retries it. A failed alert never blocks the sync.
The latch is a file in `.fleet/`, so it is host state: a process running as the same user could pre-seed it and
silence the alert for a pair it has chosen. That is an accepted residual (it already could edit `fleet.conf` or the
kit's state); the alert is detection of a moved tag, not isolation.
A re-cut leaves the marketplace ref and the plugin version unchanged, so installed plugins would stay on the old
commit: sync records the moved marketplace in `.fleet/pin-recut.reinstall` and reinstalls its plugins in every
config dir (remove, add `#<ref>`, install), and copies the Copilot and Antigravity plugin caches again (engsys#219).
The entry is removed only after every dir and cache the run covers has been done, so an interrupted sync, or a
`~/.claude` marketplace that sync had to refuse, is finished by the next one; `fleet sync --check` reports it
as drift (`waiting for a plugin reinstall`) until then. Each dir and cache that has been reinstalled is recorded in
`.fleet/pin-recut.done` and is not reinstalled again (engsys#253). So a running session's dir, left to its restart
and reinstalled by it, counts as done, and the next sync clears the entry without reinstalling the other dirs.

### Recipes

**Ship an instance change** (anything merged to the instance repo's default branch: context, configs,
models in `fleet/fleet.conf`, roster, host templates):

```bash
fleet pin --release next
```

`next` is the next patch tag (`v0.1.1` to `v0.1.2`), or pass an explicit `vX.Y.Z`. A release is tagged on
the default branch itself (eric-sabe/engsys#227), so the version has to land there first, through a PR, in two
runs of the same command:

1. **Release PR.** The release version is stamped as `metadata.version` in `.claude-plugin/marketplace.json`
   and `version` in every plugin it lists (Claude Code caches plugins by version, so every release needs a
   distinct one, and you never edit versions by hand), then `claude plugin validate` (with a scratch config
   dir). When the default branch doesn't carry that version yet, the stamp is pushed to `release/vX.Y.Z`
   and opened as a PR titled `release: vX.Y.Z` on the instance repo, and `fleet pin` **stops with exit 3**,
   printing the PR URL: nothing is tagged and no pin PR is opened, even with `--engsys` in the same command.
   Re-running while that PR is open reports the same PR; it never opens a second one. If the PR was closed
   without merging, a re-run says so and re-creates it (the `release/vX.Y.Z` branch is force-pushed again
   and a new PR is opened); to abandon a release, don't re-run.
2. **Tag.** Merge the release PR (any merge method), then re-run the same command. The default branch now
   carries the version, so the run tags the default branch's commit itself (an annotated tag), pushes the
   tag, creates the GitHub release (`--verify-tag`) and goes on to the pin PR below.

An existing tag is used as is (that is how you roll back); a new version below the latest tag, or below the
version the default branch carries, is refused. `next` picks the version the default branch already carries
when that is past every tag (a merged release PR that is not tagged yet: it is tagged, not bumped again);
otherwise, if the latest tag is the default branch's current commit (nothing new), that release is reused, and
in any other case it is the latest tag's patch + 1. A tag cut before #227 sits on a `release: vX` stamp commit
off the default branch and is never reused, even when nothing else changed: the first `next` after upgrading
opens a release PR for the following patch, which moves the fleet onto a tag on the default branch.
With `RELEASE_CI_REF_FILE` set (an instance-repo path such as `.github/workflows/fleet-tests.yml`), the release PR
also sets that file's `RELEASE_CI_REF_KEY:` line (default `ENGSYS_REF`) to the engsys tag being pinned, which is
checked to exist first, so the instance CI moves with the release instead of in a separate PR (engsys#271).

Then the pin PR: only the marketplace refs change (verified with a `jq` strip-diff), `PREPUSH_SETUP_CMD`
runs first if set, it is pushed normally and an open PR for the same pins is reused. Before any label, the PR
gets one `<!-- mm-handoff -->` comment (engsys#271). It carries an `operator_gate` only when `PIN_OPERATOR_GATE`
is set: where a branch ruleset puts `.claude/settings.json` behind a team review, the merge monster's preflight
already gates the PR at READY (`rulesetGate`). A failed handoff post is a warning; the PR is still labeled.
`REVIEW_CMD`, if set,
runs in the PR's worktree and its output is posted as a comment opening with `REVIEW_MARKER`; if the run
is clean, `READY_LABEL` (default `mm:ready`) is added so the merge monster merges the PR. A non-zero exit
or a match for `REVIEW_BLOCK_REGEX` (default `critical|warning`, case-insensitive) stops the auto-labeling:
read the output, then add the label yourself once you are satisfied. `fleet pin` then waits (up to
`PIN_WAIT_MAX_MIN`, default 240) for the merge and runs `fleet sync`. Ctrl-C while waiting is safe; run
`fleet sync` later. `--no-wait` stops after the PR is queued. Interrupted anywhere? Re-run the same
command: an existing release tag, an open release PR and an open PR for the same pins are reused.

**Adopt an engsys release.** engsys releases are cut by its maintainers, not by the fleet's App. In
engsys, a release starts with a version-bump PR (set `version` in `package.json`, run
`npm run build:plugins` so `.claude-plugin/marketplace.json` and `core/.claude-plugin/plugin.json` match,
and merge to `main`), then `gh release create vX.Y.Z -R eric-sabe/engsys --target main --generate-notes`
(`fleet pin` refuses a tag whose plugin manifests do not match `X.Y.Z`, because Claude Code keys its
plugin cache on the manifest version). If you consume upstream engsys, the tag already exists; if you
consume your own fork, cut the bump commit and release there first. Then on the host:

```bash
fleet pin --engsys vX.Y.Z            # add --release next to ship an instance change in the same PR
```

With `--release next` in the same command, a release that still needs its release PR stops the run first
(exit 3, no pin PR): merge the release PR, then re-run the same command to get the one pin PR for both.

**Then, when the sessions can go down:**

```bash
fleet status                         # BEHIND = started before the last sync changed something
fleet restart --stale
```

- **Monsters** get a typed rotation request. Each finishes its current step (never mid-merge), posts its
  digest and a final `rotation requested` heartbeat, and stops; the supervisor relaunches it on the new
  versions within about 5 minutes. Check `fleet status` a few minutes later.
- In per-session mode, sync left each running session's own dir behind (engsys#253). Each restart syncs that dir
  just before the new process starts, so `fleet restart --stale` (or one name at a time, as in the canary below)
  completes the upgrade.
- **Interactive roles** are cycled only when idle (`/exit`, then relaunch). A busy one (mid-turn) is
  skipped: re-run later, or `fleet restart acme-build --force` to interrupt it first.
- **Exited or missing** windows are simply relaunched.
- `fleet restart` with no arguments is `--status`; `--all` cycles every session; names cycle just those.

### Evaluating an engsys release before you pin it

engsys is upstream. Read before you adopt, and adopt one session first.

1. **Read what changed** (from the host):
   ```bash
   git -C ~/git/engsys fetch -q --tags
   git -C ~/git/engsys log --oneline <current>..<new>
   git -C ~/git/engsys diff --stat <current>..<new>
   gh release view <new> -R eric-sabe/engsys
   ```
   Look hardest at `core/skills/merge-monster/**` and `core/skills/maintenance-monster/**` (the unattended
   monsters' protocols), `core/skills/agent-sessions/**` and `core/fleet/**` (launcher, supervisor and kit;
   run by the host, not the plugin), hooks and permission behavior (`core/.claude-plugin/`,
   `core/templates/settings.json.tmpl`), and `core/templates/CLAUDE.md.tmpl` (conventions injected into
   every session). A change there deserves a line in your pin PR and a watchful first day.
2. **Try it without touching anything** (laptop or host, with a throwaway Claude config):
   ```bash
   export CLAUDE_CONFIG_DIR="$(mktemp -d)"
   claude plugin marketplace add https://github.com/eric-sabe/engsys.git#<new>
   claude plugin install engsys@engsys && claude plugin validate "$CLAUDE_CONFIG_DIR/plugins/marketplaces/engsys"
   cd ~/git/repo && claude     # try the commands and skills that changed; /exit
   rm -rf "$CLAUDE_CONFIG_DIR"; unset CLAUDE_CONFIG_DIR
   ```
3. **Canary on the fleet, in this order:**
   1. `fleet pin --engsys <new>` (installs; restarts nothing).
   2. `fleet restart acme-build` only, then give it one real task.
   3. The other interactive roles: `fleet restart acme-investigate acme-design`.
   4. **The monsters last**, the security monster first and the merge monster after it
      (`fleet restart acme-maintain`, then `fleet restart acme-mm`). Watch each one's ledger for a full
      cycle before moving on. Monsters run unattended with bypassed permissions and hold batons, so
      they get the release only after cheaper sessions have shown it is sound.
4. **Back out** at any point: see Rollback.

### Rollback

`fleet pin --engsys <previous> --release <previous>` (existing tags are reused as-is), then
`fleet restart --stale`. Because sessions keep their loaded versions until restarted, a bad release that
you have not yet restarted onto costs nothing but a pin PR. For an emergency without a PR, set
`ENGSYS_REF` and/or `INSTANCE_REF` in `~/.config/<org>/fleet.local.conf`. `fleet sync` will follow that
override; remove it once the rollback PR has merged, or the two sources of truth will disagree.

### Plugin integrity: `fleet verify`

The merge and maintain monsters run with bypassed permissions. The engsys singleton-write guard hook
lets one plain call of a fenced wrapper (`mm-act.sh`, `mm-baton.sh`, `mm-heartbeat.sh` and the `mnt-*`
versions) through, recognising each wrapper by its path in the plugin cache
(`~/.claude/plugins/cache/<marketplace>/engsys/<version>/`). The sessions run as the same macOS user that
owns that cache. A session that rewrote a wrapper, the hook, another hook registered beside it, or the
lease code the wrappers run could get a raw GitHub write past the guard. `fleet verify` detects that. It
does not isolate the sessions from the cache: everything on the host runs as one user, so the check makes
tampering harder and visible, and no more.

**The root of trust is GitHub.** `fleet verify` reads the pinned engsys tag through the tag namespace
(`git/ref/tags/<tag>`, so a branch with the same name can't stand in), checks that its commit is on the
repo's default branch (a tag pushed on an unmerged commit is a mismatch), and reads that commit's tree.
It hashes each protected file in the installed plugin the way `git hash-object` does and compares it with
the blob in that tree. Owner, repo and tag come from the engsys pin in the pin repo's
`.claude/settings.json`, the same source `fleet sync` uses, and the pin must be a release tag (`vX.Y.Z`).
No hash list is kept on the host or in the instance repo, because the sessions can write both.

**What is protected: the whole install root.** Every regular file under the install directory must be a
`core/` file of the verified commit, with the same content. An extra file anywhere is a mismatch, and so is
a release file that is missing or a symlink. That matters because Claude Code loads files from fixed
places that nothing references: a planted `hooks/hooks.json` (merged with the plugin's hooks), `.mcp.json`,
`bin/` (put on the Bash tool's PATH), `monitors/monitors.json`, `settings.json` or `skills/<x>/SKILL.md`
would each get past the guard while every referenced file still matched. The only thing skipped is Claude
Code's own `.in_use/` directory of PID markers at the top of the install root. On a healthy host the
install holds exactly the release's `core/` files (231 at v1.11.1), so `fleet verify` reports that count.

**Which install.** It runs `claude plugin list --json` in `PIN_DIR`, where the sessions start, and looks at
every `engsys@<marketplace>` entry that applies there (user scope, or a project entry for `PIN_DIR`),
enabled or not. An applicable entry at another version, two different install paths, or a plugin that is
disabled there is a mismatch.

Where it runs:

| When | What happens on a mismatch, or when the check can't run |
|---|---|
| `fleet launch` of a merge or maintain session (a named one, or the whole roster) | a named one is refused; a whole-roster launch leaves them out and starts the rest. Other sessions are never checked. One alert per incident |
| every supervisor tick, when a merge or maintain monster is supervised | no relaunch of those monsters until the check passes, said once on the monster's ledger. A running session is never killed for it: check it yourself. One alert per incident |

Merge and maintain sessions start only on a pass. A check that can't run (GitHub unreachable, no pin, the
plugin not installed) holds them just like a mismatch, under its own alert
(`wrapper-integrity-unverified`, next to `wrapper-integrity` for a mismatch), so you can tell an outage
from a tampered file. A monster can't merge without GitHub anyway, and the supervisor tries again every
tick. The mismatch alert repeats when the set of differing files changes.

**The escape hatch** is typed by a person: `fleet launch <name> --skip-verify`, from an interactive
terminal only. It prints a warning and posts an alert (`wrapper-integrity-skipped`); if the alert can't
be delivered (to Slack or the fallback issue), the launch is refused. No config file or environment
variable turns it on, and the supervisor never uses it. Alert text is escaped for Slack, so a file name
in an alert can't turn into a link or a mention.

**A forced engsys ref.** When `ENGSYS_REF` is overridden (in `fleet.local.conf` or the environment, the
emergency rollback path) and differs from the pin, `fleet verify` says so on every run and alerts once
(`engsys-ref-forced`). An older tag can carry a weaker guard, so the alert asks whoever set it to confirm.

The supervisor asks GitHub at most once every `VERIFY_MAX_AGE_MIN` minutes (default 15; set it in
`fleet.conf` or `fleet.local.conf`). Between calls it hashes the local files each tick and reuses the last
pass only while they are unchanged. That cache (`.fleet/verify-wrappers.json`) is host state a session can
rewrite, so it only bounds how quickly the supervisor notices; it is not a guarantee (engsys#96). A launch
never uses it and always asks GitHub. `fleet verify` exits 0 on a match, 1 on a mismatch and 3 when it
could not check.

On an alert: look at the running merge and maintain sessions and stop any you don't trust. Then
reinstall the plugin: from a directory outside any project, `claude plugin uninstall --scope user engsys@<marketplace>`,
delete its cache directory, and run `fleet sync`. `fleet verify` should then exit 0, and the next check resolves the alert.

Two settings make the check stronger:

- **A tag ruleset on the engsys repo.** The fleet's GitHub App can push to engsys. If it can create, move
  or delete a `v*` tag, someone can publish a release that matches a tampered cache and point an override
  at it. Add a tag ruleset (Settings, Rules, Rulesets, target: tags, pattern `v*`) that restricts
  **creations, updates and deletions**, with Repository admin as the only bypass (not the App).
- **Optional: lock the cache files.**
  `find ~/.claude/plugins/cache/<marketplace>/engsys/<version> -type f -exec chflags uchg {} +` makes the
  files immutable until someone clears the flag (`chflags nouchg`). Flag the files, not the directories:
  Claude Code writes a marker file into the version directory. The owner can still clear the flag, so this
  only stops casual writes. Clear it before `fleet sync` removes that version.

**The host kit.** The fleet kit runs from the host engsys checkout (`ENGSYS_DIR`), not from the plugin
cache. `fleet verify` compares the whole `core/fleet/` and `core/lib/` trees there (the gh shim, `git-env.sh`,
the lease and baton code, the verifier itself) plus the supervisor and launcher scripts with the same
release tree: a modified, missing or extra file there is a mismatch too.

**The instance marketplace's plugins** (engsys#196). Every plugin that `PIN_SETTINGS` enables from
`INSTANCE_MARKETPLACE` (a fleet's own plugin pinned beside engsys) loads hooks into the monsters and the
attended roles, so its install is held to its own marketplace's release: `INSTANCE_REF` on that
marketplace's repo, which must be a release tag (`vX.Y.Z`), in each dir `fleet verify`
covers (the fleet's config dir and, under `FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised`, `~/.claude`). The
directory the plugin is built from is the `source` of its entry in `.claude-plugin/marketplace.json` **at
that release, read from GitHub** (a local file never says where to look); it must be one `./` path inside
the repo. The check is the same as for engsys: every file under the install is a blob of that directory at
the tag, a missing, extra or modified file is a mismatch, and a symlink is `not-a-file`. Fail closed: an
enabled instance plugin that is not installed, a pin that is not a release tag, or a release whose marketplace
file doesn't name exactly one `./` source for the plugin is "not verified" (exit 3), which holds the merge and
maintain sessions like any other check that can't run.

**The engsys marketplace's stack packs** (engsys#224). Every other plugin that `PIN_SETTINGS` enables from the engsys
marketplace (`engsys-azure`, `engsys-typescript`, `engsys-web`, ...) loads skills, agents and hooks too, so it gets the
same check against the **engsys release itself** (`ENGSYS_REF` on the engsys repo; the pack's directory is the
`source` of its entry in that release's `.claude-plugin/marketplace.json`, for example `./stacks/lang/typescript`),
in every dir covered above. A tampered, missing or extra file is a mismatch (named as an `engsys stack pack` in the
launch-hold message); a pack the pin enables but that is not installed, or that the release's marketplace file does
not list, is "not verified". A real install is byte-identical to its release directory (Claude Code adds only `.in_use/`,
which the scan skips), so enabling a pack in the pin needs no allowlist.

**The instance release must be on its default branch** (eric-sabe/engsys#227), like the engsys release: its tag
must be the default branch's tip or an ancestor of it (GitHub's `compare` says `identical` or `ahead`). Anything
else (`diverged`, `behind`) is a mismatch, `release    <plugin>: vX.Y.Z of <repo> is commit ..., which is not on main`,
alerted and holding merge and maintain launches like any other (`components: instance release (...)` in the
launch-hold message). To recover, cut a release on the default branch: `fleet pin --release next` opens the release
PR, merge it, then re-run the same command (section 7, recipes). Tags cut by `fleet pin` before #227 sit on a
`release:` stamp commit off the default branch, so a fleet still pinned to one is held until it moves to a newer
release. The `INSTANCE_OFF_MAIN` setting of the warn-only stage is gone: `fleet verify` notes a leftover line in
`fleet.conf` and ignores it. A mismatch's launch-hold message names what failed (the engsys plugin, a stack pack,
an instance plugin, an instance release, the host kit, ...).

**The pin checkout's `.claude/` and its hooks.** Claude Code loads `PIN_DIR/.claude/` (settings, hooks,
agents, commands, skills) into every session, and a settings hook runs whatever script it names. Its trust
root is `PIN_REPO`'s default branch as the GitHub API reports it, never a local ref (`origin/HEAD` and
`refs/remotes/*` can be repointed by anything on the host):

- `PIN_DIR`'s HEAD must be that branch's tip or an ancestor of it (GitHub's compare says `identical` or
  `behind`). Ahead, diverged, or a commit GitHub doesn't have is a mismatch.
- The files a session loads on its own are compared with HEAD's tree (read from the API): everything
  under `.claude/`, every `CLAUDE.md` and `CLAUDE.local.md` in the checkout (dependency `node_modules/`
  trees aside), `.mcp.json`, and what a tracked symlink among them points at. Nothing may be modified,
  missing or untracked. Claude Code's own runtime files (`.claude/settings.local.json`, checked
  separately, `.claude/scheduled_tasks.lock` and `.claude/worktrees/`) are skipped, matched
  case-insensitively as APFS does.
- When HEAD is behind the tip, every one of those files, and every settings-command target, must also be
  identical at the tip: an older hook, skill or `CLAUDE.md` is a mismatch (`stale …`; run `fleet sync`).
  Only a lag in other code is a warning, so a merged pin PR never turns into a false mismatch.
- Every script a `settings.json` hook or command key (`statusLine`, `apiKeyHelper`, any `*Helper` /
  `*Command`, …) names must be an absolute path (write it as `"$CLAUDE_PROJECT_DIR/…"`; `bash hook.sh` or
  `./hook.sh` is a mismatch) to a regular file inside the repo, tracked at HEAD and unchanged. A hook that runs a path outside the repo, or has any other variable or command substitution
  in it, is a mismatch. A command is accepted only from an allowlist (engsys#185): an
  interpreter (`bash`, `sh`, `zsh`, `node`, `python*` including `python3.12`, `perl`, `ruby`) with an absolute
  script that is tracked at HEAD; a root-owned system program from the short `SAFE_PROGRAMS` list (`true`, `echo`,
  `sleep`, `date`, `cat`, ...), which runs nothing named in its arguments; or a system wrapper (`nice`, `nohup`,
  `timeout`, `xargs`, `time`) whose wrapped command passes the same rules, so a bare-name program after a
  wrapper (`nice somecli`, `xargs env mybin`) is refused like one at the top; `env` is stricter still and may only
  start one of the listed interpreters, without options or assignments. A wrapper must name its own command, and
  `xargs` accepts only its batching options (no `-a`, `-I`, `-J`). Any other system program (`git`,
  `awk`, `sed`, `find`, `perl -e`, `osascript`, ...) is a mismatch. A task runner or package manager
  (`npm run …`, `pnpm`, `yarn`, `npx`, `make`, `just`, `gradle`, `cargo`, …; `TASK_RUNNERS` in
  `lib/verify-wrappers.mjs`) is refused however it is reached, by its file name: bare, by absolute path, through a
  wrapper, `env` or `sh -c`, as `gradlew`, or as a package manager's launcher script run by node (`yarn-4.1.0.cjs`,
  `npm-cli.js`). Such a runner executes whatever `package.json` or a `Makefile` says, and verify doesn't compare those
  files with GitHub. There is deliberately no allowlist for it. The way out is a direct script that the hook names
  (`bash "$CLAUDE_PROJECT_DIR/scripts/lint.sh"`): the script is tracked at HEAD and compared byte for byte. What that
  script itself calls or imports is not followed, so keep it self-contained and review it as hook code. (A plugin's
  own `hooks.json`, written with `${CLAUDE_PLUGIN_ROOT}`, is not parsed here: the plugin's files are hash-checked.)

Claude Code's own runtime state under `.claude/` is skipped by an explicit list, matched
case-insensitively: `settings.local.json` (checked separately), `scheduled_tasks.lock`, `worktrees/`,
`checkpoints/`, `mailbox/`, `routines/.state/`, `agent-registry.json`, `agent-memory-local`, `first-run` and
`assistant-daemon-state.json`. Git ignore rules never exempt anything: a session can write
`.git/info/exclude`. A memory file (`CLAUDE.md`, `CLAUDE.local.md`, any case) is never exempt, in any
directory, and neither is anything under `.claude/commands`, `agents`, `skills`, `rules` or `hooks`.
Claude Code reads a nested `CLAUDE.md` when it works in that directory, so an untracked one anywhere in the
checkout (a stray `tmp/claude.md` too) is a mismatch. `.claude/scheduled_tasks.json` holds prompts Claude
Code runs on its own: absent or empty passes; otherwise it is a mismatch unless `VERIFY_ALLOWED_USER_FILES`
lists its sha256.

**A pin checkout behind main.** The supervisor's check runs `fleet verify --auto-sync`: when the only
problems are `stale` files and the pin checkout is on the default branch with no uncommitted changes to
tracked files (and nothing untracked in `.claude/`), it runs `fleet sync --no-jobs` itself (fast-forward and
plugin reconcile, no restarts), at most once per tick, and verifies again. It does so while sessions run too: sync
leaves a running session's own dir to that session's restart (engsys#253). `--no-jobs` never reloads
launchd jobs (the supervisor runs inside one, and a reload would kill it): if the job files changed with
the pin, it alerts `fleet-jobs-changed` asking you to run `fleet install-jobs`. A dirty, diverged or off-branch
checkout keeps the mismatch, alerted as "the pin checkout is behind main", not as tampering.

A `PIN_DIR` that is not a git checkout can't be checked this way: `fleet verify` warns, and any hook in its
settings is a mismatch.

**User-scope settings.** `fleet verify` also reads `settings.json` and `settings.local.json` of the Claude
config dir the sessions use (`FLEET_CLAUDE_CONFIG_DIR`, else `~/.claude`): a plugin the pin repo doesn't
enable is a mismatch unless `VERIFY_ALLOWED_USER_PLUGINS` lists it (§ 6.1). A user-scope hook or command
key (`statusLine`, `fileSuggestion`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
`gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, any `*Helper` / `*Command`), and any such command
key in the project's untracked `settings.local.json`, is a mismatch unless `VERIFY_ALLOWED_USER_HOOKS` lists
its content hash: the mismatch line prints it (`sha256 …`), and any change to the command, the
interpreter it uses or a file it runs changes it.

A command is pinned only when everything it runs is known: each part (split on `;`, `|`, `&&`, `||`) is a
no-op (`echo`, `printf`, `true`, …), an interpreter (`bash`, `sh`, `zsh`, `node`, `python`, `python3`, found
only in `/bin`, `/usr/bin`, `/opt/homebrew/bin` or `/usr/local/bin`) running a script, or an absolute path
to a regular file, and every file it names is an absolute path to a regular file. Only `~`, `$HOME` and
`$CLAUDE_PROJECT_DIR` are expanded. Always a mismatch: other variables, command substitution, globs,
`~user`, brace expansion, `<` redirects, output redirects other than to `/dev/null`, subshells, env
assignments, any other program found on `PATH`, relative paths, directories, symlinks, missing files,
interpreter flags that run inline code (`-c` / `-e` / `-m` / `--require` …), and `sh -c` nested more than
once. A script's own imports or `source`s are not followed: keep each allowlisted hook a single
self-contained file. The same rules apply to project hooks, whose files must also be inside the repo.

**The launcher's messaging settings.** Every session starts with
`--settings ~/.claude/<namespace>-messaging-settings.json`, which the launcher writes. `fleet verify` requires
it to hold only the keys the launcher sets (`crossSessionInbound`); any other key (`hooks`, `env`, `model`,
`statusLine`, …) is a mismatch.

**User-scope configuration besides settings.** Every file under `<config dir>/agents`, `commands`,
`skills` and `rules`, a `<config dir>/CLAUDE.md`, `CLAUDE.local.md` or `memory.yml`, and every MCP server definition (`mcpServers` in the user
state file, which is `<config dir>/.claude.json` with `FLEET_CLAUDE_CONFIG_DIR` and `~/.claude.json`
without it, the `projects[<PIN_DIR>]` entry there, and `settings*.json`) is a mismatch unless
`VERIFY_ALLOWED_USER_FILES` lists its sha256 (printed in the mismatch line). The plugin caches under
`<config dir>/plugins/` are pinned by the checks above instead. A `CLAUDE.md` or `CLAUDE.local.md` in any
directory above `PIN_DIR`, up to `$HOME`, is always a mismatch. On a host shared with a person this trips
on their own agents, skills and MCP servers: that is what a separate `FLEET_CLAUDE_CONFIG_DIR` avoids.

`memory.yml` (engsys#230) holds the memory brief's trust lists (`operator_user_ids`, `trusted_member_user_ids`,
signing keys), which are unioned with the repo's, so an edited or planted copy adds trust. Allowlist the hash of
the **reviewed** copy (the one in your instance repo at its pinned tag), never a hash read off the host:

```sh
{ printf 'engsys-user-file-v1\0memory.yml\0'; git -C <instance repo> show <tag>:<path to memory.yml>; } | shasum -a 256
```

An absent `memory.yml` passes: no copy adds no trust. With one login per session, each
`<FLEET_CLAUDE_CONFIG_DIR>.sessions/<name>` is checked the same way, so a copy there passes only if it is the
reviewed one. The sessions load the fleet dir's `memory.yml` (`ENGSYS_MEMORY_CONFIG` on their launch line, engsys#262), so
every `fleet verify --session <name>` also checks `<FLEET_CLAUDE_CONFIG_DIR>/memory.yml`, with the same rules: a
drifted copy holds every session.

An `ENGSYS_MEMORY_CONFIG` that resolves inside a repo checkout (the session's repo, any of its git worktrees, or its
git dir; symlinks followed) is repo-controlled, so the memory brief refuses it and falls back to
`$CLAUDE_CONFIG_DIR/memory.yml`, then `~/.claude/memory.yml` (engsys#268). That fallback is silent apart from one
line on the brief's stderr, which the hook discards, so a fleet whose config dir sits inside a checkout would run on
the wrong `memory.yml` without saying so. Keep `FLEET_CLAUDE_CONFIG_DIR` outside every repo (the default
`~/.config/<org>/claude` is). Settings `env` can't set it either: `fleet verify` flags every `ENGSYS_*` key there.

When the federation file declares `operators_team`, the `operator_user_ids` in that `memory.yml` must be exactly
the team's members (numeric user ids). Keep the team closed with no child teams: GitHub counts a child team's
members as members. A listed id that is not a member, or a member who is not listed, is a mismatch. A team that
can't be read (network, token scope, the wrong App installation) is "not verified", never a pass. The team is
read with `PIN_DIR` as the working directory, because the fleet's `gh` shim picks the App installation from the
working directory's `origin` for org-scoped calls (eric-sabe/engsys#257). So the team must be in an org the App
installation for `PIN_REPO`'s owner can read; `fleet verify` warns when the team's org is not `PIN_REPO`'s owner.
Like the release check, a pass is reused within `--max-age` while the local files are unchanged, so a membership
change shows on the next full check.

Only the config dirs `fleet verify` covers are checked: with `FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised`, a
`~/.claude/memory.yml` the interactive roles load is not, so keep any host-side check of that copy until it is.

Also a mismatch, at every scope: `disableAllHooks`, or an
`env` key in a protected family (`ENGSYS_*`, `FLEET_*`, `HARNESS*`, `COPILOT_*`, `AGY_*`, `NODE_*`,
`CLAUDE_PLUGIN_ROOT`, `CLAUDE_CONFIG_DIR`, `PATH`, `GH_*`, `GITHUB_*`) in any settings file, and the
endpoint, credential and provider keys (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, any `*_BASE_URL`, and
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` in any case), and keys that make a shell, git, the
loader or an interpreter load code (`BASH_ENV`, `ENV`, `ZDOTDIR`, `SHELLOPTS`, `BASHOPTS`, `PROMPT_COMMAND`,
`GIT_*`, `DYLD_*`, `LD_*`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5LIB`, `PERL5OPT`, `RUBYOPT`, …). So is a model
override: `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `ANTHROPIC_MODEL`,
`ANTHROPIC_SMALL_FAST_MODEL` or any `ANTHROPIC_*_MODEL` in an `env`, or a top-level `model`,
`availableModels`, `fallbackModel`, `advisorModel`, `modelOverrides`, `deniedModels`,
`enforceAvailableModels` or `switchModelsOnFlag: true` (the model keys of Claude Code 2.1.292's settings
schema): each could move a pinned security agent off its model. The
security lane's rendered env also unsets `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.

**Skills claude.ai syncs into a fleet config dir** (engsys#201). With the account's sync on, Claude Code writes the
account's claude.ai skills to `<config dir>/skills/synced/<orgUuid>_<accountUuid>/` (plus a `.bucket-<id>` marker and a
`manifest.json`), on a personal login and on a Team login alike. The primary fix is to never let them in: `fleet
config-dir init` and `fleet sync` set `syncClaudeAiSkills: false` and `syncClaudeAiPlugins: false` (§ 6.1), and
`fleet verify` warns (`WARNING … does not set … to false`, with the fix command) when a fleet config dir's
`settings.json` doesn't. What is already there is a mismatch, reported as **one line per bucket**
(`… holds N synced claude.ai skill file(s) …`, with a cleanup hint) instead of one per file, and a content-only
update to a bucket doesn't change the alert's fingerprint. To clear it: set the two switches, delete
`<config dir>/skills/synced/`, and run `fleet verify`. A synced skill is deliberately **not** trusted by source:
the bucket id, its marker, its `manifest.json` (`source`, `creatorType`) and the files it lists all sit in the
config dir, where any session of this user can write them, and the manifest carries no content hashes, so a
forged manifest plus a planted `SKILL.md` would look exactly like a real sync. There is no allowlist by bucket or
author. The only exception is the existing one: an operator who reviews a file can list its sha256 in
`VERIFY_ALLOWED_USER_FILES`, and it then has to be re-approved when upstream changes it.

**The alert** names the total and the categories (engsys plugin or host kit, pin checkout, unpinned
user-scope plugins, MCP servers, user-scope skills/agents/files, user-scope hooks and commands, settings,
memory files above the pin checkout), lists the first few problems, and for user-scope items points at
`fleet config-dir init`. It is posted again only when the categories or counts change, or a different
plugin or pin-checkout path differs: a user-scope skill sync that rewrites files doesn't re-alert.

**A mismatch never touches a running session.** The supervisor holds relaunches of the merge and
maintain monsters and alerts; it does not kill a running one and never revokes or breaks its baton. A
session that is already dead or stale is relaunched once the check passes, as usual.

Outside the check: shell rc files, the `node` and `claude` binaries, and a running monster's loaded files
(kept until it is stopped).

### Humans' machines

Laptops do not follow the pins automatically: the marketplaces are pinned by tag and never auto-update.
After a pin PR merges, on each machine that works in the pin repo:

```bash
jq -r '.enabledPlugins | to_entries[] | select(.value == true) | .key' .claude/settings.json   # note the enabled list first, from the pin repo
cd ~                                                        # then leave the repo: see below
claude plugin marketplace remove engsys --scope user && claude plugin marketplace add https://github.com/eric-sabe/engsys.git#<engsys tag> --scope user
claude plugin marketplace remove acme --scope user   && claude plugin marketplace add https://github.com/acme/acme-fleet.git#<instance tag> --scope user
# then: claude plugin install <name> --scope user, for each name in the list
```

Run the `claude plugin` commands from outside the pin repo, with `--scope user`. A `marketplace remove`
without `--scope` also deletes the marketplace and its plugins from the project's `.claude/settings.json`
(engsys#112). If it does, `git checkout -- .claude/settings.json` restores it.

Then restart open sessions.

---

## 8. Models

Models are **instance configuration**: knobs in `fleet/fleet.conf`, rendered into env files and roster
flags by `fleet launch`. engsys sets no model policy; this section is the pattern that works.

The scaffold creates the first knobs (`OPUS_MODEL`…`HAIKU_MODEL`, `SECURITY_MODEL`, and `<ROLE>_MODEL` /
`<ROLE>_EFFORT` for `MM`, `MAINTAIN`, `BUILD`, `INVESTIGATE`, `DESIGN`); the names are conventions, not
requirements. Its defaults: the merge monster on the judgment tier at high effort, the maintenance monster
on `SECURITY_MODEL` (keep `MAINTAIN_MODEL` equal to it), interactive roles on the judgment tier at medium. Any key you
define in `fleet.conf` is available to every template as `__KEY__`.

### Alias pins

Personas and skills refer to model **aliases** (`opus`, `sonnet`, `haiku`, ...). A Claude Code release can
silently re-point an alias, which changes fleet behavior without any pin moving. Pin the aliases in the
session env instead, so an alias moves only when you change it, deliberately, like the plugin pins:

```
# fleet/env/session.env.tmpl
ANTHROPIC_DEFAULT_OPUS_MODEL=__OPUS_MODEL__
ANTHROPIC_DEFAULT_SONNET_MODEL=__SONNET_MODEL__
ANTHROPIC_DEFAULT_HAIKU_MODEL=__HAIKU_MODEL__
```

with `OPUS_MODEL=<model id>` and so on in `fleet.conf`. `session` is the default lane: the roster's
`ENV_FILE=__ENV_DIR__/session.env` header injects it into every window (a pre-existing tmux server does
not inherit exports, so the launcher writes the env into each window's command line).

### Per-role model and effort

Put `--model` and `--effort` in the roster line's extra flags, fed by per-role knobs:

```
acme-mm|__PIN_DIR__|/engsys:merge-monster|--model __MM_MODEL__ --effort __MM_EFFORT__ --remote-control --dangerously-skip-permissions
acme-build|||--add-dir __WORKTREES_DIR__ --model __BUILD_MODEL__ --effort __BUILD_EFFORT__ --remote-control --permission-mode auto
```

Subagents inherit the session's effort (there is no per-subagent effort), so the session's setting is the
one that counts. Persona files that say `model: sonnet` or `model: opus` resolve through your alias pins.
Humans' own sessions are not pinned by the fleet; carry any hard rule (for example the security rule
below) in your instance plugin's org context so it reaches them too.

### The security lane: the 5th roster field

Some models run a safety classifier that reroutes, or refuses, requests that look like offensive-security
work, and the whole domain of a security or dependency watchdog can trip it. Pin that lane to a model whose
behavior is predictable for that domain, and keep it separate from the rest of the fleet.

The launcher's optional 5th roster field does this without a second roster. A session line becomes
`name|workdir|prompt|extra|env`; the env file (absolute, or relative to the roster's directory)
**replaces** the roster-level `ENV_FILE` for that session:

```
acme-maintain|__PIN_DIR__|/engsys:maintenance-monster|--model __MAINTAIN_MODEL__ --effort __MAINTAIN_EFFORT__ --remote-control --dangerously-skip-permissions|__ENV_DIR__/security.env
```

```
# fleet/env/security.env.tmpl
. "__ENV_DIR__/session.env"                     # build on the shared env, then point the aliases at the lane's model
ANTHROPIC_DEFAULT_OPUS_MODEL=__SECURITY_MODEL__
ANTHROPIC_DEFAULT_FABLE_MODEL=__SECURITY_MODEL__
```

A missing per-session env file is an error for that session; it never silently falls back. With the 5th
field present the extra flags must not contain a literal `|`. Dispatch any threat-modeling task in another
session explicitly with the same model.

**Nyx carries the pin itself.** `core/agents/nyx.md` sets `model:` to the same full model ID as the
scaffold's `SECURITY_MODEL` (a test keeps the two equal). A subagent whose frontmatter says `opus` runs the
parent session's own model, whatever `ANTHROPIC_DEFAULT_OPUS_MODEL` says, and a per-call `model:` on the
Agent tool takes only a tier alias, so the frontmatter is the one pin that holds in every session.
**Dispatch Nyx without `model:`**: any value you pass replaces the pin with an alias. If you change
`SECURITY_MODEL`, change nyx's frontmatter in the same commit.

### Escalation: effort before tier

When work needs more, **raise effort first** (medium, then high, then extra high). Switch to the top model
tier only for architecture, cross-cutting refactors, concurrency or migrations. **Security escalation
stays on the security lane's model at higher effort;** moving it to a model that classifies security work
is what you pinned against.

### Changing a model, and rolling a change out

1. Edit the knob in `fleet/fleet.conf`, PR it to the instance repo.
2. `fleet pin --release next`: it opens the instance release PR and stops; merge it, then re-run the same
   command (tag, pin, sync). Alternatively try a value on one host first by putting it
   in `~/.config/<org>/fleet.local.conf` and running `fleet restart <session>`.
3. `fleet restart <session>` when it can go down. Monsters pick the new env on relaunch.
4. Stage it: interactive roles first, then the monsters after a week of clean journals. Before promoting an
   unattended lane to a model with a classifier, verify that an unattended session does not stall on a
   fallback notice (search its transcript for a model-switch message and confirm the session carried on).

**Verify a session's model:** `/model` inside the session shows model and effort. From the host,
`tmux list-panes -a -F '#{window_name} #{pane_start_command}'` shows the `--model` and `--effort` each
window launched with.

---

## 9. Verified plugin mechanics

Behaviors the kit is built on, verified on Claude Code 2.1.280 in an isolated config. Re-verify after a
major Claude Code upgrade.

- A marketplace added as `…repo.git#<tag>` is **sticky**: `claude plugin marketplace update` and
  `claude plugin update` never move it. Moving a pin means removing and re-adding the marketplace, which
  `fleet sync` does.
- `claude plugin marketplace remove <m>` **uninstalls every plugin from that marketplace.** Re-adding at the
  new tag and reinstalling puts the new version in a new cache directory
  (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`).
- The cache is **keyed by version**, and **old cache directories stay on disk**. So **running sessions keep
  working until they are restarted**, which is exactly why sync and restart are separate steps.
- Because the cache is keyed by version, two releases carrying the same plugin version can collide. That is
  why `fleet pin` stamps a fresh version into every release.
- Plugin content refers to files as `<engsys-root>/…`. In plugin mode that is the plugin's per-version
  cache path, which is why host scripts, launchd jobs and the supervisor use the pinned `ENGSYS_DIR`
  checkout instead.
- If `marketplace add` fails midway (network, auth), the marketplace's plugins are **uninstalled on this
  host** until you re-run `fleet sync`. Running sessions are unaffected.
- `claude plugin marketplace remove <m>` without `--scope` removes the marketplace "from every scope",
  **including the `.claude/settings.json` of the project you run it in**: its `extraKnownMarketplaces`
  entry and the `enabledPlugins` that belong to it (engsys#112, Claude Code 2.1.28x). `fleet sync` therefore
  passes `--scope user` to every `claude plugin` mutation and runs them from an empty temp directory. It
  snapshots the pin repo's settings files first; if one changes anyway, it restores it and fails without
  printing "synced".
- `claude plugin list --json` also lists per-project installs (`scope: "project"`, with a `projectPath`).
  `fleet sync` counts only `scope: "user"` installs, and checks each enabled plugin's version against a
  `vX.Y.Z` pin.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `fleet: no fleet instance` / `fleet/fleet.conf not found` | run inside the instance repo, or pass `--instance <dir>`, or set `FLEET_INSTANCE` |
| `template … needs NAME` | a `__NAME__` in a template has no value. Set it in `fleet/fleet.conf` or `~/.config/<org>/fleet.local.conf`. An empty value counts as unset |
| `WARNING engsys checkout is at X, the pin is Y` | the host is behind the pins. Run `fleet sync` |
| `no 'engsys' pin found in …settings.json` | the pin repo's `.claude/settings.json` lacks `extraKnownMarketplaces.<name>.source.ref`, or `ENGSYS_MARKETPLACE` names the wrong marketplace |
| `… has uncommitted changes to tracked files` | sync will not clobber a checkout. Inspect with `git -C <dir> status` and `git diff --stat`; mode-bit or line-ending noise (`git diff` shows no content change) can be discarded with `git checkout -- .`, then re-run |
| `pin checkout … can't fast-forward` | the sessions' checkout is not on a clean default branch. Sync proceeds from `origin/<default>`'s pins, but sessions read the working tree; put it back on the default branch |
| `marketplace add … failed — plugins are UNINSTALLED` | a network or auth hiccup mid-swap. Running sessions are unaffected; re-run `fleet sync` |
| `… changed project settings (…); restored them from the snapshot. NOT synced` | a `claude plugin` call edited the pin repo's settings despite `--scope user` and the neutral cwd. Sync put the file back. Re-run `fleet sync`; if it repeats, the CLI changed behavior: report it on engsys#112 |
| `… not installed at the pin: <plugin> (at X, pin Y)` | an enabled plugin is missing or at another version after the plugin step. Re-run `fleet sync`; if the version stays wrong, `claude plugin uninstall --scope user <plugin@marketplace>` from outside any project, then `fleet sync` |
| `still at … after switching` | a checkout did not land on the pinned ref. Check the tag exists on the remote (`git ls-remote --tags origin`) |
| `engsys … has no fleet kit` | the pinned engsys release predates the kit; pin one that includes `core/fleet/` |
| Supervisor log: `RELAUNCH FAILED` with `claude not found on PATH` | the supervisor's launchd PATH can't see `claude`. The default job PATH covers `~/.local/bin` (native installer) and Homebrew; for anywhere else, override the PATH in `<instance>/jobs/launchd/fleet-supervisor.plist.tmpl`. Then `fleet install-jobs` (it warns until every tool resolves) and `fleet launch` for anything missing. The supervisor escalates a failed relaunch once on the ledger and comments again when it recovers |
| Alert `claude-auth-expired-<session>`, or `fleet status` shows `auth (<session>): expired since …` (one login per session) | that one session's own login was lost; the others keep running. `cd "$(mktemp -d)" && CLAUDE_CONFIG_DIR=<its dir> claude`, `/login`, `/exit`. The next supervisor tick tests that dir, resolves the alert and relaunches the session once |
| Alert `claude-auth-expired`, or `fleet status` shows `auth: expired since …` | Claude Code's login on the host no longer works, and the supervisor holds every relaunch so it doesn't relaunch sessions that can't answer. Run `/login` in any session's window (or `cd "$(mktemp -d)" && claude /login` in a terminal). The next supervisor tick sees a working login (a short test request; with `AUTH_PROBE=off`, a held pane answering normally), resolves the alert and relaunches each held session once. Nothing was killed while it waited |
| Launchd job runs but `node: command not found` | node is not in `/opt/homebrew/bin` (nvm/fnm install). Install Homebrew node; launchd does not read your shell profile |
| The fleet stopped after a reboot | the fleet user is not logged in (FileVault disables auto-login). Log in over Screen Sharing (section 6.2) |
| `not launching acme-mm: its engsys plugin does not match vX.Y.Z` | `fleet verify` found protected plugin files, or an install, that don't match the pinned release. See "Plugin integrity" in section 7 |
| `not launching acme-mm: the engsys plugin check could not run` | GitHub was unreachable, the pin is not a release tag, or the plugin is not installed (`fleet sync`). Merge and maintain stay held until `fleet verify` passes; the supervisor retries every tick |
| A session shows `missing` | no tmux window with that name. `fleet launch <name>`; a name outside the namespace is refused by the launcher |
| Session name got a `-2` suffix | a duplicate name existed somewhere under the same OS user, which silently breaks addressing. Stop the old session first, then relaunch |
| Monster asked to rotate but never came back | is the supervisor job loaded (`launchctl list \| grep fleet-supervisor`)? Is its ledger issue open? Look at `~/Library/Logs/<org>-fleet/fleet-supervisor.log` and `logs/fleet-supervisor/supervisor.log` in the instance checkout. A live session is never killed on staleness alone; a closed ledger is never touched |
| Monster scripts print `GH_AUTH_ERROR <script>: …` and exit non-zero, or bare `gh` says "not logged in" in a fleet session | bare `gh` resolved to an unauthenticated binary: a login profile (`eval "$(brew shellenv)"` in `~/.zprofile`) put Homebrew ahead of the identity shim. The engsys SessionStart hook `fleet-gh-path.mjs` re-prepends the shim through `$CLAUDE_ENV_FILE` on every start, resume, clear and compact, and kit scripts call the shim by absolute path (`FLEET_GH`, `core/lib/fleet-gh.sh`), so no `~/.zshrc` edit is needed. If it persists, check the plugin is enabled and `GH_APP_ENV_FILE` is in the session env (`fleet status`), then `fleet restart <name>` |
| `gh-app-token.mjs --check` exits 3 | the token works but permissions are short; the message lists each. Fix the App's permissions, **accept** them on the installation, re-check |
| `gh project list` prints "No projects found" for the bot | the wrong "Projects" row was set. Use the **Organization permissions** one (section 5) |
| The pin PR was not labeled | the review stopped it (a blocking match, a non-zero exit, or `REVIEW_CMD` missing). Read the review output, then add the label yourself and run `fleet sync` after it merges |
| A review CLI reports an invalid organization | its GitHub App was uninstalled. Reinstall it (suspended is fine) |
| Session ignores a new model or config | it has not restarted yet. `fleet status` shows BEHIND; `fleet restart <name>` |

Logs and state: launchd job logs in `~/Library/Logs/<org>-fleet/`; the supervisor's state and log in
`logs/fleet-supervisor/` of the instance checkout; rendered env, roster, `last-change` and `sync.log` in
`<instance>/.fleet/`.

---

## 11. Reference

### `fleet/fleet.conf`

Plain `KEY=VALUE` lines. A line starting with `#` is a comment. No quoting or expansion is performed,
except a leading `~` in a value, which becomes `$HOME`. `~/.config/<FLEET_ORG>/fleet.local.conf` (same
format) overrides it per machine. Environment values for `ENGSYS_REF` / `INSTANCE_REF` also force a pin;
`PIN_SETTINGS` (where the pins are read from) is never taken from the environment.

| Key | Required | Meaning and default |
|---|---|---|
| `FLEET_ORG` | yes | Slug for machine paths and labels: `~/.config/<org>/`, `~/.cache/<org>/`, `~/Library/Logs/<org>-fleet/`, launchd labels `com.<org>.fleet.<job>` |
| `PIN_REPO` | yes | `owner/name` whose `.claude/settings.json` holds the pins |
| `PIN_DIR` | yes | Local checkout of `PIN_REPO`; also the sessions' default workdir |
| `ENGSYS_DIR` | no | The pinned engsys checkout. Default `~/git/engsys` |
| `HARNESS` | no | Primary harness runtime (`claude`, `copilot`, or `antigravity`). Default `claude`. Merge, maintain, broker (any monster) and security-lane sessions launch on `claude` only: `fleet launch` refuses them, or leaves them out of a whole-roster launch, under any other harness, from any source (conf, environment, a roster `HARNESS=` line) |
| `HARNESS_FALLBACK` | no | Fallback harnesses (`copilot,antigravity`) whose plugins `fleet sync` also installs. The supervisor never moves a supervised session (merge, maintain, broker, any monster) to one: the fleet is Claude-only, and a seat limit is only alerted (`seat-limit` incident). Empty is the default |
| `QUOTA_COOLDOWN_MIN` | no | Ignored (accepted from older configs): the supervisor never fails over, so there is nothing to fail back from |
| `ENGSYS_MARKETPLACE` | no | Default `engsys` |
| `INSTANCE_MARKETPLACE` | no | The instance's own marketplace name (for example `acme`). Empty means no instance plugin: no instance release, and the instance checkout is not pinned |
| `WORKTREES_DIR` | no | Agent worktrees directory; created by `launch`; available to templates for `--add-dir` |
| `GH_APP_ENV` | no | Path to the GitHub App env file. Set means identity kit on |
| `FLEET_CLAUDE_CONFIG_DIR` | no | A separate Claude Code config dir for the fleet, with its own login (§ 6.1). Every fleet command and every launched session runs with `CLAUDE_CONFIG_DIR` set to it; `fleet sync` installs the plugins there and `fleet verify` checks it. An absolute path (or `~/…`). Never inherited from the caller's environment. Unset means `~/.claude` |
| `FLEET_CLAUDE_CONFIG_DIR_PER_SESSION` | no | `on`: every session that uses `FLEET_CLAUDE_CONFIG_DIR` gets its own dir, `<FLEET_CLAUDE_CONFIG_DIR>.sessions/<name>`, with its own login, so no two long-lived sessions share a refresh token (anthropics/claude-code#88583; § 6.1). `off` (default) or unset: one shared dir. Needs `FLEET_CLAUDE_CONFIG_DIR`. Never inherited from the caller's environment |
| `FLEET_CLAUDE_CONFIG_DIR_SCOPE` | no | `all` (default): every launched session runs on `FLEET_CLAUDE_CONFIG_DIR`. `supervised`: only the lines positively classified as interactive keep `~/.claude`; everything else (monsters, supervised and security-tier lines, anything unclassified) runs on the fleet dir. `fleet sync` keeps the pinned plugins in both, and `fleet verify` also checks the engsys install in `~/.claude` (§ 6.1). Never inherited from the caller's environment |
| `VERIFY_ALLOWED_USER_PLUGINS` | no | Space-separated `name@marketplace` user-scope plugins `fleet verify` reports as `allowed` instead of a mismatch (§ 6.1). Never inherited from the caller's environment |
| `VERIFY_ALLOWED_USER_FILES` | no | Space-separated sha256 hashes of user-scope agents, commands, skills, rules, memory files, `memory.yml` and MCP server definitions that `fleet verify` accepts (§ 7, "User-scope configuration besides settings"). Never inherited from the caller's environment |
| `SYNC_DEFER_ALERT_HOURS` | no | Hours a session may run on a config dir `fleet sync` left behind the pins (per-session mode) before the supervisor posts one `fleet notify --level action` asking for its restart (§ 7, What sync does). Default 24 |
| `VERIFY_ALLOWED_USER_HOOKS` | no | Space-separated sha256 content hashes of user-scope hooks and settings commands (`statusLine`, `apiKeyHelper`, any `*Helper` / `*Command`, …) that `fleet verify` accepts (§ 7, "User-scope settings"). The hash covers the command and every file it runs, and is printed in the mismatch line. Never inherited from the caller's environment |
| `REVIEW_CMD` | no | Review run in the pin PR's worktree (for example `<your-review-cli> review --base origin/main`). Empty means no review; the label only |
| `REVIEW_MARKER` | no | Marker line opening the review comment (for example `<!-- local-review-findings -->`) |
| `REVIEW_BLOCK_REGEX` | no | Default `critical\|warning` (case-insensitive). A match, or a non-zero exit, stops auto-labeling |
| `READY_LABEL` | no | Default `mm:ready` |
| `PREPUSH_SETUP_CMD` | no | Run in the pin worktree before commit and push (for example an install with a frozen lockfile) |
| `PIN_WAIT_MAX_MIN` | no | Default 240 |
| `PIN_OPERATOR_GATE` | no | An `operator_gate` reason for the mm-handoff `fleet pin` posts on each pin PR (engsys#271). Default: none (a ruleset path rule on `.claude/settings.json` is caught by the merge monster's preflight). Set it for a gate no ruleset expresses |
| `RELEASE_CI_REF_FILE` / `RELEASE_CI_REF_KEY` | no | `fleet pin --release` also sets `<KEY>: <engsys tag>` in this instance-repo file in the release PR (engsys#271). Key default `ENGSYS_REF`. Unset means the file is left alone |
| `SLACK_ENV` | no | Path to the `fleet notify` bot env file (§ 6.9). Empty means Slack is unconfigured: escalations fall back to a GitHub comment |
| `NOTIFY_FALLBACK_ISSUE` | no | `owner/repo#N` for `fleet notify`'s fallback comment when Slack is unconfigured or unreachable. Empty means the message is only printed as a warning |
| `FLEET_ID` | no | This fleet's id in a federation (§ 6.10): `^[a-z][a-z0-9-]{1,20}$`, rejected otherwise. Written into every session env. Never inherited from the caller's environment. Unset means single-fleet mode |
| `FEDERATION_FILE` | no | The registry file, relative to the instance root unless absolute. Default `federation.yml`. Missing file means single-fleet mode |
| `CLAIM_PROJECT` | no | `<owner>/<number>` of the ProjectV2 board `claim.mjs acquire`/`release` mirror the `fleet:<id>` label onto (§ 3). Owner may be a user or org and may differ from the issue's repo; a cross-owner board needs `GH_APP_OWNER` set to it (engsys#55). Unset means no board sync, only the label |
| `CLAIM_OWNER_FIELD` | no | The board field name `claim.mjs` writes the fleet id to: a TEXT or SINGLE_SELECT field (a SINGLE_SELECT field must already carry an option named exactly each fleet id, never created automatically). Default `Owner`. Ignored when `CLAIM_PROJECT` is unset |
| `FLEET_INSTANCE_REPO` | no | `owner/name` of the instance repo, which holds each fleet's status issue (§ 6.11). Default: the origin remote of the instance checkout. Written into every session env when set. Never inherited from the caller's environment |
| `OPERATOR_TIMEZONE` / `OPERATOR_CLOCK` | no | Single-fleet mode only: how times read to a person (§ 6.10, "Operator time format"). An IANA zone and `12h` or `24h`. Default UTC, 24h. With a registry, the fleet's `timezone` / `clock` in `federation.yml` win. Written into every session env when set |
| `ROLES` | no | Set it in `fleet.local.conf`. An allowlist of the roster sessions this host runs: names, names without the namespace, or kinds (`merge`, `maintain`, `broker`, `monster`, `interactive`); § 6.11. Unset means every session. Never inherited from the caller's environment |
| `ROSTER_EXCLUDE` | no | Set it in `fleet.local.conf`. A denylist with the same entries; it wins over `ROLES`. Never inherited from the caller's environment |
| anything else | | Instance-defined template variables (model knobs, and so on) |

`REVIEW_*`, `READY_LABEL`, `PREPUSH_SETUP_CMD`, `PIN_WAIT_MAX_MIN`, `PIN_OPERATOR_GATE` and `RELEASE_CI_REF_*` are read by `fleet pin`.

### Template variables

Every key above, plus `FLEET_REPO` (instance root), `FLEET_STATE` (`$FLEET_REPO/.fleet`), `ENV_DIR`
(`$FLEET_STATE/env`), `LOG_DIR` (default `~/Library/Logs/<org>-fleet`), `ENGSYS_REF`, `INSTANCE_REF` and
`TMUX_SESSION`, is available in templates as `__NAME__`. Job templates additionally get `__LABEL__` and
`__HOME__`. Rendering fails if a referenced name is unset. `TMUX_SESSION` comes from the roster's
`TMUX_SESSION=` header, else its `NAMESPACE=`, else `FLEET_ORG`.

### Pins

`ENGSYS_REF` is `extraKnownMarketplaces.<ENGSYS_MARKETPLACE>.source.ref` and `INSTANCE_REF` is the same for
`INSTANCE_MARKETPLACE`, both read from the working tree of `$PIN_DIR/.claude/settings.json`. The set of
plugins to install is `enabledPlugins` entries that are `true` and end in `@<marketplace>`.

### Files the kit writes

| Path | Contents |
|---|---|
| `<instance>/.fleet/env/<lane>.env` | rendered env files, mode 0600, with the identity lines appended when `GH_APP_ENV` is set, and `FLEET_ID` (plus `FEDERATION_FILE` when it exists) when `FLEET_ID` is set |
| `<instance>/.fleet/roster` | the rendered roster |
| `<instance>/.fleet/roster.host` | the rendered roster minus the sessions that are not on this host (§ 6.11); what `fleet launch` with no name starts |
| `<instance>/.fleet/supervisor.conf` | the rendered supervisor conf |
| `<instance>/.fleet/launch/` | one-shot launch files (mode 0600, dir 0700): each session's full command, sourced by its window's shell and removed just before the harness starts; a launch that never starts removes its own, and hour-old leftovers are pruned (engsys#236) |
| `<instance>/.fleet/last-change`, `sync.log` | what `fleet restart` uses to decide BEHIND, and the history |
| `<instance>/logs/fleet-supervisor/` | supervisor state and log |
| `~/Library/Logs/<org>-fleet/` | launchd job logs |
| `~/Library/LaunchAgents/com.<org>.fleet.<job>.plist` | installed jobs |
| `~/.cache/<org>/gh-app-token-<installation>.json` | App token cache, mode 0600 |

### Related documents

- [`core/fleet/identity/README.md`](../core/fleet/identity/README.md): the GitHub App, env file, rotation.
- [`stacks/cloud/azure/fleet/README.md`](../stacks/cloud/azure/fleet/README.md): the Azure service principal.
- [`core/skills/agent-sessions/SKILL.md`](../core/skills/agent-sessions/SKILL.md): launcher, roster format,
  permission modes, supervisor decision table.
- [`merge-monster.md`](merge-monster.md), [`maintenance-monster.md`](maintenance-monster.md),
  [`agent-messaging.md`](agent-messaging.md), [`subagent-liveness.md`](subagent-liveness.md).
- [`architecture.md`](architecture.md): how engsys itself is put together, including plugin mode.
