#!/usr/bin/env node
// github-backend.mjs — the `github` lease backend: a compare-and-swap baton on a custom git ref.
//
// Zero-dependency ESM, Node >= 20 (global fetch). The cross-machine backend durable-lease.mjs
// anticipates ("Single host, single filesystem, single clock … cross-machine use needs a different
// backend behind the same API"): one holder per singleton role (merge, maintain) across every
// fleet working a repo. Design: docs/multi-fleet.md § 2. Spike that proved the semantics (engsys#43):
// github-ref-spike.mjs next to this file.
//
// ## How a baton is stored
//
// Each role is a ref `refs/engsys/batons/<role>` pointing at a commit with the EMPTY tree and a
// structured message. Nothing is ever checked out; the ref is not fetched by default clones and
// emits no events. The commit message is the whole record:
//
//   baton merge: alice:acme-mm until 2026-10-04T12:10:00.000Z   <- human line, never parsed
//
//   holder: alice:acme-mm      <fleet>:<session>, or `none` after a release
//   token: <uuid>              the fencing token minted at acquire
//   expires: <ISO8601Z>        server time; past this the lease is forfeit
//   protocol: 1                format version; see PROTOCOL
//   fleet: alice               the fleet that wrote this commit
//
// ## Why this is a correct lock (the two GitHub guarantees)
//
// 1. `POST /git/refs` fails with 422 when the ref already exists: the FIRST claim is exclusive.
// 2. `PATCH /git/refs/<ref>` with `force: false` succeeds only if the ref's current tip is an
//    ancestor of the new commit. Every mutation here builds its commit with `parents: [tip]` where
//    `tip` is the sha it just READ, so the PATCH is a compare-and-swap on that read: if anyone moved
//    the ref forward in between, the PATCH gets 422 ("Reference cannot be updated") and the caller
//    re-reads. The check is ancestry, not equality: since every writer here only fast-forwards, it
//    equals "the tip is still the one I read" unless someone force-pushed the ref BACK to an
//    ancestor meanwhile — and a force-pusher is inside the repo's own trust boundary (see Fencing).
//
// Every success path in this file is a CAS win (or, for the first claim, a successful create).
// There is no code path that reports "acquired" / "renewed" / "released" without the server having
// accepted exactly the commit this caller built on exactly the tip it read. The operator break-glass
// is a CAS too whenever the old tip is a readable commit; it falls back to `force: true` only for a
// tip the API cannot serve as a commit. It requires the inspected tip sha, and the fleet settings
// template denies the command to agent sessions (policy enforced by the harness, not by this file).
//
// Only refs under `refs/engsys/` are accepted, and a tip whose tree is not the empty tree is an
// error for every operation (never a takeover): an empty-tree child commit on a real branch would
// read as "delete everything", and the ancestry check would let it through.
//
// ## Clock
//
// Expiry math uses the GitHub API's `Date` response header (server time), NEVER the local clock as
// an absolute. Hosts across a federation therefore never compare their own clocks. Assumptions this
// rests on: GitHub's front ends keep one consistent clock (NTP; disagreement well under a second),
// and `Date` has 1-second resolution.
//
// Two uses, two rules:
// - DECISIONS about someone else's baton (is it expired? may I take it over?) use the `Date` of the
//   GET that observed the ref. That response is read AFTER the server stamped it, so the observed
//   time lags true server time: a reader sees a lease as live slightly longer than it is, which is
//   the conservative direction for a takeover. A new baton's `expires` is that server time + TTL.
// - NUMBERS handed to a HOLDER (remaining time from assertHeld / acquire / renew) must never
//   overstate. They use the LATEST `Date` header seen during the call (the last GET, or the CAS
//   response) minus the LOCAL wall-clock time elapsed since that response arrived — the local clock
//   measures a duration here, never an instant. Every request has a timeout, and a fence read that
//   took longer than `maxFenceReadMs` is refused outright (`slow_read`) rather than answered late.
// Callers still compensate with cadence: renew at <= TTL/3, pass the action's duration as
// `minRemainingMs` to assertHeld, and keep a local wall-clock deadline (Date.now, not a monotonic
// clock that stops during sleep) past which no mutating action is allowed.
//
// ## Fencing
//
// `assertHeld({role, token})` is one read: true only if the tip carries this caller's token and is
// unexpired by server time. A holder calls it immediately before every mutating act. Renew (CAS with
// the same token, new expiry) returns the distinct `lost: true` result on a CAS loss, a token
// mismatch, an expired tip or a missing ref: the holder MUST stop acting. There is no revival: a
// renew whose READ sees the baton expired fails even with the holder's own token; the holder
// re-acquires (a loud takeover of its own stale baton). A renew whose read saw the baton live may
// still LAND after the expiry instant; that is safe, because a taker that read after expiry built
// on the same tip and the CAS lets exactly one of them through.
//
// `heldBySelf` on a refusal means the tip carries this holder NAME with a token this caller does not
// have (a second process with our name, or an earlier acquire whose confirmation was lost). It is
// never "held": acting on it is exactly the duplicate the lease prevents.
//
// The token is not a secret (anyone who can read the ref can read it); it fences STALE holders,
// not hostile ones. Anyone with `contents: write` can force-push the ref. That is the same trust
// boundary as the repo itself and is not what this primitive defends against. The remedy for a
// hostile or wedged tip (a `protocol: 9999`, an expiry years out) is the operator break-glass.
//
// ## Untrusted input
//
// The commit message is parsed as untrusted data: a hostile or careless writer can put anything in
// a commit on that ref. Parsing is a strict line grammar (bounded size, known keys exactly once,
// anchored value patterns), never eval, never free text. A message that fails the grammar makes the
// baton `malformed`: a reader reports it, a renewer treats it as lost (its token is not on the tip),
// and an acquirer may take it over (a garbage tip is indistinguishable from a dead holder, as with a
// torn record in durable-lease). The one line that outlives versions is `protocol:`: a tip whose
// protocol is higher than PROTOCOL is refused for takeover and renew (`protocol_unsupported`), so a
// fleet running older code stays out of a role a newer fleet holds (docs/multi-fleet.md § 8).
//
// ## Failure
//
// Any status other than the ones a step expects is a failure, never a success. 5xx and transport
// errors (including the per-request timeout) retry with jittered backoff, bounded. A retried WRITE
// first re-reads the tip, and does so once more after its last failure: if the tip is already the
// commit this caller built, the write landed and the lost response is treated as the success it was;
// if the tip moved elsewhere, the caller lost; only an unchanged tip retries the PATCH/POST. So a
// retry can never double-apply, and a stale "did it land?" is never guessed. Acquire also remembers
// every token it minted: a later read showing one of them on the tip is a confirmed win, so an
// unconfirmed write never strands a baton for a TTL. 422 is a decision (someone moved the ref, or
// the ref exists): re-read, never resend. 429 and 403 secondary rate limits are errors like any other
// unexpected status (no Retry-After handling; the caller's heartbeat loop retries on its own cadence
// until its local deadline). After the bounded retries, or on any unexpected status, the result is
// `{ok:false, code:"error"}` and for the fence `{held:false, code:"error"}`: an error is never "held".
//
// ## Public API
//
//   PROTOCOL, EMPTY_TREE_SHA, DEFAULT_REF_PREFIX, HOLDER_PATTERN, ROLE_PATTERN, EXIT
//   parseBatonMessage(text)                   -> { ok, record } | { ok:false, reason }   (pure)
//   formatBatonMessage(record, role)          -> the commit message                      (pure)
//   parseTtl(text)                            -> minutes                                 (pure)
//   githubFetchClient({ token, baseUrl, fetch })  the default API client (same shape as gate-check's)
//   resolveToken({ env, owner, spawn })       GH_TOKEN, else the fleet App token helper, else `gh auth token`
//   createGithubLease(opts)                   -> { acquire, renew, heartbeat, assertHeld, release, status, list, breakGlass, refs }
//   main(argv, { api, env, out, err })        the CLI (see the usage text in `usage()`)
//
// TTL is capped at 24 h (MAX_TTL_MINUTES): batons are renewed at <= TTL/3, and one buggy call must
// not lock a role for a year.
//
// What does not map from durable-lease: `reap` (takeover by `acquire` is the reap: a separate
// "delete the dead record" step would only widen the window and reset the parent chain) and
// `reconcile` (there is no local store to sweep; `list` reads every baton under the prefix).

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/** The baton commit format this code writes and the highest it will take over or renew. */
export const PROTOCOL = 1;
/** git's empty tree: every baton commit points at it (nothing is ever checked out). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Where batons live. Not fetched by default clones; emits no events (spike result). */
export const DEFAULT_REF_PREFIX = "refs/engsys/batons";

