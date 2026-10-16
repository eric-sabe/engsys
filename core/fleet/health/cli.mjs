#!/usr/bin/env node
// cli.mjs — Fleet Health Desk (`fleet health`) CLI entry point.
//
// Subcommands:
//   validate     Validate fleet-health.yml schema, adapters, thresholds, and dependency DAG
//   status|list  Show watched services, current states, advice, or rendered board block
//   tick         Run one FHD probe + hysteresis + DAG + correlation + board update cycle
//   watch-board  Fetch/read the status board and emit FHD_CHANGE lines once per state change
//   check        Check a single service's cached or live health state
//   report       Submit a structured friction report (same-fleet jsonl or cross-fleet fleet-msg)
//   correlate    Correlate pending friction reports into incidents with live verification probe
//   simulate     Force a service into healthy|up|degraded|down|clear for game-day drills
//   invoke       Execute a service's declared invoke command
//   self-probe   Verify FHD's own health (registry validity, board freshness, broken probes)
//   digest       Render a 7-day SLO-lite incident digest (markdown or JSON)
//   watch-add    Scaffold a 9-question service watch spec and optional GitHub config gate request
//   watch-remove Check reverse dependencies and prepare removal of a watched service

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry,
  resolveRegistryFile,
  ADAPTERS,
  OBSERVABILITY,
  TIERS,
  SERVICE_ID_RE,
} from './registry.mjs';
import { runProbe, parseCommandSpec } from './adapters.mjs';
import {
  loadEngineState,
  runEngineTick,
  simulateServiceState,
} from './engine.mjs';
import {
  loadIncidentsState,
  submitReport,
  correlateReports,
  syncIncidentsWithEngineState,
  computeDigest,
} from './incidents.mjs';
import {
  buildBoardData,
  renderBoardBlock,
  writeBoardCache,
  readBoardCache,
  fetchBoardCached,
  applyBoardToGitHub,
  notifyTransitions,
  isBoardStale,
  diffBoards,
  boardFingerprint,
} from './board.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a === '-h') {
      flags.help = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function resolveStateDir(flags, env = process.env) {
  if (typeof flags['state-dir'] === 'string' && flags['state-dir']) {
    return path.resolve(flags['state-dir']);
  }
  if (env.ENGSYS_FHD_STATE_DIR) return path.resolve(env.ENGSYS_FHD_STATE_DIR);
  if (env.FLEET_STATE) return path.resolve(env.FLEET_STATE);
  if (env.FLEET_INSTANCE) return path.resolve(env.FLEET_INSTANCE, '.fleet');
  return path.resolve(process.cwd(), '.fleet');
}

