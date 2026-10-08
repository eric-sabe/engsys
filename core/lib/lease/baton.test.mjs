// baton.test.mjs — tests for the monsters' baton (the caller rule over the github lease).
// Runner: `node --test core/lib/lease/baton.test.mjs`. Offline: the lease runs against the in-process
// fake of GitHub's git data API (fixtures/fake-github.mjs); the merge endpoint, notify and spawn are
// recorders. Two clocks move independently: `api.state.now` (the server's Date header) and `local.t`
// (Date.now on this host), so a sleeping laptop and a lagging server can each be simulated.

import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, fstatSync, linkSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";

import { createGithubLease } from "./github-backend.mjs";
import { fakeGitApi, REPO } from "./fixtures/fake-github.mjs";
import {
  EXIT,
  KEEPALIVE_EVERY_MS,
  RENEW_EVERY_MS,
  TAKEOVER_WAIT_MS,
  TTL_MINUTES,
  createBaton,
  createStateStore,
  defaultSpawn,
  guardCommand,
  holderFor,
  readBounded,
  sessionRoot,
  homeCheck,
  hostSlug,
  defaultNotify,
  resolveNotifyCommand,
  main,
  newBranchPrefixesFrom,
  parseConfigList,
  pushConfigArgs,
  sameProcessAlive,
  sessionProcess,
  supervisorDecision,
  unsafeLocalConfig,
  unsafePushConfig,
  localizeIncludes,
  pushEnv,
  PUSH_PATH,
  PUSH_PATH_CANDIDATES,
  NO_TRUSTED_GIT,
  pushGit,
  trustedPushDirs,
} from "./baton.mjs";

const MIN = 60_000;
const SHA = "a".repeat(40);
const noSleep = async () => {};
const HOME = { ok: true, mode: "multi", isHome: true, home: "alice", reason: "merge home for acme/app is fleet alice" };
const AWAY = { ok: true, mode: "multi", isHome: false, home: "bob", reason: "merge home for acme/app is fleet bob" };

/**
 * One session's baton over a shared fake. `world` (api + clocks) can be shared between sessions so
 * two fleets really contend for one ref.
 */
function world() {
  const api = fakeGitApi();
  const local = { t: 5_000_000 };
  return {
    api,
    local,
    advance(ms) { local.t += ms; api.state.now += ms; },
    sleepLocal(ms) { local.t += ms; }, // this host's wall clock only (the server's Date does not move)
  };
}

function session(w, { holder = "alice:acme-mm", run = "run-1", home = HOME, role = "merge", dir, mergeReply, remoteUrl, cwd, sessionDir } = {}) {
  const stateDir = dir ?? mkdtempSync(join(tmpdir(), "baton-"));
  const lease = createGithubLease({ repo: REPO, api: w.api, sleep: noSleep, random: () => 0.5, now: () => w.local.t });
  const notes = [];
  const merges = [];
  const spawned = [];
  let homeInfo = home;
  const mergeApi = {
    async request(method, path, body) {
      merges.push({ method, path, body, at: w.local.t });
      if (mergeReply) return mergeReply(merges.length);
      return { status: 200, json: { merged: true, sha: "b".repeat(40), message: "Pull Request successfully merged" }, headers: {} };
    },
  };
  const store = createStateStore({ stateDir, role });
  const baton = createBaton({
    lease,
    repo: REPO,
    role,
    holder,
    run,
    store,
    home: async () => homeInfo,
    now: () => w.local.t,
    notify: async (n) => { notes.push(n); return true; },
    mergeApi,
    spawn: async (cmd, args, opts) => { spawned.push({ cmd, args, opts, at: w.local.t }); return { code: 0, stdout: "ok\n", stderr: "", timedOut: false }; },
    sleep: async (ms) => w.advance(ms),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(cwd ? { cwd } : {}),
    ...(sessionDir ? { sessionDir } : {}),
  });
  return { baton, store, stateDir, notes, merges, spawned, lease, holder, setHome: (h) => { homeInfo = h; } };
}

const tip = (w, role = "merge") => w.api.state.refs.get(`refs/engsys/batons/${role}`) ?? null;

// ------------------------------------------------------------------------------- startup --

test("startup when home and the baton is free: acquires, persists the token 0600, act: true", async () => {
  const w = world();
  const s = session(w);
  const r = await s.baton.startup();
  assert.equal(r.exit, EXIT.OK);
  assert.equal(r.result.act, true);
  assert.equal(r.result.decision, "acquired");
  assert.equal(r.result.tookOver, undefined);
  const state = JSON.parse(readFileSync(s.store.file, "utf8"));
  assert.equal(state.holder, "alice:acme-mm");
  assert.equal(state.run, "run-1");
  assert.match(state.token, /^[0-9a-f-]{36}$/);
  assert.equal(statSync(s.store.file).mode & 0o777, 0o600);
  assert.ok(state.deadlineMs > w.local.t + 9 * MIN && state.deadlineMs < w.local.t + TTL_MINUTES * MIN, "local deadline = start + expiresInMs - 2 s");
  assert.equal(JSON.stringify(r.result).includes(state.token), false, "the token is never printed");
  assert.equal((await s.baton.fence()).result.held, true);
});

test("startup refuses when another fleet's session holds a live baton: nothing written, one info notice", async () => {
  const w = world();
  const bob = session(w, { holder: "bob:acme-mm", home: { ...HOME, home: "bob" } });
  assert.equal((await bob.baton.startup()).result.act, true);
  const before = tip(w);
  const alice = session(w, { home: HOME });
  const r = await alice.baton.startup();
  assert.equal(r.exit, EXIT.REFUSED);
  assert.equal(r.result.act, false);
  assert.equal(r.result.decision, "held_elsewhere");
  assert.equal(r.result.tipHolder, "bob:acme-mm");
  assert.equal(tip(w), before, "the ref did not move");
  assert.equal(alice.notes.length, 1);
  assert.equal(alice.notes[0].level, "info");
  await alice.baton.startup(); // the standby tick asks again
  assert.equal(alice.notes.length, 1, "no repeat notice for the same holder");
  assert.equal((await alice.baton.fence()).exit, EXIT.NOT_STARTED, "a refused startup never fences as held");
});

test("not home: never acquires, even a free baton; one info notice", async () => {
  const w = world();
  const s = session(w, { home: AWAY });
  const r = await s.baton.startup();
  assert.equal(r.result.decision, "not_home");
  assert.equal(r.result.act, false);
  assert.equal(r.result.home, "bob");
  assert.equal(tip(w), null, "no ref was created");
  assert.equal(w.api.state.log.length, 0, "not even a read");
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].level, "info");
});

test("an unreadable registry fails closed: no acquire, exit 3, one alert", async () => {
  const w = world();
  const s = session(w, { home: { ok: false, mode: "multi", reason: "federation.yml line 3: bad indent" } });
  const r = await s.baton.startup();
  assert.equal(r.exit, EXIT.ERROR);
  assert.equal(r.result.decision, "registry_error");
  assert.equal(tip(w), null);
  assert.equal(s.notes[0].level, "alert");
  await s.baton.startup();
  assert.equal(s.notes.length, 1);
});

test("a lease read error at startup is never held: exit 3, act false", async () => {
  const w = world();
  const s = session(w);
  w.api.fault({ when: (m) => m === "GET", status: 500, times: 99 });
  const r = await s.baton.startup();
  assert.equal(r.exit, EXIT.ERROR);
  assert.equal(r.result.act, false);
});

test("heldBySelf (an earlier launch of this session still holds) is a wait, never held; the old token is archived unread", async () => {
  const w = world();
  const old = session(w, { run: "run-1" });
  await old.baton.startup();
  const fresh = session(w, { run: "run-2", dir: old.stateDir });
  const r = await fresh.baton.startup();
  assert.equal(r.result.decision, "wait_self");
  assert.equal(r.result.act, false);
  assert.deepEqual(r.result.archived, ["baton-merge.json"]);
  assert.equal((await fresh.baton.fence()).exit, EXIT.NOT_STARTED);
  assert.equal((await fresh.baton.renew()).exit, EXIT.NOT_STARTED, "the new launch has no token to renew with");
  // After the TTL the new launch takes over its predecessor's baton loudly.
  w.advance(TTL_MINUTES * MIN + 1000);
  const again = await fresh.baton.startup();
  assert.equal(again.result.decision, "acquired");
  assert.equal(again.result.tookOver, "expired");
});

test("startup re-run in the SAME launch (after a /clear) resumes with a renew instead of discarding the token", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const token = s.store.load().token;
  const r = await s.baton.startup();
  assert.equal(r.result.decision, "resumed");
  assert.equal(r.result.act, true);
  assert.equal(s.store.load().token, token);
});

test("a token is refused across holders and across launches", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const other = session(w, { holder: "alice:acme-maintain", dir: s.stateDir });
  assert.equal((await other.baton.fence()).result.code, "not_started");
  const later = session(w, { run: "run-9", dir: s.stateDir });
  assert.equal((await later.baton.fence()).result.code, "not_started");
  assert.equal((await later.baton.renew()).result.code, "not_started");
});

// --------------------------------------------------------------------------------- renew --

test("renew cadence: keepalive renews every 2.5 min (under TTL/3), each renew moves the expiry", async () => {
  assert.ok(KEEPALIVE_EVERY_MS < RENEW_EVERY_MS && RENEW_EVERY_MS <= (TTL_MINUTES * MIN) / 3);
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const lines = [];
  const renewsBefore = w.api.state.log.filter((e) => e.method === "PATCH").length;
  await s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true, maxCycles: 6, pulseMaxMs: 0 });
  const patches = w.api.state.log.filter((e) => e.method === "PATCH").length - renewsBefore;
  assert.equal(patches, 6, "one renew per cycle");
  assert.deepEqual(lines, []);
  // 6 cycles × 150 s = 15 min: far past the first TTL, still held because every renew landed in time.
  assert.equal((await s.baton.fence()).result.held, true);
});

