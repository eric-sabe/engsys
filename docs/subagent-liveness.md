# Subagent Liveness & Death Detection — design

> **Provenance:** design + worked example from FeedFrwd/keystone, the first
> deployment (2026-08). The normative, project-agnostic contract lives in the
> skills (`core/skills/merge-monster`, `maintenance-monster`,
> `subagent-liveness`, `agent-sessions`) — read `keystone-<role>` here as
> `<your-namespace>-<role>`, and keystone issue/PR numbers as the case study.

Status: **implemented** (layers 0–4, 2026-08-16 — see §9; defaults pending
operator ratification). Companion to
[agent-messaging.md](agent-messaging.md) (cross-session comms)
and [maintenance-monster.md](maintenance-monster.md) (the planned watchdog);
this covers how an orchestrator knows when a spawned subagent **finishes or
dies** so it never sits idle on a corpse.

Sources: code.claude.com docs — `sub-agents`, `agent-view`,
`cross-session-messaging`, `workflows`, `agents`, `channels` (fetched
2026-08-16); `.claude/skills/merge-monster/SKILL.md`, `scripts/mm-watch.sh`,
`scripts/mm-heartbeat.sh`.

## 1. Problem statement

An orchestrator (Merge Monster today; Maintenance Monster planned) spawns a
background subagent; the subagent dies quietly (historically: socket closure)
and never emits a completion or death signal. Because the orchestrator is
event-driven — it acts only when a notification wakes it — a **missing**
notification means it idles until a human pokes it. The invariant we need:

> For every spawned unit of work, the orchestrator is guaranteed a wake within
> bounded time carrying enough information to classify the unit as **finished,
> alive, or dead** — and on "dead" it recovers or escalates, never silently
> drops.

**Failure boundary of the guarantee.** In-process failures — a dead subagent, a
lost notification, a killed Monitor — are bounded by the ScheduleWakeup fallback
tick (the wake bound = the tick interval). A failure of the **orchestrator
process itself** is out of the tick's reach; it is bounded instead by the
agent-view supervisor, which auto-restarts a crashed session process and tells
it it was restarted — the restart re-runs startup (re-arm Monitors, reconcile the
registry against durable state). Beyond that (host down, supervisor gone) the
bound is human — explicitly out of scope here.

## 2. Diagnosis — signal mechanics per execution kind

