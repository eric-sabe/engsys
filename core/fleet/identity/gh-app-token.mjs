#!/usr/bin/env node
// gh-app-token.mjs — mint (and cache) a GitHub App installation token for a fleet's bot identity
// (for example `acme-fleet[bot]`). Zero dependencies: node builtins only.
//
// Installation tokens live 1 hour. Fleet sessions are long-lived, so a token baked into their
// environment at launch would go stale; instead every `gh` / `git` call asks this helper, which
// returns the cached token while it has > REFRESH_MARGIN left and re-mints otherwise.
//
// Modes:
//   gh-app-token.mjs                       print a valid token
//   gh-app-token.mjs --refresh             force a re-mint, print it
//   gh-app-token.mjs --check               mint fresh + verify permissions against the API; print status
//                                          (exit 3 = token works but permissions are short)
//   gh-app-token.mjs git-credential <op>   git credential-helper protocol (op = get|store|erase)
//
// Config: an env file named by GH_APP_ENV_FILE (required; there is no default location) providing
// GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PEM. Optional keys: GH_APP_REQUIRED_PERMS (comma list of
// perm:level for --check), GH_APP_CACHE (cache file path), FLEET_ORG (cache directory name).
// Values already present in the process environment win over the file.
// Cache: ~/.cache/<FLEET_ORG or "engsys-fleet">/gh-app-token-<installation id>.json (dir 700, file 600).
// No token is ever written anywhere else. See README.md next to this file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_API = 'https://api.github.com';
const USER_AGENT = 'engsys-fleet';
const DOCS = 'core/fleet/identity/README.md';

// Repo-level permissions a fleet needs by default. Orgs that also use org Projects, Dependabot alerts,
// code scanning or Code quality list the extra ones in GH_APP_REQUIRED_PERMS (see README.md).
export const DEFAULT_REQUIRED_PERMS = {
  contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write', workflows: 'write',
  checks: 'read', statuses: 'read', metadata: 'read',
};
const RANK = { read: 1, write: 2, admin: 3 };

function die(msg, code = 1) {
  process.stderr.write(`gh-app-token: ${msg}\n`);
  process.exit(code);
}

// --- pure helpers (exported for tests) --------------------------------------------------------

/** Parse KEY=VALUE lines (optional `export `, `#` comments, one layer of surrounding quotes). */
export function parseEnvFile(text) {
  const cfg = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    cfg[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return cfg;
}

/** "contents:write, checks:read" -> { contents: 'write', checks: 'read' }. Throws on a malformed entry. */
export function parseRequiredPerms(str) {
  const out = {};
  for (const part of String(str).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([a-z_]+):(read|write|admin)$/);
    if (!m) throw new Error(`invalid GH_APP_REQUIRED_PERMS entry "${p}" (want perm:level, level = read|write|admin)`);
    out[m[1]] = m[2];
  }
  return out;
}

/** Permissions in `required` that `have` does not satisfy, as "perm:level (has X|none)". A higher level satisfies a lower one. */
export function missingPermissions(have, required) {
  const h = have || {};
  return Object.entries(required)
    .filter(([k, need]) => (RANK[h[k]] || 0) < RANK[need])
    .map(([k, need]) => `${k}:${need} (has ${h[k] || 'none'})`);
}

/** Where the token cache lives. `cfg.GH_APP_CACHE` overrides; `custom` tells the caller not to chmod the directory. */
export function cachePath(cfg, home = os.homedir()) {
  const expand = (p) => p.replace(/^~(?=\/|$)/, home);
  if (cfg.GH_APP_CACHE) return { file: expand(cfg.GH_APP_CACHE), custom: true };
  const org = cfg.FLEET_ORG || 'engsys-fleet';
  return { file: path.join(home, '.cache', org, `gh-app-token-${cfg.GH_APP_INSTALLATION_ID}.json`), custom: false };
}

export function apiBase(env = process.env) {
  return (env.GH_APP_API_URL || DEFAULT_API).replace(/\/+$/, '');
}

// --- config -----------------------------------------------------------------------------------

