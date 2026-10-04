#!/usr/bin/env node
// notify.mjs — fleet notify: the fleet's own Slack voice, through a per-fleet bot token. Calm by
// default (info/action/alert, no sirens), one post per incident (thread + resolve), and a
// GitHub-issue-comment fallback when Slack is unreachable or unconfigured. Never fails the caller.
//
//   fleet notify --level info|action|alert [--re <github-url>] [--incident <key>] [--resolve] "<text>"
//
// Config (read from the process environment, set by notify.sh after sourcing fleet-env.sh):
//   SLACK_ENV               path to the bot's env file (SLACK_BOT_TOKEN, SLACK_CHANNEL_ID,
//                           SLACK_OPERATORS_GROUP_ID, optional SLACK_OPERATOR_ID, FLEET_ID).
//                           Empty/missing/incomplete = Slack is "unconfigured" → fallback.
//   NOTIFY_FALLBACK_ISSUE   owner/repo#N to comment on when Slack can't be reached. Empty = skip
//                           (print the message as a warning instead).
//   FLEET_STATE             the instance's state directory; incident latches live under
//                           $FLEET_STATE/notify/.
//
// The bot token is read from disk and used only as an in-process fetch() header — never passed on
// a command line, so it never appears in `ps`, and never printed, including in error output.
//
// Zero dependencies: node builtins only (global fetch, node >= 20.11, matches package.json engines).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LEVELS = ['info', 'action', 'alert'];
const EMOJI = { info: 'ℹ️', action: '👋', alert: '⚠️' };

function die(msg, code = 2) {
  process.stderr.write(`fleet notify: ${msg}\n`);
  process.exit(code);
}

// --- pure helpers (exported for tests) ----------------------------------------------------------

/** Parse KEY=VALUE lines (optional `export `, `#` comments, one layer of surrounding quotes). */
export function parseEnvFile(text) {
  const cfg = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    cfg[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return cfg;
}

/** Parse argv (excluding node + script path) into {level, re, incident, resolve, text}. */
export function parseArgs(argv) {
  const out = { level: null, re: null, incident: null, resolve: false, textParts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--level': out.level = argv[++i]; break;
      case '--re': out.re = argv[++i]; break;
      case '--incident': out.incident = argv[++i]; break;
      case '--resolve': out.resolve = true; break;
      default: out.textParts.push(a);
    }
  }
  out.text = out.textParts.join(' ');
  delete out.textParts;
  return out;
}

/** Validate parsed args; throws a user-facing string on error, else returns nothing. */
export function validateArgs(args) {
  if (!args.level) throw '--level is required (info|action|alert)';
  if (!LEVELS.includes(args.level)) throw `--level must be one of info|action|alert (got '${args.level}')`;
  if (args.level === 'action' && !args.re) throw "--level action requires --re <github-url>";
  if (args.resolve && !args.incident) throw '--resolve requires --incident <key>';
  if (!args.resolve && !args.text) throw 'a message is required (unless --resolve)';
}

/** Filesystem-safe name for an incident key. */
export function incidentSlug(key) {
  return String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Build the Slack mention for a level. action prefers the named operator; alert always mentions
 * the group. info never mentions anyone. Returns '' when nothing should be mentioned. */
export function mentionFor(level, cfg) {
  if (level === 'info') return '';
  if (level === 'action') {
    if (cfg.SLACK_OPERATOR_ID) return `<@${cfg.SLACK_OPERATOR_ID}>`;
    return `<!subteam^${cfg.SLACK_OPERATORS_GROUP_ID}>`;
  }
  // alert
  return `<!subteam^${cfg.SLACK_OPERATORS_GROUP_ID}>`;
}

/** Compose the posted text: fleet prefix, emoji, optional mention (first post of an incident
 * only), the caller's text, and — for `action`, or any level that was given --re — a GitHub link
 * line that never asks for a Slack reply. */
export function composeText({ level, text, re, fleetId, mention }) {
  const head = `${fleetId ? `[${fleetId}] ` : ''}${EMOJI[level]}${mention ? ` ${mention}` : ''}`;
  let body = text ? `${head} ${text}` : head;
  if (re) {
    const line = level === 'action' ? `Approve or act on GitHub: ${re}` : `GitHub: ${re}`;
    body = `${body}\n\n${line}`;
  }
  return body;
}

/** Which required Slack config keys are missing (config is "unconfigured" if any are). */
export function missingSlackConfig(cfg) {
  return ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'SLACK_OPERATORS_GROUP_ID', 'FLEET_ID'].filter((k) => !cfg[k]);
}

// --- incident state (one JSON file per incident key under $FLEET_STATE/notify/) ------------------

function statePath(stateDir, incident) {
  return path.join(stateDir, 'notify', `${incidentSlug(incident)}.json`);
}

function readIncident(stateDir, incident) {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir, incident), 'utf8'));
  } catch {
    return null;
  }
}

