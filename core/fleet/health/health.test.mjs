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
  resolveRegistryFile,
} from './registry.mjs';
import { PROBE_KINDS, INVOKE_KINDS, scrubEnv } from './probe-kinds.mjs';
import {
  evaluateStatuspageJson,
  probeStatuspage,
  evaluateObservedRecords,
  probeHttpHealth,
  probeSyntheticCommand,
} from './adapters.mjs';
import {
  evaluateServiceTransition,
  loadEngineState,
  runEngineTick,
  simulateServiceState,
} from './engine.mjs';
import {
  sanitizeSymptom,
  submitReport,
  ingestCrossFleetReport,
  correlateReports,
  syncIncidentsWithEngineState,
  loadIncidentsState,
  readReports,
  computeDigest,
} from './incidents.mjs';
import {
  renderBoardBlock,
  parseBoardBlock,
  updateIssueBodyWithBoard,
  fetchBoardCached,
  applyBoardToGitHub,
  notifyTransitions,
} from './board.mjs';
import { runCli } from './cli.mjs';

function makeTmpDir(prefix = 'fhd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A GraphQL board-issue response whose last edit was by numeric user `editorId`. */
function trustedRevision(body, editorId, { edited = true } = {}) {
  const actor = { __typename: 'Bot', databaseId: editorId };
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          body,
          lastEditedAt: edited ? '2026-10-15T18:00:00Z' : null,
          editor: edited ? actor : null,
          author: edited ? { __typename: 'User', databaseId: 1 } : actor,
        },
      },
    },
  });
}

