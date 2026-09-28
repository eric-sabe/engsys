// pool.mjs — a lazy resource pool + lease broker built on the durable-lease primitive.
//
// Zero-dependency ESM, Node >= 20. Brokers a small fixed table of exclusive resource SLOTS
// (a port pair + database + cache index per test environment, a device, a license seat, ...)
// between concurrent sessions on one host. The slot table and the provision / reset / health
// commands come from a JSON pool file (see loadPool); nothing about the resource is built in.
//
// ## The protocol
//
// - The lease is the ONLY mutex: a slot is usable iff you hold its durable lease (kind
//   `<kindPrefix><id>`) — two holders can never share a slot, by construction.
// - **Provision is guaranteed-clean on grant**: the configured provision command runs INSIDE the
//   grant, after the slot lease is acquired and before the grant is handed out. A lessee that
//   died mid-run therefore never leaks dirty state to the next lessee. The optional health
//   command runs right after it; a failing provision or health check releases the slot and
//   surfaces the failure (never a dirty grant).
// - **Saturation -> queue** (serialization fallback): waiters join a durable FIFO queue with
//   position + ETA (position x moving-average lease duration).
// - **Dead-man's reaping is lazy**: every sweep — run at the top of each
//   acquire/request/release/pump — reaps slot leases whose heartbeat is past TTL (the
//   primitive's `unknown` state) and drops queue entries whose waiter stopped heartbeating. An
//   active broker may call `pump()` on an interval, but nothing here assumes one exists.
//
// ## Cooperative grants (no daemon required)
//
// There is no resident broker process. Every WAITER grants itself: a blocking `acquire` polls
// tryGrant() in its own process; an async `request` spawns a small detached waiter process (CLI
// layer) that does the same and fires the grant nudge. A process may only self-grant when the
// count of free slots exceeds the count of live queue entries ahead of it — FIFO fairness
// without a central granter. Slot acquisition itself is the primitive's mutexed acquire, so two
// waiters racing for the last slot have exactly one winner (the loser retries next poll).
//
// ## The nudge is pluggable
//
// Grant notification for async requests goes through an injected `notifier`. The default appends
// a JSON line to <store>/<name>/nudges.jsonl (a durable channel another process can drain) and,
// when a nudge command is configured (`nudgeCommand` / $POOL_NUDGE_CMD), pipes the same JSON to
// that command's stdin. The nudge is latency, not truth: the durable grant is always recoverable
// with `claim`.
//
// ## On-disk compatibility (hard contract)
//
// Pool state lives beside the lease records: <store>/<name>/{queue.json, stats.json,
// grants/<request-id>.json, nudges.jsonl, pool.log}, slot leases are `<kindPrefix><id>` records
// and the queue-mutation lock is the lease `queueLockKind`. The record shapes are a stable format
// shared with other implementations on the same host. The pool file's `name`, `kindPrefix`,
// `queueLockKind` and `nudgeEvent` let a pool reproduce an existing store's names exactly; the
// cross-implementation test (LEASE_REFERENCE_IMPL) guards it.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { createLeaseStore, KIND_PATTERN, LeaseUsageError } from "./durable-lease.mjs";

export const DEFAULT_TTL_MINUTES = 30; // slot lease TTL — lessees heartbeat long runs
export const DEFAULT_WAITER_STALE_MS = 90_000; // queue entry with no heartbeat this long is dropped
export const DEFAULT_MOVING_AVG_SEED_MS = 8 * 60_000; // ETA seed before any history exists
const MOVING_AVG_WINDOW = 10; // last N lease durations feed the moving average
const GRANT_FILE_MAX_AGE_MS = 24 * 60 * 60_000; // sweep deletes grant files older than this

/** Slot keys that are structural, not resource attributes. */
const RESERVED_SLOT_KEYS = new Set(["id", "kind"]);

/** Built-in grant fields that `grantFields` may not shadow. */
const RESERVED_GRANT_FIELDS = new Set(["ok", "state", "request_id", "mode", "slot_id", "kind", "owner", "token", "ttlMinutes", "attrs", "env", "grantedAt"]);

/** Thrown for a malformed pool file (exit 2 in the CLI, like any usage error). */
export class PoolConfigError extends LeaseUsageError {
  constructor(message) {
    super(message);
    this.name = "PoolConfigError";
  }
}

// ---------------------------------------------------------------- pool file --

/** Look up a dotted path (`ports.api`) in an attribute object. */
function lookup(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Render a template against a slot's attributes (plus `id` and `kind`). A template that is
 * exactly `{path}` yields the raw value (objects and numbers survive); otherwise every `{path}`
 * is interpolated into the string. An unresolvable placeholder throws.
 */
export function renderTemplate(template, slot) {
  if (typeof template !== "string") return template;
  const scope = { ...slot.attrs, id: slot.id, kind: slot.kind };
  const whole = /^\{([A-Za-z0-9_.]+)\}$/.exec(template);
  const resolveOne = (path) => {
    const value = lookup(scope, path);
    if (value === undefined) {
      throw new PoolConfigError(`template ${JSON.stringify(template)} references unknown slot attribute "${path}" (slot ${slot.id})`);
    }
    return value;
  };
  if (whole) return resolveOne(whole[1]);
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (_, path) => {
    const value = resolveOne(path);
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  });
}

