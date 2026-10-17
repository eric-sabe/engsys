import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runXray, formatXrayReport } from './xray.mjs';
import { hookTelemetryPath, recordHookTelemetry } from '../../lib/harness-io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGSYS_DIR = path.resolve(__dirname, '..', '..', '..');

test('Hook Flight Recorder (hookTelemetryPath & recordHookTelemetry) writes and rotates JSONL', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-telemetry-test-'));
  try {
    const tFile = path.join(tmpDir, 'hook-events.jsonl');
    // Disabled in node --test by default unless opted in
    assert.equal(hookTelemetryPath({ NODE_TEST_CONTEXT: '1' }), null);
    assert.equal(hookTelemetryPath({ NODE_TEST_CONTEXT: '1', ENGSYS_HOOK_TELEMETRY: '0', ENGSYS_HOOK_TELEMETRY_FILE: tFile }), null);
    assert.equal(hookTelemetryPath({ NODE_TEST_CONTEXT: '1', ENGSYS_HOOK_TELEMETRY_FILE: tFile }), tFile);

    const env = {
      ENGSYS_HOOK_TELEMETRY_FILE: tFile,
      ENGSYS_SESSION: 'keystone-mm',
      FLEET_ID: 'hub',
      ENGSYS_SINGLETON_ROLE: 'merge',
      ENGSYS_HARNESS: 'claude',
    };
    const rec = recordHookTelemetry(
      {
        hook: 'singleton-write-guard',
        event: 'PreToolUse',
        decision: 'deny',
        bytes: 128,
        detail: 'raw gh pr merge blocked',
      },
      env,
    );
    assert.equal(rec.hook, 'singleton-write-guard');
    assert.equal(rec.decision, 'deny');
    assert.equal(rec.session, 'keystone-mm');
    assert.equal(rec.fleet, 'hub');
    assert.equal(rec.role, 'merge');

    const lines = fs.readFileSync(tFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.hook, 'singleton-write-guard');
    assert.equal(parsed.decision, 'deny');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runXray executes all 10 subsystem checks and passes the live 9-hook synthetic self-test', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-test-'));
  try {
    const tFile = path.join(tmpDir, 'hook-events.jsonl');
    recordHookTelemetry(
      {
        hook: 'weather-check',
        event: 'SessionStart',
        decision: 'allow',
        bytes: 0,
        detail: 'all-up',
      },
      { ENGSYS_HOOK_TELEMETRY_FILE: tFile, ENGSYS_SESSION: 'test-sess' },
    );

    const report = await runXray({
      engsysDir: ENGSYS_DIR,
      pinDir: path.join(tmpDir, 'nonexistent-pin'),
      env: {
        ...process.env,
        ENGSYS_HOOK_TELEMETRY_FILE: tFile,
        ENGSYS_MEMORY_CACHE_DIR: path.join(tmpDir, 'mem-cache'),
      },
    });

    assert.equal(report.sections.length, 10, 'must report all 10 subsystem sections');
    assert.equal(report.summary.ok, true, `expected 0 failures, got: ${JSON.stringify(report.sections, null, 2)}`);
    assert.equal(report.summary.fail, 0);

    const hookSection = report.sections.find((s) => s.id === 6);
    assert.ok(hookSection);
    assert.equal(hookSection.items.length, 10, '9 core hooks + 1 summary item');
    for (const item of hookSection.items) {
      assert.equal(item.status, 'pass', `Hook self-test item failed: ${item.name} (${item.detail})`);
    }

    const formatted = formatXrayReport(report);
    assert.match(formatted, /engsys v2\.0\.0 Operational X-Ray/);
    assert.match(formatted, /VERDICT: HEALTHY \(ALL PROMISES VERIFIED\)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
