---
description: Start a Resource Broker session — arbitrate a pool of scarce host resources (test ports, databases, emulators) among fleet sessions: reap grants whose holder died, relay grant nudges to waiting sessions, actuate host-tier windows when directed. Actuates access; never decides environment health
argument-hint: "[fleet config dir: /abs/path]"
---

Arguments (optional): $ARGUMENTS

Run the **resource-broker** skill (`<engsys-root>/skills/resource-broker/SKILL.md`) as a long-lived broker session.

**Self-check, right after the Skill call returns.** Load the skill first (the `Skill` tool, then follow it). The harness can answer that call with "already loaded above; instructions unchanged" while only this short command text is in your context and the skill's body is not (engsys#211). When the call returns, look for one line of the body, right under its title, of the form `body-sentinel:resource-broker:` followed by four hex digits. If it is in your context, say nothing and go on. If it is not, do not take "already loaded" at face value: Read `<engsys-root>/skills/resource-broker/SKILL.md` by its literal path, follow it, and record the re-read in your session-start digest.

Intended to run on an always-on machine, alongside (not instead of) Merge Monster and Maintenance Monster — three batons, producer/consumer, no baton fights. Pool primitives (leases, the slot table, queue, nudges) are the `durable-lease` skill's `pool-cli`; this session drives them.

Before starting the loop:

1. Read the config: `.claude/resource-broker.yml` in this repo; if absent, `resource-broker.yml` in the fleet config dir named in the arguments or session context (`fleet config dir: /abs/path` — see the skill's § Prerequisites). If neither exists: copy `config.example.yml` (and `acme-pool.json`) from the skill, run `<engsys-root>/skills/resource-broker/scripts/broker-setup.sh --repo <owner/name>`, fill it in, and confirm with the user before proceeding.
2. Follow SKILL.md § Session startup: reconcile against the lease store, refresh the heartbeat, arm the persistent Monitor, schedule the fallback tick.
3. Then run the loop until the ledger issue is closed (kill switch) or the user stops you.

**You actuate; you do not decide.** Who may touch which resource right now is yours; whether an environment is healthy, or a red run is a flake or a regression, is not — route that to the session that owns it. Every reap, nudge and host action goes in the journal.