test("renew --if-due skips a renew that is not due, without a request", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const n = w.api.state.log.length;
  const r = await s.baton.renew({ ifDueMs: 150_000 });
  assert.equal(r.result.code, "not_due");
  assert.equal(w.api.state.log.length, n);
  w.advance(151_000);
  assert.equal((await s.baton.renew({ ifDueMs: 150_000 })).result.code, "renewed");
});

test("renew error keeps the token but never extends the local deadline", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const deadline = s.store.load().deadlineMs;
  w.advance(MIN);
  w.api.fault({ when: () => true, status: 500, times: 99 });
  const r = await s.baton.renew();
  assert.equal(r.exit, EXIT.ERROR);
  assert.equal(r.result.lost, undefined);
  assert.equal(s.store.load().deadlineMs, deadline);
});

test("lost on renew: sticky marker, exactly one alert across every renewer, no further requests", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.advance(TTL_MINUTES * MIN + 1000); // the session slept through its TTL
  const bob = session(w, { holder: "bob:acme-mm" });
  assert.equal((await bob.baton.startup()).result.tookOver, "expired");
  const twin = session(w, { dir: s.stateDir }); // the watch bus's keepalive, same session, same files
  const lines = [];
  const k = await twin.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true, pulseMaxMs: 0 });
  assert.equal(k, EXIT.REFUSED);
  assert.match(lines[0], /^BATON_LOST merge (lost|expired)$/);
  const r = await s.baton.renew();
  assert.equal(r.result.code, "lost_earlier");
  const alerts = [...s.notes, ...twin.notes].filter((n) => n.level === "alert");
  assert.equal(alerts.length, 1, "one alert, whoever saw it first");
  assert.equal(alerts[0].incident, "baton-lost-merge");
  const n = w.api.state.log.length;
  assert.equal((await s.baton.fence()).result.code, "lost_earlier");
  assert.equal((await s.baton.merge({ pr: 7, sha: SHA, method: "squash" })).result.sent, false);
  assert.equal(w.api.state.log.length, n, "a lost session never touches the network again");
  assert.equal(s.merges.length, 0);
});

test("a renew that races this session's own release is not a loss (no alert)", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const keep = session(w, { dir: s.stateDir });
  await s.baton.release({ reason: "rotation" });
  const r = await keep.baton.renew({ source: "keepalive" });
  assert.notEqual(r.result.lost, true);
  assert.equal(keep.notes.length + s.notes.length, 0);
});

// ------------------------------------------------------------------------------ fence --

test("fence blocks a merge after the lease is stolen (operator break-glass + another holder)", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const thief = session(w, { holder: "bob:acme-mm" });
  const st = await thief.lease.status({ role: "merge" });
  await thief.lease.breakGlass({ role: "merge", reason: "test", expectSha: st.sha });
  await thief.baton.startup();
  const r = await s.baton.merge({ pr: 12, sha: SHA, method: "squash" });
  assert.equal(r.exit, EXIT.REFUSED);
  assert.equal(r.result.lost, true);
  assert.equal(r.result.sent, false);
  assert.equal(s.merges.length, 0, "no merge request was sent");
  assert.equal(s.notes.filter((n) => n.incident === "baton-lost-merge").length, 1);
});

test("fence blocks once the local deadline passes with no renew (a sleeping host), without asking the server", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  // The host sleeps 10 min; the server's clock lags (here: does not move), so the server alone would
  // still call the lease held. The local Date.now() deadline refuses anyway.
  w.sleepLocal(TTL_MINUTES * MIN);
  const n = w.api.state.log.length;
  const r = await s.baton.merge({ pr: 12, sha: SHA, method: "merge" });
  assert.equal(r.result.code, "local_deadline");
  assert.equal(r.result.sent, false);
  assert.equal(w.api.state.log.length, n);
  assert.equal(s.merges.length, 0);
});

test("fence needs 60 s of lease left: under that it refuses (renew first)", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const st = s.store.load();
  s.store.save({ ...st, deadlineMs: w.local.t + 20 * MIN }); // isolate the server-side check
  w.advance(TTL_MINUTES * MIN - 40_000);
  const r = await s.baton.fence();
  assert.equal(r.result.held, false);
  assert.equal(r.result.code, "low_remaining");
  assert.equal(r.result.lost, undefined, "not lost: a renew can still save it");
  assert.equal((await s.baton.renew()).result.code, "renewed");
  assert.equal((await s.baton.fence()).result.held, true);
});

test("an assertHeld error is never held", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.api.fault({ when: (m) => m === "GET", status: 502, times: 99 });
  const r = await s.baton.fence();
  assert.equal(r.exit, EXIT.ERROR);
  assert.equal(r.result.held, false);
  assert.equal(r.result.lost, undefined);
});

test("send window: nothing is sent when 30 s or more passed since the fence started", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const assertHeld = s.lease.assertHeld;
  s.lease.assertHeld = async (opts) => { const r = await assertHeld(opts); w.sleepLocal(30_000); return r; };
  const r = await s.baton.merge({ pr: 12, sha: SHA, method: "squash" });
  assert.equal(r.result.code, "send_window");
  assert.equal(s.merges.length, 0);
  const g = await s.baton.guard(["gh", "pr", "ready", "12"]);
  assert.equal(g.result.code, "send_window");
  assert.equal(s.spawned.length, 0);
});

// ------------------------------------------------------------------------------ merge --

test("merge: PUT /pulls/{n}/merge with sha=<validated head> and the method, once", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const r = await s.baton.merge({ pr: "12", sha: SHA, method: "squash" });
  assert.equal(r.exit, EXIT.OK);
  assert.equal(r.result.merged, true);
  assert.deepEqual(s.merges.map(({ method, path, body }) => ({ method, path, body })), [
    { method: "PUT", path: `/repos/${REPO}/pulls/12/merge`, body: { sha: SHA, merge_method: "squash" } },
  ]);
});

test("merge: a moved head (409) is refused; a lost answer is unknown and never resent", async () => {
  const w = world();
  const moved = session(w, { mergeReply: () => ({ status: 409, json: { message: "Head branch was modified" }, headers: {} }) });
  await moved.baton.startup();
  const r = await moved.baton.merge({ pr: 12, sha: SHA, method: "merge" });
  assert.equal(r.result.code, "head_moved");
  assert.equal(r.exit, EXIT.REFUSED);

  const w2 = world();
  const lostAnswer = session(w2, { mergeReply: () => { throw new Error("The operation was aborted due to timeout"); } });
  await lostAnswer.baton.startup();
  const u = await lostAnswer.baton.merge({ pr: 12, sha: SHA, method: "merge" });
  assert.equal(u.result.code, "unknown");
  assert.equal(u.exit, EXIT.ERROR);
  assert.equal(lostAnswer.merges.length, 1);
});

test("merge resolves its API token before the fence, so nothing slow sits between fence and send", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const order = [];
  const assertHeld = s.lease.assertHeld;
  s.lease.assertHeld = async (o) => { order.push("fence"); return assertHeld(o); };
  const api = { prepare: async () => { order.push("token"); w.sleepLocal(25_000); }, request: async () => { order.push("send"); return { status: 200, json: { merged: true }, headers: {} }; } };
  const b = createBaton({ lease: s.lease, repo: REPO, role: "merge", holder: s.holder, run: "run-1", store: s.store, home: async () => HOME, now: () => w.local.t, mergeApi: api });
  const r = await b.merge({ pr: 1, sha: SHA, method: "merge" });
  assert.equal(r.result.merged, true);
  assert.deepEqual(order, ["token", "fence", "send"]);
});

test("merge validates its inputs: a PR number, a 40-hex sha, a known method", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  await assert.rejects(() => s.baton.merge({ pr: "12; rm", sha: SHA, method: "merge" }), /--pr/);
  await assert.rejects(() => s.baton.merge({ pr: 12, sha: "HEAD", method: "merge" }), /--sha/);
  await assert.rejects(() => s.baton.merge({ pr: 12, sha: SHA, method: "octopus" }), /--method/);
});

// --------------------------------------------------------------------------- takeover --

test("after taking over an expired baton: no mutating act for 60 s", async () => {
  const w = world();
  const dead = session(w);
  await dead.baton.startup();
  w.advance(TTL_MINUTES * MIN + 1000);
  const s = session(w, { holder: "alice:acme-mm", run: "run-2" });
  const r = await s.baton.startup();
  assert.equal(r.result.tookOver, "expired");
  assert.ok(r.result.notBefore);
  assert.equal((await s.baton.merge({ pr: 3, sha: SHA, method: "merge" })).result.code, "takeover_wait");
  w.advance(TAKEOVER_WAIT_MS - 1000);
  assert.equal((await s.baton.guard(["gh", "pr", "ready", "3"])).result.code, "takeover_wait");
  w.advance(2000);
  assert.equal((await s.baton.merge({ pr: 3, sha: SHA, method: "merge" })).result.merged, true);
  assert.equal(s.merges.length, 1);
});

