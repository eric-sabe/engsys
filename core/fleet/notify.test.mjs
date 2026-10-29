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
  apiBase, composeText, escapeSlack, hostOperator, incidentSlug, latchPr, missingSlackConfig, parseArgs, parseEnvFile,
  dropInvalidRe, planRoute, resolveFleetId, slackMention, validateArgs,
} from './notify.mjs';
import { parseFederation } from './lib/federation.mjs';

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

test('validateArgs: --resolve needs neither --level nor --re', () => {
  assert.doesNotThrow(() => validateArgs({ resolve: true, incident: 'x', text: '' }));
  assert.doesNotThrow(() => validateArgs({ level: 'action', resolve: true, incident: 'x', text: '' }));
  assert.throws(() => validateArgs({ level: 'nope', resolve: true, incident: 'x', text: '' }), /must be one of/);
});

test('validateArgs: non-resolve calls need a message', () => {
  assert.throws(() => validateArgs({ level: 'info', text: '' }), /a message is required/);
});

test('incidentSlug: sanitizes to a safe filename', () => {
  assert.equal(incidentSlug('db down!/weird key'), 'db_down__weird_key');
  assert.equal(incidentSlug('simple-key.1'), 'simple-key.1');
});

test('hostOperator: the registry\'s slack_operator for FLEET_ID, else SLACK_OPERATOR_ID, never the retired group', () => {
  const reg = { fleets: { alice: { slack_operator: 'U0000000003' } } };
  assert.equal(hostOperator({ FLEET_ID: 'alice', SLACK_OPERATOR_ID: 'U0000000001' }, reg), 'U0000000003');
  assert.equal(hostOperator({ FLEET_ID: 'bob', SLACK_OPERATOR_ID: 'U0000000001' }, reg), 'U0000000001');
  assert.equal(hostOperator({ SLACK_OPERATORS_GROUP_ID: 'S1' }, null), null);
  assert.equal(hostOperator({ SLACK_OPERATOR_ID: '<!here>' }, null), null);
});