/** `<fleet>:<session>` (docs/multi-fleet.md § Terms). `none` is the released holder. */
export const HOLDER_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RELEASED_HOLDER = "none";
/** A role names the ref; keep it a plain slug. */
export const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const FLEET_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PROTOCOL_PATTERN = /^[1-9]\d{0,3}$/;
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** A real baton message is ~200 bytes; anything past this is not one. */
const MAX_MESSAGE_BYTES = 4096;
/** Upper bound on TTL: 24 hours. A baton is renewed at <= TTL/3; one buggy call must not lock a role for a year. */
export const MAX_TTL_MINUTES = 1440;
/** Per-request timeout for the default client. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** A fence read slower than this is refused: its numbers are too stale to act on. */
export const DEFAULT_MAX_FENCE_READ_MS = 5_000;
/** How many unconfirmed tokens per role an instance remembers for confirming them from a later read. */
const MINTED_MEMORY = 64;
/** The API's Date header is truncated to whole seconds; remaining-time math subtracts this floor. */
const DATE_RESOLUTION_MS = 1000;

/** CLI exit codes. */
export const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1, // held by another / lost / expired / not held
  USAGE: 2,
  ERROR: 3, // network, exhausted retries, unexpected status, malformed where it blocks
  PROTOCOL: 4, // the tip's protocol is newer than this code: sync before taking the role
});

/** Thrown for caller mistakes (bad role/holder/ttl/config), distinct from operational outcomes. */
export class LeaseUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseUsageError";
  }
}

// ------------------------------------------------------------------------------- pure helpers --

/**
 * Parse `10m`, `90s`, `1h`, `2d` or a bare number of minutes into minutes. Throws LeaseUsageError.
 */
export function parseTtl(text) {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(String(text ?? "").trim());
  if (!m) throw new LeaseUsageError(`invalid ttl ${JSON.stringify(text)} — use e.g. 10m, 90s, 1h, or minutes`);
  const n = Number(m[1]);
  const unit = { "": 1, s: 1 / 60, m: 1, h: 60, d: 1440 }[m[2]];
  const minutes = n * unit;
  if (!(minutes > 0) || minutes > MAX_TTL_MINUTES) {
    throw new LeaseUsageError(`invalid ttl ${JSON.stringify(text)} — must be > 0 and <= ${MAX_TTL_MINUTES} minutes`);
  }
  return minutes;
}

/** The fleet id a holder address names (`alice:acme-mm` -> `alice`), or null. */
export function fleetOf(holder) {
  const i = typeof holder === "string" ? holder.indexOf(":") : -1;
  return i > 0 ? holder.slice(0, i) : null;
}

/**
 * Render a baton commit message. `record` = { holder, token, expires (ISO string), protocol, fleet }.
 * The first line is for humans; the structured lines are what parseBatonMessage reads.
 */
export function formatBatonMessage(record, role) {
  const { holder, token, expires, protocol = PROTOCOL, fleet } = record;
  const human = holder === RELEASED_HOLDER
    ? `baton ${role}: released`
    : `baton ${role}: ${holder} until ${expires}`;
  return [
    human,
    "",
    `holder: ${holder}`,
    `token: ${token}`,
    `expires: ${expires}`,
    `protocol: ${protocol}`,
    `fleet: ${fleet}`,
  ].join("\n");
}

const FIELDS = {
  holder: (v) => v === RELEASED_HOLDER || HOLDER_PATTERN.test(v),
  token: (v) => TOKEN_PATTERN.test(v),
  expires: (v) => EXPIRES_PATTERN.test(v) && !Number.isNaN(Date.parse(v)),
  protocol: (v) => PROTOCOL_PATTERN.test(v),
  fleet: (v) => v === RELEASED_HOLDER || FLEET_PATTERN.test(v),
};

/**
 * Parse a baton commit message as UNTRUSTED text. Strict: bounded size, printable lines, each known
 * key exactly once with an anchored value, no eval. Unknown `key: value` lines are ignored (a newer
 * protocol may add fields); anything that is not a `key: value` line after the first line is a
 * malformed message. Returns `{ok:true, record}` with `expiresMs` and numeric `protocol`, or
 * `{ok:false, reason, protocol}` where `protocol` is still reported when that one line parsed (so a
 * caller can refuse a newer protocol even when it cannot read the rest).
 */
