---
name: agent-sessions
description: Stand up and operate a fleet of named, long-running Claude Code sessions for a project on an always-on machine — the merge orchestrator, the maintenance watchdog, and interactive worker roles — wired for cross-session messaging, remote control, and per-role permission modes. Use when the user says "launch the agent sessions", "start the fleet", "set up the always-on sessions", or asks how to inspect/attach to running agent sessions.
---

# Agent sessions — the project fleet

One always-on machine runs a set of named Claude Code sessions per project:
the ledger-bearing monsters (`<ns>-mm` merge orchestrator, `<ns>-maintain`
security/dependency watchdog, and any further baton-holding role you add —
the fleet is not limited to two) plus interactive worker roles (`build`,
`investigate`, `design`, …). This skill owns the launcher, the roster format,
the fleet supervisor, and the operational judgment (naming, permissions,
inspection).

Scripts: `<skill-dir>/scripts/launch-agent-sessions.sh` (the launcher),
`<skill-dir>/scripts/fleet-supervisor.sh` (the relauncher), and
`roster.example` (copy to `.claude/agent-sessions.roster`, edit).

## Why names + namespace matter

Cross-session messaging addresses sessions **by name** and is scoped to the
**OS user, not the project** — every project on the machine shares one
address space. Isolation is by convention, enforced in the skills:

- every session is named `<NAMESPACE>-<role>` (the launcher refuses others);
- peers only *trust* names under their own prefix (the namespace fence), and
  the monster skills **validate every inbound message against live GitHub**
  before acting — a message can never grant consent;
- duplicate names anywhere under the same user get auto-suffixed (`name-2`),
  which silently breaks addressing — the launcher refuses a name that already
  exists as a tmux window, and at a session reset you stop old sessions
  FIRST, then relaunch.

## Permission modes — per role, not per fleet

- **Monsters** (`mm`, `maintain`): `--dangerously-skip-permissions`. They run
  unattended by design; a permission prompt nobody is watching is the bypass
  trap — the nudge arrives, the session sits at a dialog until a human
  notices. Safe ONLY because their skills carry validate-before-act, hard
  rules, and a ledger-issue kill switch.
