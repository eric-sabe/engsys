// Tests for gh-app-token.mjs — run by `npm test` (node --test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REQUIRED_PERMS, apiBase, cachePath, missingPermissions, parseEnvFile, parseRequiredPerms,
} from './gh-app-token.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-app-token.mjs');

// --- pure functions -----------------------------------------------------------------------------

test('parseEnvFile: comments, export, quotes, blank lines, `=` inside values', () => {
  const cfg = parseEnvFile([
    '# a comment',
    '',
    'GH_APP_ID=123',
    'export GH_APP_INSTALLATION_ID="456"',
    "GH_APP_PEM='/keys/acme.pem'",
    '  FLEET_ORG=acme  ',
    'GH_BOT_AUTHOR_EMAIL=1+acme-fleet[bot]@users.noreply.github.com',
    'not a line',
    'lower_case_ok=1',
  ].join('\n'));
  assert.equal(cfg.GH_APP_ID, '123');
  assert.equal(cfg.GH_APP_INSTALLATION_ID, '456');
  assert.equal(cfg.GH_APP_PEM, '/keys/acme.pem');
  assert.equal(cfg.FLEET_ORG, 'acme');
  assert.equal(cfg.GH_BOT_AUTHOR_EMAIL, '1+acme-fleet[bot]@users.noreply.github.com');
  assert.equal(cfg.lower_case_ok, '1');
  assert.equal('not a line' in cfg, false);
});

test('parseRequiredPerms: comma list of perm:level', () => {
  assert.deepEqual(parseRequiredPerms('contents:write, checks:read ,,metadata:read'), {
    contents: 'write', checks: 'read', metadata: 'read',
  });
  assert.deepEqual(parseRequiredPerms(''), {});
  assert.throws(() => parseRequiredPerms('contents'), /invalid GH_APP_REQUIRED_PERMS entry "contents"/);
  assert.throws(() => parseRequiredPerms('contents:rw'), /invalid/);
});

test('DEFAULT_REQUIRED_PERMS is the repo-level fleet set', () => {
  assert.deepEqual(DEFAULT_REQUIRED_PERMS, {
    contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write', workflows: 'write',
    checks: 'read', statuses: 'read', metadata: 'read',
  });
});

test('missingPermissions: equal or higher levels satisfy; short or absent ones are reported', () => {
  const have = { contents: 'write', checks: 'write', issues: 'read', metadata: 'read' };
  assert.deepEqual(missingPermissions(have, { contents: 'write', checks: 'read', metadata: 'read' }), []);
  assert.deepEqual(
    missingPermissions(have, { issues: 'write', statuses: 'read', contents: 'admin' }),
    ['issues:write (has read)', 'statuses:read (has none)', 'contents:admin (has write)'],
  );
  assert.deepEqual(missingPermissions(undefined, { metadata: 'read' }), ['metadata:read (has none)']);
  assert.deepEqual(missingPermissions({}, {}), []);
});

test('cachePath: FLEET_ORG namespacing, engsys-fleet fallback, GH_APP_CACHE override', () => {
  const home = '/home/u';
  assert.deepEqual(cachePath({ GH_APP_INSTALLATION_ID: '42', FLEET_ORG: 'acme' }, home), {
    file: '/home/u/.cache/acme/gh-app-token-42.json', custom: false,
  });
  assert.equal(cachePath({ GH_APP_INSTALLATION_ID: '42' }, home).file, '/home/u/.cache/engsys-fleet/gh-app-token-42.json');
  assert.deepEqual(cachePath({ GH_APP_INSTALLATION_ID: '42', FLEET_ORG: 'acme', GH_APP_CACHE: '~/x/tok.json' }, home), {
    file: '/home/u/x/tok.json', custom: true,
  });
  assert.equal(cachePath({ GH_APP_CACHE: '/var/tok.json' }, home).file, '/var/tok.json');
});

