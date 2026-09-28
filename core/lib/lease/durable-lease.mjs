// durable-lease.mjs — a durable, heartbeat-expiring, owner-fenced lease primitive.
//
// Zero-dependency ESM, Node >= 20. One primitive for every "durable lock/lease" on a host:
// shared-resource slots (see pool.mjs), maintenance windows, a merge baton, session liveness.
//
// ## Semantics
//
// - A lease is a JSON record `{owner, kind, token, heartbeat, ttlMinutes, payload, ...}`
//   persisted as a file `<store>/<kind>.json`. The lease IS the mutex.
// - **Dead-man's-switch:** a heartbeat older than `ttlMinutes` auto-expires the lease.
//   A reader treats an expired lease as **unknown** — never *held-forever*, never
//   *silent-confidence*. Acquiring over an expired lease succeeds but is flagged
//   (`tookOverExpired: true` + the previous record) and journaled, so takeover is
//   always loud.
// - **No revival:** `heartbeat` on an expired lease FAILS. Once past TTL the lease is
//   contractually forfeit even if the holder wakes up a microsecond after a reaper
//   observed the expiry — the holder must re-acquire. This is what makes the
//   reap/steal path race-free at the semantic level.
// - **Fencing token:** `acquire` mints a random token; `heartbeat` and `release` require it,
//   so a holder that lost its lease to a takeover cannot touch the new holder's lease.
// - **Owner-fenced:** owners must match the store's owner pattern (default: any safe token;
//   set `ownerPattern` / `LEASE_OWNER_PATTERN` to fence a store to one namespace).
//   `reconcile()` (run at session startup) reaps expired leases whose owner is inside the
//   fence and reports — but never touches — any foreign record found in the store.
//
// ## Concurrency (why this is TOCTOU-free)
//
// Every mutation (acquire / heartbeat / release / reap) runs inside a per-kind
// critical section — the *guard*:
//
// 1. Guard entry is `mkdirSync(guardPath)` — atomic on POSIX; exactly one caller
//    wins, losers get EEXIST and retry with jittered sleep until `guardWaitMs`.
// 2. A crashed guard-holder (guard dir older than `guardStaleMs`; holders keep it
//    for single-digit milliseconds) is reaped via `renameSync(guard, unique)` —
//    directory rename to a unique target is atomic with exactly one winner: the
//    loser gets ENOENT and simply retries `mkdir`. There is NO unlink-then-create
//    window in which two reapers can both "clean up" and both acquire.
// 3. Inside the guard, check-and-write is a single critical section, so acquire's
//    existence/freshness check and its record write cannot interleave with another
//    caller's — the classic check-then-write TOCTOU is structurally impossible.
// 4. Record writes are temp-file + `renameSync` (atomic replace), so the lock-free
//    `status`/`list` readers always see a complete JSON document, never a torn one.
//
// ## On-disk compatibility (hard contract)
//
// The store layout (`<kind>.json`, `.guard-<kind>/holder.json`, `reaped.log`), the record
// fields and the token/expiry rules are a stable format shared with other implementations of
// this primitive on the same host. Generalize through OPTIONS with backward-compatible
// defaults — never by changing the format. The cross-implementation test in
// durable-lease.test.mjs (LEASE_REFERENCE_IMPL) guards this.
//
// ## Assumptions / seams
//
// - Single host, single filesystem, single clock. Freshness compares `Date.now()` against the
//   recorded heartbeat; cross-machine use needs a different backend behind the same API.
// - The storage backend is isolated in a handful of small functions
//   (`readRecord` / `writeRecord` / `deleteRecord` / `withGuard`); the public API
//   (`acquire/release/heartbeat/status/reap/reconcile/list`) is backend-agnostic.
// - The clock is injectable (`opts.now`) for tests.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const RECORD_VERSION = 1;

/**
 * Default owner fence: any safe token (letters, digits, `. _ : @ -`, up to 128 chars, starting
 * alphanumeric). Override per store with `ownerPattern` / `LEASE_OWNER_PATTERN`.
 */
export const DEFAULT_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** Lease kinds are filesystem-safe slugs (they name the record file). Fixed: part of the format. */
export const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The git toplevel of `dir`, or null when `dir` is not inside a work tree (or git is unavailable). */
function gitToplevel(dir) {
  try {
    const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const top = res.status === 0 ? res.stdout.trim() : "";
    return top || null;
  } catch {
    return null;
  }
}

