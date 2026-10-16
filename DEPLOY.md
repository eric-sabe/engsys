# engsys Deployment Playbook (LLM & Human Runbook)

> **For AI Agents (Claude Code, GitHub Copilot CLI, Google Antigravity):**
> This document is an executable deployment runbook. When a user asks you to *"install or deploy engsys"*, determine which **Stage (1–4)** they want (default to **Stage 1** unless they ask for multi-provider review, unattended monsters, or a multi-host fleet), execute the numbered commands deterministically, **never** improvise directory structures by hand, and **stop** at any block marked **`[HUMAN GATE]`**.

---

## 0. Mental Model: Model vs. Coding Harness vs. Meta-Harness

Before deploying, keep the three layers of the stack distinct:

| Layer | What it is | Examples | What it lacks on its own |
|---|---|---|---|
| **1. Model** *(The Brain)* | Stateless reasoning and code-generation engine | Claude Opus / Sonnet, GPT / Codex, Gemini, Grok, DeepSeek | Starts every session with amnesia; has no tools, repo memory, or engineering process. |
| **2. Coding Harness** *(The Workbench)* | Interactive CLI or IDE agent runtime that gives a model tools, subagents, MCP servers, and lifecycle hooks | **Claude Code** (`claude`), **GitHub Copilot CLI** (`copilot`), **Google Antigravity** (CLI `agy`, config `antigravity`) | Gives you one generalist assistant, not an engineering organization; has no role boundaries, stack packs, or cross-PR memory. |
| **3. Meta-Harness** *(The Engineering Org — **`engsys`**)* | Portable engineering operating system that sits **above** your coding harness and materializes into it | `engsys` (`engsys install`, `fleet`) | Materializes **15 specialist personas**, **24 stack packs**, **Adaptive SDD (`/design-change`)**, **Compounding Memory**, and **optional autonomous ops** into whichever harness you run. |

---

## Which Stage Should You Deploy?

**90% of projects start at Stage 1 in under 3 minutes.** You do **not** need background "monsters," a dedicated machine, or a GitHub App to use `engsys`. Graduate only when your scale requires it:

| Stage | Name | Who it is for | What you need | Time |
|---|---|---|---|---|
| **Stage 1** | **Interactive Team** *(No Monsters)* | Any developer or team with an active repo and a supported coding harness (`claude`, `copilot`, or `antigravity`). | Node.js `>= 20.11`, Git, and your coding harness. | **~3 min** |
| **Stage 2** | **Cross-Family Review & Compounding Memory** | Projects that want a second model family (`codex`, `grok`, `deepseek`) to review PRs and want PR history indexed into subagent memory briefs. | Stage 1 + Node.js `>= 22.5` (for `node:sqlite` FTS5) + 1 external provider CLI/API key + `gh` CLI authenticated. | **~10 min** |
| **Stage 3** | **Single-Host Autonomous Fleet** *(Monsters + Health Desk)* | High-throughput repos with an always-on macOS host (e.g., Mac mini / workstation) that want unattended PR merging (`Merge Monster`), security/Dependabot triage (`Maintenance Monster`), and upstream outage monitoring (`Fleet Health Desk`). | Stage 2 + always-on macOS host (`launchd`), `tmux`, `jq`, and a GitHub App bot identity. | **~30 min** |
| **Stage 4** | **Multi-Repo / Multi-Host Federated Fleet** | Organizations running multiple repos and/or multiple always-on machines sharing build/test hardware pools and cross-host singleton leases. | Stage 3 + fleet instance repo, `federation.yml`, and optional `resource-broker`. | **~60 min** |

### OS / Platform Support Matrix (`macOS` · `Linux` · `Windows`)

| Stage | macOS | Linux | Windows |
|---|---|---|---|
| **Stages 1 & 2** *(Interactive Team, SDD, Multi-Provider Review, Agentic Memory)* | **Full native support** | **Full native support** | **WSL2 (recommended) or Git Bash** (`sh`/`bash` on `PATH` for shell lifecycle hooks; installer & `.mjs` scripts normalize POSIX paths on `win32`). |
| **Stages 3 & 4** *(Autonomous Monsters, Fleet Health Desk, Resource Broker, Federation)* | **Tier-1 native support** (`tmux` + `launchd` via `fleet install-jobs`) | **Supported (`tmux` + `cron`/`systemd`)** — all monster scripts, batons, health desk, and `fleet supervise` work natively on Linux (`stat -c` / `date -u -d` / `sha256sum`); only `fleet install-jobs` is macOS `launchd`-specific (schedule `fleet supervise` & `fleet relay` via `systemd` timer or `cron` on Linux). | **WSL2 Linux only** (requires `tmux`, POSIX `ps`/`kill`, and Unix `0600`/root-owned `/usr/bin/git` trust checks; not supported on native `cmd.exe`/PowerShell). |

