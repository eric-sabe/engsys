#!/usr/bin/env node
// fleet-gh-path.mjs: SessionStart hook (engsys#90). Keeps the fleet gh identity shim first on PATH
// for every Bash call, whatever the user's login shell does.
//
// Claude Code runs Bash from a snapshot of the login shell, so a `~/.zprofile` that runs
// `brew shellenv` re-prepends Homebrew ahead of the shim the launcher put in the session env, and
// bare `gh` becomes the unauthenticated Homebrew binary. $CLAUDE_ENV_FILE is sourced before every Bash
// command (after that snapshot), so a PATH export written here wins. SessionStart fires again on
// resume, clear and compact, so the line is re-checked each time and never duplicated.
//
// Acts only when the fleet identity is configured: GH_APP_ENV_FILE set (the launcher exports it
// with the shim on PATH). Fail-open: any error -> no output, exit 0.

import fs from 'node:fs';
import path from 'node:path';

export function shimDir(env = process.env) {
  if (!env.GH_APP_ENV_FILE) return null;
  for (const d of (env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    // The identity shim dir: holds an executable `gh` next to ../gh-app-token.mjs.
    if (fs.existsSync(path.join(d, '..', 'gh-app-token.mjs'))) {
      try { fs.accessSync(path.join(d, 'gh'), fs.constants.X_OK); return path.resolve(d); } catch { /* keep looking */ }
    }
  }
  if (env.ENGSYS_DIR) {
    const d = path.join(env.ENGSYS_DIR, 'core', 'fleet', 'identity', 'bin');
    if (fs.existsSync(path.join(d, 'gh'))) return d;
  }
  return null;
}

export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function exportLine(dir) {
  return `export PATH=${shellQuote(dir)}:"$PATH"`;
}

export function apply(env = process.env) {
  const file = env.CLAUDE_ENV_FILE;
  if (!file) return false;
  const dir = shimDir(env);
  if (!dir) return false;
  const line = exportLine(dir);
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* absent: created below */ }
  if (cur.split('\n').includes(line)) return false;
  fs.appendFileSync(file, `${line}\n`);
  return true;
}

try {
  if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) apply();
} catch { /* fail-open */ }
