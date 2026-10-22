// mnt-harvest.test.mjs — the maintenance monster's weekly findings harvest: off by default,
// cadence + window latch + error back-off, dry vs apply, and the shape of the draft PR hand-off. No network: gh is a mock,
// every fenced write goes to a recording `act`, and git runs against a local bare "origin".
// Run: node --test core/skills/maintenance-monster/scripts/mnt-harvest.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, harvestSettings, dueState, handoffBody, ERROR_BACKOFF_H } from './mnt-harvest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
delete process.env.FLEET_ID; // the host's fleet id must not leak into the handoff's session address
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-harvest-'));
const NOW = '2026-10-21T12:00:00Z';
const at = (days, hours = 0) => new Date(Date.parse(NOW) + days * 86_400_000 + hours * 3_600_000).toISOString();

const BASE = 'repo: acme/app\ndefault_branch: main\nsession_name: acme-maintain\nledger_issue: 7\nphase: read_only\n';
function setup(block = '') {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'cfg.yml'), BASE + block);
  return { dir: d, cfg: path.join(d, 'cfg.yml'), state: path.join(d, 'state') };
}
const ENABLED = 'findings_harvest:\n  enabled: true\n  cadence_days: 7\n  markers: ["<!-- cr-cli-findings -->"]\n  trusted_bot_ids: [42]\n';

const MARKER = '<!-- cr-cli-findings -->';
const finding = (title) => ({ login: 'trusted-bot', id: 42, body: `${MARKER}\n\`\`\`json\n${JSON.stringify({ findings: [{ file: 'a.ts', title, severity: 'warning', line: 3 }] })}\n\`\`\`\n` });
/** gh mock: the harvester's read shape (pr list/view, REST comments) plus the existing-PR lookup by --head. */
function mockGh(prs, { existing = [], calls = [] } = {}) {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) return JSON.stringify(existing);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(Object.keys(prs).map((n) => ({ number: Number(n) })));
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: Number(args[2]), title: 't', url: 'u' });
    if (args[0] === 'api') {
      const m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.exec(args[1]);
      if (m) return JSON.stringify((prs[m[1]]?.comments ?? []).map((c) => ({ body: c.body, created_at: '2026-10-20T00:00:00Z', user: { id: c.id, login: c.login, type: 'Bot' } })));
    }
    return '[]';
  };
}
const RECURRING = { 1: { comments: [finding('repeat offender')] }, 2: { comments: [finding('repeat offender')] } };
const noMemory = () => ({});

async function run(argv, deps = {}) {
  const lines = [];
  const errs = [];
  const code = await main(argv, { out: (s) => lines.push(s), err: (s) => errs.push(s), loadConfig: noMemory, ...deps });
  return { code, out: lines.join('\n'), err: errs.join('\n') };
}

describe('settings', () => {
  test('off by default: no block, or a block without enabled: true', () => {
    assert.equal(harvestSettings(BASE).enabled, false);
    assert.equal(harvestSettings(`${BASE}findings_harvest:\n  cadence_days: 7\n`).enabled, false);
  });
  test('defaults: weekly, dry, lookback = cadence, the top-level repo and session', () => {
    const s = harvestSettings(BASE + ENABLED);
    assert.deepEqual([s.cadenceDays, s.lookbackDays, s.apply, s.repo, s.session, s.minRecurrence], [7, 7, false, 'acme/app', 'acme-maintain', 2]);
    assert.deepEqual(s.markers, [MARKER]);
    assert.deepEqual(s.trustedBotIds, [42]);
  });
  test('malformed values and unknown keys are config errors, never guesses', () => {
    for (const bad of ['  cadence_days: 0\n', '  cadence_days: "weekly"\n', '  min_recurrence: 1\n', '  enabled: true\n  aply: true\n']) {
      assert.throws(() => harvestSettings(`${BASE}findings_harvest:\n  enabled: true\n${bad}`), new RegExp('findings_harvest'));
    }
    assert.throws(() => harvestSettings('findings_harvest:\n  enabled: true\n'), /no repo/);
  });
});

