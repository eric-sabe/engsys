# Harness Adaptation Guide — Assessing & Onboarding a New Coding Harness

This guide is the authoritative runbook for an agent or operator tasked with adapting `engsys` to a **new primary coding harness** (for example, promoting **OpenAI Codex CLI (`codex`)** from an external worker provider to a full primary conductor harness alongside `claude`, `copilot`, and `antigravity`, or onboarding **Cursor**, **Windsurf**, **Aider**, or a future agent runtime).

---

## Overview: What a Primary Harness Must Do in `engsys`

In `engsys`, an **external worker provider** (`providers:` in `engsys.config.yaml`) only needs a single non-interactive CLI call (`core/workflows/briefs/adapters/<provider>.sh`) that accepts a markdown brief and writes a JSON receipt.

A **primary conductor harness** (`harness: <name>` in `engsys.config.yaml` and `HARNESS=<name>` in `fleet.conf`) owns the entire developer and fleet lifecycle across **12 architectural surfaces**:

| # | Surface | Core `engsys` Subsystem | Key Files |
|---|---|---|---|
| **1** | **Root Instructions & Context Re-grounding** | Project working notes, `PROJECT-FACTS` preservation, compaction recovery | `core/templates/CLAUDE.md.tmpl`, `lib/render.js`, `lib/commands.js` |
| **2** | **Specialist Personas & Subagent Dispatch** | 11 core + 4 optional + 3 stack personas, least-privilege tool scoping (`NA-PS-1`), `STATUS: COMPLETE \| INCOMPLETE` handback | `core/agents/*.md`, `lib/render.js` (`renderAgentForHarness`, `renderAntigravityAgent`) |
| **3** | **Skills & Slash Commands** | 20 core skills, 24 stack packs, 11 slash workflows (`/design-change`, `/merge-monster`, etc.), `<= 200`-line progressive disclosure | `core/commands/*.md`, `core/skills/*/SKILL.md`, `stacks/**` |
| **4** | **Lifecycle Hooks & Security Enforcement** | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop` | `core/lib/harness-io.mjs`, `core/.claude-plugin/*.mjs`, `core/templates/settings.json.tmpl` |
| **5** | **Permissions, Sandbox & Unattended Mode** | Tool allow/deny globs, worktree directory trust (`--add-dir`), autonomous monster bypass flags | `core/templates/settings.json.tmpl`, `stacks/*/settings.fragment.json`, `launch-agent-sessions.sh` |
| **6** | **Model Topology & Effort Scaling** | Mapping canonical tiers (`judgement`, `execution`, `security`, `escalation`, `fast`) + reasoning effort | `lib/render.js` (`resolveModelTiers`), `core/fleet/scaffold/fleet/fleet.conf` |
| **7** | **MCP Server Materialization** | Rendering and preserving project + stack MCP servers across updates and rollbacks | `lib/render.js` (`renderMcpJson`), `lib/commands.js` |
| **8** | **Agentic Memory Engine** | Class A lesson + Class B (per-fleet `refs/engsys/memory/fleet/<fleet>/…`) SQLite FTS5 `< 2 KB` subagent brief injection & `nyx` Class A isolation | `core/.claude-plugin/subagent-memory-inject.mjs`, `core/scripts/memory-brief.mjs`, `core/scripts/memory-sync.mjs` |
| **9** | **Adaptive SDD & Multi-Provider Dispatch** | `/design-change` (`TW-1..TW-6`), `spec-slice.mjs`, `contract-check.mjs`, cross-family worker routing | `core/lib/sdd-validator.mjs`, `core/scripts/worker-run.mjs` |
| **10** | **Autonomous Fleet & Deterministic Supervisor** | `tmux` session launching, `pane_busy` detection, expired-auth hold & `auth_probe`, context-pressure rotation, CAS batons | `core/skills/agent-sessions/scripts/launch-agent-sessions.sh`, `fleet-supervisor.sh`, `core/lib/monster.sh` |
| **11** | **Remote Control & Desktop / Web Visibility** | Per-session `--remote-control` / `--remote` / `--remote-control-name <name>` vs. standalone host daemon (`remote-control start`) | `launch-agent-sessions.sh` |
| **12** | **Messaging & Closed-Loop Installer Rollback** | Same-host peer nudges vs. GitHub App-signed `fleet msg` / `fleet relay` / `fleet-inbox.mjs`; lockfile & byte-for-byte uninstall (`CT-10`/`CT-11`) | `core/fleet/lib/route.mjs`, `core/.claude-plugin/fleet-inbox.mjs`, `lib/commands.js`, `lib/selftest.js` |

---

## Step-by-Step Execution Protocol for an Assessing Agent

When asked to evaluate or onboard a candidate harness `<harness>`, execute the following **four phases** in order.

### Phase 1: Empirical Capability Probe (Do Not Guess — Run the Binary)

Never rely on training-data assumptions about a CLI or IDE harness; flags and hook schemas evolve rapidly. Run these probes against the installed binary and record the exact output:

1. **Version & Top-Level CLI Surface:**
   ```bash
   <bin> --version
   <bin> --help
   ```
2. **Feature Flags, Subcommands & Experimental Capabilities:**
   ```bash
   # Inspect subcommands for headless exec, remote-control, plugins, mcp, hooks, features:
   <bin> features list 2>&1 || true
   <bin> remote-control --help 2>&1 || true
   <bin> plugin --help 2>&1 || true
   <bin> mcp --help 2>&1 || true
   ```
3. **Instruction File & Directory Discovery:**
   - Determine which root markdown files the harness loads automatically (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, etc.) and whether subdirectory instruction files load on demand.
   - Determine where project-local configuration lives (e.g., `.claude/`, `.agents/`, `.github/copilot/`, `.codex/`).
4. **Subagent / Multi-Agent Mechanism:**
   - Check how the harness defines custom specialist agents (markdown with YAML frontmatter vs. TOML/JSON) and whether individual agents can be restricted to read-only tools (`enable_write_tools: false` / `sandbox: read-only`) to satisfy invariant **`NA-PS-1`** (critics `melvin`, `nyx`, `jody`, `leith`, `gary`, `otto`, `marcelo`, `patricia` never receive `Edit` or `Bash`).
5. **Lifecycle Hook Wire Protocol (`harness-io.mjs`):**
   - Identify supported hook events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`).
   - Test what JSON payload the harness pipes to a hook's `stdin` and what `stdout` / exit code is required to:
     - **Allow silently** (`exit 0`)
     - **Block a tool call or stop event** (e.g., `permissionDecision: "deny"`, `decision: "block"`, or `exit 2` with stderr)
     - **Inject context into the turn** (`hookSpecificOutput.additionalContext`, top-level `additionalContext`, or plain-text stdout).
