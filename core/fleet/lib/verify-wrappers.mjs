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
//                       [--fleet-config-dir]
//                       [--allowed-user-plugins "<name@mkt> ..."] [--allowed-user-hooks "<sha256> ..."]
//                       [--check-user-config --claude-json <file> --allowed-user-files "<sha256> ..."]
//                       [--pin-repo <owner/repo>]
//                       [--market-plugin "<plugin>@<marketplace>|<owner/repo>|<ref>" ...]
//                       [--cache <file> --max-age-min <n>]
//
// --engsys-dir: the host kit (ENGSYS_HOST_TREES, ENGSYS_HOST_FILES) against the same release tree.
// --user-settings-dir: the Claude config dir the sessions use (FLEET_CLAUDE_CONFIG_DIR, else ~/.claude);
//   a user-scope plugin the project doesn't enable is a mismatch unless --allowed-user-plugins lists it,
//   and a user-scope hook or settings command unless --allowed-user-hooks lists its userCommandHash.
// --market-plugin (repeatable, engsys#196): a plugin of another marketplace (the instance's), checked the same
//   way against that repo's release <ref> (a vX.Y.Z tag). The directory its install is a copy of is the
//   `source` of its entry in the release's .claude-plugin/marketplace.json, read from GitHub (pluginSubdir).
// --pin-repo: PIN_DIR's .claude/ tree and every settings-hook target against that repo's default branch
//   on GitHub (projectLocalState + verifyProjectTrust, below). A pin checkout behind the tip passes with a
//   WARNING line only while every auto-loaded file is identical at the tip.
// --fleet-config-dir (engsys#201): --user-settings-dir is a fleet config dir (not ~/.claude): warn when its settings.json
//   doesn't switch the claude.ai skill/plugin sync off. Synced skills are never trusted by source (see userConfigItems).
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
import { exitAfterFlush } from '../../lib/exit-after-flush.mjs';

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
/**
 * Settings `env` keys that move a session or a subagent off its pinned model: a pinned security agent
 * (model: claude-opus-4-8) would otherwise run on whatever a committed settings file names.
 */
export const MODEL_SETTINGS_ENV_RE = /^(CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_[A-Z0-9_]*_MODEL)$/;
/**
 * Settings `env` keys that move the API endpoint, the credentials or the provider, or route traffic
 * through a proxy (proxy variables in any case).
 */
export const ENDPOINT_SETTINGS_ENV_RE = /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|[A-Za-z0-9_]*_BASE_URL)$/;
const PROXY_ENV_RE = /^(http_proxy|https_proxy|all_proxy|no_proxy)$/i;
/**
 * Settings `env` keys that make a shell, git, the dynamic loader or another interpreter load code: Claude
 * Code applies a settings env to the session, its hooks and its Bash tool.
 */
export const CODE_INJECTION_ENV_RE = /^(BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|GIT_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|LD_[A-Z0-9_]*|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PYTHONUSERBASE|PERL5LIB|PERL5OPT|PERLLIB|RUBYOPT|RUBYLIB)$/;
export const isProtectedEnvKey = (k) => DANGEROUS_SETTINGS_ENV_KEYS.includes(k) || DANGEROUS_SETTINGS_ENV_RE.test(k)
  || MODEL_SETTINGS_ENV_RE.test(k) || ENDPOINT_SETTINGS_ENV_RE.test(k) || PROXY_ENV_RE.test(k) || CODE_INJECTION_ENV_RE.test(k);

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

/** The file under an install root that holds a protected repo path (subdir: the plugin's source directory in its repo). */
export function cachePath(root, repoPath, subdir = PLUGIN_SUBDIR) {
  return path.join(root, repoPath.slice(subdir.length + 1));
}

/**
 * Every entry under one install root. → { [repoPath]: sha | 'not-a-file' }. A symlink (to a file or a
 * directory) or anything else that isn't a regular file or a real directory is 'not-a-file' and is not
 * followed: a symlink could be repointed after the check. Only <root>/.in_use/ (and macOS .DS_Store) is skipped.
 */
export function scanRoot(root, subdir = PLUGIN_SUBDIR) {
  const out = {};
  const visit = (absDir, relDir) => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (relDir === '' && e.name === IN_USE && e.isDirectory()) continue;
      if (e.name === '.DS_Store') continue;
      const abs = path.join(absDir, e.name);
      const rel = `${relDir}${e.name}`;
      if (e.isDirectory()) visit(abs, `${rel}/`);
      else if (e.isFile()) out[`${subdir}/${rel}`] = blobSha(fs.readFileSync(abs));
      else out[`${subdir}/${rel}`] = 'not-a-file';
    }
  };
  visit(root, '');
  return out;
}

/** Scan every root. → { [root]: scanRoot(root, subdir) } */
export function localState(roots, subdir = PLUGIN_SUBDIR) {
  return Object.fromEntries(roots.map((r) => [r, scanRoot(r, subdir)]));
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

/** Parse VERIFY_ALLOWED_USER_HOOKS: space-separated sha256 hex digests (userCommandHash). → Set */
export function parseAllowedHooks(text) {
  return new Set(String(text || '').split(/\s+/).map((t) => t.toLowerCase()).filter((t) => /^[0-9a-f]{64}$/.test(t)));
}

// --- Commands in settings files -------------------------------------------------------------------
// Claude Code runs commands from settings files besides hooks: the status line, the @-mention file
// suggester, and the credential / header helpers (Claude Code 2.1.292's settings schema). Any other
// top-level key ending in Helper or Command is treated the same way.
export const COMMAND_SETTINGS_KEYS = [
  'statusLine', 'fileSuggestion', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport',
  'gcpAuthRefresh', 'otelHeadersHelper', 'proxyAuthHelper',
];
const COMMAND_KEY_RE = /(Helper|Command)$/;

/** Every command a settings object runs: hooks and command-bearing keys. → [{ where, command }] */
export function settingsCommands(cfg) {
  const out = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
  for (const c of hookCommands(cfg)) out.push({ where: 'hook', command: c });
  for (const [k, v] of Object.entries(cfg)) {
    if (!COMMAND_SETTINGS_KEYS.includes(k) && !COMMAND_KEY_RE.test(k)) continue;
    if (typeof v === 'string' && v.trim()) out.push({ where: k, command: v });
    else if (v && typeof v === 'object' && typeof v.command === 'string') out.push({ where: k, command: v.command });
    else if (v !== undefined && v !== null && v !== false) out.push({ where: k, command: JSON.stringify(v) });
  }
  return out;
}

// --- Command lines in settings (hooks and command keys) --------------------------------------------
// A command is pinned only when everything it runs is known: each simple command (split on ; & | && ||)
// is a shell no-op (echo, printf, true, false, :, exit), an interpreter with an absolute script, a root-owned
// system program from the short SAFE_PROGRAMS list (they run nothing named in their arguments), a system wrapper
// (nice, timeout, xargs, ...) whose wrapped command passes these same rules, or an absolute path to a regular file,
// and every file it names is an absolute path to a regular file. Any other system program (git, perl -e, awk,
// sed, osascript, ...) is refused: an allowlist, because a denylist of "dangerous" names can be split, aliased
// or renamed around. Only ~, $HOME and
// $CLAUDE_PROJECT_DIR are expanded. Rejected, never guessed at: other variables, command substitution,
// globs, ~user, brace expansion, input redirects, output redirects other than to /dev/null or another
// fd, subshells, env assignments, a program found on PATH that is not an interpreter in SYSTEM_BIN_DIRS,
// interpreter flags outside a small safe list (anything that could load other code),
// a relative path, a directory, a symlink, a missing file, and `sh -c` nested more than once. An
// interpreter is pinned by its path; any other program outside /bin and /usr/bin by its content. A
// script's own imports or sources are not followed: an allowlisted command should run one
// self-contained file.

/** Where an interpreter named without a path may come from; its resolved path is part of the pin. */
export const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'];
const SHELLS = ['bash', 'sh', 'zsh'];
const INTERPRETERS = [...SHELLS, 'node', 'python', 'python3', 'perl', 'ruby'];
/** python3.12, python3.13, ... are the same interpreter under a version-suffixed name. */
const isInterp = (n) => INTERPRETERS.includes(n) || /^python[0-9.]*$/.test(n);
/**
 * Root-owned system programs a pinned command may run by absolute path: none of them runs a command, a script or
 * code named in its arguments. Everything else under /bin and /usr/bin (git, awk, sed, find, perl -e, osascript,
 * ...) is refused.
 */
const SAFE_PROGRAMS = ['true', 'false', 'echo', 'printf', 'sleep', 'date', 'cat', 'head', 'tail', 'wc', 'uname', 'pwd', 'basename', 'dirname'];
/** System wrappers: they run the command in their arguments, which then has to pass the same rules. */
const WRAPPERS = ['nice', 'nohup', 'timeout', 'xargs', 'time'];
/** Options of a wrapper that take a value, and whether it has a leading positional (timeout's duration). */
const WRAPPER_VALUE_FLAGS = { nice: ['-n', '--adjustment'], nohup: [], timeout: ['-k', '--kill-after', '-s', '--signal'], xargs: ['-n', '-P', '-L', '-s', '-d', '-E'], time: ['-o', '-f'] };
/** The options of xargs that only shape how it batches its input: anything else (-a <file>, -J, -I <replstr>, which lets its input rewrite the command, ...) is refused. */
const XARGS_FLAGS = /^(-0|-r|-t|-x|--null|--no-run-if-empty|--verbose|--max-args=.*|--max-procs=.*|-[nPsLdE].*)$/;
/**
 * The words after a wrapper's own options (and timeout's duration): the command it runs. → array, or null when an
 * option can't be allowed (xargs reading its words from a file). An empty array is a wrapper with no command of its
 * own: refused by the caller, since xargs would then supply the command itself from its input.
 */
function wrapperRest(name, args) {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-') && args[i] !== '--'; i++) {
    if (name === 'xargs' && !XARGS_FLAGS.test(args[i])) return null;
    if (WRAPPER_VALUE_FLAGS[name].includes(args[i])) i++;
  }
  if (args[i] === '--') i++;
  if (name === 'timeout') i++;
  return args.slice(i);
}
/** The launcher scripts of package managers, run through node: yarn-4.1.0.cjs, npm-cli.js, pnpm.cjs, ... */
const LAUNCHER_RE = /^(yarn|npm|npx|pnpm|corepack|bun)([-.][A-Za-z0-9.-]*)?\.(cjs|mjs|js)$/;
const NOOPS = ['echo', 'printf', 'true', 'false', ':', 'exit'];
/**
 * Interpreter flags a pinned command may use: they change no code that runs. Anything else (-c, -e, -m,
 * -r, --require, --import, attached forms like -mpkg or -cCODE, ...) can load code that isn't pinned.
 */
