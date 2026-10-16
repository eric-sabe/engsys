#!/usr/bin/env node
// registry.mjs — Fleet Health Desk (FHD) service registry loader, YAML parser, and validator
// (engsys#97, #99, #100).
//
// Loads and validates `fleet-health.yml`:
//   - Top-level: version (1), board ({ repo, issue, stale_minutes }), slack ({ channel }),
//     correlation_window_minutes, services ({ <id>: { ... } } or [ { id/name, ... } ]).
//   - Validates service IDs (^[a-z0-9][a-z0-9_-]*$), observability (central|per-session),
//     probe.adapter (statuspage|observed|http-health|synthetic-command|fleet-report-only),
//     probe.tier (passive|on-ambiguity), thresholds (trip_fails >= 1, recover_clean >= 1),
//     and checks depends_on for unknown services, self-dependencies, or cycles (DAG check).
//   - Enforces the #99 rule: no PUSH_OVERRIDE advice in any impact or runbook string.
//
// Zero dependencies: node builtins only (self-contained inside core/ for plugin-mode installs).

import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const ADAPTERS = Object.freeze([
  'statuspage',
  'observed',
  'http-health',
  'synthetic-command',
  'fleet-report-only',
]);
export const OBSERVABILITY = Object.freeze(['central', 'per-session']);
export const TIERS = Object.freeze(['passive', 'on-ambiguity']);
export const KINDS = Object.freeze(['external', 'internal', 'local']);

const TOP_KEYS = new Set([
  'version',
  'board',
  'slack',
  'correlation_window_minutes',
  'services',
]);
const BOARD_KEYS = new Set(['repo', 'issue', 'stale_minutes']);
const SLACK_KEYS = new Set(['channel']);
const SERVICE_KEYS = new Set([
  'id',
  'name',
  'kind',
  'observability',
  'probe',
  'poll',
  'poll_seconds',
  'thresholds',
  'depends_on',
  'impact',
  'invoke',
  'runbook',
]);
const PROBE_KEYS = new Set([
  'adapter',
  'url',
  'component',
  'components',
  'command',
  'args',
  'tier',
  'timeout_ms',
  'auth_check',
  'auth',
  'poll',
  'poll_seconds',
  'method',
  'degraded_codes',
  'down_codes',
  'timeout_status',
  'window_minutes',
  'fail_rate_degraded',
  'fail_rate_down',
  'min_samples',
  'degraded_consecutive',
  'down_consecutive',
  'empty_status',
  'statuspage_url',
  'statuspage_component',
  'expect_match',
  'expect_json',
  'degraded_exit_codes',
  'source_file',
]);
const THRESHOLD_KEYS = new Set(['trip_fails', 'recover_clean']);
const INVOKE_KEYS = new Set(['command', 'args', 'timeout_ms', 'allow_args', 'description', 'requires_gate']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class RegistryError extends Error {
  constructor(message, errors = [message]) {
    super(message);
    this.name = 'RegistryError';
    this.errors = errors;
  }
}

// --- Zero-dependency YAML subset parser ---------------------------------------------------------

function yamlError(file, line, msg) {
  const where = file ? `${file}:${line}` : `line ${line}`;
  return new RegistryError(`${where}: ${msg}`);
}

function stripComment(s) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function readQuoted(s, i, fail) {
  const q = s[i];
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q === "'") {
      if (c === "'") {
        if (s[j + 1] === "'") { out += "'"; j++; continue; }
        return [out, j + 1];
      }
      out += c;
      continue;
    }
    if (c === '"') return [out, j + 1];
    if (c === '\\') {
      const e = s[++j];
      const map = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r' };
      if (!(e in map)) fail(`unsupported escape \\${e ?? ''} in double-quoted string`);
      out += map[e];
      continue;
    }
    out += c;
  }
  fail(`unterminated ${q === '"' ? 'double' : 'single'}-quoted string`);
}

function plainScalar(raw, fail) {
  const v = raw.trim();
  if (v === '') fail('empty value (write "" for an empty string)');
  if (v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) fail(`integer ${v} is out of range`);
    return n;
  }
  if (/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/.test(v)) {
    const f = Number(v);
    if (!Number.isFinite(f)) fail(`float ${v} is out of range`);
    return f;
  }
  return v;
}

