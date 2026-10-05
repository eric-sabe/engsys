// Tests for singleton-write-guard.mjs (engsys#62, review H1) — run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WRAPPERS, decide, githubWrites, lex, wrapperInvocation } from './singleton-write-guard.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'singleton-write-guard.mjs');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-guard-')));
for (const rel of ['merge-monster/scripts/mm-act.sh', 'merge-monster/scripts/mm-heartbeat.sh', 'merge-monster/scripts/mm-baton.sh',
  'merge-monster/scripts/mm-setup.sh', 'merge-monster/scripts/gate-request.sh', 'maintenance-monster/scripts/mnt-act.sh', 'maintenance-monster/scripts/mnt-heartbeat.sh']) {
  fs.mkdirSync(path.dirname(path.join(ROOT, 'skills', rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'skills', rel), '#!/usr/bin/env bash\n', { mode: 0o755 });
}
const ACT = path.join(ROOT, 'skills/merge-monster/scripts/mm-act.sh');
const MNT_ACT = path.join(ROOT, 'skills/maintenance-monster/scripts/mnt-act.sh');
const HB = path.join(ROOT, 'skills/merge-monster/scripts/mm-heartbeat.sh');
const SETUP = path.join(ROOT, 'skills/merge-monster/scripts/mm-setup.sh');
const GATE_REQ = path.join(ROOT, 'skills/merge-monster/scripts/gate-request.sh');
const BATON = path.join(ROOT, 'skills/merge-monster/scripts/mm-baton.sh');
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
  const cmds = hooks.hooks.PreToolUse.filter((h) => new RegExp(`^(?:${h.matcher})$`).test('Bash')).flatMap((h) => h.hooks.map((x) => x.command));
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

test('running the plugin\'s own skill scripts is execution, not a write (v1.11 canary regression)', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const denied = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  const cache = '/Users/x/.claude/plugins/cache/engsys/engsys/1.11.0/skills/maintenance-monster/scripts';
  for (const c of [
    `bash ${cache}/mnt-snapshot.sh --config /c.yml`,
    `bash ${path.join(ROOT, 'skills/maintenance-monster/scripts/mnt-watch.sh')} --state-dir logs/m`,
    `${cache}/mnt-fp-candidates.sh --config /c.yml`,
    `sh -e ${cache}/mm-agent-watch.sh --state-dir logs/m --stale-min 10`,
    `node ${cache}/mnt-fp.mjs candidates --repo o/r`,
    `bash ${cache}/mnt-snapshot.sh --config /c.yml | jq .alerts`,
    `bash ${cache}/mnt-snapshot.sh > /tmp/snap.json`,
  ]) assert.equal(denied(c), false, `should allow: ${c}`);
  for (const c of [
    `printf x > ${cache}/mnt-snapshot.sh`,
    `cat /tmp/a.sh > ${cache}/mnt-snapshot.sh`,
    `bash ${cache}/mnt-snapshot.sh > ${cache}/mnt-watch.sh`,
    `cp /tmp/x.sh ${cache}/mnt-snapshot.sh`,
    `node -e "require('fs').writeFileSync('x')" ${cache}/mnt-fp.mjs`,
    `bash ${cache}/mnt-snapshot.sh /Users/x/.claude/settings.json`,
    `bash /Users/x/.claude/settings.json`,
  ]) assert.ok(denied(c), `should deny: ${c}`);
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

test('engsys#77 M2: an unwrapped `fleet msg send` is denied in a singleton session; reads and the fenced form pass', () => {
  for (const cmd of [
    'fleet msg send --to bob:acme-build --body-file /tmp/b.txt',
    'bash /opt/engsys/core/fleet/bin/fleet --instance /x msg send --to bob:acme-build --body-file b',
    '/opt/engsys/core/fleet/bin/fleet msg send --to bob:x --body-file b',
    'node /opt/engsys/core/fleet/msg.mjs send --to bob:x --body-file b',
    'bash /opt/engsys/core/fleet/msg.sh send --to bob:x --body-file b',
    'cd /tmp && fleet msg send --to bob:x --body-file b',
    'echo hi; node ./msg.mjs send --to bob:x --body-file b',
  ]) {
    assert.equal(denied(cmd), true, cmd);
    assert.equal(denied(cmd, { ENGSYS_SINGLETON_ROLE: 'maintain' }), true, cmd);
    assert.equal(denied(cmd, {}), false, `inactive outside a singleton session: ${cmd}`);
  }
  for (const cmd of [
    'fleet msg inbox --mark-read',
    'node /opt/engsys/core/fleet/msg.mjs inbox',
    'node /opt/engsys/core/fleet/msg.mjs read https://github.com/acme/app/issues/1#issuecomment-2',
  ]) assert.equal(denied(cmd), false, cmd);
  assert.equal(denied(`${ACT} guard --repo acme/app --state-dir /tmp/s -- fleet msg send --to bob:x --body-file b`), false);
  assert.equal(denied(`bash ${MNT_ACT} guard --repo acme/app --state-dir /tmp/s -- fleet msg send --to bob:x --body-file b`, { ENGSYS_SINGLETON_ROLE: 'maintain' }), false);
});

// ------------------------------------------------------------------------------- #71 follow-ups --

test('#71 L1: gh api graphql whose document is hidden behind a substitution or a variable is denied', () => {
  for (const c of [
    'gh api graphql -f query="$(cat /tmp/m.graphql)"',
    'gh api graphql -F query="$(< m.graphql)"',
    'Q=$(cat m); gh api graphql -f query="$Q"',
    'gh api graphql -f query=$Q',
    'gh api graphql -f query="${Q}"',
    'gh api graphql -f "query=$Q"',
    'gh api graphql --raw-field="query=$Q"',
    'gh api graphql -fquery="$Q"',
    'gh api graphql -f query="`cat m`"',
    "gh api graphql -f query=$'\\x6dutation{addComment(input:{}){clientMutationId}}'",
    `gh api graphql -f query='query { viewer { login } }' -f login="$WHO"`,
    `gh api graphql -f query='query { viewer { login } }' --jq "$(echo .data)"`,
    `diff <(echo a) b; gh api graphql -f query='query { viewer { login } }'`,
    `bash -c 'gh api graphql -f query="$Q"'`,
    'gh api /graphql -f query="$Q"',
    `printf 'query=mutation{x}' | xargs -0 gh api graphql -f`,
    `echo '-X PUT repos/o/r/pulls/1/merge' | xargs gh api`,
    `cat urls | parallel gh api {}`,
  ]) assert.ok(denied(c), `should deny: ${c}`);
});

test('#71 L1: a GraphQL merge mutation is denied outright (merges use the sha-pinned wrapper)', () => {
  for (const c of [
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x", expectedHeadOid: "abc"}) { clientMutationId } }'`,
    `gh api graphql -f query='query { x: mergePullRequest }'`,
    `gh api graphql --raw-field='query=mutation M { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "r", base: "main", head: "x"}) { clientMutationId } }'`,
  ]) {
    const d = decide({ command: c, env: MERGE, pluginRoot: ROOT });
    assert.ok(d, `should deny: ${c}`);
    assert.match(d.deny, /graphql merge|mutation/, c);
  }
  assert.match(decide({ command: `gh api graphql -f query='query { x: mergePullRequest }'`, env: MERGE, pluginRoot: ROOT }).deny, /sha-pinned/);
});

test('#71 L1: visible GraphQL reads still pass, single-quoted $variables included; REST GETs with a variable path pass', () => {
  for (const c of [
    `gh api graphql -f query='query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }' -f owner=o -f name=r`,
    `gh api graphql -f query='query { viewer { login } }' --jq .data.viewer.login`,
    `gh api graphql -F number=12 -f query='query($number: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $number) { reviewThreads(first: 50) { nodes { isResolved } } } } }'`,
    'gh api "repos/$REPO/pulls/12"',
    'gh pr view "$PR" --json state',
    `gh pr list --json number --jq '.[].number' | xargs -n1 gh pr view --json state`,
  ]) assert.equal(decide({ command: c, env: MERGE, pluginRoot: ROOT }), null, c);
});

test('#71 L2: hub and interpreters running GitHub client code are denied', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    'hub api --method PUT repos/o/r/pulls/1/merge',
    'hub merge https://github.com/o/r/pull/1',
    '/usr/local/bin/hub pr list',
    `node -e "const {Octokit}=require('@octokit/rest'); new Octokit({auth: process.env.GH_TOKEN}).pulls.merge({owner:'o',repo:'r',pull_number:1})"`,
    `node --input-type=module -e "import { Octokit } from 'octokit'; await new Octokit().request('PUT /repos/o/r/pulls/1/merge')"`,
    `python3 -c "from github import Github; Github('t').get_repo('o/r').get_pull(1).merge()"`,
    `python3.12 -c "import github"`,
    `ruby -e 'require "octokit"; Octokit::Client.new.merge_pull_request("o/r", 1)'`,
    `perl -MLWP::UserAgent -e 'LWP::UserAgent->new->post("https://github.com/o/r/pulls")'`,
    `deno eval "await fetch('https://github.com/o/r/pulls', {method: 'POST'})"`,
    `bun -e "await fetch('https://github.com/o/r/pulls', {method: 'POST'})"`,
    `node <<'EOF'\nconst { Octokit } = require('@octokit/rest')\nnew Octokit().pulls.merge({})\nEOF`,
    `python3 - <<'EOF'\nfrom github import Github\nEOF`,
    'echo "import github; github.Github().get_repo(1)" | python3',
    'npx octokit-cli merge o/r 1',
    `env GH_TOKEN=x node -e "require('@octokit/rest')"`,
  ]) assert.ok(deniedIn(c), `should deny: ${c}`);
});