6. **Fleet & `tmux` Runtime Signals:**
   - **Interactive start with initial prompt:** How does `launch-agent-sessions.sh` start an interactive TUI session and feed the first turn (e.g. `claude "<prompt>"`, `copilot -i "<prompt>"`, `agy -i "<prompt>"`, `codex -C <dir> "<prompt>"`)?
   - **Headless one-shot probe (`auth_probe`):** How does `fleet-supervisor.sh` run a zero-plugin, fast 1-word health check (`claude -p`, `copilot -p`, `agy -p`, `codex exec`)?
   - **Pane busy indicator (`pane_busy`):** What string appears in `tmux capture-pane` while the harness is mid-turn (`esc to interrupt` in Claude/Copilot/Codex)?
   - **Auth error lines (`CLAUDE_AUTH_ERRORS`):** What exact line does the TUI print when OAuth/API credentials expire?

---

### Phase 2: Produce the "What Works / What Doesn't Work" Assessment Artifact

Before writing any code, compile your empirical findings into a structured **Harness Assessment Artifact** classifying every `engsys` capability into one of three buckets:

- 🟢 **Works Out-of-the-Box (Zero Code Changes):** Capabilities that are 100% harness-agnostic (e.g., Node/bash CLI scripts, Git-ref CAS batons, Fleet Health Desk probes, SDD validators, cross-fleet GitHub relay).
- 🟡 **Works With Adapter / Translation Layer:** Capabilities supported by the harness once `engsys` translates file paths, frontmatter keys, CLI flags, or hook JSON envelopes.
- 🔴 **Unsupported by Harness — Requires Architectural Fallback:** Capabilities where the harness lacks a native primitive (e.g., no cross-tmux `SendMessage` socket, or no `SubagentStart` hook) and `engsys` must wire a deterministic fallback.

