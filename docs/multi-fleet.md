# Multi-fleet: several fleets working one org's repos (design)

> **Status:** Design (proposed 2026-10), being built in phases (section 10). Implemented so far: the
> registry, `FLEET_ID` and addresses (engsys#39, operator guide in
> [`fleet-guide.md` § 6.10](fleet-guide.md#610-registry-multi-fleet)), `gate-check` (#41) and
> `fleet notify` (#42). Nothing in this doc changes how a single fleet behaves today.
>
> **Related:** [`agent-messaging.md`](agent-messaging.md) (same-fleet messaging and the "GitHub
> channel" Phase 2 this builds on), [`fleet-guide.md`](fleet-guide.md) (running one fleet),
> [`merge-monster.md`](merge-monster.md) (the merge baton), and
> [`core/lib/lease`](../core/lib/lease/durable-lease.mjs) (the `durable-lease` API that the GitHub
> backend in section 2 slots behind).
>
> **Examples** use the placeholder organization `acme`: product repo `acme/app`, instance repo
> `acme/acme-fleet`, session namespace `acme-<role>` (`acme-mm`, `acme-build`), and two fleets named
> `alice` and `bob`, each run by the operator of the same name. Replace them with yours.

## Contents

1. [Summary](#summary)
2. [Terms](#terms)
3. [The registry](#1-the-registry)
4. [Singleton batons: a real lease on GitHub](#2-singleton-batons-a-real-lease-on-github)
5. [Fleet and host roles](#3-fleet-and-host-roles)
6. [Talking between fleets](#4-talking-between-fleets)
7. [Identity: one per fleet, everywhere](#5-identity-one-per-fleet-everywhere)
8. [Human approval happens in GitHub](#6-human-approval-happens-in-github)
9. [Slack: the fleet's own voice, calm by default](#7-slack-the-fleets-own-voice-calm-by-default)
10. [Versions and pins](#8-versions-and-pins)
11. [What engsys core provides vs what an instance configures](#9-what-engsys-core-provides-vs-what-an-instance-configures)
12. [Phasing](#10-phasing)
13. [Open items](#open-items)

---

## Summary

Today a fleet is one machine, one operator and one identity. Every coordination mechanism assumes it
is alone:

- The merge baton is a ledger heartbeat that any session can overwrite
  ([`mm-heartbeat.sh`](../core/skills/merge-monster/scripts/mm-heartbeat.sh)).
- The supervisor reads local tmux
  ([`fleet-supervisor.sh`](../core/skills/agent-sessions/scripts/fleet-supervisor.sh)).
- The session-name prefix (`acme-`) is the only trust fence between sessions.
- The GitHub App, the cloud identity and the model-provider login are shared by everything on the host.
- The lease primitive is explicitly single-host: "Single host, single filesystem, single clock …
  cross-machine use needs a different backend behind the same API"
  ([`durable-lease.mjs`](../core/lib/lease/durable-lease.mjs), the "Assumptions / seams" note).

Two fleets on two machines would not collide loudly. They would both merge, both heartbeat the same
ledger, and each would look healthy to the other.

The design, in five parts:

1. **Fleets are peers, not primary and secondary.** There is no special "main" fleet. Whichever fleet
   currently holds the repo-wide batons is declared in a registry file and moved by a PR. Handing the
   work to a new operator becomes one PR plus a supervised handover, not a host migration.
2. **Split roles by scope.** Merge and maintenance are **singleton per repo**: exactly one fleet holds
   each at a time, under a real GitHub-backed lease. Build, investigate and design are **per fleet**:
   every fleet can run them, and they feed the shared queues. The resource broker and its pool (for
   example local E2E slots) are **per host** and never cross machines.
3. **GitHub is the bus between fleets.** Same-fleet nudges stay on `SendMessage`. Across fleets, which
   usually means different humans on different model-provider accounts that cannot message each
   other, messages are structured GitHub comments. A small per-fleet relay job turns them into local
   nudges. Correctness still never depends on a message arriving.
4. **One identity per fleet in every system:** a GitHub App, a cloud workload identity, a code-review
   tool key, a Slack app and the operator's own model-provider account. Every action is attributable
   to a fleet, any fleet can be revoked alone, and offboarding a fleet means deleting its identities.
5. **Human approval happens in GitHub, never in chat.** Agents nudge the operator in the session and in
   Slack, but a gate opens only when a human on the operators team acts in GitHub: a PR review
   **Approve** for anything that merges, and a structured approval comment for other gated acts
   (applying a migration, accepting a risk, a production deploy). A "go ahead" in chat, a Slack reply,
   a peer message or anything authored by a bot never opens a gate.

## Terms

| Term | Meaning |
|---|---|
| **Fleet** | One operator's set of always-on sessions on one host, with its own identities. Has a short id, for example `alice` or `bob` |
| **Operator** | The human responsible for a fleet. One per fleet; a person can be on the operators team for several |
| **Federation** | The fleets working one org's repos, listed in the instance repo's registry |
| **Singleton role** | At most one holder per repo across the federation: merge, maintain |
| **Fleet role** | Any number, one set per fleet: build, investigate, design |
| **Host role** | Bound to one machine's resources: the resource broker and its pool |
| **Home fleet** | The fleet the registry assigns to hold a singleton role |
| **Address** | `<fleet>:<session>`, for example `alice:acme-build`. The unit for cross-fleet messages and handoff fields |

## 1. The registry

One file in the instance repo (`acme/acme-fleet`, at `federation.yml`) states who exists and who holds
what. Every fleet reads it at launch and on each supervisor tick. Changes go through PR review like any
other fleet config.

```yaml
version: 1
operators_team: acme/fleet-operators       # gates count only from human members of this team
fleets:
  alice:
    operator: alice                         # GitHub login
    host: alice-host
    github_app: acme-fleet-alice            # bot login: acme-fleet-alice[bot]
    cloud_identity: fleet-alice             # e.g. an Azure SP, AWS IAM role or GCP service account
    slack_operator: U0000000001             # Slack member id to mention for this fleet
    status_issue: 11                        # this fleet's own heartbeat/digest issue in acme/acme-fleet
    enabled: true
  bob:
    operator: bob
    host: bob-host
    github_app: acme-fleet-bob
    cloud_identity: fleet-bob
    slack_operator: U0000000002
    status_issue: 12
    enabled: true
repos:
  acme/app:
    merge:    { home: alice, ledger: 101, standby: [bob], failover: escalate }
    maintain: { home: alice, ledger: 102, standby: [bob], failover: escalate }
```

- **`home`** is the only fleet allowed to _claim_ a singleton baton.
- **`standby`** fleets may take over only as `failover` allows. The default is `escalate`: a stale
  holder raises one calm alert (section 7) and a human moves `home` by PR. The rationale is that an
  unattended takeover between two machines is the failure most worth avoiding, and a slow, deliberate
  handover costs little. `auto` (a standby claims the expired lease itself) stays in the schema for
  orgs that want it.
- **`enabled: false`** is a per-fleet kill switch. It sits one level above closing a ledger, which stops
  that role for every fleet.
- **`operators_team`** is the operator source `gate-check` reads (section 6). A user-owned repo has no
  teams, so `operators: [login:account-id, ...]` is accepted instead, with the same rules as
  [gate-check.md](gate-check.md#configuration-and-permissions).
- **Optional fields.** Every fleet field except `enabled` (default `true`) is optional, and so is a
  role's `ledger`, so a new instance's registry is valid before its ledger issues exist. `standby`
  defaults to `[]` and `failover` to `escalate`.

Each host's `fleet/fleet.conf` names its own fleet with `FLEET_ID` (`^[a-z][a-z0-9-]{1,20}$`), which every
session env carries. No `federation.yml` means single-fleet mode. The loader,
`core/fleet/lib/federation.mjs`, has no dependencies, so it reads a strict YAML subset (block maps, block
lists of plain values, one-line flow maps and lists, plain or quoted scalars, integers, booleans,
comments) and rejects anything else with the line number. The operator commands
(`fleet federation validate|get|home|address|status`, and the registry block in `fleet status`) are
in [`fleet-guide.md` § 6.10](fleet-guide.md#610-registry-multi-fleet).

## 2. Singleton batons: a real lease on GitHub

The ledger issue stays as the human-readable surface (digests, heartbeats, comments). What changes is
that **claiming** becomes atomic, using a git ref as a compare-and-swap lock.

- Each baton is a ref, for example `refs/engsys/batons/merge`, pointing at a tiny commit whose message
  records `holder: alice:acme-mm`, `token: <random>`, `expires: <ISO8601Z>` and `protocol: 1`.
- **Claim or renew:** create a new commit whose parent is the current tip, then update the ref with
  `force: false`. GitHub rejects the update if someone else moved the ref first, which makes it a true
  compare-and-swap. Creating a ref fails if the ref already exists, which covers the first claim.
- **Release:** a final commit with `holder: none`. **Takeover** after expiry follows the same
  compare-and-swap path, so two standbys cannot both win.
- **Fencing:** every merge-monster action (marking a PR ready, merging) first checks that it still holds
  the token. The current heartbeat has no equivalent. A monster that wakes from a long pause after
  losing the baton stops instead of merging.
- **Startup check:** a monster checks for a live holder before doing anything. Today it just writes a
  heartbeat.

This is the cross-machine backend that `durable-lease.mjs` anticipates, implemented as a `github`
backend for `core/lib/lease` behind the existing `acquire/release/heartbeat/status/reap/reconcile/list`
API. It needs a spike first (see [Open items](#open-items)): confirm GitHub accepts updates to a custom
`refs/engsys/*` namespace through an App token. The fallback is a dedicated branch (`engsys/batons`)
excluded from rulesets, which has the same compare-and-swap semantics.

### Handover

This is how a singleton role moves from one fleet to another, for example from `alice` to `bob`:

1. A PR to `federation.yml` changes `merge.home` from `alice` to `bob`. An operator reviews it and it
   merges normally.
2. The current holder sees the change on its next tick, finishes its current PR (never mid-merge),
   posts a handover digest on the ledger, and releases the lease.
3. The new home fleet's monster claims the lease and posts its startup digest. The ledger shows the
   handover end to end.

The supervisor changes to match. It relaunches a singleton monster only if **its own fleet** is that
role's home, and it reads the holder from the lease rather than from the shared heartbeat. That removes
the failure where host B relaunches its own monster because of host A's heartbeat.

## 3. Fleet and host roles

**Build, investigate and design** run per fleet, unchanged, except for work claiming:

- **Claim before working.** Add a `fleet:<id>` label and set the project board's owner field to the
  fleet id. `implement-issue` and `implement-project` refuse an issue claimed by another fleet.
  Assignees do not work for this, because an App token cannot be an assignee.
- **Branch names carry the fleet:** `agent/<fleet>/<n>-<slug>`, for example
  `agent/bob/412-retry-backoff`.
- **Handoffs to the merge queue are unchanged** (`mm:ready` plus an `mm-handoff` block), except that the
  `session:` field becomes an address (`bob:acme-build`).

**The resource broker and its pool** stay per host. Two hosts' pools have nothing to arbitrate between
them, so the broker reports on its **fleet's status issue** instead of a per-repo ledger. Lease owner
fences become `^<fleet>-acme-…` rather than `^acme-…`.

**Each fleet gets one status issue** in the instance repo. It carries heartbeats for all the fleet's
sessions, supervisor events, and the "rotation requested" protocol. A per-repo ledger is then needed
only for singleton batons, which is where a cross-fleet view matters.

## 4. Talking between fleets

| Path | Mechanism | Durable? | Use |
|---|---|---|---|
| Same fleet | `SendMessage`, unchanged (`crossSessionInbound: accept` on monsters, see [`agent-messaging.md`](agent-messaging.md)) | no | Nudges |
| Between fleets | A GitHub comment carrying a `fleet-msg` block, on the PR or issue it concerns, or on the target fleet's status issue | yes | Bounces, merges, escalations, handover |
| Fleet to human | `fleet notify` to the org's escalation channel in Slack (section 7) | yes | Pages |

A cross-fleet message looks like this:

```markdown
<!-- fleet-msg to="bob:acme-build" from="alice:acme-mm" re="acme/app#412" protocol="1" -->
Bounced #412: the migration has no down step. Details in the review comment above.
```

- **Relay.** Each fleet runs a small scheduled job with no LLM (launchd on macOS, like the
  supervisor). It polls GitHub every minute or so for `fleet-msg` blocks addressed to its fleet, using
  conditional requests so that an unchanged poll costs nothing against the rate limit. It delivers each
  message as a local `SendMessage` to the named session. If that session is gone, the message stays on
  GitHub, and the session finds it at its next startup. This is the "GitHub channel" Phase 2 from
  [`agent-messaging.md`](agent-messaging.md), built as a polling job. A channel plugin would need an
  inbound endpoint on the operator's network; a polling job does not.
- **Sender verification.** A `fleet-msg` is acted on only if the comment's author is a bot login
  registered in `federation.yml`, the `to` address names this fleet, and the referenced PR or issue
  exists. Then, as today, the receiver re-verifies everything on GitHub and treats the message as a
  pointer, never as authority. Per-fleet Apps (section 5) are what make the author check meaningful:
  with one shared App, every fleet's comments come from the same login.
- **Same-account cross-machine messaging** (Remote Control) stays available as an optimization when one
  person runs two hosts on one account. Nothing depends on it.

## 5. Identity: one per fleet, everywhere

Fleets may run on hardware the org does not own (an operator's own machine, for example). The org
therefore cannot rely on controlling the host. Control is **revocation-based**: the org owns every
fleet identity and can revoke any of them server-side, and credentials are short-lived (1-hour App
installation tokens, rotated cloud certificates).

| System | One fleet today | Multi-fleet | Why |
|---|---|---|---|
| **GitHub bot** | One App (`acme-fleet[bot]`), key on the host | **One App per fleet** (`acme-fleet-alice`, `acme-fleet-bob`), the same permission template, installed on the same org repos | An org can install a given App only once, so per-fleet attribution needs per-fleet Apps. Each fleet's private key stays on its own host, and revoking one fleet does not touch another |
| **Commit author** | One bot author | The fleet's own bot (`acme-fleet-bob[bot]`) | Every commit and PR names its fleet |
| **Human gates** | Convention ("operator-only"); the actor is never checked, and approval is often given in chat | GitHub-only approvals verified by `gate-check` (section 6) | Under a shared identity a bot can launder a gate by posting the approval itself. Verified GitHub approvals close that and leave an audit trail |
| **Cloud** | One workload identity, often named for the host | **A cloud workload identity per fleet** (for example an Azure service principal, an AWS IAM role or a GCP service account), certificate- or federation-based, granted **identical roles from a list of fleet principals in IaC**. Keep the role set as narrow as today (typically read plus model inference) | Per-fleet sign-in logs and cost attribution; disable one fleet's identity without stopping another |
| **Model provider** | The operator's login drives every session and Remote Control | **Each operator's own account** (a seat on the org's plan, or the operator's own). Never shared across fleets. Each operator should check their provider's data-use settings for company code as part of standing up | Billing and Remote Control follow the human. This is also why cross-fleet messages go through GitHub |
| **Slack** | Often posted through a person's Slack connector, so posts are authored by that person | **One Slack app per fleet** (`Acme Fleet (alice)`), bot token with `chat:write` only, on the fleet host (section 7) | Posts are attributable to a fleet instead of impersonating a person, and revocable per fleet |
| **Code-review tool** | One key per instance | One key per fleet | Per-fleet usage and revocation |
| **OS user** | The operator's own account | A dedicated OS user for the fleet on every host ([`fleet-guide.md` section 6.1](fleet-guide.md#61-dedicated-user-or-shared-account)) | A monster cannot reach the operator's personal `gh`, cloud CLI login or keychain |
| **Upstream repos** (for example the engsys repo itself) | The fleet App installed where its owner allowed | Only fleets whose App the upstream owner chooses to install | Upstream access stays by invitation. Multi-installation support in `gh-app-token.mjs` (`GH_APP_INSTALLATIONS`, engsys v1.6.0) works per App |

**GitHub permission template for a fleet App.** Use the same set the single-fleet App has today
(contents, pull requests, issues, actions, workflows, org projects and security events: write; checks,
statuses, metadata and vulnerability alerts: read). Every fleet App gets the full set rather than a
reduced "worker" subset, because singleton roles can move between fleets by PR, and a fleet that might
become home must already be able to merge. No fleet App gets Administration, so rulesets stay under
human control.

**Offboarding a fleet:** move every `home` away from it by PR, wait for the handover digests, set
`enabled: false`, then delete that fleet's App, disable its cloud identity, revoke its code-review key,
uninstall its Slack app and remove the operator from the team. Nothing the other fleets use changes.

## 6. Human approval happens in GitHub

In a single-fleet setup an operator gate is often cleared by the operator saying so in a session, or by
a GitHub comment that cannot be attributed to a person because everything posts as the shared bot. In
a federation the rule is simple: **chat and Slack are for asking; GitHub is for approving.**

### The flow, for every gated act

1. **Gate request.** The agent posts a request on the PR or issue the act concerns. It says what will
   happen, the exact target (PR head SHA, migration name and environment, workflow run, alert id) and
   how to approve. It carries a marker:

   ```markdown
   <!-- gate-request id="migrate-prod-20261004-412" kind="migration" target="acme/app#412@3f9c2e1…" -->
   ```

   On a PR the target carries the **full** 40-character head SHA (shortened here); a short prefix is
   cheap to collide.

2. **Nudge.** The agent tells the operator, in its own session when the operator is there and in Slack,
   mentioning the fleet's operator from the registry, with a link to the request. The nudge says
   "approve on GitHub", never "reply here".
3. **Approve in GitHub.** A human approves in one of two ways:
   - **Anything that merges** (migration PRs, dependency classes the instance marks never-auto,
     operator-gated PRs, security-sensitive changes): a PR review with **Approve** on the current head.
     Pushing new commits invalidates it.
   - **Any other gated act** (applying a migration to staging or production, accepting the risk on an
     alert, dispatching a production deploy, handing off a never-auto dependency update): a comment on
     the request's thread reading `/approve <gate-id>`, or `/deny <gate-id> <reason>`.
4. **Verify.** The agent proceeds only after `gate-check` confirms the approval. If the operator says
   "approved" in chat, the agent replies with the link and keeps waiting.

### `gate-check`

`gate-check` lives in engsys core and is used by every monster and by the implement workflows. It
accepts an approval only if all of these hold:

- The actor is a **User** (not a Bot) and a member of `operators_team`, checked live through the
  team-membership API.
- The approval is **specific**: the review is on the gate request's head SHA, or the comment names the
  gate id. A `merge` gate takes only a review and every other kind only the comment, so a merge
  approval never doubles as approval to run a migration in production.
- It is **newer** than the gate request and than the PR's latest push.
- The comment **has not been edited** since it was posted (`updated_at` equals `created_at`), so a later
  edit cannot turn a different comment into an approval.
- For a merge, GitHub's own review state does not disagree: no outstanding change requests, and
  `reviewDecision` is `APPROVED`, or empty because the branch requires no review for that PR (then the
  operator's approval on the head decides). `REVIEW_REQUIRED` keeps the gate shut.
- A user-owned repo has no teams, so an instance can list operators as `login:account-id`
  (`operators:`) instead of `operators_team`; see [gate-check.md](gate-check.md#configuration-and-permissions).
- The identity running the check, and the author of the gate request, never count as approvers, even
  when they are operators. An agent never posts an approval itself.

The agent records the verified approval (who, when, link) in its journal and as a one-line comment on
the thread. `project-closeout` mines that record later. Implementation, exit codes and the latest-push
signal: [gate-check.md](gate-check.md).

### Enforce it in GitHub too

Agent code is not the only line of defense. In the product repo's ruleset, require reviewers by file
path, for example:

| Path | Required approval |
|---|---|
| database migrations (for example `db/migrations/**`) | one from `@acme/fleet-operators` |
| infrastructure (for example `infra/**`) | one from `@acme/fleet-operators` |
| `.github/workflows/**` | one from `@acme/fleet-operators` |

Then even a buggy or compromised agent cannot merge those paths without a human review. **By default,
human approval is required on gated paths only**; everything else keeps agent merges behind the baton.
The rationale is that review effort should go where a mistake is expensive or hard to undo. An
instance can widen the list, up to requiring approval on every PR.

**What stays outside this.** Commands an operator runs personally (a push with a gate bypass, a local
migration on their own machine) are already human actions. The rule covers acts an **agent** would
otherwise perform on a human's say-so.

## 7. Slack: the fleet's own voice, calm by default

- **One Slack app per fleet**, owned by the org's workspace: `Acme Fleet (alice)`, `Acme Fleet (bob)`.
  Bot scope `chat:write` only, and the bot is invited to the escalation channel.
- **No read scopes.** Approvals come from GitHub, so a fleet never needs to read Slack. This retires the
  optional `messaging.operator_slack` reply-reading feature in the
  [merge-monster config](../core/skills/merge-monster/config.example.yml).
- **Do not reuse another bot's token** (an existing chat-ops or triage bot, for example). It would copy
  that service's credential, and whatever extra scopes it carries, onto every fleet host; it would give
  every fleet one shared voice; and humans replying to the other bot in a fleet thread would trigger
  that bot's own behavior. A fleet app is a short manifest with `chat:write` and takes minutes to
  install.
- **The token lives on the host**, in a `chmod 600` env file under `~/.config/<org>/` (for example
  `~/.config/acme/slack.env`), never committed, referenced from `fleet.conf` as `SLACK_ENV`.
- **Mentions:** a real Slack user group (for example `@fleet-operators`, sent as `<!subteam^…>`) for
  anything that needs any operator; the fleet's own operator, from the registry, for fleet-local
  issues. Plain text "@fleet-operators" notifies nobody, so create the group.

### `fleet notify`

One command, in engsys core, that every monster and job uses:

```bash
fleet notify --level info|action|alert --re <github-url> "<text>"
```

It posts with the fleet's bot token, prefixes the fleet id, mentions the right people for the level,
and falls back to a comment on the fleet's status issue if Slack is unreachable. Monsters stop using a
person's Slack connector for fleet posts.

### Message format

Calm, scannable, one post per incident:

```text
[alice] acme-mm: needs a decision
What: #412 changes a migration; it's waiting for an approval.
Why it's paused: migrations need an operator review.
What to do: approve the PR on GitHub: <link>. Nothing else is blocked.
```

- **Three levels, no sirens.**

  | Level | Meaning | Mentions | Emoji |
  |---|---|---|---|
  | `info` | FYI | none | ℹ️ |
  | `action` | a human decision is needed | the fleet's operator, once | 👋 |
  | `alert` | something is down or stuck | the operators group, once | ⚠️ |

  Emoji are informational. Never 🚨 or 🔴.
- **One post per incident**, then thread replies, then one "resolved" reply. The escalate-once latch
  the monsters already use applies to every level.
- **Every `action` post links to the GitHub place where the human acts.** It never says "reply here".

## 8. Versions and pins

- **All fleets run the same pins.** The pins stay where [`fleet-guide.md`](fleet-guide.md#where-the-pins-live)
  puts them. Protocol compatibility across fleets matters more than letting each operator upgrade on
  their own schedule.
- **Only the fleet holding the merge baton runs `fleet pin`.** The pin PR goes through the merge
  monster anyway. Other fleets run `fleet sync` when they see the pin change, through the relay or on
  their next supervisor tick.
- **Every baton commit and `fleet-msg` carries `protocol: N`.** A fleet whose protocol is older than the
  holder's stays out of singleton roles until it syncs. That keeps a mixed-version rollout safe.

## 9. What engsys core provides vs what an instance configures

| engsys core (generic) | Instance repo (for example `acme/acme-fleet`) |
|---|---|
| `federation.yml` schema and loader (`core/fleet/lib/federation.mjs`, `fleet federation`); `FLEET_ID` in `fleet.conf`; `<fleet>:<session>` addresses | The actual `federation.yml`: fleets, homes, standbys, operators team |
| `github` backend for `core/lib/lease` (ref compare-and-swap, fencing, expiry) | Baton ref names per repo |
| Merge and maintenance monsters: claim, renew and fence on the lease; handover on a `home` change; startup holder check | Ledger issue numbers |
| Supervisor: relaunch only home roles; per-fleet status issue | One status issue per fleet |
| Relay job, `fleet-msg` format, sender verification | Slack channel and operator member ids |
| Gate requests, the `/approve` and `/deny` grammar, `gate-check`; monsters and implement workflows wait on it | The list of gated acts and their kinds; the product repos' ruleset required reviewers by path |
| `fleet notify` (Slack bot backend, status-issue fallback, levels, incident latch) | Per-fleet Slack apps, `SLACK_ENV` files, the escalation channel, the operators user group id |
| Work claiming in `implement-issue` and `implement-project`; fleet-prefixed branches | The board's owner field name and values |
| `fleet init --join <instance-repo> --fleet <id>`: scaffolds a fleet entry, App manifest, env templates | Runbooks: "Stand up another fleet" and "Hand over the batons" |
| `fleet status --federation`: every fleet's status issue and every baton holder | IaC that grants role assignments to each fleet's cloud identity from a list of fleet principals |

## 10. Phasing

### P0: Separate identities

Do this before a second fleet stands anything up. Tracking: #39 (registry, `FLEET_ID`), #40 (work claiming),
#41 (GitHub-only approval), #42 (`fleet notify`), #43 (baton spike, unblocks P1).

- Create the new fleet's GitHub App, its cloud workload identity with role assignments in IaC, the
  operator's model-provider seat, and a code-review tool key.
- Optionally rename or recreate the existing identities with the `-<fleet>` suffix
  (`acme-fleet-alice`). This keeps naming symmetric but is not required: the existing App can simply
  become the first fleet's App.
- Write `federation.yml` with both fleets and add `FLEET_ID` to each host's `fleet.conf`.
- Add work claiming and fleet-prefixed branches, so two fleets cannot grab the same issue on day one.
- Add GitHub-only human approval (section 6): gate requests, `gate-check`, and required reviewers by
  path. This is worth having with one fleet too, so it goes first.
- Add per-fleet Slack (section 7): create the operators user group and the first fleet's Slack app, add
  `fleet notify`, and switch the monsters to it.
- **Rule until P1 lands: the second fleet runs no monsters.** It runs only build, investigate and design,
  plus its own broker. This is safe with today's code.

### P1: Real batons

- Spike the ref compare-and-swap, then build the `github` lease backend and the merge and maintenance
  monsters' claim and fence.
- Add the startup holder check; the supervisor reads home and holder.

### P2: Cross-fleet messages

- `fleet-msg` format, relay job, delivery to addresses in other fleets (the `mm-handoff` field already
  accepts them, from P0), `fleet status --federation`.

### P3: Handover

- Move `maintain.home`, then `merge.home`, to the other fleet by PR, each with a watched cycle.
- The former home fleet becomes standby, and can later be offboarded as described in section 5.

## Open items

1. **Spike:** confirm GitHub accepts compare-and-swap updates on a custom `refs/engsys/*` ref through an
   App installation token, including how rulesets and push protection treat that namespace. If it does
   not, use the `engsys/batons` branch excluded from rulesets.

   **Spike result (2026-10): go.** Script: [`core/lib/lease/github-ref-spike.mjs`](../core/lib/lease/github-ref-spike.mjs)
   (engsys#43). Ran against a test App installation on this repo, 20 trials per check.

   - An App installation token can `POST`/`PATCH`/`DELETE` refs under `refs/engsys/spike/*` with no
     interference: the repo's only ruleset targets the `main` branch, so a custom ref and an
     off-pattern branch both sail through untouched. Creating a ref that already exists returns 422
     ("Reference already exists"), which covers the first-claim check.
   - `PATCH .../git/refs/<ref>` with `force: false` is a true compare-and-swap. Two commits parented on
     the same tip, raced with two concurrent `PATCH`es, 20/20 trials: exactly one call returned 200 and
     the other 422 ("Reference cannot be updated"). Zero double-wins, zero double-losses.
   - A renew (create commit + update ref, the two calls the design assumes) ran p50 829 ms / p95
     1388 ms over 20 iterations. At a 5-minute renewal cadence that is nowhere near a budget concern;
     the whole run (claim, 20 renews, 20 race trials, release, on both ref styles) spent 88 of the
     installation's 5000 calls/hour.
   - Visibility is where the two options diverge. The custom ref never showed up in `git fetch`/`clone`
     with the default refspec (only an explicit `git fetch origin refs/engsys/spike/...` pulls it), and,
     more importantly, it generated **no** entry in the repo's events feed
     (`GET /repos/{o}/{r}/events`) across the whole run, zero `PushEvent`s, so it is invisible to the
     Activity tab, watchers and notifications. The branch fallback (`engsys-spike/baton-*`) is just as
     invisible to a default clone, but every renew showed up as a `PushEvent` in the events feed, since
     GitHub tracks branch pushes, which would be a steady trickle of noise at a 5-minute cadence.
   - **Conclusion:** build the `github` lease backend on custom `refs/engsys/batons/<role>`, not the
     branch fallback. Semantics are identical; the custom ref is silent where the branch is not.
2. **Slack workspace administration:** creating apps and user groups needs a workspace admin. Each
   instance should name who that is before P0.
