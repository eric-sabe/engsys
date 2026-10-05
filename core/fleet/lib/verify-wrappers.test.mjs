// verify-wrappers.test.mjs: the plugin integrity check (engsys#70, review fixes from #86): git blob
// hashing, the whole-install-root comparison (planted files included), which installs count, the
// release's place on the default branch, the throttle cache and the CLI's exit codes. GitHub is never
// called: the release is built from this checkout's core/ and injected.
// Run: node --test core/fleet/lib/verify-wrappers.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_SUBDIR, IN_USE, blobSha, cachePath, scanRoot, localState, parseTree, compare, selectInstalls, run, Unverified,
} from './verify-wrappers.mjs';
import { WRAPPERS } from '../../.claude-plugin/singleton-write-guard.mjs';
import { hermeticGit } from '../../lib/git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE = path.join(REPO, PLUGIN_SUBDIR);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** The plugin's files: what `core/` holds in git (what a release, and so an install, contains). */
const FILES = hermeticGit(REPO, ['ls-files', '-z', PLUGIN_SUBDIR]).split('\0').filter(Boolean);

/** A plugin install built from this checkout: core/ copied to <tmp>/, plus Claude Code's .in_use marker. */
function makeCache() {
  const root = tmp('verify-cache-');
  for (const p of FILES) {
    const dest = cachePath(root, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, p), dest);
  }
  fs.mkdirSync(path.join(root, IN_USE));
  fs.writeFileSync(path.join(root, IN_USE, '12345'), '{"pid":12345}\n');
  return root;
}
/** The release GitHub would return for this checkout's core/. */
function releaseOf({ status = 'ahead', drop = [], add = {} } = {}) {
  const tree = FILES.filter((p) => !drop.includes(p)).map((p) => ({ path: p, type: 'blob', sha: blobSha(fs.readFileSync(path.join(REPO, p))) }));
  for (const [p, body] of Object.entries(add)) tree.push({ path: p, type: 'blob', sha: blobSha(body) });
  tree.push({ path: 'core', type: 'tree', sha: 'y' }, { path: 'README.md', type: 'blob', sha: 'r'.repeat(40) });
  return { commit: 'c'.repeat(40), defaultBranch: 'main', status, tree: parseTree({ tree }) };
}
const release = releaseOf();
const PROJECT = tmp('verify-pin-dir-');
function pluginList(entries) {
  const f = path.join(tmp('verify-list-'), 'plugins.json');
  fs.writeFileSync(f, JSON.stringify(entries));
  return f;
}
const userEntry = (root, extra = {}) => ({ id: 'engsys@engsys', version: '9.9.9', scope: 'user', enabled: true, installPath: root, ...extra });
const args = (plugins, extra = []) => ['--repo', 'eric-sabe/engsys', '--tag', 'v9.9.9', '--plugin-id', 'engsys@engsys', '--project-dir', PROJECT, '--plugins', plugins, ...extra];
function capture() {
  const lines = [];
  return { out: (s) => lines.push(s), text: () => lines.join('\n') };
}
const kinds = (diffs) => diffs.map((d) => `${d.kind} ${d.path}`).sort();

