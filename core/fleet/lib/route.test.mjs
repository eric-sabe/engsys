// route.test.mjs — the one routing rule for nudges (engsys#78): the helper, `fleet msg route`, `fleet msg
// send` applying the same rule (and reading its body from stdin), and a grep that the monster skills and
// their act scripts route through the helper and read their inbox at startup.
// Run: node --test core/fleet/lib/route.test.mjs (part of `npm test`). Hermetic: every env is built here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, routeLine, VIA } from './route.mjs';
import { FederationError } from './federation.mjs';
import { send, main as msgMain, EXIT } from '../msg.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

const REG_TEXT = `version: 1
operators: [alice:1234567]
fleets:
  alice:
    github_app: acme-fleet-alice
    github_app_id: 101
    status_issue: 11
  bob:
    github_app: acme-fleet-bob
    github_app_id: 102
    status_issue: 12
repos:
  acme/app:
    merge: { home: bob }
    maintain: { home: alice }
`;

function sink() {
  let s = '';
  return { write: (x) => { s += x; }, get text() { return s; } };
}
function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-route-'));
  const fed = path.join(d, 'federation.yml');
  fs.writeFileSync(fed, REG_TEXT);
  return { d, env: { FLEET_ID: 'alice', FEDERATION_FILE: fed, FLEET_INSTANCE_REPO: 'acme/acme-fleet', FLEET_STATE: d, ENGSYS_SESSION: 'acme-maintain' } };
}
function cli(argv, env) {
  const out = sink();
  const err = sink();
  const rc = msgMain(argv, { env, out, err });
  return { rc, out: out.text, err: err.text };
}

// --- the helper ----------------------------------------------------------------------------------

test('route: a bare session or one in this fleet goes by SendMessage; another fleet by fleet msg send', () => {
  assert.deepEqual(route('acme-build', { fleetId: 'alice' }), { via: VIA.SEND_MESSAGE, session: 'acme-build' });
  assert.deepEqual(route('alice:acme-build', { fleetId: 'alice' }), { via: VIA.SEND_MESSAGE, session: 'acme-build' });
  assert.deepEqual(route('bob:acme-build', { fleetId: 'alice' }), { via: VIA.FLEET_MSG, fleet: 'bob', session: 'acme-build', to: 'bob:acme-build' });
  assert.deepEqual(route(' bob:acme-build ', { fleetId: 'alice' }).to, 'bob:acme-build', 'surrounding whitespace is ignored');
});

test('route: single-fleet mode (no FLEET_ID) always goes by SendMessage, to the session half', () => {
  for (const fleetId of [null, '', undefined]) {
    assert.deepEqual(route('bob:acme-build', { fleetId }), { via: VIA.SEND_MESSAGE, session: 'acme-build' });
    assert.deepEqual(route('acme-build', { fleetId }), { via: VIA.SEND_MESSAGE, session: 'acme-build' });
  }
});

test('route: a role home qualifies only a bare name', () => {
  assert.equal(route('acme-mm', { fleetId: 'alice', homeFleet: 'bob' }).to, 'bob:acme-mm');
  assert.equal(route('acme-mm', { fleetId: 'alice', homeFleet: 'alice' }).via, VIA.SEND_MESSAGE);
  assert.equal(route('alice:acme-mm', { fleetId: 'alice', homeFleet: 'bob' }).via, VIA.SEND_MESSAGE, 'an explicit fleet wins over the home');
  assert.equal(route('acme-mm', { fleetId: null, homeFleet: 'bob' }).via, VIA.SEND_MESSAGE, 'no FLEET_ID: still single-fleet');
});

test('route: anything that is not <session> or <fleet>:<session> throws', () => {
  for (const bad of ['', '   ', 'a:b:c', 'Bob:acme-build', 'bob:Acme', 'bob:', ':acme', '-acme', 'acme build', '../etc', `bob:${'a'.repeat(65)}`, 42, null]) {
    assert.throws(() => route(bad, { fleetId: 'alice' }), FederationError, JSON.stringify(bad));
  }
});

test('routeLine: the two lines `fleet msg route` prints', () => {
  assert.equal(routeLine(route('acme-build', { fleetId: 'alice' })), 'same fleet: use SendMessage to acme-build');
  assert.equal(routeLine(route('bob:acme-build', { fleetId: 'alice' })), 'other fleet: fleet msg send --to bob:acme-build');
});

