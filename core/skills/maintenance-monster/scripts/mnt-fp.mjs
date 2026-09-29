#!/usr/bin/env node
// mnt-fp.mjs — engine behind mnt-fp-candidates.sh and mnt-fp-dismiss.sh (standing false-positive
// policies for the Maintenance Monster). Zero dependencies, ESM, Node >= 20.
//
//   node mnt-fp.mjs candidates --repo owner/name --config FILE [--policy ID] [--json]
//                              [--repo-dir DIR] [--default-branch NAME]
//   node mnt-fp.mjs dismiss    --repo owner/name --config FILE --alert N --policy ID
//                              --shape TEXT --evidence TEXT [--state-dir DIR] [--repo-dir DIR]
//                              [--default-branch NAME]
//
// Design. A reviewed, standing policy (config `fp_policies:`) says: "alerts of this rule are false
// positives when the code matches one of these shapes, and while these structural tripwires hold".
// `candidates` is read-only: it finds open alerts a policy covers and proves the tripwires hold at
// the alert's own commit AND at the default branch. It never dismisses. The per-alert code judgment
// belongs to the calling model. `dismiss` is the only mutating path: it re-runs the same evaluation
// for one alert (the tripwire may have tripped since the candidate list was made), then PATCHes.
//
// Fail-closed throughout: any gh or git error means ERROR and no CANDIDATE for that policy; an
// invalid policy is reported and never evaluated.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// A small YAML-subset reader. The monster's scripts otherwise take flags and never read the config;
// this one needs nested lists of maps, so it reads exactly: block mappings, block sequences (items
// may be `key: value` maps), flow `[..]` / `{..}` collections (also across lines), single- and
// double-quoted strings, plain scalars (`true`/`false`/`null` typed, everything else a string), and
// `#` comments. Anchors, tags, multi-document files and block scalars (`|`, `>`) are rejected, so a
// policy that uses them is invalid rather than silently misread.
// ---------------------------------------------------------------------------------------------

class YamlError extends Error {}

const isSpace = (c) => c === ' ' || c === '\t';
const isFlowStartPrev = (s, i) => i === 0 || isSpace(s[i - 1]) || '[{,'.includes(s[i - 1]);

/** Remove a trailing `# comment`, honouring quotes that open at a token start. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if ((c === '"' || c === "'") && isFlowStartPrev(s, i)) q = c;
    else if (c === '#' && (i === 0 || isSpace(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** Net `[`/`{` depth opened by a line: only brackets that start a flow token count. */
function flowDepth(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if ((c === '"' || c === "'") && isFlowStartPrev(s, i)) q = c;
    else if ((c === '[' || c === '{') && (depth > 0 || isFlowStartPrev(s, i))) depth++;
    else if ((c === ']' || c === '}') && depth > 0) depth--;
  }
  return depth;
}

function tokenizeLines(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes('\t')) {
      if (stripComment(line.slice(lead.length)).trim() === '') continue;
      throw new YamlError(`line ${n + 1}: tab in indentation`);
    }
    const body = stripComment(line.slice(lead.length)).trimEnd();
    if (body === '') continue;
    if (body === '---' || body === '...') throw new YamlError(`line ${n + 1}: document markers are not supported`);
    out.push({ indent: lead.length, text: body, no: n + 1 });
  }
  // Join a flow collection that spans lines into one logical line.
  const joined = [];
  for (let i = 0; i < out.length; i++) {
    const cur = { ...out[i] };
    let depth = flowDepth(cur.text);
    while (depth > 0) {
      i++;
      if (i >= out.length) throw new YamlError(`line ${cur.no}: unterminated flow collection`);
      cur.text += ' ' + out[i].text;
      depth = flowDepth(cur.text);
    }
    joined.push(cur);
  }
  return joined;
}

const isSeqItem = (t) => t === '-' || t.startsWith('- ');

function readQuoted(s, i) {
  // s[i] is the opening quote. Returns [value, indexAfterClosingQuote].
  const q = s[i];
  let v = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q === '"') {
      if (c === '\\') {
        const e = s[++j];
        if (e === undefined) break;
        if (e === 'n') v += '\n';
        else if (e === 't') v += '\t';
        else if (e === 'r') v += '\r';
        else if (e === '0') v += '\0';
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 1, j + 5))) {
          v += String.fromCharCode(parseInt(s.slice(j + 1, j + 5), 16));
          j += 4;
        } else v += e;
      } else if (c === '"') return [v, j + 1];
      else v += c;
    } else if (c === "'") {
      if (s[j + 1] === "'") { v += "'"; j++; } else return [v, j + 1];
    } else v += c;
  }
  throw new YamlError('unterminated quoted string');
}

function coerce(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return s;
}

/** Index of the `:` that ends a mapping key on this line, or -1 when it is not a `key: value` line. */
function findKeyColon(t) {
  if (t[0] === '[' || t[0] === '{') return -1;
  let start = 0;
  if (t[0] === '"' || t[0] === "'") {
    try {
      start = readQuoted(t, 0)[1];
    } catch {
      return -1;
    }
    return t[start] === ':' && (start + 1 === t.length || isSpace(t[start + 1])) ? start : -1;
  }
  for (let i = start; i < t.length; i++) {
    if (t[i] === ':' && (i + 1 === t.length || isSpace(t[i + 1]))) return i;
  }
  return -1;
}

function parseKey(k) {
  const t = k.trim();
  if (t[0] === '"' || t[0] === "'") return readQuoted(t, 0)[0];
  return t;
}