function envKey(parts) {
  return parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function flatten(prefixParts, value, out) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten([...prefixParts, k], v, out);
    return;
  }
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? JSON.stringify(value) : String(value);
  out[envKey(prefixParts)] = text;
}

/**
 * The environment a slot's commands receive: `POOL_SLOT_ID`, `POOL_SLOT_KIND`, and one
 * `POOL_SLOT_<UPPERCASE_KEY>` per attribute. Nested objects flatten with `_`
 * (`{ports:{api:3000}}` -> `POOL_SLOT_PORTS_API=3000`); arrays become JSON.
 */
export function slotEnv(slot) {
  const out = { POOL_SLOT_ID: String(slot.id), POOL_SLOT_KIND: slot.kind };
  const attrEnv = {};
  flatten([], slot.attrs, attrEnv);
  // flatten([], obj) prefixes nothing; add the POOL_SLOT_ prefix here.
  for (const [k, v] of Object.entries(attrEnv)) out[`POOL_SLOT_${k}`] = v;
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate + normalize a pool definition (the parsed pool file).
 *
 * Pool file (JSON):
 *   {
 *     "name": "pool",                 // state dir under the store (default "pool")
 *     "kindPrefix": "slot-",          // slot lease kind = kindPrefix + id (default "slot-")
 *     "queueLockKind": "pool-queue",  // queue-mutation lock kind (default `${name}-queue`)
 *     "nudgeEvent": "lease-granted",  // `event` field of async-grant nudges
 *     "shellPrefix": "POOL_LEASE",    // --shell also exports <prefix>_SLOT / _TOKEN / _OWNER
 *     "bookkeeper": "pool-keeper",    // owner for internal bookkeeping on `--force` releases
 *     "ttlMinutes": 30, "waiterStaleMs": 90000, "movingAvgSeedMs": 480000,
 *     "cwd": ".",                     // working dir for commands (relative to the pool file)
 *     "provision": "bash provision.sh --slot",  // runs on every grant; the slot id is appended as "$1"
 *     "reset": "...",                 // between-use reset (`pool-cli reset`); defaults to provision
 *     "health": "...",                // verifies the slot after provision, before the grant
 *     "nudgeCommand": "...",          // receives the grant nudge JSON on stdin
 *     "grantEnv": { "DB_URL": "postgres://localhost/{db}" },  // env handed out with a grant
 *     "grantFields": { "ports": "{ports}" },                  // extra top-level grant fields
 *     "slots": [ { "id": 1, "ports": { "api": 3000 }, "db": "app_test_1" } ]
 *   }
 *
 * Every slot has an `id` (string or number) and arbitrary other keys, its attributes. `kind`
 * overrides the derived lease kind for one slot.
 */
export function normalizePool(def, { baseDir = process.cwd() } = {}) {
  if (!isPlainObject(def)) throw new PoolConfigError("pool definition must be a JSON object");
  if (!Array.isArray(def.slots) || def.slots.length === 0) throw new PoolConfigError('pool definition needs a non-empty "slots" array');

  const name = def.name ?? "pool";
  if (typeof name !== "string" || !KIND_PATTERN.test(name)) throw new PoolConfigError(`invalid pool "name" ${JSON.stringify(name)} — must match ${KIND_PATTERN}`);
  const kindPrefix = def.kindPrefix ?? "slot-";
  if (typeof kindPrefix !== "string") throw new PoolConfigError('"kindPrefix" must be a string');
  const queueLockKind = def.queueLockKind ?? `${name}-queue`;
  if (typeof queueLockKind !== "string" || !KIND_PATTERN.test(queueLockKind)) {
    throw new PoolConfigError(`invalid "queueLockKind" ${JSON.stringify(queueLockKind)} — must match ${KIND_PATTERN}`);
  }
  for (const field of ["provision", "reset", "health", "nudgeCommand", "nudgeEvent", "shellPrefix", "bookkeeper"]) {
    if (def[field] !== undefined && typeof def[field] !== "string") throw new PoolConfigError(`"${field}" must be a string`);
  }
  for (const field of ["ttlMinutes", "waiterStaleMs", "movingAvgSeedMs"]) {
    if (def[field] !== undefined && !(typeof def[field] === "number" && Number.isFinite(def[field]) && def[field] > 0)) {
      throw new PoolConfigError(`"${field}" must be a positive number`);
    }
  }
  for (const field of ["grantEnv", "grantFields"]) {
    if (def[field] !== undefined && !isPlainObject(def[field])) throw new PoolConfigError(`"${field}" must be an object`);
  }
  for (const k of Object.keys(def.grantFields ?? {})) {
    if (RESERVED_GRANT_FIELDS.has(k)) throw new PoolConfigError(`grantFields key ${JSON.stringify(k)} collides with a built-in grant field`);
  }
  if (def.grantEnv) {
    for (const [k, v] of Object.entries(def.grantEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new PoolConfigError(`grantEnv key ${JSON.stringify(k)} is not a valid environment variable name`);
      if (typeof v !== "string") throw new PoolConfigError(`grantEnv.${k} must be a template string`);
    }
  }

  const seenIds = new Set();
  const seenKinds = new Set();
  const slots = def.slots.map((raw, i) => {
    if (!isPlainObject(raw)) throw new PoolConfigError(`slots[${i}] must be an object`);
    if (raw.id === undefined || !(typeof raw.id === "string" || typeof raw.id === "number") || raw.id === "") {
      throw new PoolConfigError(`slots[${i}] needs an "id" (string or number)`);
    }
    if (seenIds.has(String(raw.id))) throw new PoolConfigError(`duplicate slot id ${JSON.stringify(raw.id)}`);
    seenIds.add(String(raw.id));
    const kind = raw.kind ?? `${kindPrefix}${raw.id}`;
    if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
      throw new PoolConfigError(`slot ${JSON.stringify(raw.id)} lease kind ${JSON.stringify(kind)} must match ${KIND_PATTERN}`);
    }
    if (seenKinds.has(kind) || kind === queueLockKind) throw new PoolConfigError(`duplicate lease kind ${JSON.stringify(kind)}`);
    seenKinds.add(kind);
    const attrs = {};
    for (const [k, v] of Object.entries(raw)) if (!RESERVED_SLOT_KEYS.has(k)) attrs[k] = v;
    return Object.freeze({ id: raw.id, kind, attrs: Object.freeze(attrs) });
  });

  const pool = {
    name,
    kindPrefix,
    queueLockKind,
    nudgeEvent: def.nudgeEvent ?? "lease-granted",
    shellPrefix: def.shellPrefix ?? "POOL_LEASE",
    bookkeeper: def.bookkeeper,
    ttlMinutes: def.ttlMinutes,
    waiterStaleMs: def.waiterStaleMs,
    movingAvgSeedMs: def.movingAvgSeedMs,
    cwd: resolve(baseDir, def.cwd ?? "."),
    commands: { provision: def.provision, reset: def.reset, health: def.health },
    nudgeCommand: def.nudgeCommand,
    grantEnv: def.grantEnv ?? null,
    grantFields: def.grantFields ?? {},
    slots: Object.freeze(slots),
  };
  // Fail at load, not at first grant: every template must resolve for every slot.
  for (const slot of pool.slots) grantParts(pool, slot);
  return Object.freeze(pool);
}

/** Read + normalize a pool file. Relative `cwd` resolves against the file's directory. */
export function loadPool(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new PoolConfigError(`cannot read pool file ${file}: ${err.code ?? err.message}`);
  }
  let def;
  try {
    def = JSON.parse(raw);
  } catch (err) {
    throw new PoolConfigError(`pool file ${file} is not valid JSON: ${err.message}`);
  }
  return normalizePool(def, { baseDir: dirname(resolve(file)) });
}

