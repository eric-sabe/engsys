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
// when that gives none is plugins/cache/<marketplace>/<plugin>/<version>/ walked (old versions stay on disk there). The directory name is tried as the slug and lowercased.
// `fleetManaged` is true when any plugin has a repos/<owner>/<repo>/ directory; `missing` when it is fleet-managed but
// no merge-monster.yml in it is a readable file, so callers can fail closed instead of silently staying opt-in.
// Config dirs default to $CLAUDE_CONFIG_DIR, else ~/.claude.
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

export function resolve({ slug, configDirs }) {
  const fleetDirs = [];
  const configs = [];
  const seen = new Set(); // by inode: a case-insensitive filesystem answers both spellings of the slug with one directory
  for (const d of configDirs) {
    for (const root of pluginRoots(d)) {
      for (const cand of [slug, slug.toLowerCase()]) {
        const dir = path.join(root, 'repos', cand);
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
  if (!configDirs.length) configDirs.push(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  process.stdout.write(`${JSON.stringify(resolve({ slug, configDirs }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
