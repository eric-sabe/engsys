// keepalive-lifetime.test.mjs (engsys#87): the baton keepalive lives as long as its claude session,
// not as long as the watch bus that started it; the model's renew retries transient errors; a session
// that let its baton run out is relaunched without waiting for staleness.
//
// Part 1 runs in process against the fake git API (fixtures/fake-github.mjs). Part 2 runs the real
// processes: a stand-in claude process, the real mnt-watch.sh bus and the real detached renewer, with
// GitHub replaced by an HTTP server around the same fake (fixtures/fetch-to-fake.mjs, loaded through
// NODE_OPTIONS, routes api.github.com there and shortens the renewer's waits).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createGithubLease } from "./github-backend.mjs";
import { fakeGitApi, REPO } from "./fixtures/fake-github.mjs";
import {
  EXIT,
  RENEW_RETRY_BACKOFF_MS,
  TTL_MINUTES,
  createBaton,
  createStateStore,
  isClaudeCommand,
  main,
  supervisorDecision,
  transientRenewError,
} from "./baton.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const HOME = { ok: true, mode: "single", isHome: true, reason: "single-fleet mode" };
const OWNER = { pid: 4242, start: "Mon Oct 5 19:00:00 2026" };

function world() {
  const api = fakeGitApi();
  const local = { t: 5_000_000 };
  return { api, local, advance(ms) { local.t += ms; api.state.now += ms; } };
}

function session(w, { holder = "mini:acme-maintain", run = "run-1", dir, role = "maintain", prepare = null } = {}) {
  const stateDir = dir ?? mkdtempSync(join(tmpdir(), "baton-ka-"));
  const lease = createGithubLease({ repo: REPO, api: w.api, sleep: async () => {}, random: () => 0.5, now: () => w.local.t });
  const store = createStateStore({ stateDir, role });
  const logs = [];
  const baton = createBaton({
    lease, repo: REPO, role, holder, run, store,
    home: async () => HOME,
    now: () => w.local.t,
    notify: async () => true,
    mergeApi: { async request() { return { status: 200, json: {}, headers: {} }; } },
    spawn: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    sleep: async (ms) => w.advance(ms),
    prepare,
    log: (l) => logs.push(l),
  });
  return { baton, store, stateDir, logs };
}

const renewWrites = (w) => w.api.state.log.filter((e) => e.method === "PATCH").length;

// ------------------------------------------------------------------------- part 1: in process --

test("supervisorDecision marks an expired baton that still names this session as forfeited", () => {
  const home = { ok: true, isHome: true, mode: "single" };
  const mine = supervisorDecision({ home, ownHolder: "mini:acme-maintain", status: { state: "unknown", expired: true, holder: "mini:acme-maintain", expiresAt: "x" } });
  assert.equal(mine.relaunch, true);
  assert.equal(mine.forfeited, true);
  const theirs = supervisorDecision({ home, ownHolder: "mini:acme-maintain", status: { state: "unknown", expired: true, holder: "bob:acme-maintain", expiresAt: "x" } });
  assert.equal(theirs.relaunch, true);
  assert.equal(theirs.forfeited, undefined, "someone else's expired baton is not this session's forfeit");
  const free = supervisorDecision({ home, ownHolder: "mini:acme-maintain", status: { state: "free", released: true, releasedBy: "mini:acme-maintain" } });
  assert.equal(free.forfeited, undefined, "a release (rotation, session end) is not a forfeit");
});

test("transientRenewError: transport, 5xx, 429 and secondary rate limits retry; 401/404 and losses do not", () => {
  const err = (failure) => ({ ok: false, code: "error", failure });
  assert.equal(transientRenewError(err({ status: null, message: "fetch failed" })), true);
  assert.equal(transientRenewError(err({ status: 0 })), true);
  assert.equal(transientRenewError(err({ status: 502 })), true);
  assert.equal(transientRenewError(err({ status: 429 })), true);
  assert.equal(transientRenewError(err({ status: 403, message: "You have exceeded a secondary rate limit" })), true);
  assert.equal(transientRenewError(err({ status: 403, message: "Resource not accessible by integration" })), false);
  assert.equal(transientRenewError(err({ status: 401 })), false);
  assert.equal(transientRenewError(err({ code: "not_a_baton", message: "non-empty tree" })), false);
  assert.equal(transientRenewError({ ok: false, code: "expired", lost: true }), false);
  assert.equal(transientRenewError({ ok: true }), false);
});

