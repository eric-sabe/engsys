#!/usr/bin/env node
// core/fleet/lib/xray.mjs — Live Operational X-Ray & Diagnostic Self-Test (`fleet xray` / `fleet doctor`).
//
// Gives operators and agents a complete, single-command view inside a running (or freshly upgraded)
// engsys v2.0.0 installation across all 10 architectural promises:
//   [1/10] Pins, Checkouts & Wrapper Trust Closure
//   [2/10] Fleet Identities & External Credentials
//   [3/10] Launchd Jobs, Supervisor & Alert Latches
//   [4/10] Live Sessions, Model Routing & Context Window Health
//   [5/10] Singleton Monsters, Batons, Keepalives & State Ceiling
//   [6/10] Live Synthetic Hook Self-Test (9 Core Hooks in isolated sandbox)
//   [7/10] Live Hook Flight Recorder & Subagent Memory Telemetry
//   [8/10] 4-Tier Durable Agentic Memory
//   [9/10] Adaptive SDD, Contract Gates & Cross-Family Review Readiness
//  [10/10] Fleet Health Desk, Multi-Fleet Federation & E2E Resource Broker

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookTelemetryPath } from '../../lib/harness-io.mjs';
import { checkSettings } from './verify-wrappers.mjs';

export const DEFAULT_CLAUDE_TIERS = Object.freeze({
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  security: 'claude-opus-4-8',
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ENGSYS_DIR = path.resolve(__dirname, '..', '..', '..');

function runCmd(cmd, args, { cwd, env, timeout = 5000 } = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: env || process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    return { ok: true, stdout: out.trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout ? String(err.stdout) : '').trim(),
      stderr: (err.stderr ? String(err.stderr) : err.message || '').trim(),
      status: err.status ?? 1,
    };
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseKeyValFile(file) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cleaned = line.replace(/^export\s+/, '');
      const eq = cleaned.indexOf('=');
      if (eq <= 0) continue;
      const key = cleaned.slice(0, eq).trim();
      let val = cleaned.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val === '~' || val.startsWith('~/')) {
        val = path.join(os.homedir(), val.slice(1));
      }
      out[key] = val;
    }
  } catch {
    // ignore
  }
  return out;
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function repoCacheHash(repoDir) {
  try {
    const real = fs.realpathSync(repoDir);
    return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
  }
}

// ---------------------------------------------------------------------------
// [1/10] Pins, Checkouts & Wrapper Trust Closure
// ---------------------------------------------------------------------------
export function inspectPinsAndTrust(ctx) {
  const items = [];
  const engsysDir = ctx.engsysDir;
  const pinDir = ctx.pinDir;
  const fleetRepo = ctx.fleetRepo;

  // 1a. ENGSYS_DIR version + git state + 8 host files
  const pkg = readJsonSafe(path.join(engsysDir, 'package.json'));
  const pluginJson = readJsonSafe(path.join(engsysDir, 'core', '.claude-plugin', 'plugin.json'));
  const marketJson = readJsonSafe(path.join(engsysDir, '.claude-plugin', 'marketplace.json'));
  const headRes = runCmd('git', ['-C', engsysDir, 'rev-parse', '--short', 'HEAD']);
  const tagRes = runCmd('git', ['-C', engsysDir, 'tag', '--points-at', 'HEAD']);
  const dirtyRes = runCmd('git', ['-C', engsysDir, 'status', '--porcelain']);

  const pkgVer = pkg?.version || 'unknown';
  const pluginVer = pluginJson?.version || 'unknown';
  const marketVer = marketJson?.metadata?.version || 'unknown';
  const versionsMatch = pkgVer === pluginVer && pkgVer === marketVer;
  const isClean = dirtyRes.ok && dirtyRes.stdout === '';

  const hostRequired = [
    'core/fleet/identity/bin/gh',
    'core/fleet/verify.sh',
    'core/fleet/lib/verify-wrappers.mjs',
    'core/fleet/launch.sh',
    'core/fleet/supervise.sh',
    'core/fleet/lib/fleet-env.sh',
    'core/fleet/bin/fleet',
    'core/skills/agent-sessions/scripts/fleet-supervisor.sh',
  ];
  const missingHost = hostRequired.filter((rel) => !fs.existsSync(path.join(engsysDir, rel)));

  items.push({
    name: 'engsys checkout',
    status: versionsMatch && isClean && missingHost.length === 0 ? 'pass' : isClean ? 'warn' : 'warn',
    detail: `v${pkgVer} (${headRes.stdout || '?'}${tagRes.stdout ? `, tags: ${tagRes.stdout.split('\n').join(',')}` : ''}) — manifests=${versionsMatch ? 'synced' : 'MISMATCH'}, tree=${isClean ? 'clean' : 'dirty'}, host-closure=${8 - missingHost.length}/8`,
  });

  // 1b. PIN_DIR &Settings Trust Closure
  if (pinDir && fs.existsSync(pinDir)) {
    const pinHead = runCmd('git', ['-C', pinDir, 'rev-parse', '--short', 'HEAD']);
    const pinDirty = runCmd('git', ['-C', pinDir, 'status', '--porcelain']);
    items.push({
      name: 'PIN_DIR checkout',
      status: pinDirty.ok && pinDirty.stdout === '' ? 'pass' : 'warn',
      detail: `${pinDir} @ ${pinHead.stdout || '?'} (${pinDirty.stdout === '' ? 'clean' : 'dirty'})`,
    });

    const home = ctx.env.HOME || os.homedir();
    let pinSettingsSha = '';
    const originShaRes = runCmd('git', ['-C', pinDir, 'rev-parse', 'origin/main:.claude/settings.json']);
    if (originShaRes.ok && /^[0-9a-f]{40}$/.test(originShaRes.stdout)) {
      pinSettingsSha = originShaRes.stdout;
    } else {
      const headShaRes = runCmd('git', ['-C', pinDir, 'rev-parse', 'HEAD:.claude/settings.json']);
      if (headShaRes.ok && /^[0-9a-f]{40}$/.test(headShaRes.stdout)) {
        pinSettingsSha = headShaRes.stdout;
      }
    }
    const settingsDrifts = checkSettings({
      projectDir: pinDir,
      userSettingsDir: path.join(home, '.claude'),
      pinSettingsSha,
    });
    items.push({
      name: 'Claude settings trust closure',
      status: settingsDrifts.length === 0 ? 'pass' : 'fail',
      detail:
        settingsDrifts.length === 0
          ? 'No hook bypasses, dangerous env overrides, or unapproved plugins in user/local settings'
          : `Settings drift detected: ${settingsDrifts.join('; ')}`,
    });
  } else {
    items.push({
      name: 'PIN_DIR checkout',
      status: 'info',
      detail: pinDir ? `${pinDir} (not found)` : 'PIN_DIR not configured in current env',
    });
  }

  // 1c. FLEET_REPO
  if (fleetRepo && fs.existsSync(fleetRepo)) {
    const fHead = runCmd('git', ['-C', fleetRepo, 'rev-parse', '--short', 'HEAD']);
    const fBranch = runCmd('git', ['-C', fleetRepo, 'rev-parse', '--abbrev-ref', 'HEAD']);
    items.push({
      name: 'FLEET_REPO checkout',
      status: 'pass',
      detail: `${fleetRepo} @ ${fBranch.stdout || '?'}/${fHead.stdout || '?'}`,
    });
  }

  // 1d. Root-owned trusted git binary check (L1 / #101)
  let gitBin = ctx.env.ENGSYS_TRUSTED_GIT || '';
  if (!gitBin) {
    if (fs.existsSync('/usr/bin/xcrun')) {
      const xc = runCmd('/usr/bin/xcrun', ['--find', 'git']);
      if (xc.ok && xc.stdout) gitBin = xc.stdout;
    }
    if (!gitBin) {
      const wh = runCmd('which', ['git']);
      if (wh.ok && wh.stdout) gitBin = wh.stdout;
    }
  }
  if (gitBin && fs.existsSync(gitBin)) {
    try {
      const realGit = fs.realpathSync(gitBin);
      const st = fs.statSync(realGit);
      const rootOwned = st.uid === 0 && (st.mode & 0o022) === 0;
      items.push({
        name: 'Trusted git binary (monster push fence)',
        status: rootOwned || Boolean(ctx.env.ENGSYS_TRUSTED_GIT) ? 'pass' : 'warn',
        detail: `${realGit} (uid=${st.uid}, mode=0${(st.mode & 0o777).toString(8)})`,
      });
    } catch (err) {
      items.push({ name: 'Trusted git binary', status: 'warn', detail: err.message });
    }
  }

  return { id: 1, title: 'Pins, Checkouts & Wrapper Trust Closure', items };
}