test("after taking over a malformed baton: the same 60 s wait", async () => {
  const w = world();
  const sha = "c".repeat(40);
  w.api.state.commits.set(sha, { message: "garbage", parents: [], tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  w.api.state.setRef("refs/engsys/batons/merge", sha);
  const s = session(w);
  const r = await s.baton.startup();
  assert.equal(r.result.tookOver, "malformed");
  assert.equal((await s.baton.fence()).result.code, "takeover_wait");
});

// ---------------------------------------------------------------------------- release --

test("release on rotation: the ref reads free, the token is cleared, nothing fences afterwards", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const r = await s.baton.release({ reason: "rotation" });
  assert.equal(r.result.released, true);
  assert.equal(s.store.load().token, null);
  assert.equal(s.store.load().releaseReason, "rotation");
  assert.equal((await s.lease.status({ role: "merge" })).state, "free");
  assert.equal((await s.baton.fence()).exit, EXIT.NOT_STARTED);
  assert.equal((await s.baton.release({ reason: "exit" })).result.released, false, "idempotent");
  assert.equal(s.notes.length, 0);
});

test("release of an overrun baton (wasExpired) is an incident", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.advance(TTL_MINUTES * MIN + 1000);
  const r = await s.baton.release({ reason: "exit" });
  assert.equal(r.result.wasExpired, true);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].level, "alert");
  assert.equal(s.notes[0].incident, "baton-overrun-merge");
});

// --------------------------------------------------------------------------- handover --

test("handover: home moves away → renew flags it, keepalive announces it once, release, the new home acquires with no wait", async () => {
  const w = world();
  const alice = session(w);
  await alice.baton.startup();
  alice.setHome(AWAY);
  const r = await alice.baton.renew();
  assert.equal(r.result.handover.home, "bob");
  const lines = [];
  await alice.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true, maxCycles: 3, pulseMaxMs: 0 });
  assert.deepEqual(lines, ["BATON_HANDOVER merge bob"]);
  assert.equal((await alice.baton.fence()).result.held, true, "keeps holding while it finishes the current PR");
  // The new home's startup while alice still holds: stand by.
  const bob = session(w, { holder: "bob:acme-mm", home: { ...HOME, home: "bob" } });
  assert.equal((await bob.baton.startup()).result.decision, "held_elsewhere");
  assert.equal((await alice.baton.release({ reason: "handover" })).result.released, true);
  const b = await bob.baton.startup();
  assert.equal(b.result.decision, "acquired");
  assert.equal(b.result.tookOver, undefined, "a released baton is no takeover");
  assert.equal((await bob.baton.merge({ pr: 4, sha: SHA, method: "merge" })).result.merged, true);
  assert.equal((await alice.baton.fence()).exit, EXIT.NOT_STARTED, "the old home never acts again");
});

// --------------------------------------------------------------------------- keepalive --

test("keepalive stops (and stops renewing) when its owner is gone, when released, or when the model goes quiet", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const n = w.api.state.log.length;
  assert.equal(await s.baton.keepalive({ out: () => {}, parentAlive: () => false }), EXIT.OK);
  assert.equal(w.api.state.log.length, n, "an orphaned keepalive renews nothing");
  const lines = [];
  w.sleepLocal(46 * MIN);
  await s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true });
  assert.match(lines[0], /^BATON_IDLE merge/);
  assert.equal(w.api.state.log.length, n, "no model pulse: no renew");
  await s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true });
  assert.equal(lines.length, 1, "the bus restarts a stopped keepalive every poll: BATON_IDLE is said once per pulse");
  const t = session(w, { dir: s.stateDir });
  await s.baton.release({ reason: "exit" });
  assert.equal(await t.baton.keepalive({ out: () => {}, parentAlive: () => true, pulseMaxMs: 0 }), EXIT.OK);
});

// ---------------------------------------------------------------------------- guard --

test("guard: fences, then runs the command; refuses everything but gh and this engsys's gate-request.sh", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const r = await s.baton.guard(["gh", "pr", "edit", "12", "--add-label", "mm:active"]);
  assert.equal(r.exit, 0);
  assert.equal(r.stdout, "ok\n");
  assert.deepEqual(s.spawned[0].args, ["pr", "edit", "12", "--add-label", "mm:active"]);
  assert.equal(s.spawned[0].opts.timeout, 30_000);
  assert.throws(() => guardCommand(["rm", "-rf", "/"]), /gh, git push, gate-request\.sh or fleet msg send only/);
  assert.throws(() => guardCommand(["gh", "pr", "merge", "12"]), /merges go through/);
  assert.throws(() => guardCommand(["gh", "-R", "o/r", "pr", "merge", "12"]), /merges go through/);
  assert.throws(() => guardCommand(["gh", "api", "-X", "PUT", "repos/o/r/pulls/12/merge"]), /merges go through/);
  assert.throws(() => guardCommand(["gh", "pr", "ready", "12", "--admin"]), /--admin/);
  assert.throws(() => guardCommand(["/tmp/gate-request.sh", "--repo", "o/r"]), /only this engsys/);
});

/** A session working directory with a tmp/ holding b.txt, and a file outside tmp/. */
function sessionDir() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "baton-guard-msg-")));
  mkdirSync(join(cwd, "tmp"));
  chmodSync(join(cwd, "tmp"), 0o755); // whatever the umask: a private tmp/ (engsys#108 refuses a shared one)
  writeFileSync(join(cwd, "tmp", "b.txt"), "bounced #12\n");
  writeFileSync(join(cwd, "secret.txt"), "not for posting\n");
  return cwd;
}

test("guard: `fleet msg send` (engsys#77) runs this engsys's msg.mjs; other subcommands and other msg.mjs files are refused", () => {
  const own = fileURLToPath(new URL("../../fleet/msg.mjs", import.meta.url));
  const cwd = sessionDir();
  const body = join(cwd, "tmp", "b.txt");
  for (const argv of [
    ["fleet", "msg", "send", "--to", "bob:acme-build", "--body-file", "tmp/b.txt"],
    [own, "send", "--to", "bob:acme-build", "--body-file", "tmp/b.txt"],
    ["node", own, "send", "--to", "bob:acme-build", "--body-file", "tmp/b.txt"],
  ]) {
    const c = guardCommand(argv, { cwd });
    assert.equal(c.exe, process.execPath, argv.join(" "));
    assert.deepEqual(c.args, [own, "send", "--to", "bob:acme-build", "--body-file", "-"]);
    assert.equal(c.input, "bounced #12\n", "the checked file's contents go to the child on stdin");
  }
  assert.equal(readFileSync(body, "utf8"), "bounced #12\n");
  assert.throws(() => guardCommand(["fleet", "msg", "inbox"]), /fleet msg send/);
  assert.throws(() => guardCommand(["fleet", "status"]), /gh, git push, gate-request\.sh or fleet msg send only/);
  assert.throws(() => guardCommand(["/tmp/msg.mjs", "send"]), /only this engsys's msg\.mjs/);
  assert.throws(() => guardCommand(["node", "/tmp/msg.mjs", "send"]), /only this engsys's msg\.mjs/);
});

test("guard: `fleet msg send --body-file` is confined to stdin or the session's tmp/ (engsys#78, Nyx #84 Info)", () => {
  const own = fileURLToPath(new URL("../../fleet/msg.mjs", import.meta.url));
  const cwd = sessionDir();
  const send = (...rest) => guardCommand(["fleet", "msg", "send", "--to", "bob:acme-build", ...rest], { cwd });
  // allowed: stdin (passed through), a relative or absolute path under tmp/, the --flag=value spelling
  const stdin = send("--body-file", "-");
  assert.deepEqual(stdin.args, [own, "send", "--to", "bob:acme-build", "--body-file", "-"]);
  assert.equal(stdin.input, undefined, "a heredoc body: the session's stdin passes through");
  assert.equal(send("--body-file", join(cwd, "tmp", "b.txt")).input, "bounced #12\n");
  const eq = send("--body-file=tmp/b.txt");
  assert.deepEqual([eq.args.at(-1), eq.input], ["--body-file=-", "bounced #12\n"]);
  mkdirSync(join(cwd, "tmp", "sub"));
  writeFileSync(join(cwd, "tmp", "sub", "c.txt"), "x\n");
  assert.equal(send("--body-file", "tmp/sub/c.txt").input, "x\n");

  // refused: anything outside tmp/, however it is spelled
  writeFileSync(join(cwd, "tmp", "big.txt"), "x".repeat(256 * 1024 + 1));
  symlinkSync(join(cwd, "secret.txt"), join(cwd, "tmp", "link.txt"));
  symlinkSync(cwd, join(cwd, "tmp", "up"));
  for (const [args, why] of [
    [["--body-file", "secret.txt"], /outside/],
    [["--body-file", join(cwd, "secret.txt")], /outside/],
    [["--body-file", "tmp/../secret.txt"], /outside/],
    [["--body-file", "tmp/sub/../../secret.txt"], /outside/],
    [["--body-file", "/etc/hosts"], /outside/],
    [["--body-file", "tmp/link.txt"], /outside/],              // a symlink in tmp/ pointing out
    [["--body-file", "tmp/up/secret.txt"], /outside/],          // a directory symlink in tmp/ pointing up
    [["--body-file=../secret.txt"], /outside|cannot resolve/],
    [["--body-file", "tmp/missing.txt"], /cannot resolve/],
    [["--body-file", "tmp/sub"], /not a regular file/],
    [["--body-file", "tmp/big.txt"], /over 262144 bytes/],
    [["--body-file", "tmp/b.txt", "--body-file", "-"], /one --body-file/],
    [["--body-file", "tmp"], /outside/],
    [["--body-file", ""], /no file named/],
    [["--body-file"], /no file named/],
    [["--body-file", "secret.txt", "--body-file", "tmp/b.txt"], /outside/], // every occurrence is checked
  ]) assert.throws(() => send(...args), why, args.join(" "));

  // refused: a tmp/ that is itself a symlink, or no tmp/ at all
  const linked = realpathSync(mkdtempSync(join(tmpdir(), "baton-guard-msg-")));
  symlinkSync(cwd, join(linked, "tmp"));
  assert.throws(() => guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "tmp/secret.txt"], { cwd: linked }), /symlink/);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "baton-guard-msg-")));
  assert.throws(() => guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "tmp/b.txt"], { cwd: bare }), /does not exist/);
  assert.equal(guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "-"], { cwd: bare }).args.at(-1), "-", "stdin needs no tmp/");
});

