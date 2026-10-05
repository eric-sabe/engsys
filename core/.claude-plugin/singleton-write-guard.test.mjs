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
  assert.equal(githubWrites('gh pr ready 1 && git push').length, 2);
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

// ------------------------------------------------------------------- #69 re-check (N1, L-a, L-c) --

test('N1: an allowlist — aliases, extensions and unknown gh commands are denied', () => {
  for (const c of [
    `gh alias set m 'pr merge'`,
    'gh m 1 --squash',
    'gh some-extension do-thing',
    'gh pr checkout 12',
    'gh auth token',
    'gh project item-add 3 --owner o --url u',
    'gh pr',
  ]) assert.ok(denied(c), `should deny: ${c}`);
});

test('N1: gh api method forms the way pflag parses them, and graphql from a file, stdin or --input', () => {
  for (const c of [
    'gh api -X=PUT repos/o/r/pulls/1/merge',
    'gh api -XPUT repos/o/r/pulls/1/merge',
    'gh api --method=PUT repos/o/r/pulls/1/merge',
    'gh api --method PATCH repos/o/r/issues/1',
    'gh api graphql -F query=@/tmp/m.graphql',
    'gh api graphql -f query=@-',
    'gh api graphql --input q.json',
    `gh api graphql -f query='mutation{addComment(input:{subjectId:"x",body:"y"}){clientMutationId}}'`,
    'gh api -H "X-HTTP-Method-Override: PUT" repos/o/r/pulls/1/merge',
    'gh api repos/o/r/issues -F title=@body.txt -X GET',
  ]) assert.ok(denied(c), `should deny: ${c}`);
  for (const c of [
    'gh api repos/o/r/pulls/1',
    'gh api -X GET search/issues -f q=is:open',
    `gh api graphql -f query='query { repository(owner:"o", name:"r") { id } }'`,
  ]) assert.equal(decide({ command: c, env: MERGE, pluginRoot: ROOT }), null, c);
});

test('N1: HTTP clients towards GitHub, and any command naming the API host, are denied', () => {
  for (const c of [
    `curl -X PUT -H 'Authorization: Bearer x' https://api.github.com/repos/o/r/pulls/1/merge`,
    'curl -X PUT -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/o/r/pulls/1/merge',
    'curl https://github.com/o/r/pull/1',
    'wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge',
    `node -e "fetch('https://api.github.com/repos/o/r/pulls/1/merge',{method:'PUT'})"`,
    `python3 -c "import urllib.request as u; u.urlopen('https://api.github.com/x')"`,
  ]) assert.ok(denied(c), `should deny: ${c}`);
  assert.equal(decide({ command: 'curl https://example.com/health', env: MERGE, pluginRoot: ROOT }), null);
});

test('N1: git aliases, config writes, remote changes and unsafe -c are denied; local work passes', () => {
  for (const c of [
    'git config alias.p push',
    'git config --global alias.p push',
    'git config remote.origin.url https://github.com/other/repo',
    'git p origin HEAD',
    'git -c alias.p=push p origin HEAD',
    'git -c core.hooksPath=/tmp/h commit -m x',
    'git remote set-url origin https://github.com/other/repo',
    'git remote add evil https://github.com/other/repo',
    'git send-email x.patch',
  ]) assert.ok(denied(c), `should deny: ${c}`);
  for (const c of [
    'git status --porcelain',
    'git -C ../wt log --oneline -3',
    'git fetch origin',
    'git rev-parse HEAD',
    'git ls-remote origin',
    'git branch --list',
    'git branch -D agent/1-x',
    'git worktree remove ../wt --force',
    'git commit -m "fix: x"',
    'git rebase origin/main',
    'git config --get remote.origin.url',
    'git remote get-url origin',
    'git remote -v',
    'git -c user.name=bot commit -m x',
  ]) assert.equal(decide({ command: c, env: MERGE, pluginRoot: ROOT }), null, c);
});

test('N1: settings and plugin files are read-only — Bash writes and the Write/Edit tools', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    `printf '{"disableAllHooks": true}' > .claude/settings.local.json`,
    `echo x >> ~/.claude/settings.json`,
    `jq '.hooks = {}' .claude/settings.json | tee .claude/settings.json`,
    `sed -i '' 's/x/y/' "$HOME/.claude/settings.json"`,
    'cp /tmp/s.json /repo/.claude/settings.json',
    'mv .claude .claude.off',
    'rm -rf ~/.claude/plugins/cache/engsys',
    `cp /tmp/x.mjs ${ROOT}/.claude-plugin/singleton-write-guard.mjs`,
    `printf x > ${path.join(ROOT, 'skills/merge-monster/scripts/mm-heartbeat.sh')}`,
  ]) assert.ok(deniedIn(c), `should deny: ${c}`);
  for (const c of ['cat .claude/settings.json', 'jq . ~/.claude/settings.json', 'ls ~/.claude/plugins']) assert.equal(deniedIn(c), false, c);
  for (const [tool, file] of [['Write', '/repo/.claude/settings.local.json'], ['Edit', '/Users/x/.claude/settings.json'], ['MultiEdit', '/repo/.claude/settings.json'],
    ['Write', '/Library/Application Support/ClaudeCode/managed-settings.json'], ['Edit', path.join(ROOT, '.claude-plugin/hooks.json')]]) {
    assert.ok(decide({ tool_name: tool, tool_input: { file_path: file }, env, pluginRoot: ROOT }), `${tool} ${file}`);
  }
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' }, env, pluginRoot: ROOT }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/repo/.claude/settings.json' }, env: { HOME: '/Users/x' }, pluginRoot: ROOT }), null, 'inactive elsewhere');
});

test('L-c: GitHub MCP tools that may write are denied; reads pass', () => {
  for (const t of ['mcp__github__merge_pull_request', 'mcp__plugin_engineering_github__create_issue', 'mcp__github__add_issue_comment', 'mcp__github__authenticate']) {
    assert.ok(decide({ tool_name: t, tool_input: {}, env: MERGE, pluginRoot: ROOT }), t);
  }
  for (const t of ['mcp__github__get_pull_request', 'mcp__github__list_issues', 'mcp__github__search_code', 'mcp__slack__post_message']) {
    assert.equal(decide({ tool_name: t, tool_input: {}, env: MERGE, pluginRoot: ROOT }), null, t);
  }
});

test('L-a: the heartbeat exception needs --state-dir (a heartbeat with no renew is no fence)', () => {
  assert.equal(decide({ command: `${HB} --repo o/r --issue 7 --state-dir d --status x`, env: MERGE, pluginRoot: ROOT }), null);
  assert.ok(wrapperInvocation(`${HB} --repo o/r --issue 7 --status x`, ROOT) === null);
});

test('the guard is registered for Bash, the edit tools and MCP tools', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), 'hooks.json'), 'utf8'));
  const matchers = hooks.hooks.PreToolUse.filter((h) => h.hooks.some((x) => x.command.includes('singleton-write-guard.mjs'))).map((h) => new RegExp(`^(?:${h.matcher})$`));
  for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__github__merge_pull_request']) {
    assert.ok(matchers.some((m) => m.test(t)), t);
  }
});
