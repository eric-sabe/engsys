// federation-status.test.mjs — the plain-text view's operator time format (#89): unchanged without a
// setting, an "as of" line and clock-time baton expiry with one; the JSON view never changes.
// Run: node --test core/fleet/lib/federation-status.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from './federation-status.mjs';

const data = {
  generatedAt: '2026-10-05T19:50:00.000Z',
  fleets: [{ id: 'eric', operator: 'eric-sabe', enabled: true, statusIssue: { repo: 'acme/ops', number: 7 }, fleetHeartbeat: { at: '2026-10-05T19:48:00.000Z', ageSec: 120 }, brokerHeartbeat: null, relay: null }],
  batons: [{ repo: 'acme/app', role: 'merge', home: 'eric', standby: [], state: 'held', holder: 'eric:mm', holderFleet: 'eric', expiresAt: '2026-10-05T20:50:00.000Z', expiresInSec: 3600, flag: false }],
};

test('no setting: the table is what it always was', () => {
  const text = render(data, {}).join('\n');
  assert.doesNotMatch(text, /as of/);
  assert.match(text, /eric:mm\s+1h\s*$/m);
});

test('a setting adds an as-of line and the baton expiry as a clock time', () => {
  const lines = render(data, { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' });
  assert.equal(lines[0], 'as of Oct 5, 3:50 PM EDT');
  assert.match(lines.join('\n'), /eric:mm\s+1h \(Oct 5, 4:50 PM EDT\)/);
});

test('24h in another zone', () => {
  const text = render(data, { OPERATOR_TIMEZONE: 'Europe/Berlin', OPERATOR_CLOCK: '24h' }).join('\n');
  assert.match(text, /as of 5 Oct 21:50 CEST/);
  assert.match(text, /1h \(5 Oct 22:50 CEST\)/);
});

test('the data itself keeps ISO 8601 UTC (what --json prints)', () => {
  render(data, { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' });
  assert.equal(data.generatedAt, '2026-10-05T19:50:00.000Z');
  assert.equal(data.batons[0].expiresAt, '2026-10-05T20:50:00.000Z');
});
