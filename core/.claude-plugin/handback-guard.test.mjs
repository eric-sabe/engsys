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

// ---------------------------------------------------------------------------------- engsys#126 --

test('block B: an engsys persona that ends on a conclusive verdict needs no status line', () => {
  for (const m of ['Re-ran the gate.\nVERDICT: CLEAN', '**VERDICT:** FINDINGS — 2 warnings, see above', '`VERDICT: PASS`', 'VERDICT: APPROVE']) {
    assert.equal(subagentDecision({ last_assistant_message: m, agent_type: 'engsys:nyx' }), null, m);
  }
  assert.match(subagentDecision({ last_assistant_message: 'Looked at it.\nVERDICT: PENDING', agent_type: 'engsys:nyx' }), /status line/, 'an inconclusive verdict is no completion');
  assert.match(subagentDecision({ last_assistant_message: 'The verdict: clean.', agent_type: 'engsys:nyx' }), /status line/, 'prose is not a verdict line');
  assert.match(subagentDecision({ last_assistant_message: 'Verdict: needs work', agent_type: 'engsys:nyx' }), /status line/, 'lower-case words are not the conclusive vocabulary');
  assert.match(subagentDecision({ last_assistant_message: 'VERDICT: MAYBE', agent_type: 'engsys:nyx' }), /status line/, 'nor is any other capitalised word');
  assert.match(subagentDecision({ last_assistant_message: 'VERDICT: CLEAN\n\nThen I went on:\na\nb\nc\nd\ne', agent_type: 'engsys:nyx' }), /status line/, 'only the last five lines count');
  for (const m of ['Verdict: REQUIRED CHANGES', 'VERDICT: CHANGES REQUESTED — see 3 findings', 'VERDICT: BLOCK']) {
    assert.equal(subagentDecision({ last_assistant_message: m, agent_type: 'engsys:nyx' }), null, m);
  }
  assert.match(subagentDecision({ last_assistant_message: 'Review is still running; will finish once it lands.\nVERDICT: CLEAN', agent_type: 'engsys:nyx' }), /never woken again/,
    'a verdict never hides pending work (block A still applies)');
});

