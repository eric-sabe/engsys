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
- **Edit-heavy interactive roles** (`build`, `design`):
  `--permission-mode acceptEdits`. Edits flow; Bash stays behind the repo's
  allowlist, which is where the real protection lives.
- **Read-heavy roles** (`investigate`): default gating. Read tools don't
  prompt anyway; the rare prompt is exactly the moment worth a look.
- **Never bypass a generic session.** All sessions share
  `crossSessionInbound: accept`; the monsters can afford it because their
  skills carry discipline. A skill-less session's permission gate IS its
  validate-before-act.
- `--remote-control` on every session: permission prompts and transcripts
  follow the operator to their other devices, so "a prompt nobody is
  watching" stops applying to the interactive roles.

## Launching

```bash
cp .claude/skills/agent-sessions/roster.example .claude/agent-sessions.roster
# edit: NAMESPACE, roles, flags, optional ENV_FILE / MODEL
bash .claude/skills/agent-sessions/scripts/launch-agent-sessions.sh
```

The launcher: writes/patches `~/.claude/<ns>-messaging-settings.json` with
`crossSessionInbound: accept`; runs any `PREFLIGHT=` commands; injects the
optional `ENV_FILE` into every window's command line (a pre-existing tmux
server does NOT inherit launcher exports); refuses duplicate window names
(whole tmux server) and names outside the namespace; starts each session as
a tmux window named for its role (`new-window -t <session>:` — the trailing
colon means "next free index"; without it the second launch fails).

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
| stale, issue open | exited | relaunch (crash recovery) |
| "session end" | exited | leave — deliberate stop |
| ledger **closed** | any | never touch — kill switch wins |
| stale | **alive** | never kill; escalate once on the ledger |

The stale-but-alive row is deliberate: a live process is never killed on
staleness alone — that's probe-then-classify territory (subagent-liveness),
a judgment call for the operator or the maintenance watchdog, not a script.

Setup: copy `fleet-supervisor.conf.example` → `.claude/fleet-supervisor.conf`
(one line per ledger-bearing session — as many as you run — with its ledger
issue, stale threshold, and optionally its repo), and `launchd.plist.example`
→ `~/Library/LaunchAgents/` with `REPO_ROOT` set to the directory holding the
conf (Linux: cron/systemd timer, same cadence). ALIVE detection is
shell-fallback based, not process-name based — the claude binary renames its
process to its version string.

Any new baton-holding role joins the supervisor by honoring the same
contract: a ledger issue whose body carries a `last: <ISO8601Z> — status:
<text>` heartbeat line, the exact phrases "rotation requested" / "session
end", and closing the issue as its kill switch.

## Related

- Merge orchestrator: [merge-monster](../merge-monster/SKILL.md)
- Security/dependency watchdog: [maintenance-monster](../maintenance-monster/SKILL.md)
- Worker-death detection every session should use:
  [subagent-liveness](../subagent-liveness/SKILL.md)
- Messaging design: `docs/agent-messaging.md` in
  [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/agent-messaging.md)