test('#71 L2: interpreter code that names a protected path is denied, a path glued to code included', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    `python3 -c "open('.claude/settings.local.json','w').write('{}')"`,
    `python3 -c "import os; open(os.path.join(os.environ['HOME'], '.claude', 'settings.json'), 'w')"`,
    `python3 - <<'EOF'\nopen('/Users/x/.claude/settings.json', 'w').write('{}')\nEOF`,
    `node -e "require('fs').writeFileSync(process.env.CLAUDE_PLUGIN_ROOT + '/.claude-plugin/hooks.json', '{}')"`,
    `node -e "require('fs').writeFileSync('${ROOT}/.claude-plugin/hooks.json', '{}')"`,
    `ruby -e 'File.write(".git/config", "[credential]\\n\\thelper = !x")'`,
    `perl -e 'open(F, ">>", "/Users/x/.gitconfig")'`,
    `awk 'BEGIN { print "x" > ".claude/settings.json" }'`,
  ]) assert.ok(deniedIn(c), `should deny: ${c}`);
});

test('#71 L2: plain interpreter use and the kit\'s own scripts still pass', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  const cache = '/Users/x/.claude/plugins/cache/engsys/engsys/1.11.0/skills/maintenance-monster/scripts';
  for (const c of [
    `node ${cache}/mnt-fp.mjs candidates --repo o/r`,
    `node ${cache}/mnt-fp.mjs dismiss --repo o/r --alert 3 --evidence "merge of https://github.com/o/r/pull/1 with a token check"`,
    `node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).length)"`,
    `python3 -c "import json, sys; print(len(json.load(sys.stdin)))"`,
    `bash ${cache}/mnt-snapshot.sh --config /c.yml | node -e "process.stdin.pipe(process.stdout)"`,
    'node --version',
    'python3 --version',
    'gh pr list --search node',
    `python3 -c "import yaml; print(yaml.safe_load(open('.claude/maintenance-monster.yml'))['repo'])"`,
  ]) assert.equal(deniedIn(c), false, `should allow: ${c}`);
});

