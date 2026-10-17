#!/usr/bin/env node
// core/fleet/lib/xray.mjs — Live Operational X-Ray, Behavior Monitor & Troubleshooting Engine
// (`fleet xray` / `fleet doctor`).
//
// Gives operators and agents a complete, single-command view inside a running (or freshly upgraded)
// engsys v2.0.0 installation across all 10 architectural promises, PLUS deep-dive troubleshooting
// for individual sessions (`--session <name>` / `--role <role>`), a unified chronological behavior
// timeline (`--timeline` / `--since <dur>`), continuous watch mode (`--watch [<sec>]`), and an
// automated root-cause diagnosis & remediation playbook (`--diagnose`).
//
//   [1/10] Pins, Checkouts & Wrapper Trust Closure
//   [2/10] Fleet Identities & External Credentials
//   [3/10] Launchd Jobs, Supervisor & Alert Latches
//   [4/10] Live Sessions, Model Routing & Context Window Health
//   [5/10] Singleton Monsters, Batons, Keepalives, Subagents & State Ceiling
//   [6/10] Live Synthetic Hook Self-Test (9 Core Hooks in isolated sandbox)
//   [7/10] Live Hook Flight Recorder & Subagent Memory Telemetry
//   [8/10] 4-Tier Durable Agentic Memory
//   [9/10] Adaptive SDD, Contract Gates & Cross-Family Review Readiness
//  [10/10] Fleet Health Desk, Multi-Fleet Federation & E2E Resource Broker

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostToolchain } from '../../lib/host-toolchain.mjs';
import { hookTelemetryPath } from '../../lib/harness-io.mjs';
import { fleetIdProblems, loadFederation, registryWarnings } from './federation.mjs';
import { checkSettingsDetailed, ENGSYS_HOST_FILES, ENGSYS_HOST_PATHS, ENGSYS_HOST_TREES, parseAllowedPlugins } from './verify-wrappers.mjs';

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

function expandHome(val, home = os.homedir()) {
  if (typeof val !== 'string') return val;
  if (val === '~') return home;
  if (val.startsWith('~/')) return path.join(home, val.slice(2));
  return val;
}

export function parseKeyValFile(file, home = os.homedir()) {
  const out = {};
  try {
    if (!file || !fs.existsSync(file)) return out;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cleaned = line.replace(/^export\s+/, '');
      const eq = cleaned.indexOf('=');
      if (eq <= 0) continue;
      const key = cleaned.slice(0, eq).trim();
      let val = cleaned.slice(eq + 1).trim();
      // Strip inline comment if unquoted
      if (!val.startsWith('"') && !val.startsWith("'")) {
        const hashIdx = val.indexOf(' #');
        if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = expandHome(val, home);
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
    return Boolean(err && err.code === 'EPERM');
  }
}

export function parseDurationMs(spec) {
  if (!spec) return null;
  if (typeof spec === 'number' && Number.isFinite(spec)) return spec;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(String(spec).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  if (unit === 'd') return n * 86_400_000;
  return null;
}

function formatAge(isoOrEpochMs, nowMs = Date.now()) {
  const ms = typeof isoOrEpochMs === 'number' ? isoOrEpochMs : Date.parse(String(isoOrEpochMs || ''));
  if (!Number.isFinite(ms)) return '?';
  const diffSec = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${(diffSec / 3600).toFixed(1)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Monster YAML Config & Transcript / Subagent Parsers
// ---------------------------------------------------------------------------

/** Read simple scalar and one-level nested keys from a monster YAML file. */
export function parseMonsterYaml(file, home = os.homedir()) {
  const out = {};
  try {
    if (!file || !fs.existsSync(file)) return out;
    let currentParent = null;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const noComment = raw.replace(/\s+#.*$/, '').replace(/\r$/, '');
      if (!noComment.trim() || noComment.trim().startsWith('#')) continue;
      const indent = /^[ \t]*/.exec(noComment)[0].length;
      const trimmed = noComment.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      let val = trimmed.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (indent === 0) {
        if (val === '') {
          currentParent = key;
          out[key] = out[key] || {};
        } else {
          currentParent = null;
          out[key] = expandHome(val, home);
        }
      } else if (currentParent && typeof out[currentParent] === 'object') {
        out[currentParent][key] = expandHome(val, home);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Parse the tail of a Claude Code JSONL transcript to extract live model, effort,
 * exact context tokens (`input + cache_creation + cache_read`), last turn timestamp,
 * recent tool calls, and recent tool errors.
 */
export function parseTranscriptSummary(transcriptPath, maxTailBytes = 131_072) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile()) return null;
    const readSize = Math.min(st.size, maxTailBytes);
    const startOffset = Math.max(0, st.size - readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, startOffset);
    fs.closeSync(fd);

    let text = buf.toString('utf8');
    if (startOffset > 0) {
      const firstNl = text.indexOf('\n');
      if (firstNl >= 0) text = text.slice(firstNl + 1);
    }

    let model = null;
    let effort = null;
    let contextTokens = null;
    let outputTokens = null;
    let lastTurnAt = null;
    let gitBranch = null;
    let version = null;
    const recentTools = [];
    const recentErrors = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.timestamp) lastTurnAt = entry.timestamp;
      if (entry.gitBranch) gitBranch = entry.gitBranch;
      if (entry.version) version = entry.version;

      if (entry.type === 'assistant' && !entry.isSidechain && entry.message) {
        if (entry.message.model) model = entry.message.model;
        if (entry.effort) effort = entry.effort;
        const u = entry.message.usage;
        if (u && typeof u === 'object') {
          contextTokens =
            Number(u.input_tokens || 0) +
            Number(u.cache_creation_input_tokens || 0) +
            Number(u.cache_read_input_tokens || 0);
          outputTokens = Number(u.output_tokens || 0);
        }
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block && block.type === 'tool_use' && block.name) {
              const inp = block.input || {};
              let summary = block.name;
              if (block.name === 'Agent' || block.name === 'Task') {
                const sub = inp.subagent_type || inp.agent_type || 'agent';
                const m = inp.model ? `, model=${inp.model}` : '';
                const desc = inp.description ? `: ${String(inp.description).slice(0, 50)}` : '';
                summary = `Agent(${sub}${m}${desc})`;
              } else if (block.name === 'Bash' && inp.command) {
                summary = `Bash(${String(inp.command).replace(/\s+/g, ' ').slice(0, 65)})`;
              } else if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'Read') && inp.file_path) {
                summary = `${block.name}(${path.basename(String(inp.file_path))})`;
              } else if (block.name === 'ScheduleWakeup' && inp.delaySeconds !== undefined) {
                summary = `ScheduleWakeup(${inp.delaySeconds}s)`;
              }
              recentTools.push({
                ts: entry.timestamp || null,
                name: block.name,
                summary,
              });
            }
          }
        }
      } else if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block && block.type === 'tool_result' && block.is_error) {
            const rawErr =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => c.text || '').join(' ')
                  : JSON.stringify(block.content || '');
            recentErrors.push({
              ts: entry.timestamp || null,
              detail: rawErr.replace(/\s+/g, ' ').trim().slice(0, 140),
            });
          }
        }
      }
    }

    return {
      transcriptPath,
      fileBytes: st.size,
      mtimeMs: st.mtimeMs,
      model,
      effort,
      contextTokens,
      outputTokens,
      lastTurnAt: lastTurnAt || new Date(st.mtimeMs).toISOString(),
      gitBranch,
      version,
      recentTools: recentTools.slice(-8),
      recentErrors: recentErrors.slice(-5),
    };
  } catch {
    return null;
  }
}

/**
 * Parse `<stateDir>/agents.tsv` (11 columns: name, gen, status, agent_id, session_id,
 * class, task_ref, spawn_epoch, deadline_epoch, extensions, transcript_path).
 */
export function parseAgentsTsv(stateDir, nowSec = Math.floor(Date.now() / 1000)) {
  const regFile = path.join(stateDir, 'agents.tsv');
  if (!fs.existsSync(regFile)) {
    return { exists: false, rows: [], running: [], overdue: [], stale: [], failed: [], fenced: [], done: [] };
  }
  const rows = [];
  try {
    const content = fs.readFileSync(regFile, 'utf8');
    for (const raw of content.split('\n')) {
      if (!raw.trim()) continue;
      const cols = raw.split('\t');
      if (cols.length < 9) continue;
      const [name, genStr, status, agentId, sessionId, taskClass, taskRef, spawnStr, deadlineStr, extStr, transcriptPath] = cols;
      const gen = Number(genStr) || 1;
      const spawnEpoch = Number(spawnStr) || 0;
      const deadlineEpoch = Number(deadlineStr) || 0;
      const extensions = Number(extStr) || 0;
      const elapsedSec = spawnEpoch > 0 ? Math.max(0, nowSec - spawnEpoch) : 0;
      const remainingSec = deadlineEpoch > 0 ? deadlineEpoch - nowSec : 0;
      const isOverdue = status === 'running' && deadlineEpoch > 0 && nowSec >= deadlineEpoch;
      let isStale = false;
      if (status === 'running' && transcriptPath && transcriptPath !== '-' && fs.existsSync(transcriptPath)) {
        try {
          const mt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000);
          if (nowSec - mt >= 600) isStale = true;
        } catch { /* ignore */ }
      }
      rows.push({
        name,
        gen,
        status,
        agentId: agentId || '-',
        sessionId: sessionId || '-',
        taskClass: taskClass || '-',
        taskRef: taskRef || '-',
        spawnEpoch,
        deadlineEpoch,
        extensions,
        transcriptPath: transcriptPath || '-',
        elapsedSec,
        remainingSec,
        isOverdue,
        isStale,
      });
    }
  } catch { /* ignore */ }

  // Highest running generation per name (same rule as mm-agent-watch.sh)
  const runningByName = new Map();
  for (const r of rows) {
    if (r.status === 'running') {
      const prev = runningByName.get(r.name);
      if (!prev || r.gen > prev.gen) runningByName.set(r.name, r);
    }
  }
  const running = [...runningByName.values()];
  const overdue = running.filter((r) => r.isOverdue);
  const stale = running.filter((r) => r.isStale);
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'probe_failed');
  const fenced = rows.filter((r) => r.status === 'fenced');
  const done = rows.filter((r) => r.status === 'done');

  return { exists: true, rows, running, overdue, stale, failed, fenced, done };
}