// --- fleet msg route -----------------------------------------------------------------------------

test('fleet msg route: exit 3 for the same fleet, 0 for another, 2 for a bad address', () => {
  const { env } = fixture();
  let r = cli(['route', 'alice:acme-build'], env);
  assert.deepEqual([r.rc, r.out], [EXIT.SAME_FLEET, 'same fleet: use SendMessage to acme-build\n']);
  r = cli(['route', 'bob:acme-build'], env);
  assert.deepEqual([r.rc, r.out], [EXIT.OK, 'other fleet: fleet msg send --to bob:acme-build\n']);
  r = cli(['route', 'bob:acme-build'], { ...env, FLEET_ID: '' });
  assert.equal(r.rc, EXIT.SAME_FLEET, 'single-fleet mode');
  r = cli(['route', 'a:b:c'], env);
  assert.equal(r.rc, EXIT.USAGE);
  assert.equal(r.out, '');
  for (const argv of [['route'], ['route', 'a', 'b'], ['route', 'acme-mm', '--repo', 'acme/app'], ['route', 'acme-mm', '--role', 'merge'], ['route', 'acme-mm', '--nope', 'x']]) {
    assert.equal(cli(argv, env).rc, EXIT.USAGE, argv.join(' '));
  }
});

test('fleet msg route --repo/--role: a bare name goes to that role\'s home fleet', () => {
  const { env } = fixture();
  let r = cli(['route', 'acme-mm', '--repo', 'acme/app', '--role', 'merge'], env);
  assert.deepEqual([r.rc, r.out], [EXIT.OK, 'other fleet: fleet msg send --to bob:acme-mm\n'], 'merge.home is bob');
  r = cli(['route', 'acme-mm', '--repo', 'ACME/App', '--role', 'merge'], env);
  assert.equal(r.rc, EXIT.OK, 'repo names compare case-insensitively');
  r = cli(['route', 'acme-maintain', '--repo', 'acme/app', '--role', 'maintain'], env);
  assert.equal(r.rc, EXIT.SAME_FLEET, 'maintain.home is this fleet');
  r = cli(['route', 'acme-mm', '--repo', 'acme/other', '--role', 'merge'], env);
  assert.equal(r.rc, EXIT.SAME_FLEET, 'an undeclared repo leaves a bare name in this fleet');
  r = cli(['route', 'acme-mm', '--repo', 'acme/app', '--role', 'merge'], { ...env, FEDERATION_FILE: path.join(env.FLEET_STATE, 'none.yml') });
  assert.equal(r.rc, EXIT.SAME_FLEET, 'no registry file: single-fleet routing');
  r = cli(['route', 'acme-mm', '--repo', 'acme/app', '--role', 'deploy'], env);
  assert.equal(r.rc, EXIT.USAGE);
});

// --- fleet msg send applies the same rule ---------------------------------------------------------

test('send: the routing helper decides; a same-fleet address posts nothing and exits 3', () => {
  const { d, env } = fixture();
  const bodyFile = path.join(d, 'b.txt');
  fs.writeFileSync(bodyFile, 'queued fix PR #7\n');
  for (const to of ['alice:acme-mm', 'acme-mm']) {
    const posts = [];
    const out = sink();
    const rc = send(['--to', to, '--body-file', bodyFile], { env, out, err: sink(), post: (...a) => { posts.push(a); return {}; } });
    assert.equal(rc, EXIT.SAME_FLEET, to);
    assert.equal(out.text, `${routeLine(route(to, { fleetId: 'alice' }))}\n`);
    assert.equal(posts.length, 0);
  }
});

