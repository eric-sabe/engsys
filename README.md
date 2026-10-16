# engsys

**A meta-harness that installs a complete AI engineering organization into any project.**

Works natively across **Claude Code**, **GitHub Copilot CLI**, and **Google Antigravity** — materializing **15 specialist personas**, **24 composable stack packs**, **Adaptive Spec-Driven Development (`/design-change`)**, a **compounding Agentic Memory Engine**, and an **optional always-on autonomous fleet** from one declarative config file.

- **[Live Interactive Explainer ↗](https://eric-sabe.github.io/engsys/)** — or open [`index.html`](index.html) locally — for a visual tour of the mental model, the 15 specialists, the pipeline, and the graduation ladder.
- **[Deployment Playbook (`DEPLOY.md`)](DEPLOY.md)** — standalone, step-by-step runbook for both humans and AI agents.
  > **Want your agent to install it?** Paste this into Claude Code, Copilot CLI, or Antigravity:
  > `Read https://raw.githubusercontent.com/eric-sabe/engsys/main/DEPLOY.md and deploy Stage 1 into this repository.`

---

## Mental Model: Model vs. Coding Harness vs. Meta-Harness

When people talk about "AI coding agents," three distinct layers often get blurred together. `engsys` is the **top layer**:

| Layer | Role | Examples | What It Does — and Where It Stops |
|---|---|---|---|
| **1. Model** *(The Brain)* | Stateless reasoning & code generation | Claude Opus / Sonnet, GPT / Codex, Gemini, Grok, DeepSeek | Answers prompts and calls tools, but starts every session with amnesia and has no engineering process. |
| **2. Coding Harness** *(The Workbench)* | Interactive CLI / IDE runtime | **Claude Code** (`claude`), **GitHub Copilot CLI** (`copilot`), **Google Antigravity** (CLI `agy`, config `antigravity`) | Gives a model a terminal, file editor, subagents, MCP servers, and lifecycle hooks (`PreToolUse`, `PostToolUse`, `SubagentStart`) — but out of the box it is still **one generalist assistant** with no org chart, no stack packs, and no cross-PR memory. |
| **3. Meta-Harness** *(The Engineering Org — **`engsys`**)* | Portable engineering operating system | **`engsys`** (`engsys install`, `fleet`) | Sits **above** your coding harness and **across** models. Defines *who* does the work (15 specialists), *which* stack rules apply (24 packs), *how* work moves (spec → isolated worktree → independent review → merge), and *what the team remembers* (Agentic Memory) — then compiles that organization into whichever coding harness you run. |

### The Three-Part File Taxonomy Inside `engsys`

Inside the meta-harness, every file `engsys` manages belongs to one of three parts so you never rewrite prompts when switching projects or clouds:

| Part | Question | Stability | Lives in |
|---|---|---|---|
| **Persona** | *Who* does the work | Stable across every project | `core/agents/` & `optional-agents/` |
| **Capability** | *Which* stack / cloud / language | Chosen per project (composable packs) | `stacks/**/skills/` |
| **Project Facts** | What is true about *this* repository | Unique per project | Generated `CLAUDE.md` / `GEMINI.md` / `.github/copilot-instructions.md` |

The cloud architect (**Melvin**) never changes; you select `cloud: aws` **or** `azure` **or** `gcp` **or** `cloudflare` in `engsys.config.yaml` and he automatically loads the matching pack.

---

## Where to Start: The 4-Stage Graduation Ladder

**You do not need background daemons, "monsters," a second machine, or a GitHub App to use `engsys`.**
Start at **Stage 1** in 3 minutes on your laptop, and graduate only when your project's throughput demands it:

| Stage | What You Deploy | Monsters Needed? | Always-On Host? | Setup Time |
|---|---|---|---|---|
| **[Stage 1](#stage-1--interactive-team-start-here--3-minutes)** | **Interactive Team** — 11 core + 4 opt-in specialists, 24 stack packs, `/design-change` SDD, `/implement-issue`, `/pre-push`, and 51 curated lessons inside Claude Code, Copilot CLI, or Antigravity. | **No** | **No** | **~3 min** |
| **[Stage 2](#stage-2--cross-family-review--compounding-memory)** | **Cross-Family Review & Agentic Memory** — External review models (`Codex`, `Grok`, `DeepSeek`) enforce `reviewer family != author family`, and PR history feeds subagent memory briefs. | **No** | **No** | **~10 min** |
| **[Stage 3](#stage-3--single-host-autonomous-fleet-monsters--health-desk)** | **Single-Host Autonomous Fleet** — **Merge Monster** pilots `mm:ready` PRs through CI to merge, **Maintenance Monster** triages Dependabot/CodeQL & runs the **Fleet Health Desk**, supervised by `launchd` (macOS) or `systemd`/`cron` (Linux). | **Yes** (`mm`, `maintain`) | **1 macOS/Linux host** (`tmux`) | **~30 min** |
| **[Stage 4](#stage-4--multi-repo--multi-host-federated-fleet)** | **Federated Multi-Host Fleet** — GitHub-ref compare-and-swap batons fence monsters across machines, **Resource Broker** pools heavy build/test slots, and `fleet verify` enforces release-tree SHA & settings trust. | **Yes** (`+ broker`) | **1–N hosts** | **~60 min** |

> **Platform Support (`macOS` · `Linux` · `Windows`):**
> - **Stages 1 & 2 (Interactive Team, SDD, Multi-Provider Review, Agentic Memory):** Natively supported on **macOS**, **Linux**, and **Windows** (via **WSL2** or **Git Bash** so POSIX `.sh` lifecycle hooks can run; the `engsys` installer and `.mjs` scripts normalize paths across platforms).
> - **Stages 3 & 4 (Autonomous Fleet & Monsters):** Natively supported on **macOS** (`tmux` + `launchd` via `fleet install-jobs`) and **Linux / WSL2** (`tmux` + `systemd` user timer or `cron` running `fleet supervise` / `fleet relay`; all monster, baton, and supervisor scripts include GNU/Linux + BSD/macOS dual paths). Not supported on native Windows `cmd.exe`/PowerShell.

---

## Stage 1 — Interactive Team (Start Here — 3 Minutes)

If you have an active project and **Claude Code**, **GitHub Copilot CLI**, or **Google Antigravity**, four commands give you the entire interactive engineering team.

### Option A — Install into your project (CLI or Clone)

```bash
# 1. Install the zero-dependency CLI (Node >= 20.11) — or `git clone https://github.com/eric-sabe/engsys`
npm install -g engsys

# 2. Scaffold engsys.config.yaml in your repository
cd your-project
engsys init

# 3. Edit engsys.config.yaml (pick harness: claude | copilot | antigravity | all and stack packs), then materialize:
engsys install --into .
engsys verify --into .      # confirm all managed files match the lockfile

# 4. Open your project in Claude Code, Copilot CLI, or Antigravity and run the one model-driven step:
#    /naturalize
```

> **Running from a git clone instead of global npm?** Replace `engsys` with `node /path/to/engsys/install` (or run `npm link` once inside the clone).
> **Existing setup in the repo?** `engsys install` **adopts** existing `CLAUDE.md`, settings, agents, and Copilot/Cursor rules without clobbering them, and snapshots originals into `.claude/.engsys-backup/` so `engsys uninstall --into .` restores your repo byte-for-byte. See [`docs/install-scenarios.md`](docs/install-scenarios.md).

### Option B — Install as Claude Code Plugins (Zero Files Copied Into Repo)

For Claude Code users who want zero agent/skill files committed to the target repository, `engsys` ships as a **Claude Code plugin marketplace** (`engsys` core + one `engsys-<pack>` plugin per stack pack). Pin it in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "engsys": {
      "source": { "source": "github", "repo": "eric-sabe/engsys", "ref": "v2.0.0" },
      "autoUpdate": false
    }
  },
  "enabledPlugins": {
    "engsys@engsys": true,
    "engsys-typescript@engsys": true,
    "engsys-web@engsys": true
  }
}
```

Install once per machine (`claude plugin marketplace add eric-sabe/engsys#v2.0.0`, then `claude plugin install engsys@engsys` and your chosen pack plugins). Commands and agents are namespaced (`/engsys:implement-issue`, `engsys:isabelle`).

### What Stage 1 Gives You Immediately

1. **Multi-Harness Materialization (`harness: claude | copilot | antigravity | all`)**:
   - **`claude` (default):** `.claude/{agents,commands,skills,hooks,workflows}/`, `CLAUDE.md`, `.claude/settings.json`, and `.mcp.json`.
   - **`copilot`:** `.github/copilot-instructions.md`, `.github/agents/*.agent.md`, `.github/skills/<name>/SKILL.md`, `.github/hooks/engsys-hooks.json`, `.github/copilot/settings.json`, and `.vscode/mcp.json`.
   - **`antigravity`:** `GEMINI.md`, `AGENTS.md`, `.agents/agents/*.md`, `.agents/skills/<name>/SKILL.md`, `.agents/rules/*.md`, `.agents/workflows/*.md`, `.agents/hooks.json`, and `.agents/plugins/engsys/plugin.json`.
   - Universal hook I/O normalization ([`core/lib/harness-io.mjs`](core/lib/harness-io.mjs)) translates hook events and allow/deny/context decisions across all three harnesses automatically.
2. **15 Specialist Personas (11 Core + 4 Opt-In)**:
   - **Core (`agents.core: all`):** **Leith** (Product/UX Specs), **Melvin** (Cloud & Scale Architect), **Aaron** (IaC & Deploys), **Jody** (Planner), **Isabelle** (Implementer), **Bert** (Bug Hunter), **Marcelo** (Testing Strategist), **Patricia** (Librarian / ADRs), **Nyx** (Offensive Security — pinned to `claude-opus-4-8`), **Otto** (LLM/Token Optimization), and **Gary** (Design Critic).
   - **Opt-In (`agents.extra`):** **Sandy** (Marketing/SEO), **Jos** (Monetization/ASO), **DeAndre** (Tutor & Plain-Language Session Explainer), and **Steve** (Morale Scapegoat).
   - Every persona carries least-privilege `tools:` allowlists, explicit `skills:` bindings, and a machine-checked `## Handback Protocol` (`HANDBACK: COMPLETE` / `HANDBACK: INCOMPLETE`).
3. **Adaptive Spec-Driven Development (`/design-change`)**:
   - Risk-adaptive spec classification ([`core/lib/sdd-validator.mjs`](core/lib/sdd-validator.mjs), [`core/scripts/sdd-check.mjs`](core/scripts/sdd-check.mjs)):
     - **Tier 0 (Trivial):** Skip spec ceremony for typos and isolated 1-file fixes.
     - **Tier 1 (Standard):** Inline micro-spec in the issue/PR with explicit `touches` and verification commands.
     - **Tier 2 (Architectural / High-Risk):** Full spec in `docs/specs/<slug>.md` ([`core/templates/spec.md.tmpl`](core/templates/spec.md.tmpl)) triggered by 6 Escalation Tripwires (Data Model, Public Contract, Security/Trust Boundary, Concurrency/Leases, Performance/Scale, Cross-Boundary UX), sliced via [`core/scripts/spec-slice.mjs`](core/scripts/spec-slice.mjs) and verified at `/pre-push` via [`core/scripts/contract-check.mjs`](core/scripts/contract-check.mjs).
4. **51 Curated Cross-Project Lessons**:
   - Seeded into `docs/agent-lessons/library/` (or read in place in plugin mode) with structured YAML frontmatter (`applies_to.{stacks,paths,agents,roles}`, `security: true` floor, `triggers`).

---

## Stage 2 — Cross-Family Review & Compounding Memory

When you want stronger verification and cross-session learning — still 100% interactive on your workstation, with **no monsters required** — add **External Worker/Review Providers** and the **Agentic Memory Engine**.

### 2.1 Cross-Family Model Review & Worker Dispatch (`Codex`, `Grok`, `DeepSeek`)

When the same model reviews code it just wrote, blind spots compound. `engsys` dispatches **implement / review / critique / investigate** packages to external model families under a strict machine-checked receipt contract ([`docs/multi-provider-spec.md`](docs/multi-provider-spec.md)):

```bash
# 1. One-time CLI or API key setup for the providers you want:
npm install -g @openai/codex && codex login            # OpenAI Codex CLI
curl -fsSL https://x.ai/cli/install.sh | bash && grok  # xAI Grok Build CLI (or XAI_API_KEY in .env)
# For DeepSeek or metered Grok API, add DEEPSEEK_API_KEY / XAI_API_KEY to ~/.config/engsys/env (chmod 0600)

# 2. Enable your configured providers in the repo and check readiness:
engsys enable-providers codex,grok,deepseek,anthropic --into .
engsys verify --into .
```

```text
provider doctor:
  READY     codex — codex-cli 0.147.0
  READY     grok — grok-build CLI authenticated (or xAI API reachable)
  READY     deepseek — remapped to https://api.deepseek.com/anthropic
  READY     anthropic — claude 2.x
```

### 2.2 The Agentic Memory Engine ([`docs/memory-spec.md`](docs/memory-spec.md))

`engsys` ships a two-tier memory engine (requires Node.js `>= 22.5` for `node:sqlite`) that makes every subagent smarter without risking prompt injection from untrusted GitHub comments:

- **Class A (Trusted Instructions):** Loaded strictly from reviewed git refs (`origin/HEAD`) across `core/lessons-library/*.md`, `docs/agent-lessons/library/*.md`, `docs/agent-lessons/*.md`, and `docs/agent-lessons-overlay.yml`.
- **Class B (Historical Repo Evidence):** Merged PR summaries, review findings, and issue outcomes stored on an append-only custom Git data ref (`refs/engsys/memory/events/v1` via [`core/lib/memory/ref-store.mjs`](core/lib/memory/ref-store.mjs)) with mandatory pre-write secret scanning, bot-identity (`databaseId`) & edit-history (`userContentEdits`) verification, and prompt-boundary spoofing quarantine ([`core/scripts/memory-sync.mjs`](core/scripts/memory-sync.mjs)).
- **Subagent Brief Injection (`<= 2 KB`):**
  - On `PreToolUse` (`Agent|Task`), [`core/.claude-plugin/subagent-memory-inject.mjs`](core/.claude-plugin/subagent-memory-inject.mjs) stashes the subagent's task prompt and target paths (`0600`, 30s TTL).
  - On `SubagentStart`, [`core/scripts/memory-brief.mjs`](core/scripts/memory-brief.mjs) queries a host-local `node:sqlite` FTS5 cache ([`core/lib/memory/index-db.mjs`](core/lib/memory/index-db.mjs)) to inject mandatory `security: true` lessons, BM25/path-matched Class A lessons, and compact Class B pointers (`anchor * idf * recency * outcome * flagMultiplier`).
  - `nyx` (security) is strictly isolated to Class A instructions only. Full Class B evidence is fetched on demand (`memory-brief.mjs --evidence <key>`) inside an untrusted `HISTORICAL REPO EVIDENCE` envelope.
- **Finding Harvester ([`core/scripts/harvest-findings.mjs`](core/scripts/harvest-findings.mjs)):** Clusters recurring PR review findings during `/project-closeout` into candidate Class A lessons.

---

## Stage 3 — Single-Host Autonomous Fleet (Monsters + Health Desk)

When your repository produces enough PRs and security alerts that human merge-babysitting becomes the bottleneck, graduate to **Stage 3** on an always-on macOS host (e.g., a Mac mini or workstation running `tmux` and `launchd`):

- **Merge Monster (`/merge-monster` · [`docs/merge-monster.md`](docs/merge-monster.md)):** Owns the merge baton. Preflights `mm:ready` PRs (projecting comment markers and `FINDING-ACK`s via `mm-preflight.sh`), pilots `ready → CI → merge` one active PR at a time, and bounces failures with root-cause diagnosis.
- **Maintenance Monster (`/maintenance-monster` · [`docs/maintenance-monster.md`](docs/maintenance-monster.md)):** Sole owner of Dependabot, CodeQL, secret scanning, and image scanning alerts; filters standing false-positive policies (`mnt-fp.mjs`) and hands verified fix PRs to Merge Monster.
- **Fleet Health Desk (`fleet health` · [`docs/fleet-health-desk.md`](docs/fleet-health-desk.md)):**
  - Probes upstream dependencies (`statuspage` with ETag `304` caching, `observed` CI rolling windows, `http-health`, and `synthetic-command` with local-auth separation) using asymmetric hysteresis (`trip_fails` / `recover_clean`) and `depends_on` DAG alarm suppression.
  - Maintains a pinned `<!-- fleet-health -->` GitHub status board, posts calm transition-only Slack alerts, correlates inbound session friction reports (`fleet health report`), and injects 1–2 lines of weather context at `SessionStart` / `UserPromptSubmit` ([`core/.claude-plugin/weather-check.mjs`](core/.claude-plugin/weather-check.mjs)) only when services are degraded or down.
- **Single-Watcher Efficiency & Deterministic Supervision:**
  - Each monster runs **one** unified watcher (`mm-watch.sh`, `mnt-watch.sh`, `broker-watch.sh`) and single-call ticks (`mm-tick.sh`, `mnt-tick.sh`, `broker-tick.sh`) that coalesce events so a quiet 30-minute window costs **1 tool call**.
  - When idle context usage crosses `rotate_context_tokens` (clamped below 70% of the compaction window), the monster runs `mm-baton.sh rotate` / `mnt-baton.sh rotate` to record `rotation requested`, release its baton, and let the deterministic `launchd` supervisor ([`fleet-supervisor.sh`](core/skills/agent-sessions/scripts/fleet-supervisor.sh)) relaunch a fresh session (with automatic `forfeited-on-rotation` baton recovery if the session idles at its prompt).

```bash
# Scaffold a dedicated fleet instance repo on your always-on host:
git clone https://github.com/eric-sabe/engsys ~/git/engsys
~/git/engsys/install fleet init \
  --into ~/git/acme-fleet \
  --org acme --namespace acme \
  --pin-repo owner/repo --pin-dir ~/git/repo \
  --harness claude --identity github-app

# After placing your GitHub App key (core/fleet/identity/README.md) and running mm-setup.sh / mnt-setup.sh:
~/git/acme-fleet/scripts/fleet sync           # sync checkouts + plugins in isolated worktrees
~/git/acme-fleet/scripts/fleet verify         # verify wrapper, host ENGSYS_DIR & settings integrity
~/git/acme-fleet/scripts/fleet launch         # launch tmux sessions
~/git/acme-fleet/scripts/fleet install-jobs   # load launchd supervisor & identity jobs
```

---

## Stage 4 — Multi-Repo / Multi-Host Federated Fleet

For organizations running multiple repositories or multiple always-on hosts ([`docs/multi-fleet.md`](docs/multi-fleet.md), [`docs/fleet-guide.md`](docs/fleet-guide.md)):

- **GitHub-Ref Compare-and-Swap Batons ([`core/lib/lease/baton.mjs`](core/lib/lease/baton.mjs)):** Singleton roles (`merge`, `maintain`) hold lease batons on custom Git refs (`refs/engsys/leases/baton-<role>`) with session-bound keepalives and fenced write guards ([`core/.claude-plugin/singleton-write-guard.mjs`](core/.claude-plugin/singleton-write-guard.mjs)).
- **Resource Broker (`/resource-broker` · [`core/skills/resource-broker/SKILL.md`](core/skills/resource-broker/SKILL.md)):** Built on [`core/skills/durable-lease/`](core/skills/durable-lease/SKILL.md), pools finite host hardware (simulators, Docker stacks, e2e runners) across concurrent workers.
- **Cross-Fleet & Same-Host Messaging (`fleet msg`, `fleet relay` · [`docs/agent-messaging.md`](docs/agent-messaging.md)):**
  - **Cross-fleet (`<fleet>:<session>`):** Works across **all three harnesses (`claude`, `copilot`, `antigravity`)** via GitHub App-signed `<!-- fleet-msg v1 -->` comments (`fleet msg send`), `fleet relay poll` inbox delivery, monster `FLEET_MSG` watch events, and the tri-harness [`fleet-inbox.mjs`](core/.claude-plugin/fleet-inbox.mjs) hook.
  - **Same-fleet peer nudges (`<ns>-<role>`):** In **Claude Code**, uses native `SendMessage` / `ListAgents` (configured via `messaging:` in `engsys.config.yaml` → `.claude/settings.local.json` `crossSessionInbound: "accept"`, `merge-monster.yml`, and `launch-agent-sessions.sh`). In **Copilot CLI** and **Antigravity** (where no cross-tmux `SendMessage` socket exists), `fleet msg route` skips the peer socket nudge and falls back cleanly to GitHub PR comments and `mm:bounced`/`mm:escalated` labels.
- **Closed-Loop Host & Singleton Trust (`fleet verify` · [`core/fleet/lib/verify-wrappers.mjs`](core/fleet/lib/verify-wrappers.mjs)):** Verifies singleton plugin files, host `ENGSYS_DIR` scripts, and `.claude/settings.json` against the pinned GitHub release tree SHAs; revokes singleton batons (`--reason integrity-mismatch`) if tampering or drift is detected; enforces root-owned `git` and clean SSH config on guarded pushes; and holds relaunches if harness OAuth expires.

---

## CLI Reference

### Project Installer (`engsys` / `./install`)

| Command | Purpose |
|---|---|
| `engsys init [--into <path>]` | Scaffold `engsys.config.yaml` from the bundled example. |
| `engsys install --into <path> [--harness claude\|copilot\|antigravity\|all]` | Materialize personas, skills, commands, hooks, settings, and lessons into `<path>` (adopting any existing setup). |
| `engsys update --into <path>` | Re-render from current `engsys` + config; preserves `PROJECT-FACTS` and hand-added permissions; prunes deselected packs. |
| `engsys verify --into <path>` | Verify all managed files against `.claude/engsys.lock` and print the external provider readiness matrix. |
| `engsys enable-providers <names> --into <path>` | Append a `providers:` block (`codex,deepseek,grok,anthropic`) to `engsys.config.yaml` and run `update`. |
| `engsys fleet init --into <dir> ...` | Scaffold a fleet instance repository (`fleet.conf`, roster, launchd templates, `scripts/fleet` shim, optional `federation.yml` & `resource-broker`). |
| `engsys uninstall --into <path>` | Remove all `engsys`-managed files and restore snapshotted originals byte-for-byte. |

### Fleet Host CLI (`scripts/fleet` in a fleet instance)

| Command | Purpose |
|---|---|
| `fleet status [--federation]` | Show pin alignment, session state, auth holds, or federation-wide heartbeats and baton holders. |
| `fleet sync [--check]` | Sync host checkouts and plugins to pinned tags using per-instance worktree isolation. |
| `fleet verify [--alert]` | Verify singleton guard scripts, host `ENGSYS_DIR`, and settings against GitHub release tree SHAs. |
| `fleet launch` / `fleet restart [--stale]` | Start missing sessions or cycle stale sessions onto newly synced pins. |
| `fleet supervise` / `fleet install-jobs` | Run one deterministic supervisor tick or load the recurring `launchd` jobs. |
| `fleet health <subcommand>` | Operate the Fleet Health Desk (`validate`, `status`, `tick`, `check`, `report`, `simulate`, `invoke`, `self-probe`, `digest`, `watch-add`). |
| `fleet msg <route\|send\|inbox>` / `fleet relay` | Send, route, and poll cross-fleet messages. |
| `fleet pin` | Verify tag/manifest version alignment (`package.json`, `marketplace.json`, `plugin.json`) and open a pin bump PR. |

---

## Repository Layout & Documentation Map

```text
core/
  agents/             11 core specialists (melvin, aaron, isabelle, bert, jody, leith, marcelo, patricia, nyx, otto, gary)
  commands/           /generate-project, /design-change, /implement-project, /implement-issue, /pre-push,
                      /prep-review*, /project-closeout, /naturalize, /merge-monster, /maintenance-monster, /resource-broker
  skills/             stack-agnostic skills: git-workflow-agents, code-review, gh-cli, github-actions, pre-push,
                      refactor, llm-structured-outputs, web-design-reviewer, webapp-testing, chrome-devtools,
                      agentic-eval, interactive-explainer, subagent-liveness, untrusted-input, hermetic-git-tests,
                      merge-monster, maintenance-monster, mnt-watch, resource-broker, durable-lease, agent-sessions
  fleet/              fleet kit (bin/fleet, sync, verify, launch, supervise, pin, notify, federation, msg, relay)
                      + health/ (Fleet Health Desk: registry, adapters, hysteresis engine, incidents, board, cli)
                      + identity/ (GitHub App bot token minting & scoped gh shim)
  lib/                harness-io.mjs (tri-harness hook adapter), sdd-validator.mjs, untrusted.mjs, git-env.mjs,
                      monster.sh, claim.mjs, lease/ (GitHub-ref CAS baton), memory/ (SQLite FTS5 index-db & ref-store)
  scripts/            memory-brief.mjs, memory-sync.mjs, harvest-findings.mjs, validate-lessons.mjs,
                      sdd-check.mjs, spec-slice.mjs, contract-check.mjs, worker-run.mjs, worker-package.mjs
  lessons-library/    51 curated, frontmatter-validated cross-project lessons
  workflows/          long-form procedures & multi-provider worker briefs
  templates/          CLAUDE.md, GEMINI.md, copilot-instructions.md, spec.md.tmpl, settings, hooks, repo-gates

stacks/               24 detachable capability packs — compose per project (scalar or list)
  cloud/              aws · azure · gcp · cloudflare
  iac/                terraform · bicep · cdk
  lang/               typescript · python · swift · kotlin · shell
  platform/           web · ios · android
  db/                 prisma · mongo
  domain/             mobile-growth
  tooling/            issue-tracker-github · issue-tracker-linear · provider-{anthropic,codex,deepseek,grok}

optional-agents/      sandy (marketing/SEO), jos (monetization), deandre (tutor/explainer), steve (morale)
DEPLOY.md             standalone LLM & human progressive deployment playbook (Stages 1–4)
index.html            interactive visual explainer (https://eric-sabe.github.io/engsys/)
dashboard.html        privacy-preserving GitHub activity dashboard
```

### Deep-Dive Documentation (`docs/`)

- **Getting Started & Architecture:** [`DEPLOY.md`](DEPLOY.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/install-scenarios.md`](docs/install-scenarios.md) · [`docs/naturalization.md`](docs/naturalization.md)
- **Specs, Review & Memory:** [`docs/specs/engsys-sdd-upgrade.md`](docs/specs/engsys-sdd-upgrade.md) · [`docs/memory-spec.md`](docs/memory-spec.md) · [`docs/multi-provider-spec.md`](docs/multi-provider-spec.md) · [`docs/review-methodology.md`](docs/review-methodology.md)
- **Autonomous Fleet & Multi-Harness:** [`docs/specs/multi-harness-support.md`](docs/specs/multi-harness-support.md) · [`docs/fleet-guide.md`](docs/fleet-guide.md) · [`docs/multi-fleet.md`](docs/multi-fleet.md) · [`docs/merge-monster.md`](docs/merge-monster.md) · [`docs/maintenance-monster.md`](docs/maintenance-monster.md) · [`docs/fleet-health-desk.md`](docs/fleet-health-desk.md) · [`docs/agent-messaging.md`](docs/agent-messaging.md) · [`docs/subagent-liveness.md`](docs/subagent-liveness.md) · [`docs/gate-check.md`](docs/gate-check.md)

---

## Activity Dashboard (Optional)

A self-hosted, privacy-preserving GitHub activity dashboard ships in [`dashboard.html`](dashboard.html), fed by [`scripts/collect-stats.mjs`](scripts/collect-stats.mjs). Committed stats (`data/stats.json`) store only opaque per-repo aliases — never repo/owner names, issue titles, branches, or commit messages. See [`docs/dashboard-spec.md`](docs/dashboard-spec.md) for setup and daily GitHub Actions automation.

## Tests

```bash
npm test                     # runs installer selftests + all Node & shell test suites
npm run build:plugins        # regenerates .claude-plugin manifests & hooks (--check to verify)
```

## License

MIT — see [`LICENSE`](LICENSE).
