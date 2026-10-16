# engsys — Architecture

> **The meta-harness for AI software engineering**: 15 specialist personas, 24 detachable stack packs, Adaptive Spec-Driven Development (`/design-change`), a compounding Agentic Memory Engine, and an optional always-on autonomous fleet — materialized faithfully into **Claude Code**, **GitHub Copilot CLI**, and **Google Antigravity** from one config file.
> For step-by-step progressive deployment (Stages 1–4), see [`DEPLOY.md`](../DEPLOY.md).

## 1. What this solves (Model vs. Coding Harness vs. Meta-Harness)

Three layers exist in modern agentic software engineering:

1. **The Model (The Brain)** — Claude Opus/Sonnet, GPT/Codex, Gemini, Grok, DeepSeek. Stateless reasoning that starts every session with amnesia and no house rules.
2. **The Coding Harness (The Workbench)** — **Claude Code**, **GitHub Copilot CLI**, **Google Antigravity**. Wraps a model with bash execution, file editing, subagents, MCP servers, and lifecycle hooks (`PreToolUse`, `PostToolUse`, `SubagentStart`, `SessionStart`). Out of the box, however, a coding harness still gives you **one generalist assistant** with no organizational roles, no stack modularity, and no cross-PR memory.
3. **The Meta-Harness (`engsys` — The Engineering Organization)** — Sits *above* the coding harnesses and *across* models. You declare your stack and target harness(es) once in `engsys.config.yaml`, and `engsys` compiles a complete engineering organization into whichever harness you use.

When a mature setup is copy-pasted across projects by hand instead of managed by a meta-harness, two problems recur:

1. **Re-naturalization tax.** Agent profiles get hand-edited for each project's
   stack — a cloud architect rewritten as AWS vs Azure vs GCP, conventions swapped
   for the language in play — on every import.
2. **Unfaithful plumbing.** When the directories and process files are set up by
   asking a model to "wire it up," it improvises and silently skips steps. A
   process is only as good as the folders and files that back it.

engsys removes both:

- **Separate the persona (stable) from the stack knowledge (swappable)** so
  adapting to a project means *choosing packs*, not *editing prose*.
- **Make installation deterministic** — a script, not a model — so the plumbing is
  always faithful. The model only does the genuinely judgement-heavy part,
  naturalizing project facts, after the structure already exists.

## 2. Core principle: three layers

Every piece of the system belongs to exactly one of three layers. Keeping them
separate is the entire design.

| Layer | Question it answers | Stability | Where it lives |
|-------|--------------------|-----------|----------------|
| **Persona** | *Who* is doing the work | Stable across all projects | `core/agents/` & `optional-agents/` |
| **Capability** | *Which stack/tech* the work targets | Chosen per project | `stacks/**/skills/` |
| **Project facts** | What's true about *this* repo | Unique per project | generated `CLAUDE.md` / `GEMINI.md` / `.github/copilot-instructions.md` |

### Worked example: the cloud architect

`core/agents/melvin.md` is a performance-and-scale architect: personality,
first-principles discipline, and a cloud-independent diagnostic checklist (traffic
pattern, state location, SLAs, blast radius, cost explosion, coordination, limits,
observability). It contains **zero** cloud specifics. The service-level knowledge
lives in detachable packs:

- `stacks/cloud/aws/skills/cloud-architecture-aws/`
- `stacks/cloud/azure/skills/cloud-architecture-azure/`
- `stacks/cloud/gcp/skills/cloud-architecture-gcp/`
- `stacks/cloud/cloudflare/skills/cloud-architecture-cloudflare/`

The installer drops in only the pack(s) a project uses. Skills auto-trigger by
their `description`, so the agnostic persona naturally reaches for whichever pack
is present. **The persona file is never edited per project.** The same split
applies to the IaC specialist (`iac-terraform` / `iac-bicep` / `iac-cdk`), the
mobile architect (Swift/iOS vs Kotlin/Android packs), and language conventions.

