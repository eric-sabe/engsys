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
// Env: ENGSYS_HANDBACK_DIR (state dir; default <tmpdir>/engsys-handbacks), ENGSYS_HANDBACK_DEBUG=<file>
// (opt-in: append each hook input, message truncated, for diagnosis).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * id lets a relaunch ignore its predecessor's lines. Never throws (the guard fails open).
 */
export function relayHandback(input, remains, env = process.env) {
  try {
    const session = env.ENGSYS_SESSION;
    const fleet = env.FLEET_ID || '';
    if (!session || !NAME.test(session) || (fleet && !NAME.test(fleet))) return null;
    const dir = sessionsDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${fleet ? `${fleet}.` : ''}${session}.handbacks.jsonl`);
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), run: env.ENGSYS_SESSION_RUN || null, agent_id: clean(input.agent_id, 80), agent_type: clean(input.agent_type || 'agent', 80), remains: clean(remains, 200) })}\n`, { mode: 0o600 });
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
  const input = JSON.parse(raw);
  if (process.env.ENGSYS_HANDBACK_DEBUG) { // opt-in: what the hook actually receives
    const { last_assistant_message: m, ...rest } = input;
    fs.appendFileSync(process.env.ENGSYS_HANDBACK_DEBUG, `${JSON.stringify({ mode, ...rest, last_assistant_message: String(m || '').slice(0, 160) })}\n`);
  }
  let reason = null;
  if (mode === 'subagent') {
    reason = subagentDecision(input);
    if (!reason) recordHandback(input); // only the final, allowed hand-back is recorded
  } else if (mode === 'stop') {
    reason = stopDecision(input);
  }
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2; // block: the reason goes back to the model, which keeps working
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => { process.exitCode = 0; });
}
