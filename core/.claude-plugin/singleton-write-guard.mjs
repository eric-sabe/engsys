#!/usr/bin/env node
// singleton-write-guard.mjs — PreToolUse hook for the engsys core PLUGIN (engsys#62, #69 review H1/N1).
//
// A merge or maintenance monster holds its role through the github lease and must fence every write
// to GitHub (core/lib/lease/baton.mjs). Fleet monsters run with --dangerously-skip-permissions, so no
// permission prompt stands between the model and a raw `gh pr merge`. Hooks still run in that mode,
// so this one is the guard rail. Active only when ENGSYS_SINGLETON_ROLE is `merge` or `maintain`
// (launch-agent-sessions.sh exports it for a session whose roster prompt runs that monster; the hook
// reads the claude process's environment, so a command cannot unset it). Subagents run inside the
// session's process, so the agents a monster dispatches are covered too. Elsewhere it is silent.
//
// In a singleton session it is an ALLOWLIST:
//   Bash   a command that is exactly one plain invocation of a fenced wrapper passes (mm-act/mnt-act,
//          mm-baton/mnt-baton, and mm-heartbeat/mnt-heartbeat with --state-dir), with no chaining,
//          pipes, redirects or command substitution anywhere in it. Otherwise every gh, git and HTTP
//          client invocation in it (nested quoted commands too) must be a known read:
//            gh     pr|issue|run|workflow|repo|release|label|cache view|list|status|diff|checks|
//                   download|watch, search, auth status, api with no method or GET, no --input,
//                   and fields only under an explicit -X GET (query parameters),
//                   api graphql with an inline query that is not a mutation. Anything else, including
//                   aliases and extensions, is denied.
//            git    a known local or read subcommand (status, log, diff, fetch, commit, rebase, …);
//                   never push, config writes, remote changes, aliases or a -c outside a short list.
//            curl, wget, http, xh …  never towards github.com; and no command may name
//                   api.github.com or uploads.github.com at all.
//          Nor may a command touch a settings file (.claude/settings*.json, managed-settings.json, the
//          .claude dir itself) or the plugin cache except to read it.
//   Write | Edit | MultiEdit | NotebookEdit   denied on those same settings and plugin paths.
//   mcp__*github*   only tools whose name starts with get_/list_/search_/read_/fetch_/download_/view_.
//
// It raises the bar; it is not a boundary. A determined obfuscation (a script file, an interpreter
// assembling the verb, a variable holding it) gets past a lexical check. The controls are the lease
// and the sha-pinned merge. When active and unsure (an unparseable command that mentions gh, git or
// GitHub, or an internal error), it denies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLES = new Set(['merge', 'maintain']);

/** The fenced wrappers, relative to the plugin's skills/ dir. */
export const WRAPPERS = new Set([
  'merge-monster/scripts/mm-act.sh',
  'merge-monster/scripts/mm-heartbeat.sh',
  'merge-monster/scripts/mm-baton.sh',
  'maintenance-monster/scripts/mnt-act.sh',
  'maintenance-monster/scripts/mnt-heartbeat.sh',
  'maintenance-monster/scripts/mnt-baton.sh',
]);
const HEARTBEATS = new Set(['merge-monster/scripts/mm-heartbeat.sh', 'maintenance-monster/scripts/mnt-heartbeat.sh']);

const GH_READ_GROUPS = new Set(['pr', 'issue', 'run', 'workflow', 'repo', 'release', 'label', 'cache']);
const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks', 'download', 'watch']);
/** gh flags that take a separate value (so the value is not read as a group or verb). */
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname', '-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field',
  '--input', '-q', '--jq', '-t', '--template', '-b', '--body', '--body-file', '--title', '-B', '--base', '--head', '-l', '--label',
  '-a', '--assignee', '-m', '--milestone', '-r', '--ref', '--json', '-s', '--state', '-L', '--limit', '-A', '--author', '--search',
  '-S', '--workflow', '-w', '--branch', '-u', '--user', '-e', '--event', '-c', '--commit', '-n', '--name', '-D', '--dir', '-p', '--pattern']);

/** git subcommands that only read, or only change the local checkout. */
const GIT_LOCAL = new Set(['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'check-ignore', 'checkout', 'cherry', 'cherry-pick',
  'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'help',
  'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'name-rev', 'pull', 'range-diff', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'switch', 'symbolic-ref',
  'tag', 'update-index', 'var', 'version', 'worktree', 'whatchanged']);
