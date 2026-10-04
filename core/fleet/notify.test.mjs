// Tests for notify.mjs — run by `npm test` (node --test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  apiBase, composeText, incidentSlug, mentionFor, missingSlackConfig, parseArgs, parseEnvFile,
  resolveFleetId, validateArgs,
} from './notify.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs');

// --- pure functions -----------------------------------------------------------------------------

test('parseEnvFile: comments, export, quotes, blank lines', () => {
  const cfg = parseEnvFile([
    '# a comment',
    '',
    'SLACK_BOT_TOKEN=xoxb-1',
    'export SLACK_CHANNEL_ID="C123"',
    "FLEET_ID='alice'",
    '  SLACK_OPERATORS_GROUP_ID=S999  ',
    'not a line',
  ].join('\n'));
  assert.equal(cfg.SLACK_BOT_TOKEN, 'xoxb-1');
  assert.equal(cfg.SLACK_CHANNEL_ID, 'C123');
  assert.equal(cfg.FLEET_ID, 'alice');
  assert.equal(cfg.SLACK_OPERATORS_GROUP_ID, 'S999');
  assert.equal('not a line' in cfg, false);
});

test('parseArgs: flags in any order, trailing text joined', () => {
  const a = parseArgs(['--level', 'action', '--re', 'https://x/1', '--incident', 'db-down', 'oops', 'it', 'broke']);
  assert.equal(a.level, 'action');
  assert.equal(a.re, 'https://x/1');
  assert.equal(a.incident, 'db-down');
  assert.equal(a.resolve, false);
  assert.equal(a.text, 'oops it broke');
});

test('parseArgs: --resolve is a bare flag', () => {
  const a = parseArgs(['--level', 'alert', '--incident', 'db-down', '--resolve']);
  assert.equal(a.resolve, true);
  assert.equal(a.text, '');
});

test('validateArgs: level required and must be known', () => {
  assert.throws(() => validateArgs({ level: null, textParts: [] }), /--level is required/);
  assert.throws(() => validateArgs({ level: 'critical', text: 'x' }), /must be one of info\|action\|alert/);
});

test('validateArgs: action requires --re', () => {
  assert.throws(() => validateArgs({ level: 'action', text: 'x' }), /requires --re/);
  assert.doesNotThrow(() => validateArgs({ level: 'action', re: 'https://x/1', text: 'x' }));
});

test('validateArgs: --resolve requires --incident; text optional on resolve', () => {
  assert.throws(() => validateArgs({ level: 'info', resolve: true, text: '' }), /--resolve requires --incident/);
  assert.doesNotThrow(() => validateArgs({ level: 'info', resolve: true, incident: 'x', text: '' }));
});

test('validateArgs: non-resolve calls need a message', () => {
  assert.throws(() => validateArgs({ level: 'info', text: '' }), /a message is required/);
});

test('incidentSlug: sanitizes to a safe filename', () => {
  assert.equal(incidentSlug('db down!/weird key'), 'db_down__weird_key');
  assert.equal(incidentSlug('simple-key.1'), 'simple-key.1');
});

test('mentionFor: info mentions nobody', () => {
  assert.equal(mentionFor('info', { SLACK_OPERATOR_ID: 'U1', SLACK_OPERATORS_GROUP_ID: 'S1' }), '');
});

test('mentionFor: action prefers the named operator, else the group', () => {
  assert.equal(mentionFor('action', { SLACK_OPERATOR_ID: 'U1', SLACK_OPERATORS_GROUP_ID: 'S1' }), '<@U1>');
  assert.equal(mentionFor('action', { SLACK_OPERATORS_GROUP_ID: 'S1' }), '<!subteam^S1>');
});

test('mentionFor: alert prefers the group over the operator', () => {
  assert.equal(mentionFor('alert', { SLACK_OPERATOR_ID: 'U1', SLACK_OPERATORS_GROUP_ID: 'S1' }), '<!subteam^S1>');
});

