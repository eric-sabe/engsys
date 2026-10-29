#!/usr/bin/env node
// run-tests.mjs — `npm test`: run every suite, print a per-suite pass/fail summary, exit non-zero if
// any failed. Unlike an `&&` chain, one red suite does not hide the suites after it (#45).
//
// Each suite runs with the fleet's own configuration removed from its environment (ENGSYS_*, FLEET_*,
// PIN_*, the gh App env, GIT_CONFIG_*), so the result is the same inside a fleet session as outside.
// The fleet shell tests also scrub themselves (core/fleet/test/scrub-env.sh) so they pass when run alone.
//
// Each suite also gets its own TMPDIR (a fresh directory, removed when the suite passes, kept and printed
// when it fails), so suites never meet in a shared temp dir — not each other, and not another checkout's
// `npm test` running on the same host (engsys#233).
//
// Suites run concurrently on ENGSYS_TEST_JOBS workers (default: min(cores - 1, 6)). Each suite's output
// is buffered and printed whole when it finishes. ENGSYS_TEST_JOBS=1 runs everything one after another
// with output streamed live, as before. A suite marked `serial` runs alone, after the parallel ones,
// with nothing else running beside it; the mark says why. A suite marked `slow` (one of the few that take
// a minute or more alone) starts first, so the long ones are not left running by themselves at the end.
//
// Add a suite: one line in SUITES. Keep it one suite per line so concurrent edits merge cleanly.
// Usage: node scripts/run-tests.mjs [--list] [<substring>...]   (substrings filter by suite name)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SUITES = [
  ["node lib/selftest.js"],
  ["node scripts/build-plugins.mjs --check"],
  ["node core/scripts/validate-lessons.mjs"],
  ["node --test core/scripts/validate-lessons.test.mjs"],
  ["node --test scripts/security-model.test.mjs"],
  ["node --test scripts/run-tests.test.mjs"],
  ["node --test core/.claude-plugin/approve-own-scripts.test.mjs"],
  ["node --test core/.claude-plugin/handback-guard.test.mjs"],
  ["node --test core/.claude-plugin/session-transcript.test.mjs"],
  ["node --test core/.claude-plugin/singleton-write-guard.test.mjs"],
  ["node --test core/fleet/identity/gh-app-token.test.mjs"],
  ["node --test core/fleet/notify.test.mjs"],
  ["node --test core/lib/ruleset-gates.test.mjs"],
  ["node --test core/fleet/lib/federation.test.mjs"],
  ["node --test core/fleet/lib/verify-wrappers.test.mjs"],
  ["node --test core/fleet/lib/federation-status.test.mjs"],
  ["node --test core/lib/operator-time.test.mjs"],
  ["node --test core/lib/host-toolchain.test.mjs"],
  ["node --test core/.claude-plugin/engsys-context.test.mjs"],
  ["node --test core/fleet/lib/fleet-msg.test.mjs"],
  ["node --test core/fleet/lib/route.test.mjs"],
  ["node --test core/fleet/lib/handoff.test.mjs"],
  ["node --test core/lib/untrusted.test.mjs"],
  ["node --test core/lib/security-verdict.test.mjs"],
  ["node --test core/lib/security-sensitive.test.mjs"],
  ["node --test core/lib/git-env.test.mjs"],
  ["node --test core/lib/gate-check.test.mjs"],
  ["node --test core/lib/claim.test.mjs"],
  ["node --test core/lib/spec-slice.test.mjs"],
  ["node --test core/lib/contract-check.test.mjs"],
  ["bash core/lib/fleet-gh.test.sh"],
  ["node --test core/.claude-plugin/fleet-gh-path.test.mjs"],
  ["node --test core/lib/lease/durable-lease.test.mjs"],
  ["node --test core/lib/lease/github-backend.test.mjs"],
  ["node --test core/lib/lease/baton.test.mjs"],
  ["node --test core/lib/lease/keepalive-lifetime.test.mjs"],
  ["node --test core/lib/lease/guarded-push.test.mjs"],
  ["node --test core/lib/lease/pool.test.mjs"],
  ["node --test core/scripts/review-bakeoff.test.mjs"],
  ["node --test core/scripts/harvest-findings.test.mjs"],
  ["node --test core/lib/is-main.test.mjs"],
  ["node --test core/lib/exit-after-flush.test.mjs"],
  ["node --test core/scripts/plugin-mode-layout.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/lib/memory/index-db.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/lib/memory/ref-store.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/lib/memory/signing.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/lib/memory/ref-consumer-guard.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/lib/memory/ref-consumer.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/scripts/memory-brief.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/scripts/memory-sync.test.mjs"],
  ["NODE_NO_WARNINGS=1 node --test core/.claude-plugin/subagent-memory-inject.test.mjs"],
  ["node --test lib/commands.test.mjs"],
  ["bash core/fleet/identity/git-env.test.sh"],
  ["bash core/fleet/identity/gh-shim.test.sh"],
  ["bash core/fleet/test/fleet.test.sh", { slow: true }],
  ["bash core/fleet/test/notify.test.sh"],
  ["bash core/fleet/test/heartbeat.test.sh"],
  ["bash core/fleet/test/federation.test.sh"],
  ["bash core/fleet/test/federation-status.test.sh"],
  ["bash core/fleet/test/relay.test.sh"],
  ["bash core/fleet/test/host-roles.test.sh", { slow: true }],
  ["bash core/fleet/test/pin.test.sh"],
  ["bash core/fleet/test/verify.test.sh", { slow: true }],
  ["bash core/fleet/test/init.test.sh"],
  ["bash core/templates/repo-gates/test/repo-gates.test.sh"],
  ["bash core/templates/review/test/review.test.sh"],
  ["bash core/skills/durable-lease/scripts/pool-run.test.sh"],
  ["bash core/skills/resource-broker/scripts/broker.test.sh"],
  ["bash core/skills/agent-sessions/scripts/fleet-supervisor.test.sh", { slow: true }],
  ["bash core/scripts/worker-run.test.sh"],
  ["bash core/scripts/worker-package.test.sh"],
  ["bash core/skills/maintenance-monster/scripts/mnt-fp.test.sh"],
  ["node --test core/skills/maintenance-monster/scripts/mnt-security-review.test.mjs"],
  ["node --test core/skills/maintenance-monster/scripts/mnt-harvest.test.mjs"],
  ["bash core/skills/merge-monster/scripts/mm-baton.test.sh"],
  ["bash core/skills/merge-monster/scripts/mm-preflight.test.sh"],
  ["node --test core/skills/merge-monster/scripts/mm-security-stale.test.mjs"],
  ["bash core/skills/merge-monster/scripts/monster-bus.test.sh", { slow: true }],
  ["node --test core/fleet/health/health.test.mjs"],
  ["node --test core/.claude-plugin/weather-check.test.mjs"],
  ["node --test core/fleet/lib/xray.test.mjs"],
  ["node --test tests/personas-and-skills.test.mjs"],
  ["node --test tests/monster-skill-rules.test.mjs"],
  ["node --test tests/monster-skill-sentinel.test.mjs"],
  ["node --test tests/model-policy.test.mjs"],
  ["bash core/skills/agent-sessions/scripts/launch-agent-sessions.test.sh"],
  ["bash core/skills/agent-sessions/scripts/launch-golden.test.sh", { slow: true }],
];

