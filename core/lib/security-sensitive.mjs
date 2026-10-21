#!/usr/bin/env node
// security-sensitive.mjs — decides, from the repo's merge-monster config, whether a PR needs a signed security
// verdict (engsys#229). mm-preflight.sh runs it so the requirement is not left to the merge session, which reads
// attacker-authored PR content and could omit --require-security-verdict (by injection or by mistake).
//
//   security-sensitive.mjs policy --config FILE
//       → {"signedVerdict":bool,"globs":N,"label":"security","reviewLabel":"security-review-requested","reviewLabelSet":bool}
//         (config keys: ready_requirements.signed_security_verdict, security_sensitive_globs, security_sensitive_label,
//         security_review_label; reviewLabelSet says whether the config names the review label itself)
//   security-sensitive.mjs decide [--config FILE] < {"files":[{filename,previous_filename?}],"changedFiles":N,"labels":[...]}
//       → {"ok":true,"required":bool,"reasons":[...],"matched":[<=20 paths]}
//   security-sensitive.mjs review-label --repo owner/name [--config FILE]...
//       → the review request label alone, one line (engsys#231): security_review_label from the first of the merge configs
//         mm-preflight.sh reads ($ENGSYS_MM_CONFIG, .claude/merge-monster.yml in the cwd, the fleet-config-dir copy, then
//         each --config) that sets it, else security-review-requested. Two sources naming different labels, or a review
//         label equal to any source's security_sensitive_label, is exit 1 with a reason. One resolver for the merge
//         monster's tick and bus and for the maintenance monster, so both sides watch the label preflight names.
//
// A PR needs the verdict when it carries the label (default `security`) or when ANY changed file matches a glob,
// by its new path and by its old path (a rename out of a sensitive directory still counts). Fail closed: an
// unreadable config, a file list shorter than the PR's changed_files, or an unusable count is exit 1 with a reason; a
// PR with more than 3000 files (the most GitHub lists) cannot be listed in full, so it requires the verdict.
//
// Glob dialect (fleet contract): `*` and `?` stay inside one path segment; `**` crosses segments; `**/x` also matches a
// root-level `x`; `x/**` matches everything under `x/`; every other character is LITERAL (parentheses, brackets, dots,
// so Next.js route groups `(auth)` and dynamic segments `[id]` or `[...nextauth]` match themselves). No braces.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve as resolveFleetConfig, defaultConfigDirs } from './mm-config.mjs';

const require = createRequire(import.meta.url);
const { parseYaml } = require('./yaml.js');

export const GITHUB_FILE_LIMIT = 3000;
export const DEFAULT_LABEL = 'security';
/** The label that asks the security lane for a signed verdict (engsys#231): merge-monster adds it, maintenance removes it. */
export const DEFAULT_REVIEW_LABEL = 'security-review-requested';

const esc = (c) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** A glob → anchored RegExp (see the dialect above). */
export function compileGlob(glob) {
  let re = '';
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; continue; }
    if (glob.startsWith('**', i)) { re += '.*'; i += 2; continue; }
    const c = glob[i++];
    re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : esc(c);
  }
  return new RegExp(`^${re}$`);
}