---

## Stage 1: Interactive Team (Single Repo, No Monsters)

Use this stage when you have a project repository and want the **11 core specialist personas (plus up to 4 opt-in specialists)**, **stack packs**, **Adaptive SDD (`/design-change`)**, **`/implement-issue`**, **`/pre-push`**, and the **51-lesson memory library** inside your coding harness.

### Step 1.1 — Acquire the `engsys` CLI

Run **one** of the following (Node.js `>= 20.11` required for Stage 1; `>= 22.5` for Stage 2+):

```bash
# Option A: Global npm install
npm install -g engsys

# Option B: Clone upstream (recommended if you plan to contribute lessons back)
git clone https://github.com/eric-sabe/engsys ~/git/engsys
# If using Option B without `npm link`, replace `engsys` below with `node ~/git/engsys/install`
```

### Step 1.2 — Auto-Detect the Target Repository's Stack & Harness

**(Agent Instruction):** Inspect the target repository `<REPO_DIR>` before editing `engsys.config.yaml`:

1. **Detect coding harness (`harness:`):**
   - Check which CLI / IDE the user is running (`claude` -> `harness: claude`, `copilot` -> `harness: copilot`, `agy` -> `harness: antigravity`), or ask if they want `harness: all`.
   - Valid `harness:` values in `engsys.config.yaml`: `claude` (default) | `copilot` | `antigravity` | `all` (or a YAML list, e.g. `[claude, antigravity]`). Never write `harness: agy`.
2. **Detect stack packs (`stack:`):**
   - `cloud`: inspect IaC/workflows/SDKs → `aws` | `azure` | `gcp` | `cloudflare` | `none` (scalar or list).
   - `iac`: inspect `*.tf` (`terraform`), `*.bicep` (`bicep`), `cdk.json` (`cdk`), else `none`.
   - `lang`: inspect `tsconfig.json`/`package.json` (`typescript`), `pyproject.toml`/`requirements.txt` (`python`), `Package.swift`/`*.xcodeproj` (`swift`), `build.gradle.kts` (`kotlin`), `*.sh` (`shell`).
   - `platform`: inspect frontend/mobile targets → `web` | `ios` | `android` (list).
   - `db`: inspect `prisma/schema.prisma` (`prisma`), MongoDB drivers (`mongo`), else `none`.
   - `issue_tracker`: `github` (default) | `linear`.

### Step 1.3 — Scaffold and Write `engsys.config.yaml`

```bash
cd <REPO_DIR>
engsys init --into .
```

Edit `<REPO_DIR>/engsys.config.yaml` to match the detected harness and stack. Minimal Stage 1 example:

```yaml
project:
  name: Your Project Name
  description: One-line summary of what this repository builds.

harness: claude          # claude | copilot | antigravity | all

stack:
  cloud: aws             # aws | azure | gcp | cloudflare | none (or list)
  iac: terraform         # terraform | bicep | cdk | none (or list)
  lang: [typescript]     # typescript | python | swift | kotlin | shell
  platform: [web]        # web | ios | android
  db: prisma             # prisma | mongo | none

issue_tracker: github    # github | linear

agents:
  core: all              # 11 core specialists (melvin, aaron, isabelle, bert, jody, leith, marcelo, patricia, nyx, otto, gary)
  extra: [sandy, jos, deandre, steve]  # pick any subset of the 4 opt-in personas

commands: all

lessons:
  seed: true
  into: docs/agent-lessons/library

# Optional: Claude Code cross-session peer messaging (`SendMessage` / `ListAgents`)
# Writes `crossSessionInbound` to `.claude/settings.local.json` and adds namespace guidance to `CLAUDE.md`.
# messaging:
#   enabled: true
#   namespace: acme
#   inbound: accept          # accept | hold | refuse
#   remote_control: true
```

