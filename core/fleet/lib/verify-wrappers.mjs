#!/usr/bin/env node
// verify-wrappers.mjs: are the engsys plugin files that guard the singleton monsters, as installed on
// this host, byte-for-byte the files of the pinned engsys release on GitHub? (engsys#70)
//
// The singleton-write guard hook (core/.claude-plugin/singleton-write-guard.mjs) lets one plain
// invocation of a fenced wrapper through, recognised by its real path inside the plugin cache. That
// cache is writable by the same macOS user the sessions run as, so a session that rewrote a wrapper,
// the hook, its registration or the lease code the wrappers run could get a raw GitHub write past the
// guard. This check is detection and bar-raising, not isolation.
//
// Root of trust: GitHub's content at the pinned engsys ref, never a local file. One call to the git
// trees API (`gh api repos/<owner>/<repo>/git/trees/<ref>?recursive=1`) returns the blob SHA of every
// file at that ref; each protected file in the plugin cache is hashed the way `git hash-object` does
// (sha1 of "blob <size>\0" + content) and compared. No manifest is stored anywhere. A moved tag would
// defeat it, so the operator protects `v*` tags with a ruleset (docs/fleet-guide.md, "Plugin integrity").
//
// The plugin cache is a copy of the repo's core/ directory (.claude-plugin/marketplace.json:
// `"source": "./core"`), so a protected repo path core/<p> lives at <install path>/<p>.
//
//   verify-wrappers.mjs --repo <owner/repo> --ref <ref> --root <install path> [--root <path> ...]
//                       [--cache <file> --max-age-min <n>]
//
// Exit: 0 every protected file matches | 1 MISMATCH (a definite difference: the caller blocks)
//       3 not verified (GitHub unreachable, API error, truncated tree: the caller warns and goes on)
//       2 usage
//
// --cache / --max-age-min: the supervisor's throttle. A passing result is cached with the local blob
// SHAs it was computed from; within <n> minutes, a run whose local SHAs are unchanged for the same
// repo, ref and roots reuses it without calling GitHub. Any local change re-verifies at once. Only a
// pass is cached. `fleet launch` never passes --cache. The cache is host state the sessions could
// also write, so it only bounds the supervisor's detection delay; the launch gate always asks GitHub.
//
// Zero dependencies: node builtins only.

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRAPPERS } from '../../.claude-plugin/singleton-write-guard.mjs';

/** The repo directory the engsys core plugin is built from (its marketplace `source`). */
export const PLUGIN_SUBDIR = 'core';

/**
 * The protected set, as repo paths: the single list (engsys#70). The fenced wrappers come from the
 * hook's own WRAPPERS; the rest is everything that runs inside a wrapper invocation the hook lets
 * through (the baton lease code and its imports, the App token helper it executes) plus the hook and
 * the two files that register it. verify-wrappers.test.mjs fails when a wrapper reaches a file not
 * listed here.
 */
export const PROTECTED = Object.freeze([
  ...[...WRAPPERS].map((w) => `${PLUGIN_SUBDIR}/skills/${w}`).sort(),
  `${PLUGIN_SUBDIR}/.claude-plugin/singleton-write-guard.mjs`,
  `${PLUGIN_SUBDIR}/.claude-plugin/hooks.json`,
  `${PLUGIN_SUBDIR}/.claude-plugin/plugin.json`,
  `${PLUGIN_SUBDIR}/lib/lease/baton.mjs`,
  `${PLUGIN_SUBDIR}/lib/lease/github-backend.mjs`,
  `${PLUGIN_SUBDIR}/fleet/identity/gh-app-token.mjs`,
  `${PLUGIN_SUBDIR}/fleet/lib/federation.mjs`,
  `${PLUGIN_SUBDIR}/lib/gate-check.mjs`,
  `${PLUGIN_SUBDIR}/lib/git-env.mjs`,
  `${PLUGIN_SUBDIR}/lib/untrusted.mjs`,
]);

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a tag or branch name without '/': one path segment of the trees endpoint

/** The SHA `git hash-object` gives this content. */
export function blobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

/** The file under an install root that holds a protected repo path. */
export function cachePath(root, repoPath) {
  return path.join(root, repoPath.slice(PLUGIN_SUBDIR.length + 1));
}

/**
 * Hash the protected files under each root. → { [root]: { [repoPath]: sha | null | 'not-a-file' } }
 * null = absent; 'not-a-file' = a symlink, directory or anything but a regular file, or a file reached
 * through a symlinked directory (a symlink could be repointed after the check, so it never passes).
 */
export function localState(roots, files = PROTECTED) {
  const out = {};
  for (const root of roots) {
    const m = {};
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch { /* missing root: every file reads as absent */ }
    for (const p of files) {
      const abs = cachePath(root, p);
      let st;
      try { st = fs.lstatSync(abs); } catch (e) {
        if (e && e.code === 'ENOENT') { m[p] = null; continue; }
        throw e;
      }
      // A symlinked parent directory could be repointed after the check too: the file's real path must
      // be the one under the root's real path.
      m[p] = st.isFile() && fs.realpathSync(abs) === cachePath(realRoot, p) ? blobSha(fs.readFileSync(abs)) : 'not-a-file';
    }
    out[root] = m;
  }
  return out;
}

