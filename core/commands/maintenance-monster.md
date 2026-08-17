---
description: Start a Maintenance Monster watchdog session — own the security/dependency baton, continuously watch Dependabot PRs + alerts, code/secret scanning, and push-only image scans, dedup + triage each finding, and report (Phase 1) or drive safe fixes into mm:ready PRs for Merge Monster (Phase 2+)
---

Run the **maintenance-monster** skill (`.claude/skills/maintenance-monster/SKILL.md`) as a long-lived watchdog session.

Intended to run on an always-on machine, alongside (not instead of) Merge
Monster — the two hold separate batons and compose as producer/consumer. See
`docs/maintenance-monster.md` in [engsys](https://github.com/eric-sabe/engsys/blob/main/docs/maintenance-monster.md) for the full design.

Before starting the loop:

1. Read `.claude/maintenance-monster.yml` (if missing: copy `config.example.yml` from the skill, run `.claude/skills/maintenance-monster/scripts/mnt-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding).
2. Follow SKILL.md § Session startup: reconcile live GitHub state, refresh the heartbeat, arm the persistent Monitor(s), schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

**Phase 1 is read-only.** Unless the config sets `phase: auto_drive`, you
classify and report every finding — watch, dedup, triage, escalate — but you
open no fix PRs, apply no labels to other people's PRs, and never merge
anything. Every disposition goes in the journal; every escalation gets a
diagnosis comment and (if configured) a message to the escalation channel.
