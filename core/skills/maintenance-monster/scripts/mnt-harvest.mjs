#!/usr/bin/env node
// mnt-harvest.mjs — Maintenance Monster's weekly findings harvest. Runs the review-finding
// harvester (core/scripts/harvest-findings.mjs, docs/memory-spec.md §8) on the cadence the config's `findings_harvest:`
// block sets, once per window, and with `apply: true` opens the proposal as ONE draft docs PR that it hands to Merge
// Monster (`mm:ready` + an `<!-- mm-handoff -->` block whose operator_gate asks a human to approve the merge), so a
// person sees every promoted lesson before it lands. Off unless `findings_harvest.enabled: true`.
//
//   due   --config FILE --state-dir DIR [--now ISO]
//           read-only, no network: prints `HARVEST_DUE window=<date> since=<date>` when a run is due, else nothing.
//           mnt-tick.sh calls it and passes the line on as a delta.
//   run   --config FILE --state-dir DIR [--repo-dir DIR] [--now ISO] [--force]
//           harvest (gh reads), write the proposal under <state-dir>/harvest/<window>/, and with apply: true open the
//           draft PR. Every write to GitHub goes through mnt-act.sh guard (the maintain baton's fence): the push
//           (--new-branch, an agent/ branch) and the gh pr create / edit / comment. One line out:
//             HARVEST_DISABLED | HARVEST_NOT_DUE next=<date> | HARVEST_DONE window=<w> families=0
//             HARVEST_DRY window=<w> families=<n> proposal=<path>          (apply: false: nothing written to GitHub)
//             HARVEST_PR window=<w> families=<n> pr=<url> [existing]       (apply: true)
//             HARVEST_ERROR <why>                                          (exit 3; retried after a back-off)
//
// The window latch is <state-dir>/harvest/last.json ({ window, ranAt, result, pr?, errorAt? }): a run that finished
// (whatever it found) latches the window; one that failed is retried no sooner than ERROR_BACKOFF_H hours later.
//
// Exit: 0 | 2 usage | 3 HARVEST_ERROR.
import { spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readTopLevel } from './mnt-fp.mjs';
import { harvest, aggregateFamilies, renderProposal, renderLessonProposal, uniqueSlugs, defaultGh } from '../../../scripts/harvest-findings.mjs';
import { loadConfig } from '../../../scripts/memory-brief.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
export const ERROR_BACKOFF_H = 6;
const execFileP = promisify(execFile);

class UsageError extends Error {}

const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// the config reader (mnt-fp.mjs readTopLevel) keeps scalars as strings: a whole number is digits only, nothing else
const int = (v, dflt) => (v === undefined || v === null ? dflt : /^[0-9]{1,6}$/.test(String(v)) ? Number(v) : NaN);

/** The `findings_harvest:` block, validated, with defaults. Anything malformed is a config error, never a guess. */
export function harvestSettings(configText) {
  const { values, errors } = readTopLevel(configText, ['findings_harvest', 'repo', 'default_branch', 'session_name']);
  if (errors.findings_harvest) throw new UsageError(`findings_harvest: ${errors.findings_harvest}`);
  const b = values.findings_harvest ?? {};
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new UsageError('findings_harvest must be a mapping');
  // Trust comes ONLY from memory.yml (its committed, reviewed copy and the fleet config dir's): a monster's own config is
  // not where an allowlist of whose findings become lessons may be widened.
  for (const k of ['trusted_bot_ids', 'operator_ids', 'trusted_bot_user_ids', 'operator_user_ids']) {
    if (k in b) throw new UsageError(`findings_harvest.${k} is not supported: the trust lists come only from memory.yml (trusted_bot_user_ids, operator_user_ids)`);
  }
  const known = ['enabled', 'cadence_days', 'lookback_days', 'apply', 'repo', 'markers', 'min_recurrence'];
  const unknown = Object.keys(b).filter((k) => !known.includes(k));
  if (unknown.length) throw new UsageError(`findings_harvest: unknown key(s) ${unknown.join(', ')}`);
  const s = {
    enabled: b.enabled === true,
    cadenceDays: int(b.cadence_days, 7),
    apply: b.apply === true,
    repo: b.repo ?? values.repo ?? '',
    defaultBranch: values.default_branch ?? 'main',
    session: values.session_name ?? '',
    markers: Array.isArray(b.markers) ? b.markers.map(String) : b.markers ? [String(b.markers)] : [],
    minRecurrence: int(b.min_recurrence, 2),
  };
  s.lookbackDays = int(b.lookback_days, s.cadenceDays);
  if (!isIntIn(s.cadenceDays, 1, 366)) throw new UsageError('findings_harvest.cadence_days must be a whole number of days, 1-366');
  if (!isIntIn(s.lookbackDays, 1, 366)) throw new UsageError('findings_harvest.lookback_days must be a whole number of days, 1-366');
  if (!isIntIn(s.minRecurrence, 2, 100)) throw new UsageError('findings_harvest.min_recurrence must be a whole number, 2-100');
  if (s.enabled && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(s.repo))) throw new UsageError('findings_harvest: no repo (owner/name; the block\'s repo: or the top-level repo:)');
  if (!/^[A-Za-z0-9._\/-]+$/.test(String(s.defaultBranch))) throw new UsageError('default_branch is not a branch name');
  return s;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const latchFile = (stateDir) => path.join(stateDir, 'harvest', 'last.json');
