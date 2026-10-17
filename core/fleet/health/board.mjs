// board.mjs — Fleet Health Desk status board renderer, parser, ETag cache,
// fenced GitHub issue publisher, and Slack/fallback transition notifier.
//
// Zero external dependencies; imports only from within core/.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatFromEnv } from '../../lib/operator-time.mjs';
import { parseIncluded } from '../../lib/gate-check.mjs';
import { defang } from '../../lib/untrusted.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BOARD_START = '<!-- fleet-health -->';
export const BOARD_END = '<!-- /fleet-health -->';
export const BOARD_JSON_PREFIX = '<!-- fleet-health-json: ';
export const BOARD_JSON_SUFFIX = ' -->';
export const DEFAULT_STALE_MINUTES = 30;
/** How far ahead of this host's clock a board timestamp may be before it counts as invalid. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** Service ids and state words that may leave the board for a session or a watch bus. */
export const SAFE_SERVICE_ID_RE = /^[a-z0-9-]{1,40}$/;
export const BOARD_STATES = Object.freeze(['healthy', 'up', 'degraded', 'down', 'unknown']);

const STATE_ICON = Object.freeze({
  healthy: '🟢 healthy',
  up: '🟢 healthy',
  degraded: '🟡 degraded',
  down: '🔴 down',
  unknown: '⚪ unknown',
});

export function isHealthyState(state) {
  return state === 'healthy' || state === 'up';
}

