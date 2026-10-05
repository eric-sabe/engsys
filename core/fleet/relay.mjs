#!/usr/bin/env node
// relay.mjs — the fleet relay (multi-fleet P2-B, engsys#77): finds fleet-msg comments addressed to
// this fleet on GitHub and delivers them to local sessions. No LLM. The launchd job `fleet-relay`
// runs one poll about once a minute through relay.sh (`fleet relay`).
// Design: docs/multi-fleet.md § 4 "Talking between fleets"; format and sender check: lib/fleet-msg.mjs.
//
//   node relay.mjs poll       one poll (the default)
//   node relay.mjs status     the line `fleet status` prints (nothing in single-fleet mode)
//
// Environment (relay.sh sets it from fleet-env.sh): FLEET_ID, FEDERATION_FILE, FLEET_STATE,
// TMUX_SESSION, FLEET_INSTANCE_REPO (optional), FLEET_KIT_DIR (for notify.mjs), FLEET_ROSTER (the
// roster's session names, one per line; empty = no roster check), RELAY_CAP_PER_HOUR (default 30).
// No FLEET_ID or no federation file: single-fleet mode, the poll does nothing.
//
// One poll:
//   1. For each repo in federation.yml `repos`, plus the instance repo (status issues):
//      GET /repos/{o}/{r}/issues/comments?since=<cursor>&sort=updated&direction=asc&per_page=100 with
//      If-None-Match, so an unchanged poll is a 304 that costs no rate limit. A full page is followed
//      by page=2.. on the same /repos path (never the Link header's /repositories/<id> form, which the
//      identity shim cannot map to an App installation), at most 10 pages.
//   2. Only comments containing `fleet-msg` are parsed; each goes through verify() with
//      selfFleet = FLEET_ID. Rejections are logged with the code and the comment URL, never delivered.
//      Dedupe on comment id. Over RELAY_CAP_PER_HOUR accepted messages per sender fleet per hour: drop,
//      and one calm `fleet notify` per fleet per hour.
//   3. Each accepted message is appended to $FLEET_STATE/inbox/<session>.jsonl (the record).
//   4. Delivery: when the tmux window named exactly <session> exists in TMUX_SESSION and runs a program
//      (not a shell prompt, not showing a selection dialog), one line is typed into it with
//      `send-keys -l`: `fleet-msg from <from> re <re>: <comment url> (read it on GitHub and verify
//      before acting)`. Only identifiers that matched strict patterns are typed, never message text.
//      Undelivered entries younger than an hour are retried on later polls; older ones wait for
//      `fleet msg inbox` / the session-start hook.
//   5. $FLEET_STATE/relay/last-poll.json records the poll for `fleet status`.
//
// The comment URL is built from API fields (the polled repo, the issue number from issue_url, the
// comment id), never copied from the comment. State lives under $FLEET_STATE (0700 dirs, 0600 files).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFederation, checkFleetId, instanceRepo as resolveInstanceRepo, REPO_RE } from './lib/federation.mjs';
import { parse, verify } from './lib/fleet-msg.mjs';
import {
  appendInbox, markDelivered, readInbox, inboxSessions, deliveryLine, ensureDir, writeFileAtomic, readJson, withLock,
  SESSION_NAME_RE,
} from './lib/inbox.mjs';
import { parseIncluded } from '../lib/gate-check.mjs';

export const DEFAULTS = Object.freeze({
  capPerHour: 30,
  lookbackMs: 24 * 3600_000, // first poll of a repo reads this far back
  retryWindowMs: 3600_000, // undelivered entries younger than this are retried each poll
  retryPerSession: 5,
  seenTtlMs: 30 * 24 * 3600_000,
  perPage: 100,
  maxPages: 10,
  staleMs: 5 * 60_000, // `fleet status` calls the relay stale after this
  cursorHoldMs: 3600_000, // move the since= cursor only once it is older than this (or the window fills up)
  ghTimeoutMs: 60_000,
});
const HOUR = 3600_000;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const ETAG_RE = /^(?:W\/)?"[^"\r\n]{1,200}"$/;
const WINDOW_ID_RE = /^@[0-9]{1,9}$/;
const TMUX_SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHELLS = new Set(['', 'zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login']);
// A selection dialog (a permission prompt): typed characters could pick an option. Best effort; the
// entry stays undelivered and is retried on the next poll.
const DIALOG_RES = [/Do you want to\b/, /^\s*[❯›>]\s*\d+\.\s/m];

