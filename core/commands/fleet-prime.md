---
description: Re-ground a fleet session's role + subagent-orchestration discipline (on demand, e.g. after a /clear)
---

Re-ground this session before continuing. A `/clear` reloads [CLAUDE.md](../../CLAUDE.md) and the memory index but drops any loaded role skill and the memory-file bodies; this command re-installs the operating discipline on demand (the `post-clear-reground.sh` hook does it automatically after a clear/resume — run this any other time you feel un-grounded).

1. **Role skill** — if this session runs a long-lived role skill (`merge-monster` / `maintenance-monster`, or similar): re-invoke it, or re-read its `SKILL.md` + config + `<state_dir>/state.md`, then reconcile against live GitHub per its Session-startup steps. A launch script that primes the role via a first-turn slash command does not re-fire it after a clear.

2. **Subagent orchestration** — re-read [CLAUDE.md](../../CLAUDE.md) § Subagent orchestration and apply it:
   - An async background agent (no `name`) reports its result back automatically; a **named** teammate goes idle holding its result — message it to pull it. Prefer async when you just want an answer.
   - After spawning a background/async agent, wait for its completion notification before reporting — never assume or predict a pending agent's result.
   - Long runners (> a few min): use the `subagent-liveness` skill.
   - Read PR / issue / CI / merge state live from GitHub; confirm a PR actually merged before "done".
   - If a merge orchestrator owns the merge baton: don't merge; finish the PR, leave it a draft, and hand off per your merge-orchestration protocol.

3. **Reconcile before acting** — treat any PR#, issue#, SHA, or counter you "remember" as unverified until re-checked from files or GitHub.