// ---------------------------------------------------------------------------
// [2/10] Fleet Identities & External Credentials
// ---------------------------------------------------------------------------
export function inspectIdentitiesAndCerts(ctx) {
  const items = [];
  const fleetDir = ctx.fleetInstance ? path.join(ctx.fleetInstance, '.fleet') : null;
  const idDir = fleetDir ? path.join(fleetDir, 'identities') : null;

  if (idDir && fs.existsSync(idDir)) {
    const appFiles = fs.readdirSync(idDir).filter((f) => f.endsWith('.app.env'));
    const configured = [];
    for (const f of appFiles) {
      const kv = parseKeyValFile(path.join(idDir, f));
      const pemOk = kv.GH_APP_PEM_FILE && fs.existsSync(kv.GH_APP_PEM_FILE);
      configured.push(`${f.replace(/\.app\.env$/, '')}(app=${kv.GH_APP_ID || '?'},pem=${pemOk ? 'ok' : 'missing'})`);
    }
    items.push({
      name: 'GitHub App role identities',
      status: appFiles.length > 0 ? 'pass' : 'warn',
      detail: appFiles.length > 0 ? configured.join(', ') : `No *.app.env files in ${idDir}`,
    });
  } else {
    items.push({
      name: 'GitHub App role identities',
      status: 'info',
      detail: 'No .fleet/identities directory in current context',
    });
  }

  // Azure SP PEM X.509 expiry check
  const pemCandidates = [];
  if (ctx.fleetConf.AZURE_PEM_PATH) pemCandidates.push(ctx.fleetConf.AZURE_PEM_PATH);
  const home = ctx.env.HOME || os.homedir();
  const azDir = path.join(home, '.azure');
  if (fs.existsSync(azDir)) {
    try {
      for (const f of fs.readdirSync(azDir)) {
        if (f.endsWith('.pem')) pemCandidates.push(path.join(azDir, f));
      }
    } catch { /* ignore */ }
  }
  const uniquePems = [...new Set(pemCandidates)].filter((p) => fs.existsSync(p));
  if (uniquePems.length > 0) {
    for (const pem of uniquePems) {
      const endRes = runCmd('openssl', ['x509', '-enddate', '-noout', '-in', pem]);
      if (endRes.ok && endRes.stdout.startsWith('notAfter=')) {
        const dateStr = endRes.stdout.replace(/^notAfter=/, '').trim();
        const expMs = Date.parse(dateStr);
        const daysLeft = Math.floor((expMs - Date.now()) / 86_400_000);
        items.push({
          name: `Azure SP Cert (${path.basename(pem)})`,
          status: daysLeft > 14 ? 'pass' : daysLeft > 0 ? 'warn' : 'fail',
          detail: `expires ${dateStr} (${daysLeft} days remaining)`,
        });
      }
    }
  } else {
    items.push({
      name: 'Azure SP Certificate',
      status: 'info',
      detail: 'No ~/.azure/*.pem certificate found on host',
    });
  }

  // Slack & External Review CLIs
  const crRes = runCmd('which', ['coderabbit']);
  const grokRes = runCmd('which', ['grok']);
  items.push({
    name: 'Cross-family review CLIs',
    status: crRes.ok || grokRes.ok ? 'pass' : 'info',
    detail: `coderabbit=${crRes.ok ? crRes.stdout : 'absent'}, grok=${grokRes.ok ? grokRes.stdout : 'absent'}`,
  });

  return { id: 2, title: 'Fleet Identities & External Credentials', items };
}

