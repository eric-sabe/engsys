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
//                       [--engsys-dir <ENGSYS_DIR>] [--check-settings] [--user-settings-dir <claude config dir>]
//                       [--allowed-user-plugins "<name@mkt> ..."] [--pin-repo <owner/repo>]
//                       [--cache <file> --max-age-min <n>]
//
// --engsys-dir: the host kit (ENGSYS_HOST_TREES, ENGSYS_HOST_FILES) against the same release tree.
// --user-settings-dir: the Claude config dir the sessions use (FLEET_CLAUDE_CONFIG_DIR, else ~/.claude);
//   a user-scope plugin the project doesn't enable is a mismatch unless --allowed-user-plugins lists it.
// --pin-repo: PIN_DIR's .claude/ tree and every settings-hook target against that repo's default branch
//   on GitHub (projectLocalState + verifyProjectTrust, below). A pin checkout behind the tip passes with a WARNING line.
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
import { hermeticGit } from '../../lib/git-env.mjs';

/** The repo directory the engsys core plugin is built from (its marketplace `source`). */
export const PLUGIN_SUBDIR = 'core';
const P = (rel) => `${PLUGIN_SUBDIR}/${rel}`;

/**
 * Host ENGSYS_DIR code that runs outside the plugin cache (engsys#88): the fleet kit, which holds the
 * identity shim, git-env.sh, the launcher wrapper and the verifier itself, and the shared libraries
 * it loads. Whole trees, not a hand-picked list: every regular file under each tree must be a blob of
 * the release with the same content, every release file under it must be on disk, and any symlink is
 * `not-a-file`. Checked against the same release tree when --engsys-dir is given.
 */
export const ENGSYS_HOST_TREES = ['core/fleet', 'core/lib'];
/** Single host files outside those trees that the kit runs from ENGSYS_DIR. */
export const ENGSYS_HOST_FILES = [
  'core/skills/agent-sessions/scripts/fleet-supervisor.sh',
  'core/skills/agent-sessions/scripts/launch-agent-sessions.sh',
];
/** Back-compat name: the single files plus the trees' entry points callers used to list. */
export const ENGSYS_HOST_PATHS = [
  'core/fleet/identity/bin/gh',
  'core/fleet/identity/git-env.sh',
  'core/fleet/verify.sh',
  'core/fleet/lib/verify-wrappers.mjs',
  'core/fleet/launch.sh',
  'core/fleet/supervise.sh',
  'core/fleet/lib/fleet-env.sh',
  'core/fleet/bin/fleet',
  ...ENGSYS_HOST_FILES,
];

/** Settings env keys that can hijack hook execution or singleton fencing (engsys#96 M3). */
export const DANGEROUS_SETTINGS_ENV_KEYS = [
  'PATH',
  'NODE_OPTIONS',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_CONFIG_DIR',
  'ENGSYS_SINGLETON_ROLE',
  'GITHUB_API_URL',
  'ENGSYS_ALLOW_CUSTOM_GITHUB_API_URL',
  'GH_HOST',
];
/**
 * Every settings `env` key in these families is protected: the kit's own switches (ENGSYS_, FLEET_,
 * HARNESS*), other harnesses' plugin roots and homes (COPILOT_, AGY_), the Node runtime (NODE_), the
 * plugin and config roots, PATH, and the GitHub identity / endpoint (GH_, GITHUB_).
 */
export const DANGEROUS_SETTINGS_ENV_RE = /^(ENGSYS_|FLEET_|HARNESS|COPILOT_|AGY_|NODE_|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR|PATH$|GH_|GITHUB_)/;
export const isProtectedEnvKey = (k) => DANGEROUS_SETTINGS_ENV_KEYS.includes(k) || DANGEROUS_SETTINGS_ENV_RE.test(k);

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
 * lstat each component of <engsysDir>/<rel> (engsysDir included). → 'missing' | 'not-a-file' |
 * 'dir' | 'file': a symlink anywhere along the path is 'not-a-file' (it could be repointed after the
 * check).
 */
