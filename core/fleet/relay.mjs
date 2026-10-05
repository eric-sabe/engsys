#!/usr/bin/env node
// relay.mjs — the fleet relay (multi-fleet P2-B, engsys#77): finds fleet-msg comments addressed to
// this fleet on GitHub and records them in the addressed session's inbox. No LLM, and no keystrokes:
// sessions learn about waiting messages from the core plugin's inbox hook (SessionStart and
// UserPromptSubmit) and, for the monsters, a FLEET_MSG event on their watch bus. The launchd job
// `fleet-relay` runs one poll about once a minute through relay.sh (`fleet relay`).
// Design: docs/multi-fleet.md § 4 "Talking between fleets"; format and sender check: lib/fleet-msg.mjs.
//
//   node relay.mjs poll       one poll (the default)
//   node relay.mjs status     the lines `fleet status` prints (nothing in single-fleet mode)
//
// Environment (relay.sh sets it from fleet-env.sh): FLEET_ID, FEDERATION_FILE, FLEET_STATE,
// FLEET_INSTANCE_REPO (optional), FLEET_KIT_DIR (for notify.mjs), FLEET_ROSTER (the roster's session
// names, one per line; empty = no roster check), RELAY_CAP_PER_HOUR (default 30).
// No FLEET_ID or no federation file: single-fleet mode, the poll does nothing.
//
// One poll:
//   1. For each repo in federation.yml `repos`, plus the instance repo (status issues):
//      GET /repos/{o}/{r}/issues/comments?since=<cursor>&sort=updated&direction=asc&per_page=100 with
//      If-None-Match, so an unchanged poll is a 304 that costs no rate limit. The cursor holds for an
//      hour, so the URL and its ETag stay the same. A full page is followed by page=2.. on the same
//      /repos path (never the Link header's /repositories/<id> form, which the identity shim cannot map
//      to an App installation), at most 10 pages.
//   2. Only comments containing `fleet-msg` are parsed; each goes through verify() with
//      selfFleet = FLEET_ID. Rejections are logged with the code and the comment URL. Dedupe on comment
//      id. A message whose `re` can't be confirmed for a transient reason is retried on later polls, at
//      most 5 times, then rejected; it never stops the rest of the repo from being read. Over
//      RELAY_CAP_PER_HOUR accepted messages per sender fleet per hour: drop, and one calm
//      `fleet notify` per fleet per hour.
//   3. Each accepted message is appended to $FLEET_STATE/inbox/<session>.jsonl, with the sha256 of the
//      comment body (`fleet msg read` compares it), and its id is recorded in relay/state.json
//      `accepted`: readers show only entries the relay accepted (lib/inbox.mjs trustedEntries).
//   4. Inboxes are pruned: delivered entries after 7 days, undelivered ones after 30.
//   5. $FLEET_STATE/relay/last-poll.json records the poll for `fleet status`.
//
// The comment URL is built from API fields (the polled repo, the issue number from issue_url, the
// comment id), never copied from the comment. State lives under $FLEET_STATE (0700 dirs, 0600 files).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFederation, checkFleetId, instanceRepo as resolveInstanceRepo, REPO_RE } from './lib/federation.mjs';
import { parse, verify } from './lib/fleet-msg.mjs';
import {
  appendInbox, inboxSessions, pruneInbox, trustedEntries, ensureDir, writeFileAtomic, readJson, withLock, SESSION_NAME_RE,
} from './lib/inbox.mjs';
import { parseIncluded } from '../lib/gate-check.mjs';

export const DEFAULTS = Object.freeze({
  capPerHour: 30,
  lookbackMs: 24 * 3600_000, // first poll of a repo reads this far back
  seenTtlMs: 30 * 24 * 3600_000,
  perPage: 100,
  maxPages: 10,
  maxRetries: 5, // transient failures confirming one comment's `re` before it is rejected
  staleMs: 5 * 60_000, // `fleet status` calls the relay stale after this
  cursorHoldMs: 3600_000, // move the since= cursor only once it is older than this (or the window fills up)
  ghTimeoutMs: 60_000,
});
const HOUR = 3600_000;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const ETAG_RE = /^(?:W\/)?"[^"\r\n]{1,200}"$/;