export function parseBatonMessage(text) {
  if (typeof text !== "string") return { ok: false, reason: "message is not a string" };
  // The protocol line is read FIRST, from the first MAX_MESSAGE_BYTES, before any other rejection:
  // a newer protocol may legitimately write a message this version finds too large or oddly
  // shaped, and an old client must still see "newer protocol" rather than "garbage, take it over".
  // Rule for every future version: keep `protocol: N` as its own line within the first 4 KiB.
  const early = /^protocol: ([1-9]\d{0,3})$/m.exec(text.slice(0, MAX_MESSAGE_BYTES));
  const withProtocol = (reason) => ({ ok: false, reason, ...(early ? { protocol: Number(early[1]) } : {}) });
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return withProtocol("message too large");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return withProtocol("control characters");
  const lines = text.replace(/\n+$/, "").split("\n");
  const seen = {};
  let protocolSeen = null;
  const problems = [];
  lines.forEach((line, index) => {
    if (line === "") return;
    const m = /^([a-z][a-z0-9_-]{0,31}): (\S{1,256})$/.exec(line);
    if (!m) {
      if (index !== 0) problems.push("line is not `key: value`"); // only the human line may be free text
      return;
    }
    const [, key, value] = m;
    if (!(key in FIELDS)) return; // forward-compatible: unknown keys are ignored
    if (key in seen) {
      problems.push(`duplicate ${key}`);
      return;
    }
    if (!FIELDS[key](value)) {
      problems.push(`invalid ${key}`);
      return;
    }
    seen[key] = value;
    if (key === "protocol") protocolSeen = Number(value);
  });
  for (const key of Object.keys(FIELDS)) if (!(key in seen)) problems.push(`missing ${key}`);
  if (problems.length) {
    return { ok: false, reason: problems.join("; "), ...(protocolSeen !== null ? { protocol: protocolSeen } : {}) };
  }
  return {
    ok: true,
    record: {
      holder: seen.holder,
      token: seen.token,
      expires: seen.expires,
      expiresMs: Date.parse(seen.expires),
      protocol: protocolSeen,
      fleet: seen.fleet,
    },
  };
}

// --------------------------------------------------------------------------------- API client --

/**
 * The thin API layer, same shape as gate-check.mjs's `ghApiClient` so either can be injected:
 * `request(method, path, body?)` resolves `{status, json, headers}` (headers lower-cased) and throws
 * only on a transport failure. Built on global fetch; no `gh` process per call.
 */
export function githubFetchClient({ token, baseUrl = "https://api.github.com", fetch: fetchImpl = globalThis.fetch, userAgent = "engsys-lease", timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!token) throw new LeaseUsageError("githubFetchClient needs a token");
  if (typeof fetchImpl !== "function") throw new LeaseUsageError("no fetch implementation available");
  return {
    async request(method, path, body) {
      // Every request is bounded: a hung socket or a stalled body read must surface as a transport
      // error (never as a late answer that the fence would treat as current).
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const headers = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      return { status: res.status, json, headers };
    },
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TOKEN_HELPER = join(HERE, "..", "..", "fleet", "identity", "gh-app-token.mjs");

function defaultSpawn(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * Resolve a GitHub token the way the fleet does: `GH_TOKEN` (or `GITHUB_TOKEN`) in the environment;
 * else, when `GH_APP_ENV_FILE` is set, the fleet's App token helper (fresh installation token for
 * `owner`); else the logged-in `gh auth token`. Never reads argv for a token.
 */
export async function resolveToken({ env = process.env, owner, spawn = defaultSpawn } = {}) {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_APP_ENV_FILE) {
    const args = [APP_TOKEN_HELPER, ...(owner ? ["--owner", owner] : [])];
    return (await spawn(process.execPath, args, env)).trim();
  }
  return (await spawn("gh", ["auth", "token"], env)).trim();
}

// ------------------------------------------------------------------------------------ backend --

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

function validateRole(role) {
  if (typeof role !== "string" || !ROLE_PATTERN.test(role)) {
    throw new LeaseUsageError(`invalid role ${JSON.stringify(role)} — must match ${ROLE_PATTERN}`);
  }
}
function validateHolder(holder) {
  if (typeof holder !== "string" || !HOLDER_PATTERN.test(holder)) {
    throw new LeaseUsageError(`invalid holder ${JSON.stringify(holder)} — must be <fleet>:<session> matching ${HOLDER_PATTERN}`);
  }
}
function validateTtl(ttlMinutes) {
  if (typeof ttlMinutes !== "number" || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > MAX_TTL_MINUTES) {
    throw new LeaseUsageError(`invalid ttlMinutes ${JSON.stringify(ttlMinutes)} — must be a positive number <= ${MAX_TTL_MINUTES}`);
  }
}
function validateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new LeaseUsageError(`invalid token ${JSON.stringify(token)}`);
  }
}