function hostPathKind(engsysDir, rel) {
  let cur = engsysDir;
  const parts = rel ? rel.split('/') : [];
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) {
      if (e && e.code === 'ENOENT') return 'missing';
      throw e;
    }
    if (st.isSymbolicLink()) return 'not-a-file';
    if (i < parts.length - 1 && !st.isDirectory()) return 'not-a-file';
    if (i === parts.length - 1) return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'not-a-file';
  }
  return 'dir';
}

/**
 * Scan the protected host kit under engsysDir (engsys#88): every file of ENGSYS_HOST_TREES and each
 * of ENGSYS_HOST_FILES. → { [repoPath]: sha | 'missing' | 'not-a-file' }. A tree that is absent is
 * recorded as `<tree>/` 'missing' (compareHost then lists the release files it lacks); a symlinked
 * tree or path component is 'not-a-file'. .DS_Store is skipped, nothing else.
 */
export function scanHost(engsysDir) {
  const out = {};
  for (const tree of ENGSYS_HOST_TREES) {
    const kind = hostPathKind(engsysDir, tree);
    if (kind === 'missing') { out[`${tree}/`] = 'missing'; continue; }
    if (kind !== 'dir') { out[`${tree}/`] = 'not-a-file'; continue; }
    const visit = (absDir, relDir) => {
      for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (e.name === '.DS_Store') continue;
        const abs = path.join(absDir, e.name);
        const rel = `${relDir}/${e.name}`;
        if (e.isDirectory()) visit(abs, rel);
        else if (e.isFile()) out[rel] = blobSha(fs.readFileSync(abs));
        else out[rel] = 'not-a-file';
      }
    };
    visit(path.join(engsysDir, tree), tree);
  }
  for (const rel of ENGSYS_HOST_FILES) {
    const kind = hostPathKind(engsysDir, rel);
    out[rel] = kind === 'file' ? blobSha(fs.readFileSync(path.join(engsysDir, rel))) : kind === 'dir' ? 'not-a-file' : kind;
  }
  return out;
}

/**
 * Compare scanHost(engsysDir) with the release tree (engsys#88).
 * → [{ root, path, absPath, kind, have }]: modified | missing (in the release, not on disk) |
 * unexpected (on disk under a protected tree, not in the release) | not-a-file | missing-in-release
 * (a protected single file the release doesn't have).
 */
export function compareHost(tree, hostState, engsysDir) {
  const diffs = [];
  const push = (p, kind, have) => diffs.push({ root: engsysDir, path: p, absPath: path.join(engsysDir, p), kind, have });
  for (const t of ENGSYS_HOST_TREES) {
    const marker = hostState[`${t}/`];
    if (marker === 'not-a-file') { push(`${t}/`, 'not-a-file', marker); continue; }
    for (const p of tree.keys()) {
      if (p.startsWith(`${t}/`) && !(p in hostState)) push(p, 'missing', '-');
    }
  }
  for (const [p, have] of Object.entries(hostState)) {
    if (p.endsWith('/')) continue;
    const want = tree.get(p) ?? null;
    const inTree = ENGSYS_HOST_TREES.some((t) => p.startsWith(`${t}/`));
    if (have === 'missing') { if (want !== null || !inTree) push(p, 'missing', '-'); }
    else if (have === 'not-a-file') push(p, 'not-a-file', have);
    else if (want === null) push(p, inTree ? 'unexpected' : 'missing-in-release', have);
    else if (want !== have) push(p, 'modified', have);
  }
  return diffs;
}

/** Parse VERIFY_ALLOWED_USER_PLUGINS: space-separated name@marketplace. → Set (invalid entries dropped). */
export function parseAllowedPlugins(text) {
  return new Set(String(text || '').split(/\s+/).filter((t) => ID_RE.test(t)));
}