/** Run `fn` with `vars` overlaid on process.env (undefined deletes), restoring afterwards. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The env keys the CLI's registry/state resolution reads, cleared so the host's own never leak in. */
const CLEAN_FLEET_ENV = {
  FLEET_STATE: undefined,
  FLEET_INSTANCE: undefined,
  FLEET_HEALTH_FILE: undefined,
  ENGSYS_FHD_REGISTRY: undefined,
  ENGSYS_FHD_STATE_DIR: undefined,
  ENGSYS_FHD_BOARD_CACHE: undefined,
  ENGSYS_FHD_BOARD_ISSUE: undefined,
  FLEET_INSTANCE_REPO: undefined,
};
// Hermetic: this file runs in its own process, so drop the host's fleet identity and paths up front.
for (const k of [...Object.keys(CLEAN_FLEET_ENV), 'FLEET_ID', 'ENGSYS_SESSION']) delete process.env[k];

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
      kind: gh-run-list
      params: { status: queued, limit: 5 }
      requires_gate: false
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
      check: gh-api-get
      params: { path: /rate_limit }
      auth_check: { check: gh-auth-status, params: { hostname: github.com } }
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
      check: 'gh-api-get',
      params: { path: '/rate_limit' },
      auth_check: 'gh-auth-status',
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
        if (args[1] === 'graphql') return trustedRevision(block, 7);
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
        trustedEditorIds: [7],
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
        trustedEditorIds: [7],
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
    await withEnv({ ...CLEAN_FLEET_ENV, FLEET_STATE: tmp }, async () => {
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

      // Invoke without an approved gate is refused even though the entry says requires_gate: false
      assert.equal(
        await runCli(['invoke', 'github-api', '--file', cfgFile, '--json'], {
          execFile: () => assert.fail('nothing may run without the gate'),
        }),
        1,
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

  test('docs/fleet-health-desk.md YAML example validates cleanly and preserves name and impact booleans', () => {
    const docPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../docs/fleet-health-desk.md');
    const docText = fs.readFileSync(docPath, 'utf8');
    const yamlMatch = /```yaml\n([\s\S]*?)```/.exec(docText);
    assert.ok(yamlMatch, 'docs/fleet-health-desk.md must contain a yaml snippet');
    const reg = parseRegistry(yamlMatch[1]);
    assert.equal(reg.services['github-api'].name, 'GitHub API');
    assert.equal(reg.services['github-api'].impact.pause_claims, true);
    assert.equal(reg.services['github-api'].impact.dispatch_warn, true);
    assert.equal(reg.services['github-actions'].invoke.requires_gate, true);
    assert.equal(reg.services['github-actions'].invoke.kind, 'gh-run-list');
  });

  test('expired simulation resumes live probes immediately instead of turning unknown, and unsuppressed downstream outage alarms on upstream recovery', async () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const t0 = new Date('2026-10-15T18:00:00Z');
      // Simulate github-api down with 10-minute TTL
      await simulateServiceState(reg, {
        stateDir: tmp,
        serviceId: 'github-api',
        targetState: 'down',
        ttlMinutes: 10,
        now: t0,
        customAdapters: {
          statuspage: async (_cfg, opts) =>
            opts.serviceId === 'github-actions'
              ? { status: 'down', detail: 'Actions still down' }
              : { status: 'healthy', detail: 'All systems operational' },
        },
      });

      // Tick again while github-api is simulated down so github-actions trips (trip_fails: 2) while suppressed_by github-api
      const tickSuppressed = await runEngineTick(reg, {
        stateDir: tmp,
        force: true,
        now: new Date('2026-10-15T18:01:00Z'),
        customAdapters: {
          statuspage: async (_cfg, opts) =>
            opts.serviceId === 'github-actions'
              ? { status: 'down', detail: 'Actions still down' }
              : { status: 'healthy', detail: 'All systems operational' },
        },
      });
      assert.equal(tickSuppressed.state.services['github-actions'].state, 'down');
      assert.equal(tickSuppressed.state.services['github-actions'].suppressed_by, 'github-api');

      // Advance past the 10-minute simulation TTL (without force: true!) -> github-api simulation expires and probes live healthy,
      // while github-actions stays down and becomes unsuppressed (suppressed_by: null), firing FHD_TRIP!
      let apiProbed = 0;
      const tickAfterExpiry = await runEngineTick(reg, {
        stateDir: tmp,
        now: new Date('2026-10-15T18:15:00Z'),
        customAdapters: {
          statuspage: async (_cfg, opts) => {
            if (opts.serviceId === 'github-api') {
              apiProbed++;
              return { status: 'healthy', detail: 'API operational' };
            }
            return { status: 'down', detail: 'Actions still down' };
          },
        },
      });
      assert.equal(apiProbed, 1, 'expired simulation triggers immediate live probe');
      assert.notEqual(tickAfterExpiry.state.services['github-api'].state, 'unknown');

      // One more clean tick completes recover_clean: 2 for github-api
      const tickRecovered = await runEngineTick(reg, {
        stateDir: tmp,
        force: true,
        now: new Date('2026-10-15T18:16:00Z'),
        customAdapters: {
          statuspage: async (_cfg, opts) =>
            opts.serviceId === 'github-api'
              ? { status: 'healthy', detail: 'API operational' }
              : { status: 'down', detail: 'Actions still down' },
        },
      });
      assert.equal(tickRecovered.state.services['github-api'].state, 'healthy');
      assert.equal(tickRecovered.state.services['github-actions'].state, 'down');
      assert.equal(tickRecovered.state.services['github-actions'].suppressed_by, null);
      assert.ok(
        tickRecovered.events.some((e) => e.startsWith('FHD_TRIP github-actions down')),
        'newly unsuppressed downstream outage emits FHD_TRIP',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('board escapes HTML comment terminators in probe detail and applyBoardToGitHub skips unchanged fingerprints', () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const engineState = {
        updated_at: '2026-10-15T18:00:00Z',
        services: {
          'github-api': {
            state: 'degraded',
            since: '2026-10-15T17:55:00Z',
            detail: 'upstream error --> <!-- injected comment -->',
          },
        },
      };
      const block1 = renderBoardBlock(reg, engineState, {}, { now: new Date('2026-10-15T18:00:00Z') });
      const parsed = parseBoardBlock(block1);
      assert.equal(parsed.services['github-api'].state, 'degraded');

      let editCalls = 0;
      let storedIssueBody = '# Fleet Status\n';
      const mockExec = (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'api') {
          return JSON.stringify({ number: 42, body: storedIssueBody });
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
          editCalls++;
          const bfIdx = args.indexOf('--body-file');
          storedIssueBody = fs.readFileSync(args[bfIdx + 1], 'utf8');
          return '';
        }
        return '';
      };

      const pub1 = applyBoardToGitHub({
        repo: 'acme/app',
        issue: 42,
        stateDir: tmp,
        renderedBlock: block1,
        fence: false,
        now: new Date('2026-10-15T18:00:00Z'),
        execFn: mockExec,
      });
      assert.equal(pub1.updated, true);
      assert.equal(editCalls, 1);

      // Render a block 30s later with the same service states (different timestamp) -> must skip edit!
      const block2 = renderBoardBlock(
        reg,
        { ...engineState, updated_at: '2026-10-15T18:00:30Z' },
        {},
        { now: new Date('2026-10-15T18:00:30Z') },
      );
      const pub2 = applyBoardToGitHub({
        repo: 'acme/app',
        issue: 42,
        stateDir: tmp,
        renderedBlock: block2,
        fence: false,
        now: new Date('2026-10-15T18:00:30Z'),
        execFn: mockExec,
      });
      assert.equal(pub2.updated, false);
      assert.equal(pub2.reason, 'unchanged-fingerprint');
      assert.equal(editCalls, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('correlateReports persists corroborated state to disk and preserves concurrent reports submitted during probe', async () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const now = new Date('2026-10-15T18:10:00Z');
      submitReport(reg, {
        stateDir: tmp,
        service: 'github-api',
        symptom: 'HTTP 502 on first call',
        session: 'worker-1',
        now,
      });

      // Probe returns degraded (consecutive_fails=1 < trip_fails=2) AND a second report arrives concurrently during the probe
      await correlateReports(reg, {
        stateDir: tmp,
        now,
        customAdapters: {
          statuspage: async () => {
            submitReport(reg, {
              stateDir: tmp,
              service: 'github-actions',
              symptom: 'Concurrent report during probe',
              session: 'worker-2',
              now,
            });
            return { status: 'degraded', detail: 'Minor outage' };
          },
        },
      });

      // Reload engine state from disk and run syncIncidentsWithEngineState (just like cmdTick does)
      const persistedEngine = loadEngineState(tmp, now);
      assert.equal(persistedEngine.services['github-api'].state, 'degraded');
      const syncedInc = syncIncidentsWithEngineState(reg, {
        stateDir: tmp,
        engineState: persistedEngine,
        now,
      });
      assert.ok(syncedInc.active['github-api'], 'corroborated incident stays active after sync');

      // Concurrent report submitted during the probe was NOT dropped
      const allReps = readReports(tmp);
      const concurrentRep = allReps.find((r) => r.service === 'github-actions');
      assert.ok(concurrentRep, 'concurrent report submitted during verification probe is preserved');
      assert.equal(concurrentRep.processed, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Trust boundary (engsys v2.0.1): registry location, probe execution, gates, board editors', () => {
  const MINI = 'version: 1\nservices:\n  svc-a:\n    probe: { adapter: observed }\n';

  test('a registry in the working tree or its .claude/ is never resolved; one in the fleet roots is', () => {
    const repo = makeTmpDir('fhd-repo-');
    const instance = makeTmpDir('fhd-instance-');
    try {
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'fleet-health.yml'), MINI);
      fs.writeFileSync(path.join(repo, '.claude', 'fleet-health.yml'), MINI);
      const planted = path.join(repo, 'fleet-health.yml');

      // No fleet env, a relative FLEET_STATE, and explicit pointers into the repo: all refused.
      assert.equal(resolveRegistryFile({}), null);
      assert.equal(resolveRegistryFile({ FLEET_STATE: '.fleet' }), null);
      assert.equal(resolveRegistryFile({ FLEET_HEALTH_FILE: planted }), null);
      assert.equal(resolveRegistryFile({ ENGSYS_FHD_REGISTRY: planted }), null);
      const state = path.join(instance, '.fleet');
      fs.mkdirSync(state);
      assert.equal(resolveRegistryFile({ FLEET_STATE: state, FLEET_HEALTH_FILE: planted }), null);
      // A symlink inside a trusted root that points back into the repo is refused too.
      fs.symlinkSync(planted, path.join(state, 'fleet-health.yml'));
      assert.equal(resolveRegistryFile({ FLEET_STATE: state }), null);
      fs.rmSync(path.join(state, 'fleet-health.yml'));

      // Positive controls: <instance>/config/, then <FLEET_STATE>/, then <instance>/ (which wins).
      fs.mkdirSync(path.join(instance, 'config'));
      fs.writeFileSync(path.join(state, 'fleet-health.yml'), MINI);
      assert.equal(fs.realpathSync(resolveRegistryFile({ FLEET_STATE: state })), fs.realpathSync(path.join(state, 'fleet-health.yml')));
      fs.writeFileSync(path.join(instance, 'config', 'fleet-health.yml'), MINI);
      assert.equal(
        fs.realpathSync(resolveRegistryFile({ FLEET_STATE: state })),
        fs.realpathSync(path.join(instance, 'config', 'fleet-health.yml')),
      );
      fs.writeFileSync(path.join(instance, 'fleet-health.yml'), MINI);
      assert.equal(
        fs.realpathSync(resolveRegistryFile({ FLEET_INSTANCE: instance })),
        fs.realpathSync(path.join(instance, 'fleet-health.yml')),
      );
      const explicit = path.join(state, 'fleet-health.yml');
      assert.equal(resolveRegistryFile({ FLEET_STATE: state, FLEET_HEALTH_FILE: explicit }), path.resolve(explicit));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(instance, { recursive: true, force: true });
    }
  });

  test('tick refuses a repo-local --file and runs from the trusted registry', async () => {
    const repo = makeTmpDir('fhd-repo-');
    const state = makeTmpDir('fhd-state-');
    try {
      const planted = path.join(repo, 'fleet-health.yml');
      fs.writeFileSync(planted, MINI);
      await withEnv({ ...CLEAN_FLEET_ENV, FLEET_STATE: state }, async () => {
        assert.equal(await runCli(['tick', '--file', planted, '--state-dir', state, '--json']), 1);
        assert.ok(!fs.existsSync(path.join(state, 'fhd-state.json')), 'no tick ran');
        // registry-path finds nothing yet...
        assert.equal(await runCli(['registry-path']), 1);
        // ...then the trusted copy is used (positive control) and its board reaches the weather cache.
        fs.writeFileSync(path.join(state, 'fleet-health.yml'), MINI);
        assert.equal(await runCli(['tick', '--state-dir', path.join(state, 'desk'), '--json']), 0);
        assert.ok(fs.existsSync(path.join(state, 'fhd', 'board-cache.json')), 'weather cache published to FLEET_STATE');
      });
      await withEnv({ ...CLEAN_FLEET_ENV }, async () => {
        // No fleet env at all: tick has neither a registry nor a state dir and does nothing.
        assert.equal(await runCli(['tick', '--json']), 1);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  test('free-form probe and invoke commands are rejected; kinds and typed params are validated', () => {
    const svc = (extra) => ({ version: 1, services: { 'svc-a': { probe: { adapter: 'observed' }, ...extra } } });
    assert.throws(
      () => validateRegistry({ version: 1, services: { 'svc-a': { probe: { adapter: 'synthetic-command', command: 'true' } } } }),
      /free-form commands are not supported/,
    );
    assert.throws(() => validateRegistry(svc({ invoke: { command: 'true' } })), /free-form commands are not supported/);
    assert.throws(() => validateRegistry(svc({ invoke: { kind: 'rm-rf' } })), /unknown kind/);
    assert.throws(
      () => validateRegistry({ version: 1, services: { 'svc-a': { probe: { adapter: 'synthetic-command', check: 'gh-api-get', params: { path: '/x;id' } } } } }),
      /absolute API path/,
    );
    assert.throws(
      () => validateRegistry({ version: 1, services: { 'svc-a': { probe: { adapter: 'synthetic-command', check: 'tool-version', params: { tool: 'sh' } } } } }),
      /must be one of/,
    );
    // Positive control: a well-formed kind validates.
    const ok = validateRegistry({
      version: 1,
      services: { 'svc-a': { probe: { adapter: 'synthetic-command', check: 'tool-version', params: { tool: 'git' } } } },
    });
    assert.equal(ok.services['svc-a'].probe.check, 'tool-version');
  });

  test('probes run as argv arrays with no shell, from a neutral cwd', () => {
    const calls = [];
    const execFn = (file, args, opts) => {
      calls.push({ file, args, opts });
      return '{}';
    };
    const res = probeSyntheticCommand(
      { check: 'gh-api-get', params: { path: '/rate_limit' }, auth_check: { check: 'gh-auth-status', params: { hostname: 'github.com' } } },
      { execFn, env: { PATH: '/usr/bin' } },
    );
    assert.equal(res.status, 'healthy');
    assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
      ['gh', 'auth', 'status', '--hostname', 'github.com'],
      ['gh', 'api', '--method', 'GET', '/rate_limit'],
    ]);
    for (const c of calls) {
      assert.ok(!['/bin/sh', 'sh', 'bash', '/bin/bash'].includes(c.file), 'no shell executable');
      assert.equal(c.opts.shell, false);
      assert.equal(c.opts.cwd, os.tmpdir());
    }
    // A config that skipped validation still can't name an executable.
    calls.length = 0;
    const bad = probeSyntheticCommand({ command: 'echo hi; id' }, { execFn });
    assert.equal(bad.status, 'unknown');
    assert.equal(calls.length, 0);

    // Positive control: a real (harmless) kind actually executes.
    const real = probeSyntheticCommand({ check: 'tool-version', params: { tool: 'node' } }, { env: { PATH: path.dirname(process.execPath) } });
    assert.equal(real.status, 'healthy');
    assert.match(real.detail, /^v\d+\./);
  });

  test('every kind gets a scrubbed env: credentials only for the group it declares', () => {
    const hostile = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'C',
      GH_TOKEN: 'gh-secret',
      GITHUB_TOKEN: 'github-secret',
      GH_APP_PEM: '/k.pem',
      AZURE_CLIENT_SECRET: 'az-secret',
      AZURE_CONFIG_DIR: '/az',
      SLACK_BOT_TOKEN: 'slack-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      DATABASE_PASSWORD: 'db-secret',
      NODE_OPTIONS: '--require /evil.js',
      LD_PRELOAD: '/evil.so',
    };
    const seen = {};
    const execFn = (file, args, opts) => {
      seen[args.includes('auth') && file === 'gh' ? 'gh' : file] = opts.env;
      return '{}';
    };
    probeSyntheticCommand({ check: 'tool-version', params: { tool: 'git' } }, { execFn, env: hostile });
    probeSyntheticCommand({ check: 'gh-auth-status' }, { execFn, env: hostile });
    probeSyntheticCommand({ check: 'az-account-show' }, { execFn, env: hostile });

    const leaks = (env) => Object.keys(env).filter((k) => /TOKEN|SECRET|PASSWORD|KEY|PEM/.test(k));
    assert.deepEqual(Object.keys(seen.git).sort(), ['HOME', 'LANG', 'PATH']);
    assert.deepEqual(leaks(seen.az), ['AZURE_CLIENT_SECRET']);
    assert.ok(!('GH_TOKEN' in seen.az) && !('SLACK_BOT_TOKEN' in seen.az));
    assert.deepEqual(leaks(seen.gh).sort(), ['GH_APP_PEM', 'GH_TOKEN', 'GITHUB_TOKEN']);
    for (const env of Object.values(seen)) {
      assert.ok(!('NODE_OPTIONS' in env) && !('LD_PRELOAD' in env) && !('ANTHROPIC_API_KEY' in env));
    }
    // Every declared group exists, so no kind silently loses (or gains) its credentials.
    for (const def of [...Object.values(PROBE_KINDS), ...Object.values(INVOKE_KINDS)]) {
      for (const g of def.env) assert.ok(Object.keys(scrubEnv({ GH_X: '1', AZURE_X: '1' }, [g])).length > 0, g);
    }
  });

  test('invoke always needs the gate its kind defines, whatever requires_gate says', async () => {
    const state = makeTmpDir('fhd-state-');
    try {
      fs.writeFileSync(
        path.join(state, 'fleet-health.yml'),
        [
          'version: 1',
          'board: { repo: acme/fleet, issue: 9 }',
          'services:',
          '  svc-a:',
          '    probe: { adapter: observed }',
          '    invoke: { kind: gh-run-list, params: { status: queued, limit: 3 }, requires_gate: false }',
          '',
        ].join('\n'),
      );
      assert.equal(parseRegistry(fs.readFileSync(path.join(state, 'fleet-health.yml'), 'utf8')).services['svc-a'].invoke.requires_gate, true);

      await withEnv({ ...CLEAN_FLEET_ENV, FLEET_STATE: state, GH_TOKEN: 'gh-secret', SLACK_BOT_TOKEN: 'slack-secret' }, async () => {
        const calls = [];
        const execFile = (file, args, opts) => {
          calls.push({ file, args, opts });
          return 'ok\n';
        };
        // No gate: refused, nothing runs.
        assert.equal(await runCli(['invoke', 'svc-a', '--json'], { execFile }), 1);
        assert.equal(calls.length, 0);
        // Extra command-line arguments: refused.
        assert.equal(await runCli(['invoke', 'svc-a', 'extra-arg', '--approved-gate', 'config-20261017000000-abcd'], { execFile }), 2);
        assert.equal(calls.length, 0);

        // Positive control: an approved gate is checked (fixed target/kind, not caller flags), then the kind runs.
        assert.equal(
          await runCli(['invoke', 'svc-a', '--approved-gate', 'config-20261017000000-abcd', '--target', 'other', '--kind', 'merge', '--json'], { execFile }),
          0,
        );
        assert.equal(calls.length, 2);
        const gate = calls[0].args;
        assert.equal(gate[gate.indexOf('--target') + 1], 'fleet-health:invoke:svc-a');
        assert.equal(gate[gate.indexOf('--kind') + 1], 'config');
        assert.deepEqual([calls[1].file, ...calls[1].args], ['gh', 'run', 'list', '--status', 'queued', '--limit', '3']);
        assert.equal(calls[1].opts.shell, false);
        assert.equal(calls[1].opts.env.GH_TOKEN, 'gh-secret');
        assert.ok(!('SLACK_BOT_TOKEN' in calls[1].opts.env));
      });
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  test('a board body is accepted only from a trusted numeric editor ID', () => {
    const tmp = makeTmpDir();
    try {
      const reg = parseRegistry(SAMPLE_YAML);
      const block = renderBoardBlock(reg, { updated_at: '2026-10-15T18:00:00Z', services: { 'github-api': { state: 'down' } } }, {});
      const rest = ['HTTP/2.0 200 OK', 'ETag: "e1"', '', JSON.stringify({ number: 42, body: block, user: { id: 7 } })].join('\r\n');
      const fetchWith = (editorId, trustedEditorIds, opts) =>
        fetchBoardCached({
          repo: 'acme/app',
          issue: 42,
          cacheFile: path.join(tmp, 'fhd', 'board-cache.json'),
          maxAgeMs: 0,
          trustedEditorIds,
          ghExec: (args) => (args[1] === 'graphql' ? trustedRevision(block, editorId, opts) : rest),
        });

      const untrusted = fetchWith(666, [7]);
      assert.equal(untrusted.ok, false);
      assert.equal(untrusted.source, 'untrusted-editor');
      assert.ok(!fs.existsSync(path.join(tmp, 'fhd', 'board-cache.json')), 'a rejected body is never cached');
      // The REST author being trusted doesn't help when someone else made the last edit.
      assert.equal(fetchWith(666, [7]).ok, false);
      // An empty allowlist accepts nothing.
      assert.equal(fetchWith(7, []).source, 'untrusted-editor');

      // Positive controls: the trusted bot's edit, and a never-edited body it authored.
      const trusted = fetchWith(7, [7]);
      assert.equal(trusted.ok, true);
      assert.equal(trusted.board.services['github-api'].state, 'down');
      assert.equal(fetchWith(7, [7], { edited: false }).ok, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('watch-board lines carry no board free text', async () => {
    const state = makeTmpDir('fhd-state-');
    try {
      fs.writeFileSync(path.join(state, 'fleet-health.yml'), MINI);
      writeFhdCache(state, {
        version: 1,
        last_updated: new Date().toISOString(),
        services: {
          'svc-a': { state: 'down', advice: 'HOSTILE-ADVICE', name: 'HOSTILE-NAME', hold_merges: true },
          'Bad Id HOSTILE': { state: 'down' },
        },
      });
      let out = '';
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        out += chunk;
        return true;
      };
      try {
        await withEnv({ ...CLEAN_FLEET_ENV, FLEET_STATE: state }, () => runCli(['watch-board', '--max-age-sec', '3600']));
      } finally {
        process.stdout.write = orig;
      }
      assert.ok(!out.includes('HOSTILE'), out);
      assert.match(out, /^FHD_CHANGE svc-a down — hold merges$/m);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

function writeFhdCache(stateDir, board) {
  const file = path.join(stateDir, 'fhd', 'board-cache.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), board }));
}

