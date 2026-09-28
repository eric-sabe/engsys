---
name: durable-lease
description: Take a durable, heartbeat-expiring, owner-fenced lease on a shared host resource, or a slot from a small pool of them (test ports, databases, cache indices, devices), so concurrent agent sessions and hooks never collide. A lease expires on its own if the holder dies, a fencing token stops a stale holder from touching its successor, and waiters queue with a position and ETA. Covers the lease CLI, the pool CLI and its JSON pool file, owner-fence, TTL and heartbeat guidance, nudges, and the precheck-gate pattern (acquire, background heartbeat, release on EXIT). Use when two sessions or hooks would otherwise share a port, database or environment, when a hook needs an exclusive slot, or when one session at a time must hold a baton (merge, maintenance window).
---

# Durable lease: exclusive host resources without a resident broker

A lease is a small JSON record in a directory on the host: `{owner, kind, token, heartbeat,
ttlMinutes, payload, acquiredAt}`. **The lease is the mutex.** Holding it is the only thing that
entitles you to the resource. If the holder dies, its heartbeat stops and the lease expires by
itself, so a crashed session never blocks the host forever.

The code is `core/lib/lease/` (zero dependencies, ESM, Node >= 20; four files you can also vendor):

| File | Role |
|---|---|
| `durable-lease.mjs` | The library: `createLeaseStore()` gives `acquire / heartbeat / release / status / reap / reconcile / list` |
| `lease-cli.mjs` | Scriptable CLI over one lease kind at a time |
| `pool.mjs` | A pool of N interchangeable slots with a FIFO queue, ETA, reaping and grant nudges, built on the leases |
| `pool-cli.mjs` | The pool CLI: blocking and async acquisition, heartbeat, release, reset, status |

Both CLIs print exactly one JSON object on stdout and never prompt, so hooks and gates can call them.

## When to use it

- **Shared host resources.** Two agent sessions, a pre-push hook and CI-like local runs all want
  port 3000, the same test database, or the same emulator. Give each run its own slot from a pool
  instead of hardcoding the resource.
- **Baton-like exclusive work across sessions.** Only one session may merge, migrate, or run a
  maintenance window at a time: acquire a single lease kind (`merge-baton`, `maintenance-window`),
  heartbeat while working, release when done. Everyone else sees `held` (and who holds it) or,
  after the holder died, `unknown`.
- **Not for** cross-machine coordination. Freshness compares this host's clock against heartbeats
  written on this host, and the atomic-`mkdir`/rename guard assumes one POSIX filesystem. A lease
  between machines needs a different backend (a pinned issue, a database row) behind the same idea.

## Semantics to rely on

- **Dead-man's switch.** A heartbeat older than `ttlMinutes` expires the lease. Readers see an
  expired lease as **`unknown`**: never *held forever*, never *confidently free*. The stale record
  stays visible until it is reaped or taken over.
- **No revival.** `heartbeat` on an expired lease **fails**, even for its owner. Past the TTL the
  lease is forfeit; the holder must re-acquire. That closes the race between a reaper seeing the
  expiry and a slow holder waking up.
- **Loud takeover.** `acquire` over an expired or corrupt record succeeds with
  `tookOverExpired: true` and the previous record, and journals the event to `reaped.log`.
- **Fencing token.** `acquire` mints a random token. `heartbeat` and `release` need the owner and the
  token, so a holder that lost its lease to a takeover cannot refresh or release the new holder's.
  `release --force` is the operator escape hatch (journaled): never use it from a gate.
- **Exactly one winner.** Every mutation runs in a per-kind critical section (an atomic `mkdir`
  guard, stale guards reaped by atomic rename), so a race between N processes has one winner.
  Record writes are temp file plus rename, so `status` and `list` never read a torn record.

## The owner fence

