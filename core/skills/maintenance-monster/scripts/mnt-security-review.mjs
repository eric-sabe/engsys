#!/usr/bin/env node
// mnt-security-review.mjs — the security-review requests the maintenance monster serves (engsys#231). READ-ONLY.
//
// The merge monster labels a PR with the review request label (merge config `security_review_label`, default
// `security-review-requested`) when mm-preflight.sh answers `security_review_required` (exit 3): the PR needs a signed
// `nyx-review` verdict for its head and has none. The security lane (the session given ENGSYS_SECURITY_VERDICT_KEY_FILE)
// lists those PRs here, runs Nyx at each head, posts the signed verdict (security-verdict.mjs post, fenced) and removes
// the label. This script only lists and classifies; it writes nothing.
//
//   mnt-security-review.mjs list --repo owner/name [--session NAME] [--label L] [--config FILE]...
//     → one JSON object: {label, labelSource, session, signer, prs: [{number, head, url, author, isDraft,
//        selfAuthored, selfWhy, skipNoted}]}
//   mnt-security-review.mjs label --repo owner/name [--config FILE]...
//     → the review label alone, one line (for mnt-snapshot.sh / mnt-watch.sh; no GitHub call)
//
// Label: --label, else the first merge config that sets security_review_label (every discoverable source: the
// $ENGSYS_MM_CONFIG file, .claude/merge-monster.yml in the cwd, the fleet-config-dir copy (core/lib/mm-config.mjs)
// and each --config), else the default. Two sources naming different labels is an error (exit 1), never a guess.
//
// Self-authored (no independent signer until eric-sabe/engsys#220, so the lane must not review its own work): a PR is
// the session's own when ANY `<!-- mm-handoff -->` block on it (the PR body or any comment, whoever wrote it) names
// this session: `session: <NAME>`, or `<fleet>:<NAME>` (with FLEET_ID set, only `<FLEET_ID>:<NAME>`). The maintenance
// monster writes that block into every PR it opens (phase details § The loop, Drive). The match deliberately ignores
// who wrote the block: a false "self" only leaves the PR labeled for an operator (the safe direction), while trusting
// only some authors could let the lane sign a PR it wrote. Commit authors cannot tell sessions apart (every fleet
// session pushes as the same App). --session defaults to $ENGSYS_SESSION. With no session at all, every PR is
// reported selfAuthored (fail closed: the lane cannot tell its own PRs apart).
// skipNoted: a comment starting `<!-- security-review-self-skip -->` is already on the PR (say so once).
// signer: whether ENGSYS_SECURITY_VERDICT_KEY_FILE is set in this session (no key, no verdict: alert instead).
//
// Exit: 0 listed | 1 error (gh, config) | 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseHandoff } from '../../../fleet/lib/handoff.mjs';
import { loadPolicy, DEFAULT_REVIEW_LABEL } from '../../../lib/security-sensitive.mjs';
import { resolve as resolveFleetConfig, defaultConfigDirs } from '../../../lib/mm-config.mjs';
import { isMainEntry } from '../../../lib/is-main.mjs';

export const SKIP_MARKER = '<!-- security-review-self-skip -->';
const MARKER_LINE = /^ {0,3}<!-- mm-handoff -->\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Every `session:` value of every mm-handoff block in `text` (outside code fences), in order. */
export function handoffSessions(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let fenced = false;
  for (let k = 0; k < lines.length; k++) {
    if (FENCE.test(lines[k])) { fenced = !fenced; continue; }
    if (fenced || !MARKER_LINE.test(lines[k])) continue;
    const s = parseHandoff(lines.slice(k).join('\n'));
    if (s) out.push(s);
  }
  return out;
}

/** Does a handoff address name this session? Bare NAME, or <fleet>:NAME (only <FLEET_ID>:NAME when fleetId is set). */
export function namesSession(address, session, fleetId = null) {
  const a = String(address ?? '').trim().toLowerCase();
  const s = String(session ?? '').trim().toLowerCase();
  if (!a || !s) return false;
  if (a === s) return true;
  const i = a.lastIndexOf(':');
  if (i <= 0 || a.slice(i + 1) !== s) return false;
  return fleetId ? a.slice(0, i) === String(fleetId).toLowerCase() : true;
}

/**
 * Classify one PR. issue: REST issue ({body}), comments: REST issue comments ({body, user, html_url}).
 * → { selfAuthored, selfWhy, skipNoted }
 */