function safeText(raw, maxLen = 240) {
  return defang(String(raw ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<!--/g, '<! --')
    .replace(/--!?>/g, '-- >')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Derive concise advice for a service given its registry entry and runtime state.
 */
export function deriveServiceAdvice(svcConfig, svcRuntime) {
  const state = svcRuntime?.state || 'unknown';
  if (isHealthyState(state)) return 'normal operation';

  const parts = [];
  if (svcRuntime?.advice) {
    parts.push(safeText(svcRuntime.advice));
  } else {
    const impact = svcConfig?.impact || {};
    if (state === 'down' || state === 'degraded') {
      if (impact.hold_merges && !/\bhold\s+merges\b/i.test(impact.advice || '')) {
        parts.push('hold merges');
      }
      if (state === 'down' && impact.down) parts.push(safeText(impact.down));
      else if (state === 'degraded' && impact.degraded) parts.push(safeText(impact.degraded));
      else if (impact.advice) parts.push(safeText(impact.advice));
    }
    const runbookText =
      typeof svcConfig?.runbook === 'string'
        ? svcConfig.runbook
        : svcConfig?.runbook?.advice || '';
    if (runbookText.trim() && !parts.includes(safeText(runbookText.trim()))) {
      parts.push(safeText(runbookText.trim()));
    } else if (!parts.length && (svcRuntime?.detail || svcRuntime?.summary)) {
      parts.push(safeText(svcRuntime.detail || svcRuntime.summary));
    }
  }

  if (svcRuntime?.suppressed_by) {
    parts.push(`suppressed by upstream ${svcRuntime.suppressed_by}`);
  }
  if (svcRuntime?.auth_local_failure) {
    parts.push('host-local auth/context issue (vendor status unaffected)');
  }
  return parts.join('; ') || (state === 'unknown' ? 'probe status unknown' : state);
}

/**
 * Construct canonical JSON board data from registry, engine state, and incidents state.
 */
export function buildBoardData(
  registry,
  engineState = {},
  incidentsState = {},
  { now = new Date(), staleMinutes } = {},
) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const servicesMap = registry?.services || registry?.servicesMap || {};
  const runtimeServices = engineState?.services || {};
  const resolvedStaleMin =
    staleMinutes ?? registry?.board?.stale_minutes ?? DEFAULT_STALE_MINUTES;

  const services = {};
  for (const [id, svcConfig] of Object.entries(servicesMap)) {
    const rt = runtimeServices[id] || {};
    const state = rt.state || 'healthy';
    const impact = svcConfig.impact || {};
    const active = (state === 'degraded' || state === 'down') && !rt.suppressed_by;
    const summaryText = rt.detail || rt.summary || '';
    services[id] = {
      id,
      name: safeText(svcConfig.name || id, 80),
      state,
      since: rt.since || rt.last_transition_at || null,
      last_checked: rt.last_polled_at || rt.last_checked || null,
      last_known_state: rt.last_known_state || null,
      suppressed_by: rt.suppressed_by || null,
      root_cause: rt.root_cause ? safeText(rt.root_cause, 200) : null,
      simulated: Boolean(rt.simulated),
      auth_local_failure: Boolean(rt.auth_local_failure),
      hold_merges: Boolean(active && (rt.hold_merges || impact.hold_merges)),
      pause_claims: Boolean(active && impact.pause_claims),
      dispatch_warn: Boolean(active && (impact.dispatch_warn || impact.dispatch)),
      advice: deriveServiceAdvice(svcConfig, rt),
      summary: summaryText ? safeText(summaryText, 200) : '',
    };
  }

  const activeIncidents = [];
  const activeMap = incidentsState?.active || incidentsState?.incidents || {};
  for (const inc of Object.values(activeMap)) {
    if (inc && (inc.state === 'confirmed' || inc.state === 'mitigated' || inc.status === 'open')) {
      activeIncidents.push({
        id: safeText(inc.id, 80),
        service: safeText(inc.service, 80),
        classification: inc.classification || 'vendor-wide',
        opened_at: inc.opened_at,
        report_count:
          inc.report_count ??
          (Array.isArray(inc.contributing_reports) ? inc.contributing_reports.length : 1),
        summary: safeText(inc.mitigation || inc.summary || '', 160),
      });
    }
  }

  return {
    version: 1,
    last_updated: engineState?.updated_at || nowIso,
    stale_minutes: resolvedStaleMin,
    board_issue: registry?.board?.issue || registry?.board_issue || null,
    services,
    active_incidents: activeIncidents,
  };
}

/**
 * Render the `<!-- fleet-health --> ... <!-- /fleet-health -->` block for a GitHub issue body.
 */
export function renderBoardBlock(
  registry,
  engineState = {},
  incidentsState = {},
  { env = process.env, now = new Date(), staleMinutes } = {},
) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const boardData = buildBoardData(registry, engineState, incidentsState, {
    now: nowDate,
    staleMinutes,
  });
  const updatedIso = boardData.last_updated;
  let humanTime = updatedIso;
  try {
    humanTime = formatFromEnv(updatedIso, env, { now: nowDate });
  } catch {
    humanTime = updatedIso;
  }

  const timeDisplay = humanTime !== updatedIso ? `${updatedIso} (${humanTime})` : updatedIso;
  const escapedJson = JSON.stringify(boardData)
    .replace(/<!--/g, '\\u003c!--')
    .replace(/--!?>/g, '--\\u003e');
  const jsonComment = `${BOARD_JSON_PREFIX}${escapedJson}${BOARD_JSON_SUFFIX}`;

  const lines = [
    BOARD_START,
    jsonComment,
    '### Fleet Health Desk — Weather Board',
    '',
    `Last updated: \`${updatedIso}\`${humanTime !== updatedIso ? ` (${humanTime})` : ''}`,
    '',
    '| Service | State | Since | Impact / Advice |',
    '| :--- | :--- | :--- | :--- |',
  ];

  const entries = Object.values(boardData.services);
  if (entries.length === 0) {
    lines.push('| _(none)_ | ⚪ unknown | — | No services configured |');
  } else {
    for (const svc of entries) {
      const icon = STATE_ICON[svc.state] || STATE_ICON.unknown;
      const supTag = svc.suppressed_by ? ` _(via ${svc.suppressed_by})_` : '';
      const simTag = svc.simulated ? ' `[simulated]`' : '';
      let sinceDisplay = '—';
      if (svc.since) {
        try {
          const sinceHuman = formatFromEnv(svc.since, env, { now: nowDate });
          sinceDisplay = sinceHuman !== svc.since ? `${svc.since} (${sinceHuman})` : svc.since;
        } catch {
          sinceDisplay = svc.since;
        }
      }
      const safeAdvice = String(svc.advice || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(`| \`${svc.id}\` (${svc.name}) | ${icon}${supTag}${simTag} | ${sinceDisplay} | ${safeAdvice} |`);
    }
  }

  if (boardData.active_incidents.length > 0) {
    lines.push('');
    lines.push('#### Active Correlated Incidents');
    for (const inc of boardData.active_incidents) {
      lines.push(
        `- **${inc.id}** (\`${inc.service}\`, ${inc.classification}, reports: ${inc.report_count}, opened: \`${inc.opened_at}\`): ${inc.summary}`,
      );
    }
  }

  lines.push('');
  lines.push(`_Updated at ${timeDisplay} by Fleet Health Desk._`);
  lines.push(BOARD_END);
  return lines.join('\n');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Parse a `<!-- fleet-health --> ... <!-- /fleet-health -->` block from an issue body.
 */
export function parseBoardBlock(issueBody) {
  if (typeof issueBody !== 'string' || !issueBody) return null;
  const startCount = countOccurrences(issueBody, BOARD_START);
  const endCount = countOccurrences(issueBody, BOARD_END);
  if (startCount === 0 && endCount === 0) return null;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Invalid fleet-health board markers: found ${startCount} start and ${endCount} end markers`);
  }
  const startIdx = issueBody.indexOf(BOARD_START);
  const endIdx = issueBody.indexOf(BOARD_END);
  if (endIdx < startIdx) {
    throw new Error('Invalid fleet-health board markers: end marker precedes start marker');
  }

  const block = issueBody.slice(startIdx, endIdx + BOARD_END.length);
  const jsonStart = block.indexOf(BOARD_JSON_PREFIX);
  if (jsonStart === -1) {
    throw new Error('fleet-health block is missing <!-- fleet-health-json: ... --> metadata');
  }
  const jsonEnd = block.indexOf(BOARD_JSON_SUFFIX, jsonStart + BOARD_JSON_PREFIX.length);
  if (jsonEnd === -1) {
    throw new Error('fleet-health-json comment is unclosed');
  }
  const rawJson = block.slice(jsonStart + BOARD_JSON_PREFIX.length, jsonEnd).trim();
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Failed to parse fleet-health-json: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.services !== 'object') {
    throw new Error('Parsed fleet-health-json is missing services object');
  }
  return parsed;
}

/**
 * Splice `renderedBlock` into `existingBody` between `<!-- fleet-health -->` and `<!-- /fleet-health -->`,
 * or append it if no markers exist yet. Refuses to clobber if markers are duplicated or malformed.
 */
export function updateIssueBodyWithBoard(existingBody, renderedBlock) {
  const body = typeof existingBody === 'string' ? existingBody : '';
  const startCount = countOccurrences(body, BOARD_START);
  const endCount = countOccurrences(body, BOARD_END);

  if (startCount === 0 && endCount === 0) {
    if (!body.trim()) return `${renderedBlock}\n`;
    return `${body.trimEnd()}\n\n${renderedBlock}\n`;
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Refusing to update issue body: found ${startCount} start and ${endCount} end fleet-health markers`);
  }
  const startIdx = body.indexOf(BOARD_START);
  const endIdx = body.indexOf(BOARD_END);
  if (endIdx < startIdx) {
    throw new Error('Refusing to update issue body: end marker appears before start marker');
  }
  const before = body.slice(0, startIdx);
  const after = body.slice(endIdx + BOARD_END.length);
  return `${before}${renderedBlock}${after}`;
}

