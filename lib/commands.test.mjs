// Tests for lib/commands.js — path-containment discipline (engsys v2.0.1 M6).
// Run by `node --test lib/commands.test.mjs` (wired into scripts/run-tests.mjs).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeManagedPath, runUninstall } = require('./commands.js');

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('safeManagedPath (engsys v2.0.1 M6)', () => {
  test('a normal relative path resolves inside `into`', () => {
    const into = mktmp('m6-ok-');
    try {
      assert.equal(safeManagedPath(into, '.claude/commands/foo.md'), path.join(path.resolve(into), '.claude', 'commands', 'foo.md'));
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });

  test('an absolute path is rejected', () => {
    const into = mktmp('m6-abs-');
    try {
      assert.equal(safeManagedPath(into, '/etc/passwd'), null);
      assert.equal(safeManagedPath(into, path.join(into, '..', 'evil')), null, 'an absolute path built from `into` itself is still rejected');
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });

  test('a `..` traversal segment is rejected, however deeply nested', () => {
    const into = mktmp('m6-dotdot-');
    try {
      assert.equal(safeManagedPath(into, '../evil.txt'), null);
      assert.equal(safeManagedPath(into, '.claude/../../evil.txt'), null);
      assert.equal(safeManagedPath(into, '..'), null);
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });

  test('a path that passes through a symlinked ancestor directory is rejected, even though the nominal join looks contained', () => {
    const into = mktmp('m6-symlink-');
    const outside = mktmp('m6-outside-');
    try {
      // .claude -> a symlink pointing OUTSIDE `into`
      fs.symlinkSync(outside, path.join(into, '.claude'));
      assert.equal(safeManagedPath(into, '.claude/engsys.lock'), null);
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('positive control: a real (non-symlink) nested directory is accepted', () => {
    const into = mktmp('m6-real-');
    try {
      fs.mkdirSync(path.join(into, '.claude', 'commands'), { recursive: true });
      assert.equal(safeManagedPath(into, '.claude/commands/foo.md'), path.join(path.resolve(into), '.claude', 'commands', 'foo.md'));
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });

  test('non-string, empty, or NUL-containing input is rejected', () => {
    const into = mktmp('m6-bad-');
    try {
      assert.equal(safeManagedPath(into, ''), null);
      assert.equal(safeManagedPath(into, null), null);
      assert.equal(safeManagedPath(into, undefined), null);
      assert.equal(safeManagedPath(into, 'a\0b'), null);
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });
});

describe('runUninstall path containment (engsys v2.0.1 M6)', () => {
  test('a hand-edited/corrupt .claude/engsys.lock with a path-traversal `managed` key never deletes or writes outside `into` — legitimate managed files are still removed', () => {
    const into = mktmp('m6-uninstall-');
    const sentinelDir = mktmp('m6-sentinel-');
    const sentinel = path.join(sentinelDir, 'evil.txt');
    fs.writeFileSync(sentinel, 'do not delete me');
    try {
      fs.mkdirSync(path.join(into, '.claude', 'commands'), { recursive: true });
      const legitFile = path.join(into, '.claude', 'commands', 'real.md');
      fs.writeFileSync(legitFile, 'real managed file');

      // relative traversal from into/.claude/engsys.lock's perspective back out to the sentinel
      const relEscape = path.relative(into, sentinel); // e.g. "../m6-sentinel-xxxx/evil.txt"
      const lock = {
        managed: {
          '.claude/commands/real.md': 'anyhash',
          [relEscape]: 'anyhash', // malicious/corrupt entry
        },
        generated: [],
        imported: [],
      };
      fs.writeFileSync(path.join(into, '.claude', 'engsys.lock'), JSON.stringify(lock));

      const result = runUninstall({ into, dryRun: false });

      assert.ok(fs.existsSync(sentinel), 'the path-traversal entry must never be deleted — it resolves outside `into`');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not delete me');
      assert.ok(!fs.existsSync(legitFile), 'a legitimate managed file inside `into` must still be removed (positive control)');
      assert.ok(result.removed.includes('.claude/commands/real.md'));
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    }
  });
});