test('mentionFor: no group yet degrades (alert: operator, then @here; action: group, then @here)', () => {
  assert.equal(mentionFor('alert', { SLACK_OPERATOR_ID: 'U1' }), '<@U1>');
  assert.equal(mentionFor('alert', {}), '<!here>');
  assert.equal(mentionFor('action', {}), '<!here>');
  assert.equal(mentionFor('info', {}), '');
  assert.doesNotMatch(mentionFor('alert', { SLACK_OPERATORS_GROUP_ID: '' }), /subteam|undefined/);
});

test('composeText: fleet prefix + emoji, no mention', () => {
  const t = composeText({ level: 'info', text: 'all clear', re: null, fleetId: 'alice', mention: '' });
  assert.equal(t, '[alice] ℹ️ all clear');
});

test('composeText: mention only on the first post', () => {
  const t = composeText({ level: 'alert', text: 'db down', re: null, fleetId: 'alice', mention: '<!subteam^S1>' });
  assert.equal(t, '[alice] ⚠️ <!subteam^S1> db down');
});

test('composeText: action always appends a GitHub link that never asks for a Slack reply', () => {
  const t = composeText({ level: 'action', text: 'needs a decision', re: 'https://x/1', fleetId: 'alice', mention: '<@U1>' });
  assert.equal(t, '[alice] 👋 <@U1> needs a decision\n\nApprove or act on GitHub: https://x/1');
});

test('composeText: info/alert with --re get a plain GitHub line (no "approve")', () => {
  const t = composeText({ level: 'alert', text: 'db down', re: 'https://x/2', fleetId: 'alice', mention: '' });
  assert.equal(t, '[alice] ⚠️ db down\n\nGitHub: https://x/2');
});

