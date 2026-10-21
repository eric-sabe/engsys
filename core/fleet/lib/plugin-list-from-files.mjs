#!/usr/bin/env node
// plugin-list-from-files.mjs: the plugin list `claude plugin list --json` would print for a config dir, built
// from the dir's files alone, so `fleet verify` can check a live session's dir without starting a claude
// process on its credential (engsys#223: a short-lived `claude` refreshing the access token near expiry rotates
// the refresh token out from under the running session, anthropics/claude-code#88583).
//
// Sources, all read-only:
//   <dir>/plugins/installed_plugins.json   the installs: { version, plugins: { <id>: [ { scope, version, installPath,
//                                          projectPath? } ] } } (v1 kept one object per id instead of an array)
//   enabledPlugins in <dir>/settings.json, <project>/.claude/settings.json, <project>/.claude/settings.local.json
//                                          `enabled` is true only when some scope enables the plugin and NO scope
//                                          disables it: stricter than Claude's own precedence (a disable anywhere reads
//                                          as disabled), so the guard hook is never reported as loading when it might not
// Output: the same entry shape the verifier reads from the CLI: { id, version, scope, enabled, installPath, projectPath? }.
//
// --marketplaces: instead, what `claude plugin marketplace list --json` gives `fleet sync --check` (engsys#253), from
// <dir>/plugins/known_marketplaces.json ({ <name>: { source: { source, url | repo, ref? }, installLocation } }):
// [{ name, ref }], ref '' when the source pins none (a `#<ref>` on a git url counts as its ref).
//
// Fail closed: an unreadable or malformed file is an error (exit 1, nothing on stdout); the caller reports "not
// verified". A file that does not exist is an empty source (a dir with nothing installed lists `[]` too).
//
// Usage: plugin-list-from-files.mjs --config-dir <dir> --project-dir <dir>
//        plugin-list-from-files.mjs --config-dir <dir> --marketplaces
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return undefined;
    throw new Error(`can't read ${file}: ${e && e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function enabledMap(file) {
  const s = readJson(file);
  if (s === undefined) return {};
  if (!isObj(s)) throw new Error(`${file} is not a JSON object`);
  if (s.enabledPlugins === undefined) return {};
  if (!isObj(s.enabledPlugins)) throw new Error(`${file}: enabledPlugins is not an object`);
  return s.enabledPlugins;
}

export function pluginListFromFiles({ configDir, projectDir }) {
  const installedFile = path.join(configDir, 'plugins', 'installed_plugins.json');
  const inst = readJson(installedFile);
  if (inst === undefined) return [];
  if (!isObj(inst) || !isObj(inst.plugins)) throw new Error(`${installedFile} has no plugins object`);
  const enabledIn = new Set();
  const disabledIn = new Set();
  for (const f of [path.join(configDir, 'settings.json'), path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')]) {
    for (const [id, v] of Object.entries(enabledMap(f))) (v === true ? enabledIn : disabledIn).add(id);
  }
  const out = [];
  for (const [id, v] of Object.entries(inst.plugins)) {
    const installs = Array.isArray(v) ? v : [v];
    for (const e of installs) {
      if (!isObj(e)) throw new Error(`${installedFile}: an install of ${id} is not an object`);
      for (const k of ['installPath', 'projectPath', 'version', 'scope']) {
        if (e[k] !== undefined && typeof e[k] !== 'string') throw new Error(`${installedFile}: ${id} has a non-string ${k}`);
      }
      out.push({
        id,
        version: e.version,
        scope: e.scope ?? 'user',
        enabled: enabledIn.has(id) && !disabledIn.has(id),
        installPath: e.installPath ?? '',
        ...(e.projectPath ? { projectPath: e.projectPath } : {}),
      });
    }
  }
  return out;
}

export function marketplaceListFromFiles({ configDir }) {
  const file = path.join(configDir, 'plugins', 'known_marketplaces.json');
  const known = readJson(file);
  if (known === undefined) return [];
  if (!isObj(known)) throw new Error(`${file} is not a JSON object`);
  const out = [];
  for (const [name, v] of Object.entries(known)) {
    if (!isObj(v) || (v.source !== undefined && !isObj(v.source))) throw new Error(`${file}: marketplace ${name} is not an object with a source`);
    const src = v.source ?? {};
    if (src.ref !== undefined && typeof src.ref !== 'string') throw new Error(`${file}: marketplace ${name} has a non-string ref`);
    let ref = src.ref ?? '';
    if (!ref && typeof src.url === 'string' && src.url.includes('#')) ref = src.url.slice(src.url.indexOf('#') + 1);
    out.push({ name, ref });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const configDir = arg('--config-dir');
  const projectDir = arg('--project-dir');
  const markets = a.includes('--marketplaces');
  if (!configDir || (!projectDir && !markets)) { console.error('usage: plugin-list-from-files.mjs --config-dir <dir> (--project-dir <dir> | --marketplaces)'); process.exit(2); }
  try {
    const out = markets ? marketplaceListFromFiles({ configDir }) : pluginListFromFiles({ configDir, projectDir });
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    console.error(`plugin-list-from-files: ${e.message}`);
    process.exit(1);
  }
}
