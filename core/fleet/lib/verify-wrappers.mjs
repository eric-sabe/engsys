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
// Every regular file under the install root is hashed the way `git hash-object` does (sha1 of
// "blob <size>\0" + content) and compared with that tree. No manifest is stored anywhere.
//
// The whole install root is compared (engsys#86 review N1): Claude Code loads files from fixed places
// that nothing references (hooks/hooks.json, .mcp.json, bin/ on the Bash PATH, monitors/monitors.json,
// settings.json, any skills/<x>/SKILL.md), so every regular file under the root must be a core/ blob of
// the verified commit with the same content. An extra file is `unexpected`, a release file absent on disk
// is `missing`, and a symlink anywhere is `not-a-file`. The only thing skipped is Claude Code's own
// .in_use/ directory of PID markers at the top of the root.
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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo directory the engsys core plugin is built from (its marketplace `source`). */
export const PLUGIN_SUBDIR = 'core';
const P = (rel) => `${PLUGIN_SUBDIR}/${rel}`;

/**
 * Host ENGSYS_DIR files that run outside the plugin cache (engsys#88): the identity shim, the fleet
 * kit entry points, and the supervisor script. Checked against the same release tree when --engsys-dir
 * is given.
 */
export const ENGSYS_HOST_PATHS = [
  'core/fleet/identity/bin/gh',
  'core/fleet/verify.sh',
  'core/fleet/lib/verify-wrappers.mjs',
  'core/fleet/launch.sh',
  'core/fleet/supervise.sh',
  'core/fleet/lib/fleet-env.sh',
  'core/fleet/bin/fleet',
  'core/skills/agent-sessions/scripts/fleet-supervisor.sh',
];

/** Settings env keys that can hijack hook execution or singleton fencing (engsys#96 M3). */
export const DANGEROUS_SETTINGS_ENV_KEYS = [
  'PATH',
  'NODE_OPTIONS',
  'CLAUDE_PLUGIN_ROOT',
  'ENGSYS_SINGLETON_ROLE',
  'GITHUB_API_URL',
  'ENGSYS_ALLOW_CUSTOM_GITHUB_API_URL',
  'GH_HOST',
];

/** Claude Code's PID-marker directory at the top of an install root: written by Claude Code, never loaded. */
export const IN_USE = '.in_use';

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

/**
 * Every entry under one install root. → { [repoPath]: sha | 'not-a-file' }. A symlink (to a file or a
 * directory) or anything else that isn't a regular file or a real directory is 'not-a-file' and is not
 * followed: a symlink could be repointed after the check. Only <root>/.in_use/ (and macOS .DS_Store) is skipped.
 */
export function scanRoot(root) {
  const out = {};
  const visit = (absDir, relDir) => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (relDir === '' && e.name === IN_USE && e.isDirectory()) continue;
      if (e.name === '.DS_Store') continue;
      const abs = path.join(absDir, e.name);
      const rel = `${relDir}${e.name}`;
      if (e.isDirectory()) visit(abs, `${rel}/`);
      else if (e.isFile()) out[`${PLUGIN_SUBDIR}/${rel}`] = blobSha(fs.readFileSync(abs));
      else out[`${PLUGIN_SUBDIR}/${rel}`] = 'not-a-file';
    }
  };
  visit(root, '');
  return out;
}

/** Scan every root. → { [root]: scanRoot(root) } */
export function localState(roots) {
  return Object.fromEntries(roots.map((r) => [r, scanRoot(r)]));
}

/**
 * Scan the protected host kit paths under engsysDir (engsys#88).
 * → { [repoPath]: sha | 'missing' | 'not-a-file' }. Any symlink along the path (including engsysDir
 * itself) is 'not-a-file'.
 */
export function scanHost(engsysDir) {
  const out = {};
  let rootSt = null;
  try {
    rootSt = fs.lstatSync(engsysDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      for (const rel of ENGSYS_HOST_PATHS) out[rel] = 'missing';
      return out;
    }
    throw e;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    for (const rel of ENGSYS_HOST_PATHS) out[rel] = 'not-a-file';
    return out;
  }
  for (const rel of ENGSYS_HOST_PATHS) {
    const parts = rel.split('/');
    let cur = engsysDir;
    let state = null;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch (e) {
        if (e && e.code === 'ENOENT') state = 'missing';
        else throw e;
        break;
      }
      if (st.isSymbolicLink()) { state = 'not-a-file'; break; }
      if (i < parts.length - 1 && !st.isDirectory()) { state = 'not-a-file'; break; }
      if (i === parts.length - 1 && !st.isFile()) { state = 'not-a-file'; break; }
    }
    out[rel] = state ?? blobSha(fs.readFileSync(cur));
  }
  return out;
}