Every owner must match the store's owner pattern. The default accepts any safe token
(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`: `ci-main`, `agent-7`, `user@host`). To fence a store to one
namespace, set an **anchored** pattern (must start with `^`, end with `$`):

```bash
export LEASE_OWNER_PATTERN='^acme-[a-z0-9][a-z0-9-]{0,62}$'   # or --owner-pattern, or ownerPattern: in code
```

Then only `acme-*` owners can acquire, and `reconcile` reaps expired leases of `acme-*` owners while
**reporting but never touching** any record whose owner is outside the fence (another tool sharing
the directory). Owners are session identities, so use the same one for `acquire`, `heartbeat` and
`release`; a gate typically takes `LEASE_OWNER` from its environment with a default like `ci-local`.

The store defaults to `logs/leases` under the **git toplevel** of the current directory (the current
directory itself outside a git work tree), so a hook and an agent started from different
subdirectories of one checkout share a store. A linked worktree has its own toplevel: set
`LEASE_STORE` (or `--store`) to one absolute path to share a store between worktrees or checkouts on
the host, and keep it out of git.

## The lease CLI

```bash
LEASE="node core/lib/lease/lease-cli.mjs"
TOKEN=$($LEASE acquire --kind deploy-window --owner ci-main --ttl 30 --payload '{"pr":123}' | jq -r .record.token)
$LEASE heartbeat --kind deploy-window --owner ci-main --token "$TOKEN"
$LEASE release   --kind deploy-window --owner ci-main --token "$TOKEN"
$LEASE status    --kind deploy-window        # free | held | unknown
$LEASE reap      --kind deploy-window        # only succeeds on a dead lease
$LEASE list
$LEASE reconcile                              # session-startup sweep
$LEASE acquire --kind deploy-window --owner ci-main --ttl 30 --wait-ms 60000   # poll until free or timeout
```

Exit codes: `0` success (`status` is always 0; read the JSON) · `1` operational refusal (held by
another, expired, not owner, `--wait-ms` timeout) · `2` usage or validation error · `3` internal
error. Kinds are filesystem slugs (`^[a-z0-9][a-z0-9._-]{0,127}$`).

Run `reconcile` at session startup: it reaps what died while you were away and reports what is
still held.

## TTL and heartbeat guidance

- **TTL is the longest silence you will tolerate before declaring the holder dead.** Pick it from
  how long the holder can go without a chance to beat, plus margin, not from how long the work
  takes. A test suite that runs 40 minutes should still have a 30-minute TTL and a background beat.
- **Beat at roughly a quarter to an eighth of the TTL** (every 4 minutes on a 30-minute TTL). A
  single failed beat is usually a blip: retry once, and treat two consecutive failures as
  *confirmed lost*, then stop work rather than continue against a resource you no longer hold.
- **A lease the holder cannot beat is a lease it must not hold**: keep TTLs short (minutes) and
  beat from a background loop, not from inside the work.
- **Release as soon as you are done**, not at script end. Always release from an `EXIT` trap so
  no path out of the script leaks the lease; the TTL is the safety net, not the plan.
- The default slot TTL in the pool is 30 minutes. Long provision steps need a TTL longer than the
  provision itself (the pool refuses to hand out a grant whose lease lapsed during provisioning).

## The pool

A pool brokers a fixed table of slots between concurrent sessions. There is **no resident broker**:
every waiter grants *itself* when free slots exceed the live queue entries ahead of it (FIFO
fairness), and slot acquisition is the lease's mutexed `acquire`, so a race for the last slot has
one winner. The provision command runs in the beneficiary's own process, after the lease is held
and before the grant is handed out, so a slot is **guaranteed clean on grant**: a previous holder
that died mid-run cannot leak dirty state.

### The pool file

`--pool FILE` (or `LEASE_POOL_FILE`) names a JSON file. Each slot has an `id` and any other keys you
like; those are the slot's attributes.

```json
{
  "ttlMinutes": 30,
  "provision": "bash scripts/provision-slot.sh --slot",
  "health": "bash scripts/check-slot.sh --slot",
  "grantEnv": {
    "APP_PORT": "{ports.api}",
    "DATABASE_URL": "postgresql://acme:acme@localhost:5432/{db}",
    "REDIS_URL": "redis://localhost:6379/{cacheDb}"
  },
  "slots": [
    { "id": 1, "ports": { "api": 3000, "web": 3001 }, "db": "acme_test_1", "cacheDb": 1 },
    { "id": 2, "ports": { "api": 3100, "web": 3101 }, "db": "acme_test_2", "cacheDb": 2 }
  ]
}
```

| Field | Meaning |
|---|---|
| `slots[]` | `id` (string or number) plus arbitrary attributes. `kind` optionally overrides the slot's lease kind. |
| `provision` | Shell command run on **every grant**, after the lease is held. Non-zero exit releases the slot and fails the acquire. |
| `reset` | Between-use reset for `pool-cli reset` (defaults to `provision`). |
| `health` | Run right after provision (and after `reset`); non-zero exit releases the slot and fails the acquire. |
| `grantEnv` | Env handed to the holder with the grant; `{path}` placeholders read slot attributes (`{ports.api}`). Default: the `POOL_SLOT_*` variables below. |
| `grantFields` | Extra top-level fields on the grant JSON; a template that is exactly `{path}` keeps the raw value (numbers, objects). |
| `ttlMinutes`, `waiterStaleMs`, `movingAvgSeedMs` | Slot TTL (default 30), queue-entry silence cutoff (90 s), ETA seed (8 min). |
| `cwd` | Working directory for commands, relative to the pool file. |
| `nudgeCommand` | Receives each async-grant nudge as JSON on stdin. |
| `bookkeeper` | An owner (that satisfies the owner pattern) used for internal bookkeeping when `release --force` is called without `--owner`. |

**Commands receive the slot's attributes as environment variables:** `POOL_SLOT_ID`,
`POOL_SLOT_KIND`, and `POOL_SLOT_<UPPERCASE_KEY>` per attribute. Non-alphanumerics become `_`, nested
objects flatten (`ports.api` becomes `POOL_SLOT_PORTS_API`), arrays become JSON, plus
`POOL_ACTION` (`provision`, `reset` or `health`). The slot id is also appended as the final argument, so
`"provision": "bash provision.sh --slot"` runs `bash provision.sh --slot "<id>"`. Command stdout is
redirected to stderr so the CLI's stdout stays one JSON object. A provisioning script should derive
every resource name from the slot values it is given, validate them, and never accept a name from
elsewhere.

A provisioner in bash, shellcheck-clean:

```bash
#!/usr/bin/env bash
# provision-slot.sh: reset one slot. Reads POOL_SLOT_* set by the pool.
set -euo pipefail
: "${POOL_SLOT_DB:?}" "${POOL_SLOT_CACHEDB:?}"
[[ "$POOL_SLOT_DB" =~ ^acme_test_[0-9]+$ ]] || { echo "refusing db name: $POOL_SLOT_DB" >&2; exit 2; }
psql -v ON_ERROR_STOP=1 -d postgres \
  -c "DROP DATABASE IF EXISTS ${POOL_SLOT_DB} WITH (FORCE);" \
  -c "CREATE DATABASE ${POOL_SLOT_DB};" >&2
redis-cli -n "$POOL_SLOT_CACHEDB" FLUSHDB >/dev/null
```

Pool-file naming options (`name`, `kindPrefix`, `queueLockKind`, `nudgeEvent`, `shellPrefix`) default to
neutral values (`pool/`, `slot-<id>`, `pool-queue`, `lease-granted`, `POOL_LEASE`). Set them to
reproduce an existing store's names exactly, when an older implementation of the same primitive
shares the directory (see the compatibility section).

### The pool CLI

```bash
POOL="node core/lib/lease/pool-cli.mjs --pool pool.json"

# Blocking (a hook or gate): waits for a slot, printing queue position + ETA to stderr.
eval "$($POOL acquire --owner ci-main --shell)"     # exports the grant env + POOL_LEASE_SLOT/_TOKEN/_OWNER
GRANT=$($POOL acquire --owner ci-main)              # or the raw JSON grant
$POOL acquire --owner ci-main --no-wait             # grant now, or {code:"saturated", position, etaMs}
$POOL acquire --owner ci-main --wait-ms 120000      # bounded wait

# Async (agent sessions): returns {queued, position, eta} at once; a detached waiter self-grants.
$POOL request --owner agent-7 --session agent-7
$POOL claim   --request <id> --owner agent-7        # the grant, or the current position/eta

$POOL heartbeat --slot 1 --owner ci-main --token "$POOL_LEASE_TOKEN"
$POOL reset     --slot 1 --owner ci-main --token "$POOL_LEASE_TOKEN"   # re-run reset + health on a slot you hold
$POOL release   --slot 1 --owner ci-main --token "$POOL_LEASE_TOKEN"
$POOL reprovision --slot 2 --owner broker           # broker op: reset + health on a slot NOBODY holds (a held slot is refused)
$POOL health    --slot 1                            # run the health command; no lease needed
$POOL status                                        # slots (attrs, kind, state, holder), queue positions + ETAs, moving average, store + poolDir
$POOL pump --owner broker                           # one reap + drop-stale maintenance pass
```

Common flags: `--pool`, `--store`, `--owner-pattern`, `--pretty`, `--provision-cmd`, `--reset-cmd`,
`--health-cmd`, `--nudge-cmd`. Env: `LEASE_POOL_FILE`, `LEASE_STORE`, `LEASE_OWNER_PATTERN`,
`POOL_TTL_MINUTES`, `POOL_POLL_MS`, `POOL_WAITER_TIMEOUT_MS`, `POOL_PROVISION_CMD`, `POOL_RESET_CMD`,
`POOL_HEALTH_CMD`, `POOL_NUDGE_CMD` (flags beat env, env beats the pool file). Exit codes: `0` ok · `1`
refusal (saturated, timeout, not owner, provision or health failed) · `2` usage · `3` internal.

### Waiters, queue and nudges

- **Saturation queues.** Waiters join a durable FIFO queue. ETA is queue position times the moving
  average of the last 10 lease durations (an 8-minute seed until there is history). A blocking
  acquire prints `queue position N, eta ~Mm` to stderr so a wait never looks like a hang.
- **Liveness both ways.** A slot whose holder stops heartbeating is reaped after its TTL; a queue entry
  whose waiter stops polling is dropped after 90 s. Reaping is lazy (every acquire, request, release
  and pump does it), so it works with no broker running. A broker session may call `pump` on an
  interval for *active* reaping: the `resource-broker` skill is exactly that session.
- **The nudge is latency, not truth.** For an async `request`, the detached waiter grants itself when
  its turn comes and fires a nudge: a JSON line appended to `<store>/<pool name>/nudges.jsonl` and
  piped to the nudge command's stdin when one is configured. Point that command at whatever your
  fleet uses to message a session. A requester that missed the nudge recovers the durable grant with
  `claim`. **Blocking waiters are never nudged**, and a grant is never delivered only by nudge.
- **A grant is only as good as its lease.** `claim` refuses a grant whose slot expired or was taken
  over (`state: lease_lost`): re-request instead of colliding with the new holder.
- **Failures are durable.** A failed provision or health check releases the slot and writes
  `reset_failed` / `health_failed` to the request's grant file, so an async claimant sees it.

## Pattern: a precheck gate that holds a slot

The gate acquires before the expensive work, heartbeats in the background, and releases on `EXIT` so
no path (a failing step, `set -e`, a signal) leaks the slot. This is the generic shape of an
e2e-test gate that needs its own ports and database:

```bash
#!/usr/bin/env bash
# Gate: run integration tests against a leased slot.
set -euo pipefail
POOL=(node core/lib/lease/pool-cli.mjs --pool pool.json)
OWNER="${LEASE_OWNER:-ci-local}"
LEASE_ACQUIRED=0
HEARTBEAT_PID=""
LOST_MARKER="$(mktemp -u "${TMPDIR:-/tmp}/lease-lost.XXXXXX")"

# Defined BEFORE the acquire and wired to EXIT at once, so it is always safe to call.
lease_cleanup() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
  rm -f "$LOST_MARKER"
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    # Clear the flag only on CONFIRMED release, so the EXIT trap retries a failed one.
    if "${POOL[@]}" release --slot "$POOL_LEASE_SLOT" --owner "$OWNER" --token "$POOL_LEASE_TOKEN" >/dev/null 2>&1; then
      LEASE_ACQUIRED=0
    else
      echo "WARN: release of slot ${POOL_LEASE_SLOT} did not confirm; the pool reaps it after the TTL." >&2
    fi
  fi
}
trap lease_cleanup EXIT