### Step 1.4 — Materialize Into the Repository

```bash
engsys install --into .
```

**What this does deterministically (zero LLM improvisation):**
- Adopts any existing `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, or `.cursor/` rules without clobbering them (snapshots originals into `.claude/.engsys-backup/` so `engsys uninstall --into .` can restore the repo byte-for-byte).
- Materializes the files for your chosen `harness`:
  - **`claude`**: `.claude/{agents,commands,skills,hooks,workflows}/`, `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`
  - **`copilot`**: `.github/copilot-instructions.md`, `.github/agents/*.agent.md`, `.github/skills/*/SKILL.md`, `.github/hooks/engsys-hooks.json`, `.github/copilot/settings.json`, `.vscode/mcp.json`
  - **`antigravity`**: `GEMINI.md`, `AGENTS.md`, `.agents/{agents,skills,rules,workflows}/`, `.agents/hooks.json`, `.agents/plugins/engsys/plugin.json`
- Seeds the 51 curated cross-project lessons into `docs/agent-lessons/library/` and writes `docs/project-brief-overlay.md` and `docs/agent-lessons-overlay.yml`.

> **Alternative (Claude Code Plugin Mode — zero files copied into the repo):**
> If you use Claude Code and prefer not to commit `.claude/agents/` into the repo, add the marketplace once per machine (`claude plugin marketplace add eric-sabe/engsys#v2.0.0 && claude plugin install engsys@engsys`) and declare `extraKnownMarketplaces` + `enabledPlugins` in `.claude/settings.json` (see `README.md` § Option B). In plugin mode, commands and agents are namespaced as `/engsys:<command>` and `engsys:<agent>`.

### Step 1.5 — Naturalize Project Facts (The Only Model-Driven Step)

Inside your coding harness (`claude`, `copilot`, or `agy`), run:

```text
/naturalize
```

**(Agent Instruction when running `/naturalize`):**
1. Inspect the repository's build/test/lint commands, service layout, and architectural invariants.
2. Fill the fenced `<!-- ENGSYS:PROJECT-FACTS:START -->` … `<!-- ENGSYS:PROJECT-FACTS:END -->` region in `CLAUDE.md` / `GEMINI.md` / `.github/copilot-instructions.md`.
3. Fill `docs/project-brief-overlay.md` (and `.claude/workflows/briefs/project-brief-overlay.md` if present) with the repo's exact verification commands and house invariants.
4. If `docs/imported-ai-config/` was created during install, fold its durable rules into `PROJECT-FACTS` and delete `docs/imported-ai-config/`.

### Step 1.6 — Stage 1 Verification Gate

```bash
engsys verify --into .
```

- **Pass criteria:** Outputs `verify: OK — <N> managed files match`.
- **You are done with Stage 1.** Day-to-day commands you can use immediately (prefix with `/engsys:` in Claude Code plugin mode):
  - `/design-change` — Adaptive Spec-Driven Development (`Tier 0` skip, `Tier 1` inline micro-spec, `Tier 2` full spec in `docs/specs/<slug>.md`).
  - `/generate-project` — Turn a larger goal into a spec, architecture/security review, and dependency-ordered issue board.
  - `/implement-issue <N>` or `/implement-project` — Isolated worktree implementation with automatic subagent memory injection.
  - `/pre-push` — Run stack-specific verification and contract checks before pushing.
  - `/project-closeout` — Verify everything merged, clean up worktrees, and harvest lessons.

---

## Stage 2: Cross-Family Review & Compounding Memory

Graduate to **Stage 2** when you want:
1. **Cross-family model review**: Every PR authored by one model family (e.g., Anthropic) is reviewed by a different model family (e.g., OpenAI Codex, xAI Grok, or DeepSeek) before merge.
2. **Phase T2B Agentic Memory**: GitHub PR reviews, issues, and decisions are synced into a custom Git data ref (`refs/engsys/memory/events/v1`) and indexed in a local SQLite FTS5 cache so every subagent receives a `< 2 KB` path- and role-scoped memory brief at `SubagentStart`.

### Step 2.1 — `[HUMAN GATE]` Configure External Provider Credentials

Pause and ask the human which external provider(s) they want to enable (`codex`, `grok`, `deepseek`, `anthropic`):

