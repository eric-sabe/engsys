// Tests for singleton-write-guard.mjs (engsys#62, review H1) — run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, githubWrites, lex, wrapperInvocation } from './singleton-write-guard.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'singleton-write-guard.mjs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-guard-')));
for (const rel of ['merge-monster/scripts/mm-act.sh', 'merge-monster/scripts/mm-heartbeat.sh', 'merge-monster/scripts/mm-baton.sh',
  'merge-monster/scripts/mm-setup.sh', 'maintenance-monster/scripts/mnt-act.sh', 'maintenance-monster/scripts/mnt-heartbeat.sh']) {
  fs.mkdirSync(path.dirname(path.join(ROOT, 'skills', rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'skills', rel), '#!/usr/bin/env bash\n', { mode: 0o755 });
}
const ACT = path.join(ROOT, 'skills/merge-monster/scripts/mm-act.sh');
const MNT_ACT = path.join(ROOT, 'skills/maintenance-monster/scripts/mnt-act.sh');
const HB = path.join(ROOT, 'skills/merge-monster/scripts/mm-heartbeat.sh');
const SETUP = path.join(ROOT, 'skills/merge-monster/scripts/mm-setup.sh');
const MERGE = { ENGSYS_SINGLETON_ROLE: 'merge' };
const denied = (command, env = MERGE) => decide({ command, env, pluginRoot: ROOT }) !== null;

test('inactive outside a singleton-monster session: no opinion, whatever the command', () => {
  for (const env of [{}, { ENGSYS_SINGLETON_ROLE: '' }, { ENGSYS_SINGLETON_ROLE: 'build' }]) {
    assert.equal(decide({ command: 'gh pr merge 1 --admin', env, pluginRoot: ROOT }), null);
  }
});

test('denies raw GitHub writes in a merge or maintain session', () => {
  const writes = [
    'gh pr merge 12 --squash',
    'gh pr merge 12 --squash --match-head-commit abc',
    'gh -R o/r pr merge 12',
    'gh pr ready 12',
    'gh pr edit 12 --add-label mm:active',
    'gh pr close 12',
    'gh pr comment 12 --body hi',
    'gh pr review 12 --approve',
    'gh issue close 3',
    'gh issue comment 3 --body-file x.md',
    'gh issue edit 3 --add-label mnt:escalated',
    'gh label create mm:ready',
    'gh workflow run ci.yml --ref main -f force_all=true',
    'gh run rerun 99 --failed',
    'gh run cancel 99',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api --method=DELETE repos/o/r/git/refs/heads/x',
    'gh api -XPATCH repos/o/r/issues/3 -f state=closed',
    'gh api repos/o/r/issues/3/comments -f body=hi',
    'gh api repos/o/r/issues/3/labels --input labels.json',
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    'git push origin HEAD',
    'git -C ../wt push --force-with-lease origin agent/1-x',
    '/opt/homebrew/bin/gh pr merge 1',
  ];
  for (const c of writes) {
    assert.ok(denied(c), `should deny: ${c}`);
    assert.ok(denied(c, { ENGSYS_SINGLETON_ROLE: 'maintain' }), `maintain should deny: ${c}`);
  }
});

test('allows reads', () => {
  for (const c of [
    'gh pr view 12 --json state',
    'gh pr list --label mm:ready',
    'gh pr checks 12',
    'gh issue list',
    'gh api repos/o/r/pulls/12',
    'gh api -X GET repos/o/r/issues -f state=open',
    `gh api graphql -f query='query { viewer { login } }'`,
    'gh run view 99 --log-failed',
    'gh label list',
    'git fetch origin',
    'git status --porcelain',
    'git log --oneline -3',
    'ls -la',
  ]) assert.equal(decide({ command: c, env: MERGE, pluginRoot: ROOT }), null, c);
});

test('chaining, substitution and nesting cannot smuggle a write', () => {
  for (const c of [
    'true; gh pr merge 1',
    'echo x && gh pr merge 1',
    'echo x | xargs gh pr close',
    'echo $(gh pr merge 1)',
    'echo `gh pr merge 1`',
    'bash -c "gh pr merge 1"',
    `sh -c 'git push origin main'`,
    'env GH_TOKEN=x gh pr merge 1',
    '(gh pr merge 1)',
    'g\\h pr merge 1',
    '"gh" pr merge 1',
    'gh pr merge 1 >/dev/null 2>&1',
  ]) assert.ok(denied(c), `should deny: ${c}`);
});

test('the fenced wrappers pass, as one plain command only', () => {
  const ok = [
    `${ACT} merge --repo o/r --state-dir logs/mm --pr 12 --sha ${'a'.repeat(40)} --method squash`,
    `bash ${ACT} guard --repo o/r --state-dir logs/mm -- gh pr ready 12`,
    `${ACT} guard --repo o/r --state-dir logs/mm -- gh pr comment 12 --body "queued (position 2): \\"fast\\""`,
    `${ACT} guard --repo o/r --state-dir logs/mm -- git -C ../wt push --force-with-lease origin agent/1-x`,
    `${MNT_ACT} guard --repo o/r --state-dir logs/mnt -- gh issue comment 3 --body 'see run #99'`,
    `${HB} --repo o/r --issue 7 --state-dir logs/mm --status running`,
  ];
  for (const c of ok) assert.equal(decide({ command: c, env: MERGE, pluginRoot: ROOT }), null, c);
  for (const c of [
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 1; gh pr merge 1`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 1 && gh pr merge 1`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr comment 1 --body "$(gh pr merge 1)"`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr comment 1 --body "\`gh pr merge 1\`"`,
    `cd /x && ${ACT} guard --repo o/r --state-dir d -- gh pr ready 1`,
    `${SETUP} --repo o/r; gh label create x`,
    `/tmp/mm-act.sh guard -- gh pr ready 1`,
    `mm-act.sh guard -- gh pr ready 1`,
  ]) assert.ok(denied(c), `should deny: ${c}`);
  assert.equal(wrapperInvocation(`${ACT} guard -- gh pr ready 1`, null), null, 'no plugin root, no wrapper');
});

test('an unparseable command that mentions gh or git is denied (fail closed)', () => {
  assert.ok(denied(`gh pr comment 1 --body 'unbalanced`));
  assert.equal(decide({ command: `echo 'unbalanced`, env: MERGE, pluginRoot: ROOT }), null);
});

test('the deny message points at the fenced wrapper', () => {
  const d = decide({ command: 'gh pr merge 1', env: MERGE, pluginRoot: ROOT });
  assert.match(d.deny, /mm-act\.sh guard --repo <repo> --state-dir <state_dir>/);
  assert.match(d.deny, /mm-act\.sh merge --pr N --sha <validated head>/);
  assert.match(decide({ command: 'gh issue close 1', env: { ENGSYS_SINGLETON_ROLE: 'maintain' }, pluginRoot: ROOT }).deny, /mnt-act\.sh guard/);
});

test('lex and githubWrites basics', () => {
  assert.deepEqual(lex(`a 'b c' "d"`).words, [['a', 'b c', 'd']]);
  assert.equal(lex('a "$(b)"').subst, true);
  assert.equal(lex(`a '$(b)'`).subst, false);
  assert.deepEqual(githubWrites('gh pr ready 1 && git push'), ['gh pr ready', 'git push']);
});

test('hook: emits a deny decision only when active and writing', () => {
  const run = (command, extra = {}) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, ENGSYS_SINGLETON_ROLE: 'merge', ...extra },
    encoding: 'utf8',
  });
  const r = run('gh pr merge 1');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('gh pr view 1').stdout, '');
  assert.equal(run(`${ACT} guard --repo o/r --state-dir d -- gh pr ready 1`).stdout, '');
  assert.equal(run('gh pr merge 1', { ENGSYS_SINGLETON_ROLE: '' }).stdout, '');
});

test('the core plugin registers the guard as a PreToolUse Bash hook', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), 'hooks.json'), 'utf8'));
  const cmds = hooks.hooks.PreToolUse.filter((h) => h.matcher === 'Bash').flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(cmds.some((c) => c.includes('singleton-write-guard.mjs')));
});
