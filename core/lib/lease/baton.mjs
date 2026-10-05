#!/usr/bin/env node
// baton.mjs — a monster's singleton role (merge, maintain) held through the github lease, with the
// caller rule from the engsys#64 review built in. Merge Monster and Maintenance Monster call it
// through their skill scripts (mm-baton.sh / mnt-baton.sh, mm-watch.sh / mnt-watch.sh,
// mm-heartbeat.sh / mnt-heartbeat.sh); the fleet supervisor calls `supervise`. Design:
// docs/multi-fleet.md § 2 (Caller rule, Handover); the lease itself: github-backend.mjs next to this.
//
// ## The caller rule, and where each part lives
//
//   TTL 10 min, renew every <= 3m20s     TTL_MINUTES, RENEW_EVERY_MS; `keepalive` renews every
//                                        KEEPALIVE_EVERY_MS (2.5 min), `renew` on every heartbeat tick
//   lost -> stop, alert once, exit       onLost(): a sticky `baton-<role>.lost` marker created with
//                                        O_EXCL (whoever creates it sends the one alert); every later
//                                        op refuses without touching the network; the token is never
//                                        used again
//   local deadline                       recordGood(): Date.now() at the START of the last good
//                                        renew/assertHeld + its expiresInMs - 2 s. Date.now(), never a
//                                        monotonic clock (it stops while the machine sleeps)
//   fence before every mutating act      fence(): assertHeld(minRemainingMs 60 s) AND the local
//                                        deadline AND the post-takeover wait
//   merge                                merge(): fence, re-check < 30 s since the fence STARTED right
//                                        before sending, PUT /pulls/{n}/merge with sha=<validated head>,
//                                        30 s request timeout, never retried
//   after tookOverExpired/Malformed      notBeforeMs = acquire return + 60 s; fence refuses until then
//   heldBySelf / error are never held    startup reports `wait_self` / `error` with act:false; fence
//                                        is held only on assertHeld `held: true`
//   release wasExpired -> incident       release(): a `fleet notify --level alert` incident
//
// ## The token never outlives its session
//
// The fencing token is written to `<state-dir>/baton-<role>.json` (0600) so the next shell call of
// the SAME session can renew and fence with it. It is bound to the holder (`<fleet>:<session>`) and to
// the launch (`ENGSYS_SESSION_RUN`, set per launch by launch-agent-sessions.sh): an op from another
// holder or another launch refuses it, and `startup` of a new launch archives whatever an earlier one
// left, unread. A new session therefore never acts on its predecessor's token: if that predecessor's
// baton is still live it sees `wait_self` and waits out the TTL.
//
// ## Holder
//
// `<FLEET_ID>:<session>`, or `<hostname>:<session>` in single-fleet mode (no FLEET_ID), so even one
// fleet gets the lease's protection against an accidental second session. The session name comes from
// --session, else ENGSYS_SESSION (the launcher exports it).
//
// ## Ops (CLI: one JSON object on stdout; `guard` passes its command's own output through)
//
//   startup    home check, then acquire when free/expired and home        exit 0 act | 1 don't | 3 | 4
//   renew      [--if-due 150s] renew with the session's token             exit 0 | 1 lost | 3 | 5
//   keepalive  [--pulse-max 20m] renew loop for the watch bus; prints BATON_* events
//   fence      the check before a mutating act                            exit 0 held | 1 | 3 | 5
//   guard -- <gh …|gate-request.sh …>   fence, then run the command (30 s timeout)
//   merge      --pr N --sha S --method merge|squash|rebase                exit 0 merged | 1 | 3
//   release    [--reason rotation|exit|handover]                          exit 0 | 1 lost | 3
//   status     lease + local view (never the token)
//   supervise  the fleet supervisor's relaunch decision                   exit 0 may | 1 no | 3 error
//
// Common flags: --repo o/r --role merge|maintain --state-dir DIR [--session NAME]. Exit codes extend
// github-backend's: 0 ok, 1 refused, 2 usage, 3 error, 4 newer protocol, 5 not started (no token in
// this session).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT as LEASE_EXIT, HOLDER_PATTERN, LeaseUsageError, PROTOCOL, createGithubLease, githubFetchClient, resolveToken } from "./github-backend.mjs";

export const ROLES = Object.freeze(["merge", "maintain"]);
export const TTL_MINUTES = 10;
/** The longest a holder may go between renews: TTL/3. */
export const RENEW_EVERY_MS = 200_000;
/** keepalive's cadence: under RENEW_EVERY_MS with room for a slow request. */
export const KEEPALIVE_EVERY_MS = 150_000;
/** keepalive's retry after a renew error (the local deadline still bounds every act). */
export const KEEPALIVE_RETRY_MS = 30_000;
/**
 * keepalive stops renewing when the model has not touched the baton for this long (the SKILLs tick at
 * most every 10 minutes while holding, and every tick renews), so a wedged session forfeits its role
 * within ~30 minutes instead of an hour.
 */
export const DEFAULT_PULSE_MAX_MS = 20 * 60_000;
/** A fence passes only with at least this much lease left (the act's 30 s timeout + slack). */
export const FENCE_MIN_REMAINING_MS = 60_000;
/** Every fenced send must start within this long of the fence's start ... */
export const SEND_WINDOW_MS = 30_000;
/** ... and is bounded by this timeout. */
export const ACTION_TIMEOUT_MS = 30_000;
/** Subtracted from every local deadline. */
export const DEADLINE_SLACK_MS = 2_000;
/** After taking over an expired or malformed baton: no mutating act for this long. */
export const TAKEOVER_WAIT_MS = 60_000;

export const EXIT = Object.freeze({ ...LEASE_EXIT, NOT_STARTED: 5 });

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------------ pure helpers --

/** A hostname as a fleet id for the holder: lowercase, first label only, `[a-z][a-z0-9-]{0,31}`. */
export function hostSlug(raw) {
  const s = String(raw ?? "").toLowerCase().split(".")[0]
    .replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
  return s || "host";
}