- **OpenAI Codex CLI (`codex`):**
  ```bash
  npm install -g @openai/codex
  codex login
  ```
- **xAI Grok Build CLI (`grok`) or API:**
  ```bash
  curl -fsSL https://x.ai/cli/install.sh | bash
  grok   # sign in once, OR set XAI_API_KEY in ~/.config/engsys/env
  ```
- **DeepSeek API (`deepseek`):**
  Set `DEEPSEEK_API_KEY=sk-...` in `~/.config/engsys/env` (chmod `0600`) or a gitignored `<REPO_DIR>/.env`.

### Step 2.2 — Enable the Selected Provider(s) in the Repo

Pass the comma-separated list of provider names configured in Step 2.1 (e.g., `codex,grok` or `codex,grok,deepseek,anthropic`):

```bash
cd <REPO_DIR>
engsys enable-providers <selected-providers> --into .
engsys verify --into .
```

- **Pass criteria:** `provider doctor:` prints `READY` for each enabled provider, and `.claude/workflows/briefs/project-brief-overlay.md` has no unfilled `TODO` markers.

### Step 2.3 — Initialize the Agentic Memory Engine

Run from `<REPO_DIR>` (requires Node.js `>= 22.5` for `node:sqlite`). Use the trusted `ENGSYS_ROOT` package checkout (or `.claude/scripts` / `.agents/scripts` in a verified copy-mode install after `engsys verify`):

```bash
cd <REPO_DIR>
ENGSYS_ROOT="${ENGSYS_ROOT:-$(node -e 'const fs=require("fs"),path=require("path");console.log(path.dirname(fs.realpathSync(process.argv[1])))' "$(command -v engsys 2>/dev/null || echo ~/git/engsys/install)")}"
```

1. Validate the bundled and local lesson frontmatter:
   ```bash
   node "$ENGSYS_ROOT/core/scripts/validate-lessons.mjs"
   ```
2. Backfill historical PR/issue memory events (last 90 days) into `refs/engsys/memory/events/v1`:
   ```bash
   node "$ENGSYS_ROOT/core/scripts/memory-sync.mjs" --init --days 90
   ```
3. Smoke-test a subagent memory brief:
   ```bash
   node "$ENGSYS_ROOT/core/scripts/memory-brief.mjs" --agent-type isabelle --paths README.md
   ```
- **Pass criteria:** Outputs a `< 2048`-byte brief containing mandatory `security: true` lessons plus path-matched lessons/pointers.

---

## Stage 3: Single-Host Autonomous Fleet (Monsters + Fleet Health Desk)

Graduate to **Stage 3** when you have an always-on macOS host (e.g., a Mac mini or workstation) and want unattended background sessions that never log off:
- **Merge Monster (`/merge-monster`)**: Owns the `mm:ready` merge queue; preflights PR claims, pilots `ready → CI → merge` one active PR at a time, and bounces failures with diagnosis.
- **Maintenance Monster (`/maintenance-monster`)**: Owns the security and dependency surface (Dependabot, CodeQL, secret/image scanning) and runs the **Fleet Health Desk** (`fleet health`).
- **Deterministic Fleet Supervisor (`fleet supervise`)**: Runs under `launchd` every 5 minutes with **zero LLM in the restart path** — relaunches crashed or context-rotated sessions, enforces singleton git-ref batons, and holds relaunches if harness auth expires.

### Step 3.1 — Host Prerequisites

Verify the always-on host has the required binaries and Node.js `>= 22.5`:

```bash
for bin in git gh jq tmux node; do
  command -v "$bin" >/dev/null || { echo "missing required binary: $bin" >&2; exit 1; }
done
node -v   # must be >= v22.5.0
```

Ensure `~/git/engsys` is cloned on the host and checked out at the pinned release tag (e.g., `v2.0.0`).

### Step 3.2 — Scaffold the Fleet Instance Repo

Keep your organization's fleet configuration in a small dedicated instance directory/repo (`~/git/<org>-fleet`), separate from `~/git/engsys`:

```bash
~/git/engsys/install fleet init \
  --into ~/git/<org>-fleet \
  --org <org> \
  --namespace <ns> \
  --pin-repo <owner/repo> \
  --pin-dir ~/git/<repo> \
  --harness claude \
  --identity github-app
```

