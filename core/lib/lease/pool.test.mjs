// pool.test.mjs — tests for the resource pool + pool CLI.
// Runner: `node --test core/lib/lease/pool.test.mjs`.
//
// Library tests inject the clock, provisioner, and notifier — deterministic, no real sleeps on
// the expiry edges. CLI tests spawn real processes to cover the concurrency contract (two
// concurrent acquires serialize to N=2, the third queues) and the async request -> nudge
// round-trip end-to-end. The slot table is the JSON fixture fixtures/acme-pool.json: a two-slot
// table (ports 3000/3001 and 3100/3101, databases acme_test_1/_2, cache DB 1/2) that reproduces
// an existing store's names via name / kindPrefix / queueLockKind / nudgeEvent.
//
// The cross-implementation compatibility tests at the bottom run only when LEASE_REFERENCE_IMPL
// names another implementation's durable-lease.mjs whose sibling e2e-pool.mjs (or
// LEASE_REFERENCE_POOL) is the matching pool module; they skip otherwise:
//   LEASE_REFERENCE_IMPL=/path/to/durable-lease.mjs node --test core/lib/lease/pool.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPool, loadPool, normalizePool, PoolConfigError, renderTemplate, slotEnv } from "./pool.mjs";
import { LeaseUsageError } from "./durable-lease.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "pool-cli.mjs");
const FIXTURE_FILE = join(HERE, "fixtures", "acme-pool.json");
const FIXTURE = loadPool(FIXTURE_FILE);
/** The strict owner fence of a namespace-fenced deployment (`<prefix>-<slug>` owners only). */
const STRICT = /^acme-[a-z0-9][a-z0-9-]{0,62}$/;

function tempStoreDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pool-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Pool with injected clock + recording provisioner/notifier. */
function fakePool(t, opts = {}) {
  const clock = { t: 1_700_000_000_000 };
  const resets = [];
  const nudges = [];
  const pool = createPool({
    pool: FIXTURE,
    ownerPattern: STRICT,
    dir: tempStoreDir(t),
    now: () => clock.t,
    provision: (slot) => resets.push(slot.id),
    notifier: (payload) => nudges.push(payload),
    ...opts,
  });
  return { pool, clock, resets, nudges, minutes: (m) => (clock.t += m * 60_000) };
}

function grantSelf(pool, owner, mode = "blocking", session = owner) {
  const { entry } = pool.enqueue({ owner, session, mode });
  return { entry, grant: pool.tryGrant({ entryId: entry.id, owner }) };
}

/**
 * Advance the fake clock N minutes the way a LIVE waiter experiences it:
 * heartbeating its queue entry every simulated minute (well under the 90s
 * staleness cutoff), exactly as the real poll loop does every few seconds.
 */
function advanceWithWaiter({ pool, minutes }, totalMinutes, entryId, owner) {
  for (let i = 0; i < totalMinutes; i += 1) {
    minutes(1);
    pool.heartbeatEntry({ entryId, owner });
  }
}

// ---------------------------------------------------------------- library --

test("two acquires get distinct slots; the third queues with position + eta (saturation → queue)", (t) => {
  const { pool, resets } = fakePool(t);

  const a = grantSelf(pool, "acme-build").grant;
  const b = grantSelf(pool, "acme-agent-a").grant;
  assert.ok(a && b, "both acquires granted");
  assert.notEqual(a.slot_id, b.slot_id, "distinct slots");
  assert.notEqual(a.DATABASE_URL, b.DATABASE_URL, "distinct DBs");
  assert.notEqual(a.env.E2E_API_PORT, b.env.E2E_API_PORT, "distinct port pairs");
  assert.match(a.DATABASE_URL, /acme_test_[12]\?schema=public$/);
  assert.equal(a.env.DATABASE_URL, a.DATABASE_URL);
  assert.deepEqual(Object.keys(a).filter((k) => ["ports", "DATABASE_URL", "REDIS_URL"].includes(k)), ["ports", "DATABASE_URL", "REDIS_URL"], "grantFields hoisted");
  assert.match(a.REDIS_URL, /redis:\/\/localhost:6379\/[12]$/);
  assert.deepEqual(resets.sort(), [1, 2], "guaranteed-clean reset ran once per grant");

  // Saturated: the third acquire queues instead of corrupting anything.
  const { entry: c } = pool.enqueue({ owner: "acme-merge", session: "acme-merge", mode: "blocking" });
  assert.equal(pool.tryGrant({ entryId: c.id, owner: "acme-merge" }), null, "no slot free — queued");
  const status = pool.poolStatus();
  assert.equal(status.queue.length, 1);
  assert.equal(status.queue[0].position, 1);
  assert.equal(status.queue[0].etaMs, status.movingAvgMs * 1, "eta = position × moving avg");
  assert.ok(status.slots.every((s) => s.state === "held"));
});

test("release frees the slot, records lease duration into the ETA moving average, and the queued waiter self-grants", (t) => {
  const { pool, clock, minutes, resets } = fakePool(t);

  const a = grantSelf(pool, "acme-build").grant;
  const b = grantSelf(pool, "acme-agent-a").grant;
  const { entry: c } = pool.enqueue({ owner: "acme-merge", session: "acme-merge", mode: "blocking" });

  // Lease A runs for 6 minutes while C's waiter keeps heartbeating its entry.
  advanceWithWaiter({ pool, minutes }, 6, c.id, "acme-merge");
  const rel = pool.release({ slotId: a.slot_id, owner: "acme-build", token: a.token });
  assert.equal(rel.ok, true);
  assert.equal(rel.released, true);
  assert.equal(pool.movingAvgMs(), 6 * 60_000, "moving average = the one recorded duration");

  const grantC = pool.tryGrant({ entryId: c.id, owner: "acme-merge" });
  assert.ok(grantC, "queued waiter granted after release");
  assert.equal(grantC.slot_id, a.slot_id, "reuses the freed slot");
  assert.equal(resets.filter((id) => id === a.slot_id).length, 2, "freed slot reset again on re-grant");
  assert.equal(pool.poolStatus().queue.length, 0, "queue drained");
  void b;
  void clock;
});

test("dead lessee (stale heartbeat) is reaped and its slot reused — dead-man's switch via the primitive", (t) => {
  const { pool, minutes, resets } = fakePool(t);

  const a = grantSelf(pool, "acme-build", "blocking").grant;
  assert.ok(a);
  // Lessee dies: no heartbeat for longer than the TTL.
  minutes(a.ttlMinutes + 1);
  assert.equal(pool.poolStatus().slots.find((s) => s.slot_id === a.slot_id).state, "unknown", "expired lease reads unknown — never held-forever");

  // A new acquire lazily reaps the dead lease and takes the slot (reap-on-acquire:
  // works via the CLI alone, before no live broker session exists).
  const b = grantSelf(pool, "acme-agent-a").grant;
  assert.ok(b, "new acquire granted");
  const statuses = pool.poolStatus().slots;
  assert.equal(statuses.find((s) => s.slot_id === a.slot_id).state, "held", "dead slot reclaimed");
  assert.equal(statuses.find((s) => s.slot_id === a.slot_id).holder, "acme-agent-a");
  assert.equal(resets.filter((id) => id === a.slot_id).length, 2, "reclaimed slot got a clean reset before the new grant");

  // The dead lessee's stale token cannot release/heartbeat the new holder's lease (fencing).
  assert.equal(pool.heartbeat({ slotId: a.slot_id, owner: "acme-build", token: a.token }).ok, false);
  assert.equal(pool.release({ slotId: a.slot_id, owner: "acme-build", token: a.token }).ok, false);
});