/**
 * True when boardData is missing `last_updated`, is older than `staleMinutes`, or claims a time more
 * than MAX_CLOCK_SKEW_MS in the future (a future stamp would otherwise never go stale).
 */
export function isBoardStale(boardData, { now = new Date(), staleMinutes } = {}) {
  if (!boardData || typeof boardData !== 'object' || !boardData.last_updated) return true;
  const updatedMs = Date.parse(boardData.last_updated);
  if (!Number.isFinite(updatedMs)) return true;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (updatedMs - nowMs > MAX_CLOCK_SKEW_MS) return true;
  const limitMin = staleMinutes ?? boardData.stale_minutes ?? DEFAULT_STALE_MINUTES;
  return (nowMs - updatedMs) > limitMin * 60_000;
}

/**
 * Deterministic fingerprint of service health states (ignoring timestamps so routine ticks don't fire change events).
 */
export function boardFingerprint(boardData) {
  if (!boardData || typeof boardData.services !== 'object') return '';
  const items = Object.keys(boardData.services)
    .sort()
    .map((id) => {
      const s = boardData.services[id];
      const normState = isHealthyState(s.state) ? 'healthy' : s.state;
      return `${id}:${normState}:${s.suppressed_by || ''}:${s.hold_merges ? 1 : 0}:${s.pause_claims ? 1 : 0}`;
    });
  const incs = Array.isArray(boardData.active_incidents)
    ? boardData.active_incidents
        .map((inc) => `${inc.id}:${inc.service}:${inc.classification}:${inc.report_count}`)
        .sort()
    : [];
  return incs.length ? `${items.join('|')}#${incs.join(',')}` : items.join('|');
}

