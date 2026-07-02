# engsys — Architecture

> The engineering system for Claude Code: agent personas, slash commands, skills,
> hooks, workflow docs, lessons, and the templates that wire them together.
> Defined once here; installed faithfully into any project with one command.

## 1. What this solves

A mature Claude Code setup — specialized agent personas, a spec→plan→implement→
review→closeout workflow, skills, hooks, and hard-won lessons — is valuable but
hard to share across projects. Two problems recur when it's copy-pasted:

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
| **Persona** | *Who* is doing the work | Stable across all projects | `core/agents/` |
| **Capability** | *Which stack/tech* the work targets | Chosen per project | `stacks/**/skills/` |
| **Project facts** | What's true about *this* repo | Unique per project | generated `CLAUDE.md` |

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
  docs/
    architecture.md       # this file
    naturalization.md     # the model-side bring-into-a-project playbook
  install                 # deterministic installer (Node.js CLI entry point)
  package.json            # `engsys install ...`; zero runtime deps
  lib/                    # installer internals (config parse, manifest, render)
  engsys.config.example.yaml

  core/                   # stack-agnostic — always installed
    agents/
      melvin.md  aaron.md  isabelle.md  bert.md  jody.md
      leith.md   marcelo.md  patricia.md  nyx.md  otto.md  gary.md
    commands/
      generate-project.md  implement-project.md  implement-issue.md
      file-issue.md        project-closeout.md   pre-push.md
      design-audit.md      design-audit-local.md design-critique.md
      prep-review.md       prep-review-publish.md prep-review-collect.md
      prep-review-finalize.md  naturalize.md
    skills/               # stack-agnostic skills
      git-workflow-agents/ code-review/ gh-cli/ github-issues/ github-actions/
      pre-push/ refactor/ llm-structured-outputs/ web-design-reviewer/
      webapp-testing/ chrome-devtools/ agentic-eval/ git-commit/
      interactive-explainer/
    hooks/
      post-edit-reminders.sh    # template; project supplies the file patterns
    workflows/                  # long-form prompt docs the commands reference
    templates/
      CLAUDE.md.tmpl  settings.json.tmpl  settings.local.json.tmpl
      post-edit-reminders.sh.tmpl  adr-template.md  gh-issue-templates/

  stacks/                 # detachable packs, chosen per project (scalar OR list)
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

  optional-agents/        # opt-in personas, not part of core
    sandy.md    # marketing site design / conversion copy / SEO
    jos.md      # monetization / business strategy
    steve.md    # the scapegoat (morale)

  lessons-library/        # curated, generalized cross-project lessons
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
  model_strategy: "Three tiers: Sonnet 5 for execution; Opus 4.8 for orchestration and judgement; escalate to Fable 5 for the hardest / highest-stakes / stuck cases."
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

A product/UX designer, a planner, a feature implementer, a bug investigator, a
performance/scale architect, an IaC specialist, a testing strategist, a project
librarian (ADRs), an offensive-security specialist, and an LLM-optimization
specialist. Opt-in personas (mobile architect, marketing, monetization, plus a
morale "scapegoat") live in `optional-agents/`.

### Commands (core, stack-agnostic)

`generate-project` → `implement-project` / `implement-issue` → `file-issue` →
`project-closeout` → `pre-push`, plus `design-audit`/`-local`/`design-critique`,
the `prep-review*` review-package flow, and `naturalize`. Commands invoke agents
by name and reference long-form procedure in `core/workflows/`.

### Skills

- **Core (agnostic):** git-workflow-agents, code-review, gh-cli, github-issues,
  github-actions, pre-push, refactor, llm-structured-outputs, web-design-reviewer,
  webapp-testing, chrome-devtools, agentic-eval, git-commit, interactive-explainer.
- **Stack packs:** the cloud/iac/lang/platform/db/domain/tooling skills listed in §3.

## 7. Lessons

Two tiers, kept distinct:

1. **Project-local** — each project's `docs/agent-lessons/`, written during
   `/project-closeout` by mining that project's local-review findings.
2. **Generalized** — `lessons-library/` here: curated, stack-agnostic lessons that
   recur across projects (verification & review, concurrency & safety, data &
   identity, workflow & git, ops & deploy, tooling). The installer seeds these
   into a project (managed, so `verify`/`update` keep them current). Stack-specific
   lessons instead live inside the relevant pack's skill, so they install with the
   capability.

`project-closeout` ends by promoting any generalizable lesson back to
`lessons-library/` via PR — the feedback loop that keeps this the source of truth
rather than a fork point.

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