const SAFE_FLAGS = {
  shell: /^[-+][euxvf]+$|^-o$|^(errexit|nounset|pipefail|xtrace)$|^--norc$|^--noprofile$/,
  node: /^--(no-warnings|enable-source-maps|no-deprecation|trace-warnings)$/,
  python: /^-[uBEsI]+$/,
  none: /(?!)/, // perl, ruby: no flag is safe
};
/** Directories whose programs are root-owned on a stock macOS/Linux host: pinned by path alone. */
const ROOT_BIN_DIRS = ['/bin', '/usr/bin'];
/**
 * Task runners and package managers (engsys#185). Each runs whatever a manifest in the working directory
 * says (package.json scripts, a Makefile, a justfile, build.gradle, ...), and those manifests, and the
 * files they name, are not among the files verify compares with GitHub: a local writer could change them
 * and have the hook run the change. So a command that invokes one can't be pinned, whichever way it is
 * spelled (bare, by absolute path, through env, sh -c, or as an argument of a wrapper such as xargs).
 * Fail closed; the escape is a direct committed script (fleet guide, "the pin checkout's .claude/").
 */
export const TASK_RUNNERS = [
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'deno', 'corepack', 'lerna', 'nx', 'turbo',
  'make', 'gmake', 'cmake', 'ninja', 'just', 'task', 'mage', 'rake', 'bundle', 'bundler', 'gradle', 'gradlew',
  'mvn', 'mvnw', 'ant', 'sbt', 'mix', 'tox', 'nox', 'invoke', 'fab', 'poetry', 'pipenv', 'pdm', 'hatch', 'uv', 'uvx',
  'cargo', 'composer', 'pre-commit', 'lefthook', 'husky',
];
/** The task runner a command word names (by its file name, whatever its directory), or ''. */
const taskRunnerOf = (word) => {
  const base = path.basename(String(word)).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  return TASK_RUNNERS.includes(base) ? base : '';
};
const runnerProblem = (name) => `a task runner (${name}) runs manifest code that isn't pinned; use a direct committed script`;

/**
 * Tokenize a command line. → { tokens: [{t:'word', v} | {t:'op', v}], problems }. Expands ~, $HOME and
 * $CLAUDE_PROJECT_DIR; anything else that the shell would expand is a problem.
 */
function lexCommand(cmd, { home, projectDir }) {
  const tokens = [];
  const problems = [];
  const s = String(cmd ?? '');
  let cur = '', inWord = false;
  const flush = () => { if (inWord) tokens.push({ t: 'word', v: cur }); cur = ''; inWord = false; };
  const expand = (i) => { // at s[i] === '$' outside single quotes → [replacement, next index] or null
    const m = /^\$(?:\{(HOME|CLAUDE_PROJECT_DIR)\}|(HOME|CLAUDE_PROJECT_DIR)(?![A-Za-z0-9_]))/.exec(s.slice(i));
    if (!m) return null;
    const name = m[1] || m[2];
    if (name === 'CLAUDE_PROJECT_DIR' && !projectDir) return null;
    return [name === 'HOME' ? home : path.resolve(projectDir), i + m[0].length];
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) { problems.push('an unterminated quote'); break; }
      cur += s.slice(i + 1, j); inWord = true; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; inWord = true;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { cur += s[++j]; continue; }
        if (s[j] === '`') { problems.push('command substitution'); continue; }
        if (s[j] === '$') {
          const e = expand(j);
          if (!e) { problems.push(`an expansion other than ~, $HOME or $CLAUDE_PROJECT_DIR (${s.slice(j, j + 24)})`); continue; }
          cur += e[0]; j = e[1] - 1; continue;
        }
        cur += s[j];
      }
      if (j >= s.length) { problems.push('an unterminated quote'); break; }
      i = j + 1; continue;
    }
    if (c === '\\') { if (i + 1 < s.length && s[i + 1] !== '\n') cur += s[i + 1]; inWord = true; i += 2; continue; }
    if (c === '$') {
      const e = expand(i);
      if (!e) { problems.push(`an expansion other than ~, $HOME or $CLAUDE_PROJECT_DIR (${s.slice(i, i + 24)})`); i++; continue; }
      cur += e[0]; inWord = true; i = e[1]; continue;
    }
    if (c === '`') { problems.push('command substitution'); i++; continue; }
    if (c === '~' && !inWord) {
      if (i + 1 >= s.length || /[\s/;|&]/.test(s[i + 1])) { cur += home; inWord = true; i++; continue; }
      problems.push('a ~user path'); i++; continue;
    }
    if ('*?['.includes(c)) { problems.push(`a glob (${c})`); cur += c; inWord = true; i++; continue; }
    if (c === '{' || c === '}') { problems.push('brace expansion'); cur += c; inWord = true; i++; continue; }
    if (c === '(' || c === ')') { problems.push('a subshell'); i++; continue; }
    if (c === '<') { problems.push('an input redirect (<)'); i++; continue; }
    if (c === '>') {
      // an output redirect, optionally after an fd number: only to /dev/null or another fd
      if (inWord && /^\d+$/.test(cur)) { cur = ''; inWord = false; }
      flush();
      let j = i + 1;
      if (s[j] === '>') j++;
      if (s[j] === '&') {
        const m = /^&\d+/.exec(s.slice(j));
        if (!m) { problems.push('an output redirect that is not to /dev/null'); i = j + 1; continue; }
        i = j + m[0].length; continue;
      }
      while (j < s.length && /[ \t]/.test(s[j])) j++;
      if (s.slice(j, j + 9) === '/dev/null' && (j + 9 >= s.length || /[\s;|&]/.test(s[j + 9]))) { i = j + 9; continue; }
      problems.push('an output redirect that is not to /dev/null'); i = j; continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      flush();
      let v = c;
      if ((c === '|' || c === '&') && s[i + 1] === c) v += c;
      tokens.push({ t: 'op', v }); i += v.length; continue;
    }
    if (/\s/.test(c)) { flush(); i++; continue; }
    cur += c; inWord = true; i++;
  }
  flush();
  return { tokens, problems };
}

