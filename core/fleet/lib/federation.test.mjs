// federation.test.mjs — the registry loader: the YAML subset, the schema, single-fleet fallback,
// addresses, and the CLI. Run: node --test core/fleet/lib/federation.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseYaml, validateFederation, parseFederation, loadFederation, resolveFederationFile, checkFleetId,
  fleetIdProblems, getPath, roleHome, parseAddress, isOwnAddress, statusLines, main, FederationError, FLEET_ID_RE,
  repoFromRemoteUrl, instanceRepo, statusIssueTarget, registryWarnings,
} from './federation.mjs';
import { hermeticGit } from '../../lib/git-env.mjs';

const DOC = `version: 1
operators_team: acme/fleet-operators       # gates count only from human members of this team
fleets:
  alice:
    operator: alice                         # GitHub login
    host: alice-host
    github_app: acme-fleet-alice            # bot login: acme-fleet-alice[bot]
    github_app_id: 1000001                  # the App's numeric id (required with 2+ enabled fleets)
    cloud_identity: fleet-alice
    slack_operator: U0000000001
    status_issue: 11
    enabled: true
  bob:
    operator: bob
    host: bob-host
    github_app: acme-fleet-bob
    github_app_id: 1000002
    cloud_identity: fleet-bob
    slack_operator: U0000000002
    status_issue: 12
    enabled: true
repos:
  acme/app:
    merge:    { home: alice, ledger: 101, standby: [bob], failover: escalate }
    maintain: { home: alice, ledger: 102, standby: [bob], failover: escalate }
`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'federation-test-'));
const write = (dir, name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const problems = (text) => {
  try {
    parseFederation(text);
  } catch (e) {
    assert.ok(e instanceof FederationError, `expected FederationError, got ${e}`);
    return e.errors.join('\n');
  }
  assert.fail('expected the document to be rejected');
};
// A minimal valid document with one substitution, for the schema rejections.
const minimal = (extra = '', fleets = '  alice:\n    enabled: true\n') => `version: 1\nfleets:\n${fleets}${extra}`;

function cli(argv, env = {}, cwd = os.tmpdir()) {
  let out = '';
  let err = '';
  const code = main(argv, { env, cwd, out: { write: (s) => { out += s; } }, err: { write: (s) => { err += s; } } });
  return { code, out, err };
}

// --- the design doc's example, end to end ------------------------------------------------------

test('the docs/multi-fleet.md example parses and normalizes', () => {
  const reg = parseFederation(DOC);
  assert.equal(reg.version, 1);
  assert.equal(reg.operators_team, 'acme/fleet-operators');
  assert.deepEqual(Object.keys(reg.fleets), ['alice', 'bob']);
  assert.deepEqual(reg.fleets.alice, {
    enabled: true, operator: 'alice', host: 'alice-host', github_app: 'acme-fleet-alice', github_app_id: 1000001,
    cloud_identity: 'fleet-alice', slack_operator: 'U0000000001', status_issue: 11,
  });
  assert.deepEqual(reg.repos['acme/app'].merge, { home: 'alice', ledger: 101, standby: ['bob'], failover: 'escalate' });
  assert.equal(roleHome(reg, 'acme/app', 'maintain'), 'alice');
  assert.equal(roleHome(reg, 'acme/app', 'nope'), null);
  assert.equal(roleHome(null, 'acme/app', 'merge'), null);
});

test('defaults: enabled true, standby [], failover escalate; ledger and fleet fields optional', () => {
  const reg = parseFederation(minimal('repos:\n  acme/app:\n    merge: { home: alice }\n'));
  assert.deepEqual(reg.fleets.alice, { enabled: true });
  assert.deepEqual(reg.repos['acme/app'].merge, { home: 'alice', standby: [], failover: 'escalate' });
  assert.deepEqual(reg.repos, { 'acme/app': { merge: { home: 'alice', standby: [], failover: 'escalate' } } });
  assert.equal(reg.operators_team, null);
  const noRepos = parseFederation(minimal());
  assert.deepEqual(noRepos.repos, {});
});

test('operators allowlist is accepted for user-owned repos (gate-check format)', () => {
  const reg = parseFederation(minimal('operators: [alice:1234567, bob:7654321]\n'));
  assert.deepEqual(reg.operators, ['alice:1234567', 'bob:7654321']);
  const block = parseFederation(minimal('operators:\n  - alice:1234567\n'));
  assert.deepEqual(block.operators, ['alice:1234567']);
});

test('failover auto and a disabled fleet are valid', () => {
  const reg = parseFederation(minimal('repos:\n  acme/app:\n    merge: { home: alice, standby: [bob], failover: auto }\n',
    '  alice:\n    enabled: true\n  bob:\n    enabled: false\n'));
  assert.equal(reg.repos['acme/app'].merge.failover, 'auto');
  assert.equal(reg.fleets.bob.enabled, false);
});

// --- schema rejections ---------------------------------------------------------------------------

test('rejects: version missing or not 1', () => {
  assert.match(problems('fleets:\n  alice:\n    enabled: true\n'), /version is required/);
  assert.match(problems(minimal().replace('version: 1', 'version: 2')), /version must be 1, got 2/);
  assert.match(problems(minimal().replace('version: 1', 'version: "1"')), /version must be 1, got "1"/);
});

test('rejects: unknown keys at every level', () => {
  assert.match(problems(minimal('extra: 1\n')), /unknown top-level key "extra"/);
  assert.match(problems(minimal('', '  alice:\n    enabled: true\n    colour: blue\n')), /fleets\.alice: unknown key "colour"/);
  assert.match(problems(minimal('repos:\n  acme/app:\n    merge: { home: alice, owner: x }\n')), /repos\.acme\/app\.merge: unknown key "owner"/);
});

test('rejects: fleets missing, empty, or not a map', () => {
  assert.match(problems('version: 1\n'), /fleets is required/);
  assert.match(problems('version: 1\nfleets: {}\n'), /fleets is empty/);
  assert.match(problems('version: 1\nfleets: [alice]\n'), /fleets must be a map/);
  assert.match(problems('version: 1\nfleets:\n  alice:\n'), /fleets\.alice: must be a map/);
});

test('rejects: fleet ids outside the FLEET_ID pattern', () => {
  for (const id of ['A', 'Alice', '1abc', 'a', 'a_b', 'abcdefghijklmnopqrstuv']) {
    assert.match(problems(minimal('', `  ${id}:\n    enabled: true\n`)), /fleet id must match/, id);
  }
});

test('rejects: bad fleet field values', () => {
  const f = (line) => problems(minimal('', `  alice:\n    ${line}\n`));
  assert.match(f('operator: acme-fleet[bot]'), /operator: must be a GitHub user login/);
  assert.match(f('github_app: acme-fleet-alice[bot]'), /github_app: give the App slug without \[bot\]/);
  assert.match(f('github_app: Acme_App'), /github_app: must be a GitHub App slug/);
  assert.match(f('host: "two words"'), /host: must be a host name without spaces/);
  assert.match(f('slack_operator: alice'), /slack_operator: must be a Slack member id/);
  assert.match(f('status_issue: 0'), /status_issue: must be a positive issue number, got 0/);
  assert.match(f('status_issue: "11"'), /status_issue: must be a positive issue number, got "11"/);
  assert.match(f('enabled: "true"'), /enabled: must be true or false/);
  assert.match(f('github_app_id: 0'), /github_app_id: must be the App's numeric id/);
  assert.match(f('github_app_id: "5013025"'), /github_app_id: must be the App's numeric id/);
  assert.match(f('github_app_id: 5013025'), /github_app_id: set github_app/);
});

test('registryWarnings: github_app_id is required once two or more fleets are enabled (engsys#77 L3)', () => {
  const reg = parseFederation(DOC);
  assert.deepEqual(registryWarnings(reg), []);
  const unpinned = parseFederation(DOC.replace('    github_app_id: 1000002\n', ''));
  assert.deepEqual(registryWarnings(unpinned), ['fleets.bob.github_app_id is not set: with 2 enabled fleets it is required (cross-fleet messages from bob are rejected until it is)']);
  assert.match(statusLines(unpinned, { fleetId: 'alice', file: 'f.yml' }).join('\n'), /WARNING fleets\.bob\.github_app_id is not set/);
  const oneEnabled = parseFederation(DOC.replace('    github_app_id: 1000002\n', '').replace(/(status_issue: 12\n    enabled: )true/, '$1false'));
  assert.deepEqual(registryWarnings(oneEnabled), []);
});

test('rejects: malformed operators_team and operators entries', () => {
  assert.match(problems(minimal('operators_team: fleet-operators\n')), /operators_team must be org\/team-slug/);
  assert.match(problems(minimal('operators: [alice]\n')), /operators entry must be login:numeric-id/);
  assert.match(problems(minimal('operators: [ghost:1]\n')), /can never be an operator/);
  assert.match(problems(minimal('operators: alice:1\n')), /operators must be a list/);
});

test('rejects: unknown roles, missing or undeclared home, bad standby, ledger and failover', () => {
  const r = (spec, fleets) => problems(minimal(`repos:\n  acme/app:\n    ${spec}\n`, fleets));
  assert.match(r('build: { home: alice }'), /repos\.acme\/app\.build: unknown role \(allowed: merge, maintain/);
  assert.match(r('merge: { ledger: 1 }'), /merge\.home is required/);
  assert.match(r('merge: { home: carol }'), /merge\.home: "carol" is not a fleet declared under fleets/);
  assert.match(r('merge: { home: alice, standby: [carol] }'), /standby: "carol" is not a fleet declared/);
  assert.match(r('merge: { home: alice, standby: [alice] }'), /standby: "alice" is already the home fleet/);
  assert.match(r('merge: { home: alice, standby: [bob, bob] }', '  alice:\n    enabled: true\n  bob:\n    enabled: true\n'), /standby: "bob" is listed twice/);
  assert.match(r('merge: { home: alice, standby: bob }'), /standby: must be a list of fleet ids/);
  assert.match(r('merge: { home: alice, ledger: 0 }'), /ledger: must be a positive issue number, got 0/);
  assert.match(r('merge: { home: alice, ledger: -3 }'), /ledger: must be a positive issue number, got -3/);
  assert.match(r('merge: { home: alice, ledger: "101" }'), /ledger: must be a positive issue number, got "101"/);
  assert.match(r('merge: { home: alice, failover: maybe }'), /failover: must be escalate or auto, got "maybe"/);
  assert.match(r('merge: alice'), /merge: must be a map/);
  assert.match(problems(minimal('repos:\n  app:\n    merge: { home: alice }\n')), /repos\.app: repo key must be owner\/name/);
  assert.match(problems(minimal('repos:\n  acme/app: merge\n')), /repos\.acme\/app: must be a map of role/);
  assert.match(problems(minimal('repos: [acme/app]\n')), /repos must be a map/);
});

test('every problem is reported at once, and the message names the file', () => {
  try {
    parseFederation(minimal('repos:\n  acme/app:\n    merge: { home: carol, ledger: 0, failover: maybe }\n'), { file: 'federation.yml' });
    assert.fail('expected a rejection');
  } catch (e) {
    assert.equal(e.errors.length, 3);
    assert.match(e.message, /^federation\.yml is invalid \(3 problems\):/);
  }
  assert.throws(() => validateFederation([1, 2]), /expected a map at the top level/);
  assert.throws(() => validateFederation(null), /expected a map at the top level/);
});

// --- the YAML subset -----------------------------------------------------------------------------

test('subset: maps, block and flow lists, scalars, comments, quoting', () => {
  const doc = parseYaml([
    '---',
    '# a comment',
    'a: plain value',
    'b: "double \\"q\\" # not a comment"   # a comment',
    "c: 'single ''q'''",
    'd: 42',
    'e: -7',
    'f: true',
    'g: false',
    'h: null',
    'i: ~',
    'j: [x, "y, z", { k: 1 }, []]',
    'k: { a: [1, 2], b: { c: d }, "q k": v }',
    'l:',
    '  - one',
    '  - [two]',
    '  - { three: 3 }',
    'm:',
    '- same-indent list',
    'n:',
    '  deep:',
    '    deeper: x',
    'o: https://example.com/a#frag',
    'p: ""',
    'q:',
    '"quoted key": 1',
  ].join('\n'));
  assert.deepEqual(doc, {
    a: 'plain value', b: 'double "q" # not a comment', c: "single 'q'", d: 42, e: -7, f: true, g: false, h: null, i: null,
    j: ['x', 'y, z', { k: 1 }, []], k: { a: [1, 2], b: { c: 'd' }, 'q k': 'v' },
    l: ['one', ['two'], { three: 3 }], m: ['same-indent list'], n: { deep: { deeper: 'x' } },
    o: 'https://example.com/a#frag', p: '', q: null, 'quoted key': 1,
  });
  assert.equal(parseYaml('# only comments\n\n'), null);
  assert.deepEqual(parseYaml('a: 1\r\nb: 2\r\n'), { a: 1, b: 2 });
});

test('subset: everything outside it is rejected with the line number', () => {
  const cases = [
    ['a: &anchor x', /line 1: anchors are outside/],
    ['a: *alias', /line 1: aliases are outside/],
    ['a: !tag x', /line 1: tags are outside/],
    ['a: |\n  text', /line 1: block scalars are outside/],
    ['a: >\n  text', /line 1: block scalars are outside/],
    ['a: 1\n---\nb: 2', /line 2: multiple YAML documents/],
    ['a: 1\n...', /line 2: document markers/],
    ['%YAML 1.2\na: 1', /line 1: directives/],
    ['a:\n\tb: 1', /line 2: tab in indentation/],
    ['a: yes', /line 1: ambiguous value "yes"/],
    ['a: Off', /line 1: ambiguous value "Off"/],
    ['a: 1.5', /line 1: ambiguous value "1.5": floats/],
    ['a: 1e3', /line 1: ambiguous value "1e3"/],
    ['a: .inf', /line 1: ambiguous value ".inf"/],
    ['a: 010', /line 1: ambiguous number "010"/],
    ['a: 0x1f', /line 1: ambiguous number "0x1f"/],
    ['a: +5', /line 1: ambiguous number "\+5"/],
    ['a: 1_000', /line 1: ambiguous number "1_000"/],
    ['a: 99999999999999999999', /line 1: integer 99999999999999999999 is out of range/],
    ['a: [1, 2', /line 1: unterminated flow list/],
    ['a: {b: 1', /line 1: unterminated flow map/],
    ['a: [1, 2,]', /line 1: trailing comma/],
    ['a: { b: 1, b: 2 }', /line 1: duplicate key "b"/],
    ['a: 1\na: 2', /line 2: duplicate key "a"/],
    ['a: {b:1}', /line 1: expected a space after ':'/],
    ['a: [1] trailing', /line 1: unexpected text after a value/],
    ['a: "open', /line 1: unterminated double-quoted string/],
    ['a: "\\x41"', /line 1: unsupported escape/],
    ['a: b: c', /line 1: unexpected ': ' inside a plain value/],
    ['a:b', /line 1: expected 'key: value'/],
    ['l:\n  - k: v', /line 2: maps inside block lists/],
    ['l:\n  -\n    x', /line 2: nested block under a list item/],
    ['a: 1\n  b: 2', /line 2: bad indentation/],
    ['  a: 1', /line 1: the document must start at column 1/],
    ['a:\n  b: 1\n c: 2', /line 3: unexpected content|bad indentation/],
    ['- a\nb: 1', /line 2: unexpected content/],
    ['? a\n: b', /line 1: (expected 'key: value'|complex keys)/],
    ['__proto__: 1', /key "__proto__" is not allowed/],
    ['a b c: 1', /key "a b c" has characters outside/],
    ['a: @x', /reserved characters/],
  ];
  for (const [text, re] of cases) {
    assert.throws(() => parseYaml(text), (e) => e instanceof FederationError && re.test(e.message), `${JSON.stringify(text)} should match ${re}`);
  }
  assert.throws(() => parseYaml('a: yes', { file: 'f.yml' }), /^FederationError: f\.yml:1: /);
  assert.throws(() => parseYaml('a: yes', { file: 'f.yml' }), (e) => e.message.startsWith('f.yml:1: '));
});

// --- files, single-fleet fallback, FLEET_ID ------------------------------------------------------

test('loadFederation: a missing file is single-fleet mode (null); an unreadable one is an error', () => {
  const dir = tmp();
  assert.equal(loadFederation(path.join(dir, 'federation.yml')), null);
  const f = write(dir, 'federation.yml', DOC);
  assert.equal(loadFederation(f).fleets.bob.status_issue, 12);
  assert.throws(() => loadFederation(dir), /cannot read/);
  write(dir, 'bad.yml', 'version: 2\nfleets:\n  alice: { enabled: true }\n');
  assert.throws(() => loadFederation(path.join(dir, 'bad.yml')), /bad\.yml is invalid \(1 problem\)/);
});

test('resolveFederationFile: FEDERATION_FILE (absolute or instance-relative), else <instance>/federation.yml', () => {
  assert.equal(resolveFederationFile({ FLEET_REPO: '/i' }), '/i/federation.yml');
  assert.equal(resolveFederationFile({ FLEET_INSTANCE: '/i', FEDERATION_FILE: 'cfg/fed.yml' }), '/i/cfg/fed.yml');
  assert.equal(resolveFederationFile({ FLEET_REPO: '/i', FEDERATION_FILE: '/abs/fed.yml' }), '/abs/fed.yml');
  assert.equal(resolveFederationFile({}, '/cwd'), '/cwd/federation.yml');
});

test('FLEET_ID: the pattern, unset means single-fleet, and registry membership', () => {
  for (const ok of ['ab', 'alice', 'acme-eu', 'a1', 'a'.repeat(21)]) assert.ok(FLEET_ID_RE.test(ok), ok);
  for (const no of ['a', 'Alice', '1a', '-a', 'a_b', 'a'.repeat(22), 'a b']) assert.ok(!FLEET_ID_RE.test(no), no);
  assert.equal(checkFleetId(undefined), null);
  assert.equal(checkFleetId(''), null);
  assert.equal(checkFleetId('alice'), 'alice');
  assert.throws(() => checkFleetId('Alice'), /FLEET_ID "Alice" must match/);
  const reg = parseFederation(DOC);
  assert.deepEqual(fleetIdProblems(null, 'alice'), []);
  assert.deepEqual(fleetIdProblems(reg, 'alice'), []);
  assert.match(fleetIdProblems(reg, 'carol')[0], /"carol" is not declared under fleets/);
  assert.match(fleetIdProblems(reg, null)[0], /FLEET_ID is not set/);
});

// --- paths and addresses -------------------------------------------------------------------------

test('getPath: dotted paths, with repo keys that contain dots', () => {
  const reg = parseFederation(minimal('repos:\n  acme/my.app:\n    merge: { home: alice }\n  acme/app:\n    maintain: { home: alice, ledger: 7 }\n'));
  assert.equal(getPath(reg, 'repos.acme/my.app.merge.home'), 'alice');
  assert.equal(getPath(reg, 'repos.acme/app.maintain.ledger'), 7);
  assert.equal(getPath(reg, 'repos.acme/app.maintain.failover'), 'escalate');
  assert.deepEqual(getPath(reg, 'repos.acme/app.maintain.standby'), []);
  assert.equal(getPath(reg, 'fleets.alice.enabled'), true);
  assert.equal(getPath(reg, 'repos.acme/app.merge'), undefined);
  assert.equal(getPath(reg, 'fleets.alice.enabled.more'), undefined);
});

test('parseAddress: qualified, bare (my fleet), and invalid', () => {
  assert.deepEqual(parseAddress('alice:acme-build'), { fleet: 'alice', session: 'acme-build' });
  assert.deepEqual(parseAddress('alice:acme-build', 'bob'), { fleet: 'alice', session: 'acme-build' });
  assert.deepEqual(parseAddress('acme-build', 'bob'), { fleet: 'bob', session: 'acme-build' });
  assert.deepEqual(parseAddress('acme-build'), { fleet: null, session: 'acme-build' });
  assert.deepEqual(parseAddress('  acme-mm  ', null), { fleet: null, session: 'acme-mm' });
  assert.throws(() => parseAddress(''), /address is empty/);
  assert.throws(() => parseAddress(undefined), /address is empty/);
  assert.throws(() => parseAddress('a:b:c'), /more than one ':'/);
  assert.throws(() => parseAddress('Alice:acme-build'), /fleet "Alice" must match/);
  assert.throws(() => parseAddress(':acme-build'), /fleet "" must match/);
  assert.throws(() => parseAddress('alice:'), /session "" must be a session name/);
  assert.throws(() => parseAddress('alice:Acme Build'), /session "Acme Build"/);
  assert.equal(isOwnAddress('acme-build', 'alice'), true);
  assert.equal(isOwnAddress('alice:acme-build', 'alice'), true);
  assert.equal(isOwnAddress('bob:acme-build', 'alice'), false);
  assert.equal(isOwnAddress('acme-build', null), true);
  assert.equal(isOwnAddress('bob:acme-build', null), false);
});

test('statusLines: single-fleet, id only, and a registry with this fleet marked', () => {
  assert.deepEqual(statusLines(null, { file: '/i/federation.yml' }), ['fleet: single-fleet mode (no FLEET_ID, no /i/federation.yml)']);
  assert.deepEqual(statusLines(null, { fleetId: 'alice', file: '/i/federation.yml' }), [
    'fleet: alice', 'federation: none (no /i/federation.yml) — single-fleet mode',
  ]);
  const lines = statusLines(parseFederation(DOC.replace(/maintain: \{ home: alice, ledger: 102, standby: \[bob\]/, 'maintain: { home: bob, ledger: 102, standby: [alice]')), { fleetId: 'alice', file: 'f.yml' });
  assert.equal(lines[0], 'fleet: alice');
  assert.equal(lines[1], 'federation: f.yml (2 fleets: alice, bob)');
  assert.match(lines[2], /^ {2}acme\/app merge +home alice \(this fleet\) +ledger #101 +standby bob +failover escalate$/);
  assert.match(lines[3], /^ {2}acme\/app maintain +home bob +ledger #102 +standby alice +failover escalate$/);
  const warn = statusLines(parseFederation(DOC), { fleetId: 'carol', file: 'f.yml' });
  assert.match(warn[2], /WARNING FLEET_ID "carol" is not declared/);
  assert.match(statusLines(parseFederation(minimal()), { fleetId: 'alice', file: 'f.yml' })[2], /no repo roles declared/);
});

// --- CLI -----------------------------------------------------------------------------------------

test('cli validate: valid, invalid, missing (default vs explicit), FLEET_ID membership', () => {
  const dir = tmp();
  const f = write(dir, 'federation.yml', DOC);
  let r = cli(['validate', f]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^ok: .*federation\.yml \(2 fleets, 2 repo roles\)/);
  r = cli(['validate'], { FLEET_REPO: dir, FLEET_ID: 'alice' });
  assert.equal(r.code, 0);
  r = cli(['validate'], { FLEET_REPO: dir, FLEET_ID: 'carol' });
  assert.equal(r.code, 1);
  assert.match(r.err, /"carol" is not declared under fleets/);
  r = cli(['validate'], { FLEET_ID: 'Bad' });
  assert.equal(r.code, 1);
  assert.match(r.err, /FLEET_ID "Bad" must match/);
  const empty = tmp();
  r = cli(['validate'], { FLEET_REPO: empty });
  assert.equal(r.code, 0);
  assert.match(r.out, /single-fleet mode/);
  r = cli(['validate', path.join(empty, 'nope.yml')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not found/);
  const bad = write(dir, 'bad.yml', 'version: 1\nfleets:\n  alice:\n    enabled: yes\n');
  r = cli(['validate', bad]);
  assert.equal(r.code, 1);
  assert.match(r.err, /bad\.yml:4: ambiguous value "yes"/);
  r = cli(['validate', 'a', 'b']);
  assert.equal(r.code, 1);
});

test('cli get and home: values, JSON for objects, exit 3 when undeclared or single-fleet', () => {
  const dir = tmp();
  write(dir, 'federation.yml', DOC);
  const env = { FLEET_REPO: dir };
  assert.deepEqual(cli(['get', 'repos.acme/app.merge.home'], env), { code: 0, out: 'alice\n', err: '' });
  assert.equal(cli(['get', 'repos.acme/app.merge.ledger'], env).out, '101\n');
  assert.equal(cli(['get', 'fleets.bob.enabled'], env).out, 'true\n');
  assert.equal(cli(['get', 'repos.acme/app.merge.standby'], env).out, '["bob"]\n');
  assert.deepEqual(JSON.parse(cli(['get', 'repos.acme/app.maintain'], env).out), { home: 'alice', standby: ['bob'], failover: 'escalate', ledger: 102 });
  assert.equal(cli(['get', 'repos.acme/app.build'], env).code, 3);
  assert.deepEqual(cli(['home', 'acme/app', 'merge'], env), { code: 0, out: 'alice\n', err: '' });
  assert.equal(cli(['home', 'acme/other', 'merge'], env).code, 3);
  assert.equal(cli(['home', 'acme/app', 'build'], env).code, 1);
  assert.equal(cli(['home', 'app', 'merge'], env).code, 1);
  assert.equal(cli(['home', 'acme/app'], env).code, 1);
  // --file wins over the environment
  const other = write(tmp(), 'fed.yml', DOC.replace(/home: alice/g, 'home: bob').replace(/standby: \[bob\]/g, 'standby: [alice]'));
  assert.equal(cli(['home', 'acme/app', 'merge', '--file', other], env).out, 'bob\n');
  assert.equal(cli(['home', 'acme/app', 'merge', `--file=${other}`], env).out, 'bob\n');
  assert.equal(cli(['get', 'x', '--file', path.join(dir, 'missing.yml')], env).code, 1);
  // single-fleet: no file at all
  const single = { FLEET_REPO: tmp(), FLEET_ID: 'alice' };
  const r = cli(['home', 'acme/app', 'merge'], single);
  assert.equal(r.code, 3);
  assert.match(r.err, /single-fleet mode/);
  assert.equal(cli(['get', 'version'], single).code, 3);
});

test('cli address and status', () => {
  assert.deepEqual(JSON.parse(cli(['address', 'acme-build'], { FLEET_ID: 'alice' }).out), { fleet: 'alice', session: 'acme-build' });
  assert.deepEqual(JSON.parse(cli(['address', 'acme-build'], {}).out), { fleet: null, session: 'acme-build' });
  assert.deepEqual(JSON.parse(cli(['address', 'bob:acme-mm'], { FLEET_ID: 'alice' }).out), { fleet: 'bob', session: 'acme-mm' });
  assert.equal(cli(['address', 'a:b:c']).code, 1);
  const dir = tmp();
  let r = cli(['status'], { FLEET_REPO: dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /^fleet: single-fleet mode/);
  write(dir, 'federation.yml', DOC);
  r = cli(['status'], { FLEET_REPO: dir, FLEET_ID: 'alice' });
  assert.equal(r.code, 0);
  assert.match(r.out, /^fleet: alice\nfederation: .*\(2 fleets: alice, bob\)\n {2}acme\/app merge +home alice \(this fleet\)/);
  write(dir, 'federation.yml', 'version: 3\nfleets:\n  alice: { enabled: true }\n');
  r = cli(['status'], { FLEET_REPO: dir, FLEET_ID: 'alice' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^fleet: alice\nfederation: INVALID/);
  assert.equal(cli([]).code, 1);
  assert.equal(cli(['bogus']).code, 1);
  assert.equal(cli(['--help']).code, 0);
});

// --- the fleet's status issue (the broker's ledger in multi-fleet mode, #54) ---------------------

test('repoFromRemoteUrl: GitHub https, ssh and scp-like remotes; anything else is null', () => {
  assert.equal(repoFromRemoteUrl('https://github.com/acme/acme-fleet.git'), 'acme/acme-fleet');
  assert.equal(repoFromRemoteUrl('https://x-access-token@github.com/acme/acme-fleet\n'), 'acme/acme-fleet');
  assert.equal(repoFromRemoteUrl('git@github.com:acme/acme.fleet.git'), 'acme/acme.fleet');
  assert.equal(repoFromRemoteUrl('ssh://git@github.com/acme/acme-fleet'), 'acme/acme-fleet');
  assert.equal(repoFromRemoteUrl('https://gitlab.com/acme/acme-fleet.git'), null);
  assert.equal(repoFromRemoteUrl('/srv/git/acme-fleet'), null);
  assert.equal(repoFromRemoteUrl(''), null);
});

test('instanceRepo: FLEET_INSTANCE_REPO wins, else the origin of the checkout holding the file', () => {
  const dir = tmp();
  const f = write(dir, 'federation.yml', DOC);
  assert.equal(instanceRepo(f, { FLEET_INSTANCE_REPO: 'acme/acme-fleet' }), 'acme/acme-fleet');
  assert.throws(() => instanceRepo(f, { FLEET_INSTANCE_REPO: 'not a repo' }), /FLEET_INSTANCE_REPO "not a repo" must be owner\/name/);
  assert.equal(instanceRepo(f, {}), null, 'not a git checkout: unknown');
  hermeticGit(dir, ['init', '-q'], { isolateConfig: true });
  hermeticGit(dir, ['remote', 'add', 'origin', 'git@github.com:acme/acme-fleet.git'], { isolateConfig: true });
  assert.equal(instanceRepo(f, {}), 'acme/acme-fleet');
});

test('statusIssueTarget: null in single-fleet mode; the issue per fleet; fail closed otherwise', () => {
  const reg = parseFederation(DOC);
  const env = { FLEET_INSTANCE_REPO: 'acme/acme-fleet' };
  assert.equal(statusIssueTarget(null, 'alice', { env }), null);
  assert.equal(statusIssueTarget(reg, null, { env }), null);
  assert.deepEqual(statusIssueTarget(reg, 'alice', { env }), { repo: 'acme/acme-fleet', issue: 11 });
  assert.deepEqual(statusIssueTarget(reg, 'bob', { env }), { repo: 'acme/acme-fleet', issue: 12 }, 'two fleets, two issues');
  assert.throws(() => statusIssueTarget(reg, 'carol', { env }), /FLEET_ID "carol" is not declared/);
  const noIssue = parseFederation(minimal());
  assert.throws(() => statusIssueTarget(noIssue, 'alice', { env, file: 'f.yml' }), /fleets\.alice\.status_issue is not declared in f\.yml/);
  assert.throws(() => statusIssueTarget(reg, 'alice', { env: {}, file: path.join(tmp(), 'federation.yml') }), /set FLEET_INSTANCE_REPO=owner\/name/);
});

test('cli status-issue: owner/repo#N, exit 3 in single-fleet mode, exit 1 when unresolvable', () => {
  const dir = tmp();
  const f = write(dir, 'federation.yml', DOC);
  const env = { FLEET_ID: 'bob', FLEET_INSTANCE_REPO: 'acme/acme-fleet' };
  let r = cli(['status-issue', '--file', f], env);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'acme/acme-fleet#12\n');
  r = cli(['status-issue'], { ...env, FLEET_REPO: dir });
  assert.equal(r.out, 'acme/acme-fleet#12\n', 'the default file is <instance>/federation.yml');
  r = cli(['status-issue'], { ...env, FLEET_REPO: tmp() });
  assert.equal(r.code, 3);
  assert.match(r.err, /single-fleet mode/);
  r = cli(['status-issue', '--file', f], { FLEET_INSTANCE_REPO: 'acme/acme-fleet' });
  assert.equal(r.code, 3, 'no FLEET_ID: single-fleet');
  r = cli(['status-issue', '--file', f], { ...env, FLEET_ID: 'carol' });
  assert.equal(r.code, 1);
  assert.match(r.err, /not declared/);
  r = cli(['status-issue', 'extra', '--file', f], env);
  assert.equal(r.code, 1);
});
