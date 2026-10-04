# Fleet identity kit (GitHub App)

A fleet of always-on agent sessions should not run on a person's GitHub login. This kit gives the
fleet its own identity, a **GitHub App** (for example `acme-fleet[bot]`), so that:

- no personal credential sits in the automation path;
- agent commits, PRs and merges are attributable to the bot, distinct from human work;
- handing the fleet to someone else is a membership change, not an account transfer.

| File | Role |
|---|---|
| `gh-app-token.mjs` | Mints and caches a 1-hour installation token. Also a `git` credential helper. Zero dependencies. |
| `bin/gh` | A `gh` shim: runs the real `gh` with a fresh App token in `GH_TOKEN`. |
| `git-env.sh` | `fleet_git_env` / `fleet_git_env_lines`: the bot's git identity, scoped to the fleet's own processes. |
| `gh-app-login.sh` | Health check: token + permissions + env-scoped identity. Safe to run from a scheduler. |

## 1. Create the GitHub App

An org owner does this once, in the web console (there is no CLI for App creation).

1. Org **Settings, Developer settings, GitHub Apps, New GitHub App** (`https://github.com/organizations/<org>/settings/apps/new`).
2. **Name:** for example `Acme Fleet` (slug `acme-fleet`). **Homepage URL:** any valid URL.
3. **Webhook:** untick **Active**. The fleet polls; it needs no inbound webhook.
4. **Repository permissions.** Least privilege for what the fleet calls; leave everything else at "No access":

   | Permission | Level | Used for |
   |---|---|---|
   | Contents | Read and write | push branches and commits, merge |
   | Pull requests | Read and write | open, label, ready and merge PRs, update-branch |
   | Issues | Read and write | ledgers, labels, escalations, filing |
   | Checks | Read-only | CI state (`statusCheckRollup`, `gh pr checks`); the merge lane is blind without it |
   | Commit statuses | Read-only | legacy status contexts |
   | Actions | Read and write | `gh run list/watch`, `gh workflow run` |
   | Workflows | Read and write | pushes that edit `.github/workflows/*` are rejected without it |
   | Metadata | Read-only | mandatory, selected automatically |

   Optional, add only if a lane needs it (and list it in `GH_APP_REQUIRED_PERMS`, section 3):

   | Permission | Level | API name for `--check` | Used for |
   |---|---|---|---|
   | Dependabot alerts | Read-only | `vulnerability_alerts` | a maintenance lane reading Dependabot alerts |
   | Code scanning alerts | Read-only | `security_events` | a maintenance lane reading code scanning |
   | **Code quality** | Read-only | `code_quality` | GitHub Code Quality findings (`GET /repos/{owner}/{repo}/code-quality/findings`), a separate surface from code scanning |
   | Code scanning alerts | **Read and write** | `security_events` (`:write`) | dismissing alerts through the Maintenance Monster's standing false-positive policies (`fp_policies`); see below. Replaces the read-only row above |

   **Code scanning: write is optional.** Reading alerts needs only `security_events:read`. The write level is
   needed by exactly one thing: `mnt-fp-dismiss.sh` PATCHes an alert to `dismissed` (`PATCH /repos/{owner}/{repo}/code-scanning/alerts/{n}`),
   and only for rules a reviewed `fp_policies` entry covers. A fleet that does not use `fp_policies` should
   leave code scanning at read-only. Without write the dismiss script stops with a message naming this
   permission and changes nothing, so the monster falls back to proposing dismissals for the operator's
   `risk-accepted` label. To use it: set **Code scanning alerts** to **Read and write** on the App
   (section "Changing permissions" below: the installation must accept the change), then add
   `security_events:write` to `GH_APP_REQUIRED_PERMS` so `--check` verifies it. Setting that variable
   **replaces** the default list, so keep the defaults:

   ```bash
   GH_APP_REQUIRED_PERMS=contents:write,pull_requests:write,issues:write,actions:write,workflows:write,checks:read,statuses:read,metadata:read,security_events:write
   ```

5. **Organization permissions**, optional: **Projects: Read and write** (`organization_projects`), needed
   only if the fleet uses `gh project` (org ProjectV2 boards).

   > **Two "Projects" rows.** The permissions page has one under **Organization permissions** and another
   > under **Repository permissions**. Only the **Organization** one covers org ProjectV2 boards. The
   > repository-level row is for legacy repo boards; leave it at "No access". Setting the wrong one leaves
   > every org board invisible to the bot (`gh project list` prints "No projects found"), and `--check`
   > reports `organization_projects:write (has none)`.

6. **Where can this GitHub App be installed?** "Only on this account."
7. **Create GitHub App.**

## 2. Install it, record the IDs, generate a key

1. On the App's **General** page copy the **App ID** (`GH_APP_ID`) and confirm the slug in
   `https://github.com/apps/<slug>`.
2. **Install App** on the org, choosing **Only select repositories** (the ones the fleet operates on),
   not "All". The installation page URL ends in `/installations/<INSTALLATION_ID>`: that number is
   `GH_APP_INSTALLATION_ID`. As an org admin you can also list it:
   `gh api /orgs/<org>/installations --jq '.installations[] | select(.app_slug=="<slug>") | .id'`.
