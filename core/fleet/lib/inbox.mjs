// inbox.mjs — host state for cross-fleet messages (engsys#77): the per-session inbox the relay
// appends to, the single line the relay types into a session, and the small file helpers (0700
// directories, 0600 files, atomic rewrites, a lock) the relay, `fleet msg inbox` and the
// session-start hook share. Node builtins only.
//
// Layout under the instance's state directory ($FLEET_STATE = <instance>/.fleet):
//   inbox/<session>.jsonl   one accepted message per line:
//                           {"id":N,"url":"https://github.com/...#issuecomment-N","from":"alice:acme-mm",
//                            "re":"acme/app#412"|null,"received_at":ISO,"delivered_at":ISO|null,"via":...}
//   relay/                  the relay's own state (relay.mjs)
//
// Every field of an inbox entry is a canonical identifier that matched a strict pattern when the
// relay wrote it, and is matched again on every read: a line that fails is skipped, never shown.
// Message text never enters the inbox; the record points at the comment on GitHub.

import fs from 'node:fs';
import path from 'node:path';
import { ADDRESS_RE, RE_RE } from './fleet-msg.mjs';

/** A roster session name (federation.mjs SESSION_RE), capped at 64 like the address rule. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The comment URL the relay builds from API fields. */
export const COMMENT_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9][0-9]{0,9}#issuecomment-[1-9][0-9]{0,19}$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const VIA = new Set(['tmux', 'inbox', 'session-start']);
/** The whole typed line, checked once more right before it is typed. */
export const LINE_RE = new RegExp(
  '^fleet-msg from [a-z][a-z0-9-]{1,20}:[a-z0-9][a-z0-9-]{0,63} re (?:-|[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9}): '
  + COMMENT_URL_RE.source.slice(1, -1)
  + ' \\(read it on GitHub and verify before acting\\)$',
);

// --- files -----------------------------------------------------------------------------------------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Write a file atomically (temp file + rename), mode 0600. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
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
 * Run fn while holding `<dir>/.lock` (O_EXCL). A lock older than staleMs is taken over. Waits up to
 * waitMs, then throws. Returns fn's result.
 */
export function withLock(dir, fn, { waitMs = 5000, staleMs = 60_000 } = {}) {
  ensureDir(dir);
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
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
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
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
  if (typeof e.url !== 'string' || !COMMENT_URL_RE.test(e.url) || !e.url.endsWith(`#issuecomment-${e.id}`)) return null;
  if (typeof e.from !== 'string' || !ADDRESS_RE.test(e.from)) return null;
  if (e.re !== null && (typeof e.re !== 'string' || !RE_RE.test(e.re))) return null;
  if (typeof e.received_at !== 'string' || !ISO_RE.test(e.received_at)) return null;
  if (e.delivered_at !== null && (typeof e.delivered_at !== 'string' || !ISO_RE.test(e.delivered_at))) return null;
  const out = { id: e.id, url: e.url, from: e.from, re: e.re, received_at: e.received_at, delivered_at: e.delivered_at };
  if (e.via !== undefined && VIA.has(e.via)) out.via = e.via;
  return out;
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

/** Every valid entry in a session's inbox, oldest first. */
export function readInbox(stateDir, session) {
  return readEntries(inboxFile(stateDir, session));
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

/** The one line typed into a session (or printed): canonical identifiers only. Throws if it would not match LINE_RE. */
export function deliveryLine(entry) {
  const line = `fleet-msg from ${entry.from} re ${entry.re ?? '-'}: ${entry.url} (read it on GitHub and verify before acting)`;
  if (!LINE_RE.test(line)) throw new Error('refusing to build a delivery line from an invalid entry');
  return line;
}