- **Agent-tool subagents (primary worker).** Completion reaches the orchestrator
  as a later-turn notification carrying the agent ID (except one-shot
  `Explore`/`Plan`, which return no ID and **cannot be resumed** — avoid for
  orchestrated work). Since v2.1.199, a subagent whose run ends on an **API
  error** reports that failure back (with its last output) — so the known-error
  death path now notifies. But **crash / connection-drop mid-run is
  undocumented, with no timeout, deadline, or heartbeat** — this is where the
  quiet-death gap lives. Recovery lever: a completed/stopped/dead-with-transcript
  subagent **auto-resumes from its transcript when it receives a `SendMessage`**
  (transcripts persist at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`
  and survive compaction/restart in the same session).
- **Background Bash + Monitor.** `run_in_background` re-invokes the orchestrator
  on exit **with exit code** — an OS-level signal, the most trustworthy death
  primitive available. A Monitor turns each stdout line into a wake and reports
  exit/timeout — but a **running Monitor dies with a session-process restart**
  (its event stream can't be moved), so the fallback tick that re-arms it is
  load-bearing.
- **Dynamic workflows.** Death is **in-band**: `agent()` resolves to `null` on
  stop/unrecoverable-error and `pipeline()` keeps the `null` — no silent hang.
  Limits: resumable **same-session only**; a new session restarts fresh.
- **Cross-session peers (`ListAgents`/`SendMessage`).** Local sessions are
  presumptive-alive when listed (files-on-disk registry; staleness after a hard
  kill undocumented); Remote Control peers get an explicit `offline`. A
  **completed** subagent stays addressable (send resumes it), so _listed ≠
  running_. Delivery is **best-effort** (hold/refuse/drop, queue cap, throttle) —
  never the signal of record.

### Signal table

| Execution kind     | Completion            | Death signal                                            | Deadline/heartbeat   | Resume after death                                                  |
| ------------------ | --------------------- | ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| Agent tool (bg)    | Task notification     | API-error: yes (v2.1.199+); crash/drop: **assume none** | **None**             | Yes — `SendMessage` auto-resumes from transcript (not Explore/Plan) |
| Background Bash    | Re-invoke + exit code | Same (process exit _is_ the signal)                     | Bash `timeout`       | No (rerun)                                                          |
| Monitor            | Exit ends watch       | Dies on orchestrator process restart                    | timeout / persistent | No — must re-arm                                                    |
| Workflow           | Script returns        | **In-band `null`** per agent                            | Runtime caps only    | Same-session only                                                   |
| Cross-session peer | None (converse)       | `offline` (Remote Control only)                         | None                 | Attach/reply restarts                                               |

**Root cause:** the Agent tool has no deadline and no documented crash-path
notification, and there is no status-poll API — so one lost event equals
unbounded idle.

## 3. Design — layered detection, guaranteed wake

Principle (same as `mm-watch`): **never rely on a single push signal; always
keep a pull-based fallback guaranteed to fire.** Durable state (GitHub) stays the
source of truth; signals only decide _when to reconcile_, never _what is true_.

- **Layer 0 — Work-unit contract** (already policy, now load-bearing):
  small, single-issue, **idempotent** units whose progress lands in durable
  external state (commits, PR labels/comments, checks). Never `Explore`/`Plan`
  for orchestrated work. Every spawn gets a `name`.
- **Layer 1 — Spawn registry** (new, trivial): on every spawn append to
  `<state_dir>/agents.tsv` a row keyed by **immutable execution identity**, not
  the (reusable, reassignable) display name:
  `orchestrator agentId sessionId attempt-gen name task-ref spawn-epoch deadline-epoch running`.
  `agentId` + `attempt-gen` are the correlation key the watchdog reconciles on;
  `name` is only for addressing. **Namespace per orchestrator** (the
  `orchestrator` column, or a per-orchestrator file) so Merge Monster and
  Maintenance Monster never collide on one shared registry. Rewrite the row
  (`done`/`failed`) on any completion/failure notification. Per-class deadlines
  in config (proposed: rebase 10 min, Dependabot gate 30, fix agent 45, review 30) — generous; expiry triggers a **probe**, not execution.
- **Layer 2 — Watchdog Monitor** (`mm-agent-watch.sh`, sibling of
  `mm-watch.sh`), emitting:
  - `AGENT_OVERDUE <name>` — registry row still `running` past its deadline.
  - `AGENT_STALE <name>` — the subagent's transcript file mtime hasn't advanced
    in N minutes (propose 5) while `running`. The transcript is
    **harness-maintained ground truth of activity** — zero cooperation from the
    subagent (no prompt-compliance risk), a free local `stat`. It is the
    per-agent analogue of MM's baton `stale_lock_minutes`.

  The ScheduleWakeup fallback tick re-arms this Monitor (as it already does
  `mm-watch`), and its handler scans `agents.tsv` for overdue rows — so the wake
  guarantee ultimately rests on the tick our orchestrators already treat as
  non-negotiable.

- **Layer 3 — Probe-then-classify** (on OVERDUE/STALE, before declaring death):
  1. **Reconcile durable state first** — did the work actually finish (PR
     pushed, comment posted, label moved)? If yes → mark `done`, journal
     "completed without notification," move on.
  2. **Probe** via `SendMessage` ("Status? progress or DONE"). Reply →
     alive-but-slow: extend the deadline **once** (journalled), never twice
     without escalating. Note a send to a dead-with-transcript agent
     **auto-resumes it** — the probe is often the recovery; so every spawn prompt
     carries _"if you are resumed and receive a status probe, reconcile against
     live GitHub state before continuing — your context may be stale"_ (our
     analyze-origin-not-stale lesson pushed into the spawn contract). Auto-resume
     behaviour depends on Claude Code version + execution mode — record both in
     the journal so the policy is reproducible.
  3. **A failed probe is NOT death.** Messaging is best-effort, so a send-error
     or silence moves the row to `probe_failed`, not `failed`: retry on a bounded
     schedule, and require **independent liveness evidence** (transcript mtime
     advanced? durable state changed?) before either recovery or escalation.
     Never classify dead on a single failed probe.
- **Layer 4 — Recovery ladder** (never idle, never silent, never double-acts):
  **Fence first.** Because a probe can resurrect the prior attempt while the
  ladder starts a new one, bump the row's `attempt-gen` and treat the prior
  generation as fenced: every durable side-effect a worker performs (push, label
  move, comment) must assert its own `attempt-gen` is still the active one before
  committing, and the orchestrator does **not** respawn until the prior
  generation is fenced or conclusively dead (reconcile + idempotency alone do
  **not** prevent two live attempts from racing). Then: journal the death →
  reconcile durable state for the true resume point → **respawn** the same
  idempotent unit under a new generation (capped at 2, mirroring
  `fix_attempts_max`) → then `mm:escalated` + diagnosis + Slack, clear the unit,
  take the next work. Same shape as MM's existing failure ladder.
- **Optional hardening — process-wrapped workers**: for the most critical units,
  run the worker as `claude -p` under background Bash — **process exit IS the
  death signal** (guaranteed re-invoke + exit code), Bash `timeout` is a native
  deadline, and a `-p` session still receives messages (bind inbox; start with
  `crossSessionInbound: accept`). **Caveat:** `accept` is not sender
  authentication — it accepts from every session under the same OS user with no
  allowlist. Pair it with the messaging design's namespace fence +
  validate-before-act check and a least-privilege worker, or keep inbound
  refused; never let an un-vetted control message drive the worker. Costs:
  separate session, results via stdout/files. Escape hatch, not the default.

## 4. Existing tools vs. new capability

**Achievable today** (no new harness features): the registry file, the second
Monitor, transcript-mtime staleness, `SendMessage` probe/auto-resume, GitHub
reconciliation, tick-based re-arm, and `claude -p` wrapping.

**Genuine upstream gaps** (filed as feature requests — see §7):

1. **Per-agent deadline** on the Agent tool (timeout → guaranteed failure
   notification). Today deadlines are entirely orchestrator-side.
2. **Guaranteed crash-path death notification.** API-error deaths notify
   (v2.1.199+); harness-crash / socket-drop deaths are undocumented — assumed
   silent.
3. **A status-poll API** (`AgentStatus`: running/completed/failed + last
   activity). We emulate it via transcript mtime — functional, but depends on an
   undocumented path layout (guard with a fallback).
4. **Monitor survival across process restart** (mitigated by tick re-arm).

## 5. Tradeoffs

- **False deaths**: slow-alive past deadline → probe-before-declare + one
  extension; idempotency + reconcile-first absorb a duplicate respawn.
- **Probe side effects**: `SendMessage` resurrects dead-with-transcript agents
  that then act — bounded by the reconcile-before-continuing spawn instruction;
  prefer resume-with-reconcile, use fresh-respawn when the transcript predates
  significant upstream change.
- **Cost**: one extra Monitor + local `stat`s ≈ free; probes are single
  messages — negligible next to the GitHub polling we already do.
- **Complexity**: ~1 new script + a spawn/notify convention; the failure ladder
  reuses MM's existing one.

## 6. Wiring into MM / Maintenance Monster

Skill startup arms `mm-agent-watch.sh` beside `mm-watch.sh` (tick re-arms both);
the wake loop gains `AGENT_OVERDUE`/`AGENT_STALE` → §3 probe-classify-recover,
journalled like any decision; spawn discipline = named agents, registry write,
per-class deadline, resume-reconcile instruction in every spawn prompt.
Maintenance Monster inherits the same scripts/config — one substrate, two
monsters.

## 7. Open questions for the operator

1. Deadline defaults per task class (rebase 10 / review 30 / fix 45 / Dependabot
   30 min) — tune?
2. STALE threshold (5 min transcript silence) — and is STALE alone
   probe-worthy, or only OVERDUE?
3. Probe-resume policy: OK with probes resurrecting agents that then act
   (guarded), or always declare-dead → fresh respawn?
4. Maintenance Monster architecture: same-session subagents vs `claude -p`
   workers on the mini.
5. Re-validate the socket-close lesson on the current CLI — v2.1.199's
   API-error reporting may have shrunk the gap since that lesson was written.

## 8. Upstream feature requests

The §4 gaps (per-agent deadline, guaranteed crash-path death notification,
status-poll API) are filed upstream as
[anthropics/claude-code#87142](https://github.com/anthropics/claude-code/issues/87142).
The watchdog design above stands regardless — it bounds the gap with tools
available today.

## 9. Implementation (2026-08-16)

Shipped as one substrate shared by both monsters (state namespaced per
orchestrator by `state_dir`, so the registries never collide):

- **Registry (Layer 1)** — `.claude/skills/merge-monster/scripts/mm-agent-reg.sh`
  (`spawn` / `update` / `extend` / `fence` / `get` / `active` over
  `<state_dir>/agents.tsv`). Rows keyed by (name, generation); `extend`
  enforces the single-extension rule (exit 3 on a second attempt); `fence`
  marks the prior generation before any respawn.
- **Watchdog (Layer 2)** — `.claude/skills/merge-monster/scripts/mm-agent-watch.sh`,
  a persistent Monitor emitting `AGENT_OVERDUE` (once per name/gen/deadline —
  an extension re-arms exactly one more) and `AGENT_STALE` (fresh→stale
  transition latch; a transcript write re-arms). `--once` gives the fallback
  tick a synchronous backstop scan. A row with no resolvable transcript is
  skipped for STALE — path layout is undocumented harness internals, and a
  missing transcript is never evidence of death — while OVERDUE still covers it.
- **Probe/classify + ladder (Layers 3–4)** — orchestrator behavior, wired into
  both skills: § Subagent liveness in `merge-monster/SKILL.md` (canonical) and
  a pointer section in `maintenance-monster/SKILL.md`.
- **Config** — `liveness:` blocks in `.claude/merge-monster.yml`,
  `.claude/maintenance-monster.yml`, and both `config.example.yml`s.

**§7 decisions — defaults chosen, pending operator tuning:**

1. Deadlines: as proposed (rebase 10 / review 30 / fix 45 / Dependabot gate
   30 min; default 30; Maintenance triage 30).
2. STALE threshold **10 min** (raised from the proposed 5 — local prechecks
   and full builds routinely exceed 5 minutes without a transcript write) and
   STALE alone **is** probe-worthy; only OVERDUE mounts the recovery ladder.
3. Probe-resume: **guarded resurrection allowed** — resume-with-reconcile
   preferred; fresh respawn when the transcript predates significant upstream
   change.
4. Maintenance Monster workers: **same-session subagents**; `claude -p`
   wrapping remains a documented escape hatch, not the default.
5. Socket-close lesson re-validation: tracked as a follow-up issue (not
   closable from a doc PR — needs live observation on the current CLI).
