# {{ORG}} fleet: ownership and operator transition register

**The single source of truth for everything that must transfer when the fleet operator changes.** If
something is required to run the fleet (an account, a credential, a host, a role, a piece of tribal
knowledge) it belongs in a row here. If it is not in this register, assume it will be lost at handoff.

**How to use it**

- **Keep it current.** When you create an account, identity, secret or service, add a row the same day.
  When you de-personalize or rotate something, update its status.
- **No secret values here.** Rows are pointers: what it is, where it lives, who holds it, how it transfers.
  Actual secrets stay in the vault and on the host, never in git.
- **Status legend:** `ok` = role- or group-based, transfer-ready. `person` = works but is still tied to an
  individual. `unknown` = not documented, owner unknown. `planned` = not built yet.

Register created {{TODAY}}. Current principal operator: TODO (name, handle).

## 1. Accounts and ownership

Accounts that own things. Prefer a role or group over a person wherever the platform allows.

| Account or service | What it owns | Owner(s) today | Role or group alternative | Transfer how | Status |
|---|---|---|---|---|---|
| GitHub org `{{ORG}}` | Repos, the fleet App, teams | TODO | TODO: an owners team | Add the incoming owner, verify, remove the outgoing one | TODO |
| Cloud tenant and subscription | TODO | TODO | TODO | TODO | TODO |
| Domain and DNS | TODO | TODO | TODO | TODO | TODO |
| Package registry, chat workspace | TODO | TODO | TODO | TODO | TODO |

## 2. Machine and role identities

The fleet runs as its own identities, not as a person.

| Identity | Kind | Where it is registered | Owners | Secret pointer (section 3) | Status |
|---|---|---|---|---|---|
{{#if github_app}}
| Fleet GitHub App (`{{ORG}}-fleet[bot]`, TODO: confirm the slug) | Bot App, installed on `{{PIN_REPO}}` | Org settings, Developer settings, GitHub Apps | TODO | GitHub App env file and private key | TODO |
{{/if}}
{{#unless github_app}}
| Fleet GitHub identity | The host's own `gh` and git login (no identity kit) | The host account | TODO | The host's `gh` credential | person |
{{/unless}}
{{#if azure}}
| Fleet Azure service principal | Cloud SP, certificate credential | Entra app registration | TODO | Azure SP env file and certificate | TODO |
{{/if}}
| Operator groups | GitHub team, cloud group, chat group | TODO | TODO | none | TODO |

Setup procedures: the identity kit README in engsys (`core/fleet/identity/README.md`).
{{#if azure}}
The Azure service principal: `stacks/cloud/azure/fleet/README.md` in engsys.
{{/if}}

## 3. Secrets (pointers only)

| Secret | Lives at (path or vault entry) | Who can read it | Rotation | Last rotated |
|---|---|---|---|---|
{{#if github_app}}
| GitHub App private key | `~/.config/{{ORG}}/` (env file `{{GH_APP_ENV}}` names the `.pem`) and the vault | TODO | TODO | TODO |
{{/if}}
{{#if azure}}
| Azure service-principal certificate | env file `{{AZURE_SP_ENV}}` names it; and the vault | TODO | TODO | TODO |
{{/if}}
| Claude account credentials for the host | The host's Claude login | TODO | TODO | TODO |
| Review and CI tokens | TODO | TODO | TODO | TODO |

## 4. Host

| Item | Value |
|---|---|
| Machine | TODO (model, location, who has physical access) |
| OS account that runs the fleet | TODO |
| Disk-encryption recovery key | TODO: vault entry |
| Always-on settings (no sleep, auto-login policy) | TODO |
| Engsys checkout | `{{ENGSYS_DIR}}` |
| Pin repo checkout | `{{PIN_DIR}}` |
| Agent worktrees | `{{WORKTREES_DIR}}` |
| launchd jobs | `com.{{ORG}}.fleet.*` (`scripts/fleet install-jobs`) |
| Logs | `~/Library/Logs/{{ORG}}-fleet/` |

Rebuilding the host: clone the pin repo and this repo, clone engsys at the pinned tag, restore the env files
from the vault, then `scripts/fleet sync`, `scripts/fleet launch` and `scripts/fleet install-jobs`.

## 5. The fleet

| Item | Value |
|---|---|
| Engsys pin | `extraKnownMarketplaces.engsys.source.ref` in `{{PIN_REPO}}/.claude/settings.json` (`scripts/fleet status`) |
{{#if marketplace}}
| Instance pin | `extraKnownMarketplaces.{{INSTANCE_MARKETPLACE}}.source.ref` in the same file |
{{/if}}
| Session namespace | `{{NAMESPACE}}-*` |
| Merge Monster ledger | `{{PIN_REPO}}` issue TODO |
| Maintenance Monster ledger | `{{PIN_REPO}}` issue TODO |
| Kill switch | Close a ledger issue; the monster stops and the supervisor leaves it alone |

## 6. External services

| Service | What it does for the fleet | Account holder | Cost and limits | Status |
|---|---|---|---|---|
| Claude seat(s) | The sessions run on it | TODO | TODO | TODO |
| Code reviewer (`REVIEW_CMD`, if any) | Local review before `mm:ready` | TODO | TODO | TODO |
| Chat or paging service | Escalations | TODO | TODO | TODO |

## 7. Handing over the operator role

Do these in order.

1. Add the incoming operator to the role groups (GitHub team, cloud group, chat group) and as an owner of the
   fleet identities in section 2.
2. Rotate the shared secrets under the new ownership (section 3): generate the new key or certificate, deploy it
   to the host, confirm the fleet still authenticates, then delete the old one.
3. Transfer the account-level ownership that cannot be group-based (section 1): add the incoming person, verify,
   remove the outgoing one.
4. Hand over the host (section 4), or build a fresh one and move the fleet across.
5. Move the external services (section 6): seats, reviewer, paging.
6. Walk the incoming operator through `scripts/fleet status`, a `sync` and a restart, and the kill switch.
7. Update this register: principal operator, every row you touched, and the change log below.
8. Remove the outgoing operator from every group and account, then run the fleet for a day and watch the logs.

## 8. Change log

| Date | Change | By |
|---|---|---|
| {{TODAY}} | Register created from the engsys scaffold | TODO |
