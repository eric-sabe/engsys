---
description: Stand up an always-on engsys fleet for this project — gather the facts, scaffold the instance repo with `engsys fleet init`, create ledgers and labels, wire identity with the human, then sync, launch, install jobs and verify
argument-hint: "[org slug] [namespace] [pin repo owner/name]"
---

Arguments (optional): $ARGUMENTS

Walk the operator through standing up an **engsys fleet** for the current project on this always-on
machine. The human guide is
[docs/fleet-guide.md](https://github.com/eric-sabe/engsys/blob/main/docs/fleet-guide.md) (read it if you
have not; it is the source of truth for anything below). The kit is `core/fleet/` in the engsys checkout;
`ENGSYS_DIR` below means that checkout, pinned at a release tag (default `~/git/engsys`).

Examples use `acme`, `acme-fleet[bot]`, `owner/repo` and `acme-mm`. Substitute the operator's values.

## Hard rules

- **You never create credentials and never change organization settings.** You do not create a GitHub App,
  generate or download a private key, create a service principal or certificate, mint or paste a token,
  install or approve an App, accept permission changes, or change org, repo or billing settings. The human
  does each of those. When a step needs one, stop, say exactly what to do (below), and wait for them to
  confirm it is done.
- **Never read, print, copy, log or commit a private key or token.** You may reference a key by *path*. An
  env file may hold IDs, the key's path and the bot's author identity; it must be `chmod 600` and never
  committed.
- **Confirm before each side effect on shared systems:** creating or pushing a repo or tag, opening a PR,
  creating labels or ledger issues, loading launchd jobs, launching sessions. Say what you are about to do
  and to which repo, then do it once the human agrees. Never push to a default branch or merge anything
  yourself.
- **Local, reversible steps** (reading, `--dry-run`, rendering into a fresh directory, `--check`) need no
  confirmation.
- **Credentials are re-issued per host, never copied** from another machine.
- Monsters run unattended with bypassed permissions and hold batons. Before their first launch, confirm the
  human understands that closing a monster's ledger issue is the kill switch.
- Do not invent flags. If a command fails or a flag is not recognized, read its `--help` or the script and
  report what you found.

## 1. Gather the facts

Ask the human for everything below in **one message**, offering the defaults, then restate the answers back
as a table for confirmation before doing anything.

| Fact | Notes / default |
|---|---|
| Org slug (`FLEET_ORG`) | names `~/.config/<org>/`, `~/.cache/<org>/`, `~/Library/Logs/<org>-fleet/`, launchd labels `com.<org>.fleet.<job>` |
| Namespace | the session-name prefix (default: the org slug); sessions are `<ns>-mm`, `<ns>-maintain`, `<ns>-build`, ... |
| Pin repo `owner/name` and its local checkout (`PIN_DIR`) | the repo whose `.claude/settings.json` holds the version pins; also the sessions' default workdir |
| Repos the fleet serves | one merge monster and one maintenance monster per repo (multi-repo fleets get per-repo configs and a per-line repo in the supervisor conf) |
| Instance repo | where the fleet's config lives: local path (default `~/git/<org>-fleet`) and its GitHub `owner/name` |
| Instance plugin? | yes gives a marketplace name (for example `acme`): org context, per-repo monster configs, org skills. No means config only |
| engsys checkout and release tag to pin | `ENGSYS_DIR` and a released tag (for example `vX.Y.Z`), never a branch |
| Identity | `github-app` (recommended) or `none`; and cloud: `azure` or `none` |
| Account model | a dedicated macOS user (recommended) or the operator's own account (then set `FLEET_CLAUDE_CONFIG_DIR`) |
| Worktrees directory | where interactive roles work (default beside the checkout, for example `~/git/worktrees`) |
| Review command (optional) | `REVIEW_CMD` for the pin PR (for example a review CLI), plus `REVIEW_MARKER` and whether the PR should be labeled automatically |
| Model policy (optional) | alias pins per tier, per-role model and effort, and which model the security lane uses (guide section 8) |

## 2. Check the host (read-only)

Check and report; do not install anything without asking.

```bash
uname -sm; sw_vers -productVersion
command -v node claude tmux git gh jq; node -v; git --version; claude --version
dirname "$(command -v node)"        # must be /opt/homebrew/bin (launchd jobs search only there); NOT nvm or fnm
```

