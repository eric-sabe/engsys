#!/usr/bin/env node
// notify.mjs — fleet notify: the fleet's own Slack voice, through a per-fleet bot token. Calm by
// default (info/action/alert, no sirens), one post per incident (thread + resolve), and a
// GitHub-issue-comment fallback when Slack is unreachable or unconfigured. Never fails the caller.
//
//   fleet notify --level info|action|alert [--for <fleet-id|github-login> | --author <github-login> | --everyone |
//                --no-mention] [--re <https-url>] [--incident <key>] [--resolve] [--require-delivery] "<text>"
//   fleet notify --resolve --incident <key>             (--level optional: the latch knows where it went)
//   fleet notify --sweep [--repo <owner/name>] [--apply]
//
// Routing (engsys#238, operator decision 2026-10-20: no channel ping; anything for one operator is a DM):
//   action / alert     a DM to THIS host's operator (federation.yml fleets.<FLEET_ID>.slack_operator, else
//                      SLACK_OPERATOR_ID): a problem on one host is that host's operator's.
//   --for <who>        a DM to that one operator instead: a fleet id, an operator's GitHub login or a fleet
//                      App's bot login, resolved through federation.yml.
//   --author <login>   a PR author: a fleet App's bot → a DM to that fleet's operator; a human or unknown
//                      author → this host's operator (merge-monster escalations on a PR).
//   --everyone         (alert only) a problem every operator should see: the escalation channel with no
//                      mention, plus a DM to every enabled fleet's `slack_operator`.
//   --no-mention       the channel, pinging nobody (a gate on a human-authored PR, whose GitHub request
//                      already mentions the operators team).
//   info               the channel, no mention, unless --for / --author.
// A recipient with no Slack id, or a DM Slack refuses, falls back, loudly, to the channel: the post
// mentions the intended recipient when their Slack id is known (else nobody) and says who it was for.
// Never @here, never a group: SLACK_OPERATORS_GROUP_ID is retired (no longer read; a SLACK_ENV that still
// sets it works).
//
// An incident latch stores where its first post went (the channel, or the DM channel) and any alert DM
// threads, so every reply and the --resolve reply land in those same threads.
//
// --sweep: resolve the latches whose pull request is already merged or closed (the `mm-gate-<id>` and
// `mm-<PR>` incidents a merge monster never resolved). The PR comes from the latch's --re link, else
// `mm-<N>` with --repo, else a search of --repo for the gate id. Dry run by default (prints what it
// would resolve); --apply posts each ✅ resolved reply and clears the latch. `mm-<N>` matches only when
// the latch's link is in --repo (a multi-repo host has one `mm-12` per repo).
//
// --require-delivery: exit 1 when the message reached neither Slack nor the fallback issue (for a caller
// whose next step depends on the alert going out, e.g. `fleet launch --skip-verify`). Without it, notify
// never fails the caller. The caller's text is escaped for Slack (&, <, >), so text that carries file
// names or other outside data can't turn into a link or a mention; a mention is only ever built from a
// validated Slack member id.
//
// Config (read from the process environment, set by notify.sh after sourcing fleet-env.sh):
//   SLACK_ENV               path to the bot's env file (SLACK_BOT_TOKEN, SLACK_CHANNEL_ID,
//                           optional SLACK_OPERATOR_ID, FLEET_ID). DMs need the bot scope im:write.
//   FLEET_ID                the fleet's id from fleet.conf (the registry identity). It wins over a
//                           FLEET_ID in SLACK_ENV, which is only needed when fleet.conf has none.
//                           Empty/missing/incomplete = Slack is "unconfigured" → fallback.
//   FEDERATION_FILE         the fleet registry (fleet-env.sh resolves it); missing = single-fleet mode.
//   NOTIFY_FALLBACK_ISSUE   owner/repo#N to comment on when Slack can't be reached. Empty = skip
//                           (print the message as a warning instead).
//   OPERATOR_TIMEZONE / OPERATOR_CLOCK
//                           the fleet's operator time format (fleet-env.sh derives them). When either is
//                           set, an ISO 8601 UTC timestamp in the text becomes Slack's date token
//                           (each reader sees their own zone and clock; the fallback text is this
//                           fleet's format) and a plain rendering in the GitHub fallback comment.
//   FLEET_STATE             the instance's state directory; incident latches live under
//                           $FLEET_STATE/notify/.
//
// The bot token is read from disk and used only as an in-process fetch() header — never passed on
// a command line, so it never appears in `ps`, and never printed, including in error output.
//
// Zero dependencies: node builtins only (global fetch, node >= 20.11, matches package.json engines), plus
// the kit's own registry loader (lib/federation.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { humanizeText, resolveSettings } from '../lib/operator-time.mjs';
import { fleetForBot, loadFederation, recipientFor, slackOperators } from './lib/federation.mjs';

