#!/usr/bin/env node
// adapters.mjs — Pluggable probe adapters for Fleet Health Desk (engsys#97, #99).
//
// Supported adapters:
//   - statuspage        Atlassian Statuspage v2 summary/status JSON (conditional ETag, strict value
//                       validation: malformed JSON / missing fields / HTTP errors -> 'unknown',
//                       never a false 'down').
//   - observed          Derive health from recent real execution records (CI conclusions, tool runs).
//   - http-health       HTTP GET/HEAD endpoint probe (2xx -> healthy, 429 -> degraded, 5xx -> down,
//                       401/403 -> session-local auth failure).
//   - synthetic-command Execute a configured command from fleet-health.yml (splits vendor outage from
//                       host-local missing auth/context via auth_check and output classification).
//   - fleet-report-only Passive adapter whose health comes purely from correlated session reports.
//
// Zero dependencies: node builtins only.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const VALID_STATUSES = new Set(['healthy', 'degraded', 'down', 'unknown']);

export const STATUSPAGE_INDICATORS = Object.freeze({
  none: 'healthy',
  minor: 'degraded',
  maintenance: 'degraded',
  major: 'down',
  critical: 'down',
});

export const STATUSPAGE_COMPONENT_MAP = Object.freeze({
  operational: 'healthy',
  degraded_performance: 'degraded',
  under_maintenance: 'degraded',
  partial_outage: 'down',
  major_outage: 'down',
});

const SEVERITY_RANK = Object.freeze({
  healthy: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
});

/** Patterns indicating host-local / session-local missing auth or CLI context rather than a vendor outage (#99). */
export const AUTH_FAILURE_PATTERNS = [
  /please run ['"]?az login['"]?/i,
  /\baz login\b/i,
  /\bAADSTS\d+/i,
  /\bno subscription found\b/i,
  /\bnot logged in\b/i,
  /\bunauthenticated\b/i,
  /\bnot authenticated\b/i,
  /\bauthentication required\b/i,
  /\bmissing credentials\b/i,
  /\bexpired token\b/i,
  /\brefresh token.*expired\b/i,
  /\bcoderabbit auth\b/i,
  /\bgh auth login\b/i,
  /\bENOENT\b/i,
  /\bcommand not found\b/i,
];

function nowIsoStr(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse Atlassian Statuspage v2 JSON payload against optional component filters.
 * Pure function exported for unit testing against recorded JSON fixtures.
 */
export function evaluateStatuspageJson(json, { components = [], checkedAt = nowIsoStr() } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      status: 'unknown',
      detail: 'statuspage payload is not a JSON object',
      rawStatus: 'invalid_json',
      checkedAt,
    };
  }

  const wanted = Array.isArray(components) ? components.filter(Boolean) : (components ? [components] : []);

  if (wanted.length > 0) {
    if (!Array.isArray(json.components)) {
      return {
        status: 'unknown',
        detail: 'statuspage payload missing components[] array',
        rawStatus: 'missing_components',
        checkedAt,
      };
    }
    const componentStates = {};
    const degradedList = [];
    let worst = 'healthy';

    for (const target of wanted) {
      const lower = String(target).toLowerCase();
      const found = json.components.find(
        (c) => c && typeof c === 'object' && (
          (typeof c.name === 'string' && c.name.toLowerCase() === lower)
          || (typeof c.id === 'string' && c.id.toLowerCase() === lower)
        ),
      );
      if (!found || typeof found.status !== 'string') {
        return {
          status: 'unknown',
          detail: `statuspage component ${JSON.stringify(target)} missing from payload`,
          rawStatus: 'missing_component',
          checkedAt,
        };
      }
      const mapped = STATUSPAGE_COMPONENT_MAP[found.status];
      if (!mapped) {
        return {
          status: 'unknown',
          detail: `statuspage component ${JSON.stringify(target)} has unrecognized status ${JSON.stringify(found.status)}`,
          rawStatus: found.status,
          checkedAt,
        };
      }
      const canonicalName = found.name || target;
      componentStates[canonicalName] = mapped;
      if (mapped !== 'healthy') {
        degradedList.push(`${canonicalName}: ${found.status}`);
      }
      if (SEVERITY_RANK[mapped] > SEVERITY_RANK[worst]) {
        worst = mapped;
      }
    }

    return {
      status: worst,
      detail: degradedList.length > 0 ? degradedList.join('; ') : `all ${wanted.length} component(s) operational`,
      rawStatus: worst,
      componentStates,
      checkedAt,
    };
  }

  // Top-level indicator check
  const indicator = json.status?.indicator;
  if (typeof indicator !== 'string' || !(indicator in STATUSPAGE_INDICATORS)) {
    return {
      status: 'unknown',
      detail: `statuspage missing or unrecognized status.indicator (${JSON.stringify(indicator)})`,
      rawStatus: String(indicator ?? 'missing'),
      checkedAt,
    };
  }

  const mapped = STATUSPAGE_INDICATORS[indicator];
  const desc = typeof json.status?.description === 'string' && json.status.description.trim()
    ? json.status.description.trim()
    : `indicator: ${indicator}`;

  return {
    status: mapped,
    detail: desc,
    rawStatus: indicator,
    checkedAt,
  };
}

