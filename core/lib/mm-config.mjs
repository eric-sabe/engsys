#!/usr/bin/env node
// mm-config.mjs — where a repo's merge-monster config lives when it is not in the repo (engsys#229).
//
//   mm-config.mjs resolve (--repo owner/name | --cwd DIR) [--config-dir DIR]...
//     → {"slug":"o/n","configs":[abs paths of readable merge-monster.yml],"fleetDirs":[abs repos/<o>/<n> dirs],
//        "fleetManaged":bool,"missing":bool}
//
// A fleet's instance plugin carries per-repo config at <plugin root>/repos/<owner>/<repo>/ (the same directory the
// plugin's SessionStart hook injects as `fleet config dir: ...`, core/fleet/scaffold/plugin/hooks/fleet-context.sh).
// A plugin root is found, in each Claude config dir, from plugins/installed_plugins.json (every installPath); only
// when that gives none is plugins/cache/<marketplace>/<plugin>/<version>/ walked (old versions stay on disk there).
// `fleetManaged` is true when any plugin has a repos/<owner>/<repo>/ directory; `missing` when it is fleet-managed but
// no merge-monster.yml in it is a readable file, so callers can fail closed instead of silently staying opt-in.
// Config dirs default to defaultConfigDirs(): $CLAUDE_CONFIG_DIR plus the fleet's known dirs ($FLEET_CLAUDE_CONFIG_DIR, the
// per-session dirs beside it, ~/.claude), all searched, so a session cannot hide the config by repointing one variable.
// Directory names match case-insensitively, by listing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function slugFromUrl(url) {
  const s = String(url || '').trim().replace(/\.git\/?$/, '').replace(/\/+$/, '').replace(/^.*[:/]([^:/]+\/[^:/]+)$/, '$1');
  return SLUG_RE.test(s) ? s : '';
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function readable(p) { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }

/** Plugin roots installed under one Claude config dir. */
export function pluginRoots(configDir) {
  const roots = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = j && typeof j.plugins === 'object' && j.plugins ? Object.values(j.plugins) : Object.values(j || {});
    for (const list of entries) for (const e of Array.isArray(list) ? list : []) if (e && typeof e.installPath === 'string' && isDir(e.installPath)) roots.add(fs.realpathSync(e.installPath));
  } catch { /* no list: the cache walk below */ }
  if (roots.size) return [...roots]; // the list decides; the cache holds stale versions of every plugin too
  // fallback, with no usable list: each read failure stays local to its own entry: a stray file (.DS_Store, a lock) must not hide the other roots
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const cache = path.join(configDir, 'plugins', 'cache');
  for (const m of ls(cache)) for (const p of ls(path.join(cache, m))) for (const v of ls(path.join(cache, m, p))) {
    const r = path.join(cache, m, p, v);
    if (isDir(r)) roots.add(fs.realpathSync(r));
  }
  return [...roots];
}

/** Entries of `parent` whose name equals `name` ignoring case (a listing, so it also works on a case-sensitive filesystem). */
function ciChildren(parent, name) {
  const want = name.toLowerCase();
  try { return fs.readdirSync(parent).filter((e) => e.toLowerCase() === want).map((e) => path.join(parent, e)); } catch { return []; }
}

/**
 * The Claude config dirs a fleet session's plugins can be found in: the inherited $CLAUDE_CONFIG_DIR, and the fleet's
 * known dirs, so a session that points CLAUDE_CONFIG_DIR somewhere empty does not escape: $FLEET_CLAUDE_CONFIG_DIR, every
 * dir under its `.sessions` sibling (per-session dirs) and under $ENGSYS_CONFIG_DIR_SESSIONS, and ~/.claude.
 */
export function defaultConfigDirs(env = process.env) {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  const sessionsOf = (d) => { try { for (const e of fs.readdirSync(d)) if (isDir(path.join(d, e))) add(path.join(d, e)); } catch { /* none */ } };
  add(env.CLAUDE_CONFIG_DIR);
  if (env.FLEET_CLAUDE_CONFIG_DIR) { add(env.FLEET_CLAUDE_CONFIG_DIR); sessionsOf(`${env.FLEET_CLAUDE_CONFIG_DIR.replace(/\/+$/, '')}.sessions`); }
  if (env.ENGSYS_CONFIG_DIR_SESSIONS) sessionsOf(env.ENGSYS_CONFIG_DIR_SESSIONS);
  add(path.join(env.HOME || os.homedir(), '.claude'));
  return dirs;
}

export function resolve({ slug, configDirs }) {
  const fleetDirs = [];
  const configs = [];
  const seen = new Set(); // by inode: a case-insensitive filesystem answers every spelling of the slug with one directory
  const [owner, name] = slug.split('/');
  for (const d of configDirs) {
    for (const root of pluginRoots(d)) {
      for (const ownerDir of ciChildren(path.join(root, 'repos'), owner)) {
        for (const dir of ciChildren(ownerDir, name)) {
          if (!isDir(dir)) continue;
          const st = fs.statSync(dir);
          const key = `${st.dev}:${st.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const real = fs.realpathSync(dir);
          fleetDirs.push(real);
          const cfg = path.join(real, 'merge-monster.yml');
          if (isFile(cfg) && readable(cfg)) configs.push(cfg);
        }
      }
    }
  }
  return { slug, configs, fleetDirs, fleetManaged: fleetDirs.length > 0, missing: fleetDirs.length > 0 && configs.length === 0 };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let repo = ''; let cwd = ''; const dirs = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--repo') repo = rest[++i] ?? '';
    else if (rest[i] === '--cwd') cwd = rest[++i] ?? '';
    else if (rest[i] === '--config-dir') dirs.push(rest[++i] ?? '');
    else { process.stderr.write(`unknown argument: ${rest[i]}\n`); process.exit(2); }
  }
  if (cmd !== 'resolve' || (!repo && !cwd)) { process.stderr.write('usage: mm-config.mjs resolve (--repo O/N | --cwd DIR) [--config-dir DIR]...\n'); process.exit(2); }
  let slug = repo;
  if (!slug) {
    try { slug = slugFromUrl(execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })); } catch { slug = ''; }
  }
  if (!SLUG_RE.test(slug)) { process.stdout.write(`${JSON.stringify({ slug: '', configs: [], fleetDirs: [], fleetManaged: false, missing: false })}\n`); return; }
  const configDirs = dirs.filter(Boolean);
  if (!configDirs.length) configDirs.push(...defaultConfigDirs());
  process.stdout.write(`${JSON.stringify(resolve({ slug, configDirs }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
