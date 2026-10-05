// verify-wrappers.test.mjs: the plugin integrity check (engsys#70): git blob hashing, the protected
// set and its coverage of what the wrappers run, the comparison, the throttle cache and the CLI's exit
// codes. GitHub is never called: the tree is built from this checkout and injected.
// Run: node --test core/fleet/lib/verify-wrappers.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED, PLUGIN_SUBDIR, blobSha, cachePath, localState, parseTree, compare, run, Unverified } from './verify-wrappers.mjs';
import { WRAPPERS } from '../../.claude-plugin/singleton-write-guard.mjs';
import { hermeticGit } from '../../lib/git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARGS = ['--repo', 'eric-sabe/engsys', '--ref', 'v9.9.9'];

/** A plugin cache built from this checkout: the protected files copied to <tmp>/<path under core/>. */
function makeCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cache-'));
  for (const p of PROTECTED) {
    const dest = cachePath(root, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, p), dest);
  }
  return root;
}
/** The tree GitHub would return for this checkout. */
function treeOf(extra = []) {
  const tree = PROTECTED.map((p) => ({ path: p, type: 'blob', mode: '100644', sha: blobSha(fs.readFileSync(path.join(REPO, p))) }));
  return { sha: 'x', truncated: false, tree: [...tree, { path: 'core', type: 'tree', sha: 'y' }, ...extra] };
}
function capture() {
  const lines = [];
  return { out: (s) => lines.push(s), text: () => lines.join('\n') };
}

