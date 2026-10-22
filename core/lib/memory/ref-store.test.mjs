import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fakeGitApi } from '../lease/fixtures/fake-github.mjs';
import {
  EVENTS_REF,
  MEMORY_FETCH_REFSPEC,
  tailRef,
  fleetEventsRef,
  fetchMemoryRefs,
  scanTextForSecrets,
  scanEventForSecrets,
  mergeEvents,
  compactEvents,
  createMemoryRefStore,
  verifyMemoryRefTip,
} from './ref-store.mjs';
import { publicKeyB64, resolveFleetPubkeys, signTip } from './signing.mjs';

// Every store call names its ref (engsys#266: no default); these generic store tests use one fleet's events ref.
const R = 'refs/engsys/memory/fleet/eric/events';

describe('ref-store (#130)', () => {
  it('validates tailRef segments and rejects refs outside refs/engsys/memory/*', async () => {
    assert.equal(tailRef('merge', 'fleet-a'), 'refs/engsys/memory/fleet/fleet-a/merge');
    assert.equal(tailRef('maintain', 'fleet-a'), 'refs/engsys/memory/fleet/fleet-a/maintain');
    assert.equal(fleetEventsRef('fleet-a'), 'refs/engsys/memory/fleet/fleet-a/events');
    assert.throws(() => tailRef('../heads', 'main'), /invalid role/);
    assert.throws(() => tailRef('dev', 'fleet-a'), /invalid role/, 'only the baton roles have tails');
    assert.throws(() => tailRef('events', 'fleet-a'), /invalid role/, 'a role can never shadow the fleet\'s events ref');
    assert.throws(() => tailRef('merge', 'a/b'), /invalid fleetId/);
    assert.throws(() => fleetEventsRef('../x'), /invalid fleetId/);

    const fake = fakeGitApi({ repo: 'owner/repo' });
    const store = createMemoryRefStore({
      repo: 'owner/repo',
      client: fake,
      sleep: async () => {},
    });

    await assert.rejects(
      () => store.readEvents({ ref: 'refs/heads/main' }),
      /ref must live under refs\/engsys\/memory\//,
    );
    await assert.rejects(
      () => store.writeEvents({ ref: 'refs/tags/v1.0.0', events: [] }),
      /ref must live under refs\/engsys\/memory\//,
    );
  });

  it('tailRef refuses dot segments (Nyx LOW 1): no leading dot, no "..", no ".lock" suffix', () => {
    assert.equal(tailRef('merge', 'eric'), 'refs/engsys/memory/fleet/eric/merge');
    for (const [role, fleet] of [['merge', '.'], ['merge', '..'], ['merge', '.git'], ['.merge', 'eric'], ['merge', 'a..b'], ['merge', 'x.lock']]) {
      assert.throws(() => tailRef(role, fleet), /invalid/, `${role}/${fleet}`);
    }
  });

  it('readEvents and writeEvents require a ref (no default to the retired shared events ref)', async () => {
    const store = createMemoryRefStore({ repo: 'owner/repo', client: fakeGitApi({ repo: 'owner/repo' }), sleep: async () => {} });
    await assert.rejects(() => store.readEvents(), /ref is required/);
    await assert.rejects(() => store.readEvents({}), /ref is required/);
    await assert.rejects(() => store.writeEvents({ events: [{ k: 'a', updated_at: '2026-07-01T00:00:00Z' }] }), /ref is required/);
    assert.equal((await store.readEvents({ ref: EVENTS_REF })).sha, null, 'naming it explicitly is a plain read');
  });

  it('creates, reads, and updates a memory ref round-trip', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });
    const store = createMemoryRefStore({
      repo: 'owner/repo',
      client: fake,
      sleep: async () => {},
    });

    // Empty ref before first write
    const initial = await store.readEvents({ ref: R });
    assert.equal(initial.ok, true);
    assert.equal(initial.sha, null);
    assert.deepEqual(initial.events, []);

    // First write creates the ref
    const ev1 = {
      k: 'pr:owner/repo#10',
      kind: 'pr',
      summary: 'initial PR summary',
      updated_at: '2026-04-01T10:00:00Z',
    };
    const w1 = await store.writeEvents({ ref: R, events: [ev1] });
    assert.equal(w1.ok, true);
    assert.equal(w1.count, 1);
    assert.equal(w1.compacted, false);
    assert.ok(w1.sha);

    const r1 = await store.readEvents({ ref: R });
    assert.equal(r1.ok, true);
    assert.equal(r1.sha, w1.sha);
    assert.equal(r1.events.length, 1);
    assert.equal(r1.events[0].summary, 'initial PR summary');

    // Second write merges a new record and updates the existing record (newer updated_at wins)
    const ev1Updated = {
      k: 'pr:owner/repo#10',
      kind: 'pr',
      summary: 'updated PR summary',
      updated_at: '2026-04-02T10:00:00Z',
    };
    const ev2 = {
      k: 'issue:owner/repo#11',
      kind: 'issue',
      summary: 'issue summary',
      updated_at: '2026-04-01T12:00:00Z',
    };
    const w2 = await store.writeEvents({ ref: R, events: [ev1Updated, ev2] });
    assert.equal(w2.ok, true);
    assert.equal(w2.count, 2);
    assert.notEqual(w2.sha, w1.sha);

    const r2 = await store.readEvents({ ref: R });
    assert.equal(r2.ok, true);
    assert.equal(r2.events.length, 2);
    const byK = new Map(r2.events.map((e) => [e.k, e]));
    assert.equal(byK.get('pr:owner/repo#10').summary, 'updated PR summary');
    assert.equal(byK.get('issue:owner/repo#11').summary, 'issue summary');
    assert.deepEqual(r2.parents, [w1.sha]);
  });

  it('beforeCas (F5): awaited before every ref update; a refusal or a throw moves nothing', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });
    const store = createMemoryRefStore({ repo: 'owner/repo', client: fake, sleep: async () => {} });
    const ev = { k: 'pr:owner/repo#1', kind: 'pr', updated_at: '2026-07-01T00:00:00Z' };
    const seen = [];
    const refused = await store.writeEvents({ ref: R, events: [ev], beforeCas: async (ctx) => { seen.push(ctx); return { held: false, reason: 'lost' }; } });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.error, { code: 'fence_refused', detail: 'lost' });
    assert.deepEqual(seen, [{ ref: R, round: 0 }]);
    assert.equal((await store.readEvents({ ref: R })).sha, null);
    const threw = await store.writeEvents({ ref: R, events: [ev], beforeCas: async () => { throw new Error('fence crashed'); } });
    assert.equal(threw.error.code, 'fence_refused');
    assert.equal((await store.readEvents({ ref: R })).sha, null, 'a crashing gate fails closed');
    const falsy = await store.writeEvents({ ref: R, events: [ev], beforeCas: async () => undefined });
    assert.equal(falsy.error.code, 'fence_refused', 'a gate that returns nothing is a refusal');
    const ok = await store.writeEvents({ ref: R, events: [ev], beforeCas: async () => ({ held: true }) });
    assert.equal(ok.ok, true);
    assert.equal((await store.readEvents({ ref: R })).events.length, 1);
  });

  it('retries on 422 CAS contention and merges both concurrent writers without losing events', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });

    // Seed initial ref so both writers start from the same tip SHA
    const seeder = createMemoryRefStore({
      repo: 'owner/repo',
      client: fake,
      sleep: async () => {},
    });
    await seeder.writeEvents({
      ref: R,
      events: [{ k: 'seed:1', summary: 'seed', updated_at: '2026-04-01T00:00:00Z' }],
    });

    // Interleave writer B right before writer A's first PATCH lands so writer A gets 422
    let injectedRace = false;
    const racingClientA = {
      async request(method, reqPath, body) {
        if (!injectedRace && method === 'PATCH' && reqPath.includes('/git/refs/')) {
          injectedRace = true;
          const writerB = createMemoryRefStore({
            repo: 'owner/repo',
            client: fake,
            sleep: async () => {},
          });
          const wb = await writerB.writeEvents({
            ref: R,
            events: [
              { k: 'worker:b', summary: 'from writer B', updated_at: '2026-04-01T02:00:00Z' },
            ],
          });
          assert.equal(wb.ok, true);
        }
        return fake.request(method, reqPath, body);
      },
    };

    const writerA = createMemoryRefStore({
      repo: 'owner/repo',
      client: racingClientA,
      sleep: async () => {},
    });
    const wa = await writerA.writeEvents({
      ref: R,
      events: [{ k: 'worker:a', summary: 'from writer A', updated_at: '2026-04-01T01:00:00Z' }],
    });

    assert.equal(wa.ok, true);
    assert.equal(wa.rounds, 2, 'writer A should win on round 2 after re-reading and re-merging');

    const finalState = await seeder.readEvents({ ref: R });
    assert.equal(finalState.ok, true);
    assert.deepEqual(
      finalState.events.map((e) => e.k),
      ['seed:1', 'worker:a', 'worker:b'],
    );
  });

  it('compacts when maxEvents is exceeded: drops tombstones > 180d and writes a parentless commit', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });
    const nowMs = Date.parse('2026-10-15T00:00:00Z');
    const store = createMemoryRefStore({
      repo: 'owner/repo',
      client: fake,
      sleep: async () => {},
      maxEvents: 3,
      tombstoneTtlDays: 180,
      now: () => nowMs,
    });

    // First write: 2 events (under maxEvents=3)
    const w1 = await store.writeEvents({
      ref: R,
      events: [
        {
          k: 'tombstone:old',
          deleted: true,
          updated_at: '2026-01-01T00:00:00Z', // > 180 days before 2026-10-15
        },
        {
          k: 'tombstone:recent',
          deleted: true,
          updated_at: '2026-09-01T00:00:00Z', // < 180 days before 2026-10-15
        },
      ],
    });
    assert.equal(w1.ok, true);
    assert.equal(w1.compacted, false);

    // Second write adds 3 more events -> total 5 > maxEvents(3) -> triggers compaction
    const w2 = await store.writeEvents({
      ref: R,
      events: [
        { k: 'ev:1', summary: 'one', updated_at: '2026-08-01T00:00:00Z' },
        { k: 'ev:2', summary: 'two', updated_at: '2026-09-15T00:00:00Z' },
        { k: 'ev:3', summary: 'three', updated_at: '2026-10-01T00:00:00Z' },
      ],
    });
    assert.equal(w2.ok, true);
    assert.equal(w2.compacted, true);
    assert.equal(w2.count, 3);

    const r2 = await store.readEvents({ ref: R });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.parents, [w1.sha], 'compaction commit retains tip as parent so CAS stays fast-forward');
    // Old tombstone dropped; oldest remaining ('ev:1') trimmed to cap at 3 newest
    assert.deepEqual(
      r2.events.map((e) => e.k),
      ['tombstone:recent', 'ev:2', 'ev:3'],
    );
  });

  it('rejects events containing secret patterns before writing and logs redacted entries to quarantine.jsonl', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-store-secrets-'));
    try {
      const store = createMemoryRefStore({
        repo: 'owner/repo',
        client: fake,
        sleep: async () => {},
      });

      const ghToken = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
      const awsKey = 'AKIAIOSFODNN7EXAMPLE';
      const pemKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA';
      const dbUrl = 'postgres://admin:supersecretpw@db.internal.example.com:5432/prod';

      const logs = [];
      const res = await store.writeEvents({
        ref: R,
        cacheDir: tmpDir,
        log: (m) => logs.push(m),
        events: [
          {
            k: 'clean:1',
            summary: 'normal finding about pointerScore weighting',
            updated_at: '2026-04-01T00:00:00Z',
          },
          {
            k: 'secret:gh',
            summary: `leaked token ${ghToken} in comment`,
            updated_at: '2026-04-01T01:00:00Z',
          },
          {
            k: 'secret:aws',
            summary: `aws key ${awsKey}`,
            updated_at: '2026-04-01T02:00:00Z',
          },
          {
            k: 'secret:pem',
            summary: pemKey,
            updated_at: '2026-04-01T03:00:00Z',
          },
          {
            k: 'secret:db',
            summary: `conn=${dbUrl}`,
            updated_at: '2026-04-01T04:00:00Z',
          },
        ],
      });

      assert.equal(res.ok, true);
      assert.equal(res.count, 1);
      assert.equal(res.rejected.length, 4);
      assert.equal(logs.length, 4);

      const stored = await store.readEvents({ ref: R });
      assert.deepEqual(
        stored.events.map((e) => e.k),
        ['clean:1'],
      );

      const qFile = path.join(tmpDir, 'quarantine.jsonl');
      assert.ok(fs.existsSync(qFile));
      const qRaw = fs.readFileSync(qFile, 'utf8');
      assert.ok(!qRaw.includes(ghToken), 'raw secret must never be written to quarantine.jsonl');
      assert.ok(!qRaw.includes('supersecretpw'), 'DB password must never be written to quarantine.jsonl');
      const qLines = qRaw.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(qLines.length, 4);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fetchMemoryRefs invokes git fetch with refs/engsys/memory/*:refs/engsys/memory/* (engsys v2.0.1 M4: no forced "+" refspec)', () => {
    const calls = [];
    const res = fetchMemoryRefs('/repo/root', {
      exec: (cmd, args) => {
        calls.push({ cmd, args });
        return '';
      },
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args, [
      '-C',
      '/repo/root',
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      MEMORY_FETCH_REFSPEC,
    ]);
    // The regression this guards: MEMORY_FETCH_REFSPEC must not start with '+' (forced), which
    // would make `git fetch` silently clobber a local ref tip instead of failing non-fast-forward.
    assert.equal(MEMORY_FETCH_REFSPEC.startsWith('+'), false);
    assert.equal(MEMORY_FETCH_REFSPEC, 'refs/engsys/memory/*:refs/engsys/memory/*');
  });

  it('mergeEvents and compactEvents unit behavior', () => {
    const merged = mergeEvents(
      [{ k: 'a', v: 1, updated_at: '2026-01-01T00:00:00Z' }],
      [{ k: 'a', v: 2, updated_at: '2026-01-02T00:00:00Z' }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].v, 2);

    const compacted = compactEvents(merged, { maxEvents: 10, tombstoneTtlDays: 180 });
    assert.equal(compacted.length, 1);
    assert.equal(scanTextForSecrets('no secrets here').matched, false);
    assert.equal(scanEventForSecrets({ k: 'a', summary: 'xoxb-1234567890-abcdef' }).matched, true);
  });

  describe('verifyMemoryRefTip (F5: fleet signatures; the consumer, ref-consumer.mjs, has its own tests)', () => {
    const { privateKey: ericKey } = crypto.generateKeyPairSync('ed25519');
    const { privateKey: markKey } = crypto.generateKeyPairSync('ed25519');
    const pubkeys = resolveFleetPubkeys({ fleet_memory_pubkeys: { eric: publicKeyB64(ericKey), 'mark-fleet': publicKeyB64(markKey) } });
    const TAIL = tailRef('merge', 'eric');
    const signerFor = (privateKey, fleet) => ({ ref, parent, content }) => signTip({ privateKey, fleet, ref, parent, content });
    const okExec = () => ''; // cat-file -e succeeds -> every path exists
    const reviewed = () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    async function writeAndRead({ ref = TAIL, signer, events, store } = {}) {
      const s = store || createMemoryRefStore({ repo: 'owner/repo', client: fakeGitApi({ repo: 'owner/repo' }), sleep: async () => {} });
      const w = await s.writeEvents({ ref, events, signer });
      assert.equal(w.ok, true, JSON.stringify(w));
      const tip = await s.readEvents({ ref });
      return { store: s, tip };
    }
    const ev = (k, extra = {}) => ({ k, kind: 'journal', updated_at: '2026-07-01T00:00:00Z', ...extra });

    it('the writer stores events.sig next to events.jsonl, and a tip signed by its own fleet verifies end to end', async () => {
      const { tip } = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a', { path: 'src/a.ts', author_kind: 'operator', author_id: 1 })] });
      assert.match(tip.sigText, /^engsys-memory-sig v1 fleet=eric ref=refs\/engsys\/memory\/fleet\/eric\/merge parent=none /);
      const res = await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0] ?? null, content: tip.content, sigText: tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec });
      assert.equal(res.ok, true);
      assert.equal(res.fleet, 'eric');
      assert.equal(res.events.length, 1);
      assert.equal(res.events[0].author_kind, 'fleet_signed', 'embedded author_kind is never trusted');
      assert.equal(res.events[0].author_id, null);
      assert.equal(res.events[0].signed_fleet, 'eric');
    });

    it('a second write signs over its parent; the first tip\'s signature does not carry over', async () => {
      const first = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a')] });
      const w = await first.store.writeEvents({ ref: TAIL, events: [ev('b', { updated_at: '2026-07-02T00:00:00Z' })], signer: signerFor(ericKey, 'eric') });
      assert.equal(w.ok, true);
      const tip = await first.store.readEvents({ ref: TAIL });
      assert.equal(tip.parents.length, 1);
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0], content: tip.content, sigText: tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).ok, true);
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0], content: tip.content, sigText: first.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).ok, false, 'the old signature does not verify the new tip');
    });

    it('an unsigned tip, a tip signed by another fleet, and replay onto another ref are all untrusted', async () => {
      const unsigned = await writeAndRead({ events: [ev('a')] });
      assert.equal(unsigned.tip.sigText, null);
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, content: unsigned.tip.content, sigText: unsigned.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).reason, 'missing_or_malformed_signature');
      // a forger with mark-fleet's key: it signs its own ref (it can't sign eric's) and relabels the line onto eric's
      const MARK_TAIL = tailRef('merge', 'mark-fleet');
      const forger = ({ parent, content }) => signTip({ privateKey: markKey, fleet: 'mark-fleet', ref: MARK_TAIL, parent, content }).replace(`ref=${MARK_TAIL}`, `ref=${TAIL}`);
      const byMark = await writeAndRead({ signer: forger, events: [ev('a')] });
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, content: byMark.tip.content, sigText: byMark.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).reason, 'fleet_mismatch');
      const signed = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a')] });
      assert.equal((await verifyMemoryRefTip('/repo', { ref: EVENTS_REF, parent: null, content: signed.tip.content, sigText: signed.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).reason, 'ref_mismatch');
    });

    it('per-fleet events (engsys#266): signed by the fleet it names verifies; another fleet\'s events ref does not take it', async () => {
      const ERIC_EVENTS = fleetEventsRef('eric');
      const own = await writeAndRead({ ref: ERIC_EVENTS, signer: signerFor(ericKey, 'eric'), events: [ev('a')] });
      assert.deepEqual((await verifyMemoryRefTip('/repo', { ref: ERIC_EVENTS, parent: null, content: own.tip.content, sigText: own.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).fleet, 'eric');
      const MARK_EVENTS = fleetEventsRef('mark-fleet');
      assert.equal((await verifyMemoryRefTip('/repo', { ref: MARK_EVENTS, parent: null, content: own.tip.content, sigText: own.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).ok, false, 'replay onto another fleet\'s events ref');
      const s = createMemoryRefStore({ repo: 'owner/repo', client: fakeGitApi({ repo: 'owner/repo' }), sleep: async () => {} });
      const w = await s.writeEvents({ ref: MARK_EVENTS, events: [ev('a')], signer: signerFor(ericKey, 'eric') });
      assert.equal(w.error?.code, 'sign_failed', 'a fleet\'s signer refuses another fleet\'s ref outright');
    });

    it('the commit\'s GitHub identity is not an input at all (web-flow commits every API-made commit)', async () => {
      const signed = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a')] });
      const res = await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, content: signed.tip.content, sigText: signed.tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec, publisherUserId: 1, fetchCommitIdentity: async () => { throw new Error('must not be called'); } });
      assert.equal(res.ok, true);
    });

    it('drops an event whose path does NOT exist in the independently reviewed tree, even from a verified tip', async () => {
      const signed = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a', { path: 'docs/agent-lessons/does-not-exist.md' })] });
      const res = await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, content: signed.tip.content, sigText: signed.tip.sigText, pubkeys, resolveSha: reviewed, exec: () => { throw new Error('cat-file: path not found'); } });
      assert.equal(res.ok, true);
      assert.deepEqual(res.events, []);
    });

    it('fails closed when no reviewed SHA can be resolved, or an input is missing', async () => {
      const signed = await writeAndRead({ signer: signerFor(ericKey, 'eric'), events: [ev('a')] });
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, content: signed.tip.content, sigText: signed.tip.sigText, pubkeys, resolveSha: () => null, exec: okExec })).reason, 'no_reviewed_sha');
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: null, sigText: signed.tip.sigText, pubkeys })).reason, 'missing_input');
    });

    it('an unchanged write is a no-op: no commit, no fence call, no API write (review W1)', async () => {
      const fake = fakeGitApi({ repo: 'owner/repo' });
      const s = createMemoryRefStore({ repo: 'owner/repo', client: fake, sleep: async () => {} });
      const signer = signerFor(ericKey, 'eric');
      let fenced = 0;
      const beforeCas = async () => { fenced++; return { held: true }; };
      const first = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer, beforeCas, replace: true });
      assert.equal(first.noop, false);
      const writes = [];
      for (const m of ['createBlob', 'createTree', 'createCommit', 'cas']) {
        const real = s.gitData[m];
        s.gitData[m] = async (...a) => { writes.push(m); return real(...a); };
      }
      for (let i = 0; i < 3; i++) {
        const again = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer, beforeCas, replace: true });
        assert.equal(again.ok, true);
        assert.equal(again.noop, true);
        assert.equal(again.sha, first.sha);
      }
      assert.deepEqual(writes, [], 'no Git Data write at all');
      assert.equal(fenced, 1, 'the fence ran only for the one real write');
      const merged = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer, beforeCas });
      assert.equal(merged.noop, true, 'a merge that adds nothing is a no-op too');
      const { privateKey: rotatedKey } = crypto.generateKeyPairSync('ed25519');
      const rotated = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer: signerFor(rotatedKey, 'eric'), beforeCas, replace: true });
      assert.equal(rotated.noop, false, 'after a key rotation the unchanged tip is re-signed with the new key, not skipped');
      const rewrite = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer: signerFor(markKey, 'mark-fleet'), beforeCas, replace: true });
      assert.equal(rewrite.error?.code, 'sign_failed', 'another fleet can\'t sign this fleet\'s tail at all (engsys#266), so it is never skipped as current either');
      const changed = await s.writeEvents({ ref: TAIL, events: [ev('b', { updated_at: '2026-07-02T00:00:00Z' })], signer, beforeCas, replace: true });
      assert.equal(changed.noop, false);
      const tip = await s.readEvents({ ref: TAIL });
      assert.deepEqual(tip.events.map((e) => e.k), ['b'], 'replace mirrors exactly the events given (the tail ref holds the current tail only)');
    });

    it('replace with no events empties a stale tail, re-signs after rotation, and is then a no-op', async () => {
      const s = createMemoryRefStore({ repo: 'owner/repo', client: fakeGitApi({ repo: 'owner/repo' }), sleep: async () => {} });
      const signer = signerFor(ericKey, 'eric');
      await s.writeEvents({ ref: TAIL, events: [ev('a')], signer, replace: true });
      const emptied = await s.writeEvents({ ref: TAIL, events: [], signer, replace: true });
      assert.equal(emptied.ok, true);
      assert.equal(emptied.noop, false, 'the stale tail is replaced');
      let tip = await s.readEvents({ ref: TAIL });
      assert.deepEqual(tip.events, []);
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0], content: tip.content, sigText: tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).ok, true, 'the empty tail is signed');
      assert.equal((await s.writeEvents({ ref: TAIL, events: [], signer, replace: true })).noop, true, 'an unchanged empty tail is a no-op');
      const { privateKey: rotatedKey } = crypto.generateKeyPairSync('ed25519');
      const resigned = await s.writeEvents({ ref: TAIL, events: [], signer: signerFor(rotatedKey, 'eric'), replace: true });
      assert.equal(resigned.noop, false, 'after rotation the empty tail is re-signed with the new key');
      tip = await s.readEvents({ ref: TAIL });
      const rotatedKeys = resolveFleetPubkeys({ fleet_memory_pubkeys: { eric: publicKeyB64(rotatedKey) } });
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0], content: tip.content, sigText: tip.sigText, pubkeys: rotatedKeys, resolveSha: reviewed, exec: okExec })).ok, true);
      assert.equal((await s.writeEvents({ ref: EVENTS_REF, events: [], signer })).noop, true, 'without replace, nothing to merge stays a no-op');
    });

    it('a lost CAS round re-signs over the new parent and re-asks the fence (review L7)', async () => {
      const fake = fakeGitApi({ repo: 'owner/repo' });
      const s = createMemoryRefStore({ repo: 'owner/repo', client: fake, sleep: async () => {} });
      const rival = createMemoryRefStore({ repo: 'owner/repo', client: fake, sleep: async () => {} });
      const seed = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer: signerFor(ericKey, 'eric') });
      const signedParents = [];
      const base = signerFor(ericKey, 'eric');
      const signer = (args) => { signedParents.push(args.parent); return base(args); };
      let fenced = 0;
      let rivalSha = null;
      const beforeCas = async () => {
        fenced++;
        if (fenced === 1) {
          // a concurrent writer moves the ref between our commit and our CAS: round 1 must lose
          const r = await rival.writeEvents({ ref: TAIL, events: [ev('r', { updated_at: '2026-07-03T00:00:00Z' })], signer: signerFor(ericKey, 'eric') });
          rivalSha = r.sha;
        }
        return { held: true };
      };
      const res = await s.writeEvents({ ref: TAIL, events: [ev('b', { updated_at: '2026-07-02T00:00:00Z' })], signer, beforeCas });
      assert.equal(res.ok, true);
      assert.equal(res.rounds, 2);
      assert.equal(fenced, 2, 'the fence is asked again for the retried update');
      assert.deepEqual(signedParents, [seed.sha, rivalSha], 'round 2 signs over the rival\'s commit, not the stale tip');
      const tip = await s.readEvents({ ref: TAIL });
      assert.deepEqual(tip.parents, [rivalSha]);
      assert.equal((await verifyMemoryRefTip('/repo', { ref: TAIL, parent: tip.parents[0], content: tip.content, sigText: tip.sigText, pubkeys, resolveSha: reviewed, exec: okExec })).ok, true);
      assert.deepEqual(tip.events.map((e) => e.k).sort(), ['a', 'b', 'r'], 'the rival\'s event is merged, not clobbered');
    });

    it('a signer that throws aborts the write with nothing moved', async () => {
      const s = createMemoryRefStore({ repo: 'owner/repo', client: fakeGitApi({ repo: 'owner/repo' }), sleep: async () => {} });
      const w = await s.writeEvents({ ref: TAIL, events: [ev('a')], signer: () => { throw new Error('no key'); } });
      assert.equal(w.ok, false);
      assert.equal(w.error.code, 'sign_failed');
      assert.equal((await s.readEvents({ ref: TAIL })).sha, null);
    });
  });
});
