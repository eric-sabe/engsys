import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugFromUrl, pluginRoots, resolve, defaultConfigDirs } from './mm-config.mjs';

let T;
before(() => { T = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-config-')); });
after(() => fs.rmSync(T, { recursive: true, force: true }));
const mk = (dir, files = {}) => { fs.mkdirSync(dir, { recursive: true }); for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), b); } return dir; };

describe('slugFromUrl', () => {
  it('reads https, ssh and scp-style remotes', () => {
    assert.equal(slugFromUrl('https://github.com/FeedFrwd/keystone.git'), 'FeedFrwd/keystone');
    assert.equal(slugFromUrl('git@github.com:FeedFrwd/keystone.git'), 'FeedFrwd/keystone');
    assert.equal(slugFromUrl('ssh://git@github.com/FeedFrwd/keystone/'), 'FeedFrwd/keystone');
    assert.equal(slugFromUrl('garbage'), '');
    assert.equal(slugFromUrl(''), '');
  });
});

describe('resolve', () => {
  it('finds the instance plugin copy through installed_plugins.json, and any other installed plugin root', () => {
    const cfg = path.join(T, 'a');
    const plug = mk(path.join(cfg, 'plugins/cache/mk/fleet/1.0.0'), { 'repos/FeedFrwd/keystone/merge-monster.yml': 'repo: x\n', 'repos/FeedFrwd/keystone/context.md': 'c' });
    mk(path.join(cfg, 'plugins'), { 'installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'fleet@mk': [{ scope: 'user', installPath: plug }, { scope: 'project', installPath: '/nonexistent' }] } }) });
    // an old cached version with a weaker config is not what is installed: the list decides, the cache is not walked
    mk(path.join(cfg, 'plugins/cache/mk/fleet/0.9.0'), { 'repos/FeedFrwd/keystone/merge-monster.yml': 'repo: old\n' });
    const r = resolve({ slug: 'FeedFrwd/keystone', configDirs: [cfg] });
    assert.equal(r.fleetManaged, true); assert.equal(r.missing, false);
    assert.equal(r.configs.length, 1, 'only the installed version');
    assert.ok(r.configs[0].includes('/1.0.0/'));
    assert.equal(r.configs.length, 1); assert.match(r.configs[0], /repos\/FeedFrwd\/keystone\/merge-monster\.yml$/);
  });
  it('falls back to walking plugins/cache, and tries the lowercased slug', () => {
    const cfg = path.join(T, 'b');
    mk(path.join(cfg, 'plugins/cache/mk/fleet/1.0.0'), { 'repos/feedfrwd/keystone/merge-monster.yml': 'repo: x\n' });
    mk(path.join(cfg, 'plugins/cache'), { '.DS_Store': 'x' }); mk(path.join(cfg, 'plugins/cache/mk'), { 'stray.lock': 'x' }); mk(path.join(cfg, 'plugins/cache/aaa'), { 'f': 'x' });
    assert.deepEqual(pluginRoots(cfg).length, 1);
    const r = resolve({ slug: 'FeedFrwd/Keystone', configDirs: [cfg] });
    assert.equal(r.configs.length, 1);
  });
  it('fleet-managed without a merge-monster.yml is missing; no directory is not fleet-managed', () => {
    const cfg = path.join(T, 'c');
    mk(path.join(cfg, 'plugins/cache/mk/fleet/1.0.0'), { 'repos/o/n/context.md': 'c' });
    const r = resolve({ slug: 'o/n', configDirs: [cfg] });
    assert.equal(r.fleetManaged, true); assert.equal(r.missing, true); assert.deepEqual(r.configs, []);
    const other = resolve({ slug: 'o/other', configDirs: [cfg] });
    assert.equal(other.fleetManaged, false); assert.equal(other.missing, false);
    assert.equal(resolve({ slug: 'o/n', configDirs: [path.join(T, 'does-not-exist')] }).fleetManaged, false);
  });
  it('a merge-monster.yml that is a directory is not a config', () => {
    const cfg = path.join(T, 'd');
    mk(path.join(cfg, 'plugins/cache/mk/fleet/1.0.0/repos/o/n/merge-monster.yml'));
    const r = resolve({ slug: 'o/n', configDirs: [cfg] });
    assert.equal(r.missing, true);
  });
});

describe('case-insensitive match and the known config dirs', () => {
  it('matches owner and repo directories ignoring case, by listing', () => {
    const cfg = path.join(T, 'e');
    mk(path.join(cfg, 'plugins/cache/mk/fleet/1.0.0'), { 'repos/FEEDFRWD/KeyStone/merge-monster.yml': 'repo: x\n' });
    assert.equal(resolve({ slug: 'feedfrwd/keystone', configDirs: [cfg] }).configs.length, 1);
    assert.equal(resolve({ slug: 'FeedFrwd/Keystone', configDirs: [cfg] }).configs.length, 1);
    assert.equal(resolve({ slug: 'feedfrwd/keystone2', configDirs: [cfg] }).fleetManaged, false);
  });
  it('defaultConfigDirs: the inherited dir, the fleet dir, its per-session dirs, the sessions env, and ~/.claude', () => {
    const fleet = mk(path.join(T, 'f/fleet'));
    mk(path.join(T, 'f/fleet.sessions/s1')); mk(path.join(T, 'f/fleet.sessions/s2'), { 'plain-file': 'x' });
    const other = mk(path.join(T, 'f/other.sessions/s3'));
    const dirs = defaultConfigDirs({ CLAUDE_CONFIG_DIR: '/tmp/empty', FLEET_CLAUDE_CONFIG_DIR: fleet, ENGSYS_CONFIG_DIR_SESSIONS: path.dirname(other), HOME: '/h' });
    assert.deepEqual(dirs, ['/tmp/empty', fleet, path.join(T, 'f/fleet.sessions/s1'), path.join(T, 'f/fleet.sessions/s2'), other, '/h/.claude']);
    assert.deepEqual(defaultConfigDirs({ HOME: '/h' }), ['/h/.claude']);
  });
});
