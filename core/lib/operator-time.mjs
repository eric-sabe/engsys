#!/usr/bin/env node
// operator-time.mjs — how dates and times read to a person, per fleet: a time zone plus a 12-hour or
// 24-hour clock. Everything a machine reads (heartbeat `last:` lines, baton expiry, ledger markers,
// logs, --json) stays ISO 8601 UTC; callers use this only for text a human reads.
//
//   node operator-time.mjs <iso|epoch|now> [--date|--time|--relative] [--tz <IANA>] [--clock 12h|24h]
//   node operator-time.mjs context-line      the one-line instruction sessions get (empty when unset)
//   node operator-time.mjs humanize          stdin -> stdout, ISO UTC timestamps rewritten (unchanged when unset)
//
// Settings come from OPERATOR_TIMEZONE / OPERATOR_CLOCK in the environment. fleet-env.sh derives them:
// from federation.yml `fleets.<FLEET_ID>.timezone` / `.clock` in multi-fleet mode, else from the same
// two keys in fleet.conf. Default: UTC, 24h. An invalid zone falls back to UTC with a warning.
//
// Output shapes:  `Oct 5, 3:44 PM EDT` (12h)   `5 Oct 15:44 CEST` (24h)
// Intl.DateTimeFormat only; zero dependencies.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_CLOCK = '24h';
export const CLOCKS = ['12h', '24h'];

/** True when `tz` is an IANA zone name this runtime knows. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '' || tz.trim() !== tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when the environment carries any operator time setting. */
export function isConfigured(env = process.env) {
  return Boolean((env.OPERATOR_TIMEZONE || '').trim() || (env.OPERATOR_CLOCK || '').trim());
}

/**
 * The effective settings: {timezone, clock, configured, warnings}. Invalid values fall back to the
 * defaults and are reported in `warnings` (never thrown).
 */
export function resolveSettings(env = process.env) {
  const warnings = [];
  const tz = (env.OPERATOR_TIMEZONE || '').trim();
  const clk = (env.OPERATOR_CLOCK || '').trim();
  let timezone = DEFAULT_TIMEZONE;
  let clock = DEFAULT_CLOCK;
  if (tz) {
    if (isValidTimeZone(tz)) timezone = tz;
    else warnings.push(`OPERATOR_TIMEZONE '${tz}' is not an IANA time zone; using ${DEFAULT_TIMEZONE}`);
  }
  if (clk) {
    if (CLOCKS.includes(clk)) clock = clk;
    else warnings.push(`OPERATOR_CLOCK '${clk}' must be 12h or 24h; using ${DEFAULT_CLOCK}`);
  }
  return { timezone, clock, configured: Boolean(tz || clk), warnings };
}

/**
 * Turn an ISO string, epoch seconds (or milliseconds, 13+ digits), a Date, or `now` into a Date.
 * Throws a TypeError on anything unparseable.
 */
