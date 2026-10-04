// Tests for claim.mjs — run by `node --test core/lib/claim.test.mjs`. No network, no real `gh`:
// every gh-backed verb takes a fake `api` object shaped like gate-check.mjs's `ghApiClient`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  ClaimError,
  claimLabel,
  parseClaimLabel,
  branchName,
  issueBranchSlug,
  parseRef,
  parseHeartbeat,
  isClaimActive,
  acquireClaim,
  releaseClaim,
  claimStatus,
  main,
} from './claim.mjs';

const REPO = 'acme/app';
const NUM = 412;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A fake GitHub API over an in-memory label/comment store, keyed the way the real one is. */
function fakeApi({ labels = [], timeline = [], statusIssues = {} } = {}) {
  const state = { labels: [...labels], repoLabels: new Set(), comments: [] };
  return {
    state,
    async request(method, path, body) {
      if (method === 'GET' && path === `/repos/${REPO}/issues/${NUM}`) {
        return { status: 200, json: { labels: state.labels.map((name) => ({ name })) } };
      }
      if (method === 'GET' && path.startsWith(`/repos/${REPO}/issues/${NUM}/timeline`)) {
        return { status: 200, json: timeline, headers: {} };
      }
      if (method === 'GET' && path.startsWith(`/repos/${REPO}/labels/`)) {
        const name = decodeURIComponent(path.split('/labels/')[1]);
        return state.repoLabels.has(name) ? { status: 200, json: { name } } : { status: 404, json: { message: 'Not Found' } };
      }
      if (method === 'POST' && path === `/repos/${REPO}/labels`) return { status: 201, json: {} };
      if (method === 'POST' && path === `/repos/${REPO}/issues/${NUM}/labels`) {
        for (const name of body?.labels ?? []) if (!state.labels.includes(name)) state.labels.push(name);
        return { status: 200, json: [] };
      }
      if (method === 'POST' && path === `/repos/${REPO}/issues/${NUM}/comments`) return { status: 201, json: {} };
      if (method === 'DELETE' && path.startsWith(`/repos/${REPO}/issues/${NUM}/labels/`)) {
        const name = decodeURIComponent(path.split('/labels/')[1]);
        const had = state.labels.includes(name);
        state.labels = state.labels.filter((l) => l !== name);
        return { status: had ? 200 : 404, json: {} };
      }
      const m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path);
      if (method === 'GET' && m && statusIssues[`${m[1]}#${m[2]}`]) return { status: 200, json: { body: statusIssues[`${m[1]}#${m[2]}`] } };
      return { status: 404, json: { message: 'Not Found' } };
    },
  };
}
// Mark these labels as already existing in the repo (so ensureLabel's GET finds them).
function withRepoLabel(api, ...names) {
  for (const n of names) api.state.repoLabels.add(n);
  return api;
}

describe('claimLabel / parseClaimLabel', () => {
  test('round-trips a valid fleet id', () => {
    assert.equal(claimLabel('alice'), 'fleet:alice');
    assert.equal(parseClaimLabel('fleet:alice'), 'alice');
  });
  test('rejects an invalid fleet id', () => {
    assert.throws(() => claimLabel('Alice'), /invalid fleet id/);
    assert.throws(() => claimLabel(''), /invalid fleet id/);
  });
  test('parseClaimLabel is null for anything else', () => {
    assert.equal(parseClaimLabel('bug'), null);
    assert.equal(parseClaimLabel('fleet:'), null);
    assert.equal(parseClaimLabel(42), null);
  });
});

describe('branchName / issueBranchSlug', () => {
  test('with a fleet id', () => {
    assert.equal(branchName('bob', issueBranchSlug(412, 'retry-backoff')), 'agent/bob/412-retry-backoff');
    assert.equal(branchName('bob', 'project-11-phase-2'), 'agent/bob/project-11-phase-2');
  });
  test('without a fleet id (single-fleet mode): unchanged', () => {
    assert.equal(branchName(null, '412-retry-backoff'), 'agent/412-retry-backoff');
    assert.equal(branchName(undefined, '412-retry-backoff'), 'agent/412-retry-backoff');
    assert.equal(branchName('', '412-retry-backoff'), 'agent/412-retry-backoff');
  });
  test('rejects a bad fleet id or empty slug', () => {
    assert.throws(() => branchName('Bob', 'x'), /invalid fleet id/);
    assert.throws(() => branchName('bob', ''), /non-empty slug/);
  });
  test('issueBranchSlug validates its number', () => {
    assert.throws(() => issueBranchSlug(0, 'x'), /positive integer/);
    assert.throws(() => issueBranchSlug('abc', 'x'), /positive integer/);
  });
});