/** The holder address for this session: `<FLEET_ID or host>:<session>`. Throws LeaseUsageError. */
export function holderFor({ env = process.env, session, hostname = osHostname() } = {}) {
  const name = session || env.ENGSYS_SESSION;
  if (!name) throw new LeaseUsageError("no session name: pass --session <name>, or run inside a launched session (ENGSYS_SESSION)");
  const fleet = env.FLEET_ID || hostSlug(hostname);
  const holder = `${fleet}:${name}`;
  if (!HOLDER_PATTERN.test(holder)) throw new LeaseUsageError(`holder ${JSON.stringify(holder)} must match ${HOLDER_PATTERN}`);
  return { holder, fleet, session: name, fleetMode: Boolean(env.FLEET_ID) };
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0];
}

/** Process names skipped when walking up to the session (the claude process). */
const WRAPPER_PROCESSES = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh", "env", "timeout", "nohup", "login"]);

/** ps for one pid -> { ppid, start, comm } or null. */
function defaultPs(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/.exec(out);
    return m ? { ppid: Number(m[1]), start: m[2].replace(/\s+/g, " "), comm: m[3] } : null;
  } catch {
    return null;
  }
}

/**
 * The session process this call runs under: the first ancestor of `startPid` that is not a shell
 * wrapper (the Bash tool's shell, a watch bus, `bash script.sh`). For a monster that is the claude
 * process, which lives exactly as long as the session. -> { pid, start } or null (pid 1 reached, or
 * ps unavailable). `start` (the process start time) tells a live session from a reused pid.
 */
export function sessionProcess({ startPid = process.ppid, ps = defaultPs } = {}) {
  let pid = Number(startPid);
  for (let i = 0; i < 16 && pid > 1; i += 1) {
    const info = ps(pid);
    if (!info) return null;
    if (!WRAPPER_PROCESSES.has(basename(info.comm).replace(/^-/, ""))) return { pid, start: info.start };
    pid = info.ppid;
  }
  return null;
}

/** True while the process `{pid, start}` is the same live process. */
export function sameProcessAlive(proc, ps = defaultPs) {
  const info = ps(proc.pid);
  return Boolean(info && info.start === proc.start);
}

/**
 * Is this fleet the role's home? Resolves (never throws):
 *   { ok:true, mode:"single", isHome:true }                 no FLEET_ID, or no federation file
 *   { ok:true, mode:"multi", isHome, home }                 the registry names a home
 *   { ok:true, mode:"multi", isHome:true, undeclared:true }  the registry declares no home for the role:
 *                                                           the lease alone decides (host-roles.sh
 *                                                           does not auto-exclude such a session either)
 *   { ok:true, mode:"multi", isHome:false, disabled:true }  fleets.<FLEET_ID>.enabled: false
 *   { ok:false, mode:"multi", reason }                      unreadable/invalid registry, FLEET_ID not
 *                                                           declared: fail closed (never acquire)
 */
export async function homeCheck({ env = process.env, repo, role, cwd = process.cwd(), federation } = {}) {
  if (!env.FLEET_ID) return { ok: true, mode: "single", isHome: true, reason: "FLEET_ID not set: single-fleet mode" };
  let fed = federation;
  if (!fed) {
    try {
      fed = await import("../../fleet/lib/federation.mjs");
    } catch (e) {
      return { ok: false, mode: "multi", reason: `cannot load the federation reader: ${firstLine(e.message)}` };
    }
  }
  const file = fed.resolveFederationFile(env, cwd);
  let reg;
  try {
    reg = fed.loadFederation(file);
  } catch (e) {
    return { ok: false, mode: "multi", file, reason: firstLine(e.message) };
  }
  if (!reg) return { ok: true, mode: "single", isHome: true, file, reason: `no federation file (${file}): single-fleet mode` };
  const problems = fed.fleetIdProblems(reg, env.FLEET_ID);
  if (problems.length) return { ok: false, mode: "multi", file, reason: problems.join("; ") };
  const home = fed.roleHome(reg, repo, role);
  if (reg.fleets[env.FLEET_ID]?.enabled === false) {
    return { ok: true, mode: "multi", isHome: false, disabled: true, home, file, reason: `fleet ${env.FLEET_ID} is disabled in the registry` };
  }
  if (!home) return { ok: true, mode: "multi", isHome: true, undeclared: true, home: null, file, reason: `repos.${repo}.${role} declares no home: the lease alone decides` };
  return { ok: true, mode: "multi", isHome: home === env.FLEET_ID, home, file, reason: `${role} home for ${repo} is fleet ${home}` };
}

/**
 * The fleet supervisor's relaunch decision for a singleton monster (pure). Relaunch only when this
 * fleet is home AND nobody holds a live baton: free (no ref, or released), expired, or malformed with
 * a protocol this code can take over. A live baton held by anyone, this fleet's own session included,
 * is a wait: a relaunched session could not act on it (its token died with the old session). Any read
 * problem fails closed (no relaunch; the supervisor alerts once).
 *   -> { relaunch: boolean, code, reason, holder? }   code: free | expired | malformed | held_self |
 *      held_elsewhere | not_home | error
 */
export function supervisorDecision({ home, status, ownHolder }) {
  if (!home?.ok) return { relaunch: false, code: "error", reason: `registry: ${home?.reason ?? "unknown"}` };
  if (!home.isHome) return { relaunch: false, code: "not_home", reason: home.reason };
  if (!status || status.state === "error") return { relaunch: false, code: "error", reason: `baton unreadable: ${status?.failure?.message ?? status?.failure?.code ?? "no status"}` };
  if (status.state === "free") return { relaunch: true, code: "free", reason: status.released ? `baton released by ${status.releasedBy}` : "no baton" };
  if (status.state === "held") {
    const self = status.holder === ownHolder;
    return { relaunch: false, code: self ? "held_self" : "held_elsewhere", holder: status.holder, reason: `baton held by ${status.holder} until ${status.expiresAt}` };
  }
  // unknown: expired or malformed
  const protocol = status.protocol;
  if (typeof protocol === "number" && protocol > PROTOCOL) {
    return { relaunch: false, code: "error", reason: `baton protocol ${protocol} is newer than ${PROTOCOL}: sync engsys on this host first` };
  }
  if (status.expired) return { relaunch: true, code: "expired", holder: status.holder, reason: `baton of ${status.holder} expired ${status.expiresAt}` };
  if (status.malformed) return { relaunch: true, code: "malformed", reason: `baton tip is malformed (${status.reason}); the monster takes it over loudly` };
  return { relaunch: false, code: "error", reason: `baton state ${JSON.stringify(status.state)} not understood` };
}

// -------------------------------------------------------------------------------- local state --