/**
 * Check Claude Code settings files for hook/env/plugin overrides or pin drift (engsys#96 M3).
 * Inspects:
 *   - <projectDir>/.claude/settings.json: disableAllHooks, protected env keys; its hooks count as
 *     verified only when projectVerified (verifyProjectTrust compared the whole .claude/ tree and every
 *     hook target with the reviewed commit) or its blob matches pinSettingsSha;
 *   - <projectDir>/.claude/settings.local.json;
 *   - <userSettingsDir>/settings.json and settings.local.json (the fleet's CLAUDE_CONFIG_DIR, else
 *     ~/.claude). A user-scope plugin the project doesn't enable is a mismatch unless it is in
 *     allowedUserPlugins (VERIFY_ALLOWED_USER_PLUGINS), which reports it as `allowed` in info instead:
 *     its hooks still run in fleet sessions, so allowing one is an operator decision.
 * → { problems: [...], info: [...] }
 */
export function checkSettingsDetailed({ projectDir, userSettingsDir = '', pinSettingsSha = '', projectVerified = false, allowedUserPlugins = new Set() }) {
  const problems = [];
  const info = [];
  const allowed = allowedUserPlugins instanceof Set ? allowedUserPlugins : parseAllowedPlugins(allowedUserPlugins);
  const envProblems = (f, cfg) => {
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const k of Object.keys(cfg.env).sort()) {
        if (isProtectedEnvKey(k)) problems.push(`settings   ${f} overrides protected env ${k}`);
      }
    }
  };
  const pinFile = path.join(projectDir, '.claude', 'settings.json');
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
        const pinCfg = JSON.parse(raw.toString('utf8'));
        if (!pinCfg || typeof pinCfg !== 'object' || Array.isArray(pinCfg)) {
          problems.push(`settings   ${pinFile} is not a JSON object`);
        } else {
          if (pinCfg.disableAllHooks === true) {
            problems.push(`settings   ${pinFile} sets disableAllHooks: true`);
          }
          if (!pinSettingsSha && !projectVerified && pinCfg.hooks !== undefined) {
            problems.push(`settings   ${pinFile} defines hooks (unverified against origin)`);
          }
          envProblems(pinFile, pinCfg);
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

  const overlayFiles = [{ f: path.join(projectDir, '.claude', 'settings.local.json'), user: false }];
  if (userSettingsDir) {
    overlayFiles.push(
      { f: path.join(userSettingsDir, 'settings.json'), user: true },
      { f: path.join(userSettingsDir, 'settings.local.json'), user: true },
    );
  }
  for (const { f, user } of overlayFiles) {
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
    if (cfg.allowManagedHooksOnly === true) {
      problems.push(`settings   ${f} sets allowManagedHooksOnly: true`);
    }
    if (cfg.hooks !== undefined && f.endsWith('.local.json')) {
      problems.push(`settings   ${f} defines hooks`);
    }
    envProblems(f, cfg);
    if (cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object' && !Array.isArray(cfg.enabledPlugins)) {
      for (const [plugin, enabled] of Object.entries(cfg.enabledPlugins)) {
        if (enabled === true && !pinEnabled.has(plugin)) {
          if (user && allowed.has(plugin)) info.push(`allowed    ${f} enables user-scope plugin ${plugin} (VERIFY_ALLOWED_USER_PLUGINS)`);
          else problems.push(`settings   ${f} enables unpinned plugin ${plugin}`);
        } else if (enabled === false && pinEnabled.has(plugin)) {
          problems.push(`settings   ${f} disables pinned plugin ${plugin}`);
        }
      }
    }
  }
  return { problems, info };
}

/** checkSettingsDetailed's problems only (the original API). */
export function checkSettings(opts) {
  return checkSettingsDetailed(opts).problems;
}