describe('parseRef', () => {
  test('parses owner/repo#n', () => {
    assert.deepEqual(parseRef('acme/app#412'), { repo: 'acme/app', number: 412 });
  });
  test('rejects malformed refs', () => {
    for (const bad of ['acme/app', '#412', 'acme/app#0', 'acme/app#', 'not a ref']) {
      assert.throws(() => parseRef(bad), /ref must be owner\/repo#N/);
    }
  });
});

describe('parseHeartbeat', () => {
  const body = (at) => `status\n\n<!-- fleet-heartbeat -->\nlast: ${at} — status: running\n<!-- /fleet-heartbeat -->\n`;
  test('fresh just now', () => assert.equal(parseHeartbeat(body('2026-10-04T11:45:00Z'), new Date(NOW)), true));
  test('stale beyond the window', () => assert.equal(parseHeartbeat(body('2026-10-04T11:00:00Z'), new Date(NOW)), false));
  test('no marker: unresolvable', () => assert.equal(parseHeartbeat('just a status issue, no marker', new Date(NOW)), null));
  test('unparseable timestamp: unresolvable', () => assert.equal(parseHeartbeat(body('whenever'), new Date(NOW)), null));
  test('non-string body: unresolvable', () => assert.equal(parseHeartbeat(undefined), null));
});

describe('isClaimActive', () => {
  test('younger than 7 days is active regardless of heartbeat', () => {
    assert.equal(isClaimActive({ labeledAt: NOW - 1 * DAY, heartbeatFresh: false, now: NOW }), true);
  });
  test('older than 7 days with a stale heartbeat is not active (takeover-eligible)', () => {
    assert.equal(isClaimActive({ labeledAt: NOW - 8 * DAY, heartbeatFresh: false, now: NOW }), false);
  });
  test('older than 7 days but a fresh heartbeat is still active', () => {
    assert.equal(isClaimActive({ labeledAt: NOW - 8 * DAY, heartbeatFresh: true, now: NOW }), true);
  });
  test('older than 7 days, heartbeat unresolvable: age rule alone decides (not active)', () => {
    assert.equal(isClaimActive({ labeledAt: NOW - 8 * DAY, heartbeatFresh: null, now: NOW }), false);
  });
  test('unprovable age (no labeled event found) is never takeover-eligible', () => {
    assert.equal(isClaimActive({ labeledAt: null, heartbeatFresh: null, now: NOW }), true);
  });
});

describe('acquireClaim', () => {
  test('acquires cleanly when nothing else holds the issue (label already exists)', async () => {
    const api = withRepoLabel(fakeApi(), 'fleet:alice');
    const res = await acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', now: NOW });
    assert.deepEqual(res, { status: 'acquired', fleet: 'alice', took_over: undefined });
    assert.deepEqual(api.state.labels, ['fleet:alice']);
  });

  test('creates the label when the repo does not have it yet', async () => {
    const api = fakeApi();
    const res = await acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', now: NOW });
    assert.equal(res.status, 'acquired');
    assert.deepEqual(api.state.labels, ['fleet:alice']);
  });

  test('is idempotent when we already hold the claim', async () => {
    const api = withRepoLabel(fakeApi({ labels: ['fleet:alice'] }), 'fleet:alice');
    const res = await acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', now: NOW });
    assert.deepEqual(res, { status: 'already-own', fleet: 'alice' });
  });

  test('refuses a fresh foreign claim, with or without --takeover', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'fleet:bob' }, created_at: '2026-10-03T12:00:00Z' }];
    for (const takeover of [false, true]) {
      const api = fakeApi({ labels: ['fleet:bob'], timeline });
      await assert.rejects(
        acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', takeover, now: NOW }),
        (e) => e instanceof ClaimError && e.exit === EXIT.FOREIGN && /claimed by fleet "bob"/.test(e.message),
      );
      assert.deepEqual(api.state.labels, ['fleet:bob']); // untouched
    }
  });

  test('refuses a stale foreign claim WITHOUT --takeover', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'fleet:bob' }, created_at: '2026-09-01T12:00:00Z' }];
    const api = fakeApi({ labels: ['fleet:bob'], timeline });
    await assert.rejects(
      acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', takeover: false, now: NOW }),
      (e) => e instanceof ClaimError && e.exit === EXIT.FOREIGN && /stale claim/.test(e.message) && /--takeover/.test(e.message),
    );
    assert.deepEqual(api.state.labels, ['fleet:bob']);
  });

  test('takes over a stale (>7 day) foreign claim WITH --takeover, and comments', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'fleet:bob' }, created_at: '2026-09-01T12:00:00Z' }];
    const api = withRepoLabel(fakeApi({ labels: ['fleet:bob'], timeline }), 'fleet:alice');
    const res = await acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', takeover: true, now: NOW });
    assert.equal(res.status, 'acquired');
    assert.equal(res.took_over, true);
    assert.deepEqual(api.state.labels, ['fleet:alice']);
  });

  test('a foreign label with no discoverable labeled event is never takeover-eligible', async () => {
    const api = fakeApi({ labels: ['fleet:bob'], timeline: [] });
    await assert.rejects(
      acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'alice', takeover: true, now: NOW }),
      (e) => e instanceof ClaimError && /unknown time/.test(e.message),
    );
  });

  test('validates its inputs', async () => {
    const api = fakeApi();
    await assert.rejects(acquireClaim(api, { repo: 'bad ref', number: NUM, fleetId: 'alice' }), /repo must be owner\/name/);
    await assert.rejects(acquireClaim(api, { repo: REPO, number: 0, fleetId: 'alice' }), /positive integer/);
    await assert.rejects(acquireClaim(api, { repo: REPO, number: NUM, fleetId: 'Bad' }), /invalid fleet id/);
  });
});