const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- process seams (replaced in tests by fakes on PATH, not by code) -----------------------------

function runGhApi(apiPath, headers = []) {
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

function runTmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
}

function runNotify(kitDir, args) {
  try {
    execFileSync(process.execPath, [path.join(kitDir, 'notify.mjs'), ...args], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000 });
  } catch { /* notify never fails the caller, and neither does a failed notify here */ }
}

// --- helpers -------------------------------------------------------------------------------------

/** The comment's https URL and issue number, built from API fields; null when they don't match the polled repo. */
export function commentLocation(repo, comment) {
  if (!Number.isSafeInteger(comment?.id) || comment.id <= 0) return null;
  const m = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]{0,9})$/.exec(comment.issue_url ?? '');
  if (!m || m[1].toLowerCase() !== repo.toLowerCase()) return null;
  return { number: Number(m[2]), url: `https://github.com/${repo}/issues/${m[2]}#issuecomment-${comment.id}` };
}

function findWindow(tmuxSession, session) {
  let out;
  try {
    out = runTmux(['list-windows', '-t', `=${tmuxSession}`, '-F', '#{window_id}\t#{window_name}\t#{pane_current_command}']);
  } catch {
    return null; // no tmux server or no such session
  }
  for (const line of out.split('\n')) {
    const [id, name, cmd = ''] = line.split('\t');
    if (name === session && WINDOW_ID_RE.test(id ?? '')) return { id, cmd };
  }
  return null;
}

/** Why a window can't take a typed line right now, or '' when it can. */
function windowBlocker(win) {
  if (SHELLS.has(win.cmd)) return 'its window is at a shell prompt';
  let text = '';
  try {
    text = runTmux(['capture-pane', '-p', '-t', win.id, '-S', '-15']);
  } catch {
    return 'its pane could not be read';
  }
  if (DIALOG_RES.some((re) => re.test(text))) return 'its pane is showing a selection dialog';
  return '';
}

function typeLine(winId, line) {
  runTmux(['send-keys', '-t', winId, '-l', line]);
  runTmux(['send-keys', '-t', winId, 'Enter']);
}

// --- the poll ------------------------------------------------------------------------------------