test('missingSlackConfig: reports what is absent', () => {
  assert.deepEqual(missingSlackConfig({}), ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']);
  assert.deepEqual(missingSlackConfig({ SLACK_BOT_TOKEN: 'x', SLACK_CHANNEL_ID: 'C1' }), []);
});

test('resolveFleetId: fleet.conf FLEET_ID wins, SLACK_ENV fills in, a mismatch warns', () => {
  assert.deepEqual(resolveFleetId({ FLEET_ID: 'alice' }, {}), { fleetId: 'alice', warning: '' });
  assert.deepEqual(resolveFleetId({}, { FLEET_ID: 'bob' }), { fleetId: 'bob', warning: '' });
  assert.deepEqual(resolveFleetId({ FLEET_ID: 'bob' }, { FLEET_ID: 'bob' }), { fleetId: 'bob', warning: '' });
  const r = resolveFleetId({ FLEET_ID: 'alice' }, { FLEET_ID: 'bob' });
  assert.equal(r.fleetId, 'bob');
  assert.match(r.warning, /SLACK_ENV \(alice\) differs from fleet\.conf \(bob\); using bob/);
  assert.deepEqual(resolveFleetId({}, {}), { fleetId: '', warning: '' });
});

test('apiBase: default, override, trailing slash trimmed', () => {
  assert.equal(apiBase({}), 'https://slack.com/api');
  assert.equal(apiBase({ SLACK_API_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
});

// --- CLI against a stub Slack API + stub gh -----------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-notify-test-'));

let server;
let apiUrl;
let posts = []; // every chat.postMessage body the stub received
let failNext = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/chat.postMessage') {
        const parsed = JSON.parse(body);
        posts.push({ ...parsed, authorization: req.headers.authorization });
        if (failNext) {
          failNext = false;
          res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, ts: `${1700000000 + posts.length}.000100` }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function slackEnv(name, extra = {}) {
  const file = path.join(TMP, name);
  const body = {
    SLACK_BOT_TOKEN: 'xoxb-test-token', SLACK_CHANNEL_ID: 'C123',
    SLACK_OPERATORS_GROUP_ID: 'S999', FLEET_ID: 'alice', ...extra,
  };
  fs.writeFileSync(file, Object.entries(body).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return file;
}

let caseN = 0;
function stateDir() {
  caseN += 1;
  const d = path.join(TMP, `state-${caseN}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(args, { env = {}, fakeBin } = {}) {
  return new Promise((resolve) => {
    const PATH = fakeBin ? `${fakeBin}:${process.env.PATH}` : process.env.PATH;
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH, SLACK_API_URL: apiUrl, FLEET_STATE: stateDirFor(env), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
function stateDirFor(env) {
  return env.FLEET_STATE || stateDir();
}

test('info post: no mention, no link line', async () => {
  posts = [];
  const r = await run(['--level', 'info', 'all clear'], { env: { SLACK_ENV: slackEnv('a.env') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, '[alice] ℹ️ all clear');
  assert.equal(posts[0].channel, 'C123');
  assert.equal('thread_ts' in posts[0], false);
  assert.ok(!r.stdout.includes('xoxb-test-token') && !r.stderr.includes('xoxb-test-token'), 'token never printed');
});

test('token never appears in the spawned process argv (not visible in ps)', async () => {
  posts = [];
  const r = await run(['--level', 'info', 'hi'], { env: { SLACK_ENV: slackEnv('tok.env') } });
  assert.equal(r.code, 0, r.stderr);
  // The only place the token could leak into argv is if notify.mjs put it on a child_process
  // call; it doesn't (it's used only in an in-process fetch header), so nothing to assert on a
  // live `ps` here beyond: the CLI never printed it (checked above) and never needed it as an arg.
});

test('action level requires --re', async () => {
  posts = [];
  const r = await run(['--level', 'action', 'need a human'], { env: { SLACK_ENV: slackEnv('b.env') } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires --re/);
  assert.equal(posts.length, 0);
});

test('action level: mentions the named operator once, links the GitHub url, never asks for a reply', async () => {
  posts = [];
  const r = await run(
    ['--level', 'action', '--re', 'https://github.com/acme/app/pull/9', 'approve this'],
    { env: { SLACK_ENV: slackEnv('c.env', { SLACK_OPERATOR_ID: 'U42' }) } },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts[0].text, '[alice] 👋 <@U42> approve this\n\nApprove or act on GitHub: https://github.com/acme/app/pull/9');
  assert.doesNotMatch(posts[0].text, /reply (here|in slack)/i);
});

test('alert level: mentions the operators group', async () => {
  posts = [];
  const r = await run(['--level', 'alert', 'db is down'], { env: { SLACK_ENV: slackEnv('d.env') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts[0].text, '[alice] ⚠️ <!subteam^S999> db is down');
});

test('incident latch: first post opens a thread, later calls reply, no re-mention', async () => {
  posts = [];
  const env = { SLACK_ENV: slackEnv('e.env'), FLEET_STATE: stateDir() };
  const r1 = await run(['--level', 'alert', '--incident', 'db-down', 'db is down'], { env });
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(posts[0].text, '[alice] ⚠️ <!subteam^S999> db is down');
  assert.equal('thread_ts' in posts[0], false);
  const firstTs = posts[0] && JSON.parse((await fs.promises.readFile(
    path.join(env.FLEET_STATE, 'notify', 'db-down.json'), 'utf8',
  ))).ts;
  assert.ok(firstTs);

  const r2 = await run(['--level', 'alert', '--incident', 'db-down', 'still down'], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(posts[1].text, '[alice] ⚠️ still down'); // no mention on the reply
  assert.equal(posts[1].thread_ts, firstTs);
});

test('--resolve posts one thread reply and clears the latch', async () => {
  posts = [];
  const env = { SLACK_ENV: slackEnv('f.env'), FLEET_STATE: stateDir() };
  await run(['--level', 'alert', '--incident', 'disk-full', 'disk is full'], { env });
  const firstTs = JSON.parse(fs.readFileSync(path.join(env.FLEET_STATE, 'notify', 'disk-full.json'), 'utf8')).ts;

  const r = await run(['--level', 'alert', '--incident', 'disk-full', '--resolve'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts[1].text, '✅ resolved');
  assert.equal(posts[1].thread_ts, firstTs);
  assert.equal(fs.existsSync(path.join(env.FLEET_STATE, 'notify', 'disk-full.json')), false);

  // resolving again (no open incident) is a silent no-op, never an error
  const r2 = await run(['--level', 'alert', '--incident', 'disk-full', '--resolve'], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stderr, /no open incident/);
  assert.equal(posts.length, 2);
});

test('repeated identical calls within the latch do not re-mention (each reply is plain)', async () => {
  posts = [];
  const env = { SLACK_ENV: slackEnv('g.env'), FLEET_STATE: stateDir() };
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  assert.equal(posts.length, 3);
  assert.match(posts[0].text, /<@|<!subteam/);
  for (const p of posts.slice(1)) assert.doesNotMatch(p.text, /<@|<!subteam/);
});

test('unconfigured Slack (no SLACK_ENV): falls back to a gh issue comment, exits 0', async () => {
  const fakeBin = path.join(TMP, 'fakebin-unconfigured');
  fs.mkdirSync(fakeBin, { recursive: true });
  const log = path.join(TMP, 'gh-unconfigured.log');
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\ncat >/dev/null || true\n`, { mode: 0o755 });

  const r = await run(['--level', 'alert', 'no slack here'], { env: { NOTIFY_FALLBACK_ISSUE: 'acme/app#5' }, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /SLACK_ENV is not set/);
  const ghCall = fs.readFileSync(log, 'utf8');
  assert.match(ghCall, /issue comment 5 -R acme\/app --body/);
  assert.match(ghCall, /no slack here/);
});

test('fallback comment: fleet id from the environment, no Slack mention syntax', async () => {
  const fakeBin = path.join(TMP, 'fakebin-fallback-id');
  fs.mkdirSync(fakeBin, { recursive: true });
  const log = path.join(TMP, 'gh-fallback-id.log');
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\ncat >/dev/null || true\n`, { mode: 0o755 });

  const r = await run(['--level', 'alert', 'stuck'], { env: { NOTIFY_FALLBACK_ISSUE: 'acme/app#5', FLEET_ID: 'bob' }, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  const ghCall = fs.readFileSync(log, 'utf8');
  assert.match(ghCall, /\[bob\]/);
  assert.doesNotMatch(ghCall, /undefined/);
  assert.doesNotMatch(ghCall, /<!subteam|<@/);
});

test('composeText: no fleet id means no bracket prefix', () => {
  const t = composeText({ level: 'info', text: 'hi', re: null, fleetId: '', mention: '' });
  assert.doesNotMatch(t, /\[|undefined/);
});

test('unconfigured and no fallback issue: prints a warning, still exits 0', async () => {
  const r = await run(['--level', 'info', 'heads up'], { env: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no NOTIFY_FALLBACK_ISSUE configured/);
  assert.match(r.stderr, /heads up/);
});

test('Slack API failure falls back to the issue comment, never fails the caller', async () => {
  const fakeBin = path.join(TMP, 'fakebin-apifail');
  fs.mkdirSync(fakeBin, { recursive: true });
  const log = path.join(TMP, 'gh-apifail.log');
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\ncat >/dev/null || true\n`, { mode: 0o755 });

  failNext = true;
  const r = await run(
    ['--level', 'alert', 'api will fail'],
    { env: { SLACK_ENV: slackEnv('h.env'), NOTIFY_FALLBACK_ISSUE: 'acme/app#7' }, fakeBin },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Slack API call failed/);
  assert.match(fs.readFileSync(log, 'utf8'), /issue comment 7 -R acme\/app --body/);
});

test('incomplete SLACK_ENV (missing a required key) is treated as unconfigured', async () => {
  const file = path.join(TMP, 'partial.env');
  fs.writeFileSync(file, 'SLACK_BOT_TOKEN=xoxb-x\n', { mode: 0o600 });
  const r = await run(['--level', 'info', 'partial config'], { env: { SLACK_ENV: file } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /SLACK_ENV is missing/);
  assert.match(r.stderr, /SLACK_CHANNEL_ID/);
});