/** `git -c <key>=…` keys that cannot redirect a push, run a program or define an alias. */
const GIT_SAFE_CONFIG = /^(user\.(name|email)|color\.[a-z.]+|core\.pager|advice\.[a-zA-Z.]+|commit\.gpgsign|init\.defaultBranch|pull\.rebase|rebase\.autoStash)=/;
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'aria2c', 'lwp-request']);
/** Read-only tools that may name a protected settings path. */
const READ_TOOLS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'jq', 'ls', 'stat', 'wc', 'file', 'diff', 'shasum',
  'sha256sum', 'md5', 'od', 'xxd', 'realpath', 'readlink', 'test', '[']);

export function lex(cmd) {
  const s = String(cmd ?? '');
  const commands = [[]];
  let cur = '';
  let inWord = false;
  let quote = null;
  let subst = false;
  let ops = false;
  const end = () => { if (inWord) { commands[commands.length - 1].push(cur); cur = ''; inWord = false; } };
  const split = () => { end(); ops = true; if (commands[commands.length - 1].length) commands.push([]); };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 1; continue; }
      if (ch === '`' || (ch === '$' && s[i + 1] === '(')) subst = true;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === '\\') {
      if (s[i + 1] === '\n') { i += 1; continue; }
      if (i + 1 < s.length) { cur += s[i + 1]; inWord = true; i += 1; }
      continue;
    }
    if (ch === ' ' || ch === '\t') { end(); continue; }
    if (ch === '$' && s[i + 1] === '(') { subst = true; split(); i += 1; continue; }
    if (ch === '`') { subst = true; split(); continue; }
    if (';&|<>()\n\r'.includes(ch)) { split(); continue; }
    cur += ch;
    inWord = true;
  }
  if (quote) return { words: commands, subst, ops, ok: false };
  end();
  return { words: commands.filter((c) => c.length), subst, ops, ok: true };
}

const base = (w) => w.split('/').pop();

function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-')) { if (valueFlags.has(a)) i += 1; continue; }
    out.push(a);
  }
  return out;
}

/** gh api: GET only, no fields, no --input; graphql only an inline, non-mutation query. -> deny reason or null. */
function ghApiVerdict(args, endpoint) {
  let method = null;
  let input = false;
  const fields = [];
  const headers = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-X' || a === '--method') { method = String(args[i + 1] ?? ''); i += 1; }
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (/^-X./.test(a)) method = a.slice(2).replace(/^=/, ''); // pflag: -XPUT, -X=PUT
    else if (['-f', '-F', '--field', '--raw-field'].includes(a)) { fields.push(String(args[i + 1] ?? '')); i += 1; }
    else if (/^--(raw-)?field=/.test(a)) fields.push(a.slice(a.indexOf('=') + 1));
    else if (/^-[fF]./.test(a)) fields.push(a.slice(2).replace(/^=/, ''));
    else if (a === '--input' || a.startsWith('--input=')) input = true;
    else if (a === '-H' || a === '--header') { headers.push(String(args[i + 1] ?? '')); i += 1; }
    else if (/^(--header=|-H.)/.test(a)) headers.push(a.replace(/^(--header=|-H=?)/, ''));
  }
  if (headers.some((h) => /method-override/i.test(h))) return 'gh api with a method-override header';
  if (endpoint === 'graphql') {
    if (input) return 'gh api graphql --input (the document is not visible)';
    if (fields.some((v) => /^[^=]*=@/.test(v))) return 'gh api graphql with a field read from a file or stdin';
    if (fields.some((v) => /\bmutation\b/i.test(v))) return 'gh api graphql mutation';
    return null;
  }
  if (method !== null && method.toUpperCase() !== 'GET') return `gh api -X ${method}`;
  if (input) return 'gh api --input';
  // Fields make gh POST, unless the method is an explicit GET (then they are query parameters).
  if (fields.length && method === null) return 'gh api with fields (gh sends them as a POST)';
  if (fields.some((v) => /^[^=]*=@/.test(v))) return 'gh api with a field read from a file';
  return null;
}

/** -> deny reason, or null for a known read. */
function ghVerdict(args) {
  const pos = positionals(args, GH_VALUE_FLAGS);
  const [group, verb] = pos;
  if (group === undefined || group === 'help' || group === 'version') return null;
  if (group === 'search') return null;
  if (group === 'auth') return verb === 'status' ? null : `gh auth ${verb ?? ''}`.trim();
  if (group === 'api') return ghApiVerdict(args, verb);
  if (GH_READ_GROUPS.has(group) && GH_READ_VERBS.has(verb)) return null;
  return `gh ${group}${verb ? ` ${verb}` : ''} (not a known read; aliases and extensions are denied too)`;
}

