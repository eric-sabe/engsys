#!/usr/bin/env node
// mm-security-stale.mjs — escalate a security-review request that goes unanswered (engsys#246). mm-tick.sh runs it
// once per tick, after its verdict backstop.
//
// A PR the merge monster parked on preflight exit 3 (`security_review_required`, the review request label on it) waits
// for the security lane's signed verdict and for nothing else. If the lane is down, stuck, usage-limited, missing its
// key or skipping the PR as self-authored, the PR used to stay parked forever and nobody was told. So:
//
//   mm-security-stale.mjs --repo owner/name --state-dir <state_dir>/.watch --waiting "N …" --watched "N …"
//                         [--config FILE]... [--now ISO]
//     --waiting  the PRs whose preflight answered exit 3 this tick and that carry the request label
//     --watched  the PRs the verdict backstop still watches (.watch/verdict-wait: exit 3, or a failed run)
//
// For each waiting PR it measures how long the request has stood at the current head: from the first request label
// event or merge-monster request comment at or after the head was pushed (else the head push itself, the label having
// stayed on across it; else the first tick that saw it waiting). Past `security_review_escalate_minutes` (merge config,
// default 30, 0 = off; core/lib/security-sensitive.mjs reviewEscalateMinutesOf) it sends ONE
//   fleet notify --level action --author <PR author> --re <PR url> --incident security-review-stale-<repo>-<N>
// (engsys#238: a fleet App's PR → a DM to that fleet's operator, anyone else's → this host's operator). It escalates at
// once, whatever the clock, when the lane is clearly unavailable:
//   - the lane's `<!-- security-review-self-skip -->` note is on the PR (it will never review it);
//   - the lane's `<!-- security-review-no-signer -->` note is on the PR (it has no signing key);
//   - the maintain baton is free or expired (no maintenance monster is serving requests).
// Only bot-authored comments count for the request and the two notes: anyone can comment, and a human's comment must
// not move the clock or fake an outage. The latch (.watch/secstale.<N>: head, firstSeen, notified) is per PR and head:
// a new head resolves the old incident and starts the clock again. A PR that leaves the watch (the verdict landed,
// it merged, closed or left the queue) resolves its incident and drops the latch (kept for the next tick when the
// resolve fails). A PR still watched but not waiting
// (a failed preflight run, or the label removed with no verdict) keeps its latch untouched.
//
// Prints one line per act, for the tick's delta:
//   SECURITY_REVIEW_STALE #N <reason> head=<sha12> notified|notify_failed
//   SECURITY_REVIEW_STALE_RESOLVED #N <why>
// Never fails the tick: a GitHub or notify error is a line (or a stderr warning), and the next tick retries.
//
// Test seams: FLEET_GH (the gh to run), BATON_NOTIFY_CMD / FLEET_BIN (the notifier, as baton.mjs resolves it),
// MM_LANE_STATUS_CMD (prints the maintain lease status JSON; default core/lib/lease/github-backend.mjs status).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverConfigs, reviewEscalateMinutesOf } from '../../../lib/security-sensitive.mjs';
import { resolveNotifyCommand } from '../../../lib/lease/baton.mjs';
import { isMainEntry } from '../../../lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKIP_MARKER = '<!-- security-review-self-skip -->';
export const NO_SIGNER_MARKER = '<!-- security-review-no-signer -->';
export const REQUEST_MARKER = '<!-- security-review-request';
const REQUEST_PHRASE = /security review requested/i;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : NaN; };
const isBot = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');

/** The incident key for a PR's stale review (one per PR; the latch keeps the head). */
export function incidentKey(repo, number) {
  return `security-review-stale-${repo.replace('/', '-')}-${number}`;
}