/** lstat a path → 'file' | 'dir' | 'symlink' | 'other' | 'missing' */
function kindOf(abs) {
  try {
    const st = fs.lstatSync(abs);
    return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch { return 'missing'; }
}

/**
 * Parse one settings command strictly (section header above). → { programs: [abs system binary paths],
 * files: [abs regular files it runs or names], problems: [reasons] }. A command with any problem can't
 * be pinned.
 */
export function parseSettingsCommand(command, { home = os.homedir(), projectDir = '', depth = 0 } = {}) {
  const programs = [];
  const files = [];
  const lx = lexCommand(command, { home, projectDir });
  const problems = [...lx.problems];
  const fileArg = (w, what) => {
    if (!path.isAbsolute(w)) { problems.push(`${what} is not an absolute path: ${w}`); return; }
    const k = kindOf(w);
    if (k === 'file') files.push(path.normalize(w));
    else problems.push(`${what} is not a regular file (${k}): ${w}`);
  };
  const resolveBin = (name) => {
    for (const d of SYSTEM_BIN_DIRS) {
      const p = path.join(d, name);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return null;
  };
  const underSystem = (abs) => SYSTEM_BIN_DIRS.some((d) => abs.startsWith(`${d}/`));
  const runInterpreter = (name, args) => {
    let i = 0;
    for (; i < args.length && args[i].startsWith('-'); i++) {
      if (SHELLS.includes(name) && args[i] === '-c') {
        if (depth >= 1) { problems.push(`${name} -c nested more than once`); return; }
        if (i + 1 >= args.length) { problems.push(`${name} -c without a command`); return; }
        const sub = parseSettingsCommand(args[i + 1], { home, projectDir, depth: depth + 1 });
        programs.push(...sub.programs); files.push(...sub.files); problems.push(...sub.problems);
        for (const a of args.slice(i + 2)) if (a.includes('/')) fileArg(a, 'an argument');
        return;
      }
      const fam = SHELLS.includes(name) ? 'shell' : name === 'node' ? 'node' : name.startsWith('python') ? 'python' : 'none';
      if (SHELLS.includes(name) && args[i] === '-o' && i + 1 < args.length) { i++; continue; }
      if (!SAFE_FLAGS[fam].test(args[i])) { problems.push(`${name} ${args[i]} can load code that can't be pinned`); return; }
    }
    if (i >= args.length) { problems.push(`${name} with no script file`); return; }
    // a package manager's own launcher or a runner wrapper script is a task runner however it is reached
    if (taskRunnerOf(args[i]) || LAUNCHER_RE.test(path.basename(args[i]))) { problems.push(runnerProblem(path.basename(args[i]))); return; }
    fileArg(args[i], `the ${name} script`);
    for (const a of args.slice(i + 1)) if (!a.startsWith('-') && a.includes('/')) fileArg(a, 'an argument');
  };
  const simple = (words) => {
    if (!words.length) return;
    let [prog, ...args] = words;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prog)) { problems.push(`an environment assignment (${prog.split('=')[0]}=)`); return; }
    if (NOOPS.includes(prog)) return;
    if (taskRunnerOf(prog)) { problems.push(runnerProblem(taskRunnerOf(prog))); return; }
    if (path.isAbsolute(prog)) {
      const k = kindOf(prog);
      let real = prog;
      try { real = fs.realpathSync(prog); } catch { /* keep */ }
      const base = path.basename(prog);
      const pathOnly = (isInterp(base) || base === 'env')
        ? underSystem(prog) && underSystem(real)
        : ROOT_BIN_DIRS.some((d) => prog.startsWith(`${d}/`)) && ROOT_BIN_DIRS.some((d) => real.startsWith(`${d}/`));
      if (pathOnly && (k === 'file' || k === 'symlink')) {
        programs.push(prog);
        if (base === 'env') {
          if (!args.length || args[0].startsWith('-') || args[0].includes('=')) { problems.push('env with options or assignments'); return; }
          [prog, ...args] = args;
          if (taskRunnerOf(prog)) { problems.push(runnerProblem(taskRunnerOf(prog))); return; }
          if (!isInterp(prog)) { problems.push(`env runs a program that is not an interpreter: ${prog}`); return; }
          const p = resolveBin(prog);
          if (!p) { problems.push(`interpreter ${prog} not found in ${SYSTEM_BIN_DIRS.join(', ')}`); return; }
          programs.push(p);
          runInterpreter(prog, args);
        } else if (isInterp(base)) runInterpreter(base, args);
        else if (WRAPPERS.includes(base)) { // the wrapped command passes the same rules
          const rest = wrapperRest(base, args);
          if (rest === null) problems.push(`${base} with an option that reads or builds its command from outside the hook (${args.find((a) => a.startsWith('-a') || a.startsWith('-J')) || 'see the allowed xargs options'})`);
          else if (!rest.length) problems.push(`${base} without a command of its own: a wrapper may only run the command the hook names`);
          else simple(rest);
        }
        else if (SAFE_PROGRAMS.includes(base)) {
          for (const a of args) if (!a.startsWith('-') && a.includes('/')) fileArg(a, 'an argument');
        } else problems.push(`${prog} is not on the list of system programs that can't run code from their arguments (${SAFE_PROGRAMS.join(', ')}) or a wrapper`);
        return;
      }
      fileArg(prog, 'the program');
      for (const a of args) if (!a.startsWith('-') && a.includes('/')) fileArg(a, 'an argument');
      return;
    }
    if (prog.includes('/')) { problems.push(`the program is not an absolute path: ${prog}`); return; }
    if (!isInterp(prog)) { problems.push(`a program found on PATH that is not an interpreter: ${prog}`); return; }
    const p = resolveBin(prog);
    if (!p) { problems.push(`interpreter ${prog} not found in ${SYSTEM_BIN_DIRS.join(', ')}`); return; }
    programs.push(p);
    runInterpreter(prog, args);
  };
  let words = [];
  for (const tk of lx.tokens) {
    if (tk.t === 'op') { simple(words); words = []; } else words.push(tk.v);
  }
  simple(words);
  return { programs: [...new Set(programs)], files: [...new Set(files)], problems: [...new Set(problems)] };
}

/**
 * The content hash an operator allowlists (VERIFY_ALLOWED_USER_HOOKS) for one user-scope command: sha256
 * over the command text, the path of every interpreter it uses and the content of every file it runs or
 * names (parseSettingsCommand). → { hash, problems }: a command that can't be pinned is a problem
 * whatever the allowlist says. Any change to the command or a file it runs changes the hash.
 */
export function userCommandHash(command, { home = os.homedir(), projectDir = '' } = {}) {
  const p = parseSettingsCommand(command, { home, projectDir });
  const h = crypto.createHash('sha256').update(`engsys-user-command-v2\0${command}\0`);
  for (const b of [...p.programs].sort()) h.update(`bin\0${b}\0`);
  for (const f of [...p.files].sort()) h.update(`file\0${f}\0${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}\0`);
  return { hash: h.digest('hex'), problems: p.problems };
}

/** What to do about claude.ai-synced skills in a fleet config dir (engsys#201). */
const SYNCED_HINT = 'synced skills are not trusted by source or by manifest; set syncClaudeAiSkills and syncClaudeAiPlugins to false in the dir\'s settings.json and delete its skills/synced/';
/** Top-level settings keys that pick, limit or redirect the session's model (Claude Code 2.1.292). */
export const MODEL_SETTINGS_TOP_KEYS = ['model', 'availableModels', 'fallbackModel', 'advisorModel', 'modelOverrides', 'deniedModels', 'enforceAvailableModels'];

/** Parse VERIFY_ALLOWED_USER_FILES: space-separated sha256 digests (userConfigItems). → Set */
export const parseAllowedFiles = parseAllowedHooks;

/** User-scope directories whose files Claude Code loads into every session (agents, commands, skills, rules). */
export const USER_CONFIG_DIRS = ['agents', 'commands', 'skills', 'rules'];

const canonicalJson = (v) => (Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
    : JSON.stringify(v));

/**
 * The user-scope configuration a fleet session loads besides settings, with the hash an operator
 * allowlists for each (VERIFY_ALLOWED_USER_FILES). → { items: [{ what, hash }], problems }
 *   - every file under <configDir>/{agents,commands,skills,rules} and <configDir>/CLAUDE.md: sha256 over
 *     its path relative to the config dir and its content (symlinks followed once, loops refused);
 *   - every MCP server definition: `mcpServers` in the user state file (claudeJson: <configDir>/.claude.json
 *     with a fleet config dir, else ~/.claude.json), its `projects[<projectDir>].mcpServers`, and
 *     `mcpServers` in <configDir>/settings*.json: sha256 over the server name and its canonical JSON.
 * Plugin caches (<configDir>/plugins/) are not here: fleet verify and fleet sync pin those.
 */