/**
 * The session's baton state in `<stateDir>`:
 *   baton-<role>.json    { holder, run, token, deadlineMs, notBeforeMs, ... }   (0600, atomic rename)
 *   baton-<role>.lost    sticky: created once with O_EXCL, never cleared by this session
 *   baton-<role>.notice  the last info notice sent (so a standby tick does not repeat it)
 */
export function createStateStore({ stateDir, role }) {
  if (!stateDir) throw new LeaseUsageError("--state-dir is required");
  const file = join(stateDir, `baton-${role}.json`);
  const lostFile = join(stateDir, `baton-${role}.lost`);
  const noticeFile = join(stateDir, `baton-${role}.notice`);
  const ensureDir = () => mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = join(stateDir, `baton-${role}.lock`);
  /** mkdir lock: up to ~3 s of waiting; a lock older than 10 s is a crashed writer and is broken. */
  const withLock = (fn) => {
    ensureDir();
    for (let i = 0; ; i += 1) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let age = 0;
        try { age = Date.now() - statSync(lockDir).mtimeMs; } catch { continue; }
        if (age > 10_000) { try { rmdirSync(lockDir); } catch { /* raced */ } continue; }
        if (i >= 300) throw new Error(`baton state lock ${lockDir} is held`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); } finally { try { rmdirSync(lockDir); } catch { /* gone */ } }
  };
  const readJson = (f) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      return { corrupt: true, reason: String(e.message) };
    }
  };
  const writeJson = (f, value) => {
    ensureDir();
    const tmp = `${f}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, f);
  };
  return {
    file,
    lostFile,
    load: () => readJson(file),
    save: (state) => writeJson(file, state),
    /**
     * Read-modify-write under a lock (a keepalive and the model's calls run in separate processes);
     * `fn` returns the next state or null to leave the file alone.
     */
    update(fn) {
      return withLock(() => {
        const next = fn(readJson(file));
        if (next) writeJson(file, next);
        return next;
      });
    },
    lost: () => readJson(lostFile),
    /** true only for the caller that created the marker: that caller sends the one alert. */
    markLost(info) {
      ensureDir();
      let fd;
      try {
        fd = openSync(lostFile, "wx", 0o600);
      } catch (e) {
        if (e.code === "EEXIST") return false;
        throw e;
      }
      try { writeSync(fd, `${JSON.stringify(info)}\n`); } finally { closeSync(fd); }
      return true;
    },
    /** Move an earlier session's files aside, unread. */
    archive(stamp) {
      const moved = [];
      for (const f of [file, lostFile]) {
        if (existsSync(f)) { renameSync(f, `${f}.prev-${stamp}`); moved.push(basename(f)); }
      }
      return moved;
    },
    notice: () => readJson(noticeFile),
    setNotice: (value) => writeJson(noticeFile, value),
  };
}

/** A state that carries a usable token for `holder` in launch `run`. */
function usable(state, holder, run) {
  if (!state || state.corrupt || !state.token) return { ok: false, code: "not_started", reason: state?.corrupt ? `state file unreadable: ${state.reason}` : "no baton token in this session" };
  if (state.holder !== holder) return { ok: false, code: "not_started", reason: `the token on disk belongs to ${state.holder}, not ${holder}` };
  if (run && state.run && state.run !== run) return { ok: false, code: "not_started", reason: "the token on disk belongs to an earlier launch of this session; run startup" };
  return { ok: true };
}

// ------------------------------------------------------------------------------------ notify --

function defaultNotify({ env = process.env, err = process.stderr } = {}) {
  const custom = env.BATON_NOTIFY_CMD;
  return ({ level, incident, text }) => new Promise((resolveNotify) => {
    const args = ["--level", level, ...(incident ? ["--incident", incident] : []), text];
    const [cmd, ...pre] = custom ? custom.split(/\s+/).filter(Boolean) : ["fleet", "notify"];
    execFile(cmd, [...pre, ...args], { env, timeout: 30_000 }, (e) => {
      if (e) err.write(`baton: notify failed (${firstLine(e.message)}): [${level}${incident ? ` ${incident}` : ""}] ${text}\n`);
      resolveNotify(!e);
    });
  });
}

// ----------------------------------------------------------------------------- the baton --

/**
 * One session's baton for one role. Every collaborator is injectable for tests:
 *   lease     a createGithubLease() instance
 *   store     createStateStore()
 *   home      async () => homeCheck() result
 *   now       LOCAL wall clock (Date.now): deadlines and the send window only, never expiry
 *   notify    async ({level, incident, text}) => boolean
 *   mergeApi  { request(method, path, body) } with a 30 s timeout (default: githubFetchClient)
 *   spawn     (cmd, args, {timeout}) => Promise<{code, stdout, stderr, timedOut}>
 *   prepare   async () => void: resolve the API token; called once an op is past its offline checks
 */
export function createBaton({ lease, repo, role, holder, run = null, store, home, now = Date.now, notify = async () => false, mergeApi, spawn, sleep, prepare = null, log = () => {} }) {
  if (!ROLES.includes(role)) throw new LeaseUsageError(`role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) throw new LeaseUsageError(`invalid repo ${JSON.stringify(repo)}`);
  const sleepFn = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const iso = (ms) => new Date(ms).toISOString();

  /** Send an info/alert notice once per distinct key (the standby tick repeats startup). */
  async function noticeOnce(key, level, incident, text) {
    const last = store.notice();
    if (last?.key === key) return false;
    const sent = await notify({ level, incident, text });
    store.setNotice({ key, at: iso(now()), sent });
    return true;
  }

  async function onLost(result, where) {
    const first = store.markLost({ at: iso(now()), code: result.code, holder: result.holder ?? null, where });
    if (first) {
      const by = result.holder && result.holder !== "none" ? ` (the tip now names ${result.holder})` : "";
      await notify({
        level: "alert",
        incident: `baton-lost-${role}`,
        text: `${holder} lost the ${role} baton for ${repo} (${result.code}${by}) during ${where}. It stopped mutating at once and will not act again in this session; the supervisor relaunches the role where it is home.`,
      });
    }
    return { ok: false, held: false, lost: true, code: result.code, role, holder, ...(result.holder ? { tipHolder: result.holder } : {}), alerted: first, reason: "baton lost: stop now, no further mutations" };
  }

  /** Record a good renew/assertHeld that STARTED at startMs; only onto the same token. */
  function recordGood(token, startMs, expiresInMs, extra = {}) {
    store.update((s) => (s && s.token === token
      ? { ...s, deadlineMs: startMs + expiresInMs - DEADLINE_SLACK_MS, lastGoodStartMs: startMs, ...extra }
      : null));
  }

  function localView(state) {
    const t = now();
    return {
      deadlineInMs: state?.deadlineMs !== undefined ? state.deadlineMs - t : null,
      ...(state?.notBeforeMs && state.notBeforeMs > t ? { notBeforeInMs: state.notBeforeMs - t } : {}),
    };
  }

  /** Everything a fence checks before it spends a request. Returns a refusal or null. */
  function precheck() {
    const lost = store.lost();
    if (lost) return { exit: EXIT.REFUSED, result: { held: false, lost: true, code: "lost_earlier", role, holder, lostAt: lost.at, reason: "this session lost the baton; it never acts again" } };
    const state = store.load();
    const u = usable(state, holder, run);
    if (!u.ok) return { exit: EXIT.NOT_STARTED, result: { held: false, code: u.code, role, holder, reason: u.reason } };
    const t = now();
    if (state.notBeforeMs && t < state.notBeforeMs) {
      return { exit: EXIT.REFUSED, result: { held: false, code: "takeover_wait", role, holder, waitMs: state.notBeforeMs - t, reason: `took over an expired/malformed baton: no mutating act before ${iso(state.notBeforeMs)}` } };
    }
    if (!(t < state.deadlineMs)) {
      return { exit: EXIT.REFUSED, result: { held: false, code: "local_deadline", role, holder, overByMs: t - state.deadlineMs, reason: "past the local deadline (no good renew in time): run renew; never act on a lease you cannot vouch for" } };
    }
    return { state };
  }

  // -- startup -------------------------------------------------------------------------------

  async function startup() {
    const h = await home();
    const state = store.load();
    // Same launch, token on disk, not lost: a re-run of startup after a /clear. Verify by renewing.
    if (run && state?.run === run && usable(state, holder, run).ok && !store.lost()) {
      const r = await renew({ source: "model" });
      if (r.result.ok) return { exit: EXIT.OK, result: { act: true, decision: "resumed", role, holder, ...pick(r.result, ["expiresAt", "deadlineInMs", "handover"]) } };
      return { exit: r.exit, result: { act: false, decision: r.result.lost ? "lost" : "error", ...r.result } };
    }
    // A new session: anything on disk belongs to an earlier one and is never read for its token.
    const archived = store.archive(String(now()));
    if (!h.ok) {
      await noticeOnce(`registry:${h.reason}`, "alert", `baton-registry-${role}`, `${holder} will not take the ${role} baton for ${repo}: the federation registry can't be read (${h.reason}). Fix federation.yml by PR (fleet federation validate).`);
      return { exit: EXIT.ERROR, result: { act: false, decision: "registry_error", role, holder, reason: h.reason, archived } };
    }
    if (!h.isHome) {
      await noticeOnce(`not_home:${h.home}`, "info", null, `${holder} is not the ${role} home for ${repo} (${h.reason}); standing down without touching the baton.`);
      return { exit: EXIT.REFUSED, result: { act: false, decision: "not_home", role, holder, home: h.home ?? null, reason: h.reason, archived } };
    }
    await prepare?.();
    const s = await lease.status({ role });
    if (s.state === "error") return { exit: EXIT.ERROR, result: { act: false, decision: "error", role, holder, failure: s.failure, archived } };
    if (s.state === "held") return standDown(s.holder, s.expiresAt, archived, h);
    if (s.protocolSupported === false || (typeof s.protocol === "number" && s.protocol > PROTOCOL)) {
      await noticeOnce(`protocol:${s.protocol}`, "alert", `baton-protocol-${role}`, `${holder} will not take the ${role} baton for ${repo}: its protocol ${s.protocol} is newer than this engsys (${PROTOCOL}). Sync engsys on this host.`);
      return { exit: EXIT.PROTOCOL, result: { act: false, decision: "protocol_unsupported", role, holder, protocol: s.protocol, archived } };
    }
    const startMs = now();
    const r = await lease.acquire({ role, holder, ttlMinutes: TTL_MINUTES });
    if (r.ok) {
      const back = now();
      const tookOver = Boolean(r.tookOverExpired || r.tookOverMalformed);
      store.save({
        v: 1,
        role,
        repo,
        holder,
        run,
        token: r.record.token,
        acquiredAt: r.acquiredAt ?? null,
        expiresAt: r.expiresAt,
        deadlineMs: startMs + r.expiresInMs - DEADLINE_SLACK_MS,
        lastGoodStartMs: startMs,
        lastRenewOkMs: back,
        pulseMs: back,
        notBeforeMs: tookOver ? back + TAKEOVER_WAIT_MS : 0,
        ...(tookOver ? { tookOver: r.tookOverExpired ? "expired" : "malformed", previous: r.previous ?? null } : {}),
      });
      store.setNotice({ key: "holding", at: iso(back) });
      return {
        exit: EXIT.OK,
        result: {
          act: true,
          decision: "acquired",
          role,
          holder,
          mode: h.mode,
          home: h.home ?? null,
          expiresAt: r.expiresAt,
          ...(tookOver ? { tookOver: r.tookOverExpired ? "expired" : "malformed", previous: r.previous ?? null, notBefore: iso(back + TAKEOVER_WAIT_MS), reason: "took over a dead holder's baton: no mutating act for 60 s, so its in-flight act has finished or failed" } : {}),
          archived,
        },
      };
    }
    if (r.code === "held") return standDown(r.holder, r.expiresAt, archived, h, r.heldBySelf);
    if (r.code === "protocol_unsupported") return { exit: EXIT.PROTOCOL, result: { act: false, decision: "protocol_unsupported", role, holder, protocol: r.protocol, archived } };
    return { exit: EXIT.ERROR, result: { act: false, decision: "error", role, holder, reason: r.reason, failure: r.failure, archived } };
  }

  async function standDown(tipHolder, expiresAt, archived, h, heldBySelf = tipHolder === holder) {
    if (heldBySelf) {
      return { exit: EXIT.REFUSED, result: { act: false, decision: "wait_self", role, holder, expiresAt, reason: "the baton carries this session's name with a token this session does not have (an earlier launch, or a second process): never held; wait for it to expire, then run startup again", archived } };
    }
    await noticeOnce(`held:${tipHolder}`, "info", null, `${holder} found the ${role} baton for ${repo} held by ${tipHolder} (until ${expiresAt}); not acting.`);
    return { exit: EXIT.REFUSED, result: { act: false, decision: "held_elsewhere", role, holder, tipHolder, expiresAt, isHome: h.isHome, reason: h.isHome ? "home, but another holder has a live baton: stand by and run startup again on the next tick" : "not acting", archived } };
  }

  // -- renew -----------------------------------------------------------------------------------

  async function renew({ source = "model", ifDueMs = 0 } = {}) {
    const lost = store.lost();
    if (lost) return { exit: EXIT.REFUSED, result: { ok: false, lost: true, code: "lost_earlier", role, holder, lostAt: lost.at } };
    const state = store.load();
    const u = usable(state, holder, run);
    if (!u.ok) return { exit: EXIT.NOT_STARTED, result: { ok: false, code: u.code, role, holder, reason: u.reason } };
    const pulse = source === "model" ? { pulseMs: now() } : {};
    if (ifDueMs && now() - (state.lastRenewOkMs ?? 0) < ifDueMs) {
      if (pulse.pulseMs) store.update((s) => (s && s.token === state.token ? { ...s, ...pulse } : null));
      return { exit: EXIT.OK, result: { ok: true, code: "not_due", role, holder, ...localView(state) } };
    }
    await prepare?.();
    const startMs = now();
    const r = await lease.renew({ role, token: state.token, ttlMinutes: TTL_MINUTES, holder });
    if (r.ok) {
      recordGood(state.token, startMs, r.expiresInMs, { lastRenewOkMs: now(), expiresAt: r.expiresAt, ...pulse });
      const h = await home();
      const handover = h.ok && h.mode === "multi" && !h.isHome ? { home: h.home ?? null, reason: h.reason } : null;
      return { exit: EXIT.OK, result: { ok: true, code: "renewed", role, holder, expiresAt: r.expiresAt, ...localView(store.load()), ...(handover ? { handover } : {}), ...(h.ok ? {} : { registryWarning: h.reason }) } };
    }
    if (r.lost) {
      // A release by this session that landed first is not a loss.
      const again = store.load();
      if (!again || again.token !== state.token || again.releasing) return { exit: EXIT.NOT_STARTED, result: { ok: false, code: "released", role, holder } };
      return { exit: EXIT.REFUSED, result: await onLost(r, `renew (${source})`) };
    }
    store.update((s) => (s && s.token === state.token ? { ...s, lastRenewErrorMs: now(), ...pulse } : null));
    return { exit: r.code === "protocol_unsupported" ? EXIT.PROTOCOL : EXIT.ERROR, result: { ok: false, code: r.code, role, holder, reason: r.reason, failure: r.failure, ...localView(state) } };
  }

  // -- fence -----------------------------------------------------------------------------------

  async function fence() {
    const pre = precheck();
    if (!pre.state) return pre;
    const { state } = pre;
    await prepare?.();
    const startMs = now();
    const r = await lease.assertHeld({ role, token: state.token, minRemainingMs: FENCE_MIN_REMAINING_MS });
    if (r.held) {
      recordGood(state.token, startMs, r.expiresInMs, { pulseMs: now() });
      return { exit: EXIT.OK, result: { held: true, code: "held", role, holder, fenceStartedMs: startMs, expiresInMs: r.expiresInMs, ...localView(store.load()) } };
    }
    if (r.code === "lost" || r.code === "not_held" || r.code === "protocol_unsupported") {
      return { exit: EXIT.REFUSED, result: await onLost(r, "fence") };
    }
    if (r.code === "expired") {
      return { exit: EXIT.REFUSED, result: { held: false, code: r.expiresInMs > 0 ? "low_remaining" : "expired", role, holder, expiresInMs: r.expiresInMs, reason: "under 60 s of lease left: run renew (it reports lost if the lease is gone), then fence again" } };
    }
    return { exit: EXIT.ERROR, result: { held: false, code: "error", role, holder, reason: r.reason ?? "fence read failed", failure: r.failure } };
  }

  /** Fence, then `send()` only if the fence STARTED < SEND_WINDOW_MS ago and the deadline still holds. */
  async function fenced(send) {
    const f = await fence();
    if (!f.result.held) return { exit: f.exit, result: { ...f.result, sent: false } };
    const elapsed = now() - f.result.fenceStartedMs;
    const state = store.load();
    if (elapsed >= SEND_WINDOW_MS || !(now() < (state?.deadlineMs ?? 0))) {
      return { exit: EXIT.REFUSED, result: { held: false, sent: false, code: "send_window", role, holder, elapsedMs: elapsed, reason: "too long between the fence and the send: nothing sent, fence again" } };
    }
    return send({ fenceStartedMs: f.result.fenceStartedMs, elapsedMs: elapsed });
  }

  // -- merge -----------------------------------------------------------------------------------

  async function merge({ pr, sha, method }) {
    if (!/^[1-9]\d{0,9}$/.test(String(pr ?? ""))) throw new LeaseUsageError("--pr must be a PR number");
    if (!SHA_PATTERN.test(String(sha ?? ""))) throw new LeaseUsageError("--sha must be the validated 40-hex head sha");
    if (!["merge", "squash", "rebase"].includes(method)) throw new LeaseUsageError("--method must be merge, squash or rebase");
    // Resolve the API token BEFORE the fence (minting it can take seconds, and nothing slow may sit
    // between the fence and the send), but only for a session that could act at all.
    const pre = precheck();
    if (!pre.state) return { exit: pre.exit, result: { ...pre.result, sent: false } };
    if (mergeApi.prepare) await mergeApi.prepare();
    return fenced(async ({ elapsedMs }) => {
      let res;
      try {
        res = await mergeApi.request("PUT", `/repos/${repo}/pulls/${pr}/merge`, { sha, merge_method: method });
      } catch (e) {
        return { exit: EXIT.ERROR, result: { merged: false, sent: true, code: "unknown", pr: Number(pr), sha, reason: `no answer (${firstLine(e?.message ?? e)}): re-snapshot the PR before deciding anything; never resend without a new fence` } };
      }
      const msg = res.json?.message ?? null;
      if (res.status === 200 && res.json?.merged) return { exit: EXIT.OK, result: { merged: true, sent: true, code: "merged", pr: Number(pr), sha, mergeSha: res.json.sha ?? null, sentAfterFenceMs: elapsedMs } };
      if (res.status === 409) return { exit: EXIT.REFUSED, result: { merged: false, sent: true, code: "head_moved", pr: Number(pr), sha, reason: msg ?? "the head is no longer the validated sha" } };
      if (res.status === 405 || res.status === 422) return { exit: EXIT.REFUSED, result: { merged: false, sent: true, code: "not_mergeable", pr: Number(pr), sha, status: res.status, reason: msg } };
      return { exit: EXIT.ERROR, result: { merged: false, sent: true, code: "unknown", pr: Number(pr), sha, status: res.status, reason: `${msg ?? "unexpected status"}: re-snapshot the PR before deciding anything` } };
    });
  }

  // -- guard -----------------------------------------------------------------------------------

  async function guard(argv) {
    const cmd = guardCommand(argv);
    return fenced(async ({ elapsedMs }) => {
      const r = await spawn(cmd.exe, cmd.args, { timeout: ACTION_TIMEOUT_MS });
      return {
        exit: r.timedOut ? EXIT.ERROR : r.code,
        result: { sent: true, code: r.timedOut ? "timeout" : "ran", exitCode: r.code, sentAfterFenceMs: elapsedMs, ...(r.timedOut ? { reason: "killed after 30 s: its effect is unknown; re-snapshot before acting again" } : {}) },
        stdout: r.stdout,
        stderr: r.stderr,
      };
    });
  }

  // -- release ---------------------------------------------------------------------------------

  async function release({ reason = "exit" } = {}) {
    if (store.lost()) return { exit: EXIT.OK, result: { ok: true, released: false, code: "lost_earlier", role, holder, reason: "nothing to release: the baton was lost earlier (its token is never used again)" } };
    const state = store.load();
    const u = usable(state, holder, run);
    if (!u.ok) return { exit: EXIT.OK, result: { ok: true, released: false, code: u.code, role, holder, reason: u.reason } };
    await prepare?.();
    // Mark the release first, so a keepalive renew answered between our CAS and the state write below
    // reads "released", not "lost" (no false alert, no sticky marker).
    store.update((s) => (s && s.token === state.token ? { ...s, releasing: iso(now()) } : null));
    const r = await lease.release({ role, token: state.token });
    if (!r.ok) store.update((s) => (s && s.token === state.token ? (({ releasing, ...rest }) => rest)(s) : null));
    if (r.ok) {
      store.update((s) => (s && s.token === state.token ? (({ releasing, ...rest }) => ({ ...rest, token: null, releasedAt: iso(now()), releaseReason: reason }))(s) : null));
      if (r.wasExpired) {
        await notify({
          level: "alert",
          incident: `baton-overrun-${role}`,
          text: `${holder} released the ${role} baton for ${repo} (${reason}) after its TTL had run out: for a while nobody held the role while this session thought it did. Check its journal for acts after the expiry.`,
        });
      }
      return { exit: EXIT.OK, result: { ok: true, released: r.released, code: r.code, role, holder, reason, ...(r.wasExpired ? { wasExpired: true, incident: `baton-overrun-${role}` } : {}) } };
    }
    if (r.lost) return { exit: EXIT.REFUSED, result: await onLost(r, `release (${reason})`) };
    return { exit: r.code === "protocol_unsupported" ? EXIT.PROTOCOL : EXIT.ERROR, result: { ok: false, code: r.code, role, holder, reason: r.reason, failure: r.failure } };
  }

  // -- status / supervise ----------------------------------------------------------------------

  async function status() {
    await prepare?.();
    const [s, h] = [await lease.status({ role }), await home()];
    const state = store.load();
    const lost = store.lost();
    const holding = !lost && usable(state, holder, run).ok;
    return {
      exit: s.state === "error" ? EXIT.ERROR : EXIT.OK,
      result: { role, holder, holding, ...(lost ? { lost: true, lostAt: lost.at } : {}), ...(holding ? localView(state) : {}), lease: s, home: h },
    };
  }

  async function supervise() {
    const h = await home();
    if (!h.ok || !h.isHome) return { exit: h.ok ? EXIT.REFUSED : EXIT.ERROR, result: { role, holder, ...supervisorDecision({ home: h, status: null, ownHolder: holder }) } };
    await prepare?.();
    const d = supervisorDecision({ home: h, status: await lease.status({ role }), ownHolder: holder });
    return { exit: d.relaunch ? EXIT.OK : d.code === "error" ? EXIT.ERROR : EXIT.REFUSED, result: { role, holder, ...d } };
  }

  // -- keepalive -------------------------------------------------------------------------------

  /**
   * The watch bus's renewer. Prints one line per event for the Monitor: BATON_LOST, BATON_HANDOVER
   * (once), BATON_RENEW_ERROR (once per error streak), BATON_IDLE (stopped: no model pulse). Stops
   * renewing, and returns, when: the lease is lost; the token is gone (released); its parent or its
   * session process (`owner`, the claude process found by sessionProcess(); an orphaned renewer must
   * never keep a dead session's baton alive, and an intermediate shell can outlive claude); or the
   * model has not touched the baton for `pulseMaxMs` (a live bus under a dead model, same reason).
   */
  async function keepalive({ out, owner = null, ownerAlive = owner ? () => sameProcessAlive(owner) : () => true, pulseMaxMs = DEFAULT_PULSE_MAX_MS, parentAlive = defaultParentAlive(), maxCycles = Infinity } = {}) {
    let announcedHandover = false;
    let erroring = false;
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      if (!parentAlive() || !ownerAlive()) { log("keepalive: its session is gone, stopping"); return EXIT.OK; }
      if (store.lost()) return EXIT.REFUSED;
      const state = store.load();
      if (!usable(state, holder, run).ok) return EXIT.OK;
      if (pulseMaxMs && now() - (state.pulseMs ?? 0) > pulseMaxMs) {
        // Said once per pulse: the bus restarts a stopped keepalive every poll.
        if (state.idleNotedFor !== (state.pulseMs ?? 0)) {
          store.update((s) => (s && s.token === state.token ? { ...s, idleNotedFor: state.pulseMs ?? 0 } : null));
          out(`BATON_IDLE ${role} no model activity for ${Math.round((now() - (state.pulseMs ?? 0)) / 60_000)}m: keepalive stopped renewing (the next model renew restarts it, or the lease runs out)`);
        }
        return EXIT.OK;
      }
      const r = await renew({ source: "keepalive" });
      if (r.result.lost) { out(`BATON_LOST ${role} ${r.result.code}`); return EXIT.REFUSED; }
      if (r.exit === EXIT.NOT_STARTED) return EXIT.OK;
      if (r.result.ok) {
        erroring = false;
        const to = r.result.handover?.home ?? null;
        if (r.result.handover && !announcedHandover && store.load()?.handoverNoted !== to) {
          store.update((s) => (s && s.token === state.token ? { ...s, handoverNoted: to } : null));
          out(`BATON_HANDOVER ${role} ${to ?? "none"}`);
          announcedHandover = true;
        }
      } else if (!erroring) {
        out(`BATON_RENEW_ERROR ${role} ${r.result.code}: retrying every ${KEEPALIVE_RETRY_MS / 1000}s; fences refuse once the local deadline passes`);
        erroring = true;
      }
      await sleepFn(r.result.ok ? KEEPALIVE_EVERY_MS : KEEPALIVE_RETRY_MS);
    }
    return EXIT.OK;
  }

  return { startup, renew, fence, merge, guard, release, status, supervise, keepalive };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function defaultParentAlive() {
  const initial = process.ppid;
  return () => process.ppid === initial && pidAlive(initial);
}

