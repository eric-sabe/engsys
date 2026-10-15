// Git Data API CAS store for refs/engsys/memory/* (docs/memory-spec.md §3.2, #130).
//
// Shares the Git Data API primitive layer (`createGitDataClient`) with
// `core/lib/lease/github-backend.mjs`:
//   - Optimistic CAS: read current ref -> read `events.jsonl` blob -> merge
//     incoming records by `k` (last-writer-wins by `updated_at`) -> write new
//     blob + tree + commit -> PATCH ref expecting previous SHA; on 422
//     (`outcome === 'lost'`), re-fetch and re-merge.
//   - Compaction: when total lines exceed `maxEvents` (default 20,000) or
//     `forceCompact` is requested, keep only the latest version of each key `k`,
//     drop tombstones (`deleted: true`) older than `tombstoneTtlDays` (default
//     180 days), cap at `maxEvents` newest records, and write a single
//     parentless commit (`parents: []`) with `force: true` on the ref update so
//     old blobs become unreachable and GC'd.
//   - Secret scan: every outgoing event is scanned in-process before any blob
//     write; matching events are rejected and logged (never written to any ref).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createGitDataClient } from '../lease/github-backend.mjs';

export const EVENTS_REF = 'refs/engsys/memory/events';
export const MEMORY_REF_PREFIX = 'refs/engsys/memory/';
export const MEMORY_FETCH_REFSPEC = '+refs/engsys/memory/*:refs/engsys/memory/*';
export const DEFAULT_MAX_EVENTS = 20_000;
export const DEFAULT_TOMBSTONE_TTL_DAYS = 180;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Build the per-worker tail ref `refs/engsys/memory/<role>/<fleet-id>`.
 */
export function tailRef(role, fleetId) {
  if (typeof role !== 'string' || !SAFE_SEGMENT_RE.test(role)) {
    throw new Error(`tailRef: invalid role ${JSON.stringify(role)}`);
  }
  if (typeof fleetId !== 'string' || !SAFE_SEGMENT_RE.test(fleetId)) {
    throw new Error(`tailRef: invalid fleetId ${JSON.stringify(fleetId)}`);
  }
  return `${MEMORY_REF_PREFIX}${role}/${fleetId}`;
}

function validateMemoryRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(MEMORY_REF_PREFIX)) {
    throw new Error(`ref must live under ${MEMORY_REF_PREFIX} (got ${JSON.stringify(ref)})`);
  }
  const rest = ref.slice(MEMORY_REF_PREFIX.length);
  if (!rest || rest.includes('..') || rest.startsWith('/') || rest.endsWith('/')) {
    throw new Error(`invalid memory ref ${JSON.stringify(ref)}`);
  }
  return ref;
}

/**
 * Fetch `refs/engsys/memory/*` from remote into local refs.
 */
