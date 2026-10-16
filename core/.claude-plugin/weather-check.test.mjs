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
      const env = { ENGSYS_FHD_STATE_DIR: tmp, ENGSYS_SESSION: 'dev-1' };
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

      const env = { ENGSYS_FHD_STATE_DIR: tmp, ENGSYS_SESSION: 'dev-1' };
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
        ENGSYS_FHD_STATE_DIR: tmp,
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

      const envA = { ENGSYS_FHD_STATE_DIR: tmp, ENGSYS_SESSION: 'session-a' };
      const envB = { ENGSYS_FHD_STATE_DIR: tmp, ENGSYS_SESSION: 'session-b' };

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
        env: { ...process.env, ENGSYS_FHD_STATE_DIR: tmp },
        encoding: 'utf8',
      });
      assert.equal(stdout, '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