/** What a grant carries beyond the lease: the env to export and any extra top-level fields. */
function grantParts(pool, slot) {
  let env;
  if (pool.grantEnv) {
    env = {};
    for (const [k, tpl] of Object.entries(pool.grantEnv)) {
      const v = renderTemplate(tpl, slot);
      env[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    }
  } else {
    env = slotEnv(slot);
  }
  const fields = {};
  for (const [k, tpl] of Object.entries(pool.grantFields)) fields[k] = renderTemplate(tpl, slot);
  return { env, fields };
}

// ------------------------------------------------------------ command hooks --

/**
 * Run one configured command for a slot. The command string runs under `sh -c` with the slot id
 * appended as `"$1"`, in the pool's `cwd`, with POOL_SLOT_* in the environment. Its stdout is
 * redirected to OUR stderr so a CLI's stdout stays exactly one JSON object.
 */
export function runSlotCommand(pool, slot, action, command, { env = process.env } = {}) {
  const res = spawnSync("sh", ["-c", `${command} "$1"`, `pool-${action}`, String(slot.id)], {
    cwd: pool.cwd,
    stdio: ["ignore", 2, "inherit"],
    env: { ...env, ...slotEnv(slot), POOL_ACTION: action },
  });
  return res;
}

function commandFn(pool, action, command, env) {
  return (slot) => {
    const res = runSlotCommand(pool, slot, action, command, { env });
    if (res.error) throw new Error(`slot ${slot.id} ${action === "health" ? "health check" : "reset"} failed (${res.error.message})`);
    if (res.status !== 0) {
      throw new Error(
        action === "health"
          ? `slot ${slot.id} health check failed (${command} exit ${res.status})`
          : `slot ${slot.id} reset failed (${action} command exit ${res.status})`,
      );
    }
  };
}

/**
 * Default grant notifier: durable jsonl drop + optional command hook.
 * NEVER throws — the grant already happened; a failed nudge must not undo it.
 */
export function defaultNotifier(poolDir, nudgeCommand) {
  return (payload) => {
    const line = JSON.stringify(payload);
    try {
      appendFileSync(join(poolDir, "nudges.jsonl"), `${line}\n`);
    } catch {
      /* best-effort */
    }
    if (!nudgeCommand) return;
    try {
      spawnSync("sh", ["-c", nudgeCommand], { input: line, stdio: ["pipe", "ignore", "inherit"], timeout: 15_000 });
    } catch {
      /* best-effort — never let a nudge failure break the grant path */
    }
  };
}

/** Env-var fallbacks. The E2E_LEASE_* names are legacy aliases so an existing broker config keeps working. */
function envCommand(env, ...names) {
  for (const n of names) if (env[n]) return env[n];
  return undefined;
}

// --------------------------------------------------------------------- pool --

/**
 * Create the pool broker.
 *
 * @param {object} opts
 * @param {object|string} opts.pool a normalized pool (loadPool / normalizePool), a raw pool
 *   definition object, or a path to a pool file
 * @param {string} [opts.store] lease store dir (see createLeaseStore: option > $LEASE_STORE > <git toplevel>/logs/leases). `dir` is an alias.
 * @param {RegExp|string} [opts.ownerPattern] owner fence (option > $LEASE_OWNER_PATTERN > default)
 * @param {() => number} [opts.now] clock — injectable for tests
 * @param {(slot: object) => void} [opts.provision] grant-time provisioner — replaces the configured
 *   command (`provision`, else `reset`; overridable by $POOL_PROVISION_CMD / $POOL_RESET_CMD)
 * @param {(slot: object) => void} [opts.health] post-provision health check — replaces the configured command
 * @param {(slot: object) => void} [opts.reset] between-use reset (`resetSlot`) — replaces the configured command
 * @param {(payload: object) => void} [opts.notifier] async-grant nudge — injectable
 * @param {number} [opts.ttlMinutes] slot lease TTL
 * @param {number} [opts.waiterStaleMs] queue-entry heartbeat staleness cutoff
 * @param {number} [opts.movingAvgSeedMs] ETA seed before history exists
 * @param {object} [opts.env] environment for command overrides (default process.env)
 */
export function createPool({
  pool: poolInput,
  store: storeOpt,
  dir: dirOpt,
  ownerPattern,
  now = Date.now,
  provision,
  health,
  reset,
  notifier,
  ttlMinutes,
  waiterStaleMs,
  movingAvgSeedMs,
  env = process.env,
} = {}) {
  if (poolInput === undefined) throw new PoolConfigError("createPool needs a pool (definition, normalized pool, or pool file path)");
  const pool =
    typeof poolInput === "string"
      ? loadPool(poolInput)
      : Array.isArray(poolInput.slots) && poolInput.slots.every((s) => s.attrs) && poolInput.commands
        ? poolInput
        : normalizePool(poolInput);

  const ttl = ttlMinutes ?? pool.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const staleMs = waiterStaleMs ?? pool.waiterStaleMs ?? DEFAULT_WAITER_STALE_MS;
  const avgSeedMs = movingAvgSeedMs ?? pool.movingAvgSeedMs ?? DEFAULT_MOVING_AVG_SEED_MS;

  const store = createLeaseStore({ store: storeOpt ?? dirOpt, ownerPattern, now, env });
  const dir = store.dir;
  const poolDir = join(dir, pool.name);
  const grantsDir = join(poolDir, "grants");
  mkdirSync(grantsDir, { recursive: true });
  const nudgeCommand = envCommand(env, "POOL_NUDGE_CMD", "E2E_LEASE_NUDGE_CMD") ?? pool.nudgeCommand;
  const notify = notifier ?? defaultNotifier(poolDir, nudgeCommand);
  const SLOTS = pool.slots;
  const QUEUE_LOCK_KIND = pool.queueLockKind;

  // Command resolution: injected function > env override > pool-file command.
  const provisionCmd = envCommand(env, "POOL_PROVISION_CMD", "E2E_LEASE_RESET_CMD") ?? pool.commands.provision ?? pool.commands.reset;
  const resetCmd = envCommand(env, "POOL_RESET_CMD") ?? pool.commands.reset ?? provisionCmd;
  const healthCmd = envCommand(env, "POOL_HEALTH_CMD") ?? pool.commands.health;
  const runProvision = provision ?? (provisionCmd ? commandFn(pool, "provision", provisionCmd, env) : () => {});
  const runReset = reset ?? (resetCmd ? commandFn(pool, "reset", resetCmd, env) : () => {});
  const runHealth = health ?? (healthCmd ? commandFn(pool, "health", healthCmd, env) : () => {});

  const queuePath = join(poolDir, "queue.json");
  const statsPath = join(poolDir, "stats.json");
  const journalPath = join(poolDir, "pool.log");

  const findSlot = (slotId) =>
    SLOTS.find((s) => String(s.id) === String(slotId)) ??
    SLOTS.find((s) => typeof s.id === "number" && slotId !== "" && Number(slotId) === s.id);
  const requireSlot = (slotId) => {
    const slot = findSlot(slotId);
    if (!slot) throw new LeaseUsageError(`invalid slot id ${JSON.stringify(slotId)} — pool has slots ${SLOTS.map((s) => s.id).join(", ")}`);
    return slot;
  };

  // ------------------------------------------------------------- state io --

  function journal(event) {
    appendFileSync(journalPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`);
  }

  function readJson(path, fallback) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return fallback;
    }
  }

  /** Atomic write (temp + rename) so lock-free readers never see torn JSON. */
  function writeJson(path, value) {
    const tmp = join(poolDir, `.tmp-${randomUUID()}`);
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
  }

  const readQueue = () => readJson(queuePath, { entries: [] });
  const readStats = () => readJson(statsPath, { durationsMs: [] });

  /**
   * Queue/stats mutations run under a short-TTL durable lease acting as the
   * mutation lock — dogfooding the primitive instead of re-implementing a
   * guard. A mutator that dies mid-hold expires in 1 minute and the next
   * caller takes over (loudly, via the primitive's journal).
   */
  function withQueueLock(owner, fn) {
    const deadline = Date.now() + 10_000;
    let lock;
    for (;;) {
      lock = store.acquire({ kind: QUEUE_LOCK_KIND, owner, ttlMinutes: 1 });
      if (lock.ok) break;
      if (Date.now() >= deadline) {
        throw new Error(`pool queue lock busy >10s (held by ${lock.holder}) — investigate ${join(dir, `${QUEUE_LOCK_KIND}.json`)}`);
      }
      const jitter = 25 + Math.floor(Math.random() * 75);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, jitter);
    }
    try {
      return fn();
    } finally {
      store.release({ kind: QUEUE_LOCK_KIND, owner, token: lock.record.token });
    }
  }

  // -------------------------------------------------------------- helpers --

  const grantPath = (requestId) => join(grantsDir, `${requestId}.json`);
  const readGrant = (requestId) => readJson(grantPath(requestId), null);

  function liveEntries(queue) {
    return queue.entries.filter((e) => now() - Date.parse(e.heartbeat) <= staleMs);
  }

  function movingAvgMs(stats = readStats()) {
    const d = stats.durationsMs;
    if (!d.length) return avgSeedMs;
    return Math.round(d.reduce((a, b) => a + b, 0) / d.length);
  }

  /** ETA = queue position x moving-average lease duration. Position is 1-based. */
  const etaMsFor = (position, avg = movingAvgMs()) => position * avg;

  function slotStates() {
    return SLOTS.map((slot) => ({ slot, status: store.status({ kind: slot.kind }) }));
  }

  function buildGrant({ slot, record, requestId, mode }) {
    const { env: grantEnv, fields } = grantParts(pool, slot);
    return {
      ok: true,
      state: "ready",
      request_id: requestId,
      mode,
      slot_id: slot.id,
      kind: slot.kind,
      owner: record.owner,
      token: record.token,
      ttlMinutes: record.ttlMinutes,
      attrs: slot.attrs,
      ...fields,
      env: grantEnv,
      grantedAt: new Date(now()).toISOString(),
    };
  }

  // ---------------------------------------------------------------- sweep --

  /**
   * Lazy dead-man's reaping: reap slot leases whose heartbeat expired (primitive state
   * "unknown"), drop queue entries whose waiter went silent, and age out old grant files. Runs
   * at the top of every mutating op, so the mechanism works purely via the CLI.
   */
  function sweep(owner) {
    const reapedSlots = [];
    for (const { slot, status } of slotStates()) {
      if (status.state === "unknown") {
        const r = store.reap({ kind: slot.kind });
        if (r.reaped) {
          reapedSlots.push({ slot_id: slot.id, previousOwner: r.previous?.owner ?? null });
          journal({ event: "slot_reaped", slot_id: slot.id, previous: r.previous });
        }
      }
    }
    const droppedEntries = withQueueLock(owner, () => {
      const queue = readQueue();
      const live = [];
      const dropped = [];
      for (const e of queue.entries) {
        if (now() - Date.parse(e.heartbeat) > staleMs) dropped.push(e);
        else live.push(e);
      }
      if (dropped.length) {
        writeJson(queuePath, { entries: live });
        for (const e of dropped) journal({ event: "queue_entry_dropped_stale", entry: e });
      }
      return dropped;
    });
    // Age out grant files (lock-free; unlink is idempotent).
    try {
      for (const f of readdirSync(grantsDir)) {
        const p = join(grantsDir, f);
        try {
          if (now() - statSync(p).mtimeMs > GRANT_FILE_MAX_AGE_MS) unlinkSync(p);
        } catch {
          /* raced — fine */
        }
      }
    } catch {
      /* best-effort */
    }
    return { reapedSlots, droppedEntries };
  }

  // ---------------------------------------------------------------- queue --

  /** Join the queue. Returns {entry, position, etaMs}. */
  function enqueue({ owner, session = owner, mode }) {
    if (mode !== "blocking" && mode !== "async") throw new LeaseUsageError(`invalid mode ${JSON.stringify(mode)}`);
    sweep(owner);
    return withQueueLock(owner, () => {
      const queue = readQueue();
      const entry = {
        id: randomUUID(),
        owner,
        session,
        mode,
        enqueuedAt: new Date(now()).toISOString(),
        heartbeat: new Date(now()).toISOString(),
      };
      const entries = [...liveEntries(queue), entry];
      writeJson(queuePath, { entries });
      const position = entries.length; // 1-based
      return { entry, position, etaMs: etaMsFor(position) };
    });
  }

  /** Refresh a queue entry's heartbeat; returns current {position, etaMs} or null if the entry is gone. */
  function heartbeatEntry({ entryId, owner }) {
    return withQueueLock(owner, () => {
      const queue = readQueue();
      const entries = liveEntries(queue);
      const idx = entries.findIndex((e) => e.id === entryId);
      if (idx === -1) {
        if (entries.length !== queue.entries.length) writeJson(queuePath, { entries });
        return null;
      }
      entries[idx] = { ...entries[idx], heartbeat: new Date(now()).toISOString() };
      writeJson(queuePath, { entries });
      return { position: idx + 1, etaMs: etaMsFor(idx + 1) };
    });
  }

  /** Remove own entry (grant, timeout, or give-up). */
  function dequeue({ entryId, owner }) {
    withQueueLock(owner, () => {
      const queue = readQueue();
      const entries = queue.entries.filter((e) => e.id !== entryId);
      if (entries.length !== queue.entries.length) writeJson(queuePath, { entries });
    });
  }

  // ---------------------------------------------------------------- grant --

  /**
   * One self-grant attempt for the queue entry `entryId` (cooperative broker: every waiter
   * grants ITSELF — see module header). Returns the grant when it wins a slot, or null (stay
   * queued, poll again).
   *
   * Fairness: may only proceed when freeSlots > live entries ahead of us.
   * Mutual exclusion: the slot's durable-lease acquire — exactly one winner.
   * Provision: runs AFTER the slot lease is held, BEFORE the grant is returned ("guaranteed-clean
   * on grant"), followed by the health check; on failure the slot is released and the failure is
   * written to the grant file so an async claimant sees it.
   */
  function tryGrant({ entryId, owner, ttlMinutes: grantTtl = ttl }) {
    sweep(owner);
    const { myEntry, aheadIds } = withQueueLock(owner, () => {
      const entries = liveEntries(readQueue());
      const idx = entries.findIndex((e) => e.id === entryId);
      return {
        myEntry: idx === -1 ? null : entries[idx],
        aheadIds: idx === -1 ? [] : entries.slice(0, idx).map((e) => e.id),
      };
    });
    if (!myEntry) return null; // dropped as stale (or already granted+dequeued)
    const states = slotStates();
    const free = states.filter((s) => s.status.state === "free");
    // An entry ahead of us that ALREADY holds a slot (granted, but not yet
    // dequeued — the grant path acquires the slot before dequeuing) is not
    // really waiting: discount it, or a racing waiter would undercount free
    // capacity and spuriously refuse.
    const grantedAhead = states.filter(
      (s) => s.status.state === "held" && aheadIds.includes(s.status.record?.payload?.requestId),
    ).length;
    if (free.length <= aheadIds.length - grantedAhead) return null; // not our turn yet
    for (const { slot } of free) {
      const res = store.acquire({
        kind: slot.kind,
        owner,
        ttlMinutes: grantTtl,
        payload: { requestId: entryId, session: myEntry.session, mode: myEntry.mode },
      });
      if (!res.ok) continue; // lost the race for this slot — try the next free one
      if (res.tookOverExpired) journal({ event: "slot_takeover_on_grant", slot_id: slot.id, previous: res.previous });
      dequeue({ entryId, owner });
      const failWith = (state, eventName, err) => {
        // Slot is NOT usable — release it and surface the failure.
        store.release({ kind: slot.kind, owner, token: res.record.token });
        const failure = {
          ok: false,
          state,
          request_id: entryId,
          slot_id: slot.id,
          error: String(err?.message ?? err),
          at: new Date(now()).toISOString(),
        };
        writeJson(grantPath(entryId), failure);
        journal({ event: eventName, slot_id: slot.id, request_id: entryId, error: failure.error });
      };
      try {
        runProvision(slot);
      } catch (err) {
        failWith("reset_failed", "grant_reset_failed", err);
        throw err;
      }
      try {
        runHealth(slot);
      } catch (err) {
        failWith("health_failed", "grant_health_failed", err);
        throw err;
      }
      // Post-provision fencing check: a provision longer than the TTL (or a mid-provision
      // takeover) means we no longer own the slot — never hand out a grant we can't back with a
      // live lease.
      const post = store.status({ kind: slot.kind });
      if (post.state !== "held" || post.record?.token !== res.record.token) {
        const failure = {
          ok: false,
          state: "lease_lost_during_reset",
          request_id: entryId,
          slot_id: slot.id,
          error: `slot ${slot.id} lease lost during reset (ttl ${grantTtl}m shorter than the reset, or taken over) — increase --ttl`,
          at: new Date(now()).toISOString(),
        };
        writeJson(grantPath(entryId), failure);
        journal({ event: "grant_lease_lost_during_reset", slot_id: slot.id, request_id: entryId });
        throw new Error(failure.error);
      }
      const grant = buildGrant({ slot, record: res.record, requestId: entryId, mode: myEntry.mode });
      writeJson(grantPath(entryId), grant);
      journal({ event: "granted", slot_id: slot.id, request_id: entryId, owner, mode: myEntry.mode });
      if (myEntry.mode === "async") {
        // The grant channel: injected/pluggable; the default drops to nudges.jsonl (+ optional cmd).
        notify({ event: pool.nudgeEvent, session: myEntry.session, request_id: entryId, grant });
      }
      return grant;
    }
    return null; // raced out of every free slot — poll again
  }

  // ----------------------------------------------------------- public ops --

  /**
   * Blocking acquire (the hook / gate path). Polls tryGrant until granted or `waitMs` elapses;
   * calls `onWait({position, etaMs, avgMs})` each round so the CLI can print a legible wait.
   */
  async function acquireBlocking({ owner, session = owner, ttlMinutes: grantTtl = ttl, waitMs = Infinity, pollMs = 5_000, onWait = () => {} }) {
    const { entry, position, etaMs } = enqueue({ owner, session, mode: "blocking" });
    const deadline = waitMs === Infinity ? Infinity : Date.now() + waitMs;
    try {
      for (;;) {
        const grant = tryGrant({ entryId: entry.id, owner, ttlMinutes: grantTtl });
        if (grant) return grant;
        if (Date.now() >= deadline) {
          dequeue({ entryId: entry.id, owner });
          return { ok: false, code: "timeout", request_id: entry.id, position, etaMs, waitedMs: waitMs };
        }
        const pos = heartbeatEntry({ entryId: entry.id, owner });
        if (!pos) {
          // Our queue entry was dropped as stale (process suspended past waiterStaleMs, or
          // externally cleared). Nobody grants on our behalf in blocking mode, so the entry is
          // gone for good — refuse loudly instead of spinning forever (waitMs may be Infinity).
          return {
            ok: false,
            code: "queue_entry_lost",
            request_id: entry.id,
            note: `queue entry dropped as stale (waiterStaleMs=${staleMs}) — re-run acquire`,
          };
        }
        onWait({ ...pos, avgMs: movingAvgMs() });
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (err) {
      dequeue({ entryId: entry.id, owner });
      throw err;
    }
  }

  /** One-shot acquire: grant now or report queue depth (no waiting, no queue residue). */
  function acquireNoWait({ owner, session = owner, ttlMinutes: grantTtl = ttl }) {
    const { entry } = enqueue({ owner, session, mode: "blocking" });
    let grant;
    try {
      grant = tryGrant({ entryId: entry.id, owner, ttlMinutes: grantTtl });
    } finally {
      if (!grant) dequeue({ entryId: entry.id, owner });
    }
    if (grant) return grant;
    const q = poolStatus();
    return { ok: false, code: "saturated", position: q.queue.length + 1, etaMs: etaMsFor(q.queue.length + 1) };
  }

  /**
   * Async/deferred mode: enqueue and return {queued, position, eta} immediately. The CALLER (CLI)
   * spawns the detached waiter that polls tryGrant and lets the notifier fire on grant.
   */
  function request({ owner, session = owner }) {
    const { entry, position, etaMs } = enqueue({ owner, session, mode: "async" });
    journal({ event: "request_queued", request_id: entry.id, owner, session, position });
    return { ok: true, queued: true, request_id: entry.id, owner, session, position, etaMs };
  }

  /** Look up an async request: the grant if ready/failed, else live position/eta, else lost. */
  function claim({ requestId, owner }) {
    const grant = readGrant(requestId);
    if (grant) {
      if (grant.state !== "ready") return grant; // reset_failed / health_failed / lease_lost_* — surface as recorded
      // A grant is only as good as its lease: if the slot expired (claimant slept past TTL) or
      // was reaped/taken over, the resource may belong to someone else now — refuse instead of
      // handing out a stale grant.
      const slot = findSlot(grant.slot_id);
      if (!slot) {
        return { ok: false, state: "unknown_slot", request_id: requestId, slot_id: grant.slot_id, note: "the granted slot is not in this pool" };
      }
      const st = store.status({ kind: slot.kind });
      if (st.state !== "held" || st.record?.token !== grant.token) {
        return {
          ok: false,
          state: "lease_lost",
          request_id: requestId,
          slot_id: grant.slot_id,
          note: "the granted lease expired or was taken over before it was claimed — re-request",
        };
      }
      return grant;
    }
    sweep(owner);
    const entries = withQueueLock(owner, () => liveEntries(readQueue()));
    const idx = entries.findIndex((e) => e.id === requestId);
    if (idx === -1) return { ok: false, code: "unknown_request", request_id: requestId, note: "not queued and no grant on file — re-request" };
    return { ok: true, queued: true, request_id: requestId, position: idx + 1, etaMs: etaMsFor(idx + 1) };
  }

  /** Owner for internal bookkeeping when the caller passed none (`--force` release). Must satisfy the owner fence. */
  function bookkeeperFor(owner) {
    if (owner) return owner;
    if (!pool.bookkeeper) {
      throw new LeaseUsageError('a forced release without --owner needs a "bookkeeper" owner in the pool file (it must satisfy the owner pattern)');
    }
    return pool.bookkeeper;
  }

  /** Release a slot lease (fencing-token verified) and record the lease duration for the ETA moving average. */
  function release({ slotId, owner, token, force = false }) {
    const slot = requireSlot(slotId);
    const before = store.status({ kind: slot.kind });
    const res = store.release({ kind: slot.kind, owner, token, force });
    if (res.ok && res.released && before.record?.acquiredAt) {
      const duration = now() - Date.parse(before.record.acquiredAt);
      const bookkeeper = force ? bookkeeperFor(owner) : owner;
      if (Number.isFinite(duration) && duration > 0) {
        withQueueLock(bookkeeper, () => {
          const stats = readStats();
          const durationsMs = [...stats.durationsMs, duration].slice(-MOVING_AVG_WINDOW);
          writeJson(statsPath, { durationsMs });
        });
      }
      // Bookkeeping sweep so waiting pollers see accurate positions promptly.
      // (Grants themselves happen in the waiters' own processes.)
      try {
        sweep(bookkeeper);
      } catch {
        /* sweep is best-effort here */
      }
    }
    return { ...res, slot_id: slot.id };
  }

  /** Heartbeat a slot lease (passthrough to the primitive — no revival past TTL). */
  function heartbeat({ slotId, owner, token }) {
    const slot = requireSlot(slotId);
    return { ...store.heartbeat({ kind: slot.kind, owner, token }), slot_id: slot.id };
  }

  /**
   * Between-use reset of a slot the caller HOLDS (owner + fencing token verified): runs the
   * `reset` command (defaults to provision) then the health check. For multi-phase runs that
   * want a clean slot between phases without releasing it.
   */
  function resetSlot({ slotId, owner, token }) {
    const slot = requireSlot(slotId);
    const st = store.status({ kind: slot.kind });
    if (st.state !== "held" || st.record?.owner !== owner || st.record?.token !== token) {
      return { ok: false, code: st.state === "held" ? "not_owner" : "not_held", slot_id: slot.id };
    }
    try {
      runReset(slot);
      runHealth(slot);
    } catch (err) {
      return { ok: false, code: "reset_failed", slot_id: slot.id, error: String(err?.message ?? err) };
    }
    return { ok: true, code: "reset", slot_id: slot.id };
  }

  /**
   * Broker-side reprovision of a slot NOBODY holds: takes the slot's lease under `owner` (so no
   * waiter can be granted it meanwhile), runs the reset command and the health check, and
   * releases it again. A held slot is refused (`code: "held"`): its holder resets it with
   * `resetSlot`. The lease duration is not recorded in the ETA statistics, since no run happened.
   * Additive: no existing operation or on-disk record changes.
   */
  function reprovisionSlot({ slotId, owner, ttlMinutes: leaseTtl = ttl }) {
    const slot = requireSlot(slotId);
    const res = store.acquire({ kind: slot.kind, owner, ttlMinutes: leaseTtl, payload: { reprovision: true } });
    if (!res.ok) return { ok: false, code: "held", slot_id: slot.id, holder: res.holder };
    if (res.tookOverExpired) journal({ event: "slot_takeover_on_reprovision", slot_id: slot.id, previous: res.previous });
    let outcome;
    try {
      runReset(slot);
      runHealth(slot);
      outcome = { ok: true, code: "reprovisioned", slot_id: slot.id };
    } catch (err) {
      outcome = { ok: false, code: "reset_failed", slot_id: slot.id, error: String(err?.message ?? err) };
    } finally {
      store.release({ kind: slot.kind, owner, token: res.record.token });
    }
    journal({ event: outcome.ok ? "slot_reprovisioned" : "slot_reprovision_failed", slot_id: slot.id, owner, ...(outcome.error ? { error: outcome.error } : {}) });
    return outcome;
  }

  /** Run the health check for a slot (read-only; no lease needed). */
  function healthCheck({ slotId }) {
    const slot = requireSlot(slotId);
    try {
      runHealth(slot);
    } catch (err) {
      return { ok: false, code: "unhealthy", slot_id: slot.id, error: String(err?.message ?? err) };
    }
    return { ok: true, code: "healthy", slot_id: slot.id };
  }

  /** Lock-free pool overview: slots, queue (with 1-based positions + ETAs), moving average. */
  function poolStatus() {
    const avg = movingAvgMs();
    const queue = liveEntries(readQueue()).map((e, i) => ({
      request_id: e.id,
      owner: e.owner,
      session: e.session,
      mode: e.mode,
      position: i + 1,
      etaMs: etaMsFor(i + 1, avg),
      enqueuedAt: e.enqueuedAt,
    }));
    return {
      ok: true,
      store: dir,
      poolDir,
      slots: slotStates().map(({ slot, status }) => ({
        slot_id: slot.id,
        kind: slot.kind,
        attrs: slot.attrs,
        state: status.state,
        holder: status.state === "held" ? status.holder : null,
        expiresAt: status.expiresAt ?? null,
      })),
      queue,
      movingAvgMs: avg,
    };
  }

  /** One maintenance pass (reap + drop stale). For an active broker loop, ops, and tests. */
  function pump({ owner }) {
    const swept = sweep(owner);
    return { ok: true, ...swept, status: poolStatus() };
  }

  return {
    dir,
    poolDir,
    store,
    pool,
    slots: SLOTS,
    ttlMinutes: ttl,
    sweep,
    enqueue,
    heartbeatEntry,
    dequeue,
    tryGrant,
    acquireBlocking,
    acquireNoWait,
    request,
    claim,
    release,
    heartbeat,
    resetSlot,
    reprovisionSlot,
    healthCheck,
    poolStatus,
    pump,
    movingAvgMs,
  };
}