/** → { signedVerdict, globs: [string], label, reviewLabel, reviewLabelSet }. Throws on a config that cannot be read or has malformed keys. */
export function loadPolicy(text) {
  const cfg = parseYaml(text);
  if (!cfg || typeof cfg !== 'object') throw new Error('config is not a mapping');
  const g = cfg.security_sensitive_globs ?? [];
  if (!Array.isArray(g) || g.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('security_sensitive_globs must be a list of non-empty strings');
  const label = cfg.security_sensitive_label ?? DEFAULT_LABEL;
  if (typeof label !== 'string' || !label.trim()) throw new Error('security_sensitive_label must be a non-empty string');
  const reviewLabel = cfg.security_review_label ?? DEFAULT_REVIEW_LABEL;
  if (typeof reviewLabel !== 'string' || !reviewLabel.trim()) throw new Error('security_review_label must be a non-empty string');
  if (reviewLabel.trim().toLowerCase() === label.trim().toLowerCase()) throw new Error('security_review_label must differ from security_sensitive_label (removing the request would drop the requirement)');
  const rr = cfg.ready_requirements;
  return {
    signedVerdict: Boolean(rr && typeof rr === 'object' && rr.signed_security_verdict === true), globs: g.map((x) => x.trim()), label: label.trim(),
    reviewLabel: reviewLabel.trim(), reviewLabelSet: cfg.security_review_label != null,
  };
}

/** → { required, reasons, matched }. Throws Error('security_file_list_unreadable: ...') when the list can't be trusted. */
export function decide(policy, { files, changedFiles, labels }) {
  const reasons = [];
  const matched = [];
  const labelWant = policy.label.toLowerCase();
  if ((Array.isArray(labels) ? labels : []).some((l) => String(l?.name ?? l).toLowerCase() === labelWant)) reasons.push(`label:${policy.label}`);
  if (policy.globs.length) {
    if (!Number.isInteger(changedFiles) || changedFiles < 0) throw new Error('security_file_list_unreadable: the PR changed_files count is unusable');
    if (!Array.isArray(files)) throw new Error('security_file_list_unreadable: no file list');
    if (changedFiles > GITHUB_FILE_LIMIT) reasons.push(`changed_files_over_${GITHUB_FILE_LIMIT}`);
    else if (files.length < changedFiles) throw new Error(`security_file_list_unreadable: ${files.length} of ${changedFiles} changed files listed`);
    const res = policy.globs.map((g) => [g, compileGlob(g)]);
    for (const f of files) {
      for (const p of [f?.filename, f?.previous_filename]) {
        if (typeof p !== 'string' || !p) continue;
        const hit = res.find(([, re]) => re.test(p));
        if (hit && !matched.includes(p)) { matched.push(p); if (!reasons.includes(`glob:${hit[0]}`)) reasons.push(`glob:${hit[0]}`); }
      }
    }
  }
  return { required: reasons.length > 0, reasons, matched: matched.slice(0, 20) };
}

/**
 * The review label from config texts [{ source, text }] (engsys#231). The first that sets security_review_label wins; a
 * second naming a different label throws, and so does a review label equal to ANY source's security_sensitive_label
 * (loadPolicy checks that within one file only): removing the request must never remove the requirement.
 * → { label, source }
 */
export function reviewLabelOf(configs) {
  let label = null;
  let source = null;
  const sensitive = [];
  for (const c of configs) {
    let p;
    try { p = loadPolicy(c.text); } catch (e) { throw new Error(`security_config_unreadable: ${c.source}: ${e.message}`); }
    sensitive.push({ label: p.label, source: c.source });
    if (!p.reviewLabelSet) continue;
    if (label === null) { label = p.reviewLabel; source = c.source; continue; }
    if (p.reviewLabel.toLowerCase() !== label.toLowerCase()) {
      throw new Error(`security_config_unreadable: security_review_label is '${label}' in ${source} but '${p.reviewLabel}' in ${c.source}`);
    }
  }
  const out = label === null ? { label: DEFAULT_REVIEW_LABEL, source: 'default' } : { label, source };
  const clash = sensitive.find((x) => x.label.toLowerCase() === out.label.toLowerCase());
  if (clash) throw new Error(`security_config_unreadable: the review label '${out.label}' is the security_sensitive_label of ${clash.source}`);
  return out;
}

/** How long a security-review request may go unanswered before the merge monster escalates it (engsys#246). */
export const DEFAULT_REVIEW_ESCALATE_MINUTES = 30;

/**
 * security_review_escalate_minutes from config texts [{ source, text }] (engsys#246): the first that sets it wins (the
 * same order as the review label), else DEFAULT_REVIEW_ESCALATE_MINUTES; 0 turns the escalation off. A value that is
 * not a whole number of minutes, or a config that does not parse, is reported as `warning` and never fails the caller:
 * the default applies, because an escalation that silently stopped is the failure this setting exists to prevent.
 * → { minutes, source, warning }
 */
export function reviewEscalateMinutesOf(configs) {
  const warnings = [];
  for (const c of configs) {
    let cfg;
    try { cfg = parseYaml(c.text); } catch (e) { warnings.push(`${c.source}: ${e.message}`); continue; }
    const v = cfg && typeof cfg === 'object' ? cfg.security_review_escalate_minutes : undefined;
    if (v === undefined || v === null) continue;
    if (Number.isSafeInteger(v) && v >= 0) return { minutes: v, source: c.source, warning: warnings.join('; ') };
    warnings.push(`${c.source}: security_review_escalate_minutes must be a whole number of minutes (0 = off), got ${JSON.stringify(v)}`);
    break;
  }
  return { minutes: DEFAULT_REVIEW_ESCALATE_MINUTES, source: 'default', warning: warnings.join('; ') };
}

/** The merge configs mm-preflight.sh reads, in its order, each read now: [{ source, text }]. An unreadable one throws. */
export function discoverConfigs({ repo, extra = [], env = process.env, cwd = process.cwd() }) {
  const paths = [];
  if (env.ENGSYS_MM_CONFIG) paths.push(env.ENGSYS_MM_CONFIG);
  const inRepo = path.join(cwd, '.claude', 'merge-monster.yml');
  if (fs.existsSync(inRepo)) paths.push(inRepo);
  paths.push(...resolveFleetConfig({ slug: repo, configDirs: defaultConfigDirs(env) }).configs);
  paths.push(...extra);
  return paths.map((p) => {
    try { return { source: p, text: fs.readFileSync(p, 'utf8') }; } catch (e) { throw new Error(`security_config_unreadable: ${p}: ${e.message}`); }
  });
}

function readStdin() { return fs.readFileSync(0, 'utf8'); }
function fail(reason) { process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`); process.exit(1); }

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'review-label') {
    let repo = '';
    const extra = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--repo') repo = rest[++i] ?? '';
      else if (rest[i] === '--config') extra.push(rest[++i] ?? '');
      else fail(`unknown argument: ${rest[i]}`);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('usage: security-sensitive.mjs review-label --repo owner/name [--config FILE]...');
    try { process.stdout.write(`${reviewLabelOf(discoverConfigs({ repo, extra: extra.filter(Boolean) })).label}\n`); } catch (e) { fail(e.message); }
    return;
  }
  let config = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config') config = rest[++i] ?? '';
    else fail(`unknown argument: ${rest[i]}`);
  }
  let policy;
  if (config) {
    try { policy = loadPolicy(fs.readFileSync(config, 'utf8')); } catch (e) { fail(`security_config_unreadable: ${e.message}`); }
  } else policy = { signedVerdict: false, globs: [], label: DEFAULT_LABEL, reviewLabel: DEFAULT_REVIEW_LABEL, reviewLabelSet: false };
  if (cmd === 'policy') {
    const { signedVerdict, label, reviewLabel, reviewLabelSet } = policy;
    process.stdout.write(`${JSON.stringify({ signedVerdict, globs: policy.globs.length, label, reviewLabel, reviewLabelSet })}\n`);
    return;
  }
  if (cmd === 'decide') {
    let input;
    try { input = JSON.parse(readStdin()); } catch { fail('security_file_list_unreadable: input is not JSON'); }
    try { process.stdout.write(`${JSON.stringify({ ok: true, ...decide(policy, input ?? {}) })}\n`); } catch (e) { fail(e.message); }
    return;
  }
  fail('usage: security-sensitive.mjs policy|decide [--config FILE] | review-label --repo owner/name [--config FILE]...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