function checkKey(key, fail) {
  if (key === '') fail('empty key');
  if (RESERVED_KEYS.has(key)) fail(`key ${JSON.stringify(key)} is not allowed`);
}

function readFlowValue(s, i, fail, stops) {
  while (s[i] === ' ') i++;
  const c = s[i];
  if (c === '{' || c === '[') return readFlow(s, i, fail);
  if (c === '"' || c === "'") return readQuoted(s, i, fail);
  let j = i;
  while (j < s.length && !stops.includes(s[j])) j++;
  return [plainScalar(s.slice(i, j), fail), j];
}

function readFlow(s, i, fail) {
  const open = s[i];
  const close = open === '{' ? '}' : ']';
  const isMap = open === '{';
  const out = isMap ? {} : [];
  i++;
  const skip = () => { while (s[i] === ' ') i++; };
  skip();
  if (s[i] === close) return [out, i + 1];
  for (;;) {
    skip();
    if (i >= s.length) fail(`unterminated flow ${isMap ? 'map' : 'list'}`);
    if (isMap) {
      let key;
      if (s[i] === '"' || s[i] === "'") [key, i] = readQuoted(s, i, fail);
      else {
        let j = i;
        while (j < s.length && s[j] !== ':' && s[j] !== ',' && s[j] !== '}') j++;
        key = s.slice(i, j).trim();
        i = j;
        checkKey(key, fail);
      }
      skip();
      if (s[i] !== ':') fail(`expected ':' after key ${JSON.stringify(key)} in flow map`);
      i++;
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate key ${JSON.stringify(key)}`);
      let v;
      [v, i] = readFlowValue(s, i, fail, [',', '}']);
      out[key] = v;
    } else {
      let v;
      [v, i] = readFlowValue(s, i, fail, [',', ']']);
      out.push(v);
    }
    skip();
    if (i >= s.length) fail(`unterminated flow ${isMap ? 'map' : 'list'}`);
    if (s[i] === ',') {
      i++;
      skip();
      if (s[i] === close) return [out, i + 1];
      continue;
    }
    if (s[i] === close) return [out, i + 1];
    fail(`expected ',' or '${close}' in flow ${isMap ? 'map' : 'list'}`);
  }
}

function inlineValue(text, fail) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[' || t[0] === '"' || t[0] === "'") {
    const [v, j] = (t[0] === '{' || t[0] === '[') ? readFlow(t, 0, fail) : readQuoted(t, 0, fail);
    if (t.slice(j).trim() !== '') fail(`unexpected text after value: ${JSON.stringify(t.slice(j).trim())}`);
    return v;
  }
  return plainScalar(t, fail);
}

function splitKeyVal(body, fail) {
  if (body[0] === '"' || body[0] === "'") {
    const [key, j] = readQuoted(body, 0, fail);
    if (body[j] !== ':') fail(`expected ':' after key ${JSON.stringify(key)}`);
    const rest = body.slice(j + 1);
    checkKey(key, fail);
    if (rest !== '' && rest[0] !== ' ') fail(`expected a space after ':' (key ${JSON.stringify(key)})`);
    return { key, rest: rest.trim() };
  }
  const m = /^([^:]+?):(?: (.*)|$)/.exec(body);
  if (!m) return null;
  const key = m[1].trim();
  checkKey(key, fail);
  return { key, rest: (m[2] ?? '').trim() };
}

/**
 * Parse YAML text into JS objects/arrays/scalars. Supports block maps, block sequences (including
 * sequences of maps like `services:\n  - name: github`), flow maps/lists, and quoted/plain scalars.
 */
export function parseYaml(text, { file = '' } = {}) {
  const lines = [];
  const src = String(text).replace(/^\uFEFF/, '').split('\n');
  let seenContent = false;
  src.forEach((rawLine, idx) => {
    const n = idx + 1;
    const fail = (m) => { throw yamlError(file, n, m); };
    const raw = rawLine.replace(/\r$/, '');
    const indentMatch = /^[ \t]*/.exec(raw)[0];
    if (indentMatch.includes('\t') && raw.trim() !== '') fail('tab in indentation (use spaces)');
    const body = stripComment(raw.slice(indentMatch.length));
    if (body === '') return;
    if (body === '---') {
      if (seenContent) fail('multiple YAML documents are not supported');
      seenContent = true;
      return;
    }
    seenContent = true;
    lines.push({ n, indent: indentMatch.length, body });
  });

  if (!lines.length) return null;
  let pos = 0;
  const failAt = (ln, m) => { throw yamlError(file, ln.n, m); };

  function parseBlock(indent) {
    const first = lines[pos];
    if (first.body === '-' || first.body.startsWith('- ')) return parseSeq(indent);
    return parseMap(indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) failAt(ln, 'bad indentation in sequence');
      if (!(ln.body === '-' || ln.body.startsWith('- '))) break;
      const fail = (m) => failAt(ln, m);
      const rest = ln.body.slice(1).trim();
      pos++;
      if (rest === '') {
        const next = lines[pos];
        if (next && next.indent > indent) out.push(parseBlock(next.indent));
        else out.push(null);
        continue;
      }
      // Check if `- key: val` block map item
      if (rest[0] !== '{' && rest[0] !== '[' && rest[0] !== '"' && rest[0] !== "'") {
        const kv = splitKeyVal(rest, fail);
        if (kv) {
          const itemIndent = ln.indent + 2;
          const obj = {};
          if (kv.rest !== '') {
            obj[kv.key] = inlineValue(kv.rest, fail);
          } else {
            const next = lines[pos];
            if (next && next.indent > ln.indent) obj[kv.key] = parseBlock(next.indent);
            else obj[kv.key] = null;
          }
          if (pos < lines.length && lines[pos].indent >= itemIndent && !(lines[pos].indent === indent && (lines[pos].body === '-' || lines[pos].body.startsWith('- ')))) {
            const more = parseMap(lines[pos].indent);
            for (const [k, v] of Object.entries(more)) {
              if (Object.prototype.hasOwnProperty.call(obj, k)) fail(`duplicate key ${JSON.stringify(k)}`);
              obj[k] = v;
            }
          }
          out.push(obj);
          continue;
        }
      }
      out.push(inlineValue(rest, fail));
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) failAt(ln, 'bad indentation in mapping');
      if (ln.body === '-' || ln.body.startsWith('- ')) break;
      const fail = (m) => failAt(ln, m);
      const kv = splitKeyVal(ln.body, fail);
      if (!kv) fail(`expected 'key: value' or 'key:' (got ${JSON.stringify(ln.body)})`);
      const { key, rest } = kv;
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate key ${JSON.stringify(key)}`);
      pos++;
      if (rest !== '') {
        out[key] = inlineValue(rest, fail);
        continue;
      }
      const next = lines[pos];
      if (next && next.indent > indent) out[key] = parseBlock(next.indent);
      else if (next && next.indent === indent && (next.body === '-' || next.body.startsWith('- '))) out[key] = parseSeq(indent);
      else out[key] = null;
    }
    return out;
  }

  if (lines[0].indent !== 0) failAt(lines[0], 'the document must start at column 1');
  const doc = parseBlock(0);
  if (pos < lines.length) failAt(lines[pos], 'unexpected trailing content');
  return doc;
}