test("the model's renew retries a transient error with backoff and recovers (heartbeat path)", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.advance(MIN);
  // The backend already retries a 5xx 3 times per request; one more failure series makes it an error.
  w.api.fault({ when: (m) => m === "GET", status: 502, times: 3 });
  const t0 = w.local.t;
  const r = await s.baton.renew({ source: "model", retries: RENEW_RETRY_BACKOFF_MS.length });
  assert.equal(r.exit, EXIT.OK, JSON.stringify(r.result));
  assert.equal(r.result.code, "renewed");
  assert.equal(w.local.t - t0, RENEW_RETRY_BACKOFF_MS[0], "one backoff, then the retry renewed");
  assert.match(s.logs.join("\n"), /retrying in 2s/);
});

test("the model's renew gives up after its retries, and never retries a non-transient error", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.advance(MIN);
  w.api.fault({ when: () => true, status: 503, times: 999 });
  const t0 = w.local.t;
  const r = await s.baton.renew({ source: "model", retries: RENEW_RETRY_BACKOFF_MS.length });
  assert.equal(r.exit, EXIT.ERROR);
  assert.equal(w.local.t - t0, RENEW_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0), "two retries, then report");
  w.api.state.faults.length = 0;
  w.api.fault({ when: () => true, status: 401, times: 999 });
  const t1 = w.local.t;
  const r2 = await s.baton.renew({ source: "model", retries: RENEW_RETRY_BACKOFF_MS.length });
  assert.equal(r2.exit, EXIT.ERROR);
  assert.equal(w.local.t, t1, "a 401 is not retried");
});

test("the model's renew never retries past the local deadline", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.advance(TTL_MINUTES * MIN - 3_000); // 1 s of local deadline left: a 2 s wait would cross it
  w.api.fault({ when: () => true, status: 503, times: 999 });
  const t0 = w.local.t;
  await s.baton.renew({ source: "model", retries: RENEW_RETRY_BACKOFF_MS.length });
  assert.equal(w.local.t, t0);
});

test("a renew error during a gap: the keepalive keeps retrying and recovers, even when the token can't be minted", async () => {
  const w = world();
  let mintFails = 2;
  const s = session(w, { prepare: async () => { if (mintFails > 0) { mintFails -= 1; throw new Error("gh-app-token: 502 minting the installation token"); } } });
  mintFails = 0;
  await s.baton.startup();
  mintFails = 2;
  w.api.fault({ when: () => true, status: 502, times: 6 }); // after the mint recovers: two more failed renews
  const lines = [];
  const before = renewWrites(w);
  const code = await s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true, pulseMaxMs: 0, maxCycles: 6 });
  assert.equal(code, EXIT.OK);
  assert.equal(lines.filter((l) => l.startsWith("BATON_RENEW_ERROR")).length, 1, "one line per error streak");
  assert.ok(renewWrites(w) > before, "renewing resumed after the errors");
  assert.ok(s.store.load().deadlineMs > w.local.t, "and the local deadline is ahead again");
});

test("a keepalive that finds another live keepalive recorded for its state dir stops", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  let mine = true;
  const lines = [];
  const p = s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true, pulseMaxMs: 0, stillMine: () => mine, maxCycles: 50 });
  mine = false;
  assert.equal(await p, EXIT.OK);
  assert.equal(renewWrites(w), 1, "it renewed once, then saw the other renewer at the next cycle and stopped");
});