test("async request returns {queued, position, eta} then fires the injected nudge on grant", (t) => {
  const { pool, nudges, minutes } = fakePool(t);

  const a = grantSelf(pool, "acme-build").grant;
  grantSelf(pool, "acme-agent-a");

  const req = pool.request({ owner: "acme-agent-b", session: "acme-agent-b" });
  assert.equal(req.queued, true);
  assert.equal(req.position, 1);
  assert.equal(req.etaMs, pool.movingAvgMs() * 1);
  assert.equal(nudges.length, 0, "no nudge before grant");

  // claim while queued reports position/eta, not a grant.
  const pending = pool.claim({ requestId: req.request_id, owner: "acme-agent-b" });
  assert.equal(pending.queued, true);
  assert.equal(pending.position, 1);

  // Two minutes pass while the detached waiter heartbeats its entry.
  advanceWithWaiter({ pool, minutes }, 2, req.request_id, "acme-agent-b");
  pool.release({ slotId: a.slot_id, owner: "acme-build", token: a.token });

  // The waiter's poll (here: a direct tryGrant, as the detached waiter process does).
  const grant = pool.tryGrant({ entryId: req.request_id, owner: "acme-agent-b" });
  assert.ok(grant, "async request granted after a slot freed");
  assert.equal(nudges.length, 1, "nudge fired exactly once, on grant");
  assert.equal(nudges[0].session, "acme-agent-b", "nudge addressed to the requesting session");
  assert.equal(nudges[0].event, "e2e-lease-granted");
  assert.equal(nudges[0].grant.slot_id, grant.slot_id);
  assert.ok(nudges[0].grant.token, "nudge carries the lease token");

  // claim now returns the durable grant (nudge is latency, not truth).
  const claimed = pool.claim({ requestId: req.request_id, owner: "acme-agent-b" });
  assert.equal(claimed.state, "ready");
  assert.equal(claimed.slot_id, grant.slot_id);
});

test("blocking waiters never nudge; grants are FIFO-fair across modes", (t) => {
  const { pool, nudges } = fakePool(t);

  const a = grantSelf(pool, "acme-build").grant;
  const b = grantSelf(pool, "acme-agent-a").grant;
  const asyncReq = pool.request({ owner: "acme-merge", session: "acme-merge" }); // position 1
  const { entry: blocking } = pool.enqueue({ owner: "acme-agent-b", session: "acme-agent-b", mode: "blocking" }); // position 2

  pool.release({ slotId: a.slot_id, owner: "acme-build", token: a.token });
  // One slot free, blocking entry is position 2 → must NOT jump the async head.
  assert.equal(pool.tryGrant({ entryId: blocking.id, owner: "acme-agent-b" }), null, "position 2 cannot jump the queue");
  assert.ok(pool.tryGrant({ entryId: asyncReq.request_id, owner: "acme-merge" }), "head of queue granted");

  pool.release({ slotId: b.slot_id, owner: "acme-agent-a", token: b.token });
  const g = pool.tryGrant({ entryId: blocking.id, owner: "acme-agent-b" });
  assert.ok(g, "blocking waiter granted next");
  assert.equal(nudges.length, 1, "only the async grant nudged");
});

test("a silent waiter's queue entry goes stale and is dropped; later entrants advance", (t) => {
  const { pool, clock } = fakePool(t);

  grantSelf(pool, "acme-build");
  grantSelf(pool, "acme-agent-a");
  const { entry: dead } = pool.enqueue({ owner: "acme-merge", session: "acme-merge", mode: "blocking" });
  clock.t += 30_000;
  const { entry: alive } = pool.enqueue({ owner: "acme-agent-b", session: "acme-agent-b", mode: "blocking" });
  assert.equal(pool.poolStatus().queue.length, 2);

  // `dead` never heartbeats again. Past waiterStaleMs (90s), it is dropped:
  clock.t += 70_000; // dead's heartbeat is now 100s old (stale); alive's is 70s old (fresh)
  const swept = pool.pump({ owner: "acme-agent-b" });
  assert.deepEqual(swept.droppedEntries.map((e) => e.id), [dead.id], "silent waiter dropped");

  const pos = pool.heartbeatEntry({ entryId: alive.id, owner: "acme-agent-b" });
  assert.ok(pos, "live waiter still queued");
  assert.equal(pos.position, 1, "survivor advanced to head");
  const queue = pool.poolStatus().queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].request_id, alive.id);
});

test("reset failure on grant releases the slot and surfaces the failure (never hands out a dirty slot)", (t) => {
  const clock = { t: 1_700_000_000_000 };
  const pool = createPool({
    pool: FIXTURE,
    ownerPattern: STRICT,
    dir: tempStoreDir(t),
    now: () => clock.t,
    provision: () => {
      throw new Error("boom: provisioner exploded");
    },
    notifier: () => {},
  });
  const { entry } = pool.enqueue({ owner: "acme-build", session: "acme-build", mode: "blocking" });
  assert.throws(() => pool.tryGrant({ entryId: entry.id, owner: "acme-build" }), /boom/);
  assert.ok(
    pool.poolStatus().slots.every((s) => s.state === "free"),
    "slot released after failed reset — not leaked",
  );
  const claimed = pool.claim({ requestId: entry.id, owner: "acme-build" });
  assert.equal(claimed.state, "reset_failed");
  assert.match(claimed.error, /boom/);
});

test("claim refuses a stale grant whose slot lease expired or was taken over (never hands out someone else's slot)", (t) => {
  const { pool, minutes } = fakePool(t);
  const req = pool.request({ owner: "acme-merge", session: "acme-merge" });
  const granted = pool.tryGrant({ entryId: req.request_id, owner: "acme-merge" });
  assert.ok(granted, "async request granted immediately on a free pool");
  assert.equal(pool.claim({ requestId: req.request_id, owner: "acme-merge" }).state, "ready", "fresh grant claims fine");

  // The claimant sleeps past the TTL without ever heartbeating; the slot is
  // reaped and handed to someone else.
  minutes(granted.ttlMinutes + 1);
  const other = grantSelf(pool, "acme-agent-a").grant;
  assert.equal(other.slot_id, granted.slot_id, "slot reassigned to a new holder");

  const claimed = pool.claim({ requestId: req.request_id, owner: "acme-merge" });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.state, "lease_lost", "stale grant refused — re-request instead of colliding with the new holder");
});

test("a reset that outlives the TTL never yields a grant (lease_lost_during_reset)", (t) => {
  const clock = { t: 1_700_000_000_000 };
  let ttlForReset = 0;
  const pool = createPool({
    pool: FIXTURE,
    ownerPattern: STRICT,
    dir: tempStoreDir(t),
    now: () => clock.t,
    provision: () => {
      clock.t += (ttlForReset + 1) * 60_000; // the provision takes longer than the lease TTL
    },
    notifier: () => {},
  });
  const { entry } = pool.enqueue({ owner: "acme-build", session: "acme-build", mode: "blocking" });
  ttlForReset = 2;
  assert.throws(() => pool.tryGrant({ entryId: entry.id, owner: "acme-build", ttlMinutes: 2 }), /lease lost during reset/);
  const claimed = pool.claim({ requestId: entry.id, owner: "acme-build" });
  assert.equal(claimed.state, "lease_lost_during_reset", "failure recorded durably for the claimant");
});