test('apiBase: default, override, trailing slash trimmed', () => {
  assert.equal(apiBase({}), 'https://api.github.com');
  assert.equal(apiBase({ GH_APP_API_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
});

// --- CLI against a stub API -------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-gh-app-test-'));
const HOME = path.join(TMP, 'home');
const PEM = path.join(TMP, 'app.pem');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(PEM, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });

let server;
let apiUrl;
let granted = {}; // permissions the stub grants
let requests = [];
let mints = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) {
      mints += 1;
      res.statusCode = 201;
      res.end(JSON.stringify({
        token: `ghs_test_${mints}`,
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
        permissions: granted,
      }));
    } else if (req.url.startsWith('/installation/repositories')) {
      res.end(JSON.stringify({ total_count: 1, repositories: [{ full_name: 'acme/app' }] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'Not Found' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function envFile(name, extra = {}) {
  const file = path.join(TMP, name);
  const body = { GH_APP_ID: '7', GH_APP_INSTALLATION_ID: '99', GH_APP_PEM: PEM, ...extra };
  fs.writeFileSync(file, Object.entries(body).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return file;
}

function run(args, { env = {}, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME, GH_APP_API_URL: apiUrl, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const ALL = Object.fromEntries(Object.entries(DEFAULT_REQUIRED_PERMS));

test('errors clearly when GH_APP_ENV_FILE is unset', async () => {
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GH_APP_ENV_FILE is not set/);
});

test('errors clearly when the env file is missing', async () => {
  const r = await run([], { env: { GH_APP_ENV_FILE: path.join(TMP, 'nope.env') } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /env file not found/);
});

test('errors when a required key is missing from the env file', async () => {
  const file = path.join(TMP, 'partial.env');
  fs.writeFileSync(file, 'GH_APP_ID=7\n');
  const r = await run([], { env: { GH_APP_ENV_FILE: file } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GH_APP_INSTALLATION_ID not set/);
});

test('mint: prints a token, signs a valid app JWT, caches 0600 in a 0700 dir, uses the neutral User-Agent', async () => {
  granted = ALL; requests = []; mints = 0;
  const envf = envFile('mint.env', { FLEET_ORG: 'acme' });
  const r = await run([], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ghs_test_1');

  const req = requests[0];
  assert.equal(req.headers['user-agent'], 'engsys-fleet');
  const jwt = req.headers.authorization.replace(/^Bearer /, '');
  const [h, b, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(b, 'base64url')).iss, '7');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')));

  const dir = path.join(HOME, '.cache', 'acme');
  const file = path.join(dir, 'gh-app-token-99.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'ghs_test_1');

  // second call is served from the cache: no new mint
  const again = await run([], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(again.stdout.trim(), 'ghs_test_1');
  assert.equal(mints, 1);

  // --refresh forces a re-mint
  const fresh = await run(['--refresh'], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(fresh.stdout.trim(), 'ghs_test_2');
});

test('cache defaults to the engsys-fleet directory without FLEET_ORG', async () => {
  granted = ALL;
  const envf = envFile('noorg.env');
  const r = await run([], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(HOME, '.cache', 'engsys-fleet', 'gh-app-token-99.json')));
});

test('GH_APP_CACHE in the env file overrides the cache path', async () => {
  granted = ALL;
  const custom = path.join(TMP, 'custom-cache', 'tok.json');
  const envf = envFile('cache.env', { GH_APP_CACHE: custom });
  const r = await run([], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.statSync(custom).mode & 0o777, 0o600);
});

test('--check: all default permissions present -> exit 0', async () => {
  granted = { ...ALL, extra_perm: 'write' };
  const r = await run(['--check'], { env: { GH_APP_ENV_FILE: envFile('ok.env', { FLEET_ORG: 'ok' }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK — token valid until .*1 repo\(s\): acme\/app/);
});

test('--check: short permissions -> exit 3 with the missing list and a docs pointer', async () => {
  granted = { contents: 'read', pull_requests: 'write', metadata: 'read' };
  const r = await run(['--check'], { env: { GH_APP_ENV_FILE: envFile('short.env', { FLEET_ORG: 'short' }) } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /MISSING permission\(s\)/);
  assert.match(r.stderr, /contents:write \(has read\)/);
  assert.match(r.stderr, /issues:write \(has none\)/);
  assert.doesNotMatch(r.stderr, /pull_requests/);
  assert.match(r.stderr, /core\/fleet\/identity\/README\.md/);
});

test('--check: GH_APP_REQUIRED_PERMS in the env file replaces the default set', async () => {
  granted = { metadata: 'read', organization_projects: 'read' };
  const envf = envFile('custom.env', { FLEET_ORG: 'custom', GH_APP_REQUIRED_PERMS: 'metadata:read, organization_projects:write' });
  const r = await run(['--check'], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /organization_projects:write \(has read\)/);
  assert.doesNotMatch(r.stderr, /contents/);

  granted = { metadata: 'read', organization_projects: 'write' };
  const ok = await run(['--check'], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(ok.code, 0, ok.stderr);
});

test('--check: a malformed GH_APP_REQUIRED_PERMS is a hard failure (exit 1)', async () => {
  granted = ALL;
  const envf = envFile('bad.env', { FLEET_ORG: 'bad', GH_APP_REQUIRED_PERMS: 'contents' });
  const r = await run(['--check'], { env: { GH_APP_ENV_FILE: envf } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid GH_APP_REQUIRED_PERMS/);
});

test('--check: an API failure is exit 1, not 3', async () => {
  const envf = envFile('down.env', { FLEET_ORG: 'down' });
  const r = await run(['--check'], { env: { GH_APP_ENV_FILE: envf, GH_APP_API_URL: 'http://127.0.0.1:1' } });
  assert.equal(r.code, 1);
});

test('git-credential get: github.com over https yields the token; other hosts and store/erase yield nothing', async () => {
  granted = ALL;
  const envf = envFile('cred.env', { FLEET_ORG: 'cred' });
  const env = { GH_APP_ENV_FILE: envf };
  const ok = await run(['git-credential', 'get'], { env, input: 'protocol=https\nhost=github.com\n\n' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^username=x-access-token\npassword=ghs_test_\d+\n$/);
  const other = await run(['git-credential', 'get'], { env, input: 'protocol=https\nhost=example.com\n\n' });
  assert.equal(other.stdout, '');
  const http1 = await run(['git-credential', 'get'], { env, input: 'protocol=http\nhost=github.com\n\n' });
  assert.equal(http1.stdout, '');
  const store = await run(['git-credential', 'store'], { env, input: 'protocol=https\nhost=github.com\n\n' });
  assert.equal(store.stdout, '');
});