Flag: node outside `/opt/homebrew/bin`; Claude Code not from the Homebrew stable channel (it should be
installed with `brew install --cask claude-code` and never auto-updated); git older than 2.31; the fleet
user not logged in to the GUI (its launchd jobs and tmux sessions need that; after a reboot it must be logged
in again). Give the human the exact command to fix each, per guide section 6. Also check that `ENGSYS_DIR`
exists and is a git checkout; if not, tell the human to `git clone` it there, then continue.

## 3. Scaffold the instance repo

Run `engsys fleet init` (or, from the checkout, `node "$ENGSYS_DIR/install" fleet init ...`). It refuses to
guess: pass every flag from the facts.

<!-- verify-against: fleet-init -->
```bash
engsys fleet init --into <instance dir> --org <slug> --namespace <ns> \
  --pin-repo <owner/repo> --pin-dir <path> \
  [--instance-marketplace <name>] [--identity github-app|none] [--cloud azure|none]
```

If `<instance dir>` already exists and is not empty, stop and ask; never overwrite the operator's files.
Afterwards read what it produced (`fleet/fleet.conf`, `fleet/roster.tmpl`, `fleet/env/*.env.tmpl`,
`fleet/supervisor.conf.tmpl`, `scripts/fleet`, and, with an instance plugin, `.claude-plugin/` and
`plugin/`) and adjust it to the facts: the sessions and workdirs in the roster (an explicit absolute
workdir per repo in a multi-repo fleet), `WORKTREES_DIR`, model knobs, the supervisor lines per repo
(`<session>|<ledger>|<stale minutes>[|<owner/name>]`), and `GH_APP_ENV` when identity is on. Preview the
launchd jobs with `fleet install-jobs --dry-run` once the config is consistent.
Initialize git in the instance directory if needed and **commit locally**. Creating the remote repo and
pushing is the human's call: confirm first.

## 4. Ledgers and labels

Each monster needs its labels and a pinned ledger issue in the repo it serves. The setup scripts are
idempotent and fail closed rather than create a duplicate ledger. Run one pair per served repo, from the
pinned engsys checkout:

```bash
bash "$ENGSYS_DIR/core/skills/merge-monster/scripts/mm-setup.sh" --repo owner/repo
bash "$ENGSYS_DIR/core/skills/maintenance-monster/scripts/mnt-setup.sh" --repo owner/repo
```

Confirm with the human before running (it creates labels and issues in that repo). Prefer to run them as the
fleet's identity once identity (section 5) exists, so the ledgers belong to the bot; before that they run as
whoever `gh` is logged in as, which is acceptable if the human says so. If the `gh` identity lacks rights,
report it; do not work around it.

Each script prints `repo:` and `ledger_issue:` lines. Record the ledger numbers: in the monster configs
(`merge-monster.yml`, `maintenance-monster.yml` from each skill's `config.example.yml`, kept in the instance
plugin under `repos/<owner>/<repo>/`), and in `fleet/supervisor.conf.tmpl`. A ledger that is CLOSED is the
kill switch; if the script reports one, tell the human, do not reopen it yourself.

## 5. Identity

Skip when the human chose `none`. Otherwise **the human** does the following, following
`$ENGSYS_DIR/core/fleet/identity/README.md` (GitHub App) and, for a cloud principal,
`$ENGSYS_DIR/stacks/cloud/azure/fleet/README.md`. Ask for exactly this, and do none of it yourself:

**The human does (GitHub App):**

1. As an org owner, create the GitHub App (org Settings, Developer settings, GitHub Apps, New): webhook
   **inactive**; repository permissions Contents, Pull requests, Issues, Actions, Workflows = read and write;
   Checks, Commit statuses, Metadata = read-only; add Dependabot alerts / Code scanning alerts / Code quality
   (read-only) if the maintenance monster will use them.
2. If the fleet uses org project boards: **Organization permissions, Projects: read and write**. The page has
   **two "Projects" rows**; the repository-level one is the wrong one.
3. Install the App on the org with **only the repos the fleet operates on** (not "All"), and accept any
   permission request on the installation.
4. Generate a private key, and place it on the fleet host themselves (`~/.gh-app/<slug>.pem`, `chmod 600`).
5. Tell you these **non-secret** values: App ID, installation ID, App slug.

**You then:**

- Look up the bot's commit identity (read-only, allowed):
  `gh api '/users/<slug>[bot]' --jq '.id'`, giving author name `<slug>[bot]` and email
  `<id>+<slug>[bot]@users.noreply.github.com`.
