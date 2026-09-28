#!/usr/bin/env node
// pool-cli.mjs — the pool protocol CLI.
//
// Scriptable front-end over the resource pool (pool.mjs), which sits on the durable-lease
// primitive. Called by git hooks and precheck gates (blocking mode), by agent sessions (async
// mode), and by an optional broker session (status/pump loop).
//
// Prints exactly one JSON object to stdout (wait/progress lines and command output go to
// stderr); never prompts — safe for hooks.
//
// Ops:
//   acquire    --owner OWNER [--session S] [--ttl MIN] [--wait-ms N | --no-wait]
//              [--poll-ms N] [--shell]
//                Blocking mode (the hook path): blocks until a slot frees, printing queue
//                position + ETA to stderr while waiting. The slot is provisioned (guaranteed
//                clean) before the grant is printed. With --shell, prints `export` lines for the
//                grant env plus <prefix>_SLOT / _TOKEN / _OWNER instead of JSON.
//   request    --owner OWNER [--session S] [--ttl MIN]
//                Async/deferred mode: returns {queued, position, eta} at once and spawns a
//                detached waiter that self-grants when its turn comes and fires the grant nudge
//                (default: appends to <store>/<name>/nudges.jsonl and pipes to the nudge command).
//   claim      --request ID --owner OWNER [--shell]
//                Fetch an async request's grant (or current position/eta).
//   release    --slot ID --owner OWNER --token T | --slot ID --force
//   heartbeat  --slot ID --owner OWNER --token T
//   reset      --slot ID --owner OWNER --token T
//                Re-run the reset (default: provision) + health commands on a slot you hold.
//   reprovision --slot ID --owner OWNER [--ttl MIN]
//                Broker op: take a slot NOBODY holds, run reset + health, release it. A held slot
//                is refused (code "held"); its holder uses `reset`.
//   health     --slot ID
//                Run the health command for a slot (no lease needed).
//   status       Pool overview: slots (attrs, kind, state, holder), queue (positions + ETAs),
//                moving avg, and where the state lives (store, poolDir).
//   pump       --owner OWNER
//                One maintenance pass: reap stale slot leases (dead-man's switch), drop silent
//                queue entries. The lazy path runs this inside every acquire/request anyway.
//   waiter     --request ID --owner OWNER --session S [--ttl MIN]
//                (internal) the detached async waiter loop spawned by `request`.
//
// Common flags: --pool FILE, --store DIR, --owner-pattern REGEX, --pretty,
//   --provision-cmd CMD, --reset-cmd CMD, --health-cmd CMD, --nudge-cmd CMD
// Env: LEASE_POOL_FILE (pool file), LEASE_STORE (default <git toplevel>/logs/leases), LEASE_OWNER_PATTERN,
//      POOL_TTL_MINUTES, POOL_POLL_MS, POOL_WAITER_TIMEOUT_MS, POOL_PROVISION_CMD,
//      POOL_RESET_CMD, POOL_HEALTH_CMD, POOL_NUDGE_CMD. Flags win over env, env over the pool
//      file. Legacy aliases: E2E_LEASE_TTL_MINUTES, E2E_LEASE_POLL_MS,
//      E2E_LEASE_WAITER_TIMEOUT_MS, E2E_LEASE_RESET_CMD (= provision), E2E_LEASE_NUDGE_CMD.
//
// Exit codes: 0 success · 1 operational refusal (saturated / timeout / not owner / provision or
// health failed) · 2 usage error · 3 internal error.
//
// Examples:
//   GRANT=$(pool-cli.mjs acquire --owner ci-main)               # blocks until granted
//   eval "$(pool-cli.mjs acquire --owner ci-main --shell)"      # exports the grant env
//   pool-cli.mjs request --owner agent-7 --session agent-7
//   pool-cli.mjs release --slot 1 --owner ci-main --token "$POOL_LEASE_TOKEN"

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { LeaseUsageError } from "./durable-lease.mjs";
import { createPool, DEFAULT_TTL_MINUTES } from "./pool.mjs";

