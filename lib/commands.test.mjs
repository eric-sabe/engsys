// Tests for lib/commands.js — path-containment discipline (engsys v2.0.1 M6).
// Run by `node --test lib/commands.test.mjs` (wired into scripts/run-tests.mjs).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeManagedPath, runUninstall, assertBookkeepingDirsNotSymlinks } = require('./commands.js');
const { unlinkIfLinked } = require('./util.js');

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

describe('assertBookkeepingDirsNotSymlinks (engsys v2.0.1 round 2, Nyx F5)', () => {
  test('throws when .claude is a symlink', () => {
    const into = mktmp('f5-claude-');
    const outside = mktmp('f5-outside-');
    try {
      fs.symlinkSync(outside, path.join(into, '.claude'));
      assert.throws(() => assertBookkeepingDirsNotSymlinks(into), /symlink/);
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('throws when .claude/.engsys-backup is a symlink, even though .claude itself is a real directory', () => {
    const into = mktmp('f5-backup-');
    const outside = mktmp('f5-outside2-');
    try {
      fs.mkdirSync(path.join(into, '.claude'), { recursive: true });
      fs.symlinkSync(outside, path.join(into, '.claude', '.engsys-backup'));
      assert.throws(() => assertBookkeepingDirsNotSymlinks(into), /symlink/);
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('positive control: real directories (or nothing at all) pass cleanly', () => {
    const into = mktmp('f5-ok-');
    try {
      assert.doesNotThrow(() => assertBookkeepingDirsNotSymlinks(into)); // nothing exists yet
      fs.mkdirSync(path.join(into, '.claude', '.engsys-backup'), { recursive: true });
      fs.mkdirSync(path.join(into, '.agents'), { recursive: true });
      assert.doesNotThrow(() => assertBookkeepingDirsNotSymlinks(into));
    } finally {
      fs.rmSync(into, { recursive: true, force: true });
    }
  });
});

describe('unlinkIfLinked (engsys v2.0.1 round 2, Nyx F5)', () => {
  test('unlinks a symlink destination so a copy does not write through it', () => {
    const dir = mktmp('f5-unlink-sym-');
    const outside = mktmp('f5-unlink-outside-');
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'original');
      const dest = path.join(dir, 'dest.txt');
      fs.symlinkSync(sentinel, dest);
      unlinkIfLinked(dest);
      assert.equal(fs.existsSync(dest), false, 'the symlink itself must be gone');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original', 'the symlink target must be untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('unlinks a hardlinked destination so a copy does not write through it', () => {
    const dir = mktmp('f5-unlink-hard-');
    try {
      const other = path.join(dir, 'other.txt');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(other, 'original');
      fs.linkSync(other, dest);
      unlinkIfLinked(dest);
      assert.equal(fs.existsSync(dest), false);
      assert.equal(fs.readFileSync(other, 'utf8'), 'original', 'the OTHER hardlinked name must be untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('positive control: a plain file with no other links, or no file at all, is left alone', () => {
    const dir = mktmp('f5-unlink-plain-');
    try {
      const dest = path.join(dir, 'dest.txt');
      unlinkIfLinked(dest); // doesn't exist — no-op, never throws
      fs.writeFileSync(dest, 'plain');
      unlinkIfLinked(dest);
      assert.equal(fs.existsSync(dest), true);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'plain');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
