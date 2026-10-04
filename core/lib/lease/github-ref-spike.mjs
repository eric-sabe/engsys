#!/usr/bin/env node
// github-ref-spike.mjs — spike for engsys#43: can a GitHub App installation token hold a
// compare-and-swap lease on a git ref, as the cross-fleet singleton baton (see
// docs/multi-fleet.md section 2 in this repo)?
//
// Zero dependencies: node builtins + global fetch (Node >= 18). Pass a GitHub App installation
// token via GH_TOKEN. All refs this script creates live under `refs/<prefix>/spike/baton-<rand>`
// (default prefix: `engsys`) and are deleted at the end — `--keep` skips the cleanup for manual
// inspection, `--cleanup-only <ref>` just deletes one leftover ref.
//
// Usage:
//   GH_TOKEN=<installation token> node github-ref-spike.mjs <owner>/<repo> [--prefix engsys] [--keep]
//
// What it does, in order (prints one JSON summary at the end):
//   1. claim       — POST /git/refs to create a brand-new ref. Confirms it works, and that
//                     creating the SAME ref again fails (422, "already exists").
//   2. renew        — build a new commit on top of the current tip, PATCH the ref with
//                     force:false. Repeated ~20x to get latency p50/p95 and rate-limit cost.
//   3. race         — ~20 trials: two commits both parented on the current tip, two concurrent
//                     PATCHes. Exactly one must win each trial; the loser's status/message is
//                     recorded.
//   4. visibility   — does a fresh `git ls-remote`/`git clone` see the spike ref? (shell out to
//                     git in a scratch dir)
//   5. branch-fallback — same claim/renew/race semantics against a plain branch ref
//                     (refs/heads/<prefix>-spike/baton-<rand>), for the "custom refs don't work"
//                     fallback path.
//   6. cleanup      — DELETE every ref this run created (unless --keep), then verify via
//                     GET /git/matching-refs/<prefix>/spike that none remain.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://api.github.com';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function die(msg) {
  process.stderr.write(`github-ref-spike: ${msg}\n`);
  process.exit(1);
}

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) die('GH_TOKEN env var required (an installation token; never pass it on argv)');

const args = process.argv.slice(2);
const repoArg = args.find((a) => !a.startsWith('--'));
if (!repoArg || !repoArg.includes('/')) die('usage: github-ref-spike.mjs <owner>/<repo> [--prefix engsys] [--keep]');
const [OWNER, REPO] = repoArg.split('/');
const prefixIdx = args.indexOf('--prefix');
const PREFIX = prefixIdx >= 0 ? args[prefixIdx + 1] : 'engsys';
const KEEP = args.includes('--keep');

const RAND = crypto.randomBytes(4).toString('hex');
const CUSTOM_REF = `refs/${PREFIX}/spike/baton-${RAND}`;
const BRANCH_REF = `refs/heads/${PREFIX}-spike/baton-${RAND}`;

const rateLimitSamples = [];

async function gh(method, urlPath, body) {
  const t0 = Date.now();
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'engsys-fleet-spike',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limit = res.headers.get('x-ratelimit-limit');
  if (remaining != null) rateLimitSamples.push({ remaining: Number(remaining), limit: Number(limit) });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, json, ms };
}

async function createCommit(parents, message) {
  const r = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: EMPTY_TREE_SHA,
    parents,
  });
  if (!r.ok) throw new Error(`createCommit failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.sha;
}

async function getRef(ref) {
  const shortRef = ref.replace(/^refs\//, '');
  const r = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/${shortRef}`);
  return r;
}

