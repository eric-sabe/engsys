---
name: subagent-liveness
description: Register and watch long-running background subagents so a quiet death never leaves this session idle on a corpse. Use BEFORE dispatching any background agent expected to run more than a few minutes (implementation agents, investigation agents, reviewers, builds) — and on any AGENT_OVERDUE / AGENT_STALE event those watchers emit. Not needed for quick synchronous lookups. The monsters (merge-monster, maintenance-monster) already carry this discipline in their own skills — this is the same substrate for every other session.
---

# Subagent liveness — generic session protocol

The problem (full design: `docs/subagent-liveness.md` in [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/subagent-liveness.md)):
a background subagent that crashes or drops its connection mid-run emits **no
notification**, and an event-driven session then idles forever on a corpse.
This skill is the same registry + watchdog + probe/fence discipline the
monsters run, for sessions without a baton. The scripts are shared —
**one substrate, every session**:

- `.claude/skills/merge-monster/scripts/mm-agent-reg.sh` (spawn registry)
- `.claude/skills/merge-monster/scripts/mm-agent-watch.sh` (watchdog Monitor)

**State dir** — pick ONE per-session identifier at skill load and reuse it for
**every** registry and watchdog command this session ever runs:
`logs/agent-liveness/<session-id>`. Your Claude Code session name (the
`claude --name`, e.g. `acme-build`) is the right ID when you have one and
no concurrent session shares it; otherwise append a uniquifier (e.g.
`acme-build-a3f2`, suffix from your session ID). This is a **session**
identity — never derive it from an individual agent's name (each agent would
get its own registry and watchdog, and fencing/respawn tracking falls apart),
and never let two live sessions share one (their generations would fence each
other). `mkdir -p` it once. The `--name` in the commands below is different:
it names the individual **agent** inside this session's registry.

**Defaults** (no config file for generic sessions — these mirror the monsters'
`liveness:` blocks; deviate only with a reason you journal):

| Setting | Value |
| --- | --- |
| deadline: fix / implementation | 45 min |
| deadline: review / triage / investigation | 30 min |
| deadline: rebase / mechanical | 10 min |
| deadline: anything else | 30 min |
| stale threshold (transcript silence) | 10 min |
| extensions per attempt | 1 (the script enforces it) |
| respawn generations before escalating | 2 |

## On every long-running spawn

1. **Name it**; never use one-shot `Explore`/`Plan` for work you need to track
   (no agent ID → unreachable, unresumable).
2. **Register it** (record the gen it prints — every later mutation passes it
   back via `--gen`):

   ```bash
   .claude/skills/merge-monster/scripts/mm-agent-reg.sh spawn \
     --state-dir logs/agent-liveness/<session-id> --name <agent-name> \
     --task "<issue/PR ref>" --class <fix|review|rebase|default> --deadline-min <N>
   ```

   When you learn the agent ID (and can locate its transcript under
   `~/.claude/projects/…/subagents/agent-<id>.jsonl` — undocumented layout,
   absence is normal): `mm-agent-reg.sh update --name <n> --gen <g>
   --agent-id <id> --transcript <path>`.
3. **Carry the resume-reconcile contract in the spawn prompt**: _"if you are
   resumed and receive a status probe, reconcile against live GitHub state
   before continuing — your context may be stale."_
4. **Arm the watchdog once per session** (first spawn), as a persistent
   Monitor; re-arm it if it dies:

   ```bash
   bash .claude/skills/merge-monster/scripts/mm-agent-watch.sh \
     --state-dir logs/agent-liveness/<session-id> --stale-min 10
   ```

5. **Close the row on any completion/failure notification**:
   `mm-agent-reg.sh update --name <n> --gen <g> --status done|failed`.
   Closed rows emit nothing — the watchdog only fires on `running` rows.

## On `AGENT_OVERDUE` / `AGENT_STALE`

Follow **§ Subagent liveness in
[.claude/skills/merge-monster/SKILL.md](../merge-monster/SKILL.md)** — it is
the canonical statement of probe-then-classify and the fence-first recovery
ladder. The short form: reconcile durable state first (did the work actually
land?); probe via `SendMessage` (a reply = alive-but-slow → one journalled
`extend`); a failed probe is **not** death (bounded retries + independent
evidence required); classified dead → `fence` → respawn under the new
generation (max 2) → then stop and surface to the operator. Never respawn
without fencing; never double-act.

## Escalation (no baton, no ledger)

Generic sessions have no `mm:escalated` machinery: when the respawn cap hits,
**stop and tell the operator** in your session (and in whatever issue/PR the
work belongs to) — what died, what you tried, the registry rows. Never
silently drop the unit or spin a third generation.
