#!/usr/bin/env node
// federation.mjs — the multi-fleet registry: FLEET_ID, federation.yml and fleet-qualified addresses.
// Design: docs/multi-fleet.md § 1 (registry) and § 3 (addresses); operator guide: fleet-guide.md
// "Registry (multi-fleet)".
//
//   node federation.mjs validate [file]                 exit 0 valid (or no file: single-fleet), 1 invalid
//   node federation.mjs get <path> [--file f]           e.g. repos.acme/app.merge.home; objects print as JSON
//   node federation.mjs home <owner/repo> <role> [--file f]
//   node federation.mjs address <addr>                  {"fleet": ..., "session": ...} (bare = own FLEET_ID)
//   node federation.mjs status [--file f]               the block `fleet status` prints
//   node federation.mjs status-issue [--file f]         this fleet's status issue as owner/repo#N
//
// Exit codes: 0 ok, 1 invalid file or bad arguments, 3 not declared (no such path or role, or no
// federation file at all: single-fleet mode). status-issue exits 3 only in single-fleet mode (no file,
// or no FLEET_ID) and 1 when the registry is on but names no status issue for this fleet.
//
// The file is `federation.yml` at the instance repo root, or FEDERATION_FILE (fleet-env.sh resolves
// it against the instance and exports it). FLEET_ID comes from the environment (fleet.conf). No file
// means single-fleet mode: every caller behaves exactly as before the registry existed.
//
// YAML: the repo carries no YAML dependency, so this parses a strict subset (block maps, block lists
// of scalars, one-line flow maps and lists, plain/quoted scalars, integers, true/false/null,
// comments). Anything outside it (anchors, aliases, tags, block scalars, multi-line flows, multiple
// documents, ambiguous plain scalars such as `yes`, `1.5` or `010`) is an error naming the line,
// never a guess.
//
// Zero dependencies: node builtins plus engsys core's gate-check (for the operator-source format) and
// git-env (the hermetic git call that reads the instance repo's origin).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorSource } from '../../lib/gate-check.mjs';
import { hermeticGit } from '../../lib/git-env.mjs';

/** A fleet id: lowercase, starts with a letter, 2-21 characters. Same rule as fleet-env.sh. */
export const FLEET_ID_RE = /^[a-z][a-z0-9-]{1,20}$/;
/** A session name, as the roster writes it. */
export const SESSION_RE = /^[a-z0-9][a-z0-9-]*$/;
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SLACK_MEMBER_RE = /^[UW][A-Z0-9]{2,20}$/;
const TOKEN_RE = /^[^\s'"`<>]{1,200}$/;
export const ROLES = ['merge', 'maintain'];
export const FAILOVER = ['escalate', 'auto'];
const FLEET_KEYS = ['operator', 'host', 'github_app', 'cloud_identity', 'slack_operator', 'status_issue', 'enabled'];
const ROLE_KEYS = ['home', 'ledger', 'standby', 'failover'];
const TOP_KEYS = ['version', 'operators_team', 'operators', 'fleets', 'repos'];
const EXIT = { OK: 0, ERROR: 1, ABSENT: 3 };

export class FederationError extends Error {
  constructor(message, errors = [message]) {
    super(message);
    this.name = 'FederationError';
    this.errors = errors;
  }
}

// --- the YAML subset -----------------------------------------------------------------------------

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const AMBIGUOUS_WORDS = /^(?:y|n|yes|no|on|off|true|false|null|nan|inf)$/i;
const FLOAT_LIKE = /^[-+]?(?:\d[\d_]*\.\d*|\.\d+|\d+(?:\.\d*)?[eE][-+]?\d+|\.(?:inf|nan))$/i;

function yamlError(file, line, msg) {
  const where = file ? `${file}:${line}` : `line ${line}`;
  return new FederationError(`${where}: ${msg}`);
}

/** Strip a trailing ` # comment` outside quotes. */
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
    else if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** Read one quoted scalar starting at s[i]; returns [value, nextIndex]. */
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
      const map = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t' };
      if (!(e in map)) fail(`unsupported escape \\${e ?? ''} in a double-quoted string (the subset allows \\" \\\\ \\/ \\n \\t)`);
      out += map[e];
      continue;
    }
    out += c;
  }
  fail(`unterminated ${q === '"' ? 'double' : 'single'}-quoted string`);
}