/** -> deny reason, or null for a local or read-only git command. */
function gitVerdict(args) {
  let i = 0;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') { i += 1; continue; }
    if (a === '-c') {
      if (!GIT_SAFE_CONFIG.test(String(args[i + 1] ?? ''))) return `git -c ${args[i + 1] ?? ''}`;
      i += 1;
      continue;
    }
    if (/^--(git-dir|work-tree)=/.test(a) || ['--no-pager', '-P', '--no-optional-locks', '--bare'].includes(a)) continue;
    if (a.startsWith('-')) return `git ${a}`;
    break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return null;
  if (sub === 'push') return 'git push';
  if (!GIT_LOCAL.has(sub)) return `git ${sub} (not a known local or read subcommand; aliases are denied)`;
  if (sub === 'config') {
    const reads = ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'];
    return rest.some((a) => reads.includes(a)) && !rest.some((a) => /^--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)$|^-e$|^set$|^unset$/.test(a))
      ? null : 'git config (writes are denied)';
  }
  if (sub === 'remote') {
    const pos = positionals(rest, new Set());
    return pos.length === 0 || ['show', 'get-url'].includes(pos[0]) ? null : `git remote ${pos[0]}`;
  }
  return null;
}

function httpVerdict(args) {
  return args.some((a) => /github\.com|githubusercontent\.com/i.test(a)) ? 'an HTTP client towards GitHub' : null;
}

