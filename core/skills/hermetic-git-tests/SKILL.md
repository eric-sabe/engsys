---
name: hermetic-git-tests
description: Keep tests and tools that shell out to git from touching the enclosing repository when run from a git hook. A pre-push hook exports GIT_DIR, so a child `git init` or `git config` inside a test rewrites the real repo (core.bare=true breaks every worktree). Covers the git-env.mjs helper, a meta-test that fails the suite on raw git calls, and a pre-push guard. Use when writing or reviewing tests that create temp git repos, when a repo suddenly reports "must be run in a work tree", or when adding a pre-push gate.
---

# Hermetic git in tests and tools

## The failure mode

A test builds a throwaway repo by shelling out to git:

```js
execFileSync('git', ['init', '-q'], { cwd: tmp });                 // no `env`
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
```

With no `env`, the child inherits the parent's environment. Run by hand, that is harmless: nothing
exports `GIT_DIR`. But `git push` runs the **pre-push hook** with `GIT_DIR` (and `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, ...) pointing at the pushing checkout, and everything the hook starts (a precheck
script, the test runner, every test) inherits them. Git then honors `GIT_DIR` over the `cwd`, so
`git init` and `git config` act on the **real repository**.

Linked worktrees share the main repo's config, so one push corrupts every checkout on the machine:

- `core.bare = true`: every git command fails with `fatal: this operation must be run in a work tree`.
- an injected `[user]` identity: later commits from any worktree are silently mis-authored.

It reproduces only under the hook, so a plain local test run never shows it. Read-only git calls are
affected too (they read the wrong tree), just less destructively.

## The fix: `core/lib/git-env.mjs`

Zero dependencies, ESM, Node >= 20.

```js
import { hermeticGit, scrubbedGitEnv } from './git-env.mjs';

// Test setup: every git call goes through the helper; identity is per invocation, never `git config`.
hermeticGit(tmp, ['init', '-q'], { isolateConfig: true });
hermeticGit(tmp, ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
                  'commit', '-q', '--allow-empty', '-m', 'seed'], { isolateConfig: true });

// Production code that spawns git and can run under a hook: scrub the env yourself.
execFileSync('git', ['log', '--oneline'], { cwd: dir, env: scrubbedGitEnv() });
```

- `scrubbedGitEnv(base = process.env, { isolateConfig })` returns a copy with `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR` and
  `GIT_PREFIX` removed. `isolateConfig` also sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`
  and drops `GIT_CONFIG`, so a throwaway repo neither depends on nor leaks into the machine's config.
- `hermeticGit(cwd, args, opts)` is `execFileSync('git', ...)` with that env; it returns stdout.
- **Never set identity with `git config`** in a test. It writes a config file, which is the exact damage.
  Use `-c user.name=... -c user.email=...` per invocation, or `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env.
- Shell tests: `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git ...`, or `unset` them at the top of
  the test script (and `export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null`).

## Prove it: a regression test that simulates the hook

Export `GIT_DIR` at a throwaway "real" repo, run the throwaway git operations through the helper, and
assert the real repo's `.git/config` is **byte-identical**. Include a control (an un-scrubbed
`git config` really does change it) so the test can't pass vacuously. `core/lib/git-env.test.mjs` is
the reference.

## Meta-test: fail the suite when a test spawns raw git

A helper only works if it is used. This test scans the test sources and fails on `git init` /
`git config` spawned directly. Save as `test/no-raw-git.test.mjs` and adjust `ROOTS`:

```js
// Meta-test: no test may spawn raw `git init` / `git config`. Every such call must go through
// the hermetic helper (git-env.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOTS = [HERE];                       // add other test directories here
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts']);
const VERBS = '(?:init|config)';            // add 'clone', 'remote', 'worktree' if you like
const SPAWN = '(?:execFileSync|spawnSync|execSync|execFile|exec|spawn)\\(';