/**
 * Compute per-service state changes between `prevBoard` and `nextBoard`.
 */
export function diffBoards(prevBoard, nextBoard) {
  const prevServices = prevBoard?.services || {};
  const nextServices = nextBoard?.services || {};
  const changes = [];

  for (const [id, nextSvc] of Object.entries(nextServices)) {
    const prevSvc = prevServices[id];
    const prevState = prevSvc?.state || 'healthy';
    const nextState = nextSvc?.state || 'unknown';
    const prevNorm = isHealthyState(prevState) ? 'healthy' : prevState;
    const nextNorm = isHealthyState(nextState) ? 'healthy' : nextState;
    const prevSup = prevSvc?.suppressed_by || null;
    const nextSup = nextSvc?.suppressed_by || null;

    if (!prevSvc) {
      if (!isHealthyState(nextState)) {
        changes.push({
          service: id,
          name: nextSvc.name || id,
          from: prevState,
          to: nextState,
          suppressed_by: nextSup,
          hold_merges: Boolean(nextSvc.hold_merges),
          pause_claims: Boolean(nextSvc.pause_claims),
          advice: nextSvc.advice || '',
        });
      }
      continue;
    }

    if (prevNorm !== nextNorm || prevSup !== nextSup) {
      changes.push({
        service: id,
        name: nextSvc.name || id,
        from: prevState,
        to: nextState,
        suppressed_by: nextSup,
        hold_merges: Boolean(nextSvc.hold_merges),
        pause_claims: Boolean(nextSvc.pause_claims),
        advice: nextSvc.advice || '',
      });
    }
  }
  return changes;
}

export function resolveBoardCachePath(stateDirOrFile) {
  if (!stateDirOrFile) return null;
  if (stateDirOrFile.endsWith('.json')) return stateDirOrFile;
  return path.join(stateDirOrFile, 'fhd', 'board-cache.json');
}

export function writeBoardCache(stateDirOrFile, boardData, { etag = null, fetchedAt = new Date().toISOString() } = {}) {
  const file = resolveBoardCachePath(stateDirOrFile);
  if (!file) throw new Error('writeBoardCache requires stateDirOrFile');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    etag: etag || null,
    fetched_at: fetchedAt,
    fingerprint: boardFingerprint(boardData),
    board: boardData,
  };
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