/**
 * Probe an Atlassian Statuspage v2 endpoint with conditional ETag support.
 */
export async function probeStatuspage(probeCfg, { cached = null, fetchFn = globalThis.fetch, now = new Date() } = {}) {
  const checkedAt = nowIsoStr(now);
  const url = probeCfg?.url;
  if (typeof url !== 'string' || !url) {
    return { status: 'unknown', detail: 'statuspage probe missing url', rawStatus: 'config_error', checkedAt };
  }

  const headers = { Accept: 'application/json' };
  if (cached?.etag && typeof cached.etag === 'string') {
    headers['If-None-Match'] = cached.etag;
  }

  let res;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(probeCfg.timeout_ms || 10000),
    });
  } catch (e) {
    return {
      status: 'unknown',
      detail: `statuspage fetch failed: ${e?.message || String(e)}`,
      rawStatus: 'fetch_error',
      checkedAt,
    };
  }

  if (res.status === 304) {
    if (cached?.lastResult && VALID_STATUSES.has(cached.lastResult.status)) {
      return {
        ...cached.lastResult,
        etag: cached.etag,
        notModified: true,
        checkedAt,
      };
    }
    return {
      status: 'unknown',
      detail: 'statuspage returned 304 Not Modified without cached result',
      rawStatus: '304',
      checkedAt,
    };
  }

  if (!res.ok || res.status !== 200) {
    return {
      status: 'unknown',
      detail: `statuspage HTTP ${res.status}`,
      rawStatus: `http_${res.status}`,
      checkedAt,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return {
      status: 'unknown',
      detail: `statuspage invalid JSON: ${e?.message || String(e)}`,
      rawStatus: 'invalid_json',
      checkedAt,
    };
  }

  const components = probeCfg.components?.length
    ? probeCfg.components
    : (probeCfg.component ? [probeCfg.component] : []);
  const evaluated = evaluateStatuspageJson(body, { components, checkedAt });
  const etag = typeof res.headers?.get === 'function'
    ? res.headers.get('etag')
    : (res.headers?.etag ?? null);
  if (etag) evaluated.etag = etag;
  return evaluated;
}

/**
 * Evaluate observed execution records (CI runs, tool invocations) over a rolling window.
 */