/** Read the relay config from the environment. Returns { mode: 'single' } or the full context. */
export function loadContext(env = process.env) {
  const fleetId = checkFleetId(env.FLEET_ID);
  const file = env.FEDERATION_FILE;
  if (!fleetId || !file) return { mode: 'single' };
  const reg = loadFederation(file);
  if (!reg) return { mode: 'single' };
  if (!reg.fleets[fleetId]) throw new Error(`FLEET_ID ${fleetId} is not declared in ${file}`);
  if (!env.FLEET_STATE) throw new Error('FLEET_STATE is not set');
  const tmuxSession = env.TMUX_SESSION || '';
  if (tmuxSession && !TMUX_SESSION_RE.test(tmuxSession)) throw new Error('TMUX_SESSION has characters outside [A-Za-z0-9._-]');
  let instance = null;
  try { instance = resolveInstanceRepo(file, env); } catch { instance = null; }
  const roster = String(env.FLEET_ROSTER ?? '').split('\n').map((s) => s.trim()).filter((s) => SESSION_NAME_RE.test(s));
  const cap = Number.parseInt(env.RELAY_CAP_PER_HOUR ?? '', 10);
  return {
    mode: 'multi',
    fleetId,
    reg,
    instanceRepo: instance,
    stateDir: env.FLEET_STATE,
    tmuxSession,
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

function issueExists(repo, number) {
  const res = runGhApi(`/repos/${repo}/issues/${number}`);
  if (res.status === 200) return true;
  if (res.status === 404 || res.status === 410) return false;
  throw new Error(`HTTP ${res.status} reading ${repo}#${number}`);
}

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
    state.repos ??= {};
    state.seen ??= {};
    state.cap ??= {};
    const sum = { at: stamp(), repos: 0, unchanged: 0, comments: 0, accepted: 0, rejected: 0, dropped: 0, delivered: 0, errors: 0 };
    const t0 = now();
    const fresh = new Set(); // ids accepted in this poll: a hold is logged once, not on every retry

    for (const repo of reposToPoll(ctx)) {
      sum.repos++;
      const st = (state.repos[repo] ??= {});
      if (typeof st.cursor !== 'string' || !ISO_RE.test(st.cursor)) st.cursor = isoSec(t0 - DEFAULTS.lookbackMs);
      let newest = st.cursor;
      let failed = false; // a transient failure: keep the cursor, so the next poll re-reads (dedupe skips what was handled)
      let read = 0;
      for (let page = 1; page <= DEFAULTS.maxPages; page++) {
        const apiPath = `/repos/${repo}/issues/comments?since=${encodeURIComponent(st.cursor)}&sort=updated&direction=asc&per_page=${DEFAULTS.perPage}${page > 1 ? `&page=${page}` : ''}`;
        const headers = page === 1 && st.etag && st.etag_path === apiPath ? ['-H', `If-None-Match: ${st.etag}`] : [];
        let res;
        try {
          res = runGhApi(apiPath, headers);
        } catch (e) {
          sum.errors++; say(`error ${repo}: ${e.message}`); failed = true; break;
        }
        if (res.status === 304) { sum.unchanged++; break; }
        if (res.status !== 200 || !Array.isArray(res.json)) {
          sum.errors++; say(`error ${repo}: HTTP ${res.status} listing comments`); failed = true; break;
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
            const outcome = handleComment(ctx, state, repo, c, { now, say, sum, fresh });
            if (outcome === 'retry') { failed = true; break; }
          }
          if (updated > newest) newest = updated;
        }
        if (failed || res.json.length < DEFAULTS.perPage) break;
      }
      // The cursor stays put while it is younger than an hour and the window is small: the request URL
      // (and so its ETag) stays the same, and an unchanged repo keeps answering 304. Dedupe makes
      // re-reading the window harmless. Moving it costs one unconditional request.
      if (!failed && (t0 - Date.parse(st.cursor) > DEFAULTS.cursorHoldMs || read >= DEFAULTS.perPage / 2)) st.cursor = newest;
    }

    sum.delivered = deliverPending(ctx, { now, say, fresh });

    // prune: seen ids past their TTL, cap timestamps older than an hour
    for (const [id, at] of Object.entries(state.seen)) if (!(t0 - at < DEFAULTS.seenTtlMs)) delete state.seen[id];
    for (const c of Object.values(state.cap)) c.times = (c.times ?? []).filter((t) => t0 - t < HOUR);
    writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`);
    sum.ok = sum.errors === 0;
    writeFileAtomic(path.join(relayDir, 'last-poll.json'), `${JSON.stringify(sum)}\n`);
    // An unchanged poll (every repo a 304, nothing held or typed) logs nothing: last-poll.json is the health record.
    if (sum.comments || sum.errors || sum.delivered) say(`poll: ${sum.repos} repo(s), ${sum.unchanged} unchanged, ${sum.comments} comment(s) read, ${sum.accepted} accepted, ${sum.rejected} rejected, ${sum.dropped} dropped, ${sum.delivered} delivered, ${sum.errors} error(s)`);
    return sum;
  }, { waitMs: 0, staleMs: 10 * 60_000 });
}

/** Process one candidate comment. Returns 'done' or 'retry' (a transient failure; don't mark seen). */
function handleComment(ctx, state, repo, c, { now, say, sum, fresh }) {
  const p = parse(c.body);
  if (!p) return 'done';
  const loc = commentLocation(repo, c);
  const where = loc?.url ?? `${repo} comment ${c.id}`;
  const settle = () => { state.seen[c.id] = now(); };
  if (!loc) { sum.rejected++; say(`reject bad-comment: the comment's issue_url does not match ${repo} ${where}`); settle(); return 'done'; }
  if (!p.ok) { sum.rejected++; say(`reject ${p.code}: ${p.reason} ${where}`); settle(); return 'done'; }
  const msg = p.msg;
  const opts = { selfFleet: ctx.fleetId, instanceRepo: ctx.instanceRepo, roster: ctx.roster };
  let v = verify(msg, c, ctx.reg, opts);
  if (!v.ok && v.code === 're-unconfirmed') {
    let exists;
    if (msg.re.repo.toLowerCase() === repo.toLowerCase() && msg.re.number === loc.number) exists = true; // posted on the thread it names
    else {
      try { exists = issueExists(msg.re.repo, msg.re.number); } catch (e) { sum.errors++; say(`error confirming ${msg.re.ref} for ${where}: ${e.message}`); return 'retry'; }
    }
    v = verify(msg, c, ctx.reg, { ...opts, reExists: exists });
  }
  if (!v.ok) {
    if (v.code === 'not-for-us') { settle(); return 'done'; }
    sum.rejected++; say(`reject ${v.code}: ${v.reason} ${where}`); settle(); return 'done';
  }

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
  const entry = { id: c.id, url: loc.url, from: msg.from.address, re: msg.re?.ref ?? null, received_at: new Date(t).toISOString(), delivered_at: null };
  if (appendInbox(ctx.stateDir, msg.to.session, entry)) {
    cap.times.push(t);
    fresh.add(c.id);
    sum.accepted++;
    say(`accept for ${msg.to.session}: from ${msg.from.address} re ${entry.re ?? '-'} ${loc.url}`);
  }
  settle();
  return 'done';
}