function loadRegistryOrThrow(flags, env = process.env) {
  const fileOpt = typeof flags.file === 'string' ? path.resolve(flags.file) : resolveRegistryFile(env, process.cwd());
  if (!fileOpt || !fs.existsSync(fileOpt)) {
    throw new Error(
      `fleet-health.yml not found${flags.file ? ` at ${flags.file}` : ''} (pass --file <path> or set FLEET_HEALTH_FILE)`,
    );
  }
  const registry = loadRegistry(fileOpt);
  if (!registry) {
    throw new Error(`fleet-health.yml not found at ${fileOpt}`);
  }
  return { file: fileOpt, registry };
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: fleet health <command> [options]',
      '',
      'Commands:',
      '  validate [--file <path>] [--json]',
      '  status|list [--file <path>] [--state-dir <dir>] [--render-board] [--json]',
      '  tick [--file <path>] [--state-dir <dir>] [--repo <o/r>] [--issue <N>] [--publish-github] [--notify] [--correlate] [--json]',
      '  watch-board [--repo <o/r>] [--issue <N>] [--state-dir <dir>] [--cache-file <path>] [--role <role>] [--max-age-sec <N>] [--json]',
      '  check <service> [--file <path>] [--state-dir <dir>] [--cache-file <path>] [--live] [--json]',
      '  report --service <id> --symptom "<text>" [--session <s>] [--fleet <id>] [--correlate] [--json]',
      '  correlate [--file <path>] [--state-dir <dir>] [--json]',
      '  simulate <service> --state <healthy|up|degraded|down|clear> [--notify] [--json]',
      '  invoke <service> [args...] [--file <path>] [--approved-gate <id>] [--json]',
      '  self-probe [--file <path>] [--state-dir <dir>] [--stale-minutes <N>] [--json]',
      '  digest [--days <N>] [--file <path>] [--state-dir <dir>] [--json]',
      '  watch-add <service> [--adapter <type>] [--tier <tier>] [--observability <green|yellow|red>] [--url <u>] [--command <c>] [--json]',
      '  watch-remove <service> [--file <path>] [--json]',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

function cmdValidate(flags) {
  try {
    const { file, registry } = loadRegistryOrThrow(flags);
    const serviceIds = Object.keys(registry.services);
    const out = {
      ok: true,
      file,
      version: registry.version,
      board: registry.board,
      service_count: serviceIds.length,
      services: serviceIds,
    };
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      process.stdout.write(
        `fleet health validate: OK (${serviceIds.length} service${serviceIds.length === 1 ? '' : 's'}: ${serviceIds.join(', ')})\n`,
      );
    }
    return 0;
  } catch (err) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    } else {
      process.stderr.write(`fleet health validate: ${err.message}\n`);
    }
    return 1;
  }
}

function cmdStatus(flags) {
  const stateDir = resolveStateDir(flags);
  const { registry } = loadRegistryOrThrow(flags);
  const engineState = loadEngineState(stateDir);
  const incidentsState = loadIncidentsState(stateDir);

  if (flags['render-board']) {
    const block = renderBoardBlock(registry, engineState, incidentsState, { env: process.env });
    process.stdout.write(`${block}\n`);
    return 0;
  }

  const board = buildBoardData(registry, engineState, incidentsState);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(board, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`Fleet Health Desk (updated: ${board.last_updated})\n`);
  for (const svc of Object.values(board.services)) {
    const sup = svc.suppressed_by ? ` [suppressed by ${svc.suppressed_by}]` : '';
    const sim = svc.simulated ? ' [simulated]' : '';
    process.stdout.write(`  - ${svc.id} (${svc.name}): ${svc.state.toUpperCase()}${sup}${sim} — ${svc.advice}\n`);
  }
  if (board.active_incidents.length > 0) {
    process.stdout.write(`Active incidents (${board.active_incidents.length}):\n`);
    for (const inc of board.active_incidents) {
      process.stdout.write(`  * ${inc.id} [${inc.service}] (${inc.classification}, reports=${inc.report_count}): ${inc.summary}\n`);
    }
  }
  return 0;
}

