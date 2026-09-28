// durable-lease.test.mjs — unit tests for the durable-lease primitive.
// Runner: `node --test core/lib/lease/durable-lease.test.mjs`.
//
// The cross-implementation compatibility tests at the bottom run only when
// LEASE_REFERENCE_IMPL points at another implementation of this primitive (a path to its
// durable-lease.mjs); they skip otherwise:
//   LEASE_REFERENCE_IMPL=/path/to/durable-lease.mjs node --test core/lib/lease/durable-lease.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createLeaseStore,
  defaultStoreDir,
  DEFAULT_OWNER_PATTERN,
  KIND_PATTERN,
  LeaseUsageError,
  resolveOwnerPattern,
} from "./durable-lease.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "lease-cli.mjs");

// The strict fence: the shape of a namespace-fenced deployment (`<prefix>-<slug>` owners only).
// Tests that exercise the fence pass it explicitly; everything else runs on the permissive default.
const STRICT = /^acme-[a-z0-9][a-z0-9-]{0,62}$/;

function tempStoreDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Timing tests use the injectable clock (opts.now) — deterministic, no real
// sleeps, so a busy machine can never flake an expiry edge.
function fakeClockStore(t, opts = {}) {
  const clock = { t: 1_000_000_000_000 };
  const store = createLeaseStore({ dir: tempStoreDir(t), now: () => clock.t, ...opts });
  return { store, clock, minutes: (m) => (clock.t += m * 60_000) };
}

test("acquire → held → release → free round-trip", (t) => {
  const store = createLeaseStore({ dir: tempStoreDir(t) });
  const acquired = store.acquire({ kind: "e2e-slot-1", owner: "acme-build", ttlMinutes: 5 });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.record.owner, "acme-build");
  assert.ok(acquired.record.token);

  const mid = store.status({ kind: "e2e-slot-1" });
  assert.equal(mid.state, "held");
  assert.equal(mid.holder, "acme-build");

  const released = store.release({
    kind: "e2e-slot-1",
    owner: "acme-build",
    token: acquired.record.token,
  });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(store.status({ kind: "e2e-slot-1" }).state, "free");
});

test("second acquire while held is refused (the lease is the mutex)", (t) => {
  const store = createLeaseStore({ dir: tempStoreDir(t) });
  assert.equal(store.acquire({ kind: "k", owner: "acme-merge", ttlMinutes: 5 }).ok, true);
  const second = store.acquire({ kind: "k", owner: "acme-e2e", ttlMinutes: 5 });
  assert.equal(second.ok, false);
  assert.equal(second.code, "held");
  assert.equal(second.holder, "acme-merge");
});

test("heartbeat refreshes the deadline and keeps the lease alive past the original TTL", (t) => {
  const { store, minutes } = fakeClockStore(t);
  const { record } = store.acquire({ kind: "hb", owner: "acme-e2e", ttlMinutes: 1 });
  // Beat every 45s for 3 minutes — well past the original 60s deadline.
  let lastHeartbeat = Date.parse(record.heartbeat);
  for (let i = 0; i < 4; i += 1) {
    minutes(0.75);
    const beat = store.heartbeat({ kind: "hb", owner: "acme-e2e", token: record.token });
    assert.equal(beat.ok, true, `heartbeat ${i} should refresh: ${JSON.stringify(beat)}`);
    assert.ok(Date.parse(beat.record.heartbeat) > lastHeartbeat);
    lastHeartbeat = Date.parse(beat.record.heartbeat);
  }
  assert.equal(store.status({ kind: "hb" }).state, "held");
});

test("TTL expiry → reader sees unknown (never held, never silently free)", (t) => {
  const { store, minutes } = fakeClockStore(t);
  store.acquire({ kind: "dead", owner: "acme-e2e", ttlMinutes: 1 });
  minutes(1.5);
  const s = store.status({ kind: "dead" });
  assert.equal(s.state, "unknown");
  assert.equal(s.record.owner, "acme-e2e"); // the stale record stays visible
  assert.ok(s.expiredForMs > 0);
});

test("heartbeat on an expired lease FAILS — no revival, holder must re-acquire", (t) => {
  const { store, minutes } = fakeClockStore(t);
  const { record } = store.acquire({ kind: "rip", owner: "acme-e2e", ttlMinutes: 1 });
  minutes(1.5);
  const beat = store.heartbeat({ kind: "rip", owner: "acme-e2e", token: record.token });
  assert.equal(beat.ok, false);
  assert.equal(beat.code, "expired");
  // …and the lease is still "unknown" for readers, not resurrected.
  assert.equal(store.status({ kind: "rip" }).state, "unknown");
});