const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

// --- GitHub (through `gh`, so the fleet's App identity applies) ------------------------------------

/** `gh api -i <path>` -> { status, json, headers }. A 304 or 4xx is a value; only a transport failure throws. */
export function ghApi(apiPath, headers = []) {
  let stdout;
  try {
    stdout = execFileSync('gh', ['api', '-i', ...headers, apiPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: DEFAULTS.ghTimeoutMs,
    });
  } catch (e) {
    // gh exits non-zero on 304 and on 4xx/5xx; with -i the status line is still on stdout.
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
    if (!/^HTTP\/[0-9.]+ \d{3}/.test(stdout)) throw new Error(`gh api failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
  return parseIncluded(stdout);
}

/** true / false, or throws on anything but 200 / 404 / 410. */
export function issueExists(repo, number) {
  const res = ghApi(`/repos/${repo}/issues/${number}`);
  if (res.status === 200) return true;
  if (res.status === 404 || res.status === 410) return false;
  throw new Error(`HTTP ${res.status} reading ${repo}#${number}`);
}

/** The comment's https URL and issue number, built from API fields; null when they don't match the polled repo. */
export function commentLocation(repo, comment) {
  if (!Number.isSafeInteger(comment?.id) || comment.id <= 0) return null;
  const m = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]{0,9})$/.exec(comment.issue_url ?? '');
  if (!m || m[1].toLowerCase() !== repo.toLowerCase()) return null;
  return { number: Number(m[2]), url: `https://github.com/${repo}/issues/${m[2]}#issuecomment-${comment.id}` };
}

/**
 * parse() + verify() for one fetched comment, confirming `re` when verify asks for it. Shared by the
 * relay and `fleet msg read`. -> { ok, msg?, code?, reason?, transient? }; transient: the `re` lookup
 * failed for a reason worth retrying.
 */
export function checkComment(repo, c, loc, opts, { exists = issueExists } = {}) {
  const p = parse(c.body);
  if (!p) return { ok: false, code: 'malformed', reason: 'the comment carries no fleet-msg header' };
  if (!p.ok) return p;
  let v = verify(p.msg, c, opts.reg, opts);
  if (!v.ok && v.code === 're-unconfirmed') {
    let found;
    if (p.msg.re.repo.toLowerCase() === repo.toLowerCase() && p.msg.re.number === loc.number) found = true; // posted on the thread it names
    else {
      try { found = exists(p.msg.re.repo, p.msg.re.number); } catch (e) { return { ok: false, code: 're-unconfirmed', reason: e.message, transient: true, msg: p.msg }; }
    }
    v = verify(p.msg, c, opts.reg, { ...opts, reExists: found });
  }
  return v.ok ? { ok: true, msg: p.msg } : { ...v, msg: p.msg };
}

// --- context ---------------------------------------------------------------------------------------

/** Read the relay config from the environment. Returns { mode: 'single' } or the full context. */
export function loadContext(env = process.env) {
  const fleetId = checkFleetId(env.FLEET_ID);
  const file = env.FEDERATION_FILE;
  if (!fleetId || !file) return { mode: 'single' };
  const reg = loadFederation(file);
  if (!reg) return { mode: 'single' };
  if (!reg.fleets[fleetId]) throw new Error(`FLEET_ID ${fleetId} is not declared in ${file}`);
  const stateDir = env.FLEET_STATE || (env.FLEET_INBOX_DIR && path.basename(env.FLEET_INBOX_DIR) === 'inbox' ? path.dirname(env.FLEET_INBOX_DIR) : '');
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('FLEET_STATE (or FLEET_INBOX_DIR) is not set');
  let instance = null;
  try { instance = resolveInstanceRepo(file, env); } catch { instance = null; }
  const roster = String(env.FLEET_ROSTER ?? '').split('\n').map((s) => s.trim()).filter((s) => SESSION_NAME_RE.test(s));
  const cap = Number.parseInt(env.RELAY_CAP_PER_HOUR ?? '', 10);
  return {
    mode: 'multi',
    fleetId,
    reg,
    instanceRepo: instance,
    stateDir,
    roster,
    capPerHour: Number.isSafeInteger(cap) && cap > 0 ? cap : DEFAULTS.capPerHour,
    kitDir: env.FLEET_KIT_DIR || path.dirname(fileURLToPath(import.meta.url)),
  };
}