test("guard: --body-file refuses a hardlink in tmp/ (engsys#108 L3a)", () => {
  const cwd = sessionDir();
  linkSync(join(cwd, "secret.txt"), join(cwd, "tmp", "hl"));
  assert.throws(() => guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "tmp/hl"], { cwd }), /hardlinked file/);
  // the original file, still linked twice, is refused too; a plain file next to it is not
  assert.equal(guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "tmp/b.txt"], { cwd }).input, "bounced #12\n");
});

test("guard: --body-file is anchored to the session's launch directory, not the Bash cwd (engsys#108 L3b)", () => {
  const root = sessionDir();
  // another directory with its own private tmp/ (a `cd` elsewhere): its tmp/ is not the session's
  const other = sessionDir();
  writeFileSync(join(other, "tmp", "probe.txt"), "hi\n");
  const send = (body, opts) => guardCommand(["fleet", "msg", "send", "--to", "bob:x", "--body-file", body], opts);
  assert.throws(() => send("tmp/probe.txt", { cwd: other, root }), /outside/);
  assert.throws(() => send(join(other, "tmp", "probe.txt"), { cwd: other, root }), /outside/);
  // the session's own tmp/ still works from a cd'd cwd, by absolute path or relative to that cwd
  assert.equal(send(join(root, "tmp", "b.txt"), { cwd: other, root }).input, "bounced #12\n");
  mkdirSync(join(root, "sub"));
  assert.equal(send("../tmp/b.txt", { cwd: join(root, "sub"), root }).input, "bounced #12\n");

  // a shared temp dir (the /private -> /private/tmp repro): world-writable or sticky tmp/ is refused,
  // even when it is the root's own tmp/
  for (const mode of [0o1777, 0o777, 0o1755]) {
    const shared = sessionDir();
    chmodSync(join(shared, "tmp"), mode);
    assert.throws(() => send("tmp/b.txt", { cwd: shared }), /world-writable or sticky/, mode.toString(8));
    assert.throws(() => send("tmp/b.txt", { cwd: shared, root }), /outside/, `${mode.toString(8)} from the session root`);
  }
  // a tmp/ owned by another user is refused
  const realUid = process.getuid;
  process.getuid = () => realUid.call(process) + 1;
  try {
    assert.throws(() => send("tmp/b.txt", { cwd: root }), /not owned by this user/);
  } finally {
    process.getuid = realUid;
  }
});

test("sessionRoot: ENGSYS_SESSION_ROOT, then CLAUDE_PROJECT_DIR, then the cwd; only absolute paths count (engsys#108)", () => {
  assert.equal(sessionRoot({ ENGSYS_SESSION_ROOT: "/fleet/wt", CLAUDE_PROJECT_DIR: "/proj" }, "/private"), "/fleet/wt");
  assert.equal(sessionRoot({ CLAUDE_PROJECT_DIR: "/proj" }, "/private"), "/proj");
  assert.equal(sessionRoot({}, "/private"), "/private");
  assert.equal(sessionRoot({ ENGSYS_SESSION_ROOT: "", CLAUDE_PROJECT_DIR: "rel/dir" }, "/private"), "/private");
});

test("guard (baton): the body file comes from the session root's tmp/, whatever the cwd (engsys#108)", async () => {
  const w = world();
  const root = sessionDir();
  const other = sessionDir();
  const s = session(w, { cwd: other, sessionDir: root });
  await s.baton.startup();
  await assert.rejects(s.baton.guard(["fleet", "msg", "send", "--to", "bob:x", "--body-file", "tmp/b.txt"]), /outside/);
  assert.equal(s.spawned.length, 0);
  const r = await s.baton.guard(["fleet", "msg", "send", "--to", "bob:x", "--body-file", join(root, "tmp", "b.txt")]);
  assert.equal(r.exit, 0);
  assert.equal(s.spawned[0].opts.input, "bounced #12\n");
});

test("readBounded: reads at most cap bytes; a file that grew past the cap after its size check is refused (engsys#108 I1)", () => {
  const dir = sessionDir();
  const f = join(dir, "tmp", "grow.txt");
  writeFileSync(f, "small\n");
  const fd = openSync(f, "r");
  try {
    assert.equal(fstatSync(fd).size, 6, "the size check sees a small file");
    appendFileSync(f, "x".repeat(64)); // then it grows
    assert.equal(readBounded(fd, 16), null);
  } finally {
    closeSync(fd);
  }
  const exact = join(dir, "tmp", "exact.txt");
  writeFileSync(exact, "y".repeat(16));
  const fd2 = openSync(exact, "r");
  try { assert.equal(readBounded(fd2, 16), "y".repeat(16)); } finally { closeSync(fd2); }
  const empty = join(dir, "tmp", "empty.txt");
  writeFileSync(empty, "");
  const fd3 = openSync(empty, "r");
  try { assert.equal(readBounded(fd3, 16), ""); } finally { closeSync(fd3); }
});

test("guard: a guarded fleet msg send hands the child the body checked before the fence, not the path (engsys#78 review)", async () => {
  const w = world();
  const cwd = sessionDir();
  const s = session(w, { cwd });
  await s.baton.startup();
  const r = await s.baton.guard(["fleet", "msg", "send", "--to", "bob:acme-build", "--re", "acme/app#12", "--body-file", "tmp/b.txt"]);
  assert.equal(r.exit, 0);
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0].cmd, process.execPath);
  assert.deepEqual(s.spawned[0].args.slice(1), ["send", "--to", "bob:acme-build", "--re", "acme/app#12", "--body-file", "-"]);
  assert.equal(s.spawned[0].opts.input, "bounced #12\n");
  // refused before the fence: nothing runs
  await assert.rejects(s.baton.guard(["fleet", "msg", "send", "--to", "bob:acme-build", "--body-file", "secret.txt"]), /outside/);
  assert.equal(s.spawned.length, 1);
  // a heredoc body: no input, the session's stdin passes through
  await s.baton.guard(["fleet", "msg", "send", "--to", "bob:acme-build", "--body-file", "-"]);
  assert.equal(s.spawned[1].opts.input, undefined);
});

test("defaultSpawn: `input` reaches the child's stdin (the pinned body of a guarded fleet msg send)", async () => {
  const r = await defaultSpawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { timeout: 10_000, input: "pinned body\n" });
  assert.deepEqual([r.code, r.stdout, r.timedOut], [0, "pinned body\n", false]);
  const early = await defaultSpawn(process.execPath, ["-e", "process.exit(4)"], { timeout: 10_000, input: "x".repeat(1 << 20) });
  assert.equal(early.code, 4, "a child that exits without reading: its exit code, no crash");
});

test("guard on a session that holds nothing runs nothing", async () => {
  const w = world();
  const s = session(w);
  const r = await s.baton.guard(["gh", "pr", "ready", "12"]);
  assert.equal(r.exit, EXIT.NOT_STARTED);
  assert.equal(s.spawned.length, 0);
});

// ------------------------------------------------------------------------- supervisor --

test("supervisorDecision: relaunch only when home and nobody holds a live baton; errors fail closed", () => {
  const own = "alice:acme-mm";
  const cases = [
    [HOME, { state: "free" }, true, "free"],
    [HOME, { state: "free", released: true, releasedBy: "bob" }, true, "free"],
    [HOME, { state: "held", holder: own, expiresAt: "x" }, false, "held_self"],
    [HOME, { state: "held", holder: "bob:acme-mm", expiresAt: "x" }, false, "held_elsewhere"],
    [HOME, { state: "unknown", expired: true, holder: own, protocol: 1 }, true, "expired"],
    [HOME, { state: "unknown", expired: true, holder: "bob:acme-mm", protocol: 1 }, true, "expired"],
    [HOME, { state: "unknown", malformed: true, reason: "missing token" }, true, "malformed"],
    [HOME, { state: "unknown", malformed: true, reason: "x", protocol: 9 }, false, "error"],
    [HOME, { state: "error", failure: { message: "502" } }, false, "error"],
    [AWAY, { state: "free" }, false, "not_home"],
    [{ ok: false, reason: "bad yaml" }, { state: "free" }, false, "error"],
    [{ ok: true, mode: "single", isHome: true }, { state: "free" }, true, "free"],
    [{ ok: true, mode: "multi", isHome: false, disabled: true }, { state: "free" }, false, "not_home"],
  ];
  for (const [home, status, relaunch, code] of cases) {
    const d = supervisorDecision({ home, status, ownHolder: own });
    assert.equal(d.relaunch, relaunch, `${JSON.stringify(status)} → ${code}`);
    assert.equal(d.code, code, JSON.stringify(status));
  }
});

test("supervise CLI: exit 0 may relaunch, 1 held elsewhere / not home, 3 on a lease read error", async () => {
  const w = world();
  const out = [];
  const io = { out: { write: (s) => out.push(s) }, err: { write: () => {} } };
  const env = { FLEET_ID: "alice", ENGSYS_SESSION: "acme-mm" };
  const base = ["supervise", "--repo", REPO, "--role", "merge"];
  const fed = fakeFederation("alice");
  assert.equal(await main(base, { ...io, env, api: w.api, federation: fed }), EXIT.OK);
  const bob = session(w, { holder: "bob:acme-mm" });
  await bob.baton.startup();
  assert.equal(await main(base, { ...io, env, api: w.api, federation: fed }), EXIT.REFUSED);
  assert.equal(JSON.parse(out.at(-1)).code, "held_elsewhere");
  assert.equal(await main(base, { ...io, env, api: w.api, federation: fakeFederation("bob") }), EXIT.REFUSED);
  assert.equal(JSON.parse(out.at(-1)).code, "not_home");
  w.api.fault({ when: () => true, status: 500, times: 99 });
  assert.equal(await main(base, { ...io, env, api: w.api, federation: fed }), EXIT.ERROR);
});

