// git-env.mjs — a hermetic environment for child `git` processes.
//
// Zero-dependency ESM, Node >= 20. Public API:
//   GIT_LOCATION_VARS            the env vars git uses to locate the repository it operates on
//   scrubbedGitEnv(base?, opts?) a copy of `base` (default process.env) with those removed
//   hermeticGit(cwd, args, opts?) run `git` in `cwd` with the scrubbed env, return stdout
//
// The hazard. When a process shells out to `git`, an inherited `GIT_DIR` (and its siblings) makes
// git operate on THAT repository instead of the directory the command runs in. A git hook exports
// them: `git push` runs the pre-push hook with `GIT_DIR` / `GIT_WORK_TREE` set, and everything the
// hook starts (a precheck script, a test runner) inherits them. A read-only call then reads the
// wrong tree; `git init` / `git config` silently rewrites the developer's REAL repository config:
// flipping `core.bare=true` (which breaks every linked worktree on the machine) and injecting a
// bogus `[user]` identity.
//
// The fix is to strip the location variables from the child's environment so every git call
// targets its own `cwd`. It is invisible in a plain local test run (nothing exports GIT_DIR), which
// is why it needs a test that exports one on purpose (see git-env.test.mjs).

import { execFileSync } from 'node:child_process';

/** The env vars git uses to locate the repository (and index, objects) it operates on. */
export const GIT_LOCATION_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]);

/**
 * A copy of `base` (default `process.env`) with every git repo-location variable removed, so a
 * spawned git command acts on its `cwd`, not on an inherited `GIT_DIR`. Never mutates `base`.
 *
 * Options:
 *   isolateConfig  also ignore the machine's system/global git config (`GIT_CONFIG_NOSYSTEM=1`,
 *                  `GIT_CONFIG_GLOBAL=/dev/null`) and drop an inherited `GIT_CONFIG` plus any
 *                  environment-scoped config (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_CONFIG_PARAMETERS`). Use it for
 *                  throwaway temp repos so their behavior can't depend on, or leak into, the
 *                  developer's config.
 */
export function scrubbedGitEnv(base = process.env, opts = {}) {
  const env = { ...base };
  for (const key of GIT_LOCATION_VARS) delete env[key];
  if (opts.isolateConfig) {
    // An inherited GIT_CONFIG would force git to read that exact file, defeating the isolation.
    delete env.GIT_CONFIG;
    // Environment-scoped config (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS) outranks every
    // file — e.g. a fleet session's bot identity and credential helper — so drop it too.
    delete env.GIT_CONFIG_PARAMETERS;
    for (const k of Object.keys(env)) {
      if (k === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
    }
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
  }
  return env;
}

/**
 * Run `git <args>` in `cwd` hermetically and return stdout as a string (throws on a non-zero exit,
 * like `execFileSync`). Repo-location variables are scrubbed, so it acts on `cwd`, never on an
 * inherited `GIT_DIR`.
 *
 * NEVER set author identity with `git config`; that writes a config file, which is exactly the
 * damage this module prevents. Pass it per invocation instead:
 *
 *   hermeticGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=t@example.com',
 *                      'commit', '--allow-empty', '-m', 'seed'], { isolateConfig: true });
 *
 * Options: `isolateConfig` (see `scrubbedGitEnv`), `env` (extra variables merged over the scrubbed
 * env), `input` (stdin text), `stdio` (passed through; default pipes).
 */
export function hermeticGit(cwd, args, opts = {}) {
  const { isolateConfig, env: extra, ...rest } = opts;
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...rest,
    cwd,
    env: { ...scrubbedGitEnv(process.env, { isolateConfig }), ...extra },
  });
}
