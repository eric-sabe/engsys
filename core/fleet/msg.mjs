#!/usr/bin/env node
// msg.mjs — `fleet msg`: send a cross-fleet message, and read a session's inbox (engsys#76, #77).
// Format and sender check: lib/fleet-msg.mjs. Delivery: relay.mjs. Design: docs/multi-fleet.md § 4.
//
//   fleet msg send --to <fleet>:<session> [--re owner/repo#n] --body-file <file> [--from <session>]
//       Posts a comment whose first line is the generated fleet-msg header, on the `re` PR or issue,
//       or on the target fleet's status issue (federation.yml fleets.<fleet>.status_issue, in the
//       instance repo) when there is no --re. The sender is <FLEET_ID>:<--from or ENGSYS_SESSION>.
//       The body is plain text; a body carrying a fleet-msg header of its own is refused.
//       Prints the comment URL.
//   fleet msg inbox <session> [--mark-read]
//       Prints the session's undelivered messages, one line each (the same line the relay types).
//       --mark-read marks them delivered.
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 same fleet (send: `--to` names this fleet, or there is no
// FLEET_ID; the caller uses SendMessage instead).
//
// Environment (msg.sh sets it from fleet-env.sh): FLEET_ID, FEDERATION_FILE, FLEET_STATE,
// FLEET_INSTANCE_REPO (optional), ENGSYS_SESSION (the calling session, for send).

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFederation, checkFleetId, instanceRepo as resolveInstanceRepo, SESSION_RE } from './lib/federation.mjs';
import { render, ADDRESS_RE, RE_RE, FleetMsgError } from './lib/fleet-msg.mjs';
import { readInbox, markDelivered, deliveryLine, SESSION_NAME_RE } from './lib/inbox.mjs';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, SAME_FLEET: 3 });
const USAGE = `usage: fleet msg send --to <fleet>:<session> [--re owner/repo#n] --body-file <file> [--from <session>]
       fleet msg inbox <session> [--mark-read]`;
const MAX_BODY = 60_000; // GitHub caps a comment at 65536 characters; leave room for the header

class UsageError extends Error {}