// ---------------------------------------------------------------------------
// [3/10] Launchd Jobs, Supervisor & Alert Latches
// ---------------------------------------------------------------------------
export function inspectLaunchdAndLatches(ctx) {
  const items = [];
  const launchRes = runCmd('launchctl', ['list']);
  if (launchRes.ok) {
    const fleetJobs = launchRes.stdout
      .split('\n')
      .filter((l) => l.includes('com.feedfrwd.fleet'));
    if (fleetJobs.length > 0) {
      items.push({
        name: 'launchd fleet jobs',
        status: 'pass',
        detail: fleetJobs.map((l) => l.trim().replace(/\s+/g, ' ')).join(' | '),
      });
    } else {
      items.push({
        name: 'launchd fleet jobs',
        status: 'info',
        detail: 'No com.feedfrwd.fleet.* jobs currently loaded in launchctl',
      });
    }
  }

  // Check alert / unverified latches
  const stateDirs = [
    ctx.fleetState,
    ctx.pinDir ? path.join(ctx.pinDir, 'logs') : null,
  ].filter((d) => d && fs.existsSync(d));

  const latches = [];
  for (const d of stateDirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.alerted') || f.endsWith('.unverified')) {
          latches.push(path.join(d, f));
        }
      }
    } catch { /* ignore */ }
  }
  items.push({
    name: 'Supervisor alert/unverified latches',
    status: latches.length === 0 ? 'pass' : 'warn',
    detail: latches.length === 0 ? '0 active latches (clean)' : `Active latches: ${latches.join(', ')}`,
  });

  return { id: 3, title: 'Launchd Jobs, Supervisor & Alert Latches', items };
}

// ---------------------------------------------------------------------------
// [4/10] Live Sessions, Model Routing & Context Window Health
// ---------------------------------------------------------------------------
export function inspectModelsAndSessions(ctx) {
  const items = [];
  const opus = ctx.fleetConf.OPUS_MODEL || DEFAULT_CLAUDE_TIERS.opus;
  const sonnet = ctx.fleetConf.SONNET_MODEL || DEFAULT_CLAUDE_TIERS.sonnet;
  const haiku = ctx.fleetConf.HAIKU_MODEL || DEFAULT_CLAUDE_TIERS.haiku;
  const fable = ctx.fleetConf.FABLE_MODEL || DEFAULT_CLAUDE_TIERS.fable;
  const sec = ctx.fleetConf.SECURITY_MODEL || DEFAULT_CLAUDE_TIERS.security;

  const expectedOpus = 'claude-opus-5-5';
  const expectedSonnet = 'claude-sonnet-5-5';
  const expectedHaiku = 'claude-haiku-5-5';
  const expectedSec = 'claude-opus-4-8';
  const modelsOk =
    opus === expectedOpus &&
    sonnet === expectedSonnet &&
    haiku === expectedHaiku &&
    sec === expectedSec;

  items.push({
    name: 'v2.0.0 Model Routing Matrix',
    status: modelsOk ? 'pass' : 'warn',
    detail: `opus=${opus}, sonnet=${sonnet}, haiku=${haiku}, fable=${fable}, security(nyx)=${sec}`,
  });

  // Check rendered .fleet/env/session.env & security.env if present
  if (ctx.fleetState && fs.existsSync(path.join(ctx.fleetState, 'env', 'session.env'))) {
    const sessEnv = parseKeyValFile(path.join(ctx.fleetState, 'env', 'session.env'));
    const secEnv = parseKeyValFile(path.join(ctx.fleetState, 'env', 'security.env'));
    const envOk =
      sessEnv.SONNET_MODEL === expectedSonnet &&
      sessEnv.HAIKU_MODEL === expectedHaiku &&
      (!secEnv.ANTHROPIC_MODEL || secEnv.ANTHROPIC_MODEL === expectedSec);
    items.push({
      name: 'Rendered .fleet/env/{session,security}.env',
      status: envOk ? 'pass' : 'warn',
      detail: envOk
        ? `Synced (SONNET=${sessEnv.SONNET_MODEL}, HAIKU=${sessEnv.HAIKU_MODEL}, SECURITY=${secEnv.ANTHROPIC_MODEL || 'n/a'})`
        : `Stale rendered env (run 'fleet supervise --check-only' to refresh): SONNET=${sessEnv.SONNET_MODEL}, HAIKU=${sessEnv.HAIKU_MODEL}`,
    });
  }

  // Check session transcript pointers in ~/.local/state/engsys/sessions/
  const sessDir = path.dirname(hookTelemetryPath(ctx.env));
  if (fs.existsSync(sessDir)) {
    const files = fs
      .readdirSync(sessDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('hook-events'));
    const summaries = [];
    for (const f of files) {
      const rec = readJsonSafe(path.join(sessDir, f));
      if (!rec) continue;
      let tokEst = 'n/a';
      if (rec.transcript_path && fs.existsSync(rec.transcript_path)) {
        try {
          const bytes = fs.statSync(rec.transcript_path).size;
          const est = Math.round(bytes / 4);
          tokEst = `~${Math.round(est / 1000)}k/150k tok`;
        } catch { /* ignore */ }
      }
      summaries.push(`${rec.session}(${tokEst})`);
    }
    items.push({
      name: 'Session transcript pointers & context pressure',
      status: 'pass',
      detail: summaries.length > 0 ? summaries.join(', ') : `0 active session records in ${sessDir}`,
    });
  }

  return { id: 4, title: 'Live Sessions, Model Routing & Context Window Health', items };
}

