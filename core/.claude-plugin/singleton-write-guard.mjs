#!/usr/bin/env node
// singleton-write-guard.mjs — PreToolUse(Bash) hook for the engsys core PLUGIN (engsys#62, review H1).
//
// A merge or maintenance monster holds its role through the github lease and must fence every write
// to GitHub (core/lib/lease/baton.mjs). Fleet monsters run with --dangerously-skip-permissions, so a
// permission prompt never stands between the model and a raw `gh pr merge`. Hooks still run in that
// mode, so this one is the guard rail: in a singleton-monster session it DENIES every Bash command
// that writes to GitHub unless the whole command is one invocation of a fenced wrapper:
//
//     [bash] <plugin>/skills/merge-monster/scripts/mm-act.sh … | mm-heartbeat.sh … | mm-baton.sh …
//     [bash] <plugin>/skills/maintenance-monster/scripts/mnt-act.sh … | mnt-heartbeat.sh … | mnt-baton.sh …
//
// with no chaining, pipes, redirects or command substitution anywhere in it (quoted text is fine).
//
// Active only when ENGSYS_SINGLETON_ROLE is `merge` or `maintain` (launch-agent-sessions.sh exports
// it for a session whose roster prompt runs that monster). Subagents run inside the session's process,
// so the hook covers the agents a monster dispatches too. Everything else passes silently.
//
// It raises the bar; it is not a boundary. A determined obfuscation (a script file, an interpreter,
// a variable holding the verb) gets past a lexical check. The controls are the lease itself and the
// sha-pinned merge. When active and unsure (a command it cannot parse that mentions gh or git, or an
// internal error), it denies.

import fs from 'node:fs';
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

/** gh <group> <verb> pairs that write. A group mapped to `true` writes for every verb but `list`/`view`. */
const GH_WRITES = {
  pr: new Set(['merge', 'ready', 'edit', 'close', 'reopen', 'comment', 'review', 'create', 'lock', 'unlock', 'update-branch']),
  issue: new Set(['create', 'edit', 'close', 'reopen', 'comment', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop']),
  label: true,
  workflow: new Set(['run', 'enable', 'disable']),
  run: new Set(['rerun', 'cancel', 'delete']),
  release: new Set(['create', 'edit', 'delete', 'delete-asset', 'upload']),
  repo: new Set(['edit', 'delete', 'rename', 'archive', 'unarchive', 'sync']),
  secret: new Set(['set', 'delete']),
  variable: new Set(['set', 'delete']),
  cache: new Set(['delete']),
};
const READ_VERBS = new Set(['list', 'view', 'status', 'diff', 'checks']);
/** gh flags that take a separate value (so the value is not read as a group or verb). */
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname', '-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field',
  '--input', '-q', '--jq', '-t', '--template', '-b', '--body', '--body-file', '-t', '--title', '-B', '--base', '--head', '-l', '--label',
  '--add-label', '--remove-label', '-a', '--assignee', '-m', '--milestone', '-r', '--ref', '-c', '--color', '-d', '--description',
  '--json', '-s', '--state', '-L', '--limit', '-A', '--author', '--search', '-S', '--subject', '--match-head-commit']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const SHELL_WORDS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'xargs', 'sudo', 'timeout']);

/**
 * A small quote-aware shell lexer. -> { words: [[w, …], …] (one array per simple command, split at
 * ; & | && || ( ) < > newline and backticks), subst: true when $( or a backtick appears anywhere
 * (even inside double quotes), ops: true when any operator appears outside quotes, ok: false on an
 * unbalanced quote }. Quoted strings come back as single words.
 */
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

function ghWrite(args) {
  const pos = positionals(args, GH_VALUE_FLAGS);
  const [group, verb] = pos;
  if (group === 'api') {
    let method = null;
    let fields = false;
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '-X' || a === '--method') method = String(args[i + 1] ?? '').toUpperCase();
      else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
      else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2).toUpperCase();
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(raw-)?field=|^--input=/.test(a) || /^-[fF].+/.test(a)) fields = true;
    }
    if (verb === 'graphql') return args.some((a) => /\bmutation\b/.test(a)) ? 'gh api graphql mutation' : null;
    if (method && method !== 'GET') return `gh api -X ${method}`;
    if (!method && fields) return 'gh api with fields (POST)';
    return null;
  }
  const writes = GH_WRITES[group];
  if (!writes) return null;
  if (writes === true) return verb && !READ_VERBS.has(verb) ? `gh ${group} ${verb}` : null;
  return writes.has(verb) ? `gh ${group} ${verb}` : null;
}

function gitWrite(args) {
  const pos = positionals(args, GIT_VALUE_FLAGS);
  return pos[0] === 'push' ? 'git push' : null;
}

/** Every GitHub write found in `cmd` (nested quoted commands too, e.g. `bash -c "gh pr merge 1"`). */
export function githubWrites(cmd, depth = 0) {
  const found = [];
  const { words } = lex(cmd);
  for (const simple of words) {
    for (let i = 0; i < simple.length; i += 1) {
      const w = simple[i];
      if (/\s/.test(w) && depth < 3) found.push(...githubWrites(w, depth + 1));
      const b = base(w);
      if (b === 'gh') { const hit = ghWrite(simple.slice(i + 1)); if (hit) found.push(hit); }
      if (b === 'git') { const hit = gitWrite(simple.slice(i + 1)); if (hit) found.push(hit); }
    }
  }
  return [...new Set(found)];
}

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
  return WRAPPERS.has(rel) ? rel : null;
}

/** -> null (no opinion) or { deny: reason }. */
export function decide({ command, env = process.env, pluginRoot = env.CLAUDE_PLUGIN_ROOT }) {
  const role = env.ENGSYS_SINGLETON_ROLE;
  if (!ROLES.has(role)) return null;
  const l = lex(command);
  let writes = githubWrites(command);
  if (!l.ok && /\b(gh|git)\b/.test(String(command))) writes = writes.length ? writes : ['an unparseable command that mentions gh or git'];
  if (!writes.length) return null;
  if (wrapperInvocation(command, pluginRoot)) return null;
  const wrapper = role === 'merge' ? 'merge-monster/scripts/mm-act.sh' : 'maintenance-monster/scripts/mnt-act.sh';
  return {
    deny: `engsys singleton-write guard: this ${role} monster session writes to GitHub only through its fenced wrapper (found: ${writes.join(', ')}). `
      + `Run it as ONE command: <engsys-root>/skills/${wrapper} guard --repo <repo> --state-dir <state_dir> -- <the gh or git push command>`
      + `${role === 'merge' ? ', and merges as mm-act.sh merge --pr N --sha <validated head> --method merge|squash' : ''}. `
      + 'No ;, &&, |, redirects, $( ) or backticks around it. If the fence refuses, do not act (SKILL.md § The baton). '
      + 'Dispatched agents never write to GitHub themselves: they hand the push back to the monster.',
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { input = null; }
  if (!input || input.tool_name !== 'Bash') return;
  let d;
  try {
    d = decide({ command: input.tool_input && input.tool_input.command });
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
