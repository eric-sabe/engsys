#!/usr/bin/env node
// run-tests.mjs — `npm test`: run every suite, print a per-suite pass/fail summary, exit non-zero if
// any failed. Unlike an `&&` chain, one red suite does not hide the suites after it (#45).
//
// Each suite runs with the fleet's own configuration removed from its environment (ENGSYS_*, FLEET_*,
// PIN_*, the gh App env, GIT_CONFIG_*), so the result is the same inside a fleet session as outside.
// The fleet shell tests also scrub themselves (core/fleet/test/scrub-env.sh) so they pass when run alone.
//
// Add a suite: one line in SUITES. Keep it one suite per line so concurrent edits merge cleanly.
// Usage: node scripts/run-tests.mjs [--list] [<substring>...]   (substrings filter by suite name)

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SUITES = [
  ["node lib/selftest.js"],
  ["node scripts/build-plugins.mjs --check"],
  ["node --test core/.claude-plugin/approve-own-scripts.test.mjs"],
  ["node --test core/.claude-plugin/handback-guard.test.mjs"],
  ["node --test core/.claude-plugin/singleton-write-guard.test.mjs"],
  ["node --test core/fleet/identity/gh-app-token.test.mjs"],
  ["node --test core/fleet/notify.test.mjs"],
  ["node --test core/fleet/lib/federation.test.mjs"],
  ["node --test core/lib/untrusted.test.mjs"],
  ["node --test core/lib/git-env.test.mjs"],
  ["node --test core/lib/gate-check.test.mjs"],
  ["node --test core/lib/claim.test.mjs"],
  ["node --test core/lib/lease/durable-lease.test.mjs"],
  ["node --test core/lib/lease/github-backend.test.mjs"],
  ["node --test core/lib/lease/baton.test.mjs"],
  ["node --test core/lib/lease/pool.test.mjs"],
  ["node --test core/scripts/review-bakeoff.test.mjs"],
  ["bash core/fleet/identity/git-env.test.sh"],
  ["bash core/fleet/identity/gh-shim.test.sh"],
  ["bash core/fleet/test/fleet.test.sh"],
  ["bash core/fleet/test/notify.test.sh"],
  ["bash core/fleet/test/heartbeat.test.sh"],
  ["bash core/fleet/test/federation.test.sh"],
  ["bash core/fleet/test/federation-status.test.sh"],
  ["bash core/fleet/test/host-roles.test.sh"],
  ["bash core/fleet/test/pin.test.sh"],
  ["bash core/fleet/test/init.test.sh"],
  ["bash core/templates/repo-gates/test/repo-gates.test.sh"],
  ["bash core/templates/review/test/review.test.sh"],
  ["bash core/skills/durable-lease/scripts/pool-run.test.sh"],
  ["bash core/skills/resource-broker/scripts/broker.test.sh"],
  ["bash core/skills/agent-sessions/scripts/fleet-supervisor.test.sh"],
  ["bash core/scripts/worker-run.test.sh"],
  ["bash core/scripts/worker-package.test.sh"],
  ["bash core/skills/maintenance-monster/scripts/mnt-fp.test.sh"],
  ["bash core/skills/merge-monster/scripts/mm-baton.test.sh"],
];

// Variables the kit reads from a fleet session's environment.
const FLEET_ENV = /^(ENGSYS_|FLEET_|PIN_|INSTANCE_|GH_APP|GH_BOT_|GIT_CONFIG_|BATON_|NOTIFY_|SLACK_|HEARTBEAT_)|^(ENGSYS|INSTANCE|GH_TOKEN|GITHUB_TOKEN)$/;

export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !FLEET_ENV.test(k)));
}

function main(argv) {
  const list = argv.includes("--list");
  const filters = argv.filter((a) => !a.startsWith("--"));
  const suites = SUITES.map(([cmd]) => cmd).filter((cmd) => !filters.length || filters.some((f) => cmd.includes(f)));
  if (list) { console.log(suites.join("\n")); return 0; }
  if (!suites.length) { console.error(`run-tests: no suite matches ${filters.join(", ")}`); return 2; }

  const env = cleanEnv();
  const results = [];
  for (const cmd of suites) {
    const t0 = Date.now();
    process.stdout.write(`\n=== ${cmd}\n`);
    const r = spawnSync("sh", ["-c", cmd], { cwd: ROOT, env, stdio: "inherit" });
    const code = r.status ?? (r.signal ? 128 : 1);
    results.push({ cmd, code, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log("\n--- summary ---");
  for (const r of results) console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.secs.padStart(6)}s  ${r.cmd}${r.code === 0 ? "" : `  (exit ${r.code})`}`);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