/** The server clock from a response, in ms, or null when the `Date` header is missing/unparseable. */
export function serverTimeOf(response) {
  const raw = response?.headers?.date;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** An operational error result (never thrown, never "held"). */
function errorResult(role, reason, extra = {}) {
  return { ok: false, code: "error", role, reason, ...extra };
}

/**
 * Create a github lease backend for one repo.
 *
 * @param {object} opts
 * @param {string} opts.repo `owner/repo`
 * @param {{request: Function}} [opts.api] API client (default: githubFetchClient over resolveToken()); tests inject a fake
 * @param {string} [opts.token] token for the default client (default: resolveToken())
 * @param {string} [opts.refPrefix] where batons live (default DEFAULT_REF_PREFIX; must be under refs/engsys/)
 * @param {string} [opts.fleet] fleet id written in `fleet:`; default: the holder's fleet
 * @param {number} [opts.maxRetries] attempts per HTTP call on 5xx/transport (default 3)
 * @param {number} [opts.maxRounds] read→decide→CAS rounds per operation (default 4)
 * @param {number} [opts.backoffMs] base backoff (default 400; jittered, doubling)
 * @param {number} [opts.maxFenceReadMs] a fence read slower than this is refused (default 5000)
 * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable sleep for tests
 * @param {()=>number} [opts.random] injectable jitter source for tests
 * @param {()=>number} [opts.now] LOCAL wall clock, used only to measure elapsed time between a
 *   response and the moment a number is handed to the caller — never to decide expiry
 * @param {object} [opts.env] environment for token resolution
 */
export function createGithubLease({
  repo,
  api: apiOpt,
  token: tokenOpt,
  refPrefix = DEFAULT_REF_PREFIX,
  fleet: fleetOpt,
  maxRetries = 3,
  maxRounds = 4,
  backoffMs = 400,
  maxFenceReadMs = DEFAULT_MAX_FENCE_READ_MS,
  sleep = sleepDefault,
  random = Math.random,
  now = Date.now,
  env = process.env,
} = {}) {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    throw new LeaseUsageError(`invalid repo ${JSON.stringify(repo)} — expected owner/repo`);
  }
  // Batons live under refs/engsys/ only. A prefix like refs/heads would let a takeover fast-forward a
  // real branch to an empty-tree commit (every file deleted) — the ancestry CAS allows it, and a
  // fleet App is often a ruleset bypass actor. Not configurable past this namespace, on purpose.
  if (typeof refPrefix !== "string" || !/^refs\/engsys\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(refPrefix)) {
    throw new LeaseUsageError(`invalid refPrefix ${JSON.stringify(refPrefix)} — must be refs/engsys/<ns>[/<ns>...] (never refs/heads or refs/tags)`);
  }
  const owner = repo.split("/")[0];
  let apiPromise = null;
  const getApi = () => {
    if (apiOpt) return Promise.resolve(apiOpt);
    if (!apiPromise) {
      apiPromise = (tokenOpt ? Promise.resolve(tokenOpt) : resolveToken({ env, owner }))
        .then((token) => githubFetchClient({ token }));
    }
    return apiPromise;
  };

  const base = `/repos/${repo}/git`;
  const refOf = (role) => `${refPrefix}/${role}`;
  const shortRef = (ref) => ref.replace(/^refs\//, "");

  // -- one HTTP call with bounded retry on 5xx/transport. `beforeRetry` (for writes) is consulted
  //    before every resend AND once more after the last failure, and may settle the outcome from a
  //    fresh read instead of resending. Every response is stamped with the local time it arrived
  //    (`at`) so a caller can subtract the time that passed since its Date header.
  async function call(method, path, body, { beforeRetry } = {}) {
    const api = await getApi();
    let attempt = 0;
    let last = null;
    for (;;) {
      attempt += 1;
      // `at` is the local SEND time of the request that produced the response: the server stamped
      // its Date header after this instant, so "elapsed since `at`" is an upper bound on the time
      // that passed since the stamp. Elapsed time measured from arrival would miss the transit.
      const sentAt = now();
      try {
        const res = await api.request(method, path, body);
        if (res.status < 500) return { ...res, at: sentAt };
        last = { status: res.status, message: res.json?.message ?? null };
      } catch (err) {
        last = { status: null, message: String(err?.message ?? err) };
      }
      if (beforeRetry) {
        const settled = await beforeRetry();
        if (settled) return settled;
      }
      if (attempt >= maxRetries) return { status: 0, json: null, headers: {}, at: now(), failure: last };
      await sleep(backoffMs * 2 ** (attempt - 1) * (0.5 + random()));
    }
  }

  // -- git data primitives -------------------------------------------------------------------

  /** GET the ref. -> { status, sha|null, type?, serverNow, at, failure? } */
  async function readRef(ref) {
    const res = await call("GET", `${base}/ref/${shortRef(ref)}`);
    const serverNow = serverTimeOf(res);
    if (res.status === 404) return { status: 404, sha: null, serverNow, at: res.at };
    if (res.status === 200) {
      const sha = res.json?.object?.sha;
      const type = res.json?.object?.type;
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) return { status: 200, sha: null, serverNow, at: res.at, failure: { message: "ref response has no sha" } };
      return { status: 200, sha, type, serverNow, at: res.at };
    }
    return { status: res.status, sha: null, serverNow, at: res.at, failure: res.failure ?? { status: res.status, message: res.json?.message ?? null } };
  }

  async function readCommit(sha) {
    const res = await call("GET", `${base}/commits/${sha}`);
    if (res.status === 200 && typeof res.json?.message === "string") {
      return { message: res.json.message, tree: res.json?.tree?.sha ?? null, serverNow: serverTimeOf(res), at: res.at };
    }
    return { failure: res.failure ?? { status: res.status, message: res.json?.message ?? null } };
  }

  /**
   * Read the tip and interpret it. Resolves one of:
   *   { kind:"free", serverNow, clock }                                 no ref
   *   { kind:"baton", sha, record, serverNow, expired, clock }           parsed; `record.holder` may be "none"
   *   { kind:"malformed", sha, reason, protocol?, serverNow, clock }     tip is not a baton this code can read
   *   { kind:"error", failure }                                          including a tip whose tree is not the empty tree
   *
   * Two clocks come back. `serverNow` is the Date of the GET that observed the ref: DECISIONS about
   * someone else's baton (expired? takeover allowed?) use it, because it is the older of the two and
   * therefore conservative. `clock` = { serverNow, at, startedAt } is the LATEST Date header seen
   * during the read plus the local time it arrived: numbers handed to a HOLDER (remaining time) are
   * computed from it minus the local time elapsed since, so a slow read can never overstate.
   */
  async function readTip(ref) {
    const startedAt = now();
    const r = await readRef(ref);
    if (r.failure) return { kind: "error", failure: r.failure };
    if (r.serverNow === null) return { kind: "error", failure: { message: "response carried no Date header; refusing to decide on the local clock" } };
    const clock = { serverNow: r.serverNow, at: r.at, startedAt };
    if (r.status === 404) return { kind: "free", serverNow: r.serverNow, clock };
    if (r.type !== undefined && r.type !== "commit") return { kind: "malformed", sha: r.sha, reason: `ref points at a ${r.type}, not a commit`, serverNow: r.serverNow, clock };
    const c = await readCommit(r.sha);
    if (c.failure) return { kind: "error", failure: c.failure };
    if (c.serverNow !== null) { clock.serverNow = c.serverNow; clock.at = c.at; }
    if (c.tree !== null && c.tree !== EMPTY_TREE_SHA) {
      // Not a baton at all (a real commit with files). Never a takeover: a child commit on the
      // empty tree would read as "delete everything" to anyone who checked this ref out.
      return { kind: "error", failure: { code: "not_a_baton", message: `tip ${r.sha} has a non-empty tree; this ref is not a baton`, sha: r.sha } };
    }
    const parsed = parseBatonMessage(c.message);
    if (!parsed.ok) {
      return { kind: "malformed", sha: r.sha, reason: parsed.reason, ...(parsed.protocol !== undefined ? { protocol: parsed.protocol } : {}), serverNow: r.serverNow, clock };
    }
    return { kind: "baton", sha: r.sha, record: parsed.record, serverNow: r.serverNow, expired: parsed.record.expiresMs <= r.serverNow, clock };
  }

  async function createCommit(message, parents) {
    const res = await call("POST", `${base}/commits`, { message, tree: EMPTY_TREE_SHA, parents });
    if (res.status === 201 && typeof res.json?.sha === "string") return { sha: res.json.sha };
    return { failure: res.failure ?? { status: res.status, message: res.json?.message ?? null } };
  }

  /**
   * Compare-and-swap the ref from `expectedTip` (null = must not exist) to `sha`.
   * -> { outcome: "won" | "lost" | "error", clock?, failure? }
   * "lost" means the server refused (422) OR a re-read after a failed attempt showed the ref moved
   * elsewhere; "won" includes a re-read showing the ref already AT `sha` (the write landed but its
   * response was lost). `clock` is the Date (and local arrival time) of the response that proved
   * the win. Note: GitHub's check is ancestry, not equality — the PATCH also succeeds if the ref was
   * rewound to an ancestor of `expectedTip` meanwhile. Only a force-push can do that (every writer
   * here fast-forwards), and a force-pusher is inside the repo's own trust boundary.
   */
  async function cas(ref, expectedTip, sha) {
    const settleFromRead = async () => {
      const r = await readRef(ref);
      if (r.failure) return null; // can't tell; let the retry loop continue
      const clock = r.serverNow === null ? null : { serverNow: r.serverNow, at: r.at };
      if (r.sha === sha) return { settled: "won", clock };
      if (r.sha !== expectedTip) return { settled: "lost", clock }; // moved (or a lagging replica: a false "lost" is safe, a later round re-reads)
      return null; // unchanged: safe to resend
    };
    const res = expectedTip === null
      ? await call("POST", `${base}/refs`, { ref, sha }, { beforeRetry: settleFromRead })
      : await call("PATCH", `${base}/refs/${shortRef(ref)}`, { sha, force: false }, { beforeRetry: settleFromRead });
    if (res.settled) return { outcome: res.settled, clock: res.clock };
    const okStatus = expectedTip === null ? 201 : 200;
    if (res.status === okStatus) {
      const got = res.json?.object?.sha;
      if (typeof got === "string" && got !== sha) return { outcome: "error", failure: { message: `server accepted the update but the ref points at ${got}, not ${sha}` } };
      const serverNow = serverTimeOf(res);
      return { outcome: "won", clock: serverNow === null ? null : { serverNow, at: res.at } };
    }
    if (res.status === 422) return { outcome: "lost", message: res.json?.message ?? null };
    return { outcome: "error", failure: res.failure ?? { status: res.status, message: res.json?.message ?? null } };
  }

  // -- shared presentation ---------------------------------------------------------------------

  /**
   * Remaining lifetime of `expiresMs` as of NOW, for a holder, as a lower bound: the latest server
   * Date observed, minus DATE_RESOLUTION_MS (the header is truncated to the second, so true server
   * time was up to 1 s later), minus the local time elapsed since that request was SENT (the stamp
   * happened after the send, so this over-counts the elapsed time, never under). Every term errs on
   * the side of less time; a local clock that runs at the right rate is the one remaining assumption.
   */
  function remainingMs(expiresMs, clock) {
    return expiresMs - clock.serverNow - DATE_RESOLUTION_MS - Math.max(0, now() - clock.at);
  }

  function expiryInfo(record, clock) {
    return { expiresAt: record.expires, expiresInMs: remainingMs(record.expiresMs, clock) };
  }

  /** A tip's record for reporting: without the internal ms field and without the holder's token. */
  function publicRecord(record) {
    const { expiresMs, token, ...rest } = record;
    return rest;
  }

  /**
   * `held` refusal. `heldBySelf` means the tip carries this holder NAME, not this caller's token:
   * it is a second process with our name, or an earlier acquire of ours whose token we lost. It is
   * NEVER "held" for the caller — acting on it would be exactly the duplicate the lease exists to
   * prevent. Wait for expiry (or release from the process that holds the token).
   */
  function heldByOther(role, tip) {
    return {
      ok: false,
      code: "held",
      role,
      holder: tip.record.holder,
      ...expiryInfo(tip.record, tip.clock),
      serverNow: new Date(tip.serverNow).toISOString(),
      record: publicRecord(tip.record),
    };
  }

  function protocolRefusal(role, tip) {
    const protocol = tip.kind === "baton" ? tip.record.protocol : tip.protocol;
    return { ok: false, code: "protocol_unsupported", role, protocol, supported: PROTOCOL, reason: `baton protocol ${protocol} is newer than ${PROTOCOL}; sync this fleet before touching the role` };
  }

  function newerProtocol(tip) {
    const p = tip.kind === "baton" ? tip.record.protocol : tip.protocol;
    return typeof p === "number" && p > PROTOCOL;
  }

  /** The record + expiry numbers for a success, from the clock that proved the CAS (else the read's). */
  function wonResult(code, role, record, ttlMinutes, sha, clock, extra = {}) {
    const expiresMs = Date.parse(record.expires);
    return {
      ok: true,
      code,
      role,
      record: { ...record, role, ttlMinutes, sha },
      expiresAt: record.expires,
      expiresInMs: remainingMs(expiresMs, clock),
      ...extra,
    };
  }

  // -- operations ------------------------------------------------------------------------------

  // Tokens this instance minted whose CAS outcome is not known, per role (bounded). An entry is
  // `pending` while its CAS is in flight and `unconfirmed` after a lost/error outcome; a clean win
  // DELETES the entry, so a confirmed holder is never re-issued its token. See acquire.
  const mintedByRole = new Map();
  const mintedFor = (role) => { if (!mintedByRole.has(role)) mintedByRole.set(role, new Map()); return mintedByRole.get(role); };

  /**
   * Acquire the baton for `role`. Exactly one concurrent caller wins (the CAS). Over an expired,
   * released or malformed tip the win is flagged (`tookOverExpired` / `tookOverMalformed` plus
   * `previous`), so a takeover is always loud. A fresh baton held by another — or by this same
   * holder name (`heldBySelf`, see heldByOther) — is refused with `held`. That holds INSIDE a
   * process too: two acquires on one instance never both succeed; the lease is the mutex.
   *
   * Liveness: a token whose CAS outcome could not be confirmed (lost response, lagging replica) is
   * remembered as `unconfirmed`. If a later read, in this call or a later one, shows the tip
   * carrying such a token for our holder name, unexpired, the write landed: acquire reports
   * `acquired` with the TIP's record (`confirmedByRead`) and forgets the token, so exactly one caller
   * can confirm it. A token whose CAS is still in flight (`pending`) is never confirmed by another
   * caller: that caller sees `heldBySelf`. A clean win forgets the token at once. A fresh process
   * has no such memory and sees `heldBySelf`: it waits for expiry, by design.
   */
  async function acquire({ role, holder, ttlMinutes, fleet = fleetOpt ?? fleetOf(holder) } = {}) {
    validateRole(role);
    validateHolder(holder);
    validateTtl(ttlMinutes);
    if (!FLEET_PATTERN.test(fleet ?? "")) throw new LeaseUsageError(`invalid fleet ${JSON.stringify(fleet)}`);
    const ref = refOf(role);
    const minted = mintedFor(role); // token -> { record, sha, flags, previous }; survives across calls on this instance
    let lastLoss = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const tip = await readTip(ref);
      if (tip.kind === "error") return errorResult(role, "could not read the baton", { failure: tip.failure });
      let previous = null;
      let flags = {};
      if (tip.kind === "baton") {
        const ours = minted.get(tip.record.token);
        if (ours && ours.state === "unconfirmed" && tip.record.holder === holder && !tip.expired) {
          // An earlier CAS landed without us seeing it. Confirmed by this read; the token is
          // forgotten so no second caller can confirm it too. Report what the TIP says (it may have
          // been renewed since), not what we remembered.
          minted.delete(tip.record.token);
          const { expiresMs, ...tipRecord } = tip.record;
          return wonResult("acquired", role, tipRecord, undefined, tip.sha, tip.clock, { ...ours.flags, ...(ours.previous ? { previous: ours.previous } : {}), confirmedByRead: true, acquiredAt: ours.acquiredAt });
        }
        if (!tip.expired && tip.record.holder !== RELEASED_HOLDER) {
          return { ...heldByOther(role, tip), heldBySelf: tip.record.holder === holder };
        }
        if (newerProtocol(tip)) return protocolRefusal(role, tip);
        previous = publicRecord(tip.record);
        if (tip.record.holder !== RELEASED_HOLDER) flags = { tookOverExpired: true };
      } else if (tip.kind === "malformed") {
        if (newerProtocol(tip)) return protocolRefusal(role, tip);
        previous = { malformed: true, reason: tip.reason, sha: tip.sha };
        flags = { tookOverMalformed: true };
      }
      const token = randomUUID();
      const expiresMs = tip.serverNow + ttlMinutes * 60_000;
      const record = { holder, token, expires: new Date(expiresMs).toISOString(), protocol: PROTOCOL, fleet };
      const commit = await createCommit(formatBatonMessage(record, role), tip.kind === "free" ? [] : [tip.sha]);
      if (commit.failure) return errorResult(role, "could not create the baton commit", { failure: commit.failure });
      const acquiredAt = new Date(tip.serverNow).toISOString();
      minted.set(token, { state: "pending", acquiredAt, flags, previous });
      if (minted.size > MINTED_MEMORY) minted.delete(minted.keys().next().value); // bounded: oldest out
      const result = await cas(ref, tip.kind === "free" ? null : tip.sha, commit.sha);
      if (result.outcome === "won") {
        minted.delete(token); // confirmed: never re-issued
        return wonResult("acquired", role, record, ttlMinutes, commit.sha, result.clock ?? tip.clock, { ...flags, ...(previous ? { previous } : {}), acquiredAt });
      }
      // Not confirmed: a true loss, or a write that landed with its response lost (a later read of
      // our token on the tip tells the two apart).
      if (minted.has(token)) minted.get(token).state = "unconfirmed";
      if (result.outcome === "error") return errorResult(role, "the baton update failed", { failure: result.failure });
      lastLoss = result; // lost the CAS (or a settle read said so): re-read and decide again
    }
    return errorResult(role, `lost the compare-and-swap ${maxRounds} times in a row`, { failure: lastLoss });
  }

  /**
   * Renew (heartbeat): CAS a new commit with the same token and a fresh expiry. Any outcome other
   * than a CAS win on a tip that carries our unexpired token is `lost: true` — the caller stops.
   *
   * "No revival" is decided on the READ: a renew whose read saw the baton unexpired may land after
   * the expiry instant. That is safe: a taker that read after expiry built its commit on the same
   * tip, and the CAS lets exactly one of the two through; the loser re-reads and reports lost.
   */
  async function renew({ role, token, ttlMinutes, holder, fleet } = {}) {
    validateRole(role);
    validateToken(token);
    validateTtl(ttlMinutes);
    const ref = refOf(role);
    let lastLoss = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const tip = await readTip(ref);
      if (tip.kind === "error") return errorResult(role, "could not read the baton", { failure: tip.failure });
      if (tip.kind === "free") return { ok: false, code: "not_held", lost: true, role };
      if (tip.kind === "malformed") {
        if (newerProtocol(tip)) return { ...protocolRefusal(role, tip), lost: true };
        return { ok: false, code: "lost", lost: true, role, reason: `tip is malformed: ${tip.reason}` };
      }
      if (newerProtocol(tip)) return { ...protocolRefusal(role, tip), lost: true };
      if (tip.record.token !== token || tip.record.holder === RELEASED_HOLDER) {
        return { ok: false, code: "lost", lost: true, role, holder: tip.record.holder, ...expiryInfo(tip.record, tip.clock) };
      }
      if (holder !== undefined && tip.record.holder !== holder) {
        return { ok: false, code: "lost", lost: true, role, holder: tip.record.holder, reason: "token matches but holder differs" };
      }
      if (tip.expired) {
        // Dead-man's-switch: past TTL the lease is forfeit even for its owner. No revival.
        return { ok: false, code: "expired", lost: true, role, holder: tip.record.holder, ...expiryInfo(tip.record, tip.clock) };
      }
      const expiresMs = tip.serverNow + ttlMinutes * 60_000;
      const record = {
        holder: tip.record.holder,
        token,
        expires: new Date(expiresMs).toISOString(),
        protocol: PROTOCOL,
        fleet: fleet ?? fleetOpt ?? tip.record.fleet,
      };
      const commit = await createCommit(formatBatonMessage(record, role), [tip.sha]);
      if (commit.failure) return errorResult(role, "could not create the renewal commit", { failure: commit.failure });
      const result = await cas(ref, tip.sha, commit.sha);
      if (result.outcome === "won") return wonResult("renewed", role, record, ttlMinutes, commit.sha, result.clock ?? tip.clock);
      if (result.outcome === "error") return errorResult(role, "the renewal update failed", { failure: result.failure });
      // CAS lost: the ref moved under us. Re-read: if the new tip is not ours, that is LEASE_LOST
      // (the next round reports it); if it is ours (a parallel renew by the same process, or a
      // lagging replica told settle "lost"), the next round renews on top of it.
      lastLoss = result;
    }
    return errorResult(role, `lost the compare-and-swap ${maxRounds} times in a row`, { failure: lastLoss });
  }

  /**
   * Fence check: ONE read. `held: true` only if the tip carries `token`, is unexpired by server
   * time, and has at least `minRemainingMs` left as of return — remaining time is the latest Date
   * header seen minus the local time since it arrived. A read slower than `maxFenceReadMs` is
   * refused (`slow_read`): its numbers are too old to act on. Every other outcome, including any
   * error, is `held: false` with a code: not_held / lost / expired / protocol_unsupported / error.
   */
  async function assertHeld({ role, token, minRemainingMs = 0 } = {}) {
    validateRole(role);
    validateToken(token);
    const tip = await readTip(refOf(role));
    if (tip.kind === "error") return { held: false, code: "error", role, failure: tip.failure };
    const readMs = now() - tip.clock.startedAt;
    if (readMs > maxFenceReadMs) return { held: false, code: "error", role, reason: "slow_read", readMs, maxFenceReadMs };
    if (tip.kind === "free") return { held: false, code: "not_held", role };
    if (tip.kind === "malformed") return { held: false, code: newerProtocol(tip) ? "protocol_unsupported" : "lost", role, reason: tip.reason };
    if (newerProtocol(tip)) return { held: false, ...protocolRefusal(role, tip) };
    if (tip.record.token !== token || tip.record.holder === RELEASED_HOLDER) {
      return { held: false, code: "lost", role, holder: tip.record.holder, ...expiryInfo(tip.record, tip.clock) };
    }
    const info = expiryInfo(tip.record, tip.clock);
    const serverNow = new Date(tip.clock.serverNow).toISOString();
    if (tip.expired || info.expiresInMs <= 0 || info.expiresInMs < minRemainingMs) {
      return { held: false, code: "expired", role, holder: tip.record.holder, ...info, minRemainingMs, serverNow, readMs };
    }
    return { held: true, code: "held", role, holder: tip.record.holder, ...info, serverNow, readMs };
  }

  /**
   * Release: CAS to `holder: none`, keeping our token on the release commit so a repeated release
   * is recognized (idempotent: `{ok:true, released:false, code:"already_released"}`). Requires the
   * fencing token; a tip carrying someone else's token is `lost` (nothing of ours to release). A
   * released baton is acquirable by anyone immediately. Releasing a baton that is ours but already
   * expired is allowed (`wasExpired: true` — the holder overran its TTL; callers should log it): if
   * anyone took over in the meantime the CAS fails and the result is `lost`.
   */
  async function release({ role, token } = {}) {
    validateRole(role);
    validateToken(token);
    const ref = refOf(role);
    let lastLoss = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const tip = await readTip(ref);
      if (tip.kind === "error") return errorResult(role, "could not read the baton", { failure: tip.failure });
      if (tip.kind === "free") return { ok: true, code: "not_held", role, released: false };
      if (tip.kind === "malformed") {
        if (newerProtocol(tip)) return { ...protocolRefusal(role, tip), lost: true };
        return { ok: false, code: "lost", lost: true, role, reason: `tip is malformed: ${tip.reason}` };
      }
      if (newerProtocol(tip)) return { ...protocolRefusal(role, tip), lost: true };
      if (tip.record.token !== token) {
        return { ok: false, code: "lost", lost: true, role, holder: tip.record.holder };
      }
      if (tip.record.holder === RELEASED_HOLDER) return { ok: true, code: "already_released", role, released: false };
      const record = { holder: RELEASED_HOLDER, token, expires: new Date(tip.serverNow).toISOString(), protocol: PROTOCOL, fleet: fleetOpt ?? tip.record.fleet };
      const commit = await createCommit(formatBatonMessage(record, role), [tip.sha]);
      if (commit.failure) return errorResult(role, "could not create the release commit", { failure: commit.failure });
      const result = await cas(ref, tip.sha, commit.sha);
      if (result.outcome === "won") {
        return { ok: true, code: "released", role, released: true, wasExpired: tip.expired, record: { ...record, role, sha: commit.sha } };
      }
      if (result.outcome === "error") return errorResult(role, "the release update failed", { failure: result.failure });
      lastLoss = result; // the ref moved (a takeover of our expired baton): re-read, which reports lost
    }
    return errorResult(role, `lost the compare-and-swap ${maxRounds} times in a row`, { failure: lastLoss });
  }

  function describe(role, tip) {
    if (tip.kind === "error") return { role, state: "error", failure: tip.failure };
    const serverNow = new Date(tip.serverNow).toISOString();
    if (tip.kind === "free") return { role, state: "free", serverNow };
    if (tip.kind === "malformed") {
      return { role, state: "unknown", malformed: true, reason: tip.reason, sha: tip.sha, serverNow, ...(tip.protocol !== undefined ? { protocol: tip.protocol } : {}) };
    }
    const record = publicRecord(tip.record);
    const common = { role, sha: tip.sha, serverNow, record, protocol: tip.record.protocol, protocolSupported: tip.record.protocol <= PROTOCOL };
    if (tip.record.holder === RELEASED_HOLDER) return { ...common, state: "free", released: true, releasedBy: tip.record.fleet };
    if (tip.expired) return { ...common, state: "unknown", expired: true, holder: tip.record.holder, ...expiryInfo(tip.record, tip.clock), expiredForMs: tip.serverNow - tip.record.expiresMs };
    return { ...common, state: "held", holder: tip.record.holder, ...expiryInfo(tip.record, tip.clock) };
  }

  /**
   * Lock-free read. `state` is one of "free" (no ref, or released), "held", "unknown" (expired or
   * malformed: never treat as held, never as confidently free) or "error" (unreadable, or a tip that
   * is not a baton at all).
   */
  async function status({ role } = {}) {
    validateRole(role);
    return describe(role, await readTip(refOf(role)));
  }

  /** Every baton under the prefix, each described as `status` would. */
  async function list() {
    const res = await call("GET", `${base}/matching-refs/${shortRef(refPrefix)}/`);
    if (res.status !== 200 || !Array.isArray(res.json)) {
      return { ok: false, code: "error", failure: res.failure ?? { status: res.status, message: res.json?.message ?? null } };
    }
    const out = [];
    for (const entry of res.json) {
      const ref = entry?.ref;
      if (typeof ref !== "string" || !ref.startsWith(`${refPrefix}/`)) continue;
      const role = ref.slice(refPrefix.length + 1);
      if (!ROLE_PATTERN.test(role)) { out.push({ role, ref, state: "unknown", malformed: true, reason: "ref name is not a role" }); continue; }
      out.push(describe(role, await readTip(ref)));
    }
    return { ok: true, prefix: refPrefix, batons: out };
  }

  /**
   * OPERATOR BREAK-GLASS. Resets the ref to a fresh `holder: none` commit, whatever the tip holds (a
   * hostile `protocol: 9999`, an absurd expiry, a non-baton commit). It ignores the protocol and tree
   * checks, but it is still fenced two ways:
   * - `expectSha` is required: the tip sha the operator inspected (from `status`). If the current tip
   *   differs, nothing is written (`tip_moved`), so the operator decides on what they actually saw.
   * - When the old tip's commit is readable, the reset commit is parented on it and the PATCH is a
   *   normal compare-and-swap (`force: false`): a legitimate takeover that lands between the read
   *   and the write wins, and the reset reports `tip_moved` instead of wiping a live baton. Only a
   *   tip the API cannot serve as a commit (a non-commit object, an unreadable sha) is reset with a
   *   parentless commit and `force: true`.
   * It is for a human, by hand, from the CLI (`break-glass --expect-sha … --i-know`), and the fleet
   * settings template denies that command to agent sessions. Returns what it overwrote.
   */
  async function breakGlass({ role, reason, expectSha } = {}) {
    validateRole(role);
    const why = String(reason ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 120);
    if (!why) throw new LeaseUsageError("break-glass needs a --reason (printable text, up to 120 chars)");
    if (typeof expectSha !== "string" || !SHA_PATTERN.test(expectSha)) {
      throw new LeaseUsageError("break-glass needs --expect-sha <40-hex tip sha> — the tip you inspected with `status`");
    }
    const ref = refOf(role);
    const r = await readRef(ref);
    if (r.failure) return errorResult(role, "could not read the baton", { failure: r.failure });
    if (r.status === 404) return { ok: false, code: "not_held", role, reason: "no ref to reset" };
    if (r.serverNow === null) return errorResult(role, "response carried no Date header");
    if (r.sha !== expectSha) {
      return { ok: false, code: "tip_moved", role, expected: expectSha, current: r.sha, reason: "the tip is not the one you inspected; re-read with `status` and decide again" };
    }
    const readable = r.type === undefined || r.type === "commit";
    const prior = readable ? await readCommit(r.sha) : { failure: { message: `ref points at a ${r.type}, not a commit` } };
    const previous = { sha: r.sha, ...(prior.failure ? { unreadable: prior.failure } : { tree: prior.tree, message: prior.message.slice(0, MAX_MESSAGE_BYTES), parsed: parseBatonMessage(prior.message) }) };
    const record = { holder: RELEASED_HOLDER, token: randomUUID(), expires: new Date(r.serverNow).toISOString(), protocol: PROTOCOL, fleet: fleetOpt ?? RELEASED_HOLDER };
    const message = `${formatBatonMessage(record, role).replace(/\n/, ` (break-glass: ${why})\n`)}`;
    const parented = !prior.failure;
    const commit = await createCommit(message, parented ? [r.sha] : []);
    if (commit.failure) return errorResult(role, "could not create the reset commit", { failure: commit.failure });
    if (parented) {
      const result = await cas(ref, r.sha, commit.sha);
      if (result.outcome === "won") return { ok: true, code: "broke_glass", role, reason: why, forced: false, previous, record: { ...record, role, sha: commit.sha } };
      if (result.outcome === "error") return errorResult(role, "the reset failed", { failure: result.failure, previous });
      // Someone moved the ref between our read and our write (a takeover of the wedged tip). Report
      // the current tip; nothing of ours was written.
      const nowTip = await readTip(ref);
      return { ok: false, code: "tip_moved", role, expected: expectSha, current: nowTip.kind === "error" ? null : (nowTip.sha ?? null), now: describe(role, nowTip), reason: "the tip moved after you inspected it; nothing was written" };
    }
    const res = await call("PATCH", `${base}/refs/${shortRef(ref)}`, { sha: commit.sha, force: true });
    if (res.status !== 200) return errorResult(role, "the forced reset failed", { failure: res.failure ?? { status: res.status, message: res.json?.message ?? null }, previous });
    return { ok: true, code: "broke_glass", role, reason: why, forced: true, previous, record: { ...record, role, sha: commit.sha } };
  }

  /** Low-level ref access (the live test uses `remove` to clean up a scratch ref). */
  const refs = {
    ref: refOf,
    read: (role) => readTip(refOf(role)),
    async remove(role) {
      validateRole(role);
      const res = await call("DELETE", `${base}/refs/${shortRef(refOf(role))}`);
      return { ok: res.status === 204 || res.status === 404 || res.status === 422, status: res.status };
    },
  };

  return { repo, refPrefix, protocol: PROTOCOL, acquire, renew, heartbeat: renew, assertHeld, release, status, list, breakGlass, refs };
}