test('#71: the fenced wrappers run only as one plain command (the heartbeat needs --state-dir; gate-request only under guard)', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    `${HB} --repo o/r --issue 7 --status x`,
    `bash ${HB} --repo o/r --issue 7 --status x`,
    `cd ${path.dirname(HB)} && ./mm-heartbeat.sh --repo o/r --issue 7 --state-dir d --status x`,
    `${ACT} merge --repo o/r --state-dir d --pr 1 --sha ${'a'.repeat(40)} --method squash | tee /tmp/x`,
    `${GATE_REQ} --repo o/r --pr 1 --kind merge`,
    `bash ${GATE_REQ} --repo o/r --pr 1 --kind merge`,
  ]) assert.ok(deniedIn(c), `should deny: ${c}`);
  for (const c of [
    `${ACT} guard --repo o/r --state-dir d -- ${GATE_REQ} --repo o/r --pr 1 --kind merge`,
    `${HB} --repo o/r --issue 7 --state-dir d --status x`,
    `cat ${ACT}`,
    `grep -n fence ${HB}`,
  ]) assert.equal(deniedIn(c), false, `should allow: ${c}`);
});

test('#71 L3: git config files are protected like settings (Bash writes and the edit tools)', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    `printf '[credential]\\n\\thelper = !x\\n' >> .git/config`,
    'cp /tmp/c ../wt/.git/config',
    'tee -a /Users/x/.gitconfig < /tmp/c',
    `sed -i '' 's/x/y/' /repo/.git/worktrees/wt/config.worktree`,
  ]) assert.ok(deniedIn(c), `should deny: ${c}`);
  for (const c of ['cat .git/config', 'git config --get remote.origin.url', 'git -C ../wt status --porcelain']) assert.equal(deniedIn(c), false, c);
  for (const file of ['/repo/.git/config', '/Users/x/.gitconfig', '/Users/x/.config/git/config', '/repo/.git/worktrees/wt/config.worktree']) {
    assert.ok(decide({ tool_name: 'Write', tool_input: { file_path: file }, env, pluginRoot: ROOT }), file);
  }
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/repo/.github/config.yml' }, env, pluginRoot: ROOT }), null);
});