const OPS = new Set(["acquire", "request", "claim", "release", "heartbeat", "reset", "reprovision", "health", "status", "pump", "waiter"]);
const SELF = fileURLToPath(import.meta.url);
const BOOLEAN_FLAGS = new Set(["force", "pretty", "shell", "no-wait"]);
/** Flags forwarded verbatim to the detached waiter so it builds the same pool. */
const PASSTHROUGH_FLAGS = ["pool", "store", "owner-pattern", "provision-cmd", "reset-cmd", "health-cmd", "nudge-cmd"];

function usageFail(message) {
  process.stderr.write(`pool-cli: ${message}\n`);
  process.stderr.write("usage: pool-cli <acquire|request|claim|release|heartbeat|reset|reprovision|health|status|pump> [flags]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const [op, ...rest] = argv;
  if (!op || !OPS.has(op)) usageFail(`unknown or missing op ${JSON.stringify(op ?? "")}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) usageFail(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) usageFail(`--${name} requires a value`);
    flags[name] = value;
    i += 1;
  }
  return { op, flags };
}

/** POSIX single-quote a value so `eval` of --shell output can never expand `$`/backticks. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function emit(result, flags, exitCode, shellPrefix = "POOL_LEASE") {
  if (flags.shell && result?.ok && result.env) {
    // Shell mode: export lines for `eval "$(pool-cli ... --shell)"` (a hook or gate).
    const lines = Object.entries(result.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
    lines.push(`export ${shellPrefix}_SLOT=${shellQuote(result.slot_id)}`);
    lines.push(`export ${shellPrefix}_TOKEN=${shellQuote(result.token)}`);
    lines.push(`export ${shellPrefix}_OWNER=${shellQuote(result.owner)}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, flags.pretty ? 2 : 0)}\n`);
  }
  process.exitCode = exitCode;
}

function fmtEta(etaMs) {
  const min = Math.max(1, Math.round(etaMs / 60_000));
  return `~${min}m`;
}

const envNum = (...names) => {
  for (const n of names) if (process.env[n] !== undefined && process.env[n] !== "") return Number(process.env[n]);
  return undefined;
};

async function main() {
  const { op, flags } = parseArgs(process.argv.slice(2));
  const poolFile = flags.pool ?? process.env.LEASE_POOL_FILE;
  if (!poolFile) usageFail("no pool file — pass --pool FILE or set LEASE_POOL_FILE");

  // Command flags become env overrides for the pool (flags > env > pool file).
  const env = { ...process.env };
  if (flags["provision-cmd"]) env.POOL_PROVISION_CMD = flags["provision-cmd"];
  if (flags["reset-cmd"]) env.POOL_RESET_CMD = flags["reset-cmd"];
  if (flags["health-cmd"]) env.POOL_HEALTH_CMD = flags["health-cmd"];
  if (flags["nudge-cmd"]) env.POOL_NUDGE_CMD = flags["nudge-cmd"];

  const pool = createPool({
    pool: poolFile,
    env,
    ...(flags.store ? { store: flags.store } : {}),
    ...(flags["owner-pattern"] ? { ownerPattern: flags["owner-pattern"] } : {}),
  });
  const shellPrefix = pool.pool.shellPrefix;
  const out = (result, exitCode) => emit(result, flags, exitCode, shellPrefix);

  const need = (name) => {
    if (flags[name] === undefined) usageFail(`op "${op}" requires --${name}`);
    return flags[name];
  };
  const numFlag = (name, fallback) => {
    const raw = flags[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) usageFail(`--${name} must be a finite non-negative number`);
    return n;
  };

  const ttlMinutes = numFlag("ttl", envNum("POOL_TTL_MINUTES", "E2E_LEASE_TTL_MINUTES") ?? pool.ttlMinutes ?? DEFAULT_TTL_MINUTES);
  const pollMs = numFlag("poll-ms", envNum("POOL_POLL_MS", "E2E_LEASE_POLL_MS") ?? 5_000);

  switch (op) {
    case "acquire": {
      const owner = need("owner");
      const session = flags.session ?? owner;
      if (flags["no-wait"]) {
        const result = pool.acquireNoWait({ owner, session, ttlMinutes });
        return out(result, result.ok ? 0 : 1);
      }
      const waitMs = flags["wait-ms"] === undefined ? Infinity : numFlag("wait-ms", Infinity);
      let lastLine = "";
      const result = await pool.acquireBlocking({
        owner,
        session,
        ttlMinutes,
        waitMs,
        pollMs,
        onWait: ({ position, etaMs }) => {
          // Legible wait: position + ETA on stderr while blocking.
          const line = `pool-cli: pool saturated — queue position ${position}, eta ${fmtEta(etaMs)}`;
          if (line !== lastLine) process.stderr.write(`${line}\n`);
          lastLine = line;
        },
      });
      return out(result, result.ok ? 0 : 1);
    }
    case "request": {
      const owner = need("owner");
      const session = flags.session ?? owner;
      const result = pool.request({ owner, session });
      // Spawn the detached waiter that self-grants when its turn comes and fires the nudge.
      // Detached + unref'd: `request` itself returns at once.
      const waiterArgs = [SELF, "waiter", "--request", result.request_id, "--owner", owner, "--session", session, "--ttl", String(ttlMinutes), "--poll-ms", String(pollMs)];
      for (const name of PASSTHROUGH_FLAGS) if (flags[name] !== undefined) waiterArgs.push(`--${name}`, flags[name]);
      const child = spawn(process.execPath, waiterArgs, { detached: true, stdio: "ignore" });
      child.unref();
      return out({ ...result, eta: fmtEta(result.etaMs), waiter_pid: child.pid }, 0);
    }
    case "waiter": {
      // Internal: the async request's self-granting poller. Heartbeats its queue entry,
      // tryGrants each round (the pool fires the nudge on grant), and gives up loudly after the
      // waiter timeout.
      const owner = need("owner");
      const requestId = need("request");
      const rawTimeout = envNum("POOL_WAITER_TIMEOUT_MS", "E2E_LEASE_WAITER_TIMEOUT_MS") ?? 60 * 60_000;
      // Guard against NaN/negative env values — a NaN deadline would never fire.
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : 60 * 60_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const grant = pool.tryGrant({ entryId: requestId, owner, ttlMinutes });
        if (grant) return out({ ok: true, code: "granted", request_id: requestId, slot_id: grant.slot_id }, 0);
        const pos = pool.heartbeatEntry({ entryId: requestId, owner });
        if (!pos) {
          // Entry vanished (granted elsewhere, dropped stale, or cancelled).
          const state = pool.claim({ requestId, owner });
          return out(state, state.ok ? 0 : 1);
        }
        if (Date.now() >= deadline) {
          pool.dequeue({ entryId: requestId, owner });
          return out({ ok: false, code: "waiter_timeout", request_id: requestId, waitedMs: timeoutMs }, 1);
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
    case "claim": {
      const result = pool.claim({ requestId: need("request"), owner: need("owner") });
      if (result.queued) return out({ ...result, eta: fmtEta(result.etaMs) }, 0);
      return out(result, result.ok ? 0 : 1);
    }
    case "release": {
      const params = flags.force
        ? { slotId: need("slot"), force: true, owner: flags.owner }
        : { slotId: need("slot"), owner: need("owner"), token: need("token") };
      const result = pool.release(params);
      return out(result, result.ok ? 0 : 1);
    }
    case "heartbeat": {
      const result = pool.heartbeat({ slotId: need("slot"), owner: need("owner"), token: need("token") });
      return out(result, result.ok ? 0 : 1);
    }
    case "reset": {
      const result = pool.resetSlot({ slotId: need("slot"), owner: need("owner"), token: need("token") });
      return out(result, result.ok ? 0 : 1);
    }
    case "reprovision": {
      const result = pool.reprovisionSlot({ slotId: need("slot"), owner: need("owner"), ttlMinutes });
      return out(result, result.ok ? 0 : 1);
    }
    case "health": {
      const result = pool.healthCheck({ slotId: need("slot") });
      return out(result, result.ok ? 0 : 1);
    }
    case "status":
      return out(pool.poolStatus(), 0);
    case "pump": {
      const result = pool.pump({ owner: need("owner") });
      return out(result, 0);
    }
    default:
      usageFail(`unhandled op ${op}`);
  }
}

main().catch((err) => {
  if (err instanceof LeaseUsageError) {
    process.stderr.write(`pool-cli: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`pool-cli: ${err?.stack ?? err}\n`);
  process.exit(/(reset|health check) failed/.test(err?.message ?? "") ? 1 : 3);
});
