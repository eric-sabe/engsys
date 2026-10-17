#!/usr/bin/env node
// weather-check.mjs — SessionStart and UserPromptSubmit hook for Fleet Health Desk (engsys#98).
//
// Reads the locally cached status board (no network calls, zero latency, fail-open):
//   - On `session-start`:
//     * Unconfigured / no cache file -> silent (exit 0)
//     * All services `up` -> silent (exit 0)
//     * Board older than stale threshold (default 30m), or stamped in the future ->
//       "Fleet Health Desk: weather unknown (board stale since <ts>)"
//     * Any non-suppressed service `degraded` or `down` -> 1-2 concise lines.
//   - On `prompt` (UserPromptSubmit):
//     * Compares current board fingerprint against `<FLEET_STATE>/fhd/fhd-seen-<session>.json`
//       (scoped by $ENGSYS_SESSION).
//     * Silent unless a non-suppressed service state changed since last seen by this session,
//       in which case it emits a single-line update and records the new seen state.
//
// Trust boundary (engsys v2.0.1): the cache is read only from the launcher-set FLEET_STATE, never the
// working tree, and the injected text is built only from a service id matching ^[a-z0-9-]{1,40}$, the
// state enum, and the hold_merges / pause_claims booleans. No `advice`, `name` or other free text from
// the board ever reaches session context.
//
// Zero external dependencies; imports only from within core/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarness, recordHookTelemetry } from '../lib/harness-io.mjs';
import { formatFromEnv, isConfigured as isOperatorTimeConfigured } from '../lib/operator-time.mjs';
import {
  isBoardStale,
  boardFingerprint,
  diffBoards,
  weatherCacheFile,
  DEFAULT_STALE_MINUTES,
  SAFE_SERVICE_ID_RE,
  BOARD_STATES,
} from '../fleet/health/board.mjs';

/**
 * Path to the weather cache: `<FLEET_STATE>/fhd/board-cache.json`, or `null` outside a fleet session
 * (FLEET_STATE unset or not absolute). Nothing else is consulted.
 */
export function resolveWeatherCachePath(env = process.env) {
  return weatherCacheFile(env);
}

function sessionSlug(env = process.env) {
  const raw = (env.ENGSYS_SESSION || 'default').trim();
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'default';
}

function seenFilePath(cacheFile, env = process.env) {
  // Beside the cache, which is always inside FLEET_STATE.
  return path.join(path.dirname(cacheFile), `fhd-seen-${sessionSlug(env)}.json`);
}

/**
 * Load board data from a cache file (supports both `{ board: {...} }` envelope and direct board JSON).
 */
export function loadCachedBoard(cacheFile) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const board = raw.board && typeof raw.board === 'object' ? raw.board : raw;
    if (!board || !board.services || typeof board.services !== 'object') return null;
    return board;
  } catch {
    return null;
  }
}

/** The board's services reduced to the fields that may be injected; invalid entries are dropped. */
function safeServices(board) {
  const out = [];
  for (const [id, s] of Object.entries(board?.services || {})) {
    if (!SAFE_SERVICE_ID_RE.test(id) || !s || typeof s !== 'object') continue;
    if (!BOARD_STATES.includes(s.state)) continue;
    out.push({
      id,
      state: s.state,
      suppressed: Boolean(s.suppressed_by),
      hold_merges: s.hold_merges === true,
      pause_claims: s.pause_claims === true,
    });
  }
  return out;
}

function staleLimit(env, board, staleMinutes) {
  const ok = (v) => Number.isSafeInteger(v) && v > 0 && v <= 10080;
  if (ok(staleMinutes)) return staleMinutes;
  const fromEnv = env.ENGSYS_FHD_STALE_MINUTES ? Number(env.ENGSYS_FHD_STALE_MINUTES) : NaN;
  if (ok(fromEnv)) return fromEnv;
  if (ok(board?.stale_minutes)) return board.stale_minutes;
  return DEFAULT_STALE_MINUTES;
}

/** A timestamp rebuilt from the parsed date (never the board's own string). */
function formatTimestamp(iso, env = process.env, now = new Date()) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return 'unknown';
  const canonical = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (!isOperatorTimeConfigured(env)) return canonical;
  try {
    return formatFromEnv(canonical, env, { now });
  } catch {
    return canonical;
  }
}

/**
 * Pure formatter for `session-start` weather output. Returns `""` when healthy.
 */
