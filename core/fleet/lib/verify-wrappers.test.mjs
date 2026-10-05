// verify-wrappers.test.mjs: the plugin integrity check (engsys#70, review fixes from #86): git blob
// hashing, the protected closure (hooks, wrappers, lease code, all from the release's own copy), the
// comparison, which installs count, the release's place on the default branch, the throttle cache and
// the CLI's exit codes. GitHub is never called: the release is built from a cache copy and injected.
// Run: node --test core/fleet/lib/verify-wrappers.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEEDS, PLUGIN_SUBDIR, blobSha, cachePath, walk, localState, parseTree, parseWrappers, compare, selectInstalls, run, Unverified,
} from './verify-wrappers.mjs';
import { WRAPPERS } from '../../.claude-plugin/singleton-write-guard.mjs';
import { hermeticGit } from '../../lib/git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE = path.join(REPO, PLUGIN_SUBDIR);
const CLOSURE = Object.keys(walk(CORE));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A plugin cache built from this checkout: the protected closure copied to <tmp>/<path under core/>. */
function makeCache() {
  const root = tmp('verify-cache-');
  for (const p of CLOSURE) {
    const dest = cachePath(root, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, p), dest);
  }
  return root;
}
/** The release GitHub would return for the files under root, as they are now. */
function releaseOf(root, { status = 'ahead' } = {}) {
  const tree = Object.entries(walk(root)).filter(([, sha]) => sha && sha !== 'not-a-file').map(([p, sha]) => ({ path: p, type: 'blob', sha }));
  return { commit: 'c'.repeat(40), defaultBranch: 'main', status, tree: parseTree({ tree: [...tree, { path: 'core', type: 'tree', sha: 'y' }] }) };
}
const release = releaseOf(CORE);
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

test('the closure: every registered hook script, every wrapper, the lease code and what it loads', () => {
  for (const w of WRAPPERS) assert.ok(CLOSURE.includes(`core/skills/${w}`), w);
  assert.deepEqual(parseWrappers(fs.readFileSync(path.join(CORE, '.claude-plugin/singleton-write-guard.mjs'), 'utf8')).sort(), [...WRAPPERS].sort());
  // Every file hooks.json registers is protected (engsys#86 review M2), read independently of the walk.
  const hooks = JSON.parse(fs.readFileSync(path.join(CORE, '.claude-plugin/hooks.json'), 'utf8'));
  const registered = new Set();
  for (const groups of Object.values(hooks.hooks)) for (const g of groups) for (const h of g.hooks) {
    for (const m of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"?(?:\s|$)/g)) registered.add(`core/${m[1].replace(/"$/, '')}`);
  }
  assert.ok(registered.size >= 6, `hooks.json registers ${[...registered]}`);
  for (const r of registered) assert.ok(CLOSURE.includes(r), `${r} is registered in hooks.json but not protected`);
  for (const p of ['core/.claude-plugin/approve-own-scripts.mjs', 'core/.claude-plugin/engsys-context.mjs', 'core/.claude-plugin/handback-guard.mjs',
    'core/templates/post-compact-reground.sh.tmpl', 'core/templates/post-clear-reground.sh.tmpl', 'core/.claude-plugin/plugin.json',
    'core/lib/lease/baton.mjs', 'core/lib/lease/github-backend.mjs', 'core/fleet/identity/gh-app-token.mjs', 'core/fleet/lib/federation.mjs',
    'core/lib/gate-check.mjs', 'core/lib/git-env.mjs', 'core/lib/untrusted.mjs', 'core/templates/CLAUDE.md.tmpl']) {
    assert.ok(CLOSURE.includes(p), `${p} protected`);
  }
  for (const s of SEEDS) assert.ok(fs.statSync(path.join(REPO, s)).isFile(), `seed ${s} exists`);
  for (const p of CLOSURE) assert.ok(fs.statSync(path.join(REPO, p)).isFile(), `${p} exists`);
});

test('the plugin is built from core/ (the cache path mapping holds)', () => {
  const mk = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(mk.plugins.find((p) => p.name === 'engsys').source, `./${PLUGIN_SUBDIR}`);
  assert.equal(cachePath('/c/engsys/1.0.0', 'core/lib/lease/baton.mjs'), '/c/engsys/1.0.0/lib/lease/baton.mjs');
});

test('the wrapper and hook lists come from the release copy, not this checkout (review L4, M2)', () => {
  // A release whose guard names one more wrapper and whose hooks.json registers one more hook.
  const root = makeCache();
  const guard = cachePath(root, 'core/.claude-plugin/singleton-write-guard.mjs');
  fs.writeFileSync(guard, fs.readFileSync(guard, 'utf8').replace("export const WRAPPERS = new Set([", "export const WRAPPERS = new Set([\n  'merge-monster/scripts/mm-extra.sh',"));
  fs.writeFileSync(cachePath(root, 'core/skills/merge-monster/scripts/mm-extra.sh'), '#!/usr/bin/env bash\n');
  const hooksFile = cachePath(root, 'core/.claude-plugin/hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  hooks.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/extra-hook.mjs"' }] });
  fs.writeFileSync(hooksFile, JSON.stringify(hooks));
  fs.writeFileSync(cachePath(root, 'core/.claude-plugin/extra-hook.mjs'), '// extra\n');
  const rel = releaseOf(root);
  assert.deepEqual(compare(rel.tree, localState([root])), []);
  fs.appendFileSync(cachePath(root, 'core/skills/merge-monster/scripts/mm-extra.sh'), 'gh pr merge 1\n');
  fs.appendFileSync(cachePath(root, 'core/.claude-plugin/extra-hook.mjs'), 'process.stdout.write("{}")\n');
  assert.deepEqual(kinds(compare(rel.tree, localState([root]))), [
    'modified core/.claude-plugin/extra-hook.mjs',
    'modified core/skills/merge-monster/scripts/mm-extra.sh',
  ]);
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
  ]);

  // A symlinked directory on the way to a protected file is caught too.
  const viaDir = makeCache();
  const scripts = cachePath(viaDir, 'core/skills/merge-monster/scripts');
  fs.renameSync(scripts, `${scripts}.real`);
  fs.symlinkSync(`${scripts}.real`, scripts);
  assert.deepEqual(kinds(compare(release.tree, localState([viaDir]))), [
    'not-a-file core/skills/merge-monster/scripts/mm-act.sh',
    'not-a-file core/skills/merge-monster/scripts/mm-baton.sh',
    'not-a-file core/skills/merge-monster/scripts/mm-heartbeat.sh',
  ]);

  // A file the release doesn't have: fine when absent locally too, caught when present.
  const older = parseTree({ tree: [...release.tree].filter(([p]) => p !== 'core/lib/untrusted.mjs').map(([p, sha]) => ({ path: p, type: 'blob', sha })) });
  const fresh = makeCache();
  assert.deepEqual(kinds(compare(older, localState([fresh]))), ['unexpected core/lib/untrusted.mjs']);
  fs.rmSync(cachePath(fresh, 'core/lib/untrusted.mjs'));
  assert.deepEqual(compare(older, localState([fresh])), []);
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
  assert.match(c.text(), /^verify: ok, 22 protected files/);

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

test('CLI: every applicable install path is walked', async () => {
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