export function parseInstant(input, now = new Date()) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new TypeError('invalid date');
    return input;
  }
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') throw new TypeError(`cannot read a time from ${typeof input}`);
  const s = input.trim();
  if (s === 'now') return new Date(now);
  let d;
  if (/^\d{1,12}(\.\d+)?$/.test(s)) d = new Date(Number(s) * 1000);
  else if (/^\d{13,16}$/.test(s)) d = new Date(Number(s));
  else if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    // A bare date or a timestamp with no offset is read as UTC, like every machine field in the kit.
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
    d = new Date(hasZone ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}${s.includes('T') || s.includes(' ') ? '' : 'T00:00'}Z`);
  } else throw new TypeError(`cannot read a time from ${JSON.stringify(s)} (want ISO 8601, epoch seconds, or now)`);
  if (Number.isNaN(d.getTime())) throw new TypeError(`cannot read a time from ${JSON.stringify(s)}`);
  return d;
}

function parts(date, opts) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', opts).formatToParts(date)) out[p.type] = p.value;
  return out;
}

// en-US knows EDT/PST but spells Berlin `GMT+2`; en-GB knows CEST/BST. Try both, keep a real abbreviation.
function zoneName(date, timeZone) {
  let fallback = '';
  for (const locale of ['en-US', 'en-GB']) {
    const n = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value;
    if (!n) continue;
    if (!/^GMT[+-]/.test(n) || timeZone === 'UTC') return n;
    fallback ||= n;
  }
  return fallback || timeZone;
}

/** `Oct 5` / `5 Oct`, plus the year when it is not the current one. */
function datePart(date, { timezone, clock }, now) {
  const p = parts(date, { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' });
  const sameYear = parts(now, { timeZone: timezone, year: 'numeric' }).year === p.year;
  const md = clock === '12h' ? `${p.month} ${p.day}` : `${p.day} ${p.month}`;
  if (sameYear) return md;
  return clock === '12h' ? `${md}, ${p.year}` : `${md} ${p.year}`;
}

/** `3:44 PM` / `15:44`, then the zone abbreviation. */
function timePart(date, { timezone, clock }) {
  const p = parts(date, { timeZone: timezone, hour: 'numeric', minute: '2-digit', hourCycle: clock === '12h' ? 'h12' : 'h23' });
  const hh = clock === '12h' ? p.hour : p.hour.padStart(2, '0');
  return clock === '12h' ? `${hh}:${p.minute} ${p.dayPeriod}` : `${hh}:${p.minute}`;
}

/**
 * Render an instant in the operator's zone and clock, with the zone abbreviation.
 * `part`: 'datetime' (default), 'date', or 'time'. `now` only decides whether the year shows.
 */
export function formatOperatorTime(input, { timezone = DEFAULT_TIMEZONE, clock = DEFAULT_CLOCK, part = 'datetime', now = new Date() } = {}) {
  const date = parseInstant(input, now);
  const s = { timezone, clock };
  if (part === 'date') return datePart(date, s, now);
  const time = `${timePart(date, s)} ${zoneName(date, timezone)}`;
  if (part === 'time') return time;
  return `${datePart(date, s, now)}${clock === '12h' ? ',' : ''} ${time}`;
}

/** `3m ago`, `in 2h`, `just now`: the largest whole unit. */
export function formatRelative(input, now = new Date()) {
  const diff = Math.round((parseInstant(input, now).getTime() - parseInstant(now).getTime()) / 1000);
  const s = Math.abs(diff);
  if (s < 30) return 'just now';
  const unit = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

/** Format using the environment's settings. */
export function formatFromEnv(input, env = process.env, opts = {}) {
  const { timezone, clock } = resolveSettings(env);
  return formatOperatorTime(input, { timezone, clock, ...opts });
}

const ISO_UTC_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;

/**
 * Replace every ISO 8601 UTC timestamp in `text` with its human rendering. With `{slack: true}` each
 * becomes Slack's date token, so every reader sees their own zone and clock, with the sending
 * fleet's format as the fallback text. No-op when no operator time setting exists (today's text).
 */
export function humanizeText(text, env = process.env, { slack = false, now = new Date() } = {}) {
  if (!isConfigured(env)) return text;
  const { timezone, clock } = resolveSettings(env);
  return String(text).replace(ISO_UTC_RE, (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const human = formatOperatorTime(d, { timezone, clock, now });
    return slack ? slackDateToken(d, human) : human;
  });
}

/** Slack's date token: `<!date^EPOCH^{date_short_pretty} {time}|fallback>`. */
export function slackDateToken(input, fallback) {
  const epoch = Math.floor(parseInstant(input).getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${String(fallback).replace(/[<>|]/g, '')}>`;
}

/**
 * The instruction sessions get: empty when no setting exists, else
 * "Show dates and times to the operator in America/New_York with a 12-hour clock (3:44 PM ET). ..."
 */
export function contextLine(env = process.env, now = new Date()) {
  if (!isConfigured(env)) return '';
  const { timezone, clock } = resolveSettings(env);
  // `ET` (generic, DST-neutral) when the runtime has an abbreviation; else the concrete one (CEST, GMT+5:30).
  const generic = parts(now, { timeZone: timezone, timeZoneName: 'shortGeneric' }).timeZoneName || '';
  const short = /^[A-Z]{2,5}$/.test(generic) ? generic : zoneName(now, timezone);
  const example = `${timePart(now, { timezone, clock })} ${short}`;
  return `Show dates and times to the operator in ${timezone} with a ${clock === '12h' ? '12' : '24'}-hour clock (${example}). Keep machine fields in UTC.`;
}

function usage() {
  return 'usage: operator-time.mjs <iso|epoch|now> [--date|--time|--relative] [--tz <IANA>] [--clock 12h|24h]\n       operator-time.mjs context-line | humanize\n';
}

export function main(argv, { env = process.env, out = process.stdout, err = process.stderr, now = new Date() } = {}) {
  const e = { ...env };
  let part = 'datetime';
  let relative = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') part = 'date';
    else if (a === '--time') part = 'time';
    else if (a === '--relative') relative = true;
    else if (a === '--tz') e.OPERATOR_TIMEZONE = argv[++i] ?? '';
    else if (a === '--clock') e.OPERATOR_CLOCK = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') { out.write(usage()); return 0; }
    else rest.push(a);
  }
  if (rest[0] === 'context-line' && rest.length === 1) {
    const line = contextLine(e, now);
    if (line) out.write(`${line}\n`);
    return 0;
  }
  if (rest[0] === 'humanize' && rest.length === 1) {
    out.write(humanizeText(fs.readFileSync(0, 'utf8'), e, { now }));
    return 0;
  }
  if (rest.length !== 1) { err.write(usage()); return 2; }
  for (const w of resolveSettings(e).warnings) err.write(`fleet time: ${w}\n`);
  try {
    out.write(`${relative ? formatRelative(rest[0], now) : formatFromEnv(rest[0], e, { part, now })}\n`);
    return 0;
  } catch (x) {
    err.write(`fleet time: ${x.message}\n`);
    return 1;
  }
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) process.exitCode = main(process.argv.slice(2));
