#!/usr/bin/env node
// security-sensitive.mjs — decides, from the repo's merge-monster config, whether a PR needs a signed security
// verdict (engsys#229). mm-preflight.sh runs it so the requirement is not left to the merge session, which reads
// attacker-authored PR content and could omit --require-security-verdict (by injection or by mistake).
//
//   security-sensitive.mjs policy --config FILE
//       → {"signedVerdict":bool,"globs":N,"label":"security"}   (config keys: ready_requirements.signed_security_verdict,
//         security_sensitive_globs, security_sensitive_label)
//   security-sensitive.mjs decide [--config FILE] < {"files":[{filename,previous_filename?}],"changedFiles":N,"labels":[...]}
//       → {"ok":true,"required":bool,"reasons":[...],"matched":[<=20 paths]}
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

const require = createRequire(import.meta.url);
const { parseYaml } = require('./yaml.js');

export const GITHUB_FILE_LIMIT = 3000;
export const DEFAULT_LABEL = 'security';

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

/** → { signedVerdict, globs: [string], label }. Throws on a config that cannot be read or has malformed keys. */
export function loadPolicy(text) {
  const cfg = parseYaml(text);
  if (!cfg || typeof cfg !== 'object') throw new Error('config is not a mapping');
  const g = cfg.security_sensitive_globs ?? [];
  if (!Array.isArray(g) || g.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('security_sensitive_globs must be a list of non-empty strings');
  const label = cfg.security_sensitive_label ?? DEFAULT_LABEL;
  if (typeof label !== 'string' || !label.trim()) throw new Error('security_sensitive_label must be a non-empty string');
  const rr = cfg.ready_requirements;
  return { signedVerdict: Boolean(rr && typeof rr === 'object' && rr.signed_security_verdict === true), globs: g.map((x) => x.trim()), label: label.trim() };
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

function readStdin() { return fs.readFileSync(0, 'utf8'); }
function fail(reason) { process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`); process.exit(1); }

function main(argv) {
  const [cmd, ...rest] = argv;
  let config = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config') config = rest[++i] ?? '';
    else fail(`unknown argument: ${rest[i]}`);
  }
  let policy;
  if (config) {
    try { policy = loadPolicy(fs.readFileSync(config, 'utf8')); } catch (e) { fail(`security_config_unreadable: ${e.message}`); }
  } else policy = { signedVerdict: false, globs: [], label: DEFAULT_LABEL };
  if (cmd === 'policy') {
    process.stdout.write(`${JSON.stringify({ signedVerdict: policy.signedVerdict, globs: policy.globs.length, label: policy.label })}\n`);
    return;
  }
  if (cmd === 'decide') {
    let input;
    try { input = JSON.parse(readStdin()); } catch { fail('security_file_list_unreadable: input is not JSON'); }
    try { process.stdout.write(`${JSON.stringify({ ok: true, ...decide(policy, input ?? {}) })}\n`); } catch (e) { fail(e.message); }
    return;
  }
  fail('usage: security-sensitive.mjs policy|decide [--config FILE]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