/**
 * Default store: `logs/leases` under the git toplevel of the working directory, so a hook and an
 * agent started from different subdirectories of one checkout share a store. Outside a git work
 * tree (or without git) it falls back to the working directory itself. A linked worktree has its
 * own toplevel: to share a store between worktrees, set `LEASE_STORE` to one absolute path.
 */
export function defaultStoreDir(cwd = process.cwd()) {
  const base = resolve(cwd);
  return join(gitToplevel(base) ?? base, "logs", "leases");
}

/** Thrown for caller mistakes (bad owner/kind/ttl/config) — distinct from operational outcomes. */
export class LeaseUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseUsageError";
  }
}

/**
 * Resolve an owner pattern from a RegExp or a pattern string (e.g. the `LEASE_OWNER_PATTERN`
 * env var). String patterns must be anchored (`^...$`) so a fence can never silently degrade
 * into a substring match. Stateful flags (g, y) are stripped so `.test` is repeatable.
 */
export function resolveOwnerPattern(pattern) {
  if (pattern === undefined || pattern === null || pattern === "") return DEFAULT_OWNER_PATTERN;
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  if (!source.startsWith("^") || !source.endsWith("$") || source.endsWith("\\$")) {
    throw new LeaseUsageError(
      `invalid owner pattern ${JSON.stringify(source)} — must be anchored (start with ^ and end with $)`,
    );
  }
  try {
    const flags = pattern instanceof RegExp ? pattern.flags.replace(/[gy]/g, "") : "";
    return new RegExp(source, flags);
  } catch (err) {
    throw new LeaseUsageError(`invalid owner pattern ${JSON.stringify(source)}: ${err.message}`);
  }
}

/** Synchronous sleep that does not spin the CPU. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function validateKind(kind) {
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
    throw new LeaseUsageError(
      `invalid kind ${JSON.stringify(kind)} — must match ${KIND_PATTERN}`,
    );
  }
}

/** Upper bound on TTL (366 days) — a "lock" this long is a bug, and absurd TTLs overflow Date math. */
export const MAX_TTL_MINUTES = 527_040;

function validateTtl(ttlMinutes) {
  if (
    typeof ttlMinutes !== "number" ||
    !Number.isFinite(ttlMinutes) ||
    ttlMinutes <= 0 ||
    ttlMinutes > MAX_TTL_MINUTES
  ) {
    throw new LeaseUsageError(
      `invalid ttlMinutes ${JSON.stringify(ttlMinutes)} — must be a positive number ≤ ${MAX_TTL_MINUTES} (= stale_lock_minutes)`,
    );
  }
}

/**
 * Create a lease store rooted at `store`.
 *
 * @param {object} [opts]
 * @param {string} [opts.store] store directory. Precedence: this option, then `$LEASE_STORE`,
 *   then `logs/leases` under the git toplevel of the cwd (the cwd itself outside git). (`dir` is accepted as an alias.)
 * @param {RegExp|string} [opts.ownerPattern] owner fence. Precedence: this option, then
 *   `$LEASE_OWNER_PATTERN`, then DEFAULT_OWNER_PATTERN. Must be anchored.
 * @param {() => number} [opts.now] clock (ms since epoch) — injectable for tests
 * @param {object} [opts.env] environment to read LEASE_STORE / LEASE_OWNER_PATTERN from (default process.env)
 * @param {number} [opts.guardWaitMs] max time to wait for the guard critical section
 * @param {number} [opts.guardStaleMs] guard age past which a crashed guard is reaped —
 *   keep it far above any plausible hold time (holds are single-digit milliseconds;
 *   the default leaves 4 orders of magnitude of headroom for a suspended process)
 */