### Keeping a persona agnostic

The test for a persona is simple: it should read identically whether the project
is AWS, Azure, or GCP. Anything that changes when the stack changes — service
names, CLI invocations, tier/quota gotchas, language idioms — belongs in a pack,
not the persona. The persona keeps voice, values, decision discipline, diagnostic
*frameworks*, and output-artifact schemas (e.g. the testing strategist's
test-plan format, the librarian's ADR template).

## 3. Repository layout

```
engsys/
  README.md
  DEPLOY.md               # standalone LLM & human progressive deployment playbook (Stages 1–4)
  docs/
    architecture.md       # this file
    naturalization.md     # the model-side bring-into-a-project playbook
    fleet-guide.md        # running an always-on fleet with the fleet kit
    fleet-health-desk.md  # Fleet Health Desk architecture & operations
    memory-spec.md        # Class A & Class B Agentic Memory Engine specification
  install                 # deterministic installer (Node.js CLI entry point)
  .claude-plugin/         # the marketplace manifest (generated)
  scripts/build-plugins.mjs  # generates every plugin artifact from the pack sources
  package.json            # `engsys install ...`; zero runtime deps
  lib/                    # installer internals (config parse, manifest, render)
  engsys.config.example.yaml

  core/                   # stack-agnostic — always installed (and the `engsys` plugin root)
    agents/
      melvin.md  aaron.md  isabelle.md  bert.md  jody.md
      leith.md   marcelo.md  patricia.md  nyx.md  otto.md  gary.md
    commands/
      generate-project.md  implement-project.md  implement-issue.md
      design-change.md     file-issue.md         project-closeout.md   pre-push.md
      design-audit.md      design-audit-local.md design-critique.md
      prep-review.md       prep-review-publish.md prep-review-collect.md
      prep-review-finalize.md  naturalize.md
      merge-monster.md  maintenance-monster.md  resource-broker.md  fleet-prime.md  fleet-bootstrap.md
    skills/               # stack-agnostic skills (all <= 200 lines progressive disclosure)
      git-workflow-agents/ code-review/ gh-cli/ github-actions/
      pre-push/ refactor/ llm-structured-outputs/ web-design-reviewer/
      webapp-testing/ chrome-devtools/ agentic-eval/
      interactive-explainer/ subagent-liveness/ untrusted-input/ hermetic-git-tests/
      merge-monster/ maintenance-monster/ mnt-watch/ resource-broker/ durable-lease/ agent-sessions/
    fleet/                # the fleet kit: host scripts for running a fleet (§10)
      bin/fleet  lib/fleet-env.sh  launch.sh sync.sh restart.sh pin.sh
      supervise.sh  verify.sh  install-jobs.sh  health.sh  health/  jobs/launchd/  identity/  test/
    lib/                  # runtime libraries (harness-io.mjs, sdd-validator.mjs, untrusted.mjs, git-env.mjs,
                          #   monster.sh, claim.mjs, lease/baton.mjs, memory/{index-db,ref-store}.mjs)
    scripts/              # memory engine (memory-brief.mjs, memory-sync.mjs, harvest-findings.mjs,
                          #   validate-lessons.mjs), SDD tools (sdd-check.mjs, spec-slice.mjs, contract-check.mjs),
                          #   and multi-provider worker layer (worker-run.mjs, worker-package.mjs)
    workflows/            # long-form prompt docs the commands reference
    templates/            # rendered by the installer (CLAUDE.md, GEMINI.md, copilot-instructions.md,
                          #   spec.md.tmpl, settings, post-edit reminder hook scripts)
      CLAUDE.md.tmpl  GEMINI.md.tmpl  copilot-instructions.md.tmpl  spec.md.tmpl
      settings.json.tmpl  settings.local.json.tmpl  copilot-hooks.json.tmpl  agy-hooks.json.tmpl
      post-edit-reminders.sh.tmpl  post-clear-reground.sh.tmpl
      post-compact-reground.sh.tmpl  adr-template.md  gh-issue-templates/
    .claude-plugin/       # plugin-mode manifest and hook scripts (GENERATED by
                          #   `npm run build:plugins`; never copied by the installer)
    lessons-library/      # 51 curated, frontmatter-validated cross-project lessons

  stacks/                 # 24 detachable packs, chosen per project (scalar OR list)
    cloud/    aws/ azure/ gcp/ cloudflare/
    iac/      terraform/ bicep/ cdk/
    lang/     typescript/ python/ shell/
              swift/  { swift-concurrency, swiftui-patterns, swift-testing, swiftdata }
              kotlin/ { kotlin-coroutines, jetpack-compose, android-testing }
    platform/ web/  { web-platform-conventions, react-conventions, frontend-testing }
              ios/  { xcodebuildmcp-simulator-logs, pre-push-xcodebuild, mcp }
              android/ { android-build-conventions, pre-push-gradle, mcp }
    db/       prisma/ mongo/
    domain/   mobile-growth/ { apple-ads, google-play-growth }
    tooling/  issue-tracker-github/   { issue-tracker-github }   # default
              issue-tracker-linear/   { issue-tracker-linear, mcp: linear }
              provider-anthropic/  provider-codex/  provider-deepseek/  provider-grok/

  optional-agents/        # opt-in personas, not part of core
    sandy.md    # marketing site design / conversion copy / SEO
    jos.md      # monetization / business strategy
    deandre.md  # independent tutor & plain-language session explainer
    steve.md    # the scapegoat (morale)
```

### The pack contract

Every pack under `stacks/<category>/<value>/` may contain:

```
skills/<name>/SKILL.md     the capability (auto-triggers by description)
agents/<name>.md           a pack-specific persona (rare)
hooks/<name>.sh            a pack-specific hook
claude.fragment.md         markdown spliced into the project CLAUDE.md
settings.fragment.json     { permissions: {allow,deny}, mcpServers }
```

The installer copies skills/agents/hooks, splices fragments, merges permissions
and MCP servers, and records everything in `.claude/engsys.lock`.

## 4. The installer

A deterministic Node.js CLI (`install`) is the contract that makes plumbing
faithful. It does not ask a model to create directories — it reads
`engsys.config.yaml` from the target project and materializes `.claude/` exactly.
Node was chosen so the installer runs identically on macOS, Windows, and Linux;
it has no runtime dependencies (a small built-in parser handles the config), so
there's no `npm install` step.

### 4.1 Project config

```yaml
project:
  name: Acme Widgets
  description: One-line description rendered into CLAUDE.md.

# Every stack dimension accepts a single value OR a list — mixed stacks compose.
stack:
  cloud: aws            # aws | azure | gcp | cloudflare | none   (or a list)
  iac: terraform        # terraform | bicep | cdk | none          (or a list)
  lang: [typescript]    # typescript | python | swift | kotlin | shell
  platform: [web]       # web | ios | android
  db: none              # prisma | mongo | none                   (or a list)

issue_tracker: github   # github | linear | jira   (PRs/CI stay on GitHub)

agents:
  core: all             # 'all' or an explicit subset
  extra: [sandy]        # opt-in personas from optional-agents/

commands: all           # 'all' or an explicit subset

lessons:
  seed: true            # seed the universal lessons-library into the project
  into: docs/agent-lessons/library

naturalize:
  model_strategy: "Four tiers + security carve-out: Sonnet 5.5 (claude-sonnet-5-5) for execution; Opus 5.5 (claude-opus-5-5) for orchestration and judgement; escalate to Fable 5.1 (claude-fable-5-1) for architecture, concurrency, and cross-cutting refactors; Haiku 5.5 (claude-haiku-5-5) for fast probes; and Opus 4.8 (claude-opus-4-8) pinned for Nyx and security work."
  hook_patterns:        # file globs -> post-edit reminder text
    - glob: "*/schema.prisma"
      reminder: "Schema changed — regenerate the client before pushing."
  project_facts: |      # optional; otherwise a TODO marker is left
    Free-form facts rendered into the CLAUDE.md project-facts region.

engsys:
  version: main         # tag / branch / commit the project was installed from
```

### 4.2 What `install` does

1. **Resolve the manifest** — compute the file set: core (always) + selected stack
   packs + selected optional agents + the issue-tracker pack.
2. **Create directories** — `.claude/{agents,commands,skills,hooks,workflows}`. Idempotent.
3. **Copy files in** (not symlink — self-contained, portable, diffable).
4. **Render templates** — `CLAUDE.md` = `CLAUDE.md.tmpl` + each selected pack's
   `claude.fragment.md` + the `naturalize` knobs; `settings.json` = base allow/deny
   merged with each pack's permission additions; `settings.local.json` + `.mcp.json`
   from the MCP servers each pack declares.
5. **Render the hook** — `post-edit-reminders.sh` is generated from
   `naturalize.hook_patterns`, so reminders are real, not placeholders.
6. **Seed lessons** — copy the universal lessons-library into the project (managed).
7. **Write a lockfile** — `.claude/engsys.lock` records the version, config hash,
   and per-file hashes for drift detection.
8. **Print a naturalization checklist** — the handful of things the *model* should
   do next (§5) — never folder creation.

### 4.3 install / update / verify

- `install --into <path>` — first-time materialization.
- `update --into <path>` — re-render from current engsys + config. Preserves the
  fenced `PROJECT-FACTS` region of `CLAUDE.md` and any hand-added permissions;
  heals drift in managed files.
- `verify --into <path>` — checks every managed file against the lockfile's hashes;
  reports missing/modified. This is the faithfulness guard.
- `--dry-run` (install/update) prints the plan and writes nothing.

### 4.4 Why copy, not symlink

Symlinking each project to a central clone gives instant propagation but breaks
across machines, in git worktrees, and when the clone moves; it also leaks engsys
into the project's portability. Copying keeps each project self-contained and
diff-reviewable. `update` plus the lockfile recover the "propagate improvements"
benefit without the fragility.

## 5. Naturalization (the model's half)

After `install` lays down faithful structure, the model fills in judgement-heavy
project facts. This is the only model-driven step, and it edits **only** the fenced
`PROJECT-FACTS` region of `CLAUDE.md` (between the `ENGSYS:PROJECT-FACTS` markers)
plus any `<naturalize: …>` placeholders packs left in `.mcp.json`, hooks, and the
spliced fragments. It includes: project shape (services, runtimes, build/verify
toolchain), domain-specific hard invariants, where architecture docs live, and
concrete values for placeholders (e.g. an iOS scheme/simulator, a cloud resource
group).

A `/naturalize` command drives this; it is forbidden from creating directories or
moving files — the installer owns that. This split is the fix for unfaithful
plumbing: the model is never *asked* to do plumbing, so it can't skip it. See
[`naturalization.md`](naturalization.md).

## 6. Components

### Agents (core, all stack-agnostic)

Eleven core specialists: a product/UX designer (`leith`), a planner (`jody`), a feature implementer (`isabelle`), a bug investigator (`bert`), a performance/scale architect (`melvin`), an IaC specialist (`aaron`), a testing strategist (`marcelo`), a project librarian/ADR author (`patricia`), an offensive-security specialist (`nyx`, pinned to `claude-opus-4-8`), an LLM-optimization specialist (`otto`), and a design critic (`gary`). Four opt-in personas — marketing/SEO (`sandy`), monetization (`jos`), independent tutor/explainer (`deandre`), plus a morale "scapegoat" (`steve`) — live in `optional-agents/`.

### Commands (core, stack-agnostic)

`generate-project`, `design-change` (Adaptive SDD) → `implement-project` / `implement-issue` → `file-issue` →
`project-closeout` → `pre-push`, plus `design-audit`/`-local`/`design-critique`,
the `prep-review*` review-package flow, and `naturalize`; and for an always-on fleet,
`merge-monster`, `maintenance-monster`, `resource-broker`, `fleet-prime` and `fleet-bootstrap`. Commands invoke agents
by name and reference long-form procedure in `core/workflows/`.

### Skills

- **Core (agnostic):** git-workflow-agents, code-review, gh-cli,
  github-actions, pre-push, refactor, llm-structured-outputs, web-design-reviewer,
  webapp-testing, chrome-devtools, agentic-eval, interactive-explainer,
  subagent-liveness, untrusted-input, hermetic-git-tests, merge-monster,
  maintenance-monster, mnt-watch, resource-broker, durable-lease, agent-sessions.
- **Stack packs:** the cloud/iac/lang/platform/db/domain/tooling skills listed in §3.

## 7. Lessons & the Agentic Memory Engine

Two trust classes ([`docs/memory-spec.md`](memory-spec.md)), kept strictly separate:

1. **Class A (Trusted Instructions)** — `core/lessons-library/` (51 curated cross-project lessons) plus each project's `docs/agent-lessons/*.md` and `docs/agent-lessons-overlay.yml`, loaded strictly from reviewed git refs (`origin/HEAD`). Every lesson carries YAML frontmatter (`id`, `title`, `severity`, `security`, `applies_to.{stacks,paths,agents,roles}`, `triggers`, `summary`) validated by `core/scripts/validate-lessons.mjs`.
2. **Class B (Historical Repo Evidence)** — merged PR summaries, review findings, and issue outcomes stored on an append-only custom Git ref (`refs/engsys/memory/events/v1` via `core/lib/memory/ref-store.mjs`) and synced by `core/scripts/memory-sync.mjs` with secret scanning, bot `databaseId` verification, and prompt-boundary spoofing quarantine.

At `SubagentStart`, `core/.claude-plugin/subagent-memory-inject.mjs` and `core/scripts/memory-brief.mjs` query a host-local `node:sqlite` FTS5 index (`core/lib/memory/index-db.mjs`) to inject a `<= 2 KB` brief containing mandatory `security: true` lessons, BM25/path-matched Class A lessons, and compact Class B pointers (`nyx` receives Class A only). `project-closeout` runs `core/scripts/harvest-findings.mjs` to cluster recurring PR review findings into new Class A lesson candidates.

## 8. Configurability

All on the same pack mechanism:

- **Mixed stacks.** Every stack dimension accepts a scalar or a list; packs simply
  compose (fragments splice, skills auto-trigger, permissions/MCP merge). The
  installer de-dupes skills/agents by name and unions permissions.
- **Issue tracking is a separate axis from code hosting.** `issue_tracker` selects
  a pack under `stacks/tooling/`; PRs, CI, and `/code-review` stay on GitHub
  regardless. Each tracker pack ships a skill implementing a shared operation
  contract (`create-issue`, `query-board`, `link-pr`, …); commands reference those
  operations instead of hardcoding a backend. `github` is the default (zero
  behavior change); `linear` maps the contract onto the Linear MCP.
- **Mobile is platform-agnostic at the persona.** The mobile architect is iOS
  and/or Android; the platform specifics live in `lang/*` + `platform/*` packs.

## 9. Design decisions & open items

**Decided:** Node installer (cross-platform, zero-dep); copy-on-install with a
lockfile (not symlinks); `prep-review*` is core; `issue_tracker` defaults to
`github`; personas live only in `core/`/`optional-agents/` (packs carry
capabilities, not agents, save rare exceptions).

**Open:**
- **Settings merge on `update`** currently unions existing and generated
  permissions (safe, lossless); a fenced project-owned section would be cleaner.
- **Version pinning** — `engsys.lock` records a version, but installing an *older*
  engsys revision into a new project isn't implemented.
- **Lessons seeding by stack** — seeding currently copies the full universal set;
  a future option could filter by the project's chosen stack.

## 10. Plugin mode and the fleet kit

engsys ships two ways from the same sources. **Copy mode** (§4) materializes files into a project's
`.claude/`. **Plugin mode** distributes engsys as a Claude Code plugin marketplace: nothing is copied into
the project, and the project's committed `.claude/settings.json` pins a git ref.

### 10.1 Plugin mode

- **Layout.** The repo root is a marketplace (`.claude-plugin/marketplace.json`). The `engsys` plugin is
  `core/`; every stack pack under `stacks/<category>/<value>/` is its own `engsys-<value>` plugin.
  Components (`agents/`, `commands/`, `skills/`) are auto-discovered from each plugin root.
- **Generated, never hand-edited.** `scripts/build-plugins.mjs` (`npm run build:plugins`) writes every
  plugin artifact: manifests, hook wiring in `<plugin>/.claude-plugin/hooks.json`, small generated hook
  scripts, and pack-root `.mcp.json`. They all live under `.claude-plugin/` directories the copy-mode
  installer never copies, so plugin mode cannot change a copy-mode install, and `npm test` fails when they
  are stale.
- **Hooks are templates plus generated wiring.** There is no `core/hooks/`. In copy mode the installer
  renders `core/templates/*.sh.tmpl` into `.claude/hooks/`. In plugin mode `core/.claude-plugin/` carries
  the hook scripts and `hooks.json`: a SessionStart hook injects the generic conventions that copy mode
  renders into `CLAUDE.md`, re-grounding hooks run the same templates after `/clear` and compaction, a
  `PreToolUse` hook auto-approves exactly one shape (a single invocation of one of engsys's own bookkeeping
  scripts by literal path), and the handback guard runs on `Stop` and `SubagentStop`.
- **Pinning.** `extraKnownMarketplaces.engsys.source.ref` in the project's `.claude/settings.json` is the
  version; `enabledPlugins` lists what is on. A marketplace added at `#<tag>` is sticky, and the plugin cache
  is keyed by version (see the [fleet guide](fleet-guide.md#9-verified-plugin-mechanics)).
- **Paths.** Content refers to files as `<engsys-root>/…`: `.claude/` in copy mode, the plugin root in
  plugin mode. Anything run by a scheduler must not use the plugin root, because its per-version cache path
  moves; it runs from a pinned checkout instead (10.2).
- **Not in plugin mode yet:** the multi-provider worker layer (`core/scripts/`).

### 10.2 The fleet kit

`core/fleet/` is machinery for running an always-on fleet of long-lived sessions from a separate
**instance repo** (config, context and org skills) with engsys as the pinned upstream:

- **`bin/fleet`** dispatches `status`, `pin`, `sync`, `restart`, `launch`, `supervise`, `install-jobs` and
  `init`. `lib/fleet-env.sh` is sourced by every command: it loads the instance's `fleet/fleet.conf`
  (plus a per-machine override), renders `__NAME__` templates, derives the pins, and sets up the
  fleet's env-scoped git identity.
- **Host scripts run from the pinned engsys checkout** (`ENGSYS_DIR`), never from the plugin cache. The
  launcher and supervisor stay in `core/skills/agent-sessions/scripts/`; the kit calls them.
- **Pins live in one place**, the pin repo's `.claude/settings.json`. `fleet sync` makes the host match
  them (checkouts, marketplace refs, plugins, launchd jobs) and touches no running session; `fleet restart`
  cycles sessions onto the result when the operator chooses.
- **Identity** is a GitHub App bot, scoped to the fleet's own processes through environment-carried git
  config and a `gh` shim, so nothing global is written (`core/fleet/identity/`). An optional cloud service
  principal login lives in the matching pack (`stacks/cloud/azure/fleet/`).
- **Safety libraries** used by fleet sessions live in `core/lib/`: `untrusted.mjs` (a defanged envelope for
  untrusted text) and `git-env.mjs` (hermetic child git).

The human guide is [`fleet-guide.md`](fleet-guide.md); the agent-facing walkthrough is the
`/engsys:fleet-bootstrap` command.