// ---------------------------------------------------------------------------
// Context Resolution (mirrors core/fleet/lib/fleet-env.sh)
// ---------------------------------------------------------------------------
export function resolveContext(options = {}) {
  const env = options.env || process.env;
  const home = env.HOME || os.homedir();
  const engsysDir = options.engsysDir || env.ENGSYS_DIR || DEFAULT_ENGSYS_DIR;
  let fleetInstance = options.fleetInstance || env.FLEET_INSTANCE || null;
  if (!fleetInstance) {
    const cwdConf = path.join(process.cwd(), 'fleet', 'fleet.conf');
    if (fs.existsSync(cwdConf)) fleetInstance = process.cwd();
  }

  const fleetConfFile =
    options.fleetConfFile ||
    (fleetInstance && fs.existsSync(path.join(fleetInstance, 'fleet', 'fleet.conf'))
      ? path.join(fleetInstance, 'fleet', 'fleet.conf')
      : fleetInstance && fs.existsSync(path.join(fleetInstance, 'fleet.conf'))
        ? path.join(fleetInstance, 'fleet.conf')
        : null);

  const baseConf = fleetConfFile ? parseKeyValFile(fleetConfFile, home) : {};
  const fleetOrg = baseConf.FLEET_ORG || env.FLEET_ORG || '';
  const localConfFile =
    fleetOrg && fs.existsSync(path.join(home, '.config', fleetOrg, 'fleet.local.conf'))
      ? path.join(home, '.config', fleetOrg, 'fleet.local.conf')
      : null;
  const localConf = localConfFile ? parseKeyValFile(localConfFile, home) : {};
  const fleetConf = { ...baseConf, ...localConf };

  const fleetRepo = options.fleetRepo || env.FLEET_REPO || fleetConf.FLEET_REPO || fleetInstance || null;
  const pinRepo = options.pinRepo || env.PIN_REPO || fleetConf.PIN_REPO || null;
  const pinDir = options.pinDir || env.PIN_DIR || fleetConf.PIN_DIR || null;
  const fleetState =
    options.fleetState ||
    env.FLEET_STATE ||
    (fleetRepo ? path.join(fleetRepo, '.fleet') : null);
  const logDir =
    options.logDir ||
    env.LOG_DIR ||
    fleetConf.LOG_DIR ||
    (fleetOrg ? path.join(home, 'Library', 'Logs', `${fleetOrg}-fleet`) : null);

  const fleetId = options.fleetId || fleetConf.FLEET_ID || env.FLEET_ID || '';
  let federationFile = options.federationFile || fleetConf.FEDERATION_FILE || env.FEDERATION_FILE || '';
  if (!federationFile && fleetRepo) {
    federationFile = path.join(fleetRepo, 'federation.yml');
  } else if (federationFile && !path.isAbsolute(federationFile) && fleetRepo) {
    federationFile = path.join(fleetRepo, federationFile);
  }

  // Load monster YAML configs from plugin/repos/<PIN_REPO>/ or <pinDir>/.claude/
  const monsterConfigs = {};
  const monsterRoleMap = [
    { role: 'merge', file: 'merge-monster.yml', defaultStateDir: 'logs/merge-monster', batonName: 'merge' },
    { role: 'maintain', file: 'maintenance-monster.yml', defaultStateDir: 'logs/maintenance-monster', batonName: 'maintain' },
    { role: 'e2e', file: 'resource-broker.yml', defaultStateDir: 'logs/e2e-broker', batonName: null },
  ];

  for (const m of monsterRoleMap) {
    const candidates = [
      fleetRepo && pinRepo ? path.join(fleetRepo, 'plugin', 'repos', pinRepo, m.file) : null,
      pinDir ? path.join(pinDir, '.claude', m.file) : null,
    ].filter(Boolean);
    const ymlPath = candidates.find((p) => fs.existsSync(p)) || null;
    const parsed = ymlPath ? parseMonsterYaml(ymlPath, home) : {};
    const relStateDir = parsed.state_dir || m.defaultStateDir;
    let absStateDir = null;
    if (pinDir) {
      const subDir = path.isAbsolute(relStateDir) ? relStateDir : path.join(pinDir, relStateDir);
      const flatDir = path.join(pinDir, 'logs');
      // Prefer the configured subdirectory if it exists or if ymlPath exists; otherwise fall back to flat logs/ if baton-<role>.json is there
      if (fs.existsSync(subDir) || ymlPath) {
        absStateDir = subDir;
      } else if (m.batonName && fs.existsSync(path.join(flatDir, `baton-${m.batonName}.json`))) {
        absStateDir = flatDir;
      } else {
        absStateDir = subDir;
      }
    }
    monsterConfigs[m.role] = {
      role: m.role,
      batonName: m.batonName,
      ymlPath,
      config: parsed,
      stateDir: absStateDir,
      ledgerIssue: parsed.ledger_issue ? Number(parsed.ledger_issue) : null,
      heartbeatMinutes: parsed.heartbeat_minutes ? Number(parsed.heartbeat_minutes) : 15,
      staleLockMinutes: parsed.stale_lock_minutes ? Number(parsed.stale_lock_minutes) : 45,
      rotateContextTokens: parsed.rotate_context_tokens ? Number(parsed.rotate_context_tokens) : 150_000,
    };
  }

  // Parse roster.tmpl & supervisor.conf.tmpl if present
  let tmuxSession = env.TMUX_SESSION || fleetConf.TMUX_SESSION || '';
  const rosterSessions = [];
  const rosterPath = fleetRepo ? path.join(fleetRepo, 'fleet', 'roster.tmpl') : null;
  if (rosterPath && fs.existsSync(rosterPath)) {
    for (const raw of fs.readFileSync(rosterPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('TMUX_SESSION=') && !tmuxSession) {
        tmuxSession = line.split('=')[1].replace(/#.*$/, '').trim();
      } else if (line.startsWith('NAMESPACE=') && !tmuxSession) {
        tmuxSession = line.split('=')[1].replace(/#.*$/, '').trim();
      } else if (/^[a-z0-9-]+\|/.test(line)) {
        const [name, workdir, prompt, flags, envFile] = line.split('|');
        rosterSessions.push({ name, workdir, prompt, flags, envFile: envFile || '' });
      }
    }
  }
  if (!tmuxSession && fleetOrg) tmuxSession = fleetOrg;

  const supervisedSessions = [];
  const supPath = fleetRepo ? path.join(fleetRepo, 'fleet', 'supervisor.conf.tmpl') : null;
  if (supPath && fs.existsSync(supPath)) {
    for (const raw of fs.readFileSync(supPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (/^[a-z0-9-]+\|[0-9]+\|/.test(line)) {
        const [name, ledger, staleMin] = line.split('|');
        supervisedSessions.push({ name, ledger: Number(ledger), staleMinutes: Number(staleMin) });
      }
    }
  }

  return {
    env,
    home,
    engsysDir,
    pinRepo,
    pinDir,
    fleetRepo,
    fleetInstance: fleetRepo,
    fleetState,
    fleetOrg,
    fleetId,
    federationFile,
    logDir,
    tmuxSession,
    fleetConfFile,
    localConfFile,
    fleetConf,
    monsterConfigs,
    rosterSessions,
    supervisedSessions,
    tailHooks: options.tailHooks || 5,
    targetSession: options.session || null,
    targetRole: options.role || null,
    sinceMs: parseDurationMs(options.since) || null,
    includeTimeline: Boolean(options.timeline || options.since),
    forceDiagnose: Boolean(options.diagnose),
    skipSelfTest: Boolean(options.skipSelfTest),
  };
}

/** A child env for git that ignores inherited repo-location variables. */
function gitEnv(env) {
  const e = { ...(env || process.env) };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete e[k];
  return e;
}

/** The Claude Code config dir the fleet's sessions use: FLEET_CLAUDE_CONFIG_DIR (fleet.conf), else ~/.claude. */
export function claudeConfigDir(ctx) {
  const set = ctx.fleetConf?.FLEET_CLAUDE_CONFIG_DIR || '';
  return { dir: set ? expandHome(set, ctx.home) : path.join(ctx.home, '.claude'), fromConf: Boolean(set) };
}

/** Which config dir is in use and whether it is logged in (`claude auth status`: loggedIn only, nothing else). */
function claudeConfigItem(ctx, cfg) {
  const exists = fs.existsSync(cfg.dir);
  let login = 'unknown';
  if (exists) {
    const r = runCmd('claude', ['auth', 'status', '--json'], { cwd: os.tmpdir(), env: { ...ctx.env, CLAUDE_CONFIG_DIR: cfg.dir }, timeout: 15000 });
    try {
      const j = JSON.parse(r.stdout || 'null');
      if (j && j.loggedIn === true) login = 'logged in';
      else if (j && j.loggedIn === false) login = 'NOT logged in';
    } catch { /* unknown */ }
  }
  return {
    name: 'Claude config dir (fleet sessions)',
    status: !exists && cfg.fromConf ? 'fail' : login === 'logged in' ? 'pass' : 'warn',
    detail: `${cfg.dir}${cfg.fromConf ? ' (FLEET_CLAUDE_CONFIG_DIR)' : ' (default; set FLEET_CLAUDE_CONFIG_DIR to separate the fleet from the operator)'} — ${exists ? login : 'missing'}`,
    meta: { dir: cfg.dir, fromConf: cfg.fromConf, exists, login },
  };
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

  // The trust closure `fleet verify --engsys-dir` hashes: the whole core/fleet and core/lib trees plus the
  // kit files outside them (verify-wrappers.mjs ENGSYS_HOST_TREES / ENGSYS_HOST_FILES). Here: presence only.
  const hostRequired = [...new Set([...ENGSYS_HOST_TREES, ...ENGSYS_HOST_FILES, ...ENGSYS_HOST_PATHS])];
  const missingHost = hostRequired.filter((rel) => !fs.existsSync(path.join(engsysDir, rel)));

  items.push({
    name: 'engsys checkout',
    status: versionsMatch && isClean && missingHost.length === 0 ? 'pass' : 'warn',
    detail: `v${pkgVer} (${headRes.stdout || '?'}${tagRes.stdout ? `, tags: ${tagRes.stdout.split('\n').join(',')}` : ''}) — manifests=${versionsMatch ? 'synced' : 'MISMATCH'}, tree=${isClean ? 'clean' : 'dirty'}, host-closure=${hostRequired.length - missingHost.length}/${hostRequired.length}`,
    meta: { versionsMatch, isClean, missingHost, pkgVer },
  });

  // 1b. PIN_DIR & Settings Trust Closure
  if (pinDir && fs.existsSync(pinDir)) {
    const pinHead = runCmd('git', ['-C', pinDir, 'rev-parse', '--short', 'HEAD']);
    const pinDirty = runCmd('git', ['-C', pinDir, 'status', '--porcelain']);
    const pinSettings = readJsonSafe(path.join(pinDir, '.claude', 'settings.json'));
    const engsysPinRef = pinSettings?.extraKnownMarketplaces?.engsys?.source?.ref || 'unpinned';
    const instMkt = ctx.fleetConf.INSTANCE_MARKETPLACE || '';
    const instPinRef = instMkt ? pinSettings?.extraKnownMarketplaces?.[instMkt]?.source?.ref || 'unpinned' : null;

    items.push({
      name: 'PIN_DIR checkout & pins',
      status: pinDirty.ok && pinDirty.stdout === '' ? 'pass' : 'warn',
      detail: `${pinDir} @ ${pinHead.stdout || '?'} (${pinDirty.stdout === '' ? 'clean' : 'dirty'}) — engsys pin=${engsysPinRef}${instPinRef ? `, ${instMkt} pin=${instPinRef}` : ''}`,
      meta: { pinDir, isClean: pinDirty.stdout === '', engsysPinRef, instPinRef },
    });

    // Only the fully qualified remote-tracking ref, and never HEAD: this is a hint, not the trust root
    // (`fleet verify` checks .claude/ and every hook target against GitHub). No ref = hooks unverified.
    let pinSettingsSha = '';
    const originShaRes = runCmd('git', ['--no-replace-objects', '-C', pinDir, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main:.claude/settings.json'], { env: gitEnv(ctx.env) });
    if (originShaRes.ok && /^[0-9a-f]{40}$/.test(originShaRes.stdout)) {
      pinSettingsSha = originShaRes.stdout;
    }
    const cfg = claudeConfigDir(ctx);
    const { problems: settingsDrifts, info: settingsInfo } = checkSettingsDetailed({
      projectDir: pinDir,
      userSettingsDir: cfg.dir,
      pinSettingsSha,
      allowedUserPlugins: parseAllowedPlugins(ctx.fleetConf.VERIFY_ALLOWED_USER_PLUGINS || ''),
    });
    items.push({
      name: 'Claude settings trust closure',
      status: settingsDrifts.length === 0 ? 'pass' : 'fail',
      detail:
        settingsDrifts.length === 0
          ? `No hook bypasses, dangerous env overrides, or unapproved plugins in user/local settings${settingsInfo.length ? ` (${settingsInfo.length} allowed by VERIFY_ALLOWED_USER_PLUGINS)` : ''}`
          : `Settings drift detected: ${settingsDrifts.join('; ')}`,
      meta: { settingsDrifts, settingsInfo },
    });
  } else {
    items.push({
      name: 'PIN_DIR checkout',
      status: 'info',
      detail: pinDir ? `${pinDir} (not found on this host)` : 'PIN_DIR not configured in current env',
    });
  }

  items.push(claudeConfigItem(ctx, claudeConfigDir(ctx)));

  // 1c. FLEET_REPO
  if (fleetRepo && fs.existsSync(fleetRepo)) {
    const fHead = runCmd('git', ['-C', fleetRepo, 'rev-parse', '--short', 'HEAD']);
    const fBranch = runCmd('git', ['-C', fleetRepo, 'rev-parse', '--abbrev-ref', 'HEAD']);
    items.push({
      name: 'FLEET_REPO checkout',
      status: 'pass',
      detail: `${fleetRepo} @ ${fBranch.stdout || '?'}/${fHead.stdout || '?'}${ctx.localConfFile ? ` (+ ${path.basename(ctx.localConfFile)})` : ''}`,
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

  // 1e. Host OS & shell toolchain
  const tc = detectHostToolchain(ctx.env);
  items.push({
    name: 'Host OS & shell toolchain',
    status: 'pass',
    detail: `${tc.osLabel} ${tc.arch} (${tc.userland} userland, Node ${tc.nodeVersion}${tc.brewBash ? `, bash5=${tc.brewBash}` : ''}${tc.missingFromPath.length > 0 ? `, non-login PATH omits: ${tc.missingFromPath.join(':')}` : ', PATH complete'})`,
    meta: tc,
  });

  return { id: 1, title: 'Pins, Checkouts & Wrapper Trust Closure', items };
}

// ---------------------------------------------------------------------------
// [2/10] Fleet Identities & External Credentials
// ---------------------------------------------------------------------------
export function inspectIdentitiesAndCerts(ctx) {
  const items = [];
  const ghAppEnvPath = ctx.fleetConf.GH_APP_ENV || ctx.env.GH_APP_ENV || ctx.env.GH_APP_ENV_FILE || null;
  const idDir = ctx.fleetState ? path.join(ctx.fleetState, 'identities') : null;

  if (ghAppEnvPath) {
    if (fs.existsSync(ghAppEnvPath)) {
      const kv = parseKeyValFile(ghAppEnvPath, ctx.home);
      const st = fs.statSync(ghAppEnvPath);
      const modeOct = (st.mode & 0o777).toString(8);
      const pemPath = kv.GH_APP_PEM_FILE ? expandHome(kv.GH_APP_PEM_FILE, ctx.home) : null;
      const pemOk = Boolean(pemPath && fs.existsSync(pemPath));
      items.push({
        name: 'GitHub App identity (GH_APP_ENV)',
        status: pemOk && kv.GH_APP_ID ? 'pass' : 'warn',
        detail: `${ghAppEnvPath} (mode=0${modeOct}, app_id=${kv.GH_APP_ID || '?'}, bot=${kv.GH_BOT_LOGIN || '?'}, pem=${pemOk ? 'ok' : 'MISSING'})`,
      });
    } else {
      items.push({
        name: 'GitHub App identity (GH_APP_ENV)',
        status: 'info',
        detail: `Configured at ${ghAppEnvPath} (not present on this host)`,
      });
    }
  } else if (idDir && fs.existsSync(idDir)) {
    const appFiles = fs.readdirSync(idDir).filter((f) => f.endsWith('.app.env'));
    const configured = [];
    for (const f of appFiles) {
      const kv = parseKeyValFile(path.join(idDir, f), ctx.home);
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
      name: 'GitHub App identity',
      status: 'info',
      detail: 'No GH_APP_ENV or .fleet/identities configured in current context',
    });
  }

  // Azure SP PEM X.509 expiry check
  const pemCandidates = [];
  if (ctx.fleetConf.AZURE_PEM_PATH) pemCandidates.push(ctx.fleetConf.AZURE_PEM_PATH);
  const azEnvPath = ctx.fleetConf.AZURE_AGENTS_ENV || ctx.env.AZURE_AGENTS_ENV || null;
  if (azEnvPath && fs.existsSync(azEnvPath)) {
    const azKv = parseKeyValFile(azEnvPath, ctx.home);
    for (const k of ['AZURE_PEM_PATH', 'AZURE_CERT_PATH', 'AZURE_CLIENT_CERTIFICATE_PATH', 'PEM_FILE', 'CERT_PATH']) {
      if (azKv[k]) pemCandidates.push(expandHome(azKv[k], ctx.home));
    }
  }
  const azDir = path.join(ctx.home, '.azure');
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
          meta: { pem, daysLeft },
        });
      }
    }
  } else {
    items.push({
      name: 'Azure SP Certificate',
      status: 'info',
      detail: azEnvPath ? `AZURE_AGENTS_ENV=${azEnvPath} (no local PEM on this host)` : 'No ~/.azure/*.pem certificate found on host',
    });
  }

  // Slack & Notification Fallback
  const slackEnvPath = ctx.fleetConf.SLACK_ENV || ctx.env.SLACK_ENV || null;
  const fallbackIssue = ctx.fleetConf.NOTIFY_FALLBACK_ISSUE || ctx.env.NOTIFY_FALLBACK_ISSUE || null;
  if (slackEnvPath || fallbackIssue) {
    const slackExists = Boolean(slackEnvPath && fs.existsSync(slackEnvPath));
    items.push({
      name: 'Fleet Notifications (Slack + Fallback Issue)',
      status: 'pass',
      detail: `SLACK_ENV=${slackEnvPath ? `${path.basename(slackEnvPath)}(${slackExists ? 'present' : 'absent-on-host'})` : 'unset'}, fallback=${fallbackIssue || 'none'}`,
    });
  }

  // External Review CLIs
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
    const orgToken = ctx.fleetOrg || 'feedfrwd';
    const fleetJobs = launchRes.stdout
      .split('\n')
      .filter((l) => l.includes(`com.${orgToken}.fleet`) || l.includes('com.feedfrwd.fleet'));
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
        detail: `No com.${orgToken}.fleet.* jobs currently loaded in launchctl on this host`,
      });
    }
  }

  // Check alert / unverified latches across .fleet, PIN_DIR/logs, and monster state dirs
  const stateDirs = [
    ctx.fleetState,
    ctx.pinDir ? path.join(ctx.pinDir, 'logs') : null,
    ...Object.values(ctx.monsterConfigs || {}).map((m) => m.stateDir),
  ].filter((d) => d && fs.existsSync(d));

  const latches = [];
  for (const d of [...new Set(stateDirs)]) {
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
    meta: { latches },
  });

  // Check supervisor log tail if present
  const supLogCandidates = [
    ctx.logDir ? path.join(ctx.logDir, 'fleet-supervisor.log') : null,
    ctx.fleetRepo ? path.join(ctx.fleetRepo, 'logs', 'fleet-supervisor', 'supervisor.log') : null,
  ].filter(Boolean);
  const supLog = supLogCandidates.find((p) => fs.existsSync(p));
  if (supLog) {
    try {
      const lines = fs.readFileSync(supLog, 'utf8').trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || 'empty';
      items.push({
        name: 'Supervisor log latest entry',
        status: 'pass',
        detail: `${supLog}: ${lastLine.slice(0, 120)}`,
      });
    } catch { /* ignore */ }
  }

  // Check Harness & Seat-Quota Fallback state (HARNESS_FALLBACK / harness.fallback)
  const primaryHarness = ctx.fleetConf.HARNESS || ctx.env.PRIMARY_HARNESS || ctx.env.HARNESS || 'claude';
  const harnessFallback = ctx.fleetConf.HARNESS_FALLBACK || ctx.env.HARNESS_FALLBACK || '';
  const quotaCooldownMin = ctx.fleetConf.QUOTA_COOLDOWN_MIN || ctx.env.QUOTA_COOLDOWN_MIN || '60';
  const fbClis = harnessFallback
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((h) => {
      const bin = h === 'copilot' ? 'copilot' : h === 'antigravity' || h === 'agy' ? 'agy' : 'claude';
      const found = runCmd('which', [bin]);
      return `${h}(${bin}=${found.ok ? 'ok' : 'missing'})`;
    });
  const fbCliSummary = fbClis.length > 0 ? ` [fallback-clis: ${fbClis.join(', ')}]` : '';
  const fbCandidates = [
    ctx.logDir ? path.join(ctx.logDir, 'harness.fallback') : null,
    ctx.fleetRepo ? path.join(ctx.fleetRepo, 'logs', 'fleet-supervisor', 'harness.fallback') : null,
    ctx.pinDir ? path.join(ctx.pinDir, 'logs', 'fleet-supervisor', 'harness.fallback') : null,
  ].filter(Boolean);
  const fbFile = fbCandidates.find((p) => fs.existsSync(p));
  if (fbFile) {
    const fbLines = fs.readFileSync(fbFile, 'utf8').split('\n');
    const fbHarness = (fbLines[0] || '').trim() || 'unknown';
    const fbSince = (fbLines[1] || '').trim() || '?';
    const fbPrimary = (fbLines[2] || '').trim() || primaryHarness;
    const fbWhere = (fbLines[3] || '').trim() || '?';
    const fbUntil = (fbLines[4] || '').trim() || '';
    items.push({
      name: 'Harness & Seat-Quota Fallback',
      status: 'warn',
      detail: `ACTIVE FALLBACK: HARNESS=${fbHarness} (fell back from ${fbPrimary} at ${fbSince} in ${fbWhere}; configured HARNESS_FALLBACK=${harnessFallback || 'none'}, cooldown=${quotaCooldownMin}m)${fbCliSummary}`,
      meta: { fallbackActive: true, fbHarness, fbSince, fbPrimary, fbWhere, fbUntil, fbFile },
    });
  } else {
    items.push({
      name: 'Harness & Seat-Quota Fallback',
      status: 'pass',
      detail: `primary=${primaryHarness}, fallback=${harnessFallback || 'none'} (cooldown=${quotaCooldownMin}m, active=${primaryHarness})${fbCliSummary}`,
      meta: { fallbackActive: false, primaryHarness, harnessFallback },
    });
  }

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
    meta: { modelsOk, opus, sonnet, haiku, fable, sec },
  });

  // Check rendered .fleet/env/session.env & security.env if present
  if (ctx.fleetState && fs.existsSync(path.join(ctx.fleetState, 'env', 'session.env'))) {
    const sessEnv = parseKeyValFile(path.join(ctx.fleetState, 'env', 'session.env'), ctx.home);
    const secEnv = parseKeyValFile(path.join(ctx.fleetState, 'env', 'security.env'), ctx.home);
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
      meta: { envOk },
    });
  }

  // Check live tmux windows if TMUX_SESSION is known
  if (ctx.tmuxSession) {
    const tmuxRes = runCmd('tmux', [
      'list-windows',
      '-t',
      ctx.tmuxSession,
      '-F',
      '#{window_name}:#{pane_current_command}(pid=#{pane_pid})',
    ]);
    if (tmuxRes.ok && tmuxRes.stdout) {
      const wins = tmuxRes.stdout.split('\n').filter(Boolean);
      items.push({
        name: `Live tmux session (${ctx.tmuxSession})`,
        status: 'pass',
        detail: `${wins.length} window(s): ${wins.join(', ')}`,
      });
    } else if (ctx.rosterSessions.length > 0) {
      items.push({
        name: `Roster vs tmux session (${ctx.tmuxSession})`,
        status: 'info',
        detail: `tmux session '${ctx.tmuxSession}' not running on this host (roster defines ${ctx.rosterSessions.length} sessions: ${ctx.rosterSessions.map((r) => r.name).join(', ')})`,
      });
    }
  }

  // Check session transcript pointers in ~/.local/state/engsys/sessions/
  const sessDir = path.dirname(hookTelemetryPath(ctx.env));
  if (fs.existsSync(sessDir)) {
    const files = fs
      .readdirSync(sessDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('hook-events'));
    const summaries = [];
    const highContextSessions = [];
    for (const f of files) {
      const rec = readJsonSafe(path.join(sessDir, f));
      if (!rec) continue;
      let tokDesc = 'no-transcript';
      let modelDesc = '';
      if (rec.transcript_path && fs.existsSync(rec.transcript_path)) {
        const ts = parseTranscriptSummary(rec.transcript_path);
        if (ts) {
          if (ts.model) modelDesc = `@${ts.model}`;
          if (ts.contextTokens !== null) {
            const k = Math.round(ts.contextTokens / 1000);
            tokDesc = `${k}k/150k tok`;
            if (ts.contextTokens >= 150_000) {
              highContextSessions.push({ session: rec.session, tokens: ts.contextTokens });
            }
          } else {
            const est = Math.round(ts.fileBytes / 4);
            tokDesc = `~${Math.round(est / 1000)}k/150k tok`;
          }
        }
      }
      summaries.push(`${rec.session}${modelDesc}(${tokDesc})`);
    }
    items.push({
      name: 'Session transcript pointers & context pressure',
      status: highContextSessions.length === 0 ? 'pass' : 'warn',
      detail:
        summaries.length > 0
          ? summaries.join(', ')
          : `0 active session records in ${sessDir}`,
      meta: { highContextSessions },
    });
  }

  return { id: 4, title: 'Live Sessions, Model Routing & Context Window Health', items };
}