function reposToPoll(ctx) {
  const set = new Map();
  for (const r of Object.keys(ctx.reg.repos)) if (REPO_RE.test(r)) set.set(r.toLowerCase(), r);
  if (ctx.instanceRepo && REPO_RE.test(ctx.instanceRepo)) set.set(ctx.instanceRepo.toLowerCase(), ctx.instanceRepo);
  return [...set.values()];
}

function runNotify(kitDir, args) {
  try {
    execFileSync(process.execPath, [path.join(kitDir, 'notify.mjs'), ...args], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000 });
  } catch { /* notify never fails the caller, and neither does a failed notify here */ }
}

// --- the poll --------------------------------------------------------------------------------------

/**
 * One poll. Returns the summary also written to relay/last-poll.json.
 * log(line) receives one line per event.
 */
export function poll(ctx, { now = () => Date.now(), log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const relayDir = path.join(ctx.stateDir, 'relay');
  ensureDir(ctx.stateDir);
  ensureDir(relayDir);
  const stamp = () => new Date(now()).toISOString();
  const say = (l) => log(`${stamp()} ${l}`);
  return withLock(relayDir, () => {
    const stateFile = path.join(relayDir, 'state.json');
    const state = readJson(stateFile, {});
    for (const k of ['repos', 'seen', 'cap', 'accepted', 'retries']) if (!state[k] || typeof state[k] !== 'object') state[k] = {};
    const sum = { at: stamp(), repos: 0, unchanged: 0, comments: 0, accepted: 0, rejected: 0, dropped: 0, retrying: 0, errors: 0 };
    const t0 = now();

    for (const repo of reposToPoll(ctx)) {
      sum.repos++;
      const st = (state.repos[repo] ??= {});
      if (typeof st.cursor !== 'string' || !ISO_RE.test(st.cursor)) st.cursor = isoSec(t0 - DEFAULTS.lookbackMs);
      let newest = st.cursor;
      let hold = false; // keep the cursor: a failure (or a comment to retry) means the window is read again
      let retried = false; // a comment to retry: skip If-None-Match next poll, or a 304 would hide it
      let read = 0;
      for (let page = 1; page <= DEFAULTS.maxPages; page++) {
        const apiPath = `/repos/${repo}/issues/comments?since=${encodeURIComponent(st.cursor)}&sort=updated&direction=asc&per_page=${DEFAULTS.perPage}${page > 1 ? `&page=${page}` : ''}`;
        const headers = page === 1 && st.etag && st.etag_path === apiPath && !st.retry ? ['-H', `If-None-Match: ${st.etag}`] : [];
        let res;
        try {
          res = ghApi(apiPath, headers);
        } catch (e) {
          sum.errors++; say(`error ${repo}: ${e.message}`); hold = true; break;
        }
        if (res.status === 304) { sum.unchanged++; break; }
        if (res.status !== 200 || !Array.isArray(res.json)) {
          sum.errors++; say(`error ${repo}: HTTP ${res.status} listing comments`); hold = true; break;
        }
        if (page === 1) {
          const etag = res.headers.etag;
          if (typeof etag === 'string' && ETAG_RE.test(etag)) { st.etag = etag; st.etag_path = apiPath; } else { delete st.etag; delete st.etag_path; }
        }
        for (const c of res.json) {
          const updated = typeof c?.updated_at === 'string' && ISO_RE.test(c.updated_at) ? c.updated_at : null;
          if (!updated || !Number.isSafeInteger(c?.id)) continue;
          sum.comments++;
          read++;
          if (typeof c.body === 'string' && c.body.includes('fleet-msg') && !state.seen[c.id]) {
            if (handleComment(ctx, state, repo, c, { now, say, sum }) === 'retry') { hold = true; retried = true; }
          }
          if (updated > newest) newest = updated;
        }
        if (res.json.length < DEFAULTS.perPage) break;
      }
      // The cursor stays put while it is younger than an hour and the window is small: the request URL
      // (and so its ETag) stays the same, and an unchanged repo keeps answering 304. Dedupe makes
      // re-reading the window harmless. Moving it costs one unconditional request.
      if (retried) st.retry = true; else if (!hold) delete st.retry;
      if (!hold && (t0 - Date.parse(st.cursor) > DEFAULTS.cursorHoldMs || read >= DEFAULTS.perPage / 2)) st.cursor = newest;
    }

    for (const session of inboxSessions(ctx.stateDir)) {
      try { pruneInbox(ctx.stateDir, session, { now: t0 }); } catch (e) { say(`error pruning the ${session} inbox: ${e.message}`); }
    }
    // prune: seen and accepted ids past their TTL (the inbox drops undelivered entries at the same age),
    // cap timestamps older than an hour, retry counters of comments that are settled
    for (const k of ['seen', 'accepted']) for (const [id, at] of Object.entries(state[k])) if (!(t0 - at < DEFAULTS.seenTtlMs)) delete state[k][id];
    for (const id of Object.keys(state.retries)) if (state.seen[id]) delete state.retries[id];
    for (const c of Object.values(state.cap)) c.times = (c.times ?? []).filter((t) => t0 - t < HOUR);
    writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`);
    sum.ok = sum.errors === 0;
    writeFileAtomic(path.join(relayDir, 'last-poll.json'), `${JSON.stringify(sum)}\n`);
    // An unchanged poll (every repo a 304) logs nothing: last-poll.json is the health record.
    if (sum.comments || sum.errors) {
      say(`poll: ${sum.repos} repo(s), ${sum.unchanged} unchanged, ${sum.comments} comment(s) read, ${sum.accepted} accepted, ${sum.rejected} rejected, ${sum.dropped} dropped, ${sum.retrying} to retry, ${sum.errors} error(s)`);
    }
    return sum;
  }, { waitMs: 0, staleMs: 10 * 60_000 });
}

/** Process one candidate comment. Returns 'done' or 'retry' (a transient failure; not marked seen). */
function handleComment(ctx, state, repo, c, { now, say, sum }) {
  if (!parse(c.body)) return 'done';
  const loc = commentLocation(repo, c);
  const where = loc?.url ?? `${repo} comment ${c.id}`;
  const settle = () => { state.seen[c.id] = now(); };
  if (!loc) { sum.rejected++; say(`reject bad-comment: the comment's issue_url does not match ${repo} ${where}`); settle(); return 'done'; }
  const v = checkComment(repo, c, loc, { reg: ctx.reg, selfFleet: ctx.fleetId, instanceRepo: ctx.instanceRepo, roster: ctx.roster });
  if (!v.ok && v.transient) {
    const n = (state.retries[c.id] = (Number(state.retries[c.id]) || 0) + 1);
    if (n < DEFAULTS.maxRetries) { sum.retrying++; say(`retry ${n}/${DEFAULTS.maxRetries} confirming ${v.msg.re.ref} for ${where}: ${v.reason}`); return 'retry'; }
    sum.rejected++; say(`reject re-unconfirmed: gave up after ${n} attempts (${v.reason}) ${where}`); settle(); return 'done';
  }
  if (!v.ok) {
    settle();
    if (v.code !== 'not-for-us') { sum.rejected++; say(`reject ${v.code}: ${v.reason} ${where}`); }
    return 'done';
  }
  const { msg } = v;
  const sender = msg.from.fleet;
  const cap = (state.cap[sender] ??= { times: [] });
  const t = now();
  cap.times = (cap.times ?? []).filter((x) => t - x < HOUR);
  if (cap.times.length >= ctx.capPerHour) {
    sum.dropped++; say(`drop rate-cap: fleet ${sender} is over ${ctx.capPerHour} messages this hour ${where}`); settle();
    if (!(t - (cap.notified_at ?? 0) < HOUR)) {
      cap.notified_at = t;
      runNotify(ctx.kitDir, ['--level', 'info', `relay: fleet ${sender} sent more than ${ctx.capPerHour} cross-fleet messages in the last hour; dropping the rest until its rate falls (see the fleet-relay log)`]);
    }
    return 'done';
  }
  const entry = {
    id: c.id, url: loc.url, from: msg.from.address, re: msg.re?.ref ?? null, sha256: sha256(c.body),
    received_at: new Date(t).toISOString(), delivered_at: null,
  };
  if (appendInbox(ctx.stateDir, msg.to.session, entry)) {
    cap.times.push(t);
    state.accepted[c.id] = t;
    sum.accepted++;
    say(`accept for ${msg.to.session}: from ${msg.from.address} re ${entry.re ?? '-'} ${loc.url}`);
  }
  settle();
  return 'done';
}

// --- status ----------------------------------------------------------------------------------------

/** The lines `fleet status` prints for the relay (none in single-fleet mode). */
export function statusLines(ctx, { now = Date.now() } = {}) {
  if (ctx.mode !== 'multi') return [];
  const lines = [];
  const last = readJson(path.join(ctx.stateDir, 'relay', 'last-poll.json'), null);
  const at = last && typeof last.at === 'string' ? Date.parse(last.at) : NaN;
  if (!Number.isFinite(at)) lines.push('relay: never ran (fleet install-jobs installs the fleet-relay job; fleet relay runs one poll)');
  else {
    const age = Math.max(0, Math.round((now - at) / 1000));
    const ageText = age < 120 ? `${age}s` : age < 7200 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
    const health = last.ok ? 'ok' : `${Number(last.errors) || 0} error(s), see the fleet-relay log`;
    const stale = now - at > DEFAULTS.staleMs ? ' STALE: is the fleet-relay job loaded? (fleet install-jobs)' : '';
    lines.push(`relay: last poll ${ageText} ago, ${health}${stale}`);
  }
  const waiting = [];
  for (const s of inboxSessions(ctx.stateDir)) {
    const n = trustedEntries(ctx.stateDir, s, ctx).length;
    if (n) waiting.push(`${s} ${n}`);
  }
  if (waiting.length) lines.push(`  inbox undelivered: ${waiting.join(', ')} (fleet msg inbox <session>)`);
  return lines;
}

// --- CLI -------------------------------------------------------------------------------------------

export function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const [cmd = 'poll', ...rest] = argv;
  if (cmd === '-h' || cmd === '--help') { out.write('usage: relay.mjs [poll|status]\n'); return 0; }
  if (rest.length || !['poll', 'status'].includes(cmd)) { err.write('usage: relay.mjs [poll|status]\n'); return 2; }
  let ctx;
  try {
    ctx = loadContext(env);
  } catch (e) {
    if (cmd === 'status') { out.write(`relay: cannot run (${e.message})\n`); return 0; }
    err.write(`fleet relay: ${e.message}\n`);
    return 1;
  }
  if (cmd === 'status') {
    for (const l of statusLines(ctx)) out.write(`${l}\n`);
    return 0;
  }
  if (ctx.mode !== 'multi') { out.write('fleet relay: single-fleet mode (no FLEET_ID or no federation file); nothing to relay\n'); return 0; }
  try {
    const sum = poll(ctx, { log: (l) => out.write(`${l}\n`) });
    return sum.ok ? 0 : 1;
  } catch (e) {
    err.write(`fleet relay: ${e.message}\n`);
    return 1;
  }
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = main(process.argv.slice(2));