function parseFlow(s) {
  let pos = 0;
  const ws = () => { while (pos < s.length && isSpace(s[pos])) pos++; };
  const plainEnd = (stopColon) => {
    let j = pos;
    while (j < s.length) {
      const c = s[j];
      if (c === ',' || c === ']' || c === '}') break;
      if (stopColon && c === ':' && (j + 1 === s.length || isSpace(s[j + 1]) || ',]}'.includes(s[j + 1]))) break;
      j++;
    }
    return j;
  };
  function value() {
    ws();
    const c = s[pos];
    if (c === '[') {
      pos++;
      const arr = [];
      for (;;) {
        ws();
        if (s[pos] === ']') { pos++; return arr; }
        arr.push(value());
        ws();
        if (s[pos] === ',') { pos++; continue; }
        if (s[pos] === ']') { pos++; return arr; }
        throw new YamlError(`flow sequence: expected "," or "]" near "${s.slice(pos, pos + 20)}"`);
      }
    }
    if (c === '{') {
      pos++;
      const obj = Object.create(null);
      for (;;) {
        ws();
        if (s[pos] === '}') { pos++; return obj; }
        let key;
        if (s[pos] === '"' || s[pos] === "'") {
          [key, pos] = readQuoted(s, pos);
        } else {
          const e = plainEnd(true);
          key = s.slice(pos, e).trim();
          pos = e;
        }
        ws();
        if (s[pos] !== ':') throw new YamlError(`flow mapping: expected ":" after key "${key}"`);
        pos++;
        if (key in obj) throw new YamlError(`duplicate key "${key}"`);
        obj[key] = value();
        ws();
        if (s[pos] === ',') { pos++; continue; }
        if (s[pos] === '}') { pos++; return obj; }
        throw new YamlError(`flow mapping: expected "," or "}" near "${s.slice(pos, pos + 20)}"`);
      }
    }
    if (c === '"' || c === "'") {
      let v;
      [v, pos] = readQuoted(s, pos);
      return v;
    }
    if (pos >= s.length) throw new YamlError('flow collection ended early');
    const e = plainEnd(false);
    const v = s.slice(pos, e).trim();
    pos = e;
    if (/^[&!|>]/.test(v)) throw new YamlError(`unsupported YAML construct "${v.slice(0, 12)}"`);
    return coerce(v);
  }
  const v = value();
  ws();
  if (pos < s.length) throw new YamlError(`unexpected trailing text "${s.slice(pos, pos + 20)}"`);
  return v;
}

function parseInline(s) {
  const t = s.trim();
  if (t[0] === '[' || t[0] === '{') return parseFlow(t);
  if (t[0] === '"' || t[0] === "'") {
    const [v, end] = readQuoted(t, 0);
    if (t.slice(end).trim() !== '') throw new YamlError(`unexpected text after quoted string: "${t.slice(end, end + 20)}"`);
    return v;
  }
  if (/^[&!|>]/.test(t)) throw new YamlError(`unsupported YAML construct "${t.slice(0, 12)}" (use a plain or quoted string)`);
  return coerce(t);
}

function parseBlock(p, indent) {
  const line = p.lines[p.i];
  if (isSeqItem(line.text)) return parseSeq(p, indent);
  if (findKeyColon(line.text) >= 0) return parseMap(p, indent);
  p.i++;
  try {
    return parseInline(line.text);
  } catch (e) {
    throw new YamlError(`line ${line.no}: ${e.message}`);
  }
}

function parseSeq(p, indent) {
  const arr = [];
  while (p.i < p.lines.length) {
    const line = p.lines[p.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`line ${line.no}: unexpected indentation`);
    if (!isSeqItem(line.text)) break;
    const after = line.text === '-' ? '' : line.text.slice(1);
    const rest = after.trimStart();
    const itemIndent = indent + 1 + (after.length - rest.length);
    if (rest === '') {
      p.i++;
      const next = p.lines[p.i];
      arr.push(next && next.indent > indent ? parseBlock(p, next.indent) : null);
    } else if (isSeqItem(rest) || findKeyColon(rest) >= 0) {
      line.indent = itemIndent;
      line.text = rest;
      arr.push(parseBlock(p, itemIndent));
    } else {
      p.i++;
      try {
        arr.push(parseInline(rest));
      } catch (e) {
        throw new YamlError(`line ${line.no}: ${e.message}`);
      }
    }
  }
  return arr;
}

function parseMap(p, indent) {
  const obj = Object.create(null);
  while (p.i < p.lines.length) {
    const line = p.lines[p.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`line ${line.no}: unexpected indentation`);
    const ki = findKeyColon(line.text);
    if (ki < 0) {
      if (isSeqItem(line.text)) break;
      throw new YamlError(`line ${line.no}: expected "key: value"`);
    }
    let key;
    try {
      key = parseKey(line.text.slice(0, ki));
    } catch (e) {
      throw new YamlError(`line ${line.no}: ${e.message}`);
    }
    if (key in obj) throw new YamlError(`line ${line.no}: duplicate key "${key}"`);
    const rest = line.text.slice(ki + 1).trim();
    p.i++;
    if (rest === '') {
      const next = p.lines[p.i];
      if (next && next.indent > indent) obj[key] = parseBlock(p, next.indent);
      else if (next && next.indent === indent && isSeqItem(next.text)) obj[key] = parseSeq(p, indent);
      else obj[key] = null;
    } else {
      try {
        obj[key] = parseInline(rest);
      } catch (e) {
        throw new YamlError(`line ${line.no}: ${e.message}`);
      }
    }
  }
  return obj;
}

export function parseYaml(text) {
  const lines = tokenizeLines(text);
  if (lines.length === 0) return null;
  const p = { lines, i: 0 };
  const v = parseBlock(p, lines[0].indent);
  if (p.i < lines.length) throw new YamlError(`line ${lines[p.i].no}: unexpected content`);
  return v;
}

