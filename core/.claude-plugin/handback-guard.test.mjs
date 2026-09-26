// Tests for handback-guard.mjs — run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-test-'));
process.env.ENGSYS_HANDBACK_DIR = DIR;
const { classify, subagentDecision, recordHandback, stopDecision } = await import('./handback-guard.mjs');
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handback-guard.mjs');

// The real stall: a persona handed back while its own review was still running, promising to continue.
const STALL = 'Implemented the change and pushed the branch. Review pass 2 is still running; I will carry on with the fixes once it finishes.';

test('classify: the real stall is pending with no status', () => {
  const c = classify(STALL);
  assert.equal(c.status, null);
  assert.equal(c.pending, true);
  assert.match(c.remains, /Review pass 2 is still running/);
});

test('classify: explicit statuses', () => {
  assert.equal(classify('Done.\n\nSTATUS: COMPLETE').status, 'COMPLETE');
  const inc = classify('Stopped at the review.\n**STATUS:** INCOMPLETE — review pass 2 not run; resume me to apply fixes');
  assert.equal(inc.status, 'INCOMPLETE');
  assert.equal(inc.remains, 'review pass 2 not run; resume me to apply fixes');
  assert.equal(classify('`STATUS: INCOMPLETE — push pending`').remains, 'push pending');
});

test('classify: weak phrases do not override an explicit COMPLETE; strong ones do', () => {
  assert.equal(classify('No longer waiting for CI — it passed.\nSTATUS: COMPLETE').pending, false);
  assert.equal(classify('The in-progress label was removed.\nSTATUS: COMPLETE').pending, false);
  assert.equal(classify('Build is still running; will finish once it lands.\nSTATUS: COMPLETE').pending, true);
});

test('classify: an ordinary finished report is not pending', () => {
  assert.equal(classify('Opened PR #12, CI green, review comment posted.').pending, false);
});

test('subagent: blocks the real stall, with instructions', () => {
  const r = subagentDecision({ last_assistant_message: STALL, agent_type: 'engsys:isabelle' });
  assert.match(r, /never woken again/);
  assert.match(r, /STATUS: INCOMPLETE/);
});

test('subagent: never blocks twice (stop_hook_active)', () => {
  assert.equal(subagentDecision({ last_assistant_message: STALL, stop_hook_active: true }), null);
});

test('subagent: engsys persona without a status line is asked for one; other agents are not', () => {
  assert.match(subagentDecision({ last_assistant_message: 'All done, PR #12 open.', agent_type: 'engsys:isabelle' }), /status line/);
  assert.equal(subagentDecision({ last_assistant_message: 'Found 3 call sites.', agent_type: 'Explore' }), null);
});

test('subagent: explicit INCOMPLETE and clean COMPLETE are allowed', () => {
  assert.equal(subagentDecision({ last_assistant_message: 'STATUS: INCOMPLETE — push pending', agent_type: 'engsys:isabelle' }), null);
  assert.equal(subagentDecision({ last_assistant_message: 'PR open.\nSTATUS: COMPLETE', agent_type: 'engsys:isabelle' }), null);
});

test('stop: an unhandled INCOMPLETE hand-back blocks the parent once, then not again', () => {
  const sid = 'sess-1';
  recordHandback({ session_id: sid, agent_id: 'a1', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — review pass 2 not applied' });
  const r = stopDecision({ session_id: sid });
  assert.match(r, /1 subagent\(s\) handed back INCOMPLETE/);
  assert.match(r, /engsys:isabelle \(a1\): review pass 2 not applied/);
  assert.equal(stopDecision({ session_id: sid }), null, 'surfaced once only');
});

test('stop: an agent that ignored the nudge and handed back pending work anyway is still surfaced', () => {
  const sid = 'sess-2';
  recordHandback({ session_id: sid, agent_id: 'a2', agent_type: 'general-purpose', last_assistant_message: STALL });
  assert.match(stopDecision({ session_id: sid }), /Review pass 2 is still running/);
});

test('stop: a later COMPLETE hand-back from the same agent clears it', () => {
  const sid = 'sess-3';
  recordHandback({ session_id: sid, agent_id: 'a3', last_assistant_message: 'STATUS: INCOMPLETE — x' });
  recordHandback({ session_id: sid, agent_id: 'a3', last_assistant_message: 'Finished x.\nSTATUS: COMPLETE' });
  assert.equal(stopDecision({ session_id: sid }), null);
});

test('stop: sessions are isolated', () => {
  recordHandback({ session_id: 'sess-4', agent_id: 'a4', last_assistant_message: 'STATUS: INCOMPLETE — y' });
  assert.equal(stopDecision({ session_id: 'sess-5' }), null);
});

test('hook I/O: exit 2 + stderr reason on block; exit 0 + silence on allow; fail-open on garbage', () => {
  const run = (mode, input) => spawnSync(process.execPath, [HOOK, mode], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ENGSYS_HANDBACK_DIR: DIR }, encoding: 'utf8' });
  const blocked = run('subagent', { session_id: 's9', agent_id: 'z', agent_type: 'engsys:aaron', last_assistant_message: STALL });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /hand-back guard/);
  const ok = run('subagent', { session_id: 's9', agent_id: 'z', agent_type: 'engsys:aaron', last_assistant_message: 'done\nSTATUS: COMPLETE' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  const garbage = run('stop', 'not json');
  assert.equal(garbage.status, 0);
});
