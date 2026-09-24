---
description: Start a Merge Monster orchestrator session — own the merge baton, order the queue, pilot PRs through ready→CI→merge, handle easy Dependabot PRs, escalate with diagnosis
argument-hint: "[fleet config dir: /abs/path]"
---

Arguments (optional): $ARGUMENTS

Run the **merge-monster** skill (`<engsys-root>/skills/merge-monster/SKILL.md`) as a long-lived orchestrator session.

Intended to run on an always-on machine. Before starting the loop:

1. Read the config: `.claude/merge-monster.yml` in this repo; if absent, `merge-monster.yml` in the fleet config dir named in the arguments or session context (`fleet config dir: /abs/path` — see the skill's § Prerequisites). If neither exists: copy `config.example.yml` from the skill, run `<engsys-root>/skills/merge-monster/scripts/mm-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding.
2. Follow SKILL.md § Session startup: reconcile live GitHub state, refresh the heartbeat, arm the persistent Monitor, schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

While your heartbeat is fresh, you are the only thing that merges in this repo. Every decision goes in the journal; every label transition gets a reasoning comment on the PR.