/** A federation module stand-in whose registry names `home` for every role of REPO. */
function fakeFederation(home) {
  const reg = { fleets: { alice: { enabled: true }, bob: { enabled: true } }, repos: { [REPO]: { merge: { home }, maintain: { home } } } };
  return {
    resolveFederationFile: () => "/fake/federation.yml",
    loadFederation: () => reg,
    fleetIdProblems: (r, id) => (r.fleets[id] ? [] : [`FLEET_ID ${id} not declared`]),
    roleHome: (r, repo, role) => r?.repos?.[repo]?.[role]?.home ?? null,
  };
}

// ---------------------------------------------------------------------- holder / home --

test("holder naming: <FLEET_ID>:<session>, or <hostname>:<session> in single-fleet mode", () => {
  assert.equal(holderFor({ env: { FLEET_ID: "alice" }, session: "acme-mm" }).holder, "alice:acme-mm");
  assert.equal(holderFor({ env: {}, session: "acme-mm", hostname: "Erics-Mac-mini.local" }).holder, "erics-mac-mini:acme-mm");
  assert.equal(holderFor({ env: { ENGSYS_SESSION: "acme-maintain" }, hostname: "mini" }).holder, "mini:acme-maintain");
  assert.equal(holderFor({ env: {}, session: "acme-mm", hostname: "mini" }).fleetMode, false);
  assert.equal(hostSlug("42_box.lan"), "box");
  assert.equal(hostSlug("1234"), "host");
  assert.equal(hostSlug("x".repeat(80)).length, 32);
  assert.throws(() => holderFor({ env: {} }), /no session name/);
});

test("homeCheck: single-fleet without FLEET_ID or without a federation file; real registry otherwise", async () => {
  assert.deepEqual(
    pickKeys(await homeCheck({ env: {}, repo: REPO, role: "merge" }), ["ok", "mode", "isHome"]),
    { ok: true, mode: "single", isHome: true },
  );
  const dir = mkdtempSync(join(tmpdir(), "baton-fed-"));
  assert.equal((await homeCheck({ env: { FLEET_ID: "alice", FLEET_REPO: dir }, repo: REPO, role: "merge" })).mode, "single");
  writeFileSync(join(dir, "federation.yml"), [
    "version: 1",
    "fleets:",
    "  alice:",
    "    enabled: true",
    "  bob:",
    "    enabled: true",
    "  carol:",
    "    enabled: false",
    "repos:",
    `  ${REPO}:`,
    "    merge: { home: bob }",
    "",
  ].join("\n"));
  const env = (id) => ({ FLEET_ID: id, FLEET_REPO: dir });
  const bob = await homeCheck({ env: env("bob"), repo: REPO, role: "merge" });
  assert.deepEqual(pickKeys(bob, ["ok", "mode", "isHome", "home"]), { ok: true, mode: "multi", isHome: true, home: "bob" });
  assert.equal((await homeCheck({ env: env("alice"), repo: REPO, role: "merge" })).isHome, false);
  assert.equal((await homeCheck({ env: env("alice"), repo: REPO, role: "maintain" })).undeclared, true);
  assert.equal((await homeCheck({ env: env("carol"), repo: REPO, role: "merge" })).disabled, true);
  const ghost = await homeCheck({ env: env("dave"), repo: REPO, role: "merge" });
  assert.equal(ghost.ok, false, "a FLEET_ID the registry does not declare fails closed");
  writeFileSync(join(dir, "federation.yml"), "version: 1\nfleets: [\n");
  assert.equal((await homeCheck({ env: env("bob"), repo: REPO, role: "merge" })).ok, false, "an invalid registry fails closed");
});

function pickKeys(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

// --------------------------------------------------------------------------------- CLI --

test("CLI: startup → fence → guard → merge → release, one JSON line each, documented exit codes", async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), "baton-cli-"));
  const out = [];
  const errs = [];
  const notes = [];
  const merges = [];
  const deps = {
    env: { ENGSYS_SESSION: "acme-mm", ENGSYS_SESSION_RUN: "r1" },
    hostname: "mini",
    api: w.api,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => errs.push(s) },
    notify: async (n) => { notes.push(n); return true; },
    mergeApi: { async request(m, p, b) { merges.push({ m, p, b }); return { status: 200, json: { merged: true, sha: SHA }, headers: {} }; } },
    spawn: async () => ({ code: 0, stdout: "labeled\n", stderr: "", timedOut: false }),
    now: () => w.local.t,
  };
  const common = ["--repo", REPO, "--role", "merge", "--state-dir", dir];
  assert.equal(await main(["startup", ...common], deps), EXIT.OK);
  assert.equal(JSON.parse(out.at(-1)).holder, "mini:acme-mm");
  assert.equal(await main(["fence", ...common], deps), EXIT.OK);
  assert.equal(await main(["guard", ...common, "--", "gh", "pr", "ready", "5"], deps), EXIT.OK);
  assert.equal(out.at(-1), "labeled\n");
  assert.equal(await main(["merge", ...common, "--pr", "5", "--sha", SHA, "--method", "squash"], deps), EXIT.OK);
  assert.deepEqual(merges[0].b, { sha: SHA, merge_method: "squash" });
  assert.equal(await main(["release", ...common, "--reason", "rotation"], deps), EXIT.OK);
  assert.equal(await main(["fence", ...common], deps), EXIT.NOT_STARTED);
  assert.equal(await main(["status", ...common], deps), EXIT.OK);
  assert.equal(JSON.parse(out.at(-1)).lease.state, "free");
  assert.equal(await main(["fence", "--repo", REPO, "--role", "merge"], deps), EXIT.USAGE, "--state-dir is required");
  assert.equal(await main(["guard", ...common], deps), EXIT.USAGE, "guard needs a command");
  assert.equal(await main(["startup", "--repo", REPO, "--role", "deploy", "--state-dir", dir], deps), EXIT.USAGE);
  assert.equal(await main(["startup", ...common], { ...deps, env: {} }), EXIT.USAGE, "no session name");
  assert.equal(out.join("").includes(JSON.parse(readFileSync(join(dir, "baton-merge.json"), "utf8")).token ?? "\u0000"), false);
  assert.ok(existsSync(join(dir, "baton-merge.json")));
  assert.ok(readdirSync(dir).every((f) => !f.endsWith(".tmp")), "no temp files left behind");
});

// ------------------------------------------------------------------ review follow-ups (#69) --

test("L1: guard refuses every merge form, not just `gh pr merge` and numeric merge paths", () => {
  for (const argv of [
    ["gh", "api", "-X", "PUT", "repos/o/r/pulls/{pull_number}/merge", "-f", "pull_number=5"],
    ["gh", "api", "graphql", "-f", "query=mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}"],
    ["gh", "api", "graphql", "-f", "query=mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}"],
    ["gh", "api", "-X", "POST", "repos/o/r/merges", "-f", "base=main"],
  ]) assert.throws(() => guardCommand(argv), /merges go through/, argv.join(" "));
});

test("N2: guard's git push grammar is an allowlist (origin, one PR-branch refspec, --force-with-lease only)", () => {
  assert.deepEqual(guardCommand(["git", "-C", "../wt", "push", "--force-with-lease", "origin", "HEAD:refs/heads/agent/1-x"]).push,
    { dir: "../wt", flags: ["--force-with-lease"], refspec: "HEAD:refs/heads/agent/1-x", branch: "agent/1-x" });
  assert.equal(guardCommand(["git", "push", "origin", "agent/1-x"]).push.branch, "agent/1-x");
  for (const argv of [
    ["git", "push", "--force", "origin", "x"],
    ["git", "push", "-f", "origin", "x"],
    ["git", "push", "-u", "origin", "x"],
    ["git", "push", "--no-verify", "origin", "x"],
    ["git", "push", "--receive-pack=gh pr merge 5 #", "/tmp/r"],
    ["git", "push", "--exec=gh pr merge 5", "origin", "x"],
    ["git", "push", "-o", "ci.skip", "origin", "x"],
    ["git", "push", "--push-option=x", "origin", "x"],
    ["git", "push", "origin", ":release/1.0"],
    ["git", "push", "origin", "+x"],
    ["git", "push", "origin", "refs/tags/v1.0"],
    ["git", "push", "origin", "HEAD:refs/tags/v1.0"],
    ["git", "push", "origin", "x:refs/engsys/batons/merge"],
    ["git", "push", "https://github.com/other/repo", "HEAD:x"],
    ["git", "push", "/tmp/r", "HEAD:x"],
    ["git", "push", "origin"],
    ["git", "push", "origin", "a", "b"],
    ["git", "-C", "a", "-C", "b", "push", "origin", "x"],
    ["git", "-c", "core.hooksPath=/tmp", "push", "origin", "x"],
    ["git", "commit", "-m", "x"],
  ]) assert.throws(() => guardCommand(argv), /guard/, argv.join(" "));
});

/** A merge API that answers the PR and repo reads a guarded push makes. */
function pushApi({ headRef = "agent/1-x", headRepo = REPO, state = "open", defaultBranch = "main" } = {}) {
  return (n, method, path) => {
    if (path === `/repos/${REPO}/pulls/5`) return { status: 200, json: { state, head: { ref: headRef, repo: { full_name: headRepo } } }, headers: {} };
    if (path === `/repos/${REPO}`) return { status: 200, json: { default_branch: defaultBranch }, headers: {} };
    return { status: 404, json: {}, headers: {} };
  };
}

