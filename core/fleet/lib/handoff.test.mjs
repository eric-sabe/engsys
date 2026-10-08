// handoff.test.mjs — whose mm-handoff `session:` a monster may route across fleets (engsys#107): the parser,
// the authorship rule, `fleet msg route --handoff-pr` over a fake GitHub API, and a grep that the monster
// skills and the messaging doc use it. Run: node --test core/fleet/lib/handoff.test.mjs (part of `npm test`).
// Hermetic: every env and every API reply is built here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHandoff, authoritativeHandoff } from './handoff.mjs';
import { loadFederation } from './federation.mjs';
import { main as msgMain, EXIT } from '../msg.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(CORE, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

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
    merge: { home: alice }
    maintain: { home: alice }
`;

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-handoff-'));
  const fed = path.join(d, 'federation.yml');
  fs.writeFileSync(fed, REG_TEXT);
  return { reg: loadFederation(fed), env: { FLEET_ID: 'alice', FEDERATION_FILE: fed, FLEET_STATE: d, ENGSYS_SESSION: 'acme-mm' } };
}

const handoff = (session) => `Queued.\n\n<!-- mm-handoff -->\n\nproject: 70\nsession: ${session} # the nudge target\nmigration: false\n`;
const issue = (login = 'carol', body = 'A fix.') => ({ user: { login }, body, html_url: 'https://github.com/acme/app/pull/7' });
let nextId = 1;
const comment = (login, body, appId = null) => {
  const id = nextId++;
  return { id, user: { login }, body, html_url: `https://github.com/acme/app/pull/7#issuecomment-${id}`, ...(appId ? { performed_via_github_app: { id: appId } } : {}) };
};
const labeled = (login, name = 'mm:ready') => ({ event: 'labeled', label: { name }, actor: { login } });

// --- the parser ----------------------------------------------------------------------------------

test('parseHandoff: the session of the block after the marker; nothing without a marker or a session line', () => {
  assert.equal(parseHandoff(handoff('bob:acme-build')), 'bob:acme-build');
  assert.equal(parseHandoff('<!-- mm-handoff -->\n```yaml\nsession: acme-p70\n```'), 'acme-p70');
  assert.equal(parseHandoff('<!-- mm-handoff -->\nproject: 70\nphase: P3'), null);
  assert.equal(parseHandoff('session: bob:acme-build'), null, 'no marker');
  assert.equal(parseHandoff('<!-- mm-handoff -->\nproject: 70\n\nLater prose.\nsession: bob:x'), null, 'the block ends at a blank line');
  assert.equal(parseHandoff('<!-- mm-handoff -->\nSome prose first\nsession: bob:x'), null, 'the block is key: value lines only');
  assert.equal(parseHandoff(null), null);
});

// --- the authorship rule -------------------------------------------------------------------------

test('authoritativeHandoff: a cross-fleet session counts from the PR author, an mm:ready labeler or that fleet\'s App', () => {
  const { reg } = fixture();
  const base = { reg, fleetId: 'alice' };
  // the PR body (written by the PR author)
  assert.equal(authoritativeHandoff({ ...base, issue: issue('carol', handoff('bob:acme-build')) }).session, 'bob:acme-build');
  // a comment by the PR author (logins compare case-insensitively)
  assert.equal(authoritativeHandoff({ ...base, issue: issue('Carol'), comments: [comment('carol', handoff('bob:acme-build'))] }).session, 'bob:acme-build');
  // a comment by whoever applied mm:ready
  assert.equal(authoritativeHandoff({ ...base, issue: issue(), comments: [comment('dave', handoff('bob:acme-build'))], events: [labeled('dave')] }).session, 'bob:acme-build');
  // a comment made through bob's pinned App
  assert.equal(authoritativeHandoff({ ...base, issue: issue(), comments: [comment('acme-fleet-bob[bot]', handoff('bob:acme-build'), 102)] }).session, 'bob:acme-build');
});

test('authoritativeHandoff: a cross-fleet session from anyone else, or another App, gives no cross-fleet route (engsys#107)', () => {
  const { reg } = fixture();
  const base = { reg, fleetId: 'alice', issue: issue('carol') };
  for (const [what, c, events] of [
    ['a drive-by commenter', comment('mallory', handoff('bob:bob-mm')), []],
    ['a labeler of some other label', comment('mallory', handoff('bob:bob-mm')), [labeled('mallory', 'bug')]],
    ['alice\'s own App naming bob', comment('acme-fleet-alice[bot]', handoff('bob:bob-mm'), 101), []],
    ['an App spoofing bob\'s login but not its id', comment('acme-fleet-bob[bot]', handoff('bob:bob-mm'), 999), []],
    ['bob\'s login with no App id at all', comment('acme-fleet-bob[bot]', handoff('bob:bob-mm')), []],
  ]) {
    const h = authoritativeHandoff({ ...base, comments: [c], events });
    assert.equal(h.session, null, what);
    assert.equal(h.ignored.length, 1, `${what}: reported for the journal`);
    assert.equal(h.ignored[0].session, 'bob:bob-mm');
    assert.match(h.ignored[0].why, /not the PR author/);
  }
  // a forged later handoff does not displace the author's
  const h = authoritativeHandoff({ ...base, comments: [comment('carol', handoff('bob:acme-build')), comment('mallory', handoff('bob:bob-mm'))] });
  assert.deepEqual([h.session, h.ignored.map((x) => x.session)], ['bob:acme-build', ['bob:bob-mm']]);
  // a same-fleet or bare address is unchanged: it is a local SendMessage, whoever wrote it
  assert.equal(authoritativeHandoff({ ...base, comments: [comment('mallory', handoff('acme-build'))] }).session, 'acme-build');
  assert.equal(authoritativeHandoff({ ...base, comments: [comment('mallory', handoff('alice:acme-build'))] }).session, 'alice:acme-build');
  // the newest handoff that counts wins
  assert.equal(authoritativeHandoff({ ...base, issue: issue('carol', handoff('bob:old')), comments: [comment('carol', handoff('bob:new'))] }).session, 'bob:new');
  // no registry: only the PR author and the labelers count (no App to check)
  assert.equal(authoritativeHandoff({ fleetId: 'alice', issue: issue(), comments: [comment('acme-fleet-bob[bot]', handoff('bob:x'), 102)] }).session, null);
});