#### Assessment Matrix Template

| Capability / Feature | Status (`🟢` / `🟡` / `🔴`) | Native Harness Mechanism | Gap / Required `engsys` Change or Fallback |
|---|---|---|---|
| **1. Root & Scoped Instructions** | `🟢 / 🟡 / 🔴` | e.g. `AGENTS.md` | ... |
| **2. 18 Specialist Personas & `NA-PS-1` Read-Only Enforcement** | `🟢 / 🟡 / 🔴` | ... | ... |
| **3. Skills (`SKILL.md`) & Slash Workflows (`/design-change`, etc.)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **4. Lifecycle Hooks (`PreToolUse`, `SessionStart`, `SubagentStop`, `Stop`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **5. Singleton Fenced Write Guard (`singleton-write-guard.mjs`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **6. Subagent Handback Guard (`handback-guard.mjs`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **7. Agentic Memory Engine (`memory-sync.mjs`, `memory-brief.mjs`, `nyx` isolation)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **8. Adaptive SDD (`TW-1..TW-6`, `spec-slice.mjs`, `contract-check.mjs`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **9. Model Tier Mapping & Effort Scaling (`models:` / `fleet.conf`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **10. MCP Server Configuration** | `🟢 / 🟡 / 🔴` | ... | ... |
| **11. Autonomous Monsters (`/merge-monster`, `/maintenance-monster`, `/resource-broker`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **12. Fleet Supervisor (`fleet-supervisor.sh`: `pane_busy`, `auth_probe`, rotation)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **13. Remote Control & Desktop / Web / Mobile Visibility** | `🟢 / 🟡 / 🔴` | ... | ... |
| **14. Same-Fleet Peer Nudges & Cross-Fleet Messaging (`fleet msg` / `fleet relay`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **15. Host & Wrapper Integrity Verification (`fleet verify`)** | `🟢 / 🟡 / 🔴` | ... | ... |
| **16. Installer (`install`, `update`, `verify`, `uninstall` byte-for-byte rollback)** | `🟢 / 🟡 / 🔴` | ... | ... |

---

### Phase 3: Concrete Reference Assessment — OpenAI Codex CLI (`codex-cli 0.147.0`)

As a concrete reference for how Phase 1 and Phase 2 apply to an unsupported primary harness today, below is the live assessment of **OpenAI Codex CLI (`codex-cli 0.147.0`)** (which `engsys` currently supports as an external worker provider via `stacks/tooling/provider-codex/`, not yet as `harness: codex`):

| Capability / Feature | Status | What Works Today in `codex-cli 0.147.0` | What Doesn't Work / Adaptation Required |
|---|---|---|---|
| **1. Root Instructions (`AGENTS.md`)** | 🟢 **Works** | Codex CLI natively loads `AGENTS.md` from the repository root and nested directories, and `engsys` already generates `AGENTS.md` with `PROJECT-FACTS` preservation. | Extend `useAgentsMd` in `lib/commands.js` to include `harness === 'codex'`. |
| **2. Adaptive SDD (`sdd-check.mjs`, `spec-slice.mjs`, `contract-check.mjs`)** | 🟢 **Works** | Pure Node.js CLI gates invoked via shell; 100% harness-agnostic. | None. |
| **3. Git-Ref CAS Batons (`baton.mjs`), Durable Leases (`pool-cli.mjs`) & Monster Buses (`mm-tick.sh`, `mnt-tick.sh`)** | 🟢 **Works** | Pure Node.js + POSIX `bash` + GitHub App `gh` shim; zero dependency on the harness runtime. | None. |
| **4. Fleet Health Desk (`fleet health`)** | 🟢 **Works** | Pure Node.js probes (`statuspage`, `observed`, `http-health`, `synthetic-command`), hysteresis state machine, and GitHub board renderer. | None. |
| **5. Cross-Fleet Messaging (`fleet msg send`, `fleet relay poll`)** | 🟢 **Works** | GitHub App-signed `<!-- fleet-msg v1 -->` comments and local JSONL inbox (`$FLEET_INBOX_DIR/<session>.jsonl`) are harness-independent. | Add `codex` to `fleet msg route` (`core/fleet/lib/route.mjs`) so same-fleet peer nudges skip `SendMessage` and fall back to GitHub PR comments/labels (identical to `copilot` and `antigravity`). |
| **6. Lifecycle Hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`)** | 🟡 **Adapter** | `codex features list` shows `hooks: stable (true)` and `--dangerously-bypass-hook-trust` for unattended automation. | Add `codex` detection and I/O normalization to `core/lib/harness-io.mjs` (`detectHarness`, `readHookInput`, `writeHookOutput`) and generate Codex's hook configuration during `engsys install --harness codex`. |
| **7. Specialist Personas (`core/agents/*.md`) & `NA-PS-1` Read-Only Enforcement** | 🟡 **Adapter** | `codex features list` shows `multi_agent: stable (true)` and `plugins: stable (true)`, and Codex supports `-s read-only` vs `-s workspace-write` sandboxes. | Add `renderCodexAgent()` in `lib/render.js` mapping `engsys` personas to Codex's agent/plugin format, translating `Edit`/`Bash` absence (`NA-PS-1`) to `sandbox = "read-only"`. |
| **8. Skills & Slash Commands (`/design-change`, `/merge-monster`, etc.)** | 🟡 **Adapter** | `codex features list` shows `skill_search: stable (true)` and `plugins: stable (true)`. | Materialize commands as skills (as `renderCommandSkillMd` already does for Antigravity) into the skill directory Codex indexes. |
| **9. Model Tier Mapping (`models:` & `fleet.conf`)** | 🟡 **Adapter** | Codex supports `-m, --model <MODEL>` (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`) and `-c model_reasoning_effort="low\|medium\|high\|xhigh"`. | Add `codex` to `HARNESS_DEFAULT_MODEL_TIERS` in `lib/render.js` (`judgement: 'gpt-6-astra'`, `execution: 'gpt-6.1-sol'`, `security: 'gpt-6-astra'`, `escalation: 'gpt-6-astra'`, `fast: 'gpt-6-luna'`) and `{{#if harness_codex}}` in `core/fleet/scaffold/fleet/fleet.conf`. |
| **10. Fleet Session Launch (`launch-agent-sessions.sh`)** | 🟡 **Adapter** | `codex -C <workdir> --add-dir <worktrees> -m <model> "<prompt>"` starts an interactive session; `--dangerously-bypass-approvals-and-sandbox` + `--dangerously-bypass-hook-trust` (or `-a never -s workspace-write`) runs unattended monsters. | Add `translate_codex_flags()` and a `HARNESS=codex` launch branch in `launch-agent-sessions.sh`. |
| **11. Supervisor Auth Probe & Pane Liveness (`fleet-supervisor.sh`)** | 🟡 **Adapter** | `codex exec -m gpt-6-luna 'Reply with the single word OK'` runs non-interactively (`codex doctor` also checks auth/runtime health). | Add `codex exec` to `auth_probe()` and Codex's 401/login error strings to `CLAUDE_AUTH_ERRORS` in `fleet-supervisor.sh`. |
| **12. Remote Control & Desktop App Visibility** | 🟡 **Adapter** | `codex remote-control start\|stop\|pair` runs the experimental app-server daemon (`codex app` launches the Codex Desktop app), similar to Antigravity's two-step daemon architecture (`remote_control` feature flag). | Auto-start `codex remote-control start` in `launch-agent-sessions.sh` when `--remote-control` is in the roster, and note that Codex CLI lacks a per-session `--name <session>` flag (sessions group by workspace/thread). |
| **13. Same-Host Cross-Session `SendMessage` Bus** | 🔴 **Fallback** | Like Copilot CLI and Antigravity, Codex CLI has no cross-tmux `SendMessage`/`ListAgents` socket between independent `tmux` windows. | Use the existing `engsys` architectural fallback: `fleet msg route` skips same-fleet `SendMessage` nudges and relies on GitHub PR comments/labels (`mm:bounced`, `mm:escalated`), while `fleet msg send` / `fleet relay` / `fleet-inbox.mjs` handle cross-fleet messaging. |
| **14. Automatic `SubagentStart` Memory Injection** | 🔴 **Fallback** | If Codex's hook surface does not fire a `SubagentStart` hook with the child agent's prompt/type before spawning a subagent, automatic hook-based stashing (`subagent-memory-inject.mjs`) won't trigger. | Use the explicit CLI fallback already documented in `core/agents/isabelle.md`: personas run `node <engsys-root>/scripts/memory-brief.mjs --agent-type <role> --paths <files>` during their "Before Starting Work" step. |

---

### Phase 4: Implementation Checklist & Verification Gates

When implementing support for `<harness>` after the assessment spec is approved, touch these exact files in order:

1. **Hook I/O Adapter (`core/lib/harness-io.mjs` & `core/lib/harness-io.test.mjs`):**
   - Add `<harness>` detection to `detectHarness()`.
   - Normalize stdin fields (`toolName`, `toolInput`, `command`, `prompt`, `cwd`, `agentId`, `agentType`, `lastAssistantMessage`) in `readHookInput()`.
   - Format `allow`, `deny`, and `additionalContext` in `writeHookOutput()`.
2. **Renderer & Model Tiers (`lib/render.js`):**
   - Add `<harness>` to `normalizeHarness()`, `normalizeHarnesses()`, and `HARNESS_DEFAULT_MODEL_TIERS`.
   - Add `render<Harness>Agent()` (enforcing `NA-PS-1` read-only tool/sandbox scoping for critic personas) and update `renderAgentsMd()` with the harness's model strategy.
3. **Installer, Lockfile & Byte-for-Byte Rollback (`lib/commands.js` & `lib/selftest.js`):**
   - Materialize the harness's directory tree in `runInstall()`, track all files in `managed` / `generated`, snapshot any pre-existing user files via `snapBefore()`, and prune empty harness directories in `runUninstall()`.
   - Extend `CT-10` and `CT-11` in `lib/selftest.js` to test greenfield install/verify/uninstall and multi-stage harness switching + rollback for `<harness>`.
4. **Fleet Scaffold, Launcher, Supervisor & Router (`core/fleet/` & `core/skills/agent-sessions/`):**
   - Add `--harness <harness>` to `fleetInitVars()` (`lib/commands.js`), `core/fleet/scaffold/fleet/fleet.conf`, `core/fleet/lib/route.mjs`, `launch-agent-sessions.sh` (`translate_<harness>_flags`), and `fleet-supervisor.sh` (`auth_probe` and `CLAUDE_AUTH_ERRORS`).
5. **Run the Full Verification Matrix:**
   ```bash
   node lib/selftest.js
   node --test core/lib/harness-io.test.mjs core/fleet/lib/route.test.mjs core/skills/skill-layout.test.mjs tests/personas-and-skills.test.mjs
   bash core/skills/agent-sessions/scripts/fleet-supervisor.test.sh
   bash core/skills/agent-sessions/scripts/launch-golden.test.sh
   bash core/fleet/test/init.test.sh
   ```
   A new harness adds its own golden cases to `launch-golden.test.sh` (`UPDATE_GOLDEN=1` writes them). The Claude
   goldens must not change; if they do, name each changed file in the PR body (agent-sessions SKILL § Golden launch lines).