# 1. Acquire (blocking; queue position and ETA print on stderr). Only stdout is captured.
if GRANT="$("${POOL[@]}" acquire --owner "$OWNER" --shell)"; then
  eval "$GRANT"        # exports the grant env plus POOL_LEASE_SLOT / _TOKEN / _OWNER
  LEASE_ACQUIRED=1
else
  echo "FAIL: could not acquire a slot; not falling back to hardcoded ports." >&2
  exit 1
fi

# 2. Background heartbeat: one retry, then a marker file. A lost lease must not look healthy.
(
  while sleep 240; do
    if ! "${POOL[@]}" heartbeat --slot "$POOL_LEASE_SLOT" --owner "$OWNER" --token "$POOL_LEASE_TOKEN" >/dev/null 2>&1; then
      sleep 5
      if ! "${POOL[@]}" heartbeat --slot "$POOL_LEASE_SLOT" --owner "$OWNER" --token "$POOL_LEASE_TOKEN" >/dev/null 2>&1; then
        : >"$LOST_MARKER"
        exit 1
      fi
    fi
  done
) &
HEARTBEAT_PID=$!

# 3. The work, using the granted env. Check the marker between phases and abort if the lease is lost.
first=1
for suite in unit api ui; do
  if [[ -f "$LOST_MARKER" ]]; then
    echo "FAIL: slot ${POOL_LEASE_SLOT} lost (reaped or taken over); aborting." >&2
    LEASE_ACQUIRED=0   # nothing to release: it is no longer ours
    exit 1
  fi
  if [[ "$first" == "0" ]]; then   # the grant was already clean; reset between later phases
    "${POOL[@]}" reset --slot "$POOL_LEASE_SLOT" --owner "$OWNER" --token "$POOL_LEASE_TOKEN" >/dev/null
  fi
  first=0
  npm run "test:${suite}"          # reads APP_PORT / DATABASE_URL from the env
