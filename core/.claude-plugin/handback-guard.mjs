#!/usr/bin/env node
// handback-guard.mjs — SubagentStop + Stop hooks for the engsys core PLUGIN.
//
// A finished subagent is never woken again by its own background work, and a session that ends
// its turn on an unfinished hand-back has nothing left to wake it. Prose ("never fire-and-forget")
// didn't hold, so this enforces it at the two points where the stall is created:
//
//   SubagentStop (mode `subagent`) — a subagent about to hand back:
//     A. its final message says work is still pending ("will continue once…", "still running",
//        "waiting for…") and it didn't declare INCOMPLETE → block once: finish it now, or hand back
//        an explicit `STATUS: INCOMPLETE — <what remains>`.
//     B. an engsys persona (agent_type `engsys:*`) without a `STATUS: COMPLETE|INCOMPLETE` line →
//        block once: add it. Not when it ends on a conclusive verdict (`VERDICT: CLEAN`, `FINDINGS`,
//        `PASS`, `APPROVE`, …; engsys#126): a reviewer's verdict is its completion line, and the extra
//        turn only re-sent the same report.
//     • INCOMPLETE → allowed, and recorded for the parent session.
//   Stop (mode `stop`) — the main session about to end its turn:
//     C. recorded INCOMPLETE hand-backs it hasn't been told about → block once, listing them: resume
//        the agent (SendMessage), take the work over, or arm a watchdog (subagent-liveness skill).
//        Skipped in a singleton monster session (ENGSYS_SINGLETON_ROLE set; engsys#126). A monster's
//        net is its event bus instead: in any fleet-launched session (ENGSYS_SESSION set) an INCOMPLETE
//        hand-back is also appended to <sessions dir>/[<fleet>.]<session>.handbacks.jsonl, which the
//        watch bus and the tick relay as `HANDBACK_INCOMPLETE <agent>: <remains>` (core/lib/monster.sh),
//        so the monster is woken about it by the same channel as every other event and never has to be
//        held at Stop.
//
// Every block happens at most once per stop attempt (`stop_hook_active`) and per hand-back, so a
// session is never trapped. Fail-open: any error → allow (exit 0, no output).
//
// Only agents THIS session dispatched are guarded (engsys#286). The harness also runs internal subagents that
// inherit the session's context (forked or summarising agents; they reach SubagentStop with no agent_type) and whose
// final text describes the session's own work ("the loop runs until…"). Treating those as dispatched workers put
// spurious HANDBACK_INCOMPLETE events on monster buses. So a dispatch is tracked end to end: subagent-memory-inject's
// PreToolUse (Agent|Task) hook calls noteDispatch, its SubagentStart hook calls claimDispatch (the agent's id is first
// known there; matched by teammate name, then by agent type, as the memory brief matches), and SubagentStop acts only
// on a claimed agent_id. Anything else is ignored (logged under ENGSYS_HANDBACK_DEBUG); where no dispatch was ever
// tracked for the session, an agent with an agent_type still counts (see wasDispatched).
//
// Env: ENGSYS_HANDBACK_DIR (state dir; default <tmpdir>/engsys-handbacks), ENGSYS_HANDBACK_DEBUG=<file>
// (opt-in: append each hook input, message truncated, for diagnosis).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarness, emitStopBlock, recordHookTelemetry, writeHookResult } from '../lib/harness-io.mjs';
import { sessionsDir } from './session-transcript.mjs';

