#!/usr/bin/env node
// session-transcript.mjs — SessionStart hook for the engsys core PLUGIN (engsys#125).
//
// A monster's heartbeat asks how full its context is, so a session past `rotate_context_tokens` with
// nothing in flight can ask the fleet supervisor to rotate it. The heartbeat runs as a Bash child of the
// session and cannot see which transcript is its own; the SessionStart input can. So on every session
// start (startup, resume, clear, compact: a /clear starts a new transcript) this records
//
//   <sessions dir>/[<FLEET_ID>.]<ENGSYS_SESSION>.json  {session, fleet, run, session_id, transcript_path, source, at}
//
// for every session the fleet launcher started (ENGSYS_SESSION set), which includes every singleton
// monster. The broker is a monster the launcher does not give ENGSYS_SINGLETON_ROLE (it arms no write
// guard), so the record keys on the session name, not the role. The sessions dir is ENGSYS_SESSIONS_DIR,
// else $XDG_STATE_HOME/engsys/sessions, else ~/.local/state/engsys/sessions; core/lib/monster.sh reads it.
//
// The record is a pointer only (no transcript content), written 0600 in a 0700 dir by rename. Silent:
// it never injects context. Fail-open: any error -> no output, exit 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordHookTelemetry } from '../lib/harness-io.mjs';

const NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function sessionsDir(env = process.env) {
  if (env.ENGSYS_SESSIONS_DIR) return env.ENGSYS_SESSIONS_DIR;
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(base, 'engsys', 'sessions');
}

/** Record the session's transcript. -> the record's path, or null when there is nothing to record. */
export function record(input, env = process.env, now = () => new Date()) {
  const session = env.ENGSYS_SESSION;
  const fleet = env.FLEET_ID || '';
  if (!session || !NAME.test(session) || (fleet && !NAME.test(fleet))) return null;
  const t = input && (input.transcript_path || input.transcriptPath);
  if (typeof t !== 'string' || !path.isAbsolute(t) || t.includes('\n')) return null;
  const dir = sessionsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${fleet ? `${fleet}.` : ''}${session}.json`);
  const sid = input.session_id ?? input.sessionId;
  const rec = {
    session,
    fleet: fleet || null,
    run: env.ENGSYS_SESSION_RUN || null,
    session_id: typeof sid === 'string' ? sid : null,
    transcript_path: t,
    source: typeof input.source === 'string' ? input.source : null,
    at: now().toISOString(),
  };
  const payload = `${JSON.stringify(rec)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, file);
  recordHookTelemetry({
    hook: 'session-transcript',
    event: 'SessionStart',
    decision: 'record',
    bytes: Buffer.byteLength(payload, 'utf8'),
    detail: path.basename(file),
  }, env);
  return file;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  record(JSON.parse(raw));
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}