// The monsters' own documented commands must keep passing (v1.11 canary lesson): every command the
// two SKILL.md files tell the session to run, and every skill script run the ways a session runs it.
test('#71: every command the monster skills document, and every monster script, passes the guard', () => {
  const core = path.resolve(path.dirname(HOOK), '..');
  const env = { HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: core };
  const commands = [];
  for (const monster of ['merge-monster', 'maintenance-monster']) {
    const md = fs.readFileSync(path.join(core, 'skills', monster, 'SKILL.md'), 'utf8');
    const snippets = [...md.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]);
    const prose = md.replace(/```[\s\S]*?```/g, '');
    snippets.push(...[...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s*\n\s*/g, ' '))); // a code span may wrap
    for (const raw of snippets) {
      if (!/^\s*(bash\s+)?<(skill-dir|engsys-root)>\//.test(raw)) continue;
      const cmd = raw.trim()
        .replace(/<skill-dir>/g, path.join(core, 'skills', monster))
        .replace(/<engsys-root>/g, core)
        .replace(/<repo>/g, 'o/r').replace(/<state_dir>/g, `logs/${monster}`)
        .replace(/\b(\w+)(?:\\?\|\w+)+/g, '$1') // notation: merge|squash or merge\|squash -> merge (a pipe has spaces)
        .replace(/\(([^()|]+?) \| [^()]*\)/g, '$1') // notation: (--issue N | --pr N) -> --issue N
        .replace(/gh <args…>/g, 'gh pr ready 12')
        .replace(/<[^>]*>/g, 'x').replace(/…/g, '');
      const first = lex(cmd).words[0] ?? [];
      const script = first.find((w) => w.startsWith(core));
      if (!script || !fs.existsSync(script) || !fs.statSync(script).isFile()) continue;
      if (first.indexOf(script) === first.length - 1) continue; // a bare path the prose names, not a command
      commands.push(cmd);
    }
  }
  assert.ok(commands.length >= 15, `extracted only ${commands.length} documented commands`);
  // Reads and local work the docs name inline (not as a full <skill-dir> command).
  commands.push(
    'gh pr view 12 --json state,headRefOid,mergeStateStatus',
    'gh pr checks 12',
    'gh run view 99 --log-failed',
    'gh run watch 99',
    'gh search prs --repo o/r --state open',
    'gh api repos/o/r/pulls/12/reviews',
    'git show abc123:src/a.ts',
    'git -C ../wt status --porcelain',
    'git worktree remove ../wt --force',
    'git worktree prune',
    'git branch -D agent/1-x',
    'git fetch origin && git rebase origin/main',
    'fleet notify --level alert --incident baton-lost-merge "lost the merge baton"',
    'fleet notify --level action --re https://github.com/o/r/pull/12 --incident mm-12 "needs a human: push token"',
    'fleet notify --resolve --incident mm-12',
  );
  const scriptsSeen = [];
  for (const monster of ['merge-monster', 'maintenance-monster']) {
    const dir = path.join(core, 'skills', monster, 'scripts');
    for (const f of fs.readdirSync(dir)) {
      if (/\.test\./.test(f)) continue;
      const p = path.join(dir, f);
      const rel = `${monster}/scripts/${f}`;
      if (f === 'gate-request.sh') { commands.push(`${path.join(core, 'skills/merge-monster/scripts/mm-act.sh')} guard --repo o/r --state-dir d -- ${p} --repo o/r --pr 12 --kind merge`); continue; }
      const args = '--repo o/r --state-dir logs/m --issue 7 --status running';
      if (WRAPPERS.has(rel)) { commands.push(f.includes('-act.') ? `${p} guard ${args} -- gh pr ready 12` : `${p} ${args}`); continue; }
      scriptsSeen.push(f);
      if (f.endsWith('.mjs')) commands.push(`node ${p} candidates --repo o/r`);
      else commands.push(`${p} ${args}`, `bash ${p} ${args}`, `bash ${p} ${args} | jq .`);
    }
  }
  assert.ok(scriptsSeen.includes('mnt-snapshot.sh') && scriptsSeen.includes('mm-agent-watch.sh') && scriptsSeen.includes('mnt-fp.mjs'), scriptsSeen.join(' '));
  for (const role of ['merge', 'maintain']) {
    for (const c of commands) {
      const d = decide({ command: c, env: { ...env, ENGSYS_SINGLETON_ROLE: role }, pluginRoot: core, cwd: '/repo' });
      assert.equal(d, null, `${role} should allow: ${c}\n${d?.deny ?? ''}`);
    }
  }
});

