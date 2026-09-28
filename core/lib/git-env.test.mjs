// Tests for git-env.mjs — run by `node --test core/lib/git-env.test.mjs`.
//
// The bug: a child git started with no scrubbed env inherits the parent's GIT_DIR. Under a git
// pre-push hook that is the developer's real repo, so `git init` / `git config` rewrite its config.
// These tests simulate the hook (export GIT_DIR/GIT_WORK_TREE at a throwaway "real" repo) and prove
// the helper leaves that repo untouched.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_LOCATION_VARS, scrubbedGitEnv, hermeticGit } from './git-env.mjs';

const mkTmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

describe('hermetic git helper', () => {
  let realRepo; // stands in for the developer's repo that a pre-push hook points GIT_DIR at
  let scratch; // where a test's throwaway git operations run
  const saved = {};

  beforeEach(() => {
    realRepo = mkTmp('hermetic-realrepo-');
    scratch = mkTmp('hermetic-scratch-');
    // Build the "real" repo with a known identity, hermetically, BEFORE GIT_DIR is exported.
    hermeticGit(realRepo, ['init', '-q'], { isolateConfig: true });
    hermeticGit(realRepo, ['config', 'user.email', 'dev@example.com'], { isolateConfig: true });
    hermeticGit(realRepo, ['config', 'user.name', 'Real Dev'], { isolateConfig: true });
    // Now behave like the hook: export GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE at the real repo.
    for (const v of GIT_LOCATION_VARS) saved[v] = process.env[v];
    process.env.GIT_DIR = path.join(realRepo, '.git');
    process.env.GIT_WORK_TREE = realRepo;
    process.env.GIT_INDEX_FILE = path.join(realRepo, '.git', 'index');
  });

  afterEach(() => {
    for (const v of GIT_LOCATION_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    fs.rmSync(realRepo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const outerConfig = () => path.join(realRepo, '.git', 'config');

  test('control: an UN-scrubbed child git really does rewrite the inherited repo', () => {
    // Guards against a vacuous pass: proves the hazard exists in this environment.
    const before = fs.readFileSync(outerConfig());
    // raw-git-ok: deliberate raw call
    execFileSync('git', ['config', 'user.name', 'Injected Identity'], { cwd: scratch, env: process.env });
    const after = fs.readFileSync(outerConfig());
    assert.ok(!after.equals(before), 'raw git config with an inherited GIT_DIR did not touch the outer repo');
    assert.match(after.toString('utf8'), /Injected Identity/);
  });

  test('leaves the hook repo config byte-identical when running throwaway git ops', () => {
    const before = fs.readFileSync(outerConfig());

    hermeticGit(scratch, ['init', '-q'], { isolateConfig: true });
    hermeticGit(scratch, ['config', 'user.email', 'test@example.invalid'], { isolateConfig: true });
    hermeticGit(scratch, ['config', 'core.autocrlf', 'false'], { isolateConfig: true });
    hermeticGit(
      scratch,
      ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'seed'],
      { isolateConfig: true },
    );

    const after = fs.readFileSync(outerConfig());
    assert.ok(after.equals(before), 'outer repo config changed');
    const text = after.toString('utf8');
    assert.doesNotMatch(text, /bare\s*=\s*true/);
    assert.doesNotMatch(text, /example\.invalid/);
    // The throwaway config landed in the scratch repo instead.
    assert.match(fs.readFileSync(path.join(scratch, '.git', 'config'), 'utf8'), /example\.invalid/);
  });

  test('a child `git init` with an inherited GIT_DIR stays out of the outer repo', () => {
    const before = fs.readFileSync(outerConfig());
    hermeticGit(scratch, ['init', '-q']);
    assert.ok(fs.existsSync(path.join(scratch, '.git', 'HEAD')));
    assert.ok(fs.readFileSync(outerConfig()).equals(before));
    assert.equal(hermeticGit(realRepo, ['config', '--get', 'core.bare']).trim(), 'false');
  });

  test('the scrub redirects git from the inherited GIT_DIR to cwd', () => {
    const inherited = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: scratch, encoding: 'utf8', env: process.env,
    }).trim();
    assert.equal(fs.realpathSync(inherited), path.join(realRepo, '.git'));

    hermeticGit(scratch, ['init', '-q'], { isolateConfig: true });
    const scrubbed = hermeticGit(scratch, ['rev-parse', '--absolute-git-dir'], { isolateConfig: true }).trim();
    assert.equal(fs.realpathSync(scrubbed), path.join(scratch, '.git'));
  });

  test('read-only calls inspect the cwd repo, not the inherited one', () => {
    hermeticGit(scratch, ['init', '-q'], { isolateConfig: true });
    hermeticGit(
      scratch,
      ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'SCRATCH_ONLY_COMMIT'],
      { isolateConfig: true },
    );
    assert.match(hermeticGit(scratch, ['log', '--oneline']), /SCRATCH_ONLY_COMMIT/);
  });

  test('scrubbedGitEnv removes every location variable and does not mutate its input', () => {
    const base = { PATH: '/bin', HOME: '/home/x' };
    for (const v of GIT_LOCATION_VARS) base[v] = `/somewhere/${v}`;
    const env = scrubbedGitEnv(base);
    for (const v of GIT_LOCATION_VARS) {
      assert.equal(env[v], undefined, `${v} survived`);
      assert.equal(base[v], `/somewhere/${v}`, `${v} was removed from the input`);
    }
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HOME, '/home/x');
  });

  test('the default base is process.env (which the hook-simulation polluted)', () => {
    const env = scrubbedGitEnv();
    for (const v of GIT_LOCATION_VARS) assert.equal(env[v], undefined);
  });

  test('the location list covers the variables git documents for repo/index/object placement', () => {
    for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
      assert.ok(GIT_LOCATION_VARS.includes(v), `${v} missing`);
    }
  });

  test('isolateConfig detaches from global/system config and an inherited GIT_CONFIG', () => {
    const isolated = scrubbedGitEnv({ GIT_CONFIG: '/tmp/forced' }, { isolateConfig: true });
    assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(isolated.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(isolated.GIT_CONFIG, undefined);
    // Without the option the config variables are left alone.
    const plain = scrubbedGitEnv({});
    assert.equal(plain.GIT_CONFIG_NOSYSTEM, undefined);
  });

  test('hermeticGit merges caller env over the scrubbed env', () => {
    hermeticGit(scratch, ['init', '-q']);
    const out = hermeticGit(scratch, ['var', 'GIT_AUTHOR_IDENT'], {
      isolateConfig: true,
      env: { GIT_AUTHOR_NAME: 'Env Author', GIT_AUTHOR_EMAIL: 'env@example.invalid' },
    });
    assert.match(out, /Env Author <env@example\.invalid>/);
  });
});