async function createRef(ref, sha) {
  return gh('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref, sha });
}

async function updateRef(ref, sha, force) {
  const shortRef = ref.replace(/^refs\//, '');
  return gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/${shortRef}`, { sha, force });
}

async function deleteRef(ref) {
  const shortRef = ref.replace(/^refs\//, '');
  return gh('DELETE', `/repos/${OWNER}/${REPO}/git/refs/${shortRef}`);
}

async function matchingRefs(prefix) {
  const r = await gh('GET', `/repos/${OWNER}/${REPO}/git/matching-refs/${prefix}`);
  return r.json;
}

function batonMessage(holder, token, expiresMs) {
  return [
    'baton',
    `holder: ${holder}`,
    `token: ${token}`,
    `expires: ${new Date(expiresMs).toISOString()}`,
    'protocol: 1',
  ].join('\n');
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runClaimRenewRace(ref, label) {
  const out = { label, ref };

  // --- 1. claim ---
  const initialToken = crypto.randomUUID();
  const initialCommit = await createCommit([], batonMessage('alice:spike-mm', initialToken, Date.now() + 5 * 60_000));
  const claim1 = await createRef(ref, initialCommit);
  out.claim_first = { status: claim1.status, ok: claim1.ok, ms: claim1.ms };

  // claiming the SAME ref again must fail (422 already exists)
  const dupeCommit = await createCommit([], batonMessage('bob:spike-mm', crypto.randomUUID(), Date.now() + 5 * 60_000));
  const claim2 = await createRef(ref, dupeCommit);
  out.claim_duplicate = { status: claim2.status, ok: claim2.ok, message: claim2.json?.message, ms: claim2.ms };

  // --- 2. renew latency, ~20 iterations ---
  const renewLatenciesMs = [];
  for (let i = 0; i < 20; i++) {
    const cur = await getRef(ref);
    const tip = cur.json.object.sha;
    const t0 = Date.now();
    const commitSha = await createCommit([tip], batonMessage('alice:spike-mm', initialToken, Date.now() + 5 * 60_000));
    const upd = await updateRef(ref, commitSha, false);
    const ms = Date.now() - t0;
    if (!upd.ok) throw new Error(`renew #${i} failed unexpectedly: ${upd.status} ${JSON.stringify(upd.json)}`);
    renewLatenciesMs.push(ms);
  }
  out.renew = {
    iterations: renewLatenciesMs.length,
    p50_ms: percentile(renewLatenciesMs, 50),
    p95_ms: percentile(renewLatenciesMs, 95),
    min_ms: Math.min(...renewLatenciesMs),
    max_ms: Math.max(...renewLatenciesMs),
  };

  // --- 3. race: 20 trials, two concurrent PATCHes parented on the same tip ---
  const raceTrials = [];
  for (let i = 0; i < 20; i++) {
    const cur = await getRef(ref);
    const tip = cur.json.object.sha;
    const [commitA, commitB] = await Promise.all([
      createCommit([tip], batonMessage('alice:spike-mm', crypto.randomUUID(), Date.now() + 5 * 60_000)),
      createCommit([tip], batonMessage('bob:spike-mm', crypto.randomUUID(), Date.now() + 5 * 60_000)),
    ]);
    const [resA, resB] = await Promise.all([
      updateRef(ref, commitA, false),
      updateRef(ref, commitB, false),
    ]);
    const winners = [resA, resB].filter((r) => r.ok).length;
    raceTrials.push({
      trial: i,
      winners,
      a: { status: resA.status, ok: resA.ok, message: resA.json?.message },
      b: { status: resB.status, ok: resB.ok, message: resB.json?.message },
    });
  }
  const exactlyOneWinner = raceTrials.filter((t) => t.winners === 1).length;
  out.race = {
    trials: raceTrials.length,
    exactly_one_winner: exactlyOneWinner,
    zero_winners: raceTrials.filter((t) => t.winners === 0).length,
    both_winners: raceTrials.filter((t) => t.winners === 2).length,
    sample_loser_message: raceTrials.find((t) => t.winners === 1 && (!t.a.ok || !t.b.ok))
      ? (raceTrials.find((t) => t.winners === 1).a.ok ? raceTrials.find((t) => t.winners === 1).b : raceTrials.find((t) => t.winners === 1).a).message
      : null,
    trials_detail: raceTrials,
  };

  // --- 4. release: final commit holder:none ---
  const curFinal = await getRef(ref);
  const releaseCommit = await createCommit([curFinal.json.object.sha], batonMessage('none', 'released', Date.now()));
  const release = await updateRef(ref, releaseCommit, false);
  out.release = { status: release.status, ok: release.ok };

  return out;
}

async function visibilityCheck(ref) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-spike-'));
  const repoUrl = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`;
  const out = { ref };
  try {
    const lsRemote = execFileSync('git', ['ls-remote', repoUrl, ref], { encoding: 'utf8' }).trim();
    out.ls_remote_explicit_ref = lsRemote || null;

    const lsRemoteAll = execFileSync('git', ['ls-remote', repoUrl], { encoding: 'utf8' });
    out.appears_in_ls_remote_all = lsRemoteAll.includes(ref);

    execFileSync('git', ['clone', '--quiet', '--depth', '1', repoUrl, scratch], { stdio: 'ignore' });
    const localRefs = execFileSync('git', ['-C', scratch, 'for-each-ref'], { encoding: 'utf8' });
    out.fetched_into_default_clone = localRefs.includes(ref.replace('refs/', ''));

    execFileSync('git', ['-C', scratch, 'fetch', 'origin', ref], { stdio: 'ignore' });
    const fetchHead = fs.readFileSync(path.join(scratch, '.git', 'FETCH_HEAD'), 'utf8').trim();
    out.explicit_fetch_works = fetchHead.length > 0;
  } catch (e) {
    out.error = String(e.message || e);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const summary = { repo: `${OWNER}/${REPO}`, prefix: PREFIX, started_at: new Date().toISOString() };

  console.error(`[spike] checking ruleset interference for custom ref ${CUSTOM_REF} ...`);
  const rulesets = await gh('GET', `/repos/${OWNER}/${REPO}/rulesets`);
  summary.rulesets_on_repo = rulesets.json;

  console.error('[spike] 1-3: claim / duplicate-claim / renew-latency / race / release on CUSTOM ref ...');
  summary.custom_ref = await runClaimRenewRace(CUSTOM_REF, 'custom-ref');

  console.error('[spike] 4: visibility (ls-remote / clone / explicit fetch) for CUSTOM ref ...');
  summary.custom_ref_visibility = await visibilityCheck(CUSTOM_REF);

  console.error('[spike] 5: same semantics on a plain branch (fallback path) ...');
  summary.branch_ref = await runClaimRenewRace(BRANCH_REF, 'branch-ref');
  summary.branch_ref_visibility = await visibilityCheck(BRANCH_REF);

  console.error('[spike] 6: cleanup ...');
  if (!KEEP) {
    const d1 = await deleteRef(CUSTOM_REF);
    const d2 = await deleteRef(BRANCH_REF);
    summary.cleanup = { custom_ref_delete: d1.status, branch_ref_delete: d2.status };
    const leftoverCustom = await matchingRefs(`${PREFIX}/spike`);
    const leftoverBranch = await matchingRefs(`heads/${PREFIX}-spike`);
    summary.cleanup.leftover_custom_refs = leftoverCustom;
    summary.cleanup.leftover_branch_refs = leftoverBranch;
  } else {
    summary.cleanup = { skipped: true, reason: '--keep passed' };
  }

  summary.rate_limit = {
    samples: rateLimitSamples.length,
    min_remaining_seen: rateLimitSamples.length ? Math.min(...rateLimitSamples.map((s) => s.remaining)) : null,
    limit: rateLimitSamples[0]?.limit ?? null,
    calls_consumed_this_run: rateLimitSamples.length ? (rateLimitSamples[0].remaining - rateLimitSamples[rateLimitSamples.length - 1].remaining) : null,
  };
  summary.finished_at = new Date().toISOString();

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error('[spike] FAILED:', e);
  process.exit(1);
});