3. **Private keys, Generate a private key.** A `.pem` downloads. It is a secret: keep a copy in your
   vault, place the working copy on the host with `chmod 600`.
4. Look up the bot's commit identity (its no-reply email needs the bot's user ID):
   ```bash
   BOT_USER_ID=$(gh api '/users/<slug>[bot]' --jq '.id')
   echo "GH_BOT_AUTHOR_NAME=<slug>[bot]"
   echo "GH_BOT_AUTHOR_EMAIL=${BOT_USER_ID}+<slug>[bot]@users.noreply.github.com"
   ```

## 3. The env file

Machine-local, `chmod 600`, never committed. Plain `KEY=VALUE` lines (bash sources it, and the token
helper parses the same lines). There is **no default location**: the fleet config points at it
(`GH_APP_ENV` in `fleet.conf`), and the tools read it from `GH_APP_ENV_FILE`.

```bash
install -d -m 700 ~/.config/acme-fleet ~/.gh-app
mv ~/Downloads/acme-fleet.*.private-key.pem ~/.gh-app/acme-fleet.pem && chmod 600 ~/.gh-app/acme-fleet.pem
cat > ~/.config/acme-fleet/gh-app.env <<'EOF'
GH_APP_ID=123456
GH_APP_INSTALLATION_ID=7654321
GH_APP_PEM=/Users/fleet/.gh-app/acme-fleet.pem
GH_BOT_AUTHOR_NAME=acme-fleet[bot]
GH_BOT_AUTHOR_EMAIL=99999999+acme-fleet[bot]@users.noreply.github.com
# Optional:
GH_APP_SLUG=acme-fleet
FLEET_ORG=acme-fleet
# GH_APP_REQUIRED_PERMS=contents:write,pull_requests:write,issues:write,actions:write,workflows:write,checks:read,statuses:read,metadata:read
# GH_APP_INSTALLATIONS=pat-person=8765432
# GH_APP_CACHE=/path/to/token-cache.json
EOF
chmod 600 ~/.config/acme-fleet/gh-app.env
```

| Key | Required | Meaning |
|---|---|---|
| `GH_APP_ID` | yes | App ID |
| `GH_APP_INSTALLATION_ID` | yes | Installation ID |
| `GH_APP_PEM` | yes | Path to the private key (`~/` is expanded) |
| `GH_BOT_AUTHOR_NAME`, `GH_BOT_AUTHOR_EMAIL` | for git | Commit author for the env-scoped git identity |
| `GH_APP_SLUG` | no | Informational |
| `FLEET_ORG` | no | Names the cache directory: `~/.cache/<FLEET_ORG>/`. Default `engsys-fleet` |
| `GH_APP_REQUIRED_PERMS` | no | What `--check` requires: a comma list of `perm:level`. Default: the repo-level set in section 1 (contents, pull_requests, issues, actions, workflows = write; checks, statuses, metadata = read). Setting it **replaces** the default, so include the defaults you still want |
| `GH_APP_INSTALLATIONS` | no | More installations of the same App, as a comma list of `owner=installation-id`. Each owner's repos get a token from its own installation; every other owner gets `GH_APP_INSTALLATION_ID`. See section 7 |
| `GH_APP_CACHE` | no | Full path of the token cache file. Overrides the default `~/.cache/<FLEET_ORG or engsys-fleet>/gh-app-token-<installation id>.json`. Installations from `GH_APP_INSTALLATIONS` get their id before the extension (`token-<id>.json`) |

Values already in the process environment win over the file. The token cache is written `0600` in a
`0700` directory (the directory mode is enforced only for the default location); a token is never
written anywhere else.

`GH_APP_API_URL` (process environment only) overrides `https://api.github.com`, for GitHub Enterprise
Server or for tests.

## 4. How env-scoped identity leaves a person's own git and gh untouched

git reads config from the environment (`GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`,
git 2.31 or newer) at the highest precedence, above `~/.gitconfig` and the repo's own config. `git-env.sh`
puts four entries there:

1. `credential.https://github.com.helper` set to empty, which **resets** every helper inherited from other
   config (the macOS Keychain helper included);
2. the same key set to `gh-app-token.mjs git-credential`, so github.com over https authenticates as the App;
3. `user.name` and 4. `user.email` from `GH_BOT_AUTHOR_NAME` / `GH_BOT_AUTHOR_EMAIL`.

Every process the fleet starts inherits that environment, so it commits and pushes as the bot. Nothing
is written to `~/.gitconfig` or the Keychain, and nobody's `gh auth login` is changed, so a person's own
git and `gh` on the same machine (a shared laptop, or a fleet on your own account) behave exactly as before
outside fleet processes. The `gh` shim works the same way: it is on `PATH` only for fleet sessions, and
sets `GH_TOKEN` for the one command it runs.

Two entry points, both idempotent (a `FLEET_GIT_ENV=1` guard stops nested callers from adding the entries
twice, and an existing `GIT_CONFIG_COUNT` is appended to):

