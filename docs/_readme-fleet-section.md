<!-- Drop-in section for the root README.md (integrator: place it after the plugin-mode "Option C"
     section, or before "Worker providers", then delete this file). Links are relative to the repo root. -->

## The always-on fleet: engsys fleet kit

engsys can run as an **always-on fleet** on one machine: a merge orchestrator, a security and dependency
watchdog, and interactive worker roles, each a named long-running Claude Code session in tmux, relaunched
by a supervisor that has no LLM in its restart path. The **fleet kit** (`core/fleet/`) is the host tooling
for it:

- **`fleet sync` / `fleet restart`**: your config, context and org skills live in a small *instance repo*;
  engsys stays a tag-pinned upstream. One `fleet sync` makes the host match the pins without touching a
  running session, and `fleet restart --stale` cycles sessions onto the new versions when you choose.
- **`fleet pin`**: cut a release of your instance plugin and open a reviewed, refs-only pin PR.
- **An identity that is not a person**: a GitHub App bot, scoped to the fleet's own processes through
  environment-carried git config and a `gh` shim, so nothing global is written and a person's own git and
  `gh` are untouched. An optional Azure service-principal login ships in the Azure pack.
- **`fleet install-jobs`**: renders and loads the launchd jobs (supervisor, identity health check).
- **`engsys fleet init`**: scaffolds the instance repo, and `/engsys:fleet-bootstrap` walks an agent through
  the whole bring-up, stopping wherever a human must create a credential.

**Quickstart** (macOS; the host needs `git`, `gh`, `jq`, `tmux`, `node` in `/opt/homebrew/bin`, and Claude
Code from Homebrew; details in the guide):

```bash
git clone https://github.com/eric-sabe/engsys ~/git/engsys            # the pinned checkout the kit runs from
engsys fleet init --into ~/git/acme-fleet --org acme --namespace acme \
  --pin-repo owner/repo --pin-dir ~/git/repo --instance-marketplace acme --identity github-app
#   ...a human creates the GitHub App and places its key (core/fleet/identity/README.md),
#   creates the ledgers (mm-setup.sh, mnt-setup.sh), and pins the release tags in owner/repo's .claude/settings.json
~/git/acme-fleet/scripts/fleet sync                                   # checkouts + plugins to the pins
~/git/acme-fleet/scripts/fleet launch                                 # start the sessions
~/git/acme-fleet/scripts/fleet install-jobs                           # supervisor + identity jobs
```

Read the [fleet guide](docs/fleet-guide.md) for the decisions (plugin vs copy mode, one repo vs several,
the instance-layer pattern, identity, models), the generic host setup, and day-2 operations including the
canary order for adopting an engsys release. Related: the
[identity kit](core/fleet/identity/README.md), the
[Azure service-principal login](stacks/cloud/azure/fleet/README.md), the
[`agent-sessions` skill](core/skills/agent-sessions/SKILL.md) (launcher, roster, supervisor), and the
[merge](docs/merge-monster.md) and [maintenance](docs/maintenance-monster.md) monsters.