// Strong: a promise to act later. Overrides even an explicit `STATUS: COMPLETE`.
const STRONG = [
  /\b(?:still|currently)\s+(?:running|in progress|pending|executing|underway)\b/i,
  /\bwill\s+(?:continue|resume|carry on|pick (?:it|this|that) (?:back )?up|finish|follow up)\b[^.\n]{0,100}\b(?:once|when|after)\b/i,
  /\b(?:once|when|after)\s+(?:it|that|this|the\s+[\w\s#.-]{1,40}?)\s+(?:finishes|completes|is done|returns|lands|reports back)\b/i,
];
// Weak: suggests pending work; only counts when no explicit status was given.
const WEAK = [/\b(?:waiting|wait)\s+(?:on|for)\b/i, /\bin[- ]progress\b/i];
const STATUS = /^\s*[*_`]*STATUS[*_`]*\s*:\s*[*_`]*\s*(COMPLETE|INCOMPLETE)\b[*_`]*(.*)$/im;
// A conclusive verdict line (engsys#126 review): `VERDICT:` (or `Verdict:`) followed by one word of the
// conclusive vocabulary, in capitals, on one of the last five non-empty lines. Case-sensitive on purpose:
// "Verdict: needs work" is prose, not a verdict.
const VERDICT = /^\s*[*_`]*(?:VERDICT|Verdict)[*_`]*\s*:\s*[*_`]*\s*(CLEAN|FINDINGS|PASS(?:ED)?|FAIL(?:ED)?|APPROVED?|BLOCK(?:ED|ING)?|REJECT(?:ED)?|(?:REQUIRED|REQUEST(?:ED)?) CHANGES|CHANGES REQUIRED|CHANGES REQUESTED|SECURE|INSECURE|NO-GO|GO|SHIP|LGTM)(?![A-Za-z-])/m;
function verdictOf(m) {
  const tail = m.split('\n').filter((l) => l.trim()).slice(-5).join('\n');
  const v = tail.match(VERDICT);
  return v ? v[1] : null;
}

function pendingSentence(m) {
  for (const re of [...STRONG, ...WEAK]) {
    const hit = m.match(re);
    if (hit) {
      const start = Math.max(m.lastIndexOf('.', hit.index) + 1, m.lastIndexOf('\n', hit.index) + 1);
      const end = m.slice(hit.index).search(/[.\n]/);
      return m.slice(start, end < 0 ? undefined : hit.index + end).trim().slice(0, 200);
    }
  }
  return '';
}

/**
 * Classify a final message → { status, pending, remains, verdict }:
 *   status  'COMPLETE' | 'INCOMPLETE' | null (no status line)
 *   verdict the word of a conclusive `VERDICT:` line (CLEAN, FINDINGS, PASS, …), else null
 *   pending true when it promises unfinished work (strong phrases always; weak ones only without a status)
 *   remains what's unfinished (the INCOMPLETE line's text, else the pending sentence)
 */
export function classify(message) {
  const m = String(message || '');
  const s = m.match(STATUS);
  const status = s ? s[1].toUpperCase() : null;
  const strong = STRONG.some((re) => re.test(m));
  const weak = WEAK.some((re) => re.test(m));
  const pending = strong || (!status && weak);
  const stated = s ? s[2].replace(/^[\s*_`—–:-]+/, '').replace(/[\s*_`]+$/, '').trim() : '';
  const verdict = verdictOf(m);
  return { status, pending, remains: stated || (pending ? pendingSentence(m) : ''), verdict };
}

/** SubagentStop decision → reason string to block with, or null to allow. */
export function subagentDecision(input) {
  if (input.stop_hook_active) return null;
  const c = classify(input.last_assistant_message);
  if (c.status === 'INCOMPLETE') return null;
  if (c.pending) {
    return [
      'engsys hand-back guard: your final message says work is still pending, but a subagent that hands back',
      'is never woken again — not by its own background tasks, reviews or builds finishing. Nothing will resume you.',
      'Do ONE of these now:',
      '  1. Wait for that work (poll it / run it in the foreground / Monitor it) and finish the job; then end with',
      '     `STATUS: COMPLETE`.',
      '  2. Stop cleanly and end with `STATUS: INCOMPLETE — <exactly what remains and how to resume it>` so the',
      '     parent session knows it must act.',
    ].join('\n');
  }
  if (!c.status && !c.verdict && /^engsys:/.test(String(input.agent_type || ''))) {
    return 'engsys hand-back guard: end your final message with a status line — `STATUS: COMPLETE`, or `STATUS: INCOMPLETE — <what remains>` if anything is unfinished (a pending review, build, push, or follow-up counts as unfinished).';
  }
  return null;
}

function stateDir(sessionId) {
  const d = path.join(process.env.ENGSYS_HANDBACK_DIR || path.join(os.tmpdir(), 'engsys-handbacks'), String(sessionId || 'unknown').replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ---------------------------------------------------------------------------------------------
// Dispatch tracking (engsys#286): which subagents this session dispatched
// ---------------------------------------------------------------------------------------------

const DISPATCH_TTL_MS = 120_000;
const token = (v) => String(v ?? '').replace(/[^\w.-]/g, '_').slice(0, 128);
const bareType = (t) => { const parts = String(t || '').split(':'); return parts[parts.length - 1].trim().toLowerCase(); };

/** PreToolUse (Agent|Task): remember that this session is dispatching an agent of this type / teammate name. */
export function noteDispatch(input, { now = Date.now } = {}) {
  try {
    const ti = input?.tool_input ?? input?.toolInput ?? {};
    // An untyped dispatch starts as `general-purpose` (the Agent tool's default); recording nothing for it would
    // leave its hand-backs unguarded once any typed dispatch had been tracked (review W2).
    const type = bareType(ti.subagent_type || ti.agent_type || '') || 'general-purpose';
    const name = typeof ti.name === 'string' && ti.name ? token(ti.name) : '';
    const dir = path.join(stateDir(input.session_id ?? input.sessionId), 'dispatches');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ts = now();
    const f = path.join(dir, `${ts}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(f, JSON.stringify({ ts, type, name }), { mode: 0o600 });
    return f;
  } catch {
    return null;
  }
}

/**
 * SubagentStart: claim the dispatch this agent came from, and mark its agent_id as dispatched. Matched by the
 * teammate name first (a teammate starts with its name as agent_type), then by agent type; the oldest unexpired
 * record wins, and is consumed. An agent with no matching dispatch (a harness-internal agent) gets no mark.
 */
export function claimDispatch(input, { now = Date.now } = {}) {
  try {
    const agentId = input?.agent_id ?? input?.agentId;
    const agentType = input?.agent_type ?? input?.agentType;
    if (!agentId || !agentType) return false;
    const base = stateDir(input.session_id ?? input.sessionId);
    const dir = path.join(base, 'dispatches');
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return false; }
    const t = now();
    const live = [];
    for (const n of names) {
      const f = path.join(dir, n);
      let r;
      try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { r = null; }
      if (!r || t - (r.ts ?? 0) > DISPATCH_TTL_MS) { fs.rmSync(f, { force: true }); continue; }
      live.push({ f, r });
    }
    live.sort((a, b) => a.r.ts - b.r.ts);
    // A teammate's record (it carries a `name`) is claimed only by that name: a plain `engsys:bert` start must not take
    // the `bert-p2` teammate's dispatch by type (review L1).
    const hit = live.find(({ r }) => r.name && r.name === token(agentType)) || live.find(({ r }) => !r.name && r.type && r.type === bareType(agentType));
    if (!hit) return false;
    fs.rmSync(hit.f, { force: true });
    const marks = path.join(base, 'dispatched');
    fs.mkdirSync(marks, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(marks, token(agentId)), JSON.stringify({ agent_type: agentType, at: new Date(t).toISOString() }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * SubagentStop: did this session dispatch this agent?
 *   - claimDispatch marked its agent_id → yes;
 *   - this session has tracked dispatches (noteDispatch ran at least once) but not this agent → no;
 *   - no tracking at all for the session (a harness or layout whose dispatch hooks didn't run, e.g. Copilot, which
 *     has no SubagentStart) → fall back to "it has an agent_type": the harness-internal agents of engsys#286 arrive
 *     with none, so they are still ignored, and a typed agent keeps the guard.
 */
export function wasDispatched(input) {
  try {
    const agentId = input?.agent_id;
    const base = stateDir(input.session_id);
    if (agentId && fs.existsSync(path.join(base, 'dispatched', token(agentId)))) return true;
    if (fs.existsSync(path.join(base, 'dispatches')) || fs.existsSync(path.join(base, 'dispatched'))) return false;
    return Boolean(input?.agent_type);
  } catch {
    return Boolean(input?.agent_type);
  }
}

/** Record (INCOMPLETE) or clear (anything else) the hand-back of one subagent. */
export function recordHandback(input, env = process.env) {
  const dir = stateDir(input.session_id);
  const f = path.join(dir, `${String(input.agent_id || 'agent').replace(/[^\w.-]/g, '_')}.json`);
  const c = classify(input.last_assistant_message);
  // INCOMPLETE — declared, or inferred when an agent handed back pending work anyway (after its nudge)
  if (c.status === 'INCOMPLETE' || (c.status !== 'COMPLETE' && c.pending)) {
    fs.writeFileSync(f, JSON.stringify({ agent_id: input.agent_id, agent_type: input.agent_type, remains: c.remains || '(unspecified)', surfaced: false, at: new Date().toISOString() }), { mode: 0o600 });
    relayHandback(input, c.remains || '(unspecified)', env);
  } else {
    fs.rmSync(f, { force: true });
  }
}

const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The monsters' net for block C (engsys#126 review): append an INCOMPLETE hand-back to the session's
 * hand-back log, which the watch bus and tick relay as an event. Only in a fleet-launched session; the run
 * id lets a relaunch ignore its predecessor's lines. Coordinates with monster_handback_prune /
 * monster_handback_events via `<file>.lock` (engsys#138). Never throws (the guard fails open).
 */
export function relayHandback(input, remains, env = process.env) {
  try {
    const session = env.ENGSYS_SESSION;
    const fleet = env.FLEET_ID || '';
    if (!session || !NAME.test(session) || (fleet && !NAME.test(fleet))) return null;
    const dir = sessionsDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = `${fleet ? `${fleet}.` : ''}${session}.handbacks.jsonl`;
    const file = path.join(dir, base);
    const lock = `${file}.lock`;
    const reclaim = `${lock}.reclaim`;
    const timeoutMs = Math.max(0, Number(env.ENGSYS_HANDBACK_LOCK_TIMEOUT_MS ?? 5000) || 0);
    let locked = false;
    const deadline = Date.now() + timeoutMs;
    while (!locked) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        locked = true;
      } catch {
        try {
          const st = fs.statSync(lock);
          if (Date.now() - st.mtimeMs > 30_000) {
            try {
              const rst = fs.statSync(reclaim);
              if (Date.now() - rst.mtimeMs > 30_000) fs.rmdirSync(reclaim);
            } catch { /* no stale reclaim lock */ }
            let reclaiming = false;
            try {
              fs.mkdirSync(reclaim, { mode: 0o700 });
              reclaiming = true;
            } catch { /* another process is reclaiming */ }
            if (reclaiming) {
              try {
                const st2 = fs.statSync(lock);
                if (st2.ino === st.ino && Date.now() - st2.mtimeMs > 30_000) {
                  const staleLock = `${lock}.stale.${process.pid}`;
                  fs.renameSync(lock, staleLock);
                  fs.rmdirSync(staleLock);
                }
              } catch { /* already released */ } finally {
                try { fs.rmdirSync(reclaim); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* released or raced */ }
        if (Date.now() >= deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, Math.max(1, deadline - Date.now())));
      }
    }
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);
    const entry = `${JSON.stringify({ at: new Date().toISOString(), run: env.ENGSYS_SESSION_RUN || null, agent_id: clean(input.agent_id, 80), agent_type: clean(input.agent_type || 'agent', 80), remains: clean(remains, 200) })}\n`;
    if (!locked) {
      const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmpPending = `${file}.tmp.${suffix}`;
      const pending = `${file}.pending.${suffix}`;
      fs.writeFileSync(tmpPending, entry, { mode: 0o600 });
      fs.renameSync(tmpPending, pending);
      return pending;
    }
    try {
      const prefix = `${base}.pending.`;
      for (const name of fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()) {
        const pf = path.join(dir, name);
        const df = `${pf}.draining.${process.pid}`;
        try {
          fs.renameSync(pf, df);
          const data = fs.readFileSync(df, 'utf8');
          if (data) fs.appendFileSync(file, data, { mode: 0o600 });
          fs.rmSync(df, { force: true });
        } catch { /* ignore raced pending file */ }
      }
      fs.appendFileSync(file, entry, { mode: 0o600 });
    } finally {
      try { fs.rmdirSync(lock); } catch { /* ignore */ }
    }
    return file;
  } catch {
    return null;
  }
}

/** Stop decision → reason string to block with (marks the listed hand-backs surfaced), or null. */
export function stopDecision(input, env = process.env) {
  if (input.stop_hook_active) return null;
  if (env.ENGSYS_SINGLETON_ROLE) return null; // block C: a monster tracks its agents in its registry
  const dir = stateDir(input.session_id);
  const open = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const f = path.join(dir, name);
    let r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (r.surfaced) continue;
    open.push(r);
    fs.writeFileSync(f, JSON.stringify({ ...r, surfaced: true }), { mode: 0o600 });
  }
  if (!open.length) return null;
  return [
    `engsys hand-back guard: ${open.length} subagent(s) handed back INCOMPLETE and nothing is watching them:`,
    ...open.map((r) => `  • ${r.agent_type || 'agent'} (${r.agent_id}): ${r.remains}`),
    'Before ending your turn, for each: resume it (SendMessage to that agent), take the remaining work over',
    'yourself, or arm a watchdog / ScheduleWakeup (subagent-liveness skill) — or tell the user plainly it is',
    'unfinished and why. Ending the turn without one of these is how work silently stalls for hours.',
  ].join('\n');
}

async function main() {
  const mode = process.argv[2];
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const rawInput = JSON.parse(raw);
  const input = {
    ...rawInput,
    session_id: rawInput.session_id ?? rawInput.sessionId,
    agent_id: rawInput.agent_id ?? rawInput.agentId,
    agent_type: rawInput.agent_type ?? rawInput.agentType,
    last_assistant_message: rawInput.last_assistant_message ?? rawInput.lastAssistantMessage,
    stop_hook_active: rawInput.stop_hook_active ?? rawInput.stopHookActive,
  };
  if (process.env.ENGSYS_HANDBACK_DEBUG) { // opt-in: what the hook actually receives
    const { last_assistant_message: m, ...rest } = input;
    fs.appendFileSync(process.env.ENGSYS_HANDBACK_DEBUG, `${JSON.stringify({ mode, ...rest, last_assistant_message: String(m || '').slice(0, 160) })}\n`);
  }
  let reason = null;
  if (mode === 'subagent') {
    if (!wasDispatched(input)) {
      // engsys#286: not an agent this session dispatched (a harness-internal agent): never blocked, recorded or relayed
      if (process.env.ENGSYS_HANDBACK_DEBUG) {
        fs.appendFileSync(process.env.ENGSYS_HANDBACK_DEBUG, `${JSON.stringify({ mode, ignored: 'not dispatched by this session', agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null })}\n`);
      }
      recordHookTelemetry({ hook: 'handback-guard', event: 'SubagentStop', decision: 'ignored', detail: `undispatched agent=${input.agent_type || '(none)'}` });
      return;
    }
    reason = subagentDecision(input);
    if (!reason) recordHandback(input); // only the final, allowed hand-back is recorded
  } else if (mode === 'stop') {
    reason = stopDecision(input);
  }
  const evName = mode === 'subagent' ? 'SubagentStop' : 'Stop';
  if (reason) {
    const harness = detectHarness(process.env, rawInput);
    if (harness === 'copilot') {
      process.exitCode = writeHookResult(emitStopBlock('copilot', reason), {
        hook: 'handback-guard',
        event: evName,
        detail: `${input.agent_type || mode}: ${reason.split('\n')[0]}`,
      });
    } else {
      recordHookTelemetry({
        hook: 'handback-guard',
        event: evName,
        decision: 'block',
        detail: `${input.agent_type || mode}: ${reason.split('\n')[0]}`,
      });
      process.stderr.write(`${reason}\n`);
      process.exitCode = 2; // block: the reason goes back to the model, which keeps working
    }
  } else {
    recordHookTelemetry({
      hook: 'handback-guard',
      event: evName,
      decision: 'allow',
      detail: input.agent_type ? `agent=${input.agent_type}` : mode,
    });
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => { process.exitCode = 0; });
}