describe('cadence and the window latch', () => {
  test('dueState: due with no latch; a latched window waits cadence_days; a failure waits the back-off', () => {
    const s = harvestSettings(BASE + ENABLED);
    const now = Date.parse(NOW);
    assert.equal(dueState(s, null, now).due, true);
    assert.equal(dueState(s, { ranAt: at(-6) }, now).due, false);
    assert.equal(dueState(s, { ranAt: at(-7) }, now).due, true);
    assert.equal(dueState(s, { ranAt: at(-30), errorAt: at(0, -(ERROR_BACKOFF_H - 1)) }, now).due, false);
    assert.equal(dueState(s, { ranAt: at(-30), errorAt: at(0, -ERROR_BACKOFF_H) }, now).due, true);
    assert.equal(dueState(harvestSettings(BASE), null, now).due, false, 'disabled is never due');
  });

  test('due prints nothing when off, HARVEST_DUE when on; run latches the window once', async () => {
    const off = setup();
    assert.equal((await run(['due', '--config', off.cfg, '--state-dir', off.state, '--now', NOW])).out, '');
    assert.equal((await run(['run', '--config', off.cfg, '--state-dir', off.state, '--now', NOW], { gh: async () => { throw new Error('no gh when off'); } })).out, 'HARVEST_DISABLED');

    const on = setup(ENABLED);
    assert.equal((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', NOW])).out, 'HARVEST_DUE window=2026-10-21 since=2026-10-14');
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--now', NOW], { gh: mockGh({}) });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'HARVEST_DONE window=2026-10-21 families=0');
    assert.equal((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(3)])).out, '', 'latched for the window');
    assert.match((await run(['run', '--config', on.cfg, '--state-dir', on.state, '--now', at(3)], { gh: mockGh({}) })).out, /^HARVEST_NOT_DUE next=2026-10-28/);
    assert.match((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(7)])).out, /^HARVEST_DUE window=2026-10-28/);
  });

  test('a failed harvest is HARVEST_ERROR (exit 3), not latched as done, and retried after the back-off', async () => {
    const on = setup(ENABLED);
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--now', NOW], { gh: async () => { throw new Error('HTTP 502'); } });
    assert.equal(r.code, 3);
    assert.match(r.out, /^HARVEST_ERROR .*HTTP 502/);
    assert.equal((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(0, 1)])).out, '');
    assert.match((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(0, ERROR_BACKOFF_H)])).out, /^HARVEST_DUE/);
  });

  test('no trust allowlist anywhere: the harvester refuses, reported as HARVEST_ERROR', async () => {
    const on = setup('findings_harvest:\n  enabled: true\n');
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--now', NOW], { gh: mockGh(RECURRING) });
    assert.equal(r.code, 3);
    assert.match(r.out, /no trust allowlist/);
  });

  test('a config error is a usage error (exit 2)', async () => {
    const bad = setup('findings_harvest:\n  enabled: true\n  cadence_days: 0\n');
    assert.equal((await run(['due', '--config', bad.cfg, '--state-dir', bad.state])).code, 2);
  });
});