/**
 * Read only the wanted top-level keys of a config file. Each key's block is parsed on its own, so a
 * YAML feature this reader does not know elsewhere in the (model-read) file cannot break it.
 * Returns { values: {key: value}, errors: {key: message} }.
 */
export function readTopLevel(text, wanted) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  for (const line of lines) {
    const m = /^([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line);
    if (m) chunks.push({ key: m[1], lines: [line] });
    else if (chunks.length) chunks[chunks.length - 1].lines.push(line);
  }
  const values = {};
  const errors = {};
  for (const key of wanted) {
    const mine = chunks.filter((c) => c.key === key);
    if (mine.length === 0) continue;
    if (mine.length > 1) { errors[key] = `duplicate top-level key "${key}"`; continue; }
    try {
      const v = parseYaml(mine[0].lines.join('\n'));
      values[key] = v ? v[key] : null;
    } catch (e) {
      errors[key] = e instanceof YamlError ? e.message : String(e);
    }
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------------------------
// Globs: matched against the full repo-relative path. `*` and `?` stay within one path segment,
// `**/` matches any number of directories (including none), a trailing `**` matches everything below.
// ---------------------------------------------------------------------------------------------

export function globToRegExp(glob) {
  const g = glob.replace(/^\/+/, '');
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const close = g.indexOf(']', i + 2);
      if (close > 0) {
        let cls = g.slice(i + 1, close);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

// ---------------------------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
// The example config ships `<who> <yyyy-mm-dd> <link ...>`: any <...> token, or an unclosed <who/<yyyy/<link, is a placeholder.
const PLACEHOLDER_RE = /<[^<>]*>|<\s*(who|yyyy|link)/i;
const TRIPWIRE_TYPES = ['absent_regex', 'absent_dependency', 'absent_path'];
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v) => (typeof v === 'string' ? [v] : v);

function checkKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

function validateTripwire(c, i, errors) {
  const where = `tripwire[${i}]`;
  if (!isPlain(c)) { errors.push(`${where}: must be a mapping`); return null; }
  if (!TRIPWIRE_TYPES.includes(c.type)) {
    errors.push(`${where}: unknown type ${JSON.stringify(c.type ?? null)} (expected one of ${TRIPWIRE_TYPES.join(', ')})`);
    return null;
  }
  const n0 = errors.length;
  if (c.type === 'absent_regex') {
    checkKeys(c, ['type', 'glob', 'pattern', 'ignore_case'], where, errors);
    if (!isStr(c.glob)) errors.push(`${where}: glob is required`);
    if (!isStr(c.pattern)) errors.push(`${where}: pattern is required`);
    if (c.ignore_case !== undefined && typeof c.ignore_case !== 'boolean') errors.push(`${where}: ignore_case must be true or false`);
    if (isStr(c.pattern)) {
      try { new RegExp(c.pattern); } catch (e) { errors.push(`${where}: pattern is not a valid regular expression (${e.message})`); }
    }
  } else if (c.type === 'absent_dependency') {
    checkKeys(c, ['type', 'manifests', 'names'], where, errors);
    if (!isStr(c.manifests)) errors.push(`${where}: manifests (a glob) is required`);
    if (!Array.isArray(c.names) || c.names.length === 0 || !c.names.every(isStr)) errors.push(`${where}: names must be a non-empty list of package names`);
  } else {
    checkKeys(c, ['type', 'glob'], where, errors);
    if (!isStr(c.glob)) errors.push(`${where}: glob is required`);
  }
  return errors.length === n0 ? c : null;
}

/** Returns { label, ok, errors, policy }. `policy` is normalised and only set when ok. */
export function validatePolicy(raw, index) {
  const errors = [];
  const label = isPlain(raw) && typeof raw.id === 'string' && raw.id ? raw.id : `#${index + 1}`;
  if (!isPlain(raw)) return { label, ok: false, errors: ['policy must be a mapping'] };
  checkKeys(raw, ['id', 'rule', 'tool', 'approved_by', 'known_fp_shapes', 'paths', 'tripwire'], 'policy', errors);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id must be a slug of [a-z0-9-] (no leading/trailing hyphen, at most 64 characters)');
  if (!isStr(raw.rule) || /\s/.test(raw.rule)) errors.push('rule must be an exact code-scanning rule id');
  if (raw.tool !== undefined && raw.tool !== null && !isStr(raw.tool)) errors.push('tool must be a string');
  if (!isStr(raw.approved_by)) errors.push('approved_by is required (who, date and a link to the reviewed change that added this policy)');
  else if (PLACEHOLDER_RE.test(raw.approved_by)) errors.push('approved_by still contains a template placeholder (a <...> token such as <who>, <yyyy-mm-dd> or <link>); replace it with who signed off, the date and a bare link to the reviewed change');
  if (!Array.isArray(raw.known_fp_shapes) || raw.known_fp_shapes.length === 0) errors.push('known_fp_shapes must be a non-empty list');
  else if (!raw.known_fp_shapes.every(isStr)) errors.push('known_fp_shapes entries must be non-empty strings (quote a shape that contains ": ")');
  const paths = { include: [], exclude: [] };
  if (raw.paths !== undefined && raw.paths !== null) {
    if (!isPlain(raw.paths)) errors.push('paths must be a mapping with include and/or exclude');
    else {
      checkKeys(raw.paths, ['include', 'exclude'], 'paths', errors);
      for (const k of ['include', 'exclude']) {
        if (raw.paths[k] === undefined || raw.paths[k] === null) continue;
        const l = strList(raw.paths[k]);
        if (!Array.isArray(l) || !l.every(isStr)) errors.push(`paths.${k} must be a list of globs`);
        else paths[k] = l;
      }
    }
  }
  const tripwire = [];
  if (!Array.isArray(raw.tripwire) || raw.tripwire.length === 0) errors.push('tripwire must be a non-empty list (a policy without a structural check is a blind dismissal)');
  else raw.tripwire.forEach((c, i) => { const v = validateTripwire(c, i, errors); if (v) tripwire.push(v); });
  if (errors.length) return { label, ok: false, errors };
  return {
    label,
    ok: true,
    errors: [],
    policy: {
      id: raw.id,
      rule: raw.rule,
      tool: isStr(raw.tool) ? raw.tool : null,
      approved_by: raw.approved_by.trim(),
      known_fp_shapes: raw.known_fp_shapes,
      paths,
      tripwire,
    },
  };
}

/** Validate every entry; a duplicate id invalidates every entry that shares it. */
export function validatePolicies(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return [{ label: 'fp_policies', ok: false, errors: ['fp_policies must be a list'] }];
  const results = list.map((raw, i) => validatePolicy(raw, i));
  const seen = new Map();
  for (const r of results) if (r.ok) seen.set(r.policy.id, (seen.get(r.policy.id) || 0) + 1);
  for (const r of results) {
    if (r.ok && seen.get(r.policy.id) > 1) {
      r.ok = false;
      r.errors = [`duplicate policy id "${r.policy.id}"`];
      delete r.policy;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// git (hermetic) and gh
// ---------------------------------------------------------------------------------------------

// Repo-location variables a git hook exports. An inherited GIT_DIR would override the clone we pass
// as cwd. (Inlined, like the lease primitives, so this file is self-contained.)
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of GIT_LOCATION_VARS) delete env[k];
  return env;
}

class ToolError extends Error {}
/** A failure that affects every alert of a policy (the default branch is unavailable): fail the whole policy closed. */
class MainError extends ToolError {}

const oneLine = (s, max = 300) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

function git(dir, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: dir, env: gitEnv(), maxBuffer: 1 << 29, input: opts.input });
  if (r.error) throw new ToolError(`git ${args[0]}: ${r.error.message}`);
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  if (r.status !== 0 && !opts.allowFail) throw new ToolError(`git ${args.join(' ')} failed (exit ${r.status}): ${oneLine(stderr)}`);
  return { status: r.status, stdout: r.stdout, stderr };
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.error) return { ok: false, stdout: '', stderr: `gh: ${r.error.message}`, status: null };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;
const MAX_PAGES = 200;

function ghJson(args) {
  const r = gh(['api', ...args]);
  if (!r.ok) {
    const err = new ToolError(`gh api ${args[args.length - 1]} failed: ${oneLine(r.stderr || r.stdout)}`);
    err.http403 = /HTTP 403|Resource not accessible/i.test(r.stderr + r.stdout);
    err.http404 = /HTTP 404|Not Found/i.test(r.stderr + r.stdout);
    throw err;
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new ToolError(`gh api ${args[args.length - 1]}: response is not JSON`);
  }
}

const perPage = () => (Number(process.env.MNT_FP_PER_PAGE) > 0 ? Number(process.env.MNT_FP_PER_PAGE) : 100);

/** Open alerts of one ref (default branch when `ref` is null), all pages, walking to the first empty page. */
function listOpenAlerts(repo, ref = null) {
  const per = perPage();
  const all = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new ToolError(`code-scanning alert list exceeds ${MAX_PAGES} pages`);
    const refq = ref ? `&ref=${ref}` : '';
    const items = ghJson([`repos/${repo}/code-scanning/alerts?state=open&per_page=${per}&page=${page}${refq}`]);
    if (!Array.isArray(items)) throw new ToolError('code-scanning alerts response is not a list');
    if (items.length === 0) break;
    all.push(...items);
  }
  return all.filter((a) => a && a.state === 'open');
}

/** Open PR numbers, ascending. `gh pr list` pages internally up to --limit; a full result means "maybe more", so widen. */
function listOpenPrs(repo) {
  let limit = Number(process.env.MNT_FP_PR_LIMIT) > 0 ? Number(process.env.MNT_FP_PR_LIMIT) : 1000;
  for (;;) {
    const r = gh(['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number', '--limit', String(limit)]);
    if (!r.ok) throw new ToolError(`gh pr list failed: ${oneLine(r.stderr || r.stdout)}`);
    let list;
    try { list = JSON.parse(r.stdout); } catch { throw new ToolError('gh pr list: response is not JSON'); }
    if (!Array.isArray(list) || !list.every((x) => x && Number.isInteger(x.number))) throw new ToolError('gh pr list: unexpected response');
    if (list.length < limit) return list.map((x) => x.number).sort((a, b) => a - b);
    if (limit >= 100000) throw new ToolError(`more than ${limit} open PRs; the PR list may be truncated`);
    limit *= 4;
  }
}

/** Open alerts of a PR: its merge ref first (what the merge gate analyses), then /head when merge is 404 or empty. */
function listPrAlerts(repo, pr) {
  for (const kind of ['merge', 'head']) {
    let items;
    try {
      items = listOpenAlerts(repo, `refs/pull/${pr}/${kind}`);
    } catch (e) {
      if (e.http404) continue; // no analysis for that ref
      throw e;
    }
    if (items.length) return items;
  }
  return [];
}

const PR_REF_RE = /^refs\/pull\/(\d+)\/(merge|head)$/;
const prFromRef = (ref) => {
  const m = typeof ref === 'string' ? PR_REF_RE.exec(ref) : null;
  return m ? Number(m[1]) : null;
};

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

function makeCtx({ repoDir, repo, defaultBranch }) {
  return { repoDir, repo, defaultBranch, main: undefined, trees: new Map(), blobs: new Map(), commits: new Set() };
}

/** Fetch the default branch into its own ref (never trust a stale one). Cached; a failure is cached too. */
function ensureMain(ctx) {
  if (ctx.main === undefined) {
    try {
      const top = git(ctx.repoDir, ['rev-parse', '--git-dir'], { allowFail: true });
      if (top.status !== 0) throw new ToolError(`not a git repository: ${ctx.repoDir}`);
      const b = ctx.defaultBranch;
      git(ctx.repoDir, ['fetch', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`]);
      const sha = git(ctx.repoDir, ['rev-parse', '--verify', `refs/remotes/origin/${b}^{commit}`]).stdout.toString('utf8').trim();
      if (!SHA_RE.test(sha)) throw new ToolError(`cannot resolve origin/${b}`);
      ctx.main = { ok: true, sha };
    } catch (e) {
      ctx.main = { ok: false, error: e.message };
    }
  }
  if (!ctx.main.ok) throw new MainError(`default branch not available (fail-closed): ${ctx.main.error}`);
  return ctx.main.sha;
}

/**
 * Make `sha` available locally. Tries the sha itself, then, for a PR instance, the PR's merge and head refs fetched
 * into scratch refs (refs/mnt-fp/pr-<n>-<kind>), then any other ref the instance names.
 */
function ensureCommit(ctx, sha, ref, pr) {
  if (ctx.commits.has(sha)) return;
  const have = () => git(ctx.repoDir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).status === 0;
  if (!have()) {
    const first = git(ctx.repoDir, ['fetch', 'origin', sha], { allowFail: true });
    const n = pr ?? prFromRef(ref);
    if (!have() && n !== null) {
      for (const kind of ['merge', 'head']) {
        if (have()) break;
        git(ctx.repoDir, ['fetch', 'origin', `+refs/pull/${n}/${kind}:refs/mnt-fp/pr-${n}-${kind}`], { allowFail: true });
      }
    } else if (!have() && typeof ref === 'string' && REF_RE.test(ref)) git(ctx.repoDir, ['fetch', 'origin', ref], { allowFail: true });
    if (!have()) throw new ToolError(`commit ${sha.slice(0, 12)} is not available locally and could not be fetched${n === null || n === undefined ? '' : ` (PR ${n})`}${first.status === 0 ? '' : ` (${oneLine(first.stderr, 120)})`}`);
  }
  ctx.commits.add(sha);
}

function treeAt(ctx, rev) {
  if (ctx.trees.has(rev)) return ctx.trees.get(rev);
  const out = git(ctx.repoDir, ['ls-tree', '-r', '-z', '--full-tree', rev]).stdout.toString('utf8');
  const files = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
    if (m) files.push({ mode: m[1], type: m[2], sha: m[3], path: m[4] });
  }
  ctx.trees.set(rev, files);
  return files;
}

/** Read blobs by sha through one `git cat-file --batch`. Returns Map(sha -> Buffer). */
function readBlobs(ctx, shas) {
  const need = [...new Set(shas)].filter((s) => !ctx.blobs.has(s));
  if (need.length) {
    const r = git(ctx.repoDir, ['cat-file', '--batch'], { input: need.map((s) => `${s}\n`).join('') });
    const buf = r.stdout;
    let pos = 0;
    for (const sha of need) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) throw new ToolError('git cat-file --batch: truncated output');
      const header = buf.slice(pos, nl).toString('utf8').split(' ');
      if (header[1] !== 'blob') throw new ToolError(`git cat-file --batch: cannot read blob ${sha.slice(0, 12)}`);
      const size = Number(header[2]);
      ctx.blobs.set(sha, buf.slice(nl + 1, nl + 1 + size));
      pos = nl + 1 + size + 1;
    }
  }
  return ctx.blobs;
}

const contentFiles = (files, glob) => {
  const re = globToRegExp(glob);
  return files.filter((f) => f.type === 'blob' && f.mode !== '120000' && re.test(f.path));
};

function evalCheck(ctx, rev, check) {
  const files = treeAt(ctx, rev);
  if (check.type === 'absent_path') {
    const re = globToRegExp(check.glob);
    const hits = files.filter((f) => re.test(f.path)).map((f) => f.path);
    return hits.length
      ? { ok: false, detail: `path present: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}` }
      : { ok: true, detail: `no path matches ${check.glob}` };
  }
  if (check.type === 'absent_regex') {
    const targets = contentFiles(files, check.glob);
    const re = new RegExp(check.pattern, check.ignore_case ? 'im' : 'm');
    const blobs = readBlobs(ctx, targets.map((f) => f.sha));
    const hits = targets.filter((f) => re.test(blobs.get(f.sha).toString('utf8'))).map((f) => f.path);
    return hits.length
      ? { ok: false, files_scanned: targets.length, detail: `/${check.pattern}/ matches in ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}` }
      : { ok: true, files_scanned: targets.length, detail: `/${check.pattern}/ absent from ${targets.length} file(s) matching ${check.glob}` };
  }
  // absent_dependency
  const targets = contentFiles(files, check.manifests);
  const blobs = readBlobs(ctx, targets.map((f) => f.sha));
  const hits = [];
  for (const f of targets) {
    let pkg;
    try {
      pkg = JSON.parse(blobs.get(f.sha).toString('utf8'));
    } catch (e) {
      throw new ToolError(`cannot parse ${f.path} at ${rev.slice(0, 12)} as JSON: ${e.message}`);
    }
    if (!isPlain(pkg)) throw new ToolError(`${f.path} at ${rev.slice(0, 12)} is not a JSON object`);
    for (const sec of DEP_SECTIONS) {
      const deps = isPlain(pkg[sec]) ? pkg[sec] : {};
      for (const name of check.names) if (Object.prototype.hasOwnProperty.call(deps, name)) hits.push(`${name} (${sec}) in ${f.path}`);
    }
  }
  return hits.length
    ? { ok: false, files_scanned: targets.length, detail: `dependency present: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}` }
    : { ok: true, files_scanned: targets.length, detail: `none of ${check.names.join(', ')} in ${targets.length} manifest(s) matching ${check.manifests}` };
}

function evalTripwire(ctx, rev, where, policy, pr = null) {
  return policy.tripwire.map((check, index) => ({ index, type: check.type, where, sha: rev, pr, ...evalCheck(ctx, rev, check) }));
}

/** The instance(s) of an alert as evaluation inputs; `pr` says which PR's ref list the instance came from. */
function instanceOf(alert, pr) {
  const inst = alert.most_recent_instance || {};
  const loc = inst.location || {};
  return { pr: pr ?? prFromRef(inst.ref), ref: inst.ref || null, sha: inst.commit_sha, path: loc.path, line: loc.start_line ?? null };
}

const policyCovers = (policy, alert) =>
  alert.rule && alert.rule.id === policy.rule &&
  (!policy.tool || (alert.tool && typeof alert.tool.name === 'string' && alert.tool.name.toLowerCase() === policy.tool.toLowerCase()));

function scopeReason(policy, p) {
  const { include, exclude } = policy.paths;
  if (include.length && !include.some((g) => globToRegExp(g).test(p))) return `path matches no paths.include glob`;
  const ex = exclude.find((g) => globToRegExp(g).test(p));
  return ex ? `path excluded by ${ex}` : null;
}

/**
 * Evaluate one alert against one policy. `item` is { alert, instances[] }: the alert JSON plus every instance
 * found for it (default branch and PR refs, deduped by alert number). Returns a record; throws ToolError on a
 * gh/git problem with this alert (the caller reports ERROR for it alone) and MainError when the default branch
 * itself is unavailable (the caller fails the whole policy closed).
 * The tripwire must hold at EVERY instance's commit and at the default branch.
 * `mainCache` (optional) reuses the default-branch tripwire result across alerts.
 */
function evaluateAlert(ctx, policy, item, mainCache) {
  const { alert, instances } = item;
  const primary = instances[0];
  const rec = {
    status: null,
    alert: alert.number,
    policy: policy.id,
    rule: policy.rule,
    tool: alert.tool ? alert.tool.name : null,
    severity: (alert.rule && (alert.rule.security_severity_level || alert.rule.severity)) || null,
    html_url: alert.html_url || null,
    pr: primary.pr,
    path: primary.path || null,
    line: primary.line,
    sha: primary.sha || null,
    instances,
    tripwire: [],
    reason: null,
  };
  if (!Number.isInteger(alert.number)) throw new ToolError('alert has no numeric id');
  for (const inst of instances) {
    if (typeof inst.path !== 'string' || !inst.path) throw new ToolError('alert has no location path');
    if (typeof inst.sha !== 'string' || !SHA_RE.test(inst.sha)) throw new ToolError('alert has no valid most_recent_instance.commit_sha');
  }
  for (const inst of instances) {
    const why = scopeReason(policy, inst.path);
    if (why) { Object.assign(rec, { status: 'OUT_OF_SCOPE', reason: why, pr: inst.pr, path: inst.path, line: inst.line, sha: inst.sha }); return rec; }
  }

  const mainSha = ensureMain(ctx);
  rec.main_sha = mainSha;
  const seen = new Set();
  const distinct = instances.filter((i) => !seen.has(i.sha) && seen.add(i.sha));
  for (const inst of distinct) ensureCommit(ctx, inst.sha, inst.ref, inst.pr);
  let mainChecks = mainCache && mainCache.get(policy.id);
  if (!mainChecks) {
    try {
      mainChecks = evalTripwire(ctx, mainSha, 'main', policy);
    } catch (e) {
      throw new MainError(`default branch tripwire could not be evaluated (fail-closed): ${e.message}`);
    }
    if (mainCache) mainCache.set(policy.id, mainChecks);
  }
  rec.tripwire = [...distinct.flatMap((inst) => evalTripwire(ctx, inst.sha, 'commit', policy, inst.pr)), ...mainChecks];
  rec.status = rec.tripwire.some((c) => !c.ok) ? 'TRIPWIRE_FAILED' : 'CANDIDATE';
  return rec;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv, spec) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const def = spec[a];
    if (!def) throw new UsageError(`unknown arg: ${a}`);
    if (def.flag) o[def.key] = true;
    else {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      o[def.key] = argv[++i];
    }
  }
  return o;
}
class UsageError extends Error {}

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ToolError(`cannot read config ${file}: ${e.code || e.message}`);
  }
  const { values, errors } = readTopLevel(text, ['fp_policies', 'default_branch', 'state_dir']);
  if (errors.fp_policies) throw new ToolError(`config fp_policies: ${errors.fp_policies}`);
  const scalar = (k) => (typeof values[k] === 'string' && values[k] ? values[k] : null);
  return {
    policies: validatePolicies(values.fp_policies),
    defaultBranch: scalar('default_branch') || 'main',
    stateDir: scalar('state_dir'),
  };
}

function checkCommon(o, needConfig = true) {
  if (!o.repo || !REPO_RE.test(o.repo)) throw new UsageError('--repo owner/name is required');
  if (needConfig && !o.config) throw new UsageError('--config FILE is required');
  if (o.defaultBranch !== undefined && !BRANCH_RE.test(o.defaultBranch)) throw new UsageError(`invalid --default-branch: ${o.defaultBranch}`);
}

function textLines(records) {
  const lines = [];
  const prSuffix = (pr) => (pr ? ` pr=${pr}` : '');
  for (const r of records) {
    if (r.status === 'CANDIDATE') lines.push(`CANDIDATE ${r.alert} ${r.policy} ${r.path}:${r.line} ${r.sha}${prSuffix(r.pr)}`);
    else if (r.status === 'OUT_OF_SCOPE') lines.push(`OUT_OF_SCOPE ${r.alert} ${r.policy} ${r.path} ${oneLine(r.reason)}${prSuffix(r.pr)}`);
    else if (r.status === 'TRIPWIRE_FAILED') {
      for (const c of r.tripwire.filter((x) => !x.ok)) lines.push(`TRIPWIRE_FAILED ${r.alert} ${r.policy} ${c.type}#${c.index} ${c.where} ${oneLine(c.detail)}${prSuffix(c.pr)}`);
    } else lines.push(`ERROR ${oneLine(r.reason)}`);
  }
  return lines;
}