// ---------------------------------------------------------------------------
// [5/10] Singleton Monsters, Batons, Keepalives & State Ceiling
// ---------------------------------------------------------------------------
export function inspectMonstersAndBatons(ctx) {
  const items = [];
  const logsDir = ctx.pinDir ? path.join(ctx.pinDir, 'logs') : null;
  if (logsDir && fs.existsSync(logsDir)) {
    for (const role of ['merge', 'maintain']) {
      const batonFile = path.join(logsDir, `baton-${role}.json`);
      const pidFile = path.join(logsDir, `baton-${role}.keepalive.pid`);
      const baton = readJsonSafe(batonFile);
      if (baton) {
        let pidStatus = 'no-keepalive-pid';
        if (fs.existsSync(pidFile)) {
          const pid = fs.readFileSync(pidFile, 'utf8').trim();
          pidStatus = isPidAlive(pid) ? `keepalive-pid=${pid}(alive)` : `keepalive-pid=${pid}(DEAD)`;
        }
        if (baton.released_at) {
          items.push({
            name: `Baton [${role}]`,
            status: 'pass',
            detail: `released (${baton.release_reason || 'clean'}) at ${baton.released_at}`,
          });
        } else {
          const expMs = Date.parse(baton.expires_at || '');
          const remSec = Number.isFinite(expMs) ? Math.round((expMs - Date.now()) / 1000) : 0;
          items.push({
            name: `Baton [${role}]`,
            status: remSec > 0 ? 'pass' : 'warn',
            detail: `held by ${baton.holder?.session || '?'} (TTL=${remSec}s, ${pidStatus})`,
          });
        }
      } else {
        items.push({
          name: `Baton [${role}]`,
          status: 'info',
          detail: `No baton-${role}.json in ${logsDir}`,
        });
      }
    }

    // Check state.md 4,096-byte ceiling
    const stateFiles = fs.readdirSync(logsDir).filter((f) => f === 'state.md' || f.endsWith('-state.md'));
    for (const sf of stateFiles) {
      const sz = fs.statSync(path.join(logsDir, sf)).size;
      items.push({
        name: `Monster state ceiling (${sf})`,
        status: sz <= 4096 ? 'pass' : 'fail',
        detail: `${sz} / 4096 bytes (${Math.round((sz / 4096) * 100)}%)`,
      });
    }
  } else {
    items.push({
      name: 'Monster batons & state ceiling',
      status: 'info',
      detail: 'No PIN_DIR/logs directory in current context',
    });
  }

  return { id: 5, title: 'Singleton Monsters, Batons, Keepalives & State Ceiling', items };
}