/** Parse a git trees API response into Map<path, blob sha>. Throws an Unverified on a bad or truncated tree. */
export function parseTree(json) {
  let t;
  try { t = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Unverified('GitHub returned something that is not JSON'); }
  if (!t || !Array.isArray(t.tree)) throw new Unverified(`GitHub returned no tree${t && t.message ? `: ${t.message}` : ''}`);
  if (t.truncated) throw new Unverified('GitHub truncated the tree');
  const m = new Map();
  for (const e of t.tree) if (e && e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string') m.set(e.path, e.sha);
  return m;
}

/**
 * Compare local hashes to the tree. → [{ root, path, kind }] for every difference:
 *   modified (different bytes) | missing (in the release, not on disk) | unexpected (on disk, not in the
 *   release) | not-a-file. A file in neither (an older release without it) is fine.
 */
export function compare(tree, local, files = PROTECTED) {
  const diffs = [];
  for (const [root, m] of Object.entries(local)) {
    for (const p of files) {
      const want = tree.get(p) ?? null;
      const have = m[p] ?? null;
      if (have === 'not-a-file') diffs.push({ root, path: p, kind: 'not-a-file' });
      else if (want === null && have === null) continue;
      else if (want === null) diffs.push({ root, path: p, kind: 'unexpected' });
      else if (have === null) diffs.push({ root, path: p, kind: 'missing' });
      else if (want !== have) diffs.push({ root, path: p, kind: 'modified' });
    }
  }
  return diffs;
}

export class Unverified extends Error {}

/** Fetch the tree at <ref> through gh (the fleet's identity shim when it is first on PATH). */
export function fetchTree({ repo, ref, gh = 'gh', timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const endpoint = `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    execFile(gh, ['api', endpoint], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message || err).trim().split('\n').pop().slice(0, 200);
        reject(new Unverified(`gh api ${endpoint} failed: ${why}`));
        return;
      }
      try { resolve(parseTree(stdout)); } catch (e) { reject(e); }
    });
  });
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeCache(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseArgs(argv) {
  const a = { roots: [], repo: '', ref: '', cache: '', maxAgeMin: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    switch (k) {
      case '--repo': a.repo = v(); break;
      case '--ref': a.ref = v(); break;
      case '--root': a.roots.push(v()); break;
      case '--cache': a.cache = v(); break;
      case '--max-age-min': a.maxAgeMin = Number(v()); break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  if (!REPO_RE.test(a.repo)) throw new Error('--repo must be owner/repo');
  if (!REF_RE.test(a.ref) || a.ref.includes('..')) throw new Error('--ref must be a tag (or a branch name without /)');
  if (!a.roots.length) throw new Error('at least one --root is needed');
  if (a.maxAgeMin !== null && !(Number.isFinite(a.maxAgeMin) && a.maxAgeMin >= 0)) throw new Error('--max-age-min must be a number of minutes');
  if ((a.maxAgeMin !== null) !== Boolean(a.cache)) throw new Error('--cache and --max-age-min go together');
  return a;
}

/** The CLI, with its effects injectable for tests. → exit code. */
export async function run(argv, { fetch = fetchTree, now = Date.now, out = (s) => process.stdout.write(s + '\n') } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { out(`verify: ${e.message}`); return 2; }
  const roots = a.roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  const target = `${a.repo}@${a.ref}`;
  let local;
  try { local = localState(roots); } catch (e) { out(`verify: not verified: can't read the plugin files (${e.message})`); return 3; }

  if (a.cache) {
    const c = readCache(a.cache);
    const ageMin = c ? (now() - Number(c.verifiedAt)) / 60_000 : Infinity;
    if (c && c.result === 'ok' && c.repo === a.repo && c.ref === a.ref && sameJson(c.local, local) && ageMin >= 0 && ageMin < a.maxAgeMin) {
      out(`verify: ok, ${PROTECTED.length} protected files in ${roots.join(', ')} match ${target} (unchanged since the check ${Math.floor(ageMin)}m ago)`);
      return 0;
    }
  }

  let tree;
  try { tree = await fetch({ repo: a.repo, ref: a.ref }); } catch (e) {
    out(`verify: not verified against ${target}: ${e instanceof Unverified ? e.message : String(e && e.message || e)}`);
    return 3;
  }
  const diffs = compare(tree, local);
  if (diffs.length) {
    const files = new Set(diffs.map((d) => d.path)).size;
    out(`verify: MISMATCH, ${files} of ${PROTECTED.length} protected files differ from ${target}:`);
    for (const d of diffs) out(`  ${d.kind.padEnd(10)} ${cachePath(d.root, d.path)}`);
    if (a.cache) { try { fs.rmSync(a.cache, { force: true }); } catch { /* best effort */ } }
    return 1;
  }
  if (a.cache) {
    try { writeCache(a.cache, { repo: a.repo, ref: a.ref, local, result: 'ok', verifiedAt: now() }); } catch (e) {
      out(`verify: WARNING can't write ${a.cache} (${e.message}); the next run asks GitHub again`);
    }
  }
  out(`verify: ok, ${PROTECTED.length} protected files in ${roots.join(', ')} match ${target}`);
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stdout.write(`verify: not verified: internal error (${e && e.message})\n`);
    process.exit(3);
  });
}