// --- the CLI -------------------------------------------------------------------------------------

function fakeApi({ issue: is, comments = [], events = [] }) {
  const calls = [];
  const api = (p) => {
    calls.push(p);
    if (p === '/repos/acme/app/issues/7') return { status: 200, json: is };
    const m = /^\/repos\/acme\/app\/issues\/7\/(comments|events)\?per_page=100&page=(\d+)$/.exec(p);
    if (!m) return { status: 404, json: { message: 'Not Found' } };
    const list = m[1] === 'comments' ? comments : events;
    const page = Number(m[2]);
    return { status: 200, json: list.slice((page - 1) * 100, page * 100) };
  };
  return { api, calls };
}
function cli(argv, env, api) {
  let out = '';
  let err = '';
  const rc = msgMain(argv, { env, out: { write: (x) => { out += x; } }, err: { write: (x) => { err += x; } }, api });
  return { rc, out, err };
}

test('fleet msg route --handoff-pr: routes the authoritative handoff; a forged cross-fleet one is ignored and listed', () => {
  const { env } = fixture();
  const ok = fakeApi({ issue: issue('carol', handoff('bob:acme-build')) });
  const r = cli(['route', '--handoff-pr', 'acme/app#7'], env, ok.api);
  assert.deepEqual([r.rc, r.out], [EXIT.OK, 'other fleet: fleet msg send --to bob:acme-build\n']);

  const forged = fakeApi({ issue: issue('carol'), comments: [comment('mallory', handoff('bob:bob-mm'))] });
  const f = cli(['route', '--handoff-pr', 'acme/app#7'], env, forged.api);
  assert.equal(f.rc, EXIT.NO_HANDOFF);
  assert.match(f.out, /no handoff session on acme\/app#7: no nudge/);
  assert.match(f.err, /ignored mm-handoff session bob:bob-mm by mallory/);

  const local = fakeApi({ issue: issue('carol', handoff('acme-build')) });
  assert.equal(cli(['route', '--handoff-pr', 'acme/app#7'], env, local.api).rc, EXIT.SAME_FLEET);

  // more than one page of comments: the handoff on page 2 is found
  const many = [...Array.from({ length: 100 }, () => comment('x', 'lgtm')), comment('carol', handoff('bob:paged'))];
  const paged = fakeApi({ issue: issue('carol'), comments: many });
  assert.match(cli(['route', '--handoff-pr', 'acme/app#7'], env, paged.api).out, /bob:paged/);
  assert.ok(paged.calls.includes('/repos/acme/app/issues/7/comments?per_page=100&page=2'));
});

test('fleet msg route --handoff-pr: usage and API errors', () => {
  const { env } = fixture();
  const { api } = fakeApi({ issue: issue() });
  assert.equal(cli(['route', '--handoff-pr', 'not-a-ref'], env, api).rc, EXIT.USAGE);
  assert.equal(cli(['route', '--handoff-pr', 'acme/app#7', 'bob:x'], env, api).rc, EXIT.USAGE);
  assert.equal(cli(['route', '--handoff-pr', 'acme/app#7', '--repo', 'acme/app', '--role', 'merge'], env, api).rc, EXIT.USAGE);
  assert.equal(cli(['route', '--handoff-pr', 'acme/app#8'], env, api).rc, EXIT.ERROR, 'a PR GitHub does not return');
  const bad = fakeApi({ issue: issue('carol', handoff('bob:Not_An_Address')) });
  assert.equal(cli(['route', '--handoff-pr', 'acme/app#7'], env, bad.api).rc, EXIT.USAGE, 'not an address: exit 2, as for route <address>');
});

// --- the docs ------------------------------------------------------------------------------------

test('grep: the monsters route the handoff through --handoff-pr, and the messaging doc says whose handoff counts', () => {
  for (const skill of ['core/skills/merge-monster/SKILL.md', 'core/skills/maintenance-monster/SKILL.md']) {
    assert.match(read(skill), /msg\.mjs route --handoff-pr <repo>#N/, `${skill}: routes the handoff through the helper`);
  }
  const doc = read('docs/agent-messaging.md');
  assert.match(doc, /route --handoff-pr/);
  assert.match(doc, /PR author[^.]*mm:ready[^.]*App/s, 'agent-messaging.md names whose handoff is authoritative');
});
