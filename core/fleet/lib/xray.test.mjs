import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runXray,
  resolveContext,
  formatXrayReport,
  parseTranscriptSummary,
  parseAgentsTsv,
  claudeConfigItem,
} from './xray.mjs';
import { hookTelemetryPath, recordHookTelemetry } from '../../lib/harness-io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGSYS_DIR = path.resolve(__dirname, '..', '..', '..');

/**
 * A hermetic environment for runXray: a throwaway HOME (so no real ~/.claude, ~/.config/<org> or
 * ~/Library/Logs is read) and LOG_DIR, no fleet variables from the caller, and only PATH/TMPDIR kept so
 * node, git and the hook self-test still run.
 */
function hermeticEnv(tmpDir, extra = {}) {
  const home = path.join(tmpDir, 'home');
  const logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, LOG_DIR: logDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return { ...env, ...extra };
}

test('Hook Flight Recorder (hookTelemetryPath & recordHookTelemetry) writes when configured and skips unconfigured unit tests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-telemetry-test-'));
  try {
    const tFile = path.join(tmpDir, 'hook-events.jsonl');
    assert.equal(hookTelemetryPath({ NODE_TEST_CONTEXT: '1', ENGSYS_HOOK_TELEMETRY: '0', ENGSYS_HOOK_TELEMETRY_FILE: tFile }), null);
    assert.equal(hookTelemetryPath({ NODE_TEST_CONTEXT: '1', ENGSYS_HOOK_TELEMETRY_FILE: tFile }), tFile);
    // Skips writing when NODE_TEST_CONTEXT is set and no explicit file/dir/opt-in is passed
    assert.equal(
      recordHookTelemetry({ hook: 'weather-check', event: 'SessionStart', decision: 'allow' }, { NODE_TEST_CONTEXT: '1', HOME: tmpDir }),
      null,
    );

    const env = {
      ENGSYS_HOOK_TELEMETRY_FILE: tFile,
      ENGSYS_SESSION: 'keystone-merge',
      FLEET_ID: 'eric',
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
    assert.equal(rec.session, 'keystone-merge');
    assert.equal(rec.fleet, 'eric');
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
      env: hermeticEnv(tmpDir, {
        ENGSYS_HOOK_TELEMETRY_FILE: tFile,
        ENGSYS_MEMORY_CACHE_DIR: path.join(tmpDir, 'mem-cache'),
      }),
    });

    assert.equal(report.sections.length, 10, 'must report all 10 subsystem sections');
    const cfgItem = report.sections.flatMap((sec) => sec.items).find((i) => i.name === 'Claude config dir (fleet sessions)');
    assert.ok(cfgItem, 'reports the Claude config dir the fleet sessions use');
    assert.equal(cfgItem.meta.dir, path.join(tmpDir, 'home', '.claude'), 'the hermetic HOME, never the real ~/.claude');
    assert.equal(cfgItem.meta.fromConf, false);
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

