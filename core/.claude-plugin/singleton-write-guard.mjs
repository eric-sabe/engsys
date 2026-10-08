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
//   Bash | Monitor (any tool input with a `command` string, #85 M1)
//          a command that is one plain invocation of a fenced wrapper passes (mm-act/mnt-act,
//          mm-baton/mnt-baton, and mm-heartbeat/mnt-heartbeat with --state-dir), with no chaining,
//          redirects or substitution; only 2>&1, `| jq …` / `| cat`, `; echo $?` and a heredoc of
//          data on its stdin may follow (#85 F2), the heredoc with a quoted delimiter so its body
//          expands nothing (#106). Otherwise every gh, git and HTTP client invocation
//          in it (nested quoted commands too; names compared case-insensitively, $'…' decoded) must
//          be a known read:
//            gh     pr|issue|run|workflow|repo|release|label|cache view|list|status|diff|checks|
//                   download|watch, search, auth status, api with no method or GET, no --input,
//                   and fields only under an explicit -X GET (query parameters),
//                   api graphql with an inline, visible query that is not a mutation: no field the
//                   shell expands ($VAR, $( ), backticks) and no substitution anywhere in the command,
//                   and never a merge mutation (#71 L1); gh api never fed by xargs or parallel, never
//                   with an unquoted $VAR or a word starting with an expansion, never next to a
//                   substitution (#85 L6). Anything else, including aliases and extensions, is denied.
//            hub    never (another GitHub client).
//            git    a known local or read subcommand (status, log, diff, fetch, commit, rebase, …);
//                   never push, config writes, remote changes, aliases or a -c outside a short list.
//            curl, wget, http, xh …  never towards github.com; and no command may name
//                   api.github.com or uploads.github.com at all.
//            node, python, ruby, perl, deno, bun, npx   in command position, not when their code
//                   (inline, a heredoc they read, stdin or their arguments) names Octokit/PyGithub,
//                   calls github.com with a write-ish verb, names a protected path, or (read as shell
//                   words, so subprocess.run(['gh','pr','merge']) counts) runs a gh/git write (#71 L2,
//                   #85 L1); running the kit's own scripts is fine.
//          NAME=value may prefix a kit script, never gh or git. A heredoc fed to cat, tee or gh is data
//          and is not read as commands (#85 F1), except that an UNQUOTED delimiter makes the shell run
//          the body's $( ) and backticks, so those are commands (#92 NF1); a heredoc fed to eval, a
//          read loop that evals, or xargs … sh -c is code. The fenced wrappers and gate-request.sh run only as
//          the one plain invocation above. Nor may a command touch a settings file
//          (.claude/settings*.json, managed-settings.json, the .claude dir itself, the shell snapshots
//          and session-env files sourced before each Bash call), git config (.git/config,
//          ~/.gitconfig) or the plugin cache except to read it; a path glued to code
//          (`open('.claude/settings.json','w')`) counts, and a plugin-cache path handed to a kit
//          script (its --config) is a read.
//   Write | Edit | MultiEdit | NotebookEdit   denied on those same settings, git config and plugin paths.
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

/** One ANSI-C escape after a backslash in $'…' at s[j] -> [text, chars consumed]. */
function ansiEscape(s, j) {
  const c = s[j];
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  if (c in simple) return [simple[c], 1];
  const hex = (re, from) => { const m = re.exec(s.slice(from)); return m ? m[0] : ''; };
  if (c === 'x') { const h = hex(/^[0-9a-fA-F]{1,2}/, j + 1); return h ? [String.fromCodePoint(parseInt(h, 16)), 1 + h.length] : ['\\x', 1]; }
  if (c === 'u' || c === 'U') { const h = hex(c === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/, j + 1); return h ? [String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)), 1 + h.length] : [`\\${c}`, 1]; }
  if (/[0-7]/.test(c)) { const o = hex(/^[0-7]{1,3}/, j); return [String.fromCharCode(parseInt(o, 8) & 0xff), o.length]; }
  if (c === 'c' && j + 1 < s.length) return [String.fromCharCode(s.charCodeAt(j + 1) & 0x1f), 2];
  return [`\\${c ?? ''}`, c === undefined ? 0 : 1];
}

/**
 * A small shell lexer: simple commands split on ; & | < > ( ) and newlines. `subst` is set by a
 * command or process substitution anywhere ($( ), backticks, <( ), >( )), quoted or not. Parallel
 * to `words`, per word:
 *   exp   the shell expands part of it ($ or a backtick outside single quotes), so the lexer does
 *         not see what the command receives;
 *   uexp  an unquoted $VAR or ${…}: word splitting can turn it into several words or flags (#85 L6);
 *   lead  the word starts with an expansion, so it can become a flag even when quoted.
 * `$'…'` is decoded (ANSI-C escapes) and `$"…"` read as "…", so `$'gh'` lexes as gh (#85 L2).
 */