// ------------------------------------------------------------------------- #85 Nyx follow-ups --

const NYX_ENV = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
const nyxDenied = (command, tool_name = 'Bash') => decide({ tool_name, tool_input: { command }, env: NYX_ENV, pluginRoot: ROOT, cwd: '/repo' }) !== null;
const CACHE = '/Users/x/.claude/plugins/cache/engsys/engsys/1.11.1/skills';

test('#85 M1: a Monitor command is checked like Bash; the monsters\' watch scripts still pass', () => {
  assert.ok(nyxDenied('until gh pr checks 5 --required; do sleep 30; done; gh pr merge 5 --squash', 'Monitor'));
  assert.ok(nyxDenied('while true; do git push origin HEAD; sleep 60; done', 'Monitor'));
  for (const c of [
    `bash ${CACHE}/merge-monster/scripts/mm-watch.sh --repo o/r --state-dir logs/mm --interval 30 --default-branch main --ledger 7`,
    `bash ${CACHE}/maintenance-monster/scripts/mnt-watch.sh --repo o/r --state-dir logs/mnt --interval 30 --default-branch main --ledger 8`,
    `bash ${CACHE}/merge-monster/scripts/mm-agent-watch.sh --state-dir logs/mm --stale-min 10`,
    'tail -f logs/mm/journal.md | grep --line-buffered ERROR',
  ]) assert.equal(nyxDenied(c, 'Monitor'), false, `should allow: ${c}`);
  assert.equal(decide({ tool_name: 'Monitor', tool_input: { ws: { url: 'wss://x' } }, env: NYX_ENV, pluginRoot: ROOT }), null, 'a WebSocket Monitor has no command');
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), 'hooks.json'), 'utf8'));
  const matchers = hooks.hooks.PreToolUse.filter((h) => h.hooks.some((x) => x.command.includes('singleton-write-guard.mjs'))).map((h) => new RegExp(`^(?:${h.matcher})$`));
  assert.ok(matchers.some((m) => m.test('Monitor')), 'hooks.json routes Monitor to the guard');
});

