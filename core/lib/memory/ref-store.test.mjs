import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGitApi } from '../lease/fixtures/fake-github.mjs';
import {
  EVENTS_REF,
  MEMORY_FETCH_REFSPEC,
  tailRef,
  fetchMemoryRefs,
  scanTextForSecrets,
  scanEventForSecrets,
  mergeEvents,
  compactEvents,
  createMemoryRefStore,
} from './ref-store.mjs';

describe('ref-store (#130)', () => {
  it('validates tailRef segments and rejects refs outside refs/engsys/memory/*', async () => {
    assert.equal(tailRef('dev', 'fleet-a'), 'refs/engsys/memory/dev/fleet-a');
    assert.throws(() => tailRef('../heads', 'main'), /invalid role/);
    assert.throws(() => tailRef('dev', 'a/b'), /invalid fleetId/);

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

  it('creates, reads, and updates refs/engsys/memory/events round-trip', async () => {
    const fake = fakeGitApi({ repo: 'owner/repo' });
    const store = createMemoryRefStore({
      repo: 'owner/repo',
      client: fake,
      sleep: async () => {},
    });

    // Empty ref before first write
    const initial = await store.readEvents();
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
    const w1 = await store.writeEvents({ events: [ev1] });
    assert.equal(w1.ok, true);
    assert.equal(w1.count, 1);
    assert.equal(w1.compacted, false);
    assert.ok(w1.sha);

    const r1 = await store.readEvents();
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
    const w2 = await store.writeEvents({ events: [ev1Updated, ev2] });
    assert.equal(w2.ok, true);
    assert.equal(w2.count, 2);
    assert.notEqual(w2.sha, w1.sha);

    const r2 = await store.readEvents();
    assert.equal(r2.ok, true);
    assert.equal(r2.events.length, 2);
    const byK = new Map(r2.events.map((e) => [e.k, e]));
    assert.equal(byK.get('pr:owner/repo#10').summary, 'updated PR summary');
    assert.equal(byK.get('issue:owner/repo#11').summary, 'issue summary');
    assert.deepEqual(r2.parents, [w1.sha]);
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
      events: [{ k: 'worker:a', summary: 'from writer A', updated_at: '2026-04-01T01:00:00Z' }],
    });

    assert.equal(wa.ok, true);
    assert.equal(wa.rounds, 2, 'writer A should win on round 2 after re-reading and re-merging');

    const finalState = await seeder.readEvents();
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
      events: [
        { k: 'ev:1', summary: 'one', updated_at: '2026-08-01T00:00:00Z' },
        { k: 'ev:2', summary: 'two', updated_at: '2026-09-15T00:00:00Z' },
        { k: 'ev:3', summary: 'three', updated_at: '2026-10-01T00:00:00Z' },
      ],
    });
    assert.equal(w2.ok, true);
    assert.equal(w2.compacted, true);
    assert.equal(w2.count, 3);

    const r2 = await store.readEvents();
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

      const stored = await store.readEvents();
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

  it('fetchMemoryRefs invokes git fetch with +refs/engsys/memory/*:refs/engsys/memory/*', () => {
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
});
