'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseYaml } = require('./yaml');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function relPath(from, to) {
  return path.relative(from, to).replace(/\\/g, '/');
}

// engsys v2.0.1 rounds 2-3 (Nyx F5/F7), engsys#192, engsys#222: copy `src` to `dest` WITHOUT ever
// writing through whatever already sits at `dest`, and without leaving `dest` missing when the
// copy fails. `fs.copyFileSync` follows a symlink and rewrites a hardlinked inode in place,
// silently overwriting the symlink target or every other name sharing the inode. So:
//
//   1. Stage the copy in a fresh temp file beside `dest` (`COPYFILE_EXCL`, so a planted temp name
//      fails instead of being followed). A copy that fails here (unreadable src, disk full)
//      leaves the old `dest` untouched.
//   2. ALWAYS unlink `dest` (a missing `dest` is fine; any other unlink error throws — continuing
//      past a failed unlink would defeat the point). An unconditional unlink has no
//      check-then-act gap to race (#192: an lstat-gated unlink left a plain-file -> symlink swap
//      window).
//   3. `link` the staged file into place. Like `COPYFILE_EXCL`, `link` fails (EEXIST) when anything
//      reappeared at `dest` in the gap, instead of writing through it. `rename` would silently
//      replace the raced-in path, which is the attack #192 closes. Where the filesystem has no
//      hard links, fall back to a `COPYFILE_EXCL` copy of the staged file.
//   4. Remove the temp file, whatever happened.
//
// Only a step-3 failure other than EEXIST can still leave `dest` missing; that error names the
// missing path so a re-run fixes it.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

function copyToDest(src, dest) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.engsys-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    try {
      fs.unlinkSync(dest);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      try {
        fs.linkSync(tmp, dest);
      } catch (err) {
        if (!LINK_UNSUPPORTED.has(err.code)) throw err;
        fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') err.message = `${err.message} — ${dest} is now MISSING (its old copy was removed); re-run the engsys command to restore it`;
      throw err;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort: never mask the real outcome */ }
  }
}

// Recursively copy a directory tree, returning the list of files written
// (as paths relative to destRoot). Used so we can record managed files in the lock.
function copyDir(srcDir, destDir, destRoot, written) {
  written = written || [];
  destRoot = destRoot || destDir;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest, destRoot, written);
    } else if (entry.isSymbolicLink()) {
      // resolve and copy real content
      const real = fs.realpathSync(src);
      ensureDir(path.dirname(dest));
      copyToDest(real, dest);
      written.push(relPath(destRoot, dest));
    } else {
      ensureDir(path.dirname(dest));
      copyToDest(src, dest);
      written.push(relPath(destRoot, dest));
    }
  }
  return written;
}

function copyFile(src, dest, destRoot, written) {
  ensureDir(path.dirname(dest));
  const real = fs.lstatSync(src).isSymbolicLink() ? fs.realpathSync(src) : src;
  copyToDest(real, dest);
  if (written) written.push(relPath(destRoot, dest));
}

// Load engsys.config — supports .yaml/.yml (subset parser) and .json.
function loadConfig(file) {
  const text = readText(file);
  if (file.endsWith('.json')) return JSON.parse(text);
  return parseYaml(text);
}

// Pull the `description:` value out of a markdown file's YAML frontmatter.
function frontmatterDescription(file) {
  if (!exists(file)) return '';
  const text = readText(file);
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end === -1) return '';
  const fm = text.slice(3, end);
  const m = fm.match(/^\s*description:\s*(.+)$/m);
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

module.exports = {
  fs, path, relPath,
  ensureDir, readText, writeText, exists, sha256,
  copyDir, copyFile, loadConfig, frontmatterDescription, uniq,
  copyToDest,
};