// --- Project settings and hooks (the pin checkout) ------------------------------------------------
// Claude Code loads PIN_DIR/.claude/ (settings.json, its hooks, agents, commands, skills) into every
// fleet session, and a settings hook runs whatever script it names. The trust root is the pin repo's
// default branch as GitHub reports it, never a local ref (origin/HEAD and refs/remotes/* can be
// repointed by anything that runs as this user):
//   1. the default branch's tip SHA, from the API;
//   2. PIN_DIR's HEAD must be that tip or an ancestor of it: compare/<tip>...<HEAD> is `identical`
//      (ok) or `behind` (ok, with a warning to run fleet sync). `ahead`, `diverged`, or a commit GitHub
//      doesn't have is a mismatch;
//   3. every file under .claude/ on disk must be a blob of HEAD's .claude/ tree (from the API) with the
//      same content, and every blob of that tree must be on disk: nothing modified, missing or
//      untracked. Claude Code's own runtime state there is skipped (PROJECT_RUNTIME_EXEMPT);
//   4. every script a settings.json hook command names ($CLAUDE_PROJECT_DIR resolved) must lie inside
//      the repo, be a regular file, be tracked at HEAD and match it.

/** Paths under .claude/ that Claude Code itself writes and never loads as configuration. */
export const PROJECT_RUNTIME_EXEMPT = {
  files: ['.claude/settings.local.json', '.claude/scheduled_tasks.lock'],
  dirs: ['.claude/worktrees/'],
};
/** Interpreters and devices a hook command may name outside the repo. */
const SYSTEM_PATH_RE = /^\/(dev\/null$|bin\/|sbin\/|usr\/bin\/|usr\/sbin\/)/;

/** Split a shell command into words: quotes and backslashes removed, nothing expanded. */
export function shellWords(cmd) {
  const words = [];
  let cur = '', inWord = false, q = '';
  const s = String(cmd ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = ''; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inWord = true; continue; }
    if (/\s/.test(c) || ';|&()<>'.includes(c)) {
      if (inWord) { words.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += c; inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}

/** Every `type: command` hook command in a settings object. */
export function hookCommands(cfg) {
  const out = [];
  const hooks = cfg && typeof cfg === 'object' ? cfg.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (h && typeof h.command === 'string') out.push(h.command);
      }
    }
  }
  return out;
}

/**
 * The repo files a hook command names. → { targets: [repo-relative posix path], problems: [] }.
 * A word with a `/` is a path once $CLAUDE_PROJECT_DIR is resolved: it must stay inside projectDir
 * (system interpreters and /dev/null aside). Any other expansion left in a path can't be verified and
 * is a problem. A word that is itself a command line (bash -c "...") is split again.
 */
export function hookTargets(command, projectDir, depth = 0) {
  const targets = [];
  const problems = [];
  const root = path.resolve(projectDir);
  for (let w of shellWords(command)) {
    w = w.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])/g, root);
    if (/[\s;|&]/.test(w) && depth < 2) {
      const sub = hookTargets(w, projectDir, depth + 1);
      targets.push(...sub.targets); problems.push(...sub.problems);
      continue;
    }
    if (!w.includes('/')) continue;
    if (/[$`]/.test(w)) { problems.push(`hook       settings.json hook command names a path that can't be resolved: ${w}`); continue; }
    const abs = path.resolve(root, w);
    if (SYSTEM_PATH_RE.test(abs)) continue;
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { problems.push(`hook       settings.json hook command runs ${abs}, outside the repo`); continue; }
    targets.push(rel.split(path.sep).join('/'));
  }
  return { targets: [...new Set(targets)], problems };
}

function isExempt(rel) {
  return PROJECT_RUNTIME_EXEMPT.files.includes(rel) || PROJECT_RUNTIME_EXEMPT.dirs.some((d) => rel.startsWith(d));
}

/**
 * What the pin checkout has on disk: HEAD, every file under .claude/ (exempt paths aside), and each
 * hook target. → { head, files: {rel: sha|'not-a-file'}, targets: {rel: sha|'missing'|'not-a-file'|'outside'}, problems }
 */