```bash
. core/fleet/identity/git-env.sh
fleet_git_env ~/.config/acme-fleet/gh-app.env        # export into this shell (host scripts)
fleet_git_env_lines ~/.config/acme-fleet/gh-app.env  # print KEY=VALUE lines to append to a session env file
```

Break-glass: call the real `gh` by absolute path (for example `/opt/homebrew/bin/gh`) to act as whoever
that `gh` is logged in as. An installation token has no "user", so `gh api /user`, `@me` and
`gh auth status` do not describe the bot.

## 5. Health check: `--check` and `gh-app-login.sh`

```bash
GH_APP_ENV_FILE=~/.config/acme-fleet/gh-app.env node core/fleet/identity/gh-app-token.mjs --check
```

`--check` always mints a **fresh** token (a cached one carries the permissions it was minted with),
compares its permissions with `GH_APP_REQUIRED_PERMS` and lists the repos the installation covers.
With `GH_APP_INSTALLATIONS` set it checks each installation in turn; those extra installations only need
`contents:write`, `pull_requests:write` and `metadata:read` (section 7).

| Exit | Meaning |
|---|---|
| 0 | Token valid, all required permissions present |
| 3 | Token works but permissions are short. The message lists each one, for example `issues:write (has none)` |
| 1 | Anything else: env file, key or API problem |

`gh-app-login.sh [env-file]` (argument or `GH_APP_ENV_FILE`) runs `--check`, treats exit 3 as a warning
and any other failure as a failure, and then verifies that the env-scoped identity resolves to the App
credential helper and the bot author. It writes nothing global, so it is safe on a shared machine and as
a launchd job (the fleet kit ships a 30-minute job template).

### Changing permissions

1. App **Permissions & events**, set the permission, **Save changes**.
2. The installation must **accept** it: org **Settings, GitHub Apps, Installed GitHub Apps**, then the
   App, then **Review request**, **Accept new permissions**. Until accepted nothing changes.
3. Re-check. `--check` mints fresh, so no cache clearing is needed (`gh-app-token.mjs --refresh` also
   re-mints for callers using the cache).

## 6. Rotating the private key

Overlap the keys so there is no gap:

1. App settings, **Private keys, Generate a private key** (the old key stays valid).
2. Place the new `.pem` on the host (`chmod 600`) and point `GH_APP_PEM` at it (or overwrite the file).
3. `gh-app-token.mjs --check` (fresh mint with the new key), and `gh-app-login.sh`.
4. Delete the old key in the App settings, and remove the old file from the host and from vaults you no
   longer want it in.

Rotate on a handoff of fleet ownership and whenever a key may have been exposed.

## 7. More than one installation (repos outside the org)

The App's own installation covers the org's repos. To let the fleet push branches and open PRs on a repo
owned by another account (for example a maintainer's personal repo the fleet depends on), install the
same App there; no second key is needed.

1. If the App was created for "only this account", open its settings, **Advanced**, **Make public**.
   Public only means other accounts may install it; permissions stay under the App owner's control.
   GitHub won't make it private again while another account has it installed.
2. Signed in as that account: `https://github.com/apps/<slug>`, **Install**, pick the account,
   **Only select repositories**, the repo(s). The page you land on,
   `https://github.com/settings/installations/<id>`, holds the installation id.
3. Add it to the env file: `GH_APP_INSTALLATIONS=<owner>=<id>` (comma-separate more).
4. On the repo, add a branch ruleset on the default branch that requires a PR and an approval, with
   **Repository admin** in the bypass list. The App has no Administration permission, so it can open
   PRs but can't merge them, push to the branch, or change the ruleset; the admin bypass lets the
   owner merge their own PRs.
5. `--check` (section 5) should report an `OK (<owner>)` line.

Permissions belong to the App, not the installation: the other account grants the repo everything the
App holds, not just the PR minimum. Workflows + contents write lets a pushed branch run a workflow with
that repo's Actions secrets. Keep anything that matters behind an Environment that needs approval. The
other account can revoke all of it at any time by uninstalling the App (**Settings, Applications,
Installed GitHub Apps**).

How a call picks the installation: `git` sends the repo path to the credential helper (git-env.sh sets
`credential.https://github.com.useHttpPath`), and the helper uses the path's owner. The `gh` shim picks
the first of, in order: `GH_APP_OWNER`; `--owner <login>` / `--owner=<login>` (names the account a
command like `gh project`, `gh repo list` or `gh search --owner` acts on, so it outranks a repo named
elsewhere in the same invocation — e.g. `gh project item-add 89 --owner FeedFrwd --url
https://github.com/eric-sabe/engsys/issues/53` adds an eric-sabe issue to a FeedFrwd board and needs
the FeedFrwd installation); `-R`/`--repo`; a `gh api repos/<owner>/...` path; a
`https://github.com/<owner>/...` argument; otherwise the current repo's `origin`. Commits are authored
by the bot (`GH_BOT_AUTHOR_*`) in every repo, so its PRs can be approved by the repo owner.

