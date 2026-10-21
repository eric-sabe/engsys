// Tests for mm-security-stale.mjs (engsys#246) — run by `npm test` (node --test). No network: gh, the notifier and the
// maintain lease status are stub scripts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authorLogin, decide, escalationText, incidentKey, laneFrom, prFacts, tick, NO_SIGNER_MARKER, SKIP_MARKER,
} from './mm-security-stale.mjs';
import { reviewEscalateMinutesOf, DEFAULT_REVIEW_ESCALATE_MINUTES } from '../../../lib/security-sensitive.mjs';

const LABEL = 'security-review-requested';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const T0 = Date.parse('2026-10-21T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const BOT = { __typename: 'Bot', login: 'feedfrwd-fleet-mark' };
const HUMAN = { __typename: 'User', login: 'mallory' };
const labeled = (min, name = LABEL) => ({ __typename: 'LabeledEvent', createdAt: at(min), label: { name } });
const comment = (min, body, author = BOT) => ({ __typename: 'IssueComment', createdAt: at(min), body, author });
const pr = ({ head = H1, committed = 0, nodes = [], author = BOT } = {}) => ({
  url: 'https://github.com/acme/app/pull/7', headRefOid: head, author,
  commits: { nodes: [{ commit: { committedDate: at(committed) } }] },
  timelineItems: { nodes },
});

describe('pure helpers', () => {
  test('authorLogin: a Bot (or gh\'s app/ form) becomes <slug>[bot]; a user stays as is', () => {
    assert.equal(authorLogin(BOT), 'feedfrwd-fleet-mark[bot]');
    assert.equal(authorLogin({ login: 'app/feedfrwd-fleet-eric' }), 'feedfrwd-fleet-eric[bot]');
    assert.equal(authorLogin({ __typename: 'Bot', login: 'x[bot]' }), 'x[bot]');
    assert.equal(authorLogin(HUMAN), 'mallory');
    assert.equal(authorLogin(null), '');
  });

  test('incidentKey is per repo and PR', () => {
    assert.equal(incidentKey('acme/app', 7), 'security-review-stale-acme-app-7');
  });

  test('prFacts: the clock starts at the first label event or bot request comment at or after the head push', () => {
    let f = prFacts(pr({ committed: 0, nodes: [labeled(5), comment(6, 'security review requested for `aaaa`')] }), LABEL);
    assert.equal(f.requestAt, T0 + 5 * 60000);
    assert.equal(f.author, 'feedfrwd-fleet-mark[bot]');
    // a label applied before this head was pushed: the request comment for the new head starts it
    f = prFacts(pr({ committed: 10, nodes: [labeled(5), comment(12, '<!-- security-review-request head="b" -->\nrequested')] }), LABEL);
    assert.equal(f.requestAt, T0 + 12 * 60000);
    // label kept across the push and no new request: the push itself
    f = prFacts(pr({ committed: 10, nodes: [labeled(5)] }), LABEL);
    assert.equal(f.requestAt, T0 + 10 * 60000);
    // another label, and a human's comment, never count
    f = prFacts(pr({ committed: 0, nodes: [labeled(3, 'other'), comment(4, 'security review requested', HUMAN), labeled(8)] }), LABEL);
    assert.equal(f.requestAt, T0 + 8 * 60000);
  });

  test('prFacts: a force push to the head moves the push time past an older commit date', () => {
    const nodes = [{ __typename: 'HeadRefForcePushedEvent', createdAt: at(20), afterCommit: { oid: H1 } }, labeled(5)];
    assert.equal(prFacts(pr({ committed: 0, nodes }), LABEL).requestAt, T0 + 20 * 60000);
  });

  test('prFacts: the lane notes count only from a bot', () => {
    assert.equal(prFacts(pr({ nodes: [comment(1, `${SKIP_MARKER}\nmine`)] }), LABEL).skipNote, true);
    assert.equal(prFacts(pr({ nodes: [comment(1, `${SKIP_MARKER}\nfake`, HUMAN)] }), LABEL).skipNote, false);
    assert.equal(prFacts(pr({ nodes: [comment(1, `${NO_SIGNER_MARKER}\nno key`)] }), LABEL).noSignerNote, true);
    assert.equal(prFacts(pr({ nodes: [comment(1, `quoting ${NO_SIGNER_MARKER}`)] }), LABEL).noSignerNote, false);
  });

  test('laneFrom: free or expired is unavailable; held, an error or nothing is not news', () => {
    assert.equal(laneFrom({ state: 'free' }).available, false);
    assert.match(laneFrom({ state: 'unknown', expired: true, expiredForMs: 900000 }).why, /expired 15 min ago/);
    assert.equal(laneFrom({ state: 'held' }).available, true);
    assert.equal(laneFrom({ state: 'error' }).available, true);
    assert.equal(laneFrom(null).available, true);
  });

  const facts = (o = {}) => ({ requestAt: T0, skipNote: false, noSignerNote: false, ...o });
  test('decide: fires once past the threshold, not before', () => {
    assert.equal(decide({ facts: facts(), lane: laneFrom({ state: 'held' }), minutes: 30, now: T0 + 29 * 60000 }).escalate, false);
    const d = decide({ facts: facts(), lane: laneFrom({ state: 'held' }), minutes: 30, now: T0 + 30 * 60000 });
    assert.deepEqual(d, { escalate: true, reason: 'unanswered_30min', waitedMin: 30 });
  });

  test('decide: the lane being clearly unavailable escalates at once', () => {
    const now = T0 + 60000;
    assert.equal(decide({ facts: facts({ skipNote: true }), minutes: 30, now }).reason, 'self_authored_skip');
    assert.equal(decide({ facts: facts({ noSignerNote: true }), minutes: 30, now }).reason, 'security_lane_no_key');
    assert.equal(decide({ facts: facts(), lane: laneFrom({ state: 'free' }), minutes: 30, now }).reason, 'security_lane_down');
  });

  test('decide: 0 turns it off, even for a skip note or a down lane', () => {
    assert.equal(decide({ facts: facts({ skipNote: true }), lane: laneFrom({ state: 'free' }), minutes: 0, now: T0 + 999 * 60000 }).escalate, false);
  });

  test('decide: unreadable GitHub falls back to the first sighting', () => {
    assert.equal(decide({ facts: null, minutes: 30, now: T0 + 31 * 60000, firstSeen: T0 }).escalate, true);
    assert.equal(decide({ facts: null, minutes: 30, now: T0 + 31 * 60000, firstSeen: T0 + 10 * 60000 }).escalate, false);
  });

  test('escalationText names the PR, the head and why, and never says to reply in Slack', () => {
    const t = escalationText({ number: 7, head: H1, reason: 'security_lane_down', waitedMin: 3, lane: laneFrom({ state: 'free' }), minutes: 30 });
    assert.match(t, /PR #7 \(head aaaaaaaaaaaa\) has waited 3 min/);
    assert.match(t, /not running \(no maintenance monster holds the maintain baton\)/);
    assert.doesNotMatch(t, /reply/i);
  });
});

describe('reviewEscalateMinutesOf (the config reader)', () => {
  test('first config that sets it wins; default 30; 0 is off; a bad value warns and keeps the default', () => {
    assert.deepEqual(reviewEscalateMinutesOf([]), { minutes: DEFAULT_REVIEW_ESCALATE_MINUTES, source: 'default', warning: '' });
    assert.equal(DEFAULT_REVIEW_ESCALATE_MINUTES, 30);
    assert.equal(reviewEscalateMinutesOf([{ source: 'a', text: 'repo: x\n' }, { source: 'b', text: 'security_review_escalate_minutes: 45\n' }]).minutes, 45);
    assert.equal(reviewEscalateMinutesOf([{ source: 'a', text: 'security_review_escalate_minutes: 0\n' }]).minutes, 0);
    const bad = reviewEscalateMinutesOf([{ source: 'a', text: 'security_review_escalate_minutes: soon\n' }]);
    assert.equal(bad.minutes, 30);
    assert.match(bad.warning, /must be a whole number of minutes/);
    assert.equal(reviewEscalateMinutesOf([{ source: 'a', text: 'security_review_escalate_minutes: -5\n' }]).minutes, 30);
  });
});

describe('tick against stub gh, notifier and lease status', () => {
  let T; let env; let notifyLog;
  const write = (name, v) => fs.writeFileSync(path.join(T, name), typeof v === 'string' ? v : JSON.stringify(v));
  before(() => {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-secstale-'));
    notifyLog = path.join(T, 'notify.log');
    write('gh', `#!/usr/bin/env bash\ncase "$*" in *number=7*) cat "${T}/pr-7.json" ;; *) exit 1 ;; esac\n`);
    write('notify', `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${notifyLog}"\n`);
    write('lane', `#!/usr/bin/env bash\ncat "${T}/lane.json"\n`);
    for (const f of ['gh', 'notify', 'lane']) fs.chmodSync(path.join(T, f), 0o755);
    env = { PATH: process.env.PATH, FLEET_GH: path.join(T, 'gh'), BATON_NOTIFY_CMD: `bash ${path.join(T, 'notify')}`, MM_LANE_STATUS_CMD: `bash ${path.join(T, 'lane')}` };
  });
  after(() => fs.rmSync(T, { recursive: true, force: true }));

  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(T, 'w-'));
    fs.writeFileSync(notifyLog, '');
    write('lane.json', { state: 'held' });
    return dir;
  };
  const sink = () => { const s = { text: '', write: (x) => { s.text += x; } }; return s; };
  const step = (dir, min, { waiting = [7], watched = [7], minutes = 30 } = {}) => {
    const out = sink();
    tick({ repo: 'acme/app', dir, waiting, watched, minutes, label: LABEL, now: T0 + min * 60000, env, out });
    return out.text;
  };
  const calls = () => fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean);

  test('fires once past the threshold, routed to the PR\'s owner, and never again for the same head', () => {
    const dir = fresh();
    write('pr-7.json', pr({ committed: 0, nodes: [labeled(1)] }));
    assert.equal(step(dir, 20), '');
    assert.equal(step(dir, 30), '', '29 min after the request: not yet');
    assert.match(step(dir, 31), /^SECURITY_REVIEW_STALE #7 unanswered_30min head=aaaaaaaaaaaa notified\n$/);
    assert.equal(calls().length, 1);
    assert.match(calls()[0], /^--level action --author feedfrwd-fleet-mark\[bot\] --re https:\/\/github\.com\/acme\/app\/pull\/7 --incident security-review-stale-acme-app-7 Security review for PR #7/);
    assert.equal(step(dir, 45), '');
    assert.equal(calls().length, 1, 'latched per PR and head');
  });

  test('a new head resolves the old incident and starts the clock again', () => {
    const dir = fresh();
    write('pr-7.json', pr({ committed: 0, nodes: [labeled(0)] }));
    step(dir, 31);
    write('pr-7.json', pr({ head: H2, committed: 40, nodes: [labeled(0), comment(41, 'security review requested for `bbbb`')] }));
    assert.equal(step(dir, 42), 'SECURITY_REVIEW_STALE_RESOLVED #7 new_head bbbbbbbbbbbb\n');
    assert.equal(step(dir, 70), '', '29 min after the new request');
    assert.match(step(dir, 72), /SECURITY_REVIEW_STALE #7 unanswered_30min head=bbbbbbbbbbbb notified/);
    assert.deepEqual(calls().map((c) => c.split(' ').slice(0, 2).join(' ')), ['--level action', '--resolve --incident', '--level action']);
  });

  test('a verdict landing (the PR leaves the watch) resolves the alert and drops the latch', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0)] }));
    step(dir, 31);
    assert.equal(step(dir, 32, { waiting: [7], watched: [7] }), '');
    assert.equal(step(dir, 33, { waiting: [], watched: [7] }), '', 'still watched (a failed run): kept');
    assert.ok(fs.existsSync(path.join(dir, 'secstale.7')));
    assert.equal(step(dir, 34, { waiting: [], watched: [] }), 'SECURITY_REVIEW_STALE_RESOLVED #7 left_the_watch\n');
    assert.equal(calls().at(-1), '--resolve --incident security-review-stale-acme-app-7');
    assert.equal(fs.existsSync(path.join(dir, 'secstale.7')), false);
  });

  test('a PR that leaves before it was escalated is forgotten without a resolve', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0)] }));
    step(dir, 5);
    assert.equal(step(dir, 6, { waiting: [], watched: [] }), '');
    assert.equal(calls().length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'secstale.7')), false);
  });

  test('the lane\'s self-authored skip note escalates at once', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0), comment(1, `${SKIP_MARKER}\nthis session authored it`)] }));
    assert.match(step(dir, 2), /SECURITY_REVIEW_STALE #7 self_authored_skip head=aaaaaaaaaaaa notified/);
    assert.match(calls()[0], /skipped it as self-authored/);
  });

  test('the lane\'s no-signer note escalates at once', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0), comment(1, `${NO_SIGNER_MARKER}\nno key`)] }));
    assert.match(step(dir, 2), /SECURITY_REVIEW_STALE #7 security_lane_no_key/);
  });

  test('a stale maintain baton escalates at once', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0)] }));
    write('lane.json', { state: 'unknown', expired: true, expiredForMs: 25 * 60000 });
    assert.match(step(dir, 2), /SECURITY_REVIEW_STALE #7 security_lane_down head=aaaaaaaaaaaa notified/);
    assert.match(calls()[0], /the maintain baton expired 25 min ago/);
  });

  test('0 disables it: nothing is sent, whatever the clock or the lane', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0), comment(1, `${SKIP_MARKER}\nx`)] }));
    write('lane.json', { state: 'free' });
    assert.equal(step(dir, 500, { minutes: 0 }), '');
    assert.equal(calls().length, 0);
  });

  test('a human PR author goes to --author as is (notify then DMs this host\'s operator)', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0)], author: HUMAN }));
    step(dir, 31);
    assert.match(calls()[0], /--author mallory --re/);
  });

  test('a notify failure is said, and retried on the next tick', () => {
    const dir = fresh();
    write('pr-7.json', pr({ nodes: [labeled(0)] }));
    const failing = { ...env, BATON_NOTIFY_CMD: 'false' };
    const out = sink();
    tick({ repo: 'acme/app', dir, waiting: [7], watched: [7], minutes: 30, label: LABEL, now: T0 + 31 * 60000, env: failing, out });
    assert.match(out.text, /notify_failed/);
    assert.match(step(dir, 32), /notified/);
  });
});