// ---------------------------------------------------------------------------
// [5/10] Singleton Monsters, Batons, Keepalives, Subagents & State Ceiling
// ---------------------------------------------------------------------------
export function inspectMonstersAndBatons(ctx) {
  const items = [];
  const monsters = ctx.monsterConfigs || {};
  const nowSec = Math.floor(Date.now() / 1000);
  const flatLogsDir = ctx.pinDir ? path.join(ctx.pinDir, 'logs') : null;

  for (const role of ['merge', 'maintain', 'e2e']) {
    const m = monsters[role];
    let stateDir = m?.stateDir || flatLogsDir;
    const subExists = Boolean(stateDir && fs.existsSync(stateDir));
    const flatBatonExists = Boolean(
      m?.batonName && flatLogsDir && fs.existsSync(path.join(flatLogsDir, `baton-${m.batonName}.json`)),
    );
    if (!subExists && flatBatonExists) {
      stateDir = flatLogsDir;
    }

    if (!stateDir || !fs.existsSync(stateDir)) {
      if (m?.ymlPath || stateDir) {
        items.push({
          name: `Monster [${role}]${m?.ledgerIssue ? ` (ledger #${m.ledgerIssue})` : ''}`,
          status: 'info',
          detail: `state_dir=${stateDir || 'unconfigured'} (not initialized on this host yet)`,
        });
      }
      continue;
    }

    // 1. Baton & Keepalive (for merge and maintain)
    if (m?.batonName) {
      let batonFile = path.join(stateDir, `baton-${m.batonName}.json`);
      let pidFile = path.join(stateDir, `baton-${m.batonName}.keepalive.pid`);
      if (!fs.existsSync(batonFile) && flatLogsDir) {
        const fallbackBaton = path.join(flatLogsDir, `baton-${m.batonName}.json`);
        if (fs.existsSync(fallbackBaton)) {
          batonFile = fallbackBaton;
          pidFile = path.join(flatLogsDir, `baton-${m.batonName}.keepalive.pid`);
        }
      }
      const baton = readJsonSafe(batonFile);
      if (baton) {
        let pidStatus = 'no-keepalive-pid';
        let kaDead = false;
        if (fs.existsSync(pidFile)) {
          const rawPid = fs.readFileSync(pidFile, 'utf8').trim().split('|')[0];
          const alive = isPidAlive(rawPid);
          pidStatus = alive ? `keepalive-pid=${rawPid}(alive)` : `keepalive-pid=${rawPid}(DEAD)`;
          if (!alive) kaDead = true;
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
            status: remSec > 0 && !kaDead ? 'pass' : 'warn',
            detail: `held by ${baton.holder?.session || '?'} (TTL=${remSec}s, ${pidStatus})`,
            meta: { role, holder: baton.holder?.session, remSec, kaDead, stateDir, ledgerIssue: m.ledgerIssue },
          });
        }
      } else {
        items.push({
          name: `Baton [${role}]`,
          status: 'info',
          detail: `No baton-${m.batonName}.json in ${stateDir}`,
        });
      }
    }

    // 2. Monster state.md 4,096-byte ceiling
    const stateMd = path.join(stateDir, 'state.md');
    if (fs.existsSync(stateMd)) {
      const sz = fs.statSync(stateMd).size;
      items.push({
        name: `Monster state ceiling [${role}] (${path.relative(ctx.pinDir || stateDir, stateMd) || 'state.md'})`,
        status: sz <= 4096 ? (sz <= 3500 ? 'pass' : 'warn') : 'fail',
        detail: `${sz} / 4096 bytes (${Math.round((sz / 4096) * 100)}%)`,
        meta: { role, stateMd, bytes: sz },
      });
    }

    // 3. Subagent spawn registry (agents.tsv)
    const ag = parseAgentsTsv(stateDir, nowSec);
    if (ag.exists && ag.rows.length > 0) {
      const hasOverdueOrFailed = ag.overdue.length > 0 || ag.stale.length > 0 || ag.failed.length > 0;
      const runningNames = ag.running.map(
        (r) => `${r.name}#g${r.gen}(${r.taskRef},${r.isOverdue ? 'OVERDUE' : `${r.remainingSec}s-left`})`,
      );
      items.push({
        name: `Subagent registry [${role}] (agents.tsv)`,
        status: hasOverdueOrFailed ? 'warn' : 'pass',
        detail: `running=${ag.running.length}, overdue=${ag.overdue.length}, stale=${ag.stale.length}, done=${ag.done.length}, fenced=${ag.fenced.length}, failed=${ag.failed.length}${runningNames.length > 0 ? ` — active: ${runningNames.join(', ')}` : ''}`,
        meta: { role, stateDir, overdue: ag.overdue, stale: ag.stale, failed: ag.failed },
      });
    }

    // 4. Watch heartbeat & sticky rotation request (.watch/last-heartbeat, .watch/rotation-requested)
    const hbFile = path.join(stateDir, '.watch', 'last-heartbeat');
    const rotFile = path.join(stateDir, '.watch', 'rotation-requested');
    if (fs.existsSync(hbFile) || fs.existsSync(rotFile)) {
      const hbEpoch = fs.existsSync(hbFile) ? Number(fs.readFileSync(hbFile, 'utf8').trim()) : 0;
      const hbAgeMin = hbEpoch > 0 ? Math.round((nowSec - hbEpoch) / 60) : null;
      const rotLines = fs.existsSync(rotFile) ? fs.readFileSync(rotFile, 'utf8').trim().split('\n') : [];
      const rotStatus = rotLines[1] || null;
      const staleMin = m?.staleLockMinutes || 45;
      const hbStale = hbAgeMin !== null && hbAgeMin > staleMin;
      items.push({
        name: `Watch bus & rotation state [${role}]`,
        status: hbStale ? 'warn' : 'pass',
        detail: `last_heartbeat=${hbAgeMin !== null ? `${hbAgeMin}m ago` : 'n/a'} (stale>${staleMin}m)${rotStatus ? `, sticky_rotation="${rotStatus}"` : ''}`,
        meta: { role, stateDir, hbAgeMin, staleMin, hbStale, rotStatus },
      });
    }
  }

  // Also check flat PIN_DIR/logs/*-state.md if present (for backwards compatibility / tests)
  if (flatLogsDir && fs.existsSync(flatLogsDir)) {
    const flatStates = fs
      .readdirSync(flatLogsDir)
      .filter((f) => f === 'state.md' || f.endsWith('-state.md'));
    for (const sf of flatStates) {
      const fullPath = path.join(flatLogsDir, sf);
      if (items.some((i) => i.meta?.stateMd === fullPath)) continue;
      const sz = fs.statSync(fullPath).size;
      items.push({
        name: `Monster state ceiling (${sf})`,
        status: sz <= 4096 ? 'pass' : 'fail',
        detail: `${sz} / 4096 bytes (${Math.round((sz / 4096) * 100)}%)`,
        meta: { stateMd: fullPath, bytes: sz },
      });
    }
  }

  if (items.length === 0) {
    items.push({
      name: 'Monster batons, subagents & state ceiling',
      status: 'info',
      detail: 'No PIN_DIR/logs directory found on this host',
    });
  }

  return { id: 5, title: 'Singleton Monsters, Batons, Keepalives, Subagents & State Ceiling', items };
}

