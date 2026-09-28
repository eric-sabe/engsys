# {{ORG}} fleet

This is {{ORG}}'s **fleet instance**: the configuration, context and org-specific pieces for a fleet of
always-on Claude Code sessions (a merge monster, a maintenance monster and attended build, investigate and
design sessions) that work on [`{{PIN_REPO}}`](https://github.com/{{PIN_REPO}}).

It holds config only. The machinery (host tooling, identity, gates, the monsters themselves) is
[engsys](https://github.com/eric-sabe/engsys), checked out on the fleet host at `ENGSYS_DIR` and pinned by tag in
`{{PIN_REPO}}/.claude/settings.json`. Nothing here is copied from engsys, so upgrading is a pin change.

## Layout

| Path | What it is |
|---|---|
| `fleet/fleet.conf` | Host settings and model policy (`KEY=VALUE`). `~/.config/{{ORG}}/fleet.local.conf` overrides it per machine |
| `fleet/roster.tmpl` | Which sessions run, with which model, prompt and env |
| `fleet/env/*.env.tmpl` | Per-lane session environments (`session` is the default lane; `security` is the maintenance monster's) |
| `fleet/supervisor.conf.tmpl` | The monsters and their ledger issues; enables the supervisor job |
| `jobs/launchd/*.plist.tmpl` | Extra or overriding launchd jobs |
| `scripts/fleet` | The entry point: a shim that runs the engsys fleet kit against this repo |
| `docs/TRANSITION.md` | Ownership register: everything that must transfer when the operator changes |
| `.fleet/` | Machine-local rendered state (gitignored) |
{{#if marketplace}}
| `.claude-plugin/`, `plugin/` | The `{{INSTANCE_MARKETPLACE}}` plugin: per-repo context and monster configs (`plugin/repos/<owner>/<repo>/`), org context (`plugin/context/org.md`), and a SessionStart hook that injects them |
{{/if}}
{{#unless marketplace}}
| `fleet/repos/<owner>/<repo>/` | Per-repo monster configs (the roster passes this directory to the monsters) |
{{/unless}}

Templates use `__NAME__` tokens filled from `fleet/fleet.conf` (and `fleet.local.conf`) when the fleet launches.

## Day to day

```bash
scripts/fleet status                  # pins vs what this host runs, and which sessions are behind
scripts/fleet sync                    # bring the host checkouts and plugins to the pins (no restarts)
scripts/fleet launch                  # start missing sessions (or: launch <name>)
scripts/fleet restart --stale         # cycle sessions that run an older pin, when you are ready
scripts/fleet pin --engsys vX.Y.Z     # move the engsys pin: opens the pin PR, waits, syncs
scripts/fleet install-jobs            # (re)install the launchd jobs (--dry-run to preview)
tmux attach -t {{NAMESPACE}}          # look at the sessions (detach: Ctrl-b d)
```

`scripts/fleet help` lists every command. Changing what runs is a PR here plus `scripts/fleet sync` and a restart.

## Docs

- engsys fleet guide: `docs/fleet-guide.md` in the engsys repo (the human guide to running a fleet)
- Identity (GitHub App): `core/fleet/identity/README.md` in the engsys repo
{{#if azure}}
- Azure service principal: `stacks/cloud/azure/fleet/README.md` in the engsys repo
{{/if}}
- Merge Monster and Maintenance Monster: the `merge-monster` and `maintenance-monster` skills in engsys
- Who owns what, and how to hand the fleet over: [`docs/TRANSITION.md`](docs/TRANSITION.md)