export function createLeaseStore({
  store: storeOpt,
  dir: dirOpt,
  ownerPattern: ownerPatternOpt,
  env = process.env,
  now = Date.now,
  guardWaitMs = 5_000,
  guardStaleMs = 60_000,
} = {}) {
  const dir = resolve(storeOpt ?? dirOpt ?? (env.LEASE_STORE || defaultStoreDir()));
  const ownerPattern = resolveOwnerPattern(ownerPatternOpt ?? env.LEASE_OWNER_PATTERN);

  function validateOwner(owner) {
    if (typeof owner !== "string" || !ownerPattern.test(owner)) {
      throw new LeaseUsageError(
        `invalid owner ${JSON.stringify(owner)} — must match the owner pattern ${ownerPattern}`,
      );
    }
  }

  mkdirSync(dir, { recursive: true });

  const recordPath = (kind) => join(dir, `${kind}.json`);
  const guardPath = (kind) => join(dir, `.guard-${kind}`);
  const journalPath = join(dir, "reaped.log");

  // ---------------------------------------------------------------- backend --

  /** @returns {object|null} parsed record, `{corrupt:true,...}` on bad JSON, null if absent */
  function readRecord(kind) {
    let raw;
    try {
      raw = readFileSync(recordPath(kind), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { corrupt: true, kind, raw };
      }
      return parsed;
    } catch {
      // A torn/garbage record is indistinguishable from a dead holder: treat it as
      // expired-unknown so it can be reaped — never as held-forever.
      return { corrupt: true, kind, raw };
    }
  }

  /** Atomic write: temp file + rename, so lock-free readers never see torn JSON. */
  function writeRecord(kind, record) {
    const tmp = join(dir, `.tmp-${kind}-${randomUUID()}`);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, recordPath(kind));
  }

  function deleteRecord(kind) {
    try {
      unlinkSync(recordPath(kind));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  function journal(event) {
    appendFileSync(journalPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`);
  }

  // ------------------------------------------------------- guard (the mutex) --

  /**
   * Run `fn` inside the per-kind critical section. Guard entry is an atomic
   * `mkdir`; a stale guard (crashed holder) is reaped via atomic rename-to-unique
   * so exactly one reaper wins and nobody can double-clean. See module header.
   *
   * Guard release is identity-verified: each holder writes a unique id into the
   * guard, and release captures the guard by atomic rename, checks the captured
   * id, and restores the guard if it turned out to belong to a newer holder (i.e.
   * we were stale-reaped mid-hold). Holds last milliseconds and `guardStaleMs`
   * leaves ~4 orders of magnitude of headroom, so a holder can only lose its
   * guard after being suspended for longer than `guardStaleMs`; the id check
   * narrows even that misfire to the limits of what the filesystem permits, and
   * any residual misfire is journaled — never silent.
   */
  function withGuard(kind, fn) {
    const guard = guardPath(kind);
    const holderId = randomUUID();
    const deadline = Date.now() + guardWaitMs;
    for (;;) {
      try {
        mkdirSync(guard);
        try {
          writeFileSync(join(guard, "holder.json"), JSON.stringify({ id: holderId, pid: process.pid }));
        } catch (writeErr) {
          rmSync(guard, { recursive: true, force: true }); // don't leave an id-less guard behind
          throw writeErr;
        }
        break; // we hold the guard
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Guard held — crashed holder? (Holders keep it for milliseconds.)
        let mtimeMs = null;
        try {
          mtimeMs = statSync(guard).mtimeMs;
        } catch (statErr) {
          if (statErr.code !== "ENOENT") throw statErr;
          continue; // released between mkdir and stat — retry immediately
        }
        if (mtimeMs !== null && Date.now() - mtimeMs > guardStaleMs) {
          const reaped = `${guard}.reaped-${randomUUID()}`;
          try {
            renameSync(guard, reaped); // atomic: exactly one reaper wins
            try {
              rmSync(reaped, { recursive: true, force: true });
            } catch {
              /* best-effort; unique name, harmless if left behind */
            }
          } catch (renameErr) {
            if (renameErr.code !== "ENOENT") throw renameErr;
            // Another reaper won — fall through and retry mkdir.
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `lease guard for kind "${kind}" busy for >${guardWaitMs}ms (${guard}) — ` +
              `a guard holder should only live milliseconds; investigate or remove the dir`,
          );
        }
        sleepMs(10 + Math.floor(Math.random() * 40));
      }
    }
    try {
      return fn();
    } finally {
      releaseGuard(guard, holderId);
    }
  }

  /**
   * Identity-verified guard release: atomically capture the guard by renaming it
   * to a unique path, verify the captured holder id is ours, and only then delete
   * it. If the capture turns out to be a NEWER holder's guard (we were reaped as
   * stale while suspended), restore it by renaming back — and journal loudly if
   * even the restore loses a race. Never removes another holder's guard silently.
   */
  function releaseGuard(guard, holderId) {
    const captured = `${guard}.release-${randomUUID()}`;
    try {
      renameSync(guard, captured); // atomic capture: exactly one winner
    } catch (err) {
      if (err.code === "ENOENT") return; // we were stale-reaped; nothing to release
      throw err;
    }
    let capturedId = null;
    try {
      capturedId = JSON.parse(readFileSync(join(captured, "holder.json"), "utf8")).id;
    } catch {
      /* unreadable id — treat as not-ours */
    }
    if (capturedId === holderId) {
      rmSync(captured, { recursive: true, force: true });
      return;
    }
    // We captured a newer holder's guard (possible only after being suspended
    // past guardStaleMs). Put it back.
    try {
      renameSync(captured, guard);
      journal({ event: "guard_lost", guard, holderId });
    } catch {
      // A third holder re-created the guard path in the interim; drop our capture
      // and record the misfire — the affected holder's own release will ENOENT.
      rmSync(captured, { recursive: true, force: true });
      journal({ event: "guard_release_misfire", guard, holderId, capturedId });
    }
  }

  // ------------------------------------------------------------- freshness --

  function isExpired(record) {
    if (record.corrupt) return true;
    const hb = Date.parse(record.heartbeat);
    if (Number.isNaN(hb)) return true;
    const ttlMs = record.ttlMinutes * 60_000;
    if (typeof record.ttlMinutes !== "number" || !(ttlMs > 0)) return true;
    return now() - hb > ttlMs;
  }

  function expiryInfo(record) {
    const hb = Date.parse(record.heartbeat);
    if (Number.isNaN(hb)) return { expiresAt: null };
    const expiresAtMs = hb + record.ttlMinutes * 60_000;
    // Defensive: a hand-written/foreign record with an absurd TTL must not make
    // status()/list()/reconcile() throw (Date.toISOString RangeErrors past ±8.64e15).
    if (!Number.isFinite(expiresAtMs) || Math.abs(expiresAtMs) > 8.64e15) {
      return { expiresAt: null, expiresInMs: null };
    }
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresInMs: expiresAtMs - now(),
    };
  }

  // ------------------------------------------------------------- operations --

  /**
   * Acquire the lease for `kind`. Exactly one concurrent caller wins.
   * Over an expired/corrupt record: succeeds with `tookOverExpired: true` and the
   * previous record attached (loud takeover), and the takeover is journaled.
   */
  function acquire({ kind, owner, ttlMinutes, payload = null }) {
    validateKind(kind);
    validateOwner(owner);
    validateTtl(ttlMinutes);
    return withGuard(kind, () => {
      const existing = readRecord(kind);
      if (existing && !isExpired(existing)) {
        return {
          ok: false,
          code: "held",
          kind,
          holder: existing.owner,
          heldBySelf: existing.owner === owner,
          record: existing,
          ...expiryInfo(existing),
        };
      }
      const nowIso = new Date(now()).toISOString();
      const record = {
        v: RECORD_VERSION,
        kind,
        owner,
        token: randomUUID(),
        heartbeat: nowIso,
        ttlMinutes,
        payload,
        acquiredAt: nowIso,
      };
      writeRecord(kind, record);
      if (existing) {
        journal({ event: "takeover", kind, by: owner, previous: existing });
        return { ok: true, code: "acquired", kind, record, tookOverExpired: true, previous: existing };
      }
      return { ok: true, code: "acquired", kind, record };
    });
  }

  /**
   * Refresh the heartbeat. Requires owner + token (the fencing token minted at
   * acquire). FAILS on an expired lease — no revival; re-acquire instead.
   */
  function heartbeat({ kind, owner, token }) {
    validateKind(kind);
    validateOwner(owner);
    return withGuard(kind, () => {
      const record = readRecord(kind);
      if (!record) return { ok: false, code: "not_held", kind };
      if (record.corrupt) return { ok: false, code: "expired", kind, record };
      if (record.owner !== owner || record.token !== token) {
        return { ok: false, code: "not_owner", kind, holder: record.owner };
      }
      if (isExpired(record)) {
        // Dead-man's-switch: past TTL the lease is forfeit even for its owner.
        return { ok: false, code: "expired", kind, record };
      }
      const updated = { ...record, heartbeat: new Date(now()).toISOString() };
      writeRecord(kind, updated);
      return { ok: true, code: "refreshed", kind, record: updated, ...expiryInfo(updated) };
    });
  }

  /**
   * Release the lease. Requires owner + token; `force: true` is the operator
   * escape hatch (skips both checks, journaled). Releasing a lease that is not
   * held is OK (idempotent): `{ok: true, released: false}`.
   */
  function release({ kind, owner, token, force = false }) {
    validateKind(kind);
    if (!force) validateOwner(owner);
    return withGuard(kind, () => {
      const record = readRecord(kind);
      if (!record) return { ok: true, code: "not_held", kind, released: false };
      if (!force) {
        if (record.corrupt || record.owner !== owner) {
          return { ok: false, code: "not_owner", kind, holder: record.corrupt ? null : record.owner };
        }
        if (record.token !== token) {
          // A takeover happened and someone else's fencing token is on the record.
          return { ok: false, code: "token_mismatch", kind, holder: record.owner };
        }
      }
      deleteRecord(kind);
      if (force) journal({ event: "force_release", kind, previous: record });
      return { ok: true, code: "released", kind, released: true, wasExpired: isExpired(record) };
    });
  }

  /**
   * Reap a dead lease: deletes the record ONLY if it is expired/corrupt (a fresh
   * lease is refused). Journaled. `{ok: true, reaped: false}` when nothing to reap.
   */
  function reap({ kind }) {
    validateKind(kind);
    return withGuard(kind, () => {
      const record = readRecord(kind);
      if (!record) return { ok: true, code: "not_held", kind, reaped: false };
      if (!isExpired(record)) {
        return { ok: false, code: "held", kind, holder: record.owner, ...expiryInfo(record) };
      }
      deleteRecord(kind);
      journal({ event: "reap", kind, previous: record });
      return { ok: true, code: "reaped", kind, reaped: true, previous: record };
    });
  }

  /**
   * Lock-free read. `state` is exactly one of:
   * - "free"    — no record
   * - "held"    — record with a fresh heartbeat
   * - "unknown" — record whose heartbeat is past TTL (or corrupt). NEVER treat
   *               this as held; NEVER treat it as confidently free either.
   */
  function status({ kind }) {
    validateKind(kind);
    const record = readRecord(kind);
    if (!record) return { kind, state: "free" };
    if (isExpired(record)) {
      const hb = record.corrupt ? NaN : Date.parse(record.heartbeat);
      return {
        kind,
        state: "unknown",
        record,
        expiredForMs: Number.isNaN(hb) ? null : now() - hb - record.ttlMinutes * 60_000,
      };
    }
    return { kind, state: "held", holder: record.owner, record, ...expiryInfo(record) };
  }

  /**
   * All lease kinds present in the store (lock-free), each with its status.
   * A `.json` file whose stem is not a valid lease kind (some other tool sharing
   * the dir) is reported as `state: "invalid"` — never passed to the lease ops,
   * never touched.
   */
  function list() {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -".json".length))
      .sort()
      .map((kind) =>
        KIND_PATTERN.test(kind)
          ? status({ kind })
          : { kind, state: "invalid", note: "filename is not a valid lease kind — reported, never touched" },
      );
  }

  /**
   * Session-startup reconciliation: sweep the store, reap every expired
   * lease whose owner is inside the owner fence, report fresh ones, and report —
   * without touching — any record whose owner is outside the fence.
   */
  function reconcile() {
    const held = [];
    const reaped = [];
    const foreign = [];
    for (const entry of list()) {
      if (entry.state === "invalid") {
        foreign.push(entry); // not a lease kind — report, never touch
        continue;
      }
      const ownerOk =
        entry.record && !entry.record.corrupt && ownerPattern.test(String(entry.record.owner ?? ""));
      if (entry.state === "held") {
        if (ownerOk) held.push(entry);
        else foreign.push(entry);
        continue;
      }
      if (entry.state === "unknown") {
        if (!ownerOk && !entry.record?.corrupt) {
          foreign.push(entry); // outside the owner fence — report, never reap
          continue;
        }
        const result = reap({ kind: entry.kind });
        if (result.reaped) reaped.push(result);
        else if (result.code === "held") held.push(status({ kind: entry.kind })); // re-acquired mid-sweep
      }
    }
    return { ok: true, held, reaped, foreign };
  }

  return { dir, ownerPattern, acquire, release, heartbeat, status, reap, reconcile, list };
}