test('#85 L1: argv-array subprocess calls in interpreter code are read as the commands they run', () => {
  for (const c of [
    `python3 -c "import subprocess; subprocess.run(['gh','pr','merge','5','--squash'])"`,
    `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['gh', 'pr', 'merge', '5'])\nPY`,
    `node -e "require('child_process').execFileSync('gh',['pr','merge','5'])"`,
    `node -e "require('child_process').execFileSync('git',['push','origin','HEAD:main'])"`,
    `perl -e 'system("gh","pr","merge","5")'`,
    `ruby -e 'system("gh","pr","merge","5")'`,
    `python3 -c "import os; os.execvp('gh',['gh','api','-X','PUT','repos/o/r/pulls/5/merge'])"`,
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
  for (const c of [
    `python3 -c "import subprocess; print(subprocess.run(['git','log','-1'], capture_output=True).stdout)"`,
    `node -e "console.log(require('child_process').execFileSync('gh',['pr','view','5','--json','state']).toString())"`,
  ]) assert.equal(nyxDenied(c), false, `should allow: ${c}`);
});

test('#85 L2: command names match case-insensitively, and $\'…\' / $"…" quoting is read through', () => {
  for (const c of [
    'GH pr merge 5',
    'Gh pr merge 5',
    'GIT push origin HEAD',
    'Hub merge https://github.com/o/r/pull/1',
    `NODE -e "require('@octokit/rest')"`,
    "$'gh' pr merge 5",
    '$"gh" pr merge 5',
    "$'\\x67h' pr merge 5",
    'CURL -X PUT https://api.github.com/repos/o/r/pulls/1/merge',
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
});

test('#85 L3: shell snapshots and session-env files are protected (sourced before every Bash call)', () => {
  for (const c of [
    `printf 'export GIT_SSH_COMMAND=/tmp/x\\n' >> ~/.claude/shell-snapshots/snapshot-zsh-1.sh`,
    'echo "export GH_TOKEN=x" > /Users/x/.claude/session-env/abc/env.sh',
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
  for (const file of ['/Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh', '/Users/x/.claude/session-env/abc/env.sh']) {
    assert.ok(decide({ tool_name: 'Write', tool_input: { file_path: file }, env: NYX_ENV, pluginRoot: ROOT }), file);
  }
  assert.ok(decide({ tool_name: 'Edit', tool_input: { file_path: '/cfg/shell-snapshots/s.sh' }, env: { ...NYX_ENV, CLAUDE_CONFIG_DIR: '/cfg' }, pluginRoot: ROOT }), 'under CLAUDE_CONFIG_DIR too');
});

test('#85 L6: a gh api method hidden in an unquoted variable or a leading expansion is denied; quoted path interpolation passes', () => {
  for (const c of [
    `A='-X PUT'; gh api repos/o/r/pulls/5/merge $A`,
    'gh api repos/o/r/pulls/5/merge ${M:+-XPUT}',
    'gh api repos/$REPO/pulls/5/merge',
    'gh api "$EP"',
    'gh api repos/o/r/pulls/5/merge "$M"',
    'gh api repos/o/r/pulls/5/merge $(printf -- -XPUT)',
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
  for (const c of ['gh api "repos/$REPO/pulls/12"', 'gh api "repos/o/r/pulls/$N/reviews" --jq length', 'gh api repos/o/r/pulls/12']) {
    assert.equal(nyxDenied(c), false, `should allow: ${c}`);
  }
});

test('#85 F1: interpreter names outside command position, and heredocs of data, pass', () => {
  for (const c of [
    `grep -rn python3 ${CACHE}/maintenance-monster/scripts`,
    `rg -n node ${CACHE}/merge-monster/SKILL.md`,
    `grep -rn "python3" ~/.claude/plugins/cache/engsys`,
    `cat > /tmp/body.md <<'EOF'\nPR https://github.com/o/r/pull/5 could not merge: node 22 build fails; the guarded git push is next.\nEOF`,
    `${ACT} guard --repo o/r --state-dir d -- gh issue comment 5 --body-file - <<'EOF'\nEscalation: node 22 fails; next is the guarded git push; check .claude/settings.json.\nEOF`,
    `tee /tmp/digest.md <<EOF\ngh pr merge is never run here; python3 and node were both fine.\nEOF`,
    'echo "a <<EOF b"',
  ]) assert.equal(nyxDenied(c), false, `should allow: ${c}`);
  for (const c of [
    `bash <<'EOF'\ngh pr merge 5\nEOF`,
    `cat <<'EOF' | sh\ngit push origin HEAD\nEOF`,
    `python3 <<'EOF'\nimport subprocess; subprocess.run(['gh','pr','merge','5'])\nEOF`,
    `echo "<<X"\ngh pr merge 5`,
    `cat <<'EOF' > ~/.claude/settings.json\n{}\nEOF`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 5 <<'EOF' | bash\ngh pr merge 5\nEOF`,
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
});

test('#85 F2: wrapper forms that change nothing pass; env prefixes run kit scripts, never gh or git or a wrapper', () => {
  const home = path.dirname(ROOT);
  const viaTilde = `~/${path.basename(ROOT)}/skills/merge-monster/scripts/mm-act.sh`;
  const env = { ...NYX_ENV, HOME: home };
  for (const c of [
    `${HB} --repo o/r --issue 7 --state-dir=logs/mm --status x`,
    `${viaTilde} guard --repo o/r --state-dir d -- gh pr ready 5`,
    `${ACT} merge --repo o/r --state-dir d --pr 1 --sha ${'a'.repeat(40)} --method squash; echo "exit=$?"`,
    `${ACT} merge --repo o/r --state-dir d --pr 1 --sha ${'a'.repeat(40)} --method squash; echo $?`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 5 2>&1`,
    `${BATON} status --repo o/r --state-dir d | jq .`,
    `${BATON} status --repo o/r --state-dir d | jq -r '.holding'`,
    `${BATON} status --repo o/r --state-dir d 2>&1 | cat`,
    `REPO=o/r ${CACHE}/merge-monster/scripts/mm-snapshot.sh --repo o/r`,
    `LIVENESS=1 bash ${CACHE}/merge-monster/scripts/mm-agent-watch.sh --state-dir logs/mm`,
  ]) assert.equal(decide({ command: c, env, pluginRoot: ROOT, cwd: '/repo' }), null, `should allow: ${c}`);
  for (const c of [
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 5 | bash`,
    `${ACT} guard --repo o/r --state-dir d -- gh pr ready 5; gh pr merge 5`,
    `${BATON} status --repo o/r --state-dir d | jq . > ~/.claude/settings.json`,
    `ENGSYS_NEW_BRANCH_PREFIX= ${ACT} guard --repo o/r --state-dir d --new-branch -- git push origin HEAD:refs/heads/release/x`,
    'GH_TOKEN=x gh pr view 5',
    'GIT_SSH_COMMAND=/tmp/x git fetch origin',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=/tmp/x git fetch',
  ]) assert.ok(decide({ command: c, env, pluginRoot: ROOT, cwd: '/repo' }), `should deny: ${c}`);
});

test('#85 (keystone-maintain): a plugin-cache path handed to a kit script is a read; settings and git config are not', () => {
  const cfg = '/Users/x/.claude/plugins/cache/ff-engsys-fleet/feedfrwd/0.1.10/repos/FeedFrwd/keystone/maintenance-monster.yml';
  const script = `${CACHE}/maintenance-monster/scripts/mnt-fp-candidates.sh`;
  for (const c of [
    `${script} --repo FeedFrwd/keystone --config ${cfg}`,
    `bash ${script} --repo FeedFrwd/keystone --config ${cfg}`,
    `${script} --repo FeedFrwd/keystone --config=${cfg}`,
    `cat ${cfg}`,
  ]) assert.equal(nyxDenied(c), false, `should allow: ${c}`);
  for (const c of [
    `${script} --repo o/r --config /Users/x/.claude/settings.json`,
    `${script} --repo o/r --config /repo/.git/config`,
    `cp ${cfg} /tmp/x && ${script} --config ${cfg} > ${cfg}`,
    `node -e "1" ${cfg}`,
  ]) assert.ok(nyxDenied(c), `should deny: ${c}`);
});

// ------------------------------------------------------- #92 NF1: unquoted heredocs expand --

test('#92 NF1: an unquoted heredoc runs its substitutions whatever reads it; a quoted one is data', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    'cat <<EOF\n$(gh pr merge 5)\nEOF',
    'cat <<EOF\n`gh pr merge 5`\nEOF',
    'tee /tmp/f <<EOF\nnote: $(gh pr merge 5) done\nEOF',
    'cat <<-EOF\n\t$(git push origin HEAD)\n\tEOF',
    'cat <<EOF\n$(echo $(gh pr merge 5))\nEOF',
    'cat <<EOF\n$(echo ")"; gh pr merge 5)\nEOF',
    "cat <<EOF\n$(echo ')' ; gh pr merge 5)\nEOF",
    'cat <<EOF\n$(gh pr merge 5\nEOF',
    `${ACT} guard --repo o/r --state-dir d -- gh issue comment 5 --body-file - <<EOF\n$(gh pr merge 5)\nEOF`,
    'python3 <<EOF\n$(gh pr merge 5)\nEOF',
    'gh api graphql -F query=x <<EOF\n$QUERY\nEOF',
  ]) assert.ok(deniedIn(c), `should deny: ${JSON.stringify(c)}`);
  for (const c of [
    "cat <<'EOF'\n$(gh pr merge 5)\nEOF",
    'cat <<"EOF"\n`gh pr merge 5`\nEOF',
    'cat <<\\EOF\n$(gh pr merge 5)\nEOF',
    'cat <<EOF\nescaped \\$(gh pr merge 5) and \\`gh pr merge 5\\`\nEOF',
    'cat > /tmp/b.md <<EOF\nPR $N: node 22 failed; next the guarded git push. Built $(date).\nEOF',
    `${ACT} guard --repo o/r --state-dir d -- gh issue comment 5 --body-file - <<EOF\nPR $N failed on node 22\nEOF`,
  ]) assert.equal(deniedIn(c), false, `should allow: ${JSON.stringify(c)}`);
});

test('#92 NF1: a heredoc feeding eval, a read loop that evals, or xargs … sh -c is code', () => {
  const env = { ...MERGE, HOME: '/Users/x', CLAUDE_PLUGIN_ROOT: ROOT };
  const deniedIn = (command) => decide({ command, env, pluginRoot: ROOT, cwd: '/repo' }) !== null;
  for (const c of [
    "while read l; do eval \"$l\"; done <<'EOF'\ngh pr merge 5\nEOF",
    "while read l\ndo\n  eval \"$l\"\ndone <<'EOF'\ngh pr merge 5\nEOF",
    "while read -r l; do bash -c \"$l\"; done <<'EOF'\ngit push origin HEAD\nEOF",
    "for f in a; do $f; done <<'EOF'\ngh pr merge 5\nEOF",
    "xargs -I{} sh -c {} <<'EOF'\ngh pr merge 5\nEOF",
    "xargs -n1 bash -c <<'EOF'\ngh pr merge 5\nEOF",
    "parallel sh -c {} <<'EOF'\ngh pr merge 5\nEOF",
    "source /dev/stdin <<'EOF'\ngh pr merge 5\nEOF",
    "{ while read l; do eval \"$l\"; done; } <<'EOF'\ngh pr merge 5\nEOF",
    "while read l; do eval \"$l\"; done 0<<'EOF'\ngh pr merge 5\nEOF",
    "(while read l; do eval \"$l\"; done) <<'EOF'\ngh pr merge 5\nEOF",
    "parallel --jobs 2 sh -c {} <<'EOF'\ngh pr merge 5\nEOF",
    "xargs --max-args 1 sh -c <<'EOF'\ngh pr merge 5\nEOF",
  ]) assert.ok(deniedIn(c), `should deny: ${JSON.stringify(c)}`);
  for (const c of [
    "while read l; do echo \"$l\"; done <<'EOF'\ngh pr merge 5\nEOF",
    "{ cat; } <<'EOF'\ngh pr merge 5\nEOF",
    "echo start; cat <<'EOF'\ngh pr merge 5\nEOF",
  ]) assert.equal(deniedIn(c), false, `should allow: ${JSON.stringify(c)}`);
});