// --- Schema Validation & DAG Check --------------------------------------------------------------

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const show = (v) => JSON.stringify(v);

function checkNoPushOverride(text, where, err) {
  if (typeof text === 'string' && /\bPUSH_OVERRIDE\b/.test(text)) {
    err(`${where}: PUSH_OVERRIDE advice is forbidden (defer local-env authority to the resource broker instead)`);
  }
}

function normalizeImpact(rawImpact, at, err) {
  const out = {
    merge: null,
    dispatch: null,
    triage: null,
    advice: null,
    down: null,
    degraded: null,
    hold_merges: false,
    pause_claims: false,
    dispatch_warn: false,
    components: {},
  };
  if (rawImpact === undefined || rawImpact === null) return out;
  if (typeof rawImpact === 'string') {
    checkNoPushOverride(rawImpact, `${at}.impact`, err);
    out.advice = rawImpact.trim();
    out.down = out.advice;
    out.degraded = out.advice;
    out.hold_merges = /\bhold\s+merges\b/i.test(out.advice);
    return out;
  }
  if (!isMap(rawImpact)) {
    err(`${at}.impact: must be a map or string, got ${show(rawImpact)}`);
    return out;
  }
  for (const [k, v] of Object.entries(rawImpact)) {
    if (k === 'hold_merges' || k === 'pause_claims' || k === 'dispatch_warn') {
      if (typeof v !== 'boolean') err(`${at}.impact.${k}: must be boolean, got ${show(v)}`);
      else out[k] = v;
      continue;
    }
    if (typeof v !== 'string') {
      err(`${at}.impact.${k}: must be a string, got ${show(v)}`);
      continue;
    }
    checkNoPushOverride(v, `${at}.impact.${k}`, err);
    if (['merge', 'dispatch', 'triage', 'advice', 'down', 'degraded'].includes(k)) {
      out[k] = v.trim();
    } else {
      out.components[k] = v.trim();
    }
    if (/\bhold\s+merges\b/i.test(v)) out.hold_merges = true;
  }
  if (!out.advice) {
    const parts = [out.merge, out.dispatch, out.triage, out.down, out.degraded, ...Object.values(out.components)].filter(Boolean);
    if (parts.length) out.advice = parts[0];
  }
  return out;
}