async function cmdTick(flags) {
  const stateDir = resolveStateDir(flags);
  const { registry } = loadRegistryOrThrow(flags);
  const force = Boolean(flags.force);

  const tickResult = await runEngineTick(registry, { stateDir, force });
  let engineState = tickResult.state;
  const busLines = [...(tickResult.events || [])];

  let correlationResult = null;
  if (flags.correlate !== false) {
    correlationResult = await correlateReports(registry, { stateDir });
    if (correlationResult.events?.length) {
      busLines.push(...correlationResult.events);
    }
    engineState = loadEngineState(stateDir);
  }

  const incidentsState = syncIncidentsWithEngineState(registry, { stateDir, engineState });
  const boardData = buildBoardData(registry, engineState, incidentsState);
  writeBoardCache(stateDir, boardData, { fetchedAt: new Date().toISOString() });

  const renderedBlock = renderBoardBlock(registry, engineState, incidentsState, { env: process.env });
  const fhdDir = path.join(stateDir, 'fhd');
  fs.mkdirSync(fhdDir, { recursive: true });
  const localBoardFile = path.join(fhdDir, 'board.md');
  fs.writeFileSync(localBoardFile, `${renderedBlock}\n`, 'utf8');

  const repo =
    (typeof flags.repo === 'string' && flags.repo) ||
    process.env.FLEET_INSTANCE_REPO ||
    registry.board?.repo ||
    '';
  const issue =
    (typeof flags.issue === 'string' && flags.issue) ||
    process.env.ENGSYS_FHD_BOARD_ISSUE ||
    registry.board?.issue ||
    null;

  let githubResult = null;
  if (flags['publish-github'] && repo && issue) {
    try {
      githubResult = applyBoardToGitHub({
        repo,
        issue,
        stateDir,
        renderedBlock,
        fence: !flags['no-fence'],
      });
    } catch (err) {
      githubResult = { updated: false, error: err.message };
    }
  }

  let notifyResults = [];
  if (flags.notify && tickResult.transitions.length > 0) {
    notifyResults = notifyTransitions(registry, tickResult.transitions, {
      stateDir,
      repo,
      issue,
      env: process.env,
    });
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          transitions: tickResult.transitions,
          events: busLines,
          board: boardData,
          github: githubResult,
          notifications: notifyResults,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const line of busLines) {
      process.stdout.write(`${line}\n`);
    }
  }
  return 0;
}

function cmdWatchBoard(flags) {
  const stateDir = resolveStateDir(flags);
  const cacheFile =
    (typeof flags['cache-file'] === 'string' && flags['cache-file']) ||
    process.env.ENGSYS_FHD_BOARD_CACHE ||
    path.join(stateDir, 'fhd', 'board-cache.json');
  const role = typeof flags.role === 'string' && flags.role ? flags.role.replace(/[^A-Za-z0-9_-]/g, '_') : 'watch';
  const maxAgeSec = flags['max-age-sec'] !== undefined ? Number(flags['max-age-sec']) : 60;
  const maxAgeMs = Number.isFinite(maxAgeSec) ? maxAgeSec * 1000 : 60_000;

  let repo = typeof flags.repo === 'string' ? flags.repo : process.env.FLEET_INSTANCE_REPO || '';
  let issue =
    (typeof flags.issue === 'string' && flags.issue) ||
    process.env.ENGSYS_FHD_BOARD_ISSUE ||
    null;

  if (!issue) {
    try {
      const candidateFile = typeof flags.file === 'string' ? path.resolve(flags.file) : resolveRegistryFile(process.env, process.cwd());
      if (candidateFile && fs.existsSync(candidateFile)) {
        const reg = loadRegistry(candidateFile);
        if (reg?.board?.issue) issue = reg.board.issue;
        if (reg?.board?.repo && !repo) repo = reg.board.repo;
      }
    } catch {
      // ignore if registry is absent on a remote watcher
    }
  }

  if (typeof issue === 'string' && issue.includes('#')) {
    const [r, num] = issue.split('#');
    if (r && !repo) repo = r;
    issue = num;
  }

  const fetched = fetchBoardCached({
    repo,
    issue,
    cacheFile,
    maxAgeMs,
  });

  if (!fetched.ok || !fetched.board) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, source: fetched.source, error: fetched.error || null, changes: [] })}\n`);
    }
    return flags.strict ? 1 : 0;
  }

  const seenFile = path.join(path.dirname(cacheFile), `watcher-seen-${role}.json`);
  let prevSeenBoard = null;
  try {
    const rawSeen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    prevSeenBoard = rawSeen?.board || null;
  } catch {
    prevSeenBoard = null;
  }

  const changes = diffBoards(prevSeenBoard, fetched.board);
  const currentFp = boardFingerprint(fetched.board);
  const prevFp = prevSeenBoard ? boardFingerprint(prevSeenBoard) : null;

  if (currentFp !== prevFp) {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    fs.writeFileSync(
      seenFile,
      JSON.stringify({ updated_at: new Date().toISOString(), fingerprint: currentFp, board: fetched.board }, null, 2) + '\n',
      'utf8',
    );
  }

  const busLines = [];
  for (const ch of changes) {
    if (ch.suppressed_by) continue;
    busLines.push(`FHD_CHANGE ${ch.service} ${ch.to}${ch.advice ? ` — ${ch.advice}` : ''}`);
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, source: fetched.source, changes, busLines, board: fetched.board }, null, 2)}\n`,
    );
  } else {
    for (const line of busLines) {
      process.stdout.write(`${line}\n`);
    }
  }
  return 0;
}

