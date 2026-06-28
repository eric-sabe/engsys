# engsys

**An AI engineering team you install into any project.**

A complete Claude Code engineering system — agent personas, slash commands,
skills, hooks, workflow docs, and curated lessons — plus a deterministic
installer that materializes it **faithfully** into any project from one config
file.

**[Live explainer ↗](https://eric-sabe.github.io/engsys/)** — or open
[`index.html`](index.html) locally — for a visual tour of the system and the team.

## Why

The system used to live copy-pasted across projects at different maturity
levels. That caused two recurring pains:

1. **Re-naturalization tax** — hand-editing agent profiles per stack (the cloud
   architect as AWS vs Azure vs GCP) on every import.
2. **Unfaithful plumbing** — when commands were ported and a model was asked to
   "set up the folders," it improvised and skipped steps.

engsys fixes both. See [`docs/architecture.md`](docs/architecture.md) for the
full design.

## The core idea: three layers

| Layer | Question | Stability | Lives in |
|-------|----------|-----------|----------|
| **Persona** | *Who* does the work | Stable everywhere | `core/agents/` |
| **Capability** | *Which* stack/tech | Chosen per project | `stacks/**/skills/` (packs) |
| **Project facts** | What's true about *this* repo | Unique per project | generated `CLAUDE.md` |

The cloud architect (Melvin) never changes; you install `cloud-architecture-aws`
**or** `-azure` **or** `-gcp` **or** `-cloudflare` and he auto-loads whichever is
present. Adapting to a project becomes *choosing packs*, not *editing prose*.

## Quickstart

**Option A — install from npm** (global CLI):

```bash
npm install -g engsys

cd your-project
engsys init                 # scaffold engsys.config.yaml from the bundled example
$EDITOR engsys.config.yaml  # pick cloud / iac / lang / platform / db / agents
engsys install --into .     # materialize .claude/, CLAUDE.md, settings, .mcp.json

# open the project in Claude Code and run /naturalize  (the one model-driven step)
engsys verify --into .      # anytime: confirm nothing drifted
```

**Option B — run from a clone** (no global install; the repo is also where you
fork packs and PR lessons back, so you'll likely want it anyway):

```bash
git clone https://github.com/eric-sabe/engsys

cd your-project
cp /path/to/engsys/engsys.config.example.yaml ./engsys.config.yaml
$EDITOR engsys.config.yaml
node /path/to/engsys/install install --into .   # same CLI, invoked directly
node /path/to/engsys/install verify  --into .
```

> Tip: from a clone you can also `cd engsys && npm link` once to get the bare
> `engsys` command on your PATH, then use it exactly like Option A.

The installer is **zero-dependency** Node (≥18) — it adds nothing to your
project's dependency tree and runs the same on macOS, Windows, and Linux.

## Commands

| Command | What it does |
|---------|--------------|
| `init [--into <path>]` | Scaffold `engsys.config.yaml` from the bundled example (default: current dir). Handy after a global `npm install`. |
| `install --into <path>` | First-time materialization of `.claude/`, `CLAUDE.md`, settings, `.mcp.json`. |
| `update --into <path>` | Re-render from current engsys + config. Preserves the CLAUDE.md PROJECT-FACTS region and any hand-added permissions; heals drift in managed files. |
| `verify --into <path>` | Compares installed managed files against the lockfile; reports missing/modified. |
| `uninstall --into <path>` | Removes everything engsys added and restores the project's prior files. |
| `--dry-run` | (install/update/uninstall) print the plan, write nothing. |

engsys **adopts** a repo's existing setup rather than overwriting it — a foreign
`CLAUDE.md` is folded in and backed up, settings merge, the project's own agents
are preserved, and Copilot/Cursor config is imported for `/naturalize`. It's fully
reversible with `uninstall`. See [`docs/install-scenarios.md`](docs/install-scenarios.md).

## Layout

```
core/               stack-agnostic — always installed
  agents/           personas: architect, IaC, implementer, planner, designer,
                    tester, librarian, security, LLM-opt, bug hunter
  commands/         generate-project → implement → file-issue → project-closeout,
                    pre-push, design-*, prep-review*, naturalize
  skills/           git-workflow-agents, code-review, gh-cli, github-issues,
                    github-actions, pre-push, refactor, …
  workflows/        long-form procedure docs the commands reference
  templates/        CLAUDE.md, settings, hook, ADR + issue templates

stacks/             detachable capability packs — pick per project (scalar or list)
  cloud/            aws · azure · gcp · cloudflare
  iac/              terraform · bicep · cdk
  lang/             typescript · python · swift · kotlin · shell
  platform/         web · ios · android
  db/               prisma · mongo
  domain/           mobile-growth
  tooling/          issue-tracker-github · issue-tracker-linear

optional-agents/    opt-in: gary (mobile), sandy (marketing), jos (monetization),
                    steve (morale)
lessons-library/    curated cross-project lessons (seeded into projects on install)
docs/               architecture · naturalization
lib/  install       the zero-dep Node installer
index.html          single-page visual explainer
team-images/        team roster art (lib/generate-team-avatars.mjs (re)generates it)
```

### Pack contract

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

## Feedback loop

Project closeouts mine local review findings into `docs/agent-lessons/`. When a
lesson generalizes across projects, PR it into [`lessons-library/`](lessons-library/)
so the next install can seed it. That keeps engsys the source of truth instead of
a fork point.

## Activity dashboard (optional)

A self-hosted GitHub activity dashboard ships in this repo ([`dashboard.html`](dashboard.html)),
fed by a daily collector. It charts commits, PRs, issues, code-review discipline,
languages, and a contribution heatmap across your repos and orgs. It's built to be
**publishable**: the committed `data/stats.json` carries only opaque per-repo aliases
(e.g. "Sneaky Raccoon") — never repo/owner names, issue titles, branches, or commit
messages. The alias↔name mapping is never serialized.

No identity lives in the source — the collector reads it from the environment
(`.env` locally, Actions secrets in CI). Set it up for yourself:

1. **Configure identity.** Copy [`.env.example`](.env.example) to `.env` (gitignored)
   and fill it in — the collector loads `.env` automatically:

   ```bash
   DASHBOARD_PAT=ghp_your_token_here          # classic PAT, scopes: repo, read:org, read:user
   DASHBOARD_LOGIN=octocat                     # your GitHub login
   DASHBOARD_EMAILS=you@example.com            # commit-author emails (CSV)
   DASHBOARD_OWNERS=octocat:user,your-org:org  # owners to scan, "name:type" (user|org)
   DASHBOARD_EXTRA_LOGINS=                     # optional: legacy/renamed logins to fold in
   ```

   Create the PAT at <https://github.com/settings/tokens>.

2. **Collect and commit:**

   ```bash
   node scripts/collect-stats.mjs                  # full trailing-12-month run
   git add data/stats.json && git commit -m "dashboard: initial stats"
   ```

3. **Publish** via GitHub Pages (Settings → Pages → deploy from `main`, root). The
   dashboard is then live at `/dashboard.html`.

4. **Automate** the daily refresh: add the same five variables as repo secrets
   (Settings → Secrets and variables → Actions) — `DASHBOARD_PAT`, `DASHBOARD_LOGIN`,
   `DASHBOARD_EMAILS`, `DASHBOARD_OWNERS`, and (optionally) `DASHBOARD_EXTRA_LOGINS`.
   The workflow in [`.github/workflows/dashboard.yml`](.github/workflows/dashboard.yml)
   runs a delta collection each morning and commits the result.

Collection modes:

| Invocation | Use |
|---|---|
| `node scripts/collect-stats.mjs` | full run — the whole trailing window |
| `… --delta` | only the current week, merged in (what the cron uses) |
| `… --repo owner/name` | recollect specific repos (repeatable); leaves the rest intact |
| `DIRECT_LOC_SLEEP_MS=150 node …` | speed up the per-commit LOC walk for one-off backfills (default 500ms is cron-safe) |

Full design notes and the data model live in [`docs/dashboard-spec.md`](docs/dashboard-spec.md).

## Tests

```bash
npm test     # exercises the YAML-subset config parser
```

## License

MIT — see [`LICENSE`](LICENSE).
