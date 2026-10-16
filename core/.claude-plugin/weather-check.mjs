#!/usr/bin/env node
// weather-check.mjs — SessionStart and UserPromptSubmit hook for Fleet Health Desk (engsys#98).
//
// Reads the locally cached status board (no network calls, zero latency, fail-open):
//   - On `session-start`:
//     * Unconfigured / no cache file -> silent (exit 0)
//     * All services `up` -> silent (exit 0)
//     * Board older than stale threshold (default 30m) ->
//       "Fleet Health Desk: weather unknown (board stale since <ts>)"
//     * Any non-suppressed service `degraded` or `down` ->
//       1-2 concise lines with operator-formatted timestamp and actionable advice.
//   - On `prompt` (UserPromptSubmit):
//     * Compares current board fingerprint against `<cacheDir>/fhd-seen-<session>.json`
//       (scoped by $ENGSYS_SESSION).
//     * Silent unless a non-suppressed service state changed since last seen by this session,
//       in which case it emits a single-line update and records the new seen state.
//
// Zero external dependencies; imports only from within core/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarness } from '../lib/harness-io.mjs';
import { formatFromEnv, isConfigured as isOperatorTimeConfigured } from '../lib/operator-time.mjs';
import {
  isBoardStale,
  boardFingerprint,
  diffBoards,
  DEFAULT_STALE_MINUTES,
} from '../fleet/health/board.mjs';

/**
 * Resolve the path to `board-cache.json` from environment variables or working directory.
 */
export function resolveWeatherCachePath(env = process.env, cwd = process.cwd()) {
  if (env.ENGSYS_FHD_BOARD_CACHE) return path.resolve(env.ENGSYS_FHD_BOARD_CACHE);
  if (env.ENGSYS_FHD_STATE_DIR) return path.resolve(env.ENGSYS_FHD_STATE_DIR, 'fhd', 'board-cache.json');
  if (env.FLEET_STATE) return path.resolve(env.FLEET_STATE, 'fhd', 'board-cache.json');
  if (env.FLEET_INSTANCE) return path.resolve(env.FLEET_INSTANCE, '.fleet', 'fhd', 'board-cache.json');
  return path.resolve(cwd, '.fleet', 'fhd', 'board-cache.json');
}

function sessionSlug(env = process.env) {
  const raw = (env.ENGSYS_SESSION || 'default').trim();
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
}

function seenFilePath(cacheFile, env = process.env) {
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
    if (!board || typeof board.services !== 'object') return null;
    return board;
  } catch {
    return null;
  }
}

function formatTimestamp(iso, env = process.env, now = new Date()) {
  if (!iso) return 'unknown';
  if (!isOperatorTimeConfigured(env)) return iso;
  try {
    return formatFromEnv(iso, env, { now });
  } catch {
    return iso;
  }
}

/**
 * Pure formatter for `session-start` weather output. Returns `""` when healthy.
 */
export function formatWeatherSessionStart(
  board,
  { env = process.env, now = new Date(), staleMinutes } = {},
) {
  if (!board || typeof board.services !== 'object') return '';
  const limitMin =
    staleMinutes ??
    (env.ENGSYS_FHD_STALE_MINUTES ? Number(env.ENGSYS_FHD_STALE_MINUTES) : undefined) ??
    board.stale_minutes ??
    DEFAULT_STALE_MINUTES;

  const ts = formatTimestamp(board.last_updated, env, now);
  if (isBoardStale(board, { now, staleMinutes: limitMin })) {
    return `Fleet Health Desk: weather unknown (board stale since ${ts})`;
  }

  const impacted = Object.values(board.services).filter(
    (s) => (s.state === 'degraded' || s.state === 'down') && !s.suppressed_by,
  );
  if (impacted.length === 0) return '';

  const summaries = impacted.map((s) => {
    const label = s.id || s.name;
    const state = String(s.state).toUpperCase();
    const advice = s.advice ? ` — ${s.advice}` : '';
    return `${label} is ${state}${advice}`;
  });

  const line1 = `Fleet Health Desk (as of ${ts}): ${summaries.join('; ')}`;
  const holdMerges = impacted.some((s) => s.hold_merges);
  const pauseClaims = impacted.some((s) => s.pause_claims);
  const gates = [];
  if (holdMerges) gates.push('hold merges');
  if (pauseClaims) gates.push('pause new issue claims');

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
  if (!nextBoard || typeof nextBoard.services !== 'object') return '';
  const changes = diffBoards(prevBoard, nextBoard).filter((c) => !c.suppressed_by);
  if (changes.length === 0) return '';

  const ts = formatTimestamp(nextBoard.last_updated, env, now);
  const parts = changes.map((c) => {
    const advice = c.advice ? ` (${c.advice})` : '';
    return `${c.service} ${c.from} -> ${c.to}${advice}`;
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
export function run(event = 'session-start', env = process.env, { cwd = process.cwd(), now = new Date() } = {}) {
  const cacheFile = resolveWeatherCachePath(env, cwd);
  const board = loadCachedBoard(cacheFile);
  if (!board) return '';

  const seenFile = seenFilePath(cacheFile, env);

  if (event === 'prompt') {
    const limitMin =
      (env.ENGSYS_FHD_STALE_MINUTES ? Number(env.ENGSYS_FHD_STALE_MINUTES) : undefined) ??
      board.stale_minutes ??
      DEFAULT_STALE_MINUTES;
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
    return wrapHookOutput('prompt', deltaText, env);
  }

  // session-start
  writeSeenState(seenFile, board, now);
  const startText = formatWeatherSessionStart(board, { env, now });
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