/** A checkout's git config the way `git config --list --show-scope` reports it in a fleet session. */
const FLEET_CONFIG = [
  { scope: "system", key: "credential.helper", value: "osxkeychain" },
  { scope: "local", key: "core.hookspath", value: ".husky/_" },
  { scope: "local", key: "remote.origin.url", value: `https://github.com/${REPO}.git` },
  { scope: "local", key: "branch.agent/1-x.merge", value: "refs/heads/agent/1-x" },
  { scope: "command", key: "credential.https://github.com.helper", value: "" },
  { scope: "command", key: "credential.https://github.com.helper", value: "!node /fleet/gh-app-token.mjs git-credential" },
  { scope: "command", key: "user.name", value: "fleet[bot]" },
];
const PUSH_C = [
  "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "core.fsmonitor=false", "-c", "http.sslVerify=true", "-c", "core.sshCommand=ssh", "-c", "core.askPass=",
  "-c", "credential.helper=", "-c", "credential.helper=osxkeychain", "-c", "credential.https://github.com.helper=",
  "-c", "credential.https://github.com.helper=!node /fleet/gh-app-token.mjs git-credential", "-c", "push.gpgSign=false", "-c", "push.recurseSubmodules=no",
];

test("N2: a guarded push is checked against the PR and origin, then sent with hooks off and file transport refused", async () => {
  const run = async (argv, { opts = {}, url = `https://github.com/${REPO}.git`, pr = 5 } = {}) => {
    const w = world();
    const reply = pushApi(opts);
    const calls = [];
    const s = session(w, { remoteUrl: async () => url });
    const b = createBaton({
      lease: s.lease, repo: REPO, role: "merge", holder: s.holder, run: "run-1", store: s.store, home: async () => HOME, now: () => w.local.t,
      mergeApi: { request: async (m, p) => reply(0, m, p) },
      spawn: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
      remoteUrl: async () => url,
      pushConfig: async () => FLEET_CONFIG,
      gitPath: () => "/usr/bin/git",
    });
    await s.baton.startup();
    return { r: await b.guard(argv, { pr }), calls };
  };
  const ok = await run(["git", "-C", "../wt", "push", "--force-with-lease", "origin", "HEAD:refs/heads/agent/1-x"]);
  assert.equal(ok.r.result.code, "ran");
  assert.deepEqual(ok.calls[0], { cmd: "/usr/bin/git", args: [...PUSH_C, "-C", "../wt", "push", "--force-with-lease", "origin", "HEAD:refs/heads/agent/1-x"] });
  const refused = [
    [["git", "push", "origin", "HEAD:refs/heads/other"], {}, "head branch is agent/1-x"],
    [["git", "push", "origin", "HEAD:refs/heads/develop"], { opts: { headRef: "develop", defaultBranch: "develop" } }, "default branch"],
    [["git", "push", "origin", "HEAD:refs/heads/Main"], { opts: { headRef: "Main", defaultBranch: "main" } }, "default branch"],
    [["git", "push", "origin", "agent/1-x"], { opts: { headRepo: "fork/app" } }, "head lives in fork/app"],
    [["git", "push", "origin", "agent/1-x"], { opts: { state: "closed" } }, "is closed"],
    [["git", "push", "origin", "agent/1-x"], { url: "https://github.com/other/repo.git" }, "is not acme/app"],
    [["git", "push", "origin", "agent/1-x"], { url: "/tmp/local-remote" }, "is not acme/app"],
  ];
  for (const [argv, o, why] of refused) {
    const { r, calls } = await run(argv, o);
    assert.equal(r.result.sent, false, argv.join(" "));
    assert.match(r.result.reason, new RegExp(why), argv.join(" "));
    assert.equal(calls.length, 0, "nothing ran");
  }
  await assert.rejects(() => run(["git", "push", "origin", "agent/1-x"], { pr: null }), /--pr/);
});