test("ensureKeepalive: starts one detached renewer, records it, and the next bus adopts it", () => {
  const w = world();
  const s = session(w);
  return s.baton.startup().then(() => {
    const spawned = [];
    const alive = new Set();
    const deps = {
      owner: OWNER,
      out: () => {},
      ownerIsClaude: () => true,
      // the child consumes the one-time nonce the starter wrote, and gets its owner from it
      spawnChild: (nonce) => { const pid = 7000 + spawned.length; spawned.push({ pid, owner: s.store.takeKeepaliveNonce(nonce) }); alive.add(pid); return pid; },
      isAlive: ({ pid, start }) => alive.has(pid) && start === `start-${pid}`,
      startOf: (pid) => `start-${pid}`,
      kill: (pid) => alive.delete(pid),
    };
    const a = s.baton.ensureKeepalive(deps);
    assert.equal(a.result.code, "started");
    assert.deepEqual(spawned[0].owner, OWNER, "the renewer is bound to the claude process, via the nonce file");
    assert.deepEqual(s.store.keepalivePid(), { pid: 7000, start: "start-7000", ownerPid: OWNER.pid, ownerStart: OWNER.start, run: "run-1" });
    // A second bus (the Monitor was re-armed): adopt, no second process.
    const b = s.baton.ensureKeepalive(deps);
    assert.equal(b.result.code, "adopted");
    assert.equal(b.result.pid, 7000);
    assert.equal(spawned.length, 1);
    // The renewer died: the next bus starts a new one.
    alive.delete(7000);
    assert.equal(s.baton.ensureKeepalive(deps).result.code, "started");
    assert.equal(spawned.length, 2);
    // A recycled pid (same pid, another start time) is not ours: start a new one, kill nothing.
    alive.clear(); alive.add(7001);
    deps.isAlive = ({ pid, start }) => alive.has(pid) && start === "someone-else";
    assert.equal(s.baton.ensureKeepalive(deps).result.code, "started");
    assert.equal(alive.has(7001), true, "the unrelated process with the recycled pid is never killed");
  });
});

test("ensureKeepalive: a renewer left by another launch is stopped and replaced; none without an owner, a token or a live baton", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const killed = [];
  const alive = new Set([9000]);
  s.store.setKeepalivePid({ pid: 9000, start: "start-9000", ownerPid: 1111, ownerStart: "old", run: "run-0" });
  const deps = {
    owner: OWNER,
    out: () => {},
    ownerIsClaude: () => true,
    spawnChild: () => { alive.add(9100); return 9100; },
    isAlive: ({ pid, start }) => alive.has(pid) && start === `start-${pid}`,
    startOf: (pid) => `start-${pid}`,
    kill: (pid) => { killed.push(pid); alive.delete(pid); },
  };
  assert.equal(s.baton.ensureKeepalive(deps).result.code, "started");
  assert.deepEqual(killed, [9000]);
  assert.equal(s.store.keepalivePid().pid, 9100);

  assert.equal(s.baton.ensureKeepalive({ ...deps, owner: null }).result.code, "no_owner");

  const idle = session(w, { dir: s.stateDir });
  const lines = [];
  w.advance(25 * MIN);
  const r = idle.baton.ensureKeepalive({ ...deps, out: (l) => lines.push(l), spawnChild: () => assert.fail("no renewer for an idle model") });
  assert.equal(r.result.code, "idle");
  idle.baton.ensureKeepalive({ ...deps, out: (l) => lines.push(l) });
  assert.equal(lines.length, 1, "BATON_IDLE once per pulse");
  assert.match(lines[0], /^BATON_IDLE maintain/);

  const none = session(w);
  assert.equal(none.baton.ensureKeepalive(deps).exit, EXIT.NOT_STARTED);
  none.store.markLost({ at: "x", code: "lost" });
  assert.equal(none.baton.ensureKeepalive(deps).exit, EXIT.REFUSED);
});

test("the keepalive pidfile round-trips, a launch id with '|' included", () => {
  const store = createStateStore({ stateDir: mkdtempSync(join(tmpdir(), "baton-pid-")), role: "merge" });
  assert.equal(store.keepalivePid(), null);
  store.setKeepalivePid({ pid: 12, start: "Mon Oct 5 19:13:02 2026", ownerPid: 3, ownerStart: "Mon Oct 5 18:00:00 2026", run: "a|b" });
  assert.deepEqual(store.keepalivePid(), { pid: 12, start: "Mon Oct 5 19:13:02 2026", ownerPid: 3, ownerStart: "Mon Oct 5 18:00:00 2026", run: "a|b" });
  writeFileSync(store.keepaliveFiles.pid, "garbage\n");
  assert.equal(store.keepalivePid(), null);
});

test("L1: isClaudeCommand accepts the claude CLI as ps shows it, and nothing else", () => {
  for (const c of ["claude", "/Users/x/.local/bin/claude", "-claude", "2.1.233", " 2.1.300 "]) assert.equal(isClaudeCommand(c), true, c);
  for (const c of ["node", "bash", "/usr/bin/login", "tmux", "claude-helper", "2.1", "v2.1.233", "", null]) assert.equal(isClaudeCommand(c), false, String(c));
});