test("blocking acquire whose queue entry vanishes refuses loudly instead of spinning forever", async (t) => {
  const { pool } = fakePool(t);
  grantSelf(pool, "acme-build");
  grantSelf(pool, "acme-agent-a");

  const blocking = pool.acquireBlocking({ owner: "acme-merge", pollMs: 50 }); // waitMs defaults to Infinity
  // Wait until it's queued, then yank its entry (as an external clear / stale-drop would).
  let queued = [];
  for (let i = 0; i < 100 && !queued.length; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    queued = pool.poolStatus().queue;
  }
  assert.equal(queued.length, 1, "blocking waiter queued");
  pool.dequeue({ entryId: queued[0].request_id, owner: "acme-merge" });

  const result = await blocking;
  assert.equal(result.ok, false);
  assert.equal(result.code, "queue_entry_lost", "terminates with a loud refusal, even with waitMs=Infinity");
});

test("moving average is a windowed mean and drives the ETA math", (t) => {
  const { pool, minutes } = fakePool(t);
  for (const mins of [4, 8, 12]) {
    const { grant } = grantSelf(pool, "acme-build");
    minutes(mins);
    pool.release({ slotId: grant.slot_id, owner: "acme-build", token: grant.token });
  }
  assert.equal(pool.movingAvgMs(), 8 * 60_000, "(4+8+12)/3 = 8 minutes");
  grantSelf(pool, "acme-build");
  grantSelf(pool, "acme-agent-a");
  const req = pool.request({ owner: "acme-merge" });
  assert.equal(req.etaMs, 8 * 60_000, "eta = position 1 × avg 8m");
});


// -------------------------------------------------------------------- CLI --

const CLI_ENV = {
  ...process.env,
  LEASE_POOL_FILE: FIXTURE_FILE,
  LEASE_OWNER_PATTERN: STRICT.source,
  POOL_PROVISION_CMD: "true", // stub the provisioner — CLI tests exercise the protocol, not provisioning
  POOL_POLL_MS: "200",
};

function runCli(args, store, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args, "--store", store],
      { env: { ...CLI_ENV, ...extraEnv } },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("CLI: two concurrent acquires serialize to N=2 and the third queues (real processes)", async (t) => {
  const store = tempStoreDir(t);

  // Three concurrent no-wait acquires racing for two slots.
  const results = await Promise.all([
    runCli(["acquire", "--owner", "acme-build", "--no-wait"], store),
    runCli(["acquire", "--owner", "acme-agent-a", "--no-wait"], store),
    runCli(["acquire", "--owner", "acme-merge", "--no-wait"], store),
  ]);
  const parsed = results.map((r) => ({ ...r, json: JSON.parse(r.stdout) }));
  const grants = parsed.filter((r) => r.json.ok);
  const refused = parsed.filter((r) => !r.json.ok);
  assert.equal(grants.length, 2, "exactly two winners");
  assert.equal(refused.length, 1, "exactly one queued/refused");
  assert.equal(refused[0].code, 1, "refusal exits 1");
  assert.equal(refused[0].json.code, "saturated");
  assert.ok(refused[0].json.position >= 1);
  assert.notEqual(grants[0].json.slot_id, grants[1].json.slot_id, "winners hold distinct slots");

  // A blocking acquire now prints position + ETA to stderr while waiting, then wins after a release.
  const blocking = runCli(["acquire", "--owner", "acme-agent-b", "--wait-ms", "15000"], store);
  await new Promise((r) => setTimeout(r, 700)); // let it queue + print at least one wait line
  const g0 = grants[0].json;
  const rel = await runCli(["release", "--slot", String(g0.slot_id), "--owner", g0.owner, "--token", g0.token], store);
  assert.equal(JSON.parse(rel.stdout).released, true);
  const done = await blocking;
  const grant = JSON.parse(done.stdout);
  assert.equal(grant.ok, true, `blocking acquire granted after release (stderr: ${done.stderr})`);
  assert.equal(grant.slot_id, g0.slot_id);
  assert.match(done.stderr, /queue position 1, eta ~\d+m/, "wait is legible: position + ETA on stderr");
});

test("CLI: async request returns {queued, position, eta} immediately; detached waiter nudges on grant", async (t) => {
  const store = tempStoreDir(t);
  const nudgeFile = join(store, "nudge-received.jsonl");

  const [a, b] = await Promise.all([
    runCli(["acquire", "--owner", "acme-build", "--no-wait"], store),
    runCli(["acquire", "--owner", "acme-agent-a", "--no-wait"], store),
  ]);
  const ga = JSON.parse(a.stdout);
  const gb = JSON.parse(b.stdout);
  assert.ok(ga.ok && gb.ok);

  // Async request while saturated: immediate queued response + a detached waiter.
  const nudgeCmd = `cat >> ${JSON.stringify(nudgeFile)}`;
  const req = await runCli(["request", "--owner", "acme-merge", "--session", "acme-merge"], store, {
    POOL_NUDGE_CMD: nudgeCmd,
  });
  const reqJson = JSON.parse(req.stdout);
  assert.equal(reqJson.queued, true);
  assert.equal(reqJson.position, 1);
  assert.ok(reqJson.etaMs > 0);
  assert.ok(reqJson.waiter_pid, "detached waiter spawned");

  // Free a slot; the waiter (polling every 200ms) should self-grant and nudge.
  await runCli(["release", "--slot", String(ga.slot_id), "--owner", ga.owner, "--token", ga.token], store);
  let nudged = null;
  for (let i = 0; i < 50 && !nudged; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const lines = readFileSync(nudgeFile, "utf8").trim().split("\n");
      if (lines.length && lines[0]) nudged = JSON.parse(lines[0]);
    } catch {
      /* not yet */
    }
  }
  assert.ok(nudged, "grant nudge delivered via the nudge command (pluggable messaging seam)");
  assert.equal(nudged.session, "acme-merge");
  assert.equal(nudged.grant.slot_id, ga.slot_id);

  // The durable channels agree: nudges.jsonl + claim both carry the grant.
  const jsonl = readFileSync(join(store, "e2e-pool", "nudges.jsonl"), "utf8");
  assert.match(jsonl, /e2e-lease-granted/);
  const claim = await runCli(["claim", "--request", reqJson.request_id, "--owner", "acme-merge"], store);
  const claimed = JSON.parse(claim.stdout);
  assert.equal(claimed.state, "ready");
  assert.equal(claimed.token, nudged.grant.token);
});

test("CLI: --shell emits export lines for the hook; heartbeat keeps the lease alive", async (t) => {
  const store = tempStoreDir(t);
  const res = await runCli(["acquire", "--owner", "acme-build", "--no-wait", "--shell"], store);
  assert.match(res.stdout, /export E2E_API_PORT='\d+'/);
  assert.match(res.stdout, /export DATABASE_URL='postgresql:\/\/acme:acme@localhost:5432\/acme_test_\d\?schema=public'/);
  assert.match(res.stdout, /export E2E_LEASE_TOKEN='/);
  const token = res.stdout.match(/export E2E_LEASE_TOKEN='([^']+)'/)[1];
  const slot = res.stdout.match(/export E2E_LEASE_SLOT='(\d)'/)[1];
  assert.match(res.stdout, /export E2E_LEASE_OWNER='acme-build'/);
  const hb = await runCli(["heartbeat", "--slot", slot, "--owner", "acme-build", "--token", token], store);
  assert.equal(JSON.parse(hb.stdout).ok, true);
  const rel = await runCli(["release", "--slot", slot, "--owner", "acme-build", "--token", token], store);
  assert.equal(JSON.parse(rel.stdout).released, true);
});

