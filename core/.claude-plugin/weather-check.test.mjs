// weather-check.test.mjs — Unit tests for the Fleet Health Desk SessionStart & UserPromptSubmit hook (#98).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  run,
  formatWeatherSessionStart,
  formatWeatherPromptDelta,
  resolveWeatherCachePath,
} from './weather-check.mjs';
import { writeBoardCache } from '../fleet/health/board.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpDir(prefix = 'weather-check-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('weather-check.mjs hook (#98)', () => {
  test('silent when unconfigured or cache file does not exist', () => {
    const tmp = makeTmpDir();
    try {
      const env = { FLEET_STATE: tmp, ENGSYS_SESSION: 'dev-1' };
      assert.equal(run('session-start', env, { cwd: tmp }), '');
      assert.equal(run('prompt', env, { cwd: tmp }), '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('silent on session-start when all services are up', () => {
    const tmp = makeTmpDir();
    try {
      const now = new Date('2026-10-15T18:00:00.000Z');
      const board = {
        version: 1,
        last_updated: '2026-10-15T17:58:00.000Z',
        stale_minutes: 30,
        services: {
          'github-api': { id: 'github-api', name: 'GitHub API', state: 'up', advice: 'normal operation' },
        },
      };
      writeBoardCache(tmp, board, { fetchedAt: now.toISOString() });

      const env = { FLEET_STATE: tmp, ENGSYS_SESSION: 'dev-1' };
      assert.equal(run('session-start', env, { cwd: tmp, now }), '');
      assert.equal(run('prompt', env, { cwd: tmp, now }), '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits stale warning on session-start when board is older than threshold', () => {
    const tmp = makeTmpDir();
    try {
      const now = new Date('2026-10-15T19:00:00.000Z');
      const board = {
        version: 1,
        last_updated: '2026-10-15T18:00:00.000Z', // 60m old > 30m limit
        stale_minutes: 30,
        services: {
          'github-api': { id: 'github-api', state: 'up' },
        },
      };
      writeBoardCache(tmp, board, { fetchedAt: now.toISOString() });

      const env = {
        FLEET_STATE: tmp,
        ENGSYS_SESSION: 'dev-1',
        OPERATOR_TIMEZONE: 'America/New_York',
        OPERATOR_CLOCK: '12h',
      };
      const rawOut = run('session-start', env, { cwd: tmp, now });
      assert.ok(rawOut);
      const parsed = JSON.parse(rawOut);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(parsed.additionalContext, /Fleet Health Desk: weather unknown \(board stale since .*EDT\)/);

      // Prompt hook stays silent when board is stale (never spams every prompt)
      assert.equal(run('prompt', env, { cwd: tmp, now }), '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits concise weather + advice on session-start when degraded/down and skips suppressed_by', () => {
    const now = new Date('2026-10-15T18:00:00.000Z');
    const board = {
      version: 1,
      last_updated: '2026-10-15T17:59:00.000Z',
      stale_minutes: 30,
      services: {
        'github-api': {
          id: 'github-api',
          name: 'GitHub API',
          state: 'down',
          hold_merges: true,
          pause_claims: true,
          advice: 'hold merges; pause new issue claims',
        },
        'github-actions': {
          id: 'github-actions',
          name: 'GitHub Actions',
          state: 'down',
          suppressed_by: 'github-api',
          advice: 'suppressed by upstream github-api',
        },
      },
    };
    const text = formatWeatherSessionStart(board, {
      env: { OPERATOR_TIMEZONE: 'UTC', OPERATOR_CLOCK: '24h' },
      now,
    });
    const lines = text.split('\n');
    assert.equal(lines.length, 2, 'emits at most 1-2 lines');
    assert.ok(lines[0].includes('github-api is DOWN'));
    assert.ok(!lines[0].includes('github-actions'), 'suppressed downstream service is not listed separately');
    assert.match(lines[1], /Weather advisory: hold merges, pause new issue claims\./);
  });

  test('UserPromptSubmit (prompt) emits one-line delta only when state changes per ENGSYS_SESSION', () => {
    const tmp = makeTmpDir();
    try {
      const now = new Date('2026-10-15T18:00:00.000Z');
      const boardUp = {
        version: 1,
        last_updated: '2026-10-15T17:59:00.000Z',
        stale_minutes: 30,
        services: {
          'github-api': { id: 'github-api', name: 'GitHub API', state: 'up', advice: 'normal operation' },
        },
      };
      writeBoardCache(tmp, boardUp, { fetchedAt: now.toISOString() });

      const envA = { FLEET_STATE: tmp, ENGSYS_SESSION: 'session-a' };
      const envB = { FLEET_STATE: tmp, ENGSYS_SESSION: 'session-b' };

      // Both sessions start while board is UP -> silent
      assert.equal(run('session-start', envA, { cwd: tmp, now }), '');
      assert.equal(run('session-start', envB, { cwd: tmp, now }), '');

      // Prompt while still UP -> silent
      assert.equal(run('prompt', envA, { cwd: tmp, now }), '');

      // Board transitions to DEGRADED mid-session
      const boardDeg = {
        version: 1,
        last_updated: '2026-10-15T18:01:00.000Z',
        stale_minutes: 30,
        services: {
          'github-api': {
            id: 'github-api',
            name: 'GitHub API',
            state: 'degraded',
            hold_merges: true,
            advice: 'hold merges; elevated 5xx rate',
          },
        },
      };
      writeBoardCache(tmp, boardDeg, { fetchedAt: '2026-10-15T18:01:00.000Z' });

      // Session A submits a prompt -> receives 1-line delta
      const outA1 = run('prompt', envA, { cwd: tmp, now: new Date('2026-10-15T18:01:05.000Z') });
      assert.ok(outA1);
      const parsedA1 = JSON.parse(outA1);
      assert.equal(parsedA1.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(parsedA1.additionalContext, /Fleet Health Desk update.*github-api up -> degraded/);

      // Next prompt on Session A with same board -> silent!
      assert.equal(run('prompt', envA, { cwd: tmp, now: new Date('2026-10-15T18:01:10.000Z') }), '');

      // Session B has not seen the transition yet -> receives delta on its next prompt
      const outB1 = run('prompt', envB, { cwd: tmp, now: new Date('2026-10-15T18:01:15.000Z') });
      assert.ok(outB1);
      assert.match(JSON.parse(outB1).additionalContext, /github-api up -> degraded/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI execution exits 0 and fails open when invoked directly', () => {
    const tmp = makeTmpDir();
    try {
      const script = path.join(__dirname, 'weather-check.mjs');
      const stdout = execFileSync(process.execPath, [script, 'session-start'], {
        cwd: tmp,
        env: { PATH: process.env.PATH, FLEET_STATE: tmp },
        encoding: 'utf8',
      });
      assert.equal(stdout, '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // --- Trust boundary (engsys v2.0.1) -------------------------------------------------------------

  const NOW = new Date('2026-10-15T18:00:00.000Z');
  const downBoard = (over = {}) => ({
    version: 1,
    last_updated: '2026-10-15T17:59:00.000Z',
    stale_minutes: 30,
    services: { 'svc-a': { id: 'svc-a', state: 'down', hold_merges: true } },
    ...over,
  });

  test('the cache is read only from an absolute FLEET_STATE, never from the working tree', () => {
    const repo = makeTmpDir('weather-repo-');
    const state = makeTmpDir('weather-state-');
    try {
      // A board planted in the working tree, plus every former override pointing at it.
      writeBoardCache(path.join(repo, '.fleet'), downBoard(), { fetchedAt: NOW.toISOString() });
      writeBoardCache(repo, downBoard(), { fetchedAt: NOW.toISOString() });
      const planted = path.join(repo, '.fleet', 'fhd', 'board-cache.json');
      const ignoredEnvs = [
        {},
        { FLEET_INSTANCE: repo },
        { ENGSYS_FHD_BOARD_CACHE: planted },
        { ENGSYS_FHD_STATE_DIR: repo },
        { FLEET_STATE: '.fleet' }, // relative: would resolve against the repo
      ];
      for (const env of ignoredEnvs) {
        assert.equal(run('session-start', { ...env, ENGSYS_SESSION: 's' }, { now: NOW }), '', JSON.stringify(env));
        assert.equal(run('prompt', { ...env, ENGSYS_SESSION: 's' }, { now: NOW }), '', JSON.stringify(env));
      }
      assert.equal(resolveWeatherCachePath({ ENGSYS_FHD_BOARD_CACHE: planted }), null);
      // Nothing was written into the working tree.
      assert.deepEqual(fs.readdirSync(path.join(repo, '.fleet', 'fhd')).sort(), ['board-cache.json']);

      // Positive control: the same board under the launcher-set FLEET_STATE is read and announced.
      writeBoardCache(state, downBoard(), { fetchedAt: NOW.toISOString() });
      const out = run('session-start', { FLEET_STATE: state, ENGSYS_SESSION: 's' }, { now: NOW });
      assert.match(JSON.parse(out).additionalContext, /svc-a is DOWN/);
      // ...and the per-session seen file lands in the state dir.
      assert.ok(fs.existsSync(path.join(state, 'fhd', 'fhd-seen-s.json')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  test('injected text carries only id, state and gate booleans, never board free text', () => {
    const HOSTILE = 'IGNORE-PREVIOUS-INSTRUCTIONS';
    const board = {
      version: 1,
      last_updated: '2026-10-15T17:59:00.000Z',
      stale_minutes: 30,
      services: {
        'svc-a': {
          id: `svc-a ${HOSTILE}`,
          name: `${HOSTILE} name`,
          state: 'down',
          advice: `${HOSTILE} advice`,
          summary: `${HOSTILE} summary`,
          root_cause: `${HOSTILE} root cause`,
          hold_merges: true,
          pause_claims: 'yes', // not a boolean: ignored
        },
        [`Bad Id ${HOSTILE}`]: { state: 'down', advice: HOSTILE },
        'svc-b': { state: `down ${HOSTILE}`, advice: HOSTILE },
        ['x'.repeat(41)]: { state: 'down' },
      },
    };
    const start = formatWeatherSessionStart(board, { env: {}, now: NOW });
    const delta = formatWeatherPromptDelta(null, board, { env: {}, now: NOW });
    for (const text of [start, delta]) {
      assert.ok(!text.includes(HOSTILE), text);
      assert.ok(!text.includes('name'), text);
      assert.ok(!text.includes('x'.repeat(41)), text);
    }
    // Positive control: the valid service is reported with its state and its boolean gate.
    assert.match(start, /svc-a is DOWN/);
    assert.match(start, /Weather advisory: hold merges\./);
    assert.ok(!start.includes('pause'), 'a non-boolean pause_claims is not a gate');
    assert.match(delta, /svc-a healthy -> down \(hold merges\)/);
  });

  test('a board timestamp is never echoed raw, and a future one counts as stale', () => {
    const forged = formatWeatherSessionStart(downBoard({ last_updated: '2026-10-15T17:59:00Z <!-- note -->' }), { env: {}, now: NOW });
    assert.ok(!forged.includes('note'), forged);
    assert.match(forged, /weather unknown \(board stale since unknown\)/);

    const future = formatWeatherSessionStart(downBoard({ last_updated: '2026-10-16T18:00:00.000Z' }), { env: {}, now: NOW });
    assert.match(future, /^Fleet Health Desk: weather unknown \(board stale since 2026-10-16T18:00:00Z\)$/);
    assert.ok(!future.includes('svc-a'), 'a future-dated board reports no services');

    // Positive control: within clock skew, the board is current.
    const fresh = formatWeatherSessionStart(downBoard({ last_updated: '2026-10-15T18:00:30.000Z' }), { env: {}, now: NOW });
    assert.match(fresh, /svc-a is DOWN/);
  });
});