export function lex(cmd) {
  const s = String(cmd ?? '');
  const commands = [[]];
  const exps = [[]];
  const uexps = [[]];
  const leads = [[]];
  let cur = '';
  let inWord = false;
  let curExp = false;
  let curU = false;
  let curLead = false;
  let quote = null;
  let subst = false;
  let ops = false;
  const end = () => {
    if (inWord) {
      commands.at(-1).push(cur); exps.at(-1).push(curExp); uexps.at(-1).push(curU); leads.at(-1).push(curLead);
      cur = ''; inWord = false; curExp = false; curU = false; curLead = false;
    }
  };
  const split = () => { end(); ops = true; if (commands.at(-1).length) { commands.push([]); exps.push([]); uexps.push([]); leads.push([]); } };
  const expansion = (unquoted) => { if (cur === '') curLead = true; curExp = true; if (unquoted) curU = true; };
  const EXPANDS = /[A-Za-z0-9_{(@*#?$!-]/;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else cur += ch;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") { quote = null; continue; }
      if (ch === '\\' && i + 1 < s.length) { const [text, used] = ansiEscape(s, i + 1); cur += text; i += used; continue; }
      cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 1; continue; }
      if (ch === '`' || (ch === '$' && s[i + 1] === '(')) subst = true;
      if (ch === '`' || (ch === '$' && EXPANDS.test(s[i + 1] ?? ''))) expansion(false);
      cur += ch;
      continue;
    }
    if (ch === '$' && (s[i + 1] === "'" || s[i + 1] === '"')) {
      // $'…' (ANSI-C) and $"…" (locale): the $ is quoting, not part of the word.
      curExp = true;
      inWord = true;
      quote = s[i + 1] === "'" ? "$'" : '"';
      i += 1;
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
    if ((ch === '<' || ch === '>') && s[i + 1] === '(') subst = true; // process substitution
    if (';&|<>()\n\r'.includes(ch)) { split(); continue; }
    if (ch === '$' && EXPANDS.test(s[i + 1] ?? '')) expansion(true); // $VAR, ${…}, $1, $?
    cur += ch;
    inWord = true;
  }
  if (quote) return { words: commands, exp: exps, uexp: uexps, lead: leads, subst, ops, ok: false };
  end();
  const keep = commands.map((c, i) => i).filter((i) => commands[i].length);
  return { words: keep.map((i) => commands[i]), exp: keep.map((i) => exps[i]), uexp: keep.map((i) => uexps[i]), lead: keep.map((i) => leads[i]), subst, ops, ok: true };
}

const base = (w) => w.split('/').pop();
/** A command name as the (case-insensitive, on macOS) filesystem resolves it (#85 L2). */
const cmdName = (w) => base(w).toLowerCase();

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

/** GraphQL mutations that merge: never through gh in a singleton session (merges use the sha-pinned mm-act.sh merge). */
const GRAPHQL_MERGE = /mergePullRequest|enablePullRequestAutoMerge|mergeBranch/i;

/**
 * gh api: GET only, no fields, no --input; graphql only an inline, visible, non-mutation query.
 * `exp` parallels `args` (lex's expansion flags); `subst` is set when the whole command carries a
 * command or process substitution. -> deny reason or null.
 */
function ghApiVerdict(args, endpoint, { exp = [], subst = false } = {}) {
  let method = null;
  let input = false;
  const fields = [];
  const headers = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-X' || a === '--method') { method = String(args[i + 1] ?? ''); i += 1; }
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (/^-X./.test(a)) method = a.slice(2).replace(/^=/, ''); // pflag: -XPUT, -X=PUT
    else if (['-f', '-F', '--field', '--raw-field'].includes(a)) { fields.push({ v: String(args[i + 1] ?? ''), exp: Boolean(exp[i + 1]) }); i += 1; }
    else if (/^--(raw-)?field=/.test(a)) fields.push({ v: a.slice(a.indexOf('=') + 1), exp: Boolean(exp[i]) });
    else if (/^-[fF]./.test(a)) fields.push({ v: a.slice(2).replace(/^=/, ''), exp: Boolean(exp[i]) });
    else if (a === '--input' || a.startsWith('--input=')) input = true;
    else if (a === '-H' || a === '--header') { headers.push(String(args[i + 1] ?? '')); i += 1; }
    else if (/^(--header=|-H.)/.test(a)) headers.push(a.replace(/^(--header=|-H=?)/, ''));
  }
  if (headers.some((h) => /method-override/i.test(h))) return 'gh api with a method-override header';
  if (/^\/?graphql$/i.test(String(endpoint ?? ''))) {
    if (input) return 'gh api graphql --input (the document is not visible)';
    if (fields.some((f) => /^[^=]*=@/.test(f.v))) return 'gh api graphql with a field read from a file or stdin';
    // #71 L1: the document must be visible text. A substitution or a variable can hold a mutation.
    if (subst) return 'gh api graphql in a command with a command or process substitution (the document is not visible)';
    if (fields.some((f) => f.exp)) return 'gh api graphql with a field the shell expands ($VAR, ${…}, $( ) or backticks: the document is not visible)';
    if (fields.some((f) => GRAPHQL_MERGE.test(f.v))) return 'gh api graphql merge (merges go through the sha-pinned mm-act.sh merge)';
    if (fields.some((f) => /\bmutation\b/i.test(f.v))) return 'gh api graphql mutation';
    return null;
  }
  if (method !== null && method.toUpperCase() !== 'GET') return `gh api -X ${method}`;
  if (input) return 'gh api --input';
  // Fields make gh POST, unless the method is an explicit GET (then they are query parameters).
  if (fields.length && method === null) return 'gh api with fields (gh sends them as a POST)';
  if (fields.some((f) => /^[^=]*=@/.test(f.v))) return 'gh api with a field read from a file';
  return null;
}