export function readBoardCache(stateDirOrFile) {
  const file = resolveBoardCachePath(stateDirOrFile);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.board) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * `<id> <state>[ — hold merges][, pause claims]` for a diffBoards change, built only from the
 * validated id, the state enum and the two booleans; `''` when the id or state isn't valid.
 */
export function boardBusSuffix(change) {
  const id = change?.service;
  const state = change?.to;
  if (typeof id !== 'string' || !SAFE_SERVICE_ID_RE.test(id) || !BOARD_STATES.includes(state)) return '';
  const gates = [];
  if (change.hold_merges === true) gates.push('hold merges');
  if (change.pause_claims === true) gates.push('pause claims');
  return `${id} ${state}${gates.length ? ` — ${gates.join(', ')}` : ''}`;
}

/**
 * The fleet-wide weather cache the session hook reads: `<FLEET_STATE>/fhd/board-cache.json`.
 * `null` unless the launcher set an absolute FLEET_STATE.
 */
export function weatherCacheFile(env = process.env) {
  const st = env?.FLEET_STATE;
  if (typeof st !== 'string' || !st || !path.isAbsolute(st)) return null;
  return path.join(path.resolve(st), 'fhd', 'board-cache.json');
}

/**
 * Mirror a board this host built (tick/simulate) or verified (watch-board) into the fleet-wide
 * weather cache, so sessions see it whatever state dir the desk itself runs with. No-op without
 * FLEET_STATE, or when `skipFile` already is that file.
 */
export function publishWeatherCache(boardData, { env = process.env, skipFile = null, fetchedAt = new Date().toISOString() } = {}) {
  const file = weatherCacheFile(env);
  if (!file || !boardData) return null;
  if (skipFile && path.resolve(skipFile) === file) return null;
  try {
    return writeBoardCache(file, boardData, { fetchedAt });
  } catch {
    return null;
  }
}

const BOARD_ISSUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){' +
  'body lastEditedAt editor{__typename ... on User{databaseId} ... on Bot{databaseId}} ' +
  'author{__typename ... on User{databaseId} ... on Bot{databaseId}}}}}';

/**
 * Read the board issue's body together with the numeric ID of whoever last wrote it, in one GraphQL
 * query (so the body and the editor belong to the same revision). The last writer is `editor` when
 * the body was ever edited, else the author.
 */
export function fetchBoardIssueWithEditor({ repo, issueNum, ghExec = defaultGhExec }) {
  const [owner, name] = String(repo).split('/');
  const raw = ghExec([
    'api',
    'graphql',
    '-f',
    `query=${BOARD_ISSUE_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${Number(issueNum)}`,
  ]);
  const issue = JSON.parse(String(raw))?.data?.repository?.issue;
  if (!issue || typeof issue !== 'object') throw new Error(`issue ${repo}#${issueNum} not found`);
  const actor = issue.lastEditedAt ? issue.editor : issue.author;
  const id = Number.isSafeInteger(actor?.databaseId) ? actor.databaseId : null;
  return { body: typeof issue.body === 'string' ? issue.body : '', editorId: id };
}

function defaultGhExec(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    if (err.stdout && /^HTTP\/\S+\s+304\b/m.test(String(err.stdout))) {
      return String(err.stdout);
    }
    throw err;
  }
}

/**
 * Fetch the status board from GitHub Issue `#N` using conditional ETag caching (`If-None-Match`).
 */