test("N2: --new-branch creates a branch origin lacks (no force, never the default branch) and nothing else", async () => {
  const run = async (argv, { exists = false, defaultBranch = "main", newBranchPrefixes } = {}) => {
    const w = world();
    const calls = [];
    const s = session(w);
    const b = createBaton({
      lease: s.lease, repo: REPO, role: "maintain", holder: "alice:acme-maintain", run: "run-1", store: createStateStore({ stateDir: s.stateDir, role: "maintain" }), home: async () => HOME, now: () => w.local.t,
      mergeApi: { request: async (m, p) => (p === `/repos/${REPO}` ? { status: 200, json: { default_branch: defaultBranch } } : p.startsWith(`/repos/${REPO}/git/ref/heads/`) ? { status: exists ? 200 : 404, json: {} } : { status: 404, json: {} }) },
      spawn: async (cmd, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
      remoteUrl: async () => `git@github.com:${REPO}.git`,
      pushConfig: async () => FLEET_CONFIG,
      ...(newBranchPrefixes ? { newBranchPrefixes } : {}),
    });
    await b.startup();
    return { r: await b.guard(argv, { newBranch: true }), calls };
  };
  const ok = await run(["git", "-C", "../wt", "push", "origin", "HEAD:refs/heads/agent/mnt-fix-1"]);
  assert.equal(ok.r.result.code, "ran");
  assert.deepEqual(ok.calls[0].slice(-3), ["push", "origin", "HEAD:refs/heads/agent/mnt-fix-1"]);
  assert.match((await run(["git", "push", "origin", "agent/mnt-fix-1"], { exists: true })).r.result.reason, /already exists/);
  assert.match((await run(["git", "push", "--force-with-lease", "origin", "agent/mnt-fix-1"])).r.result.reason, /no --force-with-lease/);
  assert.match((await run(["git", "push", "origin", "agent/x"], { defaultBranch: "agent/x" })).r.result.reason, /default branch/);
  // #71: only under a configured prefix (default agent/), so a push can't create a branch a
  // branch-filtered workflow trigger watches.
  for (const branch of ["mnt/fix-1", "release/2.0", "main-hotfix", "agentx/1"]) {
    const { r, calls } = await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
    assert.equal(r.result.code, "push_refused", branch);
    assert.match(r.result.reason, /only branches under agent\//, branch);
    assert.equal(calls.length, 0, branch);
  }
  assert.equal((await run(["git", "push", "origin", "mnt/fix-1"], { newBranchPrefixes: ["mnt/fix-", "agent/"] })).r.result.code, "ran");
  assert.match((await run(["git", "push", "origin", "agent/1"], { newBranchPrefixes: [] })).r.result.reason, /no valid prefix/);
});

test("#71: ENGSYS_NEW_BRANCH_PREFIX sets the prefixes; unset means agent/, an invalid value refuses every new branch", () => {
  assert.deepEqual(newBranchPrefixesFrom({}), ["agent/"]);
  assert.deepEqual(newBranchPrefixesFrom({ ENGSYS_NEW_BRANCH_PREFIX: "" }), ["agent/"]);
  assert.deepEqual(newBranchPrefixesFrom({ ENGSYS_NEW_BRANCH_PREFIX: "agent/acme/, mnt/fix-" }), ["agent/acme/", "mnt/fix-"]);
  for (const bad of ["../x", "-x", "agent/ $(id)", "*"]) assert.deepEqual(newBranchPrefixesFrom({ ENGSYS_NEW_BRANCH_PREFIX: bad }), [], bad);
});

test("#71 L3: the push masks the checkout's credential helper, ssh command, askpass and fsmonitor, and keeps the fleet's helper", () => {
  const entries = [
    { scope: "system", key: "credential.helper", value: "osxkeychain" },
    { scope: "global", key: "core.sshcommand", value: "ssh -i ~/.ssh/fleet" },
    { scope: "local", key: "core.sshcommand", value: "/tmp/evil-ssh" },
    { scope: "local", key: "core.askpass", value: "/tmp/evil-askpass" },
    { scope: "worktree", key: "core.fsmonitor", value: "/tmp/evil-fsmonitor" },
    { scope: "command", key: "credential.https://github.com.helper", value: "" },
    { scope: "command", key: "credential.https://github.com.helper", value: "!fleet-helper" },
  ];
  const args = pushConfigArgs(entries);
  const values = args.filter((_, i) => i % 2 === 1);
  assert.ok(args.every((a, i) => i % 2 === 1 || a === "-c"), "only -c options");
  assert.ok(values.includes("core.sshCommand=ssh -i ~/.ssh/fleet"), "the operator's ssh command, not the checkout's");
  assert.ok(values.includes("core.askPass="), "askpass off (also stops the SSH_ASKPASS fallback)");
  assert.ok(values.includes("core.fsmonitor=false"));
  assert.ok(!values.some((v) => v.includes("/tmp/evil")), "nothing from the checkout");
  // The reset comes first, then every non-local helper in git's read order: the fleet's env-scoped one last.
  const reset = values.indexOf("credential.helper=");
  assert.deepEqual(values.slice(reset, reset + 4), ["credential.helper=", "credential.helper=osxkeychain", "credential.https://github.com.helper=", "credential.https://github.com.helper=!fleet-helper"]);
  assert.ok(values.includes("core.sshCommand=ssh") === false);
  assert.ok(pushConfigArgs([]).includes("core.sshCommand=ssh"), "no ssh command anywhere: plain ssh");
});

test("#71 L3: a guarded push refuses a checkout whose own config sets credential, proxy, TLS, URL-rewrite, include or transport keys", async () => {
  const unsafe = [
    ["local", "credential.helper", "!evil"],
    ["local", "credential.https://github.com/acme/app.helper", "!evil"],
    ["local", "credential.https://github.com.username", "x"],
    ["local", "http.proxy", "http://attacker:8080"],
    ["local", "http.https://github.com.proxy", "http://attacker:8080"],
    ["local", "http.sslverify", "false"],
    ["local", "http.https://github.com.sslcainfo", "/tmp/ca.pem"],
    ["local", "http.extraheader", "X: y"],
    ["local", "http.curloptresolve", "github.com:443:10.0.0.1"],
    ["local", "url.https://evil.example/.insteadof", "https://github.com/"],
    ["local", "url.git@evil:.pushinsteadof", "https://github.com/"],
    ["local", "include.path", "/tmp/x"],
    ["local", "includeif.gitdir:/x/.path", "/tmp/x"],
    ["local", "remote.origin.proxy", "http://attacker"],
    ["local", "remote.origin.vcs", "evil"],
    ["local", "remote.origin.receivepack", "evil"],
    ["local", "protocol.ext.allow", "always"],
    ["local", "core.gitproxy", "/tmp/evil"],
    ["worktree", "http.proxy", "http://attacker"],
  ];
  for (const [scope, key, value] of unsafe) assert.deepEqual(unsafeLocalConfig([{ scope, key, value }]), [key], key);
  const fine = [
    ["local", "http.postbuffer", "524288000"],
    ["local", "http.https://github.com.lowspeedlimit", "1000"],
    ["local", "core.hookspath", ".husky/_"],
    ["local", "core.sshcommand", "/tmp/masked-anyway"],
    ["local", "remote.origin.url", `https://github.com/${REPO}.git`],
    ["local", "remote.origin.pushurl", `https://github.com/${REPO}.git`],
    ["local", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["local", "branch.agent/1-x.merge", "refs/heads/agent/1-x"],
    ["global", "http.proxy", "http://corp-proxy"],
    ["global", "url.git@github.com:.insteadof", "https://github.com/"],
    ["command", "credential.https://github.com.helper", "!GH_APP_ENV_FILE='/x/gh-app.env' '/opt/homebrew/bin/node' '/x/gh-app-token.mjs' git-credential"],
    ["command", "credential.https://github.com.helper", ""],
    ["command", "credential.https://github.com.usehttppath", "true"],
    ["command", "user.name", "fleet[bot]"],
  ];
  assert.deepEqual(unsafeLocalConfig(fine.map(([scope, key, value]) => ({ scope, key, value }))), []);

  const w = world();
  const calls = [];
  const s = session(w);
  const mk = (pushConfig) => createBaton({
    lease: s.lease, repo: REPO, role: "merge", holder: s.holder, run: "run-1", store: s.store, home: async () => HOME, now: () => w.local.t,
    mergeApi: { request: async (m, p) => pushApi()(0, m, p) },
    spawn: async (cmd, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
    remoteUrl: async () => `https://github.com/${REPO}.git`,
    pushConfig,
  });
  await s.baton.startup();
  const planted = await mk(async () => [...FLEET_CONFIG, { scope: "local", key: "http.https://github.com.proxy", value: "http://attacker" }])
    .guard(["git", "-C", "../wt", "push", "origin", "agent/1-x"], { pr: 5 });
  assert.equal(planted.result.code, "push_refused");
  assert.match(planted.result.reason, /http\.https:\/\/github\.com\.proxy/);
  const unreadable = await mk(async () => { throw new Error("fatal: bad config line 3"); }).guard(["git", "push", "origin", "agent/1-x"], { pr: 5 });
  assert.equal(unreadable.result.code, "push_refused");
  assert.match(unreadable.result.reason, /could not read the checkout's git config/);
  assert.equal(calls.length, 0, "nothing ran");
});

test("#71 L3: parseConfigList reads git config --list --show-scope -z", () => {
  assert.deepEqual(parseConfigList("system\0credential.helper\nosxkeychain\0local\0core.bare\0command\0credential.https://github.com.helper\n!a b=c\nd\0"), [
    { scope: "system", key: "credential.helper", value: "osxkeychain" },
    { scope: "local", key: "core.bare", value: null },
    { scope: "command", key: "credential.https://github.com.helper", value: "!a b=c\nd" },
  ]);
  assert.deepEqual(parseConfigList(""), []);
});

test("M3: sessionProcess walks past shells to the session process; sameProcessAlive tells a reused pid apart", () => {
  const table = {
    40: { ppid: 30, start: "Sun Oct 4 12:00:03 2026", comm: "bash" },
    30: { ppid: 20, start: "Sun Oct 4 12:00:02 2026", comm: "/bin/zsh" },
    20: { ppid: 10, start: "Sun Oct 4 12:00:01 2026", comm: "2.1.233" },
    10: { ppid: 1, start: "Sun Oct 4 11:00:00 2026", comm: "-zsh" },
  };
  const ps = (pid) => table[pid] ?? null;
  assert.deepEqual(sessionProcess({ startPid: 40, ps }), { pid: 20, start: "Sun Oct 4 12:00:01 2026" });
  // claude died: the intermediate shell was reparented to init.
  const orphan = { 40: table[40], 30: { ...table[30], ppid: 1 } };
  assert.equal(sessionProcess({ startPid: 40, ps: (pid) => orphan[pid] ?? null }), null);
  assert.equal(sameProcessAlive({ pid: 20, start: "Sun Oct 4 12:00:01 2026" }, ps), true);
  assert.equal(sameProcessAlive({ pid: 20, start: "Sun Oct 4 12:59:59 2026" }, ps), false, "same pid, another process");
  assert.equal(sameProcessAlive({ pid: 99, start: "x" }, ps), false);
  const real = sessionProcess();
  assert.ok(real === null || (real.pid > 1 && typeof real.start === "string"), "the real ps parses");
});

test("M3: keepalive stops, renewing nothing, once its session process is gone; the pulse limit is 20 min", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const n = w.api.state.log.length;
  assert.equal(await s.baton.keepalive({ out: () => {}, parentAlive: () => true, ownerAlive: () => false, pulseMaxMs: 0 }), EXIT.OK);
  assert.equal(w.api.state.log.length, n);
  const lines = [];
  w.sleepLocal(21 * MIN);
  await s.baton.keepalive({ out: (l) => lines.push(l), parentAlive: () => true });
  assert.match(lines[0] ?? "", /^BATON_IDLE merge/, "default pulse limit is 20 minutes");
});

test("L2: without ENGSYS_SESSION_RUN the session's process id stands in, so a re-run of startup keeps its own token", async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), "baton-l2-"));
  const out = [];
  const deps = (run) => ({ env: { ENGSYS_SESSION: "acme-mm" }, hostname: "mini", api: w.api, run, out: { write: (x) => out.push(x) }, err: { write: () => {} }, notify: async () => true, now: () => w.local.t });
  const common = ["--repo", REPO, "--role", "merge", "--state-dir", dir];
  assert.equal(await main(["startup", ...common], deps("pid:4242@Sun Oct 4 12:00:00 2026")), EXIT.OK);
  assert.equal(await main(["startup", ...common], deps("pid:4242@Sun Oct 4 12:00:00 2026")), EXIT.OK);
  assert.equal(JSON.parse(out.at(-1)).decision, "resumed");
  assert.equal(await main(["startup", ...common], deps("pid:5151@Sun Oct 4 13:00:00 2026")), EXIT.REFUSED, "another session never reads the token");
  assert.equal(JSON.parse(out.at(-1)).decision, "wait_self");
});

test("L3: a keepalive renew answered between our release CAS and its state write is no loss", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const keep = session(w, { dir: s.stateDir });
  const release = s.lease.release;
  let raced = null;
  s.lease.release = async (o) => { const r = await release(o); raced = await keep.baton.renew({ source: "keepalive" }); return r; };
  assert.equal((await s.baton.release({ reason: "rotation" })).result.released, true);
  assert.notEqual(raced.result.lost, true);
  assert.equal(existsSync(s.store.lostFile), false, "no sticky marker");
  assert.equal(s.notes.length + keep.notes.length, 0, "no alert");
  assert.equal(s.store.load().releasing, undefined);
});

test("L3: a failed release clears its in-progress mark, so a real loss later still alerts", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  w.api.fault({ when: () => true, status: 500, times: 99 });
  assert.equal((await s.baton.release({ reason: "exit" })).exit, EXIT.ERROR);
  assert.equal(s.store.load().releasing, undefined);
  assert.ok(s.store.load().token);
});

// ---------------------------------------------------------------- default notify (#75) --

test("default notify resolves an absolute command, never a bare `fleet`", () => {
  const [cmd, script] = resolveNotifyCommand({});
  assert.equal(cmd, "bash");
  assert.ok(script.startsWith("/") && script.endsWith("core/fleet/bin/fleet"), script);
  assert.ok(existsSync(script), `${script} must exist in the kit`);
});