test("CLI: without --store or LEASE_STORE the pool store is <git toplevel>/logs/leases, shared by every subdirectory", async (t) => {
  const repo = realpathSync(tempStoreDir(t));
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const deep = join(repo, "apps", "web");
  mkdirSync(deep, { recursive: true });
  const run = (args, cwd) =>
    new Promise((resolvePromise) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env: { ...CLI_ENV, LEASE_STORE: "" } }, (error, stdout, stderr) =>
        resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
  const granted = await run(["acquire", "--owner", "acme-build", "--no-wait"], repo);
  assert.equal(JSON.parse(granted.stdout).ok, true, granted.stderr);
  assert.ok(existsSync(join(repo, "logs", "leases", "e2e-pool", "queue.json")) || existsSync(join(repo, "logs", "leases", "e2e-slot-1.json")));
  const seen = await run(["status"], deep);
  const held = JSON.parse(seen.stdout).slots.filter((s) => s.state === "held");
  assert.equal(held.length, 1, "a process in a subdirectory sees the slot the toplevel process took");
  assert.ok(!existsSync(join(deep, "logs")), "no second store appears in the subdirectory");
});

// ---------------------------------------------------------- slot catalog --

test("slot catalog: the fixture pool's DBs / cache indices / ports are distinct and never overlap", () => {
  const dbs = FIXTURE.slots.map((s) => s.attrs.db);
  assert.deepEqual(dbs, ["acme_test_1", "acme_test_2"]);
  const ports = FIXTURE.slots.flatMap((s) => [s.attrs.ports.api, s.attrs.ports.dashboard]);
  assert.deepEqual(ports, [3000, 3001, 3100, 3101]);
  assert.equal(new Set(ports).size, ports.length, "no port shared between slots");
  const cache = FIXTURE.slots.map((s) => s.attrs.redisDb);
  assert.deepEqual(cache, [1, 2]);
  assert.deepEqual(FIXTURE.slots.map((s) => s.kind), ["e2e-slot-1", "e2e-slot-2"]);
  assert.equal(FIXTURE.queueLockKind, "e2e-pool-queue");
  for (const s of FIXTURE.slots) {
    const { env } = { env: slotEnv(s) };
    assert.equal(env.POOL_SLOT_DB, s.attrs.db);
  }
});

// -------------------------------------------- slot attributes -> commands --

