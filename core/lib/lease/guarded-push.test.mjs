// guarded-push.test.mjs — the guarded push's git options against REAL git (engsys#71 L3).
// Runner: `node --test core/lib/lease/guarded-push.test.mjs`. A local smart-HTTP server (git
// http-backend behind Basic auth) stands in for GitHub; a fake helper stands in for the fleet's
// env-scoped credential helper (GIT_CONFIG_COUNT). Every git call runs with a scrubbed environment
// (core/lib/git-env.mjs), so nothing here reads or writes the enclosing repository or the machine's
// git config.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubbedGitEnv, hermeticGit } from "../git-env.mjs";
import { parseConfigList, pushConfigArgs, pushEnv, readPushConfig, unsafePushConfig } from "./baton.mjs";

const TOKEN = "fleet-token-123";
const ROOT = mkdtempSync(join(tmpdir(), "guarded-push-"));
const SRV = join(ROOT, "srv");
const MARK = join(ROOT, "marks");
mkdirSync(SRV);
mkdirSync(MARK);

/** A shell script that records it ran (as `name`) and, as a credential helper, can answer `get`. */
function script(name, body = "") {
  const p = join(ROOT, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\necho "$@" >> '${join(MARK, name)}'\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const FLEET_HELPER = script("fleet-helper", `[ "$1" = get ] && printf 'username=x-access-token\\npassword=${TOKEN}\\n'; exit 0`);
const EVIL_HELPER = script("evil-helper", "exit 0");
const EVIL_ASKPASS = script("evil-askpass", "echo evil");
const EVIL_SSH = script("evil-ssh", "exit 1");
const HOOKS = join(ROOT, "hooks");
mkdirSync(HOOKS);
writeFileSync(join(HOOKS, "pre-push"), `#!/bin/sh\necho ran >> '${join(MARK, "evil-hook")}'\nexit 0\n`);
chmodSync(join(HOOKS, "pre-push"), 0o755);
const ran = (name) => existsSync(join(MARK, name));
const resetMarks = () => { rmSync(MARK, { recursive: true, force: true }); mkdirSync(MARK); };

/** The smart-HTTP server: 401 without the fleet token, else git http-backend (receive-pack enabled by REMOTE_USER). */
const server = createServer((req, res) => {
  const want = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
  if (req.headers.authorization !== want) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...scrubbedGitEnv(process.env, { isolateConfig: true }),
      GIT_PROJECT_ROOT: SRV,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      REMOTE_USER: "x-access-token",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  req.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on("data", (c) => chunks.push(c));
  cgi.on("close", () => {
    const out = Buffer.concat(chunks);
    const sep = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, sep).toString("utf8").split("\r\n");
    const headers = {};
    let status = 200;
    for (const line of head) {
      const i = line.indexOf(":");
      const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10); else if (k) headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(sep + 4));
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}/r.git`;
test.after(() => { server.close(); rmSync(ROOT, { recursive: true, force: true }); });

hermeticGit(ROOT, ["init", "-q", "--bare", join(SRV, "r.git")], { isolateConfig: true });

/** A checkout an agent prepared: one commit, origin = the server, and a planted helper, askpass, ssh command and hooks dir. */
function checkout(name, { plant = true } = {}) {
  const wt = join(ROOT, name);
  const g = (args) => hermeticGit(ROOT, ["-C", wt, ...args], { isolateConfig: true });
  hermeticGit(ROOT, ["init", "-q", "-b", "main", wt], { isolateConfig: true });
  g(["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed"]);
  g(["remote", "add", "origin", ORIGIN]);
  if (!plant) return wt;
  g(["config", "credential.helper", EVIL_HELPER]);
  g(["config", "core.askPass", EVIL_ASKPASS]);
  g(["config", "core.sshCommand", EVIL_SSH]);
  g(["config", "core.hooksPath", HOOKS]);
  return wt;
}

/** A session environment: scrubbed, no prompts, no inherited askpass; `fleet` adds the env-scoped helper the way git-env.sh does. */
/** The fleet helper the way git-env.sh writes it (…/gh-app-token.mjs git-credential), so the env-scoped scan accepts it. */
const APP_TOKEN = join(ROOT, "gh-app-token.mjs");
writeFileSync(APP_TOKEN, `echo "$@" >> '${join(MARK, "fleet-helper")}'\n[ "$2" = get ] && printf 'username=x-access-token\\npassword=${TOKEN}\\n'\nexit 0\n`);
const APP_HELPER = `!sh '${APP_TOKEN}' git-credential`;

function sessionEnv({ fleet = true, globalConfig = "/dev/null", helper = FLEET_HELPER } = {}) {
  const env = scrubbedGitEnv(process.env, { isolateConfig: true });
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_GLOBAL = globalConfig;
  if (fleet) {
    const key = `credential.${ORIGIN.replace(/\/r\.git$/, "")}.helper`;
    Object.assign(env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: helper });
  }
  return env;
}

const git = (wt, args, env) => new Promise((done) => {
  execFile("git", args, { cwd: wt, env, timeout: 30_000 }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
/** The guard's options for this checkout, read the way the guarded push reads them. */
async function guardArgs(wt, env) {
  const r = await git(wt, ["config", "--list", "--show-scope", "-z"], env);
  assert.equal(r.code, 0, r.stderr);
  return pushConfigArgs(parseConfigList(r.stdout));
}
const remoteHas = (branch) => hermeticGit(ROOT, ["--git-dir", join(SRV, "r.git"), "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], { isolateConfig: true }).trim() !== "";

test("#71 L3: under the guard's options a push authenticates through the env-scoped fleet helper, and nothing planted in the checkout runs", async () => {
  resetMarks();
  const wt = checkout("wt-fleet");
  const env = sessionEnv();
  const r = await git(wt, [...(await guardArgs(wt, env)), "push", "origin", "HEAD:refs/heads/agent/1-x"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(remoteHas("agent/1-x"), "the branch reached the server");
  assert.ok(ran("fleet-helper"), "the fleet's helper answered");
  for (const m of ["evil-helper", "evil-askpass", "evil-ssh", "evil-hook"]) assert.equal(ran(m), false, `${m} must not run`);
});

test("#71 L3: resetting credential.helper without adding the fleet's helper back would break the push (why the re-add exists)", async () => {
  resetMarks();
  const wt = checkout("wt-reset-only");
  const env = sessionEnv();
  const r = await git(wt, ["-c", "core.hooksPath=/dev/null", "-c", "core.askPass=", "-c", "credential.helper=", "push", "origin", "HEAD:refs/heads/agent/2-x"], env);
  assert.notEqual(r.code, 0, "no credential: the push fails");
  assert.equal(ran("fleet-helper"), false, "-c credential.helper= wiped the env-scoped helper");
  assert.equal(remoteHas("agent/2-x"), false);
});

test("#71 L3: outside a fleet env the checkout's planted helper and askpass run on a plain push, never under the guard's options", async () => {
  resetMarks();
  const wt = checkout("wt-plain");
  const env = sessionEnv({ fleet: false });
  const plain = await git(wt, ["-c", "core.hooksPath=/dev/null", "push", "origin", "HEAD:refs/heads/agent/3-x"], env);
  assert.notEqual(plain.code, 0);
  assert.ok(ran("evil-helper") && ran("evil-askpass"), "the plant is live without the guard");
  resetMarks();
  const guarded = await git(wt, [...(await guardArgs(wt, env)), "push", "origin", "HEAD:refs/heads/agent/3-x"], env);
  assert.notEqual(guarded.code, 0, "no helper outside the checkout: no credential, and no prompt");
  for (const m of ["evil-helper", "evil-askpass", "evil-ssh", "evil-hook"]) assert.equal(ran(m), false, `${m} must not run`);
});

test("#71 L3: an operator's global helper (no env-scoped config) is kept under the guard's options", async () => {
  resetMarks();
  const wt = checkout("wt-global");
  const global = join(ROOT, "global.gitconfig");
  writeFileSync(global, `[credential "${ORIGIN.replace(/\/r\.git$/, "")}"]\n\thelper = ${FLEET_HELPER}\n`);
  const env = sessionEnv({ fleet: false, globalConfig: global });
  const r = await git(wt, [...(await guardArgs(wt, env)), "push", "origin", "HEAD:refs/heads/agent/4-x"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(remoteHas("agent/4-x"));
  assert.ok(ran("fleet-helper"));
  assert.equal(ran("evil-helper"), false);
  assert.equal(readFileSync(global, "utf8").includes("evil"), false, "the global file is untouched");
});

test("#85 L3: the push's cleaned environment still authenticates through the fleet helper, and drops planted GIT_ASKPASS / NODE_OPTIONS / GIT_SSH_COMMAND", async () => {
  resetMarks();
  const wt = checkout("wt-env", { plant: false });
  const home = mkdtempSync(join(ROOT, "home-"));
  const env = pushEnv({ ...sessionEnv({ helper: APP_HELPER }), HOME: home, GIT_ASKPASS: EVIL_ASKPASS, SSH_ASKPASS: EVIL_ASKPASS, GIT_SSH_COMMAND: EVIL_SSH, NODE_OPTIONS: "--require /nonexistent.js", GIT_CONFIG_PARAMETERS: `'credential.helper=${EVIL_HELPER}'` });
  const entries = await readPushConfig(wt, { ...sessionEnv({ helper: APP_HELPER }), HOME: home });
  assert.deepEqual(unsafePushConfig(entries), [], "the fleet's env-scoped helper passes the scan");
  assert.deepEqual(unsafePushConfig(await readPushConfig(wt, { ...sessionEnv(), HOME: home })), [`credential.${ORIGIN.replace(/\/r\.git$/, "")}.helper`], "any other env-scoped helper is refused");
  const r = await git(wt, [...pushConfigArgs(entries), "push", "origin", "HEAD:refs/heads/agent/5-x"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(remoteHas("agent/5-x"));
  assert.ok(ran("fleet-helper"));
  for (const m of ["evil-helper", "evil-askpass", "evil-ssh", "evil-hook"]) assert.equal(ran(m), false, `${m} must not run`);
});

test("#85 L3: an includeIf in the operator's global config that points into the checkout is read as the checkout's config and refused", async () => {
  const wt = realpathSync(checkout("wt-include"));
  const home = mkdtempSync(join(ROOT, "home-"));
  writeFileSync(join(wt, ".git", "evil.inc"), "[http]\n\tproxy = http://127.0.0.1:9\n");
  writeFileSync(join(home, ".gitconfig"), `[includeIf "gitdir:${wt}/"]\n\tpath = ${join(wt, ".git", "evil.inc")}\n`);
  const entries = await readPushConfig(wt, { ...sessionEnv(), HOME: home });
  const proxy = entries.find((e) => e.key === "http.proxy");
  assert.equal(proxy?.scope, "local", "relabeled from global");
  assert.ok(unsafePushConfig(entries).includes("http.proxy"));
});
