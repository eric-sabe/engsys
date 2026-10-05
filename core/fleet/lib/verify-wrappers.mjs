#!/usr/bin/env node
// verify-wrappers.mjs: are the engsys plugin files that guard the singleton monsters, as Claude Code
// would load them in PIN_DIR, byte-for-byte the files of the pinned engsys release on GitHub? (engsys#70)
//
// The singleton-write guard hook (core/.claude-plugin/singleton-write-guard.mjs) lets one plain
// invocation of a fenced wrapper through, recognised by its real path inside the plugin cache. That
// cache is writable by the same macOS user the sessions run as, so a session that rewrote a wrapper,
// the hook, any other hook registered beside it, or the lease code the wrappers run could get a raw
// GitHub write past the guard. This check is detection and bar-raising, not isolation.
//
// Root of trust: GitHub's content at the pinned engsys tag, never a local file.
//   1. git/ref/tags/<tag> (the tag namespace only: a branch of the same name can't stand in), peeled
//      to its commit;
//   2. that commit must be on the default branch: compare/<commit>...<default> is `ahead` or
//      `identical` (a tag pushed on an unmerged commit is a mismatch);
//   3. git/trees/<commit>?recursive=1: the blob SHA of every file in that commit.
// Each protected file in the plugin cache is hashed the way `git hash-object` does (sha1 of
// "blob <size>\0" + content) and compared. No manifest is stored anywhere.
//
// The protected set is a closure walked from the cached files themselves: the SEEDS below, every file
// under SEED_DIRS (the monster skills), every script hooks.json registers, the fenced wrappers named by
// the guard's own WRAPPERS, and everything those import or run. Each file is read once, then hashed and parsed from the same buffer. Walking the
// local copy is sound: a file that changed what the walk reaches is itself a mismatch. So the wrapper
// and hook lists are the release's own (engsys#86 review L4, M2), never the host checkout's.
//
// Which install is checked (engsys#86 review H2): every <plugin-id> entry of `claude plugin list
// --json`, run in PIN_DIR, that applies there (no projectPath, or projectPath = PIN_DIR), any scope,
// enabled or not. An applicable entry at another version, two install paths, or no enabled entry is a
// mismatch. No applicable entry at all is "not verified" (run fleet sync).
//
// The plugin cache is a copy of the repo's core/ directory (.claude-plugin/marketplace.json:
// `"source": "./core"`), so a protected repo path core/<p> lives at <install path>/<p>.
//
//   verify-wrappers.mjs --repo <owner/repo> --tag vX.Y.Z --plugin-id engsys@<marketplace>
//                       --project-dir <PIN_DIR> --plugins <`claude plugin list --json` output file>
//                       [--cache <file> --max-age-min <n>]
//
// Exit: 0 everything matches | 1 MISMATCH (a definite difference) | 3 not verified (GitHub unreachable,
//       API error, truncated tree, nothing installed) | 2 usage. Callers hold merge/maintain sessions on
//       anything but 0. A mismatch ends with a `fingerprint: <sha1>` line naming that exact mismatch.
//
// --cache / --max-age-min: the supervisor's throttle. A pass is cached with the local blob SHAs it was
// computed from; within <n> minutes, a run whose local SHAs are unchanged for the same repo and tag
// reuses it without calling GitHub. Any local change re-verifies at once. Only a pass is cached.
// `fleet launch` never passes --cache. The cache is host state the sessions could also write, so it
// only bounds the supervisor's detection delay; the launch gate always asks GitHub.
//
// Zero dependencies: node builtins only.

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo directory the engsys core plugin is built from (its marketplace `source`). */
export const PLUGIN_SUBDIR = 'core';
const P = (rel) => `${PLUGIN_SUBDIR}/${rel}`;

/**
 * Where the walk starts: the registration (plugin.json and the hooks.json it points at), the guard (its
 * WRAPPERS name the fenced wrappers), the conventions engsys-context.mjs injects at SessionStart, and the
 * lease code the wrappers run, listed as well as reached so a parser miss can't drop it.
 */
export const SEEDS = Object.freeze([
  P('.claude-plugin/plugin.json'),
  P('.claude-plugin/hooks.json'),
  P('.claude-plugin/singleton-write-guard.mjs'),
  P('templates/CLAUDE.md.tmpl'),
  P('lib/lease/baton.mjs'),
  P('lib/lease/github-backend.mjs'),
  P('fleet/identity/gh-app-token.mjs'),
  P('fleet/lib/federation.mjs'),
]);
/**
 * Directories protected whole: the two monster skills. The guard lets a monster run its own skill scripts
 * by path, and it can't see what a script does inside, so every script there (mm-watch.sh,
 * mm-snapshot.sh, gate-check.sh, ...) is as trusted as a fenced wrapper, and SKILL.md is the monster's
 * protocol. A file in the release's copy of these directories that is missing locally is a mismatch too.
 */