// Variables the kit reads from a fleet session's environment.
const FLEET_ENV = /^(ENGSYS_|FLEET_|PIN_|INSTANCE_|GH_APP|GH_BOT_|GIT_CONFIG_|BATON_|NOTIFY_|SLACK_|HEARTBEAT_|OPERATOR_|CLAUDE_CODE_)|^(ENGSYS|INSTANCE|GH_TOKEN|GITHUB_TOKEN)$/;

export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !FLEET_ENV.test(k)));
}

// Worker count: ENGSYS_TEST_JOBS if it is a positive integer, else min(cores - 1, 6), at least 1.
export function jobCount(env = process.env, cores = availableParallelism()) {
  const raw = env.ENGSYS_TEST_JOBS;
  if (raw !== undefined && raw !== "") {
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`ENGSYS_TEST_JOBS must be a positive integer, got "${raw}"`);
    return Number(raw);
  }
  return Math.max(1, Math.min(cores - 1, 6));
}

// Run one suite in its own TMPDIR. `live` streams output (serial mode); otherwise it is buffered and
// returned whole. The TMPDIR is removed on pass and kept on failure.
function runSuite({ cmd }, { env, base, cwd, live, write }) {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(base, "engsys-test-"));
  if (live) write(`\n=== ${cmd}\n`);
  return new Promise((done) => {
    const chunks = [];
    const child = spawn("sh", ["-c", cmd], { cwd, env: { ...env, TMPDIR: tmp }, stdio: live ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
    if (!live) for (const s of [child.stdout, child.stderr]) s.on("data", (c) => chunks.push(c));
    let spawnErr;
    child.on("error", (e) => { spawnErr = e; });
    child.on("close", (status, signal) => {
      const code = spawnErr ? 1 : (status ?? (signal ? 128 : 1));
      if (spawnErr) chunks.push(Buffer.from(`run-tests: could not start: ${spawnErr.message}\n`));
      if (code === 0) rmSync(tmp, { recursive: true, force: true });
      done({ cmd, code, secs: ((Date.now() - t0) / 1000).toFixed(1), out: Buffer.concat(chunks), tmp: code === 0 ? null : tmp });
    });
  });
}

// Run `suites` on `jobs` workers, taking them in the order given; print each one's output as it finishes.
async function pool(suites, jobs, opts, results) {
  let next = 0;
  const worker = async () => {
    while (next < suites.length) {
      const s = suites[next++];
      const r = await runSuite(s, opts);
      if (!opts.live) { opts.write(`\n=== ${r.cmd}\n`); opts.write(r.out); }
      if (r.tmp) opts.write(`--- FAILED (exit ${r.code}); its TMPDIR is kept: ${r.tmp}\n`);
      results.set(s, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));
}

// Run `suites` ({ cmd, serial?, slow? }) and return their results in the order given. jobs === 1: one at a
// time, in order, output live. Otherwise: the non-serial suites on `jobs` workers (slow ones first), then
// the serial ones alone, one at a time.
export async function runSuites(suites, { jobs, env = cleanEnv(), base = tmpdir(), cwd = ROOT, write = (s) => process.stdout.write(s) }) {
  const results = new Map();
  if (jobs === 1) {
    await pool(suites, 1, { env, base, cwd, live: true, write }, results);
  } else {
    const opts = { env, base, cwd, live: false, write };
    const parallel = suites.filter((s) => !s.serial);
    await pool([...parallel.filter((s) => s.slow), ...parallel.filter((s) => !s.slow)], jobs, opts, results);
    await pool(suites.filter((s) => s.serial), 1, opts, results);
  }
  return suites.map((s) => results.get(s));
}

async function main(argv) {
  const list = argv.includes("--list");
  const filters = argv.filter((a) => !a.startsWith("--"));
  const suites = SUITES.map(([cmd, opts = {}]) => ({ cmd, serial: opts.serial, slow: !!opts.slow })).filter(({ cmd }) => !filters.length || filters.some((f) => cmd.includes(f)));
  if (list) { console.log(suites.map((s) => s.cmd).join("\n")); return 0; }
  if (!suites.length) { console.error(`run-tests: no suite matches ${filters.join(", ")}`); return 2; }

  let jobs;
  try { jobs = jobCount(); } catch (e) { console.error(`run-tests: ${e.message}`); return 2; }
  if (jobs > 1) console.log(`run-tests: ${suites.length} suites on ${jobs} workers (ENGSYS_TEST_JOBS=1 for one at a time)`);
  const t0 = Date.now();
  const results = await runSuites(suites, { jobs });

  const failed = results.filter((r) => r.code !== 0);
  console.log("\n--- summary ---");
  for (const r of results) console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.secs.padStart(6)}s  ${r.cmd}${r.code === 0 ? "" : `  (exit ${r.code}; TMPDIR kept: ${r.tmp})`}`);
  console.log(`\nwall clock ${((Date.now() - t0) / 1000).toFixed(1)}s on ${jobs} worker${jobs === 1 ? "" : "s"}`);
  console.log(`${results.length - failed.length}/${results.length} suites passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