/** Expand a leading ~ and $HOME so settings paths are recognized however they are spelled. */
function expandHome(p, home) {
  return String(p).replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

/** Is `p` a settings file, the .claude dir itself, or the plugin cache? */
export function protectedPath(p, { env = process.env, cwd = process.cwd() } = {}) {
  if (typeof p !== 'string' || !p) return false;
  const home = env.HOME || os.homedir();
  const abs = path.resolve(cwd, expandHome(p, home));
  if (/(^|\/)\.claude\/?$/.test(abs)) return true;
  if (/(^|\/)\.claude\/(settings[^/]*\.json|managed-settings\.json)$/.test(abs)) return true;
  if (/managed-settings\.json$/.test(abs)) return true;
  if (/(^|\/)\.claude\/plugins(\/|$)/.test(abs)) return true;
  if (env.CLAUDE_CONFIG_DIR) {
    const cfg = path.resolve(expandHome(env.CLAUDE_CONFIG_DIR, home));
    if (abs === cfg || abs.startsWith(`${cfg}/plugins`) || (path.dirname(abs) === cfg && /^settings[^/]*\.json$/.test(path.basename(abs)))) return true;
  }
  if (env.CLAUDE_PLUGIN_ROOT) {
    let root = env.CLAUDE_PLUGIN_ROOT;
    try { root = fs.realpathSync(root); } catch { /* keep as given */ }
    if (abs === root || abs.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** Interpreters that run a script file given as their first non-option argument. */
const SCRIPT_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node']);
const SCRIPT_FILE = /\.(sh|bash|mjs|cjs|js)$/;

/**
 * True when simple[i] is a plugin script being RUN, not written: either the command itself
 * (`/…/plugins/…/x.sh args`) or the first non-option argument of bash/sh/zsh/node
 * (`bash /…/plugins/…/x.sh args`; a bare path counts only as the first simple command, since a
 * redirect target is lexed as a later simple command). Running the plugin's own skill scripts is how a monster works;
 * changing them is still denied (cp/mv/tee/sed -i/redirects never reach this branch as the script
 * position, and settings JSON files never match SCRIPT_FILE).
 */
export function scriptExecution(simple, i, simpleIndex = 0) {
  const w = simple[i] ?? '';
  if (!SCRIPT_FILE.test(w)) return false;
  // A bare path at position 0 is a command only in the FIRST simple command: the lexer also emits a
  // redirect target (`printf x > /…/x.sh`) as its own simple command, which always comes later.
  if (i === 0) return simpleIndex === 0;
  const head = base(simple[0] ?? '');
  if (!SCRIPT_INTERPRETERS.has(head)) return false;
  let j = 1;
  while (j < simple.length && simple[j].startsWith('-')) {
    if (head === 'node' && ['-e', '--eval', '-p', '--print'].includes(simple[j])) return false; // inline code, not a script file
    j += 1;
  }
  return j === i;
}

/** Every reason to deny `cmd` in a singleton session (nested quoted commands too). */
export function bashFindings(cmd, ctx = {}, depth = 0) {
  const found = [];
  const { words } = lex(cmd);
  for (const [simpleIndex, simple] of words.entries()) {
    const head = base(simple[0] ?? '');
    for (let i = 0; i < simple.length; i += 1) {
      const w = simple[i];
      if (/\s/.test(w) && depth < 3) found.push(...bashFindings(w, ctx, depth + 1));
      const b = base(w);
      let hit = null;
      if (b === 'gh') hit = ghVerdict(simple.slice(i + 1));
      else if (b === 'git') hit = gitVerdict(simple.slice(i + 1));
      else if (HTTP_CLIENTS.has(b)) hit = httpVerdict(simple.slice(i + 1));
      if (hit) found.push(hit);
      if (/(^|[/@.])(api|uploads)\.github\.com/i.test(w)) found.push('a command that names the GitHub API host');
      if (protectedPath(w, ctx) && !READ_TOOLS.has(head) && !scriptExecution(simple, i, simpleIndex)) found.push(`a write to a protected settings or plugin path (${w})`);
    }
  }
  return [...new Set(found)];
}

/** Back-compat name for the findings list. */
export const githubWrites = (cmd) => bashFindings(cmd);

/** The wrapper's rel path when `cmd` is exactly one invocation of a fenced wrapper, else null. */
export function wrapperInvocation(cmd, pluginRoot) {
  if (!pluginRoot) return null;
  const l = lex(cmd);
  if (!l.ok || l.subst || l.ops || l.words.length !== 1) return null;
  const words = [...l.words[0]];
  if (words[0] === 'bash') words.shift();
  const exe = words[0];
  if (!exe || !path.isAbsolute(exe)) return null;
  let root;
  let real;
  try { root = fs.realpathSync(pluginRoot); real = fs.realpathSync(exe); } catch { return null; }
  const rel = path.relative(path.join(root, 'skills'), real).split(path.sep).join('/');
  if (!WRAPPERS.has(rel)) return null;
  if (HEARTBEATS.has(rel) && !words.includes('--state-dir')) return null; // L-a: the heartbeat without a renew is no fence
  return rel;
}

function denyMessage(role, found) {
  const wrapper = role === 'merge' ? 'merge-monster/scripts/mm-act.sh' : 'maintenance-monster/scripts/mnt-act.sh';
  return `engsys singleton-write guard: this ${role} monster session only reads GitHub directly (found: ${found.join('; ')}). `
    + `Writes go through ONE plain command: <engsys-root>/skills/${wrapper} guard --repo <repo> --state-dir <state_dir> -- gh <args…>`
    + `${role === 'merge' ? '; merges as mm-act.sh merge --pr N --sha <validated head> --method merge|squash' : ''}`
    + '; a push as … guard --pr N -- git -C <worktree> push --force-with-lease origin HEAD:refs/heads/<PR head branch>. '
    + 'No ;, &&, |, redirects, $( ) or backticks around it. If the fence refuses, do not act (SKILL.md § The baton). '
    + 'Dispatched agents never write to GitHub themselves: they hand the act back to the monster. Settings and plugin files are read-only here.';
}

/** -> null (no opinion) or { deny: reason }. */
export function decide({ tool_name: tool = 'Bash', tool_input: input = {}, command, env = process.env, pluginRoot = env.CLAUDE_PLUGIN_ROOT, cwd = process.cwd() }) {
  const role = env.ENGSYS_SINGLETON_ROLE;
  if (!ROLES.has(role)) return null;
  const ctx = { env, cwd };
  if (tool === 'Bash') {
    const cmd = command ?? input.command;
    if (wrapperInvocation(cmd, pluginRoot)) return null;
    let found = bashFindings(cmd, ctx);
    if (!lex(cmd).ok && /\b(gh|git|curl|wget)\b|github\.com|\.claude/.test(String(cmd))) found = found.length ? found : ['an unparseable command that mentions gh, git, GitHub or .claude'];
    return found.length ? { deny: denyMessage(role, found) } : null;
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = input.file_path ?? input.notebook_path ?? input.path;
    return protectedPath(p, ctx) ? { deny: `engsys singleton-write guard: settings and plugin files are read-only in a ${role} monster session (${p}): changing them could switch off the hooks that fence its GitHub writes.` } : null;
  }
  if (/^mcp__/.test(tool) && /github/i.test(tool)) {
    const name = tool.split('__').pop();
    return /^(get|list|search|read|fetch|download|view)(_|$)/i.test(name) ? null
      : { deny: `engsys singleton-write guard: GitHub MCP tool ${tool} may write; a ${role} monster session writes to GitHub only through its fenced wrapper.` };
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { input = null; }
  if (!input || typeof input.tool_name !== 'string') return;
  let d;
  try {
    d = decide({ tool_name: input.tool_name, tool_input: input.tool_input || {}, cwd: input.cwd || process.cwd() });
  } catch (e) {
    d = ROLES.has(process.env.ENGSYS_SINGLETON_ROLE) ? { deny: `engsys singleton-write guard failed (${String(e && e.message)}): denied, fail closed` } : null;
  }
  if (!d) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.deny },
  }));
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}
