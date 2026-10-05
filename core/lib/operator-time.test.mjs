// operator-time.test.mjs — the operator time formatter: zones, 12h/24h, DST, invalid-zone fallback,
// the session context line, ISO-to-human rewriting, Slack tokens and the CLI.
// Run: node --test core/lib/operator-time.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTimeZone, isConfigured, resolveSettings, parseInstant, formatOperatorTime, formatRelative,
  formatFromEnv, humanizeText, slackDateToken, contextLine, main,
} from './operator-time.mjs';

const NOW = new Date('2026-10-05T19:50:00Z');
const ET12 = { timezone: 'America/New_York', clock: '12h', now: NOW };
const BERLIN24 = { timezone: 'Europe/Berlin', clock: '24h', now: NOW };

test('12h Eastern: month day, 12-hour time, zone abbreviation', () => {
  assert.equal(formatOperatorTime('2026-10-05T19:44:00Z', ET12), 'Oct 5, 3:44 PM EDT');
  assert.equal(formatOperatorTime('2026-12-05T19:44:00Z', ET12), 'Dec 5, 2:44 PM EST');
});

test('24h Berlin: day month, 24-hour time, zone abbreviation', () => {
  assert.equal(formatOperatorTime('2026-10-05T13:44:00Z', BERLIN24), '5 Oct 15:44 CEST');
  assert.equal(formatOperatorTime('2026-01-05T13:44:00Z', BERLIN24), '5 Jan 14:44 CET');
});

test('midnight and noon read correctly on both clocks', () => {
  assert.equal(formatOperatorTime('2026-10-05T04:00:00Z', ET12), 'Oct 5, 12:00 AM EDT');
  assert.equal(formatOperatorTime('2026-10-05T16:00:00Z', ET12), 'Oct 5, 12:00 PM EDT');
  assert.equal(formatOperatorTime('2026-10-04T22:05:00Z', BERLIN24), '5 Oct 00:05 CEST');
});

test('the year shows only when it is not the current one', () => {
  assert.equal(formatOperatorTime('2025-03-05T19:44:00Z', ET12), 'Mar 5, 2025, 2:44 PM EST');
  assert.equal(formatOperatorTime('2025-03-05T13:44:00Z', BERLIN24), '5 Mar 2025 14:44 CET');
});

test('date and time parts render on their own', () => {
  assert.equal(formatOperatorTime('2026-10-05T19:44:00Z', { ...ET12, part: 'date' }), 'Oct 5');
  assert.equal(formatOperatorTime('2026-10-05T19:44:00Z', { ...ET12, part: 'time' }), '3:44 PM EDT');
  assert.equal(formatOperatorTime('2026-10-05T13:05:00Z', { ...BERLIN24, part: 'time' }), '15:05 CEST');
});

test('DST boundary: the same wall time an hour apart gets different abbreviations', () => {
  // US fall-back, 2026-11-01 06:00 UTC: 01:30 happens twice, EDT then EST.
  assert.equal(formatOperatorTime('2026-11-01T05:30:00Z', ET12), 'Nov 1, 1:30 AM EDT');
  assert.equal(formatOperatorTime('2026-11-01T06:30:00Z', ET12), 'Nov 1, 1:30 AM EST');
  // EU spring-forward, 2026-03-29 01:00 UTC: 02:30 CET never exists.
  assert.equal(formatOperatorTime('2026-03-29T00:59:00Z', BERLIN24), '29 Mar 01:59 CET');
  assert.equal(formatOperatorTime('2026-03-29T01:00:00Z', BERLIN24), '29 Mar 03:00 CEST');
});

test('a zone with no abbreviation falls back to a GMT offset; UTC reads UTC', () => {
  assert.equal(formatOperatorTime('2026-10-05T13:44:00Z', { timezone: 'Asia/Kolkata', clock: '12h', now: NOW }), 'Oct 5, 7:14 PM GMT+5:30');
  assert.equal(formatOperatorTime('2026-10-05T13:44:00Z', { now: NOW }), '5 Oct 13:44 UTC');
});

test('isValidTimeZone: IANA names yes, junk no', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  for (const bad of ['Mars/Olympus', '', ' UTC', 'EST5EDT garbage', undefined, 5]) assert.equal(isValidTimeZone(bad), false, String(bad));
});

