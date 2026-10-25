#!/usr/bin/env node
// engine.mjs — Fleet Health Desk state machine, hysteresis, dependency graph root-causing,
// poll cadence, hybrid tiering, and simulation engine (engsys#97, #99, #100).
//
// Zero dependencies: node builtins + core/fleet modules.

import path from 'node:path';
import { ensureDir, readJson, withLock, writeFileAtomic } from '../lib/inbox.mjs';
import { topologicalOrder } from './registry.mjs';
import { probeStatuspage, runProbe, VALID_STATUSES, STATUSPAGE_INDICATORS, STATUSPAGE_COMPONENT_MAP } from './adapters.mjs';

// ---------------------------------------------------------------------------------------------
// Watch-bus vocabulary (engsys#181). A bus line reaches a monster's context, so it carries only fixed words: the service
// id (registry-validated), the state enum, a reason code and the gate words. Probe output (`detail`, the first line of a
// command's or an API's response), the advice and the runbook stay on the board and in the local state files.
// ---------------------------------------------------------------------------------------------
// An explicit allowlist, not just a character class (review Low): the adapters' own fixed status words, the Statuspage
// indicator and component enums, and the numeric shapes the probes produce (HTTP code, `http_<code>`, `exit_<code>`).
// Anything else, including a vendor string that happens to be a plain token, is reported as `probe`.
const REASON_WORDS = new Set([
  'auth_local_failure', 'timeout', 'network_error', 'fetch_error', 'config_error', 'parse_error', 'invalid_json',
  'invalid_records', 'invalid_output', 'mismatch_output', 'missing_component', 'missing', 'empty',
  'healthy', 'degraded', 'down', 'unknown',
  ...Object.keys(STATUSPAGE_INDICATORS), ...Object.keys(STATUSPAGE_COMPONENT_MAP),
]);
const REASON_RE = /^(?:\d{3}|http_\d{3}|exit_\d{1,3})$/;
const BUS_SESSION_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** A short reason code for a service state: the probe's raw status when it is a plain token, else `probe`. */
export function busReason(svc) {
  if (svc?.auth_local_failure) return 'auth_local_failure';
  const raw = String(svc?.last_probe_result?.rawStatus ?? svc?.raw_state ?? '').toLowerCase();
  return REASON_WORDS.has(raw) || REASON_RE.test(raw) ? raw : 'probe';
}

/** `<id> <state> reason=<code>[ — hold merges][, pause claims]`, from fixed words only. */
export function engineBusSuffix(id, state, svc, spec) {
  const gates = [];
  if (svc?.hold_merges === true) gates.push('hold merges');
  if (spec?.impact?.pause_claims === true) gates.push('pause claims');
  return `${id} ${state} reason=${busReason(svc)}${gates.length ? ` — ${gates.join(', ')}` : ''}`;
}

/** The session a guidance line names: a plain name, else `local`. */
export function busSession(name) {
  return typeof name === 'string' && BUS_SESSION_RE.test(name) ? name : 'local';
}

export const SIMULATABLE_STATES = new Set(['healthy', 'degraded', 'down', 'unknown', 'clear']);