/** A GraphQL author → the login `fleet notify --author` takes: a Bot as `<slug>[bot]`, `app/<slug>` likewise. */
export function authorLogin(author) {
  const login = String(author?.login ?? '').replace(/^app\//, '');
  if (!login) return '';
  return (author?.__typename === 'Bot' || /^app\//.test(author?.login ?? '')) && !/\[bot\]$/i.test(login) ? `${login}[bot]` : login;
}

/**
 * The facts the decision needs, from one GraphQL pullRequest (shape of PR_QUERY's result) and the request label:
 * { head, url, author, headAt, requestAt, skipNote, noSignerNote }. requestAt: the first label event (that label) or
 * bot request comment at or after headAt, else headAt (the label stayed on across the push), else NaN.
 */
export function prFacts(pr, label) {
  const want = String(label ?? '').toLowerCase();
  const head = pr?.headRefOid ?? '';
  const nodes = pr?.timelineItems?.nodes ?? [];
  let headAt = ms(pr?.commits?.nodes?.[0]?.commit?.committedDate);
  for (const n of nodes) {
    if (n?.__typename === 'HeadRefForcePushedEvent' && n.afterCommit?.oid === head) headAt = Math.max(headAt || 0, ms(n.createdAt));
  }
  const comments = nodes.filter((n) => n?.__typename === 'IssueComment' && isBot(n.author));
  const starts = (n, m) => String(n.body ?? '').trimStart().startsWith(m);
  const asks = [
    ...nodes.filter((n) => n?.__typename === 'LabeledEvent' && String(n.label?.name ?? '').toLowerCase() === want).map((n) => ms(n.createdAt)),
    ...comments.filter((n) => starts(n, REQUEST_MARKER) || REQUEST_PHRASE.test(String(n.body ?? ''))).map((n) => ms(n.createdAt)),
  ].filter((t) => Number.isFinite(t) && !(t < headAt));
  return {
    head, url: pr?.url ?? '', author: authorLogin(pr?.author),
    headAt, requestAt: asks.length ? Math.min(...asks) : headAt,
    skipNote: comments.some((n) => starts(n, SKIP_MARKER)),
    noSignerNote: comments.some((n) => starts(n, NO_SIGNER_MARKER)),
  };
}

/** The maintain lease status → { available, why }: free or expired is unavailable; held, or unknown, is not news. */
export function laneFrom(status) {
  if (!status || typeof status !== 'object') return { available: true, why: '' };
  if (status.state === 'free') return { available: false, why: 'no maintenance monster holds the maintain baton' };
  if (status.state === 'unknown' && status.expired) {
    const min = Number.isFinite(status.expiredForMs) ? Math.round(status.expiredForMs / 60000) : null;
    return { available: false, why: `the maintain baton expired${min !== null ? ` ${min} min ago` : ''}` };
  }
  return { available: true, why: '' };
}

/**
 * Escalate now? Pure. facts from prFacts (or null when GitHub was unreadable), lane from laneFrom (or null when not
 * read), firstSeen the latch's first sighting (ms). → { escalate, reason, waitedMin }.
 */
export function decide({ facts, lane, minutes, now, firstSeen }) {
  if (!(minutes > 0)) return { escalate: false, reason: 'off', waitedMin: 0 };
  const start = Number.isFinite(facts?.requestAt) ? facts.requestAt : firstSeen;
  const waitedMin = Math.max(0, Math.floor((now - start) / 60000));
  if (facts?.skipNote) return { escalate: true, reason: 'self_authored_skip', waitedMin };
  if (facts?.noSignerNote) return { escalate: true, reason: 'security_lane_no_key', waitedMin };
  if (lane && !lane.available) return { escalate: true, reason: 'security_lane_down', waitedMin };
  if (waitedMin >= minutes) return { escalate: true, reason: `unanswered_${minutes}min`, waitedMin };
  return { escalate: false, reason: 'waiting', waitedMin };
}

const WHY = {
  self_authored_skip: 'the security lane skipped it as self-authored, so it needs an operator\'s review',
  security_lane_no_key: 'the security lane has no signing key, so no verdict can be posted until that is fixed',
  security_lane_down: 'the security lane is not running',
};

/** The escalation text (plain; notify escapes it). */
export function escalationText({ number, head, reason, waitedMin, lane, minutes }) {
  const why = reason === 'security_lane_down' ? `${WHY[reason]} (${lane?.why ?? 'maintain baton not held'})`
    : WHY[reason] ?? `nobody answered it within ${minutes} min`;
  return `Security review for PR #${number} (head ${head.slice(0, 12)}) has waited ${waitedMin} min with no signed verdict: ${why}. `
    + 'The PR stays parked until the security lane posts a verdict for this head, or an operator reviews it.';
}

// --- I/O --------------------------------------------------------------------------------------------------------

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    url headRefOid author { __typename login }
    commits(last: 1) { nodes { commit { committedDate } } }
    timelineItems(last: 100, itemTypes: [LABELED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, ISSUE_COMMENT]) { nodes {
      __typename
      ... on LabeledEvent { createdAt label { name } }
      ... on HeadRefForcePushedEvent { createdAt afterCommit { oid } }
      ... on IssueComment { createdAt body author { __typename login } } } } } } }`;

function run(cmd, args, { timeout = 60000, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout, env });
  if (r.error || r.status !== 0) throw new Error(String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200));
  return r.stdout;
}

function readPr(repo, number, env) {
  const out = run(env.FLEET_GH || 'gh', ['api', 'graphql', '-f', `owner=${repo.split('/')[0]}`, '-f', `name=${repo.split('/')[1]}`,
    '-F', `number=${number}`, '-f', `query=${PR_QUERY}`, '--jq', '.data.repository.pullRequest'], { env });
  return JSON.parse(out);
}

function readLane(repo, env) {
  const cmd = env.MM_LANE_STATUS_CMD
    ? env.MM_LANE_STATUS_CMD.split(/\s+/).filter(Boolean)
    : [process.execPath, path.join(HERE, '..', '..', '..', 'lib', 'lease', 'github-backend.mjs'), 'status', '--repo', repo, '--role', 'maintain'];
  try { return JSON.parse(run(cmd[0], cmd.slice(1), { timeout: 30000, env })); } catch { return null; }
}

function notify(args, env) {
  const [cmd, ...pre] = resolveNotifyCommand(env);
  try { run(cmd, [...pre, ...args], { timeout: 30000, env }); return true; } catch (e) {
    process.stderr.write(`mm-security-stale: fleet notify failed (${e.message})\n`);
    return false;
  }
}

const latchFile = (dir, n) => path.join(dir, `secstale.${n}`);
function readLatch(dir, n) { try { return JSON.parse(fs.readFileSync(latchFile(dir, n), 'utf8')); } catch { return null; } }
function writeLatch(dir, n, v) { fs.writeFileSync(latchFile(dir, n), `${JSON.stringify(v)}\n`); }
const nums = (s) => [...new Set(String(s ?? '').split(/\s+/).filter((x) => /^[1-9][0-9]*$/.test(x)).map(Number))];

export function tick({ repo, dir, waiting, watched, minutes, label, now = Date.now(), env = process.env, out = process.stdout }) {
  const resolve = (n, why) => {
    const ok = notify(['--resolve', '--incident', incidentKey(repo, n)], env);
    if (ok) out.write(`SECURITY_REVIEW_STALE_RESOLVED #${n} ${why}\n`);
    return ok;
  };
  // PRs that left the watch: the verdict landed, or the PR merged, closed or left the queue
  for (const f of fs.readdirSync(dir).filter((x) => /^secstale\.[0-9]+$/.test(x))) {
    const n = Number(f.split('.')[1]);
    if (waiting.includes(n) || watched.includes(n)) continue;
    if (readLatch(dir, n)?.notified && !resolve(n, 'left_the_watch')) continue; // keep the latch: retried next tick
    fs.rmSync(path.join(dir, f), { force: true });
  }
  let lane;
  for (const n of waiting) {
    let pr = null;
    try { pr = readPr(repo, n, env); } catch (e) { process.stderr.write(`mm-security-stale: cannot read ${repo}#${n} (${e.message})\n`); }
    const facts = pr ? prFacts(pr, label) : null;
    let latch = readLatch(dir, n);
    if (latch && facts?.head && latch.head !== facts.head) {
      if (latch.notified) resolve(n, `new_head ${facts.head.slice(0, 12)}`);
      latch = null; // a new head starts the clock again
    }
    if (!latch) latch = { head: facts?.head ?? '', firstSeen: now, notified: false };
    if (!latch.notified && minutes > 0) {
      if (lane === undefined) lane = laneFrom(readLane(repo, env));
      const d = decide({ facts, lane, minutes, now, firstSeen: latch.firstSeen });
      if (d.escalate) {
        const head = facts?.head || latch.head || '';
        const args = ['--level', 'action', ...(facts?.author ? ['--author', facts.author] : []),
          '--re', facts?.url || `https://github.com/${repo}/pull/${n}`, '--incident', incidentKey(repo, n),
          escalationText({ number: n, head, reason: d.reason, waitedMin: d.waitedMin, lane, minutes })];
        const ok = notify(args, env);
        if (ok) Object.assign(latch, { notified: true, reason: d.reason });
        out.write(`SECURITY_REVIEW_STALE #${n} ${d.reason} head=${head.slice(0, 12) || '-'} ${ok ? 'notified' : 'notify_failed'}\n`);
      }
    }
    writeLatch(dir, n, latch);
  }
}