async function cmdCheck(positionals, flags) {
  const serviceId = positionals[0] || flags.service;
  if (!serviceId || typeof serviceId !== 'string') {
    process.stderr.write('fleet health check: service id is required (usage: fleet health check <service>)\n');
    return 2;
  }
  const stateDir = resolveStateDir(flags);

  if (flags.live) {
    const { registry } = loadRegistryOrThrow(flags);
    const svc = registry.services[serviceId];
    if (!svc) {
      process.stderr.write(`fleet health check: unknown service '${serviceId}'\n`);
      return 1;
    }
    const probeRes = await runProbe(svc, { stateDir });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ service: serviceId, live: true, ...probeRes }, null, 2)}\n`);
    } else {
      process.stdout.write(`${serviceId}: ${probeRes.status.toUpperCase()} — ${probeRes.detail}\n`);
    }
    if (flags['no-exit-code']) return 0;
    if (probeRes.status === 'down') return 3;
    if (probeRes.status === 'degraded') return 2;
    return 0;
  }

  const cacheFile =
    (typeof flags['cache-file'] === 'string' && flags['cache-file']) ||
    process.env.ENGSYS_FHD_BOARD_CACHE ||
    path.join(stateDir, 'fhd', 'board-cache.json');
  const cached = readBoardCache(cacheFile);
  let svcBoard = cached?.board?.services?.[serviceId] || null;

  if (!svcBoard) {
    try {
      const { registry } = loadRegistryOrThrow(flags);
      const engineState = loadEngineState(stateDir);
      const incidentsState = loadIncidentsState(stateDir);
      const board = buildBoardData(registry, engineState, incidentsState);
      svcBoard = board.services[serviceId] || null;
    } catch {
      svcBoard = null;
    }
  }

  if (!svcBoard) {
    const unknownOut = {
      id: serviceId,
      state: 'unknown',
      advice: 'service not found in board cache or registry',
    };
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(unknownOut, null, 2)}\n`);
    } else {
      process.stdout.write(`${serviceId}: UNKNOWN — ${unknownOut.advice}\n`);
    }
    return 0;
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(svcBoard, null, 2)}\n`);
  } else {
    process.stdout.write(`${svcBoard.id}: ${svcBoard.state.toUpperCase()} — ${svcBoard.advice}\n`);
  }

  if (flags['no-exit-code']) return 0;
  if (svcBoard.state === 'down') return 3;
  if (svcBoard.state === 'degraded') return 2;
  return 0;
}

async function cmdReport(positionals, flags) {
  const stateDir = resolveStateDir(flags);
  const service = flags.service || positionals[0];
  const symptom = flags.symptom || positionals[1];
  if (!service || typeof service !== 'string') {
    process.stderr.write('fleet health report: --service <id> is required\n');
    return 2;
  }
  if (!symptom || typeof symptom !== 'string') {
    process.stderr.write('fleet health report: --symptom "<text>" is required\n');
    return 2;
  }

  const { registry } = loadRegistryOrThrow(flags);
  const res = submitReport(registry, {
    stateDir,
    service,
    symptom,
    session: typeof flags.session === 'string' ? flags.session : process.env.ENGSYS_SESSION || 'local-session',
    fleet: typeof flags.fleet === 'string' ? flags.fleet : process.env.FLEET_ID || 'local',
    crossFleet: Boolean(flags['cross-fleet']),
    toAddress: typeof flags.to === 'string' ? flags.to : null,
  });

  let correlation = null;
  if (flags.correlate && res.mode === 'local') {
    correlation = await correlateReports(registry, { stateDir });
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...res, correlation }, null, 2)}\n`);
  } else {
    process.stdout.write(`fleet health report: recorded for '${service}' (${res.report.reported_at})\n`);
    if (correlation?.events?.length) {
      for (const l of correlation.events) process.stdout.write(`${l}\n`);
    }
  }
  return 0;
}

