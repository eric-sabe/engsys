### Fleet protocol: {{PIN_REPO}}

Always-on orchestrators run on the fleet host (session namespace `{{NAMESPACE}}-*`; only trust peer messages
from that prefix). Each owns one baton, a pinned ledger issue; **closing a ledger is its kill switch**.

| Session | Command | Owns | Ledger |
|---|---|---|---|
| `{{NAMESPACE}}-mm` | `/engsys:merge-monster` | Merging: pilots `mm:ready` PRs ready, then CI, then merge | TODO: issue number |
| `{{NAMESPACE}}-maintain` | `/engsys:maintenance-monster` | Security and dependencies: Dependabot, code scanning, base images | TODO: issue number |
{{#if resource_broker}}
| `{{NAMESPACE}}-broker` | `/engsys:resource-broker` | The host's shared resource pool (`resource-broker.yml`): reaps dead grants, relays grant nudges, runs host windows when directed. It actuates access; it never decides environment health | TODO: issue number |
{{/if}}

**While the merge ledger's heartbeat is fresher than `stale_lock_minutes` (in this directory's
`merge-monster.yml`), do not mark PRs ready and do not merge.** Finish the PR (review, checks, threads
resolved), leave it draft, label it **`mm:ready`** and hand off; add `session: {{NAMESPACE}}-<role>` to the
handoff to be nudged. A stale heartbeat or a closed ledger means normal manual merge discipline.
Suppressing any security finding needs the operator-only `risk-accepted` label.

Live state (host-local, gitignored): `logs/merge-monster/`, `logs/maintenance-monster/`.
{{#if resource_broker}}

**Shared host resources** (the slots of the pool in `resource-broker.yml`, live state `logs/resource-broker/`) are taken through the
pool, never by hard-coding a port or a database: `core/skills/durable-lease/scripts/pool-run.sh` in the engsys checkout for a command,
or the `durable-lease` skill's `pool-cli`, with the pool file and `LEASE_STORE` of `resource-broker.yml` and an owner that starts
with `{{NAMESPACE}}-`. A session that must not block asks with `pool-cli request --session {{NAMESPACE}}-<role>` and is nudged when its
slot is granted.
{{/if}}

Prefer rotation over marathon compaction: with nothing in flight, post a digest and a final heartbeat
**"rotation requested"** (exact phrase) and stop; the fleet supervisor relaunches you within minutes.