function loadConfig() {
  const home = os.homedir();
  const envFile = process.env.GH_APP_ENV_FILE;
  if (!envFile) {
    die('GH_APP_ENV_FILE is not set — point it at the GitHub App env file (shape in ' + DOCS + ')');
  }
  const file = envFile.replace(/^~(?=\/)/, home);
  if (!fs.existsSync(file)) die(`env file not found: ${file} (GH_APP_ENV_FILE)`);
  const cfg = parseEnvFile(fs.readFileSync(file, 'utf8'));
  for (const k of ['GH_APP_ID', 'GH_APP_INSTALLATION_ID', 'GH_APP_PEM', 'GH_APP_REQUIRED_PERMS', 'GH_APP_CACHE', 'FLEET_ORG']) {
    if (process.env[k]) cfg[k] = process.env[k];
  }
  for (const k of ['GH_APP_ID', 'GH_APP_INSTALLATION_ID', 'GH_APP_PEM']) {
    if (!cfg[k]) die(`${k} not set (env file: ${file})`);
  }
  cfg.GH_APP_PEM = cfg.GH_APP_PEM.replace(/^~(?=\/)/, home);
  return cfg;
}

function appJwt(appId, pemPath) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  // iat backdated 60s for clock skew; exp must be <= 10 minutes out.
  const body = b64({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(`${head}.${body}`), fs.readFileSync(pemPath, 'utf8'))
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function gh(url, { method = 'GET', token, bearer } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        Authorization: bearer ? `Bearer ${bearer}` : `token ${token}`,
      },
    });
  } catch (e) {
    die(`${method} ${apiBase()}${url} -> ${e && e.cause && e.cause.code ? e.cause.code : e.message}`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) die(`${method} ${url} -> HTTP ${res.status}: ${json.message || text.slice(0, 200)}`);
  return json;
}

function readCache(cfg) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(cfg).file, 'utf8'));
    if (c.token && Date.parse(c.expires_at) - Date.now() > REFRESH_MARGIN_MS) return c;
  } catch { /* missing or corrupt cache -> re-mint */ }
  return null;
}

function writeCache(cfg, entry) {
  const { file, custom } = cachePath(cfg);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!custom) fs.chmodSync(dir, 0o700); // never chmod a directory the operator chose via GH_APP_CACHE
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic; concurrent minters just last-write-win
}

async function mint(cfg) {
  if (!fs.existsSync(cfg.GH_APP_PEM)) die(`private key not found: ${cfg.GH_APP_PEM}`);
  const jwt = appJwt(cfg.GH_APP_ID, cfg.GH_APP_PEM);
  const r = await gh(`/app/installations/${cfg.GH_APP_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    bearer: jwt,
  });
  const entry = { token: r.token, expires_at: r.expires_at, permissions: r.permissions || {} };
  writeCache(cfg, entry);
  return entry;
}

async function token(cfg, { force = false } = {}) {
  if (!force) {
    const c = readCache(cfg);
    if (c) return c;
  }
  return mint(cfg);
}

async function main() {
  const [mode, op] = process.argv.slice(2);
  const cfg = loadConfig();

  if (mode === 'git-credential') {
    if (op !== 'get') return; // store/erase: nothing to persist — the helper is the source
    const input = fs.readFileSync(0, 'utf8');
    const attrs = Object.fromEntries(
      input.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    if (attrs.host !== 'github.com' || (attrs.protocol && attrs.protocol !== 'https')) return;
    const { token: t } = await token(cfg);
    process.stdout.write(`username=x-access-token\npassword=${t}\n`);
    return;
  }

  if (mode === '--check') {
    let required;
    try {
      required = cfg.GH_APP_REQUIRED_PERMS ? parseRequiredPerms(cfg.GH_APP_REQUIRED_PERMS) : DEFAULT_REQUIRED_PERMS;
    } catch (e) { die(e.message); }
    const { token: t, expires_at, permissions } = await token(cfg, { force: true }); // fresh: carries current permissions
    const missing = missingPermissions(permissions, required);
    const repos = await gh('/installation/repositories?per_page=100', { token: t });
    const names = (repos.repositories || []).map((r) => r.full_name).sort();
    process.stdout.write(
      `gh-app-token: OK — token valid until ${expires_at}; installation covers ${repos.total_count} repo(s): ${names.join(', ')}\n`,
    );
    if (missing.length) {
      die(`installation token is MISSING permission(s): ${missing.join(', ')} — set them on the App and accept them on the installation (${DOCS}, "Changing permissions")`, 3); // 3 = token works, permissions short
    }
    return;
  }

  const { token: t } = await token(cfg, { force: mode === '--refresh' });
  process.stdout.write(`${t}\n`);
}

// Run only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => die(e && e.message ? e.message : String(e)));
}
