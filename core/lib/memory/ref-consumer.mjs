// ref-consumer.mjs — the staged-fetch consumer of signed memory refs (engsys#266; docs/memory-spec.md §3.1, §9).
//
// The ONE reader of refs/engsys/memory/* content as trusted input (ref-consumer-guard.test.mjs lists it in
// CONSUMERS). Two halves:
//
//   consumeMemoryRefs(repoRoot, opts)   the maintain baton holder's tick (memory-sync --consume): force-fetch the
//                                       remote's memory refs into a staging namespace, and move each local
//                                       refs/engsys/memory/<ref> only to a staged tip that (1) verifies — signed by
//                                       the fleet the ref names, against fleet_memory_pubkeys in the operator's
//                                       memory.yml — and (2) descends from the last verified tip (`git merge-base
//                                       --is-ancestor`). The local refs therefore hold only verified tips, and they
//                                       are the record of the last verified tip. Writers always commit a child of
//                                       the previous tip (merge, `replace: true` tail, compaction alike), so content
//                                       is never assumed append-only; only ancestry is checked. A stale signed tip
//                                       can't be re-parented: the signature binds its parent.
//   loadVerifiedRefEvents(repoRoot, o)  the brief's synchronous read path (index-db loadClassBEvents): re-verify each
//                                       local consumable tip and return its events stamped `fleet_signed`. Verdicts
//                                       are cached per (ref, tip, reviewed SHA, pubkeys), so a brief re-verifies
//                                       only what changed.
//
// Which refs are consumed: every ref in a fleet's namespace, `refs/engsys/memory/fleet/<fleet>/{events,merge,maintain}`
// (signing.mjs refFleet, engsys#266), each signed by the fleet its path names. The retired shared
// `refs/engsys/memory/events` and the pre-#266 `<role>/<fleet>` tails are never consumed (operator decision on #266):
// one fleet's key must not vouch for a stream every fleet reads. Dropping a fleet's key from memory.yml drops its
// stream at the next read (trust.mjs re-checks the key on every brief, too).
//
// Rollback state: besides the local ref, the last verified tip per ref is written to `<state dir>/memory-ref-tips.json`
// (outside .git). It is consulted only when the local ref is missing (a wiped or fresh git dir). With neither, the
// first staged tip that verifies is trusted (trust on first use) and a warning is logged.
//
// Skip, never block: every failure (fetch, a bad signature, a rollback, a git error) leaves the last verified state
// as it was, is reported per ref, and never throws.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEventsJsonl, verifyMemoryRefTipSync } from './ref-store.mjs';
import { refFleet, resolveFleetPubkeys } from './signing.mjs';

// ref-store.mjs's MEMORY_REF_PREFIX, restated: index-db imports this module and ref-store imports index-db, so a
// top-level use of a ref-store `const` here could run before ref-store has evaluated (functions are hoisted; consts
// are not). ref-consumer.test.mjs asserts the two are equal.
export const MEMORY_REF_PREFIX = 'refs/engsys/memory/';
/** The fleet namespaces (ref-store FLEET_REF_PREFIX, restated for the same reason). */
export const FLEET_REF_PREFIX = `${MEMORY_REF_PREFIX}fleet/`;
/** Where the staged fetch lands. Never read for trust; only verified tips move into refs/engsys/memory/fleet/*. */
export const INCOMING_PREFIX = 'refs/engsys/memory-incoming/';
export const STAGED_FETCH_REFSPEC = `+${FLEET_REF_PREFIX}*:${INCOMING_PREFIX}fleet/*`;
export const TIPS_FILE = 'memory-ref-tips.json';
export const VERIFY_CACHE_FILE = 'ref-verify-cache.json';
const ZERO_OID = '0'.repeat(40);
// A rejection that describes configuration, not an attack: a fleet whose key isn't in memory.yml yet. Logged once per
// ref (then kept quiet in the tips file until the reason changes), so the heartbeat's warn file can clear while a
// fleet waits for its pubkey PR. Every other rejection is logged on every tick.
const QUIET_REASONS = new Set(['unknown_fleet']);
// The staged fetch must never start gc or maintenance in the operator's checkout (dozens of worktrees share it).
const FETCH_CONFIG = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const OID_RE = /^[0-9a-f]{40}$/;