export function fetchBoardCached({
  repo,
  issue,
  cacheFile,
  maxAgeMs = 60_000,
  now = new Date(),
  ghExec = defaultGhExec,
  trustedEditorIds = [],
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const resolvedCache = resolveBoardCachePath(cacheFile);
  const cached = resolvedCache ? readBoardCache(resolvedCache) : null;

  if (cached && cached.fetched_at && maxAgeMs > 0) {
    const ageMs = nowMs - Date.parse(cached.fetched_at);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs) {
      return {
        ok: true,
        source: 'cache',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
      };
    }
  }

  if (!repo || !issue) {
    if (cached?.board) {
      return {
        ok: true,
        source: 'cache-fallback',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
      };
    }
    return { ok: false, source: 'unconfigured', error: 'repo and issue are required to fetch board' };
  }

  const issueNum = String(issue).replace(/^#/, '');
  const args = ['api', '-i', `/repos/${repo}/issues/${issueNum}`];
  if (cached?.etag) {
    args.push('-H', `If-None-Match: ${cached.etag}`);
  }

  let rawResponse;
  try {
    rawResponse = ghExec(args);
  } catch (err) {
    if (cached?.board) {
      return {
        ok: true,
        source: 'cache-stale-on-error',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
        warning: err.message,
      };
    }
    return { ok: false, source: 'error', error: err.message };
  }

  const { status, json, headers } = parseIncluded(rawResponse);
  if (status === 304 && cached?.board) {
    const etag = headers?.etag || cached.etag || null;
    if (resolvedCache) {
      writeBoardCache(resolvedCache, cached.board, { etag, fetchedAt: nowDate.toISOString() });
    }
    return {
      ok: true,
      source: '304',
      etag,
      board: cached.board,
      prevBoard: cached.board,
      changes: [],
    };
  }

  if (status !== 200 || !json) {
    if (cached?.board) {
      return {
        ok: true,
        source: 'cache-stale-on-http-error',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
        warning: `HTTP ${status}`,
      };
    }
    return { ok: false, source: 'http-error', status, error: `HTTP ${status}` };
  }

  // A changed body is accepted only when its last writer is on the trusted numeric-ID allowlist. An
  // empty allowlist accepts nothing; a rejected body never reaches the cache (the last verified board,
  // if any, stays in place).
  const trusted = new Set((trustedEditorIds || []).map(Number).filter(Number.isSafeInteger));
  let verifiedBody;
  try {
    const rev = fetchBoardIssueWithEditor({ repo, issueNum, ghExec });
    if (rev.editorId === null || !trusted.has(rev.editorId)) {
      return {
        ok: false,
        source: 'untrusted-editor',
        error: trusted.size === 0
          ? 'no trusted board editors configured (board.trusted_editor_ids)'
          : `board issue ${repo}#${issueNum} was last written by an account outside board.trusted_editor_ids`,
      };
    }
    verifiedBody = rev.body;
  } catch (err) {
    if (cached?.board) {
      return {
        ok: true,
        source: 'cache-stale-on-error',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
        warning: err.message,
      };
    }
    return { ok: false, source: 'error', error: err.message };
  }

  let board;
  try {
    board = parseBoardBlock(verifiedBody);
  } catch (err) {
    if (cached?.board) {
      return {
        ok: true,
        source: 'cache-stale-on-parse-error',
        etag: cached.etag,
        board: cached.board,
        prevBoard: cached.board,
        changes: [],
        warning: err.message,
      };
    }
    return { ok: false, source: 'parse-error', error: err.message };
  }
  if (!board) {
    return { ok: false, source: 'no-board-block', error: `Issue ${repo}#${issueNum} has no fleet-health block` };
  }

  const etag = headers?.etag || null;
  const prevBoard = cached?.board || null;
  const changes = diffBoards(prevBoard, board);
  if (resolvedCache) {
    writeBoardCache(resolvedCache, board, { etag, fetchedAt: nowDate.toISOString() });
  }

  return {
    ok: true,
    source: '200',
    etag,
    board,
    prevBoard,
    changes,
  };
}

/**
 * Update the GitHub status board issue body, fenced by `mnt-act.sh guard` when `fence: true`.
 * Publishes only when `boardFingerprint` changes compared with the last published fingerprint,
 * or when the refresh interval (half of `stale_minutes`) has elapsed so the board does not go stale.
 */
export function applyBoardToGitHub({
  repo,
  issue,
  stateDir,
  renderedBlock,
  boardData = null,
  force = false,
  now = new Date(),
  mntActPath = path.resolve(__dirname, '../../skills/maintenance-monster/scripts/mnt-act.sh'),
  fence = true,
  execFn = execFileSync,
} = {}) {
  if (!repo || !issue) throw new Error('applyBoardToGitHub requires repo and issue');
  if (!stateDir) throw new Error('applyBoardToGitHub requires stateDir');

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const issueNum = String(issue).replace(/^#/, '');
  const issueRef = `${repo}#${issueNum}`;
  const fhdDir = path.join(stateDir, 'fhd');
  fs.mkdirSync(fhdDir, { recursive: true });
  const pubStateFile = path.join(fhdDir, `github-published-${issueNum}.json`);

  let parsedCandidate = boardData;
  if (!parsedCandidate) {
    try {
      parsedCandidate = parseBoardBlock(renderedBlock);
    } catch {
      parsedCandidate = null;
    }
  }
  const candidateFp = parsedCandidate ? boardFingerprint(parsedCandidate) : null;
  const staleMinutes = parsedCandidate?.stale_minutes ?? DEFAULT_STALE_MINUTES;
  const refreshIntervalMs = Math.max(60_000, Math.floor((staleMinutes * 60_000) / 2));

  if (!force && candidateFp) {
    try {
      const prevPub = JSON.parse(fs.readFileSync(pubStateFile, 'utf8'));
      const prevAtMs = prevPub?.published_at ? Date.parse(prevPub.published_at) : NaN;
      if (
        prevPub?.issue === issueRef &&
        prevPub?.fingerprint === candidateFp &&
        Number.isFinite(prevAtMs) &&
        nowMs - prevAtMs >= 0 &&
        nowMs - prevAtMs < refreshIntervalMs
      ) {
        return { updated: false, reason: 'unchanged-fingerprint' };
      }
    } catch {
      // No prior published state recorded; proceed to inspect GitHub issue
    }
  }

  const rawIssueJson = execFn('gh', ['api', `/repos/${repo}/issues/${issueNum}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const issueObj = JSON.parse(rawIssueJson);
  const existingBody = issueObj?.body || '';

  if (!force && candidateFp) {
    try {
      const existingBoard = parseBoardBlock(existingBody);
      const existingUpdatedMs = existingBoard?.last_updated ? Date.parse(existingBoard.last_updated) : NaN;
      if (
        existingBoard &&
        boardFingerprint(existingBoard) === candidateFp &&
        Number.isFinite(existingUpdatedMs) &&
        nowMs - existingUpdatedMs >= 0 &&
        nowMs - existingUpdatedMs < refreshIntervalMs
      ) {
        fs.writeFileSync(
          pubStateFile,
          JSON.stringify({ issue: issueRef, fingerprint: candidateFp, published_at: existingBoard.last_updated }, null, 2) + '\n',
          'utf8',
        );
        return { updated: false, reason: 'unchanged-fingerprint' };
      }
    } catch {
      // Proceed with updateIssueBodyWithBoard
    }
  }

  const updatedBody = updateIssueBodyWithBoard(existingBody, renderedBlock);

  if (updatedBody === existingBody) {
    if (candidateFp) {
      fs.writeFileSync(
        pubStateFile,
        JSON.stringify({ issue: issueRef, fingerprint: candidateFp, published_at: nowDate.toISOString() }, null, 2) + '\n',
        'utf8',
      );
    }
    return { updated: false, reason: 'unchanged' };
  }

  const bodyFile = path.join(fhdDir, `board-body-${issueNum}.md`);
  fs.writeFileSync(bodyFile, updatedBody, 'utf8');

  if (fence) {
    execFn(
      'bash',
      [
        mntActPath,
        'guard',
        '--repo',
        repo,
        '--state-dir',
        stateDir,
        '--',
        'gh',
        'issue',
        'edit',
        issueNum,
        '-R',
        repo,
        '--body-file',
        bodyFile,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } else {
    execFn('gh', ['issue', 'edit', issueNum, '-R', repo, '--body-file', bodyFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (candidateFp) {
    fs.writeFileSync(
      pubStateFile,
      JSON.stringify({ issue: issueRef, fingerprint: candidateFp, published_at: nowDate.toISOString() }, null, 2) + '\n',
      'utf8',
    );
  }

  return { updated: true, bodyFile };
}

/**
 * Notify Slack / fallback issue on confirmed, non-suppressed service transitions via `core/fleet/notify.mjs`.
 */
export function notifyTransitions(
  registry,
  transitions = [],
  {
    stateDir,
    repo = '',
    issue = null,
    boardUrl = '',
    notifyScript = path.resolve(__dirname, '../notify.mjs'),
    notifyExec = null,
    env = process.env,
  } = {},
) {
  const results = [];
  const servicesMap = registry?.services || registry?.servicesMap || {};
  const boardIssue = issue || registry?.board?.issue || registry?.board_issue || null;
  const boardRepo = repo || registry?.board?.repo || '';
  const resolvedUrl =
    boardUrl ||
    (boardRepo && boardIssue ? `https://github.com/${boardRepo}/issues/${String(boardIssue).replace(/^#/, '')}` : '');

  const runNotify =
    notifyExec ||
    ((args, callEnv) =>
      execFileSync(process.execPath, [notifyScript, ...args], {
        env: callEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  for (const t of transitions) {
    if (!t || !t.service) continue;
    if (t.suppressed_by) {
      results.push({ service: t.service, skipped: true, reason: `suppressed_by:${t.suppressed_by}` });
      continue;
    }
    if (t.to === 'unknown') {
      results.push({ service: t.service, skipped: true, reason: 'unknown_probe_state' });
      continue;
    }

    const svcConfig = servicesMap[t.service] || { id: t.service, name: t.service };
    const incidentKey = `fhd-${t.service}`;
    const callEnv = {
      ...env,
      ...(stateDir ? { FLEET_STATE: stateDir } : {}),
    };

    const fromEffective = t.from === 'unknown' ? (t.from_known || t.from) : t.from;
    if (isHealthyState(t.to) && (fromEffective === 'degraded' || fromEffective === 'down')) {
      const args = ['--level', 'info', '--incident', incidentKey, '--resolve'];
      try {
        runNotify(args, callEnv);
        results.push({ service: t.service, notified: true, resolve: true, incident: incidentKey, args });
      } catch (err) {
        results.push({ service: t.service, notified: false, error: err.message, args });
      }
      continue;
    }

    if (t.to === 'degraded' || t.to === 'down') {
      const holdMerges = Boolean(t.hold_merges || svcConfig?.impact?.hold_merges);
      const wantsAction = t.to === 'down' || holdMerges;
      const level = wantsAction ? (resolvedUrl ? 'action' : 'alert') : 'info';
      const advice = deriveServiceAdvice(svcConfig, {
        state: t.to,
        advice: t.advice,
        detail: t.detail || t.summary,
        suppressed_by: t.suppressed_by,
      });
      const msg = `FHD: ${svcConfig.name || t.service} (${t.service}) is ${t.to.toUpperCase()} — ${advice}`;
      const args = ['--level', level, '--incident', incidentKey];
      if (resolvedUrl) {
        args.push('--re', resolvedUrl);
      }
      args.push(msg);

      try {
        runNotify(args, callEnv);
        results.push({ service: t.service, notified: true, level, incident: incidentKey, args });
      } catch (err) {
        results.push({ service: t.service, notified: false, error: err.message, args });
      }
    }
  }

  return results;
}