/** A plain (unquoted) scalar: integers, true/false, null/~, or a string the subset can't misread. */
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
  if (/^[-+]?0[0-9_]+$/.test(v) || /^[-+]?0[xXoObB]/.test(v) || /^\+[0-9]/.test(v) || /^[-+]?[0-9][0-9_]*$/.test(v)) {
    fail(`ambiguous number ${JSON.stringify(v)} (quote it, or write a plain decimal integer)`);
  }
  if (FLOAT_LIKE.test(v)) fail(`ambiguous value ${JSON.stringify(v)}: floats are outside the subset (quote it)`);
  if (AMBIGUOUS_WORDS.test(v)) fail(`ambiguous value ${JSON.stringify(v)} (use true/false, or quote it to mean the string)`);
  const first = v[0];
  if ('&*!|>%@`'.includes(first)) {
    const what = { '&': 'anchors', '*': 'aliases', '!': 'tags', '|': 'block scalars', '>': 'block scalars', '%': 'directives', '@': 'reserved characters', '`': 'reserved characters' }[first];
    fail(`${what} are outside the supported YAML subset (${JSON.stringify(v)}); quote the value if it is a string`);
  }
  if (first === '-' && (v.length === 1 || v[1] === ' ')) fail(`a list item is not allowed here (${JSON.stringify(v)})`);
  if (first === '?' && (v.length === 1 || v[1] === ' ')) fail('complex keys (?) are outside the supported YAML subset');
  if (/: |:$/.test(v)) fail(`unexpected ': ' inside a plain value ${JSON.stringify(v)} (quote it)`);
  if (/[\t]/.test(v)) fail('tab inside a value');
  if (v.includes(' #')) fail(`unexpected ' #' inside a plain value (quote it)`);
  return v;
}

/** Parse a one-line flow collection ({...} or [...]) or a scalar, from s[i]. Returns [value, next]. */
function readFlowValue(s, i, fail, stops) {
  while (s[i] === ' ') i++;
  const c = s[i];
  if (c === '{' || c === '[') return readFlow(s, i, fail);
  if (c === '"' || c === "'") {
    const [v, j] = readQuoted(s, i, fail);
    return [v, j];
  }
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
    if (i >= s.length) fail(`unterminated flow ${isMap ? 'map' : 'list'} (flow collections must fit on one line)`);
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
      if (s[i] !== ':') fail(`expected ':' after key ${JSON.stringify(key)} in a flow map`);
      i++;
      if (s[i] !== ' ' && s[i] !== undefined) fail(`expected a space after ':' in a flow map (key ${JSON.stringify(key)})`);
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
    if (i >= s.length) fail(`unterminated flow ${isMap ? 'map' : 'list'} (flow collections must fit on one line)`);
    if (s[i] === ',') {
      i++;
      skip();
      if (s[i] === close) fail(`trailing comma in a flow ${isMap ? 'map' : 'list'}`);
      continue;
    }
    if (s[i] === close) return [out, i + 1];
    fail(`expected ',' or '${close}' in a flow ${isMap ? 'map' : 'list'}`);
  }
}

function checkKey(key, fail) {
  if (key === '') fail('empty key');
  if (RESERVED_KEYS.has(key)) fail(`key ${JSON.stringify(key)} is not allowed`);
  if (!/^[A-Za-z0-9_./-]+$/.test(key)) fail(`key ${JSON.stringify(key)} has characters outside [A-Za-z0-9_./-] (quote it)`);
}