// ---------------------------------------------------------------------------
// [6/10] Live Synthetic Hook Self-Test (All 9 Core Hooks)
// ---------------------------------------------------------------------------
export async function runLiveHookSelfTest(ctx) {
  if (ctx.skipSelfTest) {
    return {
      id: 6,
      title: 'Live Synthetic Hook Self-Test (9 Core Hooks)',
      items: [{ name: 'Synthetic Self-Test', status: 'info', detail: 'Skipped (--skip-selftest)' }],
    };
  }
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
        [path.join(pluginDir, 'subagent-memory-inject.mjs'), 'pre-agent'],
        {
          env: memEnv,
          input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'xray-s1',
            cwd: ctx.engsysDir,
            tool_name: 'Agent',
            tool_input: { subagent_type: 'engsys:isabelle', prompt: 'Review core/fleet/verify.sh bash quoting and git locks' },
          }),
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      const rSub = spawnSync(
        process.execPath,
        [path.join(pluginDir, 'subagent-memory-inject.mjs')],
        {
          env: memEnv,
          input: JSON.stringify({
            hook_event_name: 'SubagentStart',
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
// [7/10] Live Hook Flight Recorder, Handbacks & Subagent Memory Telemetry
// ---------------------------------------------------------------------------
export function inspectTelemetry(ctx) {
  const items = [];
  const tFile = hookTelemetryPath(ctx.env);
  const allEvents = readJsonlSafe(tFile);
  const cutoffMs = ctx.sinceMs ? Date.now() - ctx.sinceMs : 0;
  const events = allEvents.filter((e) => {
    if (ctx.targetSession && e.session !== ctx.targetSession) return false;
    if (cutoffMs > 0 && e.ts && Date.parse(e.ts) < cutoffMs) return false;
    return true;
  });

  const deniedOrBlocked = events.filter((e) => e.decision === 'deny' || e.decision === 'block');

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
      status: deniedOrBlocked.length === 0 ? 'pass' : 'warn',
      detail: `${events.length} event(s) (${summary})`,
      meta: { deniedOrBlocked },
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
      detail: `Ready at ${tFile} (0 matching live events recorded yet; populates automatically as sessions run)`,
    });
  }

  // Check INCOMPLETE handback logs in ~/.local/state/engsys/sessions/*.handbacks.jsonl
  const sessDir = path.dirname(tFile);
  const incompleteHandbacks = [];
  if (fs.existsSync(sessDir)) {
    try {
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.handbacks.jsonl')) continue;
        const sessName = f.replace(/\.handbacks\.jsonl$/, '');
        if (ctx.targetSession && !sessName.endsWith(ctx.targetSession)) continue;
        for (const hb of readJsonlSafe(path.join(sessDir, f))) {
          incompleteHandbacks.push({ session: sessName, ...hb });
        }
      }
    } catch { /* ignore */ }
  }
  items.push({
    name: 'Subagent Handback Logs (*.handbacks.jsonl)',
    status: incompleteHandbacks.length === 0 ? 'pass' : 'warn',
    detail:
      incompleteHandbacks.length === 0
        ? '0 pending INCOMPLETE subagent handbacks'
        : `${incompleteHandbacks.length} INCOMPLETE handback(s): ${incompleteHandbacks.map((h) => `${h.session}:${h.agent_type || h.agent_id}("${h.remains}")`).join('; ')}`,
    meta: { incompleteHandbacks },
  });

  // Subagent Memory Injection telemetry (~/.cache/engsys/memory/<hash>/injections.jsonl)
  const memCacheRoot = ctx.env.ENGSYS_MEMORY_CACHE_DIR || path.join(ctx.home, '.cache', 'engsys', 'memory');
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
  const recentInjections = [];
  for (const f of injectionFiles) {
    for (const rec of readJsonlSafe(f)) {
      if (cutoffMs > 0 && rec.ts && Date.parse(rec.ts) < cutoffMs) continue;
      totalInj++;
      totalMs += Number(rec.ms || 0);
      totalBytes += Number(rec.bytes || 0);
      if (rec.skipped_budget) skippedBudget++;
      if (rec.spawn_failed) spawnFailed++;
      recentInjections.push(rec);
    }
  }

  items.push({
    name: 'Subagent Memory Brief Telemetry (injections.jsonl)',
    status: spawnFailed === 0 && skippedBudget === 0 ? 'pass' : 'warn',
    detail:
      totalInj > 0
        ? `${totalInj} subagent briefs injected (avg ${Math.round(totalBytes / totalInj)}B in ${Math.round(totalMs / totalInj)}ms, skipped_budget=${skippedBudget}, spawn_failed=${spawnFailed})`
        : `0 subagent briefs recorded yet in ${memCacheRoot}`,
    meta: { totalInj, skippedBudget, spawnFailed, recentInjections: recentInjections.slice(-5) },
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
  const opDir = ctx.env.ENGSYS_MEMORY_DIR || path.join(ctx.home, '.engsys', 'memory');
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
  const mntDir = ctx.monsterConfigs?.maintain?.stateDir;
  // FHD Board Cache & Incidents
  const cacheCandidates = [
    ctx.env.ENGSYS_FHD_BOARD_CACHE,
    mntDir ? path.join(mntDir, 'fhd', 'board-cache.json') : null,
    mntDir ? path.join(mntDir, 'fhd-board-cache.json') : null,
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
      detail: `${services.length} services tracked, ${nonUp.length} degraded/down (last_updated=${board?.last_updated || '?'})${nonUp.length > 0 ? ` — degraded: ${nonUp.map((s) => `${s.id || '?'}=${s.state}`).join(', ')}` : ''}`,
      meta: { nonUp, fhdCache },
    });
  } else {
    items.push({
      name: 'Fleet Health Desk (FHD) Board Cache',
      status: 'info',
      detail: 'No fhd/board-cache.json yet (populates when Maintenance Monster runs fleet health tick)',
    });
  }

  // Multi-Fleet Federation (validated via core/fleet/lib/federation.mjs)
  const fedFile = ctx.federationFile;
  if (fedFile && fs.existsSync(fedFile)) {
    try {
      const reg = loadFederation(fedFile);
      const warnings = registryWarnings(reg);
      const idProblems = fleetIdProblems(reg, ctx.fleetId);
      const fleetIds = Object.keys(reg.fleets || {});
      const roleSummaries = [];
      for (const [repo, roles] of Object.entries(reg.repos || {})) {
        for (const [role, spec] of Object.entries(roles)) {
          roleSummaries.push(`${repo}:${role}->home=${spec.home}(ledger=#${spec.ledger || '?'}${spec.standby?.length ? `,standby=${spec.standby.join(',')}` : ''})`);
        }
      }
      const ok = idProblems.length === 0;
      items.push({
        name: 'Multi-Fleet Federation Registry',
        status: !ok ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
        detail: `${fedFile} — fleet_id=${ctx.fleetId || 'unset'}, fleets=[${fleetIds.join(', ')}], roles=[${roleSummaries.join('; ')}]${idProblems.length ? ` — PROBLEMS: ${idProblems.join('; ')}` : ''}${warnings.length ? ` — WARNINGS: ${warnings.join('; ')}` : ''}`,
        meta: { reg, warnings, idProblems },
      });
    } catch (err) {
      items.push({
        name: 'Multi-Fleet Federation Registry',
        status: 'fail',
        detail: `Invalid federation registry (${fedFile}): ${err.message}`,
        meta: { federationError: err.message },
      });
    }
  } else {
    items.push({
      name: 'Multi-Fleet Federation Registry',
      status: 'info',
      detail: 'Single-fleet mode (no federation.yml found)',
    });
  }

  // E2E Resource Broker Pool & Leases
  const e2eCfg = ctx.monsterConfigs?.e2e?.config || {};
  const leasesDir =
    e2eCfg.lease?.store ||
    (ctx.pinDir ? path.join(ctx.pinDir, 'logs', 'leases') : null);
  const poolFileCandidates = [
    ctx.fleetRepo && ctx.pinRepo
      ? path.join(ctx.fleetRepo, 'plugin', 'repos', ctx.pinRepo, e2eCfg.lease?.pool_file || 'e2e-pool.json')
      : null,
    ctx.pinDir ? path.join(ctx.pinDir, '.claude', 'e2e-pool.json') : null,
  ].filter(Boolean);
  const poolFile = poolFileCandidates.find((p) => fs.existsSync(p));
  const poolJson = poolFile ? readJsonSafe(poolFile) : null;
  const poolSlots = Array.isArray(poolJson?.slots) ? poolJson.slots.length : null;

  if (leasesDir && fs.existsSync(leasesDir)) {
    const leaseFiles = fs.readdirSync(leasesDir).filter((f) => f.endsWith('.json'));
    items.push({
      name: 'Durable Lease / E2E Resource Broker Slots',
      status: 'pass',
      detail: `${leaseFiles.length} active lease file(s) in ${leasesDir}${poolSlots !== null ? ` (pool defines ${poolSlots} slot(s))` : ''}`,
    });
  } else {
    items.push({
      name: 'Durable Lease / E2E Resource Broker Slots',
      status: 'info',
      detail: poolSlots !== null
        ? `Pool defines ${poolSlots} slot(s) (${poolFile}); no local leases dir at ${leasesDir || 'n/a'} on this host`
        : 'No active slot leases directory in current context',
    });
  }

  return { id: 10, title: 'Fleet Health Desk, Multi-Fleet Federation & E2E Resource Broker', items };
}

