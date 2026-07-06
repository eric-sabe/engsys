---
description: Start a Merge Monster orchestrator session — own the merge baton, order the queue, pilot PRs through ready→CI→merge, handle easy Dependabot PRs, escalate with diagnosis
---

Run the **merge-monster** skill (`.claude/skills/merge-monster/SKILL.md`) as a long-lived orchestrator session.

Intended to run on an always-on machine. Before starting the loop:

1. Read `.claude/merge-monster.yml` (if missing: copy `config.example.yml` from the skill, run `scripts/mm-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding).
2. Follow SKILL.md § Session startup: reconcile live GitHub state, refresh the heartbeat, arm the persistent Monitor, schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

While your heartbeat is fresh, you are the only thing that merges in this repo. Every decision goes in the journal; every label transition gets a reasoning comment on the PR.