/** A value on the same line as its key or dash: flow collection, quoted or plain scalar. */
function inlineValue(text, fail) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[' || t[0] === '"' || t[0] === "'") {
    const [v, j] = t[0] === '{' || t[0] === '[' ? readFlow(t, 0, fail) : readQuoted(t, 0, fail);
    if (t.slice(j).trim() !== '') fail(`unexpected text after a value: ${JSON.stringify(t.slice(j).trim())}`);
    return v;
  }
  return plainScalar(t, fail);
}

/**
 * Parse the strict YAML subset. Throws FederationError naming the file and line on anything
 * outside it. Returns plain objects, arrays, strings, integers, booleans and null.
 */
export function parseYaml(text, { file = '' } = {}) {
  const lines = [];
  const src = String(text).replace(/^﻿/, '').split('\n');
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
      if (seenContent) fail('multiple YAML documents are outside the supported subset');
      seenContent = true;
      return;
    }
    if (body === '...' || body.startsWith('--- ')) fail('document markers other than one leading --- are outside the supported subset');
    if (body.startsWith('%')) fail('directives are outside the supported YAML subset');
    seenContent = true;
    lines.push({ n, indent: indentMatch.length, body });
  });

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
      if (ln.indent > indent) failAt(ln, 'bad indentation (deeper than the list it follows)');
      if (!(ln.body === '-' || ln.body.startsWith('- '))) break;
      const fail = (m) => failAt(ln, m);
      const rest = ln.body.slice(1).trim();
      if (rest === '') fail('nested block under a list item is outside the supported subset (write the item on the dash line)');
      if (/^[^"'{[][^:]*:( |$)/.test(rest)) fail('maps inside block lists are outside the supported subset (use a flow map: - { key: value })');
      out.push(inlineValue(rest, fail));
      pos++;
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) failAt(ln, 'bad indentation (deeper than the key above it, which already has a value)');
      const fail = (m) => failAt(ln, m);
      if (ln.body === '-' || ln.body.startsWith('- ')) fail('a list item where a key was expected');
      let key;
      let rest;
      if (ln.body[0] === '"' || ln.body[0] === "'") {
        let j;
        [key, j] = readQuoted(ln.body, 0, fail);
        if (ln.body[j] !== ':') fail(`expected ':' after key ${JSON.stringify(key)}`);
        rest = ln.body.slice(j + 1);
        if (key === '' || RESERVED_KEYS.has(key)) fail(`key ${JSON.stringify(key)} is not allowed`);
      } else {
        const m = /^([^:]*?):(?: (.*)|$)/.exec(ln.body);
        if (!m) fail(`expected 'key: value' or 'key:' (got ${JSON.stringify(ln.body)})`);
        key = m[1].trim();
        rest = m[2] === undefined ? '' : ` ${m[2]}`;
        checkKey(key, fail);
      }
      if (rest !== '' && rest[0] !== ' ') fail(`expected a space after ':' (key ${JSON.stringify(key)})`);
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate key ${JSON.stringify(key)}`);
      pos++;
      if (rest.trim() !== '') {
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

  if (!lines.length) return null;
  if (lines[0].indent !== 0) failAt(lines[0], 'the document must start at column 1');
  const doc = parseBlock(0);
  if (pos < lines.length) failAt(lines[pos], 'unexpected content (check the indentation)');
  return doc;
}

// --- the schema ----------------------------------------------------------------------------------

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const show = (v) => JSON.stringify(v);

/**
 * Validate a parsed federation document (docs/multi-fleet.md § 1). Collects every problem and throws
 * one FederationError listing them all. Returns a normalized copy with defaults filled in:
 * fleets.<id>.enabled (true), repos.<r>.<role>.standby ([]) and .failover ('escalate').
 */
export function validateFederation(doc, { file = '' } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isMap(doc)) {
    throw new FederationError(`${file || 'federation file'}: expected a map at the top level`, ['expected a map at the top level']);
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) err(`unknown top-level key ${show(k)} (allowed: ${TOP_KEYS.join(', ')})`);

  if (doc.version === undefined) err('version is required (version: 1)');
  else if (doc.version !== 1) err(`version must be 1, got ${show(doc.version)}`);

  const out = { version: 1, operators_team: null, operators: [], fleets: {}, repos: {} };
  if (doc.operators_team !== undefined && doc.operators_team !== null) {
    if (typeof doc.operators_team !== 'string') err(`operators_team must be org/team-slug, got ${show(doc.operators_team)}`);
    else out.operators_team = doc.operators_team;
  }
  if (doc.operators !== undefined && doc.operators !== null) {
    if (!Array.isArray(doc.operators) || doc.operators.some((e) => typeof e !== 'string')) err('operators must be a list of login:id strings');
    else out.operators = doc.operators.slice();
  }
  try {
    operatorSource({ operatorsTeam: out.operators_team, operators: out.operators });
  } catch (e) {
    err(e.message);
  }

  if (doc.fleets === undefined || doc.fleets === null) err('fleets is required (at least one fleet)');
  else if (!isMap(doc.fleets)) err('fleets must be a map of fleet id to its settings');
  else {
    if (!Object.keys(doc.fleets).length) err('fleets is empty (declare at least one fleet)');
    for (const [id, f] of Object.entries(doc.fleets)) {
      const at = `fleets.${id}`;
      if (!FLEET_ID_RE.test(id)) err(`${at}: fleet id must match ${FLEET_ID_RE.source}`);
      if (!isMap(f)) { err(`${at}: must be a map (at least enabled: true)`); continue; }
      for (const k of Object.keys(f)) if (!FLEET_KEYS.includes(k)) err(`${at}: unknown key ${show(k)} (allowed: ${FLEET_KEYS.join(', ')})`);
      const fl = { enabled: true };
      const str = (k, re, hint) => {
        if (f[k] === undefined || f[k] === null) return;
        if (typeof f[k] !== 'string' || !re.test(f[k])) err(`${at}.${k}: ${hint}, got ${show(f[k])}`);
        else fl[k] = f[k];
      };
      str('operator', LOGIN_RE, 'must be a GitHub user login');
      str('host', TOKEN_RE, 'must be a host name without spaces');
      if (typeof f.github_app === 'string' && f.github_app.endsWith('[bot]')) err(`${at}.github_app: give the App slug without [bot] (the bot login is <slug>[bot]), got ${show(f.github_app)}`);
      else str('github_app', APP_SLUG_RE, 'must be a GitHub App slug (lowercase letters, digits, hyphens)');
      str('cloud_identity', TOKEN_RE, 'must be an identity name or id without spaces');
      str('slack_operator', SLACK_MEMBER_RE, 'must be a Slack member id (U… or W…)');
      if (f.status_issue !== undefined && f.status_issue !== null) {
        if (!isPosInt(f.status_issue)) err(`${at}.status_issue: must be a positive issue number, got ${show(f.status_issue)}`);
        else fl.status_issue = f.status_issue;
      }
      if (f.enabled !== undefined) {
        if (typeof f.enabled !== 'boolean') err(`${at}.enabled: must be true or false, got ${show(f.enabled)}`);
        else fl.enabled = f.enabled;
      }
      out.fleets[id] = fl;
    }
  }
  const fleetIds = isMap(doc.fleets) ? Object.keys(doc.fleets) : [];

  if (doc.repos !== undefined && doc.repos !== null) {
    if (!isMap(doc.repos)) err('repos must be a map of owner/repo to its roles');
    else {
      for (const [repo, roles] of Object.entries(doc.repos)) {
        const at = `repos.${repo}`;
        if (!REPO_RE.test(repo)) err(`${at}: repo key must be owner/name`);
        if (!isMap(roles)) { err(`${at}: must be a map of role (${ROLES.join(', ')}) to its settings`); continue; }
        const outRoles = {};
        for (const [role, spec] of Object.entries(roles)) {
          const rat = `${at}.${role}`;
          if (!ROLES.includes(role)) { err(`${rat}: unknown role (allowed: ${ROLES.join(', ')}; build, investigate and design are per fleet and never listed)`); continue; }
          if (!isMap(spec)) { err(`${rat}: must be a map, e.g. { home: <fleet>, ledger: <issue> }`); continue; }
          for (const k of Object.keys(spec)) if (!ROLE_KEYS.includes(k)) err(`${rat}: unknown key ${show(k)} (allowed: ${ROLE_KEYS.join(', ')})`);
          const r = { home: null, standby: [], failover: 'escalate' };
          if (spec.home === undefined || spec.home === null) err(`${rat}.home is required`);
          else if (typeof spec.home !== 'string' || !fleetIds.includes(spec.home)) err(`${rat}.home: ${show(spec.home)} is not a fleet declared under fleets`);
          else r.home = spec.home;
          if (spec.ledger !== undefined && spec.ledger !== null) {
            if (!isPosInt(spec.ledger)) err(`${rat}.ledger: must be a positive issue number, got ${show(spec.ledger)}`);
            else r.ledger = spec.ledger;
          }
          if (spec.standby !== undefined && spec.standby !== null) {
            if (!Array.isArray(spec.standby)) err(`${rat}.standby: must be a list of fleet ids, e.g. [bob]`);
            else {
              const seen = new Set();
              for (const s of spec.standby) {
                if (typeof s !== 'string' || !fleetIds.includes(s)) err(`${rat}.standby: ${show(s)} is not a fleet declared under fleets`);
                else if (s === spec.home) err(`${rat}.standby: ${show(s)} is already the home fleet`);
                else if (seen.has(s)) err(`${rat}.standby: ${show(s)} is listed twice`);
                else { seen.add(s); r.standby.push(s); }
              }
            }
          }
          if (spec.failover !== undefined && spec.failover !== null) {
            if (!FAILOVER.includes(spec.failover)) err(`${rat}.failover: must be ${FAILOVER.join(' or ')}, got ${show(spec.failover)}`);
            else r.failover = spec.failover;
          }
          outRoles[role] = r;
        }
        out.repos[repo] = outRoles;
      }
    }
  }

  if (errors.length) {
    const head = `${file || 'federation file'} is invalid (${errors.length} problem${errors.length === 1 ? '' : 's'})`;
    throw new FederationError(`${head}:\n  - ${errors.join('\n  - ')}`, errors);
  }
  return out;
}

/** Parse and validate a federation file's text. */
export function parseFederation(text, { file = '' } = {}) {
  return validateFederation(parseYaml(text, { file }), { file });
}

/**
 * Where the federation file lives: FEDERATION_FILE (absolute, or relative to the instance), else
 * <instance>/federation.yml, else ./federation.yml.
 */
export function resolveFederationFile(env = process.env, cwd = process.cwd()) {
  const base = env.FLEET_REPO || env.FLEET_INSTANCE || cwd;
  const f = env.FEDERATION_FILE || 'federation.yml';
  return path.resolve(base, f);
}

/** Load and validate the registry. Returns null when the file does not exist (single-fleet mode). */
export function loadFederation(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new FederationError(`cannot read ${file}: ${e.message}`);
  }
  return parseFederation(text, { file });
}

/** Validate a FLEET_ID value ('' / undefined = unset, single-fleet). Returns the id or null. */
export function checkFleetId(id) {
  if (id === undefined || id === null || id === '') return null;
  if (!FLEET_ID_RE.test(id)) throw new FederationError(`FLEET_ID ${show(id)} must match ${FLEET_ID_RE.source} (lowercase, starts with a letter, 2-21 characters)`);
  return id;
}

/** Problems with this fleet's place in the registry (an empty list when fine or single-fleet). */
export function fleetIdProblems(reg, fleetId) {
  if (!reg) return [];
  if (!fleetId) return ['a federation file exists but FLEET_ID is not set in fleet/fleet.conf'];
  if (!reg.fleets[fleetId]) return [`FLEET_ID ${show(fleetId)} is not declared under fleets in the federation file`];
  return [];
}

/**
 * Look up a dotted path. Repo keys contain '/' and may contain '.', so at each level the longest
 * run of segments that names an existing key wins: repos.acme/my.app.merge.home works.
 */
export function getPath(obj, dotted) {
  const segs = String(dotted).split('.');
  let cur = obj;
  let i = 0;
  while (i < segs.length) {
    if (!isMap(cur) && !Array.isArray(cur)) return undefined;
    let hit = -1;
    for (let j = segs.length; j > i; j--) {
      const k = segs.slice(i, j).join('.');
      if (Object.prototype.hasOwnProperty.call(cur, k)) { hit = j; cur = cur[k]; break; }
    }
    if (hit < 0) return undefined;
    i = hit;
  }
  return cur;
}

/** The home fleet for a repo role, or null when the registry does not declare it. */
export function roleHome(reg, repo, role) {
  return reg?.repos?.[repo]?.[role]?.home ?? null;
}

/**
 * Parse an address: `<fleet>:<session>` (alice:acme-build) or a bare session name, which means
 * "my fleet" (ownFleet, or null in single-fleet mode).
 */
export function parseAddress(addr, ownFleet = null) {
  if (typeof addr !== 'string' || addr.trim() === '') throw new FederationError('address is empty');
  const a = addr.trim();
  const parts = a.split(':');
  if (parts.length > 2) throw new FederationError(`address ${show(a)} has more than one ':' (use <fleet>:<session>)`);
  const [fleet, session] = parts.length === 2 ? parts : [ownFleet || null, parts[0]];
  if (parts.length === 2 && !FLEET_ID_RE.test(fleet)) throw new FederationError(`address ${show(a)}: fleet ${show(fleet)} must match ${FLEET_ID_RE.source}`);
  if (!SESSION_RE.test(session)) throw new FederationError(`address ${show(a)}: session ${show(session)} must be a session name (lowercase letters, digits, hyphens)`);
  return { fleet, session };
}

/** True when an address names this fleet (a bare name always does). */
export function isOwnAddress(addr, ownFleet = null) {
  const { fleet } = parseAddress(addr, ownFleet);
  return fleet === null || fleet === (ownFleet || null);
}

/** owner/repo from a GitHub remote URL (https, ssh or scp-like form), or null. */
export function repoFromRemoteUrl(url) {
  const m = String(url ?? '').trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m && REPO_RE.test(m[1]) ? m[1] : null;
}

/**
 * The repo that holds the fleets' status issues (the instance repo): FLEET_INSTANCE_REPO when set,
 * else the `origin` remote of the checkout that holds the federation file. Null when neither works.
 */
export function instanceRepo(file, env = process.env) {
  if (env.FLEET_INSTANCE_REPO) {
    if (!REPO_RE.test(env.FLEET_INSTANCE_REPO)) throw new FederationError(`FLEET_INSTANCE_REPO ${show(env.FLEET_INSTANCE_REPO)} must be owner/name`);
    return env.FLEET_INSTANCE_REPO;
  }
  try {
    return repoFromRemoteUrl(hermeticGit(path.dirname(file), ['config', '--get', 'remote.origin.url'], { stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/**
 * This fleet's status issue, `{ repo, issue }`, or null in single-fleet mode (no registry, or no
 * FLEET_ID). Throws when the registry is on but the issue can't be named: FLEET_ID not declared, no
 * `status_issue`, or no instance repo. Callers fail closed on that rather than fall back to a
 * shared per-repo ledger, which is the collision the status issue exists to avoid.
 */
export function statusIssueTarget(reg, fleetId, { file, env = process.env } = {}) {
  if (!reg || !fleetId) return null;
  const problems = fleetIdProblems(reg, fleetId);
  if (problems.length) throw new FederationError(problems.join('; '));
  const issue = reg.fleets[fleetId].status_issue;
  if (!issue) throw new FederationError(`fleets.${fleetId}.status_issue is not declared in ${file || 'the federation file'}`);
  const repo = instanceRepo(file, env);
  if (!repo) throw new FederationError(`cannot tell which repo holds fleet ${fleetId}'s status issue: set FLEET_INSTANCE_REPO=owner/name, or give the checkout of ${file || 'the federation file'} a GitHub origin remote`);
  return { repo, issue };
}