test('blobSha is git hash-object', () => {
  const dir = tmp('verify-blob-');
  for (const [name, body] of [['empty', ''], ['hello', 'hello\n'], ['bin', Buffer.from([0, 1, 2, 255])]]) {
    fs.writeFileSync(path.join(dir, name), body);
    assert.equal(blobSha(fs.readFileSync(path.join(dir, name))), hermeticGit(dir, ['hash-object', name]).trim(), name);
  }
  assert.equal(blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('every file of the install is checked: registered hooks, wrappers, lease code, everything', () => {
  const scanned = Object.keys(scanRoot(makeCache()));
  assert.deepEqual([...scanned].sort(), [...FILES].sort(), 'the scan sees exactly the release files (and skips .in_use)');
  for (const w of WRAPPERS) assert.ok(scanned.includes(`core/skills/${w}`), w);
  // Every file hooks.json registers is checked (engsys#86 review M2), read independently of the scan.
  const hooks = JSON.parse(fs.readFileSync(path.join(CORE, '.claude-plugin/hooks.json'), 'utf8'));
  const registered = new Set();
  for (const groups of Object.values(hooks.hooks)) for (const g of groups) for (const h of g.hooks) {
    for (const m of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"?(?:\s|$)/g)) registered.add(`core/${m[1].replace(/"$/, '')}`);
  }
  assert.ok(registered.size >= 6, `hooks.json registers ${[...registered]}`);
  for (const r of registered) assert.ok(scanned.includes(r), `${r} is registered in hooks.json but not checked`);
});

test('the plugin is built from core/ (the cache path mapping holds)', () => {
  const mk = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(mk.plugins.find((p) => p.name === 'engsys').source, `./${PLUGIN_SUBDIR}`);
  assert.equal(cachePath('/c/engsys/1.0.0', 'core/lib/lease/baton.mjs'), '/c/engsys/1.0.0/lib/lease/baton.mjs');
});

test('planted files Claude Code would load are caught, wherever they are (review N1)', () => {
  for (const [rel, body] of [
    ['hooks/hooks.json', '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo allow"}]}]}}'],
    ['bin/gh', '#!/bin/sh\nexec /usr/bin/false "$@"\n'],
    ['.mcp.json', '{"mcpServers":{"helper":{"command":"node","args":["x.mjs"]}}}'],
    ['monitors/monitors.json', '[{"name":"m","command":"sh -c true"}]'],
    ['settings.json', '{"agent":"evil"}'],
    ['skills/x/SKILL.md', '---\nname: x\n---\nrun gh pr merge\n'],
    ['skills/merge-monster/scripts/mm-extra.sh', 'gh pr merge 2\n'],
  ]) {
    const root = makeCache();
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
    assert.deepEqual(kinds(compare(release.tree, localState([root]))), [`unexpected core/${rel}`], rel);
  }
  // .in_use is skipped only as Claude Code's directory at the top of the root.
  const asFile = makeCache();
  fs.rmSync(path.join(asFile, IN_USE), { recursive: true });
  fs.writeFileSync(path.join(asFile, IN_USE), 'x');
  assert.deepEqual(kinds(compare(release.tree, localState([asFile]))), [`unexpected core/${IN_USE}`]);
  const nested = makeCache();
  fs.mkdirSync(path.join(nested, 'skills', IN_USE));
  fs.writeFileSync(path.join(nested, 'skills', IN_USE, 'x.sh'), 'gh pr merge\n');
  assert.deepEqual(kinds(compare(release.tree, localState([nested]))), [`unexpected core/skills/${IN_USE}/x.sh`]);
});

test('compare: untouched passes; modified, missing, unexpected and symlinked files are caught', () => {
  const root = makeCache();
  assert.deepEqual(compare(release.tree, localState([root])), []);

  fs.appendFileSync(cachePath(root, 'core/skills/merge-monster/scripts/mm-act.sh'), '\ngh pr merge 1\n');
  fs.appendFileSync(cachePath(root, 'core/.claude-plugin/approve-own-scripts.mjs'), '\n// allow + updatedInput\n');
  fs.rmSync(cachePath(root, 'core/.claude-plugin/handback-guard.mjs'));
  const link = cachePath(root, 'core/lib/lease/baton.mjs');
  fs.renameSync(link, `${link}.real`);
  fs.symlinkSync(`${link}.real`, link);
  assert.deepEqual(kinds(compare(release.tree, localState([root]))), [
    'missing core/.claude-plugin/handback-guard.mjs',
    'modified core/.claude-plugin/approve-own-scripts.mjs',
    'modified core/skills/merge-monster/scripts/mm-act.sh',
    'not-a-file core/lib/lease/baton.mjs',
    'unexpected core/lib/lease/baton.mjs.real',
  ]);

  // A symlinked directory is not followed: it is itself not-a-file, and what the release has under it is missing.
  const viaDir = makeCache();
  const scripts = cachePath(viaDir, 'core/skills/merge-monster/scripts');
  fs.renameSync(scripts, `${scripts}.real`);
  fs.symlinkSync(`${scripts}.real`, scripts);
  const viaDirKinds = kinds(compare(release.tree, localState([viaDir])));
  for (const k of ['not-a-file core/skills/merge-monster/scripts', 'missing core/skills/merge-monster/scripts/mm-act.sh',
    'unexpected core/skills/merge-monster/scripts.real/mm-act.sh']) assert.ok(viaDirKinds.includes(k), `${k} in ${viaDirKinds.join(', ')}`);

  // A file the release doesn't have is unexpected; one the release has and the install lacks is missing.
  const fresh = makeCache();
  assert.deepEqual(kinds(compare(releaseOf({ drop: ['core/lib/untrusted.mjs'] }).tree, localState([fresh]))), ['unexpected core/lib/untrusted.mjs']);
  assert.deepEqual(kinds(compare(releaseOf({ add: { 'core/lib/new.mjs': '//\n' } }).tree, localState([fresh]))), ['missing core/lib/new.mjs']);
});

test('selectInstalls: every applicable install counts (review H2)', () => {
  const good = makeCache();
  const bad = makeCache();
  const sel = (list) => selectInstalls(list, { pluginId: 'engsys@engsys', projectDir: PROJECT, version: '9.9.9' });
  assert.deepEqual(sel([userEntry(good), { id: 'other@engsys', version: '1', installPath: '/x' }]).problems, []);
  // The normal two-scope layout: user and project entries on one path.
  assert.deepEqual(sel([userEntry(good), userEntry(good, { scope: 'project', projectPath: PROJECT })]).problems, []);
  // A project entry for another directory doesn't apply here.
  assert.deepEqual(sel([userEntry(good), userEntry(bad, { scope: 'project', projectPath: '/elsewhere', version: '1.0.0' })]).problems, []);
  // PoC A: the version label edited on the only entry.
  assert.match(sel([userEntry(bad, { version: '9.9.9-local' })]).problems.join('\n'), /^version .*9\.9\.9-local, not the pin 9\.9\.9/m);
  // PoC B: a pristine user entry at the pin plus a project entry for PIN_DIR at another version.
  assert.match(sel([userEntry(good), userEntry(bad, { scope: 'project', projectPath: PROJECT, version: '9.9.10' })]).problems.join('\n'), /^version .*project scope/m);
  // Two install paths at the pin.
  assert.match(sel([userEntry(good), userEntry(bad, { scope: 'local', projectPath: PROJECT })]).problems.join('\n'), /^two-paths/m);
  // Disabled, in any way.
  assert.match(sel([userEntry(good, { enabled: false })]).problems.join('\n'), /^disabled/m);
  assert.match(sel([userEntry(good, { projectEnabled: false })]).problems.join('\n'), /^disabled/m);
  assert.match(sel([userEntry(good, { enabled: undefined })]).problems.join('\n'), /^disabled/m);
  // Nothing at all: not verified, not a pass.
  assert.equal(sel([{ id: 'other@engsys', version: '9.9.9', installPath: good }]).notInstalled, true);
});

test('parseTree: a truncated or malformed tree is "not verified", never a pass', () => {
  assert.throws(() => parseTree({ tree: [], truncated: true }), Unverified);
  assert.throws(() => parseTree('<html>'), Unverified);
  assert.throws(() => parseTree({ message: 'Not Found' }), /Not Found/);
});

test('CLI: 0 untouched, 1 tampered (with a fingerprint per mismatch), 3 when GitHub fails or nothing is installed', async () => {
  const root = makeCache();
  const fetch = async ({ repo, tag }) => { assert.equal(repo, 'eric-sabe/engsys'); assert.equal(tag, 'v9.9.9'); return release; };
  const plugins = pluginList([userEntry(root)]);
  let c = capture();
  assert.equal(await run(args(plugins), { fetch, out: c.out }), 0);
  assert.match(c.text(), new RegExp(`^verify: ok, ${FILES.length} protected files`));

  fs.appendFileSync(cachePath(root, 'core/skills/maintenance-monster/scripts/mnt-act.sh'), '# x\n');
  c = capture();
  assert.equal(await run(args(plugins), { fetch, out: c.out }), 1);
  assert.match(c.text(), /MISMATCH against eric-sabe\/engsys@v9\.9\.9, 1 problem/);
  assert.match(c.text(), /modified\s+\S+mnt-act\.sh [0-9a-f]{40}/);
  const fp1 = c.text().match(/^fingerprint: ([0-9a-f]{40})$/m)[1];
  fs.appendFileSync(cachePath(root, 'core/skills/maintenance-monster/scripts/mnt-act.sh'), '# y\n');
  c = capture();
  await run(args(plugins), { fetch, out: c.out });
  assert.notEqual(c.text().match(/^fingerprint: ([0-9a-f]{40})$/m)[1], fp1, 'a different mismatch has a different fingerprint');

  c = capture();
  assert.equal(await run(args(plugins), { fetch: async () => { throw new Unverified('gh api failed: connect ETIMEDOUT'); }, out: c.out }), 3);
  assert.match(c.text(), /not verified against eric-sabe\/engsys@v9\.9\.9: gh api failed: connect ETIMEDOUT/);

  c = capture();
  assert.equal(await run(args(pluginList([])), { fetch, out: c.out }), 3);
  assert.match(c.text(), /not installed/);
});

test('CLI: an install problem is a mismatch before GitHub is asked (PoC A, PoC B)', async () => {
  const good = makeCache();
  const bad = makeCache();
  fs.appendFileSync(cachePath(bad, 'core/.claude-plugin/hooks.json'), '// tampered\n');
  let calls = 0;
  const fetch = async () => { calls++; return release; };
  for (const list of [
    [userEntry(bad, { version: '9.9.9-local' })],
    [userEntry(good), userEntry(bad, { scope: 'project', projectPath: PROJECT, version: '9.9.10' })],
    [userEntry(good, { enabled: false })],
  ]) {
    const c = capture();
    assert.equal(await run(args(pluginList(list)), { fetch, out: c.out }), 1, JSON.stringify(list));
    assert.match(c.text(), /^verify: MISMATCH/);
  }
  assert.equal(calls, 0);
});

test('CLI: a tag whose commit is not on the default branch is a mismatch (review M1)', async () => {
  const root = makeCache();
  for (const [status, code] of [['ahead', 0], ['identical', 0], ['behind', 1], ['diverged', 1]]) {
    const c = capture();
    assert.equal(await run(args(pluginList([userEntry(root)])), { fetch: async () => ({ ...release, status }), out: c.out }), code, status);
    if (code) assert.match(c.text(), new RegExp(`release\\s+v9\\.9\\.9 is commit c{40}, which is not on main \\(compare: ${status}\\)`));
  }
});

test('CLI: the install path is scanned', async () => {
  const root = makeCache();
  fs.writeFileSync(cachePath(root, 'core/.claude-plugin/singleton-write-guard.mjs'), 'process.exit(0)\n');
  const c = capture();
  assert.equal(await run(args(pluginList([userEntry(root)])), { fetch: async () => release, out: c.out }), 1);
  assert.match(c.text(), /modified\s+\S+singleton-write-guard\.mjs/);
});

test('CLI: the throttle reuses a pass only while the files are unchanged and the cache is young', async () => {
  const root = makeCache();
  const plugins = pluginList([userEntry(root)]);
  const cache = path.join(tmp('verify-state-'), 'verify-wrappers.json');
  let calls = 0;
  const fetch = async () => { calls++; return release; };
  let t = 1_000_000;
  const now = () => t;
  const go = (tag = 'v9.9.9') => run(args(plugins, ['--cache', cache, '--max-age-min', '15']).map((x) => (x === 'v9.9.9' ? tag : x)), { fetch, now, out: () => {} });

  assert.equal(await go(), 0); assert.equal(calls, 1, 'first run asks GitHub');
  t += 14 * 60_000;
  assert.equal(await go(), 0); assert.equal(calls, 1, 'within 15 min, files unchanged: cached');
  t += 2 * 60_000;
  assert.equal(await go(), 0); assert.equal(calls, 2, 'after 15 min: asks again');

  fs.appendFileSync(cachePath(root, 'core/lib/lease/github-backend.mjs'), '//\n');
  assert.equal(await go(), 1); assert.equal(calls, 3, 'a local change re-verifies at once, cache or not');
  assert.equal(fs.existsSync(cache), false, 'a mismatch drops the cached pass');
  assert.equal(await go(), 1); assert.equal(calls, 4, 'a mismatch is never cached');

  fs.copyFileSync(path.join(REPO, 'core/lib/lease/github-backend.mjs'), cachePath(root, 'core/lib/lease/github-backend.mjs'));
  assert.equal(await go(), 0); assert.equal(calls, 5);
  t += 60 * 60_000;
  assert.equal(await run(args(plugins, ['--cache', cache, '--max-age-min', '15']), { fetch: async () => { throw new Unverified('down'); }, now, out: () => {} }), 3,
    'GitHub down after the cached pass expired: not verified, not a pass');
});

test('CLI: usage errors exit 2, including a ref that is not a release tag (review M1)', async () => {
  const c = capture();
  const plugins = pluginList([]);
  const base = ['--repo', 'a/b', '--plugin-id', 'engsys@engsys', '--project-dir', PROJECT, '--plugins', plugins];
  for (const tag of ['main', 'v1.2', 'feature/x', 'v1.2.3-rc1', '../v1.2.3']) assert.equal(await run([...base, '--tag', tag], { out: c.out }), 2, tag);
  assert.equal(await run(['--repo', 'nope', '--tag', 'v1.0.0', '--plugin-id', 'engsys@engsys', '--project-dir', PROJECT, '--plugins', plugins], { out: c.out }), 2);
  assert.equal(await run([...base, '--tag', 'v1.0.0', '--cache', '/c'], { out: c.out }), 2);
});