done

# 4. Release now, not at script end: hold the scarce slot only as long as you need it.
lease_cleanup
```

Habits that keep this correct: define the cleanup and the `EXIT` trap **before** acquiring; never
fall back to fixed ports if the pool is unavailable (that is exactly the collision the lease exists to
prevent); reap the heartbeat loop in the cleanup; and treat a lost-lease marker as a hard stop.

### Batteries included: `pool-run.sh`

When the gate is one command, `scripts/pool-run.sh` does all of the above (acquire, export the grant
env, background heartbeat, terminate the command on confirmed loss, release on `EXIT` including
`SIGINT` and `SIGTERM`):

```bash
core/skills/durable-lease/scripts/pool-run.sh --owner ci-local --pool pool.json --ttl 30 -- npm run test:e2e
```

It exits with the command's status, `75` if the lease was lost mid-run, or the pool CLI's status if no
slot could be acquired (the command never runs then). The command sees the grant env (the pool
file's `grantEnv`, else `POOL_SLOT_*`) plus `POOL_RUN_SLOT`, `POOL_RUN_TOKEN`, `POOL_RUN_OWNER`. The
script locates `pool-cli.mjs` relative to the skill; set `POOL_CLI` if you vendored the library
elsewhere.

## A baton across sessions

One kind, one holder, a payload that says why. The holder beats while it works; anyone else reads
`status`:

```bash
LEASE="node core/lib/lease/lease-cli.mjs"
if OUT=$($LEASE acquire --kind merge-baton --owner "$SESSION" --ttl 15 --payload '{"pr":123}'); then
  TOKEN=$(jq -r .record.token <<<"$OUT")   # beat every few minutes while merging, release when done