test('resolveSettings: default UTC 24h; an invalid zone or clock falls back with a warning', () => {
  assert.deepEqual(resolveSettings({}), { timezone: 'UTC', clock: '24h', configured: false, warnings: [] });
  const r = resolveSettings({ OPERATOR_TIMEZONE: 'Nope/Zone', OPERATOR_CLOCK: '13h' });
  assert.equal(r.timezone, 'UTC');
  assert.equal(r.clock, '24h');
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /Nope\/Zone.*using UTC/);
  assert.equal(resolveSettings({ OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' }).configured, true);
});

test('isConfigured: blank values do not count', () => {
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured({ OPERATOR_TIMEZONE: ' ', OPERATOR_CLOCK: '' }), false);
  assert.equal(isConfigured({ OPERATOR_CLOCK: '12h' }), true);
});

test('formatFromEnv with an invalid zone renders in UTC', () => {
  assert.equal(formatFromEnv('2026-10-05T13:44:00Z', { OPERATOR_TIMEZONE: 'Nope/Zone', OPERATOR_CLOCK: '12h' }, { now: NOW }), 'Oct 5, 1:44 PM UTC');
});

test('parseInstant: ISO, epoch seconds, epoch milliseconds, now; junk throws', () => {
  assert.equal(parseInstant('2026-10-05T19:44:00Z').toISOString(), '2026-10-05T19:44:00.000Z');
  assert.equal(parseInstant('1791229440').toISOString(), '2026-10-05T19:44:00.000Z');
  assert.equal(parseInstant('1791229440000').toISOString(), '2026-10-05T19:44:00.000Z');
  assert.equal(parseInstant('2026-10-05T19:44:00').toISOString(), '2026-10-05T19:44:00.000Z', 'no offset reads as UTC');
  assert.equal(parseInstant('now', NOW).toISOString(), NOW.toISOString());
  assert.throws(() => parseInstant('last tuesday'), /cannot read a time/);
});

test('formatRelative: largest whole unit, past and future', () => {
  assert.equal(formatRelative('2026-10-05T19:20:00Z', NOW), '30m ago');
  assert.equal(formatRelative('2026-10-05T22:50:00Z', NOW), 'in 3h');
  assert.equal(formatRelative('2026-10-03T19:50:00Z', NOW), '2d ago');
  assert.equal(formatRelative('2026-10-05T19:49:50Z', NOW), 'just now');
});

test('contextLine: absent without a setting, present with one', () => {
  assert.equal(contextLine({}, NOW), '');
  assert.equal(
    contextLine({ OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' }, NOW),
    'Show dates and times to the operator in America/New_York with a 12-hour clock (3:50 PM ET). Keep machine fields in UTC.',
  );
  assert.equal(
    contextLine({ OPERATOR_TIMEZONE: 'Europe/Berlin', OPERATOR_CLOCK: '24h' }, NOW),
    'Show dates and times to the operator in Europe/Berlin with a 24-hour clock (21:50 CEST). Keep machine fields in UTC.',
  );
  assert.match(contextLine({ OPERATOR_CLOCK: '12h' }, NOW), /in UTC with a 12-hour clock/);
});

test('humanizeText: no setting leaves the text byte-for-byte; a setting rewrites ISO UTC only', () => {
  const text = 'stale since 2026-10-05T19:44:00Z (job 2026-10-05, build 20261005T194400Z)';
  assert.equal(humanizeText(text, {}), text);
  const env = { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' };
  assert.equal(humanizeText(text, env, { now: NOW }), 'stale since Oct 5, 3:44 PM EDT (job 2026-10-05, build 20261005T194400Z)');
});

test('humanizeText for Slack: a date token per timestamp, fallback in the fleet format', () => {
  const env = { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' };
  assert.equal(
    humanizeText('baton expires 2026-10-05T19:44:00Z', env, { slack: true, now: NOW }),
    'baton expires <!date^1791229440^{date_short_pretty} {time}|Oct 5, 3:44 PM EDT>',
  );
});

test('slackDateToken strips characters that would break the token', () => {
  assert.equal(slackDateToken('2026-10-05T19:44:00Z', 'a|b>c<d'), '<!date^1791229440^{date_short_pretty} {time}|abcd>');
});

function cli(args, env = {}) {
  let out = ''; let err = '';
  const code = main(args, { env, out: { write: (s) => { out += s; } }, err: { write: (s) => { err += s; } }, now: NOW });
  return { code, out, err };
}

test('CLI: renders with --tz/--clock, the env, and the part flags', () => {
  assert.equal(cli(['2026-10-05T19:44:00Z', '--tz', 'America/New_York', '--clock', '12h']).out, 'Oct 5, 3:44 PM EDT\n');
  assert.equal(cli(['2026-10-05T13:44:00Z'], { OPERATOR_TIMEZONE: 'Europe/Berlin', OPERATOR_CLOCK: '24h' }).out, '5 Oct 15:44 CEST\n');
  assert.equal(cli(['2026-10-05T19:44:00Z', '--time', '--tz', 'America/New_York', '--clock', '12h']).out, '3:44 PM EDT\n');
  assert.equal(cli(['2026-10-05T19:44:00Z', '--date', '--tz', 'America/New_York']).out, '5 Oct\n');
  assert.equal(cli(['2026-10-05T19:20:00Z', '--relative']).out, '30m ago\n');
  assert.equal(cli(['now']).out, '5 Oct 19:50 UTC\n');
});

test('CLI: an invalid zone warns and falls back to UTC; a bad time exits 1', () => {
  const r = cli(['2026-10-05T19:44:00Z', '--tz', 'Nope/Zone']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '5 Oct 19:44 UTC\n');
  assert.match(r.err, /Nope\/Zone is not|'Nope\/Zone' is not an IANA time zone/);
  assert.equal(cli(['soon']).code, 1);
  assert.equal(cli([]).code, 2);
});

test('CLI: context-line prints nothing without a setting', () => {
  assert.equal(cli(['context-line']).out, '');
  assert.match(cli(['context-line'], { OPERATOR_TIMEZONE: 'America/New_York' }).out, /^Show dates and times to the operator in America\/New_York/);
});