function readLatch(stateDir) {
  try { return JSON.parse(fs.readFileSync(latchFile(stateDir), 'utf8')); } catch { return null; }
}
function writeLatch(stateDir, obj) {
  fs.mkdirSync(path.dirname(latchFile(stateDir)), { recursive: true });
  const tmp = `${latchFile(stateDir)}.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`);
  fs.renameSync(tmp, latchFile(stateDir));
}

/** → { due, window, since, next } for `now` (ms). A latched window waits cadence_days; a failed run waits ERROR_BACKOFF_H. */
export function dueState(settings, latch, now) {
  const window = isoDate(now);
  const since = isoDate(now - settings.lookbackDays * DAY);
  if (!settings.enabled) return { due: false, window, since, next: null };
  const ranAt = latch && Date.parse(latch.ranAt ?? '');
  const errAt = latch && Date.parse(latch.errorAt ?? '');
  let next = 0;
  if (Number.isFinite(ranAt)) next = ranAt + settings.cadenceDays * DAY;
  if (Number.isFinite(errAt)) next = Math.max(next, errAt + ERROR_BACKOFF_H * 3_600_000);
  return { due: now >= next, window, since, next: next ? new Date(next).toISOString() : null };
}

function defaultAct(stateDir, repo) {
  return (args) => {
    const r = spawnSync('bash', [path.join(HERE, 'mnt-act.sh'), 'guard', '--repo', repo, '--state-dir', stateDir, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}
async function defaultGit(args, { cwd } = {}) {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const LESSONS_DIR = 'docs/agent-lessons';
/** true when `files` is non-empty and every one is a .md directly under docs/agent-lessons/ */
export function docsOnly(files) {
  return files.length > 0 && files.every((f) => new RegExp(`^${LESSONS_DIR}/[^/]+\\.md$`).test(f));
}

/** true when an mm-handoff body sets a non-empty operator_gate */
export function hasOperatorGate(body) {
  const m = /^operator_gate:[ \t]*(.*)$/m.exec(String(body ?? ''));
  return Boolean(m) && m[1].replace(/[ \t]#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim() !== '';
}

/** The handoff block Merge Monster reads (core/workflows/merge-monster-protocol.md § How to enqueue). */
export function handoffBody({ session, window, files, fleetId = process.env.FLEET_ID ?? '' }) {
  const addr = session ? (fleetId && !session.includes(':') ? `${fleetId}:${session}` : session) : '';
  return [
    '<!-- mm-handoff -->',
    'depends_on: []',
    'migration: false',
    'operator_gate: "harvested lessons: a human reviews every proposed lesson before this merges"',
    `notes: docs-only, ${files} proposed lesson file(s) from the findings harvest (window ${window}); maintain opened it and never merges it`,
    ...(addr ? [`session: ${addr}`] : []),
    '',
  ].join('\n');
}

/**
 * Open the harvest's draft PR, every GitHub write fenced. `deps.act(args)` runs `mnt-act.sh guard … <args>` and returns
 * { code, stdout, stderr }; `deps.git` runs local git; `deps.gh` is read-only (the existing-PR lookup).
 */
export async function openHarvestPr(families, { repo, defaultBranch, session, window, repoDir, workDir }, { act, git, gh }) {
  const branch = `agent/memory-harvest-${window}`;
  const fenced = (args, what) => {
    const r = act(args);
    if (r.code !== 0) throw new Error(`${what} refused or failed (exit ${r.code}): ${String(r.stderr || r.stdout).trim().split('\n').pop()}`);
    return r.stdout.trim();
  };
  const handoffFile = path.join(workDir, 'handoff.md');
  // A run that died after opening the PR: complete what is missing (the handoff, the label), nothing twice. Only a PR
  // from this repo's own branch counts: a fork's PR with the same head branch name is someone else's.
  const listed = JSON.parse((await gh(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'url,state,isCrossRepository', '--limit', '20'])) || '[]');
  const own = listed.filter((p) => p && p.isCrossRepository === false && /^https:\/\/\S+\/pull\/\d+$/.test(String(p.url)));
  if (own.length) {
    const prUrl = own[0].url;
    const v = JSON.parse(await gh(['pr', 'view', prUrl, '-R', repo, '--json', 'author,state,isCrossRepository,labels,comments,files']));
    const files = (v.files ?? []).map((f) => f.path);
    if (v.isCrossRepository !== false || !docsOnly(files)) throw new Error(`${prUrl} is on ${branch} but is not this harvest's docs-only PR (files: ${files.slice(0, 5).join(', ') || 'none'}); not touching it`);
    if (v.state === 'OPEN') {
      // ours only: posted by the PR's author (this fleet's identity opened it) and still carrying the operator gate. A
      // handoff anyone else posted in the window between the create and ours, or one without the gate, does not count.
      const me = v.author?.login;
      const ours = (c) => me && c?.author?.login === me && String(c.body ?? '').trimStart().startsWith('<!-- mm-handoff -->') && hasOperatorGate(c.body);
      if (!(v.comments ?? []).some(ours)) {
        fs.writeFileSync(handoffFile, handoffBody({ session, window, files: files.length }));
        fenced(['--', 'gh', 'pr', 'comment', prUrl, '-R', repo, '--body-file', handoffFile], 'the handoff comment');
      }
      if (!(v.labels ?? []).some((l) => l.name === 'mm:ready')) fenced(['--', 'gh', 'pr', 'edit', prUrl, '-R', repo, '--add-label', 'mm:ready'], 'the mm:ready label');
    }
    return { branch, prUrl, files, existing: true };
  }
  const wt = path.join(workDir, 'wt');
  fs.rmSync(wt, { recursive: true, force: true });
  await git(['fetch', 'origin', defaultBranch], { cwd: repoDir });
  const onOrigin = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repoDir })).trim() !== '';
  try {
    if (onOrigin) {
      await git(['fetch', 'origin', branch], { cwd: repoDir });
      await git(['worktree', 'add', '--detach', wt, `origin/${branch}`], { cwd: repoDir });
    } else {
      await git(['worktree', 'add', '--detach', wt, `origin/${defaultBranch}`], { cwd: repoDir });
    }
    let files = [];
    if (!onOrigin) {
      const dir = path.join(wt, 'docs', 'agent-lessons');
      fs.mkdirSync(dir, { recursive: true });
      const existing = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
      const slugOf = uniqueSlugs(families, existing);
      for (const fam of families) {
        const f = path.join(dir, `${slugOf.get(fam)}.md`);
        fs.writeFileSync(f, renderLessonProposal(fam));
        files.push(path.relative(wt, f));
      }
      await git(['add', '--', ...files], { cwd: wt });
      // the repo's own hooks (husky and the like) are not run here: a throwaway worktree lacks their untracked setup,
      // and nothing in it but the generated lesson files is committed (the guarded push runs with hooks off too)
      await git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', `docs(memory): propose ${files.length} harvested lesson(s) (findings harvest ${window})`], { cwd: wt });
      fenced(['--new-branch', '--', 'git', '-C', wt, 'push', 'origin', `HEAD:refs/heads/${branch}`], 'the push');
    } else {
      files = (await git(['diff', '--name-only', `origin/${defaultBranch}...HEAD`], { cwd: wt })).split('\n').filter(Boolean);
      // reuse a branch a stopped run pushed only when it is still nothing but lesson files
      if (!docsOnly(files)) throw new Error(`origin has ${branch}, but it changes more than ${LESSONS_DIR}/ (${files.slice(0, 5).join(', ') || 'nothing'}); not opening a PR from it`);
    }
    const bodyFile = path.join(workDir, 'pr-body.md');
    fs.writeFileSync(bodyFile, `${renderProposal(families, { repo })}\n---\nOpened by the maintenance monster's weekly findings harvest (window ${window}). Draft and docs-only: Merge Monster pilots it, and its operator gate needs a human to approve the merge after reviewing every lesson.\n`);
    const prUrl = fenced(['--', 'gh', 'pr', 'create', '-R', repo, '--draft', '--base', defaultBranch, '--head', branch,
      '--title', `docs: propose ${files.length} harvested lesson(s) (findings harvest ${window})`, '--body-file', bodyFile], 'gh pr create').split('\n').pop();
    if (!/^https:\/\/\S+\/pull\/\d+$/.test(prUrl)) throw new Error(`gh pr create printed no PR URL: ${prUrl.slice(0, 200)}`);
    fs.writeFileSync(handoffFile, handoffBody({ session, window, files: files.length }));
    fenced(['--', 'gh', 'pr', 'comment', prUrl, '-R', repo, '--body-file', handoffFile], 'the handoff comment');
    fenced(['--', 'gh', 'pr', 'edit', prUrl, '-R', repo, '--add-label', 'mm:ready'], 'the mm:ready label');
    return { branch, prUrl, files, existing: false };
  } finally {
    try { await git(['worktree', 'remove', '--force', wt], { cwd: repoDir }); } catch { /* best effort */ }
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

function parse(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, force: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { if (i + 1 >= rest.length) throw new UsageError(`${a} needs a value`); return rest[++i]; };
    if (a === '--config') o.config = val();
    else if (a === '--state-dir') o.stateDir = val();
    else if (a === '--repo-dir') o.repoDir = val();
    else if (a === '--now') o.now = val();
    else if (a === '--force') o.force = true;
    else throw new UsageError(`unknown arg: ${a}`);
  }
  if (cmd !== 'due' && cmd !== 'run') throw new UsageError('usage: mnt-harvest.mjs due|run --config FILE --state-dir DIR [--repo-dir DIR] [--now ISO] [--force]');
  if (!o.config || !o.stateDir) throw new UsageError('--config and --state-dir are required');
  return o;
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let o;
  let s;
  try {
    o = parse(argv);
    s = harvestSettings(fs.readFileSync(o.config, 'utf8'));
  } catch (e) {
    err(`mnt-harvest: ${e.message}`);
    return 2;
  }
  const now = o.now ? Date.parse(o.now) : (deps.now ?? Date.now)();
  if (!Number.isFinite(now)) { err('mnt-harvest: --now is not a date'); return 2; }
  const latch = readLatch(o.stateDir);
  const st = dueState(s, latch, now);
  if (o.cmd === 'due') {
    if (st.due) out(`HARVEST_DUE window=${st.window} since=${st.since}`);
    return 0;
  }
  if (!s.enabled) { out('HARVEST_DISABLED'); return 0; }
  if (!st.due && !o.force) { out(`HARVEST_NOT_DUE next=${st.next}`); return 0; }
  const repoDir = path.resolve(o.repoDir ?? process.cwd());
  const workDir = path.join(o.stateDir, 'harvest', st.window);
  fs.mkdirSync(workDir, { recursive: true });
  const gh = deps.gh ?? defaultGh;
  const fail = (why) => {
    writeLatch(o.stateDir, { ...(latch ?? {}), errorAt: new Date(now).toISOString(), error: String(why).slice(0, 300) });
    out(`HARVEST_ERROR ${String(why).replace(/\s+/g, ' ').slice(0, 300)}`);
    return 3;
  };
  let families;
  try {
    const config = (deps.loadConfig ?? loadConfig)(repoDir);
    if (s.markers.length) config.review_markers = [...(config.review_markers ?? []), ...s.markers];
    const { records } = await harvest({ repo: s.repo, since: st.since, config, journalPaths: [] }, { gh, log: deps.log ?? (() => {}) });
    families = aggregateFamilies(records, { minRecurrence: s.minRecurrence });
  } catch (e) {
    return fail(e?.message ?? e);
  }
  const proposal = path.join(workDir, 'proposal.md');
  fs.writeFileSync(proposal, renderProposal(families, { repo: s.repo }));
  fs.writeFileSync(path.join(workDir, 'families.json'), `${JSON.stringify({ window: st.window, since: st.since, repo: s.repo, families }, null, 2)}\n`);
  const base = { window: st.window, ranAt: new Date(now).toISOString(), families: families.length };
  if (families.length === 0) {
    writeLatch(o.stateDir, { ...base, result: 'none' });
    out(`HARVEST_DONE window=${st.window} families=0`);
    return 0;
  }
  if (!s.apply) {
    writeLatch(o.stateDir, { ...base, result: 'dry' });
    out(`HARVEST_DRY window=${st.window} families=${families.length} proposal=${proposal}`);
    return 0;
  }
  try {
    const r = await openHarvestPr(families, { repo: s.repo, defaultBranch: s.defaultBranch, session: s.session, window: st.window, repoDir, workDir },
      { act: deps.act ?? defaultAct(o.stateDir, s.repo), git: deps.git ?? defaultGit, gh });
    writeLatch(o.stateDir, { ...base, result: 'pr', pr: r.prUrl });
    out(`HARVEST_PR window=${st.window} families=${families.length} pr=${r.prUrl}${r.existing ? ' existing' : ''}`);
    return 0;
  } catch (e) {
    return fail(e?.message ?? e);
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`mnt-harvest: ${e?.message ?? e}\n`); process.exitCode = 3; });
