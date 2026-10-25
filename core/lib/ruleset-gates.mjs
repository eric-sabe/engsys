#!/usr/bin/env node
// ruleset-gates.mjs — which PRs a branch ruleset puts behind a required review, known up front (engsys#271).
//
// A ruleset's pull_request rule can carry path-based `required_reviewers`: changes matching `file_patterns` need
// `minimum_approvals` approving reviews from `reviewer` (a team). Keystone's main ruleset puts `.claude/**`,
// `infrastructure/**`, `.github/workflows/**`, the ADRs and more behind FeedFrwd/fleet-operators. Merge Monster used to
// find that out only at BLOCKED (checks green, then reviews, rollup, rulesets, the team id), several API calls and a
// delay per PR before it asked the operator. mm-preflight.sh asks this instead, and a matching PR is operator-gated at
// READY, with or without a handoff `operator_gate`.
//
//   ruleset-gates.mjs gate --repo owner/name --base BRANCH [--cache-dir DIR] [--ttl-sec N]   < ["path", …]
//     → {"gated":true,"rules":[{"rulesetId":N,"reviewer":{"type":"Team","id":N},"minimumApprovals":N,"files":[…≤10]}]}
//       {"gated":false} when no rule matches, {"gated":false,"unreadable":"<why>"} when the rules can't be read.
//
// The rules come from GET /repos/{repo}/rules/branches/{base} (the active rules that apply to the branch, every ruleset
// merged, each tagged with its ruleset_id), read once per repo and base and cached for --ttl-sec (default 600, about one
// merge-monster tick; MM_RULESET_TTL_SEC) in --cache-dir (MM_RULESET_CACHE_DIR, else $FLEET_STATE/mm-rulesets, else the
// OS temp dir), so a tick's preflights cost one call. An unreadable answer infers nothing (gated false, `unreadable`
// says why) and is never cached: the gate then shows up at BLOCKED as before. Exit 0 always, except usage (2).
//
// Patterns follow GitHub's fnmatch reading of file_patterns (File::FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB): `*` and
// `?` stay inside one path segment and match dotfiles; `**` as a whole segment crosses directories (`**/x` also at the
// root, `x/**` everything under x); `**` inside a segment is just `*` (it never crosses `/`, so it never over-gates);
// `[abc]`, `[a-z]`, `[!abc]` / `[^abc]` classes; `{a,b}` alternatives (not nested); `\x` escapes. Anything else (a
// leading `!` negation, an unterminated class or brace, nested braces) is reported as `unknown` with the ruleset and
// pattern, logged on stderr, and never pre-gates: the PR then meets that rule at BLOCKED as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMainEntry } from './is-main.mjs';

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,250}$/;

/** The path-review rules among a branch's rules: [{ rulesetId, reviewer, minimumApprovals, patterns }]. */
export function reviewerRules(branchRules) {
  const out = [];
  for (const r of Array.isArray(branchRules) ? branchRules : []) {
    if (r?.type !== 'pull_request') continue;
    for (const rr of r.parameters?.required_reviewers ?? []) {
      const patterns = (rr?.file_patterns ?? []).filter((p) => typeof p === 'string' && p.trim());
      if (!patterns.length || !rr?.reviewer) continue;
      out.push({
        rulesetId: r.ruleset_id ?? null,
        reviewer: { type: rr.reviewer.type ?? null, id: rr.reviewer.id ?? null },
        minimumApprovals: rr.minimum_approvals ?? 1,
        patterns,
      });
    }
  }
  return out;
}

const MAX_EXPANSIONS = 64;

/** `{a,b}` alternatives (EXTGLOB), not nested → [strings]; throws on nesting, an unterminated brace or too many. */
function expandBraces(p) {
  let out = [''];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { out = out.map((o) => o + p.slice(i, i + 2)); i++; continue; }
    if (c === '}') throw new Error('unbalanced }');
    if (c !== '{') { out = out.map((o) => o + c); continue; }
    const end = p.indexOf('}', i);
    if (end < 0) throw new Error('unterminated {');
    const body = p.slice(i + 1, end);
    if (body.includes('{')) throw new Error('nested braces');
    const alts = body.split(',');
    out = out.flatMap((o) => alts.map((a) => o + a));
    if (out.length > MAX_EXPANSIONS) throw new Error(`more than ${MAX_EXPANSIONS} brace alternatives`);
    i = end;
  }
  return out;
}

const esc = (c) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** One path segment (no `/`) → regex source; throws on an unterminated class. */
function segmentSource(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\') { if (i + 1 < seg.length) re += esc(seg[++i]); else re += esc('\\'); continue; }
    if (c === '*') { while (seg[i + 1] === '*') i++; re += '[^/]*'; continue; } // `**` inside a segment is `*`
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (seg[j] === '!' || seg[j] === '^') { neg = true; j++; }
      let body = '';
      if (seg[j] === ']') { body += '\\]'; j++; }
      for (; j < seg.length && seg[j] !== ']'; j++) body += seg[j] === '\\' ? (j + 1 < seg.length ? esc(seg[++j]) : '\\\\') : seg[j] === '-' ? '-' : esc(seg[j]);
      if (j >= seg.length) throw new Error('unterminated [');
      re += neg ? `[^/${body}]` : `(?!/)[${body}]`;
      i = j;
      continue;
    }
    re += esc(c);
  }
  return re;
}

