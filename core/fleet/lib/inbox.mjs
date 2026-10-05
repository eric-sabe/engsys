// inbox.mjs — host state for cross-fleet messages (engsys#77): the per-session inbox the relay
// appends to, the checks every reader applies before it shows an entry, and the small file helpers
// (0700 directories, 0600 files, atomic rewrites, a lock) the relay, `fleet msg` and the inbox hook
// share. Node builtins only.
//
// Layout under the instance's state directory ($FLEET_STATE = <instance>/.fleet):
//   inbox/<session>.jsonl   one accepted message per line:
//                           {"id":N,"url":"https://github.com/...#issuecomment-N","from":"alice:acme-mm",
//                            "re":"acme/app#412"|null,"sha256":"<hex of the comment body>",
//                            "received_at":ISO,"delivered_at":ISO|null,"via":...}
//   relay/state.json        the relay's own state; `accepted` lists the comment ids it accepted
//
// Message text never enters the inbox; an entry points at the comment, and `fleet msg read` fetches
// and re-checks it. Readers trust an entry only when (trustedEntries):
//   - every field matches its pattern (validEntry);
//   - it is bound to the registry: the comment's repo and the `re` repo are registry repos or the
//     instance repo, and the `from` fleet is an enabled fleet other than this one (boundToRegistry);
//   - the relay itself accepted that comment id (relay/state.json `accepted`).
// A line planted by hand fails the last two unless the registry and the relay state are planted too.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ADDRESS_RE, RE_RE } from './fleet-msg.mjs';

/** A roster session name (federation.mjs SESSION_RE), capped at 64 like the address rule. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The comment URL the relay builds from API fields: repo (group 1), issue (2), comment id (3). */
export const COMMENT_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]{0,9})#issuecomment-([1-9][0-9]{0,19})$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const VIA = new Set(['inbox', 'session-start', 'prompt']);
const DAY = 24 * 3600_000;
export const PRUNE = Object.freeze({ deliveredMs: 7 * DAY, undeliveredMs: 30 * DAY });

// --- files -----------------------------------------------------------------------------------------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Write a file atomically (temp file + rename), mode 0600. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn while holding `<dir>/.lock` (O_EXCL). The lock file carries a random token; a lock older
 * than staleMs is taken over, and on the way out the lock is removed only if it still carries our
 * token (a slow holder whose lock was taken over never deletes its successor's). Waits up to waitMs,
 * then throws. Returns fn's result.
 */
export function withLock(dir, fn, { waitMs = 5000, staleMs = 60_000 } = {}) {
  ensureDir(dir);
  const lock = path.join(dir, '.lock');
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(`${lock} is held by another process`);
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
    } catch { /* gone, or no longer ours */ }
  }
}

// --- inbox -----------------------------------------------------------------------------------------

export function inboxDir(stateDir) {
  return path.join(stateDir, 'inbox');
}

function inboxFile(stateDir, session) {
  if (!SESSION_NAME_RE.test(session ?? '')) throw new Error(`not a session name: ${JSON.stringify(session)}`);
  return path.join(inboxDir(stateDir), `${session}.jsonl`);
}

/** An inbox entry whose every field matches its pattern, normalized; null otherwise. */
export function validEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (!Number.isSafeInteger(e.id) || e.id <= 0) return null;
  const u = typeof e.url === 'string' ? COMMENT_URL_RE.exec(e.url) : null;
  if (!u || u[3] !== String(e.id)) return null;
  if (typeof e.from !== 'string' || !ADDRESS_RE.test(e.from)) return null;
  if (e.re !== null && (typeof e.re !== 'string' || !RE_RE.test(e.re))) return null;
  if (e.sha256 !== undefined && (typeof e.sha256 !== 'string' || !SHA_RE.test(e.sha256))) return null;
  if (typeof e.received_at !== 'string' || !ISO_RE.test(e.received_at)) return null;
  if (e.delivered_at !== null && (typeof e.delivered_at !== 'string' || !ISO_RE.test(e.delivered_at))) return null;
  const out = { id: e.id, url: e.url, from: e.from, re: e.re };
  if (e.sha256 !== undefined) out.sha256 = e.sha256;
  out.received_at = e.received_at;
  out.delivered_at = e.delivered_at;
  if (e.via !== undefined && VIA.has(e.via)) out.via = e.via;
  return out;
}

/** The repo part of a comment URL, or null. */
export function urlRepo(url) {
  const m = COMMENT_URL_RE.exec(String(url ?? ''));
  return m ? m[1] : null;
}