async function cmdCorrelate(flags) {
  const stateDir = resolveStateDir(flags);
  const { registry } = loadRegistryOrThrow(flags);
  const res = await correlateReports(registry, { stateDir });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...res }, null, 2)}\n`);
  } else {
    for (const line of res.events) {
      process.stdout.write(`${line}\n`);
    }
  }
  return 0;
}

async function cmdSimulate(positionals, flags) {
  const serviceId = positionals[0] || flags.service;
  let targetState = flags.state || positionals[1];
  if (!serviceId || typeof serviceId !== 'string') {
    process.stderr.write('fleet health simulate: <service> is required\n');
    return 2;
  }
  if (!targetState || typeof targetState !== 'string') {
    process.stderr.write('fleet health simulate: --state <healthy|up|degraded|down|clear> is required\n');
    return 2;
  }
  if (targetState === 'up') targetState = 'healthy';

  const stateDir = resolveStateDir(flags);
  const { registry } = loadRegistryOrThrow(flags);

  const simResult = await simulateServiceState(registry, {
    stateDir,
    serviceId,
    targetState,
  });

  const engineState = simResult.state;
  const incidentsState = syncIncidentsWithEngineState(registry, { stateDir, engineState });
  const boardData = buildBoardData(registry, engineState, incidentsState);
  writeBoardCache(stateDir, boardData, { fetchedAt: new Date().toISOString() });

  const renderedBlock = renderBoardBlock(registry, engineState, incidentsState, { env: process.env });
  const fhdDir = path.join(stateDir, 'fhd');
  fs.mkdirSync(fhdDir, { recursive: true });
  fs.writeFileSync(path.join(fhdDir, 'board.md'), `${renderedBlock}\n`, 'utf8');

  let notifications = [];
  if (flags.notify && simResult.transitions.length > 0) {
    const repo =
      (typeof flags.repo === 'string' && flags.repo) ||
      process.env.FLEET_INSTANCE_REPO ||
      registry.board?.repo ||
      '';
    const issue =
      (typeof flags.issue === 'string' && flags.issue) ||
      process.env.ENGSYS_FHD_BOARD_ISSUE ||
      registry.board?.issue ||
      null;
    notifications = notifyTransitions(registry, simResult.transitions, {
      stateDir,
      repo,
      issue,
      env: process.env,
    });
  }

  const nextSvc = engineState.services[serviceId];
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, service: serviceId, state: nextSvc.state, board: boardData, notifications }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `fleet health simulate: ${serviceId} -> ${nextSvc.state.toUpperCase()} (${boardData.services[serviceId]?.advice || ''})\n`,
    );
  }
  return 0;
}

function cmdInvoke(positionals, flags) {
  const serviceId = positionals[0] || flags.service;
  const extraArgs = positionals.slice(1);
  if (!serviceId) {
    process.stderr.write('fleet health invoke: usage: fleet health invoke <service> [args...]\n');
    return 2;
  }

  const { registry } = loadRegistryOrThrow(flags);
  const svc = registry.services[serviceId];
  if (!svc) {
    process.stderr.write(`fleet health invoke: unknown service '${serviceId}'\n`);
    return 1;
  }
  if (!svc.invoke) {
    process.stderr.write(`fleet health invoke: service '${serviceId}' has no invoke command configured\n`);
    return 1;
  }
  if (extraArgs.length > 0 && svc.invoke.allow_args === false) {
    process.stderr.write(`fleet health invoke: service '${serviceId}' does not allow extra arguments\n`);
    return 2;
  }

  const cmdSpec = parseCommandSpec(svc.invoke.command, [...(svc.invoke.args || []), ...extraArgs]);
  try {
    const output = execFileSync(cmdSpec.file, cmdSpec.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: svc.invoke.timeout_ms || 60_000,
    });
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, service: serviceId, output: output.trim() })}\n`,
      );
    } else if (output.trim()) {
      process.stdout.write(`${output.trim()}\n`);
    }
    return 0;
  } catch (err) {
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, service: serviceId, error: err.message })}\n`,
      );
    } else {
      process.stderr.write(`fleet health invoke: command failed: ${err.message}\n`);
    }
    return 1;
  }
}

function cmdSelfProbe(flags) {
  const stateDir = resolveStateDir(flags);
  const staleMinutes = flags['stale-minutes'] !== undefined ? Number(flags['stale-minutes']) : 30;
  const issues = [];

  let registry = null;
  try {
    const loaded = loadRegistryOrThrow(flags);
    registry = loaded.registry;
  } catch (err) {
    issues.push(`registry_invalid: ${err.message}`);
  }

  const cached = readBoardCache(stateDir);
  const engineState = loadEngineState(stateDir);
  const board = cached?.board || (registry ? buildBoardData(registry, engineState, loadIncidentsState(stateDir)) : null);

  if (!Object.keys(engineState.services || {}).length && !cached?.board) {
    issues.push('board_never_updated: no FHD engine tick or board cache recorded yet');
  } else if (board && isBoardStale(board, { staleMinutes })) {
    issues.push(`board_stale: last_updated ${board.last_updated} exceeds ${staleMinutes}m threshold`);
  }

  const unknownProbes = [];
  const authFailures = [];
  for (const [id, svc] of Object.entries(engineState.services || {})) {
    if (svc.state === 'unknown') unknownProbes.push(id);
    if (svc.auth_local_failure) authFailures.push(id);
  }
  if (unknownProbes.length > 0) {
    issues.push(`unknown_probes: ${unknownProbes.join(', ')}`);
  }
  if (authFailures.length > 0) {
    issues.push(`auth_local_failures: ${authFailures.join(', ')}`);
  }

  const ok = issues.length === 0;
  const out = {
    ok,
    last_updated: board?.last_updated || engineState.updated_at || null,
    stale_minutes: staleMinutes,
    unknown_probes: unknownProbes,
    auth_local_failures: authFailures,
    issues,
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (ok) {
    process.stdout.write(`fleet health self-probe: OK (last_updated: ${out.last_updated})\n`);
  } else {
    process.stderr.write(`fleet health self-probe: UNHEALTHY — ${issues.join('; ')}\n`);
  }
  return ok ? 0 : 1;
}

function cmdDigest(flags) {
  const stateDir = resolveStateDir(flags);
  const { registry } = loadRegistryOrThrow(flags);
  const days = flags.days !== undefined ? Number(flags.days) : 7;
  const digest = computeDigest(registry, { stateDir, days });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
  } else {
    process.stdout.write(`${digest.markdown}\n`);
  }
  return 0;
}

function cmdWatchAdd(positionals, flags) {
  const serviceId = positionals[0] || flags.service;
  if (!serviceId || !SERVICE_ID_RE.test(serviceId)) {
    process.stderr.write('fleet health watch-add: valid <service> slug is required (e.g. github-actions)\n');
    return 2;
  }

  const obsClass = String(flags.observability || 'green').toLowerCase();
  if (!['green', 'yellow', 'red', ...OBSERVABILITY].includes(obsClass)) {
    process.stderr.write('fleet health watch-add: --observability must be green, yellow, red, central, or per-session\n');
    return 2;
  }

  if (obsClass === 'red' && !flags['allow-red-scaffold']) {
    const msg =
      `Service '${serviceId}' has observability=red (no honest probe surface exists). ` +
      'Per FHD policy (#100), refuse adding a fake check: file an engineering issue to build an observable health endpoint or log counter first.';
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, refused_red: true, service: serviceId, error: msg })}\n`);
    } else {
      process.stderr.write(`fleet health watch-add: ${msg}\n`);
    }
    return 1;
  }

  const registryObs = obsClass === 'per-session' ? 'per-session' : 'central';
  const adapter = String(flags.adapter || (obsClass === 'yellow' ? 'synthetic-command' : 'statuspage'));
  if (!ADAPTERS.includes(adapter)) {
    process.stderr.write(`fleet health watch-add: invalid --adapter '${adapter}' (allowed: ${ADAPTERS.join(', ')})\n`);
    return 2;
  }
  const tier = String(flags.tier || (adapter === 'synthetic-command' ? 'on-ambiguity' : 'passive'));
  if (!TIERS.includes(tier)) {
    process.stderr.write(`fleet health watch-add: invalid --tier '${tier}' (allowed: ${TIERS.join(', ')})\n`);
    return 2;
  }

  const name = typeof flags.name === 'string' ? flags.name : serviceId;
  const url = typeof flags.url === 'string' ? flags.url : 'https://status.example.com/api/v2/summary.json';
  const command = typeof flags.command === 'string' ? flags.command : 'true';
  const dependsOn = typeof flags['depends-on'] === 'string'
    ? flags['depends-on'].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const holdMerges = Boolean(flags['hold-merges']);
  const advice = typeof flags.advice === 'string' ? flags.advice : `Wait for ${name} recovery before retrying.`;

  const questions = {
    q1_service: `${serviceId} (${name})`,
    q2_failure_modes: flags['failure-modes'] || 'API 5xx, rate-limit exhaustion, or upstream outage',
    q3_observability: `${obsClass} (registry observability: ${registryObs})`,
    q4_adapter_and_probe: adapter === 'statuspage' || adapter === 'http-health' ? `${adapter} (${url})` : `${adapter} (${command})`,
    q5_tier_and_cadence: `${tier} (poll_seconds: 90)`,
    q6_hysteresis: 'trip_fails: 2, recover_clean: 3',
    q7_dependencies: dependsOn.length ? dependsOn.join(', ') : 'none',
    q8_impact: `hold_merges=${holdMerges}, advice="${advice}"`,
    q9_runbook: advice,
  };

  const yamlLines = [
    `  ${serviceId}:`,
    `    kind: external`,
    `    observability: ${registryObs}`,
    `    probe:`,
    `      adapter: ${adapter}`,
    `      tier: ${tier}`,
  ];
  if (adapter === 'statuspage' || adapter === 'http-health') {
    yamlLines.push(`      url: "${url}"`);
  } else if (adapter === 'synthetic-command') {
    yamlLines.push(`      command: "${command}"`);
  }
  yamlLines.push(`    poll_seconds: 90`);
  yamlLines.push(`    thresholds:`);
  yamlLines.push(`      trip_fails: 2`);
  yamlLines.push(`      recover_clean: 3`);
  if (dependsOn.length > 0) {
    yamlLines.push(`    depends_on: [${dependsOn.join(', ')}]`);
  }
  yamlLines.push(`    impact:`);
  yamlLines.push(`      hold_merges: ${holdMerges}`);
  yamlLines.push(`      advice: "${advice}"`);
  yamlLines.push(`    runbook: "${advice}"`);

  const yamlSnippet = yamlLines.join('\n');

  let gateResult = null;
  if (flags['request-gate'] && flags.repo && flags.issue) {
    const gateCheckScript = path.resolve(__dirname, '../../lib/gate-check.mjs');
    const whatText = [
      `Add watched service \`${serviceId}\` (${name}) to \`fleet-health.yml\`.`,
      '',
      '```yaml',
      yamlSnippet,
      '```',
    ].join('\n');
    const gateArgs = [
      gateCheckScript,
      'request',
      '--repo',
      String(flags.repo),
      '--issue',
      String(flags.issue),
      '--kind',
      'config',
      '--target',
      `fleet-health:${serviceId}`,
      '--what',
      whatText,
    ];
    if (flags['dry-run']) gateArgs.push('--dry-run');
    try {
      const out = execFileSync(process.execPath, gateArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      gateResult = { ok: true, output: out.trim() };
    } catch (err) {
      gateResult = { ok: false, error: err.message };
    }
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, service: serviceId, questions, yaml: yamlSnippet, gate: gateResult }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`# 9-Question Watch Spec for ${serviceId}\n`);
    for (const [k, v] of Object.entries(questions)) {
      process.stdout.write(`- ${k}: ${v}\n`);
    }
    process.stdout.write(`\n# fleet-health.yml snippet:\n${yamlSnippet}\n`);
  }
  return 0;
}