/**
 * Detect cycles in `depends_on` graph and return topological ordering (dependencies first).
 */
export function checkDependencyDag(servicesMap) {
  const visited = new Map(); // id -> 0 (visiting) | 1 (done)
  const order = [];
  const cycles = [];

  function dfs(id, stack) {
    const st = visited.get(id);
    if (st === 1) return;
    if (st === 0) {
      const idx = stack.indexOf(id);
      cycles.push([...stack.slice(idx), id]);
      return;
    }
    visited.set(id, 0);
    stack.push(id);
    const deps = servicesMap[id]?.depends_on ?? [];
    for (const dep of deps) {
      if (servicesMap[dep]) dfs(dep, stack);
    }
    stack.pop();
    visited.set(id, 1);
    order.push(id);
  }

  for (const id of Object.keys(servicesMap)) {
    if (!visited.has(id)) dfs(id, []);
  }
  return { order, cycles };
}

/**
 * Return service IDs ordered dependencies-first so root dependencies are evaluated before dependents.
 */
export function topologicalOrder(servicesMap) {
  return checkDependencyDag(servicesMap).order;
}

/**
 * Validate a parsed `fleet-health.yml` object and return a normalized copy with defaults.
 */
export function validateRegistry(doc, { file = '' } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isMap(doc)) {
    throw new RegistryError(`${file || 'fleet-health.yml'}: expected a map at the top level`, ['expected a map at the top level']);
  }

  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) err(`unknown top-level key ${show(k)} (allowed: ${[...TOP_KEYS].join(', ')})`);
  }

  if (doc.version === undefined) err('version is required (version: 1)');
  else if (doc.version !== 1) err(`version must be 1, got ${show(doc.version)}`);

  const out = {
    version: 1,
    board: { repo: null, issue: null, stale_minutes: 30 },
    slack: { channel: null },
    correlation_window_minutes: 15,
    services: {},
  };

  if (doc.board !== undefined && doc.board !== null) {
    if (!isMap(doc.board)) err('board must be a map ({ repo, issue, stale_minutes })');
    else {
      for (const k of Object.keys(doc.board)) {
        if (!BOARD_KEYS.has(k)) err(`board: unknown key ${show(k)} (allowed: ${[...BOARD_KEYS].join(', ')})`);
      }
      if (doc.board.repo !== undefined && doc.board.repo !== null) {
        if (typeof doc.board.repo !== 'string' || !REPO_RE.test(doc.board.repo)) {
          err(`board.repo: must be owner/name, got ${show(doc.board.repo)}`);
        } else out.board.repo = doc.board.repo;
      }
      if (doc.board.issue !== undefined && doc.board.issue !== null) {
        if (!isPosInt(doc.board.issue)) err(`board.issue: must be a positive integer, got ${show(doc.board.issue)}`);
        else out.board.issue = doc.board.issue;
      }
      if (doc.board.stale_minutes !== undefined && doc.board.stale_minutes !== null) {
        if (!isPosInt(doc.board.stale_minutes)) err(`board.stale_minutes: must be a positive integer, got ${show(doc.board.stale_minutes)}`);
        else out.board.stale_minutes = doc.board.stale_minutes;
      }
    }
  }

  if (doc.slack !== undefined && doc.slack !== null) {
    if (!isMap(doc.slack)) err('slack must be a map ({ channel })');
    else {
      for (const k of Object.keys(doc.slack)) {
        if (!SLACK_KEYS.has(k)) err(`slack: unknown key ${show(k)} (allowed: ${[...SLACK_KEYS].join(', ')})`);
      }
      if (doc.slack.channel !== undefined && doc.slack.channel !== null) {
        if (typeof doc.slack.channel !== 'string' || !doc.slack.channel.trim()) {
          err(`slack.channel: must be a non-empty string, got ${show(doc.slack.channel)}`);
        } else out.slack.channel = doc.slack.channel.trim();
      }
    }
  }

  if (doc.correlation_window_minutes !== undefined && doc.correlation_window_minutes !== null) {
    if (!isPosInt(doc.correlation_window_minutes)) {
      err(`correlation_window_minutes: must be a positive integer, got ${show(doc.correlation_window_minutes)}`);
    } else out.correlation_window_minutes = doc.correlation_window_minutes;
  }

  // Normalize services (supports map `{ <id>: { ... } }` or array `[ { id/name: <id>, ... } ]`)
  const rawServices = {};
  if (doc.services === undefined || doc.services === null) {
    err('services is required (at least one service)');
  } else if (Array.isArray(doc.services)) {
    if (doc.services.length === 0) err('services is empty (declare at least one service)');
    doc.services.forEach((item, idx) => {
      if (!isMap(item)) {
        err(`services[${idx}]: must be a map`);
        return;
      }
      const id = item.id ?? item.name;
      if (typeof id !== 'string' || !id.trim()) {
        err(`services[${idx}]: missing id or name`);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(rawServices, id)) {
        err(`services: duplicate service id ${show(id)}`);
        return;
      }
      rawServices[id] = item;
    });
  } else if (isMap(doc.services)) {
    if (Object.keys(doc.services).length === 0) err('services is empty (declare at least one service)');
    for (const [id, spec] of Object.entries(doc.services)) {
      rawServices[id] = spec;
    }
  } else {
    err('services must be a map of service id to its config');
  }

  for (const [id, s] of Object.entries(rawServices)) {
    const at = `services.${id}`;
    if (!SERVICE_ID_RE.test(id)) {
      err(`${at}: service id must match ${SERVICE_ID_RE.source}`);
    }
    if (!isMap(s)) {
      err(`${at}: must be a map`);
      continue;
    }
    for (const k of Object.keys(s)) {
      if (!SERVICE_KEYS.has(k)) err(`${at}: unknown key ${show(k)}`);
    }

    const kind = s.kind ?? 'external';
    if (!KINDS.includes(kind)) {
      err(`${at}.kind: must be one of ${KINDS.join(', ')}, got ${show(s.kind)}`);
    }

    const observability = s.observability ?? 'central';
    if (!OBSERVABILITY.includes(observability)) {
      err(`${at}.observability: must be one of ${OBSERVABILITY.join(', ')}, got ${show(s.observability)}`);
    }

    // Probe validation
    let probe = null;
    if (!isMap(s.probe)) {
      err(`${at}.probe: required and must be a map`);
    } else {
      for (const k of Object.keys(s.probe)) {
        if (!PROBE_KEYS.has(k)) err(`${at}.probe: unknown key ${show(k)}`);
      }
      const adapter = s.probe.adapter;
      if (!ADAPTERS.includes(adapter)) {
        err(`${at}.probe.adapter: must be one of ${ADAPTERS.join(', ')}, got ${show(adapter)}`);
      }
      const defaultTier = adapter === 'synthetic-command' ? 'on-ambiguity' : 'passive';
      const tier = s.probe.tier ?? defaultTier;
      if (!TIERS.includes(tier)) {
        err(`${at}.probe.tier: must be one of ${TIERS.join(', ')}, got ${show(s.probe.tier)}`);
      }

      if (adapter === 'statuspage' || adapter === 'http-health') {
        if (typeof s.probe.url !== 'string' || !/^https?:\/\/\S+$/.test(s.probe.url)) {
          err(`${at}.probe.url: required http(s) URL for adapter '${adapter}', got ${show(s.probe.url)}`);
        }
      }

      if (adapter === 'synthetic-command') {
        const hasCmd = (typeof s.probe.command === 'string' && s.probe.command.trim() !== '')
          || (Array.isArray(s.probe.command) && s.probe.command.length > 0 && s.probe.command.every((x) => typeof x === 'string'));
        if (!hasCmd) {
          err(`${at}.probe.command: required non-empty string or string array for synthetic-command`);
        }
      }

      const timeoutMs = s.probe.timeout_ms ?? 10000;
      if (!isPosInt(timeoutMs)) {
        err(`${at}.probe.timeout_ms: must be a positive integer, got ${show(s.probe.timeout_ms)}`);
      }

      let components = [];
      if (s.probe.component !== undefined && s.probe.component !== null) {
        if (typeof s.probe.component !== 'string' || !s.probe.component.trim()) {
          err(`${at}.probe.component: must be a non-empty string`);
        } else components.push(s.probe.component.trim());
      }
      if (s.probe.components !== undefined && s.probe.components !== null) {
        if (!Array.isArray(s.probe.components) || s.probe.components.some((c) => typeof c !== 'string' || !c.trim())) {
          err(`${at}.probe.components: must be a list of non-empty strings`);
        } else components = [...components, ...s.probe.components.map((c) => c.trim())];
      }

      probe = {
        ...s.probe,
        adapter,
        tier,
        timeout_ms: timeoutMs,
        components,
      };
    }

    const rawPoll = s.poll_seconds ?? s.poll ?? s.probe?.poll_seconds ?? s.probe?.poll ?? 90;
    if (!isPosInt(rawPoll)) {
      err(`${at}.poll_seconds: must be a positive integer, got ${show(rawPoll)}`);
    }

    const defaultTrip = probe?.adapter === 'statuspage' ? 1 : 2;
    const thresholds = { trip_fails: defaultTrip, recover_clean: 3 };
    if (s.thresholds !== undefined && s.thresholds !== null) {
      if (!isMap(s.thresholds)) {
        err(`${at}.thresholds: must be a map ({ trip_fails, recover_clean })`);
      } else {
        for (const k of Object.keys(s.thresholds)) {
          if (!THRESHOLD_KEYS.has(k)) err(`${at}.thresholds: unknown key ${show(k)}`);
        }
        if (s.thresholds.trip_fails !== undefined) {
          if (!isPosInt(s.thresholds.trip_fails)) {
            err(`${at}.thresholds.trip_fails: must be an integer >= 1, got ${show(s.thresholds.trip_fails)}`);
          } else thresholds.trip_fails = s.thresholds.trip_fails;
        }
        if (s.thresholds.recover_clean !== undefined) {
          if (!isPosInt(s.thresholds.recover_clean)) {
            err(`${at}.thresholds.recover_clean: must be an integer >= 1, got ${show(s.thresholds.recover_clean)}`);
          } else thresholds.recover_clean = s.thresholds.recover_clean;
        }
      }
    }

    const dependsOn = [];
    if (s.depends_on !== undefined && s.depends_on !== null) {
      if (!Array.isArray(s.depends_on)) {
        err(`${at}.depends_on: must be a list of service ids`);
      } else {
        const seen = new Set();
        for (const dep of s.depends_on) {
          if (typeof dep !== 'string' || !SERVICE_ID_RE.test(dep)) {
            err(`${at}.depends_on: invalid service id ${show(dep)}`);
          } else if (dep === id) {
            err(`${at}.depends_on: service ${show(id)} cannot depend on itself`);
          } else if (!Object.prototype.hasOwnProperty.call(rawServices, dep)) {
            err(`${at}.depends_on: unknown service ${show(dep)}`);
          } else if (!seen.has(dep)) {
            seen.add(dep);
            dependsOn.push(dep);
          }
        }
      }
    }

    const impact = normalizeImpact(s.impact, at, err);

    let invoke = null;
    if (s.invoke !== undefined && s.invoke !== null) {
      if (!isMap(s.invoke)) {
        err(`${at}.invoke: must be a map ({ command, args, timeout_ms })`);
      } else {
        for (const k of Object.keys(s.invoke)) {
          if (!INVOKE_KEYS.has(k)) err(`${at}.invoke: unknown key ${show(k)}`);
        }
        const hasCmd = (typeof s.invoke.command === 'string' && s.invoke.command.trim() !== '')
          || (Array.isArray(s.invoke.command) && s.invoke.command.length > 0 && s.invoke.command.every((x) => typeof x === 'string'));
        if (!hasCmd) err(`${at}.invoke.command: required non-empty string or string array`);
        const invTimeout = s.invoke.timeout_ms ?? 60000;
        if (!isPosInt(invTimeout)) err(`${at}.invoke.timeout_ms: must be a positive integer, got ${show(s.invoke.timeout_ms)}`);
        if (s.invoke.allow_args !== undefined && typeof s.invoke.allow_args !== 'boolean') {
          err(`${at}.invoke.allow_args: must be boolean, got ${show(s.invoke.allow_args)}`);
        }
        if (s.invoke.requires_gate !== undefined && typeof s.invoke.requires_gate !== 'boolean') {
          err(`${at}.invoke.requires_gate: must be boolean, got ${show(s.invoke.requires_gate)}`);
        }
        invoke = {
          command: s.invoke.command,
          args: Array.isArray(s.invoke.args) ? s.invoke.args.map(String) : [],
          timeout_ms: invTimeout,
          allow_args: s.invoke.allow_args === true,
          requires_gate: Boolean(s.invoke.requires_gate),
          description: typeof s.invoke.description === 'string' ? s.invoke.description : null,
        };
      }
    }

    let runbook = null;
    if (s.runbook !== undefined && s.runbook !== null) {
      if (typeof s.runbook !== 'string' || !s.runbook.trim()) {
        err(`${at}.runbook: must be a non-empty string, got ${show(s.runbook)}`);
      } else {
        checkNoPushOverride(s.runbook, `${at}.runbook`, err);
        runbook = s.runbook.trim();
      }
    }

    out.services[id] = {
      id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : id,
      kind,
      observability,
      probe,
      poll_seconds: rawPoll,
      thresholds,
      depends_on: dependsOn,
      impact,
      invoke,
      runbook,
    };
  }

  // DAG cycle check across all services
  const { cycles } = checkDependencyDag(out.services);
  for (const cycle of cycles) {
    err(`depends_on cycle detected: ${cycle.join(' -> ')}`);
  }

  if (errors.length) {
    const head = `${file || 'fleet-health.yml'} is invalid (${errors.length} problem${errors.length === 1 ? '' : 's'})`;
    throw new RegistryError(`${head}:\n  - ${errors.join('\n  - ')}`, errors);
  }
  return out;
}