/**
 * What `guard` may run: `gh …` (never a merge of any form, which goes through `merge` and its sha
 * pin, and never `--admin`), `git [-C dir] push` for a PR branch (`--force-with-lease`, never a
 * force, delete, the default branch or refs/engsys), or this engsys's own gate-request.sh. The guard is a
 * fence, not a way around the permission system, so it runs nothing else.
 */
export function guardCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new LeaseUsageError("guard needs a command after --");
  let [exe, ...args] = argv;
  if (exe === "bash" && args.length) [exe, ...args] = args;
  if (exe === "gh") {
    if (args.includes("--admin")) throw new LeaseUsageError("guard never runs --admin");
    // Matched loosely on purpose (flags such as -R o/r can sit anywhere): any `pr … merge` or API
    // path to a merge endpoint is refused.
    if ((args.includes("pr") && args.includes("merge")) || args.some((a) => /\/merges?\b|mergePullRequest|enablePullRequestAutoMerge|mergeBranch/.test(a))) {
      throw new LeaseUsageError("merges go through `merge --pr N --sha <validated head> --method …`, never gh under guard (no merge endpoint, placeholder path or GraphQL merge mutation)");
    }
    return { exe: "gh", args };
  }
  if (exe === "git") {
    // A push for a PR branch, prepared by a dispatched agent and sent by the monster under the fence.
    let i = 0;
    const pre = [];
    while (args[i] === "-C" && args[i + 1]) { pre.push("-C", args[i + 1]); i += 2; }
    if (args[i] !== "push") throw new LeaseUsageError("guard runs `git [-C dir] push …` only");
    const rest = args.slice(i + 1);
    const bad = rest.find((a) => a === "--force" || a === "-f" || /^-[a-zA-Z]*f/.test(a) && !a.startsWith("--") || a === "--mirror" || a === "--all" || a === "--tags"
      || a === "--delete" || a === "-d" || a.startsWith("+") || /refs\/engsys\//.test(a) || /(^|:)(refs\/heads\/)?(main|master)$/.test(a));
    if (bad) throw new LeaseUsageError(`guard refuses git push ${bad}: --force-with-lease to a PR branch only, never a force, a delete, the default branch or refs/engsys`);
    return { exe: "git", args: [...pre, "push", ...rest] };
  }
  if (basename(exe) === "gate-request.sh") {
    const own = resolve(HERE, "..", "..", "skills", "merge-monster", "scripts", "gate-request.sh");
    let real;
    try { real = realpathSync(exe); } catch { real = null; }
    let ownReal;
    try { ownReal = realpathSync(own); } catch { ownReal = own; }
    if (real !== ownReal) throw new LeaseUsageError(`guard runs only this engsys's gate-request.sh (${own})`);
    return { exe: "bash", args: [real, ...args] };
  }
  throw new LeaseUsageError(`guard runs gh, git push or gate-request.sh only, not ${JSON.stringify(exe)}`);
}