export function formatWeatherSessionStart(
  board,
  { env = process.env, now = new Date(), staleMinutes } = {},
) {
  if (!board || !board.services || typeof board.services !== 'object') return '';
  const limitMin = staleLimit(env, board, staleMinutes);

  const ts = formatTimestamp(board.last_updated, env, now);
  if (isBoardStale(board, { now, staleMinutes: limitMin })) {
    return `Fleet Health Desk: weather unknown (board stale since ${ts})`;
  }

  const impacted = safeServices(board).filter(
    (s) => (s.state === 'degraded' || s.state === 'down') && !s.suppressed,
  );
  if (impacted.length === 0) return '';

  const summaries = impacted.map((s) => `${s.id} is ${s.state.toUpperCase()}`);
  const line1 = `Fleet Health Desk (as of ${ts}): ${summaries.join('; ')}`;
  const gates = [];
  if (impacted.some((s) => s.hold_merges)) gates.push('hold merges');
  if (impacted.some((s) => s.pause_claims)) gates.push('pause new issue claims');

  if (gates.length > 0) {
    return `${line1}\nWeather advisory: ${gates.join(', ')}.`;
  }
  return line1;
}

/**
 * Pure formatter for `prompt` (UserPromptSubmit) mid-session delta. Returns `""` when no non-suppressed state changed.
 */
export function formatWeatherPromptDelta(
  prevBoard,
  nextBoard,
  { env = process.env, now = new Date() } = {},
) {
  if (!nextBoard || !nextBoard.services || typeof nextBoard.services !== 'object') return '';
  const changes = diffBoards(prevBoard, nextBoard).filter(
    (c) => !c.suppressed_by
      && SAFE_SERVICE_ID_RE.test(String(c.service))
      && BOARD_STATES.includes(c.from)
      && BOARD_STATES.includes(c.to),
  );
  if (changes.length === 0) return '';

  const ts = formatTimestamp(nextBoard.last_updated, env, now);
  const parts = changes.map((c) => {
    // Gates from the board's own values, true only when they are literally boolean true.
    const svc = nextBoard.services[c.service] || {};
    const gates = [];
    if (svc.hold_merges === true) gates.push('hold merges');
    if (svc.pause_claims === true) gates.push('pause new issue claims');
    return `${c.service} ${c.from} -> ${c.to}${gates.length ? ` (${gates.join(', ')})` : ''}`;
  });
  return `Fleet Health Desk update (as of ${ts}): ${parts.join('; ')}`;
}

function writeSeenState(seenFile, board, now = new Date()) {
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    const payload = {
      updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
      fingerprint: boardFingerprint(board),
      board,
    };
    const tmp = `${seenFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    fs.renameSync(tmp, seenFile);
  } catch {
    // fail-open if cache dir is read-only
  }
}

function readSeenState(seenFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.board) return null;
    return raw;
  } catch {
    return null;
  }
}

function wrapHookOutput(event, text, env = process.env) {
  if (!text) return '';
  const harness = detectHarness(env);
  if (harness === 'copilot') return JSON.stringify({ additionalContext: text });
  if (harness === 'antigravity') return text;
  const hookEventName = event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart';
  return JSON.stringify({
    additionalContext: text,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text,
    },
  });
}

/**
 * Execute the weather-check hook for `session-start` or `prompt`.
 * Returns the serialized hook output string (or `""` when silent).
 */
export function run(event = 'session-start', env = process.env, { now = new Date() } = {}) {
  const cacheFile = resolveWeatherCachePath(env);
  if (!cacheFile) return '';
  const board = loadCachedBoard(cacheFile);
  if (!board) return '';

  const seenFile = seenFilePath(cacheFile, env);
  const hookEventName = event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart';

  if (event === 'prompt') {
    const limitMin = staleLimit(env, board);
    if (isBoardStale(board, { now, staleMinutes: limitMin })) {
      return '';
    }
    const seen = readSeenState(seenFile);
    const currentFp = boardFingerprint(board);
    if (seen && seen.fingerprint === currentFp) {
      return '';
    }
    const prevBoard = seen?.board || null;
    writeSeenState(seenFile, board, now);
    const deltaText = formatWeatherPromptDelta(prevBoard, board, { env, now });
    if (deltaText) {
      recordHookTelemetry({
        hook: 'weather-check',
        event: hookEventName,
        decision: 'inject',
        bytes: Buffer.byteLength(deltaText, 'utf8'),
        detail: deltaText.slice(0, 120),
      }, env);
    }
    return wrapHookOutput('prompt', deltaText, env);
  }

  // session-start
  writeSeenState(seenFile, board, now);
  const startText = formatWeatherSessionStart(board, { env, now });
  recordHookTelemetry({
    hook: 'weather-check',
    event: hookEventName,
    decision: startText ? 'inject' : 'allow',
    bytes: Buffer.byteLength(startText, 'utf8'),
    detail: startText ? startText.split('\n')[0].slice(0, 120) : 'all-up',
  }, env);
  return wrapHookOutput('session-start', startText, env);
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const arg = process.argv[2];
  const event = arg === 'prompt' ? 'prompt' : 'session-start';
  try {
    const out = run(event, process.env);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // fail-open: never block a session or prompt
  }
}
