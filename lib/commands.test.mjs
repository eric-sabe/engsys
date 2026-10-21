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
const { copyToDest } = require('./util.js');

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

describe('copyToDest (engsys v2.0.1 rounds 2-3, Nyx F5/F7; engsys#192, #222)', () => {
  test('a hardlinked destination is replaced, not written through: the OTHER hardlinked name keeps its content', () => {
    const dir = mktmp('f5-copytodest-hard-');
    try {
      const other = path.join(dir, 'other.txt');
      const src = path.join(dir, 'src.txt');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(other, 'original');
      fs.writeFileSync(src, 'new content');
      fs.linkSync(other, dest);
      copyToDest(src, dest);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');
      assert.equal(fs.readFileSync(other, 'utf8'), 'original', 'the OTHER hardlinked name must be untouched');
      assert.equal(fs.statSync(dest).nlink, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a symlink destination is unlinked and replaced with real copied content (end to end)', () => {
    const dir = mktmp('f7-copytodest-sym-');
    const outside = mktmp('f7-outside-');
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'original');
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'new content');
      const dest = path.join(dir, 'dest.txt');
      fs.symlinkSync(sentinel, dest);
      copyToDest(src, dest);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'new content', 'dest must now be a real file with the copied content, not the symlink');
      assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original', 'the old symlink target must be untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('TOCTOU: if a file reappears at dest between the unlink and the copy, the copy throws (EEXIST) instead of silently writing through it', () => {
    const dir = mktmp('f7-toctou-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'attacker payload');
      const dest = path.join(dir, 'dest.txt');
      fs.symlinkSync('/nonexistent-target-for-this-test', dest); // copyToDest will remove this
      // Simulate the race directly: re-plant a file at `dest` as if another process won the gap
      // between copyToDest's unlink and copyFileSync, then run copyToDest and confirm
      // it refuses to overwrite the raced-in file instead of succeeding silently.
      const raceWinner = 'raced-in by someone else';
      const origUnlinkSync = fs.unlinkSync;
      fs.unlinkSync = function (p) {
        const r = origUnlinkSync.call(fs, p);
        if (p === dest) fs.writeFileSync(dest, raceWinner);
        return r;
      };
      try {
        assert.throws(() => copyToDest(src, dest), /EEXIST/);
      } finally {
        fs.unlinkSync = origUnlinkSync;
      }
      assert.equal(fs.readFileSync(dest, 'utf8'), raceWinner, 'the raced-in content must survive untouched — proof the copy never wrote through it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#192: a PLAIN file at dest is unlinked too (new inode), and a symlink swapped in right after that unlink makes the copy throw instead of writing through', () => {
    const dir = mktmp('f7-plain-swap-');
    const outside = mktmp('f7-plain-swap-outside-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'attacker payload');
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'original');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'plain v1'); // plain, nlink 1: the old code never unlinked this
      const origUnlinkSync = fs.unlinkSync;
      let unlinked = false;
      fs.unlinkSync = function (p) {
        const r = origUnlinkSync.call(fs, p);
        if (p === dest) {
          unlinked = true;
          fs.symlinkSync(sentinel, dest); // the swap, in the gap
        }
        return r;
      };
      try {
        assert.throws(() => copyToDest(src, dest), /EEXIST/);
      } finally {
        fs.unlinkSync = origUnlinkSync;
      }
      assert.ok(unlinked, 'a plain-file dest must be unlinked before the copy');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original', 'the symlink target must never be written through');
      assert.ok(fs.lstatSync(dest).isSymbolicLink(), 'the swapped-in symlink is left in place, not written through');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a non-ENOENT unlink failure is thrown, never swallowed (dest is a directory)', () => {
    const dir = mktmp('f7-unlink-fail-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'x');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(dest);
      assert.throws(() => copyToDest(src, dest));
      assert.ok(fs.statSync(dest).isDirectory());
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.engsys-tmp-')), [], 'no staged temp file left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // engsys#222: no staged temp file may survive any outcome.
  const tmpResidue = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.engsys-tmp-'));

  test('#222: a copy that fails before dest is touched (unreadable src) leaves the OLD dest in place, and no temp file', () => {
    const dir = mktmp('f222-src-fail-');
    try {
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'old content');
      assert.throws(() => copyToDest(path.join(dir, 'no-such-src.txt'), dest), /ENOENT/);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'old content', 'the old dest must survive a failed copy');
      assert.deepEqual(tmpResidue(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#222: a copy that fails mid-write (disk full while staging) leaves the OLD dest in place, and no temp file', () => {
    const dir = mktmp('f222-stage-fail-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'new content');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'old content');
      const origCopyFileSync = fs.copyFileSync;
      fs.copyFileSync = function (from, to, mode) {
        origCopyFileSync.call(fs, from, to, mode); // a partial temp file now exists...
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      };
      try {
        assert.throws(() => copyToDest(src, dest), /ENOSPC/);
      } finally {
        fs.copyFileSync = origCopyFileSync;
      }
      assert.equal(fs.readFileSync(dest, 'utf8'), 'old content');
      assert.deepEqual(tmpResidue(dir), [], 'the partial temp file is cleaned up');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#222: if placing the staged copy fails after the unlink, the error loudly names the now-missing dest', () => {
    const dir = mktmp('f222-link-fail-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'new content');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'old content');
      const origLinkSync = fs.linkSync;
      fs.linkSync = function () {
        throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
      };
      try {
        assert.throws(() => copyToDest(src, dest), (err) => err.code === 'EIO' && err.message.includes(`${dest} is now MISSING`) && /re-run/.test(err.message));
      } finally {
        fs.linkSync = origLinkSync;
      }
      assert.deepEqual(tmpResidue(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#222: a filesystem without hard links falls back to an exclusive copy of the staged file', () => {
    const dir = mktmp('f222-no-hardlinks-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'new content');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'old content');
      const origLinkSync = fs.linkSync;
      fs.linkSync = function () {
        throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });
      };
      try {
        copyToDest(src, dest);
      } finally {
        fs.linkSync = origLinkSync;
      }
      assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');
      assert.equal(fs.statSync(dest).nlink, 1);
      assert.deepEqual(tmpResidue(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#222: a planted symlink at the temp name is never followed', () => {
    const dir = mktmp('f222-tmp-plant-');
    const outside = mktmp('f222-tmp-plant-outside-');
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'original');
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'attacker payload');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'old content');
      const origCopyFileSync = fs.copyFileSync;
      fs.copyFileSync = function (from, to, mode) {
        if (to.includes('.engsys-tmp-')) fs.symlinkSync(sentinel, to); // win the race for the temp name
        return origCopyFileSync.call(fs, from, to, mode);
      };
      try {
        assert.throws(() => copyToDest(src, dest), /EEXIST/);
      } finally {
        fs.copyFileSync = origCopyFileSync;
      }
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original');
      assert.equal(fs.readFileSync(dest, 'utf8'), 'old content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('positive control: with nothing at dest, and with an ordinary pre-existing file, the copy still succeeds', () => {
    const dir0 = mktmp('f7-fresh-');
    try {
      const src0 = path.join(dir0, 'src.txt');
      fs.writeFileSync(src0, 'fresh');
      copyToDest(src0, path.join(dir0, 'new.txt'));
      assert.equal(fs.readFileSync(path.join(dir0, 'new.txt'), 'utf8'), 'fresh');
    } finally {
      fs.rmSync(dir0, { recursive: true, force: true });
    }
    const dir = mktmp('f7-plain-overwrite-');
    try {
      const src = path.join(dir, 'src.txt');
      fs.writeFileSync(src, 'v2');
      const dest = path.join(dir, 'dest.txt');
      fs.writeFileSync(dest, 'v1'); // a plain pre-existing file
      copyToDest(src, dest);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'v2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