export function userConfigItems({ configDir, claudeJson = '', projectDir = '' }) {
  const items = [];
  const problems = [];
  const fileHash = (rel, buf) => crypto.createHash('sha256').update(`engsys-user-file-v1\0${rel}\0`).update(buf).digest('hex');
  const seen = new Set();
  const walk = (abs, rel, depth) => {
    let st;
    try { st = fs.statSync(abs); } catch { problems.push(`user-cfg   ${abs} is a dangling link or unreadable`); return; }
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* keep */ }
    if (st.isDirectory()) {
      if (seen.has(real) || depth > 12) { problems.push(`user-cfg   ${abs} is a directory loop`); return; }
      seen.add(real);
      for (const e of fs.readdirSync(abs).sort()) { if (e !== '.DS_Store') walk(path.join(abs, e), `${rel}/${e}`, depth + 1); }
    } else if (st.isFile()) items.push({ what: `${path.join(configDir, rel)}`, hash: fileHash(rel, fs.readFileSync(abs)) });
    else problems.push(`user-cfg   ${abs} is not a regular file`);
  };
  for (const d of USER_CONFIG_DIRS) {
    const abs = path.join(configDir, d);
    try { fs.lstatSync(abs); } catch { continue; }
    walk(abs, d, 0);
  }
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
    const abs = path.join(configDir, name);
    try { fs.lstatSync(abs); } catch { continue; }
    walk(abs, name, 0);
  }
  const servers = (obj, where) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const name of Object.keys(obj).sort()) {
      items.push({ what: `MCP server ${name} (${where})`, hash: crypto.createHash('sha256').update(`engsys-user-mcp-v1\0${name}\0${canonicalJson(obj[name])}`).digest('hex') });
    }
  };
  const readJson = (f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      if (e && e.code !== 'ENOENT') problems.push(`user-cfg   ${f} is not valid JSON`);
      return null;
    }
  };
  if (claudeJson) {
    const j = readJson(claudeJson);
    if (j) {
      servers(j.mcpServers, claudeJson);
      if (projectDir && j.projects && typeof j.projects === 'object') {
        const want = new Set([path.resolve(projectDir)]);
        try { want.add(fs.realpathSync(projectDir)); } catch { /* keep */ }
        for (const [k, v] of Object.entries(j.projects)) if (want.has(k)) servers(v?.mcpServers, `${claudeJson} projects[${k}]`);
      }
    }
  }
  for (const f of ['settings.json', 'settings.local.json']) {
    const j = readJson(path.join(configDir, f));
    if (j) servers(j.mcpServers, path.join(configDir, f));
  }
  return { items, problems };
}

/**
 * Memory files Claude Code also loads from the directories above the project: any CLAUDE.md or
 * CLAUDE.local.md in a parent of projectDir, up to and including home (or / when the project is outside
 * home). → [absolute paths] (names matched case-insensitively)
 */
export function parentMemoryFiles(projectDir, home = os.homedir()) {
  const out = [];
  let dir = path.resolve(projectDir);
  const top = path.resolve(home);
  const underHome = dir === top || dir.startsWith(`${top}/`);
  while (true) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { entries = []; }
    for (const e of entries) if (MEMORY_NAMES.includes(fold(e))) out.push(path.join(dir, e));
    if (underHome && dir === top) break;
  }
  return out.sort();
}

/**
 * Check Claude Code settings files for hook/env/plugin/model overrides or pin drift (engsys#96 M3).
 * Inspects:
 *   - <projectDir>/.claude/settings.json: disableAllHooks, protected env keys, model keys; its hooks and
 *     commands count as verified only when projectVerified (verifyProjectTrust compared .claude/ and
 *     every command target with GitHub) or its blob matches pinSettingsSha;
 *   - <projectDir>/.claude/settings.local.json (untracked: hooks are a mismatch, other commands need the
 *     operator allowlist);
 *   - <userSettingsDir>/settings.json and settings.local.json (the fleet's CLAUDE_CONFIG_DIR, else
 *     ~/.claude). A user-scope plugin the project doesn't enable is a mismatch unless allowedUserPlugins
 *     (VERIFY_ALLOWED_USER_PLUGINS) lists it; a user-scope hook or command is a mismatch unless its
 *     userCommandHash is in allowedUserHooks (VERIFY_ALLOWED_USER_HOOKS). Listed ones are `allowed` info.
 * → { problems: [...], info: [...] }
 */
export function checkSettingsDetailed({
  projectDir, userSettingsDir = '', pinSettingsSha = '', projectVerified = false,
  allowedUserPlugins = new Set(), allowedUserHooks = new Set(), home = os.homedir(),
  claudeJson = '', allowedUserFiles = null, fleetConfigDir = false,
}) {
  const problems = [];
  const info = [];
  const warnings = [];
  const allowed = allowedUserPlugins instanceof Set ? allowedUserPlugins : parseAllowedPlugins(allowedUserPlugins);
  const allowedHooks = allowedUserHooks instanceof Set ? allowedUserHooks : parseAllowedHooks(allowedUserHooks);
  const common = (f, cfg) => {
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const k of Object.keys(cfg.env).sort()) {
        if (isProtectedEnvKey(k)) problems.push(`settings   ${f} overrides protected env ${k}`);
      }
    }
    for (const k of MODEL_SETTINGS_TOP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) problems.push(`settings   ${f} sets ${k} (the fleet pins models per session)`);
    }
    if (cfg.switchModelsOnFlag === true) problems.push(`settings   ${f} sets switchModelsOnFlag (the fleet pins models per session)`);
    if (cfg.disableAllHooks === true) problems.push(`settings   ${f} sets disableAllHooks: true`);
  };
  const allowlisted = (f, where, command) => {
    const { hash, problems: unpinned } = userCommandHash(command, { home, projectDir });
    const label = where === 'hook' ? 'a hook' : `${where}`;
    if (unpinned.length) problems.push(`settings   ${f} ${label} runs a command with an expansion that can't be pinned (${unpinned[0]})`);
    else if (allowedHooks.has(hash)) info.push(`allowed    ${f} ${label} ${hash} (VERIFY_ALLOWED_USER_HOOKS)`);
    else problems.push(`settings   ${f} ${label} runs a command not on VERIFY_ALLOWED_USER_HOOKS (sha256 ${hash})`);
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
          if (!pinSettingsSha && !projectVerified) {
            if (pinCfg.hooks !== undefined) problems.push(`settings   ${pinFile} defines hooks (unverified against origin)`);
            for (const c of settingsCommands(pinCfg)) {
              if (c.where !== 'hook') problems.push(`settings   ${pinFile} sets ${c.where} (unverified against origin)`);
            }
          }
          common(pinFile, pinCfg);
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
    if (cfg.allowManagedHooksOnly === true) {
      problems.push(`settings   ${f} sets allowManagedHooksOnly: true`);
    }
    common(f, cfg);
    for (const c of settingsCommands(cfg)) {
      // The project's untracked local overlay never carries hooks; its other commands, and every
      // user-scope command, run only when the operator allowlisted their exact content.
      if (!user && c.where === 'hook') continue;
      allowlisted(f, c.where, c.command);
    }
    if (!user && cfg.hooks !== undefined) problems.push(`settings   ${f} defines hooks`);
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
  // A fleet config dir must have Claude Code's claude.ai sync switched off (engsys#201; `fleet config-dir init` and
  // `fleet sync` set it, engsys#200): synced skills and plugins change with no host-side action and their content has
  // no root of trust here, so the dir should never receive them. Only `false` is honoured by Claude Code. A warning:
  // what did sync in is judged below, the switch only says whether more will arrive.
  if (userSettingsDir && fleetConfigDir) {
    let us = null;
    try { us = JSON.parse(fs.readFileSync(path.join(userSettingsDir, 'settings.json'), 'utf8')); } catch { us = null; }
    const off = (k) => us && typeof us === 'object' && us[k] === false;
    const on = ['syncClaudeAiSkills', 'syncClaudeAiPlugins'].filter((k) => !off(k));
    if (on.length) {
      warnings.push(`${path.join(userSettingsDir, 'settings.json')} does not set ${on.join(' and ')} to false, so Claude Code may sync claude.ai skills or plugins into this fleet config dir; run: fleet config-dir init (it retrofits an existing dir), or fleet sync`);
    }
  }
  // User-scope configuration loaded besides settings (agents, commands, skills, rules, memory, MCP
  // servers): each must be on VERIFY_ALLOWED_USER_FILES. Checked when allowedUserFiles is passed.
  if (userSettingsDir && allowedUserFiles) {
    const allowedF = allowedUserFiles instanceof Set ? allowedUserFiles : parseAllowedFiles(allowedUserFiles);
    const uc = userConfigItems({ configDir: userSettingsDir, claudeJson, projectDir });
    problems.push(...uc.problems);
    // Files claude.ai synced into <dir>/skills/synced/<bucket>/ are reported once per bucket, not once per file. Nothing is
    // trusted by being there: the bucket id, its marker and its manifest.json are files a session can write too, and the
    // manifest has no content hashes. Each file is still a problem unless its own sha256 is on the allowlist.
    const syncedRoot = path.join(userSettingsDir, 'skills', 'synced') + path.sep;
    const buckets = new Map();
    for (const it of uc.items) {
      if (allowedF.has(it.hash)) { info.push(`allowed    ${it.what} ${it.hash} (VERIFY_ALLOWED_USER_FILES)`); continue; }
      const rel = it.what.startsWith(syncedRoot) ? it.what.slice(syncedRoot.length) : null;
      // <bucket>/..., or the .bucket-<bucket> marker beside it; any other loose file under synced/ keeps its own line
      const b = rel === null ? null : rel.includes(path.sep) ? rel.split(path.sep)[0] : /^\.bucket-[^.].*$/.test(rel) ? rel.slice('.bucket-'.length) : null;
      if (b !== null) buckets.set(b, (buckets.get(b) || 0) + 1);
      else problems.push(`user-cfg   ${it.what} is not on VERIFY_ALLOWED_USER_FILES (sha256 ${it.hash})`);
    }
    for (const [b, n] of [...buckets].sort()) {
      problems.push(`user-cfg   ${path.join(syncedRoot, b)} holds ${n} synced claude.ai skill file(s) not on VERIFY_ALLOWED_USER_FILES (${SYNCED_HINT})`);
    }
  }
  if (allowedUserFiles) {
    for (const f of parentMemoryFiles(projectDir, home)) problems.push(`memory     ${f} is loaded into every session above the pin checkout; remove it`);
  }
  return { problems: [...new Set(problems)], info: [...new Set(info)], warnings: [...new Set(warnings)] };
}

