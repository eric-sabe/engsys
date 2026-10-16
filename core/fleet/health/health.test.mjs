// health.test.mjs — Comprehensive unit and integration tests for Fleet Health Desk (#97, #98, #99, #100).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRegistry,
  validateRegistry,
  topologicalOrder,
} from './registry.mjs';
import {
  evaluateStatuspageJson,
  probeStatuspage,
  evaluateObservedRecords,
  probeHttpHealth,
  probeSyntheticCommand,
} from './adapters.mjs';
import {
  evaluateServiceTransition,
  runEngineTick,
  simulateServiceState,
} from './engine.mjs';
import {
  sanitizeSymptom,
  submitReport,
  ingestCrossFleetReport,
  correlateReports,
  syncIncidentsWithEngineState,
  computeDigest,
} from './incidents.mjs';
import {
  renderBoardBlock,
  parseBoardBlock,
  updateIssueBodyWithBoard,
  fetchBoardCached,
  notifyTransitions,
} from './board.mjs';
import { runCli } from './cli.mjs';

function makeTmpDir(prefix = 'fhd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SAMPLE_YAML = `
version: 1
board:
  repo: acme/app
  issue: 42
  stale_minutes: 30
services:
  github-api:
    name: "GitHub API"
    kind: external
    observability: central
    probe:
      adapter: statuspage
      tier: passive
      url: "https://www.githubstatus.com/api/v2/summary.json"
      components: ["API Requests"]
    poll_seconds: 60
    thresholds:
      trip_fails: 2
      recover_clean: 2
    impact:
      hold_merges: true
      advice: "Hold merges and pause claims until GitHub API recovers."
    invoke:
      command: "echo pong"
      allow_args: true
    runbook: "Hold merges and pause claims until GitHub API recovers."
  github-actions:
    name: "GitHub Actions"
    kind: external
    observability: central
    probe:
      adapter: statuspage
      tier: passive
      url: "https://www.githubstatus.com/api/v2/summary.json"
      components: ["Actions"]
    poll_seconds: 120
    thresholds:
      trip_fails: 2
      recover_clean: 2
    depends_on: [github-api]
    impact:
      hold_merges: true
      advice: "Hold merges while Actions runners are degraded."
    runbook: "Hold merges while Actions runners are degraded."
  aks-staging:
    name: "AKS Staging"
    kind: internal
    observability: central
    probe:
      adapter: synthetic-command
      tier: on-ambiguity
      command: "kubectl get nodes"
      auth_check: "kubectl config current-context"
    poll_seconds: 180
    thresholds:
      trip_fails: 2
      recover_clean: 1
    impact:
      hold_merges: false
      advice: "Check staging cluster health."
    runbook: "Check staging cluster health."
`;

describe('P1-A (#97): Registry schema, YAML parser, and DAG validation', () => {
  test('parses valid fleet-health.yml and produces topological order', () => {
    const reg = parseRegistry(SAMPLE_YAML);
    assert.equal(reg.version, 1);
    assert.equal(reg.board.issue, 42);
    assert.ok(reg.services['github-api']);
    assert.ok(reg.services['github-actions']);
    assert.deepEqual(reg.services['github-actions'].depends_on, ['github-api']);

    const order = topologicalOrder(reg.services);
    assert.ok(order.indexOf('github-api') < order.indexOf('github-actions'));
  });

  test('detects dependency cycles in depends_on', () => {
    const cyclic = {
      version: 1,
      services: {
        'svc-a': { probe: { adapter: 'observed' }, depends_on: ['svc-b'] },
        'svc-b': { probe: { adapter: 'observed' }, depends_on: ['svc-a'] },
      },
    };
    assert.throws(() => validateRegistry(cyclic), /depends_on cycle detected/);
  });

  test('rejects PUSH_OVERRIDE in impact or runbook fields', () => {
    const forbidden = {
      version: 1,
      services: {
        svcA: {
          probe: { adapter: 'observed' },
          runbook: 'Use PUSH_OVERRIDE to bypass checks',
        },
      },
    };
    assert.throws(() => validateRegistry(forbidden), /PUSH_OVERRIDE/);
  });
});

describe('P1-A (#97): Probe adapters (statuspage, observed, http-health, synthetic-command)', () => {
  test('statuspage adapter maps indicators, filters components, and handles 304 ETag cache', async () => {
    const probeCfg = {
      adapter: 'statuspage',
      url: 'https://status.example.com/api/v2/summary.json',
      components: ['API Requests'],
    };

    let calls = 0;
    const mockFetch = async (_url, opts) => {
      calls++;
      if (opts.headers['If-None-Match'] === '"etag-1"') {
        return { status: 304, ok: false, headers: { get: () => '"etag-1"' } };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"etag-1"' : null) },
        json: async () => ({
          status: { indicator: 'none', description: 'All Systems Operational' },
          components: [
            { name: 'API Requests', status: 'degraded_performance' },
            { name: 'Pages', status: 'major_outage' },
          ],
        }),
      };
    };

    const first = await probeStatuspage(probeCfg, { fetchFn: mockFetch });
    assert.equal(first.status, 'degraded');
    assert.equal(first.etag, '"etag-1"');

    const second = await probeStatuspage(probeCfg, {
      cached: { etag: first.etag, lastResult: first },
      fetchFn: mockFetch,
    });
    assert.equal(second.status, 'degraded');
    assert.equal(second.notModified, true);
    assert.equal(calls, 2);
  });

  test('broken statuspage probe (HTTP 500 or malformed JSON) returns unknown, never healthy', async () => {
    const probeCfg = {
      adapter: 'statuspage',
      url: 'https://status.example.com/api/v2/summary.json',
    };
    const res500 = await probeStatuspage(probeCfg, {
      fetchFn: async () => ({ status: 500, ok: false, headers: { get: () => null } }),
    });
    assert.equal(res500.status, 'unknown');

    const resBadJson = evaluateStatuspageJson('not-json');
    assert.equal(resBadJson.status, 'unknown');

    const resEmptyObj = evaluateStatuspageJson({});
    assert.equal(resEmptyObj.status, 'unknown');
  });

  test('observed adapter evaluates rolling window failure rates and consecutive failures', () => {
    const now = new Date('2026-10-15T18:00:00Z');
    const probeCfg = {
      window_minutes: 30,
      degraded_consecutive: 2,
      down_consecutive: 4,
    };

    const recordsDeg = [
      { timestamp: '2026-10-15T17:55:00Z', ok: true },
      { timestamp: '2026-10-15T17:58:00Z', ok: false },
      { timestamp: '2026-10-15T17:59:00Z', ok: false },
    ];
    assert.equal(evaluateObservedRecords(recordsDeg, probeCfg, { now }).status, 'degraded');

    const recordsDown = [
      ...recordsDeg,
      { timestamp: '2026-10-15T17:59:10Z', ok: false },
      { timestamp: '2026-10-15T17:59:20Z', ok: false },
    ];
    assert.equal(evaluateObservedRecords(recordsDown, probeCfg, { now }).status, 'down');
  });

  test('synthetic-command splits host-local missing auth/context from vendor outage', () => {
    const probeCfg = {
      adapter: 'synthetic-command',
      command: 'kubectl get nodes',
      auth_check: 'kubectl config current-context',
    };

    // Auth check fails -> status is 'healthy' with authLocalFailure: true (not vendor 'down')
    const localFail = probeSyntheticCommand(probeCfg, {
      execFn: () => {
        const err = new Error('current-context is not set');
        err.status = 1;
        err.stderr = 'error: current-context is not set';
        throw err;
      },
    });
    assert.equal(localFail.status, 'healthy');
    assert.equal(localFail.authLocalFailure, true);

    // Auth check passes, probe command fails with server error -> vendor 'down'
    let callIdx = 0;
    const vendorFail = probeSyntheticCommand(probeCfg, {
      execFn: () => {
        callIdx++;
        if (callIdx === 1) return 'staging-context\n';
        const err = new Error('Unable to connect to the server: dial tcp timeout');
        err.status = 1;
        err.stderr = 'Unable to connect to the server: dial tcp timeout';
        throw err;
      },
    });
    assert.equal(vendorFail.status, 'down');
    assert.ok(!vendorFail.authLocalFailure);
  });

  test('http-health maps 200->healthy, 429->degraded, 503->down, 401->authLocalFailure', async () => {
    const cfg = { url: 'https://api.example.com/health' };
    const r200 = await probeHttpHealth(cfg, { fetchFn: async () => ({ status: 200 }) });
    assert.equal(r200.status, 'healthy');

    const r429 = await probeHttpHealth(cfg, { fetchFn: async () => ({ status: 429 }) });
    assert.equal(r429.status, 'degraded');

    const r503 = await probeHttpHealth(cfg, { fetchFn: async () => ({ status: 503 }) });
    assert.equal(r503.status, 'down');

    const r401 = await probeHttpHealth(cfg, { fetchFn: async () => ({ status: 401 }) });
    assert.equal(r401.status, 'healthy');
    assert.equal(r401.authLocalFailure, true);
  });
});

describe('P1-A (#97): Hysteresis state machine & dependency DAG suppression', () => {
  test('asymmetric hysteresis requires trip_fails to trip and recover_clean + statuspageGateResult to recover', () => {
    const svc = {
      id: 'github-api',
      thresholds: { trip_fails: 2, recover_clean: 2 },
      impact: { hold_merges: true, advice: 'Hold merges' },
    };

    // 1st failure: stays 'healthy'
    const step1 = evaluateServiceTransition(
      { state: 'healthy', consecutive_fails: 0, consecutive_clean: 0 },
      { status: 'down', detail: 'major outage' },
      svc,
    );
    assert.equal(step1.state, 'healthy');
    assert.equal(step1.consecutive_fails, 1);

    // 2nd consecutive failure: trips to 'down'
    const step2 = evaluateServiceTransition(
      step1,
      { status: 'down', detail: 'major outage' },
      svc,
    );
    assert.equal(step2.state, 'down');
    assert.equal(step2.hold_merges, true);

    // 1st clean probe: still 'down' (recover_clean = 2)
    const step3 = evaluateServiceTransition(
      step2,
      { status: 'healthy', detail: 'operational' },
      svc,
    );
    assert.equal(step3.state, 'down');
    assert.equal(step3.consecutive_clean, 1);

    // 2nd clean probe, but statuspageGateResult is degraded -> held in 'down'
    const step4Held = evaluateServiceTransition(
      step3,
      { status: 'healthy', detail: 'local ok' },
      svc,
      { statuspageGateResult: { status: 'degraded' } },
    );
    assert.equal(step4Held.state, 'down');

    // 2nd clean probe with statuspageGateResult healthy -> recovers to 'healthy'
    const step4Recovered = evaluateServiceTransition(
      step3,
      { status: 'healthy', detail: 'operational' },
      svc,
      { statuspageGateResult: { status: 'healthy' } },
    );
    assert.equal(step4Recovered.state, 'healthy');
  });

  test('broken probe (unknown) preserves last_known_state', () => {
    const svc = { id: 'github-api', thresholds: { trip_fails: 2, recover_clean: 2 } };
    const prev = { state: 'degraded', consecutive_fails: 2, consecutive_clean: 0, last_known_state: 'degraded' };
    const next = evaluateServiceTransition(prev, { status: 'unknown', detail: 'HTTP 500' }, svc);
    assert.equal(next.state, 'unknown');
    assert.equal(next.last_known_state, 'degraded');
  });

  test('depends_on DAG suppresses downstream service when upstream is degraded/down', async () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const customAdapters = {
        statuspage: async () => ({ status: 'down', detail: 'outage' }),
      };

      // Tick 1: consecutive_fails = 1
      await runEngineTick(reg, { stateDir: tmp, customAdapters, force: true });
      // Tick 2: trips both github-api and github-actions, but github-actions is suppressed_by github-api
      const tick2 = await runEngineTick(reg, { stateDir: tmp, customAdapters, force: true });

      assert.equal(tick2.state.services['github-api'].state, 'down');
      assert.equal(tick2.state.services['github-api'].suppressed_by, null);
      assert.equal(tick2.state.services['github-actions'].state, 'down');
      assert.equal(tick2.state.services['github-actions'].suppressed_by, 'github-api');
      assert.match(tick2.state.services['github-actions'].root_cause, /github-actions down because github-api is down/);

      const actionsTransition = tick2.transitions.find((t) => t.service === 'github-actions');
      assert.equal(actionsTransition?.suppressed_by, 'github-api');
      assert.ok(!tick2.events.some((e) => e.includes('github-actions')), 'suppressed service does not emit bus alarm');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('P1-B (#98): Status board rendering, ETag caching, and transition notifications', () => {
  test('renders and parses board block with UTC + operator time and refuses duplicate markers', () => {
    const reg = parseRegistry(SAMPLE_YAML);
    const engineState = {
      updated_at: '2026-10-15T18:00:00Z',
      services: {
        'github-api': {
          state: 'down',
          since: '2026-10-15T17:55:00Z',
          detail: 'Major outage',
          hold_merges: true,
          advice: 'Hold merges and pause claims until GitHub API recovers.',
        },
        'github-actions': {
          state: 'down',
          since: '2026-10-15T17:55:00Z',
          suppressed_by: 'github-api',
          root_cause: 'github-actions down because github-api is down',
        },
      },
    };
    const env = { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' };
    const block = renderBoardBlock(reg, engineState, {}, { env, now: new Date('2026-10-15T18:00:00Z') });

    assert.ok(block.includes('<!-- fleet-health -->'));
    assert.ok(block.includes('<!-- /fleet-health -->'));
    assert.ok(block.includes('2026-10-15T18:00:00Z'));
    assert.ok(block.includes('EDT'));

    const parsed = parseBoardBlock(`# Issue header\n\n${block}\n\nFooter text.`);
    assert.equal(parsed.services['github-api'].state, 'down');
    assert.equal(parsed.services['github-api'].hold_merges, true);
    assert.equal(parsed.services['github-actions'].suppressed_by, 'github-api');
    assert.equal(parsed.services['github-actions'].hold_merges, false);

    const merged = updateIssueBodyWithBoard('# Issue title\n\nKeep this prose.', block);
    assert.ok(merged.startsWith('# Issue title\n\nKeep this prose.\n\n<!-- fleet-health -->'));

    assert.throws(
      () => updateIssueBodyWithBoard(`${block}\n${block}`, block),
      /Refusing to update issue body/,
    );
  });

  test('fetchBoardCached uses conditional If-None-Match ETag and handles 304 Not Modified', () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const block = renderBoardBlock(reg, { updated_at: '2026-10-15T18:00:00Z', services: {} }, {});
      const cacheFile = path.join(tmp, 'fhd', 'board-cache.json');

      const seenArgs = [];
      const gh200 = (args) => {
        seenArgs.push(args);
        return [
          'HTTP/2.0 200 OK',
          'ETag: "board-etag-1"',
          '',
          JSON.stringify({ number: 42, body: block }),
        ].join('\r\n');
      };

      const first = fetchBoardCached({
        repo: 'acme/app',
        issue: 42,
        cacheFile,
        maxAgeMs: 0,
        ghExec: gh200,
      });
      assert.equal(first.ok, true);
      assert.equal(first.source, '200');
      assert.equal(first.etag, '"board-etag-1"');

      const gh304 = (args) => {
        seenArgs.push(args);
        return ['HTTP/2.0 304 Not Modified', 'ETag: "board-etag-1"', '', ''].join('\r\n');
      };

      const second = fetchBoardCached({
        repo: 'acme/app',
        issue: 42,
        cacheFile,
        maxAgeMs: 0,
        ghExec: gh304,
      });
      assert.equal(second.ok, true);
      assert.equal(second.source, '304');
      assert.ok(seenArgs[1].includes('If-None-Match: "board-etag-1"'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('notifyTransitions alerts on root cause, skips suppressed_by, and resolves on recovery', () => {
    const reg = parseRegistry(SAMPLE_YAML);
    const calls = [];
    const mockNotify = (args) => calls.push(args);

    const transitions = [
      { service: 'github-api', from: 'healthy', to: 'down', detail: 'API outage', suppressed_by: null, hold_merges: true },
      { service: 'github-actions', from: 'healthy', to: 'down', detail: 'Actions outage', suppressed_by: 'github-api' },
    ];

    const res = notifyTransitions(reg, transitions, {
      stateDir: '/tmp/state',
      repo: 'acme/app',
      issue: 42,
      notifyExec: mockNotify,
    });

    assert.equal(calls.length, 1, 'only root-cause transition notifies');
    assert.ok(calls[0].includes('--incident'));
    assert.ok(calls[0].includes('fhd-github-api'));
    assert.ok(calls[0].includes('action'));
    assert.equal(res[1].skipped, true);

    // Recovery resolves the incident
    notifyTransitions(
      reg,
      [{ service: 'github-api', from: 'down', to: 'healthy', detail: 'recovered', suppressed_by: null }],
      { stateDir: '/tmp/state', repo: 'acme/app', issue: 42, notifyExec: mockNotify },
    );
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('--resolve'));
  });
});