export function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      repo: { type: 'string' }, 'state-dir': { type: 'string' }, waiting: { type: 'string' }, watched: { type: 'string' },
      config: { type: 'string', multiple: true }, label: { type: 'string' }, now: { type: 'string' },
    } }));
  } catch (e) { err.write(`mm-security-stale: ${e.message}\n`); return 2; }
  if (!REPO_RE.test(values.repo ?? '') || !values['state-dir']) {
    err.write('usage: mm-security-stale.mjs --repo owner/name --state-dir DIR --waiting "N …" --watched "N …" [--label L] [--config FILE]... [--now ISO]\n');
    return 2;
  }
  let cfg;
  try { cfg = reviewEscalateMinutesOf(discoverConfigs({ repo: values.repo, extra: values.config ?? [], env })); } catch (e) {
    cfg = { minutes: 30, warning: e.message };
  }
  if (cfg.warning) err.write(`mm-security-stale: ${cfg.warning}; security_review_escalate_minutes = ${cfg.minutes}\n`);
  const now = values.now ? ms(values.now) : Date.now();
  fs.mkdirSync(values['state-dir'], { recursive: true });
  tick({
    repo: values.repo, dir: values['state-dir'], waiting: nums(values.waiting), watched: nums(values.watched),
    minutes: cfg.minutes, label: values.label || 'security-review-requested', now, env, out,
  });
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = main();
