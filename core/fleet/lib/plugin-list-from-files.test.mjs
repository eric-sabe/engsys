// plugin-list-from-files.test.mjs: the file-derived plugin list (engsys#223) and its parity with what
// `claude plugin list --json` reports to the verifier. Run: node --test core/fleet/lib/plugin-list-from-files.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pluginListFromFiles, marketplaceListFromFiles } from './plugin-list-from-files.mjs';
import { selectInstalls } from './verify-wrappers.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-list-from-files.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plf-'));
const put = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };

function dirs({ installed, user, project, local }) {
  const cfg = tmp();
  const proj = tmp();
  if (installed !== undefined) put(path.join(cfg, 'plugins', 'installed_plugins.json'), installed);
  if (user !== undefined) put(path.join(cfg, 'settings.json'), user);
  if (project !== undefined) put(path.join(proj, '.claude', 'settings.json'), project);
  if (local !== undefined) put(path.join(proj, '.claude', 'settings.local.json'), local);
  return { configDir: cfg, projectDir: proj };
}

const V2 = { version: 2, plugins: { 'engsys@engsys': [{ scope: 'user', version: '1.0.0', installPath: '/cache/engsys' }], 'o@m': [{ scope: 'project', version: '2', installPath: '/o', projectPath: '/p' }] } };

test('v2 installs become CLI-shaped entries, enabled from the settings', () => {
  const d = dirs({ installed: V2, user: { enabledPlugins: { 'engsys@engsys': true } } });
  assert.deepEqual(pluginListFromFiles(d), [
    { id: 'engsys@engsys', version: '1.0.0', scope: 'user', enabled: true, installPath: '/cache/engsys' },
    { id: 'o@m', version: '2', scope: 'project', enabled: false, installPath: '/o', projectPath: '/p' },
  ]);
});

test('a v1 file (one object per id) is read too', () => {
  const d = dirs({ installed: { version: 1, plugins: { 'a@b': { version: '3', installPath: '/a' } } }, user: { enabledPlugins: { 'a@b': true } } });
  assert.deepEqual(pluginListFromFiles(d), [{ id: 'a@b', version: '3', scope: 'user', enabled: true, installPath: '/a' }]);
});

test('a disable in any scope reads as disabled; an enable in any scope with no disable reads as enabled', () => {
  const on = { enabledPlugins: { 'engsys@engsys': true } };
  const off = { enabledPlugins: { 'engsys@engsys': false } };
  assert.equal(pluginListFromFiles(dirs({ installed: V2, project: on }))[0].enabled, true);
  assert.equal(pluginListFromFiles(dirs({ installed: V2, user: on, local: off }))[0].enabled, false);
  assert.equal(pluginListFromFiles(dirs({ installed: V2, user: off, project: on }))[0].enabled, false);
});

test('nothing installed (no file) is an empty list, like the CLI', () => {
  assert.deepEqual(pluginListFromFiles(dirs({})), []);
});

test('fail closed: unreadable or malformed input throws', () => {
  for (const bad of [
    { installed: '{nope' }, { installed: [] }, { installed: { plugins: [] } }, { installed: { plugins: { 'a@b': [1] } } },
    { installed: { plugins: { 'a@b': [{ installPath: 5 }] } } }, { installed: V2, user: '{x' }, { installed: V2, project: [] },
    { installed: V2, local: { enabledPlugins: 'yes' } },
  ]) assert.throws(() => pluginListFromFiles(dirs(bad)), Error, JSON.stringify(bad));
  const d = dirs({});
  fs.mkdirSync(path.join(d.configDir, 'plugins', 'installed_plugins.json'), { recursive: true });
  assert.throws(() => pluginListFromFiles(d), /can't read/);
});

test('the CLI prints the list and exits 1 with nothing on stdout when it fails', () => {
  const ok = dirs({ installed: V2, user: { enabledPlugins: { 'engsys@engsys': true } } });
  assert.equal(JSON.parse(execFileSync('node', [MOD, '--config-dir', ok.configDir, '--project-dir', ok.projectDir]).toString()).length, 2);
  const bad = dirs({ installed: '{nope' });
  const r = spawnSync('node', [MOD, '--config-dir', bad.configDir, '--project-dir', bad.projectDir]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.toString(), '');
  assert.equal(spawnSync('node', [MOD]).status, 2);
});

test('selectInstalls gives the same verdict on the file-derived list as on the CLI-shaped one', () => {
  const proj = tmp();
  const cli = (list) => selectInstalls(list, { pluginId: 'engsys@engsys', projectDir: proj, version: '1.0.0' });
  const cases = {
    ok: [{ id: 'engsys@engsys', version: '1.0.0', scope: 'user', enabled: true, installPath: '/c' }],
    wrongVersion: [{ id: 'engsys@engsys', version: '0.9.0', scope: 'user', enabled: true, installPath: '/c' }],
    disabled: [{ id: 'engsys@engsys', version: '1.0.0', scope: 'user', enabled: false, installPath: '/c' }],
    absent: [{ id: 'x@y', version: '1', scope: 'user', enabled: true, installPath: '/x' }],
    twoPaths: [{ id: 'engsys@engsys', version: '1.0.0', scope: 'user', enabled: true, installPath: '/c' }, { id: 'engsys@engsys', version: '1.0.0', scope: 'project', enabled: true, installPath: '/d', projectPath: proj }],
  };
  for (const [name, list] of Object.entries(cases)) {
    const plugins = {};
    for (const e of list) (plugins[e.id] ??= []).push({ scope: e.scope, version: e.version, installPath: e.installPath, ...(e.projectPath ? { projectPath: e.projectPath } : {}) });
    const en = Object.fromEntries(list.filter((e) => e.id === 'engsys@engsys').map((e) => [e.id, e.enabled]));
    const files = pluginListFromFiles({ ...dirs({ installed: { version: 2, plugins }, user: { enabledPlugins: en } }), projectDir: proj });
    assert.deepEqual(cli(files), cli(list), name);
  }
});

test('the marketplace list (engsys#253): name and ref, from known_marketplaces.json', () => {
  const cfg = tmp();
  assert.deepEqual(marketplaceListFromFiles({ configDir: cfg }), [], 'no file: nothing known');
  put(path.join(cfg, 'plugins', 'known_marketplaces.json'), {
    engsys: { source: { source: 'git', url: 'https://github.com/e/engsys.git', ref: 'v2.3.2' }, installLocation: '/m/engsys' },
    hashed: { source: { source: 'git', url: 'https://github.com/a/b.git#v1.0.0' } },
    official: { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
  });
  assert.deepEqual(marketplaceListFromFiles({ configDir: cfg }), [
    { name: 'engsys', ref: 'v2.3.2' }, { name: 'hashed', ref: 'v1.0.0' }, { name: 'official', ref: '' },
  ]);
  const r = spawnSync('node', [MOD, '--config-dir', cfg, '--marketplaces']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.toString())[0].ref, 'v2.3.2');
  put(path.join(cfg, 'plugins', 'known_marketplaces.json'), '[1]');
  const bad = spawnSync('node', [MOD, '--config-dir', cfg, '--marketplaces']);
  assert.equal(bad.status, 1, 'malformed fails closed');
  assert.equal(bad.stdout.toString(), '');
});
