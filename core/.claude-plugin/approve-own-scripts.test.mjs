// Tests for approve-own-scripts.mjs — run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvable } from './approve-own-scripts.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approve-own-scripts.mjs');

function fakePlugin() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-approve-')));
  const mm = path.join(root, 'skills/merge-monster/scripts');
  fs.mkdirSync(mm, { recursive: true });
  fs.mkdirSync(path.join(root, 'skills/subagent-liveness'), { recursive: true });
  for (const f of ['mm-agent-reg.sh', 'mm-agent-watch.sh', 'mm-setup.sh']) {
    fs.writeFileSync(path.join(mm, f), '#!/usr/bin/env bash\n', { mode: 0o755 });
  }
  return { root, reg: path.join(mm, 'mm-agent-reg.sh'), watch: path.join(mm, 'mm-agent-watch.sh'), setup: path.join(mm, 'mm-setup.sh') };
}

const P = fakePlugin();

test('approves a single literal-path invocation with quoted args', () => {
  const c = `${P.reg} spawn --state-dir logs/agent-liveness/s1 --name isabelle-123 --task "issue #123 example task" --class fix --deadline-min 45`;
  assert.equal(approvable(c, P.root), 'merge-monster/scripts/mm-agent-reg.sh');
});

test('approves `bash "<path>" … &` (background watchdog)', () => {
  const c = `bash "${P.watch}" --state-dir logs/agent-liveness/s1 --stale-min 10 &`;
  assert.equal(approvable(c, P.root), 'merge-monster/scripts/mm-agent-watch.sh');
});

test('approves backslash-newline continuations', () => {
  const c = `${P.reg} update \\\n  --state-dir logs/agent-liveness/s1 --name isabelle-123 --gen 1 \\\n  --agent-id isabelle-123@session-1`;
  assert.ok(approvable(c, P.root));
});

test('approves a path that normalizes into the allowlist', () => {
  const c = `${P.root}/skills/subagent-liveness/../merge-monster/scripts/mm-agent-reg.sh list --state-dir x`;
  assert.ok(approvable(c, P.root));
});

const REJECT = {
  'the variable-based compound form sessions produced': `cd /repo\nENGSYS_ROOT=${P.root}\nSID=s1\nmkdir -p logs/agent-liveness/$SID\n"$ENGSYS_ROOT/skills/merge-monster/scripts/mm-agent-reg.sh" spawn --state-dir logs/agent-liveness/$SID`,
  'cd && chaining': `cd /repo && ${P.reg} spawn`,
  'semicolon chaining': `${P.reg} spawn; rm -rf /`,
  'pipe': `${P.reg} spawn | tee out`,
  'redirect': `${P.reg} spawn > /tmp/x`,
  'command substitution': `${P.reg} spawn --name $(whoami)`,
  'backticks': `${P.reg} spawn --name \`whoami\``,
  'glob': `${P.reg} spawn --state-dir logs/*`,
  'non-allowlisted script (setup)': `${P.setup} --repo a/b`,
  'relative path': `.claude/skills/merge-monster/scripts/mm-agent-reg.sh spawn`,
  'bash -c': `bash -c "${P.reg} spawn"`,
  'unbalanced quote': `${P.reg} spawn --task "oops`,
  'double background': `${P.reg} spawn &&`,
  'env-assignment prefix': `FOO=1 ${P.reg} spawn`,
};
for (const [name, c] of Object.entries(REJECT)) {
  test(`rejects: ${name}`, () => assert.equal(approvable(c, P.root), null));
}

test('rejects the same relative script under a different root', () => {
  const other = fakePlugin();
  assert.equal(approvable(`${other.reg} spawn`, P.root), null);
});

test('rejects an allowlisted name that is a symlink escaping the plugin', () => {
  const evilRoot = fakePlugin();
  const outside = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))), 'evil.sh');
  fs.writeFileSync(outside, '#!/usr/bin/env bash\n', { mode: 0o755 });
  fs.rmSync(evilRoot.reg);
  fs.symlinkSync(outside, evilRoot.reg);
  assert.equal(approvable(`${evilRoot.reg} spawn`, evilRoot.root), null);
});

test('hook: emits an allow decision for an approvable Bash call, nothing otherwise', () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: P.root }, encoding: 'utf8',
  });
  const ok = run({ tool_name: 'Bash', tool_input: { command: `${P.reg} spawn --name a` } });
  assert.equal(ok.status, 0);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: `cd /x && ${P.reg} spawn` } },
    { tool_name: 'Read', tool_input: { file_path: P.reg } },
    { garbage: true },
  ]) {
    const r = run(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('copy-mode settings template allows exactly the same scripts (lockstep)', async () => {
  const { ALLOWED } = await import('./approve-own-scripts.mjs');
  const tmpl = fs.readFileSync(path.join(path.dirname(HOOK), '..', 'templates', 'settings.json.tmpl'), 'utf8');
  for (const rel of ALLOWED) {
    assert.ok(tmpl.includes(`"Bash(.claude/skills/${rel} *)"`), `missing direct rule for ${rel}`);
    assert.ok(tmpl.includes(`"Bash(bash .claude/skills/${rel} *)"`), `missing bash rule for ${rel}`);
  }
  const listed = [...tmpl.matchAll(/"Bash\((?:bash )?\.claude\/skills\/([^ ]+\.sh) \*\)"/g)].map((m) => m[1]);
  for (const rel of listed) assert.ok(ALLOWED.has(rel), `template allows ${rel}, which the hook does not`);
});