/**
 * A ruleset file pattern → { re } or { unknown: why } (GitHub's fnmatch: FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB; see
 * the header). Unknown syntax never matches.
 */
export function compilePattern(pattern) {
  const p = String(pattern ?? '').trim().replace(/^\/+/, '');
  if (!p) return { unknown: 'empty pattern' };
  if (p.startsWith('!')) return { unknown: 'negation (!) is not supported' };
  try {
    const alts = expandBraces(p).map((one) => {
      const segs = one.split('/');
      let src = '';
      segs.forEach((seg, k) => {
        const last = k === segs.length - 1;
        if (seg === '**') src += last ? (k === 0 ? '.*' : '.+') : '(?:[^/]*/)*';
        else src += segmentSource(seg) + (last ? '' : '/');
      });
      return src;
    });
    return { re: new RegExp(`^(?:${alts.join('|')})$`) };
  } catch (e) {
    return { unknown: e.message };
  }
}

/**
 * The rules a PR's changed files hit → { gated, rules: [{ rulesetId, reviewer, minimumApprovals, files }], unknown? }.
 * `unknown` lists the patterns that were not understood ({ rulesetId, pattern, why }): they never gate.
 */
export function matchRules(rules, files) {
  const paths = [...new Set((files ?? []).filter((f) => typeof f === 'string' && f))];
  const hits = [];
  const unknown = [];
  for (const rule of rules) {
    const res = [];
    for (const p of rule.patterns) {
      const c = compilePattern(p);
      if (c.re) res.push(c.re); else unknown.push({ rulesetId: rule.rulesetId, pattern: p, why: c.unknown });
    }
    const matched = paths.filter((f) => res.some((re) => re.test(f)));
    if (matched.length) hits.push({ rulesetId: rule.rulesetId, reviewer: rule.reviewer, minimumApprovals: rule.minimumApprovals, files: matched.slice(0, 10) });
  }
  return { gated: hits.length > 0, rules: hits, ...(unknown.length ? { unknown } : {}) };
}

function cacheDir(flag, env) {
  if (flag) return flag;
  if (env.MM_RULESET_CACHE_DIR) return env.MM_RULESET_CACHE_DIR;
  if (env.FLEET_STATE) return path.join(env.FLEET_STATE, 'mm-rulesets');
  return path.join(os.tmpdir(), `engsys-mm-rulesets-${process.getuid?.() ?? 'u'}`);
}

/** The branch's path-review rules, cached; throws with a reason when GitHub can't be read. */
export function loadRules({ repo, base, dir, ttlSec, env = process.env, now = Date.now() }) {
  const file = path.join(dir, `${repo.replace('/', '__')}__${base.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(c.rules) && now - c.fetchedAt >= 0 && now - c.fetchedAt < ttlSec * 1000) return c.rules;
  } catch { /* no cache yet */ }
  const r = spawnSync(env.FLEET_GH || 'gh', ['api', `repos/${repo}/rules/branches/${encodeURI(base)}`, '--paginate', '--jq', '.[]'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24, env });
  if (r.error || r.status !== 0) throw new Error(String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200));
  const branchRules = r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const rules = reviewerRules(branchRules);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, rules }), { mode: 0o600 });
  } catch { /* an unwritable cache only costs a call */ }
  return rules;
}

export function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr, stdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  const [cmd, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, options: { repo: { type: 'string' }, base: { type: 'string' }, 'cache-dir': { type: 'string' }, 'ttl-sec': { type: 'string' } } }));
  } catch (e) { err.write(`ruleset-gates: ${e.message}\n`); return 2; }
  if (cmd !== 'gate' || !REPO_RE.test(values.repo ?? '') || !BRANCH_RE.test(values.base ?? '')) {
    err.write('usage: ruleset-gates.mjs gate --repo owner/name --base BRANCH [--cache-dir DIR] [--ttl-sec N] < ["path", …]\n');
    return 2;
  }
  const ttl = Number(values['ttl-sec'] ?? env.MM_RULESET_TTL_SEC ?? 600);
  let files;
  try { files = JSON.parse(stdin() || '[]'); } catch { files = null; }
  if (!Array.isArray(files)) { out.write(`${JSON.stringify({ gated: false, unreadable: 'the changed-file list is not a JSON array' })}\n`); return 0; }
  let rules;
  try {
    rules = loadRules({ repo: values.repo, base: values.base, dir: cacheDir(values['cache-dir'], env), ttlSec: Number.isFinite(ttl) && ttl >= 0 ? ttl : 600, env });
  } catch (e) {
    out.write(`${JSON.stringify({ gated: false, unreadable: `rulesets: ${e.message}` })}\n`);
    return 0;
  }
  const m = matchRules(rules, files);
  for (const u of m.unknown ?? []) err.write(`ruleset-gates: ruleset ${u.rulesetId} pattern ${JSON.stringify(u.pattern)} not understood (${u.why}); not pre-gated on it\n`);
  out.write(`${JSON.stringify(m.gated ? m : { gated: false, ...(m.unknown ? { unknown: m.unknown } : {}) })}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = main();