export const SEED_DIRS = Object.freeze([P('skills/merge-monster/'), P('skills/maintenance-monster/')]);
const GUARD = P('.claude-plugin/singleton-write-guard.mjs');

export const TAG_RE = /^v\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** The SHA `git hash-object` gives this content. */
export function blobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

/** The file under an install root that holds a protected repo path. */
export function cachePath(root, repoPath) {
  return path.join(root, repoPath.slice(PLUGIN_SUBDIR.length + 1));
}

/** The fenced wrappers named in the guard's source: `export const WRAPPERS = new Set([...])`. */
export function parseWrappers(src) {
  const m = String(src).match(/export const WRAPPERS = new Set\(\[([\s\S]*?)\]\)/);
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]) : [];
}

/** Repo paths a protected file reaches: hook registrations, wrappers, imports and exec'd scripts. */
export function refsOf(repoPath, src) {
  const s = String(src);
  const dir = path.posix.dirname(repoPath);
  const out = [];
  const rel = (r) => out.push(path.posix.normalize(path.posix.join(dir, r)));
  const fromRoot = (r) => out.push(path.posix.normalize(P(r)));
  if (repoPath.endsWith('/hooks.json')) {
    for (const m of s.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g)) fromRoot(m[1]);
  } else if (repoPath.endsWith('/plugin.json')) {
    for (const m of s.matchAll(/"\.\/([A-Za-z0-9_./-]+)"/g)) fromRoot(m[1]);
  } else if (repoPath.endsWith('.mjs') || repoPath.endsWith('.js')) {
    if (repoPath === GUARD) for (const w of parseWrappers(s)) fromRoot(`skills/${w}`);
    for (const m of s.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) rel(m[1]);
    for (const m of s.matchAll(/join\(HERE,\s*((?:['"][^'"]+['"],?\s*)+)\)/g)) {
      rel([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join('/'));
    }
  } else if (repoPath.endsWith('.sh') || repoPath.endsWith('.tmpl')) {
    for (const m of s.matchAll(/(?:\$here|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\))\/([A-Za-z0-9_./-]+\.(?:sh|mjs))/g)) rel(m[1]);
    // `$<any script-dir variable>/../../../lib/x.mjs`: a relative climb is relative to the script's dir.
    for (const m of s.matchAll(/\/((?:\.\.\/)+[A-Za-z0-9_./-]+\.(?:sh|mjs))/g)) rel(m[1]);
  }
  return out.filter((p) => p.startsWith(`${PLUGIN_SUBDIR}/`));
}

/**
 * Walk the protected closure under one install root. → { [repoPath]: sha | null | 'not-a-file' }
 * null = absent; 'not-a-file' = a symlink, directory, anything but a regular file, or a file reached
 * through a symlinked directory (a symlink could be repointed after the check, so it never passes).
 */
export function walk(root, seeds = SEEDS, dirs = SEED_DIRS) {
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* missing root: every file reads as absent */ }
  const out = {};
  const queue = [...seeds];
  const list = (repoDir) => { // every entry under a seed directory, as repo paths (a symlinked entry is not followed)
    let ents;
    try { ents = fs.readdirSync(cachePath(root, repoDir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = `${repoDir}${e.name}`;
      if (e.isDirectory()) list(`${p}/`);
      else queue.push(p);
    }
  };
  for (const d of dirs) list(d);
  while (queue.length) {
    const p = queue.shift();
    if (p in out) continue;
    const abs = cachePath(root, p);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) {
      if (e && e.code === 'ENOENT') { out[p] = null; continue; }
      throw e;
    }
    if (!st.isFile() || fs.realpathSync(abs) !== cachePath(realRoot, p)) { out[p] = 'not-a-file'; continue; }
    const buf = fs.readFileSync(abs);
    out[p] = blobSha(buf);
    queue.push(...refsOf(p, buf));
  }
  return out;
}