test("L1: no detached renewer when the session process is not the claude CLI (the bus runs it attached)", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const r = s.baton.ensureKeepalive({ owner: OWNER, out: () => {}, ownerIsClaude: () => false, spawnChild: () => assert.fail("never started") });
  assert.equal(r.result.code, "no_owner");
  assert.match(r.result.reason, /not the claude CLI/);
  assert.equal(readdirSync(s.stateDir).some((f) => f.includes(".nonce-")), false, "no nonce written");
});

test("L1: the owner travels in a one-time nonce file: consumed once, never forgeable from argv", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const nonce = s.store.writeKeepaliveNonce(OWNER);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(statMode(join(s.stateDir, `baton-maintain.keepalive.nonce-${nonce}`)), 0o600);
  assert.deepEqual(s.store.takeKeepaliveNonce(nonce), OWNER);
  assert.equal(s.store.takeKeepaliveNonce(nonce), null, "a nonce is good once");
  assert.equal(s.store.takeKeepaliveNonce("../../etc/passwd"), null);
  assert.equal(s.store.takeKeepaliveNonce("f".repeat(32)), null, "a nonce nobody wrote");

  // The renewer's own entry point refuses to run without a valid nonce, before any request.
  const errs = [];
  const io = { out: { write: () => {} }, err: { write: (t) => errs.push(t) } };
  const env = { ENGSYS_SESSION: "acme-maintain", ENGSYS_SESSION_RUN: "run-1" };
  const argv = ["keepalive", "--repo", REPO, "--role", "maintain", "--state-dir", s.stateDir, "--session", "acme-maintain", "--detached-child"];
  const before = w.api.state.log.length;
  assert.equal(await main(argv, { ...io, env, hostname: "mini", api: w.api }), EXIT.REFUSED);
  assert.equal(await main(argv, { ...io, env: { ...env, BATON_KEEPALIVE_NONCE: "f".repeat(32) }, hostname: "mini", api: w.api }), EXIT.REFUSED);
  assert.equal(await main([...argv, "--owner-pid", "1", "--owner-start", "x"], { ...io, env, hostname: "mini", api: w.api }), EXIT.REFUSED, "an owner on argv grants nothing");
  assert.equal(w.api.state.log.length, before, "nothing renewed");
  assert.match(errs.join(""), /no valid one-time nonce/);
});

test("L1: a renewer that fails to start leaves no nonce behind", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const r = s.baton.ensureKeepalive({ owner: OWNER, out: () => {}, ownerIsClaude: () => true, spawnChild: () => { throw new Error("EAGAIN"); } });
  assert.equal(r.result.code, "spawn_failed");
  assert.equal(readdirSync(s.stateDir).some((f) => f.includes(".nonce-")), false);
});

function statMode(f) {
  return statSync(f).mode & 0o777;
}

// ---------------------------------------------------------------------- part 2: real processes --