*(Note: `--harness` supports `claude`, `copilot`, or `antigravity`.)*

### Step 3.3 — `[HUMAN GATE]` Create the GitHub App Bot Identity

Autonomous monsters must act under a dedicated **GitHub App bot identity** (`<slug>[bot]`), never a human's personal `~/.gitconfig` or `gh` login.
Pause and have the human follow [`core/fleet/identity/README.md`](core/fleet/identity/README.md) to:
1. Create the GitHub App on the organization/account with the required permissions (Contents, Pull requests, Issues, Checks, Metadata).
2. Place the private key at `~/.config/<org>/gh-app.pem` (`chmod 0600`) and write `~/.config/<org>/gh-app.env` (`chmod 0600`).
3. Verify the scoped `gh` shim works:
   ```bash
   ~/git/<org>-fleet/scripts/fleet status
   ```

### Step 3.4 — Bootstrap Monster Ledgers & Fleet Health Desk

1. Create the pinned GitHub ledger issues and labels (`mm:ready`, `mm:active`, `mm:bounced`, `mnt:*`) for Merge Monster and Maintenance Monster:
   ```bash
   bash ~/git/engsys/core/skills/merge-monster/scripts/mm-setup.sh --repo <owner/repo>
   bash ~/git/engsys/core/skills/maintenance-monster/scripts/mnt-setup.sh --repo <owner/repo>
   ```
2. Record the returned ledger issue numbers in `~/git/<org>-fleet/config/merge-monster.yml` and `~/git/<org>-fleet/config/maintenance-monster.yml`.
3. *(Optional — Fleet Health Desk)* Configure `~/git/<org>-fleet/config/fleet-health.yml` with your upstream services (`github`, `anthropic`, `ci`, etc.) and validate:
   ```bash
   ~/git/<org>-fleet/scripts/fleet health validate --registry ~/git/<org>-fleet/config/fleet-health.yml
   ```

### Step 3.5 — Sync, Verify Integrity, Launch & Install Supervisor Jobs

```bash
~/git/<org>-fleet/scripts/fleet sync
~/git/<org>-fleet/scripts/fleet verify
~/git/<org>-fleet/scripts/fleet launch
~/git/<org>-fleet/scripts/fleet install-jobs
```

- **Stage 3 Verification Gate:**
  - `fleet verify` exits `0` (all singleton wrapper scripts, host `ENGSYS_DIR` files, and `.claude/settings.json` match the pinned GitHub release tree).
  - `fleet status` shows `<ns>-mm` and `<ns>-maintain` running in `tmux` with fresh ledger heartbeats.

---

## Stage 4: Multi-Repo / Multi-Host Federated Fleet & Resource Broker

Graduate to **Stage 4** when you operate **multiple repositories** and/or **multiple always-on hosts** and need:
- **Cross-host singleton fencing**: GitHub custom-ref compare-and-swap batons (`refs/engsys/leases/baton-<role>`) guarantee only one Merge Monster or Maintenance Monster acts on a repo across all hosts, with automatic `forfeited-on-rotation` handover.
- **Host role partitioning**: Designate a `home` fleet per repo (`federation.yml`) so worker hosts never accidentally spawn duplicate singleton monsters.
- **Resource Broker (`/resource-broker`)**: Durable lease pool (`core/skills/durable-lease/`) coordinating heavy local host resources (iOS simulators, Android emulators, Docker databases, e2e slots) across concurrent subagents.
- **Cross-Fleet Messaging (`fleet msg` & `fleet relay`)**: Validated, rate-limited cross-fleet nudges and inbox delivery via GitHub issue comments.

### Step 4.1 — Initialize (or Re-Scaffold) With `--fleet <id>` and `--resource-broker`

When scaffolding a federated host's fleet config (pass `--force` if upgrading an existing Stage 3 instance directory, and keep `--harness` matched to your host harness):

```bash
~/git/engsys/install fleet init \
  --into ~/git/<org>-fleet \
  --org <org> \
  --namespace <ns> \
  --pin-repo <owner/repo> \
  --pin-dir ~/git/<repo> \
  --harness claude \
  --fleet <fleet-id> \
  --resource-broker \
  --identity github-app
```

### Step 4.2 — Configure `federation.yml` and Host Roles