/** The keys the session launcher writes into its messaging settings file (launch-agent-sessions.sh). */
export const MESSAGING_SETTINGS_KEYS = ['crossSessionInbound'];
/**
 * The launcher's messaging settings (`--settings` on every session, the monsters included): it may hold
 * only the keys the launcher writes. → problems (an absent file is fine: the launcher creates it)
 */
export function checkMessagingSettings(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e && e.code === 'ENOENT' ? [] : [`settings   ${file} cannot be stat'd`]; }
  if (st.isSymbolicLink() || !st.isFile()) return [`settings   ${file} is not a regular file`];
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return [`settings   ${file} is not valid JSON`]; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return [`settings   ${file} is not a JSON object`];
  return Object.keys(cfg).filter((k) => !MESSAGING_SETTINGS_KEYS.includes(k)).sort()
    .map((k) => `settings   ${file} sets ${k} (the launcher's messaging settings may hold only ${MESSAGING_SETTINGS_KEYS.join(', ')})`);
}

/** checkSettingsDetailed's problems only (the original API). */
export function checkSettings(opts) {
  return checkSettingsDetailed(opts).problems;
}

// --- Project settings, hooks and memory files (the pin checkout) -----------------------------------
// Claude Code loads PIN_DIR/.claude/ (settings.json, its hooks, agents, commands, skills), every
// CLAUDE.md / CLAUDE.local.md in the tree and .mcp.json into fleet sessions, and a settings command runs
// whatever script it names. The trust root is the pin repo's default branch as GitHub reports it,
// never a local ref (origin/HEAD and refs/remotes/* can be repointed by anything that runs as this user):
//   1. the default branch's tip SHA, from the API;
//   2. PIN_DIR's HEAD must be that tip or an ancestor of it: compare/<tip>...<HEAD> is `identical` or
//      `behind`. `ahead`, `diverged`, or a commit GitHub doesn't have is a mismatch;
//   3. every auto-loaded file on disk (.claude/**, CLAUDE.md files, .mcp.json, what a tracked symlink
//      among them points at, every settings-command target) must be a blob of HEAD's tree (from the
//      API) with the same content, and every such blob of HEAD must be on disk. Claude Code's own
//      runtime state is skipped (PROJECT_RUNTIME_EXEMPT: an explicit list, matched case-folded). Git
//      ignore rules never exempt a file: a session can write .git/info/exclude;
//   4. when HEAD is behind, every one of those paths must also be identical at the tip (a reviewed
//      but superseded hook or memory file is a mismatch); a lag in other code is only a warning.

/**
 * Paths under .claude/ that Claude Code itself writes and never loads as configuration: an explicit
 * list, matched case-folded. Ignore rules (.gitignore, .git/info/exclude) never exempt anything: a
 * session can write them. Memory files and .claude/{commands,agents,skills,rules,hooks} are never on it.
 * (.claude/scheduled_tasks.json is not exempt either: it carries prompts; see SCHEDULED_TASKS.)
 */
export const PROJECT_RUNTIME_EXEMPT = {
  files: ['.claude/settings.local.json', '.claude/scheduled_tasks.lock', '.claude/agent-registry.json',
    '.claude/first-run', '.claude/assistant-daemon-state.json', '.claude/agent-memory-local'],
  dirs: ['.claude/worktrees/', '.claude/checkpoints/', '.claude/mailbox/', '.claude/routines/.state/',
    '.claude/agent-memory-local/'],
};
/** Claude Code's scheduled tasks: prompts it runs on its own. Present and non-empty, it needs the operator allowlist. */
export const SCHEDULED_TASKS = '.claude/scheduled_tasks.json';
const NEVER_EXEMPT_RE = /^\.claude\/(commands|agents|skills|rules|hooks)\//;
/** Memory files Claude Code loads from any directory, and the project MCP config at the root. */
const MEMORY_NAMES = ['claude.md', 'claude.local.md'];
const MCP_FILE = '.mcp.json';
/** Directories never walked for memory files (dependency trees and git's own). */
const MEMORY_SKIP_DIRS = ['node_modules', '.git'];

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
 * The repo files a project settings command runs or names. → { targets: [repo-relative posix path],
 * problems: [] }. Parsed strictly (parseSettingsCommand): every file must be an absolute path (after
 * $CLAUDE_PROJECT_DIR) to a regular file inside projectDir; system interpreters are fine. Anything
 * that can't be pinned is a problem. Not covered: what a script itself imports or sources.
 */
