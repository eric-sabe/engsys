// baton.test.mjs — tests for the monsters' baton (the caller rule over the github lease).
// Runner: `node --test core/lib/lease/baton.test.mjs`. Offline: the lease runs against the in-process
// fake of GitHub's git data API (fixtures/fake-github.mjs); the merge endpoint, notify and spawn are
// recorders. Two clocks move independently: `api.state.now` (the server's Date header) and `local.t`
// (Date.now on this host), so a sleeping laptop and a lagging server can each be simulated.

import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
  guardCommand,
  holderFor,
  homeCheck,
  hostSlug,
  defaultNotify,
  resolveNotifyCommand,
  main,
  sameProcessAlive,
  sessionProcess,
  supervisorDecision,
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

function session(w, { holder = "alice:acme-mm", run = "run-1", home = HOME, role = "merge", dir, mergeReply, remoteUrl } = {}) {
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

test("guard: `fleet msg send` (engsys#77) runs this engsys's msg.mjs; other subcommands and other msg.mjs files are refused", () => {
  const own = fileURLToPath(new URL("../../fleet/msg.mjs", import.meta.url));
  for (const argv of [
    ["fleet", "msg", "send", "--to", "bob:acme-build", "--body-file", "b.txt"],
    [own, "send", "--to", "bob:acme-build", "--body-file", "b.txt"],
    ["node", own, "send", "--to", "bob:acme-build", "--body-file", "b.txt"],
  ]) {
    const c = guardCommand(argv);
    assert.equal(c.exe, process.execPath, argv.join(" "));
    assert.deepEqual(c.args, [own, "send", "--to", "bob:acme-build", "--body-file", "b.txt"]);
  }
  assert.throws(() => guardCommand(["fleet", "msg", "inbox"]), /fleet msg send/);
  assert.throws(() => guardCommand(["fleet", "status"]), /gh, git push, gate-request\.sh or fleet msg send only/);
  assert.throws(() => guardCommand(["/tmp/msg.mjs", "send"]), /only this engsys's msg\.mjs/);
  assert.throws(() => guardCommand(["node", "/tmp/msg.mjs", "send"]), /only this engsys's msg\.mjs/);
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
    });
    await s.baton.startup();
    return { r: await b.guard(argv, { pr }), calls };
  };
  const ok = await run(["git", "-C", "../wt", "push", "--force-with-lease", "origin", "HEAD:refs/heads/agent/1-x"]);
  assert.equal(ok.r.result.code, "ran");
  assert.deepEqual(ok.calls[0], { cmd: "git", args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-C", "../wt", "push", "--force-with-lease", "origin", "HEAD:refs/heads/agent/1-x"] });
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
  const run = async (argv, { exists = false, defaultBranch = "main" } = {}) => {
    const w = world();
    const calls = [];
    const s = session(w);
    const b = createBaton({
      lease: s.lease, repo: REPO, role: "maintain", holder: "alice:acme-maintain", run: "run-1", store: createStateStore({ stateDir: s.stateDir, role: "maintain" }), home: async () => HOME, now: () => w.local.t,
      mergeApi: { request: async (m, p) => (p === `/repos/${REPO}` ? { status: 200, json: { default_branch: defaultBranch } } : p.startsWith(`/repos/${REPO}/git/ref/heads/`) ? { status: exists ? 200 : 404, json: {} } : { status: 404, json: {} }) },
      spawn: async (cmd, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
      remoteUrl: async () => `git@github.com:${REPO}.git`,
    });
    await b.startup();
    return { r: await b.guard(argv, { newBranch: true }), calls };
  };
  const ok = await run(["git", "-C", "../wt", "push", "origin", "HEAD:refs/heads/mnt/fix-1"]);
  assert.equal(ok.r.result.code, "ran");
  assert.deepEqual(ok.calls[0].slice(-3), ["push", "origin", "HEAD:refs/heads/mnt/fix-1"]);
  assert.match((await run(["git", "push", "origin", "mnt/fix-1"], { exists: true })).r.result.reason, /already exists/);
  assert.match((await run(["git", "push", "--force-with-lease", "origin", "mnt/fix-1"])).r.result.reason, /no --force-with-lease/);
  assert.match((await run(["git", "push", "origin", "trunk"], { defaultBranch: "trunk" })).r.result.reason, /default branch/);
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