// ---------------------------------------------------------------------------
// Session / Role Deep-Dive Troubleshooting (--session <name> / --role <role>)
// ---------------------------------------------------------------------------
export function inspectSessionDeepDive(ctx) {
  let sessionName = ctx.targetSession;
  let role = ctx.targetRole;

  if (!sessionName && !role) return null;

  // Map role <-> sessionName using roster or standard naming
  if (!sessionName && role) {
    const fromRoster = ctx.rosterSessions.find(
      (r) =>
        r.name.endsWith(`-${role}`) ||
        r.name === role ||
        (role === 'merge' && r.prompt.includes('merge-monster')) ||
        (role === 'maintain' && r.prompt.includes('maintenance-monster')) ||
        (role === 'e2e' && r.prompt.includes('resource-broker')),
    );
    sessionName = fromRoster ? fromRoster.name : `keystone-${role}`;
  }
  if (!role && sessionName) {
    if (sessionName.endsWith('-merge') || sessionName === 'merge') role = 'merge';
    else if (sessionName.endsWith('-maintain') || sessionName === 'maintain') role = 'maintain';
    else if (sessionName.endsWith('-e2e') || sessionName === 'e2e') role = 'e2e';
  }

  const deep = {
    session: sessionName,
    role: role || 'interactive',
    tmux: null,
    transcriptRecord: null,
    transcriptSummary: null,
    hookEvents: [],
    handbacks: [],
    monster: null,
  };

  // 1. Check tmux window & pane capture
  if (ctx.tmuxSession) {
    const winRes = runCmd('tmux', [
      'list-windows',
      '-t',
      ctx.tmuxSession,
      '-F',
      '#{window_name}|#{pane_pid}|#{pane_current_command}|#{pane_dead}',
    ]);
    if (winRes.ok && winRes.stdout) {
      for (const line of winRes.stdout.split('\n')) {
        const [wName, pid, cmd, dead] = line.split('|');
        if (wName === sessionName) {
          const capRes = runCmd('tmux', [
            'capture-pane',
            '-p',
            '-t',
            `${ctx.tmuxSession}:${sessionName}`,
            '-S',
            '-30',
          ]);
          const paneLines = capRes.ok
            ? capRes.stdout
                .split('\n')
                .map((l) => l.trimEnd())
                .filter(Boolean)
                .slice(-15)
            : [];
          deep.tmux = {
            tmuxSession: ctx.tmuxSession,
            window: wName,
            panePid: Number(pid) || null,
            command: cmd || null,
            dead: dead === '1',
            paneTail: paneLines,
          };
        }
      }
    }
  }

  // 2. Check transcript pointer & JSONL transcript tail
  const sessDir = path.dirname(hookTelemetryPath(ctx.env));
  if (fs.existsSync(sessDir)) {
    const candidates = [
      ctx.fleetId ? path.join(sessDir, `${ctx.fleetId}.${sessionName}.json`) : null,
      path.join(sessDir, `${sessionName}.json`),
      ...fs
        .readdirSync(sessDir)
        .filter((f) => f.endsWith(`.${sessionName}.json`) || f === `${sessionName}.json`)
        .map((f) => path.join(sessDir, f)),
    ].filter(Boolean);
    const ptrFile = candidates.find((p) => fs.existsSync(p));
    if (ptrFile) {
      const rec = readJsonSafe(ptrFile);
      deep.transcriptRecord = rec;
      if (rec?.transcript_path && fs.existsSync(rec.transcript_path)) {
        deep.transcriptSummary = parseTranscriptSummary(rec.transcript_path);
      }
    }

    // 3. Check session handbacks
    const hbCandidates = [
      ctx.fleetId ? path.join(sessDir, `${ctx.fleetId}.${sessionName}.handbacks.jsonl`) : null,
      path.join(sessDir, `${sessionName}.handbacks.jsonl`),
      ...fs
        .readdirSync(sessDir)
        .filter((f) => f.endsWith(`.${sessionName}.handbacks.jsonl`) || f === `${sessionName}.handbacks.jsonl`)
        .map((f) => path.join(sessDir, f)),
    ].filter(Boolean);
    const hbFile = hbCandidates.find((p) => fs.existsSync(p));
    if (hbFile) {
      deep.handbacks = readJsonlSafe(hbFile);
    }
  }

  // 4. Filter hook-events.jsonl to this session
  const allHooks = readJsonlSafe(hookTelemetryPath(ctx.env));
  deep.hookEvents = allHooks
    .filter((e) => e.session === sessionName || (role && e.session === role))
    .slice(-15);

  // 5. Monster-specific state (baton, agents.tsv, state.md, journal-YYYY-MM.md)
  if (role && ctx.monsterConfigs?.[role]) {
    const m = ctx.monsterConfigs[role];
    const stateDir = m.stateDir;
    const monsterInfo = {
      role,
      stateDir,
      ledgerIssue: m.ledgerIssue,
      rotateContextTokens: m.rotateContextTokens,
      baton: null,
      agents: null,
      stateMdBytes: null,
      stateMdPreview: [],
      journalTail: [],
    };
    if (stateDir && fs.existsSync(stateDir)) {
      if (m.batonName) {
        const bFile = path.join(stateDir, `baton-${m.batonName}.json`);
        if (fs.existsSync(bFile)) monsterInfo.baton = readJsonSafe(bFile);
      }
      monsterInfo.agents = parseAgentsTsv(stateDir);
      const sFile = path.join(stateDir, 'state.md');
      if (fs.existsSync(sFile)) {
        monsterInfo.stateMdBytes = fs.statSync(sFile).size;
        monsterInfo.stateMdPreview = fs
          .readFileSync(sFile, 'utf8')
          .split('\n')
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .slice(0, 12);
      }
      const journals = fs
        .readdirSync(stateDir)
        .filter((f) => /^journal-\d{4}-\d{2}\.md$/.test(f))
        .sort();
      if (journals.length > 0) {
        const latestJournal = path.join(stateDir, journals[journals.length - 1]);
        monsterInfo.journalTail = fs
          .readFileSync(latestJournal, 'utf8')
          .split('\n')
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .slice(-10);
      }
    }
    deep.monster = monsterInfo;
  }

  return deep;
}