/** The lines `fleet status` prints for the registry. */
export function statusLines(reg, { fleetId = null, file = '' } = {}) {
  const lines = [];
  if (!reg && !fleetId) return [`fleet: single-fleet mode (no FLEET_ID, no ${file || 'federation file'})`];
  lines.push(`fleet: ${fleetId || '(FLEET_ID not set)'}`);
  if (!reg) {
    lines.push(`federation: none (${file ? `no ${file}` : 'no file'}) — single-fleet mode`);
    return lines;
  }
  const ids = Object.keys(reg.fleets);
  lines.push(`federation: ${file} (${ids.length} fleet${ids.length === 1 ? '' : 's'}: ${ids.map((id) => (reg.fleets[id].enabled ? id : `${id} (disabled)`)).join(', ')})`);
  for (const p of fleetIdProblems(reg, fleetId)) lines.push(`  WARNING ${p}`);
  const rows = [];
  for (const [repo, roles] of Object.entries(reg.repos)) {
    for (const role of ROLES) {
      const r = roles[role];
      if (!r) continue;
      const mine = fleetId && r.home === fleetId ? ' (this fleet)' : '';
      const extra = [r.ledger ? `ledger #${r.ledger}` : 'ledger -', r.standby.length ? `standby ${r.standby.join(',')}` : 'standby -', `failover ${r.failover}`];
      rows.push([`${repo} ${role}`, `home ${r.home}${mine}`, extra.join('  ')]);
    }
  }
  if (!rows.length) lines.push('  no repo roles declared');
  const w0 = Math.max(...rows.map((r) => r[0].length), 0);
  const w1 = Math.max(...rows.map((r) => r[1].length), 0);
  for (const r of rows) lines.push(`  ${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}`);
  return lines;
}

