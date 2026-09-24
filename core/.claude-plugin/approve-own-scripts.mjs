#!/usr/bin/env node
// approve-own-scripts.mjs — PreToolUse(Bash) hook for the engsys core PLUGIN.
//
// Plugin scripts live under a per-user, per-version cache path, so no static permission rule can
// pre-approve them portably. This hook auto-approves exactly ONE shape of command:
//
//     [bash] <literal path to an allowlisted engsys bookkeeping script> <args…> [&]
//
// i.e. a single invocation whose executable resolves (symlinks included) to one of the scripts in
// ALLOWED below, inside THIS plugin's root. Anything else — shell variables, `cd`/`&&`/`;` chaining,
// pipes, redirects, subshells, globs, escapes, unbalanced quotes, other scripts — produces no output,
// so Claude Code's normal permission flow applies. Deny and ask rules are still evaluated on top of
// an "allow" from this hook. Fail-closed: any error → no output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Low-risk bookkeeping only: liveness registry + watchdog, GitHub watch/snapshot, ledger heartbeat,
// merge preflight, session-sync. Setup (creates labels/ledgers) and session launch/supervision are
// deliberately NOT here — those stay behind a human prompt.
export const ALLOWED = new Set([
  'merge-monster/scripts/mm-agent-reg.sh',
  'merge-monster/scripts/mm-agent-watch.sh',
  'merge-monster/scripts/mm-watch.sh',
  'merge-monster/scripts/mm-snapshot.sh',
  'merge-monster/scripts/mm-heartbeat.sh',
  'merge-monster/scripts/mm-preflight.sh',
  'merge-monster/scripts/mm-session-sync.sh',
  'maintenance-monster/scripts/mnt-watch.sh',
  'maintenance-monster/scripts/mnt-snapshot.sh',
  'maintenance-monster/scripts/mnt-heartbeat.sh',
]);

// Characters that can chain, redirect, substitute, expand, or escape. Rejected anywhere (after an
// optional single trailing background `&` is removed and line continuations are joined).
const FORBIDDEN = /[\n\r;|&<>`$\\*?[\]{}~!()]/;

function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let inToken = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) return null; // unbalanced
  if (inToken) out.push(cur);
  return out;
}

/** Returns the allowlisted script's relative path if `command` is an approvable invocation, else null. */
export function approvable(command, pluginRoot) {
  if (typeof command !== 'string' || !pluginRoot) return null;
  let cmd = command.replace(/\\\r?\n/g, ' ').trim(); // join `\`-newline continuations
  if (/(^|[^&])&$/.test(cmd)) cmd = cmd.slice(0, -1).trim(); // one trailing background `&`
  if (!cmd || FORBIDDEN.test(cmd)) return null;
  const tokens = tokenize(cmd);
  if (!tokens || tokens.length === 0) return null;
  if (tokens[0] === 'bash') tokens.shift();
  const exe = tokens[0];
  if (!exe || !path.isAbsolute(exe)) return null;

  let root;
  try { root = fs.realpathSync(pluginRoot); } catch { return null; }
  const skillsDir = path.join(root, 'skills');
  let real;
  try { real = fs.realpathSync(path.resolve(exe)); } catch { return null; }
  const rel = path.relative(skillsDir, real).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel) || !ALLOWED.has(rel)) return null;
  return rel;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input.tool_name !== 'Bash') return;
  const rel = approvable(input.tool_input && input.tool_input.command, process.env.CLAUDE_PLUGIN_ROOT);
  if (!rel) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `engsys: own bookkeeping script (${rel}) invoked by literal path`,
    },
  }));
}

// Run as a hook only when executed directly (tests import approvable()).
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}