export function hookTargets(command, projectDir, { home = os.homedir() } = {}) {
  const root = path.resolve(projectDir);
  const p = parseSettingsCommand(command, { home, projectDir: root });
  const problems = p.problems.map((r) => `hook       settings.json command can't be pinned (${r}): ${command}`);
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  const targets = [];
  for (const f of p.files) {
    let rel = path.relative(root, f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.relative(realRoot, f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { problems.push(`hook       settings.json hook command runs ${f}, outside the repo`); continue; }
    targets.push(rel.split(path.sep).join('/'));
  }
  return { targets: [...new Set(targets)], problems };
}

/** APFS and HFS+ compare names case-insensitively and normalize Unicode: so does the exempt list. */
const fold = (p) => String(p).normalize('NFC').toLowerCase();
export function isExempt(rel) {
  const r = fold(rel);
  if (NEVER_EXEMPT_RE.test(r) || MEMORY_NAMES.includes(r.split('/').pop())) {
    // memory files are exempt only inside .claude/worktrees/ (other checkouts, never loaded from here)
    return r.startsWith('.claude/worktrees/');
  }
  return PROJECT_RUNTIME_EXEMPT.files.includes(r) || PROJECT_RUNTIME_EXEMPT.dirs.some((d) => r.startsWith(d));
}
/** Is a repo path one of the files Claude Code loads on its own (memory files, .mcp.json, .claude/**)? */
export function isAutoLoaded(rel) {
  if (isExempt(rel)) return false;
  const r = fold(rel);
  if (r.startsWith('.claude/') || r === fold(MCP_FILE)) return true;
  if (r.split('/').some((seg) => MEMORY_SKIP_DIRS.includes(seg))) return false;
  return MEMORY_NAMES.includes(r.split('/').pop());
}

/**
 * What the pin checkout has on disk: HEAD, every auto-loaded file (.claude/**, CLAUDE.md files, .mcp.json;
 * exempt paths aside), what a symlink among them points at, and each settings-command target.
 * → { head, files: {rel: sha|'symlink:<sha>'|'not-a-file'}, links, linked, targets, problems }
 */
export function projectLocalState(projectDir, { git = hermeticGit } = {}) {
  const problems = [];
  const root = path.resolve(projectDir);
  let head = '';
  try { head = git(root, ['--no-replace-objects', 'rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); } catch { head = ''; }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Unverified(`can't read HEAD of the pin checkout ${root}`);
  const files = {};
  const links = {}; // a symlink among the auto-loaded files → the repo path it points at, or 'outside'
  const linked = {}; // the files under each such target: {rel: sha | 'not-a-file' | 'missing'}
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  const inRepo = (abs) => {
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* lexical */ }
    const r = path.relative(realRoot, real);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null;
  };
  // Files under a path, no symlinks followed: what a symlinked auto-loaded entry brings in.
  const walk = (abs, rel, out) => {
    let st2 = null;
    try { st2 = fs.lstatSync(abs); } catch { st2 = null; }
    if (!st2) { out[rel] = 'missing'; return; }
    if (st2.isSymbolicLink()) { out[rel] = 'not-a-file'; return; }
    if (st2.isFile()) { out[rel] = blobSha(fs.readFileSync(abs)); return; }
    if (!st2.isDirectory()) { out[rel] = 'not-a-file'; return; }
    for (const e of fs.readdirSync(abs)) { if (e !== '.DS_Store') walk(path.join(abs, e), `${rel}/${e}`, out); }
  };
  const record = (abs, rel, e) => {
    if (e.isFile()) files[rel] = blobSha(fs.readFileSync(abs));
    else if (e.isSymbolicLink()) {
      // A tracked symlink (git stores its target as the blob): compared with HEAD like any file, and
      // what it points at must be in the repo and match HEAD too.
      const to = fs.readlinkSync(abs);
      files[rel] = `symlink:${blobSha(to)}`;
      const target = inRepo(path.resolve(path.dirname(abs), to));
      if (!target) links[rel] = 'outside';
      else {
        links[rel] = target;
        if (!isAutoLoaded(target)) walk(path.join(root, target), target, linked);
      }
    } else files[rel] = 'not-a-file';
  };
  // One walk of the checkout: everything under .claude/, and memory files anywhere else.
  const visit = (absDir, relDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      const inClaude = fold(rel).startsWith('.claude/') || fold(rel) === '.claude';
      if (e.isDirectory()) {
        // only .claude/worktrees/ (other checkouts) is not walked: in any other exempt dir a memory file still counts
        if (fold(`${rel}/`).startsWith('.claude/worktrees/')) continue;
        if (!inClaude && MEMORY_SKIP_DIRS.includes(e.name)) continue;
        visit(abs, rel);
      } else if (fold(rel) === '.claude') {
        files['.claude/'] = 'not-a-file';
      } else if (isAutoLoaded(rel)) {
        record(abs, rel, e);
      }
    }
  };
  visit(root, '');
  const targets = {};
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')); } catch { cfg = null; }
  for (const { command } of settingsCommands(cfg)) {
    const t = hookTargets(command, root);
    problems.push(...t.problems);
    for (const rel of t.targets) {
      const abs = path.join(root, rel);
      let s2 = null;
      try { s2 = fs.lstatSync(abs); } catch { s2 = null; }
      if (!s2) { targets[rel] = 'missing'; continue; }
      if (s2.isSymbolicLink() || !s2.isFile()) { targets[rel] = 'not-a-file'; continue; }
      if (!inRepo(abs)) { targets[rel] = 'outside'; continue; }
      targets[rel] = blobSha(fs.readFileSync(abs));
    }
  }
  // The scheduled-task file is judged on its own (it carries prompts): absent or empty passes; otherwise
  // the operator allowlists its content (VERIFY_ALLOWED_USER_FILES).
  let scheduledTasks = null;
  for (const k of Object.keys(files)) {
    if (fold(k) !== SCHEDULED_TASKS) continue;
    const buf = files[k] === 'not-a-file' ? null : fs.readFileSync(path.join(root, k));
    delete files[k];
    if (buf === null) { scheduledTasks = { rel: k, empty: false, hash: 'not-a-file' }; continue; }
    const txt = buf.toString('utf8').trim();
    let empty = txt === '';
    if (!empty) { try { const j = JSON.parse(txt); empty = (Array.isArray(j) && !j.length) || (j && typeof j === 'object' && !Array.isArray(j) && !Object.keys(j).length) || (Array.isArray(j?.tasks) && !j.tasks.length && Object.keys(j).length === 1); } catch { /* not empty */ } }
    scheduledTasks = { rel: k, empty, hash: crypto.createHash('sha256').update(`engsys-user-file-v1\0${k}\0`).update(buf).digest('hex') };
  }
  return { head, files, links, linked, targets, scheduledTasks, problems: [...new Set(problems)] };
}

/** A commit's whole tree from the API. → Map<path, {sha, mode}> of its blobs (a truncated tree is "not verified") */
async function commitBlobs(api, repo, sha) {
  const commit = await api(`repos/${repo}/git/commits/${sha}`);
  const treeSha = commit?.tree?.sha;
  if (!/^[0-9a-f]{40}$/.test(treeSha || '')) throw new Unverified(`can't read the tree of ${repo}@${sha.slice(0, 12)}`);
  const out = new Map();
  for (const e of parseTreeEntries(await api(`repos/${repo}/git/trees/${treeSha}?recursive=1`))) {
    if (e.type === 'blob' && !e.path.endsWith('.DS_Store')) out.set(e.path, { sha: e.sha, mode: e.mode });
  }
  return out;
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
  if (status !== 'identical' && status !== 'behind') {
    problems.push(`pin-head   ${repo} checkout HEAD ${local.head} is not ${defaultBranch} or an ancestor of it (${tip.slice(0, 12)}; compare: ${status || 'no status'})`);
    return { problems, warnings, tip, defaultBranch };
  }
  const want = await commitBlobs(api, repo, local.head);
  const checked = new Set(); // every path whose content a session loads: HEAD's must equal the tip's

  if (local.files['.claude/'] === 'not-a-file') problems.push('claude-dir .claude is not a directory');
  for (const [rel] of want) {
    if (!isAutoLoaded(rel) || fold(rel) === SCHEDULED_TASKS) continue;
    checked.add(rel);
    if (!(rel in local.files)) problems.push(`missing    ${rel} (tracked at HEAD)`);
  }
  for (const [rel, have] of Object.entries(local.files)) {
    if (rel === '.claude/') continue;
    const w = want.get(rel);
    checked.add(rel);
    if (have === 'not-a-file') problems.push(`not-a-file ${rel}`);
    else if (!w) problems.push(`untracked  ${rel} (not in HEAD)`);
    else if (have.startsWith('symlink:')) {
      if (w.mode !== '120000' || `symlink:${w.sha}` !== have) problems.push(`modified   ${rel} (a symlink that differs from HEAD)`);
    } else if (w.mode === '120000') problems.push(`not-a-file ${rel} (a symlink at HEAD)`);
    else if (w.sha !== have) problems.push(`modified   ${rel} ${have}`);
  }
  // What tracked symlinks among them point at: inside the repo, and matching HEAD there too.
  for (const [rel, t] of Object.entries(local.links || {})) {
    if (t === 'outside') problems.push(`not-a-file ${rel} (a symlink that points outside the repo)`);
  }
  const linkRoots = [...new Set(Object.values(local.links || {}).filter((t) => t !== 'outside' && !isAutoLoaded(t)))];
  for (const t of linkRoots) {
    const under = (p) => p === t || p.startsWith(`${t}/`);
    const haveT = Object.fromEntries(Object.entries(local.linked || {}).filter(([p]) => under(p)));
    const wantT = [...want].filter(([p]) => under(p));
    for (const [p] of wantT) { checked.add(p); if (!(p in haveT)) problems.push(`missing    ${p} (tracked at HEAD, linked from .claude/)`); }
    for (const [p, have] of Object.entries(haveT)) {
      checked.add(p);
      const w = want.get(p);
      if (have === 'missing') { if (!wantT.length) problems.push(`missing    ${p} (linked from .claude/, not at HEAD)`); }
      else if (have === 'not-a-file') problems.push(`not-a-file ${p} (linked from .claude/)`);
      else if (!w) problems.push(`untracked  ${p} (linked from .claude/, not in HEAD)`);
      else if (w.mode === '120000' || w.sha !== have) problems.push(`modified   ${p} ${have} (linked from .claude/)`);
    }
  }
  for (const [rel, have] of Object.entries(local.targets)) {
    checked.add(rel);
    if (have === 'missing') { problems.push(`hook       settings.json hook target ${rel} is missing`); continue; }
    if (have === 'not-a-file') { problems.push(`hook       settings.json hook target ${rel} is not a regular file`); continue; }
    if (have === 'outside') { problems.push(`hook       settings.json hook target ${rel} resolves outside the repo`); continue; }
    const w = want.get(rel);
    if (!w) problems.push(`hook       settings.json hook target ${rel} is not tracked at HEAD`);
    else if (w.mode === '120000' || w.sha !== have) problems.push(`hook       settings.json hook target ${rel} differs from HEAD (${have})`);
  }

  if (status === 'behind') {
    // An older reviewed commit is fine for ordinary code, never for what a session loads.
    const atTip = await commitBlobs(api, repo, tip);
    for (const [p] of atTip) if (isAutoLoaded(p)) checked.add(p);
    const stale = [...checked].filter((p) => {
      const a = want.get(p); const b = atTip.get(p);
      return (a?.sha ?? null) !== (b?.sha ?? null) || (a?.mode ?? null) !== (b?.mode ?? null);
    }).sort();
    for (const p of stale) problems.push(`stale      ${p} differs from ${defaultBranch} (${tip.slice(0, 12)}); run fleet sync`);
    if (!stale.length) warnings.push(`pin checkout behind ${defaultBranch}: HEAD ${local.head.slice(0, 12)} is an ancestor of ${tip.slice(0, 12)} (no auto-loaded file differs); run fleet sync`);
  }
  return { problems: [...new Set(problems)], warnings, tip, defaultBranch };
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
export function compare(tree, local, subdir = PLUGIN_SUBDIR) {
  const diffs = [];
  for (const [root, m] of Object.entries(local)) {
    for (const p of tree.keys()) {
      if (p.startsWith(`${subdir}/`) && !(p in m)) diffs.push({ root, path: p, kind: 'missing', have: '-' });
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

/**
 * Is an INSTANCE marketplace's release tag required to be on its repo's default branch (engsys#196)? The engsys
 * release always is (fetchRelease's `compare`, a MISMATCH otherwise). Instance fleets tag `release:` commits that sit
 * off the default branch (FeedFrwd/ff-engsys-fleet: v0.1.15 to v0.1.18 all diverge), so for now an off-main instance tag
 * is a WARNING (printed, and alerted at info level by verify.sh) and every other instance check still enforces: the file
 * hashes against the tag's tree, a non-tag pin, an unreadable source. Flip this to true, and nothing else, to make it a
 * MISMATCH like engsys (follow-up: eric-sabe/engsys#227).
 */
export const INSTANCE_OFF_MAIN_ENFORCED = false;

/** Where a marketplace lists its plugins, at the root of its repo. */
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
/** The placeholder directory a marketplace plugin's install is scanned under until its real source directory is known. */
const MARKET_SCAN = '@plugin';

/**
 * The repo directory a marketplace plugin is installed from (engsys#196): the `source` of its entry in the
 * marketplace file, read from the verified release (never from a local file), which must be a path inside
 * the repo. A plugin's install is a copy of that directory, so a repo path <subdir>/<p> lives at
 * <install path>/<p>. Anything else (an unlisted or duplicated plugin, a source that is not a `./` path, the
 * repo root, a path that climbs out) throws an Unverified: fail closed, never guess a directory.
 */
export function pluginSubdir(marketplaceJson, pluginName) {
  let m;
  try { m = JSON.parse(String(marketplaceJson)); } catch { throw new Unverified(`${MARKETPLACE_FILE} of the release is not JSON`); }
  const entries = Array.isArray(m?.plugins) ? m.plugins.filter((e) => e && e.name === pluginName) : [];
  if (entries.length !== 1) throw new Unverified(`${MARKETPLACE_FILE} of the release lists ${entries.length} plugins named ${pluginName}, not one`);
  const src = entries[0].source;
  if (typeof src !== 'string' || !src.startsWith('./')) throw new Unverified(`the release's source for ${pluginName} is not a ./ path inside its repo`);
  const dir = path.posix.normalize(src.slice(2)).replace(/\/+$/, '');
  if (!dir || dir === '.' || dir === '..' || dir.startsWith('../') || dir.startsWith('/')) {
    throw new Unverified(`the release's source for ${pluginName} (${src}) is the repo root or leaves the repo`);
  }
  return dir;
}

/** A blob's bytes through gh, checked against the sha the verified tree names. */
export async function fetchBlob({ repo, sha, gh = 'gh', timeoutMs = 30_000 }) {
  const b = await ghJson(gh, `repos/${repo}/git/blobs/${sha}`, timeoutMs);
  if (!b || b.encoding !== 'base64' || typeof b.content !== 'string') throw new Unverified(`GitHub returned an unreadable blob ${sha}`);
  const buf = Buffer.from(b.content, 'base64');
  if (blobSha(buf) !== sha) throw new Unverified(`the blob GitHub returned for ${sha} does not hash to it`);
  return buf;
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
  // 'wx': never write through a file or symlink someone else put at the temp name; the cache dir is one a session can write
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
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
    fleetConfigDir: false,
    userSettingsDir: '',
    pinSettingsSha: '',
    pinRepo: '',
    allowedUserPlugins: '',
    allowedUserHooks: '',
    allowedUserFiles: '',
    messagingSettings: '',
    claudeJson: '',
    checkUserConfig: false,
    marketPlugins: [],
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
      case '--fleet-config-dir': a.fleetConfigDir = true; break;
      case '--user-settings-dir': a.userSettingsDir = v(); a.checkSettings = true; break;
      case '--pin-settings-sha': a.pinSettingsSha = v(); a.checkSettings = true; break;
      case '--pin-repo': a.pinRepo = v(); a.checkSettings = true; break;
      case '--allowed-user-plugins': a.allowedUserPlugins = v(); break;
      case '--allowed-user-hooks': a.allowedUserHooks = v(); break;
      case '--allowed-user-files': a.allowedUserFiles = v(); break;
      case '--claude-json': a.claudeJson = v(); break;
      case '--messaging-settings': a.messagingSettings = v(); break;
      case '--check-user-config': a.checkUserConfig = true; break;
      case '--market-plugin': {
        const [id, repo, tag, ...extra] = v().split('|');
        if (extra.length || !ID_RE.test(id || '') || !REPO_RE.test(repo || '') || !tag || /\s/.test(tag)) throw new Error('--market-plugin must be <plugin>@<marketplace>|<owner/repo>|<ref>');
        a.marketPlugins.push({ id, repo, tag });
        break;
      }
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

/** Problem categories for the alert, in the order they are shown. */
const PROBLEM_GROUPS = [
  { key: 'plugin', label: 'engsys plugin or host kit', integrity: true },
  { key: 'pin', label: 'pin checkout', integrity: true },
  { key: 'plugins', label: 'unpinned user-scope plugins', userScope: true },
  { key: 'mcp', label: 'MCP servers', userScope: true },
  { key: 'files', label: 'user-scope skills/agents/files', userScope: true },
  { key: 'commands', label: 'user-scope hooks and commands', userScope: true },
  { key: 'settings', label: 'settings' },
  { key: 'memory', label: 'memory files above the pin checkout' },
];
function problemGroup(l) {
  if (/^user-cfg\s+MCP server /.test(l)) return 'mcp';
  if (/^user-cfg /.test(l)) return 'files';
  if (/^settings .* enables unpinned plugin /.test(l)) return 'plugins';
  if (/^settings .* (a hook|\S+) runs a command/.test(l)) return 'commands';
  if (/^settings /.test(l)) return 'settings';
  if (/^memory /.test(l)) return 'memory';
  if (/^(release|version|no-path|two-paths|disabled|shadowed) /.test(l)) return 'plugin';
  if (/^\S+\s+\//.test(l)) return 'plugin'; // an absolute path: the plugin cache or the host kit
  return 'pin';
}
/** → [{ label, count, userScope }] for the categories present */
export function groupProblems(lines) {
  const n = new Map();
  for (const l of lines) { const k = problemGroup(l); n.set(k, (n.get(k) || 0) + 1); }
  return PROBLEM_GROUPS.filter((g) => n.has(g.key)).map((g) => ({ label: g.label, count: n.get(g.key), userScope: Boolean(g.userScope) }));
}
/**
 * The alert latch's fingerprint: categories and counts, plus the exact paths (content hashes stripped) of
 * integrity problems (the plugin, the host kit, the pin checkout). A user-scope skill sync that rewrites
 * files then doesn't re-alert every tick; a newly tampered path always does.
 */
export function problemFingerprint(lines) {
  const parts = groupProblems(lines).map((g) => `${g.label}=${g.count}`);
  const integrity = new Set(PROBLEM_GROUPS.filter((g) => g.integrity).map((g) => g.key));
  for (const l of lines) if (integrity.has(problemGroup(l))) parts.push(l.replace(/\b[0-9a-f]{40,64}\b/g, '#'));
  // a synced-skills bucket: its path and file count, so a file planted into an already reported bucket re-alerts while a
  // content-only update (same files) does not (engsys#201)
  for (const l of lines) if (/synced claude\.ai skill file/.test(l)) parts.push(l.replace(/\(synced skills are not trusted.*$/, ''));
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

/** The CLI, with its effects injectable for tests. → exit code. */
export async function run(argv, {
  fetch = fetchRelease,
  blob = fetchBlob,
  instanceOffMainEnforced = INSTANCE_OFF_MAIN_ENFORCED,
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
    const groups = groupProblems(sorted);
    out(`summary: ${sorted.length} problems: ${groups.map((g) => `${g.label} (${g.count})`).join(', ')}`);
    if (groups.some((g) => g.userScope)) out('hint: set up a separate fleet config dir: fleet config-dir init (see fleet guide § 6.1)');
    // last hint wins in the alert: leftover claude.ai-synced skills have a specific cleanup
    if (sorted.some((l) => /synced claude\.ai skill file/.test(l))) out('hint: claude.ai synced skills into the fleet config dir. Set syncClaudeAiSkills and syncClaudeAiPlugins to false in its settings.json (fleet config-dir init does it), delete its skills/synced/ directory, then fleet verify (fleet guide § 6.1)');
    // which of the pinned things the problems are in, for the launch gate's hold reason
    const comps = [...new Set(sorted.map(componentOf))];
    out(`components: ${comps.join(', ')}`);
    out(`fingerprint: ${problemFingerprint(sorted)}`);
    if (a.cache) { try { fs.rmSync(a.cache, { force: true }); } catch { /* best effort */ } }
    return 1;
  };
  const componentOf = (l) => {
    // the label comes first: settings, user-cfg and memory lines also carry an absolute path or a plugin id, which say nothing about which install failed
    if (/^(settings|user-cfg|memory|sched) /.test(l)) return 'settings or user-scope config';
    for (const mp of market) {
      if (l.includes(mp.id) || (mp.roots || []).some((r) => l.includes(r))) return /^release /.test(l) ? `instance release (${mp.id})` : `instance plugin ${mp.id}`;
    }
    if (a.engsysDir && l.includes(a.engsysDir)) return 'host kit';
    if (/^(release|version|no-path|two-paths|disabled|shadowed) /.test(l) || /^\S+\s+\//.test(l)) return 'engsys plugin';
    return 'pin checkout';
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
  // Plugins of other marketplaces (the instance marketplace, engsys#196): each is held to its own marketplace's
  // pinned release the same way. Same fail-closed rules: an install that is missing, or a pin that is not a
  // release tag, is "not verified", never silently skipped.
  const market = [];
  for (const mp of a.marketPlugins) {
    if (!TAG_RE.test(mp.tag)) {
      out(`verify: not verified: ${mp.id} is pinned at '${mp.tag}', which is not a release tag (vX.Y.Z), so its install can't be checked against ${mp.repo}`);
      return 3;
    }
    const ms = selectInstalls(list, { pluginId: mp.id, projectDir: a.projectDir, version: mp.tag.slice(1), harness: a.harness, globalPluginsDir: a.globalPluginsDir });
    if (ms.notInstalled) { out(`verify: not verified: ${mp.id} is not installed for ${a.projectDir} (run: fleet sync)`); return 3; }
    preProblems.push(...ms.problems);
    market.push({ ...mp, roots: ms.roots });
  }
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
      allowedUserHooks: parseAllowedHooks(a.allowedUserHooks),
      claudeJson: a.claudeJson,
      allowedUserFiles: a.checkUserConfig ? parseAllowedFiles(a.allowedUserFiles) : null,
      fleetConfigDir: a.fleetConfigDir,
    });
    preProblems.push(...r.problems);
    info = r.info;
    warnLines(r.warnings);
    if (a.messagingSettings) preProblems.push(...checkMessagingSettings(a.messagingSettings));
  }
  infoLines(info);
  if (preProblems.length) return mismatch(preProblems);

  let local;
  try { local = localState(sel.roots); } catch (e) { out(`verify: not verified: can't read the plugin files (${e.message})`); return 3; }
  const marketLocal = {};
  try { for (const mp of market) marketLocal[mp.id] = { repo: mp.repo, tag: mp.tag, local: localState(mp.roots, MARKET_SCAN) }; } catch (e) {
    out(`verify: not verified: can't read the plugin files (${e.message})`); return 3;
  }
  let host = null;
  if (a.engsysDir) {
    try { host = scanHost(a.engsysDir); } catch (e) { out(`verify: not verified: can't read the host kit files (${e.message})`); return 3; }
  }
  const where = sel.roots.join(', ');
  const projectKey = project ? { repo: a.pinRepo, ...project } : null;

  if (a.cache) {
    const c = readCache(a.cache);
    const ageMin = c ? (now() - Number(c.verifiedAt)) / 60_000 : Infinity;
    if (c && c.result === 'ok' && c.repo === a.repo && c.tag === a.tag && sameJson(c.local, local) && sameJson(c.market ?? {}, marketLocal) && sameJson(c.host ?? null, host)
      && sameJson(c.project ?? null, projectKey) && sameJson(c.info ?? [], info) && ageMin >= 0 && ageMin < a.maxAgeMin) {
      warnLines(Array.isArray(c.warnings) ? c.warnings : []);
      for (const mp of market) out(`verify: ok, ${countFiles(marketLocal[mp.id].local)} files of ${mp.id} in ${mp.roots.join(', ')} match ${mp.repo}@${mp.tag} (unchanged)`);
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
  const released = new Map();
  const marketWarnings = [];
  for (const mp of market) {
    try {
      const key = `${mp.repo}@${mp.tag}`;
      if (!released.has(key)) released.set(key, await fetch({ repo: mp.repo, tag: mp.tag }));
      const mrel = released.get(key);
      if (mrel.status !== 'ahead' && mrel.status !== 'identical') {
        const line = `${mp.id}: ${mp.tag} of ${mp.repo} is commit ${mrel.commit}, which is not on ${mrel.defaultBranch} (compare: ${mrel.status})`;
        if (instanceOffMainEnforced) problems.push(`release    ${line}`);
        else marketWarnings.push(`instance release ${line}; allowed for now, a MISMATCH once INSTANCE_OFF_MAIN_ENFORCED is on (eric-sabe/engsys#227)`);
      }
      const mfSha = mrel.tree.get(MARKETPLACE_FILE);
      if (!mfSha) throw new Unverified(`${mp.repo}@${mp.tag} has no ${MARKETPLACE_FILE}`);
      const subdir = pluginSubdir(await blob({ repo: mp.repo, sha: mfSha }), mp.id.split('@')[0]);
      const rekeyed = Object.fromEntries(Object.entries(marketLocal[mp.id].local).map(([root, m]) => [root,
        Object.fromEntries(Object.entries(m).map(([k, v]) => [`${subdir}/${k.slice(MARKET_SCAN.length + 1)}`, v]))]));
      // an install of nothing, or of a directory the release doesn't have, is a mismatch, not a pass
      if (![...mrel.tree.keys()].some((p) => p.startsWith(`${subdir}/`))) throw new Unverified(`${mp.repo}@${mp.tag} has no files under ${subdir}/`);
      for (const d of compare(mrel.tree, rekeyed, subdir)) problems.push(`${d.kind.padEnd(10)} ${cachePath(d.root, d.path, subdir)} ${d.have}`);
      mp.subdir = subdir;
    } catch (e) {
      out(`verify: not verified against ${mp.repo}@${mp.tag}: ${e instanceof Unverified ? e.message : String(e && e.message || e)}`);
      return 3;
    }
  }
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
    const st = project.scheduledTasks;
    if (st && !st.empty) {
      const allowedF = parseAllowedFiles(a.allowedUserFiles);
      if (st.hash !== 'not-a-file' && allowedF.has(st.hash)) out(`verify: info allowed    ${st.rel} ${st.hash} (VERIFY_ALLOWED_USER_FILES)`);
      else problems.push(`sched      ${st.rel} holds scheduled prompts, not on VERIFY_ALLOWED_USER_FILES (sha256 ${st.hash})`);
    }
  }
  warnings = [...marketWarnings, ...warnings];
  warnLines(warnings);
  if (problems.length) return mismatch(problems);

  if (a.cache) {
    try { writeCache(a.cache, { repo: a.repo, tag: a.tag, local, market: marketLocal, host, project: projectKey, info, warnings, result: 'ok', verifiedAt: now() }); } catch (e) {
      out(`verify: WARNING can't write ${a.cache} (${e.message}); the next run asks GitHub again`);
    }
  }
  for (const mp of market) out(`verify: ok, ${countFiles(marketLocal[mp.id].local)} files of ${mp.id} in ${mp.roots.join(', ')} match ${mp.repo}@${mp.tag} (${mp.subdir}/)`);
  out(`verify: ok, ${countFiles(local)} protected files in ${where} match ${target} (commit ${rel.commit.slice(0, 12)}, on ${rel.defaultBranch})${project ? `; ${a.pinRepo} checkout ${project.head.slice(0, 12)} and its auto-loaded files (.claude/, CLAUDE.md, .mcp.json, command targets) match GitHub` : ''}`);
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  // Exit only once stdout has drained: process.exit() right after a big write to a pipe (the `$(...)` in
  // verify.sh) drops the tail on a loaded host, losing the summary/fingerprint lines the alert needs (engsys#198).
  const finish = exitAfterFlush;
  run(process.argv.slice(2)).then(finish, (e) => {
    process.stdout.write(`verify: not verified: internal error (${e && e.message})\n`);
    finish(3);
  });
}