export function classify({ issue, comments = [], session, fleetId = null }) {
  const skipNoted = comments.some((c) => String(c?.body ?? '').trimStart().startsWith(SKIP_MARKER));
  if (!session) return { selfAuthored: true, selfWhy: 'no session name (--session or ENGSYS_SESSION): cannot tell this session\'s PRs apart', skipNoted };
  const texts = [{ where: 'the PR body', body: issue?.body }, ...comments.map((c) => ({ where: c?.html_url ?? 'a comment', body: c?.body }))];
  for (const t of texts) {
    const hit = handoffSessions(t.body).find((a) => namesSession(a, session, fleetId));
    if (hit) return { selfAuthored: true, selfWhy: `the mm-handoff block in ${t.where} names session ${hit}`, skipNoted };
  }
  return { selfAuthored: false, selfWhy: '', skipNoted };
}

/**
 * The review label from the config texts: [{ source, text }]. The first that sets security_review_label wins; a second
 * source naming a different label throws. → { label, source }
 */
export function reviewLabelOf(configs) {
  let label = null;
  let source = null;
  for (const c of configs) {
    let p;
    try { p = loadPolicy(c.text); } catch (e) { throw new Error(`security_config_unreadable: ${c.source}: ${e.message}`); }
    if (!p.reviewLabelSet) continue;
    if (label === null) { label = p.reviewLabel; source = c.source; continue; }
    if (p.reviewLabel.toLowerCase() !== label.toLowerCase()) {
      throw new Error(`security_config_unreadable: security_review_label is '${label}' in ${source} but '${p.reviewLabel}' in ${c.source}`);
    }
  }
  return label === null ? { label: DEFAULT_REVIEW_LABEL, source: 'default' } : { label, source };
}

function gh(args) {
  const r = spawnSync(process.env.FLEET_GH || 'gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 300)}`);
  return r.stdout;
}
/** `gh api --paginate` prints one JSON array per page, back to back. */
function pages(text) {
  const out = [];
  const s = String(text).trim();
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === ']') { depth--; if (depth === 0) out.push(...JSON.parse(s.slice(start, i + 1))); }
  }
  if (depth !== 0) throw new Error('could not parse the paginated comment list');
  return out;
}

function discoverConfigs({ repo, extra, env = process.env, cwd = process.cwd() }) {
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

export function list({ repo, session, fleetId, label, configs = [], env = process.env, cwd = process.cwd() }) {
  const lbl = label ? { label, source: '--label' } : reviewLabelOf(discoverConfigs({ repo, extra: configs, env, cwd }));
  const raw = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--label', lbl.label, '--json', 'number,headRefOid,url,author,isDraft,labels']));
  const want = lbl.label.toLowerCase();
  const prs = [];
  for (const p of raw) {
    if (!(p.labels ?? []).some((l) => String(l?.name ?? '').toLowerCase() === want)) continue; // gh's filter, verified
    const issue = JSON.parse(gh(['api', `repos/${repo}/issues/${p.number}`]));
    const comments = pages(gh(['api', '--paginate', `repos/${repo}/issues/${p.number}/comments?per_page=100`]));
    prs.push({ number: p.number, head: p.headRefOid, url: p.url, author: p.author?.login ?? null, isDraft: !!p.isDraft, ...classify({ issue, comments, session, fleetId }) });
  }
  prs.sort((a, b) => a.number - b.number);
  return { label: lbl.label, labelSource: lbl.source, session: session || null, signer: Boolean(env.ENGSYS_SECURITY_VERDICT_KEY_FILE), prs };
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  const [cmd, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, options: {
      repo: { type: 'string' }, session: { type: 'string' }, label: { type: 'string' }, config: { type: 'string', multiple: true },
    } }));
  } catch (e) { err.write(`mnt-security-review: ${e.message}\n`); return 2; }
  if (!['list', 'label'].includes(cmd) || !REPO_RE.test(values.repo ?? '')) {
    err.write('usage: mnt-security-review.mjs list|label --repo owner/name [--session NAME] [--label L] [--config FILE]...\n');
    return 2;
  }
  try {
    if (cmd === 'label') {
      const l = values.label ? values.label : reviewLabelOf(discoverConfigs({ repo: values.repo, extra: values.config ?? [], env })).label;
      out.write(`${l}\n`);
      return 0;
    }
    const r = list({ repo: values.repo, session: values.session ?? env.ENGSYS_SESSION ?? '', fleetId: env.FLEET_ID || null, label: values.label, configs: values.config ?? [], env });
    out.write(`${JSON.stringify(r)}\n`);
    return 0;
  } catch (e) {
    out.write(`${JSON.stringify({ ok: false, reason: e.message })}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) process.exitCode = main();