// --- CLI -----------------------------------------------------------------------------------------

const USAGE = `usage: federation.mjs validate [file]
       federation.mjs get <path> [--file f]
       federation.mjs home <owner/repo> <role> [--file f]
       federation.mjs address <addr>
       federation.mjs status [--file f]
       federation.mjs status-issue [--file f]`;

export function main(argv, { env = process.env, out = process.stdout, err = process.stderr, cwd = process.cwd() } = {}) {
  const say = (s) => out.write(`${s}\n`);
  const warn = (s) => err.write(`federation: ${s}\n`);
  const args = [];
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') {
      if (!argv[i + 1]) { warn('--file needs a path'); return EXIT.ERROR; }
      file = argv[++i];
    } else if (argv[i].startsWith('--file=')) file = argv[i].slice(7);
    else if (argv[i] === '-h' || argv[i] === '--help') { say(USAGE); return EXIT.OK; }
    else args.push(argv[i]);
  }
  const [cmd, ...rest] = args;
  let fleetId;
  try {
    fleetId = checkFleetId(env.FLEET_ID);
  } catch (e) {
    warn(e.message);
    return EXIT.ERROR;
  }
  const explicit = file !== null || (cmd === 'validate' && rest[0] !== undefined);
  const target = path.resolve(cwd, file ?? (cmd === 'validate' ? rest[0] : undefined) ?? resolveFederationFile(env, cwd));
  const load = () => {
    const reg = loadFederation(target);
    if (!reg && explicit) throw new FederationError(`${target} not found`);
    return reg;
  };

  try {
    switch (cmd) {
      case 'validate': {
        if (rest.length > 1) { warn(USAGE); return EXIT.ERROR; }
        const reg = load();
        if (!reg) { say(`no federation file (${target}): single-fleet mode`); return EXIT.OK; }
        // Without FLEET_ID (CI on the instance repo, say) only the file itself is checked.
        if (fleetId && !reg.fleets[fleetId]) { warn(`${target}: ${fleetIdProblems(reg, fleetId).join('; ')}`); return EXIT.ERROR; }
        const roles = Object.values(reg.repos).reduce((n, r) => n + Object.keys(r).length, 0);
        const nf = Object.keys(reg.fleets).length;
        say(`ok: ${target} (${nf} fleet${nf === 1 ? '' : 's'}, ${roles} repo role${roles === 1 ? '' : 's'})`);
        return EXIT.OK;
      }
      case 'get': {
        if (rest.length !== 1) { warn(USAGE); return EXIT.ERROR; }
        const reg = load();
        if (!reg) { warn(`no federation file (${target}): single-fleet mode`); return EXIT.ABSENT; }
        const v = getPath(reg, rest[0]);
        if (v === undefined) { warn(`${rest[0]}: not declared in ${target}`); return EXIT.ABSENT; }
        say(v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
        return EXIT.OK;
      }
      case 'home': {
        if (rest.length !== 2) { warn(USAGE); return EXIT.ERROR; }
        const [repo, role] = rest;
        if (!REPO_RE.test(repo)) { warn(`repo must be owner/name, got ${show(repo)}`); return EXIT.ERROR; }
        if (!ROLES.includes(role)) { warn(`role must be one of ${ROLES.join(', ')}, got ${show(role)}`); return EXIT.ERROR; }
        const reg = load();
        if (!reg) { warn(`no federation file (${target}): single-fleet mode`); return EXIT.ABSENT; }
        const home = roleHome(reg, repo, role);
        if (!home) { warn(`repos.${repo}.${role} is not declared in ${target}`); return EXIT.ABSENT; }
        say(home);
        return EXIT.OK;
      }
      case 'address': {
        if (rest.length !== 1) { warn(USAGE); return EXIT.ERROR; }
        say(JSON.stringify(parseAddress(rest[0], fleetId)));
        return EXIT.OK;
      }
      case 'status': {
        if (rest.length) { warn(USAGE); return EXIT.ERROR; }
        let reg;
        try {
          reg = load();
        } catch (e) {
          say(`fleet: ${fleetId || '(FLEET_ID not set)'}`);
          say(`federation: INVALID — ${e.message.split('\n').join('\n  ')}`);
          return EXIT.ERROR;
        }
        for (const l of statusLines(reg, { fleetId, file: target })) say(l);
        return EXIT.OK;
      }
      case 'status-issue': {
        if (rest.length) { warn(USAGE); return EXIT.ERROR; }
        const reg = load();
        const t = statusIssueTarget(reg, fleetId, { file: target, env });
        if (!t) { warn(reg ? 'FLEET_ID is not set: single-fleet mode' : `no federation file (${target}): single-fleet mode`); return EXIT.ABSENT; }
        say(`${t.repo}#${t.issue}`);
        return EXIT.OK;
      }
      default:
        warn(cmd ? `unknown command ${show(cmd)}\n${USAGE}` : USAGE);
        return EXIT.ERROR;
    }
  } catch (e) {
    if (e instanceof FederationError) { warn(e.message); return EXIT.ERROR; }
    throw e;
  }
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) process.exitCode = main(process.argv.slice(2));