test('blobSha is git hash-object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-blob-'));
  for (const [name, body] of [['empty', ''], ['hello', 'hello\n'], ['bin', Buffer.from([0, 1, 2, 255])]]) {
    fs.writeFileSync(path.join(dir, name), body);
    assert.equal(blobSha(fs.readFileSync(path.join(dir, name))), hermeticGit(dir, ['hash-object', name]).trim(), name);
  }
  assert.equal(blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('the protected set: wrappers, hook, its registration, the lease code', () => {
  for (const w of WRAPPERS) assert.ok(PROTECTED.includes(`core/skills/${w}`), w);
  for (const p of ['core/.claude-plugin/singleton-write-guard.mjs', 'core/.claude-plugin/hooks.json', 'core/.claude-plugin/plugin.json',
    'core/lib/lease/baton.mjs', 'core/lib/lease/github-backend.mjs']) assert.ok(PROTECTED.includes(p), p);
  assert.equal(new Set(PROTECTED).size, PROTECTED.length, 'no duplicates');
  for (const p of PROTECTED) assert.ok(fs.statSync(path.join(REPO, p)).isFile(), `${p} exists`);
});

test('the plugin is built from core/ (the cache path mapping holds)', () => {
  const mk = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(mk.plugins.find((p) => p.name === 'engsys').source, `./${PLUGIN_SUBDIR}`);
  const hooks = fs.readFileSync(path.join(REPO, 'core/.claude-plugin/hooks.json'), 'utf8');
  assert.match(hooks, /\$\{CLAUDE_PLUGIN_ROOT\}\/\.claude-plugin\/singleton-write-guard\.mjs/);
  assert.equal(cachePath('/c/engsys/1.0.0', 'core/lib/lease/baton.mjs'), '/c/engsys/1.0.0/lib/lease/baton.mjs');
});

test('everything a wrapper runs is protected (imports, sibling scripts, the token helper)', () => {
  // Walk from the wrappers: a .sh names the scripts/libs it execs by relative path; a .mjs reaches
  // relative modules through static and dynamic imports and execs helpers by path.join(HERE, ...).
  const seen = new Set();
  const queue = [...WRAPPERS].map((w) => `core/skills/${w}`);
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const src = fs.readFileSync(path.join(REPO, p), 'utf8');
    const dir = path.posix.dirname(p);
    const refs = [];
    if (p.endsWith('.sh')) {
      for (const m of src.matchAll(/(?:\$here|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\))\/([A-Za-z0-9_./-]+\.(?:sh|mjs))/g)) refs.push(m[1]);
    } else {
      for (const m of src.matchAll(/(?:from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) refs.push(m[1]);
      for (const m of src.matchAll(/join\(HERE,\s*((?:['"][^'"]+['"],?\s*)+)\)/g)) {
        refs.push([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join('/'));
      }
    }
    for (const r of refs) {
      const target = path.posix.normalize(path.posix.join(dir, r));
      if (fs.existsSync(path.join(REPO, target))) queue.push(target);
    }
  }
  assert.ok(seen.has('core/lib/lease/baton.mjs') && seen.has('core/fleet/identity/gh-app-token.mjs'), `walk reached the lease code: ${[...seen]}`);
  for (const p of seen) assert.ok(PROTECTED.includes(p), `${p} runs inside a fenced wrapper but is not in PROTECTED`);
  const hookFiles = new Set(['core/.claude-plugin/singleton-write-guard.mjs', 'core/.claude-plugin/hooks.json', 'core/.claude-plugin/plugin.json']);
  assert.deepEqual(PROTECTED.filter((p) => !seen.has(p) && !hookFiles.has(p)), [], 'PROTECTED lists only what the wrappers run, plus the hook and its registration');
});

test('compare: untouched passes; modified, missing, unexpected and symlinked files are caught', () => {
  const root = makeCache();
  const tree = parseTree(treeOf());
  assert.deepEqual(compare(tree, localState([root])), []);

  fs.appendFileSync(cachePath(root, 'core/skills/merge-monster/scripts/mm-act.sh'), '\ngh pr merge 1\n');
  fs.rmSync(cachePath(root, 'core/.claude-plugin/hooks.json'));
  const link = cachePath(root, 'core/lib/lease/baton.mjs');
  const real = `${link}.real`;
  fs.renameSync(link, real);
  fs.symlinkSync(real, link);
  const diffs = compare(tree, localState([root]));
  assert.deepEqual(diffs.map((d) => `${d.kind} ${d.path}`).sort(), [
    'missing core/.claude-plugin/hooks.json',
    'modified core/skills/merge-monster/scripts/mm-act.sh',
    'not-a-file core/lib/lease/baton.mjs',
  ]);

  // A symlinked directory on the way to a protected file is caught too.
  const viaDir = makeCache();
  const scripts = cachePath(viaDir, 'core/skills/merge-monster/scripts');
  fs.renameSync(scripts, `${scripts}.real`);
  fs.symlinkSync(`${scripts}.real`, scripts);
  assert.deepEqual(compare(tree, localState([viaDir])).map((d) => `${d.kind} ${d.path}`).sort(), [
    'not-a-file core/skills/merge-monster/scripts/mm-act.sh',
    'not-a-file core/skills/merge-monster/scripts/mm-baton.sh',
    'not-a-file core/skills/merge-monster/scripts/mm-heartbeat.sh',
  ]);

  // A file the release doesn't have: fine when absent locally too (an older release), caught when present.
  const older = parseTree({ tree: treeOf().tree.filter((e) => e.path !== 'core/lib/untrusted.mjs') });
  const fresh = makeCache();
  assert.deepEqual(compare(older, localState([fresh])).map((d) => `${d.kind} ${d.path}`), ['unexpected core/lib/untrusted.mjs']);
  fs.rmSync(cachePath(fresh, 'core/lib/untrusted.mjs'));
  assert.deepEqual(compare(older, localState([fresh])), []);
});

test('parseTree: a truncated or malformed tree is "not verified", never a pass', () => {
  assert.throws(() => parseTree({ ...treeOf(), truncated: true }), Unverified);
  assert.throws(() => parseTree('<html>'), Unverified);
  assert.throws(() => parseTree({ message: 'Not Found' }), /Not Found/);
});

test('CLI: exit 0 on an untouched cache, 1 on a tampered wrapper, 3 when GitHub fails', async () => {
  const root = makeCache();
  const fetch = async ({ repo, ref }) => { assert.equal(repo, 'eric-sabe/engsys'); assert.equal(ref, 'v9.9.9'); return parseTree(treeOf()); };
  let c = capture();
  assert.equal(await run([...ARGS, '--root', root], { fetch, out: c.out }), 0);
  assert.match(c.text(), /^verify: ok, \d+ protected files/);

  fs.appendFileSync(cachePath(root, 'core/skills/maintenance-monster/scripts/mnt-act.sh'), '# x\n');
  c = capture();
  assert.equal(await run([...ARGS, '--root', root], { fetch, out: c.out }), 1);
  assert.match(c.text(), /MISMATCH, 1 of \d+ protected files differ from eric-sabe\/engsys@v9\.9\.9/);
  assert.match(c.text(), /modified\s+\S+mnt-act\.sh/);

  c = capture();
  assert.equal(await run([...ARGS, '--root', root], { fetch: async () => { throw new Unverified('gh api failed: connect ETIMEDOUT'); }, out: c.out }), 3);
  assert.match(c.text(), /not verified against eric-sabe\/engsys@v9\.9\.9: gh api failed: connect ETIMEDOUT/);
});

test('CLI: every root is checked', async () => {
  const good = makeCache();
  const bad = makeCache();
  fs.writeFileSync(cachePath(bad, 'core/.claude-plugin/singleton-write-guard.mjs'), 'process.exit(0)\n');
  const c = capture();
  assert.equal(await run([...ARGS, '--root', good, '--root', bad], { fetch: async () => parseTree(treeOf()), out: c.out }), 1);
  assert.match(c.text(), new RegExp(`modified\\s+${fs.realpathSync(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('CLI: the throttle reuses a pass only while the files are unchanged and the cache is young', async () => {
  const root = makeCache();
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-state-')), 'verify-wrappers.json');
  let calls = 0;
  const fetch = async () => { calls++; return parseTree(treeOf()); };
  let t = 1_000_000;
  const now = () => t;
  const go = (extra = []) => run([...ARGS, '--root', root, '--cache', cache, '--max-age-min', '15', ...extra], { fetch, now, out: () => {} });

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
  assert.equal(await run([...ARGS.slice(0, 2), '--ref', 'v9.9.10', '--root', root, '--cache', cache, '--max-age-min', '15'], { fetch, now, out: () => {} }), 0);
  assert.equal(calls, 6, 'another ref is not served from the cache');

  // GitHub down after a cached pass expired: not verified (3), not a pass.
  t += 60 * 60_000;
  assert.equal(await run([...ARGS, '--root', root, '--cache', cache, '--max-age-min', '15'], { fetch: async () => { throw new Unverified('down'); }, now, out: () => {} }), 3);
});

test('CLI: usage errors exit 2', async () => {
  const c = capture();
  assert.equal(await run(['--repo', 'nope', '--ref', 'v1', '--root', '/x'], { out: c.out }), 2);
  assert.equal(await run(['--repo', 'a/b', '--ref', '../x', '--root', '/x'], { out: c.out }), 2);
  assert.equal(await run(['--repo', 'a/b', '--ref', 'feature/x', '--root', '/x'], { out: c.out }), 2);
  assert.equal(await run(['--repo', 'a/b', '--ref', 'v1'], { out: c.out }), 2);
  assert.equal(await run(['--repo', 'a/b', '--ref', 'v1', '--root', '/x', '--cache', '/c'], { out: c.out }), 2);
});