/** A policy-level error (or, with policy null, a config-level one). */
function errRec(policy, reason) {
  return { status: 'ERROR', alert: null, pr: null, policy, reason: `${policy ? `policy ${policy}: ` : ''}${reason}` };
}
/** An error confined to one alert: the policy's other alerts still evaluate. */
function alertErr(policy, alert, reason) {
  return { status: 'ERROR', alert, pr: null, policy, reason: `alert ${alert}: ${reason}` };
}

const PRS_RE = /^(all|none|[1-9][0-9]*(,[1-9][0-9]*)*)$/;

function cmdCandidates(argv) {
  const o = parseArgs(argv, {
    '--repo': { key: 'repo' }, '--config': { key: 'config' }, '--policy': { key: 'policy' }, '--json': { key: 'json', flag: true },
    '--repo-dir': { key: 'repoDir' }, '--default-branch': { key: 'defaultBranch' }, '--prs': { key: 'prs' },
  });
  checkCommon(o);
  o.prs = o.prs ?? 'all';
  if (!PRS_RE.test(o.prs)) throw new UsageError('--prs must be all, none, or a comma-separated list of PR numbers');
  const records = [];
  let cfg;
  try {
    cfg = loadConfig(o.config);
  } catch (e) {
    records.push(errRec(null, e.message));
    return finish(records, o.json);
  }
  let selected = cfg.policies;
  if (o.policy) {
    selected = cfg.policies.filter((r) => (r.ok ? r.policy.id : r.label) === o.policy);
    if (selected.length === 0) records.push(errRec(o.policy, 'not found in fp_policies'));
  }
  const valid = [];
  for (const r of selected) {
    if (r.ok) valid.push(r.policy);
    else records.push(errRec(r.label, `invalid policy, no candidates: ${r.errors.join('; ')}`));
  }
  if (valid.length === 0) return finish(records, o.json);

  const ctx = makeCtx({ repoDir: o.repoDir || '.', repo: o.repo, defaultBranch: o.defaultBranch || cfg.defaultBranch });

  // Alerts by number: the default branch first, then each open PR's ref. An alert seen on several refs keeps
  // every instance, and the tripwire is evaluated at each of them.
  const items = new Map();
  const add = (alert, pr) => {
    if (!alert || !Number.isInteger(alert.number)) return;
    const inst = instanceOf(alert, pr);
    const cur = items.get(alert.number);
    if (!cur) items.set(alert.number, { alert, instances: [inst] });
    else if (!cur.instances.some((x) => x.sha === inst.sha && x.path === inst.path && x.line === inst.line)) cur.instances.push(inst);
  };
  try {
    for (const a of listOpenAlerts(o.repo)) add(a, null);
  } catch (e) {
    // Affects every alert: fail every policy closed.
    for (const p of valid) records.push(errRec(p.id, `cannot list the default branch's alerts: ${e.message}`));
    return finish(records, o.json);
  }
  let prs = [];
  if (o.prs === 'all') {
    try {
      prs = listOpenPrs(o.repo);
    } catch (e) {
      records.push(errRec(null, `cannot list open PRs, so no PR was scanned: ${e.message}`));
    }
  } else if (o.prs !== 'none') prs = o.prs.split(',').map(Number);
  for (const pr of prs) {
    try {
      for (const a of listPrAlerts(o.repo, pr)) add(a, pr);
    } catch (e) {
      records.push({ status: 'ERROR', alert: null, pr, policy: null, reason: `pr ${pr}: could not list code-scanning alerts: ${e.message}` });
    }
  }

  const ordered = [...items.values()].sort((x, y) => x.alert.number - y.alert.number);
  const mainCache = new Map();
  for (const policy of valid) {
    const mine = ordered.filter((it) => policyCovers(policy, it.alert));
    const polRecs = [];
    let wide = false;
    for (const it of mine) {
      try {
        polRecs.push(evaluateAlert(ctx, policy, it, mainCache));
      } catch (e) {
        if (e instanceof MainError) {
          // Affects every alert of the policy: fail it closed.
          polRecs.push(errRec(policy.id, e.message));
          wide = true;
          break;
        }
        polRecs.push(alertErr(policy.id, it.alert.number, e.message));
      }
    }
    records.push(...(wide ? polRecs.filter((r) => r.status !== 'CANDIDATE') : polRecs));
  }
  return finish(records, o.json);
}