/** Walk every root. → { [root]: walk(root) } */
export function localState(roots, seeds = SEEDS, dirs = SEED_DIRS) {
  return Object.fromEntries(roots.map((r) => [r, walk(r, seeds, dirs)]));
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
 * Compare local hashes to the release tree. → [{ root, path, kind, have }] for every difference:
 *   modified (different bytes) | missing (in the release, not on disk) | unexpected (on disk, not in the
 *   release) | not-a-file. A file in neither (a reference the release doesn't have either) is fine.
 */
export function compare(tree, local, dirs = SEED_DIRS) {
  const diffs = [];
  for (const [root, m] of Object.entries(local)) {
    for (const p of tree.keys()) {
      if (!(p in m) && dirs.some((d) => p.startsWith(d))) diffs.push({ root, path: p, kind: 'missing', have: '-' });
    }
    for (const [p, have] of Object.entries(m)) {
      const want = tree.get(p) ?? null;
      if (have === 'not-a-file') diffs.push({ root, path: p, kind: 'not-a-file', have });
      else if (want === null && have === null) continue;
      else if (want === null) diffs.push({ root, path: p, kind: 'unexpected', have });
      else if (have === null) diffs.push({ root, path: p, kind: 'missing', have: '-' });
      else if (want !== have) diffs.push({ root, path: p, kind: 'modified', have });
    }
  }
  return diffs;
}

/**
 * Which installs apply in projectDir, from `claude plugin list --json` run there.
 * → { roots, problems, notInstalled }. problems are mismatches: an applicable entry at another version
 * or without a path, more than one install path, or no enabled entry.
 */
export function selectInstalls(list, { pluginId, projectDir, version }) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const dir = real(projectDir);
  const entries = (Array.isArray(list) ? list : []).filter((e) => e && e.id === pluginId);
  const applicable = entries.filter((e) => !e.projectPath || real(e.projectPath) === dir);
  if (!applicable.length) return { roots: [], problems: [], notInstalled: true };
  const problems = [];
  for (const e of applicable) {
    if (e.version !== version) problems.push(`version    ${pluginId} (${e.scope || '?'} scope) is ${e.version ?? 'unversioned'}, not the pin ${version}: ${e.installPath || '(no path)'}`);
    else if (!e.installPath) problems.push(`no-path    ${pluginId} (${e.scope || '?'} scope) has no install path`);
  }
  const roots = [...new Set(applicable.filter((e) => e.version === version && e.installPath).map((e) => real(e.installPath)))];
  if (roots.length > 1) problems.push(`two-paths  ${pluginId} has ${roots.length} install paths for ${dir}: ${roots.join(', ')}`);
  if (!applicable.some((e) => e.enabled === true && e.projectEnabled !== false)) {
    problems.push(`disabled   ${pluginId} is not enabled for ${dir}, so its guard hook would not load`);
  }
  return { roots, problems, notInstalled: false };
}

export class Unverified extends Error {}

function ghJson(gh, endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(gh, ['api', endpoint], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message || err).trim().split('\n').pop().slice(0, 200);
        reject(new Unverified(`gh api ${endpoint} failed: ${why}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Unverified(`gh api ${endpoint} returned something that is not JSON`)); }
    });
  });
}

/**
 * The release on GitHub, through gh (the fleet's identity shim when it is first on PATH).
 * → { commit, defaultBranch, status, tree: Map }. status is GitHub's compare of <commit>...<default>:
 * `ahead` (the default branch has moved on from it) or `identical` mean the commit is on that branch.
 */
export async function fetchRelease({ repo, tag, gh = 'gh', timeoutMs = 30_000 }) {
  let obj = (await ghJson(gh, `repos/${repo}/git/ref/tags/${tag}`, timeoutMs)).object;
  for (let i = 0; obj && obj.type === 'tag' && i < 5; i++) obj = (await ghJson(gh, `repos/${repo}/git/tags/${obj.sha}`, timeoutMs)).object;
  if (!obj || obj.type !== 'commit' || !/^[0-9a-f]{40}$/.test(obj.sha || '')) throw new Unverified(`tag ${tag} does not resolve to a commit`);
  const defaultBranch = (await ghJson(gh, `repos/${repo}`, timeoutMs)).default_branch;
  if (!defaultBranch) throw new Unverified(`can't read the default branch of ${repo}`);
  const status = (await ghJson(gh, `repos/${repo}/compare/${obj.sha}...${encodeURIComponent(defaultBranch)}?per_page=1`, timeoutMs)).status;
  if (!status) throw new Unverified(`can't compare ${tag} with ${defaultBranch}`);
  const tree = parseTree(await ghJson(gh, `repos/${repo}/git/trees/${obj.sha}?recursive=1`, timeoutMs));
  return { commit: obj.sha, defaultBranch, status, tree };
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
const countFiles = (local) => new Set(Object.values(local).flatMap((m) => Object.keys(m))).size;

export function parseArgs(argv) {
  const a = { repo: '', tag: '', pluginId: '', projectDir: '', plugins: '', cache: '', maxAgeMin: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    switch (k) {
      case '--repo': a.repo = v(); break;
      case '--tag': a.tag = v(); break;
      case '--plugin-id': a.pluginId = v(); break;
      case '--project-dir': a.projectDir = v(); break;
      case '--plugins': a.plugins = v(); break;
      case '--cache': a.cache = v(); break;
      case '--max-age-min': a.maxAgeMin = Number(v()); break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  if (!REPO_RE.test(a.repo)) throw new Error('--repo must be owner/repo');
  if (!TAG_RE.test(a.tag)) throw new Error('--tag must be a release tag, vX.Y.Z');
  if (!ID_RE.test(a.pluginId)) throw new Error('--plugin-id must be <plugin>@<marketplace>');
  if (!a.projectDir) throw new Error('--project-dir is needed');
  if (!a.plugins) throw new Error('--plugins is needed (the output of `claude plugin list --json`, run in the project dir)');
  if (a.maxAgeMin !== null && !(Number.isFinite(a.maxAgeMin) && a.maxAgeMin >= 0)) throw new Error('--max-age-min must be a number of minutes');
  if ((a.maxAgeMin !== null) !== Boolean(a.cache)) throw new Error('--cache and --max-age-min go together');
  return a;
}

/** The CLI, with its effects injectable for tests. → exit code. */
export async function run(argv, { fetch = fetchRelease, now = Date.now, out = (s) => process.stdout.write(s + '\n') } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { out(`verify: ${e.message}`); return 2; }
  const target = `${a.repo}@${a.tag}`;
  const version = a.tag.slice(1);
  const mismatch = (lines) => {
    const sorted = [...lines].sort();
    out(`verify: MISMATCH against ${target}, ${sorted.length} problem(s):`);
    for (const l of sorted) out(`  ${l}`);
    out(`fingerprint: ${crypto.createHash('sha1').update(sorted.join('\n')).digest('hex')}`);
    if (a.cache) { try { fs.rmSync(a.cache, { force: true }); } catch { /* best effort */ } }
    return 1;
  };

  let list;
  try { list = JSON.parse(fs.readFileSync(a.plugins, 'utf8')); } catch (e) { out(`verify: not verified: can't read the plugin list (${e.message})`); return 3; }
  const sel = selectInstalls(list, { pluginId: a.pluginId, projectDir: a.projectDir, version });
  if (sel.notInstalled) { out(`verify: not verified: ${a.pluginId} is not installed for ${a.projectDir} (run: fleet sync)`); return 3; }
  if (sel.problems.length) return mismatch(sel.problems);

  let local;
  try { local = localState(sel.roots); } catch (e) { out(`verify: not verified: can't read the plugin files (${e.message})`); return 3; }
  const where = sel.roots.join(', ');

  if (a.cache) {
    const c = readCache(a.cache);
    const ageMin = c ? (now() - Number(c.verifiedAt)) / 60_000 : Infinity;
    if (c && c.result === 'ok' && c.repo === a.repo && c.tag === a.tag && sameJson(c.local, local) && ageMin >= 0 && ageMin < a.maxAgeMin) {
      out(`verify: ok, ${countFiles(local)} protected files in ${where} match ${target} (unchanged since the check ${Math.floor(ageMin)}m ago)`);
      return 0;
    }
  }

  let rel;
  try { rel = await fetch({ repo: a.repo, tag: a.tag }); } catch (e) {
    out(`verify: not verified against ${target}: ${e instanceof Unverified ? e.message : String(e && e.message || e)}`);
    return 3;
  }
  const problems = [];
  if (rel.status !== 'ahead' && rel.status !== 'identical') {
    problems.push(`release    ${a.tag} is commit ${rel.commit}, which is not on ${rel.defaultBranch} (compare: ${rel.status})`);
  }
  for (const d of compare(rel.tree, local)) problems.push(`${d.kind.padEnd(10)} ${cachePath(d.root, d.path)} ${d.have}`);
  if (problems.length) return mismatch(problems);

  if (a.cache) {
    try { writeCache(a.cache, { repo: a.repo, tag: a.tag, local, result: 'ok', verifiedAt: now() }); } catch (e) {
      out(`verify: WARNING can't write ${a.cache} (${e.message}); the next run asks GitHub again`);
    }
  }
  out(`verify: ok, ${countFiles(local)} protected files in ${where} match ${target} (commit ${rel.commit.slice(0, 12)}, on ${rel.defaultBranch})`);
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