/** -> deny reason, or null for a known read. `opts` carries lex's expansion flags for `args`. */
function ghVerdict(args, opts = {}) {
  const pos = positionals(args, GH_VALUE_FLAGS);
  const [group, verb] = pos;
  if (group === undefined || group === 'help' || group === 'version') return null;
  if (group === 'search') return null;
  if (group === 'auth') return verb === 'status' ? null : `gh auth ${verb ?? ''}`.trim();
  if (group === 'api') {
    // xargs/parallel append arguments the lexer never sees (-X PUT, -f query=mutation…).
    if (opts.appended) return 'gh api with arguments xargs or parallel supplies (not visible)';
    // #85 L6: `A='-X PUT'; gh api …/merge $A` — an unquoted expansion splits into flags, and a word
    // that starts with one can be a flag even quoted. "repos/$REPO/pulls/12" is fine.
    if (args.some((_, k) => opts.uexp?.[k] || opts.lead?.[k])) return 'gh api with an argument the shell can turn into flags (unquoted $VAR, or a word starting with $…)';
    if (opts.subst) return 'gh api in a command with a command or process substitution (it can supply the arguments)';
    return ghApiVerdict(args, verb, opts);
  }
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

/**
 * `fleet msg send` posts a GitHub comment through a child gh this hook never sees (engsys#77), so in a
 * singleton session it is a write like any other: allowed only as `mm-act.sh|mnt-act.sh guard -- fleet
 * msg send …`. Caught as `fleet … msg … send`, and as msg.sh / msg.mjs (any path, any interpreter) followed
 * by `send`. `inbox` and `read` stay allowed: they only read.
 */
export function fleetMsgSendVerdict(simple, i) {
  const b = base(simple[i] ?? '');
  const rest = simple.slice(i + 1);
  if (b === 'fleet') {
    const m = rest.indexOf('msg');
    return m !== -1 && rest.slice(m + 1).includes('send') ? 'fleet msg send (a GitHub write)' : null;
  }
  if (b === 'msg.sh' || b === 'msg.mjs') return rest.includes('send') ? 'fleet msg send (a GitHub write)' : null;
  return null;
}

function httpVerdict(args) {
  return args.some((a) => /github\.com|githubusercontent\.com/i.test(a)) ? 'an HTTP client towards GitHub' : null;
}

/** Expand a leading ~ and $HOME so settings paths are recognized however they are spelled. */
function expandHome(p, home) {
  return String(p).replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

/**
 * What `p` is, if protected: 'settings' (settings files, the .claude dir itself, and the shell
 * snapshots and session-env files sourced before every Bash call), 'gitconfig' (.git/config,
 * config.worktree, ~/.gitconfig, the XDG git config) or 'plugin' (the plugin cache and
 * CLAUDE_PLUGIN_ROOT). false otherwise.
 */
export function protectedPath(p, { env = process.env, cwd = process.cwd() } = {}) {
  if (typeof p !== 'string' || !p) return false;
  const home = env.HOME || os.homedir();
  const abs = path.resolve(cwd, expandHome(p, home));
  if (/(^|\/)\.claude\/?$/.test(abs)) return 'settings';
  if (/(^|\/)\.claude\/(settings[^/]*\.json|managed-settings\.json)$/.test(abs)) return 'settings';
  if (/managed-settings\.json$/.test(abs)) return 'settings';
  // #85 L3: sourced before every Bash call, so an export planted there reaches the monster's push.
  if (/(^|\/)\.claude\/(shell-snapshots|session-env)(\/|$)/.test(abs)) return 'settings';
  if (/(^|\/)\.claude\/plugins(\/|$)/.test(abs)) return 'plugin';
  // #71 L3: git config a planted credential helper, ssh command or proxy could live in.
  if (/(^|\/)\.git\/(config|config\.worktree|worktrees\/[^/]+\/config\.worktree)$/.test(abs)) return 'gitconfig';
  if (abs === path.join(home, '.gitconfig') || abs === path.join(env.XDG_CONFIG_HOME ? path.resolve(expandHome(env.XDG_CONFIG_HOME, home)) : path.join(home, '.config'), 'git', 'config')) return 'gitconfig';
  if (env.CLAUDE_CONFIG_DIR) {
    const cfg = path.resolve(expandHome(env.CLAUDE_CONFIG_DIR, home));
    if (abs === cfg || (path.dirname(abs) === cfg && /^settings[^/]*\.json$/.test(path.basename(abs)))) return 'settings';
    if (/^\/(shell-snapshots|session-env)(\/|$)/.test(abs.slice(cfg.length)) && abs.startsWith(cfg)) return 'settings';
    if (abs.startsWith(`${cfg}/plugins`)) return 'plugin';
  }
  if (env.CLAUDE_PLUGIN_ROOT) {
    let root = env.CLAUDE_PLUGIN_ROOT;
    try { root = fs.realpathSync(root); } catch { /* keep as given */ }
    if (abs === root || abs.startsWith(`${root}/`)) return 'plugin';
  }
  return false;
}

/** Interpreters that run a script file given as their first non-option argument. */
const SCRIPT_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node']);
const SCRIPT_FILE = /\.(sh|bash|mjs|cjs|js)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Commands that run the command after them, and their flags that take a value. */
const PREFIX_COMMANDS = new Map([['env', ['-u', '-C', '-S']], ['command', []], ['exec', ['-a']], ['xargs', ['-n', '-I', '-P', '-L', '-s', '-d', '-E', '--max-args', '--max-procs', '--max-lines', '--delimiter']], ['parallel', ['-j', '--jobs', '-I']],
  ['timeout', ['-s', '-k']], ['nohup', []], ['sudo', ['-u', '-g']], ['nice', ['-n']], ['time', []], ['stdbuf', []]]);

/**
 * Indices of the words a simple command runs: the first word after any NAME=value assignments,
 * and the command a prefix (env, command, exec, xargs, timeout, nohup, sudo, …) runs in turn.
 */
export function commandIndices(simple) {
  const out = [];
  let i = 0;
  while (i < simple.length && ASSIGNMENT.test(simple[i])) i += 1;
  while (i < simple.length) {
    out.push(i);
    const name = cmdName(simple[i]);
    if (!PREFIX_COMMANDS.has(name)) break;
    const valued = PREFIX_COMMANDS.get(name);
    i += 1;
    while (i < simple.length) {
      const a = simple[i];
      if (valued.includes(a)) { i += 2; continue; }
      if (a.startsWith('-') || ASSIGNMENT.test(a) || (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(a))) { i += 1; continue; }
      break;
    }
  }
  return out;
}

/**
 * The index of the script file a simple command runs, or -1: a path in command position (only in
 * the FIRST simple command, since the lexer also emits a redirect target as its own later simple
 * command), or the first non-option argument of bash/sh/zsh/node (never node's inline code).
 */
function executedScript(simple, simpleIndex) {
  for (const c of commandIndices(simple)) {
    if (SCRIPT_FILE.test(simple[c]) && !ASSIGNMENT.test(simple[c])) return simpleIndex === 0 ? c : -1;
    const head = cmdName(simple[c]);
    if (!SCRIPT_INTERPRETERS.has(head)) continue;
    let j = c + 1;
    while (j < simple.length && simple[j].startsWith('-')) {
      if (head === 'node' && ['-e', '--eval', '-p', '--print'].includes(simple[j])) return -1; // inline code, not a script file
      j += 1;
    }
    return j < simple.length && SCRIPT_FILE.test(simple[j]) ? j : -1;
  }
  return -1;
}

/**
 * True when simple[i] is a script being RUN, not written (v1.11.1): the command itself, after any
 * NAME=value prefix (`REPO=x /…/plugins/…/x.sh args`), or the first non-option argument of
 * bash/sh/zsh/node. Changing the script is still denied (cp/mv/tee/sed -i/redirects never put it in
 * that position, and settings JSON files never match SCRIPT_FILE).
 */
export function scriptExecution(simple, i, simpleIndex = 0) {
  return executedScript(simple, simpleIndex) === i;
}

/** Words that may hold a path glued to code or punctuation (`open('.claude/settings.json','w')`). */
function pathTokens(w) {
  return [w, ...w.split(/[\s'"`(),;=:<>|&{}[\]+]+/).filter((t) => t && t !== w)];
}

/** The fenced wrappers and gate-request.sh: they run only as one plain wrapper invocation (gate-request under guard). */
const FENCED_SCRIPTS = new Set([...WRAPPERS, 'merge-monster/scripts/gate-request.sh'].map((rel) => rel.split('/').pop()));

/** Interpreters that can run GitHub client code inline, from stdin or from a script (#71 L2). */
const INTERPRETER = /^(node|nodejs|python[0-9.]*|ruby|perl|deno|bun|bunx|npx)$/;
/** Shells: a heredoc they read is commands (as are eval and source). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.']);
/** Flags that make the next argument inline code (node -e/-p, python -c, ruby/perl -e/-E, clusters such as -ne). */
const INLINE_FLAG = /^(-[A-Za-z]*[ceE]|-p|--eval|--print|--eval=.*|--print=.*)$/;
/** Text that marks interpreter code as a GitHub client. */
const GITHUB_LIB = /octokit|PyGithub|from\s+github\s+import|import\s+github\b|Net::GitHub|Pithub|\bghapi\b/i;
const GITHUB_WEB = /github\.com\//i;
const WRITEISH = /\b(PUT|POST|PATCH|DELETE|method|urlopen|fetch|requests?|axios|got|Request|HTTPSConnection|Net::HTTP|LWP|HTTP::Tiny|merge|push|graphql|mutation|authorization|token)\b/i;
/** Protected paths in code; a monster's own config (`.claude/merge-monster.yml`) is not one. */
const SETTINGS_TEXT = /\.claude(?!\/[\w.-]+\.(?:ya?ml|md)\b)|managed-settings|\.gitconfig\b|\.git\/(config|worktrees)\b|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR/;

/**
 * What a heredoc opened at s[at] feeds: 'shell' (bash, sh, eval, … anywhere in its pipeline, or a
 * command word the shell expands), 'interp' (an interpreter) or 'data' (cat, tee, gh --body-file -, …).
 */
function heredocSink(s, lineStart, at, after) {
  const line = s.slice(lineStart, at);
  const tail = s.slice(after, (s.indexOf('\n', after) + 1 || s.length + 1) - 1).split(/;|&&|\|\|/)[0];
  // Command boundaries, including shell keywords and a lone ( or { (not the {} in xargs -I{}).
  const SEP = /;|&&|\|\||\n|(?:^|\s)[({](?=\s|$)|\b(?:while|until|for|do|done|if|then|else|elif|fi)\b/;
  // A loop, group or subshell redirected from the heredoc (`while read l; do eval "$l"; done <<EOF`,
  // `{ …; } 0<<EOF`) feeds every command in it, so read the whole command up to the heredoc (#92 NF1).
  const parts = /(\bdone|[})])\s*\d*$/.test(line) ? s.slice(0, at).split(SEP) : [line.split(SEP).pop()];
  parts[parts.length - 1] = `${parts.at(-1)} ${tail}`;
  let sink = 'data';
  for (const segment of parts) {
    for (const part of segment.replace(/<<-?\s*(['"]?)[^\s'"]+\1/g, ' ').replace(/\d*[<>]+&?\s*\S+/g, ' ').split('|')) {
      const words = lex(part).words.flat();
      const c = commandIndices(words).map((k) => words[k]);
      if (c.some((w) => SHELLS.has(cmdName(w)) || /^[$`]/.test(w))) return 'shell';
      if (c.some((w) => INTERPRETER.test(cmdName(w)))) sink = 'interp';
    }
  }
  return sink;
}

/**
 * What an UNQUOTED heredoc body makes the shell run or expand (#92 NF1): the text of every live
 * `$( … )` and backtick substitution (an escaped \\$ or \\` is literal), and whether a $VAR, ${…}
 * or $[…] is expanded. -> { code: [command text…], expands }.
 */
function bodyExpansions(body) {
  const code = [];
  let expands = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '$' && body[i + 1] === '(') {
      // To the matching ), skipping quoted text: `$(echo ")"; gh pr merge 5)` is one substitution.
      let depth = 0;
      let quote = null;
      let j = i + 1;
      for (; j < body.length; j += 1) {
        const c = body[j];
        if (quote === "'") { if (c === "'") quote = null; continue; }
        if (c === '\\') { j += 1; continue; }
        if (quote === '"') { if (c === '"') quote = null; continue; }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '(') depth += 1;
        else if (c === ')' && --depth === 0) break;
      }
      code.push(body.slice(i + 2, j)); // unbalanced: the rest of the body, fail closed
      expands = true;
      i = j;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== '`') j += body[j] === '\\' ? 2 : 1;
      code.push(body.slice(i + 1, j));
      expands = true;
      i = j;
      continue;
    }
    if (ch === '$' && /[A-Za-z0-9_{[@*#?$!-]/.test(body[i + 1] ?? '')) expands = true;
  }
  return { code, expands };
}

/**
 * The delimiter word of a heredoc operator at s[i] (`<<` or `<<-`), read the way bash reads it (#110):
 * the WHOLE word up to the next unquoted blank or metacharacter, with single-quoted, double-quoted,
 * backslash-escaped and bare parts concatenated after quote removal, so `<<'EOF'X` ends at `EOFX` and
 * `<<'EO''F'` at `EOF`. Any quoting makes it quoted (the body is not expanded). A `$` or backtick, a
 * backslash inside double quotes, a quote that does not close, or an empty word is not parsed: null
 * (the caller fails closed). -> { raw, delim, strip, quoted } | null.
 */
export function heredocOperator(s, i) {
  const m = /^<<(-?)[ \t]*/.exec(s.slice(i, i + 64));
  if (!m) return null;
  let j = i + m[0].length;
  let delim = '';
  let quoted = false;
  while (j < s.length && !/[\s;&|<>()]/.test(s[j])) {
    const ch = s[j];
    if (ch === '$' || ch === '`') return null;
    if (ch === "'") {
      const e = s.indexOf("'", j + 1);
      if (e < 0) return null;
      delim += s.slice(j + 1, e);
      quoted = true;
      j = e + 1;
    } else if (ch === '"') {
      const e = s.indexOf('"', j + 1);
      if (e < 0) return null;
      const part = s.slice(j + 1, e);
      if (/[$`\\]/.test(part)) return null;
      delim += part;
      quoted = true;
      j = e + 1;
    } else if (ch === '\\') {
      if (j + 1 >= s.length || s[j + 1] === '\n') return null;
      delim += s[j + 1];
      quoted = true;
      j += 2;
    } else {
      delim += ch;
      j += 1;
    }
  }
  if (!delim || delim.includes('\n')) return null;
  return { raw: s.slice(i, j), delim, strip: m[1] === '-', quoted };
}

/**
 * Take heredoc bodies out of `cmd` (#85 F1). A body fed to cat, tee or gh is data and is never
 * lexed (an escalation comment may mention node, git push or .claude/settings.json). A body fed to
 * a shell is commands and stays in; one fed to an interpreter is code for interpreterFindings.
 * Quote-aware, so `echo "<<X"` opens nothing. An UNQUOTED delimiter makes the shell expand the
 * body whatever reads it, so its substitutions are commands (shellCode) and any expansion sets
 * `subst` (#92 NF1); a quoted delimiter (<<'EOF', <<"EOF", <<\EOF) keeps the body inert. The
 * delimiter is read as bash reads it (heredocOperator, #110). `ops` lists each operator with its
 * offset in `text`. `ok` is false when a delimiter can't be read, or a `<<` follows an arithmetic
 * `((` (a shift, not a heredoc): the body then stays in `text`, read as commands, and the caller
 * fails closed. -> { text, shellCode, interpCode, subst, ops, ok }.
 */
export function splitHeredocs(cmd) {
  const s = String(cmd ?? '');
  if (!s.includes('<<')) return { text: s, shellCode: '', interpCode: '', subst: false, ops: [], ok: true };
  let ok = true;
  let arith = false;
  const ops = [];
  let subst = false;
  let out = '';
  const shell = [];
  const interp = [];
  const pending = [];
  let quote = null;
  let lineStart = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") { if (ch === "'") quote = null; out += ch; continue; }
    if (quote === '"') {
      if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i += 1; continue; }
      if (ch === '"') quote = null;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '(' && s[i + 1] === '(') arith = true;
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const op = arith ? null : heredocOperator(s, i);
      if (!op) {
        ok = false; // unreadable: leave it, and the lines after it, in the text
      } else {
        pending.push({ delim: op.delim, strip: op.strip, quoted: op.quoted, sink: heredocSink(s, lineStart, i, i + op.raw.length) });
        ops.push({ ...op, at: out.length });
        out += op.raw;
        i += op.raw.length - 1;
        continue;
      }
    }
    if (ch === '\n') {
      out += ch;
      let j = i + 1;
      for (const p of pending) {
        const body = [];
        while (j <= s.length) {
          const e = s.indexOf('\n', j);
          const line = s.slice(j, e < 0 ? s.length : e);
          j = e < 0 ? s.length + 1 : e + 1;
          if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break;
          body.push(line);
        }
        if (p.sink === 'shell') shell.push(body.join('\n'));
        else {
          if (p.sink === 'interp') interp.push(body.join('\n'));
          if (!p.quoted) {
            const x = bodyExpansions(body.join('\n'));
            shell.push(...x.code);
            subst ||= x.expands;
          }
        }
      }
      if (pending.length) { pending.length = 0; i = j - 1; }
      lineStart = i + 1;
      continue;
    }
    out += ch;
  }
  return { text: out, shellCode: shell.join('\n'), interpCode: interp.join('\n'), subst, ops, ok };
}

/** A script inside the installed plugin (cache or CLAUDE_PLUGIN_ROOT): the kit's own code, not the agent's. */
const kitScript = (w, ctx) => SCRIPT_FILE.test(w) && protectedPath(w, ctx) === 'plugin';

/**
 * #71 L2: an interpreter at simple[i] whose code may be a GitHub client or touch settings. A run of
 * the kit's own script (`node <plugin>/…/mnt-fp.mjs …`) is exempt. Code is the whole command when the
 * interpreter reads its program from stdin (no script, no inline flag, or `-`), else its own words;
 * plus any heredoc fed to an interpreter. #85 L1: the code is also scanned as shell words with
 * quotes, brackets and commas turned into spaces, so subprocess.run(['gh','pr','merge','5']) reads as
 * `gh pr merge 5`. -> deny reasons.
 */
function interpreterFindings(simple, i, text, interpCode, ctx, depth, subst) {
  let mode = 'stdin';
  let script = null;
  const name = cmdName(simple[i]);
  for (let j = i + 1; j < simple.length; j += 1) {
    const a = simple[j];
    if (INLINE_FLAG.test(a)) { mode = 'inline'; break; }
    if (a === '-') break;
    if (a.startsWith('-')) continue;
    if (['run', 'x', 'exec'].includes(a) && /^(deno|bun)$/.test(name)) continue; // deno/bun subcommands
    if (a === 'eval') { mode = 'inline'; break; }
    mode = 'script';
    script = a;
    break;
  }
  if (mode === 'script' && kitScript(script, ctx)) return [];
  const code = `${mode === 'stdin' ? text : simple.slice(i + 1).join(' ')}\n${interpCode}`;
  const found = [];
  const roots = [ctx.env?.CLAUDE_PLUGIN_ROOT, ctx.env?.CLAUDE_CONFIG_DIR].filter(Boolean);
  if (GITHUB_LIB.test(code)) found.push(`${name} running GitHub client code (Octokit, PyGithub, …)`);
  if (GITHUB_WEB.test(code) && WRITEISH.test(code)) found.push(`${name} code that calls github.com`);
  if (SETTINGS_TEXT.test(code) || roots.some((r) => code.includes(r))) found.push(`${name} code that names a protected settings, git config or plugin path`);
  if (depth < 3) found.push(...bashFindings(code.replace(/['"`[\](),]/g, ' '), ctx, depth + 1, subst, { skipInterpreters: true }).map((f) => `${name} code: ${f}`));
  return found;
}

/** Every reason to deny `cmd` in a singleton session (nested quoted commands too). */
export function bashFindings(cmd, ctx = {}, depth = 0, outerSubst = false, opts = {}) {
  const found = [];
  // Interpreter code re-scanned as words (opts.skipInterpreters) is already flat: no heredocs to split.
  const { text, shellCode, interpCode, subst: hereSubst } = opts.skipInterpreters ? { text: String(cmd ?? ''), shellCode: '', interpCode: '', subst: false } : splitHeredocs(cmd);
  const l = lex(shellCode ? `${text}\n${shellCode}` : text);
  const subst = outerSubst || l.subst || hereSubst;
  for (const [simpleIndex, simple] of l.words.entries()) {
    const at = commandIndices(simple);
    const head = cmdName(simple[at[0] ?? 0] ?? '');
    const reading = READ_TOOLS.has(head);
    const ran = executedScript(simple, simpleIndex);
    const kitRun = ran >= 0 && protectedPath(simple[ran], ctx) === 'plugin';
    const exp = l.exp[simpleIndex] ?? [];
    const uexp = l.uexp[simpleIndex] ?? [];
    const lead = l.lead[simpleIndex] ?? [];
    for (const c of at) {
      const n = cmdName(simple[c]);
      // #85 F2: NAME=value may prefix a kit script, never gh or git (GIT_CONFIG_*, GIT_SSH_COMMAND, GH_TOKEN …).
      if ((n === 'gh' || n === 'git') && simple.slice(0, c).some((w) => ASSIGNMENT.test(w))) found.push(`an environment assignment before ${n}`);
    }
    for (let i = 0; i < simple.length; i += 1) {
      const w = simple[i];
      if (/\s/.test(w) && depth < 3) found.push(...bashFindings(w, ctx, depth + 1, subst, opts));
      const b = cmdName(w);
      let hit = null;
      if (b === 'gh') {
        hit = ghVerdict(simple.slice(i + 1), { exp: exp.slice(i + 1), uexp: uexp.slice(i + 1), lead: lead.slice(i + 1), subst,
          appended: simple.slice(0, i).some((x) => ['xargs', 'parallel'].includes(cmdName(x))) });
      } else if (b === 'hub') hit = 'hub (another GitHub client; reads and writes go through gh here)';
      else if (b === 'git') hit = gitVerdict(simple.slice(i + 1));
      else if (HTTP_CLIENTS.has(b)) hit = httpVerdict(simple.slice(i + 1));
      else hit = fleetMsgSendVerdict(simple, i);
      if (hit) found.push(hit);
      // #85 F1: an interpreter only where it runs, never as a READ_TOOL's argument (grep -rn python3 …).
      if (!opts.skipInterpreters && !reading && at.includes(i) && INTERPRETER.test(b)) found.push(...interpreterFindings(simple, i, text, interpCode, ctx, depth, subst));
      if (/(^|[/@.])(api|uploads)\.github\.com/i.test(w)) found.push('a command that names the GitHub API host');
      if (FENCED_SCRIPTS.has(b) && !reading) {
        found.push(`${b} not run as one plain command (the heartbeat needs --state-dir; gate-request.sh only under guard; a heredoc on it needs a quoted delimiter, <<'EOF'; only 2>&1, | jq, | cat or ; echo $? may follow)`);
      }
      if (!reading && i !== ran) {
        // A plugin path handed to a kit script is a read (its --config); settings and git config never are.
        const kinds = pathTokens(w).map((t) => protectedPath(t, ctx)).filter(Boolean);
        if (kinds.some((k) => !(k === 'plugin' && kitRun))) found.push(`a write to a protected settings, git config or plugin path (${w})`);
      }
    }
  }
  return [...new Set(found)];
}

/** Back-compat name for the findings list. */
export const githubWrites = (cmd) => bashFindings(cmd);

/** What may follow a wrapper (#85 F2): 2>&1, then | jq [flags] [filter] or | cat, then ; echo "…$?". */
const WRAPPER_TAIL = /(?:\s+2>&1)?(?:\s*\|\s*(?:cat|jq(?:\s+-[A-Za-z]+)*(?:\s+(?:'[^'\n]*'|\.[\w.[\]-]*))?))?(?:\s*;\s*echo\s+(?:"[\w =:-]*\$\?"|[\w=:-]*\$\?))?\s*$/;

/** The wrapper's rel path when `cmd` is exactly one invocation of a fenced wrapper, else null. */
export function wrapperInvocation(cmd, pluginRoot, env = process.env) {
  if (!pluginRoot) return null;
  // A heredoc of data on its stdin is fine (`… -- gh issue comment N --body-file - <<'EOF'`); one a
  // shell or interpreter reads is not.
  const { text, shellCode, interpCode, subst, ops, ok } = splitHeredocs(cmd);
  if (!ok || shellCode || interpCode || subst) return null;
  if (ops.length > 1) return null;
  // #106: an UNQUOTED delimiter makes the shell expand $VAR, ${…} and $[…] in the body, so a fenced
  // post could carry any secret in the session env. Only <<'EOF', <<"EOF" or <<\EOF passes.
  if (ops[0] && !ops[0].quoted) return null;
  // The operator, cut out where splitHeredocs placed it (#110: the same parse bash makes).
  const bare = ops[0] ? text.slice(0, ops[0].at) + ' ' + text.slice(ops[0].at + ops[0].raw.length) : text;
  const l = lex(bare.trim().replace(WRAPPER_TAIL, ''));
  if (!l.ok || l.subst || l.ops || l.words.length !== 1) return null;
  const words = [...l.words[0]];
  if (words[0] === 'bash') words.shift();
  const exe = words[0] && expandHome(words[0], env.HOME || os.homedir());
  if (!exe || !path.isAbsolute(exe)) return null;
  let root;
  let real;
  try { root = fs.realpathSync(pluginRoot); real = fs.realpathSync(exe); } catch { return null; }
  const rel = path.relative(path.join(root, 'skills'), real).split(path.sep).join('/');
  if (!WRAPPERS.has(rel)) return null;
  // L-a: the heartbeat without a renew is no fence.
  if (HEARTBEATS.has(rel) && !words.some((w) => w === '--state-dir' || w.startsWith('--state-dir='))) return null;
  return rel;
}

function denyMessage(role, found) {
  const wrapper = role === 'merge' ? 'merge-monster/scripts/mm-act.sh' : 'maintenance-monster/scripts/mnt-act.sh';
  return `engsys singleton-write guard: this ${role} monster session only reads GitHub directly (found: ${found.join('; ')}). `
    + `Writes go through ONE plain command: <engsys-root>/skills/${wrapper} guard --repo <repo> --state-dir <state_dir> -- gh <args…>`
    + `${role === 'merge' ? '; merges as mm-act.sh merge --pr N --sha <validated head> --method merge|squash' : ''}`
    + '; a push as … guard --pr N -- git -C <worktree> push --force-with-lease origin HEAD:refs/heads/<PR head branch>. '
    + 'No ;, &&, redirects, $( ) or backticks around it (2>&1, | jq, | cat and ; echo $? may follow); a heredoc body needs a quoted delimiter (<<\'EOF\'), since an unquoted one expands $VAR into the post. If the fence refuses, do not act (SKILL.md § The baton). '
    + 'Dispatched agents never write to GitHub themselves: they hand the act back to the monster. Settings, git config and plugin files are read-only here.';
}

/** -> null (no opinion) or { deny: reason }. */
export function decide({ tool_name: tool = 'Bash', tool_input: input = {}, command, env = process.env, pluginRoot = env.CLAUDE_PLUGIN_ROOT, cwd = process.cwd() }) {
  const role = env.ENGSYS_SINGLETON_ROLE;
  if (!ROLES.has(role)) return null;
  const ctx = { env, cwd };
  // #85 M1: Monitor (and any tool that runs a shell command string) is Bash for this purpose.
  const cmd = command ?? input.command;
  if (tool === 'Bash' || typeof cmd === 'string') {
    if (wrapperInvocation(cmd, pluginRoot, env)) return null;
    let found = bashFindings(cmd, ctx);
    // #110: a heredoc delimiter we can't read the way bash does could hide the commands after it.
    if (!splitHeredocs(cmd).ok && /\b(gh|git|curl|wget|hub)\b|github\.com|\.claude/i.test(String(cmd)) && !found.length) found = ['a heredoc delimiter the guard cannot read the way the shell does (quote it plainly: <<\'EOF\')'];
    if (!lex(cmd).ok && /\b(gh|git|curl|wget|hub)\b|github\.com|\.claude/i.test(String(cmd))) found = found.length ? found : ['an unparseable command that mentions gh, git, GitHub or .claude'];
    return found.length ? { deny: denyMessage(role, found) } : null;
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = input.file_path ?? input.notebook_path ?? input.path;
    return protectedPath(p, ctx) ? { deny: `engsys singleton-write guard: settings, git config and plugin files are read-only in a ${role} monster session (${p}): changing them could switch off the hooks that fence its GitHub writes, or plant a program in its push.` } : null;
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