test("acquire over an expired lease succeeds LOUDLY (tookOverExpired + previous + journal)", (t) => {
  const { store, minutes } = fakeClockStore(t);
  const dir = store.dir;
  store.acquire({ kind: "slot", owner: "acme-merge", ttlMinutes: 1, payload: { pr: 1 } });
  minutes(1.5);
  const takeover = store.acquire({ kind: "slot", owner: "acme-e2e", ttlMinutes: 5 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.tookOverExpired, true);
  assert.equal(takeover.previous.owner, "acme-merge");
  const journal = readFileSync(join(dir, "reaped.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].event, "takeover");
  assert.equal(journal[0].previous.owner, "acme-merge");
});

test("reap removes a dead lease, refuses a fresh one", (t) => {
  const { store, minutes } = fakeClockStore(t);
  store.acquire({ kind: "fresh", owner: "acme-e2e", ttlMinutes: 60 });
  const refused = store.reap({ kind: "fresh" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "held");

  store.acquire({ kind: "stale", owner: "acme-e2e", ttlMinutes: 1 });
  minutes(1.5); // "fresh" (60min TTL) stays held; "stale" (1min) expires
  const reaped = store.reap({ kind: "stale" });
  assert.equal(reaped.ok, true);
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.previous.owner, "acme-e2e");
  assert.equal(store.status({ kind: "stale" }).state, "free");
});

test("release requires the fencing token; wrong token / wrong owner refused; force works", (t) => {
  const store = createLeaseStore({ dir: tempStoreDir(t) });
  store.acquire({ kind: "k", owner: "acme-merge", ttlMinutes: 5 });

  const wrongToken = store.release({ kind: "k", owner: "acme-merge", token: "nope" });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.code, "token_mismatch");

  const wrongOwner = store.release({ kind: "k", owner: "acme-e2e", token: "nope" });
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.code, "not_owner");

  const forced = store.release({ kind: "k", force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.released, true);
  assert.equal(store.status({ kind: "k" }).state, "free");

  // Idempotent: releasing a free lease is ok/no-op.
  const again = store.release({ kind: "k", owner: "acme-merge", token: "x" });
  assert.equal(again.ok, true);
  assert.equal(again.released, false);
});

test("namespace fence (strict pattern): foreign owner rejected; bad kind rejected; bad ttl rejected", (t) => {
  const store = createLeaseStore({ dir: tempStoreDir(t), ownerPattern: STRICT });
  assert.throws(
    () => store.acquire({ kind: "k", owner: "other-bot", ttlMinutes: 5 }),
    LeaseUsageError,
  );
  assert.throws(
    () => store.acquire({ kind: "../evil", owner: "acme-e2e", ttlMinutes: 5 }),
    LeaseUsageError,
  );
  assert.throws(
    () => store.acquire({ kind: "k", owner: "acme-e2e", ttlMinutes: 0 }),
    LeaseUsageError,
  );
  assert.throws(
    () => store.acquire({ kind: "k", owner: "acme-e2e", ttlMinutes: 1e12 }),
    LeaseUsageError,
  );
});

test("a hand-written record with an absurd TTL never makes status/list throw", (t) => {
  const dir = tempStoreDir(t);
  const store = createLeaseStore({ dir });
  writeFileSync(
    join(dir, "huge.json"),
    JSON.stringify({ v: 1, kind: "huge", owner: "acme-x", token: "t", heartbeat: new Date().toISOString(), ttlMinutes: 1e300 }),
  );
  const s = store.status({ kind: "huge" });
  assert.equal(s.state, "held"); // fresh heartbeat — held, but expiry math is clamped
  assert.equal(s.expiresAt, null);
  assert.doesNotThrow(() => store.list());
});

test("corrupt record is treated as expired-unknown and can be taken over", (t) => {
  const dir = tempStoreDir(t);
  const store = createLeaseStore({ dir });
  writeFileSync(join(dir, "torn.json"), "{not json");
  assert.equal(store.status({ kind: "torn" }).state, "unknown");
  const takeover = store.acquire({ kind: "torn", owner: "acme-e2e", ttlMinutes: 5 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.tookOverExpired, true);
});

test("a stale guard (crashed holder) is reaped and does not wedge the store", (t) => {
  const dir = tempStoreDir(t);
  const store = createLeaseStore({ dir, guardStaleMs: 50 });
  const guard = join(dir, ".guard-k");
  mkdirSync(guard);
  writeFileSync(join(guard, "holder.json"), JSON.stringify({ id: "dead-holder", pid: 0 }));
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(guard, old, old); // simulate a guard abandoned 2 minutes ago
  const acquired = store.acquire({ kind: "k", owner: "acme-e2e", ttlMinutes: 5 });
  assert.equal(acquired.ok, true);
});

test("a live guard makes callers wait; guardWaitMs timeout throws loudly", (t) => {
  const dir = tempStoreDir(t);
  const store = createLeaseStore({ dir, guardWaitMs: 150, guardStaleMs: 60_000 });
  mkdirSync(join(dir, ".guard-k")); // fresh guard, never released
  assert.throws(
    () => store.acquire({ kind: "k", owner: "acme-e2e", ttlMinutes: 5 }),
    /guard for kind "k" busy/,
  );
});

test("a .json file whose stem is not a lease kind never breaks list/reconcile and is never touched", (t) => {
  const dir = tempStoreDir(t);
  const store = createLeaseStore({ dir });
  writeFileSync(join(dir, "Not A Kind!.json"), "{}");
  store.acquire({ kind: "real", owner: "acme-e2e", ttlMinutes: 5 });

  const listed = store.list();
  assert.deepEqual(
    listed.map((e) => [e.kind, e.state]),
    [["Not A Kind!", "invalid"], ["real", "held"]],
  );
  const result = store.reconcile();
  assert.deepEqual(result.foreign.map((f) => f.kind), ["Not A Kind!"]);
  assert.equal(readFileSync(join(dir, "Not A Kind!.json"), "utf8"), "{}"); // untouched
});

test("reconcile: reaps expired in-fence leases, keeps fresh ones, never touches foreign records", (t) => {
  const { store, minutes } = fakeClockStore(t, { ownerPattern: STRICT });
  const dir = store.dir;
  store.acquire({ kind: "live", owner: "acme-merge", ttlMinutes: 60 });
  store.acquire({ kind: "dead", owner: "acme-e2e", ttlMinutes: 1 });
  // A record outside the fence (e.g. another tool sharing the dir).
  writeFileSync(
    join(dir, "alien.json"),
    JSON.stringify({ v: 1, kind: "alien", owner: "other-bot", token: "t", heartbeat: "2000-01-01T00:00:00Z", ttlMinutes: 1 }),
  );
  minutes(1.5); // "dead" (1min) expires; "live" (60min) stays held

  const result = store.reconcile();
  assert.deepEqual(result.held.map((h) => h.kind), ["live"]);
  assert.deepEqual(result.reaped.map((r) => r.kind), ["dead"]);
  assert.deepEqual(result.foreign.map((f) => f.kind), ["alien"]);
  assert.equal(store.status({ kind: "dead" }).state, "free");
  assert.equal(store.status({ kind: "alien" }).state, "unknown"); // untouched
});

// ---------------------------------------------------------------------------
// THE CRUX: contended acquire across real processes — exactly one winner.
// Races N concurrent `lease-cli.mjs acquire` child processes at the same kind
// and asserts exactly one exits 0. Exercises guard mkdir/rename atomicity and
// the CLI exit-code contract across true process boundaries.
// ---------------------------------------------------------------------------

function runCli(args, { env = {}, cwd, cli = CLI } = {}) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, cwd }, (error, stdout, stderr) => {
      resolvePromise({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

test("contended acquire: N concurrent processes, exactly one winner", async (t) => {
  const dir = tempStoreDir(t);
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runCli([
        "acquire",
        "--kind", "contended",
        "--owner", `acme-racer-${i}`,
        "--ttl", "5",
        "--store", dir,
      ]),
    ),
  );
  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code === 1);
  assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(losers.length, N - 1);
  for (const loser of losers) {
    const parsed = JSON.parse(loser.stdout);
    assert.equal(parsed.code, "held");
  }
  // And the store agrees with the winner.
  const winnerRecord = JSON.parse(winners[0].stdout).record;
  const status = JSON.parse((await runCli(["status", "--kind", "contended", "--store", dir])).stdout);
  assert.equal(status.state, "held");
  assert.equal(status.holder, winnerRecord.owner);
});

test("CLI round-trip: acquire → heartbeat → release with the printed token", async (t) => {
  const dir = tempStoreDir(t);
  const acquired = await runCli([
    "acquire", "--kind", "cli", "--owner", "acme-build", "--ttl", "5",
    "--payload", '{"pr":123}', "--store", dir,
  ]);
  assert.equal(acquired.code, 0, acquired.stderr);
  const { record } = JSON.parse(acquired.stdout);
  assert.deepEqual(record.payload, { pr: 123 });

  const beat = await runCli([
    "heartbeat", "--kind", "cli", "--owner", "acme-build", "--token", record.token, "--store", dir,
  ]);
  assert.equal(beat.code, 0, beat.stderr);

  const released = await runCli([
    "release", "--kind", "cli", "--owner", "acme-build", "--token", record.token, "--store", dir,
  ]);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(JSON.parse(released.stdout).released, true);

  const status = await runCli(["status", "--kind", "cli", "--store", dir]);
  assert.equal(JSON.parse(status.stdout).state, "free");
});

test("CLI validation errors exit 2; unknown op exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
  try {
    const badOwner = await runCli(["acquire", "--kind", "k", "--owner", "other-bot", "--ttl", "5", "--store", dir], {
      env: { LEASE_OWNER_PATTERN: STRICT.source },
    });
    assert.equal(badOwner.code, 2);
    assert.match(badOwner.stderr, /invalid owner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const badOp = await runCli(["frobnicate"]);
  assert.equal(badOp.code, 2);
});

// ---------------------------------------------------------------------------
// Owner pattern: permissive by default, strict on request (option / env / CLI flag).
// ---------------------------------------------------------------------------

test("owner pattern: the default accepts any safe token and rejects unsafe ones", (t) => {
  const store = createLeaseStore({ dir: tempStoreDir(t), env: {} });
  for (const [i, owner] of ["ci-main", "worker_1", "user@host", "session:42", "Build.Agent-7", "a", "9lives", "x".repeat(128)].entries()) {
    const res = store.acquire({ kind: `k${i}`, owner, ttlMinutes: 5 });
    assert.equal(res.ok, true, `${JSON.stringify(owner)} should be accepted`);
  }
  for (const owner of ["", " lead", "-lead", ".hidden", "a/b", "../x", "two words", "semi;colon", "x".repeat(129), "line\nbreak", undefined, 42]) {
    assert.throws(
      () => store.acquire({ kind: "bad", owner, ttlMinutes: 5 }),
      LeaseUsageError,
      `${JSON.stringify(owner)} should be rejected`,
    );
  }
  assert.equal(store.ownerPattern.source, DEFAULT_OWNER_PATTERN.source);
});

test("owner pattern: a custom strict pattern (option) fences the store and reconcile leaves foreign records alone", (t) => {
  const dir = tempStoreDir(t);
  const strict = createLeaseStore({ dir, ownerPattern: STRICT });
  assert.equal(strict.acquire({ kind: "k", owner: "acme-build", ttlMinutes: 5 }).ok, true);
  assert.throws(() => strict.acquire({ kind: "k2", owner: "ci-main", ttlMinutes: 5 }), /owner pattern/);
  // A permissive writer shares the dir; the strict store reports its record as foreign.
  const loose = createLeaseStore({ dir, env: {} });
  assert.equal(loose.acquire({ kind: "shared", owner: "ci-main", ttlMinutes: 5 }).ok, true);
  assert.deepEqual(strict.reconcile().foreign.map((f) => f.kind), ["shared"]);
  assert.deepEqual(strict.reconcile().held.map((h) => h.kind), ["k"]);
});

test("owner pattern: LEASE_OWNER_PATTERN env applies when no option is given; the option wins over env", (t) => {
  const dir = tempStoreDir(t);
  const fromEnv = createLeaseStore({ dir, env: { LEASE_OWNER_PATTERN: STRICT.source } });
  assert.equal(fromEnv.ownerPattern.source, STRICT.source);
  assert.throws(() => fromEnv.acquire({ kind: "k", owner: "ci-main", ttlMinutes: 5 }), LeaseUsageError);
  assert.equal(fromEnv.acquire({ kind: "k", owner: "acme-main", ttlMinutes: 5 }).ok, true);

  const optionWins = createLeaseStore({ dir, env: { LEASE_OWNER_PATTERN: STRICT.source }, ownerPattern: "^ci-[a-z]+$" });
  assert.equal(optionWins.acquire({ kind: "other", owner: "ci-main", ttlMinutes: 5 }).ok, true);
  assert.throws(() => optionWins.acquire({ kind: "other2", owner: "acme-main", ttlMinutes: 5 }), LeaseUsageError);
});

test("owner pattern: unanchored or invalid patterns are refused at construction, flags g/y are neutralized", (t) => {
  const dir = tempStoreDir(t);
  assert.throws(() => createLeaseStore({ dir, ownerPattern: "acme-" }), /anchored/);
  assert.throws(() => createLeaseStore({ dir, ownerPattern: "^acme-" }), /anchored/);
  assert.throws(() => createLeaseStore({ dir, ownerPattern: "^acme-[$" }), LeaseUsageError);
  assert.throws(() => resolveOwnerPattern("^a\\$"), /anchored/); // an escaped $ is not an anchor
  // A global regexp carries lastIndex state; the store must not inherit it.
  const store = createLeaseStore({ dir, ownerPattern: /^acme-[a-z]+$/g });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(store.acquire({ kind: `g${i}`, owner: "acme-abc", ttlMinutes: 5 }).ok, true);
  }
  assert.equal(resolveOwnerPattern(undefined), DEFAULT_OWNER_PATTERN);
  assert.equal(resolveOwnerPattern(""), DEFAULT_OWNER_PATTERN);
});

test("owner pattern: CLI honors LEASE_OWNER_PATTERN and --owner-pattern (flag beats env)", async (t) => {
  const dir = tempStoreDir(t);
  const permissive = await runCli(["acquire", "--kind", "a", "--owner", "ci-main", "--ttl", "5", "--store", dir], {
    env: { LEASE_OWNER_PATTERN: "" },
  });
  assert.equal(permissive.code, 0, permissive.stderr);
  const viaEnv = await runCli(["acquire", "--kind", "b", "--owner", "ci-main", "--ttl", "5", "--store", dir], {
    env: { LEASE_OWNER_PATTERN: STRICT.source },
  });
  assert.equal(viaEnv.code, 2);
  const viaFlag = await runCli(
    ["acquire", "--kind", "c", "--owner", "acme-main", "--ttl", "5", "--store", dir, "--owner-pattern", STRICT.source],
    { env: { LEASE_OWNER_PATTERN: "^ci-[a-z]+$" } },
  );
  assert.equal(viaFlag.code, 0, viaFlag.stderr);
  const badPattern = await runCli(["status", "--kind", "a", "--store", dir, "--owner-pattern", "acme"]);
  assert.equal(badPattern.code, 2);
});

// ---------------------------------------------------------------------------
// Store location: --store / store option > LEASE_STORE > logs/leases under the git toplevel of
// the cwd (the cwd itself when not in a git work tree).
// ---------------------------------------------------------------------------

/** Run `fn` with git kept from discovering any repo above `ceiling` (a non-git temp dir is then really non-git). */
function withGitCeiling(ceiling, fn) {
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(ceiling);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prev;
  }
}

const HERMETIC_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test("store: outside git it defaults to logs/leases under the cwd; LEASE_STORE overrides; the option beats env", async (t) => {
  const cwd = tempStoreDir(t);
  withGitCeiling(cwd, () => assert.equal(defaultStoreDir(cwd), join(cwd, "logs", "leases")));

  const noGit = { LEASE_STORE: "", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const viaDefault = await runCli(["acquire", "--kind", "k", "--owner", "ci-main", "--ttl", "5"], { cwd, env: noGit });
  assert.equal(viaDefault.code, 0, viaDefault.stderr);
  assert.ok(existsSync(join(cwd, "logs", "leases", "k.json")), "outside git the default store is <cwd>/logs/leases");

  const envDir = join(cwd, "from-env");
  const viaEnv = await runCli(["acquire", "--kind", "k", "--owner", "ci-main", "--ttl", "5"], { cwd, env: { LEASE_STORE: envDir } });
  assert.equal(viaEnv.code, 0, viaEnv.stderr);
  assert.ok(existsSync(join(envDir, "k.json")));

  const optDir = join(cwd, "from-flag");
  const viaFlag = await runCli(["acquire", "--kind", "k", "--owner", "ci-main", "--ttl", "5", "--store", optDir], { cwd, env: { LEASE_STORE: envDir } });
  assert.equal(viaFlag.code, 0, viaFlag.stderr);
  assert.ok(existsSync(join(optDir, "k.json")));

  assert.equal(createLeaseStore({ dir: optDir, env: { LEASE_STORE: envDir } }).dir, optDir);
  assert.equal(createLeaseStore({ store: optDir, env: { LEASE_STORE: envDir } }).dir, optDir);
  assert.equal(createLeaseStore({ env: { LEASE_STORE: envDir } }).dir, envDir);
});

test("store: a linked worktree shares the main checkout's store", async (t) => {
  const repo = realpathSync(tempStoreDir(t));
  const g = (args, cwd) => execFileSync("git", args, { cwd, env: { ...process.env, ...HERMETIC_GIT, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  g(["init", "-q", repo]);
  g(["commit", "-q", "--allow-empty", "-m", "seed"], repo);
  const wt = join(dirname(repo), `${basename(repo)}-wt`);
  g(["worktree", "add", "-q", "--detach", wt], repo);
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const main = join(repo, "logs", "leases");
  assert.equal(defaultStoreDir(wt), main, "a worktree resolves to the main checkout's store");
  assert.equal(defaultStoreDir(join(wt)), defaultStoreDir(repo));
});

test("store: inside a git repo the default is logs/leases under the toplevel, from any subdirectory", async (t) => {
  const repo = realpathSync(tempStoreDir(t));
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env, ...HERMETIC_GIT } });
  const deep = join(repo, "packages", "app", "src");
  mkdirSync(deep, { recursive: true });
  const top = join(repo, "logs", "leases");

  assert.equal(defaultStoreDir(repo), top);
  assert.equal(defaultStoreDir(deep), top, "a subdirectory resolves to the same store as the toplevel");

  // A hook started at the toplevel and an agent started deep inside must see each other's leases.
  const env = { LEASE_STORE: "", ...HERMETIC_GIT };
  const hook = await runCli(["acquire", "--kind", "shared", "--owner", "ci-main", "--ttl", "5"], { cwd: repo, env });
  assert.equal(hook.code, 0, hook.stderr);
  assert.ok(existsSync(join(top, "shared.json")), "the toplevel store holds the lease");
  const agent = await runCli(["status", "--kind", "shared"], { cwd: deep, env });
  assert.equal(JSON.parse(agent.stdout).state, "held", "the subdirectory process reads the same store");
  assert.ok(!existsSync(join(deep, "logs")), "no store is created beside the subdirectory");
  assert.equal(createLeaseStore({ env: {} }).dir, defaultStoreDir(process.cwd()), "createLeaseStore uses the same default");

  // LEASE_STORE and --store still win over the git default.
  const pinned = join(repo, "elsewhere");
  const viaEnv = await runCli(["acquire", "--kind", "k", "--owner", "ci-main", "--ttl", "5"], { cwd: deep, env: { ...env, LEASE_STORE: pinned } });
  assert.equal(viaEnv.code, 0, viaEnv.stderr);
  assert.ok(existsSync(join(pinned, "k.json")));
});

test("on-disk format: record fields, file layout and journal shape are the documented stable format", (t) => {
  const { store, minutes } = fakeClockStore(t);
  const dir = store.dir;
  const { record } = store.acquire({ kind: "fmt", owner: "acme-build", ttlMinutes: 7, payload: { n: 1 } });
  assert.deepEqual(Object.keys(record), ["v", "kind", "owner", "token", "heartbeat", "ttlMinutes", "payload", "acquiredAt"]);
  assert.equal(record.v, 1);
  assert.match(record.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(readFileSync(join(dir, "fmt.json"), "utf8"), `${JSON.stringify(record, null, 2)}\n`);
  assert.ok(KIND_PATTERN.test("fmt"));
  minutes(10);
  store.acquire({ kind: "fmt", owner: "acme-e2e", ttlMinutes: 7 });
  const [entry] = readFileSync(join(dir, "reaped.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(Object.keys(entry), ["at", "event", "kind", "by", "previous"]);
  assert.equal(entry.event, "takeover");
});

// ---------------------------------------------------------------------------
// Cross-implementation compatibility (LEASE_REFERENCE_IMPL).
//
// The on-disk store layout, record format and fencing semantics are a stable format shared with
// other implementations of this primitive on the same host. When LEASE_REFERENCE_IMPL names
// another implementation's durable-lease.mjs, prove a store written by one is read, renewed,
// released, expired and reaped correctly by the other, in both directions. The reference's own
// owner fence is taken from its exported OWNER_PATTERN and handed to this port as `ownerPattern`,
// which also proves a product-specific fence is expressible through the option.
// ---------------------------------------------------------------------------

const REFERENCE = process.env.LEASE_REFERENCE_IMPL ? resolve(process.env.LEASE_REFERENCE_IMPL) : null;
const ref = REFERENCE ? await import(pathToFileURL(REFERENCE).href) : null;
const skipRef = REFERENCE ? false : "LEASE_REFERENCE_IMPL not set";
const refCli = REFERENCE ? join(dirname(REFERENCE), "lease-cli.mjs") : null;

/** Build owners that satisfy the reference's fence without hardcoding its namespace: reuse the literal prefix of its pattern. */
function refOwners() {
  const pattern = ref.OWNER_PATTERN;
  const prefix = /^\^([A-Za-z0-9._-]*)/.exec(pattern.source)?.[1] ?? "";
  const owners = ["alpha", "beta", "gamma", "delta"].map((n) => `${prefix}${n}`);
  for (const o of owners) assert.ok(pattern.test(o), `derived owner ${o} must satisfy the reference fence ${pattern}`);
  return owners;
}

/** Two stores on one directory sharing one fake clock: the reference implementation and this port. */
function pairedStores(t) {
  const clock = { t: 1_000_000_000_000 };
  const dir = tempStoreDir(t);
  const now = () => clock.t;
  const refStore = ref.createLeaseStore({ dir, now });
  const port = createLeaseStore({ dir, now, ownerPattern: ref.OWNER_PATTERN });
  const [alpha, beta, gamma] = refOwners();
  return { dir, clock, refStore, port, alpha, beta, gamma, minutes: (m) => (clock.t += m * 60_000) };
}

test("compat: reference acquires -> port reads, heartbeats, releases (fencing token honored)", { skip: skipRef }, (t) => {
  const { refStore, port, alpha, beta, minutes } = pairedStores(t);
  const acquired = refStore.acquire({ kind: "shared", owner: alpha, ttlMinutes: 5, payload: { n: 1 } });
  assert.equal(acquired.ok, true);

  const seen = port.status({ kind: "shared" });
  assert.equal(seen.state, "held");
  assert.equal(seen.holder, alpha);
  assert.deepEqual(seen.record, acquired.record, "record read byte-for-byte equal");
  assert.equal(seen.expiresAt, refStore.status({ kind: "shared" }).expiresAt, "expiry agrees");
  assert.deepEqual(port.list(), refStore.list());

  // Fencing: wrong token / wrong owner refused by the port, right token accepted.
  assert.equal(port.heartbeat({ kind: "shared", owner: alpha, token: "nope" }).code, "not_owner");
  assert.equal(port.release({ kind: "shared", owner: alpha, token: "nope" }).code, "token_mismatch");
  assert.equal(port.release({ kind: "shared", owner: beta, token: acquired.record.token }).code, "not_owner");
  minutes(1);
  const beat = port.heartbeat({ kind: "shared", owner: alpha, token: acquired.record.token });
  assert.equal(beat.ok, true);
  assert.equal(refStore.status({ kind: "shared" }).record.heartbeat, beat.record.heartbeat, "reference sees the port's heartbeat");
  assert.equal(port.acquire({ kind: "shared", owner: beta, ttlMinutes: 5 }).code, "held", "the port honors the reference's lease as the mutex");

  const released = port.release({ kind: "shared", owner: alpha, token: acquired.record.token });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(refStore.status({ kind: "shared" }).state, "free");
});

test("compat: port acquires -> reference reads, heartbeats, releases (the reverse direction)", { skip: skipRef }, (t) => {
  const { refStore, port, alpha, beta, minutes } = pairedStores(t);
  const acquired = port.acquire({ kind: "shared", owner: alpha, ttlMinutes: 5, payload: { n: 2 } });
  assert.equal(acquired.ok, true);

  const seen = refStore.status({ kind: "shared" });
  assert.equal(seen.state, "held");
  assert.deepEqual(seen.record, acquired.record);
  assert.equal(refStore.heartbeat({ kind: "shared", owner: alpha, token: "nope" }).code, "not_owner");
  assert.equal(refStore.release({ kind: "shared", owner: alpha, token: "nope" }).code, "token_mismatch");
  assert.equal(refStore.acquire({ kind: "shared", owner: beta, ttlMinutes: 5 }).code, "held");
  minutes(1);
  assert.equal(refStore.heartbeat({ kind: "shared", owner: alpha, token: acquired.record.token }).ok, true);
  assert.equal(port.status({ kind: "shared" }).record.heartbeat, refStore.status({ kind: "shared" }).record.heartbeat);
  assert.equal(refStore.release({ kind: "shared", owner: alpha, token: acquired.record.token }).released, true);
  assert.equal(port.status({ kind: "shared" }).state, "free");
});

test("compat: both implementations write byte-identical records and journal entries (modulo the random token)", { skip: skipRef }, (t) => {
  const { dir, refStore, port, alpha, beta, minutes } = pairedStores(t);
  const params = { ttlMinutes: 9, payload: { pr: 7, tags: ["a", "b"] } };
  refStore.acquire({ kind: "from-ref", owner: alpha, ...params });
  port.acquire({ kind: "from-port", owner: alpha, ...params });
  const normalize = (kind) => readFileSync(join(dir, `${kind}.json`), "utf8").replace(/"token": "[^"]+"/, '"token": "T"');
  assert.equal(normalize("from-ref").replace('"kind": "from-ref"', '"kind": "K"'), normalize("from-port").replace('"kind": "from-port"', '"kind": "K"'));

  // Takeover journals: the same event shape from either side.
  minutes(20);
  refStore.acquire({ kind: "from-port", owner: beta, ttlMinutes: 1 }); // reference takes over the port's expired lease
  port.acquire({ kind: "from-ref", owner: beta, ttlMinutes: 1 }); // port takes over the reference's expired lease
  const journal = readFileSync(join(dir, "reaped.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(journal.length, 2);
  assert.deepEqual(Object.keys(journal[0]), Object.keys(journal[1]));
  assert.deepEqual(journal.map((e) => e.event), ["takeover", "takeover"]);
});

test("compat: expiry, no-revival, loud takeover and reap agree across implementations on a shared clock", { skip: skipRef }, (t) => {
  const { refStore, port, alpha, beta, gamma, minutes } = pairedStores(t);
  const a = refStore.acquire({ kind: "exp-ref", owner: alpha, ttlMinutes: 1 });
  const b = port.acquire({ kind: "exp-port", owner: alpha, ttlMinutes: 1 });
  minutes(1.5);

  // Each side sees the OTHER's expired record as unknown (never held, never free).
  for (const [reader, kind] of [[port, "exp-ref"], [refStore, "exp-port"]]) {
    const s = reader.status({ kind });
    assert.equal(s.state, "unknown");
    assert.ok(s.expiredForMs > 0);
  }
  // No revival, whichever side wrote the lease.
  assert.equal(port.heartbeat({ kind: "exp-ref", owner: alpha, token: a.record.token }).code, "expired");
  assert.equal(refStore.heartbeat({ kind: "exp-port", owner: alpha, token: b.record.token }).code, "expired");

  // Reap: the port reaps the reference's dead lease; the reference reaps the port's.
  const reapedByPort = port.reap({ kind: "exp-ref" });
  const reapedByRef = refStore.reap({ kind: "exp-port" });
  assert.equal(reapedByPort.reaped, true);
  assert.equal(reapedByRef.reaped, true);
  assert.equal(reapedByPort.previous.owner, alpha);
  assert.equal(refStore.status({ kind: "exp-ref" }).state, "free");
  assert.equal(port.status({ kind: "exp-port" }).state, "free");

  // Takeover over an expired record written by the other side is flagged, and fencing follows the NEW token.
  const c = refStore.acquire({ kind: "tko", owner: alpha, ttlMinutes: 1 });
  minutes(2);
  const took = port.acquire({ kind: "tko", owner: beta, ttlMinutes: 5 });
  assert.equal(took.tookOverExpired, true);
  assert.equal(took.previous.owner, alpha);
  assert.equal(refStore.heartbeat({ kind: "tko", owner: alpha, token: c.record.token }).code, "not_owner", "the displaced holder is fenced out");
  assert.equal(refStore.heartbeat({ kind: "tko", owner: beta, token: took.record.token }).ok, true);
  assert.equal(refStore.release({ kind: "tko", owner: beta, token: took.record.token }).released, true);
  void gamma;
});

test("compat: reconcile classifies held / reaped / foreign identically", { skip: skipRef }, (t) => {
  const { dir, refStore, port, alpha, beta, minutes } = pairedStores(t);
  refStore.acquire({ kind: "live", owner: alpha, ttlMinutes: 60 });
  port.acquire({ kind: "dead-a", owner: beta, ttlMinutes: 1 });
  refStore.acquire({ kind: "dead-b", owner: beta, ttlMinutes: 1 });
  writeFileSync(
    join(dir, "alien.json"),
    JSON.stringify({ v: 1, kind: "alien", owner: "outside-the-fence", token: "t", heartbeat: "2000-01-01T00:00:00Z", ttlMinutes: 1 }),
  );
  writeFileSync(join(dir, "Not A Kind!.json"), "{}");
  minutes(2);

  const summarize = (r) => ({
    held: r.held.map((h) => h.kind),
    reaped: r.reaped.map((h) => h.kind),
    foreign: r.foreign.map((f) => f.kind),
  });
  // One implementation sweeps the store; the other must then see the identical steady state.
  const first = summarize(port.reconcile());
  assert.deepEqual(first, { held: ["live"], reaped: ["dead-a", "dead-b"], foreign: ["Not A Kind!", "alien"] });
  const second = summarize(refStore.reconcile());
  assert.deepEqual(second, { held: ["live"], reaped: [], foreign: ["Not A Kind!", "alien"] });
});

test("compat: a crashed guard left by one implementation is reaped by the other", { skip: skipRef }, (t) => {
  const { dir, port } = pairedStores(t);
  const [alpha] = refOwners();
  const guard = join(dir, ".guard-k");
  mkdirSync(guard);
  writeFileSync(join(guard, "holder.json"), JSON.stringify({ id: "dead-holder", pid: 0 }));
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(guard, old, old);
  const stalePort = createLeaseStore({ dir, guardStaleMs: 50, ownerPattern: ref.OWNER_PATTERN });
  assert.equal(stalePort.acquire({ kind: "k", owner: alpha, ttlMinutes: 5 }).ok, true);
  void port;
});

test("compat: the two CLIs contend for one lease across real processes — exactly one winner", { skip: skipRef || !existsSync(refCli ?? "") }, async (t) => {
  const dir = tempStoreDir(t);
  const owners = refOwners();
  const env = { LEASE_OWNER_PATTERN: ref.OWNER_PATTERN.source };
  const racers = [];
  for (let i = 0; i < 6; i += 1) {
    const cli = i % 2 === 0 ? refCli : CLI;
    racers.push(runCli(["acquire", "--kind", "contended", "--owner", `${owners[0]}-r${i}`, "--ttl", "5", "--store", dir], { env, cli }));
  }
  const results = await Promise.all(racers);
  const winners = results.filter((r) => r.code === 0);
  assert.equal(winners.length, 1, `expected exactly 1 winner across both CLIs, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r.code === 1).length, 5);
  const { record } = JSON.parse(winners[0].stdout);

  // CLI round-trips cross the implementation boundary in both directions.
  const hbPort = await runCli(["heartbeat", "--kind", "contended", "--owner", record.owner, "--token", record.token, "--store", dir], { env });
  assert.equal(hbPort.code, 0, hbPort.stderr);
  const relRef = await runCli(["release", "--kind", "contended", "--owner", record.owner, "--token", record.token, "--store", dir], { env, cli: refCli });
  assert.equal(relRef.code, 0, relRef.stderr);
  assert.equal(JSON.parse(relRef.stdout).released, true);

  const viaRef = await runCli(["acquire", "--kind", "back", "--owner", owners[1], "--ttl", "5", "--store", dir], { env, cli: refCli });
  const tok = JSON.parse(viaRef.stdout).record.token;
  const hbRef = await runCli(["heartbeat", "--kind", "back", "--owner", owners[1], "--token", tok, "--store", dir], { env });
  assert.equal(hbRef.code, 0, hbRef.stderr);
  const relPort = await runCli(["release", "--kind", "back", "--owner", owners[1], "--token", tok, "--store", dir], { env });
  assert.equal(JSON.parse(relPort.stdout).released, true);
  assert.equal(JSON.parse((await runCli(["status", "--kind", "back", "--store", dir], { env, cli: refCli })).stdout).state, "free");
});