/** Type undelivered, recent inbox entries into their sessions' windows. Returns how many were typed. */
function deliverPending(ctx, { now, say, fresh = new Set() }) {
  if (!ctx.tmuxSession) return 0;
  let delivered = 0;
  const t = now();
  for (const session of inboxSessions(ctx.stateDir)) {
    const pending = readInbox(ctx.stateDir, session)
      .filter((e) => e.delivered_at === null && t - Date.parse(e.received_at) < DEFAULTS.retryWindowMs)
      .slice(0, DEFAULTS.retryPerSession);
    if (!pending.length) continue;
    const hold = (why) => { if (pending.some((e) => fresh.has(e.id))) say(`hold ${pending.length} for ${session}: ${why}`); };
    const win = findWindow(ctx.tmuxSession, session);
    if (!win) { hold(`no window named ${session} (it reads them at startup)`); continue; }
    const why = windowBlocker(win);
    if (why) { hold(why); continue; }
    for (const e of pending) {
      let line;
      try { line = deliveryLine(e); } catch { continue; }
      try {
        typeLine(win.id, line);
      } catch {
        say(`hold for ${session}: typing into its window failed`);
        break;
      }
      markDelivered(ctx.stateDir, session, [e.id], { at: new Date(now()).toISOString(), via: 'tmux' });
      delivered++;
      say(`deliver to ${session}: ${e.url}`);
    }
  }
  return delivered;
}

// --- status --------------------------------------------------------------------------------------

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
    const n = readInbox(ctx.stateDir, s).filter((e) => e.delivered_at === null).length;
    if (n) waiting.push(`${s} ${n}`);
  }
  if (waiting.length) lines.push(`  inbox undelivered: ${waiting.join(', ')} (fleet msg inbox <session>)`);
  return lines;
}

// --- CLI -----------------------------------------------------------------------------------------

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