export function fetchMemoryRefs(
  repoRoot,
  { remote = 'origin', refspec = MEMORY_FETCH_REFSPEC, exec = execFileSync } = {},
) {
  try {
    exec('git', ['-C', repoRoot, 'fetch', '--no-tags', '--quiet', remote, refspec], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// In-process secret scanner (defense-in-depth before any Git Data API write)
// ---------------------------------------------------------------------------

const SECRET_RULES = [
  {
    id: 'github_token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    id: 'aws_access_key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  },
  {
    id: 'api_secret_key',
    re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'slack_token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: 'db_connection_url',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i,
  },
  {
    id: 'google_api_key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
];

function redactMatch(raw) {
  const s = String(raw || '');
  if (s.length <= 8) return '***REDACTED***';
  return `${s.slice(0, 4)}***REDACTED***`;
}

/**
 * Scan a string for high-confidence secret material.
 * @returns {{ matched: boolean, findings: Array<{ rule: string, redacted: string }> }}
 */
export function scanTextForSecrets(text) {
  const s = String(text ?? '');
  const findings = [];
  for (const rule of SECRET_RULES) {
    const m = rule.re.exec(s);
    if (m) {
      findings.push({
        rule: `secret:${rule.id}`,
        redacted: redactMatch(m[0]),
      });
    }
  }
  return { matched: findings.length > 0, findings };
}

/**
 * Scan all string fields of a memory event record for secret patterns.
 */
export function scanEventForSecrets(event) {
  if (!event || typeof event !== 'object') {
    return { matched: false, findings: [] };
  }
  const serialized = JSON.stringify(event);
  return scanTextForSecrets(serialized);
}

// ---------------------------------------------------------------------------
// Keyed merge & compaction
// ---------------------------------------------------------------------------

function parseUpdatedMs(ev) {
  if (!ev || typeof ev !== 'object') return 0;
  if (typeof ev.updated_at === 'number' && Number.isFinite(ev.updated_at)) {
    return ev.updated_at;
  }
  if (typeof ev.updated_at === 'string' && ev.updated_at) {
    const t = Date.parse(ev.updated_at);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function keyOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  return String(ev.k || ev.id || '');
}

function normalizeRecord(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const k = keyOf(ev);
  if (!k) return null;
  if (ev.k === k) return ev;
  return { ...ev, k };
}

function compareByTimeAndKey(a, b) {
  const ta = parseUpdatedMs(a);
  const tb = parseUpdatedMs(b);
  if (ta !== tb) return ta - tb;
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Merge `existing` and `incoming` event arrays by key `k` (last-writer-wins
 * by `updated_at`; on equal timestamp, `incoming` wins).
 */
export function mergeEvents(existing = [], incoming = []) {
  const byKey = new Map();
  for (const raw of existing) {
    const ev = normalizeRecord(raw);
    if (!ev) continue;
    const prev = byKey.get(ev.k);
    if (!prev || parseUpdatedMs(ev) >= parseUpdatedMs(prev)) {
      byKey.set(ev.k, ev);
    }
  }
  for (const raw of incoming) {
    const ev = normalizeRecord(raw);
    if (!ev) continue;
    const prev = byKey.get(ev.k);
    if (!prev || parseUpdatedMs(ev) >= parseUpdatedMs(prev)) {
      byKey.set(ev.k, ev);
    }
  }
  return [...byKey.values()].sort(compareByTimeAndKey);
}

/**
 * Compact events:
 *   1. Deduplicate by `k` (latest `updated_at` wins).
 *   2. Drop tombstones (`deleted: true`) older than `tombstoneTtlDays` days.
 *   3. Cap at `maxEvents` newest records by `updated_at`.
 */
export function compactEvents(
  events = [],
  {
    maxEvents = DEFAULT_MAX_EVENTS,
    tombstoneTtlDays = DEFAULT_TOMBSTONE_TTL_DAYS,
    now = Date.now(),
  } = {},
) {
  const merged = mergeEvents(events, []);
  const ttlMs = Math.max(0, tombstoneTtlDays) * 86_400_000;
  const kept = merged.filter((ev) => {
    if (ev.deleted === true) {
      const ts = parseUpdatedMs(ev);
      if (ts > 0 && now - ts > ttlMs) return false;
    }
    return true;
  });
  if (kept.length <= maxEvents) return kept;
  return kept.slice(kept.length - maxEvents);
}

export function parseEventsJsonl(content) {
  const raw = String(content ?? '');
  if (!raw.trim()) return { events: [], rawLineCount: 0 };
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const events = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const norm = normalizeRecord(obj);
      if (norm) events.push(norm);
    } catch {
      // Ignore corrupt line
    }
  }
  return { events, rawLineCount: lines.length };
}

export function formatEventsJsonl(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  return events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
}

function appendSecretQuarantine(cacheDir, entry) {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.appendFileSync(path.join(cacheDir, 'quarantine.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// Git Data API CAS Ref Store
// ---------------------------------------------------------------------------

export function createMemoryRefStore({
  repo,
  api,
  client,
  token,
  sleep,
  maxRetries = 3,
  backoffMs = 150,
  maxEvents = DEFAULT_MAX_EVENTS,
  tombstoneTtlDays = DEFAULT_TOMBSTONE_TTL_DAYS,
  maxCasRounds = 6,
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const gitData = createGitDataClient({
    repo,
    api: client || (api && typeof api.request === 'function' ? api : undefined),
    token,
    sleep,
    maxRetries,
    backoffMs,
    now,
    env,
  });

  async function readEvents({ ref = EVENTS_REF } = {}) {
    const fullRef = validateMemoryRef(ref);
    const refRes = await gitData.readRef(fullRef);
    if (refRes.status === 404) {
      return { ok: true, sha: null, events: [], rawLineCount: 0, parents: [] };
    }
    if (refRes.failure || !refRes.sha || (refRes.type && refRes.type !== 'commit')) {
      return {
        ok: false,
        error: refRes.failure || { code: 'malformed_ref', detail: `ref type: ${refRes.type}` },
      };
    }

    const commitRes = await gitData.readCommit(refRes.sha);
    if (commitRes.failure) {
      return { ok: false, error: commitRes.failure };
    }

    const treeRes = await gitData.readTree(commitRes.tree);
    if (treeRes.failure) {
      return { ok: false, error: treeRes.failure };
    }

    const entry = treeRes.tree.find((e) => e.path === 'events.jsonl');
    if (!entry || !entry.sha) {
      return {
        ok: true,
        sha: refRes.sha,
        events: [],
        rawLineCount: 0,
        parents: commitRes.parents || [],
      };
    }

    const blobRes = await gitData.readBlob(entry.sha);
    if (blobRes.failure) {
      return { ok: false, error: blobRes.failure };
    }

    const { events, rawLineCount } = parseEventsJsonl(blobRes.content);
    return {
      ok: true,
      sha: refRes.sha,
      events,
      rawLineCount,
      parents: commitRes.parents || [],
    };
  }

  async function writeEvents({
    ref = EVENTS_REF,
    events = [],
    message = 'memory-sync',
    forceCompact = false,
    cacheDir = null,
    log = () => {},
  } = {}) {
    const fullRef = validateMemoryRef(ref);
    if (!Array.isArray(events)) {
      throw new Error('writeEvents: events must be an array');
    }

    // Step 1: In-process secret scan before any network write.
    const cleanEvents = [];
    const rejected = [];
    for (const raw of events) {
      const ev = normalizeRecord(raw);
      if (!ev) continue;
      const scan = scanEventForSecrets(ev);
      if (scan.matched) {
        const finding = scan.findings[0];
        const rej = {
          ts: new Date(now()).toISOString(),
          k: ev.k,
          url: ev.url || '',
          author_id: ev.author_id ?? null,
          rule: finding.rule,
          span: finding.redacted,
        };
        rejected.push(rej);
        log(`secret scan rejected event ${ev.k} (${finding.rule})`);
        appendSecretQuarantine(cacheDir, rej);
        continue;
      }
      cleanEvents.push(ev);
    }

    if (cleanEvents.length === 0 && !forceCompact) {
      const tip = await readEvents({ ref: fullRef });
      if (!tip.ok) return { ok: false, error: tip.error, rejected };
      return {
        ok: true,
        noop: true,
        sha: tip.sha,
        count: tip.events.length,
        compacted: false,
        rounds: 0,
        rejected,
      };
    }

    // Step 2: Optimistic CAS loop
    for (let round = 0; round < maxCasRounds; round++) {
      const tip = await readEvents({ ref: fullRef });
      if (!tip.ok) {
        return { ok: false, error: tip.error, rejected };
      }

      const merged = mergeEvents(tip.events, cleanEvents);
      const shouldCompact =
        Boolean(forceCompact) ||
        tip.rawLineCount + cleanEvents.length > maxEvents ||
        merged.length > maxEvents;

      const finalEvents = shouldCompact
        ? compactEvents(merged, { maxEvents, tombstoneTtlDays, now: now() })
        : merged;

      const jsonl = formatEventsJsonl(finalEvents);
      const blobRes = await gitData.createBlob(jsonl);
      if (blobRes.failure) {
        return { ok: false, error: blobRes.failure, rejected };
      }

      const treeRes = await gitData.createTree([
        {
          path: 'events.jsonl',
          mode: '100644',
          type: 'blob',
          sha: blobRes.sha,
        },
      ]);
      if (treeRes.failure) {
        return { ok: false, error: treeRes.failure, rejected };
      }

      const parents = shouldCompact ? [] : tip.sha ? [tip.sha] : [];
      const commitRes = await gitData.createCommit(message, parents, treeRes.sha);
      if (commitRes.failure) {
        return { ok: false, error: commitRes.failure, rejected };
      }

      const casRes = await gitData.cas(fullRef, tip.sha, commitRes.sha, {
        force: shouldCompact,
      });
      if (casRes.outcome === 'won') {
        return {
          ok: true,
          noop: false,
          sha: commitRes.sha,
          count: finalEvents.length,
          compacted: shouldCompact,
          rounds: round + 1,
          rejected,
        };
      }
      if (casRes.outcome === 'lost') {
        // Concurrent writer moved the ref; re-fetch and re-merge on next round.
        continue;
      }
      return { ok: false, error: casRes.failure, rejected };
    }

    return {
      ok: false,
      error: {
        code: 'cas_exhausted',
        detail: `CAS lost ${maxCasRounds} consecutive rounds on ${fullRef}`,
      },
      rejected,
    };
  }

  return {
    repo,
    readEvents,
    writeEvents,
    gitData,
  };
}