test('runXray deep-dives into sessions, parses transcripts/agents.tsv/federation, and synthesizes troubleshooting diagnoses', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-troubleshoot-'));
  try {
    const fleetDir = path.join(tmpDir, 'ff-engsys-fleet');
    const pinDir = path.join(tmpDir, 'keystone');
    const sessDir = path.join(tmpDir, 'sessions');
    const memCacheDir = path.join(tmpDir, 'mem-cache');
    fs.mkdirSync(path.join(fleetDir, 'fleet'), { recursive: true });
    fs.mkdirSync(path.join(fleetDir, 'plugin', 'repos', 'FeedFrwd', 'keystone'), { recursive: true });
    fs.mkdirSync(path.join(pinDir, 'logs', 'merge-monster', '.watch'), { recursive: true });
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(memCacheDir, { recursive: true });

    // 1. Write fleet/fleet.conf & federation.yml
    fs.writeFileSync(
      path.join(fleetDir, 'fleet', 'fleet.conf'),
      [
        'FLEET_ORG=feedfrwd',
        'FLEET_ID=eric',
        'PIN_REPO=FeedFrwd/keystone',
        `PIN_DIR=${pinDir}`,
        `FLEET_CLAUDE_CONFIG_DIR=${path.join(tmpDir, 'fleet-claude')}`,
        'OPUS_MODEL=claude-opus-5-5',
        'SONNET_MODEL=claude-sonnet-5-5',
        'HAIKU_MODEL=claude-haiku-5-5',
        'FABLE_MODEL=claude-fable-5-1',
        'SECURITY_MODEL=claude-opus-4-8',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(fleetDir, 'federation.yml'),
      [
        'version: 1',
        'operators_team: FeedFrwd/fleet-operators',
        'fleets:',
        '  eric:',
        '    operator: eric-sabe',
        '    host: macmini-eric',
        '    github_app: feedfrwd-fleet',
        '    github_app_id: 5013025',
        '    status_issue: 30',
        '    enabled: true',
        '    timezone: America/New_York',
        '    clock: 12h',
        'repos:',
        '  FeedFrwd/keystone:',
        '    merge: { home: eric, ledger: 2792 }',
        '    maintain: { home: eric, ledger: 3157 }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(fleetDir, 'plugin', 'repos', 'FeedFrwd', 'keystone', 'merge-monster.yml'),
      [
        'repo: FeedFrwd/keystone',
        'ledger_issue: 2792',
        'state_dir: logs/merge-monster',
        'rotate_context_tokens: 150000',
      ].join('\n'),
    );

    // 2. Write simulated Merge Monster state anomalies:
    //    - expired baton
    //    - oversized state.md (5000B > 4096B ceiling)
    //    - overdue subagent in agents.tsv
    const mmStateDir = path.join(pinDir, 'logs', 'merge-monster');
    fs.writeFileSync(
      path.join(mmStateDir, 'baton-merge.json'),
      JSON.stringify({
        role: 'merge',
        holder: { session: 'keystone-merge' },
        acquired_at: '2026-10-16T20:00:00.000Z',
        expires_at: '2026-10-16T20:10:00.000Z',
      }),
    );
    fs.writeFileSync(path.join(mmStateDir, 'state.md'), `# Merge Monster State\n${'x'.repeat(4200)}\n`);
    fs.writeFileSync(path.join(mmStateDir, 'journal-2026-10.md'), '- 2026-10-16T20:05:00Z merged PR #401\n');
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      path.join(mmStateDir, 'agents.tsv'),
      `rebase-402\t1\trunning\tagent-1\tsess-1\trebase\tPR#402\t${nowSec - 900}\t${nowSec - 60}\t0\t-\n`,
    );

    // 3. Write simulated session transcript pointer + JSONL transcript (>150k tokens + tool error)
    const trxPath = path.join(tmpDir, 'keystone-merge-transcript.jsonl');
    fs.writeFileSync(
      trxPath,
      [
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          timestamp: '2026-10-16T20:12:00.000Z',
          effort: 'high',
          gitBranch: 'main',
          message: {
            model: 'claude-opus-5-5',
            usage: {
              input_tokens: 2000,
              cache_creation_input_tokens: 3000,
              cache_read_input_tokens: 155000,
              output_tokens: 450,
            },
            content: [
              {
                type: 'tool_use',
                name: 'Agent',
                input: { subagent_type: 'engsys:nyx', model: 'opus', description: 'Security review PR #402' },
              },
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'gh pr merge 402 --squash' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-10-16T20:12:05.000Z',
          message: {
            content: [
              {
                type: 'tool_result',
                is_error: true,
                content: 'singleton-write-guard: direct gh pr merge is denied; route through mm-act.sh',
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(sessDir, 'eric.keystone-merge.json'),
      JSON.stringify({
        session: 'keystone-merge',
        fleet: 'eric',
        session_id: 'sid-mm-1',
        transcript_path: trxPath,
        at: '2026-10-16T20:00:00.000Z',
      }),
    );

    // 4. Write INCOMPLETE handback + denied hook event + memory brief injection
    fs.writeFileSync(
      path.join(sessDir, 'eric.keystone-merge.handbacks.jsonl'),
      `${JSON.stringify({ at: '2026-10-16T20:11:00.000Z', agent_id: 'a-99', agent_type: 'engsys:isabelle', remains: 'CI check still running on PR #402' })}\n`,
    );
    const tFile = path.join(sessDir, 'hook-events.jsonl');
    recordHookTelemetry(
      {
        ts: '2026-10-16T20:12:04.000Z',
        session: 'keystone-merge',
        fleet: 'eric',
        role: 'merge',
        hook: 'singleton-write-guard',
        event: 'PreToolUse',
        decision: 'deny',
        bytes: 140,
        detail: 'blocked raw gh pr merge 402',
      },
      { ENGSYS_HOOK_TELEMETRY_FILE: tFile },
    );
    fs.writeFileSync(
      path.join(memCacheDir, 'injections.jsonl'),
      `${JSON.stringify({ ts: '2026-10-16T20:11:30.000Z', agent_type: 'nyx', lesson_keys: ['bash:quoting'], pointer_keys: [], bytes: 812, ms: 42 })}\n`,
    );
    fs.mkdirSync(path.join(fleetDir, 'logs', 'fleet-supervisor'), { recursive: true });
    fs.writeFileSync(
      path.join(fleetDir, 'logs', 'fleet-supervisor', 'harness.fallback'),
      'copilot\n2026-10-16T20:10:00Z\nclaude\nkeystone-merge\n9999999999\n',
    );

    // Verify unit parsers directly
    const tsSummary = parseTranscriptSummary(trxPath);
    assert.equal(tsSummary.model, 'claude-opus-5-5');
    assert.equal(tsSummary.contextTokens, 160000);
    assert.equal(tsSummary.recentTools.length, 2);
    assert.equal(tsSummary.recentErrors.length, 1);

    const agSummary = parseAgentsTsv(mmStateDir, nowSec);
    assert.equal(agSummary.running.length, 1);
    assert.equal(agSummary.overdue.length, 1);

    // Run full X-Ray with --role merge and --skip-selftest
    const report = await runXray({
      engsysDir: ENGSYS_DIR,
      fleetInstance: fleetDir,
      pinDir,
      role: 'merge',
      diagnose: true,
      skipSelfTest: true,
      env: hermeticEnv(tmpDir, {
        ENGSYS_SESSIONS_DIR: sessDir,
        ENGSYS_HOOK_TELEMETRY_FILE: tFile,
        ENGSYS_MEMORY_CACHE_DIR: memCacheDir,
      }),
    });

    const cfgItem2 = report.sections.flatMap((sec) => sec.items).find((i) => i.name === 'Claude config dir (fleet sessions)');
    assert.ok(cfgItem2, 'reports the Claude config dir');
    assert.equal(cfgItem2.meta.dir, path.join(tmpDir, 'fleet-claude'), 'FLEET_CLAUDE_CONFIG_DIR from fleet.conf');
    assert.equal(cfgItem2.status, 'fail', 'a configured dir that does not exist fails');
    assert.ok(!report.sections.flatMap((sec) => sec.items).some((i) => i.name === 'Claude config dir (interactive roles)'), 'scope all: one dir only');
    assert.doesNotMatch(JSON.stringify(cfgItem2), /token|oauth/i, 'no credential material in the report');

    // Must flag state.md > 4096B as a failure
    assert.equal(report.summary.ok, false);
    assert.ok(report.summary.fail >= 1);
    assert.ok(report.sessionDeepDive, 'sessionDeepDive must be populated for --role merge');
    assert.equal(report.sessionDeepDive.session, 'keystone-merge');
    assert.equal(report.sessionDeepDive.transcriptSummary.contextTokens, 160000);
    assert.ok(report.timeline.length >= 3, 'unified timeline must merge hook, handback, baton, and memory-brief events');

    // Verify automated root-cause diagnoses cover the simulated anomalies
    const symptoms = report.diagnoses.map((d) => d.symptom).join('\n');
    assert.match(symptoms, /ACTIVE FALLBACK: HARNESS=copilot/);
    assert.match(symptoms, /Baton \[merge\]/);
    assert.match(symptoms, /Monster state ceiling \[merge\]/);
    assert.match(symptoms, /Subagent registry \[merge\]/);
    assert.match(symptoms, /hook deny\/block event/);
    assert.match(symptoms, /INCOMPLETE handback/);
    assert.match(symptoms, /context window is at 160k tokens/);
    assert.match(symptoms, /recent tool_result error/);

    const formatted = formatXrayReport(report, { includeTimeline: true, forceDiagnose: true });
    assert.match(formatted, /\[SESSION DEEP-DIVE: keystone-merge \(role=merge\)\]/);
    assert.match(formatted, /\[BEHAVIOR TIMELINE/);
    assert.match(formatted, /\[DIAGNOSIS & REMEDIATION PLAYBOOK\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runXray never reads the process\'s real home: a host with its own Claude settings gives the same report (engsys#178)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-realhome-'));
  const realHome = path.join(tmpDir, 'host-home'); // stands in for the machine's real $HOME, with settings that WOULD drift
  fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(realHome, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'unpinned-plugin@somewhere': true },
    env: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
    model: 'opus',
  }));
  const savedHome = process.env.HOME;
  process.env.HOME = realHome; // os.homedir() now resolves to the poisoned home
  try {
    assert.equal(os.homedir(), realHome, 'precondition: the poisoned home is what the process sees');
    const env = hermeticEnv(tmpDir, { ENGSYS_HOOK_TELEMETRY_FILE: path.join(tmpDir, 'h.jsonl'), ENGSYS_MEMORY_CACHE_DIR: path.join(tmpDir, 'mem-cache') });
    assert.notEqual(path.resolve(env.HOME), path.resolve(os.homedir()), 'the env handed to runXray carries the fixture HOME, not the real one');
    assert.equal(resolveContext({ env, engsysDir: ENGSYS_DIR }).home, env.HOME, 'resolveContext resolves the fixture home, not os.homedir()');
    const report = await runXray({
      engsysDir: ENGSYS_DIR,
      pinDir: path.join(tmpDir, 'nonexistent-pin'),
      skipSelfTest: true,
      env,
    });
    const text = JSON.stringify(report);
    assert.ok(!text.includes(realHome), `the report mentions the process's real home:\n${text.split(realHome).length - 1} occurrence(s)`);
    assert.doesNotMatch(text, /Settings drift detected/);
    assert.doesNotMatch(text, /unpinned-plugin@somewhere/);
    const cfgItem = report.sections.flatMap((sec) => sec.items).find((i) => i.name === 'Claude config dir (fleet sessions)');
    assert.equal(cfgItem.meta.dir, path.join(tmpDir, 'home', '.claude'));
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('xray reports both Claude config dirs under FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-scope-'));
  try {
    const fleetDir = path.join(tmpDir, 'inst');
    fs.mkdirSync(path.join(fleetDir, 'fleet'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'fleet-claude'), { recursive: true });
    fs.writeFileSync(path.join(fleetDir, 'fleet', 'fleet.conf'), ['FLEET_ORG=acme', 'PIN_REPO=acme/app', `PIN_DIR=${path.join(tmpDir, 'nope')}`,
      `FLEET_CLAUDE_CONFIG_DIR=${path.join(tmpDir, 'fleet-claude')}`, 'FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised'].join('\n') + '\n');
    const report = await runXray({ engsysDir: ENGSYS_DIR, fleetInstance: fleetDir, skipSelfTest: true, env: hermeticEnv(tmpDir, { ENGSYS_HOOK_TELEMETRY_FILE: path.join(tmpDir, 'h.jsonl') }) });
    const items = report.sections.flatMap((sec) => sec.items);
    const sup = items.find((i) => i.name === 'Claude config dir (supervised sessions)');
    const ia = items.find((i) => i.name === 'Claude config dir (interactive roles)');
    assert.ok(sup, 'the fleet dir, for the supervised sessions');
    assert.equal(sup.meta.dir, path.join(tmpDir, 'fleet-claude'));
    assert.ok(ia, 'and ~/.claude, for the interactive roles');
    assert.equal(ia.meta.dir, path.join(tmpDir, 'home', '.claude'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#212: xray says "login state unknown" (never "NOT logged in") for a logged-out answer in an SSH shell on macOS', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-ssh-'));
  try {
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(tmpDir, 'cfg'));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho \'{"loggedIn": false}\'\nexit 1\n', { mode: 0o755 });
    const cfg = { dir: path.join(tmpDir, 'cfg'), fromConf: true, scope: 'all' };
    const base = { PATH: `${bin}:${process.env.PATH}` };
    const ssh = claudeConfigItem({ env: { ...base, SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, platform: 'darwin' }, cfg);
    assert.match(ssh.detail, /login state unknown \(SSH, Keychain not readable/);
    assert.doesNotMatch(ssh.detail, /NOT logged in/);
    assert.equal(ssh.status, 'warn');
    const gui = claudeConfigItem({ env: base, platform: 'darwin' }, cfg);
    assert.match(gui.detail, /NOT logged in/);
    const linux = claudeConfigItem({ env: { ...base, SSH_TTY: '/dev/ttys001' }, platform: 'linux' }, cfg);
    assert.match(linux.detail, /NOT logged in/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