export function evaluateObservedRecords(records, probeCfg = {}, { now = new Date() } = {}) {
  const checkedAt = nowIsoStr(now);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Array.isArray(records)) {
    return {
      status: 'unknown',
      detail: 'observed records are not an array',
      rawStatus: 'invalid_records',
      checkedAt,
    };
  }

  const windowMs = (probeCfg.window_minutes ?? 30) * 60_000;
  const recent = records.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    if (!r.timestamp && !r.at) return true;
    const t = Date.parse(r.timestamp || r.at);
    return Number.isFinite(t) ? (nowMs - t <= windowMs) : true;
  });

  if (recent.length === 0) {
    const emptyStatus = probeCfg.empty_status === 'unknown' ? 'unknown' : 'healthy';
    return {
      status: emptyStatus,
      detail: 'no recent observations in window',
      rawStatus: 'empty',
      checkedAt,
    };
  }

  const isFailure = (r) => {
    if (typeof r.ok === 'boolean') return !r.ok;
    const c = String(r.conclusion ?? r.status ?? '').toLowerCase();
    return ['failure', 'timed_out', 'error', 'down', 'degraded', 'action_required', 'startup_failure'].includes(c);
  };

  let totalFails = 0;
  let consecutiveFails = 0;
  // Records assumed chronological (oldest -> newest); count trailing consecutive failures
  for (let i = 0; i < recent.length; i++) {
    if (isFailure(recent[i])) totalFails++;
  }
  for (let i = recent.length - 1; i >= 0; i--) {
    if (isFailure(recent[i])) consecutiveFails++;
    else break;
  }

  const failRate = totalFails / recent.length;
  const minSamples = probeCfg.min_samples ?? 3;
  const downConsec = probeCfg.down_consecutive ?? 3;
  const degConsec = probeCfg.degraded_consecutive ?? 1;
  const downRate = probeCfg.fail_rate_down ?? 0.75;
  const degRate = probeCfg.fail_rate_degraded ?? 0.3;

  if (consecutiveFails >= downConsec || (recent.length >= minSamples && failRate >= downRate)) {
    return {
      status: 'down',
      detail: `${totalFails}/${recent.length} recent observations failed (${consecutiveFails} consecutive)`,
      rawStatus: 'down',
      checkedAt,
    };
  }
  if (consecutiveFails >= degConsec || (recent.length >= Math.min(2, minSamples) && failRate >= degRate)) {
    return {
      status: 'degraded',
      detail: `${totalFails}/${recent.length} recent observations failed (${consecutiveFails} consecutive)`,
      rawStatus: 'degraded',
      checkedAt,
    };
  }
  return {
    status: 'healthy',
    detail: `${recent.length - totalFails}/${recent.length} recent observations succeeded`,
    rawStatus: 'healthy',
    checkedAt,
  };
}

/**
 * Probe via the `observed` adapter: reads observations from options or `<stateDir>/fhd-observed.json`.
 */
export function probeObserved(probeCfg, { serviceId, stateDir, observations = null, now = new Date() } = {}) {
  const checkedAt = nowIsoStr(now);
  let records = observations;
  if (!records) {
    const candidateFiles = [];
    if (probeCfg?.source_file) {
      candidateFiles.push(stateDir ? path.resolve(stateDir, probeCfg.source_file) : probeCfg.source_file);
    }
    if (stateDir && serviceId) {
      candidateFiles.push(path.join(stateDir, `fhd-observed-${serviceId}.jsonl`));
      candidateFiles.push(path.join(stateDir, 'fhd-observed.json'));
    }
    for (const file of candidateFiles) {
      if (!fs.existsSync(file)) continue;
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (!text) { records = []; break; }
        if (file.endsWith('.jsonl')) {
          records = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } else {
          const parsed = JSON.parse(text);
          records = Array.isArray(parsed) ? parsed : (parsed?.[serviceId] ?? []);
        }
        break;
      } catch (e) {
        return {
          status: 'unknown',
          detail: `cannot parse observed source ${path.basename(file)}: ${e.message}`,
          rawStatus: 'parse_error',
          checkedAt,
        };
      }
    }
  }
  return evaluateObservedRecords(records ?? [], probeCfg, { now });
}

/**
 * Probe an HTTP health endpoint (`http-health`, #99 P2).
 */
export async function probeHttpHealth(probeCfg, { fetchFn = globalThis.fetch, now = new Date() } = {}) {
  const checkedAt = nowIsoStr(now);
  const url = probeCfg?.url;
  if (typeof url !== 'string' || !url) {
    return { status: 'unknown', detail: 'http-health probe missing url', rawStatus: 'config_error', checkedAt };
  }
  const method = (probeCfg.method || 'GET').toUpperCase();
  let res;
  try {
    res = await fetchFn(url, {
      method,
      signal: AbortSignal.timeout(probeCfg.timeout_ms || 10000),
    });
  } catch (e) {
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed?\s*out/i.test(String(e?.message));
    const timeoutStatus = VALID_STATUSES.has(probeCfg.timeout_status) ? probeCfg.timeout_status : 'unknown';
    return {
      status: timeoutStatus,
      detail: `http-health ${isTimeout ? 'timeout' : 'network error'}: ${e?.message || String(e)}`,
      rawStatus: isTimeout ? 'timeout' : 'network_error',
      checkedAt,
    };
  }

  const code = res.status;
  if (code >= 200 && code < 300) {
    return { status: 'healthy', detail: `HTTP ${code}`, rawStatus: String(code), checkedAt };
  }
  if ((code === 401 || code === 403) && probeCfg.auth_codes_local !== false) {
    return {
      status: 'healthy',
      authLocalFailure: true,
      detail: `HTTP ${code} (session-local auth or credentials rejected)`,
      rawStatus: String(code),
      checkedAt,
    };
  }
  const degradedCodes = Array.isArray(probeCfg.degraded_codes) ? probeCfg.degraded_codes : [429];
  const downCodes = Array.isArray(probeCfg.down_codes) ? probeCfg.down_codes : [500, 502, 503, 504];

  if (degradedCodes.includes(code)) {
    return { status: 'degraded', detail: `HTTP ${code}`, rawStatus: String(code), checkedAt };
  }
  if (downCodes.includes(code)) {
    return { status: 'down', detail: `HTTP ${code}`, rawStatus: String(code), checkedAt };
  }
  return { status: 'unknown', detail: `unexpected HTTP ${code}`, rawStatus: String(code), checkedAt };
}

