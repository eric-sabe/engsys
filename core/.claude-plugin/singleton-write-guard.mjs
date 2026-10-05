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
//                   api graphql with an inline, visible query that is not a mutation: no field the
//                   shell expands ($VAR, $( ), backticks) and no substitution anywhere in the command,
//                   and never a merge mutation (#71 L1); gh api never fed by xargs or parallel.
//                   Anything else, including aliases and extensions, is denied.
//            hub    never (another GitHub client).
//            git    a known local or read subcommand (status, log, diff, fetch, commit, rebase, …);
//                   never push, config writes, remote changes, aliases or a -c outside a short list.
//            curl, wget, http, xh …  never towards github.com; and no command may name
//                   api.github.com or uploads.github.com at all.
//            node, python, ruby, perl, deno, bun, npx   not when their code (inline, a heredoc, stdin
//                   or their arguments) names Octokit/PyGithub, calls github.com with a write-ish
//                   verb, or names a protected path; running the kit's own scripts is fine (#71 L2).
//          The fenced wrappers and gate-request.sh run only as that one plain invocation. Nor may a
//          command touch a settings file (.claude/settings*.json, managed-settings.json, the .claude
//          dir itself), git config (.git/config, ~/.gitconfig) or the plugin cache except to read
//          it; a path glued to code (`open('.claude/settings.json','w')`) counts.
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

/**
 * A small shell lexer: simple commands split on ; & | < > ( ) and newlines. `subst` is set by a
 * command or process substitution anywhere ($( ), backticks, <( ), >( )), quoted or not. `exp`
 * parallels `words`: true for a word whose text the shell would expand ($ or a backtick outside
 * single quotes), so what the lexer sees is not what the command receives.
 */
export function lex(cmd) {
  const s = String(cmd ?? '');
  const commands = [[]];
  const exps = [[]];
  let cur = '';
  let inWord = false;
  let curExp = false;
  let quote = null;
  let subst = false;
  let ops = false;
  const end = () => {
    if (inWord) { commands[commands.length - 1].push(cur); exps[exps.length - 1].push(curExp); cur = ''; inWord = false; curExp = false; }
  };
  const split = () => { end(); ops = true; if (commands[commands.length - 1].length) { commands.push([]); exps.push([]); } };
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
      if (ch === '`' || (ch === '$' && i + 1 < s.length && s[i + 1] !== '"')) curExp = true;
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
    if ((ch === '<' || ch === '>') && s[i + 1] === '(') subst = true; // process substitution
    if (';&|<>()\n\r'.includes(ch)) { split(); continue; }
    if (ch === '$' && i + 1 < s.length && !' \t\n'.includes(s[i + 1])) curExp = true; // $VAR, ${…}, $'…' (ANSI-C)
    cur += ch;
    inWord = true;
  }
  if (quote) return { words: commands, exp: exps, subst, ops, ok: false };
  end();
  const keep = commands.map((c, i) => [c, exps[i]]).filter(([c]) => c.length);
  return { words: keep.map(([c]) => c), exp: keep.map(([, e]) => e), subst, ops, ok: true };
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
  // #71 L3: git config a planted credential helper, ssh command or proxy could live in.
  if (/(^|\/)\.git\/(config|config\.worktree|worktrees\/[^/]+\/config\.worktree)$/.test(abs)) return true;
  if (abs === path.join(home, '.gitconfig') || abs === path.join(env.XDG_CONFIG_HOME ? path.resolve(expandHome(env.XDG_CONFIG_HOME, home)) : path.join(home, '.config'), 'git', 'config')) return true;
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