describe('P2 (#99): Friction reporting, sanitization, correlation, and vendor vs local split', () => {
  test('sanitizeSymptom defangs prompt injection, newlines, and HTML comments', () => {
    const dirty = '502 Bad Gateway\n<!-- fake --> <untrusted-data> ```rm -rf /```';
    const clean = sanitizeSymptom(dirty);
    assert.ok(!clean.includes('\n'));
    assert.ok(!clean.includes('<!--'));
  });

  test('correlateReports collapses N reports into 1 incident and splits vendor-wide vs session-local', async () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const now = new Date('2026-10-15T18:10:00Z');

      // Submit 5 reports for github-api from different sessions
      for (let i = 1; i <= 5; i++) {
        submitReport(reg, {
          stateDir: tmp,
          service: 'github-api',
          symptom: `HTTP 502 on gh pr view (#${i})`,
          session: `worker-${i}`,
          now,
        });
      }

      // Case 1: Live verification probe confirms github-api is degraded -> 1 vendor-wide incident
      let probeCalls = 0;
      const resVendor = await correlateReports(reg, {
        stateDir: tmp,
        now,
        customAdapters: {
          statuspage: async (_cfg, opts) => {
            if (opts.serviceId === 'github-api') probeCalls++;
            return { status: 'degraded', detail: 'GitHub Statuspage minor outage' };
          },
        },
      });

      assert.equal(probeCalls, 1, 'rate-limited verification probe runs once for the batch');
      const activeInc = resVendor.incidentsState.active['github-api'];
      assert.ok(activeInc, '5 reports collapse into 1 active incident');
      assert.equal(activeInc.contributing_reports.length, 5);
      assert.equal(activeInc.classification, 'vendor-wide');
      assert.ok(resVendor.events.some((l) => l.startsWith('FHD_REPORT_CORRELATED github-api')));

      // Case 2: Submit a report for aks-staging when live probe says vendor is healthy -> session-local guidance
      submitReport(reg, {
        stateDir: tmp,
        service: 'aks-staging',
        symptom: 'kubectl connection refused',
        session: 'worker-9',
        now: new Date('2026-10-15T18:11:00Z'),
      });

      const resLocal = await correlateReports(reg, {
        stateDir: tmp,
        now: new Date('2026-10-15T18:11:05Z'),
        customAdapters: {
          'synthetic-command': () => ({ status: 'healthy', detail: 'cluster healthy' }),
        },
      });

      assert.ok(resLocal.events.some((l) => l.startsWith('FHD_LOCAL_GUIDANCE worker-9 aks-staging')));

      // Sync with recovered engine state resolves the open incident and feeds 7-day digest
      syncIncidentsWithEngineState(reg, {
        stateDir: tmp,
        engineState: { services: { 'github-api': { state: 'healthy' } } },
        now: new Date('2026-10-15T18:25:00Z'),
      });

      const digest = computeDigest(reg, {
        stateDir: tmp,
        days: 7,
        now: new Date('2026-10-15T19:00:00Z'),
      });
      assert.equal(digest.services['github-api'].vendor_wide_incidents, 1);
      assert.equal(digest.services['github-api'].mttr_minutes, 15);
      assert.equal(digest.services['aks-staging'].session_local_reports, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ingestCrossFleetReport parses and sanitizes FHD_REPORT lines', () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const msg = 'FHD_REPORT service=github-api session=remote-1 symptom="503 error <!-- html -->"';
      const out = ingestCrossFleetReport(reg, {
        stateDir: tmp,
        body: msg,
        fromFleet: 'eu-west',
      });
      assert.ok(out);
      assert.equal(out.report.service, 'github-api');
      assert.equal(out.report.fleet, 'eu-west');
      assert.ok(!out.report.symptom.includes('<!--'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('P3 (#100): CLI subcommands (simulate, watch-add, watch-remove, invoke, self-probe)', () => {
  test('watch-add refuses observability=red and scaffolds 9-question spec for green/yellow', async () => {
    const codeRed = await runCli(['watch-add', 'legacy-vpn', '--observability', 'red', '--json']);
    assert.equal(codeRed, 1);

    const codeGreen = await runCli([
      'watch-add',
      'azure-openai',
      '--observability',
      'green',
      '--adapter',
      'http-health',
      '--url',
      'https://status.azure.com/health',
      '--json',
    ]);
    assert.equal(codeGreen, 0);
  });

  test('simulate, check, self-probe, invoke, and watch-remove work end-to-end', async () => {
    const tmp = makeTmpDir();
    try {
      const cfgFile = path.join(tmp, 'fleet-health.yml');
      fs.writeFileSync(cfgFile, SAMPLE_YAML, 'utf8');

      // Validate
      assert.equal(await runCli(['validate', '--file', cfgFile, '--json']), 0);

      // Simulate github-api down
      assert.equal(
        await runCli(['simulate', 'github-api', '--state', 'down', '--file', cfgFile, '--state-dir', tmp, '--json']),
        0,
      );

      // Check github-api returns exit code 3 (down)
      assert.equal(
        await runCli(['check', 'github-api', '--file', cfgFile, '--state-dir', tmp, '--json']),
        3,
      );

      // Self-probe passes because board was just updated
      assert.equal(
        await runCli(['self-probe', '--file', cfgFile, '--state-dir', tmp, '--json']),
        0,
      );

      // Invoke configured command on github-api returns exit 0
      assert.equal(
        await runCli(['invoke', 'github-api', '--file', cfgFile, '--json']),
        0,
      );

      // watch-remove refuses removing github-api because github-actions depends on it
      assert.equal(
        await runCli(['watch-remove', 'github-api', '--file', cfgFile, '--json']),
        1,
      );

      // watch-remove allows removing github-actions (no reverse dependencies)
      assert.equal(
        await runCli(['watch-remove', 'github-actions', '--file', cfgFile, '--json']),
        0,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
