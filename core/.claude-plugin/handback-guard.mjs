#!/usr/bin/env node
// handback-guard.mjs — SubagentStop + Stop hooks for the engsys core PLUGIN.
//
// A finished subagent is never woken again by its own background work, and a session that ends
// its turn on an unfinished hand-back has nothing left to wake it. Prose ("never fire-and-forget")
// didn't hold, so this enforces it at the two points where the stall is created:
//
//   SubagentStop (mode `subagent`) — a subagent about to hand back:
//     • its final message says work is still pending ("will continue once…", "still running",
//       "waiting for…") and it didn't declare INCOMPLETE → block once: finish it now, or hand back
//       an explicit `STATUS: INCOMPLETE — <what remains>`.
//     • an engsys persona (agent_type `engsys:*`) without a `STATUS: COMPLETE|INCOMPLETE` line →
//       block once: add it.
//     • INCOMPLETE → allowed, and recorded for the parent session.
//   Stop (mode `stop`) — the main session about to end its turn:
//     • recorded INCOMPLETE hand-backs it hasn't been told about → block once, listing them: resume
//       the agent (SendMessage), take the work over, or arm a watchdog (subagent-liveness skill).
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

// Strong: a promise to act later. Overrides even an explicit `STATUS: COMPLETE`.
const STRONG = [
  /\b(?:still|currently)\s+(?:running|in progress|pending|executing|underway)\b/i,
  /\bwill\s+(?:continue|resume|carry on|pick (?:it|this|that) (?:back )?up|finish|follow up)\b[^.\n]{0,100}\b(?:once|when|after)\b/i,
  /\b(?:once|when|after)\s+(?:it|that|this|the\s+[\w\s#.-]{1,40}?)\s+(?:finishes|completes|is done|returns|lands|reports back)\b/i,
];
// Weak: suggests pending work; only counts when no explicit status was given.
const WEAK = [/\b(?:waiting|wait)\s+(?:on|for)\b/i, /\bin[- ]progress\b/i];
const STATUS = /^\s*[*_`]*STATUS[*_`]*\s*:\s*[*_`]*\s*(COMPLETE|INCOMPLETE)\b[*_`]*(.*)$/im;

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
 * Classify a final message → { status, pending, remains }:
 *   status  'COMPLETE' | 'INCOMPLETE' | null (no status line)
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
  return { status, pending, remains: stated || (pending ? pendingSentence(m) : '') };
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
  if (!c.status && /^engsys:/.test(String(input.agent_type || ''))) {
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
export function recordHandback(input) {
  const dir = stateDir(input.session_id);
  const f = path.join(dir, `${String(input.agent_id || 'agent').replace(/[^\w.-]/g, '_')}.json`);
  const c = classify(input.last_assistant_message);
  // INCOMPLETE — declared, or inferred when an agent handed back pending work anyway (after its nudge)
  if (c.status === 'INCOMPLETE' || (c.status !== 'COMPLETE' && c.pending)) {
    fs.writeFileSync(f, JSON.stringify({ agent_id: input.agent_id, agent_type: input.agent_type, remains: c.remains || '(unspecified)', surfaced: false, at: new Date().toISOString() }), { mode: 0o600 });
  } else {
    fs.rmSync(f, { force: true });
  }
}

/** Stop decision → reason string to block with (marks the listed hand-backs surfaced), or null. */
export function stopDecision(input) {
  if (input.stop_hook_active) return null;
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