test("default notify runs with a PATH that lacks `fleet` (FLEET_BIN stub is invoked)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-notify-"));
  const stub = join(dir, "stub-fleet");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n`);
  chmodSync(stub, 0o755);
  const err = [];
  const notify = defaultNotify({ env: { PATH: "/nonexistent", FLEET_BIN: stub }, err: { write: (x) => err.push(x) } });
  assert.equal(await notify({ level: "alert", incident: "baton-lost-merge", text: "lost it" }), true);
  assert.deepEqual(readFileSync(join(dir, "argv"), "utf8").trim().split("\n"), ["notify", "--level", "alert", "--incident", "baton-lost-merge", "lost it"]);
  assert.deepEqual(err, []);
});

test("default notify failure is soft and names the resolved command", async () => {
  const err = [];
  const notify = defaultNotify({ env: { PATH: "/nonexistent", FLEET_BIN: "/no/such/fleet" }, err: { write: (x) => err.push(x) } });
  assert.equal(await notify({ level: "alert", text: "x" }), false);
  assert.match(err.join(""), /notify failed via `\/no\/such\/fleet notify`/);
});

// ------------------------------------------------------------------------- #85 Nyx follow-ups --

test("#85 L3: env-scoped config (scope command) is checked too: only the fleet's helper, useHttpPath and user keys pass", () => {
  const bad = [
    ["credential.helper", "!evil"],
    ["credential.https://github.com.helper", "!/tmp/evil.sh"],
    ["url.https://evil.example/.pushinsteadof", "https://github.com/"],
    ["http.proxy", "http://attacker"],
    ["core.sshcommand", "/tmp/evil-ssh"],
    ["core.askpass", "/tmp/evil"],
    ["include.path", "/tmp/x"],
  ];
  for (const [key, value] of bad) assert.deepEqual(unsafePushConfig([{ scope: "command", key, value }]), [key], key);
  assert.deepEqual(unsafePushConfig(FLEET_CONFIG), []);
  assert.deepEqual(unsafePushConfig([{ scope: "global", key: "core.sshcommand", value: "ssh -i ~/.ssh/fleet" }]), [], "the operator's own config");
  assert.equal(unsafeLocalConfig, unsafePushConfig, "back-compat name");
});

test("#85 L3: an includeIf in global config that points into the checkout counts as the checkout's config", () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-inc-"));
  const entries = [
    { scope: "global", origin: `file:${join(dir, ".git", "evil.inc")}`, key: "http.proxy", value: "http://attacker" },
    { scope: "global", origin: `file:${join(dir, "x.inc")}`, key: "credential.helper", value: "!evil" },
    { scope: "global", origin: "file:/Users/x/.gitconfig", key: "core.editor", value: "nano" },
    { scope: "command", origin: "command line:", key: "user.name", value: "bot" },
  ];
  const out = localizeIncludes(entries, [dir, join(dir, ".git")]);
  assert.deepEqual(out.map((e) => e.scope), ["local", "local", "global", "command"]);
  assert.deepEqual(unsafePushConfig(out), ["http.proxy", "credential.helper"]);
});

test("#85 L3: the push environment drops GIT_* (but the fleet's env-scoped config), askpass, proxies, NODE_OPTIONS and preloads, and pins PATH", () => {
  const env = pushEnv({
    HOME: "/Users/x", GH_APP_ENV_FILE: "/x/gh-app.env", PATH: "/tmp/evil-bin:/usr/bin",
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "user.name", GIT_CONFIG_VALUE_1: "bot",
    GIT_SSH_COMMAND: "/tmp/evil", GIT_SSH: "/tmp/evil", GIT_ASKPASS: "/tmp/evil", GIT_PROXY_COMMAND: "/tmp/evil", GIT_EXEC_PATH: "/tmp/evil", GIT_DIR: "/tmp/x",
    GIT_CONFIG_PARAMETERS: "'credential.helper=!evil'", GIT_CONFIG_GLOBAL: "/tmp/g", GIT_SSL_NO_VERIFY: "1", SSH_ASKPASS: "/tmp/evil", NODE_OPTIONS: "--require /tmp/evil.js",
    https_proxy: "http://attacker", ALL_PROXY: "http://attacker", SSL_CERT_FILE: "/tmp/ca.pem", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", LD_PRELOAD: "/tmp/evil.so",
    DEVELOPER_DIR: "/tmp/fake-xcode", TOOLCHAINS: "evil",
  });
  assert.deepEqual(Object.keys(env).sort(), ["GH_APP_ENV_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
  assert.equal(env.PATH, PUSH_PATH);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("#85 L4: the config is scanned again inside the fence, right before the push; the push gets the cleaned env", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const run = async (second) => {
    const calls = [];
    let scans = 0;
    const b = createBaton({
      lease: s.lease, repo: REPO, role: "merge", holder: s.holder, run: "run-1", store: s.store, home: async () => HOME, now: () => w.local.t,
      mergeApi: { request: async (m, p) => pushApi()(0, m, p) },
      spawn: async (cmd, args, opts) => { calls.push({ args, opts }); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
      remoteUrl: async () => `https://github.com/${REPO}.git`,
      pushConfig: async () => { scans += 1; return scans === 1 ? FLEET_CONFIG : second; },
    });
    return { r: await b.guard(["git", "-C", "../wt", "push", "origin", "agent/1-x"], { pr: 5 }), calls, scans: () => scans };
  };
  const planted = await run([...FLEET_CONFIG, { scope: "local", key: "url.https://evil.example/.pushinsteadof", value: "https://github.com/" }]);
  assert.equal(planted.r.result.code, "push_refused");
  assert.equal(planted.r.result.sent, false);
  assert.match(planted.r.result.reason, /pushinsteadof/);
  assert.equal(planted.calls.length, 0, "nothing ran");
  assert.equal(planted.scans(), 2);
  const clean = await run(FLEET_CONFIG);
  assert.equal(clean.r.result.code, "ran");
  assert.equal(clean.calls[0].opts.env.PATH, PUSH_PATH, "the push runs with pushEnv()");
  assert.ok(!("NODE_OPTIONS" in clean.calls[0].opts.env));
});

test("#85 L5: guard refuses gh api graphql whose document is not inline", () => {
  for (const argv of [
    ["gh", "api", "graphql", "-F", "query=@/tmp/m.graphql"],
    ["gh", "api", "graphql", "-f", "query=@-"],
    ["gh", "api", "graphql", "--field=query=@m.graphql"],
    ["gh", "api", "graphql", "-Fquery=@m.graphql"],
    ["gh", "api", "graphql", "--input", "m.json"],
    ["gh", "api", "graphql", "--input=m.json"],
    ["gh", "api", "/graphql", "-F", "query=@m.graphql"],
  ]) assert.throws(() => guardCommand(argv), /document inline/, argv.join(" "));
  assert.equal(guardCommand(["gh", "api", "graphql", "-f", "query=query { viewer { login } }"]).exe, "gh");
  assert.equal(guardCommand(["gh", "api", "repos/o/r/issues/1/labels", "--input", "labels.json"]).exe, "gh", "REST --input stays allowed");
});

test("#85 L3: parseConfigList reads the --show-origin form", () => {
  assert.deepEqual(parseConfigList("global\0file:/Users/x/.gitconfig\0core.editor\nnano\0command\0command line:\0user.name\nbot\0", { origin: true }), [
    { scope: "global", origin: "file:/Users/x/.gitconfig", key: "core.editor", value: "nano" },
    { scope: "command", origin: "command line:", key: "user.name", value: "bot" },
  ]);
});

// ------------------------------------------------------------------- #92 NF2: a trusted git --

test("#92 NF2: the push PATH keeps only root-owned directories nobody else can write", () => {
  const st = (uid, mode, dir = true) => ({ uid, mode, isDirectory: () => dir, isFile: () => !dir });
  const table = { "/usr/bin": st(0, 0o40755), "/opt/homebrew/bin": st(501, 0o40775), "/usr/local/bin": st(0, 0o40775), "/bin": st(0, 0o40755) };
  const stat = (p) => { if (table[p]) return table[p]; throw new Error("ENOENT"); };
  assert.deepEqual(trustedPushDirs(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/nope"], { stat }), ["/usr/bin", "/bin"]);
  // On this host: every PUSH_PATH entry really is root-owned and not group/other-writable.
  for (const d of PUSH_PATH.split(":").filter(Boolean)) {
    const s = statSync(d);
    assert.ok(s.uid === 0 && (s.mode & 0o022) === 0, d);
  }
  assert.ok(PUSH_PATH_CANDIDATES.includes("/opt/homebrew/bin"), "Homebrew is a candidate, kept only when root-owned");
});

test("#92 NF2: the push runs git by absolute path from a trusted directory, never a planted one ahead of it", () => {
  const planted = mkdtempSync(join(tmpdir(), "planted-"));
  writeFileSync(join(planted, "git"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
  const git = pushGit({ dirs: [planted, ...PUSH_PATH_CANDIDATES] });
  assert.notEqual(git, join(planted, "git"), "a user-owned directory is never used");
  if (git) {
    assert.ok(git.startsWith("/") && git.endsWith("/git"));
    assert.equal(statSync(git).uid, 0);
  }
  assert.equal(pushGit({ dirs: [planted] }), null, "only a user-writable git: none");
  // A root-owned git that doesn't run (the macOS shim without the Command Line Tools) is skipped.
  const st = (dir) => ({ uid: 0, mode: dir ? 0o40755 : 0o100755, isDirectory: () => dir, isFile: () => !dir });
  const stat = (p) => st(!p.endsWith("/git"));
  const tried = [];
  const run = (p) => { tried.push(p); if (p === "/a/git") throw new Error("xcrun: error: invalid active developer path"); return "git version 2"; };
  assert.equal(pushGit({ dirs: ["/a", "/b"], stat, run }), "/b/git");
  assert.deepEqual(tried, ["/a/git", "/b/git"]);
});

test("#92 NF2: with no trusted git the guarded push is refused before anything is sent", async () => {
  const w = world();
  const s = session(w);
  await s.baton.startup();
  const calls = [];
  const b = createBaton({
    lease: s.lease, repo: REPO, role: "merge", holder: s.holder, run: "run-1", store: s.store, home: async () => HOME, now: () => w.local.t,
    mergeApi: { request: async (m, p) => pushApi()(0, m, p) },
    spawn: async (cmd, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
    remoteUrl: async () => `https://github.com/${REPO}.git`,
    pushConfig: async () => FLEET_CONFIG,
    gitPath: () => null,
  });
  const r = await b.guard(["git", "push", "origin", "agent/1-x"], { pr: 5 });
  assert.equal(r.result.code, "push_refused");
  assert.equal(r.result.reason, NO_TRUSTED_GIT);
  assert.match(NO_TRUSTED_GIT, /Command Line Tools/);
  assert.equal(calls.length, 0);
});