1. Edit `~/git/<org>-fleet/fleet/federation.yml` (scaffolded under `fleet/` alongside `fleet.conf`) to declare each fleet ID, its `status_issue`, operator timezone (`time_zone`, `time_format`), and which fleet is `home` for `merge` and `maintain` on each repository (see [`docs/multi-fleet.md`](docs/multi-fleet.md)).
2. Validate the federation registry:
   ```bash
   ~/git/<org>-fleet/scripts/fleet federation validate
   ```
3. On each host, sync pins, verify release-tree integrity, and reload `launchd` jobs:
   ```bash
   ~/git/<org>-fleet/scripts/fleet sync
   ~/git/<org>-fleet/scripts/fleet verify
   ~/git/<org>-fleet/scripts/fleet install-jobs
   ```

### Step 4.3 — Stage 4 Verification Gate

```bash
~/git/<org>-fleet/scripts/fleet status --federation
```

- **Pass criteria:** Prints every federated fleet's heartbeat age, every singleton baton (`holder`, `expires_at`, and `holder == home`), and `0` integrity or auth holds.

### Harness Messaging Matrix (`claude` vs. `copilot` vs. `antigravity`)

`engsys` separates **same-fleet peer nudges** from **cross-fleet federation messaging** so every harness operates safely without requiring Claude Code's proprietary Unix socket:

| Layer | Claude Code (`claude`) | GitHub Copilot CLI (`copilot`) | Google Antigravity (`antigravity`) |
|---|---|---|---|
| **Same-Fleet / Same-Host Peer Nudges** (`<ns>-<role>`, e.g. `acme-mm` → `acme-build`) | Uses native `SendMessage` & `ListAgents` (configured via `messaging:` in `engsys.config.yaml` / `merge-monster.yml` and `--name <ns>-<role> --settings ~/.claude/<ns>-messaging-settings.json --remote-control`). | No cross-tmux `SendMessage` socket exists. `fleet msg route` (`HARNESS=copilot`) reports `SendMessage unavailable in copilot — skip peer nudge`; GitHub PR comments & `mm:bounced`/`mm:escalated` labels serve as the notification. | Antigravity's `send_message` only addresses child/peer subagents inside one workspace process by `conversationId`. Across independent sessions, `fleet msg route` (`HARNESS=antigravity`) skips `SendMessage` and relies on GitHub PR state/comments. |
| **Cross-Fleet / Cross-Host Messaging** (`<fleet>:<session>`, e.g. `bob:acme-p70`) | **Full support:** `fleet msg send` → App-signed `<!-- fleet-msg v1 -->` GitHub comment → `fleet relay poll` → `$FLEET_INBOX_DIR/<session>.jsonl` → `FLEET_MSG` watch event + `fleet-inbox.mjs` hook (`hookSpecificOutput.additionalContext`). | **Full support:** Same GitHub App-signed `fleet msg` / `fleet relay` pipeline + `fleet-inbox.mjs` hook (`{ additionalContext }`). | **Full support:** Same GitHub App-signed `fleet msg` / `fleet relay` pipeline + `fleet-inbox.mjs` hook (plain-text stdout context). |
| **Remote Control & Desktop / Web / Mobile Visibility** (`--remote-control` in roster) | **Turnkey per-session:** `claude --name <ns>-<role> ... --remote-control` registers each session immediately by its logical name (`acme-mm`, `acme-maintain`, `acme-build`) in the **Claude Desktop app**, **claude.ai/code**, and **Claude mobile app**. | **Web & Mobile (`--remote`):** `launch-agent-sessions.sh` translates `--remote-control` → `--remote` (`copilot --name <ns>-<role> -i "<prompt>" --remote`). Copilot CLI has no standalone Electron desktop app; named sessions appear in **GitHub Web (`github.com/copilot`)** and **GitHub Mobile**. | **Daemon + per-session (now automated):** Antigravity requires both a host-level daemon (`agy remote-control start`) and per-session `--remote-control`. `launch-agent-sessions.sh` now auto-starts `agy remote-control start --name <fleet>-<host>` when needed and forwards `--remote-control`, `--dangerously-skip-permissions`, and `--effort` to `agy`. Note: `agy` groups sessions by **Workspace / Project** in the Antigravity Desktop App rather than a per-session `--name` flag. |