const LEVELS = ['info', 'action', 'alert'];
const EMOJI = { info: 'ℹ️', action: '👋', alert: '⚠️' };
/** A Slack member id, as federation.mjs validates `slack_operator`. Nothing else becomes a mention. */
const SLACK_MEMBER_RE = /^[UW][A-Z0-9]{2,20}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** --re: an https URL with nothing Slack reads as markup (engsys#238: it reaches DMs unescaped). */
const RE_URL_RE = /^https:\/\/[^\s<>|`]{1,500}$/;

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

/** Parse argv (excluding node + script path) into {level, for, re, incident, resolve, sweep, text, ...}. */
export function parseArgs(argv) {
  const out = {
    level: null, for: null, author: null, everyone: false, noMention: false, re: null, incident: null, resolve: false, requireDelivery: false,
    sweep: false, apply: false, repo: null, textParts: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--level': out.level = argv[++i]; break;
      case '--for': out.for = argv[++i]; break;
      case '--author': out.author = argv[++i]; break;
      case '--everyone': out.everyone = true; break;
      case '--no-mention': out.noMention = true; break;
      case '--re': out.re = argv[++i]; break;
      case '--incident': out.incident = argv[++i]; break;
      case '--resolve': out.resolve = true; break;
      case '--require-delivery': out.requireDelivery = true; break;
      case '--sweep': out.sweep = true; break;
      case '--apply': out.apply = true; break;
      case '--repo': out.repo = argv[++i]; break;
      default: out.textParts.push(a);
    }
  }
  out.text = out.textParts.join(' ');
  delete out.textParts;
  return out;
}

/** Validate parsed args; throws a user-facing string on error, else returns nothing. */
export function validateArgs(args) {
  if (args.repo && !REPO_RE.test(args.repo)) throw `--repo must be owner/name (got '${args.repo}')`;
  if (args.sweep) {
    if (args.text || args.resolve || args.incident) throw '--sweep takes only --repo and --apply';
    return;
  }
  if (args.apply) throw '--apply goes with --sweep';
  if (!args.level && !args.resolve) throw '--level is required (info|action|alert)';
  if (args.level && !LEVELS.includes(args.level)) throw `--level must be one of info|action|alert (got '${args.level}')`;
  if (args.level === 'action' && !args.re && !args.resolve) throw "--level action requires --re <github-url>";
  if (args.re && !RE_URL_RE.test(args.re)) throw '--re must be an https URL with no spaces, <, >, | or backticks';
  if (args.for !== null && args.for !== undefined && !args.for) throw '--for needs a fleet id or GitHub login';
  if (args.author !== null && args.author !== undefined && !args.author) throw '--author needs a GitHub login';
  if (args.everyone && args.level !== 'alert') throw '--everyone goes with --level alert';
  if ([args.for, args.author, args.everyone, args.noMention].filter(Boolean).length > 1) throw 'use one of --for, --author, --everyone, --no-mention';
  if (args.resolve && !args.incident) throw '--resolve requires --incident <key>';
  if (!args.resolve && !args.text) throw 'a message is required (unless --resolve)';
}

/** Filesystem-safe name for an incident key. */
export function incidentSlug(key) {
  return String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** `<@U…>` for a valid Slack member id, else '' (a malformed id never turns into markup). */
export function slackMention(id) {
  return typeof id === 'string' && SLACK_MEMBER_RE.test(id) ? `<@${id}>` : '';
}

/** This host's operator: its fleet's `slack_operator` in the registry, else SLACK_OPERATOR_ID. */
export function hostOperator(cfg = {}, reg = null) {
  const fromReg = reg?.fleets?.[cfg.FLEET_ID]?.slack_operator;
  return slackMention(fromReg) ? fromReg : slackMention(cfg.SLACK_OPERATOR_ID) ? cfg.SLACK_OPERATOR_ID : null;
}

/**
 * Where a first post goes (engsys#238). Returns { channel: { mention } | null, dms: [member id],
 * meantFor, warning }: `channel` is the escalation-channel post, `dms` the operators to DM. A one-person
 * route also carries `label` (who it is for) and `fallbackMention` (their mention, used if Slack refuses
 * the DM). `meantFor` is set when the recipient could not be DMed, so the channel post says who it was for.
 */
export function planRoute({ level, forWho = null, author = null, everyone = false, noMention = false, cfg = {}, reg = null }) {
  const one = (id, label) => ({ channel: null, dms: [id], meantFor: null, label, fallbackMention: slackMention(id), warning: '' });
  const toChannel = (label, why) => ({ channel: { mention: '' }, dms: [], meantFor: label, warning: `${label}: ${why}; posting to the channel instead of a DM` });
  if (everyone) {
    const ops = slackOperators(reg);
    const host = hostOperator(cfg, reg);
    return { channel: { mention: '' }, dms: ops.length ? ops : host ? [host] : [], meantFor: null, warning: '' };
  }
  if (noMention || (level === 'info' && !forWho && !author)) return { channel: { mention: '' }, dms: [], meantFor: null, warning: '' };
  if (forWho) {
    const r = recipientFor(reg, forWho);
    if (r && slackMention(r.slack_operator)) return one(r.slack_operator, forWho);
    return toChannel(forWho, !reg ? 'no fleet registry (FEDERATION_FILE)' : !r ? 'not in the fleet registry' : `fleet ${r.fleet} has no slack_operator`);
  }
  const owner = author ? fleetForBot(reg, author) : null;
  if (owner) {
    if (slackMention(owner.slack_operator)) return one(owner.slack_operator, `the operator of fleet ${owner.fleet}`);
    return toChannel(`the operator of fleet ${owner.fleet}${owner.operator ? ` (${owner.operator})` : ''}`, 'no slack_operator');
  }
  const host = hostOperator(cfg, reg);
  if (host) return one(host, "this host's operator");
  return toChannel("this host's operator", `no Slack id (fleets.${cfg.FLEET_ID || '<FLEET_ID>'}.slack_operator or SLACK_OPERATOR_ID)`);
}

/** Slack's control characters in plain text: & < > (https://api.slack.com/reference/surfaces/formatting#escaping). */
export function escapeSlack(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Compose the posted text: fleet prefix, emoji, optional mention (first post of an incident
 * only), the caller's text, a "meant for" line when a DM fell back to the channel, and — for
 * `action`, or any level that was given --re — a GitHub link line that never asks for a Slack reply. */
export function composeText({ level, text, re, fleetId, mention, meantFor = null }) {
  const head = `${fleetId ? `[${fleetId}] ` : ''}${EMOJI[level]}${mention ? ` ${mention}` : ''}`;
  let body = text ? `${head} ${escapeSlack(text)}` : head;
  if (meantFor) body = `${body}\n\n(Meant as a DM for ${escapeSlack(meantFor)}, who could not be reached that way; posted here instead.)`;
  if (re) {
    const line = level === 'action' ? `Approve or act on GitHub: ${re}` : `GitHub: ${re}`;
    body = `${body}\n\n${line}`;
  }
  return body;
}

/** The fleet id posts carry: fleet.conf's FLEET_ID (the registry identity) when set, else the one in
 * SLACK_ENV. A disagreement is reported so the stale copy gets fixed. */
export function resolveFleetId(cfg, env = process.env) {
  const conf = env.FLEET_ID || '';
  const slack = cfg.FLEET_ID || '';
  const warning = conf && slack && conf !== slack
    ? `FLEET_ID in SLACK_ENV (${slack}) differs from fleet.conf (${conf}); using ${conf}`
    : '';
  return { fleetId: conf || slack, warning };
}

/** Which required Slack config keys are missing (config is "unconfigured" if any are). */
export function missingSlackConfig(cfg) {
  // The operator and FLEET_ID are optional: routing degrades (see planRoute) and the fleet id also
  // comes from the environment.
  return ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'].filter((k) => !cfg[k]);
}

/** The pull request a latch is about, { repo, number } or null: its --re link when that is a PR on
 * GitHub, else an `mm-<N>` key whose link is in `repo` (a multi-repo host has one `mm-12` per repo, so
 * a latch with no link, or a link elsewhere, never matches). `mm-gate-<id>` is searched by the sweep. */
export function latchPr(key, latch, repo = null) {
  const re = typeof latch?.re === 'string' ? latch.re : '';
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s#?]+)\/pull\/([1-9][0-9]*)(?:[/?#]|$)/.exec(re);
  if (m && REPO_RE.test(m[1])) return { repo: m[1], number: Number(m[2]) };
  const k = /^mm-([1-9][0-9]*)$/.exec(key);
  const linkRepo = /^https:\/\/github\.com\/([^/\s]+\/[^/\s#?]+)(?:[/?#]|$)/.exec(re)?.[1];
  return k && repo && linkRepo === repo ? { repo, number: Number(k[1]) } : null;
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

function listIncidents(stateDir) {
  try {
    return fs.readdirSync(path.join(stateDir, 'notify')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

// --- Slack ---------------------------------------------------------------------------------------

const DEFAULT_SLACK_API = 'https://slack.com/api';

/** Slack API base URL, overridable via SLACK_API_URL (tests only — never set on a real fleet). */
export function apiBase(env = process.env) {
  return (env.SLACK_API_URL || DEFAULT_SLACK_API).replace(/\/+$/, '');
}

async function slackCall(token, method, payload) {
  const res = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error || `slack http ${res.status}`);
  return body;
}

async function postSlack({ token, channel, text, threadTs }) {
  return slackCall(token, 'chat.postMessage', { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }); // { ok, ts, ... }
}

/** Open (or reuse) the bot's DM with a member and post there; returns { channel, ts }. Needs im:write. */
async function postDm({ token, user, text }) {
  const open = await slackCall(token, 'conversations.open', { users: user });
  const channel = open?.channel?.id;
  if (!channel) throw new Error('conversations.open returned no channel');
  const res = await postSlack({ token, channel, text });
  return { channel, ts: res.ts };
}

// --- fallback --------------------------------------------------------------------------------

function fallback(message, fallbackIssue) { // → true when the comment was posted
  if (!fallbackIssue) {
    process.stderr.write(`fleet notify: Slack unavailable, no NOTIFY_FALLBACK_ISSUE configured — message was:\n${message}\n`);
    return false;
  }
  const m = fallbackIssue.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!m) {
    process.stderr.write(`fleet notify: NOTIFY_FALLBACK_ISSUE is malformed ('${fallbackIssue}', want owner/repo#N) — message was:\n${message}\n`);
    return false;
  }
  const [, repo, number] = m;
  try {
    execFileSync('gh', ['issue', 'comment', number, '-R', repo, '--body', message], { stdio: ['ignore', 'ignore', 'pipe'] });
    process.stderr.write(`fleet notify: Slack unavailable — fell back to a comment on ${fallbackIssue}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`fleet notify: Slack unavailable AND the fallback comment on ${fallbackIssue} failed (${e.message}) — message was:\n${message}\n`);
    return false;
  }
}

// --- main ------------------------------------------------------------------------------------

const warn = (m) => process.stderr.write(`fleet notify: ${m}\n`);

/** SLACK_ENV → { cfg, unconfiguredReason }; cfg.FLEET_ID resolved (fleet.conf wins). */
function loadSlackConfig() {
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
      const { fleetId, warning } = resolveFleetId(cfg);
      if (warning) warn(warning);
      cfg.FLEET_ID = fleetId;
      const missing = missingSlackConfig(cfg);
      if (missing.length) unconfiguredReason = `SLACK_ENV is missing ${missing.join(', ')}`;
    }
  }
  // Unconfigured Slack still prefixes the fallback comment with fleet.conf's id.
  if (!cfg.FLEET_ID && process.env.FLEET_ID) cfg.FLEET_ID = process.env.FLEET_ID;
  return { cfg, unconfiguredReason };
}

/** The registry, or null in single-fleet mode; an unreadable registry warns and routes as single-fleet. */
function loadRegistry() {
  const file = process.env.FEDERATION_FILE;
  if (!file) return null;
  try {
    return loadFederation(file);
  } catch (e) {
    warn(`the fleet registry could not be read (${String(e.message).split('\n')[0]}); routing without it`);
    return null;
  }
}

/**
 * Post a first message along `route`. Returns { latch, delivered } where latch = { channel, ts, dms }
 * describes the threads it opened. Throws when nothing reached Slack (the caller falls back to GitHub).
 */
async function postFirst({ token, cfg, route, compose }) {
  let latch = null;
  const dms = [];
  for (const user of route.dms) {
    try {
      const r = await postDm({ token, user, text: compose('') });
      if (!route.channel && !latch) latch = { channel: r.channel, ts: r.ts };
      else dms.push(r);
    } catch (e) {
      warn(`DM to ${user} failed (${e.message})`);
      if (!route.channel) {
        // The one recipient's DM failed: fall back, loudly, to the channel (engsys#238).
        warn('posting to the channel instead of the DM');
        route = { ...route, channel: { mention: route.fallbackMention || '' }, meantFor: route.label || user };
      }
    }
  }
  if (route.channel) {
    const res = await postSlack({ token, channel: cfg.SLACK_CHANNEL_ID, text: compose(route.channel.mention, route.meantFor) });
    latch = { channel: cfg.SLACK_CHANNEL_ID, ts: res.ts };
  }
  if (!latch) throw new Error('no Slack destination accepted the post');
  return { ...latch, ...(dms.length ? { dms } : {}) };
}

/** Reply in every thread a latch holds (its first post, then each alert DM). Throws if the first fails. */
async function postReplies({ token, cfg, latch, text }) {
  await postSlack({ token, channel: latch.channel || cfg.SLACK_CHANNEL_ID, text, threadTs: latch.ts });
  for (const dm of latch.dms || []) {
    try { await postSlack({ token, channel: dm.channel, text, threadTs: dm.ts }); } catch (e) { warn(`reply in the DM thread ${dm.channel} failed (${e.message})`); }
  }
}

/** Resolve one open incident: one ✅ resolved reply in each of its threads, then clear the latch.
 * Returns true when resolved; on a Slack failure falls back to GitHub and keeps the latch. */
async function resolveIncident({ stateDir, key, latch, cfg, unconfiguredReason, fallbackIssue, why = '' }) {
  const text = '✅ resolved';
  if (unconfiguredReason) {
    // No Slack thread to reply in: say which incident on the fallback issue, and drop the latch so a
    // re-run (or the next sweep) does not repeat it.
    warn(`${unconfiguredReason} — Slack not posted`);
    const prefix = cfg.FLEET_ID ? `[${cfg.FLEET_ID}] ` : '';
    fallback(`${prefix}${text}: ${key}${why ? ` (${why})` : ''}`, fallbackIssue);
    clearIncident(stateDir, key);
    return true;
  }
  try {
    await postReplies({ token: cfg.SLACK_BOT_TOKEN, cfg, latch, text });
    clearIncident(stateDir, key);
    return true;
  } catch (e) {
    warn(`Slack API call failed (${e.message}) — Slack not posted`);
    fallback(text, fallbackIssue);
    return false;
  }
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** The PR a latch is about, searching `repo` for an `mm-gate-<id>` key's gate id when the latch has no link. */
function sweepTarget(key, latch, repo) {
  const pr = latchPr(key, latch, repo);
  if (pr) return { pr };
  if (/^mm-[1-9][0-9]*$/.test(key)) return { skip: repo ? `its link is not in ${repo}, so the PR is ambiguous` : 'pass --repo to match it' };
  const g = /^mm-gate-([a-z0-9][a-z0-9-]{0,78}[a-z0-9])$/.exec(key);
  if (!g) return { skip: 'not tied to a pull request' };
  if (!repo) return { skip: 'gate latch without a link: pass --repo to search for it' };
  const res = ghJson(['api', '-X', 'GET', 'search/issues', '-f', `q="${g[1]}" repo:${repo} is:pr in:comments`, '--jq', '{n: [.items[].number]}']);
  if (res.n.length !== 1) return { skip: `search for gate ${g[1]} in ${repo} found ${res.n.length} pull requests` };
  return { pr: { repo, number: res.n[0] } };
}

async function sweep(args, stateDir) {
  const keys = listIncidents(stateDir);
  const { cfg, unconfiguredReason } = loadSlackConfig();
  const fallbackIssue = process.env.NOTIFY_FALLBACK_ISSUE || '';
  const counts = { resolved: 0, would: 0, open: 0, skipped: 0 };
  for (const key of keys) {
    const latch = readIncident(stateDir, key);
    let t;
    try {
      t = sweepTarget(key, latch, args.repo);
    } catch (e) {
      t = { skip: `GitHub search failed (${e.message.split('\n')[0]})` };
    }
    if (t.skip) { counts.skipped += 1; process.stdout.write(`skip     ${key}: ${t.skip}\n`); continue; }
    const { repo, number } = t.pr;
    let st;
    try {
      st = ghJson(['api', `repos/${repo}/issues/${number}`, '--jq', '{state: .state, pr: (.pull_request != null), merged: (.pull_request.merged_at != null)}']);
    } catch (e) {
      counts.skipped += 1;
      process.stdout.write(`skip     ${key}: cannot read ${repo}#${number} (${e.message.split('\n')[0]})\n`);
      continue;
    }
    if (!st.pr) { counts.skipped += 1; process.stdout.write(`skip     ${key}: ${repo}#${number} is not a pull request\n`); continue; }
    if (st.state !== 'closed') { counts.open += 1; process.stdout.write(`open     ${key}: ${repo}#${number} is still open\n`); continue; }
    const why = `${repo}#${number} ${st.merged ? 'merged' : 'closed'}`;
    if (!args.apply) { counts.would += 1; process.stdout.write(`would    ${key}: ${why}\n`); continue; }
    if (await resolveIncident({ stateDir, key, latch, cfg, unconfiguredReason, fallbackIssue, why })) {
      counts.resolved += 1;
      process.stdout.write(`resolved ${key}: ${why}\n`);
    } else {
      counts.skipped += 1;
      process.stdout.write(`failed   ${key}: ${why}; latch kept\n`);
    }
  }
  const tail = args.apply ? `${counts.resolved} resolved` : `${counts.would} would be resolved (dry run; --apply to resolve)`;
  process.stdout.write(`sweep: ${keys.length} open latches, ${tail}, ${counts.open} still open, ${counts.skipped} skipped\n`);
}

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
  if (args.sweep) { await sweep(args, stateDir); return; }
  const fallbackIssue = process.env.NOTIFY_FALLBACK_ISSUE || '';

  // --resolve with no open incident is a no-op (idempotent: nothing to resolve, never an error).
  const incident = args.incident ? readIncident(stateDir, args.incident) : null;
  if (args.resolve && !incident) {
    warn(`--resolve ${args.incident} — no open incident, nothing to do`);
    process.exit(0);
    return;
  }

  const { cfg, unconfiguredReason } = loadSlackConfig();
  for (const w of resolveSettings(process.env).warnings) warn(w);

  if (args.resolve) {
    await resolveIncident({ stateDir, key: args.incident, latch: incident, cfg, unconfiguredReason, fallbackIssue });
    process.exit(0);
    return;
  }

  // cfg.FLEET_ID is already resolved: fleet.conf's FLEET_ID wins, else the Slack env file's.
  const fleetId = cfg.FLEET_ID || '';
  const compose = (mention, meantFor = null) => composeText({ level: args.level, text: args.text, re: args.re, fleetId, mention, meantFor });
  const slack = (t) => humanizeText(t, process.env, { slack: true });
  const plainText = humanizeText(compose(''), process.env); // Slack mention syntax means nothing in a GitHub comment

  if (unconfiguredReason) {
    warn(`${unconfiguredReason} — Slack not posted`);
    const delivered = fallback(plainText, fallbackIssue);
    process.exit(args.requireDelivery && !delivered ? 1 : 0);
  }

  try {
    const token = cfg.SLACK_BOT_TOKEN;
    if (incident) {
      // A later post in an open incident: reply in its threads, no re-mention, wherever it first went.
      await postReplies({ token, cfg, latch: incident, text: slack(compose('')) });
      writeIncident(stateDir, args.incident, { ...incident, level: args.level });
      return;
    }
    // Mention once per incident (or on every post outside one); the routing is decided only here.
    const route = planRoute({
      level: args.level, forWho: args.for, author: args.author, everyone: args.everyone, noMention: args.noMention, cfg, reg: loadRegistry(),
    });
    if (route.warning) warn(route.warning);
    const latch = await postFirst({ token, cfg, route, compose: (m, meant) => slack(compose(m, meant)) });
    if (args.incident) {
      writeIncident(stateDir, args.incident, { ...latch, level: args.level, incident: args.incident, ...(args.re ? { re: args.re } : {}) });
    }
  } catch (e) {
    warn(`Slack API call failed (${e.message}) — Slack not posted`);
    const delivered = fallback(plainText, fallbackIssue);
    process.exit(args.requireDelivery && !delivered ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