describe('dry vs apply', () => {
  test('apply: false (the default) writes the proposal locally and nothing to GitHub', async () => {
    const on = setup(ENABLED);
    const acts = [];
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--now', NOW], { gh: mockGh(RECURRING), act: (a) => { acts.push(a); return { code: 0, stdout: '', stderr: '' }; }, git: async () => { throw new Error('no git when dry'); } });
    assert.equal(r.code, 0);
    assert.match(r.out, /^HARVEST_DRY window=2026-10-21 families=1 proposal=/);
    assert.equal(acts.length, 0, 'no fenced write');
    const proposal = r.out.split('proposal=')[1];
    assert.match(fs.readFileSync(proposal, 'utf8'), /repeat offender/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(on.state, 'harvest', 'last.json'), 'utf8')).result, 'dry');
  });

  function gitRepo() {
    const d = tmp();
    const origin = path.join(d, 'origin.git');
    const repo = path.join(d, 'repo');
    const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
    g(d, 'init', '-q', '--bare', '-b', 'main', origin);
    g(d, 'clone', '-q', origin, repo);
    fs.mkdirSync(path.join(repo, 'docs', 'agent-lessons'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'agent-lessons', 'repeat-offender.md'), 'existing\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'init'); g(repo, 'push', '-q', 'origin', 'HEAD:main');
    return { origin, repo, g };
  }

  test('apply: true opens ONE draft docs PR, every write fenced, handed to Merge Monster with mm:ready and an operator gate', async () => {
    const on = setup(ENABLED.replace('  cadence_days: 7\n', '  cadence_days: 7\n  apply: true\n'));
    const { origin, repo, g } = gitRepo();
    const acts = [];
    const act = (a) => {
      acts.push(a);
      if (a[0] === '--new-branch') { g(a[4], 'push', '-q', 'origin', a[7]); return { code: 0, stdout: '', stderr: '' }; }
      if (a[2] === 'pr' && a[3] === 'create') return { code: 0, stdout: 'https://github.com/acme/app/pull/77\n', stderr: '' };
      if (a[2] === 'pr' && a[3] === 'comment') acts.handoff = fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8');
      if (a[2] === 'pr' && a[3] === 'create') acts.body = fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    };
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    Object.assign(process.env, env);
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--repo-dir', repo, '--now', NOW], { gh: mockGh(RECURRING), act });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out, 'HARVEST_PR window=2026-10-21 families=1 pr=https://github.com/acme/app/pull/77');
    // the shape: push a new agent/ branch, then create (draft, docs), then the handoff, then the label
    assert.deepEqual(acts.map((a) => (a[0] === '--new-branch' ? 'push' : `${a[2]} ${a[3]}`)), ['push', 'pr create', 'pr comment', 'pr edit']);
    assert.deepEqual(acts[0].slice(0, 4), ['--new-branch', '--', 'git', '-C']);
    assert.deepEqual(acts[0].slice(5), ['push', 'origin', 'HEAD:refs/heads/agent/memory-harvest-2026-10-21']);
    const create = acts[1];
    for (const f of ['--draft', '-R', 'acme/app', '--base', 'main', '--head', 'agent/memory-harvest-2026-10-21']) assert.ok(create.includes(f), `pr create carries ${f}`);
    assert.deepEqual(acts[3].slice(-2), ['--add-label', 'mm:ready']);
    assert.match(acts.handoff, /^<!-- mm-handoff -->\n/);
    assert.match(acts.handoff, /operator_gate: "harvested lessons: a human reviews every proposed lesson/);
    assert.match(acts.handoff, /^session: acme-maintain$/m);
    assert.match(acts.handoff, /migration: false/);
    // docs only, on the pushed branch, beside (never over) an existing lesson; the default branch untouched
    const files = g(repo, 'ls-tree', '-r', '--name-only', 'origin/main').split('\n').filter(Boolean);
    assert.deepEqual(files, ['docs/agent-lessons/repeat-offender.md']);
    const changed = execFileSync('git', ['--git-dir', origin, 'diff', '--name-only', 'main', 'agent/memory-harvest-2026-10-21']).toString().trim().split('\n');
    assert.deepEqual(changed, ['docs/agent-lessons/repeat-offender-2.md']);
    assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'main:docs/agent-lessons/repeat-offender.md']).toString(), 'existing\n');
    assert.equal(g(repo, 'worktree', 'list').trim().split('\n').length, 1, 'the worktree is removed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(on.state, 'harvest', 'last.json'), 'utf8')).pr, 'https://github.com/acme/app/pull/77');
    assert.equal((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(1)])).out, '', 'one PR per window');

    // re-run of the same window (--force) after the PR exists: nothing written again
    const again = [];
    const r2 = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--repo-dir', repo, '--now', NOW, '--force'],
      { gh: mockGh(RECURRING, { existing: [{ url: 'https://github.com/acme/app/pull/77', state: 'OPEN' }] }), act: (a) => { again.push(a); return { code: 0, stdout: '', stderr: '' }; } });
    assert.equal(r2.out, 'HARVEST_PR window=2026-10-21 families=1 pr=https://github.com/acme/app/pull/77 existing');
    assert.equal(again.length, 0);
  });

  test('a refused fence stops the run: HARVEST_ERROR, no PR, retried after the back-off', async () => {
    const on = setup(ENABLED.replace('  cadence_days: 7\n', '  cadence_days: 7\n  apply: true\n'));
    const { repo } = gitRepo();
    const acts = [];
    const r = await run(['run', '--config', on.cfg, '--state-dir', on.state, '--repo-dir', repo, '--now', NOW],
      { gh: mockGh(RECURRING), act: (a) => { acts.push(a); return { code: 1, stdout: '', stderr: '{"decision":"refused"}' }; } });
    assert.equal(r.code, 3);
    assert.match(r.out, /^HARVEST_ERROR the push refused or failed \(exit 1\)/);
    assert.equal(acts.length, 1, 'nothing after the refused push');
    assert.equal((await run(['due', '--config', on.cfg, '--state-dir', on.state, '--now', at(0, 1)])).out, '');
  });

  test('handoffBody qualifies the session with FLEET_ID', () => {
    assert.match(handoffBody({ session: 'acme-maintain', window: 'w', files: 1, fleetId: 'eric' }), /^session: eric:acme-maintain$/m);
    assert.doesNotMatch(handoffBody({ session: '', window: 'w', files: 1, fleetId: '' }), /session:/);
  });
});

test('the shell wrapper runs due, by literal path', () => {
  const on = setup(ENABLED);
  const r = spawnSync('bash', [path.join(HERE, 'mnt-harvest.sh'), 'due', '--config', on.cfg, '--state-dir', on.state, '--now', NOW], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'HARVEST_DUE window=2026-10-21 since=2026-10-14');
});