function finish(records, asJson) {
  if (asJson) process.stdout.write(JSON.stringify(records, null, 2) + '\n');
  else for (const l of textLines(records)) process.stdout.write(l + '\n');
  return records.some((r) => r.status === 'ERROR') ? 1 : 0;
}

const MAX_COMMENT = 280;
const MAX_EVIDENCE = 200;

function fitComment(s) {
  const cps = Array.from(s);
  if (s.length <= MAX_COMMENT && cps.length <= MAX_COMMENT) return s;
  let out = cps;
  while (out.join('').length > MAX_COMMENT - 1) out = out.slice(0, -1);
  return out.join('') + '…';
}

function cmdDismiss(argv) {
  const o = parseArgs(argv, {
    '--repo': { key: 'repo' }, '--config': { key: 'config' }, '--alert': { key: 'alert' }, '--policy': { key: 'policy' },
    '--shape': { key: 'shape' }, '--evidence': { key: 'evidence' }, '--state-dir': { key: 'stateDir' },
    '--repo-dir': { key: 'repoDir' }, '--default-branch': { key: 'defaultBranch' },
  });
  checkCommon(o);
  if (!/^[1-9][0-9]*$/.test(o.alert || '')) throw new UsageError('--alert N (a positive integer) is required');
  if (!o.policy) throw new UsageError('--policy ID is required');
  if (!isStr(o.shape)) throw new UsageError('--shape is required (one of the policy\'s known_fp_shapes, verbatim)');
  if (!isStr(o.evidence)) throw new UsageError('--evidence is required (one line: what the code does)');
  const alertNo = Number(o.alert);
  const refuse = (why) => {
    process.stdout.write(`REFUSED ${alertNo} ${o.policy} ${oneLine(why, 600)}\n`);
    return 1;
  };

  let cfg;
  try {
    cfg = loadConfig(o.config);
  } catch (e) {
    return refuse(e.message);
  }
  const entry = cfg.policies.find((r) => (r.ok ? r.policy.id : r.label) === o.policy);
  if (!entry) return refuse('policy not found in fp_policies');
  if (!entry.ok) return refuse(`policy is invalid: ${entry.errors.join('; ')}`);
  const policy = entry.policy;
  if (!policy.known_fp_shapes.includes(o.shape)) return refuse('--shape does not exactly equal one of the policy known_fp_shapes');
  const evidence = oneLine(o.evidence, MAX_EVIDENCE);

  const stateDir = o.stateDir || cfg.stateDir;
  if (!stateDir) return refuse('no state dir for the disposition journal (pass --state-dir or set state_dir in the config)');
  const journal = path.join(stateDir, 'fp-dispositions.jsonl');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.closeSync(fs.openSync(journal, 'a'));
  } catch (e) {
    return refuse(`cannot write the disposition journal ${journal}: ${e.code || e.message}`);
  }

  let alert;
  try {
    alert = ghJson([`repos/${o.repo}/code-scanning/alerts/${alertNo}`]);
  } catch (e) {
    return refuse(`cannot re-read the alert: ${e.message}`);
  }
  if (!isPlain(alert) || alert.number !== alertNo) return refuse('re-read alert does not match the requested alert number');
  if (alert.state !== 'open') return refuse(`alert is already closed (state: ${alert.state})`);
  if (!policyCovers(policy, alert)) return refuse('alert rule/tool is not covered by this policy');

  const ctx = makeCtx({ repoDir: o.repoDir || '.', repo: o.repo, defaultBranch: o.defaultBranch || cfg.defaultBranch });
  let rec;
  try {
    rec = evaluateAlert(ctx, policy, { alert, instances: [instanceOf(alert, null)] }, null);
  } catch (e) {
    return refuse(`re-check failed (fail-closed): ${e.message}`);
  }
  if (rec.status === 'OUT_OF_SCOPE') return refuse(`alert is out of scope: ${rec.reason}`);
  if (rec.status === 'TRIPWIRE_FAILED') {
    const bad = rec.tripwire.filter((c) => !c.ok).map((c) => `${c.type}#${c.index} @${c.where}: ${c.detail}`);
    return refuse(`tripwire now failing: ${bad.join(' | ')}`);
  }

  const comment = fitComment(`fp-policy ${policy.id}: ${o.shape} — ${evidence}`);
  const res = gh([
    'api', '-X', 'PATCH', `repos/${o.repo}/code-scanning/alerts/${alertNo}`,
    '-f', 'state=dismissed', '-f', 'dismissed_reason=false positive', '-f', `dismissed_comment=${comment}`,
  ]);
  if (!res.ok) {
    if (/HTTP 403|Resource not accessible/i.test(res.stderr + res.stdout)) {
      process.stdout.write(`ERROR alert ${alertNo} not dismissed: HTTP 403. Dismissing code-scanning alerts needs the GitHub App permission "Code scanning alerts: Read and write" (security_events: write); add it to the App, accept it on the installation, and list it in GH_APP_REQUIRED_PERMS (core/fleet/identity/README.md).\n`);
    } else {
      process.stdout.write(`ERROR alert ${alertNo} not dismissed: ${oneLine(res.stderr || res.stdout)}\n`);
    }
    return 1;
  }
  const line = {
    ts: new Date().toISOString(),
    alert: alertNo,
    policy: policy.id,
    sha: rec.sha,
    pr: rec.pr,
    path: rec.path,
    line: rec.line,
    shape: o.shape,
    evidence,
    html_url: rec.html_url,
    comment,
  };
  try {
    fs.appendFileSync(journal, JSON.stringify(line) + '\n');
  } catch (e) {
    process.stdout.write(`DISMISSED ${alertNo} ${policy.id} ${rec.path}:${rec.line} ${rec.sha}${rec.pr ? ` pr=${rec.pr}` : ''}\nERROR the alert WAS dismissed but the journal write failed (${e.code || e.message}); record it in the ledger by hand: ${JSON.stringify(line)}\n`);
    return 1;
  }
  process.stdout.write(`DISMISSED ${alertNo} ${policy.id} ${rec.path}:${rec.line} ${rec.sha}${rec.pr ? ` pr=${rec.pr}` : ''}\n`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'candidates') return cmdCandidates(rest);
    if (cmd === 'dismiss') return cmdDismiss(rest);
    throw new UsageError('usage: mnt-fp.mjs candidates|dismiss ...');
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    process.stdout.write(`ERROR ${oneLine(e && e.message ? e.message : e)}\n`);
    return 1;
  }
}

// Run only when executed directly, so the readers above stay importable.
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
