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
      fs.copyFileSync(real, dest);
      written.push(path.relative(destRoot, dest));
    } else {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      written.push(path.relative(destRoot, dest));
    }
  }
  return written;
}

function copyFile(src, dest, destRoot, written) {
  ensureDir(path.dirname(dest));
  const real = fs.lstatSync(src).isSymbolicLink() ? fs.realpathSync(src) : src;
  fs.copyFileSync(real, dest);
  if (written) written.push(path.relative(destRoot, dest));
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
  fs, path,
  ensureDir, readText, writeText, exists, sha256,
  copyDir, copyFile, loadConfig, frontmatterDescription, uniq,
};
