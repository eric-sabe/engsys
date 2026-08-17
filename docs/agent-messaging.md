# Merge Monster — cross-session agent communication (design)

> **Provenance:** design + worked example from FeedFrwd/keystone, the first
> deployment (2026-08). The normative, project-agnostic contract lives in the
> skills (`core/skills/merge-monster`, `maintenance-monster`,
> `subagent-liveness`, `agent-sessions`) — read `keystone-<role>` here as
> `<your-namespace>-<role>`, and keystone issue/PR numbers as the case study.

Status: **Phase 0 + Phase 1 build.** This doc and the Phase 1 skill/protocol
changes land together in one PR, held unmerged until the next Claude Code
**session reset** (when the ad-hoc live sessions are torn down and relaunched
under the `keystone-<role>` names below — see [Rollout](#rollout)). Nothing here
changes a _running_ session's behavior: a live session has already loaded its
skill, and messaging is off unless the `messaging:` config block is present.
Phase 2 (the GitHub channel) stays future. See the
[enqueue protocol](prompts/merge-monster-protocol.md) for how sessions
coordinate today.

## The problem

Coordination between our Claude Code sessions is entirely GitHub-mediated
polling. An enqueuer writes the `mm:ready` label; Merge Monster's `mm-watch`
notices on its next ~30s poll. Merge Monster bounces a PR (removes `mm:ready` +
comments); the authoring session finds out _whenever it next looks_. The baton
check ("is Merge Monster active?") is a ledger-issue heartbeat round-trip with a
staleness window of up to `stale_lock_minutes` (45 min).

The second gap — author-notification latency — is the real cost. When Merge
Monster bounced #3132 (8 Dockerfiles missing a `COPY`) and #3100 (missing review
marker), the authoring session simply had to _notice_.

[Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
and [channels](https://code.claude.com/docs/en/channels) can close these gaps —
but only if we respect what they are and are not.

## What the primitives are (and their hard limits)

### Cross-session messaging — `SendMessage` / `ListAgents`

Session-to-session, **plain-text**, **best-effort** nudges, addressed **by
session name**.

- **Plain text only** — no structured payloads. A "go look at this" poke, not
  data transport.
- **Best-effort** — a message can be delivered, held, or dropped. Nothing
  persists if the target is offline.
- **Scoped to the OS user, not the project.** Every session the same user runs
  on a machine binds a socket the others can see. There is **no built-in
  sender allowlist** for peer messages.
- **The bypass-permissions trap.** `crossSessionInbound` takes one of three
  values — `accept` (deliver to Claude), `hold` (show a notice, don't deliver),
  `refuse` (drop). With no explicit value, the default is permission-mode-based,
  and that default is the trap: a session **running with bypassed permissions
  holds all inbound messages** except those from a sender that _also_ bypasses,
  opening an approval dialog in the receiving session. An unattended Merge
  Monster would silently queue nudges behind a dialog nobody is watching.
  `crossSessionInbound: accept` is therefore a **required** setting for the
  autonomous MM, not a nicety.
- **Rate-limited** — identical repeats arriving within a short window are
  dropped, per-sender repeats are throttled, and accepted-but-unread messages
  cap at **50 per session**. One nudge per state change, never a status stream.
- **Same-machine** via a per-session socket (never through Anthropic servers);
  reaching a session on _another_ of your machines routes through Anthropic
  servers over that machine's Remote Control connection (requires Remote Control
  on both ends, and Claude Code ≥ 2.1.225 to _initiate_ across machines).

### Channels

An MCP-server plugin that pushes **external** events _into_ a running session
(the inverse of a normal MCP server). Stock plugins are chat bridges
(Telegram / Discord / iMessage); a GitHub/CI use requires **building a custom
webhook-receiver channel**. Research preview; requires Anthropic auth; events
arrive only while the session is open. See [Phase 2](#phase-2--github-channel).

## Design principle: GitHub stays the source of truth

Messaging is a **latency layer**, never the system of record. GitHub (the ledger
issue, the `mm:*` labels, the PR comments) remains durable, cross-machine,
auditable, and the closeout-ceremony's mining surface. **Correctness must never
depend on a message arriving.** Every messaging path degrades to today's
poll-based behavior when a nudge is held, dropped, or the peer is gone.

The two primitives are complementary:

- **Channel** = _external system → session_. Brings the **event in** ("GitHub
  says #3140 is `mm:ready`", "main CI went red").
- **Messaging** = _session ↔ session_. Fans the **consequence out** (MM →
  author: "bounced #3132, fix the COPY lines").

## Naming convention (the namespace fence)

Because addressing is by name and scoped to the OS user — not the project — with
several projects' sessions on one Mac mini, isolation is **convention enforced
in the skill**, not a platform ACL.

- Every FeedFrwd/keystone session is named **`keystone-<role>`**. Set at launch
  with `--name` (see [the launch script](../scripts/launch-keystone-sessions.sh)).
  The durable role set fired up on every cold start:

  | Session                | Role                                                                                                                                                                                                               |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `keystone-mm`          | Merge orchestrator (owns the merge baton)                                                                                                                                                                          |
  | `keystone-build`       | Implementation — ship features / fix bugs                                                                                                                                                                          |
  | `keystone-maintain`    | Security/dependency watchdog (`/maintenance-monster`, Phase 1 read-only) — watches Dependabot PRs + GHAS/CodeQL, triages, and reports; from Phase 2 drives fixes into `mm:ready` PRs for `keystone-mm` (see below) |
  | `keystone-investigate` | Bug investigation / root cause / issue filing                                                                                                                                                                      |
  | `keystone-design`      | Product / UX design + specs                                                                                                                                                                                        |

  Ad-hoc sessions (e.g. `keystone-p70` for a specific project push) follow the
  same prefix.

- The merge orchestrator is **`keystone-mm`**. Per-repo prefixing is what makes
  **multiple Merge Monsters on one machine** safe: `keystone-mm` and
  `campos-mm` never collide. (If two sessions ever _do_ share a name, Claude
  Code keeps the name on the first and renames the second to a variant, making
  addressing ambiguous — the prefix avoids that. Disambiguate any residual
  collision by the working directory shown in `/list-agents`, or the short
  `[ref]` Claude Code appends to collided rows.)

## Discovery — repo-scoped, not a blind peer scan

Do not scan all peers and guess. Each side advertises its address through a
repo-scoped surface:

- **Merge Monster** writes its own addressable name (`keystone-mm`) into the
  **ledger issue** (#2792) session-start digest. An enqueuer reads the MM
  address from _its own repo's ledger_ — inherently repo-scoped.
- **Authoring sessions** advertise _their_ name in the PR's `mm-handoff` block
  (below). The PR is in MM's repo, so the mapping is repo-scoped too.

`ListAgents` is **already the live registry of who exists** — never maintain a
separate register-on-start list; it drifts into lies when sessions die uncleanly
(socket-close, no resume). The only thing that needs recording is the _work →
session_ mapping, and its natural home is the PR handoff (per-PR, self-cleaning).

## The `mm-handoff` `session` field

Extend the existing handoff block with an optional `session` field. The
enqueuer already posts this comment when it labels `mm:ready`; this adds one
line.

```markdown
<!-- mm-handoff -->

project: 70
phase: P3
session: keystone-p70 # addressable name — the nudge target
machine: mac-mini # optional: same-machine socket vs needs Remote Control
notify: true # optional: author opt-out of nudges
depends_on: [3130]
migration: false
```

Only `session` is essential. It is authoritative for authorship: the session
that wrote the handoff is the one that wants nudges about this PR.

## Send flow (Merge Monster → author), with graceful degradation

On a state change the author would act on — **bounced**, **escalated**,
**merged**, **blocked-needs-you** — after the GitHub action (label + comment):

1. Read `session` from the handoff.
2. Filter `ListAgents` to `keystone-*` (the namespace fence); match the name
   (disambiguate by cwd if needed).
3. **Match + reachable** → `SendMessage` a one-line nudge referencing the PR and
   the action.
4. **No match** (dead, renamed, or on a different machine than the mini) → skip
   silently. The PR comment + label are already posted, so it falls back to
   today's poll-based behavior.

Nudge only on actionable transitions — never routine queue-position updates
(rate limits and noise). Migration acks and prod-IaC go/no-go are **not**
nudge targets: a peer message can't grant consent, so those stay human-routed
(`PushNotification`).

## Receive validation (the real safety net)

Nothing at the platform level stops a confused other-project session from poking
`keystone-mm`. Because a peer message **cannot approve anything or change
configuration**, and MM already re-verifies everything against GitHub before
acting, a stray message is at worst ignorable noise. Make that explicit:

Act on an inbound message only if **both**:

1. the sender is a `keystone-*` session, **and**
2. the referenced PR / issue actually exists in `FeedFrwd/keystone`.

A "merge #999" from `campos-mm` references a PR not in our repo → no-op. Treat
every inbound message as an untrusted hint that triggers a GitHub re-check, never
as an instruction to act on directly.

## Operator replies over Slack (closing the escalation loop)

Today an escalation is fire-and-forward: MM posts `mm:escalated` + a diagnosis to
`#engineering-escalation`, and the operator has to come back to GitHub and act
(merge, label, comment) for MM to notice on its next poll. MM can instead **read
the operator's Slack reply** and act on it, closing the loop without a GitHub
round-trip. This is the one inbound path where a message _can_ carry operator
**consent** — precisely because it is the verified operator, not a peer session.

- **Mechanism, not a channel.** No stock channel bridges Slack (channels ship
  Telegram / Discord / iMessage only), so this is **poll-based** via the Slack
  MCP (`slack_read_channel` / `slack_read_thread` on `#engineering-escalation`,
  `C0B741GHA3A`), read on MM's existing wake cycle — not an event push. To
  correlate reliably, MM posts each escalation as a thread it records the
  `message_ts` for, then re-reads that thread for replies.
- **Best-effort, GitHub still authoritative.** The Slack MCP is claude.ai-authed;
  it is **demonstrated working on the always-on Mac mini**, but auth can lapse,
  so this stays a latency accelerator. The operator acting on the PR directly
  (merge / label / comment) always works and remains the recovery path — exactly
  the degradation principle above.
- **Three gates before an operator Slack reply is acted on** (all required):
  1. **Verified operator.** The reply's Slack `user` id is on an explicit
     operator allowlist (e.g. `U0A4ANMJQ3H`) — never an arbitrary channel member
     or a bot post.
  2. **Correlated.** The reply is in (or references) an escalation _MM itself
     posted_, matched by recorded thread `message_ts` or the PR/issue number in
     MM's escalation.
  3. **Re-validated against GitHub.** The instruction is re-checked against live
     GitHub state before acting. A Slack "merge it" grants the **human decision**
     only; it never bypasses a hard gate — MM still refuses to merge red required
     checks, unresolved review threads, or a ruleset block, and still never
     `--admin`s. Ambiguous replies are re-asked, never guessed.

Consent that a peer message cannot give (migration acks, prod-IaC go/no-go), a
verified operator Slack reply _can_ — under the same three gates. This is opt-in
via `messaging.operator_slack` in the config (below); absent it, escalations stay
fire-and-forward.

## Derived project roster (for the rare non-PR nudge)

Per-PR handoff can't address non-PR-scoped cases (a `MAIN_RED` whose culprit
already merged; "heads-up to whoever's driving Project 70"). Rather than a
maintained registry, **derive** a soft `project → last-seen session (via PR #)`
map from the handoffs MM already processes, and keep it in `state.md`. Because it
is derived, it can't drift into a lie the way a register-on-start list does; it
is explicitly "last known" and re-checked against `ListAgents` before use.

## Config additions

A `messaging:` section in `.claude/merge-monster.yml`, off by default so the
absence of it is exactly today's behavior:

```yaml
messaging:
  session_name: keystone-mm # MM's own addressable name; advertised in the ledger
  notify_author: true # send nudges on bounce/escalate/merge
  namespace_prefix: keystone- # only ever address / trust names with this prefix
  inbound: accept # documents the required crossSessionInbound value
  operator_slack: # optional: read operator replies to escalations (best-effort)
    enabled: false # off by default → escalations stay fire-and-forward
    channel_id: C0B741GHA3A # #engineering-escalation
    operator_user_ids: [U0A4ANMJQ3H] # allowlist; a reply from anyone else is ignored
```

## Phase 2 — GitHub channel

A **custom webhook-receiver channel** would replace `mm-watch`'s 30s poll with
event-driven wakeups: a GitHub `pull_request` (labeled `mm:ready`),
`check_suite`, or `workflow_run` event pushes a compact event into MM's session
the instant it happens. Bigger lift, and it rides a preview API:

- GitHub webhooks need a reachable endpoint; the mini is not a public server —
  requires a relay (Cloudflare Tunnel / an Azure Function GitHub hits that
  forwards) or Actions steps that POST to the channel ingress.
- Session-open-only and best-effort — if MM is down, events are missed, so
  GitHub state stays the recovery path (MM already re-snapshots on startup).
- Requires confirming our claude.ai plan exposes `channelsEnabled`.

Treat the relay as an **untrusted ingress**: verify the GitHub webhook HMAC
signature, reject replays (dedupe on delivery id), allow only an explicit
event-type **and** repository allowlist, and forward only **canonical
identifiers** (PR number, workflow-run id) into the channel — never arbitrary
payload text. MM then fetches current GitHub state before acting, exactly the
validate-before-act rule applied to inbound peer messages.

Only worth building after Phase 1 proves the pattern. For the _operator↔MM_
direction, [Remote Control](https://code.claude.com/docs/en/remote-control)
already covers steering MM from a phone, so no chat-bridge channel is needed
there.

## Rollout

1. **Phase 0 + 1 (this PR).** The naming convention, the
   [launch script](../scripts/launch-keystone-sessions.sh), **and** the messaging
   behavior: MM advertises `keystone-mm` in the ledger; the `mm-handoff`
   `session` field; MM's bounce/escalate/merge nudge with graceful degradation;
   receive validation; the optional operator-Slack reply loop. Merged at the next
   **session reset** — at reset the operator stops the ad-hoc live sessions
   _first_, then runs the launch script, so no duplicate-name collision (a second
   `keystone-mm` alongside a live one would be renamed to a variant and break
   addressing). The launch script's whole-server duplicate-name check is the
   backstop, not the plan.
2. **Phase 2 (channel).** The GitHub webhook-receiver channel, if Phase 1 earns
   it.

## Setup notes

- **`crossSessionInbound: accept`** is required for the autonomous MM (else the
  bypass trap holds every nudge). The launch script sets it per session; it can
  alternatively live in `~/.claude/settings.json` or a machine-local
  `.claude/settings.local.json`.
- Cross-session messaging needs Claude Code **≥ 2.1.224** (base feature);
  **≥ 2.1.225** to _initiate_ a conversation with a session on another of your
  machines; **≥ 2.1.232** for `@`-mentions and the `/config` inbound row. The
  mini currently runs 2.1.233.
- Same-machine peers reach each other directly; a session on a different machine
  than the mini needs Remote Control on both ends, otherwise MM falls back to
  the PR comment.
- **Operator-Slack reads** (optional) need the claude.ai-authed Slack MCP in the
  session. Verified present on the mini; treat as best-effort (§ Operator replies
  over Slack).

## Related: the maintenance watchdog (`keystone-maintain`)

Merge Monster's sibling, now specified in
[maintenance-monster.md](maintenance-monster.md) and built alongside this in the
same PR. This section records how the two compose.

Where Merge Monster owns the _merge queue_, the maintenance watchdog owns the
_security/dependency surface_: it stays on top of Dependabot PRs, GHAS / CodeQL
findings, and vulnerability advisories, triages them with the expert agents
(nyx for security, aaron for CI/IaC, isabelle for fixes), escalates when it
needs a human, and **drives the resulting fixes into the normal PR process** —
where `keystone-mm` then merges them. The two compose cleanly: `keystone-maintain`
produces `mm:ready` PRs; `keystone-mm` consumes them.

It reuses the primitives above — **its own** ledger/baton (a pinned issue
distinct from MM's #2792), the `keystone-*` namespace, and the same nudges (it
`SendMessage`s `keystone-mm` when a fix PR is queued; `keystone-mm` nudges it
back on a bounce, addressed via the `mm-handoff` `session: keystone-maintain`).
Per the resolved design decisions, `keystone-maintain` is the **sole owner of
Dependabot** (MM's `dependabot.auto_merge` is retired), runs as a **continuous
watchdog** with its own Monitor + heartbeat, and **shares
`#engineering-escalation`**. The existing
[Dependabot triage playbook](agent-lessons/dependabot-triage.md) is its phase
model.