function cmdWatchRemove(positionals, flags) {
  const serviceId = positionals[0] || flags.service;
  if (!serviceId) {
    process.stderr.write('fleet health watch-remove: <service> is required\n');
    return 2;
  }
  const { registry } = loadRegistryOrThrow(flags);
  if (!registry.services[serviceId]) {
    process.stderr.write(`fleet health watch-remove: service '${serviceId}' is not in registry\n`);
    return 1;
  }

  const dependents = [];
  for (const [id, svc] of Object.entries(registry.services)) {
    if (Array.isArray(svc.depends_on) && svc.depends_on.includes(serviceId)) {
      dependents.push(id);
    }
  }

  if (dependents.length > 0) {
    const msg = `Cannot remove '${serviceId}' while downstream services depend on it: ${dependents.join(', ')}`;
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, service: serviceId, dependents, error: msg })}\n`);
    } else {
      process.stderr.write(`fleet health watch-remove: ${msg}\n`);
    }
    return 1;
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, service: serviceId, dependents: [], target: `fleet-health:remove:${serviceId}` }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `fleet health watch-remove: '${serviceId}' has no reverse dependencies and is safe to remove via operator config gate.\n`,
    );
  }
  return 0;
}

export async function runCli(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseFlags(argv);
  const cmd = positionals[0] || (flags.help ? 'help' : 'status');
  const restPos = positionals.slice(1);

  if (cmd === 'help' || flags.help) {
    printUsage();
    return 0;
  }

  try {
    switch (cmd) {
      case 'validate':
        return cmdValidate(flags);
      case 'status':
      case 'list':
        return cmdStatus(flags);
      case 'tick':
        return await cmdTick(flags);
      case 'watch-board':
        return cmdWatchBoard(flags);
      case 'check':
        return await cmdCheck(restPos, flags);
      case 'report':
        return await cmdReport(restPos, flags);
      case 'correlate':
        return await cmdCorrelate(flags);
      case 'simulate':
        return await cmdSimulate(restPos, flags);
      case 'invoke':
        return cmdInvoke(restPos, flags);
      case 'self-probe':
        return cmdSelfProbe(flags);
      case 'digest':
        return cmdDigest(flags);
      case 'watch-add':
        return cmdWatchAdd(restPos, flags);
      case 'watch-remove':
        return cmdWatchRemove(restPos, flags);
      default:
        process.stderr.write(`fleet health: unknown command '${cmd}' (see 'fleet health --help')\n`);
        return 2;
    }
  } catch (err) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    } else {
      process.stderr.write(`fleet health ${cmd}: ${err.message}\n`);
    }
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => process.exit(code));
}