// ---------------------------------------------------------------------------------------- CLI --

const OPS = new Set(["status", "acquire", "renew", "heartbeat", "fence", "release", "list", "break-glass"]);

function usage() {
  return [
    "usage: github-backend.mjs <status|acquire|renew|fence|release|list|break-glass> --repo o/r [flags]",
    "  status      --role R",
    "  acquire     --role R --holder fleet:session [--ttl 10m]        (ttl <= 24h)",
    "  renew       --role R --token T [--ttl 10m]                     (alias: heartbeat)",
    "  fence       --role R --token T [--min-remaining 30s]           exit 0 only while held",
    "  release     --role R --token T",
    "  list",
    "  break-glass --role R --reason '<why>' --expect-sha <tip sha from status> --i-know",
    "              OPERATOR ONLY (denied to agent sessions): reset the ref to holder: none if the tip is still <sha>",
    "common: --ref-prefix refs/engsys/<ns>  --fleet <id>  --pretty",
    "env: GH_TOKEN | GITHUB_TOKEN, else GH_APP_ENV_FILE (fleet App token helper), else `gh auth token`",
    "exit: 0 ok | 1 refused (held/lost/expired/not held) | 2 usage | 3 error | 4 protocol newer than this code",
  ].join("\n");
}

function parseArgs(argv) {
  const [op, ...rest] = argv;
  if (!op || !OPS.has(op)) throw new LeaseUsageError(`unknown or missing op ${JSON.stringify(op ?? "")}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new LeaseUsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (name === "pretty" || name === "i-know") { flags[name] = true; continue; }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new LeaseUsageError(`--${name} requires a value`);
    flags[name] = value;
    i += 1;
  }
  return { op, flags };
}

function exitFor(result) {
  if (result.ok === true || result.held === true) return EXIT.OK;
  if (result.code === "protocol_unsupported") return EXIT.PROTOCOL;
  if (result.code === "error") return EXIT.ERROR;
  return EXIT.REFUSED;
}

/** The CLI. Prints exactly one JSON object to stdout; sets the exit code; never prompts. */
export async function main(argv, { api, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err.write(`github-backend: ${e.message}\n${usage()}\n`);
    return EXIT.USAGE;
  }
  const { op, flags } = parsed;
  const emit = (result) => { out.write(`${JSON.stringify(result, null, flags.pretty ? 2 : 0)}\n`); };
  try {
    if (!flags.repo) throw new LeaseUsageError("--repo owner/repo is required");
    const need = (name) => {
      if (flags[name] === undefined) throw new LeaseUsageError(`op "${op}" requires --${name}`);
      return flags[name];
    };
    const lease = createGithubLease({
      repo: flags.repo,
      ...(api ? { api } : {}),
      ...(flags["ref-prefix"] ? { refPrefix: flags["ref-prefix"] } : {}),
      ...(flags.fleet ? { fleet: flags.fleet } : {}),
      env,
    });
    const ttl = () => parseTtl(flags.ttl ?? "10m");
    let result;
    switch (op) {
      case "status": result = await lease.status({ role: need("role") }); result.ok = result.state !== "error"; if (result.state === "error") result.code = "error"; break;
      case "acquire": result = await lease.acquire({ role: need("role"), holder: need("holder"), ttlMinutes: ttl() }); break;
      case "renew":
      case "heartbeat": result = await lease.renew({ role: need("role"), token: need("token"), ttlMinutes: ttl(), ...(flags.holder ? { holder: flags.holder } : {}) }); break;
      case "fence": result = await lease.assertHeld({ role: need("role"), token: need("token"), minRemainingMs: flags["min-remaining"] ? parseTtl(flags["min-remaining"]) * 60_000 : 0 }); break;
      case "release": result = await lease.release({ role: need("role"), token: need("token") }); break;
      case "list": result = await lease.list(); break;
      case "break-glass":
        if (flags["i-know"] !== true) {
          throw new LeaseUsageError("break-glass resets the baton ref regardless of who holds it; this is an operator action, never an agent's. Re-run with --expect-sha <tip from status> --i-know to confirm");
        }
        result = await lease.breakGlass({ role: need("role"), reason: need("reason"), expectSha: need("expect-sha") });
        break;
      default: throw new LeaseUsageError(`unknown op ${op}`);
    }
    emit(result);
    return exitFor(result);
  } catch (e) {
    if (e instanceof LeaseUsageError) {
      err.write(`github-backend: ${e.message}\n${usage()}\n`);
      return EXIT.USAGE;
    }
    emit({ ok: false, code: "error", reason: String(e?.message ?? e) });
    return EXIT.ERROR;
  }
}

// Run only when executed directly, so tests can import without side effects.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
