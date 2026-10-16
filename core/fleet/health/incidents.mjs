#!/usr/bin/env node
// incidents.mjs — Inbound report validation, cross-fleet report formatting, report correlation
// (collapsing N reports within window into one incident, splitting vendor-wide vs session-local),
// incident lifecycle tracking, and weekly SLO-lite digest (engsys#98, #99, #100).
//
// Zero dependencies: node builtins + core modules.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defang } from '../../lib/untrusted.mjs';
import { ensureDir, readJson, withLock, writeFileAtomic } from '../lib/inbox.mjs';
import { render as renderFleetMsg } from '../lib/fleet-msg.mjs';
import { SERVICE_ID_RE } from './registry.mjs';
import { loadEngineState, runEngineTick } from './engine.mjs';

const SESSION_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_SYMPTOM_LEN = 240;

function nowIsoStr(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function reportsFilePath(stateDir) {
  return path.join(stateDir, 'fhd-reports.jsonl');
}

export function incidentsStatePath(stateDir) {
  return path.join(stateDir, 'fhd-incidents.json');
}

export function incidentsLogPath(stateDir) {
  return path.join(stateDir, 'fhd-incidents.jsonl');
}

/**
 * Sanitize untrusted symptom text: single-line, defanged against envelope markers, HTML comments stripped, capped.
 */
export function sanitizeSymptom(raw) {
  const text = defang(String(raw ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<!--/g, '<! --')
    .replace(/-->/g, '-- >')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_SYMPTOM_LEN);
}

export function readReports(stateDir) {
  const file = reportsFilePath(stateDir);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeReports(stateDir, reports) {
  ensureDir(stateDir);
  const content = reports.map((r) => JSON.stringify(r)).join('\n') + (reports.length ? '\n' : '');
  writeFileAtomic(reportsFilePath(stateDir), content);
}

export function loadIncidentsState(stateDir) {
  const raw = readJson(incidentsStatePath(stateDir), null);
  if (!raw || typeof raw !== 'object') {
    return { version: 1, active: {}, history: [], last_verified_at: {} };
  }
  return {
    version: 1,
    active: raw.active && typeof raw.active === 'object' ? { ...raw.active } : {},
    history: Array.isArray(raw.history) ? [...raw.history] : [],
    last_verified_at: raw.last_verified_at && typeof raw.last_verified_at === 'object' ? { ...raw.last_verified_at } : {},
  };
}

export function saveIncidentsState(stateDir, state) {
  ensureDir(stateDir);
  writeFileAtomic(incidentsStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

function appendIncidentHistoryLog(stateDir, entry) {
  ensureDir(stateDir);
  fs.appendFileSync(incidentsLogPath(stateDir), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Submit an inbound report (`fleet health report <service> "<symptom>"`).
 * Supports same-fleet local inbox append and cross-fleet `fleet-msg` payload formatting (#98).
 */
export function submitReport(registry, {
  stateDir,
  service,
  symptom,
  session = process.env.ENGSYS_SESSION || 'local-session',
  fleet = process.env.FLEET_ID || 'local',
  crossFleet = false,
  toAddress = null,
  fromAddress = null,
  reRef = null,
  now = new Date(),
} = {}) {
  if (!service || !SERVICE_ID_RE.test(service) || !registry?.services?.[service]) {
    throw new Error(`unknown or invalid service ${JSON.stringify(service)}`);
  }
  const cleanSymptom = sanitizeSymptom(symptom);
  if (!cleanSymptom) {
    throw new Error('symptom is required and cannot be empty');
  }
  const cleanSession = SESSION_SAFE_RE.test(String(session ?? '')) ? String(session) : 'local-session';
  const cleanFleet = SESSION_SAFE_RE.test(String(fleet ?? '')) ? String(fleet) : 'local';
  const nowIso = nowIsoStr(now);
  const report = {
    id: `rep-${service}-${Date.now()}-${randomBytes(3).toString('hex')}`,
    service,
    symptom: cleanSymptom,
    session: cleanSession,
    fleet: cleanFleet,
    reported_at: nowIso,
    processed: false,
  };

  if (crossFleet || toAddress) {
    const to = toAddress || 'home:maintain';
    const from = fromAddress || `${cleanFleet === 'local' ? 'spoke' : cleanFleet}:${cleanSession}`;
    const re = reRef || (registry.board?.repo && registry.board?.issue ? `${registry.board.repo}#${registry.board.issue}` : null);
    const body = `FHD_REPORT service=${service} session=${cleanSession} symptom=${JSON.stringify(cleanSymptom)}`;
    const payload = renderFleetMsg({ to, from, re, body });
    return {
      mode: 'cross-fleet',
      to,
      from,
      re,
      payload,
      report,
    };
  }

  if (!stateDir) throw new Error('stateDir is required to record a local report');
  withLock(stateDir, () => {
    const existing = readReports(stateDir);
    existing.push(report);
    writeReports(stateDir, existing);
  });

  return {
    mode: 'local',
    report,
  };
}

/**
 * Parse a cross-fleet `FHD_REPORT` message body and record it into the desk's local report inbox.
 */
export function ingestCrossFleetReport(registry, {
  stateDir,
  body,
  fromFleet = 'remote',
  fromSession = 'remote-session',
  now = new Date(),
} = {}) {
  const m = /\bFHD_REPORT\s+service=([a-z0-9][a-z0-9_-]*)(?:\s+session=([A-Za-z0-9._-]+))?\s+symptom=(.+)$/m.exec(String(body ?? '').trim());
  if (!m) return null;
  const service = m[1];
  const session = m[2] || fromSession;
  let rawSymptom = m[3].trim();
  if (rawSymptom.startsWith('"') && rawSymptom.endsWith('"')) {
    try { rawSymptom = JSON.parse(rawSymptom); } catch { /* keep raw */ }
  }
  return submitReport(registry, {
    stateDir,
    service,
    symptom: rawSymptom,
    session,
    fleet: fromFleet,
    crossFleet: false,
    now,
  });
}

function formatLocalGuidance(serviceSpec, svcState) {
  const parts = [];
  if (serviceSpec.observability === 'per-session') {
    parts.push(`${serviceSpec.id} is a per-session local dependency (central probes cannot see your host)`);
    parts.push('defer local-env authority to the resource broker (never use PUSH_OVERRIDE)');
  } else if (svcState?.auth_local_failure) {
    parts.push(svcState.detail || `central ${serviceSpec.id} is healthy; host/session auth or context is missing`);
  } else {
    parts.push(`central ${serviceSpec.id} probe is healthy; issue appears session-local (check local network, auth, or rate limits)`);
  }
  if (serviceSpec.runbook) parts.push(`runbook: ${serviceSpec.runbook}`);
  return parts.join(' — ');
}

/**
 * Synchronize active incidents with the latest engine service states:
 *   - Opens/confirms an incident when a central service trips to degraded/down (even without reports).
 *   - Marks an incident `mitigated` when transitioning from `down` to `degraded`.
 *   - Marks an incident `resolved` (`resolved_at` set) when the service recovers to `healthy`.
 */
export function syncIncidentsWithEngineState(registry, {
  stateDir,
  engineState,
  now = new Date(),
} = {}) {
  const nowIso = nowIsoStr(now);
  const incState = loadIncidentsState(stateDir);

  for (const [serviceId, spec] of Object.entries(registry.services ?? {})) {
    if (spec.observability === 'per-session') continue;
    const svc = engineState?.services?.[serviceId];
    if (!svc) continue;
    const active = incState.active[serviceId];

    if (svc.state === 'down' || svc.state === 'degraded') {
      if (!active) {
        const opened = {
          id: `inc-${serviceId}-${Date.now()}-${randomBytes(2).toString('hex')}`,
          service: serviceId,
          state: 'confirmed',
          service_state: svc.state,
          classification: 'vendor-wide',
          opened_at: svc.since || nowIso,
          updated_at: nowIso,
          confidence: 'high',
          contributing_reports: [],
          root_cause: svc.root_cause || null,
          suppressed_by: svc.suppressed_by || null,
          mitigation: svc.advice || svc.detail || '',
          resolved_at: null,
        };
        incState.active[serviceId] = opened;
        appendIncidentHistoryLog(stateDir, { event: 'opened', at: nowIso, incident: opened });
      } else {
        const nextLifecycle = (active.service_state === 'down' && svc.state === 'degraded') ? 'mitigated' : 'confirmed';
        active.state = nextLifecycle;
        active.service_state = svc.state;
        active.updated_at = nowIso;
        active.root_cause = svc.root_cause || null;
        active.suppressed_by = svc.suppressed_by || null;
        active.mitigation = svc.advice || svc.detail || active.mitigation;
      }
    } else if (svc.state === 'healthy' && active) {
      const resolved = {
        ...active,
        state: 'resolved',
        service_state: 'healthy',
        updated_at: nowIso,
        resolved_at: nowIso,
      };
      delete incState.active[serviceId];
      incState.history.push(resolved);
      appendIncidentHistoryLog(stateDir, { event: 'resolved', at: nowIso, incident: resolved });
    }
  }

  saveIncidentsState(stateDir, incState);
  return incState;
}

/**
 * Correlate pending inbound reports (`#98` P1-B):
 *   - Collapses N reports for `<service>` within `correlation_window_minutes` into ONE incident.
 *   - Triggers an immediate verification probe (bypassing `poll_seconds` once, rate-limited by `verifyCooldownSeconds`).
 *   - Distinguishes `vendor-wide` (probe confirms degraded/down -> incident confirmed) from
 *     `session-local` (probe clean or authLocalFailure or per-session -> emits targeted `FHD_LOCAL_GUIDANCE`,
 *     never broadcasts to Slack or trips the central board).
 */
export async function correlateReports(registry, {
  stateDir,
  now = new Date(),
  verifyCooldownSeconds = 60,
  ...tickOpts
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const nowIso = nowIsoStr(nowDate);
  const windowMs = (registry.correlation_window_minutes ?? 15) * 60_000;

  const allReports = readReports(stateDir);
  const pending = allReports.filter((r) => !r.processed && (nowMs - Date.parse(r.reported_at || nowIso) <= windowMs));
  if (pending.length === 0) {
    return { incidentsState: loadIncidentsState(stateDir), events: [], engineResult: null };
  }

  // Group pending reports by service
  const byService = new Map();
  for (const r of pending) {
    if (!registry.services[r.service]) {
      r.processed = true;
      continue;
    }
    if (!byService.has(r.service)) byService.set(r.service, []);
    byService.get(r.service).push(r);
  }

  const incState = loadIncidentsState(stateDir);
  const forceServices = new Set();

  for (const serviceId of byService.keys()) {
    const spec = registry.services[serviceId];
    if (spec.observability === 'per-session') continue;
    const lastVer = incState.last_verified_at[serviceId] ? Date.parse(incState.last_verified_at[serviceId]) : 0;
    if (!lastVer || (nowMs - lastVer) >= verifyCooldownSeconds * 1000) {
      forceServices.add(serviceId);
      incState.last_verified_at[serviceId] = nowIso;
    }
  }
  saveIncidentsState(stateDir, incState);

  // Run verification probes for reported central services
  let engineResult = null;
  if (forceServices.size > 0) {
    engineResult = await runEngineTick(registry, {
      stateDir,
      forceServices,
      now: nowDate,
      ...tickOpts,
    });
  }
  const engineState = engineResult?.state ?? loadEngineState(stateDir, nowDate);
  const updatedIncState = loadIncidentsState(stateDir);
  const events = [...(engineResult?.events ?? [])];

  for (const [serviceId, reports] of byService.entries()) {
    const spec = registry.services[serviceId];
    const svcState = engineState.services?.[serviceId];
    const probeConfirmedTrouble = spec.observability === 'central'
      && (
        svcState?.state === 'down'
        || svcState?.state === 'degraded'
        || svcState?.raw_state === 'down'
        || svcState?.raw_state === 'degraded'
        || (spec.probe?.adapter === 'fleet-report-only' && reports.length >= (spec.thresholds?.trip_fails ?? 1))
      )
      && !svcState?.auth_local_failure;

    if (probeConfirmedTrouble) {
      // Vendor-wide incident: collapse all N reports into one incident record
      const effectiveState = (svcState?.state === 'down' || svcState?.state === 'degraded')
        ? svcState.state
        : (svcState?.raw_state === 'down' ? 'down' : 'degraded');

      // Ensure engine state reflects the confirmed report-corroborated state even if trip_fails > 1
      if (svcState && svcState.state === 'healthy') {
        svcState.state = effectiveState;
        svcState.last_known_state = effectiveState;
        svcState.since = nowIso;
      }

      let inc = updatedIncState.active[serviceId];
      if (!inc) {
        inc = {
          id: `inc-${serviceId}-${nowMs}-${randomBytes(2).toString('hex')}`,
          service: serviceId,
          state: 'confirmed',
          service_state: effectiveState,
          classification: 'vendor-wide',
          opened_at: nowIso,
          updated_at: nowIso,
          confidence: 'high',
          contributing_reports: [],
          root_cause: svcState?.root_cause || null,
          suppressed_by: svcState?.suppressed_by || null,
          mitigation: svcState?.advice || spec.impact?.advice || svcState?.detail || '',
          resolved_at: null,
        };
        updatedIncState.active[serviceId] = inc;
      } else {
        inc.state = 'confirmed';
        inc.service_state = effectiveState;
        inc.classification = 'vendor-wide';
        inc.updated_at = nowIso;
        inc.confidence = 'high';
      }

      for (const r of reports) {
        if (!inc.contributing_reports.some((cr) => cr.id === r.id)) {
          inc.contributing_reports.push({
            id: r.id,
            session: r.session,
            fleet: r.fleet,
            symptom: r.symptom,
            reported_at: r.reported_at,
          });
        }
        r.processed = true;
      }

      appendIncidentHistoryLog(stateDir, {
        event: 'correlated_vendor_wide',
        at: nowIso,
        incident: inc,
      });

      events.push(
        `FHD_REPORT_CORRELATED ${serviceId} ${inc.id} vendor-wide reports=${inc.contributing_reports.length} state=${effectiveState}`,
      );
    } else {
      // Session-local: probe is clean (or authLocalFailure, or per-session service) -> guide reporting sessions only, no broadcast!
      const guidance = formatLocalGuidance(spec, svcState);
      const seenSessions = new Set();
      for (const r of reports) {
        r.processed = true;
        const target = r.fleet && r.fleet !== 'local' ? `${r.fleet}:${r.session}` : r.session;
        if (!seenSessions.has(target)) {
          seenSessions.add(target);
          events.push(`FHD_LOCAL_GUIDANCE ${target} ${serviceId} — ${guidance}`);
        }
      }
      const localRecord = {
        id: `local-${serviceId}-${nowMs}-${randomBytes(2).toString('hex')}`,
        service: serviceId,
        state: 'resolved',
        service_state: 'healthy',
        classification: 'session-local',
        opened_at: nowIso,
        updated_at: nowIso,
        resolved_at: nowIso,
        confidence: 'high',
        contributing_reports: reports.map((r) => ({
          id: r.id,
          session: r.session,
          fleet: r.fleet,
          symptom: r.symptom,
          reported_at: r.reported_at,
        })),
        mitigation: guidance,
      };
      updatedIncState.history.push(localRecord);
      appendIncidentHistoryLog(stateDir, {
        event: 'deflected_session_local',
        at: nowIso,
        incident: localRecord,
      });
    }
  }

  withLock(stateDir, () => {
    writeReports(stateDir, allReports);
    saveIncidentsState(stateDir, updatedIncState);
  });

  return {
    incidentsState: updatedIncState,
    events,
    engineResult,
  };
}

/**
 * Compute weekly SLO-lite incident digest (`fleet health digest --days 7`, #100 P3).
 */
export function computeDigest(registry, { stateDir, days = 7, now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const windowMs = days * 86400_000;
  const windowStartMs = nowMs - windowMs;
  const incState = loadIncidentsState(stateDir);

  const allIncidents = [
    ...Object.values(incState.active),
    ...incState.history,
  ];

  const servicesSummary = {};
  for (const id of Object.keys(registry.services ?? {})) {
    servicesSummary[id] = {
      service: id,
      observability: registry.services[id].observability,
      vendor_wide_incidents: 0,
      session_local_reports: 0,
      suppressed_incidents: 0,
      downtime_minutes: 0,
      mttr_minutes: null,
      availability_pct: 100,
    };
  }

  const resolvedDurations = new Map();

  for (const inc of allIncidents) {
    if (!inc || !servicesSummary[inc.service]) continue;
    const openedMs = Date.parse(inc.opened_at || '');
    const resolvedMs = inc.resolved_at ? Date.parse(inc.resolved_at) : nowMs;
    if (!Number.isFinite(openedMs) || resolvedMs < windowStartMs) continue;

    const sum = servicesSummary[inc.service];
    if (inc.classification === 'session-local') {
      sum.session_local_reports += (inc.contributing_reports?.length || 1);
      continue;
    }

    if (inc.suppressed_by) {
      sum.suppressed_incidents += 1;
      continue;
    }

    sum.vendor_wide_incidents += 1;
    const startClamp = Math.max(openedMs, windowStartMs);
    const endClamp = Math.min(resolvedMs, nowMs);
    const durMin = Math.max(0, (endClamp - startClamp) / 60_000);
    sum.downtime_minutes += durMin;

    if (inc.resolved_at && Number.isFinite(resolvedMs)) {
      const fullMin = Math.max(0, (resolvedMs - openedMs) / 60_000);
      if (!resolvedDurations.has(inc.service)) resolvedDurations.set(inc.service, []);
      resolvedDurations.get(inc.service).push(fullMin);
    }
  }

  const totalWindowMin = days * 1440;
  for (const [id, sum] of Object.entries(servicesSummary)) {
    sum.downtime_minutes = Math.round(sum.downtime_minutes * 10) / 10;
    const avail = Math.max(0, ((totalWindowMin - sum.downtime_minutes) / totalWindowMin) * 100);
    sum.availability_pct = Number(avail.toFixed(2));
    const durs = resolvedDurations.get(id);
    if (durs && durs.length > 0) {
      const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
      sum.mttr_minutes = Math.round(avg * 10) / 10;
    }
  }

  const lines = [
    `### 📊 Fleet Health Desk — ${days}-Day SLO-Lite Digest (${nowIsoStr(nowDate)})`,
    '',
    '| Service | Availability | Vendor Incidents | Suppressed (Root-Caused) | Session-Local Deflected | Downtime (min) | MTTR (min) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of Object.values(servicesSummary)) {
    lines.push(
      `| \`${s.service}\` | ${s.availability_pct.toFixed(2)}% | ${s.vendor_wide_incidents} | ${s.suppressed_incidents} | ${s.session_local_reports} | ${s.downtime_minutes} | ${s.mttr_minutes ?? '-'} |`,
    );
  }

  return {
    window_days: days,
    generated_at: nowIsoStr(nowDate),
    services: servicesSummary,
    markdown: lines.join('\n'),
  };
}