else
  jq -r '"baton held by \(.holder), expires \(.expiresAt)"' <<<"$OUT"   # wait, or work on something else
fi
```

If the holder's session dies, the lease goes `unknown` at the TTL and the next `acquire` takes over
loudly (`tookOverExpired: true`, journaled). Never `release --force` a baton you did not take.

## Compatibility contract

The on-disk format is stable and shared with other implementations of this primitive on the same
host: `<kind>.json` records with fields `v, kind, owner, token, heartbeat, ttlMinutes, payload,
acquiredAt`; `.guard-<kind>/holder.json` guards; the `reaped.log` journal; and for pools
`<name>/{queue.json, stats.json, grants/<request-id>.json, nudges.jsonl, pool.log}` plus the
`<kindPrefix><id>` slot leases and the `queueLockKind` lock. Generalize with options and env vars,
never by changing the format. `core/lib/lease/durable-lease.test.mjs` and `pool.test.mjs` prove it
against another implementation when `LEASE_REFERENCE_IMPL=/path/to/that/durable-lease.mjs` is set:

```bash
LEASE_REFERENCE_IMPL=/path/to/other/durable-lease.mjs node --test core/lib/lease/durable-lease.test.mjs core/lib/lease/pool.test.mjs
```

## Gotchas

- Same host only (see above). Never put the store on a network filesystem.
- The default store is `<git toplevel>/logs/leases`, so different subdirectories of one checkout agree.
  Different checkouts or linked worktrees do not: set `LEASE_STORE` to one absolute path, in the
  environment of every hook, agent and broker that should share leases.
- Never put secrets in a lease `payload`: it is readable by anything that can read the store.
- Do not `release --force` from automation; it bypasses the fencing token. Use `reap` for a dead
  lease, which refuses a live one.
- A `status` of `unknown` is a decision point, not a free slot: `reap` it or `acquire` over it (which
  reports the takeover), but do not assume the previous holder is gone until the TTL says so.