- Write the machine-local env file (`~/.config/<org>/gh-app.env`, `chmod 600`, never in a repo) from those
  values and the **path** of the key, in the shape given in the identity README. Do not open the `.pem`.
- Set `GH_APP_ENV` in `fleet/fleet.conf` (or `~/.config/<org>/fleet.local.conf` for this machine only).
- Make sure `fleet/env/session.env.tmpl` unsets `GH_TOKEN`/`GITHUB_TOKEN` and puts
  `__ENGSYS_DIR__/core/fleet/identity/bin` first on `PATH` (fleet launch appends only the git identity and
  `GH_APP_ENV_FILE`); otherwise sessions' `gh` acts as whoever is logged in.
- Verify: `GH_APP_ENV_FILE=<env file> node "$ENGSYS_DIR/core/fleet/identity/gh-app-token.mjs" --check`.
  Exit 0 is required. Exit 3 means the token works but permissions are short: relay the listed permissions to
  the human, who fixes them in the App and accepts them on the installation. Then re-run `--check`.

**The human does (cloud, only if chosen):** creates the service principal and its certificate, places the
certificate on the host (`chmod 600`), and gives you the non-secret IDs. You write the machine-local env file
from those IDs and the certificate's path and point a roster `PREFLIGHT=` line and the session env at it.

If a review CLI needs its own login or API key on this host (for the pin PR's `REVIEW_CMD`), the human
generates and enters it. If that CLI depends on a GitHub App installed on the org, the human keeps it
installed (suspended is fine).

## 6. Pins

The pin repo's `.claude/settings.json` must declare the marketplaces at tags and enable the plugins:

```json
{
  "extraKnownMarketplaces": {
    "engsys": { "source": { "source": "github", "repo": "eric-sabe/engsys", "ref": "vX.Y.Z" }, "autoUpdate": false },
    "acme":   { "source": { "source": "github", "repo": "acme/acme-fleet", "ref": "v0.1.0" }, "autoUpdate": false }
  },
  "enabledPlugins": { "engsys@engsys": true, "acme@acme": true }
}
```

Prepare the change on a branch in the pin repo (merge into existing keys; never clobber the file). The
instance ref must be a tag that exists on the instance remote, so ask the human to push the instance repo and
its first tag (`git tag v0.1.0`) before you open the PR. Opening the PR and merging it are the human's call;
confirm, then present the PR. Wait until the pins are merged (or, for a one-time bootstrap the human chooses to
do directly, on `PIN_DIR`'s default branch) before syncing, because `fleet sync` reads the pins from the pin
checkout.

## 7. First sync, launch and jobs

Run these on the fleet host as the fleet user, from the instance checkout. Say what each does, and stop at
the first error, reading the message (guide section 10 lists the common ones).

```bash
scripts/fleet sync                # checkouts at the pins, plugins installed; touches no session
scripts/fleet status              # host in sync; every session "missing"
```

Confirm the monster warning above, then:

```bash
scripts/fleet launch              # renders .fleet/ and starts the sessions in tmux
tmux list-windows -t <ns>         # one window per roster session
scripts/fleet status
scripts/fleet install-jobs --dry-run
scripts/fleet install-jobs        # supervisor (5 min) and, with identity, gh-app-login (30 min)
launchctl list | grep com.<org>
```

## 8. Verify

Report each as pass or fail with the evidence, not as an assumption:

- `fleet status`: host in sync with the pins; every session running and current (none `missing`,
  `exited` or BEHIND).
- Identity (if on): `--check` exits 0; a commit made by a fleet session is authored by `<slug>[bot]`.
- Each monster's ledger heartbeat (`last: <time> — status: ...`) is fresh within a few minutes of launch.
- The launchd jobs are loaded and their logs (`~/Library/Logs/<org>-fleet/`) show a clean first run.
- Optionally, with the human's go-ahead, one small issue goes end to end through the implement command and
  the merge monster merges it.

## 9. Hand back

Finish with a short report: what was created (paths, repos, ledger numbers, tags), what passed, and the
**remaining human actions** (each credential or setting you were not allowed to touch, anything they deferred).
Remind them to fill in `docs/TRANSITION.md` (who holds each seat, key and secret, by name only, never the
value), and how to operate it from here: `fleet status`, `fleet pin`, `fleet sync`, `fleet restart --stale`
(guide section 7).
