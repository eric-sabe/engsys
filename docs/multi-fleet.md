# Multi-fleet: several fleets working one org's repos (design)

> **Status:** Design (proposed 2026-10), being built in phases (section 10). Implemented so far: the
> registry, `FLEET_ID` and addresses (engsys#39, operator guide in
> [`fleet-guide.md` § 6.10](fleet-guide.md#610-registry-multi-fleet)), work claiming and
> fleet-prefixed branches (`core/lib/claim.mjs`, #40), `gate-check` (#41), `fleet notify` (#42) and
> per-host roles (#53, [`fleet-guide.md` § 6.11](fleet-guide.md#611-host-roles-which-sessions-run-on-this-host)).
> Nothing in this doc changes how a single fleet behaves today.
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
  that role for every fleet. From engsys v1.9.0 the kit enforces it on that fleet's hosts: no monster
  (merge, maintain, broker, any supervised session) launches or is supervised; interactive roles run
  ([`fleet-guide.md` § 6.11](fleet-guide.md#611-host-roles-which-sessions-run-on-this-host)).
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
- **Fencing:** every monster write (marking a PR ready, merging, labels, comments, gate requests,
  dismissals, dispatching an agent that will push) first checks that it still holds the token. A
  monster that wakes from a long pause after losing the baton stops instead of merging (#62: see
  [P1](#p1-real-batons)).
- **Startup check:** a monster checks the registry and the lease for a live holder before doing
  anything, and acquires only where its fleet is home (#62).

This is the cross-machine backend that `durable-lease.mjs` anticipates. The spike (see
[Open items](#open-items)) confirmed that an App token can update a custom `refs/engsys/*` ref and that
`force: false` is a true compare-and-swap, so the backend uses the custom ref, not the branch fallback.

### The `github` backend (implemented, engsys#61)

[`core/lib/lease/github-backend.mjs`](../core/lib/lease/github-backend.mjs), zero dependencies, global
`fetch` with a 10 s timeout on every request. Token: `GH_TOKEN`, else the fleet's App token helper when
`GH_APP_ENV_FILE` is set, else `gh auth token`. Tests: `github-backend.test.mjs` next to it (offline,
against an in-process fake of the git data API that implements the two CAS rules, moves its clock
during requests and can serve lagging reads; a live test runs with `LEASE_GITHUB_LIVE=1
LEASE_GITHUB_REPO=owner/repo` on a scratch ref it deletes afterwards).

**API.** `createGithubLease({ repo, refPrefix?, fleet?, api? })` gives:

| Call | What it does | Result |
|---|---|---|
| `acquire({ role, holder, ttlMinutes })` | create the ref, or CAS over an expired, released or malformed tip | `acquired` (with `tookOverExpired` / `tookOverMalformed` + `previous` on a takeover; `confirmedByRead` when an earlier write of ours whose outcome was unknown turned out to have landed, reported from the tip), `held` (holder, expiry; `heldBySelf` when the tip carries our NAME with a token this caller does not have, including a second acquire on the same instance: never "held"), `protocol_unsupported`, `error` |
| `renew({ role, token, ttlMinutes })` (alias `heartbeat`) | CAS a commit with the same token and a new expiry | `renewed`; or **`lost: true`** with `lost` (token not on the tip, or the CAS lost and the re-read shows another holder), `expired` (our token, past expiry: no revival), `not_held`, `protocol_unsupported` |
| `assertHeld({ role, token, minRemainingMs? })` | one read, the fence | `held: true` only if the tip carries our token, is unexpired and has at least `minRemainingMs` left as of return; a read slower than 5 s is refused (`error`, `slow_read`); every other outcome, including an error, is `held: false` |
| `release({ role, token })` | CAS to `holder: none`, our token kept on the release commit | `released` (`wasExpired: true` if we overran the TTL: log it), `already_released` / `not_held` (idempotent), `lost` (another holder's token is on the tip), `protocol_unsupported` |
| `status({ role })`, `list()` | lock-free reads | `state` is `free` (no ref, or released), `held`, `unknown` (expired or malformed) or `error` (unreadable, or not a baton) |
| `breakGlass({ role, reason, expectSha })` | **operator only**: reset the ref to `holder: none` if the tip is still `expectSha` | `broke_glass` with `previous` (what it overwrote) and `forced` (true only for a tip the API cannot serve as a commit), `tip_moved` (nothing written), `not_held`, `error` |

TTL is capped at 24 hours. Not carried over from the file backend: `reap` (the takeover inside `acquire`
is the reap; a separate delete step would only widen the window) and `reconcile` (nothing local to
sweep).

CLI, one JSON object on stdout:
`node core/lib/lease/github-backend.mjs status|acquire|renew|fence|release|list --repo o/r --role merge --holder fleet:session [--token T] [--ttl 10m]`.
Exit codes: 0 ok, 1 refused (held, lost, expired, not held), 2 usage, 3 error, 4 the tip's protocol is
newer than this code. `break-glass --repo o/r --role R --reason '<why>' --expect-sha <tip> --i-know` is
the one operator action: it resets the ref to `holder: none` whatever the tip holds (a hostile
`protocol: 9999`, an expiry years out, a non-baton commit), prints what it overwrote, and refuses to
run without both flags. `--expect-sha` is the tip the operator inspected with `status`: if the tip is
no longer that sha, nothing is written (`tip_moved`). When the old tip is a readable commit the reset
is parented on it and written as a normal compare-and-swap, so a legitimate takeover that lands between
the operator's read and write survives (`tip_moved` again); `force: true` is used only for a tip that
definitively is not a commit the API can serve (a non-commit object, or a commit GET answering
404/422), after one more check that the tip still equals `--expect-sha`; a transient failure to read
the commit (5xx, timeout, 401/403/429) writes nothing. It is meant for a human at a shell, not an
agent or a monster. The engsys settings template (`core/templates/settings.json.tmpl`) denies
`Bash(*github-backend.mjs*break-glass*)` in every rendered project, and a fleet instance repo should
carry the same deny in its session settings, but treat that as a guard rail, not a boundary: a glob on
the command string is bypassed by `node -e`, an op passed through a variable, a copied script, or a raw
`gh api` PATCH by anyone with `contents: write`. The control that actually fences the write is
`--expect-sha`: whoever runs it must have inspected that specific tip.

**Where batons live.** `refPrefix` must be under `refs/engsys/` (default `refs/engsys/batons`);
`refs/heads`, `refs/tags` and anything else are rejected. A tip whose tree is not the empty tree is an
`error` for every operation and never a takeover: a takeover writes an empty-tree child commit, and on
a real branch that would read as "delete everything", which the ancestry check would allow.

**Commit format.** Each baton commit points at the empty tree, has the previous tip as its parent, and
carries the record in its message:

```text
baton merge: alice:acme-mm until 2026-10-04T12:10:00.000Z

holder: alice:acme-mm
token: 7c2e9a3e-4b7f-4d1c-9a2e-5f6b7c8d9e0f
expires: 2026-10-04T12:10:00.000Z
protocol: 1
fleet: alice
```

The first line is for humans. The rest is parsed as untrusted data: a strict line grammar (bounded
size, each known key exactly once, anchored values, unknown keys ignored), never evaluated. A tip that
fails the grammar is `malformed`: readers report it, a renewer treats it as lost, an acquirer may take
it over (it is indistinguishable from a dead holder). The `protocol:` line is the one that outlives
versions, and it is read first, before the size and character checks, so an old client sees "newer
protocol" even in a message it otherwise cannot read: a tip whose protocol is higher than the code's is
refused for takeover, renew, fence and release, so a fleet on older code stays out of a role a newer
fleet holds (section 8). Rule for every future version: keep `protocol: N` on its own line within the
first 4 KiB.

**CAS rule.** `PATCH force:false` succeeds only if the ref's current tip is an ancestor of the new
commit. Every writer here only fast-forwards, so that equals "the tip is still the one I read" unless
someone force-pushed the ref back to an ancestor meanwhile, and a force-pusher is inside the repo's own
trust boundary. "No revival" is decided on the read: a renew whose read saw the baton live may land
after the expiry instant. That is safe, because a taker that read after expiry built on the same tip
and the CAS lets exactly one of them through.

**Clock rule.** Expiry math never uses the local clock as an instant; a response without a `Date`
header is an error, not a local-clock decision. Decisions about someone else's baton (expired? may I
take over?) use the `Date` of the GET that observed the ref: it lags true server time by up to one
round-trip, which makes a lease look live slightly longer, the conservative direction. A new baton's
`expires` is that server time plus the TTL. Numbers handed to a holder (remaining time from
`assertHeld`, `acquire`, `renew`) are lower bounds: the latest `Date` seen during the call (the last
GET, or the CAS response), minus 1 s for the header's truncation to whole seconds, minus the local
wall-clock time elapsed since that request was *sent* (the server stamped it after the send, so this
counts the transit too). A fence read that took longer than 5 s is refused rather than answered late.
Assumptions: GitHub's front ends share one clock (NTP, well under a second apart) at 1-second
resolution, and the local clock runs at the right rate during a call. Callers still compensate with
cadence: renew at or under TTL/3, pass the action's expected duration as `minRemainingMs`, and keep a
local wall-clock deadline (`Date.now()`, not a monotonic clock, which stops while a laptop sleeps) past
which no mutating action runs.

**Failure semantics.** Every success is a CAS win (or, for the first claim, a successful create). A 422
is a decision, never resent: the caller re-reads the tip and decides again (bounded rounds). 5xx and
transport errors (including the request timeout) retry with jittered backoff, bounded; before resending
a write, and once more after the last failure, the backend re-reads the tip: if it already is the commit
the caller built, the write landed and is reported as the success it was; if it moved elsewhere, the
caller lost; only an unchanged tip resends. So a retry never double-applies. `acquire` also remembers
the tokens whose CAS outcome it could not learn (per instance, bounded): a later read showing one of
them on the tip (same holder, unexpired) is a confirmed win, reported from the tip and forgotten at
once so only one caller can confirm it; a token whose CAS is still in flight is never confirmed by
another caller, and a cleanly confirmed token is forgotten immediately, so two acquires on one
instance never both succeed. An unconfirmed write therefore never strands a baton for a TTL while the
process lives. A lagging replica can only ever cost a round (a false "lost"), never produce a false win. 429 and
secondary rate limits are errors like any other unexpected status (no `Retry-After` handling; the
heartbeat loop retries on its own cadence until its local deadline). Any other status or an exhausted
retry is `error`, and an error is never `held`.

The token is not a secret (anyone who can read the ref can read it): it fences stale holders, not
hostile ones. Anyone with `contents: write` can force-push the ref, which is the repo's own trust
boundary, not this primitive's; break-glass is the operator's remedy for a wedged or hostile tip.

**Caller rule (for the monsters' claim and fence).** TTL 10 min, renew every 3 min or less; on renew
`error` retry with backoff, on `lost: true` stop at once and never reuse the token. Keep a local
wall-clock deadline from the last successful renew or fence (`Date.now()` at request start plus
`expiresInMs`, minus slack). Immediately before each mutating act, `assertHeld` with `minRemainingMs`
covering the act's own timeout plus slack, then re-check the wall clock before sending. After a
takeover (`tookOverExpired` / `tookOverMalformed`), wait at least that long before the first mutating
act, so a zombie holder's in-flight action has finished or failed. `heldBySelf` and `error` are never
held. Release on clean shutdown.

### Handover

This is how a singleton role moves from one fleet to another, for example from `alice` to `bob`:

1. A PR to `federation.yml` changes `merge.home` from `alice` to `bob`. An operator reviews it and it
   merges normally.
2. The current holder sees the change within one renew (its watch bus emits `BATON_HANDOVER merge
   bob`), starts nothing new, finishes or parks its current PR (never mid-merge), posts a handover
   digest on the ledger, writes a final `handover to bob` heartbeat, and releases the lease.
3. The new home fleet's monster claims the lease and posts its startup digest: a standing-by monster on
   its next tick, or one bob's supervisor relaunches once the lease is free. The ledger shows the
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
fences become `^<fleet>-acme-…` rather than `^acme-…`. One shared `resource-broker.yml` serves every
fleet: the broker scripts resolve the status issue from `federation.yml` at run time, prefix the owner and
fence with `FLEET_ID` (`lease.fleet_qualify: false` opts out), and stop rather than fall back to the
shared ledger when the status issue can't be resolved. The lease store is a local path, so each host's
pool is its own.

The status issue then carries two heartbeat blocks, each rewritten only by its writer: the supervisor's
`<!-- fleet-heartbeat -->` (the fleet is alive; work claiming reads it) and the broker's
`<!-- broker-heartbeat -->`. The supervisor conf names the block to read for a session
(`<session>|<issue>|<stale>|<repo>|broker-heartbeat`), and `fleet supervise` writes that line for the
broker. Both writers edit the same body with a read-modify-write, so one can drop the other's fresh line;
the broker reads the body back after writing and retries, and any other writer of the issue should do the
same.

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
#41 (GitHub-only approval), #42 (`fleet notify`), #43 (baton spike, unblocks P1), #53 (per-host roles).

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
  plus its own broker. From engsys v1.9.0 the kit enforces this (#53, operator guide in
  [`fleet-guide.md` § 6.11](fleet-guide.md#611-host-roles-which-sessions-run-on-this-host)): with
  `FLEET_ID` and the registry in place, a host never launches, cycles or supervises a merge or
  maintenance monster whose home is another fleet, and `fleet sync` keeps the supervisor job unloaded on
  a host that supervises nothing. The manual workaround (launching sessions by name, `install-jobs
  --only`, checking after every sync that the supervisor is unloaded) is no longer needed.

### P1: Real batons

- Spike the ref compare-and-swap (#43, done), then build the `github` lease backend (#61, done:
  section 2) and the merge and maintenance monsters' claim and fence (#62, done: below).
- Add the startup holder check; the supervisor reads the holder from the lease (#62, done; it also
  still skips a monster whose home is another fleet, from #53).

**How the monsters hold their role (#62).** [`core/lib/lease/baton.mjs`](../core/lib/lease/baton.mjs)
wraps the backend with the caller rule; the monsters call it through `mm-baton.sh` / `mnt-baton.sh`
(startup, renew, fence, release, status: bookkeeping, auto-approved) and `mm-act.sh` / `mnt-act.sh`
(the fenced writes: `merge`, and `guard -- gh …`; behind a prompt). Where each caller-rule item lives:

| Rule | Where |
|---|---|
| TTL 10 min, renew at most every 3m20s | `TTL_MINUTES`, `RENEW_EVERY_MS`; `keepalive` (run by `mm-watch.sh` / `mnt-watch.sh`) renews every 2.5 min, and `mm-heartbeat.sh --state-dir` on every heartbeat |
| on `lost: true` stop, alert once, exit | a sticky `baton-<role>.lost` marker created with `O_EXCL`; its creator sends the one `fleet notify --level alert --incident baton-lost-<role>`; every later call refuses with no request; the token is never used again |
| local deadline | `Date.now()` at the start of the last good renew or `assertHeld`, plus its `expiresInMs`, minus 2 s; checked with `Date.now()` before every fence and again before every send |
| fence before each merge | `assertHeld` with `minRemainingMs: 60000`, the local deadline, the post-takeover wait, then < 30 s since the fence started, then `PUT /pulls/{n}/merge` with `sha=<validated head>` and a 30 s timeout, never retried |
| wait 60 s after a takeover | `notBeforeMs` (acquire return + 60 s); every fenced act refuses until then |
| `heldBySelf` and errors are never held | startup answers `wait_self` / `error` with `act: false`; a fence holds only on `held: true` |
| `wasExpired` release is an incident | `fleet notify --level alert --incident baton-overrun-<role>` |

The token is written 0600 to the monster's state dir so later shell calls of the same session can use it,
bound to the holder and to the launch (`ENGSYS_SESSION_RUN`, exported per launch by
`launch-agent-sessions.sh` with `ENGSYS_SESSION`): a new launch archives its predecessor's file unread
and waits out that baton (`wait_self`) rather than reuse its token. The background renewer stops when its
watch bus is orphaned or the model has not touched the baton for 45 minutes, so a renewer can never keep a
dead session's role alive. Holder: `<FLEET_ID>:<session>`, or `<hostname>:<session>` in single-fleet mode
(no `FLEET_ID` or no federation file), where the lease still guards against an accidental second session.
A role the registry declares no home for is decided by the lease alone (host-roles does not exclude
such a session either); an unreadable registry, or a `FLEET_ID` it does not declare, fails closed.

**Supervisor.** `fleet supervise` appends the role to the merge and maintain lines of the supervisor
conf (6th field). Before any relaunch of such a session, the supervisor runs `baton.mjs supervise`:
relaunch only when this fleet is home and nobody holds a live baton (free, released, expired, or a
malformed tip the monster will take over loudly). A live baton held by another fleet, or by this
session's own earlier launch, is a wait. A lease or registry read error is a wait plus one alert via
`NOTIFY_CMD` (`baton-read-<name>`), resolved on the next clean read. Two triggers are new and apply to
these sessions only: a `handover` heartbeat with the process gone, and a stale heartbeat with the
session idle at its prompt and its baton forfeited.

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