// Array form: execFileSync("git", [... "init" | "config" ...]). The 200-char window also
// spans global options such as ["-C", dir, "config", ...].
const RAW_GIT_ARRAY = new RegExp(`${SPAWN}\\s*["']git["'][\\s\\S]{0,200}?["']${VERBS}["']`);
// Shell form: execSync("git init -q"), exec(`git -C /repo config user.name x`).
const RAW_GIT_SHELL = new RegExp(`${SPAWN}\\s*[\`"'][^\`"')]*?\\bgit\\b[^\`"')]*?\\b${VERBS}\\b`);
// Escape hatch for a deliberate raw call (e.g. a control that proves the hazard): put this marker
// on the same line or the line above. Keep such uses rare and reviewed.
const ALLOW = /raw-git-ok/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('the detectors fire on what they must catch and stay quiet on the sanctioned forms', () => {
  // Controls: without these the "no offenders" test below could pass vacuously.
  assert.ok(RAW_GIT_ARRAY.test('execFileSync("git", ["init", "-q"])'));
  assert.ok(RAW_GIT_ARRAY.test('spawnSync("git", ["-C", dir, "config", "u.n", "x"])'));
  assert.ok(RAW_GIT_SHELL.test('execSync("git init -q")'));
  assert.ok(RAW_GIT_SHELL.test('execSync(`git -C /repo config user.name x`)'));
  assert.ok(!RAW_GIT_ARRAY.test('hermeticGit(repo, ["init", "-q"])'));
  assert.ok(!RAW_GIT_SHELL.test('execFileSync("git", ["rev-parse", "--show-toplevel"])'));
});

test('tests reach git init/config only through the hermetic helper', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      if (!EXTS.has(extname(file)) || file === fileURLToPath(import.meta.url)) continue;
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      const allowed = (idx) => ALLOW.test(lines[idx] ?? '') || ALLOW.test(lines[idx - 1] ?? '');
      for (const re of [RAW_GIT_ARRAY, RAW_GIT_SHELL]) {
        const g = new RegExp(re.source, 'g');
        for (let m; (m = g.exec(src)); ) {
          const line = src.slice(0, m.index).split('\n').length - 1;
          if (!allowed(line)) offenders.push(`${relative(root, file)}:${line + 1}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [], 'raw git init/config in tests; use hermeticGit (see git-env.mjs)');
});
```

Notes: it is a regex lint, not a parser. It catches the direct forms, not a git call hidden behind your own
wrapper (so keep wrappers in one helper file that scrubs the env and is itself excluded or reviewed).
Under vitest/jest swap the `node:test` import for the runner's `describe/it/expect`. Shell test
files (`*.sh`) need their own grep: fail on `git (init|config)` lines not preceded by `env -u GIT_DIR`.

## Pre-push guard: catch the corruption immediately

Run this after the test step of the pre-push gate (or in the hook itself). It is read-only and
cheap, so run it on every push. A corrupting run is then caught right there, not hours later when
another worktree fails.

```sh
#!/bin/sh
# git-config hermeticity guard: run after the test step of the pre-push gate.
# GUARD_EMAIL_GLOBS: space-separated case-globs for identities a test would inject,
# e.g. "*@example.invalid *@test.local". Empty disables the identity check.
GUARD_EMAIL_GLOBS="${GUARD_EMAIL_GLOBS:-*@example.invalid *@test.local}"

bare=$(git config --local --get core.bare 2>/dev/null || true)
email=$(git config --local --get user.email 2>/dev/null || true)

if [ "$bare" = "true" ]; then
  echo "guard: core.bare=true. A non-hermetic git test rewrote the shared repo config." >&2
  echo "guard: repair: cfg=\"\$(git rev-parse --git-common-dir)/config\"; cp \"\$cfg\" \"\$cfg.bak\"; git config --file \"\$cfg\" core.bare false" >&2
  exit 1
fi
for glob in $GUARD_EMAIL_GLOBS; do
  # shellcheck disable=SC2254  # the glob is meant to be expanded as a case pattern
  case "$email" in
    $glob)
      echo "guard: repo user.email is '$email', an identity a test injected into the shared config." >&2
      echo "guard: repair: git config --local --unset-all user.email; git config --local --unset-all user.name" >&2
      exit 1 ;;
  esac
done
exit 0
```

Set `GUARD_EMAIL_GLOBS` to the address domain your own tests use for throwaway identities (use a
reserved domain such as `example.invalid`, which no real committer has). The guard only reads the
repo-local config, so a legitimate identity in your global config never trips it.

## Remediation if it already happened

```sh
# Resolve the SHARED git dir first: worktrees keep no config at ./.git/config, and once
# core.bare=true, `git -C <worktree>` may refuse. Fall back to the main checkout's path.
CFG="$(git rev-parse --git-common-dir 2>/dev/null)/config"
cp "$CFG" "$CFG.bak.$(date +%s)"                 # back up first
git config --file "$CFG" core.bare false
git config --file "$CFG" --remove-section user    # if injected
git status                                         # confirm git works again
```

Then check `git log --all --author=<injected name>` for mis-authored commits. Repair is temporary
until the hermetic fix is on the branch you push from: the next push that runs the tests corrupts it
again. See the lesson `lessons-library/git-core-bare-flip-breaks-all-worktrees.md`.
