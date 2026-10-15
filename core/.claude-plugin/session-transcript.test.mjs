// Tests for session-transcript.mjs (engsys#125) — run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, sessionsDir } from './session-transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'session-transcript.mjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-st-')));
const INPUT = { session_id: 'abc', transcript_path: '/home/x/.claude/projects/p/abc.jsonl', source: 'startup' };

test('records the transcript of a fleet-launched session, 0600, by rename', () => {
  const dir = tmp();
  const f = record(INPUT, { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSION_RUN: 'r1', ENGSYS_SESSIONS_DIR: dir }, () => new Date('2026-10-14T00:00:00Z'));
  assert.equal(f, path.join(dir, 'acme-mm.json'));
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(rec, { session: 'acme-mm', fleet: null, run: 'r1', session_id: 'abc', transcript_path: INPUT.transcript_path, source: 'startup', at: '2026-10-14T00:00:00.000Z' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['acme-mm.json'], 'no temp file left behind');
});

test('a /clear (new transcript) replaces the record; FLEET_ID qualifies the name', () => {
  const dir = tmp();
  const env = { ENGSYS_SESSION: 'acme-mm', FLEET_ID: 'alice', ENGSYS_SESSIONS_DIR: dir };
  record(INPUT, env);
  const f = record({ ...INPUT, transcript_path: '/home/x/new.jsonl', source: 'clear' }, env);
  assert.equal(path.basename(f), 'alice.acme-mm.json');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).transcript_path, '/home/x/new.jsonl');
});

test('records nothing outside a fleet session, or for a name or path it cannot trust', () => {
  const dir = tmp();
  assert.equal(record(INPUT, { ENGSYS_SESSIONS_DIR: dir }), null, 'no ENGSYS_SESSION');
  assert.equal(record(INPUT, { ENGSYS_SESSION: '../x', ENGSYS_SESSIONS_DIR: dir }), null, 'a path in the name');
  assert.equal(record(INPUT, { ENGSYS_SESSION: 'acme-mm', FLEET_ID: 'a/b', ENGSYS_SESSIONS_DIR: dir }), null, 'a path in the fleet');
  assert.equal(record({ ...INPUT, transcript_path: 'rel.jsonl' }, { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSIONS_DIR: dir }), null, 'a relative transcript');
  assert.equal(record({}, { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSIONS_DIR: dir }), null, 'no transcript');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the sessions dir: ENGSYS_SESSIONS_DIR, else XDG_STATE_HOME, else ~/.local/state', () => {
  assert.equal(sessionsDir({ ENGSYS_SESSIONS_DIR: '/a' }), '/a');
  assert.equal(sessionsDir({ XDG_STATE_HOME: '/s' }), '/s/engsys/sessions');
  assert.equal(sessionsDir({ HOME: '/h' }), '/h/.local/state/engsys/sessions');
});

test('hook I/O: silent, exit 0, fail-open on garbage; wired on SessionStart behind ENGSYS_SESSION', () => {
  const dir = tmp();
  const run = (input, env) => spawnSync(process.execPath, [HOOK], { input, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const r = run(JSON.stringify(INPUT), { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSIONS_DIR: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, 'acme-mm.json')));
  assert.equal(run('not json', { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSIONS_DIR: dir }).status, 0);
  const hooks = JSON.parse(fs.readFileSync(path.join(HERE, 'hooks.json'), 'utf8'));
  const cmds = hooks.hooks.SessionStart.flatMap((h) => (h.matcher ? [] : h.hooks.map((x) => x.command)));
  const c = cmds.find((x) => x.includes('session-transcript.mjs'));
  assert.ok(c, 'registered for every SessionStart source (no matcher)');
  assert.match(c, /^\[ -z "\$\{ENGSYS_SESSION:-\}" \] \|\| node /, 'node starts only in a fleet session');
});