/** Whether a reader consumes `ref`: a ref in a fleet's namespace (signing.mjs refFleet). The one place this is decided. */
export function isConsumedRef(ref) {
  return refFleet(ref) !== null;
}

/** memory.yml `peer_fleet_weight`, clamped to [0, 1]; 0.5 when unset or not a number. */
export function peerFleetWeight(config) {
  const v = Number(config?.peer_fleet_weight);
  if (config?.peer_fleet_weight == null || config.peer_fleet_weight === '' || !Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

function git(exec, repoRoot, args, opts = {}) {
  return exec('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** `[{ ref, sha }]` under `prefix`, sorted. */
function listRefs(exec, repoRoot, prefix) {
  const out = git(exec, repoRoot, ['for-each-ref', '--format=%(refname) %(objectname)', prefix.replace(/\/$/, '')]);
  const refs = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+) ([0-9a-f]{40})$/.exec(line.trim());
    if (m && m[1].startsWith(prefix)) refs.push({ ref: m[1], sha: m[2] });
  }
  return refs.sort((a, b) => a.ref.localeCompare(b.ref));
}

function localTip(exec, repoRoot, ref) {
  try { return git(exec, repoRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).trim() || null; } catch { return null; }
}

/** The commit's tip content: `{ parent, content, sigText }`, or null when it has no events.jsonl. */
function readTip(exec, repoRoot, sha) {
  const parents = git(exec, repoRoot, ['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1);
  if (parents.length > 1) return { error: 'merge_commit' };
  let content;
  try { content = git(exec, repoRoot, ['show', `${sha}:events.jsonl`]); } catch { return { error: 'no_events_jsonl' }; }
  let sigText = '';
  try { sigText = git(exec, repoRoot, ['show', `${sha}:events.sig`]); } catch { /* verify reports the missing signature */ }
  return { parent: parents[0] || null, content, sigText };
}

/**
 * The staged fetch, with gc and maintenance off (`-c gc.auto=0 -c maintenance.auto=false`, and
 * `--no-auto-maintenance` where git has it: 2.29+; an older git that rejects the option is retried without it).
 */
function stagedFetch(exec, repoRoot, remote) {
  const args = ['fetch', '--no-tags', '--prune', '--quiet', remote, STAGED_FETCH_REFSPEC];
  try {
    git(exec, repoRoot, [...FETCH_CONFIG, 'fetch', '--no-auto-maintenance', ...args.slice(1)], { timeout: 60_000 });
  } catch (e) {
    if (!/unknown option|usage: git fetch/i.test(String(e?.stderr || e?.message || ''))) throw e;
    git(exec, repoRoot, [...FETCH_CONFIG, ...args], { timeout: 60_000 });
  }
}

function isAncestor(exec, repoRoot, older, newer) {
  try {
    git(exec, repoRoot, ['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false; // exit 1 (not an ancestor) or 128 (the old tip is not in this history at all): both reject
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/**
 * The maintain baton holder's staged fetch. `opts`:
 *   remote ('origin'), repo (the key the tips file is stored under, e.g. owner/name), stateDir (where TIPS_FILE
 *   lives; '' = local refs only), config (the brief config: fleet_memory_pubkeys from the operator's memory.yml),
 *   exec (execFileSync, for tests), log (one line per warning).
 * → { ok, fetched, results: [{ ref, status: 'accepted'|'unchanged'|'rejected', reason?, fleet?, tofu?, sha? }] }.
 * `ok: false` only when the fetch itself failed (nothing changed). Never throws.
 */
export function consumeMemoryRefs(repoRoot, { remote = 'origin', repo = '', stateDir = '', config = {}, exec = execFileSync, log = () => {} } = {}) {
  const results = [];
  const pubkeys = resolveFleetPubkeys(config, { log });
  // No usable key: nothing could verify, so don't fetch at all (no network, no staged refs, no warnings).
  if (!pubkeys.size) return { ok: true, fetched: false, skipped: 'no_keys', results };
  try {
    stagedFetch(exec, repoRoot, remote);
  } catch (e) {
    return { ok: false, fetched: false, error: String(e?.stderr || e?.message || e).trim().split('\n').pop(), results };
  }
  const tipsFile = stateDir ? path.join(stateDir, TIPS_FILE) : '';
  const tips = (tipsFile && readJson(tipsFile)) || { version: 1, repos: {} };
  if (!tips.repos || typeof tips.repos !== 'object') tips.repos = {};
  const repoKey = repo || remote;
  const known = tips.repos[repoKey] && typeof tips.repos[repoKey] === 'object' ? tips.repos[repoKey] : {};
  if (!tips.quiet || typeof tips.quiet !== 'object') tips.quiet = {};
  const quiet = tips.quiet[repoKey] && typeof tips.quiet[repoKey] === 'object' ? tips.quiet[repoKey] : {};
  let staged = [];
  try { staged = listRefs(exec, repoRoot, INCOMING_PREFIX); } catch (e) {
    return { ok: false, fetched: true, error: `can't list the staged refs: ${String(e?.message || e)}`, results };
  }
  let tipsChanged = false;
  for (const { ref: incoming, sha } of staged) {
    const ref = `${MEMORY_REF_PREFIX}${incoming.slice(INCOMING_PREFIX.length)}`;
    if (!isConsumedRef(ref)) continue;
    const reject = (reason) => {
      results.push({ ref, status: 'rejected', reason, sha });
      if (QUIET_REASONS.has(reason)) {
        if (quiet[ref] === reason) return; // already said once
        quiet[ref] = reason;
        tipsChanged = true;
        log(`memory-consume: ${ref} rejected (${reason}): add the fleet's key to fleet_memory_pubkeys to read it; said once until that changes`);
        return;
      }
      if (quiet[ref] !== undefined) { delete quiet[ref]; tipsChanged = true; }
      log(`memory-consume: ${ref} rejected (${reason}); kept the last verified tip`);
    };
    try {
      const local = localTip(exec, repoRoot, ref);
      if (local === sha) {
        results.push({ ref, status: 'unchanged', sha });
        if (known[ref] !== sha) { known[ref] = sha; tipsChanged = true; }
        continue;
      }
      const tip = readTip(exec, repoRoot, sha);
      if (tip.error) { reject(tip.error); continue; }
      const v = verifyMemoryRefTipSync(repoRoot, { ref, parent: tip.parent, content: tip.content, sigText: tip.sigText, pubkeys, exec });
      if (!v.ok) { reject(v.reason); continue; }
      const last = local || (OID_RE.test(String(known[ref] || '')) ? known[ref] : null);
      let tofu = false;
      if (last) {
        if (!isAncestor(exec, repoRoot, last, sha)) { reject(`not_a_descendant_of_last_verified ${last.slice(0, 12)}${local ? '' : ' (from the tips file)'}`); continue; }
      } else {
        tofu = true;
        log(`memory-consume: ${ref} has no last verified tip (first fetch, or the git dir and tips file were reset); trusting ${sha.slice(0, 12)} on first use`);
      }
      // compare-and-swap: a concurrent consumer that moved the ref first makes this fail, never clobbers it
      git(exec, repoRoot, ['update-ref', '-m', 'engsys memory: verified staged tip', ref, sha, local || ZERO_OID]);
      known[ref] = sha;
      tipsChanged = true;
      if (quiet[ref] !== undefined) delete quiet[ref];
      results.push({ ref, status: 'accepted', fleet: v.fleet, sha, ...(tofu ? { tofu: true } : {}) });
    } catch (e) {
      reject(`git_error: ${String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 200)}`);
    }
  }
  if (tipsFile && tipsChanged) {
    tips.version = 1;
    tips.repos[repoKey] = known;
    tips.quiet[repoKey] = quiet;
    try { writeJsonAtomic(tipsFile, tips); } catch (e) { log(`memory-consume: can't write ${tipsFile} (${e.message}); the local refs still record the verified tips`); }
  }
  return { ok: true, fetched: true, results };
}

/** A stable fingerprint of the configured pubkeys: a key change invalidates every cached verdict. */
export function pubkeysFingerprint(config) {
  const raw = config?.fleet_memory_pubkeys && typeof config.fleet_memory_pubkeys === 'object' ? config.fleet_memory_pubkeys : {};
  const norm = Object.keys(raw).sort().map((f) => [f, [].concat(raw[f] ?? []).map(String).sort()]);
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 32);
}

/**
 * The brief's read path: the events of every local consumed ref whose tip verifies, stamped
 * `author_kind: 'fleet_signed'` / `signed_fleet`, merged by `k` with `ownFleet`'s copy winning a collision
 * (then the newer `updated_at`). Verdicts are cached in `<cacheDir>/VERIFY_CACHE_FILE` per (ref, tip,
 * reviewed SHA, pubkeys); a cache hit re-reads only the blob. `resolveSha` is the reviewed-SHA resolver
 * (index-db passes its own, to keep the import graph acyclic at call time). Never throws.
 */
export function loadVerifiedRefEvents(repoRoot, { config = {}, cacheDir = '', ownFleet = process.env.FLEET_ID || '', resolveSha, exec = execFileSync, refs = null } = {}) {
  let local;
  try { local = Array.isArray(refs) ? refs : listRefs(exec, repoRoot, MEMORY_REF_PREFIX); } catch { return []; }
  local = local.filter((r) => isConsumedRef(r.ref));
  if (!local.length) return [];
  const pubkeys = resolveFleetPubkeys(config);
  if (!pubkeys.size) return [];
  let reviewedSha = null;
  try { reviewedSha = resolveSha ? resolveSha(repoRoot) : null; } catch { reviewedSha = null; }
  const fp = pubkeysFingerprint(config);
  const cacheFile = cacheDir ? path.join(cacheDir, VERIFY_CACHE_FILE) : '';
  const cache = (cacheFile && readJson(cacheFile)) || {};
  const nextCache = {};
  let cacheDirty = false;
  const streams = [];
  for (const { ref, sha } of local) {
    const key = `${ref}@${sha}|${reviewedSha || '-'}|${fp}`;
    let verdict = cache[key];
    let content = null;
    try {
      if (!verdict || typeof verdict.ok !== 'boolean') {
        const tip = readTip(exec, repoRoot, sha);
        if (tip.error) verdict = { ok: false, reason: tip.error };
        else {
          content = tip.content;
          const v = verifyMemoryRefTipSync(repoRoot, { ref, parent: tip.parent, content, sigText: tip.sigText, pubkeys, exec, ...(resolveSha ? { resolveSha: () => reviewedSha } : {}) });
          verdict = v.ok ? { ok: true, fleet: v.fleet, keys: v.events.map((e) => e.k).filter((k) => typeof k === 'string') } : { ok: false, reason: v.reason };
        }
        cacheDirty = true;
      }
      nextCache[key] = verdict;
      if (!verdict.ok) continue;
      if (content === null) content = git(exec, repoRoot, ['show', `${sha}:events.jsonl`]);
      const keep = new Set(verdict.keys);
      const events = [];
      for (const raw of parseEventsJsonl(content).events) {
        if (!raw || typeof raw !== 'object' || !keep.has(raw.k)) continue;
        const { author_kind: _ak, author_id: _aid, editor_kind: _ek, editor_id: _eid, signed_fleet: _sf, ...rest } = raw;
        events.push({ ...rest, author_kind: 'fleet_signed', author_id: null, signed_fleet: verdict.fleet });
      }
      streams.push({ fleet: verdict.fleet, events });
    } catch {
      /* one unreadable ref never costs the others */
    }
  }
  if (cacheFile && (cacheDirty || Object.keys(cache).length !== Object.keys(nextCache).length)) {
    try { writeJsonAtomic(cacheFile, nextCache); } catch { /* the cache is an optimisation only */ }
  }
  return mergeFleetStreams(streams, ownFleet);
}

const updatedMs = (e) => { const t = Date.parse(e?.updated_at ?? ''); return Number.isFinite(t) ? t : 0; };

/** Merge `[{ fleet, events }]` by `k`: own fleet's copy wins a collision, then the newer `updated_at`. */
export function mergeFleetStreams(streams, ownFleet = '') {
  const byKey = new Map();
  for (const { fleet, events } of streams) {
    for (const e of events) {
      if (!e || typeof e.k !== 'string') continue;
      const prev = byKey.get(e.k);
      const own = Boolean(ownFleet) && fleet === ownFleet;
      const prevOwn = Boolean(ownFleet) && prev?.signed_fleet === ownFleet;
      if (!prev || (own && !prevOwn) || (own === prevOwn && updatedMs(e) >= updatedMs(prev))) byKey.set(e.k, e);
    }
  }
  return [...byKey.values()];
}
