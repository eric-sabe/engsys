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

// engsys v2.0.1 round 2 (Nyx F5): unlink `dest` first when it already exists as a symlink OR a
// hardlink (nlink > 1) — `fs.copyFileSync` otherwise writes THROUGH either, silently overwriting
// whatever the symlink points at or every other name sharing that hardlinked inode, instead of
// replacing `dest` itself. A plain regular file with no other links is left alone (no need to
// unlink-then-recreate it). Never throws: a `dest` that doesn't exist yet is a no-op.
//
// Returns `true` when it actually unlinked something, `false` otherwise — round 3 (F7, TOCTOU):
// `lstat` here and the caller's `copyFileSync` are two separate syscalls, so a symlink/hardlink
// could be re-planted at `dest` in between. `copyToDest` (below) is the paired helper that closes
// that gap: when this returns `true`, it copies with `COPYFILE_EXCL` so a file that exists again
// at `dest` (the race) makes the copy fail loudly instead of silently writing through it.
function unlinkIfLinked(dest) {
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return false; // doesn't exist — nothing to do
  }
  if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
    // cr review (round 2): must NOT swallow a failed unlink — the whole point of this function is
    // that the copy which follows must never write through a symlink/hardlink. Silently
    // continuing past a failed unlink would do exactly that. Let it throw.
    fs.unlinkSync(dest);
    return true;
  }
  return false;
}

/**
 * The paired copy for `unlinkIfLinked`: copies `src` to `dest`, using `COPYFILE_EXCL` when
 * `unlinkIfLinked` just removed something at `dest`, so a symlink/hardlink re-planted there in
 * the gap between that `lstat` and this `copyFileSync` makes the copy throw (EEXIST) instead of
 * silently writing through the race (round 3, F7).
 */
function copyToDest(src, dest) {
  const justUnlinked = unlinkIfLinked(dest);
  fs.copyFileSync(src, dest, justUnlinked ? fs.constants.COPYFILE_EXCL : 0);
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
  unlinkIfLinked, copyToDest,
};