test('block C: a singleton monster session is never blocked at Stop; any other session still is', () => {
  const sid = 'sess-monster';
  recordHandback({ session_id: sid, agent_id: 'm1', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — push pending' });
  for (const role of ['merge', 'maintain']) assert.equal(stopDecision({ session_id: sid }, { ENGSYS_SINGLETON_ROLE: role }), null, role);
  assert.match(stopDecision({ session_id: sid }, {}), /1 subagent\(s\) handed back INCOMPLETE/, 'unsurfaced, so a non-monster session still hears about it');
  recordHandback({ session_id: 'sess-monster-2', agent_id: 'm2', last_assistant_message: 'STATUS: INCOMPLETE — review pending' });
  const run = spawnSync(process.execPath, [HOOK, 'stop'], { input: JSON.stringify({ session_id: 'sess-monster-2' }), env: { ...process.env, ENGSYS_HANDBACK_DIR: DIR, ENGSYS_SINGLETON_ROLE: 'merge' }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
});

test('block C net for monsters: an INCOMPLETE hand-back in a fleet session is logged for the bus to relay', async () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-sess-'));
  const env = { ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSION_RUN: 'r7', ENGSYS_SINGLETON_ROLE: 'merge', ENGSYS_SESSIONS_DIR: sdir };
  recordHandback({ session_id: 'sess-net', agent_id: 'n1', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — push\u0007 pending' }, env);
  recordHandback({ session_id: 'sess-net', agent_id: 'n2', agent_type: 'engsys:isabelle', last_assistant_message: 'Done.\nSTATUS: COMPLETE' }, env);
  const lines = fs.readFileSync(path.join(sdir, 'acme-mm.handbacks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, 'only the INCOMPLETE one');
  assert.equal(lines[0].run, 'r7');
  assert.equal(lines[0].agent_id, 'n1');
  assert.equal(lines[0].remains, 'push  pending', 'control characters are stripped');
  recordHandback({ session_id: 'sess-net2', agent_id: 'n3', last_assistant_message: 'STATUS: INCOMPLETE — x' }, { ENGSYS_SESSIONS_DIR: sdir });
  assert.deepEqual(fs.readdirSync(sdir), ['acme-mm.handbacks.jsonl'], 'nothing logged outside a fleet session');
  // Stale lock recovery (#138): a crashed holder's >30s `.lock` dir is stolen and cleaned up.
  const staleLock = path.join(sdir, 'acme-mm.handbacks.jsonl.lock');
  fs.mkdirSync(staleLock);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(staleLock, past, past);
  recordHandback({ session_id: 'sess-net', agent_id: 'n4', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — after stale lock' }, env);
  assert.equal(fs.existsSync(staleLock), false, 'stale lock stolen and cleaned up');
  const afterLines = fs.readFileSync(path.join(sdir, 'acme-mm.handbacks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(afterLines.length, 2);
  // Active lock timeout (#138): never append without the lock; preserve in `.pending.*` and drain once lock frees.
  fs.mkdirSync(staleLock);
  recordHandback(
    { session_id: 'sess-net', agent_id: 'n5', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — queued while locked' },
    { ...env, ENGSYS_HANDBACK_LOCK_TIMEOUT_MS: '15' }
  );
  const duringLockLines = fs.readFileSync(path.join(sdir, 'acme-mm.handbacks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(duringLockLines.length, 2, 'did not append to handbacks.jsonl while lock was held');
  assert.equal(fs.readdirSync(sdir).some((n) => n.startsWith('acme-mm.handbacks.jsonl.pending.')), true, 'saved in pending sidecar');
  fs.rmdirSync(staleLock);
  recordHandback({ session_id: 'sess-net', agent_id: 'n6', agent_type: 'engsys:isabelle', last_assistant_message: 'STATUS: INCOMPLETE — drains pending' }, env);
  assert.equal(fs.readdirSync(sdir).some((n) => n.startsWith('acme-mm.handbacks.jsonl.pending.')), false, 'pending sidecar drained');
  const drainedLines = fs.readFileSync(path.join(sdir, 'acme-mm.handbacks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(drainedLines.map((l) => l.agent_id), ['n1', 'n4', 'n5', 'n6']);
});

test('CT-06: Copilot payload with pending promise exits 0 with JSON {"decision":"block","reason":"engsys hand-back guard:..."}', () => {
  const r = spawnSync(
    process.execPath,
    [HOOK, 'subagent'],
    {
      input: JSON.stringify({
        hookEventName: 'subagentStop',
        sessionId: 'sess-copilot-hb',
        agentId: 'a-cop',
        agentType: 'engsys:isabelle',
        lastAssistantMessage: 'I will continue once CI finishes.',
      }),
      env: { ...process.env, ENGSYS_HANDBACK_DIR: DIR },
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^engsys hand-back guard:/);
});


// ---------------------------------------------------------------------------------- engsys#286 --
// Only agents this session dispatched are guarded: a harness-internal agent (no agent_type, never dispatched)
// whose text sounds pending must not put a HANDBACK_INCOMPLETE on a monster's bus.

const { noteDispatch, claimDispatch, wasDispatched } = await import('./handback-guard.mjs');
const LOOP = 'merge-monster orchestrator is holding the merge baton for FeedFrwd/keystone; ledger #2792 is open, so the loop runs until it closes. Still running.';
const MEMORY_INJECT = path.join(path.dirname(HOOK), 'subagent-memory-inject.mjs');

function fleetRun(mode, input, sdir, extra = {}) {
  return spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify(input),
    env: { ...process.env, FLEET_ID: '', ENGSYS_HANDBACK_DIR: DIR, ENGSYS_SESSION: 'acme-mm', ENGSYS_SESSION_RUN: 'r1', ENGSYS_SESSIONS_DIR: sdir, ...extra },
    encoding: 'utf8',
  });
}
const relayed = (sdir) => {
  const f = path.join(sdir, 'acme-mm.handbacks.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('286: an undispatched agent with pending-sounding text is neither blocked, recorded nor relayed', () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-286-'));
  const dbg = path.join(sdir, 'debug.jsonl');
  // the observed shape: no agent_type, a bare 17-hex agent id, in a session that dispatched something else
  noteDispatch({ session_id: 'sess-286a', tool_input: { subagent_type: 'engsys:isabelle' } });
  const r = fleetRun('subagent', { session_id: 'sess-286a', agent_id: 'a9be9a2dec73dbce7', last_assistant_message: LOOP }, sdir, { ENGSYS_HANDBACK_DEBUG: dbg });
  assert.equal(r.status, 0, 'never blocked');
  assert.equal(r.stderr, '');
  assert.deepEqual(relayed(sdir), [], 'nothing on the bus');
  assert.equal(stopDecision({ session_id: 'sess-286a' }, {}), null, 'nothing recorded for the Stop guard either');
  assert.match(fs.readFileSync(dbg, 'utf8'), /"ignored":"not dispatched by this session"/, 'logged under ENGSYS_HANDBACK_DEBUG');
  // …and in a session that never tracked a dispatch, the empty agent_type alone is enough
  const r2 = fleetRun('subagent', { session_id: 'sess-286b', agent_id: 'a63689d9bd2137895', last_assistant_message: LOOP }, sdir);
  assert.equal(r2.status, 0);
  assert.deepEqual(relayed(sdir), []);
});

test('286: a dispatched agent\'s INCOMPLETE is still recorded and relayed, and a pending one still blocked', () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-286c-'));
  noteDispatch({ session_id: 'sess-286c', tool_input: { subagent_type: 'engsys:isabelle' } });
  assert.equal(claimDispatch({ session_id: 'sess-286c', agent_id: 'a-real', agent_type: 'engsys:isabelle' }), true);
  const blocked = fleetRun('subagent', { session_id: 'sess-286c', agent_id: 'a-real', agent_type: 'engsys:isabelle', last_assistant_message: STALL }, sdir);
  assert.equal(blocked.status, 2, 'block A still applies to a dispatched agent');
  const inc = fleetRun('subagent', { session_id: 'sess-286c', agent_id: 'a-real', agent_type: 'engsys:isabelle', last_assistant_message: 'Stopped.\nSTATUS: INCOMPLETE — push pending' }, sdir);
  assert.equal(inc.status, 0);
  assert.deepEqual(relayed(sdir).map((l) => [l.agent_id, l.remains]), [['a-real', 'push pending']]);
  assert.match(stopDecision({ session_id: 'sess-286c' }, {}), /1 subagent\(s\) handed back INCOMPLETE/);
});

test('286: claimDispatch matches the teammate name first, then the type; consumes the record; ignores expired ones', () => {
  noteDispatch({ session_id: 'sess-286d', tool_input: { subagent_type: 'engsys:isabelle' } });
  noteDispatch({ session_id: 'sess-286d', tool_input: { subagent_type: 'engsys:nyx', name: 'isabelle' } });
  assert.equal(claimDispatch({ session_id: 'sess-286d', agent_id: 'a-team', agent_type: 'isabelle' }), true, 'the teammate named isabelle');
  assert.equal(claimDispatch({ session_id: 'sess-286d', agent_id: 'a-plain', agent_type: 'engsys:isabelle' }), true, 'the plain isabelle dispatch is still there');
  assert.equal(claimDispatch({ session_id: 'sess-286d', agent_id: 'a-extra', agent_type: 'engsys:isabelle' }), false, 'each dispatch is claimed once');
  assert.equal(claimDispatch({ session_id: 'sess-286d', agent_id: 'a-internal', agent_type: '' }), false, 'no agent_type: never claims');
  noteDispatch({ session_id: 'sess-286e', tool_input: { subagent_type: 'general-purpose' } }, { now: () => Date.now() - 10 * 60_000 });
  assert.equal(claimDispatch({ session_id: 'sess-286e', agent_id: 'a-late', agent_type: 'general-purpose' }), false, 'an expired dispatch is not claimed');
  assert.equal(wasDispatched({ session_id: 'sess-286d', agent_id: 'a-team', agent_type: 'isabelle' }), true);
  assert.equal(wasDispatched({ session_id: 'sess-286d', agent_id: 'a-extra', agent_type: 'engsys:isabelle' }), false, 'tracked session, unclaimed agent');
  assert.equal(wasDispatched({ session_id: 'sess-286-none', agent_id: 'x', agent_type: 'engsys:aaron' }), true, 'no tracking at all (e.g. Copilot): a typed agent keeps the guard');
});

test('286 end to end: memory-inject\'s PreToolUse + SubagentStart hooks mark the dispatch the guard then honours', () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-286f-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-286-cwd-')); // not a repo: the brief fails open, the claim still happens
  const env = { ...process.env, ENGSYS_HANDBACK_DIR: DIR, NODE_NO_WARNINGS: '1' };
  spawnSync(process.execPath, [MEMORY_INJECT, 'pre-agent'], { cwd, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-286f', cwd, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'engsys:bert', name: 'bert-p3', prompt: 'x' } }) });
  spawnSync(process.execPath, [MEMORY_INJECT], { cwd, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-286f', cwd, hook_event_name: 'SubagentStart', agent_id: 'abert-p3-1234', agent_type: 'bert-p3' }) });
  const inc = fleetRun('subagent', { session_id: 'sess-286f', agent_id: 'abert-p3-1234', agent_type: 'bert-p3', last_assistant_message: 'STATUS: INCOMPLETE — waiting for the lead' }, sdir);
  assert.equal(inc.status, 0);
  assert.deepEqual(relayed(sdir).map((l) => l.agent_id), ['abert-p3-1234']);
  const internal = fleetRun('subagent', { session_id: 'sess-286f', agent_id: 'a0123456789abcdef', last_assistant_message: LOOP }, sdir);
  assert.equal(internal.status, 0);
  assert.deepEqual(relayed(sdir).map((l) => l.agent_id), ['abert-p3-1234'], 'the internal agent added nothing');
});

test('286 review W2: an untyped dispatch is recorded as general-purpose, so its agent stays guarded', () => {
  noteDispatch({ session_id: 'sess-286w2', tool_input: { subagent_type: 'engsys:isabelle' } }); // a typed one is tracked too
  noteDispatch({ session_id: 'sess-286w2', tool_input: { description: 'look around', prompt: 'x' } });
  assert.equal(claimDispatch({ session_id: 'sess-286w2', agent_id: 'a-gp', agent_type: 'general-purpose' }), true);
  assert.equal(wasDispatched({ session_id: 'sess-286w2', agent_id: 'a-gp', agent_type: 'general-purpose' }), true);
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-hb-286w2-'));
  const inc = fleetRun('subagent', { session_id: 'sess-286w2', agent_id: 'a-gp', agent_type: 'general-purpose', last_assistant_message: 'STATUS: INCOMPLETE — tests still to run' }, sdir);
  assert.equal(inc.status, 0);
  assert.deepEqual(relayed(sdir).map((l) => l.agent_id), ['a-gp'], 'its INCOMPLETE is relayed');
});

test('286 review L1: a plain typed start never claims a teammate\'s record by type', () => {
  noteDispatch({ session_id: 'sess-286l1', tool_input: { subagent_type: 'engsys:bert', name: 'bert-p2' } });
  assert.equal(claimDispatch({ session_id: 'sess-286l1', agent_id: 'a-plain-bert', agent_type: 'engsys:bert' }), false, 'not by type');
  assert.equal(claimDispatch({ session_id: 'sess-286l1', agent_id: 'abert-p2-1', agent_type: 'bert-p2' }), true, 'the teammate still claims it by name');
});
