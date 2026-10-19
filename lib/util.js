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

// engsys v2.0.1 rounds 2-3 (Nyx F5/F7), engsys#192: copy `src` to `dest` WITHOUT ever writing
// through whatever already sits at `dest`. `fs.copyFileSync` follows a symlink and rewrites a
// hardlinked inode in place, silently overwriting the symlink target or every other name sharing
// the inode. So `dest` is ALWAYS unlinked first (a missing `dest` is fine; any other unlink error
// throws — continuing past a failed unlink would defeat the point), then copied with
// `COPYFILE_EXCL`, so anything that reappears at `dest` in the gap (a symlink swapped in by
// another process) makes the copy fail loudly (EEXIST) instead of writing through it.
//
// This used to unlink only when an `lstat` found a symlink/hardlink, which left a plain-file ->
// symlink swap window between that `lstat` and the copy (#192); an unconditional unlink has no
// check-then-act gap to race.
function copyToDest(src, dest) {
  try {
    fs.unlinkSync(dest);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
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