function parseFlags(argv, allowed) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}`);
    if (name === 'mark-read') { flags[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    if (name in flags) throw new UsageError(`--${name} given twice`);
    flags[name] = value;
  }
  return { flags, positional };
}

function postComment(repo, number, body) {
  const out = execFileSync('gh', ['api', '-X', 'POST', `/repos/${repo}/issues/${number}/comments`, '--input', '-'], {
    input: JSON.stringify({ body }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
  });
  return JSON.parse(out);
}

/** `fleet msg send`. Returns an exit code. */
export function send(argv, { env = process.env, out, err, post = postComment } = {}) {
  const { flags, positional } = parseFlags(argv, ['to', 're', 'body-file', 'from']);
  if (positional.length) throw new UsageError(`unexpected argument ${JSON.stringify(positional[0])}`);
  if (!flags.to) throw new UsageError('--to <fleet>:<session> is required');
  if (!flags['body-file']) throw new UsageError('--body-file <file> is required');

  const fleetId = checkFleetId(env.FLEET_ID);
  const bare = SESSION_RE.test(flags.to) && !flags.to.includes(':');
  const to = ADDRESS_RE.exec(flags.to);
  if (!to && !bare) { err.write(`fleet msg: --to must be <fleet>:<session>, got ${JSON.stringify(flags.to)}\n`); return EXIT.USAGE; }
  const toSession = to ? to[2] : flags.to;
  if (bare || !fleetId || to[1] === fleetId) {
    out.write(`same fleet: use SendMessage to ${toSession}\n`);
    return EXIT.SAME_FLEET;
  }
  if (flags.re !== undefined && !RE_RE.test(flags.re)) { err.write(`fleet msg: --re must be owner/repo#n, got ${JSON.stringify(flags.re)}\n`); return EXIT.USAGE; }
  const fromSession = flags.from ?? env.ENGSYS_SESSION ?? '';
  if (!SESSION_NAME_RE.test(fromSession)) {
    err.write('fleet msg: the sending session is unknown: pass --from <session> (sessions launched by the fleet have ENGSYS_SESSION)\n');
    return EXIT.USAGE;
  }

  let body;
  try {
    body = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    err.write(`fleet msg: cannot read ${flags['body-file']}: ${e.message}\n`);
    return EXIT.ERROR;
  }
  if (body.length > MAX_BODY) { err.write(`fleet msg: the body is ${body.length} characters; the limit is ${MAX_BODY}\n`); return EXIT.ERROR; }

  const file = env.FEDERATION_FILE;
  const reg = file ? loadFederation(file) : null;
  if (!reg) { err.write(`fleet msg: no federation file (${file || 'FEDERATION_FILE unset'}); cross-fleet messages need the registry\n`); return EXIT.ERROR; }
  const target = reg.fleets[to[1]];
  if (!target) { err.write(`fleet msg: fleet ${to[1]} is not declared in ${file}\n`); return EXIT.ERROR; }
  if (!target.enabled) { err.write(`fleet msg: fleet ${to[1]} is disabled in ${file}; its relay would not act on the message\n`); return EXIT.ERROR; }
  if (!reg.fleets[fleetId]) { err.write(`fleet msg: FLEET_ID ${fleetId} is not declared in ${file}\n`); return EXIT.ERROR; }
  let instance = null;
  try { instance = resolveInstanceRepo(file, env); } catch { instance = null; }

  let repo;
  let number;
  if (flags.re) {
    const m = RE_RE.exec(flags.re);
    [repo, number] = [m[1], Number(m[2])];
    const listed = Object.keys(reg.repos).some((r) => r.toLowerCase() === repo.toLowerCase());
    if (!listed && (!instance || instance.toLowerCase() !== repo.toLowerCase())) {
      err.write(`fleet msg: ${repo} is neither in ${file} repos nor the instance repo; the receiving relay would reject the message\n`);
      return EXIT.ERROR;
    }
  } else {
    if (!target.status_issue) { err.write(`fleet msg: fleets.${to[1]}.status_issue is not declared in ${file}; pass --re owner/repo#n\n`); return EXIT.ERROR; }
    if (!instance) { err.write('fleet msg: cannot tell the instance repo (set FLEET_INSTANCE_REPO=owner/name); pass --re owner/repo#n\n'); return EXIT.ERROR; }
    [repo, number] = [instance, target.status_issue];
  }

  let comment;
  try {
    comment = render({ to: flags.to, from: `${fleetId}:${fromSession}`, re: flags.re ?? null, body });
  } catch (e) {
    if (e instanceof FleetMsgError) { err.write(`fleet msg: ${e.message}\n`); return EXIT.ERROR; }
    throw e;
  }
  let res;
  try {
    res = post(repo, number, comment);
  } catch (e) {
    err.write(`fleet msg: posting on ${repo}#${number} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}\n`);
    return EXIT.ERROR;
  }
  out.write(`${typeof res?.html_url === 'string' ? res.html_url : `posted on ${repo}#${number}`}\n`);
  return EXIT.OK;
}

/** `fleet msg inbox`. Returns an exit code. */
export function inbox(argv, { env = process.env, out, err } = {}) {
  const { flags, positional } = parseFlags(argv, ['mark-read']);
  if (positional.length !== 1) throw new UsageError('fleet msg inbox takes one session name');
  const session = positional[0];
  if (!SESSION_NAME_RE.test(session)) { err.write(`fleet msg: not a session name: ${JSON.stringify(session)}\n`); return EXIT.USAGE; }
  if (!env.FLEET_STATE) { err.write('fleet msg: FLEET_STATE is not set\n'); return EXIT.ERROR; }
  const pending = readInbox(env.FLEET_STATE, session).filter((e) => e.delivered_at === null);
  if (!pending.length) { out.write(`no undelivered messages for ${session}\n`); return EXIT.OK; }
  for (const e of pending) out.write(`${deliveryLine(e)}\n`);
  if (flags['mark-read']) {
    const n = markDelivered(env.FLEET_STATE, session, pending.map((e) => e.id), { via: 'inbox' });
    out.write(`marked ${n} read\n`);
  }
  return EXIT.OK;
}

export function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'send') return send(rest, { env, out, err });
    if (cmd === 'inbox') return inbox(rest, { env, out, err });
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') { out.write(`${USAGE}\n`); return EXIT.OK; }
    err.write(`${USAGE}\n`);
    return EXIT.USAGE;
  } catch (e) {
    if (e instanceof UsageError) { err.write(`fleet msg: ${e.message}\n${USAGE}\n`); return EXIT.USAGE; }
    err.write(`fleet msg: ${e.message}\n`);
    return EXIT.ERROR;
  }
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = main(process.argv.slice(2));