describe('releaseClaim', () => {
  test('removes our label', async () => {
    const api = fakeApi({ labels: ['fleet:alice'] });
    const res = await releaseClaim(api, { repo: REPO, number: NUM, fleetId: 'alice' });
    assert.deepEqual(res, { status: 'released', fleet: 'alice', held: true });
    assert.deepEqual(api.state.labels, []);
  });
  test('is a no-op (not an error) when we never held it', async () => {
    const api = fakeApi({ labels: [] });
    const res = await releaseClaim(api, { repo: REPO, number: NUM, fleetId: 'alice' });
    assert.deepEqual(res, { status: 'released', fleet: 'alice', held: false });
  });
});

describe('claimStatus', () => {
  test('reports the current holder', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'fleet:bob' }, created_at: '2026-09-01T12:00:00Z' }];
    const api = fakeApi({ labels: ['fleet:bob'], timeline });
    assert.deepEqual(await claimStatus(api, { repo: REPO, number: NUM }), { held_by: 'bob', since: '2026-09-01T12:00:00.000Z' });
  });
  test('reports unclaimed', async () => {
    const api = fakeApi({ labels: [] });
    assert.deepEqual(await claimStatus(api, { repo: REPO, number: NUM }), { held_by: null });
  });
});

describe('main (CLI)', () => {
  function run(args, { env = {}, api } = {}) {
    const out = { s: '' }; const err = { s: '' };
    const streams = { out: { write: (s) => (out.s += s) }, err: { write: (s) => (err.s += s) } };
    return main(args, { api, env, cwd: '/tmp', ...streams }).then((code) => ({ code, out: out.s, err: err.s }));
  }

  test('single-fleet mode (no FLEET_ID): acquire/release are no-ops, exit 0', async () => {
    const api = fakeApi();
    const acq = await run(['acquire', `${REPO}#${NUM}`], { env: {}, api });
    assert.equal(acq.code, EXIT.OK);
    assert.match(acq.out, /single-fleet mode/);
    const rel = await run(['release', `${REPO}#${NUM}`], { env: {}, api });
    assert.equal(rel.code, EXIT.OK);
    assert.match(rel.out, /single-fleet mode/);
  });

  test('acquires with FLEET_ID from the environment', async () => {
    const api = withRepoLabel(fakeApi(), 'fleet:alice');
    const res = await run(['acquire', `${REPO}#${NUM}`], { env: { FLEET_ID: 'alice' }, api });
    assert.equal(res.code, EXIT.OK);
    assert.match(res.out, /"status":"acquired"/);
  });

  test('--fleet-id overrides the environment', async () => {
    const api = withRepoLabel(fakeApi(), 'fleet:bob');
    const res = await run(['acquire', `${REPO}#${NUM}`, '--fleet-id', 'bob'], { env: { FLEET_ID: 'alice' }, api });
    assert.match(res.out, /"fleet":"bob"/);
  });

  test('exits FOREIGN and prints the holder on a blocked claim', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'fleet:bob' }, created_at: '2026-10-03T12:00:00Z' }];
    const api = fakeApi({ labels: ['fleet:bob'], timeline });
    const res = await run(['acquire', `${REPO}#${NUM}`], { env: { FLEET_ID: 'alice' }, api });
    assert.equal(res.code, EXIT.FOREIGN);
    assert.match(res.err, /claimed by fleet "bob"/);
  });

  test('status works without a FLEET_ID', async () => {
    const api = fakeApi({ labels: ['fleet:bob'] });
    const res = await run(['status', `${REPO}#${NUM}`], { env: {}, api });
    assert.equal(res.code, EXIT.OK);
    assert.match(res.out, /"held_by":"bob"/);
  });

  test('rejects a bad ref and an unknown command', async () => {
    const api = fakeApi();
    assert.equal((await run(['acquire', 'nope'], { api })).code, EXIT.ERROR);
    assert.equal((await run(['frobnicate', `${REPO}#${NUM}`], { api })).code, EXIT.ERROR);
    assert.equal((await run([], { api })).code, EXIT.ERROR);
  });

  test('rejects a malformed FLEET_ID', async () => {
    const api = fakeApi();
    const res = await run(['acquire', `${REPO}#${NUM}`], { env: { FLEET_ID: 'Bad_ID' }, api });
    assert.equal(res.code, EXIT.ERROR);
    assert.match(res.err, /FLEET_ID/);
  });
});