/** The fake git API behind HTTP, on the real clock, so separate processes share one baton. */
async function startFakeGithub() {
  const api = fakeGitApi({ now: Date.now() });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      api.state.now = Date.now();
      try {
        const r = await api.request(req.method, req.url, body ? JSON.parse(body) : undefined);
        res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
        res.end(r.json === null || r.json === undefined ? "" : JSON.stringify(r.json));
      } catch (e) {
        res.writeHead(599); res.end(String(e?.message ?? e)); // a thrown fault: a transport error
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { api, server, url: `http://127.0.0.1:${server.address().port}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** Renewers for this state dir, from the process table (proves "one process, not two"). */
function renewersFor(dir) {
  const ps = spawnSync("ps", ["-e", "-o", "pid=,args="], { encoding: "utf8" }).stdout;
  return ps.split("\n").filter((l) => l.includes(dir) && l.includes(" keepalive ") && l.includes("--detached-child")).map((l) => Number(l.trim().split(/\s+/)[0]));
}

test("real processes: kill the bus → the renewer keeps renewing; a new bus adopts it; kill the claude owner → it stops", { timeout: 90_000 }, async (t) => {
  const gh = await startFakeGithub();
  t.after(() => gh.server.close());
  const T = mkdtempSync(join(tmpdir(), "baton-life-"));
  const dir = join(T, "state");
  mkdirSync(join(T, "bin"), { recursive: true });
  writeFileSync(join(T, "bin", "gh"), "#!/usr/bin/env bash\nexit 0\n"); // the bus's GitHub polls: nothing new
  chmodSync(join(T, "bin", "gh"), 0o755);
  const env = {
    PATH: `${join(T, "bin")}:${process.env.PATH}`,
    HOME: T,
    ENGSYS_SESSION: "acme-maintain",
    ENGSYS_SESSION_RUN: "run-life",
    GH_TOKEN: "test-token",
    FAKE_GITHUB_URL: gh.url,
    BATON_TEST_TIME_SCALE: "1000", // 150 s → 150 ms, 30 s → 30 ms in the renewer only
    NODE_OPTIONS: `--import ${join(HERE, "fixtures", "fetch-to-fake.mjs")}`,
  };
  const baton = join(HERE, "baton.mjs");
  const common = ["--repo", REPO, "--role", "maintain", "--state-dir", dir];
  // Async: the fake GitHub answers from this process's event loop.
  const st = await new Promise((done) => {
    const c = spawn(process.execPath, [baton, "startup", ...common], { env });
    let stdout = ""; let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (status) => done({ status, stdout, stderr }));
  });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.equal(JSON.parse(st.stdout).decision, "acquired");

  // The stand-in claude process: starts a watch bus (in its own process group, the way a Monitor
  // runs one) on SIGUSR1 and stays up until killed.
  // Run under the name `claude`, so `ps` shows the claude CLI (the renewer only binds to that).
  symlinkSync(process.execPath, join(T, "bin", "claude"));
  const owner = spawn(join(T, "bin", "claude"), [join(HERE, "fixtures", "fake-claude.mjs"), join(HERE, "..", "..", "skills", "maintenance-monster", "scripts", "mnt-watch.sh"), dir, REPO, join(T, "bus")], { env, stdio: "ignore" });
  t.after(() => { try { owner.kill("SIGKILL"); } catch { /* gone */ } });
  const busPid = (n) => { try { return Number(readFileSync(join(T, `bus-${n}.pid`), "utf8")); } catch { return null; } };
  await until("bus 1", () => busPid(1));
  const pidfile = join(dir, "baton-maintain.keepalive.pid");
  await until("the detached renewer", () => existsSync(pidfile));
  const keeper = Number(readFileSync(pidfile, "utf8").split("|")[0]);
  assert.notEqual(keeper, busPid(1));
  const writes = () => gh.api.state.log.filter((e) => e.method === "PATCH").length;
  await until("renewals", () => writes() >= 2);

  // Kill the bus and its whole process group (a Monitor expiry).
  process.kill(-busPid(1), "SIGKILL");
  await until("bus 1 gone", () => !alive(busPid(1)));
  // A transient GitHub error inside the gap: the renewer retries and recovers.
  gh.api.fault({ when: (m) => m === "GET", status: 502, times: 9 });
  const afterKill = writes();
  await until("renewals after the bus died", () => writes() >= afterKill + 3);
  assert.equal(alive(keeper), true, "the renewer outlived its bus");

  // Re-arm: a new bus adopts the running renewer and relays what happened while no bus ran.
  owner.kill("SIGUSR1");
  await until("bus 2", () => busPid(2));
  await until("bus 2 relayed the renew error from the gap", () => { try { return readFileSync(join(T, "bus-2.out"), "utf8").includes("BATON_RENEW_ERROR maintain"); } catch { return false; } });
  await sleep(500);
  assert.equal(Number(readFileSync(pidfile, "utf8").split("|")[0]), keeper, "adopted, not replaced");
  assert.deepEqual(renewersFor(dir), [keeper], "one renewer process, not two");

  // The claude session ends: the renewer stops within a cycle and renews nothing more.
  owner.kill("SIGKILL");
  await until("the renewer stops with its owner", () => !alive(keeper));
  const final = writes();
  await sleep(500);
  assert.equal(writes(), final, "nothing renewed after the owner died");
  try { process.kill(-busPid(2), "SIGKILL"); } catch { /* exited on its own (orphaned) */ }
});