/**
 * Compare scanHost(engsysDir) with the release tree (engsys#88).
 * → [{ root, path, absPath, kind, have }]
 */
export function compareHost(tree, hostState, engsysDir) {
  const diffs = [];
  for (const [p, have] of Object.entries(hostState)) {
    const want = tree.get(p) ?? null;
    const absPath = path.join(engsysDir, p);
    if (want === null) diffs.push({ root: engsysDir, path: p, absPath, kind: 'missing-in-release', have });
    else if (have === 'missing') diffs.push({ root: engsysDir, path: p, absPath, kind: 'missing', have: '-' });
    else if (have === 'not-a-file') diffs.push({ root: engsysDir, path: p, absPath, kind: 'not-a-file', have });
    else if (want !== have) diffs.push({ root: engsysDir, path: p, absPath, kind: 'modified', have });
  }
  return diffs;
}

/**
 * Check Claude Code settings files for hook/env/plugin overrides or pin drift (engsys#96 M3).
 * Inspects:
 *   - <projectDir>/.claude/settings.json (disableAllHooks, hooks, protected env, and optional blob SHA match vs origin)
 *   - <projectDir>/.claude/settings.local.json
 *   - <userSettingsDir>/settings.json and <userSettingsDir>/settings.local.json
 */
export function checkSettings({ projectDir, userSettingsDir = '', pinSettingsSha = '' }) {
  const problems = [];
  const pinFile = path.join(projectDir, '.claude', 'settings.json');
  let pinCfg = null;
  let pinEnabled = new Set();
  if (fs.existsSync(pinFile)) {
    let st;
    try { st = fs.lstatSync(pinFile); } catch { st = null; }
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      problems.push(`settings   ${pinFile} is not a regular file`);
    } else {
      const raw = fs.readFileSync(pinFile);
      if (pinSettingsSha) {
        const haveSha = blobSha(raw);
        if (haveSha !== pinSettingsSha) {
          problems.push(`settings   ${pinFile} differs from origin (${haveSha} != ${pinSettingsSha})`);
        }
      }
      try {
        pinCfg = JSON.parse(raw.toString('utf8'));
        if (!pinCfg || typeof pinCfg !== 'object' || Array.isArray(pinCfg)) {
          problems.push(`settings   ${pinFile} is not a JSON object`);
        } else {
          if (pinCfg.disableAllHooks === true) {
            problems.push(`settings   ${pinFile} sets disableAllHooks: true`);
          }
          if (pinCfg.hooks !== undefined) {
            problems.push(`settings   ${pinFile} defines hooks`);
          }
          if (pinCfg.env && typeof pinCfg.env === 'object' && !Array.isArray(pinCfg.env)) {
            for (const k of DANGEROUS_SETTINGS_ENV_KEYS) {
              if (Object.prototype.hasOwnProperty.call(pinCfg.env, k)) {
                problems.push(`settings   ${pinFile} overrides protected env ${k}`);
              }
            }
          }
          pinEnabled = new Set(
            pinCfg.enabledPlugins && typeof pinCfg.enabledPlugins === 'object' && !Array.isArray(pinCfg.enabledPlugins)
              ? Object.entries(pinCfg.enabledPlugins)
                  .filter(([, v]) => v === true)
                  .map(([k]) => k)
              : [],
          );
        }
      } catch {
        problems.push(`settings   ${pinFile} is not valid JSON`);
      }
    }
  } else if (pinSettingsSha) {
    problems.push(`settings   ${pinFile} is missing (expected ${pinSettingsSha})`);
  }

  const overlayFiles = [path.join(projectDir, '.claude', 'settings.local.json')];
  if (userSettingsDir) {
    overlayFiles.push(
      path.join(userSettingsDir, 'settings.json'),
      path.join(userSettingsDir, 'settings.local.json'),
    );
  }
  for (const f of overlayFiles) {
    let st;
    try { st = fs.lstatSync(f); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      problems.push(`settings   ${f} cannot be stat'd`);
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      problems.push(`settings   ${f} is not a regular file`);
      continue;
    }
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      problems.push(`settings   ${f} is not valid JSON`);
      continue;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      problems.push(`settings   ${f} is not a JSON object`);
      continue;
    }
    if (cfg.disableAllHooks === true) {
      problems.push(`settings   ${f} sets disableAllHooks: true`);
    }
    if (cfg.hooks !== undefined) {
      problems.push(`settings   ${f} defines hooks`);
    }
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const k of DANGEROUS_SETTINGS_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(cfg.env, k)) {
          problems.push(`settings   ${f} overrides protected env ${k}`);
        }
      }
    }
    if (cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object' && !Array.isArray(cfg.enabledPlugins)) {
      for (const [plugin, enabled] of Object.entries(cfg.enabledPlugins)) {
        if (enabled === true && !pinEnabled.has(plugin)) {
          problems.push(`settings   ${f} enables unpinned plugin ${plugin}`);
        } else if (enabled === false && pinEnabled.has(plugin)) {
          problems.push(`settings   ${f} disables pinned plugin ${plugin}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Parse a plugin list from Claude Code (`claude plugin list --json`), Copilot CLI (`$COPILOT_HOME/config.json`
 * with leading `//` JSONC comments and `installedPlugins`), or Antigravity (`.agents/plugins.json`).
 */
export function parsePluginList(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const cleaned = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    parsed = JSON.parse(cleaned);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.installedPlugins)
      ? parsed.installedPlugins
      : Array.isArray(parsed?.plugins)
        ? parsed.plugins
        : [];
  return arr.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const id = e.id || (e.name && e.marketplace ? `${e.name}@${e.marketplace}` : '');
    const installPath = e.installPath ?? e.cache_path ?? e.install_path ?? '';
    const projectPath = e.projectPath ?? e.project_path;
    const scope = e.scope ?? 'user';
    return {
      ...e,
      ...(id ? { id } : {}),
      ...(installPath ? { installPath } : {}),
      ...(projectPath ? { projectPath } : {}),
      scope,
    };
  });
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
 * Compare each install root with the release's core/ tree. → [{ root, path, kind, have }] for every
 * difference: modified (different bytes) | missing (in the release, not on disk) | unexpected (on disk,
 * not in the release) | not-a-file (a symlink or other non-regular entry).
 */
export function compare(tree, local) {
  const diffs = [];
  for (const [root, m] of Object.entries(local)) {
    for (const p of tree.keys()) {
      if (p.startsWith(`${PLUGIN_SUBDIR}/`) && !(p in m)) diffs.push({ root, path: p, kind: 'missing', have: '-' });
    }
    for (const [p, have] of Object.entries(m)) {
      const want = tree.get(p) ?? null;
      if (have === 'not-a-file') diffs.push({ root, path: p, kind: 'not-a-file', have });
      else if (want === null) diffs.push({ root, path: p, kind: 'unexpected', have });
      else if (want !== have) diffs.push({ root, path: p, kind: 'modified', have });
    }
  }
  return diffs;
}

function findShadowingPlugins(pluginId, verifiedRoots, candidateDirs, real) {
  const pluginName = String(pluginId || '').split('@')[0];
  if (!pluginName) return [];
  const verifiedSet = new Set(verifiedRoots.map((r) => real(r)));
  const shadows = [];
  for (const baseDir of candidateDirs) {
    if (!baseDir || !fs.existsSync(baseDir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const candidate = path.join(baseDir, e.name);
      if (verifiedSet.has(real(candidate))) continue;
      for (const rel of ['plugin.json', '.claude-plugin/plugin.json']) {
        const mf = path.join(candidate, rel);
        if (!fs.existsSync(mf)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (parsed && parsed.name === pluginName) {
            shadows.push(`shadowed   ${pluginId} is shadowed by ${candidate} (${mf})`);
            break;
          }
        } catch {
          shadows.push(`shadowed   ${pluginId} has unreadable plugin manifest at ${mf}`);
          break;
        }
      }
    }
  }
  return shadows;
}

/**
 * Which installs apply in projectDir, from `claude plugin list --json` (or Copilot / Antigravity plugin list).
 * → { roots, problems, notInstalled }. problems are mismatches: an applicable entry at another version
 * or without a path, more than one install path, no enabled entry, or an Antigravity global shadow (NA-4).
 */
export function selectInstalls(list, { pluginId, projectDir, version, harness = 'claude', globalPluginsDir = '' }) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const dir = real(projectDir);
  const normalized = parsePluginList(list);
  const entries = normalized.filter((e) => e && e.id === pluginId);
  const applicable = entries.filter((e) => !e.projectPath || real(e.projectPath) === dir);
  const roots = [...new Set(applicable.filter((e) => e.version === version && e.installPath).map((e) => real(e.installPath)))];

  const shadowDirs = [];
  if (harness === 'antigravity' || globalPluginsDir) {
    shadowDirs.push(globalPluginsDir || process.env.AGY_GLOBAL_PLUGINS_DIR || path.join(os.homedir(), '.gemini', 'config', 'plugins'));
    shadowDirs.push(path.join(dir, '.agents', 'plugins'));
  }
  const shadowProblems = findShadowingPlugins(pluginId, roots, shadowDirs, real);

  if (!applicable.length) {
    if (shadowProblems.length) return { roots: [], problems: shadowProblems, notInstalled: false };
    return { roots: [], problems: [], notInstalled: true };
  }
  const problems = [...shadowProblems];
  for (const e of applicable) {
    if (e.version !== version) problems.push(`version    ${pluginId} (${e.scope || '?'} scope) is ${e.version ?? 'unversioned'}, not the pin ${version}: ${e.installPath || '(no path)'}`);
    else if (!e.installPath) problems.push(`no-path    ${pluginId} (${e.scope || '?'} scope) has no install path`);
  }
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
  const a = {
    repo: '',
    tag: '',
    pluginId: '',
    projectDir: '',
    plugins: '',
    cache: '',
    maxAgeMin: null,
    harness: process.env.HARNESS || process.env.FLEET_HARNESS || 'claude',
    globalPluginsDir: process.env.AGY_GLOBAL_PLUGINS_DIR || '',
    engsysDir: '',
    checkSettings: false,
    userSettingsDir: '',
    pinSettingsSha: '',
  };
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
      case '--harness': a.harness = v(); break;
      case '--global-plugins-dir': a.globalPluginsDir = v(); break;
      case '--engsys-dir': a.engsysDir = v(); break;
      case '--check-settings': a.checkSettings = true; break;
      case '--user-settings-dir': a.userSettingsDir = v(); a.checkSettings = true; break;
      case '--pin-settings-sha': a.pinSettingsSha = v(); a.checkSettings = true; break;
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
  try { list = parsePluginList(fs.readFileSync(a.plugins, 'utf8')); } catch (e) { out(`verify: not verified: can't read the plugin list (${e.message})`); return 3; }
  const sel = selectInstalls(list, {
    pluginId: a.pluginId,
    projectDir: a.projectDir,
    version,
    harness: a.harness,
    globalPluginsDir: a.globalPluginsDir,
  });
  if (sel.notInstalled) { out(`verify: not verified: ${a.pluginId} is not installed for ${a.projectDir} (run: fleet sync)`); return 3; }
  const preProblems = [...sel.problems];
  if (a.checkSettings) {
    preProblems.push(
      ...checkSettings({
        projectDir: a.projectDir,
        userSettingsDir: a.userSettingsDir,
        pinSettingsSha: a.pinSettingsSha,
      }),
    );
  }
  if (preProblems.length) return mismatch(preProblems);

  let local;
  try { local = localState(sel.roots); } catch (e) { out(`verify: not verified: can't read the plugin files (${e.message})`); return 3; }
  let host = null;
  if (a.engsysDir) {
    try { host = scanHost(a.engsysDir); } catch (e) { out(`verify: not verified: can't read the host kit files (${e.message})`); return 3; }
  }
  const where = sel.roots.join(', ');

  if (a.cache) {
    const c = readCache(a.cache);
    const ageMin = c ? (now() - Number(c.verifiedAt)) / 60_000 : Infinity;
    if (c && c.result === 'ok' && c.repo === a.repo && c.tag === a.tag && sameJson(c.local, local) && sameJson(c.host ?? null, host) && ageMin >= 0 && ageMin < a.maxAgeMin) {
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
  if (host) {
    for (const d of compareHost(rel.tree, host, a.engsysDir)) problems.push(`${d.kind.padEnd(10)} ${d.absPath} ${d.have}`);
  }
  if (problems.length) return mismatch(problems);

  if (a.cache) {
    try { writeCache(a.cache, { repo: a.repo, tag: a.tag, local, host, result: 'ok', verifiedAt: now() }); } catch (e) {
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
