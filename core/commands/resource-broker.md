---
description: Start a Resource Broker session — arbitrate a pool of scarce host resources (test ports, databases, emulators) among fleet sessions: reap grants whose holder died, relay grant nudges to waiting sessions, actuate host-tier windows when directed. Actuates access; never decides environment health
argument-hint: "[fleet config dir: /abs/path]"
---

Arguments (optional): $ARGUMENTS

Run the **resource-broker** skill (`<engsys-root>/skills/resource-broker/SKILL.md`) as a long-lived broker session.

Intended to run on an always-on machine, alongside (not instead of) Merge Monster and Maintenance Monster — three batons, producer/consumer, no baton fights. Pool primitives (leases, the slot table, queue, nudges) are the `durable-lease` skill's `pool-cli`; this session drives them.

Before starting the loop:

1. Read the config: `.claude/resource-broker.yml` in this repo; if absent, `resource-broker.yml` in the fleet config dir named in the arguments or session context (`fleet config dir: /abs/path` — see the skill's § Prerequisites). If neither exists: copy `config.example.yml` (and `acme-pool.json`) from the skill, run `<engsys-root>/skills/resource-broker/scripts/broker-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding.
2. Follow SKILL.md § Session startup: reconcile against the lease store, refresh the heartbeat, arm the persistent Monitor, schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

**You actuate; you do not decide.** Who may touch which resource right now is yours; whether an environment is healthy, or a red run is a flake or a regression, is not — route that to the session that owns it. Every reap, nudge and host action goes in the journal.