test('send: --body-file - reads the body from stdin (the fenced heredoc form)', () => {
  const { env } = fixture();
  const posts = [];
  const out = sink();
  const err = sink();
  const rc = send(['--to', 'bob:acme-mm', '--re', 'acme/app#7', '--body-file', '-'], {
    env, out, err, readStdin: () => 'queued fix PR #7 for GHSA-x: mm:ready\n',
    post: (repo, n, body) => { posts.push({ repo, n, body }); return { html_url: `https://github.com/${repo}/issues/${n}#issuecomment-5` }; },
  });
  assert.equal(rc, EXIT.OK, err.text);
  assert.deepEqual([posts[0].repo, posts[0].n], ['acme/app', 7]);
  assert.match(posts[0].body, /^<!-- fleet-msg to="bob:acme-mm" from="alice:acme-maintain" re="acme\/app#7" protocol="1" -->\nqueued fix PR #7/);
  const failing = send(['--to', 'bob:acme-mm', '--body-file', '-'], { env, out: sink(), err: sink(), readStdin: () => { throw new Error('EAGAIN'); }, post: () => assert.fail('posted') });
  assert.equal(failing, EXIT.ERROR);
});

// --- the senders and receivers use it (grep) -------------------------------------------------------

/** The text of a markdown `## <title>` section (up to the next `## `). */
function section(md, title) {
  const start = md.indexOf(`\n## ${title}`);
  assert.notEqual(start, -1, `no section ${title}`);
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next === -1 ? undefined : next);
}

test('grep: the monster skills route every nudge through the helper before any SendMessage', () => {
  for (const skill of ['skills/merge-monster/SKILL.md', 'skills/maintenance-monster/SKILL.md']) {
    const md = read(skill);
    const msgSec = section(md, 'Cross-session messaging');
    const routeAt = msgSec.indexOf('msg.mjs route');
    assert.notEqual(routeAt, -1, `${skill}: Cross-session messaging names msg.mjs route`);
    assert.ok(routeAt < msgSec.indexOf('SendMessage'), `${skill}: the route comes before the first SendMessage`);
    assert.match(msgSec, /guard --repo <repo> --state-dir <state_dir> -- fleet msg send --to <fleet>:<session> --re <repo>#N --body-file -/, `${skill}: the cross-fleet reply is the fenced send on the PR`);
    assert.match(md, /never nudge a\s+session without routing its address through `msg\.mjs route`/, `${skill}: hard rule`);
  }
  // the pre-#78 rule ("another fleet's address gets no nudge") is gone
  assert.doesNotMatch(read('skills/merge-monster/SKILL.md'), /another fleet's address gets no nudge/);
  assert.match(read('skills/maintenance-monster/SKILL.md'), /msg\.mjs route acme-mm --repo <repo> --role merge/, 'MNT places the merge orchestrator in merge.home');
});

test('grep: the act scripts and fleet msg send reference the helper', () => {
  for (const s of ['skills/merge-monster/scripts/mm-act.sh', 'skills/maintenance-monster/scripts/mnt-act.sh']) {
    assert.match(read(s), /msg\.mjs route <address>/, s);
  }
  assert.match(read('fleet/msg.mjs'), /from '\.\/lib\/route\.mjs'/);
});

test('grep: every role skill reads its cross-fleet inbox at startup and treats a typed fleet-msg line as a pointer', () => {
  for (const skill of ['skills/merge-monster/SKILL.md', 'skills/maintenance-monster/SKILL.md', 'skills/resource-broker/SKILL.md']) {
    const startup = section(read(skill), 'Session startup');
    assert.match(startup, /msg\.mjs inbox <your session> --mark-read/, `${skill}: startup reads the inbox`);
    assert.match(startup, /msg\.mjs read <url>/, `${skill}: and reads each pointer`);
  }
  for (const skill of ['skills/merge-monster/SKILL.md', 'skills/maintenance-monster/SKILL.md', 'skills/resource-broker/SKILL.md']) {
    assert.match(read(skill), /typed\s+(into the session[^.]*)?`?fleet-msg from …`? line|`fleet-msg from …` line typed/, `${skill}: a typed fleet-msg line`);
  }
  const ctx = read('fleet/scaffold/repo/context.md');
  assert.match(ctx, /msg\.mjs inbox <your session> --mark-read/, 'the fleet protocol tells every session (implementers too)');
  assert.match(ctx, /msg\.mjs route <address>/);
  assert.match(read('workflows/merge-monster-protocol.md'), /replies on the PR/, 'mm-handoff: MM replies across fleets on the PR');
});

test('grep: the resource broker sends nothing across fleets', () => {
  const dir = path.join(CORE, 'skills', 'resource-broker');
  const files = [path.join(dir, 'SKILL.md'), ...fs.readdirSync(path.join(dir, 'scripts')).filter((f) => !f.endsWith('.test.sh')).map((f) => path.join(dir, 'scripts', f))];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text.replace(/never sends `fleet msg send`/g, ''), /fleet msg send|msg\.mjs send/, path.relative(CORE, f));
  }
});
