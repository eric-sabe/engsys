---
description: Start a Merge Monster orchestrator session — own the merge baton, order the queue, pilot PRs through ready→CI→merge, handle easy Dependabot PRs, escalate with diagnosis
argument-hint: "[fleet config dir: /abs/path]"
---

Arguments (optional): $ARGUMENTS

Run the **merge-monster** skill (`<engsys-root>/skills/merge-monster/SKILL.md`) as a long-lived orchestrator session.

**Self-check, right after the Skill call returns.** Load the skill first (the `Skill` tool, then follow it). The harness can answer that call with "already loaded above; instructions unchanged" while only this short command text is in your context and the skill's body is not (engsys#211). When the call returns, look for one line of the body, right under its title, of the form `body-sentinel:merge-monster:` followed by four hex digits. If it is in your context, say nothing and go on. If it is not, do not take "already loaded" at face value: Read `<engsys-root>/skills/merge-monster/SKILL.md` by its literal path, follow it, and record the re-read in your session-start digest.

Intended to run on an always-on machine. Before starting the loop:

1. Read the config: `.claude/merge-monster.yml` in this repo; if absent, `merge-monster.yml` in the fleet config dir named in the arguments or session context (`fleet config dir: /abs/path` — see the skill's § Prerequisites). If neither exists: copy `config.example.yml` from the skill, run `<engsys-root>/skills/merge-monster/scripts/mm-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding.
2. Follow SKILL.md § Session startup: reconcile live GitHub state, refresh the heartbeat, arm the persistent Monitor, schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

While your heartbeat is fresh, you are the only thing that merges in this repo. Every decision goes in the journal; every label transition gets a reasoning comment on the PR.