function defaultSpawn(cmd, args, { timeout }) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout, killSignal: "SIGTERM", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && err.killed);
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
    });
  });
}

// ---------------------------------------------------------------------------------------- CLI --

const OPS = new Set(["startup", "renew", "keepalive", "fence", "guard", "merge", "release", "status", "supervise"]);

function usage() {
  return [
    "usage: baton.mjs <op> --repo o/r --role merge|maintain --state-dir DIR [--session NAME] [flags]",
    "  startup                         home check + acquire; exit 0 = act, 1 = do not act",
    "  renew      [--if-due 150s]      renew this session's baton",
    "  keepalive  [--pulse-max 20m]   renew loop for the watch bus (stops with its session)",
    "  fence                           exit 0 only while it is safe to mutate",
    "  guard -- gh <args…> | <engsys>/skills/merge-monster/scripts/gate-request.sh <args…>",
    "  merge      --pr N --sha <validated head> --method merge|squash|rebase",
    "  release    [--reason rotation|exit|handover]",
    "  status",
    "  supervise                       relaunch decision for the fleet supervisor (no --state-dir)",
    "env: ENGSYS_SESSION (session name), ENGSYS_SESSION_RUN (per launch), FLEET_ID, FEDERATION_FILE,",
    "     GH_TOKEN | GH_APP_ENV_FILE | gh auth token, BATON_NOTIFY_CMD (default: fleet notify)",
    "exit: 0 ok | 1 refused | 2 usage | 3 error | 4 newer protocol | 5 not started in this session",
  ].join("\n");
}

