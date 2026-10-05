// Tests for fleet-gh-path.mjs (engsys#90): the SessionStart hook keeps the identity shim first on
// PATH for Bash calls even when the login shell's profile re-prepends an unauthenticated gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-gh-path.mjs');

function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-path-'));
  const shim = path.join(t, 'identity', 'bin');
  const brew = path.join(t, 'homebrew', 'bin');
  fs.mkdirSync(shim, { recursive: true });
  fs.mkdirSync(brew, { recursive: true });
  fs.writeFileSync(path.join(t, 'identity', 'gh-app-token.mjs'), '');
  for (const [d, who] of [[shim, 'shim'], [brew, 'unauthenticated']]) {
    fs.writeFileSync(path.join(d, 'gh'), `#!/bin/sh\necho ${who}\n`, { mode: 0o755 });
  }
  const zprofile = path.join(t, 'zprofile');
  fs.writeFileSync(zprofile, `export PATH="${brew}:$PATH"\n`); // what `eval "$(brew shellenv)"` does
  const envFile = path.join(t, 'claude-env');
  return { t, shim, brew, zprofile, envFile };
}

function runHook(env, extra = {}) {
  return spawnSync(process.execPath, [HOOK], { env: { ...process.env, ...env, ...extra }, encoding: 'utf8' });
}

// A Bash tool call: login-shell snapshot (profile re-prepends Homebrew), then $CLAUDE_ENV_FILE, then the command.
function bashCall(s, pathStart, command) {
  return spawnSync('bash', ['-c', `. "${s.zprofile}"; [ ! -f "${s.envFile}" ] || . "${s.envFile}"; ${command}`], {
    env: { PATH: pathStart, HOME: s.t }, encoding: 'utf8',
  }).stdout.trim();
}

const base = (s) => ({ GH_APP_ENV_FILE: '/x/gh-app.env', CLAUDE_ENV_FILE: s.envFile, PATH: `${s.shim}:/usr/bin:/bin` });

test('control: without the hook the login profile shadows the shim', () => {
  const s = sandbox();
  assert.equal(bashCall(s, `${s.shim}:/usr/bin:/bin`, 'gh'), 'unauthenticated');
});

test('with the hook the resolved gh is the shim, past a profile that prepends Homebrew', () => {
  const s = sandbox();
  assert.equal(runHook(base(s)).status, 0);
  assert.equal(bashCall(s, `${s.shim}:/usr/bin:/bin`, 'gh'), 'shim');
  assert.equal(bashCall(s, `${s.shim}:/usr/bin:/bin`, 'command -v gh'), path.join(s.shim, 'gh'));
});

test('idempotent across resume/compact/clear: re-running writes the line once', () => {
  const s = sandbox();
  runHook(base(s)); runHook(base(s)); runHook(base(s));
  assert.equal(fs.readFileSync(s.envFile, 'utf8').trim().split('\n').length, 1);
});

test('preserves lines other hooks wrote (append, never truncate)', () => {
  const s = sandbox();
  fs.writeFileSync(s.envFile, 'export FOO=bar\n');
  runHook(base(s));
  assert.match(fs.readFileSync(s.envFile, 'utf8'), /^export FOO=bar\n/);
});

test('no-op when the fleet identity is not configured', () => {
  const s = sandbox();
  runHook({ ...base(s), GH_APP_ENV_FILE: '' });
  assert.equal(fs.existsSync(s.envFile), false);
});

test('no-op without CLAUDE_ENV_FILE, and fail-open with no shim on PATH', () => {
  const s = sandbox();
  assert.equal(runHook({ ...base(s), CLAUDE_ENV_FILE: '' }).status, 0);
  const r = runHook({ ...base(s), PATH: '/usr/bin:/bin', ENGSYS_DIR: '' });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(s.envFile), false);
});

test('a shim path with spaces and quotes survives the shell', () => {
  const s = sandbox();
  const odd = path.join(s.t, "it's a dir", 'identity', 'bin');
  fs.mkdirSync(odd, { recursive: true });
  fs.writeFileSync(path.join(odd, '..', 'gh-app-token.mjs'), '');
  fs.writeFileSync(path.join(odd, 'gh'), '#!/bin/sh\necho odd\n', { mode: 0o755 });
  runHook({ ...base(s), PATH: `${odd}:/usr/bin:/bin` });
  assert.equal(bashCall(s, '/usr/bin:/bin', 'gh'), 'odd');
});