/** Words that may hold a path glued to code or punctuation (`open('.claude/settings.json','w')`). */
function pathTokens(w) {
  return [w, ...w.split(/[\s'"`(),;=:<>|&{}[\]+]+/).filter((t) => t && t !== w)];
}

/** The fenced wrappers and gate-request.sh: they run only as one plain wrapper invocation (gate-request under guard). */
const FENCED_SCRIPTS = new Set([...WRAPPERS, 'merge-monster/scripts/gate-request.sh'].map((rel) => rel.split('/').pop()));

/** Interpreters that can run GitHub client code inline, from stdin or from a script (#71 L2). */
const INTERPRETER = /^(node|nodejs|python[0-9.]*|ruby|perl|deno|bun|bunx|npx)$/;
/** Flags that make the next argument inline code (node -e/-p, python -c, ruby/perl -e/-E, clusters such as -ne). */
const INLINE_FLAG = /^(-[A-Za-z]*[ceE]|-p|--eval|--print|--eval=.*|--print=.*)$/;
/** Text that marks interpreter code as a GitHub client. */
const GITHUB_LIB = /octokit|PyGithub|from\s+github\s+import|import\s+github\b|Net::GitHub|Pithub|\bghapi\b/i;
const GITHUB_WEB = /github\.com\//i;
const WRITEISH = /\b(PUT|POST|PATCH|DELETE|method|urlopen|fetch|requests?|axios|got|Request|HTTPSConnection|Net::HTTP|LWP|HTTP::Tiny|merge|push|graphql|mutation|authorization|token)\b/i;
/** Protected paths in code; a monster's own config (`.claude/merge-monster.yml`) is not one. */
const SETTINGS_TEXT = /\.claude(?!\/[\w.-]+\.(?:ya?ml|md)\b)|managed-settings|\.gitconfig\b|\.git\/(config|worktrees)\b|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR/;

/** The bodies of every heredoc in `cmd` (so code fed on stdin is seen whoever reads it). */
function heredocBodies(cmd) {
  const out = [];
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?:\n|$)|$)/g;
  let m;
  while ((m = re.exec(String(cmd)))) out.push(m[3]);
  const here = /<<<\s*(\S+)/g;
  while ((m = here.exec(String(cmd)))) out.push(m[1]);
  return out.join('\n');
}

/** A script inside the installed plugin (cache or CLAUDE_PLUGIN_ROOT): the kit's own code, not the agent's. */
const kitScript = (w, ctx) => SCRIPT_FILE.test(w) && protectedPath(w, ctx);

/**
 * #71 L2: an interpreter at simple[i] whose code may be a GitHub client or touch settings. A run of
 * the kit's own script (`node <plugin>/…/mnt-fp.mjs …`) is exempt. Code is the whole command when the
 * interpreter reads its program from stdin (no script, no inline flag, or `-`), else its own words
 * plus any heredoc. -> deny reason or null.
 */
function interpreterVerdict(simple, i, cmd, ctx) {
  let mode = 'stdin';
  let script = null;
  for (let j = i + 1; j < simple.length; j += 1) {
    const a = simple[j];
    if (INLINE_FLAG.test(a)) { mode = 'inline'; break; }
    if (a === '-') break;
    if (a.startsWith('-')) continue;
    if (['run', 'x', 'exec'].includes(a) && /^(deno|bun)$/.test(base(simple[i]))) continue; // deno/bun subcommands
    if (a === 'eval') { mode = 'inline'; break; }
    mode = 'script';
    script = a;
    break;
  }
  if (mode === 'script' && kitScript(script, ctx)) return null;
  const text = mode === 'stdin' ? String(cmd) : `${simple.slice(i).join(' ')}\n${heredocBodies(cmd)}`;
  const roots = [ctx.env?.CLAUDE_PLUGIN_ROOT, ctx.env?.CLAUDE_CONFIG_DIR].filter(Boolean);
  if (GITHUB_LIB.test(text)) return `${base(simple[i])} running GitHub client code (Octokit, PyGithub, …)`;
  if (GITHUB_WEB.test(text) && WRITEISH.test(text)) return `${base(simple[i])} code that calls github.com`;
  if (SETTINGS_TEXT.test(text) || roots.some((r) => text.includes(r))) return `${base(simple[i])} code that names a protected settings, git config or plugin path`;
  return null;
}

/** Every reason to deny `cmd` in a singleton session (nested quoted commands too). */
export function bashFindings(cmd, ctx = {}, depth = 0, outerSubst = false) {
  const found = [];
  const l = lex(cmd);
  const subst = outerSubst || l.subst;
  for (const [simpleIndex, simple] of l.words.entries()) {
    const head = base(simple[0] ?? '');
    const exp = l.exp[simpleIndex] ?? [];
    for (let i = 0; i < simple.length; i += 1) {
      const w = simple[i];
      if (/\s/.test(w) && depth < 3) found.push(...bashFindings(w, ctx, depth + 1, subst));
      const b = base(w);
      let hit = null;
      if (b === 'gh') hit = ghVerdict(simple.slice(i + 1), { exp: exp.slice(i + 1), subst, appended: simple.slice(0, i).some((x) => ['xargs', 'parallel'].includes(base(x))) });
      else if (b === 'hub') hit = 'hub (another GitHub client; reads and writes go through gh here)';
      else if (b === 'git') hit = gitVerdict(simple.slice(i + 1));
      else if (HTTP_CLIENTS.has(b)) hit = httpVerdict(simple.slice(i + 1));
      else if (INTERPRETER.test(b)) hit = interpreterVerdict(simple, i, cmd, ctx);
      if (hit) found.push(hit);
      if (/(^|[/@.])(api|uploads)\.github\.com/i.test(w)) found.push('a command that names the GitHub API host');
      if (FENCED_SCRIPTS.has(b) && !READ_TOOLS.has(head)) {
        found.push(`${b} not run as one plain command (no ;, &&, |, redirects or substitution; the heartbeat needs --state-dir; gate-request.sh only under guard)`);
      }
      if (!READ_TOOLS.has(head) && !scriptExecution(simple, i, simpleIndex) && pathTokens(w).some((t) => protectedPath(t, ctx))) {
        found.push(`a write to a protected settings, git config or plugin path (${w})`);
      }
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