- **Interactive roles** (`build`, `investigate`, `design`):
  `--permission-mode auto --add-dir <worktrees dir>`. Auto mode approves
  routine actions and still asks on risky ones; the repo's deny rules apply
  on top. **`--add-dir` is required:** agents work in git worktrees beside the
  checkout (`../worktrees/<name>`, skill `git-workflow-agents`), which is
  outside the session's working directory — without it every edit there, and
  every command that `cd`s there, prompts, in any mode short of a bypass.
  Put `--add-dir` anywhere in the extra flags (the launcher places the prompt
  first, so list-valued flags can't swallow it). `acceptEdits` is the fallback
  where auto mode isn't available — it still needs `--add-dir`.
- **Never bypass a generic session.** All sessions share
  `crossSessionInbound: accept`; the monsters can afford it because their
  skills carry discipline. A skill-less session's permission gate IS its
  validate-before-act.
- `--remote-control` on every session: permission prompts and transcripts
  follow the operator to their other devices, so "a prompt nobody is
  watching" stops applying to the interactive roles.

## Launching

Under the **fleet kit**, `fleet launch` renders your instance's `fleet/roster.tmpl` and runs this
launcher for you (see [docs/fleet-guide.md](https://github.com/eric-sabe/engsys/blob/main/docs/fleet-guide.md));
the rest of this section describes the launcher itself, which is also what you run by hand in copy mode:

```bash
cp <engsys-root>/skills/agent-sessions/roster.example .claude/agent-sessions.roster
# edit: NAMESPACE, roles, flags, optional ENV_FILE / MODEL
bash <engsys-root>/skills/agent-sessions/scripts/launch-agent-sessions.sh
```

The launcher: writes/patches `~/.claude/<ns>-messaging-settings.json` with
`crossSessionInbound: accept`; runs any `PREFLIGHT=` commands; injects the
optional `ENV_FILE` into every window's command line (a pre-existing tmux
server does NOT inherit launcher exports); refuses duplicate window names
(whole tmux server) and names outside the namespace; starts each session as
a tmux window named for its role (`new-window -t <session>:` — the trailing
colon means "next free index"; without it the second launch fails).

A session line may carry an optional 5th field, `name|workdir|prompt|extra|env`:
a per-session env file (absolute, or relative to the roster's directory) that
**replaces** the roster-level `ENV_FILE` for that session only. Use it to run
lanes with different environments (say, another model-alias set for a security
role) from one roster instead of a second roster; source the shared env from
inside the lane's file if it should build on it. A missing per-session file is
an error for that session (it never silently falls back to `ENV_FILE`). With
the 5th field present the extra flags must not contain a literal `|`.

`ENV_FILE` is the hook for a durable machine identity (cloud credentials,
inference endpoints) — e.g. a certificate-credential service principal with
least-privilege read+inference roles, so no session ever depends on the
operator's interactive cloud login surviving the night. `PREFLIGHT=` lines
(repeatable) are the matching refresh hook: a cloud-login script, `gh auth
status`, anything that should re-check the identity before sessions start.
They run on every invocation, including the supervisor's single-session
relaunches, and are fail-open (warn, launch anyway). For identities that
expire between launches, add a sibling launchd/cron job running the same
login script every few hours.

## Running from a fleet repo

The launcher and supervisor need not live in the repo they drive. A separate
fleet repo (roster, supervisor conf, monster configs, launchd jobs) can run
sessions against one or more target repos:

- **Roster**: give every session an absolute `<workdir>` (the target checkout).
- **Supervisor**: set `REPO=owner/name` in the conf, or a 4th
  `|owner/name` field per session for a multi-repo fleet. Without either it
  falls back to `gh repo view` in its cwd (the in-repo mode).
- **Monster configs**: each monster reads `.claude/<monster>.yml` from its
  repo if present; otherwise from the **fleet config dir** named in its
  session context. Pass it in the roster's initial prompt —
  `/merge-monster fleet config dir: /abs/fleet/configs/<repo>` — and put
  `merge-monster.yml` / `maintenance-monster.yml` there. An in-repo config
  always wins.

## Reset-time runbook

**With the fleet kit** (`core/fleet/`, plugin mode; see
[docs/fleet-guide.md](https://github.com/eric-sabe/engsys/blob/main/docs/fleet-guide.md)),
`fleet restart` does all of this for you, in the right order and per role:
`fleet restart` shows which sessions are behind, `fleet restart --stale` (or
`<name>...`, or `--all`) cycles them. Monsters get a rotation request and the
supervisor relaunches them; idle interactive roles are `/exit`ed and relaunched;
busy ones are skipped unless `--force`. Run `fleet sync` first if the pins moved.

**By hand** (copy mode, or no kit):

1. Stop the old sessions (tmux windows / Ctrl-C the claude processes) —
   duplicate names break addressing, and a stopped session's skill state
   (ledgers, labels) is all on GitHub anyway.
2. `git pull` the repo the sessions run from.
3. Re-run the launcher. Monsters reconcile from live GitHub on startup — no
   local state to migrate.

## Inspecting the fleet

- **On the machine**: `tmux attach -t <ns>` — `Ctrl-b w` window picker,
  `Ctrl-b [` scrollback, `Ctrl-b d` detach. Prefer **read-only** for the
  monsters (`tmux attach -t <ns> -r`) — anything typed into a
  bypass-permissions session's window executes.
- **From other machines**: `ssh <host> -t 'tmux attach -t <ns> -r'`. Plain
  attach mirrors the active window for all viewers; for independent focus,
  `tmux new-session -t <ns> -s inspect` (grouped session; exit when done).
- **Transcript-level, anywhere**: `--remote-control` sessions appear in the
  operator's claude.ai / Claude app by name — read the live transcript, send
  steering, answer permission prompts. Usually the better lens for the
  monsters than the raw terminal.

## Autonomous rotation (fleet supervisor)

Long-running monsters rotate instead of enduring lossy compaction — and the
relaunch must not wait on a human. `<skill-dir>/scripts/fleet-supervisor.sh`
runs under launchd/cron every ~5 minutes with **no LLM in the restart path**
(recovery works even when the whole fleet is dark):

| Ledger heartbeat | Process | Action |
| --- | --- | --- |
| "rotation requested" (exact phrase) | exited | kill window, relaunch |
| "rotation requested" | **alive, idle at its prompt** ≥ `ROTATE_GRACE_MIN` (default 3) after that heartbeat | kill window, relaunch — once per rotation heartbeat |
| stale, issue open | exited | relaunch (crash recovery) |
| "session end" | exited | leave — deliberate stop |
| ledger **closed** | any | never touch — kill switch wins |
| any (`HOST_CHECK_CMD` says this host doesn't run the session) | any | never touch: no ledger read, no comment, no relaunch. Asked first, every tick; a check that errors skips the session too |
| (per tick, not per session) `HOST_HEALTH_CMD` fails | | one alert through `NOTIFY_CMD` per incident, resolved once the check passes again; a failed post is retried next tick |
| stale | **alive** | never kill; escalate once on the ledger |
| any relaunch **fails** | | escalate once on the ledger with the launcher's error, retry each tick without commenting, comment once on recovery |

**Moved ledger targets.** The supervisor records, per session, the ledger target it
last launched it against (`logs/fleet-supervisor/<name>.target`). When the
configured target differs (for example the resource broker moving from a
per-repo ledger issue to the status issue's `<!-- broker-heartbeat -->` block), it
also reads the recorded old target, and honours a `rotation requested` there that
is newer than the launch. A session still on the old version posts it on the old
target, which would otherwise never be read. Relaunching records the new target
and ends the double read. A session with no record (the first tick after
upgrading to a supervisor that keeps one) is assumed to be on the current target,
so for that one transition, if an old-version session sits idle after a
`fleet restart`, exit it and `fleet launch` it by hand. The general rule: when a
session's ledger target changes, the rotation handshake has to be readable on
both sides during the transition.

**Singleton monsters (a 6th conf field `merge` or `maintain`; `fleet supervise`
fills it in).** Their role is held through the github lease, and every relaunch
in the table also needs the lease to allow it (`core/lib/lease/baton.mjs
supervise`, or `BATON_CMD=`): this fleet is the role's home (always true in
single-fleet mode) and nobody holds a live baton. A live baton, another
fleet's or this session's own, is a wait; a lease read that fails is a wait
plus one alert through `NOTIFY_CMD` (`baton-read-<name>`). Two rows apply to
them only:

| Ledger heartbeat | Process | Action |
| --- | --- | --- |
| "handover" (the old home released the role) | exited | relaunch, if the baton allows |
| stale | **alive, idle at its prompt**, baton forfeited | relaunch: staleness + idle + a lease nobody holds is three signals, not one |

The launcher exports `ENGSYS_SESSION` (the session name),
`ENGSYS_SESSION_RUN` (a per-launch id) and `ENGSYS_SESSION_ROOT` (the resolved
directory it launched the session in) into every session: the baton's holder
is `<FLEET_ID or hostname>:<ENGSYS_SESSION>`, a fencing token on disk is
honored only by the launch that took it, and a guarded `fleet msg send` takes
its `--body-file` only from `<ENGSYS_SESSION_ROOT>/tmp/`, wherever the session
has `cd`'d since. A session whose prompt runs the merge
or maintenance monster also gets `ENGSYS_SINGLETON_ROLE=merge|maintain`, which
arms the engsys plugin's singleton-write guard hook: raw GitHub writes are
denied unless they go through the monster's fenced wrappers (merge-monster
SKILL.md § The baton). Every other session has it unset.

**A Claude session can't exit itself.** A monster that honors a rotation
request posts its digest + final `rotation requested` heartbeat, stops its
loop, and then sits at the prompt with its process still alive — so the
supervisor relaunches an alive session too, but only after that heartbeat,
only once it's idle (no turn running), and only once per heartbeat (the
relaunched session is never mistaken for the old one; if it never heartbeats,
the stale-but-alive row below applies instead).

The stale-but-alive row is deliberate: a live process is never killed on
staleness alone (the singleton row above adds two more signals). That is probe-then-classify territory (subagent-liveness),
a judgment call for the operator or the maintenance watchdog, not a script.

Setup, **fleet kit (plugin mode; recommended):** put the conf lines in your
instance repo's `fleet/supervisor.conf.tmpl` and run `fleet install-jobs`; the
kit renders the conf, sets `LAUNCH_CMD`, `TMUX_SESSION` and `HOST_CHECK_CMD`
(drops sessions that are not on this host: fleet-guide § 6.11), and loads the
launchd job from the pinned engsys checkout (`fleet supervise` is one tick).
Plugin mode has no `.claude/skills/agent-sessions/` in the project, so the two
example files here are for reference, not for copying.

Setup, **copy mode (manual):** copy `fleet-supervisor.conf.example` →
`.claude/fleet-supervisor.conf` (one line per ledger-bearing session — as many
as you run — with its ledger issue, stale threshold, and optionally its repo),
and `launchd.plist.example` → `~/Library/LaunchAgents/` with `REPO_ROOT` set to
the directory holding the conf (Linux: cron/systemd timer, same cadence).

Either way, ALIVE detection is shell-fallback based, not process-name based —
the claude binary renames its process to its version string.

Any new baton-holding role joins the supervisor by honoring the same
contract: a ledger issue whose body carries a `last: <ISO8601Z> — status:
<text>` heartbeat line, the exact phrases "rotation requested" / "session
end", and closing the issue as its kill switch.

## Related

- Merge orchestrator: [merge-monster](../merge-monster/SKILL.md)
- Security/dependency watchdog: [maintenance-monster](../maintenance-monster/SKILL.md)
- Shared host resource pool arbiter (optional third monster): [resource-broker](../resource-broker/SKILL.md)
- Worker-death detection every session should use:
  [subagent-liveness](../subagent-liveness/SKILL.md)
- Running and upgrading a fleet from an instance repo: `docs/fleet-guide.md` in
  [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/fleet-guide.md)
- Messaging design: `docs/agent-messaging.md` in
  [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/agent-messaging.md)