/**
 * Parse and validate `fleet-health.yml` text.
 */
export function parseRegistry(text, { file = '' } = {}) {
  return validateRegistry(parseYaml(text, { file }), { file });
}

/**
 * Resolve where `fleet-health.yml` lives: `FLEET_HEALTH_FILE` (or `ENGSYS_FHD_REGISTRY`),
 * else `<FLEET_REPO || FLEET_INSTANCE || cwd>/fleet-health.yml`, else `<cwd>/.claude/fleet-health.yml`.
 */
export function resolveRegistryFile(env = process.env, cwd = process.cwd()) {
  const explicit = env.FLEET_HEALTH_FILE || env.ENGSYS_FHD_REGISTRY;
  const base = env.FLEET_REPO || env.FLEET_INSTANCE || cwd;
  if (explicit) return path.resolve(base, explicit);
  const primary = path.resolve(base, 'fleet-health.yml');
  if (fs.existsSync(primary)) return primary;
  const dotClaude = path.resolve(base, '.claude', 'fleet-health.yml');
  if (fs.existsSync(dotClaude)) return dotClaude;
  return primary;
}

/**
 * Load and validate `fleet-health.yml` from disk. Returns `null` if file does not exist (`ENOENT`).
 */
export function loadRegistry(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new RegistryError(`cannot read ${file}: ${e.message}`);
  }
  return parseRegistry(text, { file });
}