/**
 * Split a command string or array into `{ file, args, useShell }`.
 */
export function parseCommandSpec(cmd, extraArgs = []) {
  if (Array.isArray(cmd)) {
    return { file: cmd[0], args: [...cmd.slice(1), ...extraArgs], useShell: false };
  }
  const s = String(cmd ?? '').trim();
  // If the command has shell operators, run via /bin/sh -c; otherwise split simple tokens safely.
  if (/[|&;<>()$`\\"'\n]/.test(s)) {
    const full = extraArgs.length ? `${s} ${extraArgs.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}` : s;
    return { file: '/bin/sh', args: ['-c', full], useShell: true };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  return { file: parts[0], args: [...parts.slice(1), ...extraArgs], useShell: false };
}

/**
 * Check if command output or error indicates a host/session-local missing auth or context (#99).
 */
export function isAuthOrContextFailure(outputText, errCode = null) {
  if (errCode === 'ENOENT') return true;
  const text = String(outputText ?? '');
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

function runCommandSafe(cmdSpec, { timeoutMs = 10000, env = process.env, cwd = process.cwd(), execFn = execFileSync } = {}) {
  try {
    const stdout = execFn(cmdSpec.file, cmdSpec.args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd,
    });
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : null,
      errCode: e.code ?? null,
      killed: Boolean(e.killed) || e.code === 'ETIMEDOUT',
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
}

/**
 * Probe via `synthetic-command` (#99 P2).
 * Splits "service down" from "this host's auth or context is missing":
 *   1. If `probeCfg.auth_check` is set, runs it first. If it fails, returns `status: 'healthy'`
 *      with `authLocalFailure: true` so a local auth issue never causes a false fleet outage.
 *   2. Runs `probeCfg.command`. If exit is non-zero and output matches `isAuthOrContextFailure`,
 *      returns `status: 'healthy'` with `authLocalFailure: true`.
 */
export function probeSyntheticCommand(probeCfg, { env = process.env, cwd = process.cwd(), execFn = execFileSync, now = new Date() } = {}) {
  const checkedAt = nowIsoStr(now);
  const timeoutMs = probeCfg?.timeout_ms || 10000;

  if (probeCfg?.auth_check) {
    const authSpec = parseCommandSpec(probeCfg.auth_check);
    const authRes = runCommandSafe(authSpec, { timeoutMs, env, cwd, execFn });
    if (!authRes.ok) {
      const msg = (authRes.stderr || authRes.stdout || 'auth_check failed').trim().split('\n')[0].slice(0, 160);
      return {
        status: 'healthy',
        authLocalFailure: true,
        detail: `session-local auth or context missing: ${msg}`,
        rawStatus: 'auth_local_failure',
        checkedAt,
      };
    }
  }

  const cmdSpec = parseCommandSpec(probeCfg?.command, Array.isArray(probeCfg?.args) ? probeCfg.args : []);
  if (!cmdSpec.file) {
    return { status: 'unknown', detail: 'synthetic-command missing executable', rawStatus: 'config_error', checkedAt };
  }

  const res = runCommandSafe(cmdSpec, { timeoutMs, env, cwd, execFn });
  const combined = `${res.stdout}\n${res.stderr}`.trim();

  if (!res.ok) {
    if (res.killed) {
      const timeoutStatus = VALID_STATUSES.has(probeCfg.timeout_status) ? probeCfg.timeout_status : 'degraded';
      return {
        status: timeoutStatus,
        detail: `synthetic probe timed out after ${timeoutMs}ms`,
        rawStatus: 'timeout',
        checkedAt,
      };
    }
    if (isAuthOrContextFailure(combined, res.errCode)) {
      const firstLine = combined.split('\n')[0]?.slice(0, 160) || 'missing local auth/context';
      return {
        status: 'healthy',
        authLocalFailure: true,
        detail: `session-local auth or context missing: ${firstLine}`,
        rawStatus: 'auth_local_failure',
        checkedAt,
      };
    }
    const degCodes = Array.isArray(probeCfg.degraded_exit_codes) ? probeCfg.degraded_exit_codes : [];
    const status = degCodes.includes(res.code) ? 'degraded' : 'down';
    const snippet = combined.split('\n')[0]?.slice(0, 160) || `exit ${res.code ?? 1}`;
    return {
      status,
      detail: `synthetic probe failed (exit ${res.code ?? 1}): ${snippet}`,
      rawStatus: `exit_${res.code ?? 1}`,
      checkedAt,
    };
  }

  if (probeCfg.expect_json) {
    try {
      JSON.parse(res.stdout);
    } catch {
      return {
        status: 'unknown',
        detail: 'synthetic probe exited 0 but output is not valid JSON',
        rawStatus: 'invalid_output',
        checkedAt,
      };
    }
  }
  if (typeof probeCfg.expect_match === 'string' && probeCfg.expect_match) {
    if (!res.stdout.includes(probeCfg.expect_match)) {
      return {
        status: 'unknown',
        detail: `synthetic probe output did not match ${JSON.stringify(probeCfg.expect_match)}`,
        rawStatus: 'mismatch_output',
        checkedAt,
      };
    }
  }

  const firstLine = res.stdout.trim().split('\n')[0]?.slice(0, 120) || 'ok';
  return {
    status: 'healthy',
    detail: firstLine,
    rawStatus: 'exit_0',
    checkedAt,
  };
}

/**
 * Dispatch a probe for a service using its configured adapter.
 * Any unexpected throw or malformed adapter return is converted to `status: 'unknown'`.
 */
export async function runProbe(serviceSpec, opts = {}) {
  const checkedAt = nowIsoStr(opts.now);
  const probeCfg = serviceSpec?.probe;
  if (!probeCfg || typeof probeCfg !== 'object') {
    return { status: 'unknown', detail: 'missing probe configuration', rawStatus: 'config_error', checkedAt };
  }
  try {
    let result;
    if (typeof opts.customAdapters?.[probeCfg.adapter] === 'function') {
      result = await opts.customAdapters[probeCfg.adapter](probeCfg, { ...opts, serviceId: serviceSpec.id });
    } else {
      switch (probeCfg.adapter) {
        case 'statuspage':
          result = await probeStatuspage(probeCfg, opts);
          break;
        case 'observed':
          result = probeObserved(probeCfg, { ...opts, serviceId: serviceSpec.id });
          break;
        case 'http-health':
          result = await probeHttpHealth(probeCfg, opts);
          break;
        case 'synthetic-command':
          result = probeSyntheticCommand(probeCfg, opts);
          break;
        case 'fleet-report-only':
          result = {
            status: 'healthy',
            detail: 'passive report-only service',
            rawStatus: 'passive',
            checkedAt,
          };
          break;
        default:
          result = {
            status: 'unknown',
            detail: `unsupported adapter ${JSON.stringify(probeCfg.adapter)}`,
            rawStatus: 'unsupported_adapter',
            checkedAt,
          };
      }
    }
    if (!result || !VALID_STATUSES.has(result.status)) {
      return {
        status: 'unknown',
        detail: `adapter ${probeCfg.adapter} returned invalid status ${JSON.stringify(result?.status)}`,
        rawStatus: 'invalid_adapter_return',
        checkedAt,
      };
    }
    return {
      checkedAt,
      ...result,
    };
  } catch (e) {
    return {
      status: 'unknown',
      detail: `adapter ${probeCfg.adapter} threw: ${e?.message || String(e)}`,
      rawStatus: 'adapter_exception',
      checkedAt,
    };
  }
}