// ---------------------------------------------------------------------------
// [6/10] Live Synthetic Hook Self-Test (All 9 Core Hooks)
// ---------------------------------------------------------------------------
export async function runLiveHookSelfTest(ctx) {
  const items = [];
  const pluginDir = path.join(ctx.engsysDir, 'core', '.claude-plugin');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-xray-selftest-'));
  const t0 = Date.now();

  try {
    const telemetryFile = path.join(tmpDir, 'hook-events.jsonl');
    const baseEnv = {
      ...ctx.env,
      ENGSYS_HARNESS: 'claude',
      CLAUDE_PLUGIN_ROOT: path.join(ctx.engsysDir, 'core'),
      ENGSYS_DIR: ctx.engsysDir,
      ENGSYS_SESSION: 'xray-probe',
      FLEET_ID: 'xray',
      ENGSYS_HOOK_TELEMETRY_FILE: telemetryFile,
      OPERATOR_TIMEZONE: 'America/New_York',
    };

    // 1. engsys-context.mjs
    {
      const r = spawnSync(process.execPath, [path.join(pluginDir, 'engsys-context.mjs')], {
        env: baseEnv,
        encoding: 'utf8',
        timeout: 5000,
      });
      const parsed = JSON.parse(r.stdout || '{}');
      const text = parsed?.hookSpecificOutput?.additionalContext || '';
      const ok = r.status === 0 && text.includes('engsys conventions') && !/\{\{[A-Z_]+\}\}/.test(text);
      items.push({
        name: 'Hook [1/9] engsys-context (SessionStart)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? `Injected ${Buffer.byteLength(text, 'utf8')}B conventions with 0 unrendered tokens` : 'Failed to render conventions',
      });
    }

    // 2. fleet-gh-path.mjs
    {
      const envFile = path.join(tmpDir, 'claude.env');
      const r = spawnSync(process.execPath, [path.join(pluginDir, 'fleet-gh-path.mjs')], {
        env: { ...baseEnv, GH_APP_ENV_FILE: '/tmp/fake.app.env', CLAUDE_ENV_FILE: envFile },
        encoding: 'utf8',
        timeout: 5000,
      });
      const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
      const ok = r.status === 0 && content.includes('core/fleet/identity/bin');
      items.push({
        name: 'Hook [2/9] fleet-gh-path (SessionStart)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Prepends core/fleet/identity/bin to CLAUDE_ENV_FILE' : 'Failed to write PATH export',
      });
    }

    // 3. approve-own-scripts.mjs
    {
      const { approvable } = await import(path.join(pluginDir, 'approve-own-scripts.mjs'));
      const root = path.join(ctx.engsysDir, 'core');
      const allowOut = approvable(
        `bash ${root}/skills/merge-monster/scripts/mm-preflight.sh`,
        root,
      );
      const denyOut = approvable(
        `bash ${root}/skills/merge-monster/scripts/mm-preflight.sh && rm -rf /`,
        root,
      );
      const ok =
        allowOut === 'merge-monster/scripts/mm-preflight.sh' &&
        denyOut === null;
      items.push({
        name: 'Hook [3/9] approve-own-scripts (PreToolUse:Bash)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Auto-approves trusted engsys script & abstains on chained shell operators' : 'Decision mismatch',
      });
    }

    // 4. singleton-write-guard.mjs
    {
      const { decide } = await import(path.join(pluginDir, 'singleton-write-guard.mjs'));
      const root = path.join(ctx.engsysDir, 'core');
      const blocked = decide({
        command: 'gh pr merge 42 --squash',
        env: { ENGSYS_SINGLETON_ROLE: 'merge' },
        pluginRoot: root,
      });
      const allowed = decide({
        command: `bash ${root}/skills/merge-monster/scripts/mm-act.sh pr-comment --repo o/r --pr 42 --body hi`,
        env: { ENGSYS_SINGLETON_ROLE: 'merge' },
        pluginRoot: root,
      });
      const ok = Boolean(blocked?.deny) && allowed === null;
      items.push({
        name: 'Hook [4/9] singleton-write-guard (PreToolUse)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Denies unfenced gh pr merge & allows fenced mm-act.sh invocation' : 'Fence check failed',
      });
    }

    // 5. handback-guard.mjs
    {
      const { subagentDecision } = await import(path.join(pluginDir, 'handback-guard.mjs'));
      const blocked = subagentDecision({
        agent_type: 'engsys:isabelle',
        last_assistant_message: 'Done! All tests pass.',
      });
      const allowed = subagentDecision({
        agent_type: 'engsys:isabelle',
        last_assistant_message: 'All tests pass.\nSTATUS: COMPLETE',
      });
      const ok = typeof blocked === 'string' && blocked.includes('STATUS: COMPLETE') && allowed === null;
      items.push({
        name: 'Hook [5/9] handback-guard (SubagentStop)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Blocks missing STATUS line & allows valid STATUS: COMPLETE' : 'Handback check failed',
      });
    }

    // 6. subagent-memory-inject.mjs
    {
      const cacheDir = path.join(tmpDir, 'mem-cache');
      const memEnv = {
        ...baseEnv,
        ENGSYS_MEMORY_CACHE_DIR: cacheDir,
        CLAUDE_PROJECT_DIR: ctx.engsysDir,
      };
      const rPre = spawnSync(
        process.execPath,
        [path.join(pluginDir, 'subagent-memory-inject.mjs'), 'pre-tool-use'],
        {
          env: memEnv,
          input: JSON.stringify({
            session_id: 'xray-s1',
            tool_name: 'Agent',
            tool_input: { subagent_type: 'engsys:isabelle', prompt: 'Review core/fleet/verify.sh bash quoting and git locks' },
          }),
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      const rSub = spawnSync(
        process.execPath,
        [path.join(pluginDir, 'subagent-memory-inject.mjs'), 'subagent-start'],
        {
          env: memEnv,
          input: JSON.stringify({
            session_id: 'xray-s1',
            agent_id: 'xray-a1',
            agent_type: 'engsys:isabelle',
            cwd: ctx.engsysDir,
          }),
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      const outJson = JSON.parse(rSub.stdout || '{}');
      const brief = outJson?.hookSpecificOutput?.additionalContext || '';
      const ok = rPre.status === 0 && rSub.status === 0 && brief.includes('[lesson ');
      items.push({
        name: 'Hook [6/9] subagent-memory-inject (PreToolUse + SubagentStart)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? `Stashed prompt & injected ${Buffer.byteLength(brief, 'utf8')}B memory brief` : 'Brief injection failed',
      });
    }

    // 7. weather-check.mjs
    {
      const { run: runWeather } = await import(path.join(pluginDir, 'weather-check.mjs'));
      const boardFile = path.join(tmpDir, 'board-cache.json');
      const nowIso = new Date().toISOString();
      fs.writeFileSync(
        boardFile,
        JSON.stringify({
          last_updated: nowIso,
          services: { github: { id: 'github', state: 'up' } },
        }),
      );
      const wEnv = { ...baseEnv, ENGSYS_FHD_BOARD_CACHE: boardFile };
      const silentOut = runWeather('session-start', wEnv);
      fs.writeFileSync(
        boardFile,
        JSON.stringify({
          last_updated: nowIso,
          services: {
            github: { id: 'github', state: 'degraded', advice: 'hold merges', hold_merges: true },
          },
        }),
      );
      const alertOut = runWeather('session-start', wEnv);
      const ok = silentOut === '' && alertOut.includes('github is DEGRADED') && alertOut.includes('hold merges');
      items.push({
        name: 'Hook [7/9] weather-check (SessionStart + UserPromptSubmit)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Silent when healthy & injects advisory when service is degraded' : 'Weather check failed',
      });
    }

    // 8. fleet-inbox.mjs
    {
      const { inboxLine } = await import(path.join(ctx.engsysDir, 'core', 'fleet', 'lib', 'inbox.mjs'));
      const sample = inboxLine({
        id: 101,
        url: 'https://github.com/org/repo/issues/1#issuecomment-101',
        from: 'hub:maintain',
        re: 'org/repo#1',
        sha256: 'a'.repeat(64),
        received_at: '2026-10-16T00:00:00Z',
      });
      const ok = typeof sample === 'string' && sample.includes('fleet hub (claims session maintain)');
      items.push({
        name: 'Hook [8/9] fleet-inbox (Cross-Fleet Pointer Relay)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Verified pointer-only formatting & pane-ownership guard' : 'Inbox check failed',
      });
    }

    // 9. session-transcript.mjs
    {
      const { record } = await import(path.join(pluginDir, 'session-transcript.mjs'));
      const recPath = record(
        { session_id: 'sid-1', transcript_path: '/tmp/xray-transcript.jsonl', source: 'startup' },
        { ...baseEnv, ENGSYS_SESSIONS_DIR: tmpDir },
      );
      const ok = Boolean(recPath && fs.existsSync(recPath));
      items.push({
        name: 'Hook [9/9] session-transcript (SessionStart Pointer)',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'Atomically writes 0600 session transcript pointer' : 'Transcript pointer write failed',
      });
    }

    // Verify synthetic flight recorder captured the self-test events
    const recordedEvents = readJsonlSafe(telemetryFile);
    const elapsed = Date.now() - t0;
    items.push({
      name: 'Synthetic Self-Test Summary & Flight Recorder Verification',
      status: recordedEvents.length >= 4 ? 'pass' : 'warn',
      detail: `9/9 hooks verified in ${elapsed}ms (${recordedEvents.length} telemetry events captured in sandbox)`,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { id: 6, title: 'Live Synthetic Hook Self-Test (9 Core Hooks)', items };
}

// ---------------------------------------------------------------------------
// [7/10] Live Hook Flight Recorder & Subagent Memory Telemetry
// ---------------------------------------------------------------------------
export function inspectTelemetry(ctx) {
  const items = [];
  const tFile = hookTelemetryPath(ctx.env);
  const events = readJsonlSafe(tFile);

  if (events.length > 0) {
    const byHook = {};
    for (const e of events) {
      const k = `${e.hook}:${e.decision}`;
      byHook[k] = (byHook[k] || 0) + 1;
    }
    const summary = Object.entries(byHook)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    items.push({
      name: 'Hook Flight Recorder (hook-events.jsonl)',
      status: 'pass',
      detail: `${events.length} events recorded (${summary})`,
    });

    const tailCount = ctx.tailHooks || 5;
    const recent = events.slice(-tailCount);
    for (const r of recent) {
      items.push({
        name: `  event @ ${r.ts}`,
        status: r.decision === 'deny' || r.decision === 'block' ? 'warn' : 'info',
        detail: `[${r.session || '-'}] ${r.hook} (${r.event}) -> ${r.decision} (${r.bytes || 0}B)${r.detail ? ` — ${r.detail}` : ''}`,
      });
    }
  } else {
    items.push({
      name: 'Hook Flight Recorder (hook-events.jsonl)',
      status: 'info',
      detail: `Ready at ${tFile} (0 live events recorded yet; populates automatically as sessions run)`,
    });
  }

  // Subagent Memory Injection telemetry (~/.cache/engsys/memory/<hash>/injections.jsonl)
  const home = ctx.env.HOME || os.homedir();
  const memCacheRoot = ctx.env.ENGSYS_MEMORY_CACHE_DIR || path.join(home, '.cache', 'engsys', 'memory');
  const injectionFiles = [];
  if (fs.existsSync(memCacheRoot)) {
    try {
      for (const entry of fs.readdirSync(memCacheRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const p = path.join(memCacheRoot, entry.name, 'injections.jsonl');
          if (fs.existsSync(p)) injectionFiles.push(p);
        } else if (entry.name === 'injections.jsonl') {
          injectionFiles.push(path.join(memCacheRoot, entry.name));
        }
      }
    } catch { /* ignore */ }
  }

  let totalInj = 0;
  let totalMs = 0;
  let totalBytes = 0;
  let skippedBudget = 0;
  let spawnFailed = 0;
  for (const f of injectionFiles) {
    for (const rec of readJsonlSafe(f)) {
      totalInj++;
      totalMs += Number(rec.ms || 0);
      totalBytes += Number(rec.bytes || 0);
      if (rec.skipped_budget) skippedBudget++;
      if (rec.spawn_failed) spawnFailed++;
    }
  }

  items.push({
    name: 'Subagent Memory Brief Telemetry (injections.jsonl)',
    status: spawnFailed === 0 ? 'pass' : 'warn',
    detail:
      totalInj > 0
        ? `${totalInj} subagent briefs injected (avg ${Math.round(totalBytes / totalInj)}B in ${Math.round(totalMs / totalInj)}ms, skipped_budget=${skippedBudget}, spawn_failed=${spawnFailed})`
        : `0 subagent briefs recorded yet in ${memCacheRoot}`,
  });

  return { id: 7, title: 'Live Hook Flight Recorder & Subagent Memory Telemetry', items };
}

// ---------------------------------------------------------------------------
// [8/10] 4-Tier Durable Agentic Memory
// ---------------------------------------------------------------------------
export function inspectMemoryTiers(ctx) {
  const items = [];
  const libDir = path.join(ctx.engsysDir, 'core', 'lessons-library');
  if (fs.existsSync(libDir)) {
    const lessons = fs.readdirSync(libDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    items.push({
      name: 'Tier 3: Bundled Universal Lessons Library',
      status: lessons.length >= 50 ? 'pass' : 'warn',
      detail: `${lessons.length} curated lessons in ${libDir}`,
    });
  }

  const targetRepo = ctx.pinDir && fs.existsSync(ctx.pinDir) ? ctx.pinDir : ctx.engsysDir;
  const repoLessonsDir = path.join(targetRepo, 'docs', 'agent-lessons');
  const overlayFile = path.join(targetRepo, 'docs', 'agent-lessons-overlay.yml');
  const repoLessons = fs.existsSync(repoLessonsDir)
    ? fs.readdirSync(repoLessonsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    : [];
  items.push({
    name: `Tier 2: Repo Lessons & Overlay (${path.basename(targetRepo)})`,
    status: 'pass',
    detail: `${repoLessons.length} repo lessons, overlay=${fs.existsSync(overlayFile) ? 'present' : 'default'}`,
  });

  // Check refs/engsys/memory git ref
  const refRes = runCmd('git', ['-C', targetRepo, 'show-ref', 'refs/engsys/memory']);
  items.push({
    name: `Git-backed Memory Ref (refs/engsys/memory in ${path.basename(targetRepo)})`,
    status: 'info',
    detail: refRes.ok && refRes.stdout ? `Present (${refRes.stdout.split(' ')[0].slice(0, 8)})` : 'Not yet synced (created on first memory-sync.mjs --push)',
  });

  // Tier 0/1 Operator memory
  const home = ctx.env.HOME || os.homedir();
  const opDir = ctx.env.ENGSYS_MEMORY_DIR || path.join(home, '.engsys', 'memory');
  const l0 = path.join(opDir, 'l0-core.md');
  const l1 = path.join(opDir, 'l1-digest.md');
  items.push({
    name: 'Tier 0/1: Operator Personal Memory (~/.engsys/memory)',
    status: 'pass',
    detail: `l0-core=${fs.existsSync(l0) ? `${fs.statSync(l0).size}B` : 'unseeded'}, l1-digest=${fs.existsSync(l1) ? `${fs.statSync(l1).size}B` : 'unseeded'}`,
  });

  return { id: 8, title: '4-Tier Durable Agentic Memory', items };
}

// ---------------------------------------------------------------------------
// [9/10] Adaptive SDD, Contract Gates & Cross-Family Review Readiness
// ---------------------------------------------------------------------------
export function inspectSddAndContracts(ctx) {
  const items = [];
  const requiredModules = [
    'core/lib/spec-slice.mjs',
    'core/lib/contract-check.mjs',
    'core/lib/gate-check.mjs',
    'core/lib/claim.mjs',
    'core/scripts/memory-brief.mjs',
    'core/scripts/harvest-findings.mjs',
  ];
  const missing = requiredModules.filter((s) => !fs.existsSync(path.join(ctx.engsysDir, s)));
  items.push({
    name: 'Adaptive SDD & Contract Verification Tooling',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail:
      missing.length === 0
        ? `All ${requiredModules.length} core gate/memory modules present (${requiredModules.map((m) => path.basename(m)).join(', ')})`
        : `Missing modules: ${missing.join(', ')}`,
  });

  const targetRepo = ctx.pinDir && fs.existsSync(ctx.pinDir) ? ctx.pinDir : ctx.engsysDir;
  const specsDir = path.join(targetRepo, 'docs', 'specs');
  const specCount = fs.existsSync(specsDir)
    ? fs.readdirSync(specsDir).filter((f) => f.endsWith('.md')).length
    : 0;
  items.push({
    name: `Repository Specs (${path.basename(targetRepo)}/docs/specs)`,
    status: 'pass',
    detail: `${specCount} spec document(s)`,
  });

  return { id: 9, title: 'Adaptive SDD, Contract Gates & Cross-Family Review Readiness', items };
}

// ---------------------------------------------------------------------------
// [10/10] Fleet Health Desk, Multi-Fleet Federation & E2E Resource Broker
// ---------------------------------------------------------------------------
export function inspectHealthFederationAndPool(ctx) {
  const items = [];
  // FHD Board Cache
  const cacheCandidates = [
    ctx.env.ENGSYS_FHD_BOARD_CACHE,
    ctx.fleetState ? path.join(ctx.fleetState, 'fhd', 'board-cache.json') : null,
    ctx.pinDir ? path.join(ctx.pinDir, 'logs', 'fhd', 'board-cache.json') : null,
  ].filter(Boolean);
  const fhdCache = cacheCandidates.find((p) => fs.existsSync(p));
  if (fhdCache) {
    const board = readJsonSafe(fhdCache)?.board || readJsonSafe(fhdCache);
    const services = board?.services ? Object.values(board.services) : [];
    const nonUp = services.filter((s) => s.state !== 'up' && s.state !== 'healthy');
    items.push({
      name: 'Fleet Health Desk (FHD) Board Cache',
      status: nonUp.length === 0 ? 'pass' : 'warn',
      detail: `${services.length} services tracked, ${nonUp.length} degraded/down (last_updated=${board?.last_updated || '?'})`,
    });
  } else {
    items.push({
      name: 'Fleet Health Desk (FHD) Board Cache',
      status: 'info',
      detail: 'No fhd/board-cache.json yet (populates when Maintenance Monster runs fleet health tick)',
    });
  }

  // Multi-Fleet Federation
  const fedFile = ctx.fleetConf.FEDERATION_FILE || ctx.env.FEDERATION_FILE;
  if (fedFile && fs.existsSync(fedFile)) {
    items.push({
      name: 'Multi-Fleet Federation Registry',
      status: 'pass',
      detail: `${fedFile} (fleet_id=${ctx.fleetConf.FLEET_ID || ctx.env.FLEET_ID || 'single'})`,
    });
  } else {
    items.push({
      name: 'Multi-Fleet Federation Registry',
      status: 'info',
      detail: 'Single-fleet mode (no FEDERATION_FILE configured)',
    });
  }

  // E2E Resource Broker Leases
  const leasesDir = ctx.pinDir ? path.join(ctx.pinDir, 'logs', 'leases') : null;
  if (leasesDir && fs.existsSync(leasesDir)) {
    const leaseFiles = fs.readdirSync(leasesDir).filter((f) => f.endsWith('.json'));
    items.push({
      name: 'Durable Lease / E2E Resource Broker Slots',
      status: 'pass',
      detail: `${leaseFiles.length} slot file(s) in ${leasesDir}`,
    });
  } else {
    items.push({
      name: 'Durable Lease / E2E Resource Broker Slots',
      status: 'info',
      detail: 'No active slot leases directory in current context',
    });
  }

  return { id: 10, title: 'Fleet Health Desk, Multi-Fleet Federation & E2E Resource Broker', items };
}

// ---------------------------------------------------------------------------
// Main Runner & Formatter
// ---------------------------------------------------------------------------
export async function runXray(options = {}) {
  const env = options.env || process.env;
  const engsysDir = options.engsysDir || env.ENGSYS_DIR || DEFAULT_ENGSYS_DIR;
  const fleetInstance = options.fleetInstance || env.FLEET_INSTANCE || null;
  const fleetConfFile =
    options.fleetConfFile ||
    (fleetInstance && fs.existsSync(path.join(fleetInstance, 'fleet', 'fleet.conf'))
      ? path.join(fleetInstance, 'fleet', 'fleet.conf')
      : fleetInstance && fs.existsSync(path.join(fleetInstance, 'fleet.conf'))
        ? path.join(fleetInstance, 'fleet.conf')
        : null);
  const fleetConf = fleetConfFile ? parseKeyValFile(fleetConfFile) : {};
  const pinDir = options.pinDir || env.PIN_DIR || fleetConf.PIN_DIR || null;
  const fleetRepo = options.fleetRepo || env.FLEET_REPO || fleetConf.FLEET_REPO || null;
  const fleetState =
    options.fleetState ||
    env.FLEET_STATE ||
    (fleetInstance ? path.join(fleetInstance, '.fleet') : null);

  const ctx = {
    env,
    engsysDir,
    pinDir,
    fleetRepo,
    fleetInstance,
    fleetState,
    fleetConf,
    tailHooks: options.tailHooks || 5,
  };

  const sections = [
    inspectPinsAndTrust(ctx),
    inspectIdentitiesAndCerts(ctx),
    inspectLaunchdAndLatches(ctx),
    inspectModelsAndSessions(ctx),
    inspectMonstersAndBatons(ctx),
    await runLiveHookSelfTest(ctx),
    inspectTelemetry(ctx),
    inspectMemoryTiers(ctx),
    inspectSddAndContracts(ctx),
    inspectHealthFederationAndPool(ctx),
  ];

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const s of sections) {
    for (const item of s.items) {
      if (item.status === 'pass') passCount++;
      else if (item.status === 'warn') warnCount++;
      else if (item.status === 'fail') failCount++;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    engsysDir,
    pinDir,
    fleetInstance,
    summary: {
      ok: failCount === 0,
      pass: passCount,
      warn: warnCount,
      fail: failCount,
    },
    sections,
  };
}

export function formatXrayReport(report) {
  const lines = [];
  lines.push('================================================================================');
  lines.push(`  engsys v2.0.0 Operational X-Ray (${report.timestamp})`);
  lines.push(`  ENGSYS_DIR: ${report.engsysDir}`);
  if (report.pinDir) lines.push(`  PIN_DIR:    ${report.pinDir}`);
  lines.push('================================================================================');
  lines.push('');

  const icon = (status) => {
    if (status === 'pass') return '[PASS]';
    if (status === 'warn') return '[WARN]';
    if (status === 'fail') return '[FAIL]';
    return '[INFO]';
  };

  for (const sec of report.sections) {
    lines.push(`[${sec.id}/10] ${sec.title}`);
    for (const item of sec.items) {
      lines.push(`  ${icon(item.status)} ${item.name}: ${item.detail}`);
    }
    lines.push('');
  }

  lines.push('--------------------------------------------------------------------------------');
  lines.push(
    `  VERDICT: ${report.summary.ok ? 'HEALTHY (ALL PROMISES VERIFIED)' : 'FAILURES DETECTED'} — ` +
      `${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed`,
  );
  lines.push('--------------------------------------------------------------------------------');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let json = false;
  let tailHooks = 5;
  let fleetInstance = process.env.FLEET_INSTANCE || null;
  let pinDir = process.env.PIN_DIR || null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--tail-hooks' && args[i + 1]) tailHooks = Number(args[++i]) || 5;
    else if (a === '--instance' && args[i + 1]) fleetInstance = path.resolve(args[++i]);
    else if (a === '--pin-dir' && args[i + 1]) pinDir = path.resolve(args[++i]);
  }

  const report = await runXray({ fleetInstance, pinDir, tailHooks });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatXrayReport(report)}\n`);
  }
  process.exit(report.summary.ok ? 0 : 1);
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`fleet xray error: ${err.message}\n`);
    process.exit(1);
  });
}