function writeIncident(stateDir, incident, data) {
  const p = statePath(stateDir, incident);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
}

function clearIncident(stateDir, incident) {
  try { fs.unlinkSync(statePath(stateDir, incident)); } catch { /* already gone */ }
}

// --- Slack ---------------------------------------------------------------------------------------

const DEFAULT_SLACK_API = 'https://slack.com/api';

/** Slack API base URL, overridable via SLACK_API_URL (tests only — never set on a real fleet). */
export function apiBase(env = process.env) {
  return (env.SLACK_API_URL || DEFAULT_SLACK_API).replace(/\/+$/, '');
}

async function postSlack({ token, channel, text, threadTs }) {
  const res = await fetch(`${apiBase()}/chat.postMessage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error || `slack http ${res.status}`);
  return body; // { ok, ts, ... }
}

// --- fallback --------------------------------------------------------------------------------

function fallback(message, fallbackIssue) {
  if (!fallbackIssue) {
    process.stderr.write(`fleet notify: Slack unavailable, no NOTIFY_FALLBACK_ISSUE configured — message was:\n${message}\n`);
    return;
  }
  const m = fallbackIssue.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!m) {
    process.stderr.write(`fleet notify: NOTIFY_FALLBACK_ISSUE is malformed ('${fallbackIssue}', want owner/repo#N) — message was:\n${message}\n`);
    return;
  }
  const [, repo, number] = m;
  try {
    execFileSync('gh', ['issue', 'comment', number, '-R', repo, '--body', message], { stdio: ['ignore', 'ignore', 'pipe'] });
    process.stderr.write(`fleet notify: Slack unavailable — fell back to a comment on ${fallbackIssue}\n`);
  } catch (e) {
    process.stderr.write(`fleet notify: Slack unavailable AND the fallback comment on ${fallbackIssue} failed (${e.message}) — message was:\n${message}\n`);
  }
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    validateArgs(args);
  } catch (e) {
    die(e);
    return;
  }

  const stateDir = process.env.FLEET_STATE;
  if (!stateDir) { die('FLEET_STATE is not set (run via `fleet notify`, not notify.mjs directly)', 1); return; }
  const fallbackIssue = process.env.NOTIFY_FALLBACK_ISSUE || '';

  // --resolve with no open incident is a no-op (idempotent: nothing to resolve, never an error).
  if (args.resolve) {
    const existing = readIncident(stateDir, args.incident);
    if (!existing) {
      process.stderr.write(`fleet notify: --resolve ${args.incident} — no open incident, nothing to do\n`);
      process.exit(0);
      return;
    }
  }

  const slackEnvPath = process.env.SLACK_ENV || '';
  let cfg = {};
  let unconfiguredReason = '';
  if (!slackEnvPath) {
    unconfiguredReason = 'SLACK_ENV is not set';
  } else {
    let raw;
    try {
      raw = fs.readFileSync(slackEnvPath, 'utf8');
    } catch {
      unconfiguredReason = `SLACK_ENV (${slackEnvPath}) could not be read`;
    }
    if (raw !== undefined) {
      cfg = parseEnvFile(raw);
      const missing = missingSlackConfig(cfg);
      if (missing.length) unconfiguredReason = `SLACK_ENV is missing ${missing.join(', ')}`;
    }
  }

  const incident = args.incident ? readIncident(stateDir, args.incident) : null;
  const isFirstPost = !!args.incident && !incident;
  // Slack mention syntax means nothing in a GitHub fallback comment, so mention only when posting to Slack.
  const mention = (args.resolve || unconfiguredReason) ? '' : (isFirstPost || !args.incident) ? mentionFor(args.level, cfg) : '';
  // FLEET_ID: the Slack env file when configured, else the fleet's own environment (fleet.conf / session env).
  const fleetId = cfg.FLEET_ID || process.env.FLEET_ID || '';
  const text = args.resolve ? '✅ resolved' : composeText({
    level: args.level, text: args.text, re: args.re, fleetId, mention,
  });

  if (unconfiguredReason) {
    process.stderr.write(`fleet notify: ${unconfiguredReason} — Slack not posted\n`);
    fallback(text, fallbackIssue);
    process.exit(0);
  }

  try {
    const result = await postSlack({
      token: cfg.SLACK_BOT_TOKEN,
      channel: cfg.SLACK_CHANNEL_ID,
      text,
      threadTs: incident ? incident.ts : undefined,
    });
    if (args.resolve) {
      clearIncident(stateDir, args.incident);
    } else if (args.incident) {
      writeIncident(stateDir, args.incident, {
        ts: incident ? incident.ts : result.ts,
        level: args.level,
        channel: cfg.SLACK_CHANNEL_ID,
      });
    }
  } catch (e) {
    process.stderr.write(`fleet notify: Slack API call failed (${e.message}) — Slack not posted\n`);
    fallback(text, fallbackIssue);
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
