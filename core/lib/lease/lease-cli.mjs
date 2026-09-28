#!/usr/bin/env node
// lease-cli.mjs — scriptable CLI over the durable-lease primitive.
//
// Built to be called non-interactively (git hooks, precheck gates, agent session shell flows).
// Prints exactly one JSON object to stdout; never prompts.
//
// Usage:
//   node core/lib/lease/lease-cli.mjs <op> [flags]
//
// Ops:
//   acquire    --kind K --owner OWNER --ttl MINUTES [--payload JSON] [--wait-ms N]
//   heartbeat  --kind K --owner OWNER --token T
//   release    --kind K --owner OWNER --token T | --kind K --force
//   status     --kind K
//   reap       --kind K
//   list
//   reconcile
//
// Common flags: --store DIR, --owner-pattern REGEX, --pretty
// Env: LEASE_STORE (default logs/leases under the cwd), LEASE_OWNER_PATTERN (anchored regex;
//      default accepts any safe token). Flags win over env.
//
// Exit codes:
//   0  success (for `status`: any state — read the JSON)
//   1  operational refusal: held by another / expired / not owner / wait timeout
//   2  usage or validation error
//   3  unexpected internal error
//
// Examples:
//   TOKEN=$(node lease-cli.mjs acquire --kind deploy-window --owner ci-main --ttl 30 | jq -r .record.token)
//   node lease-cli.mjs heartbeat --kind deploy-window --owner ci-main --token "$TOKEN"
//   node lease-cli.mjs release   --kind deploy-window --owner ci-main --token "$TOKEN"

import { createLeaseStore, LeaseUsageError } from "./durable-lease.mjs";

const OPS = new Set(["acquire", "heartbeat", "release", "status", "reap", "list", "reconcile"]);

function usageFail(message) {
  process.stderr.write(`lease-cli: ${message}\n`);
  process.stderr.write("usage: lease-cli.mjs <acquire|heartbeat|release|status|reap|list|reconcile> [flags]\n");
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
    if (name === "force" || name === "pretty") {
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

// Sets process.exitCode instead of calling process.exit so stdout flushes fully
// even when piped (process.exit can truncate buffered output).
function emit(result, pretty, exitCode) {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
  process.exitCode = exitCode;
}

async function main() {
  const { op, flags } = parseArgs(process.argv.slice(2));
  const store = createLeaseStore({
    ...(flags.store ? { store: flags.store } : {}),
    ...(flags["owner-pattern"] ? { ownerPattern: flags["owner-pattern"] } : {}),
  });
  const pretty = Boolean(flags.pretty);

  const need = (name) => {
    if (flags[name] === undefined) usageFail(`op "${op}" requires --${name}`);
    return flags[name];
  };

  switch (op) {
    case "acquire": {
      const params = { kind: need("kind"), owner: need("owner"), ttlMinutes: Number(need("ttl")) };
      if (flags.payload !== undefined) {
        try {
          params.payload = JSON.parse(flags.payload);
        } catch {
          usageFail("--payload must be valid JSON");
        }
      }
      const waitMs = flags["wait-ms"] === undefined ? 0 : Number(flags["wait-ms"]);
      if (!Number.isFinite(waitMs) || waitMs < 0) usageFail("--wait-ms must be a finite non-negative number");
      const deadline = Date.now() + waitMs;
      for (;;) {
        const result = store.acquire(params);
        if (result.ok) return emit(result, pretty, 0);
        if (Date.now() >= deadline) {
          return emit(waitMs > 0 ? { ...result, code: "timeout", waitedMs: waitMs } : result, pretty, 1);
        }
        await new Promise((r) => setTimeout(r, Math.min(500, Math.max(50, deadline - Date.now()))));
      }
    }
    case "heartbeat": {
      const result = store.heartbeat({ kind: need("kind"), owner: need("owner"), token: need("token") });
      return emit(result, pretty, result.ok ? 0 : 1);
    }
    case "release": {
      const params = flags.force
        ? { kind: need("kind"), force: true }
        : { kind: need("kind"), owner: need("owner"), token: need("token") };
      const result = store.release(params);
      return emit(result, pretty, result.ok ? 0 : 1);
    }
    case "status":
      return emit(store.status({ kind: need("kind") }), pretty, 0);
    case "reap": {
      const result = store.reap({ kind: need("kind") });
      return emit(result, pretty, result.ok ? 0 : 1);
    }
    case "list":
      return emit({ ok: true, leases: store.list() }, pretty, 0);
    case "reconcile":
      return emit(store.reconcile(), pretty, 0);
    default:
      usageFail(`unhandled op ${op}`);
  }
}

main().catch((err) => {
  if (err instanceof LeaseUsageError) {
    process.stderr.write(`lease-cli: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`lease-cli: ${err?.stack ?? err}\n`);
  process.exit(3);
});