function parseArgs(argv) {
  const [op, ...rest] = argv;
  if (!op || !OPS.has(op)) throw new LeaseUsageError(`unknown or missing op ${JSON.stringify(op ?? "")}`);
  const flags = {};
  let command = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") { command = rest.slice(i + 1); break; }
    if (!arg.startsWith("--")) throw new LeaseUsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (name === "pretty") { flags.pretty = true; continue; }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new LeaseUsageError(`--${name} requires a value`);
    flags[name] = value;
    i += 1;
  }
  if (op === "guard" && !command) throw new LeaseUsageError("guard needs `-- <command>`");
  if (op !== "guard" && command) throw new LeaseUsageError(`${op} takes no command`);
  return { op, flags, command };
}

function durationMs(text, name) {
  const m = /^(\d+)(ms|s|m)?$/.exec(String(text));
  if (!m) throw new LeaseUsageError(`--${name}: use e.g. 150s, 45m or milliseconds`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? "ms"]);
}

/**
 * The CLI. `deps` injects collaborators for tests: { api, lease, mergeApi, notify, spawn, now, sleep,
 * env, cwd, hostname, out, err, federation, parentAlive }.
 */
export async function main(argv, deps = {}) {
  const { env = process.env, out = process.stdout, err = process.stderr, cwd = process.cwd() } = deps;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err.write(`baton: ${e.message}\n${usage()}\n`);
    return EXIT.USAGE;
  }
  const { op, flags, command } = parsed;
  const emit = (result) => out.write(`${JSON.stringify(result, null, flags.pretty ? 2 : 0)}\n`);
  try {
    if (!flags.repo || !REPO_PATTERN.test(flags.repo)) throw new LeaseUsageError("--repo owner/repo is required");
    if (!ROLES.includes(flags.role)) throw new LeaseUsageError(`--role must be one of ${ROLES.join(", ")}`);
    const { holder } = holderFor({ env, session: flags.session, hostname: deps.hostname ?? osHostname() });
    const stateDir = flags["state-dir"] ? resolve(cwd, flags["state-dir"]) : null;
    if (op !== "supervise" && !stateDir) throw new LeaseUsageError(`${op} needs --state-dir`);
    // The token is resolved once, by `prepare` (createBaton calls it only once an op is past its
    // offline checks, so a lost or tokenless session spends no request): minting one can take
    // seconds, and that time must never count against a fence read (5 s cap) or sit between a fence
    // and its send.
    let tokenP = null;
    const token = () => (tokenP ??= resolveToken({ env, owner: flags.repo.split("/")[0] }).then((t) => {
      if (!t) throw new Error("no GitHub token could be resolved (GH_TOKEN, GH_APP_ENV_FILE or gh auth token)");
      return t;
    }));
    let clientP = null;
    const client = () => (clientP ??= token().then((t) => githubFetchClient({ token: t })));
    const lease = deps.lease ?? createGithubLease({ repo: flags.repo, api: deps.api ?? { request: async (m, p, b) => (await client()).request(m, p, b) }, env });
    let mergeClientP = null;
    const mergeClient = () => (mergeClientP ??= token().then((t) => githubFetchClient({ token: t, timeoutMs: ACTION_TIMEOUT_MS, userAgent: "engsys-baton" })));
    const mergeApi = deps.mergeApi ?? {
      prepare: async () => { await mergeClient(); },
      async request(method, path, body) { return (await mergeClient()).request(method, path, body); },
    };
    const baton = createBaton({
      lease,
      repo: flags.repo,
      role: flags.role,
      holder,
      run: env.ENGSYS_SESSION_RUN || (deps.run !== undefined ? deps.run : fallbackRun(env)),
      store: stateDir ? createStateStore({ stateDir, role: flags.role }) : nullStore(),
      home: () => homeCheck({ env, repo: flags.repo, role: flags.role, cwd, federation: deps.federation }),
      now: deps.now ?? Date.now,
      notify: deps.notify ?? defaultNotify({ env, err }),
      mergeApi,
      spawn: deps.spawn ?? defaultSpawn,
      sleep: deps.sleep,
      prepare: deps.api || deps.lease ? null : async () => { await client(); },
      log: (s) => err.write(`baton: ${s}\n`),
    });
    let r;
    switch (op) {
      case "startup": r = await baton.startup(); break;
      case "renew": r = await baton.renew({ source: "model", ifDueMs: flags["if-due"] ? durationMs(flags["if-due"], "if-due") : 0 }); break;
      case "fence": r = await baton.fence(); break;
      case "merge": r = await baton.merge({ pr: flags.pr, sha: flags.sha, method: flags.method }); break;
      case "release": r = await baton.release({ reason: flags.reason ?? "exit" }); break;
      case "status": r = await baton.status(); break;
      case "supervise": r = await baton.supervise(); break;
      case "guard": {
        r = await baton.guard(command);
        if (r.stdout) out.write(r.stdout);
        if (r.stderr) err.write(r.stderr);
        err.write(`baton: ${JSON.stringify(r.result)}\n`);
        return r.exit;
      }
      case "keepalive":
        return await baton.keepalive({
          out: (line) => out.write(`${line}\n`),
          owner: deps.owner !== undefined ? deps.owner : sessionProcess({ startPid: env.BATON_WALK_FROM || process.ppid }),
          pulseMaxMs: flags["pulse-max"] ? durationMs(flags["pulse-max"], "pulse-max") : DEFAULT_PULSE_MAX_MS,
          ...(deps.parentAlive ? { parentAlive: deps.parentAlive } : {}),
          ...(deps.maxCycles ? { maxCycles: deps.maxCycles } : {}),
        });
      default: throw new LeaseUsageError(`unknown op ${op}`);
    }
    emit(r.result);
    return r.exit;
  } catch (e) {
    if (e instanceof LeaseUsageError) {
      err.write(`baton: ${e.message}\n${usage()}\n`);
      return EXIT.USAGE;
    }
    emit({ ok: false, code: "error", reason: String(e?.message ?? e) });
    return EXIT.ERROR;
  }
}

/**
 * The launch id when the launcher did not set ENGSYS_SESSION_RUN (a session started by hand): the
 * session process's pid and start time, constant for the session and different for its successor, so
 * a re-run of startup resumes its own token and a new session still never reads its predecessor's.
 * null when it can't be found (startup then always starts fresh).
 */
function fallbackRun(env) {
  const p = sessionProcess({ startPid: env.BATON_WALK_FROM || process.ppid });
  return p ? `pid:${p.pid}@${p.start}` : null;
}

/** `supervise` reads no local state. */
function nullStore() {
  return { load: () => null, lost: () => null, notice: () => null, setNotice() {}, save() {}, update() { return null; }, markLost() { return false; }, archive() { return []; } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