/** A stub provisioner: records its environment and arguments so tests can assert on what a command receives. */
function stubCommand(t, name = "stub") {
  const dir = tempStoreDir(t);
  const out = join(dir, `${name}.env`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\n{ env; echo "ARGS=$*"; echo "PWD_SEEN=$(pwd)"; } > "$STUB_OUT"\n`);
  return { dir, out, script, command: `STUB_OUT=${JSON.stringify(out)} sh ${JSON.stringify(script)} --slot` };
}

const readEnvFile = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("provision command receives the slot's attributes as POOL_SLOT_<KEY> env vars plus POOL_SLOT_ID", (t) => {
  const stub = stubCommand(t);
  const def = { ...JSON.parse(readFileSync(FIXTURE_FILE, "utf8")), provision: stub.command, cwd: stub.dir };
  const pool = createPool({ pool: def, ownerPattern: STRICT, dir: tempStoreDir(t), notifier: () => {} });
  const { grant } = grantSelf(pool, "acme-build");
  assert.ok(grant, "granted");
  const env = readEnvFile(stub.out);
  assert.equal(env.POOL_SLOT_ID, "1");
  assert.equal(env.POOL_SLOT_KIND, "e2e-slot-1");
  assert.equal(env.POOL_SLOT_DB, "acme_test_1");
  assert.equal(env.POOL_SLOT_REDISDB, "1");
  assert.equal(env.POOL_SLOT_PORTS_API, "3000", "nested attributes flatten with _");
  assert.equal(env.POOL_SLOT_PORTS_DASHBOARD, "3001");
  assert.equal(env.POOL_ACTION, "provision");
  assert.equal(env.ARGS, "--slot 1", "the slot id is also appended as the last argument (provisioner CLIs that take --slot N)");
  assert.equal(realpathSync(env.PWD_SEEN), realpathSync(stub.dir), "commands run in the pool's cwd");

  // The second grant provisions the OTHER slot with ITS values.
  grantSelf(pool, "acme-agent-a");
  const env2 = readEnvFile(stub.out);
  assert.equal(env2.POOL_SLOT_ID, "2");
  assert.equal(env2.POOL_SLOT_DB, "acme_test_2");
  assert.equal(env2.POOL_SLOT_PORTS_API, "3100");
});

test("slot env naming: keys upper-case, non-alphanumerics become _, arrays become JSON, null becomes empty; id/kind are structural", () => {
  const pool = normalizePool({
    slots: [
      { id: "web-1", "cache-db": 7, ports: { api: 3000, "admin.ui": 3001 }, tags: ["a", "b"], note: null, region: "eu" },
    ],
  });
  const env = slotEnv(pool.slots[0]);
  assert.deepEqual(env, {
    POOL_SLOT_ID: "web-1",
    POOL_SLOT_KIND: "slot-web-1",
    POOL_SLOT_CACHE_DB: "7",
    POOL_SLOT_PORTS_API: "3000",
    POOL_SLOT_PORTS_ADMIN_UI: "3001",
    POOL_SLOT_TAGS: '["a","b"]',
    POOL_SLOT_NOTE: "",
    POOL_SLOT_REGION: "eu",
  });
  assert.deepEqual(Object.keys(pool.slots[0].attrs), ["cache-db", "ports", "tags", "note", "region"], "id is not an attribute");
});

test("without grantEnv a grant hands out the POOL_SLOT_* env; with it, the rendered templates (raw values survive in grantFields)", (t) => {
  const generic = createPool({
    pool: { slots: [{ id: 1, port: 4000, db: "x_1" }, { id: 2, port: 4001, db: "x_2" }] },
    dir: tempStoreDir(t),
    notifier: () => {},
    env: {},
  });
  const { grant } = grantSelf(generic, "ci-main");
  assert.equal(grant.env.POOL_SLOT_PORT, "4000");
  assert.equal(grant.env.POOL_SLOT_DB, "x_1");
  assert.deepEqual(grant.attrs, { port: 4000, db: "x_1" });

  const { grant: g2 } = grantSelf(pool2(t), "acme-build");
  assert.equal(g2.env.E2E_API_PORT, "3000");
  assert.deepEqual(g2.ports, { api: 3000, dashboard: 3001 }, "an exact {path} template keeps the raw object");
  assert.equal(renderTemplate("{ports.api}-{db}", FIXTURE.slots[0]), "3000-acme_test_1");
  assert.equal(renderTemplate("{ports.api}", FIXTURE.slots[0]), 3000);
  assert.equal(renderTemplate("{id}", FIXTURE.slots[0]), 1);
  assert.equal(renderTemplate("{kind}", FIXTURE.slots[0]), "e2e-slot-1");

  function pool2(tt) {
    return createPool({ pool: FIXTURE, ownerPattern: STRICT, dir: tempStoreDir(tt), notifier: () => {}, provision: () => {} });
  }
});

test("provision command failure releases the slot, records reset_failed and exits the CLI 1 (real process)", async (t) => {
  const store = tempStoreDir(t);
  const res = await runCli(["acquire", "--owner", "acme-build", "--no-wait"], store, { POOL_PROVISION_CMD: "exit 7 #" });
  assert.equal(res.code, 1, res.stderr);
  const status = JSON.parse((await runCli(["status"], store)).stdout);
  assert.ok(status.slots.every((s) => s.state === "free"), "slot not leaked");
  const grants = readdirSync(join(store, "e2e-pool", "grants"));
  assert.equal(grants.length, 1);
  const failure = JSON.parse(readFileSync(join(store, "e2e-pool", "grants", grants[0]), "utf8"));
  assert.equal(failure.state, "reset_failed");
  assert.match(failure.error, /exit 7/);
});

test("health command runs after provision; a failing check releases the slot and records health_failed", async (t) => {
  const { pool, resets } = fakePool(t, {
    health: (slot) => {
      throw new Error(`slot ${slot.id} health check failed (probe exit 1)`);
    },
  });
  const { entry } = pool.enqueue({ owner: "acme-build", session: "acme-build", mode: "blocking" });
  assert.throws(() => pool.tryGrant({ entryId: entry.id, owner: "acme-build" }), /health check failed/);
  assert.deepEqual(resets, [1], "provision ran first");
  assert.ok(pool.poolStatus().slots.every((s) => s.state === "free"));
  assert.equal(pool.claim({ requestId: entry.id, owner: "acme-build" }).state, "health_failed");

  // Through the CLI: a failing health command exits 1; a passing one hands out the grant.
  const store = tempStoreDir(t);
  const bad = await runCli(["acquire", "--owner", "acme-build", "--no-wait"], store, { POOL_HEALTH_CMD: "exit 3 #" });
  assert.equal(bad.code, 1, bad.stderr);
  const good = await runCli(["acquire", "--owner", "acme-build", "--no-wait"], store, { POOL_HEALTH_CMD: "true" });
  assert.equal(JSON.parse(good.stdout).ok, true, good.stderr);
});

test("reprovision: the broker resets a slot nobody holds (lease taken, reset + health, released); a held slot is refused", (t) => {
  const calls = [];
  const { pool } = fakePool(t, {
    reset: (slot) => calls.push(`reset ${slot.id}`),
    health: (slot) => calls.push(`health ${slot.id}`),
  });
  const { grant } = grantSelf(pool, "acme-build");
  const other = pool.slots.find((s) => s.id !== grant.slot_id).id;
  calls.length = 0; // the grant itself ran health

  const free = pool.reprovisionSlot({ slotId: other, owner: "acme-broker" });
  assert.deepEqual(free, { ok: true, code: "reprovisioned", slot_id: other });
  assert.deepEqual(calls, [`reset ${other}`, `health ${other}`]);
  assert.equal(pool.poolStatus().slots.find((s) => s.slot_id === other).state, "free", "the slot is released again");
  assert.deepEqual(pool.poolStatus().queue, [], "nothing was queued");

  const held = pool.reprovisionSlot({ slotId: grant.slot_id, owner: "acme-broker" });
  assert.equal(held.ok, false);
  assert.equal(held.code, "held");
  assert.equal(held.holder, "acme-build");
  assert.equal(calls.length, 2, "a held slot is never reset from under its holder");
  assert.equal(pool.poolStatus().slots.find((s) => s.slot_id === grant.slot_id).holder, "acme-build");
});

test("reprovision: a failing reset or health check is reported, and the slot is still released", (t) => {
  const { pool } = fakePool(t, {
    reset: () => {
      throw new Error("slot 1 reset failed (boom)");
    },
  });
  const res = pool.reprovisionSlot({ slotId: 1, owner: "acme-broker" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "reset_failed");
  assert.match(res.error, /boom/);
  assert.equal(pool.poolStatus().slots.find((s) => s.slot_id === 1).state, "free");
});

test("status reports where the pool state lives (store, poolDir), so a broker can tail nudges.jsonl", async (t) => {
  const store = tempStoreDir(t);
  const status = JSON.parse((await runCli(["status"], store)).stdout);
  assert.equal(realpathSync(status.store), realpathSync(store));
  assert.equal(realpathSync(status.poolDir), realpathSync(join(store, "e2e-pool")));
  const re = await runCli(["reprovision", "--slot", "1", "--owner", "acme-broker"], store, { POOL_RESET_CMD: "true", POOL_HEALTH_CMD: "true" });
  assert.equal(JSON.parse(re.stdout).code, "reprovisioned", re.stderr);
  const bad = await runCli(["reprovision", "--slot", "2", "--owner", "acme-broker"], store, { POOL_RESET_CMD: "exit 4 #" });
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).code, "reset_failed");
});

test("reset op re-runs the reset command on a slot you hold (token-verified) with POOL_ACTION=reset; health op is read-only", async (t) => {
  const store = tempStoreDir(t);
  const stub = stubCommand(t, "reset");
  const grant = JSON.parse((await runCli(["acquire", "--owner", "acme-build", "--no-wait"], store)).stdout);
  assert.equal(grant.ok, true);

  const denied = await runCli(["reset", "--slot", String(grant.slot_id), "--owner", "acme-build", "--token", "nope"], store, { POOL_RESET_CMD: stub.command });
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stdout).code, "not_owner");
  assert.equal(existsSync(stub.out), false, "no command ran for a caller without the token");

  const ok = await runCli(["reset", "--slot", String(grant.slot_id), "--owner", "acme-build", "--token", grant.token], store, { POOL_RESET_CMD: stub.command });
  assert.equal(ok.code, 0, ok.stderr);
  const env = readEnvFile(stub.out);
  assert.equal(env.POOL_ACTION, "reset");
  assert.equal(env.POOL_SLOT_DB, `acme_test_${grant.slot_id}`);

  const hstub = stubCommand(t, "health");
  const healthy = await runCli(["health", "--slot", String(grant.slot_id)], store, { POOL_HEALTH_CMD: hstub.command });
  assert.equal(JSON.parse(healthy.stdout).code, "healthy");
  assert.equal(readEnvFile(hstub.out).POOL_ACTION, "health");
  const unhealthy = await runCli(["health", "--slot", "2"], store, { POOL_HEALTH_CMD: "exit 1 #" });
  assert.equal(unhealthy.code, 1);
  assert.equal(JSON.parse(unhealthy.stdout).code, "unhealthy");
});

test("command flags (--provision-cmd) override env, env overrides the pool file; the legacy E2E_LEASE_RESET_CMD alias still works", async (t) => {
  const store = tempStoreDir(t);
  const flagStub = stubCommand(t, "flag");
  const flagged = await runCli(["acquire", "--owner", "acme-build", "--no-wait", "--provision-cmd", flagStub.command], store, { POOL_PROVISION_CMD: "exit 9 #" });
  assert.equal(flagged.code, 0, flagged.stderr);
  assert.equal(readEnvFile(flagStub.out).POOL_SLOT_ID, "1");

  const legacyStub = stubCommand(t, "legacy");
  const legacy = await runCli(["acquire", "--owner", "acme-agent-a", "--no-wait"], tempStoreDir(t), {
    POOL_PROVISION_CMD: "",
    E2E_LEASE_RESET_CMD: legacyStub.command,
  });
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(readEnvFile(legacyStub.out).POOL_SLOT_ID, "1");
});

// ------------------------------------------------------- pool file / config --

test("pool file: load, defaults, and validation errors", (t) => {
  const dir = tempStoreDir(t);
  const minimal = normalizePool({ slots: [{ id: 1 }, { id: "b", region: "eu" }] });
  assert.equal(minimal.name, "pool");
  assert.equal(minimal.kindPrefix, "slot-");
  assert.equal(minimal.queueLockKind, "pool-queue");
  assert.equal(minimal.nudgeEvent, "lease-granted");
  assert.equal(minimal.shellPrefix, "POOL_LEASE");
  assert.deepEqual(minimal.slots.map((s) => s.kind), ["slot-1", "slot-b"]);

  const bad = (def, re) => assert.throws(() => normalizePool(def), (err) => err instanceof PoolConfigError && err instanceof LeaseUsageError && re.test(err.message));
  bad(null, /JSON object/);
  bad({}, /non-empty "slots"/);
  bad({ slots: [] }, /non-empty "slots"/);
  bad({ slots: [{ region: "x" }] }, /needs an "id"/);
  bad({ slots: [{ id: 1 }, { id: "1" }] }, /duplicate slot id/);
  bad({ slots: [{ id: "A B" }] }, /must match/);
  bad({ slots: [{ id: 1 }], name: "../x" }, /invalid pool "name"/);
  bad({ slots: [{ id: 1 }], provision: 5 }, /"provision" must be a string/);
  bad({ slots: [{ id: 1 }], ttlMinutes: 0 }, /"ttlMinutes"/);
  bad({ slots: [{ id: 1 }], grantEnv: { "bad-name": "x" } }, /not a valid environment variable name/);
  bad({ slots: [{ id: 1 }], grantEnv: { X: "{missing}" } }, /unknown slot attribute "missing"/);
  bad({ slots: [{ id: 1 }], grantFields: { token: "x" } }, /collides/);
  bad({ slots: [{ id: 1, kind: "same" }, { id: 2, kind: "same" }] }, /duplicate lease kind/);

  assert.throws(() => loadPool(join(dir, "missing.json")), /cannot read pool file/);
  writeFileSync(join(dir, "broken.json"), "{nope");
  assert.throws(() => loadPool(join(dir, "broken.json")), /not valid JSON/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ cwd: "work", slots: [{ id: 1 }] }));
  assert.equal(loadPool(join(dir, "ok.json")).cwd, join(dir, "work"), "cwd resolves against the pool file's directory");
});

test("CLI: a missing / invalid pool file or unknown slot is a usage error (exit 2)", async (t) => {
  const store = tempStoreDir(t);
  const none = await runCli(["status"], store, { LEASE_POOL_FILE: "" });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no pool file/);
  const missing = await runCli(["status"], store, { LEASE_POOL_FILE: join(store, "absent.json") });
  assert.equal(missing.code, 2);
  const badSlot = await runCli(["heartbeat", "--slot", "99", "--owner", "acme-build", "--token", "x"], store);
  assert.equal(badSlot.code, 2);
  assert.match(badSlot.stderr, /invalid slot id/);
  const badOwner = await runCli(["acquire", "--owner", "other-bot", "--no-wait"], store);
  assert.equal(badOwner.code, 2);
  const flagPool = await runCli(["status", "--pool", FIXTURE_FILE], store, { LEASE_POOL_FILE: "" });
  assert.equal(flagPool.code, 0, flagPool.stderr);
});

test("owner fence: a pool on the default pattern accepts any safe owner; a forced release needs a bookkeeper that satisfies the fence", (t) => {
  const { pool } = fakePool(t, { pool: { slots: [{ id: 1 }, { id: 2 }] }, ownerPattern: undefined, env: {} });
  const { grant } = grantSelf(pool, "ci-main@host:1");
  assert.ok(grant, "permissive default fence");
  // No `bookkeeper` in this pool: a forced release with no owner cannot do its stats bookkeeping.
  assert.throws(() => pool.release({ slotId: grant.slot_id, force: true }), /bookkeeper/);

  const { pool: withKeeper } = fakePool(t);
  const { grant: g } = grantSelf(withKeeper, "acme-build");
  const forced = withKeeper.release({ slotId: g.slot_id, force: true });
  assert.equal(forced.released, true, "the pool file's bookkeeper covers forced releases");
  assert.equal(withKeeper.poolStatus().slots.find((s) => s.slot_id === g.slot_id).state, "free");
});

test("on-disk layout: slot leases, queue lock, queue/stats/grants/pool.log sit where the stable format puts them", (t) => {
  const store = tempStoreDir(t);
  const { pool } = fakePool(t, { dir: store });
  const req = pool.request({ owner: "acme-merge", session: "acme-merge" });
  const g = pool.tryGrant({ entryId: req.request_id, owner: "acme-merge" });
  assert.ok(g);
  const files = readdirSync(store).sort();
  assert.ok(files.includes("e2e-slot-1.json"), "slot lease record");
  assert.ok(files.includes("e2e-pool"), "pool state dir");
  assert.deepEqual(readdirSync(join(store, "e2e-pool")).sort(), ["grants", "pool.log", "queue.json"]);
  assert.deepEqual(readdirSync(join(store, "e2e-pool", "grants")), [`${req.request_id}.json`]);
  const record = JSON.parse(readFileSync(join(store, "e2e-slot-1.json"), "utf8"));
  assert.deepEqual(Object.keys(record), ["v", "kind", "owner", "token", "heartbeat", "ttlMinutes", "payload", "acquiredAt"]);
  assert.deepEqual(record.payload, { requestId: req.request_id, session: "acme-merge", mode: "async" });
  assert.equal(record.ttlMinutes, 30);
  assert.deepEqual(JSON.parse(readFileSync(join(store, "e2e-pool", "queue.json"), "utf8")), { entries: [] });
  const log = readFileSync(join(store, "e2e-pool", "pool.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(log.map((e) => e.event), ["request_queued", "granted"]);
  // The queue lock is a released lease: no record left behind.
  assert.ok(!files.includes("e2e-pool-queue.json"));
  const grantFile = JSON.parse(readFileSync(join(store, "e2e-pool", "grants", `${req.request_id}.json`), "utf8"));
  assert.deepEqual(Object.keys(grantFile).slice(0, 9), ["ok", "state", "request_id", "mode", "slot_id", "kind", "owner", "token", "ttlMinutes"]);
});

// ---------------------------------------------------------------------------
// Cross-implementation compatibility (LEASE_REFERENCE_IMPL).
//
// The pool's on-disk state is a stable format shared with other implementations on the same
// host. When LEASE_REFERENCE_IMPL names another implementation's durable-lease.mjs whose sibling
// e2e-pool.mjs (override: LEASE_REFERENCE_POOL) is the matching pool module, drive both against
// one store on one fake clock, with the provisioner stubbed on both sides, and prove each reads,
// grants into, heartbeats, releases and claims what the other wrote.
// ---------------------------------------------------------------------------

const REFERENCE = process.env.LEASE_REFERENCE_IMPL ? resolve(process.env.LEASE_REFERENCE_IMPL) : null;
const REFERENCE_POOL = process.env.LEASE_REFERENCE_POOL
  ? resolve(process.env.LEASE_REFERENCE_POOL)
  : REFERENCE
    ? join(dirname(REFERENCE), "e2e-pool.mjs")
    : null;
const refLease = REFERENCE ? await import(pathToFileURL(REFERENCE).href) : null;
const refPoolMod = REFERENCE_POOL && existsSync(REFERENCE_POOL) ? await import(pathToFileURL(REFERENCE_POOL).href) : null;
const skipRef = !REFERENCE ? "LEASE_REFERENCE_IMPL not set" : !refPoolMod ? `no reference pool module at ${REFERENCE_POOL}` : false;

function refOwners() {
  const pattern = refLease.OWNER_PATTERN;
  const prefix = /^\^([A-Za-z0-9._-]*)/.exec(pattern.source)?.[1] ?? "";
  const owners = ["alpha", "beta", "gamma", "delta"].map((n) => `${prefix}${n}`);
  for (const o of owners) assert.ok(pattern.test(o), `derived owner ${o} must satisfy the reference fence ${pattern}`);
  return owners;
}

/** The reference pool and this port on one directory, one clock, both provisioners stubbed and both notifiers recording. */
function pairedPools(t) {
  const clock = { t: 1_700_000_000_000 };
  const dir = tempStoreDir(t);
  const now = () => clock.t;
  const [alpha, beta, gamma, delta] = refOwners();
  const refProvisions = [];
  const portProvisions = [];
  const refNudges = [];
  const portNudges = [];
  const refPool = refPoolMod.createE2ePool({ dir, now, reset: (s) => refProvisions.push(s.id), notifier: (p) => refNudges.push(p) });
  const def = { ...JSON.parse(readFileSync(FIXTURE_FILE, "utf8")), bookkeeper: alpha };
  const port = createPool({ pool: def, dir, now, ownerPattern: refLease.OWNER_PATTERN, provision: (s) => portProvisions.push(s.id), notifier: (p) => portNudges.push(p) });
  return { dir, clock, refPool, port, alpha, beta, gamma, delta, refProvisions, portProvisions, refNudges, portNudges, minutes: (m) => (clock.t += m * 60_000) };
}

test("pool compat: reference grants -> port reads status, heartbeats, releases; stats feed the shared moving average", { skip: skipRef }, (t) => {
  const { refPool, port, alpha, minutes } = pairedPools(t);
  const { entry } = refPool.enqueue({ owner: alpha, session: alpha, mode: "blocking" });
  const grant = refPool.tryGrant({ entryId: entry.id, owner: alpha });
  assert.ok(grant);

  const status = port.poolStatus();
  const slot = status.slots.find((s) => s.slot_id === grant.slot_id);
  assert.equal(slot.state, "held");
  assert.equal(slot.holder, alpha);
  assert.equal(status.slots.filter((s) => s.state === "free").length, 1);
  assert.deepEqual(slot.attrs.ports, grant.ports, "the fixture's slot table lines up with the reference's slot ids and ports");

  minutes(1);
  assert.equal(port.heartbeat({ slotId: grant.slot_id, owner: alpha, token: "nope" }).ok, false);
  assert.equal(port.heartbeat({ slotId: grant.slot_id, owner: alpha, token: grant.token }).ok, true);
  minutes(5);
  const released = port.release({ slotId: grant.slot_id, owner: alpha, token: grant.token });
  assert.equal(released.released, true);
  assert.equal(released.slot_id, grant.slot_id);
  assert.equal(refPool.poolStatus().slots.find((s) => s.slot_id === grant.slot_id).state, "free");
  assert.equal(port.movingAvgMs(), 6 * 60_000, "the port recorded the lease duration in the shared stats.json");
  assert.equal(refPool.movingAvgMs(), port.movingAvgMs(), "and the reference reads the same average");
});

test("pool compat: port grants -> reference heartbeats and releases; grant shape is a superset of the reference's", { skip: skipRef }, (t) => {
  const { refPool, port, alpha, beta, minutes } = pairedPools(t);
  const portGrant = grantSelf(port, alpha).grant;
  const { entry } = refPool.enqueue({ owner: beta, session: beta, mode: "blocking" });
  const refGrant = refPool.tryGrant({ entryId: entry.id, owner: beta });
  assert.ok(portGrant && refGrant);
  assert.notEqual(portGrant.slot_id, refGrant.slot_id, "the two implementations never double-book a slot");
  for (const key of Object.keys(refGrant)) assert.ok(key in portGrant, `port grant carries the reference field ${key}`);
  assert.equal(portGrant.kind, `e2e-slot-${portGrant.slot_id}`);
  assert.deepEqual(portGrant.env.E2E_API_PORT, String(portGrant.ports.api));

  minutes(2);
  assert.equal(refPool.heartbeat({ slotId: portGrant.slot_id, owner: alpha, token: portGrant.token }).ok, true);
  assert.equal(refPool.release({ slotId: portGrant.slot_id, owner: alpha, token: "nope" }).ok, false);
  assert.equal(refPool.release({ slotId: portGrant.slot_id, owner: alpha, token: portGrant.token }).released, true);
  assert.equal(port.poolStatus().slots.find((s) => s.slot_id === portGrant.slot_id).state, "free");
});

test("pool compat: the durable queue is shared — FIFO across implementations, async grant + claim in both directions, nudge event", { skip: skipRef }, (t) => {
  const { refPool, port, alpha, beta, gamma, delta, refNudges, portNudges, minutes } = pairedPools(t);
  const a = grantSelf(port, alpha).grant; // slot A: held via the port
  const { entry } = refPool.enqueue({ owner: beta, session: beta, mode: "blocking" });
  const b = refPool.tryGrant({ entryId: entry.id, owner: beta }); // slot B: held via the reference
  assert.ok(a && b);

  // Saturated: a reference async request and a port async request queue in one FIFO.
  const refReq = refPool.request({ owner: gamma, session: gamma });
  const portReq = port.request({ owner: delta, session: delta });
  assert.equal(refReq.position, 1);
  assert.equal(portReq.position, 2, "the port sees the reference's entry ahead of it");
  const overview = port.poolStatus().queue;
  assert.deepEqual(overview.map((q) => q.request_id), [refReq.request_id, portReq.request_id]);
  assert.deepEqual(overview.map((q) => q.mode), ["async", "async"]);
  assert.equal(refPool.poolStatus().queue.length, 2);
  assert.equal(port.claim({ requestId: refReq.request_id, owner: delta }).position, 1);
  assert.equal(refPool.claim({ requestId: portReq.request_id, owner: gamma }).position, 2);

  // Free one slot (by the reference, on the port's lease). The port's entry is second: it must NOT jump the reference's.
  minutes(1);
  port.heartbeatEntry({ entryId: portReq.request_id, owner: delta });
  refPool.heartbeatEntry({ entryId: refReq.request_id, owner: gamma });
  assert.equal(refPool.release({ slotId: a.slot_id, owner: alpha, token: a.token }).released, true);
  assert.equal(port.tryGrant({ entryId: portReq.request_id, owner: delta }), null, "FIFO fairness holds across implementations");

  // The PORT grants the REFERENCE's queued async request; the reference claims it durably.
  const granted = port.tryGrant({ entryId: refReq.request_id, owner: gamma });
  assert.ok(granted, "the port granted an entry another implementation enqueued");
  assert.equal(portNudges.length, 1);
  assert.equal(portNudges[0].event, "e2e-lease-granted", "nudge event name reproduces the reference's when the pool file says so");
  assert.equal(portNudges[0].session, gamma);
  const claimed = refPool.claim({ requestId: refReq.request_id, owner: gamma });
  assert.equal(claimed.state, "ready");
  assert.equal(claimed.token, granted.token);
  assert.equal(claimed.slot_id, granted.slot_id);

  // Reverse: the REFERENCE grants the PORT's queued request once the other slot frees; the port claims it.
  minutes(1);
  port.heartbeatEntry({ entryId: portReq.request_id, owner: delta });
  assert.equal(port.release({ slotId: b.slot_id, owner: beta, token: b.token }).released, true);
  const grantedByRef = refPool.tryGrant({ entryId: portReq.request_id, owner: delta });
  assert.ok(grantedByRef, "the reference granted an entry the port enqueued");
  assert.equal(refNudges.length, 1);
  assert.equal(refNudges[0].event, "e2e-lease-granted");
  const portClaim = port.claim({ requestId: portReq.request_id, owner: delta });
  assert.equal(portClaim.state, "ready");
  assert.equal(portClaim.token, grantedByRef.token);

  // Both queues drained; both slots held with the fencing tokens each grant carries.
  assert.equal(port.poolStatus().queue.length, 0);
  assert.equal(refPool.heartbeat({ slotId: granted.slot_id, owner: gamma, token: granted.token }).ok, true);
  assert.equal(port.heartbeat({ slotId: grantedByRef.slot_id, owner: delta, token: grantedByRef.token }).ok, true);
});

test("pool compat: dead-man's reaping and stale grants agree; failure records are readable by the other side", { skip: skipRef }, (t) => {
  const { refPool, port, alpha, beta, gamma, minutes, refProvisions } = pairedPools(t);
  const first = grantSelf(refPool, alpha, "blocking").grant;
  assert.equal(refProvisions.length, 1);
  minutes(first.ttlMinutes + 1);
  assert.equal(port.poolStatus().slots.find((s) => s.slot_id === first.slot_id).state, "unknown", "port reads the reference's expired lease as unknown");
  assert.equal(port.heartbeat({ slotId: first.slot_id, owner: alpha, token: first.token }).ok, false, "no revival");

  // The port lazily reaps + takes over the reference's dead slot; the dead holder's token is fenced out.
  const second = grantSelf(port, beta).grant;
  assert.ok(second);
  assert.equal(refPool.poolStatus().slots.find((s) => s.slot_id === second.slot_id).holder, beta);
  assert.equal(refPool.release({ slotId: first.slot_id, owner: alpha, token: first.token }).ok, false, "stale token fenced out by the reference too");

  // A stale async grant is refused by BOTH implementations' claim.
  const req = refPool.request({ owner: gamma, session: gamma });
  port.release({ slotId: second.slot_id, owner: beta, token: second.token });
  const granted = refPool.tryGrant({ entryId: req.request_id, owner: gamma });
  minutes(granted.ttlMinutes + 1);
  grantSelf(port, beta);
  assert.equal(port.claim({ requestId: req.request_id, owner: gamma }).state, "lease_lost");
  assert.equal(refPool.claim({ requestId: req.request_id, owner: gamma }).state, "lease_lost");

  // A provision failure written by the port is surfaced verbatim by the reference's claim.
  const { dir, clock } = { dir: mkdtempSync(join(tmpdir(), "pool-test-")), clock: { t: 1_700_000_000_000 } };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failing = createPool({
    pool: { ...JSON.parse(readFileSync(FIXTURE_FILE, "utf8")), bookkeeper: alpha },
    dir,
    now: () => clock.t,
    ownerPattern: refLease.OWNER_PATTERN,
    provision: () => {
      throw new Error("boom: provisioner exploded");
    },
    notifier: () => {},
  });
  const refOnDir = refPoolMod.createE2ePool({ dir, now: () => clock.t, reset: () => {}, notifier: () => {} });
  const { entry } = failing.enqueue({ owner: alpha, session: alpha, mode: "blocking" });
  assert.throws(() => failing.tryGrant({ entryId: entry.id, owner: alpha }), /boom/);
  const seen = refOnDir.claim({ requestId: entry.id, owner: alpha });
  assert.equal(seen.state, "reset_failed");
  assert.match(seen.error, /boom/);
});

test("pool compat: both implementations produce the same on-disk file set for the same operations", { skip: skipRef }, (t) => {
  const a = pairedPools(t);
  const b = pairedPools(t);
  const drive = (pool, owner, other) => {
    const g = grantSelf(pool, owner).grant;
    const r = pool.request({ owner: other, session: other });
    pool.release({ slotId: g.slot_id, owner, token: g.token });
    return r;
  };
  drive(a.refPool, a.alpha, a.beta);
  drive(b.port, b.alpha, b.beta);
  const listing = (dir) =>
    readdirSync(dir, { recursive: true })
      .filter((f) => !/\.tmp-|grants[\\/].+\.json$/.test(f))
      .sort();
  assert.deepEqual(listing(b.dir), listing(a.dir));
});

const refCli = REFERENCE ? join(dirname(REFERENCE), "e2e-lease-cli.mjs") : null;

test("pool compat: the two pool CLIs interoperate on one store (acquire with one, heartbeat/release with the other)", { skip: skipRef || !existsSync(refCli ?? "") }, async (t) => {
  const store = tempStoreDir(t);
  const [alpha, beta] = refOwners();
  const env = { LEASE_OWNER_PATTERN: refLease.OWNER_PATTERN.source, POOL_PROVISION_CMD: "true", E2E_LEASE_RESET_CMD: "true", POOL_POLL_MS: "200", E2E_LEASE_POLL_MS: "200" };
  const run = (cli, args) =>
    new Promise((res) => {
      execFile(process.execPath, [cli, ...args, "--store", store], { env: { ...CLI_ENV, ...env } }, (error, stdout, stderr) => res({ code: error?.code ?? 0, stdout, stderr }));
    });

  // reference CLI grants -> port CLI status / heartbeat / release
  const viaRef = JSON.parse((await run(refCli, ["acquire", "--owner", alpha, "--no-wait"])).stdout);
  assert.equal(viaRef.ok, true);
  const status = JSON.parse((await run(CLI, ["status"])).stdout);
  assert.equal(status.slots.find((s) => s.slot_id === viaRef.slot_id).holder, alpha);
  const hb = await run(CLI, ["heartbeat", "--slot", String(viaRef.slot_id), "--owner", alpha, "--token", viaRef.token]);
  assert.equal(hb.code, 0, hb.stderr);
  const rel = await run(CLI, ["release", "--slot", String(viaRef.slot_id), "--owner", alpha, "--token", viaRef.token]);
  assert.equal(JSON.parse(rel.stdout).released, true);

  // port CLI grants -> reference CLI status / heartbeat / release
  const viaPort = JSON.parse((await run(CLI, ["acquire", "--owner", beta, "--no-wait"])).stdout);
  assert.equal(viaPort.ok, true);
  const refStatus = JSON.parse((await run(refCli, ["status"])).stdout);
  assert.equal(refStatus.slots.find((s) => s.slot_id === viaPort.slot_id).holder, beta);
  const refHb = await run(refCli, ["heartbeat", "--slot", String(viaPort.slot_id), "--owner", beta, "--token", viaPort.token]);
  assert.equal(refHb.code, 0, refHb.stderr);
  const refRel = await run(refCli, ["release", "--slot", String(viaPort.slot_id), "--owner", beta, "--token", viaPort.token]);
  assert.equal(JSON.parse(refRel.stdout).released, true);
  assert.ok(JSON.parse((await run(CLI, ["status"])).stdout).slots.every((s) => s.state === "free"));
});