function nowIsoStr(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function stateFilePath(stateDir) {
  return path.join(stateDir, 'fhd-state.json');
}

export function defaultServiceState(nowIso = nowIsoStr()) {
  return {
    state: 'healthy',
    last_known_state: 'healthy',
    raw_state: 'healthy',
    since: nowIso,
    last_polled_at: null,
    consecutive_fails: 0,
    consecutive_clean: 0,
    detail: 'not polled yet',
    component_states: {},
    etag: null,
    last_probe_result: null,
    suppressed_by: null,
    root_cause: null,
    advice: '',
    hold_merges: false,
    auth_local_failure: false,
    simulated: null,
  };
}

export function loadEngineState(stateDir, now = new Date()) {
  const nowIso = nowIsoStr(now);
  const raw = readJson(stateFilePath(stateDir), null);
  if (!raw || typeof raw !== 'object' || typeof raw.services !== 'object' || !raw.services) {
    return { version: 1, updated_at: nowIso, services: {} };
  }
  return {
    version: 1,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso,
    services: { ...raw.services },
  };
}

export function saveEngineState(stateDir, state) {
  ensureDir(stateDir);
  writeFileAtomic(stateFilePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Resolve concrete fleet-impact advice for a service given its current state and component states.
 */
export function resolveImpactAdvice(serviceSpec, state, componentStates = {}) {
  if (state === 'healthy') return { advice: '', hold_merges: false };
  const imp = serviceSpec?.impact ?? {};
  const parts = [];
  let holdMerges = Boolean(imp.hold_merges);

  if (componentStates && typeof componentStates === 'object' && imp.components) {
    for (const [comp, compState] of Object.entries(componentStates)) {
      if (compState !== 'healthy' && imp.components[comp]) {
        parts.push(`${comp}: ${imp.components[comp]}`);
        if (/\bhold\s+merges\b/i.test(imp.components[comp])) holdMerges = true;
      }
    }
  }

  if (parts.length === 0) {
    const specific = (state === 'down' && imp.down)
      || (state === 'degraded' && imp.degraded)
      || imp.advice
      || [imp.merge ? `merge: ${imp.merge}` : null, imp.dispatch ? `dispatch: ${imp.dispatch}` : null, imp.triage ? `triage: ${imp.triage}` : null].filter(Boolean).join('; ');
    if (specific) parts.push(specific);
  }

  const advice = parts.join('; ');
  if (/\bhold\s+merges\b/i.test(advice)) holdMerges = true;
  return { advice, hold_merges: holdMerges };
}

/**
 * Pure hysteresis state transition for a single service.
 *
 * Rules (#97, #99):
 *   - Broken probe (`status === 'unknown'`) -> sets `state: 'unknown'`, preserves `last_known_state`,
 *     never increments `consecutive_fails`, and NEVER trips a false `down` transition.
 *   - Local auth/context missing (`authLocalFailure === true`) -> sets `auth_local_failure: true`,
 *     keeps service `state` healthy (never trips a vendor outage).
 *   - Failing probe (`degraded` | `down`) -> increments `consecutive_fails`, resets `consecutive_clean`.
 *     Trips from `healthy` only when `consecutive_fails >= thresholds.trip_fails`.
 *   - Clean probe (`healthy`) -> increments `consecutive_clean`, resets `consecutive_fails`.
 *     Recovers from `degraded`/`down` only when `consecutive_clean >= thresholds.recover_clean`
 *     AND (when `statuspageGateResult` is provided) `statuspageGateResult.status === 'healthy'`.
 */
export function evaluateServiceTransition(prevState, probeResult, serviceSpec, { now = new Date(), statuspageGateResult = null } = {}) {
  const nowIso = nowIsoStr(now);
  const prev = prevState ? { ...defaultServiceState(nowIso), ...prevState } : defaultServiceState(nowIso);
  const tripFails = serviceSpec?.thresholds?.trip_fails ?? 1;
  const recoverClean = serviceSpec?.thresholds?.recover_clean ?? 3;

  // Check active simulation override first (#100 P3)
  if (prev.simulated && typeof prev.simulated === 'object' && VALID_STATUSES.has(prev.simulated.state)) {
    const exp = prev.simulated.expires_at ? Date.parse(prev.simulated.expires_at) : Infinity;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    if (nowMs < exp) {
      const simState = prev.simulated.state;
      const changed = prev.state !== simState;
      const { advice, hold_merges } = resolveImpactAdvice(serviceSpec, simState, prev.component_states);
      return {
        ...prev,
        state: simState,
        last_known_state: simState === 'unknown' ? prev.last_known_state : simState,
        raw_state: simState,
        since: changed ? (prev.simulated.set_at || nowIso) : prev.since,
        last_polled_at: nowIso,
        detail: prev.simulated.detail || `simulated ${simState}`,
        advice,
        hold_merges,
        auth_local_failure: false,
      };
    }
    // Expired simulation clears automatically
    prev.simulated = null;
  }

  const probeStatus = VALID_STATUSES.has(probeResult?.status) ? probeResult.status : 'unknown';
  const componentStates = probeResult?.componentStates ?? {};

  // Host/session-local auth failure: never a vendor outage (#99 P2)
  if (probeResult?.authLocalFailure) {
    const stableState = prev.state === 'unknown' ? (prev.last_known_state || 'healthy') : prev.state;
    const { advice, hold_merges } = resolveImpactAdvice(serviceSpec, stableState, componentStates);
    return {
      ...prev,
      state: stableState,
      raw_state: 'auth_local_failure',
      last_polled_at: nowIso,
      detail: probeResult.detail || 'session-local auth or context missing',
      auth_local_failure: true,
      advice,
      hold_merges,
    };
  }

  // Broken probe -> unknown + preserve last_known_state, never false down (#97)
  if (probeStatus === 'unknown') {
    const lastKnown = prev.state !== 'unknown' ? prev.state : (prev.last_known_state || 'healthy');
    return {
      ...prev,
      state: 'unknown',
      last_known_state: lastKnown,
      raw_state: 'unknown',
      since: prev.state === 'unknown' ? prev.since : nowIso,
      last_polled_at: nowIso,
      detail: probeResult?.detail || 'probe returned unknown',
      auth_local_failure: false,
    };
  }

  const next = {
    ...prev,
    raw_state: probeStatus,
    last_polled_at: nowIso,
    detail: probeResult?.detail || probeStatus,
    component_states: componentStates,
    etag: probeResult?.etag ?? prev.etag ?? null,
    last_probe_result: {
      status: probeStatus,
      detail: probeResult?.detail || probeStatus,
      rawStatus: probeResult?.rawStatus || probeStatus,
      componentStates,
    },
    auth_local_failure: false,
  };

  const baselineState = prev.state === 'unknown' ? (prev.last_known_state || 'healthy') : prev.state;

  if (probeStatus === 'degraded' || probeStatus === 'down') {
    next.consecutive_fails = (prev.consecutive_fails || 0) + 1;
    next.consecutive_clean = 0;

    if (baselineState === 'healthy') {
      if (next.consecutive_fails >= tripFails) {
        next.state = probeStatus;
        next.last_known_state = probeStatus;
        next.since = nowIso;
      } else {
        next.state = 'healthy';
        next.last_known_state = 'healthy';
        next.detail = `${probeResult?.detail || probeStatus} (failing ${next.consecutive_fails}/${tripFails} before trip)`;
      }
    } else if (baselineState === 'degraded') {
      if (probeStatus === 'down' && next.consecutive_fails >= tripFails) {
        next.state = 'down';
        next.last_known_state = 'down';
        next.since = nowIso;
      } else {
        next.state = 'degraded';
        next.last_known_state = 'degraded';
      }
    } else if (baselineState === 'down') {
      // Transitioning from down -> degraded (mitigated)
      next.state = probeStatus;
      next.last_known_state = probeStatus;
    }
  } else if (probeStatus === 'healthy') {
    next.consecutive_clean = (prev.consecutive_clean || 0) + 1;
    next.consecutive_fails = 0;

    if (baselineState === 'degraded' || baselineState === 'down') {
      const gateClean = !statuspageGateResult || statuspageGateResult.status === 'healthy';
      if (next.consecutive_clean >= recoverClean && gateClean) {
        next.state = 'healthy';
        next.last_known_state = 'healthy';
        next.since = nowIso;
      } else {
        next.state = baselineState;
        next.last_known_state = baselineState;
        const reason = !gateClean
          ? `statuspage still ${statuspageGateResult.status}`
          : `clean ${next.consecutive_clean}/${recoverClean} before recovery`;
        next.detail = `recovering (${reason})`;
      }
    } else {
      next.state = 'healthy';
      next.last_known_state = 'healthy';
      if (prev.state === 'unknown') next.since = nowIso;
    }
  }

  const { advice, hold_merges } = resolveImpactAdvice(serviceSpec, next.state, next.component_states);
  next.advice = advice;
  next.hold_merges = hold_merges;
  return next;
}

/**
 * Apply dependency graph root-causing (`depends_on`, #100 P3):
 * When service A declares `depends_on: [B]` and B is `down` or `degraded`,
 * A's non-healthy state is marked `suppressed_by: <rootDep>` with
 * `root_cause: "<A> <state> because <rootDep> is <rootState>"`, suppressing derivative alarms.
 */
export function applyDependencyGraph(registryServices, servicesState) {
  const order = topologicalOrder(registryServices);
  const out = { ...servicesState };

  for (const id of order) {
    const spec = registryServices[id];
    const st = out[id];
    if (!spec || !st) continue;

    const deps = spec.depends_on ?? [];
    let failingDep = null;
    for (const depId of deps) {
      const depSt = out[depId];
      if (!depSt) continue;
      if (depSt.state === 'down' || depSt.state === 'degraded') {
        // Follow transitive root cause if the dependency itself is suppressed by an upstream root
        const rootId = depSt.suppressed_by || depId;
        const rootSt = out[rootId] || depSt;
        if (!failingDep || (rootSt.state === 'down' && failingDep.state !== 'down')) {
          failingDep = { id: rootId, state: rootSt.state };
        }
      }
    }

    if (failingDep && (st.state === 'down' || st.state === 'degraded')) {
      out[id] = {
        ...st,
        suppressed_by: failingDep.id,
        root_cause: `${id} ${st.state} because ${failingDep.id} is ${failingDep.state}`,
      };
    } else {
      out[id] = {
        ...st,
        suppressed_by: null,
        root_cause: null,
      };
    }
  }

  return out;
}

export function isSimulationActive(simulated, now = new Date()) {
  if (!simulated || typeof simulated !== 'object' || !VALID_STATUSES.has(simulated.state)) return false;
  const exp = simulated.expires_at ? Date.parse(simulated.expires_at) : Infinity;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  return nowMs < exp;
}

/**
 * Decide whether a service should be probed on this tick.
 */
export function shouldProbeService(serviceSpec, prevServiceState, {
  now = new Date(),
  force = false,
  forceServices = new Set(),
  allServicesState = {},
} = {}) {
  if (!serviceSpec || serviceSpec.observability === 'per-session') {
    return force && forceServices.has(serviceSpec?.id);
  }
  if (serviceSpec.probe?.adapter === 'fleet-report-only') return false;
  if (force || forceServices.has(serviceSpec.id)) return true;

  // Active simulation does not need a live probe, but an expired simulation must probe immediately
  if (prevServiceState?.simulated?.state) {
    if (isSimulationActive(prevServiceState.simulated, now)) return false;
    return true;
  }

  const tier = serviceSpec.probe?.tier ?? 'passive';
  const curState = prevServiceState?.state ?? 'healthy';

  if (tier === 'on-ambiguity') {
    // Only run on-ambiguity synthetic probes if the service is not healthy, or a dependency is ambiguous/unhealthy
    const depUnhealthy = (serviceSpec.depends_on ?? []).some((dep) => {
      const ds = allServicesState[dep]?.state;
      return ds && ds !== 'healthy';
    });
    if (curState === 'healthy' && !depUnhealthy) return false;
  }

  const lastPolled = prevServiceState?.last_polled_at ? Date.parse(prevServiceState.last_polled_at) : NaN;
  if (!Number.isFinite(lastPolled)) return true;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  return (nowMs - lastPolled) >= (serviceSpec.poll_seconds ?? 90) * 1000;
}

/**
 * Run one deterministic FHD tick across all central services in topological order.
 */
export async function runEngineTick(registry, {
  stateDir,
  force = false,
  forceServices = new Set(),
  now = new Date(),
  fetchFn = globalThis.fetch,
  execFn = undefined,
  observations = null,
  customAdapters = null,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const nowIso = nowIsoStr(now);
  const currentState = stateDir ? loadEngineState(stateDir, now) : { version: 1, updated_at: nowIso, services: {} };
  const prevServices = { ...currentState.services };
  const nextServices = { ...currentState.services };

  const order = topologicalOrder(registry.services);
  let anyEvaluated = Object.keys(prevServices).length === 0;

  for (const id of order) {
    const spec = registry.services[id];
    if (!spec) continue;
    if (spec.observability === 'per-session' && !forceServices.has(id)) {
      if (!nextServices[id]) {
        nextServices[id] = {
          ...defaultServiceState(nowIso),
          detail: 'per-session (self-probed on each host)',
        };
        anyEvaluated = true;
      }
      continue;
    }

    const prev = prevServices[id] ? { ...defaultServiceState(nowIso), ...prevServices[id] } : defaultServiceState(nowIso);
    const hadExpiredSim = Boolean(prev.simulated?.state) && !isSimulationActive(prev.simulated, now);
    const hasSim = isSimulationActive(prev.simulated, now);
    const doProbe = shouldProbeService(spec, prev, {
      now,
      force: force || hadExpiredSim,
      forceServices,
      allServicesState: nextServices,
    });

    if (hadExpiredSim) {
      prev.simulated = null;
      anyEvaluated = true;
    }

    if (!doProbe && !hasSim) {
      nextServices[id] = prev;
      continue;
    }

    anyEvaluated = true;
    let probeResult = null;
    let statuspageGateResult = null;

    if (!hasSim) {
      probeResult = await runProbe(spec, {
        stateDir,
        cached: { etag: prev.etag, lastResult: prev.last_probe_result },
        fetchFn,
        execFn,
        observations: observations?.[id] ?? null,
        customAdapters,
        now,
        env,
        cwd,
      });

      // If recovering from degraded/down and a secondary statuspage_url is configured, gate recovery on it
      if (
        probeResult.status === 'healthy'
        && (prev.state === 'degraded' || prev.state === 'down')
        && spec.probe?.adapter !== 'statuspage'
        && spec.probe?.statuspage_url
      ) {
        statuspageGateResult = await probeStatuspage(
          {
            url: spec.probe.statuspage_url,
            components: spec.probe.statuspage_component ? [spec.probe.statuspage_component] : [],
            timeout_ms: spec.probe.timeout_ms || 10000,
          },
          { fetchFn, now },
        );
      }
    }

    nextServices[id] = evaluateServiceTransition(prev, probeResult, spec, {
      now,
      statuspageGateResult,
    });
  }

  // Apply dependency graph root-causing & suppression (#100 P3)
  const rootedServices = applyDependencyGraph(registry.services, nextServices);

  // Compute transitions and watch-bus event lines
  const transitions = [];
  const events = [];

  for (const id of order) {
    const spec = registry.services[id];
    if (!spec || spec.observability === 'per-session') continue;
    const before = prevServices[id]?.state ?? 'healthy';
    const beforeKnown = prevServices[id]?.last_known_state ?? before;
    const beforeSuppressedBy = prevServices[id]?.suppressed_by ?? null;
    const afterObj = rootedServices[id];
    if (!afterObj) continue;
    const after = afterObj.state;
    const afterSuppressedBy = afterObj.suppressed_by || null;

    if (afterObj.auth_local_failure && forceServices.has(id)) {
      events.push(`FHD_LOCAL_GUIDANCE ${busSession(env.ENGSYS_SESSION)} ${id} reason=auth_local_failure — session-local auth or context is missing on this host; the service itself is not down (details: fleet health status)`);
    }

    const unsuppressedWhileFailing =
      before === after &&
      Boolean(beforeSuppressedBy) &&
      !afterSuppressedBy &&
      (after === 'degraded' || after === 'down');

    if (before === after && !unsuppressedWhileFailing) continue;

    const transition = {
      service: id,
      from: before,
      from_known: beforeKnown,
      to: after,
      since: afterObj.since || nowIso,
      advice: afterObj.advice || '',
      detail: afterObj.detail || '',
      suppressed_by: afterSuppressedBy,
      was_suppressed_by: beforeSuppressedBy,
      unsuppressed: unsuppressedWhileFailing,
      root_cause: afterObj.root_cause || null,
      hold_merges: Boolean(afterObj.hold_merges),
      simulated: Boolean(afterObj.simulated),
    };
    transitions.push(transition);

    // Suppress derivative alarms when `suppressed_by` is set (#100 P3)
    if (transition.suppressed_by) continue;
    // Never emit outage alarms on `unknown` (broken probe)
    if (after === 'unknown') continue;

    const line = engineBusSuffix(id, after, afterObj, spec);
    if ((before === 'healthy' || unsuppressedWhileFailing) && (after === 'degraded' || after === 'down')) {
      events.push(`FHD_TRIP ${line}`);
      events.push(`FHD_CHANGE ${line}`);
    } else if ((before === 'degraded' || before === 'down' || (before === 'unknown' && (beforeKnown === 'degraded' || beforeKnown === 'down'))) && after === 'healthy') {
      events.push(`FHD_RECOVER ${id} healthy`);
      events.push(`FHD_CHANGE ${id} healthy`);
    } else {
      events.push(`FHD_CHANGE ${line}`);
    }
  }

  const updatedAt = (anyEvaluated || transitions.length > 0 || events.length > 0 || !currentState.updated_at)
    ? nowIso
    : currentState.updated_at;

  const updatedState = {
    version: 1,
    updated_at: updatedAt,
    services: rootedServices,
  };

  if (stateDir) {
    withLock(stateDir, () => {
      saveEngineState(stateDir, updatedState);
    });
  }

  return {
    state: updatedState,
    transitions,
    events,
  };
}

/**
 * Inject or clear a simulated state for `<serviceId>` (#100 P3 `/mnt-watch-simulate`).
 */
export async function simulateServiceState(registry, {
  stateDir,
  serviceId,
  targetState,
  ttlMinutes = 30,
  now = new Date(),
  ...tickOpts
} = {}) {
  if (!registry?.services?.[serviceId]) {
    throw new Error(`unknown service ${JSON.stringify(serviceId)}`);
  }
  if (!SIMULATABLE_STATES.has(targetState)) {
    throw new Error(`state must be one of ${[...SIMULATABLE_STATES].join(', ')} (got ${JSON.stringify(targetState)})`);
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowIsoStr(nowDate);
  const expIso = nowIsoStr(new Date(nowDate.getTime() + ttlMinutes * 60_000));

  withLock(stateDir, () => {
    const st = loadEngineState(stateDir, nowDate);
    const cur = st.services[serviceId] ? { ...defaultServiceState(nowIso), ...st.services[serviceId] } : defaultServiceState(nowIso);
    if (targetState === 'clear') {
      cur.simulated = null;
    } else {
      cur.simulated = {
        state: targetState,
        set_at: nowIso,
        expires_at: expIso,
        detail: `simulated ${targetState} (TTL ${ttlMinutes}m)`,
      };
    }
    st.services[serviceId] = cur;
    saveEngineState(stateDir, st);
  });

  return runEngineTick(registry, {
    stateDir,
    forceServices: new Set([serviceId]),
    now: nowDate,
    ...tickOpts,
  });
}