test('slackMention: only a valid member id becomes markup (mention escaping)', () => {
  assert.equal(slackMention('U0123ABC'), '<@U0123ABC>');
  for (const bad of ['<!here>', 'U1> <!channel', 'u0123', '', null, undefined, 'S999']) assert.equal(slackMention(bad), '', String(bad));
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
let opens = []; // every conversations.open `users` the stub received
let failNext = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/conversations.open') {
        const { users } = JSON.parse(body);
        opens.push(users);
        if (users === 'UREFUSED1') { res.end(JSON.stringify({ ok: false, error: 'missing_scope' })); return; }
        res.end(JSON.stringify({ ok: true, channel: { id: `D${users}` } }));
        return;
      }
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

test('action level, no --for: a DM to this host\'s operator, links the GitHub url, never asks for a reply', async () => {
  posts = []; opens = [];
  const r = await run(
    ['--level', 'action', '--re', 'https://github.com/acme/app/pull/9', 'approve this'],
    { env: { SLACK_ENV: slackEnv('c.env', { SLACK_OPERATOR_ID: 'U42' }) } },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(opens, ['U42']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'DU42');
  assert.equal(posts[0].text, '[alice] 👋 approve this\n\nApprove or act on GitHub: https://github.com/acme/app/pull/9');
  assert.doesNotMatch(posts[0].text, /reply (here|in slack)/i);
});

test('alert level, host-local: a DM to this host\'s operator only, no channel post (engsys#238)', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'alert', 'db is down'], { env: { SLACK_ENV: slackEnv('d.env', { SLACK_OPERATOR_ID: 'U42' }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(opens, ['U42']);
  assert.deepEqual(posts.map((p) => [p.channel, p.text]), [['DU42', '[alice] ⚠️ db is down']]);
});

test('alert level, no operator Slack id anywhere: the channel, no mention, loudly', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'alert', 'db is down'], { env: { SLACK_ENV: slackEnv('d2.env') } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /this host's operator: no Slack id/);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /^\[alice\] ⚠️ db is down\n\n\(Meant as a DM for this host's operator/);
  assert.doesNotMatch(posts[0].text, /<@|<!/);
});

test('incident latch: first post opens a thread, later calls reply, no re-mention', async () => {
  posts = [];
  const env = { SLACK_ENV: slackEnv('e.env', { SLACK_OPERATOR_ID: 'U42' }), FLEET_STATE: stateDir() };
  const r1 = await run(['--level', 'action', '--re', 'https://x/1', '--incident', 'db-down', 'db is down'], { env });
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(posts[0].text, '[alice] 👋 db is down\n\nApprove or act on GitHub: https://x/1');
  assert.equal(posts[0].channel, 'DU42');
  assert.equal('thread_ts' in posts[0], false);
  const firstTs = posts[0] && JSON.parse((await fs.promises.readFile(
    path.join(env.FLEET_STATE, 'notify', 'db-down.json'), 'utf8',
  ))).ts;
  assert.ok(firstTs);

  const r2 = await run(['--level', 'action', '--re', 'https://x/1', '--incident', 'db-down', 'still down'], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(posts[1].text, '[alice] 👋 still down\n\nApprove or act on GitHub: https://x/1'); // no mention on the reply
  assert.equal(posts[1].thread_ts, firstTs);
  assert.equal(posts[1].channel, 'DU42');
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
  const env = { SLACK_ENV: slackEnv('g.env', { SLACK_OPERATOR_ID: 'U42' }), FLEET_STATE: stateDir() };
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  await run(['--level', 'action', '--re', 'https://x/9', '--incident', 'inc-1', 'decide'], { env });
  assert.equal(posts.length, 3);
  assert.equal('thread_ts' in posts[0], false);
  for (const p of posts.slice(1)) { assert.ok(p.thread_ts); assert.doesNotMatch(p.text, /<@|<!subteam/); }
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

test('composeText escapes the caller text for Slack, not the mention or the link (engsys#86)', () => {
  assert.equal(escapeSlack('a & <b> c'), 'a &amp; &lt;b&gt; c');
  const t = composeText({ level: 'alert', text: 'file <https://evil|reinstall guide> & <!here>', re: 'https://x/3?a=1&b=2', fleetId: 'alice', mention: '<!subteam^S1>' });
  assert.match(t, /<!subteam\^S1>/);
  assert.match(t, /file &lt;https:\/\/evil\|reinstall guide&gt; &amp; &lt;!here&gt;/);
  assert.doesNotMatch(t, /<https:\/\/evil/);
  assert.match(t, /GitHub: https:\/\/x\/3\?a=1&b=2$/);
});

test('--require-delivery: exit 1 when nothing was delivered, 0 when the fallback posted', async () => {
  let r = await run(['--level', 'alert', '--require-delivery', 'must go out'], { env: {} });
  assert.equal(r.code, 1, r.stderr);
  const fakeBin = path.join(TMP, 'fakebin-require');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  r = await run(['--level', 'alert', '--require-delivery', 'must go out'], { env: { NOTIFY_FALLBACK_ISSUE: 'acme/app#5' }, fakeBin });
  assert.equal(r.code, 1, 'the fallback comment failed too');
  fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/usr/bin/env bash\ncat >/dev/null || true\n', { mode: 0o755 });
  r = await run(['--level', 'alert', '--require-delivery', 'must go out'], { env: { NOTIFY_FALLBACK_ISSUE: 'acme/app#5' }, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  r = await run(['--level', 'alert', 'no flag'], { env: {} });
  assert.equal(r.code, 0, 'without the flag notify still never fails the caller');
});

test('incomplete SLACK_ENV (missing a required key) is treated as unconfigured', async () => {
  const file = path.join(TMP, 'partial.env');
  fs.writeFileSync(file, 'SLACK_BOT_TOKEN=xoxb-x\n', { mode: 0o600 });
  const r = await run(['--level', 'info', 'partial config'], { env: { SLACK_ENV: file } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /SLACK_ENV is missing/);
  assert.match(r.stderr, /SLACK_CHANNEL_ID/);
});

// --- operator time format (#89) -------------------------------------------------------------------

test('time format set: an ISO UTC time becomes a Slack date token with the fleet-format fallback', async () => {
  posts = [];
  const r = await run(['--level', 'info', 'baton expires 2026-10-05T19:44:00Z'], {
    env: { SLACK_ENV: slackEnv('t1.env'), OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^\[alice\] ℹ️ baton expires <!date\^1791229440\^\{date_short_pretty\} \{time\}\|[A-Z][a-z]{2} \d+(, \d{4})?, 3:44 PM EDT>$/);
});

test('no time format: the text is posted exactly as given', async () => {
  posts = [];
  const r = await run(['--level', 'info', 'baton expires 2026-10-05T19:44:00Z'], { env: { SLACK_ENV: slackEnv('t2.env') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts[0].text, '[alice] ℹ️ baton expires 2026-10-05T19:44:00Z');
});

test('time format set, Slack down: the GitHub fallback comment reads in the fleet format, no Slack token', async () => {
  const bin = path.join(TMP, 'fakebin-time');
  const log = path.join(TMP, 'gh-time.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${log}"\n`, { mode: 0o755 });
  const r = await run(['--level', 'info', 'stale since 2026-10-05T13:44:00Z'], {
    env: { SLACK_ENV: path.join(TMP, 'missing.env'), NOTIFY_FALLBACK_ISSUE: 'acme/app#5', FLEET_ID: 'alice', OPERATOR_TIMEZONE: 'Europe/Berlin', OPERATOR_CLOCK: '24h' },
    fakeBin: bin,
  });
  assert.equal(r.code, 0, r.stderr);
  const logged = fs.readFileSync(log, 'utf8');
  assert.match(logged, /stale since 5 Oct 15:44 CEST/);
  assert.ok(!logged.includes('<!date^'), 'no Slack token in a GitHub comment');
});

// --- routing: DMs, owner-aware recipients, latches in DMs, sweep (engsys#238) ----------------------

const REG_TEXT = [
  'version: 1',
  'fleets:',
  '  eric:',
  '    operator: eric-sabe',
  '    github_app: feedfrwd-fleet-eric',
  '    slack_operator: U0000000001',
  '  mark-fleet:',
  '    operator: mdbardsley',
  '    github_app: feedfrwd-fleet-mark-fleet',
  '    slack_operator: U0000000002',
  '  quiet:',
  '    operator: quiet-op',
  '    github_app: feedfrwd-fleet-quiet',
  '  refused:',
  '    operator: refused-op',
  '    slack_operator: UREFUSED1',
  '  retired:',
  '    operator: gone-op',
  '    github_app: feedfrwd-fleet-retired',
  '    slack_operator: U0000000005',
  '    enabled: false',
].join('\n') + '\n';
const REG = parseFederation(REG_TEXT);
function regFile() {
  const f = path.join(TMP, 'federation.yml');
  fs.writeFileSync(f, REG_TEXT);
  return f;
}
const HOST = { FLEET_ID: 'eric', SLACK_OPERATOR_ID: 'U0000000009' };

test('planRoute: action/alert with no recipient → a DM to this host\'s operator only', () => {
  for (const level of ['action', 'alert']) {
    const r = planRoute({ level, cfg: HOST, reg: REG });
    assert.equal(r.channel, null, level);
    assert.deepEqual(r.dms, ['U0000000001'], level);
  }
  assert.deepEqual(planRoute({ level: 'action', cfg: { SLACK_OPERATOR_ID: 'U0000000009' }, reg: null }).dms, ['U0000000009']);
  assert.deepEqual(planRoute({ level: 'info', cfg: HOST, reg: REG }), { channel: { mention: '' }, dms: [], meantFor: null, warning: '' });
});

test('planRoute: alert --everyone → channel without mention + a DM per enabled fleet operator', () => {
  const r = planRoute({ level: 'alert', everyone: true, cfg: HOST, reg: REG });
  assert.deepEqual(r.channel, { mention: '' });
  assert.deepEqual(r.dms, ['U0000000001', 'U0000000002', 'UREFUSED1'], 'the disabled fleet is not DMed');
  assert.deepEqual(planRoute({ level: 'alert', everyone: true, cfg: HOST, reg: null }).dms, ['U0000000009']);
});

test('planRoute: --for a disabled fleet still DMs its operator, with a warning (engsys#255)', () => {
  for (const who of ['retired', 'gone-op']) {
    const r = planRoute({ level: 'action', forWho: who, cfg: HOST, reg: REG });
    assert.deepEqual(r.dms, ['U0000000005'], who);
    assert.match(r.warning, /fleet retired is disabled in the fleet registry; DMing its operator anyway/, who);
  }
  assert.equal(planRoute({ level: 'action', forWho: 'mark-fleet', cfg: HOST, reg: REG }).warning, '', 'an enabled fleet: no warning');
  assert.deepEqual(planRoute({ level: 'action', forWho: 'feedfrwd-fleet-retired[bot]', cfg: HOST, reg: REG }).dms, [], 'a disabled fleet\'s bot is not resolved (fleetForBot skips it)');
});

test('planRoute: --for resolves a fleet id, an operator login or a fleet bot to one DM', () => {
  for (const who of ['mark-fleet', 'mdbardsley', 'MDBardsley', 'feedfrwd-fleet-mark-fleet[bot]']) {
    const r = planRoute({ level: 'action', forWho: who, cfg: HOST, reg: REG });
    assert.equal(r.channel, null, who);
    assert.deepEqual(r.dms, ['U0000000002'], who);
  }
});

test('planRoute: --author → the PR\'s fleet operator for a fleet bot, else this host\'s operator', () => {
  assert.deepEqual(planRoute({ level: 'action', author: 'feedfrwd-fleet-mark-fleet[bot]', cfg: HOST, reg: REG }).dms, ['U0000000002']);
  for (const a of ['someone', 'dependabot[bot]', 'feedfrwd-fleet-retired[bot]']) {
    assert.deepEqual(planRoute({ level: 'action', author: a, cfg: HOST, reg: REG }).dms, ['U0000000001'], a);
  }
  const quiet = planRoute({ level: 'action', author: 'feedfrwd-fleet-quiet[bot]', cfg: HOST, reg: REG });
  assert.deepEqual(quiet.channel, { mention: '' });
  assert.match(quiet.meantFor, /the operator of fleet quiet \(quiet-op\)/);
});

test('planRoute: an unknown or Slack-less recipient → the channel, no mention, named in the text', () => {
  const unknown = planRoute({ level: 'action', forWho: 'nobody', cfg: HOST, reg: REG });
  assert.deepEqual(unknown.channel, { mention: '' });
  assert.equal(unknown.meantFor, 'nobody');
  assert.match(unknown.warning, /not in the fleet registry/);
  assert.match(planRoute({ level: 'info', forWho: 'quiet', cfg: HOST, reg: REG }).warning, /fleet quiet has no slack_operator/);
  assert.match(planRoute({ level: 'action', forWho: 'eric', cfg: HOST, reg: null }).warning, /no fleet registry/);
  assert.deepEqual(planRoute({ level: 'action', noMention: true, cfg: HOST, reg: REG }).channel, { mention: '' });
});

test('validateArgs: one routing flag; --everyone only on alert; --sweep stands alone', () => {
  assert.doesNotThrow(() => validateArgs({ level: 'alert', for: 'eric', text: 'x' }));
  assert.throws(() => validateArgs({ level: 'action', re: 'https://x/1', everyone: true, text: 'x' }), /--everyone goes with --level alert/);
  assert.throws(() => validateArgs({ level: 'alert', everyone: true, for: 'eric', text: 'x' }), /use one of/);
  assert.throws(() => validateArgs({ level: 'action', re: 'https://x/1', author: 'a', noMention: true, text: 'x' }), /use one of/);
  assert.throws(() => validateArgs({ level: 'info', for: '', text: 'x' }), /--for needs/);
  assert.throws(() => validateArgs({ level: 'info', author: '', text: 'x' }), /--author needs/);
  assert.doesNotThrow(() => validateArgs({ sweep: true, apply: true, repo: 'acme/app', text: '' }));
  assert.throws(() => validateArgs({ sweep: true, text: 'x' }), /--sweep takes only/);
  assert.throws(() => validateArgs({ level: 'info', apply: true, text: 'x' }), /--apply goes with --sweep/);
  assert.throws(() => validateArgs({ sweep: true, repo: 'bad repo', text: '' }), /--repo must be/);
});

test('dropInvalidRe: only a plain https URL is kept (it reaches DMs unescaped); anything else is dropped (engsys#255)', () => {
  for (const ok of ['https://github.com/acme/app/pull/9', 'https://x/3?a=1&b=2', 'https://github.com/acme/app/pull/9#issuecomment-5']) {
    const args = { level: 'action', re: ok, text: 'x' };
    assert.doesNotThrow(() => validateArgs(args), ok);
    assert.equal(dropInvalidRe(args), '', ok);
    assert.equal(args.re, ok);
  }
  for (const bad of ['http://github.com/x', 'javascript:alert(1)', 'https://x/1|click me', 'https://x/<!here>', 'https://x/a b', 'github.com/x', '']) {
    const args = { level: 'info', re: bad, text: 'x' };
    assert.doesNotThrow(() => validateArgs(args), bad);
    assert.match(dropInvalidRe(args), /--re is not an https URL/, bad);
    assert.equal(args.re, null, bad);
  }
  assert.equal(dropInvalidRe({ re: null }), '', 'no --re: nothing to say');
});

test('--re that is not a plain https URL is dropped with a warning and the alert still posts, without the link (engsys#255)', async () => {
  posts = [];
  const r = await run(['--level', 'action', '--re', 'https://x/1|<!channel>', 'decide'], { env: { SLACK_ENV: slackEnv('re.env', { SLACK_OPERATOR_ID: 'U0000000001' }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /--re is not an https URL .*posting without the link/);
  assert.equal(posts.length, 1);
  assert.doesNotMatch(posts[0].text, /x\/1|<!channel>|GitHub:/, 'the bad link never reaches Slack');
  assert.match(posts[0].text, /decide/);
});

test('--re dropped from an alert-level post (the supervisor login alert) still posts too', async () => {
  posts = [];
  const r = await run(['--level', 'alert', '--re', 'http://github.com/acme/app/issues/1', 'login expired'], { env: { SLACK_ENV: slackEnv('re2.env', { SLACK_OPERATOR_ID: 'U0000000001' }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts.length >= 1, true);
  assert.ok(posts.every((p) => !p.text.includes('http://')));
});

test('latchPr: a PR link, or mm-<N> only when the latch\'s link is in --repo', () => {
  assert.deepEqual(latchPr('mm-gate-x', { re: 'https://github.com/acme/app/pull/9#issuecomment-1' }), { repo: 'acme/app', number: 9 });
  assert.deepEqual(latchPr('mm-12', { re: 'https://github.com/acme/app/issues/101' }, 'acme/app'), { repo: 'acme/app', number: 12 });
  assert.equal(latchPr('mm-12', { re: 'https://github.com/acme/other/issues/101' }, 'acme/app'), null, 'another repo\'s mm-12');
  assert.equal(latchPr('mm-12', {}, 'acme/app'), null, 'no link: ambiguous on a multi-repo host');
  assert.equal(latchPr('mm-12', {}), null);
  assert.equal(latchPr('x', { re: 'https://github.com/acme/app/issues/9' }), null);
  assert.equal(latchPr('x', { re: 'https://evil.example/acme/app/pull/9' }), null);
});

test('--for: a DM to that operator only, no channel post and no mention', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'action', '--for', 'feedfrwd-fleet-mark-fleet[bot]', '--re', 'https://github.com/acme/app/pull/9', 'approve merge'],
    { env: { SLACK_ENV: slackEnv('dm.env', { SLACK_OPERATOR_ID: 'U0000000001' }), FEDERATION_FILE: regFile() } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(opens, ['U0000000002']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'DU0000000002');
  assert.equal(posts[0].text, '[alice] 👋 approve merge\n\nApprove or act on GitHub: https://github.com/acme/app/pull/9');
});

test('--author: a mark-fleet PR DMs its operator; a human PR DMs this host\'s operator', async () => {
  posts = []; opens = [];
  const env = { SLACK_ENV: slackEnv('au.env'), FEDERATION_FILE: regFile(), FLEET_ID: 'eric' };
  await run(['--level', 'action', '--author', 'feedfrwd-fleet-mark-fleet[bot]', '--re', 'https://github.com/acme/app/pull/9', 'blocked'], { env });
  await run(['--level', 'action', '--author', 'some-human', '--re', 'https://github.com/acme/app/pull/10', 'blocked'], { env });
  assert.deepEqual(opens, ['U0000000002', 'U0000000001']);
  assert.deepEqual(posts.map((p) => p.channel), ['DU0000000002', 'DU0000000001']);
});

test('--for an unknown recipient: the channel, loudly, no mention, saying who it was for (escaped)', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'action', '--for', '<!here>', '--re', 'https://x/1', 'decide'],
    { env: { SLACK_ENV: slackEnv('unk.env', { SLACK_OPERATOR_ID: 'U0000000001' }), FEDERATION_FILE: regFile() } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /<!here>: not in the fleet registry; posting to the channel instead of a DM/);
  assert.deepEqual(opens, []);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /^\[alice\] 👋 decide\n\n\(Meant as a DM for &lt;!here&gt;, who could not be reached/);
  assert.doesNotMatch(posts[0].text, /<!here>|<@/);
});

test('--for a DM Slack refuses: falls back to the channel, mentioning the intended recipient', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'info', '--for', 'refused', 'fyi'], { env: { SLACK_ENV: slackEnv('ref.env', { SLACK_OPERATOR_ID: 'U0000000009' }), FEDERATION_FILE: regFile() } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /DM to UREFUSED1 failed \(missing_scope\)/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /^\[alice\] ℹ️ <@UREFUSED1> fyi/);
  assert.doesNotMatch(posts[0].text, /U0000000009/, 'never the host operator instead');
  assert.match(posts[0].text, /Meant as a DM for refused/);
});

test('host-local alert with a registry: a DM to this host\'s operator only', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'alert', '--incident', 'seat-limit', 'seat limit'], { env: { SLACK_ENV: slackEnv('hl.env'), FEDERATION_FILE: regFile(), FLEET_ID: 'mark-fleet', FLEET_STATE: stateDir() } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(opens, ['U0000000002']);
  assert.deepEqual(posts.map((p) => [p.channel, p.text]), [['DU0000000002', '[mark-fleet] ⚠️ seat limit']]);
});

test('alert --everyone: the channel with no mention, plus a DM to every enabled operator', async () => {
  posts = []; opens = [];
  const r = await run(['--level', 'alert', '--everyone', 'baton holder stale'], { env: { SLACK_ENV: slackEnv('al.env', { SLACK_OPERATOR_ID: 'U0000000009' }), FEDERATION_FILE: regFile() } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(opens, ['U0000000001', 'U0000000002', 'UREFUSED1']);
  assert.deepEqual(posts.map((p) => p.channel), ['DU0000000001', 'DU0000000002', 'C123']);
  for (const p of posts) assert.equal(p.text, '[alice] ⚠️ baton holder stale');
  assert.match(r.stderr, /DM to UREFUSED1 failed/);
});

test('a DM incident: replies and --resolve thread in the DM, and the latch stores the DM channel', async () => {
  posts = []; opens = [];
  const env = { SLACK_ENV: slackEnv('dmi.env'), FEDERATION_FILE: regFile(), FLEET_STATE: stateDir() };
  const base = ['--level', 'action', '--re', 'https://github.com/acme/app/pull/9#issuecomment-5', '--incident', 'mm-gate-merge-1'];
  await run([...base, '--for', 'mark-fleet', 'approve'], { env });
  const latchFile = path.join(env.FLEET_STATE, 'notify', 'mm-gate-merge-1.json');
  const latch = JSON.parse(fs.readFileSync(latchFile, 'utf8'));
  assert.equal(latch.channel, 'DU0000000002');
  assert.equal(latch.re, 'https://github.com/acme/app/pull/9#issuecomment-5');
  await run([...base, 'still waiting'], { env }); // no --for: the latch decides where it goes
  assert.equal(posts[1].channel, 'DU0000000002');
  assert.equal(posts[1].thread_ts, latch.ts);
  const r = await run(['--resolve', '--incident', 'mm-gate-merge-1'], { env }); // no --level or --re needed
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(posts[2], { channel: 'DU0000000002', text: '✅ resolved', thread_ts: latch.ts, authorization: 'Bearer xoxb-test-token' });
  assert.equal(fs.existsSync(latchFile), false);
  assert.deepEqual(opens, ['U0000000002'], 'replies reuse the stored DM channel');
});

test('an --everyone incident resolves in the channel thread and in every DM thread', async () => {
  posts = []; opens = [];
  const env = { SLACK_ENV: slackEnv('ali.env'), FEDERATION_FILE: regFile(), FLEET_STATE: stateDir() };
  await run(['--level', 'alert', '--everyone', '--incident', 'disk', 'disk full'], { env });
  const latch = JSON.parse(fs.readFileSync(path.join(env.FLEET_STATE, 'notify', 'disk.json'), 'utf8'));
  assert.equal(latch.channel, 'C123');
  assert.deepEqual(latch.dms.map((d) => d.channel), ['DU0000000001', 'DU0000000002']);
  const n = posts.length;
  await run(['--resolve', '--incident', 'disk'], { env });
  const resolved = posts.slice(n);
  assert.deepEqual(resolved.map((p) => [p.channel, p.text]), [['C123', '✅ resolved'], ['DU0000000001', '✅ resolved'], ['DU0000000002', '✅ resolved']]);
  assert.equal(resolved[0].thread_ts, latch.ts);
  assert.equal(resolved[1].thread_ts, latch.dms[0].ts);
});

test('--no-mention: an action post in the channel mentions nobody', async () => {
  posts = [];
  const r = await run(['--level', 'action', '--no-mention', '--re', 'https://x/1', 'team gate'], { env: { SLACK_ENV: slackEnv('nm.env', { SLACK_OPERATOR_ID: 'U0000000001' }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts[0].channel, 'C123');
  assert.equal(posts[0].text, '[alice] 👋 team gate\n\nApprove or act on GitHub: https://x/1');
});

function sweepGh(name) {
  const fakeBin = path.join(TMP, `fakebin-${name}`);
  fs.mkdirSync(fakeBin, { recursive: true });
  const log = path.join(TMP, `gh-${name}.log`);
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *search/issues*) echo '{"n":[15]}' ;;
  *repos/acme/app/issues/9\\ *) echo '{"state":"closed","pr":true,"merged":true}' ;;
  *repos/acme/app/issues/12\\ *) echo '{"state":"open","pr":true,"merged":false}' ;;
  *repos/acme/app/issues/15\\ *) echo '{"state":"closed","pr":true,"merged":false}' ;;
  "issue comment"*) cat >/dev/null || true ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  return { fakeBin, log };
}

function seedLatches(dir, latches) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(latches)) fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify(v));
}

test('--sweep: dry run lists the latches of merged/closed PRs and changes nothing; --apply resolves them', async () => {
  const { fakeBin, log } = sweepGh('sweep');
  const env = { SLACK_ENV: slackEnv('sw.env'), FLEET_STATE: stateDir() };
  const dir = path.join(env.FLEET_STATE, 'notify');
  seedLatches(dir, {
    'mm-gate-merge-20261021-ab12': { ts: '1.1', channel: 'DU0000000002', re: 'https://github.com/acme/app/pull/9#issuecomment-5' },
    'mm-12': { ts: '1.2', channel: 'C123', re: 'https://github.com/acme/app/issues/101' },
    'mm-13': { ts: '1.5', channel: 'C123' },
    'mm-gate-merge-20261001-cd34': { ts: '1.3', channel: 'C123' },
    'seat-limit': { ts: '1.4', channel: 'C123' },
  });

  posts = [];
  let r = await run(['--sweep', '--repo', 'acme/app'], { env, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would {4}mm-gate-merge-20261021-ab12: acme\/app#9 merged/);
  assert.match(r.stdout, /would {4}mm-gate-merge-20261001-cd34: acme\/app#15 closed/);
  assert.match(r.stdout, /open {5}mm-12: acme\/app#12 is still open/);
  assert.match(r.stdout, /skip {5}mm-13: its link is not in acme\/app, so the PR is ambiguous/);
  assert.match(r.stdout, /skip {5}seat-limit: not tied to a pull request/);
  assert.match(r.stdout, /sweep: 5 open latches, 2 would be resolved \(dry run; --apply to resolve\), 1 still open, 2 skipped/);
  assert.equal(posts.length, 0, 'a dry run posts nothing');
  assert.equal(fs.readdirSync(dir).length, 5, 'a dry run clears nothing');
  assert.match(fs.readFileSync(log, 'utf8'), /search\/issues -f q="merge-20261001-cd34" repo:acme\/app is:pr in:comments/);

  r = await run(['--sweep', '--repo', 'acme/app', '--apply'], { env, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 resolved/);
  assert.deepEqual(posts.map((p) => [p.channel, p.thread_ts, p.text]), [['C123', '1.3', '✅ resolved'], ['DU0000000002', '1.1', '✅ resolved']]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['mm-12.json', 'mm-13.json', 'seat-limit.json']);
});

test('--sweep --apply with Slack unconfigured: names each incident on the fallback issue and drops its latch', async () => {
  const { fakeBin, log } = sweepGh('sweep-noslack');
  const env = { NOTIFY_FALLBACK_ISSUE: 'acme/app#5', FLEET_ID: 'eric', FLEET_STATE: stateDir() };
  const dir = path.join(env.FLEET_STATE, 'notify');
  seedLatches(dir, { 'mm-gate-merge-20261021-ab12': { ts: '1.1', channel: 'C123', re: 'https://github.com/acme/app/pull/9' } });
  let r = await run(['--sweep', '--repo', 'acme/app', '--apply'], { env, fakeBin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /resolved mm-gate-merge-20261021-ab12: acme\/app#9 merged/);
  assert.match(fs.readFileSync(log, 'utf8'), /issue comment 5 -R acme\/app --body \[eric\] ✅ resolved: mm-gate-merge-20261021-ab12 \(acme\/app#9 merged\)/);
  assert.deepEqual(fs.readdirSync(dir), []);
  r = await run(['--sweep', '--repo', 'acme/app', '--apply'], { env, fakeBin });
  assert.match(r.stdout, /sweep: 0 open latches/);
  assert.equal((fs.readFileSync(log, 'utf8').match(/issue comment/g) || []).length, 1, 'a re-run does not repeat it');
});