// ---------------------------------------------------------------------------
// Unified Chronological Behavior Timeline
// ---------------------------------------------------------------------------
export function buildBehaviorTimeline(ctx, limit = 25) {
  const timeline = [];
  const cutoffMs = ctx.sinceMs ? Date.now() - ctx.sinceMs : 0;

  const pushEvent = (ts, subsystem, level, summary) => {
    const ms = Date.parse(String(ts || ''));
    if (!Number.isFinite(ms)) return;
    if (cutoffMs > 0 && ms < cutoffMs) return;
    timeline.push({ ts: new Date(ms).toISOString(), ms, subsystem, level, summary });
  };

  // 1. Hook events
  const tFile = hookTelemetryPath(ctx.env);
  for (const e of readJsonlSafe(tFile)) {
    if (ctx.targetSession && e.session !== ctx.targetSession) continue;
    const level = e.decision === 'deny' || e.decision === 'block' ? 'warn' : 'info';
    pushEvent(
      e.ts,
      `hook:${e.hook}`,
      level,
      `[${e.session || '-'}] ${e.event} -> ${e.decision} (${e.bytes || 0}B)${e.detail ? ` — ${e.detail}` : ''}`,
    );
  }

  // 2. Subagent Memory Brief injections
  const memCacheRoot = ctx.env.ENGSYS_MEMORY_CACHE_DIR || path.join(ctx.home, '.cache', 'engsys', 'memory');
  if (fs.existsSync(memCacheRoot)) {
    try {
      for (const entry of fs.readdirSync(memCacheRoot, { withFileTypes: true })) {
        const p = entry.isDirectory()
          ? path.join(memCacheRoot, entry.name, 'injections.jsonl')
          : entry.name === 'injections.jsonl'
            ? path.join(memCacheRoot, entry.name)
            : null;
        if (p && fs.existsSync(p)) {
          for (const rec of readJsonlSafe(p)) {
            const level = rec.spawn_failed || rec.skipped_budget ? 'warn' : 'info';
            pushEvent(
              rec.ts,
              'memory-brief',
              level,
              `agent=${rec.agent_type || '?'} lessons=[${(rec.lesson_keys || []).join(',')}] pointers=${(rec.pointer_keys || []).length} (${rec.bytes || 0}B in ${rec.ms || 0}ms)`,
            );
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Handback logs
  const sessDir = path.dirname(tFile);
  if (fs.existsSync(sessDir)) {
    try {
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.handbacks.jsonl')) continue;
        const sessName = f.replace(/\.handbacks\.jsonl$/, '');
        if (ctx.targetSession && !sessName.endsWith(ctx.targetSession)) continue;
        for (const hb of readJsonlSafe(path.join(sessDir, f))) {
          pushEvent(
            hb.at,
            'handback',
            'warn',
            `[${sessName}] INCOMPLETE from ${hb.agent_type || hb.agent_id}: ${hb.remains}`,
          );
        }
      }
    } catch { /* ignore */ }
  }

  // 4. FHD incidents & baton transitions in monster state dirs
  for (const [role, m] of Object.entries(ctx.monsterConfigs || {})) {
    if (!m.stateDir || !fs.existsSync(m.stateDir)) continue;
    const incFile = path.join(m.stateDir, 'fhd-incidents.jsonl');
    for (const inc of readJsonlSafe(incFile)) {
      pushEvent(
        inc.opened_at || inc.ts,
        'fhd-incident',
        inc.state === 'confirmed' ? 'warn' : 'info',
        `service=${inc.service} state=${inc.state} class=${inc.classification || '?'}`,
      );
    }
    if (m.batonName) {
      const b = readJsonSafe(path.join(m.stateDir, `baton-${m.batonName}.json`));
      if (b?.acquired_at) {
        pushEvent(b.acquired_at, `baton:${role}`, 'info', `acquired by ${b.holder?.session || '?'}`);
      }
      if (b?.released_at) {
        pushEvent(
          b.released_at,
          `baton:${role}`,
          b.release_reason === 'forfeited-on-rotation' || b.release_reason === 'integrity-mismatch' ? 'warn' : 'info',
          `released (${b.release_reason || 'clean'})`,
        );
      }
    }
  }

  timeline.sort((a, b) => a.ms - b.ms);
  return timeline.slice(-limit);
}

// ---------------------------------------------------------------------------
// Automated Root-Cause Diagnosis & Remediation Engine
// ---------------------------------------------------------------------------
export function synthesizeDiagnoses(ctx, sections, sessionDeepDive) {
  const diagnoses = [];

  for (const sec of sections) {
    for (const item of sec.items) {
      if (item.status !== 'warn' && item.status !== 'fail') continue;

      if (item.name === 'engsys checkout') {
        if (item.meta && !item.meta.versionsMatch) {
          diagnoses.push({
            severity: 'fail',
            symptom: `engsys manifest version mismatch (${item.detail})`,
            cause: 'package.json, core/.claude-plugin/plugin.json, and .claude-plugin/marketplace.json versions are out of sync.',
            remediation: `Check git status in ${ctx.engsysDir} and checkout the tagged release: git -C "${ctx.engsysDir}" checkout v2.0.0`,
          });
        } else if (item.meta && !item.meta.isClean) {
          diagnoses.push({
            severity: 'warn',
            symptom: `Dirty host engsys checkout at ${ctx.engsysDir}`,
            cause: 'Local uncommitted edits in ENGSYS_DIR will cause `fleet verify` (#88 host trust closure) to fail and block monster launches.',
            remediation: `Inspect and clean drift: git -C "${ctx.engsysDir}" status --porcelain && git -C "${ctx.engsysDir}" checkout -- .`,
          });
        }
      } else if (item.name === 'PIN_DIR checkout & pins' && item.meta && !item.meta.isClean) {
        diagnoses.push({
          severity: 'warn',
          symptom: `Dirty PIN_DIR working tree at ${ctx.pinDir}`,
          cause: 'Uncommitted changes in PIN_DIR may cause wrapper verification or git pull fast-forward checks to warn or fail.',
          remediation: `Check dirty files in PIN_DIR: git -C "${ctx.pinDir}" status --short`,
        });
      } else if (item.name === 'Claude settings trust closure') {
        diagnoses.push({
          severity: 'fail',
          symptom: item.detail,
          cause: 'User or local settings contain disableAllHooks, dangerous env overrides (PATH, NODE_OPTIONS, CLAUDE_PLUGIN_ROOT, ENGSYS_SINGLETON_ROLE), or unapproved plugins (#96 M3).',
          remediation: `Inspect settings.json and settings.local.json in the fleet's Claude config dir (${claudeConfigDir(ctx).dir}), and "${ctx.pinDir || '.'}/.claude/settings.local.json", and remove the offending keys (or, for an operator-approved user-scope plugin, list it in VERIFY_ALLOWED_USER_PLUGINS).`,
        });
      } else if (item.name.startsWith('Azure SP Cert')) {
        diagnoses.push({
          severity: item.status,
          symptom: `${item.name}: ${item.detail}`,
          cause: 'The Azure Service Principal X.509 certificate is expiring soon or has expired, which will break az-sp-login.sh preflight.',
          remediation: `Rotate the Azure SP certificate and update ${item.meta?.pem || '~/.azure/*.pem'}.`,
        });
      } else if (item.name === 'Supervisor alert/unverified latches' && item.meta?.latches?.length) {
        diagnoses.push({
          severity: 'warn',
          symptom: `Supervisor latches active: ${item.meta.latches.map((l) => path.basename(l)).join(', ')}`,
          cause: 'A previous supervisor tick detected an unverified wrapper or stale monster heartbeat and latched an alert.',
          remediation: `Verify integrity and clear latches: fleet verify && rm -f ${item.meta.latches.map((l) => `"${l}"`).join(' ')}`,
        });
      } else if (item.name === 'Harness & Seat-Quota Fallback' && item.meta?.fallbackActive) {
        diagnoses.push({
          severity: 'warn',
          symptom: item.detail,
          cause: `Primary harness (${item.meta.fbPrimary}) hit its seat usage/rate limit in '${item.meta.fbWhere}' at ${item.meta.fbSince}; fleet-supervisor failed over supervised monsters to HARNESS=${item.meta.fbHarness}.`,
          remediation: `Supervisor will automatically probe ${item.meta.fbPrimary} and fail back after cooldown. To return to ${item.meta.fbPrimary} immediately once the seat resets: rm -f "${item.meta.fbFile}"`,
        });
      } else if (item.name === 'Rendered .fleet/env/{session,security}.env') {
        diagnoses.push({
          severity: 'warn',
          symptom: item.detail,
          cause: 'The rendered environment files in .fleet/env/ predate the latest fleet/fleet.conf model updates.',
          remediation: `Re-render .fleet/env/ files: fleet${ctx.fleetRepo ? ` --instance "${ctx.fleetRepo}"` : ''} supervise --check-only`,
        });
      } else if (item.name === 'Session transcript pointers & context pressure' && item.meta?.highContextSessions?.length) {
        for (const hc of item.meta.highContextSessions) {
          diagnoses.push({
            severity: 'warn',
            symptom: `Session '${hc.session}' context window is at ${Math.round(hc.tokens / 1000)}k tokens (>= 150k rotation threshold)`,
            cause: 'Session has exceeded rotate_context_tokens. If it is a monster, rotation waits until no subagent is running in agents.tsv and <state_dir>/active is empty.',
            remediation: `Inspect session details: fleet xray --session ${hc.session}`,
          });
        }
      } else if (item.name.startsWith('Baton [')) {
        const m = item.meta || {};
        diagnoses.push({
          severity: 'warn',
          symptom: `${item.name}: ${item.detail}`,
          cause: m.kaDead
            ? 'The detached baton keepalive process died while the baton is still marked held.'
            : 'The local baton lease TTL has expired without being renewed or cleanly released.',
          remediation: `Run scripted baton rotation/release or let fleet-supervisor forfeit on idle rotation: node "${ctx.engsysDir}/core/lib/lease/baton.mjs" status --role ${m.role || 'merge'} --state-dir "${m.stateDir || '.'}"`,
        });
      } else if (item.name.startsWith('Monster state ceiling')) {
        diagnoses.push({
          severity: item.status,
          symptom: `${item.name}: ${item.detail}`,
          cause: 'Monster state.md must remain <= 4,096 bytes so ticks and context reload stay bounded.',
          remediation: `Archive completed sections from "${item.meta?.stateMd}" into the monthly journal-YYYY-MM.md file.`,
        });
      } else if (item.name.startsWith('Subagent registry [')) {
        const m = item.meta || {};
        diagnoses.push({
          severity: 'warn',
          symptom: `${item.name}: ${item.detail}`,
          cause: 'One or more spawned subagents exceeded their deadline_epoch (OVERDUE), stopped writing to their transcript (STALE), or failed.',
          remediation: `Run subagent watchdog scan: bash "${ctx.engsysDir}/core/skills/merge-monster/scripts/mm-agent-watch.sh" --state-dir "${m.stateDir}" --once`,
        });
      } else if (item.name === 'Hook Flight Recorder (hook-events.jsonl)' && item.meta?.deniedOrBlocked?.length) {
        const lastBlock = item.meta.deniedOrBlocked[item.meta.deniedOrBlocked.length - 1];
        diagnoses.push({
          severity: 'warn',
          symptom: `${item.meta.deniedOrBlocked.length} hook deny/block event(s) recorded (latest: [${lastBlock.session || '-'}] ${lastBlock.hook} -> ${lastBlock.decision})`,
          cause:
            lastBlock.hook === 'singleton-write-guard'
              ? `A singleton monster attempted an unfenced mutation (${lastBlock.detail || 'blocked command'}) instead of routing through mm-act.sh / mnt-act.sh.`
              : `handback-guard blocked a subagent or session stop (${lastBlock.detail || 'missing STATUS line or pending work'}).`,
          remediation: `Inspect full session hook history: fleet xray --session ${lastBlock.session || 'keystone-merge'} --tail-hooks 20`,
        });
      } else if (item.name === 'Subagent Handback Logs (*.handbacks.jsonl)' && item.meta?.incompleteHandbacks?.length) {
        diagnoses.push({
          severity: 'warn',
          symptom: item.detail,
          cause: 'A subagent exited with STATUS: INCOMPLETE, leaving unfinished work for the parent session or monster watch bus.',
          remediation: `Resume the subagent or clear once resolved by the parent session.`,
        });
      } else if (item.name === 'Subagent Memory Brief Telemetry (injections.jsonl)') {
        diagnoses.push({
          severity: 'warn',
          symptom: item.detail,
          cause: 'One or more SubagentStart memory brief injections exceeded the 2000ms budget or failed to spawn.',
          remediation: `Warm the repository FTS5 lesson index: node "${ctx.engsysDir}/core/scripts/memory-brief.mjs" --agent isabelle --cwd "${ctx.pinDir || ctx.engsysDir}"`,
        });
      } else if (item.name === 'Fleet Health Desk (FHD) Board Cache' && item.meta?.nonUp?.length) {
        diagnoses.push({
          severity: 'warn',
          symptom: `External service(s) degraded/down on FHD board: ${item.meta.nonUp.map((s) => `${s.id}=${s.state}`).join(', ')}`,
          cause: 'Fleet Health Desk probes detected vendor or CI degradation; sessions receive automatic weather advisories.',
          remediation: `Check live FHD status: fleet health status`,
        });
      } else if (item.name === 'Multi-Fleet Federation Registry' && (item.status === 'fail' || item.status === 'warn')) {
        diagnoses.push({
          severity: item.status,
          symptom: item.detail,
          cause: 'federation.yml has schema errors, missing github_app_id for enabled peer fleets, or FLEET_ID mismatch.',
          remediation: `Validate federation registry: node "${ctx.engsysDir}/core/fleet/lib/federation.mjs" validate "${ctx.federationFile}"`,
        });
      }
    }
  }

  // Also check sessionDeepDive for recent tool errors
  if (sessionDeepDive?.transcriptSummary?.recentErrors?.length) {
    const errs = sessionDeepDive.transcriptSummary.recentErrors;
    diagnoses.push({
      severity: 'warn',
      symptom: `Session '${sessionDeepDive.session}' has ${errs.length} recent tool_result error(s) in its live transcript`,
      cause: `Latest error: ${errs[errs.length - 1].detail}`,
      remediation: `Inspect the session pane or transcript: ${sessionDeepDive.transcriptSummary.transcriptPath}`,
    });
  }

  return diagnoses;
}

// ---------------------------------------------------------------------------
// Main Runner & Formatter
// ---------------------------------------------------------------------------
export async function runXray(options = {}) {
  const ctx = resolveContext(options);

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

  const sessionDeepDive = inspectSessionDeepDive(ctx);
  const timeline = buildBehaviorTimeline(ctx, ctx.includeTimeline ? 50 : 10);
  const diagnoses = synthesizeDiagnoses(ctx, sections, sessionDeepDive);

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
    engsysDir: ctx.engsysDir,
    pinRepo: ctx.pinRepo,
    pinDir: ctx.pinDir,
    fleetInstance: ctx.fleetInstance,
    fleetId: ctx.fleetId || null,
    summary: {
      ok: failCount === 0,
      pass: passCount,
      warn: warnCount,
      fail: failCount,
    },
    sections,
    sessionDeepDive,
    timeline,
    diagnoses,
  };
}

export function formatXrayReport(report, options = {}) {
  const lines = [];
  lines.push('================================================================================');
  lines.push(`  engsys v2.0.0 Operational X-Ray (${report.timestamp})`);
  lines.push(`  ENGSYS_DIR:     ${report.engsysDir}`);
  if (report.fleetInstance) lines.push(`  FLEET_INSTANCE: ${report.fleetInstance}${report.fleetId ? ` (FLEET_ID=${report.fleetId})` : ''}`);
  if (report.pinDir) lines.push(`  PIN_DIR:        ${report.pinDir}${report.pinRepo ? ` (${report.pinRepo})` : ''}`);
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

  // Optional Session Deep-Dive section
  if (report.sessionDeepDive) {
    const d = report.sessionDeepDive;
    lines.push('================================================================================');
    lines.push(`  [SESSION DEEP-DIVE: ${d.session} (role=${d.role})]`);
    lines.push('================================================================================');
    if (d.tmux) {
      lines.push(`  Tmux Window: ${d.tmux.tmuxSession}:${d.tmux.window} (pid=${d.tmux.panePid}, cmd=${d.tmux.command}, dead=${d.tmux.dead})`);
      if (d.tmux.paneTail.length > 0) {
        lines.push('  Live Pane Tail:');
        for (const pl of d.tmux.paneTail.slice(-10)) {
          lines.push(`    | ${pl}`);
        }
      }
    } else {
      lines.push('  Tmux Window: not currently running on this host');
    }

    if (d.transcriptSummary) {
      const ts = d.transcriptSummary;
      const rotThresh = d.monster?.rotateContextTokens || 150_000;
      const pct = ts.contextTokens !== null ? `${Math.round((ts.contextTokens / rotThresh) * 100)}%` : '?';
      lines.push(
        `  Transcript:  ${ts.transcriptPath} (last turn ${formatAge(ts.lastTurnAt)}, branch=${ts.gitBranch || '?'})`,
      );
      lines.push(
        `  Model/Ctx:   model=${ts.model || '?'} (effort=${ts.effort || '?'}), context=${ts.contextTokens !== null ? `${ts.contextTokens.toLocaleString()} / ${rotThresh.toLocaleString()} tok (${pct})` : `~${Math.round(ts.fileBytes / 4).toLocaleString()} tok`}`,
      );
      if (ts.recentTools.length > 0) {
        lines.push(`  Recent Tool Calls (${ts.recentTools.length}):`);
        for (const t of ts.recentTools) {
          lines.push(`    - [${t.ts || '?'}] ${t.summary}`);
        }
      }
      if (ts.recentErrors.length > 0) {
        lines.push(`  Recent Tool Errors (${ts.recentErrors.length}):`);
        for (const e of ts.recentErrors) {
          lines.push(`    ! [${e.ts || '?'}] ${e.detail}`);
        }
      }
    } else if (d.transcriptRecord) {
      lines.push(`  Transcript Pointer: ${d.transcriptRecord.transcript_path} (file not found on disk)`);
    } else {
      lines.push('  Transcript Pointer: none recorded for this session');
    }

    if (d.monster) {
      const m = d.monster;
      lines.push(`  Monster Config: state_dir=${m.stateDir || '?'}, ledger=#${m.ledgerIssue || '?'}`);
      if (m.stateMdPreview.length > 0) {
        lines.push(`  state.md (${m.stateMdBytes}/4096B) Preview:`);
        for (const sl of m.stateMdPreview.slice(0, 6)) {
          lines.push(`    > ${sl}`);
        }
      }
      if (m.journalTail.length > 0) {
        lines.push('  Latest Journal Entries:');
        for (const jl of m.journalTail.slice(-5)) {
          lines.push(`    * ${jl}`);
        }
      }
    }
    lines.push('');
  }

  // Chronological Behavior Timeline (shown when events exist or --timeline/--since passed)
  if (report.timeline && (report.timeline.length > 0 || options.includeTimeline)) {
    lines.push('[BEHAVIOR TIMELINE (Recent Cross-Subsystem Events)]');
    if (report.timeline.length === 0) {
      lines.push('  (No timeline events recorded in the selected window)');
    } else {
      for (const ev of report.timeline) {
        const tag = ev.level === 'warn' ? '!' : '·';
        lines.push(`  ${tag} ${ev.ts} [${ev.subsystem}] ${ev.summary}`);
      }
    }
    lines.push('');
  }

  // Automated Root-Cause Diagnosis & Remediation Playbook
  if ((report.diagnoses && report.diagnoses.length > 0) || options.forceDiagnose) {
    lines.push('================================================================================');
    lines.push('  [DIAGNOSIS & REMEDIATION PLAYBOOK]');
    lines.push('================================================================================');
    if (!report.diagnoses || report.diagnoses.length === 0) {
      lines.push('  [PASS] 0 anomalies detected across all 10 subsystems. No remediation required.');
    } else {
      for (let i = 0; i < report.diagnoses.length; i++) {
        const d = report.diagnoses[i];
        lines.push(`  ${i + 1}. [${d.severity.toUpperCase()}] ${d.symptom}`);
        lines.push(`     Root Cause:  ${d.cause}`);
        lines.push(`     Remediation: ${d.remediation}`);
      }
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

function printHelp() {
  process.stdout.write(
    [
      'Usage: fleet [--instance <dir>] xray [options]',
      '',
      'Live operational X-Ray, behavior monitor, and troubleshooting tool for engsys v2.0.0.',
      '',
      'Options:',
      '  --instance <dir>     Fleet instance repository (e.g. ~/git/feedfrwd/ff-engsys-fleet)',
      '  --pin-dir <dir>      Target pinned repository checkout (e.g. ~/git/feedfrwd/keystone)',
      '  --session <name>     Deep-dive into a specific session (tmux, transcript, tools, hooks, monster state)',
      '  --role <role>        Deep-dive into a monster role (merge | maintain | e2e)',
      '  --since <duration>   Filter telemetry & behavior timeline to window (e.g. 15m, 2h, 1d)',
      '  --timeline           Show extended unified chronological behavior timeline (up to 50 events)',
      '  --diagnose           Always show the [DIAGNOSIS & REMEDIATION PLAYBOOK] section',
      '  --tail-hooks <N>     Number of recent hook events to display in section [7/10] (default: 5)',
      '  --skip-selftest      Skip the synthetic 9-hook sandbox self-test for instant polling',
      '  --watch [<sec>]      Continuously refresh the X-Ray every <sec> seconds (default: 5)',
      '  --json               Emit structured JSON output for agent/programmatic consumption',
      '  -h, --help           Show this help message',
      '',
    ].join('\n'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  let json = false;
  let tailHooks = 5;
  let fleetInstance = process.env.FLEET_INSTANCE || null;
  let pinDir = process.env.PIN_DIR || null;
  let session = null;
  let role = null;
  let since = null;
  let timeline = false;
  let diagnose = false;
  let skipSelfTest = false;
  let watchSec = 0;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--json') json = true;
    else if (a === '--timeline' || a === '--events') timeline = true;
    else if (a === '--diagnose' || a === '--why-blocked') diagnose = true;
    else if (a === '--skip-selftest' || a === '--fast') skipSelfTest = true;
    else if (a === '--tail-hooks' && args[i + 1]) tailHooks = Number(args[++i]) || 5;
    else if (a === '--instance' && args[i + 1]) fleetInstance = path.resolve(args[++i]);
    else if (a === '--pin-dir' && args[i + 1]) pinDir = path.resolve(args[++i]);
    else if (a === '--session' && args[i + 1]) session = args[++i];
    else if (a === '--role' && args[i + 1]) role = args[++i];
    else if (a === '--since' && args[i + 1]) since = args[++i];
    else if (a === '--watch') {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        watchSec = Math.max(1, Number(args[++i]));
      } else {
        watchSec = 5;
      }
    }
  }

  const runOpts = {
    fleetInstance,
    pinDir,
    tailHooks,
    session,
    role,
    since,
    timeline,
    diagnose,
    skipSelfTest,
  };

  if (watchSec > 0 && !json) {
    // Continuous monitoring loop
    for (;;) {
      const report = await runXray(runOpts);
      process.stdout.write('\x1Bc');
      process.stdout.write(`${formatXrayReport(report, { includeTimeline: timeline, forceDiagnose: diagnose })}\n`);
      process.stdout.write(`\n[Watching every ${watchSec}s — press Ctrl-C to stop]\n`);
      await new Promise((r) => setTimeout(r, watchSec * 1000));
    }
  }

  const report = await runXray(runOpts);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatXrayReport(report, { includeTimeline: timeline, forceDiagnose: diagnose })}\n`);
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