export function projectLocalState(projectDir, { git = hermeticGit } = {}) {
  const problems = [];
  const root = path.resolve(projectDir);
  let head = '';
  try { head = git(root, ['--no-replace-objects', 'rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); } catch { head = ''; }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Unverified(`can't read HEAD of the pin checkout ${root}`);
  const files = {};
  const links = {}; // a symlink under .claude/ → the repo path it points at, or 'outside'
  const linked = {}; // the files under each such target: {rel: sha | 'not-a-file' | 'missing'}
  const claudeDir = path.join(root, '.claude');
  const realRootEarly = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  const inRepo = (abs) => {
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* lexical */ }
    const r = path.relative(realRootEarly, real);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null;
  };
  // Files under a directory, no symlinks followed: what a symlinked .claude/ entry brings in.
  const walk = (abs, rel, out) => {
    let st2 = null;
    try { st2 = fs.lstatSync(abs); } catch { st2 = null; }
    if (!st2) { out[rel] = 'missing'; return; }
    if (st2.isSymbolicLink()) { out[rel] = 'not-a-file'; return; }
    if (st2.isFile()) { out[rel] = blobSha(fs.readFileSync(abs)); return; }
    if (!st2.isDirectory()) { out[rel] = 'not-a-file'; return; }
    for (const e of fs.readdirSync(abs)) { if (e !== '.DS_Store') walk(path.join(abs, e), `${rel}/${e}`, out); }
  };
  let st = null;
  try { st = fs.lstatSync(claudeDir); } catch { st = null; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) files['.claude/'] = 'not-a-file';
  else if (st) {
    const visit = (absDir, relDir) => {
      for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (e.name === '.DS_Store') continue;
        const rel = `${relDir}/${e.name}`;
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) { if (!isExempt(`${rel}/`)) visit(abs, rel); }
        else if (isExempt(rel)) continue;
        else if (e.isFile()) files[rel] = blobSha(fs.readFileSync(abs));
        else if (e.isSymbolicLink()) {
          // A tracked symlink (git stores its target as the blob): compared with HEAD like any file,
          // and what it points at must be in the repo and match HEAD too.
          files[rel] = `symlink:${blobSha(fs.readlinkSync(abs))}`;
          const target = inRepo(path.resolve(absDir, fs.readlinkSync(abs)));
          if (!target) links[rel] = 'outside';
          else {
            links[rel] = target;
            if (!target.startsWith('.claude/')) walk(path.join(root, target), target, linked);
          }
        } else files[rel] = 'not-a-file';
      }
    };
    visit(claudeDir, '.claude');
  }
  const targets = {};
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')); } catch { cfg = null; }
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  for (const cmd of hookCommands(cfg)) {
    const t = hookTargets(cmd, root);
    problems.push(...t.problems);
    for (const rel of t.targets) {
      const abs = path.join(root, rel);
      let s2 = null;
      try { s2 = fs.lstatSync(abs); } catch { s2 = null; }
      if (!s2) { targets[rel] = 'missing'; continue; }
      if (s2.isSymbolicLink() || !s2.isFile()) { targets[rel] = 'not-a-file'; continue; }
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { /* keep */ }
      const r = path.relative(realRoot, real);
      if (!r || r.startsWith('..') || path.isAbsolute(r)) { targets[rel] = 'outside'; continue; }
      targets[rel] = blobSha(fs.readFileSync(abs));
    }
  }
  return { head, files, links, linked, targets, problems: [...new Set(problems)] };
}

/**
 * Compare projectLocalState() with GitHub. api(endpoint) → Promise<json>, rejecting with an
 * Unverified whose .httpStatus is set for an HTTP error. → { problems, warnings, tip, defaultBranch }
 */
export async function verifyProjectTrust(local, { repo, api }) {
  const problems = [...local.problems];
  const warnings = [];
  const defaultBranch = (await api(`repos/${repo}`)).default_branch;
  if (!defaultBranch) throw new Unverified(`can't read the default branch of ${repo}`);
  const ref = await api(`repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const tip = ref?.object?.sha;
  if (!/^[0-9a-f]{40}$/.test(tip || '')) throw new Unverified(`can't read the tip of ${repo} ${defaultBranch}`);
  let status = '';
  if (tip === local.head) status = 'identical';
  else {
    try { status = (await api(`repos/${repo}/compare/${tip}...${local.head}?per_page=1`)).status || ''; } catch (e) {
      if (e instanceof Unverified && (e.httpStatus === 404 || e.httpStatus === 422)) status = 'unknown-commit';
      else throw e;
    }
  }
  if (status === 'behind') warnings.push(`pin checkout behind ${defaultBranch}: HEAD ${local.head.slice(0, 12)} is an ancestor of ${tip.slice(0, 12)}; run fleet sync`);
  else if (status !== 'identical') {
    problems.push(`pin-head   ${repo} checkout HEAD ${local.head} is not ${defaultBranch} or an ancestor of it (${tip.slice(0, 12)}; compare: ${status || 'no status'})`);
    return { problems, warnings, tip, defaultBranch };
  }
  // HEAD's .claude/ tree, from GitHub.
  const commit = await api(`repos/${repo}/git/commits/${local.head}`);
  const top = parseTreeEntries(await api(`repos/${repo}/git/trees/${commit?.tree?.sha}`));
  const claudeEntry = top.find((e) => e.path === '.claude' && e.type === 'tree');
  const want = new Map();
  if (claudeEntry) {
    for (const e of parseTreeEntries(await api(`repos/${repo}/git/trees/${claudeEntry.sha}?recursive=1`))) {
      if (e.type === 'blob' && !e.path.endsWith('.DS_Store')) want.set(`.claude/${e.path}`, { sha: e.sha, mode: e.mode });
    }
  }
  if (local.files['.claude/'] === 'not-a-file') problems.push('claude-dir .claude is not a directory');
  for (const [rel, w] of want) {
    if (isExempt(rel)) continue;
    if (!(rel in local.files)) problems.push(`missing    ${rel} (tracked at HEAD)`);
  }
  for (const [rel, have] of Object.entries(local.files)) {
    if (rel === '.claude/') continue;
    const w = want.get(rel);
    if (have === 'not-a-file') problems.push(`not-a-file ${rel}`);
    else if (!w) problems.push(`untracked  ${rel} (not in HEAD)`);
    else if (have.startsWith('symlink:')) {
      if (w.mode !== '120000' || `symlink:${w.sha}` !== have) problems.push(`modified   ${rel} (a symlink that differs from HEAD)`);
    } else if (w.mode === '120000') problems.push(`not-a-file ${rel} (a symlink at HEAD)`);
    else if (w.sha !== have) problems.push(`modified   ${rel} ${have}`);
  }
  // What tracked symlinks under .claude/ point at: inside the repo, and matching HEAD there too.
  const linkRoots = [...new Set(Object.values(local.links || {}).filter((t) => t !== 'outside' && !t.startsWith('.claude/')))];
  for (const [rel, t] of Object.entries(local.links || {})) {
    if (t === 'outside') problems.push(`not-a-file ${rel} (a symlink that points outside the repo)`);
  }
  for (const t of linkRoots) {
    const wantT = await treeFilesAt(api, repo, commit?.tree?.sha, t);
    const haveT = Object.fromEntries(Object.entries(local.linked || {}).filter(([p]) => p === t || p.startsWith(`${t}/`)));
    for (const [p, w] of wantT) if (!(p in haveT)) problems.push(`missing    ${p} (tracked at HEAD, linked from .claude/)`);
    for (const [p, have] of Object.entries(haveT)) {
      const w = wantT.get(p);
      if (have === 'missing') { if (!wantT.size) problems.push(`missing    ${p} (linked from .claude/, not at HEAD)`); }
      else if (have === 'not-a-file') problems.push(`not-a-file ${p} (linked from .claude/)`);
      else if (!w) problems.push(`untracked  ${p} (linked from .claude/, not in HEAD)`);
      else if (w.mode === '120000' || w.sha !== have) problems.push(`modified   ${p} ${have} (linked from .claude/)`);
    }
  }
  for (const [rel, have] of Object.entries(local.targets)) {
    if (have === 'missing') { problems.push(`hook       settings.json hook target ${rel} is missing`); continue; }
    if (have === 'not-a-file') { problems.push(`hook       settings.json hook target ${rel} is not a regular file`); continue; }
    if (have === 'outside') { problems.push(`hook       settings.json hook target ${rel} resolves outside the repo`); continue; }
    let w = want.get(rel);
    if (!w && !rel.startsWith('.claude/')) {
      try {
        const c = await api(`repos/${repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}?ref=${local.head}`);
        if (c && !Array.isArray(c) && c.type === 'file' && typeof c.sha === 'string') w = { sha: c.sha };
      } catch (e) {
        if (!(e instanceof Unverified && e.httpStatus === 404)) throw e;
      }
    }
    if (!w) problems.push(`hook       settings.json hook target ${rel} is not tracked at HEAD`);
    else if (w.sha !== have) problems.push(`hook       settings.json hook target ${rel} differs from HEAD (${have})`);
  }
  return { problems: [...new Set(problems)], warnings, tip, defaultBranch };
}

/** Every blob at or under repoPath in a commit tree, from the API. → Map<repo path, {sha, mode}> (empty: not there) */
async function treeFilesAt(api, repo, rootTree, repoPath) {
  const out = new Map();
  const parts = repoPath.split('/');
  let tree = rootTree;
  for (let i = 0; i < parts.length; i++) {
    const e = parseTreeEntries(await api(`repos/${repo}/git/trees/${tree}`)).find((x) => x.path === parts[i]);
    if (!e) return out;
    if (i === parts.length - 1 && e.type === 'blob') { out.set(repoPath, { sha: e.sha, mode: e.mode }); return out; }
    if (e.type !== 'tree') return out;
    tree = e.sha;
  }
  for (const e of parseTreeEntries(await api(`repos/${repo}/git/trees/${tree}?recursive=1`))) {
    if (e.type === 'blob' && !e.path.endsWith('.DS_Store')) out.set(`${repoPath}/${e.path}`, { sha: e.sha, mode: e.mode });
  }
  return out;
}

function parseTreeEntries(t) {
  if (!t || !Array.isArray(t.tree)) throw new Unverified(`GitHub returned no tree${t && t.message ? `: ${t.message}` : ''}`);
  if (t.truncated) throw new Unverified('GitHub truncated the tree');
  return t.tree.filter((e) => e && typeof e.path === 'string' && typeof e.sha === 'string');
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
  for (const e of t.tree) {
    if (
      e &&
      e.type === 'blob' &&
      typeof e.path === 'string' &&
      typeof e.sha === 'string' &&
      e.path !== '.DS_Store' &&
      !e.path.endsWith('/.DS_Store')
    ) {
      m.set(e.path, e.sha);
    }
  }
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
        const u = new Unverified(`gh api ${endpoint} failed: ${why}`);
        const m = /HTTP (\d{3})/.exec(String(stderr || ''));
        if (m) u.httpStatus = Number(m[1]);
        reject(u);
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
    pinRepo: '',
    allowedUserPlugins: '',
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
      case '--pin-repo': a.pinRepo = v(); a.checkSettings = true; break;
      case '--allowed-user-plugins': a.allowedUserPlugins = v(); break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  if (!REPO_RE.test(a.repo)) throw new Error('--repo must be owner/repo');
  if (!TAG_RE.test(a.tag)) throw new Error('--tag must be a release tag, vX.Y.Z');
  if (!ID_RE.test(a.pluginId)) throw new Error('--plugin-id must be <plugin>@<marketplace>');
  if (!a.projectDir) throw new Error('--project-dir is needed');
  if (a.pinRepo && !REPO_RE.test(a.pinRepo)) throw new Error('--pin-repo must be owner/repo');
  if (!a.plugins) throw new Error('--plugins is needed (the output of `claude plugin list --json`, run in the project dir)');
  if (a.maxAgeMin !== null && !(Number.isFinite(a.maxAgeMin) && a.maxAgeMin >= 0)) throw new Error('--max-age-min must be a number of minutes');
  if ((a.maxAgeMin !== null) !== Boolean(a.cache)) throw new Error('--cache and --max-age-min go together');
  return a;
}

/** The CLI, with its effects injectable for tests. → exit code. */
export async function run(argv, {
  fetch = fetchRelease,
  projectApi = (endpoint) => ghJson('gh', endpoint, 30_000),
  projectLocal = projectLocalState,
  now = Date.now,
  out = (s) => process.stdout.write(s + '\n'),
} = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { out(`verify: ${e.message}`); return 2; }
  const target = `${a.repo}@${a.tag}`;
  const version = a.tag.slice(1);
  const mismatch = (lines) => {
    const sorted = [...new Set(lines)].sort();
    out(`verify: MISMATCH against ${target}, ${sorted.length} problem(s):`);
    for (const l of sorted) out(`  ${l}`);
    out(`fingerprint: ${crypto.createHash('sha1').update(sorted.join('\n')).digest('hex')}`);
    if (a.cache) { try { fs.rmSync(a.cache, { force: true }); } catch { /* best effort */ } }
    return 1;
  };
  const infoLines = (lines) => { for (const l of lines) out(`verify: info ${l}`); };
  const warnLines = (lines) => { for (const l of lines) out(`verify: WARNING ${l}`); };

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
  let info = [];
  let project = null;
  if (a.pinRepo) {
    try { project = projectLocal(a.projectDir); } catch (e) {
      out(`verify: not verified: ${e instanceof Unverified ? e.message : `can't read the pin checkout (${e && e.message})`}`);
      return 3;
    }
  }
  if (a.checkSettings) {
    const r = checkSettingsDetailed({
      projectDir: a.projectDir,
      userSettingsDir: a.userSettingsDir,
      pinSettingsSha: a.pinSettingsSha,
      projectVerified: Boolean(project),
      allowedUserPlugins: parseAllowedPlugins(a.allowedUserPlugins),
    });
    preProblems.push(...r.problems);
    info = r.info;
  }
  infoLines(info);
  if (preProblems.length) return mismatch(preProblems);

  let local;
  try { local = localState(sel.roots); } catch (e) { out(`verify: not verified: can't read the plugin files (${e.message})`); return 3; }
  let host = null;
  if (a.engsysDir) {
    try { host = scanHost(a.engsysDir); } catch (e) { out(`verify: not verified: can't read the host kit files (${e.message})`); return 3; }
  }
  const where = sel.roots.join(', ');
  const projectKey = project ? { repo: a.pinRepo, ...project } : null;

  if (a.cache) {
    const c = readCache(a.cache);
    const ageMin = c ? (now() - Number(c.verifiedAt)) / 60_000 : Infinity;
    if (c && c.result === 'ok' && c.repo === a.repo && c.tag === a.tag && sameJson(c.local, local) && sameJson(c.host ?? null, host)
      && sameJson(c.project ?? null, projectKey) && sameJson(c.info ?? [], info) && ageMin >= 0 && ageMin < a.maxAgeMin) {
      warnLines(Array.isArray(c.warnings) ? c.warnings : []);
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
  let warnings = [];
  if (project) {
    let pt;
    try { pt = await verifyProjectTrust(project, { repo: a.pinRepo, api: projectApi }); } catch (e) {
      out(`verify: not verified against ${a.pinRepo}: ${e instanceof Unverified ? e.message : String(e && e.message || e)}`);
      return 3;
    }
    problems.push(...pt.problems);
    warnings = pt.warnings;
  }
  warnLines(warnings);
  if (problems.length) return mismatch(problems);

  if (a.cache) {
    try { writeCache(a.cache, { repo: a.repo, tag: a.tag, local, host, project: projectKey, info, warnings, result: 'ok', verifiedAt: now() }); } catch (e) {
      out(`verify: WARNING can't write ${a.cache} (${e.message}); the next run asks GitHub again`);
    }
  }
  out(`verify: ok, ${countFiles(local)} protected files in ${where} match ${target} (commit ${rel.commit.slice(0, 12)}, on ${rel.defaultBranch})${project ? `; ${a.pinRepo} checkout ${project.head.slice(0, 12)} and its .claude/ match GitHub` : ''}`);
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