/** Is `repo` one the relay polls: a registry repo or the instance repo (case-insensitive)? */
export function listedRepo(reg, instanceRepo, repo) {
  if (typeof repo !== 'string') return false;
  const r = repo.toLowerCase();
  return Object.keys(reg?.repos ?? {}).some((k) => k.toLowerCase() === r) || (typeof instanceRepo === 'string' && instanceRepo.toLowerCase() === r);
}

/** An entry the registry vouches for: its repos are listed and its sender is another enabled fleet. */
export function boundToRegistry(entry, { reg, fleetId, instanceRepo }) {
  if (!reg?.fleets || !fleetId || !reg.fleets[fleetId]) return false;
  if (!listedRepo(reg, instanceRepo, urlRepo(entry.url))) return false;
  const fleet = ADDRESS_RE.exec(entry.from)?.[1];
  if (!fleet || fleet === fleetId || !reg.fleets[fleet]?.enabled) return false;
  if (entry.re !== null && !listedRepo(reg, instanceRepo, RE_RE.exec(entry.re)?.[1])) return false;
  return true;
}

function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const v = validEntry(e);
    if (v) out.push(v);
  }
  return out;
}

const serialize = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');

/** Every pattern-valid entry in a session's inbox, oldest first (no registry or relay check). */
export function readInbox(stateDir, session) {
  return readEntries(inboxFile(stateDir, session));
}

/** Comment ids the relay accepted (relay/state.json `accepted`). */
export function acceptedIds(stateDir) {
  const st = readJson(path.join(stateDir, 'relay', 'state.json'), null);
  const acc = st && typeof st.accepted === 'object' && st.accepted ? st.accepted : {};
  return new Set(Object.keys(acc).filter((k) => /^[1-9][0-9]{0,19}$/.test(k)).map(Number));
}

/**
 * The entries a reader may show: valid, bound to the registry, accepted by the relay itself.
 * `undelivered: true` (the default) keeps only the ones not yet delivered.
 */
export function trustedEntries(stateDir, session, { reg, fleetId, instanceRepo, undelivered = true }) {
  const accepted = acceptedIds(stateDir);
  return readInbox(stateDir, session).filter((e) => (!undelivered || e.delivered_at === null)
    && accepted.has(e.id) && boundToRegistry(e, { reg, fleetId, instanceRepo }));
}

/** Sessions that have an inbox file. */
export function inboxSessions(stateDir) {
  try {
    return fs.readdirSync(inboxDir(stateDir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .filter((s) => SESSION_NAME_RE.test(s))
      .sort();
  } catch {
    return [];
  }
}

/** Append one entry (validated); a duplicate id is ignored. Returns true when it was added. */
export function appendInbox(stateDir, session, entry) {
  const file = inboxFile(stateDir, session);
  const e = validEntry(entry);
  if (!e) throw new Error('refusing to write an invalid inbox entry');
  return withLock(inboxDir(stateDir), () => {
    const entries = readEntries(file);
    if (entries.some((x) => x.id === e.id)) return false;
    entries.push(e);
    writeFileAtomic(file, serialize(entries));
    return true;
  });
}

/** Set delivered_at (and via) on the given ids that are still undelivered. Returns how many changed. */
export function markDelivered(stateDir, session, ids, { at = new Date().toISOString(), via = 'inbox' } = {}) {
  const file = inboxFile(stateDir, session);
  const want = new Set(ids);
  return withLock(inboxDir(stateDir), () => {
    const entries = readEntries(file);
    let n = 0;
    for (const e of entries) {
      if (want.has(e.id) && e.delivered_at === null) { e.delivered_at = at; e.via = via; n++; }
    }
    if (n) writeFileAtomic(file, serialize(entries));
    return n;
  });
}

/**
 * Drop delivered entries older than PRUNE.deliveredMs (by delivered_at), undelivered ones older than
 * PRUNE.undeliveredMs (by received_at), and lines that fail validation. Returns how many were dropped.
 */
export function pruneInbox(stateDir, session, { now = Date.now(), deliveredMs = PRUNE.deliveredMs, undeliveredMs = PRUNE.undeliveredMs } = {}) {
  const file = inboxFile(stateDir, session);
  return withLock(inboxDir(stateDir), () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
    const keep = readEntries(file).filter((e) => (e.delivered_at === null
      ? now - Date.parse(e.received_at) < undeliveredMs
      : now - Date.parse(e.delivered_at) < deliveredMs));
    if (keep.length !== raw) writeFileAtomic(file, serialize(keep));
    return raw - keep.length;
  });
}

/** One inbox line for display: canonical identifiers only. */
export function inboxLine(entry) {
  return `from ${entry.from} re ${entry.re ?? '-'}: ${entry.url}`;
}
