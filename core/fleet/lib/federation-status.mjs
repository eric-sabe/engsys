#!/usr/bin/env node
// federation-status.mjs — `fleet status --federation`: one read-only view of every fleet and every baton.
//
//   federation-status.mjs [--json] [--file federation.yml]
//
// Fleets: for each fleet in the registry, its operator, enabled flag and status issue, plus the age
// of the `<!-- fleet-heartbeat -->` and `<!-- broker-heartbeat -->` blocks read from that issue (the
// writers are fleet/heartbeat.sh and the resource broker's broker-heartbeat.sh). The relay column is
// filled by the cross-fleet relay (#77); until it reports, relay is `-` / null.
// Batons: for each repo role, home, standby, and the live holder and expiry read from
// refs/engsys/batons/<role> through the github lease backend's own `status` read (lib/lease), with a
// `!` flag when the holder's fleet is not the role's home.
//
// Read-only: only GET requests, issued through `gh api` (the fleet's gh identity), never a write.
// Every per-row failure is shown on its row and never aborts the table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghApiClient } from '../../lib/gate-check.mjs';
import { formatFromEnv, isConfigured } from '../../lib/operator-time.mjs';
import { createGithubLease, fleetOf, RELEASED_HOLDER } from '../../lib/lease/github-backend.mjs';
import {
  ROLES, FederationError, checkFleetId, instanceRepo, loadFederation, resolveFederationFile,
} from './federation.mjs';

const BLOCK_RE = (name) => new RegExp(`<!--\\s*${name}\\s*-->\\s*\\nlast:\\s*([^\\s—-]\\S*)`);
const MARKERS = { fleet: 'fleet-heartbeat', broker: 'broker-heartbeat' };

/** The ISO timestamp in a `<!-- <marker> -->` block's `last:` line, as ms since epoch, or null. */
export function heartbeatMs(body, marker) {
  const m = typeof body === 'string' ? BLOCK_RE(marker).exec(body) : null;
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/** `90` -> `1m`, `7300` -> `2h`, `200000` -> `2d`: the largest whole unit, seconds in. */
export function humanSeconds(sec) {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

async function readStatusIssue(api, repo, number) {
  const res = await api.request('GET', `/repos/${repo}/issues/${number}`);
  if (res.status !== 200 || typeof res.json?.body !== 'string') {
    throw new Error(`HTTP ${res.status}${res.json?.message ? ` ${res.json.message}` : ''}`);
  }
  return res.json.body;
}

async function collectFleet(id, spec, { api, repo, repoProblem, nowMs }) {
  const row = {
    id, operator: spec.operator ?? null, enabled: spec.enabled !== false,
    statusIssue: spec.status_issue ? { repo, number: spec.status_issue } : null,
    fleetHeartbeat: null, brokerHeartbeat: null, relay: null,
  };
  if (!spec.status_issue) return row;
  if (!repo) { row.error = repoProblem; return row; }
  try {
    const body = await readStatusIssue(api, repo, spec.status_issue);
    for (const [key, field] of [['fleet', 'fleetHeartbeat'], ['broker', 'brokerHeartbeat']]) {
      const at = heartbeatMs(body, MARKERS[key]);
      if (at !== null) row[field] = { at: new Date(at).toISOString(), ageSec: Math.max(0, Math.round((nowMs - at) / 1000)) };
    }
  } catch (e) {
    row.error = `status issue unreadable: ${String(e.message ?? e)}`;
  }
  return row;
}

async function collectBaton(repo, role, spec, { leaseFor }) {
  const row = {
    repo, role, home: spec.home, standby: spec.standby ?? [],
    state: 'error', holder: null, holderFleet: null, expiresAt: null, expiresInSec: null, flag: false,
  };
  let st;
  try {
    st = await leaseFor(repo).status({ role });
  } catch (e) {
    row.error = String(e.message ?? e);
    return row;
  }
  if (st.state === 'error') {
    row.error = st.failure?.message ?? st.reason ?? 'unreadable';
    return row;
  }
  row.state = st.state === 'unknown' ? (st.expired ? 'expired' : 'unknown') : st.state;
  if (st.state === 'unknown' && !st.expired) row.error = st.reason ?? 'malformed baton';
  const holder = st.holder ?? null;
  if (holder && holder !== RELEASED_HOLDER) {
    row.holder = holder;
    row.holderFleet = fleetOf(holder);
    row.expiresAt = st.expiresAt ?? null;
    row.expiresInSec = typeof st.expiresInMs === 'number' ? Math.round(st.expiresInMs / 1000) : null;
    row.flag = row.holderFleet !== null && row.holderFleet !== spec.home;
  }
  return row;
}

/**
 * Gather the federation view. `api` is a `request(method, path)` client (default: `gh api`);
 * `leaseFor(repo)` builds the baton reader (default: the github lease backend over `api`).
 */
export async function collect(reg, { file = '', env = process.env, api = ghApiClient(), now = Date.now, leaseFor } = {}) {
  const nowMs = now();
  const mkLease = leaseFor ?? ((repo) => createGithubLease({ repo, api, env }));
  let repo = null;
  let repoProblem = null;
  if (Object.values(reg.fleets).some((f) => f.status_issue)) {
    try {
      repo = instanceRepo(file, env);
    } catch (e) {
      repoProblem = e.message;
    }
    if (!repo && !repoProblem) repoProblem = 'cannot tell which repo holds the status issues: set FLEET_INSTANCE_REPO=owner/name or give the federation file a GitHub origin remote';
  }
  const fleetJobs = Object.entries(reg.fleets).map(([id, spec]) => collectFleet(id, spec, { api, repo, repoProblem, nowMs }));
  const batonJobs = [];
  for (const [r, roles] of Object.entries(reg.repos)) {
    for (const role of ROLES) if (roles[role]) batonJobs.push(collectBaton(r, role, roles[role], { leaseFor: mkLease }));
  }
  const [fleets, batons] = await Promise.all([Promise.all(fleetJobs), Promise.all(batonJobs)]);
  return { generatedAt: new Date(nowMs).toISOString(), file, fleets, batons };
}

const age = (hb) => (hb ? humanSeconds(hb.ageSec) : '-');

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)];
}

/**
 * The plain-text rendering of a `collect` result. With an operator time format in `env`
 * (OPERATOR_TIMEZONE / OPERATOR_CLOCK) it adds an "as of" line and the baton expiry as a clock time;
 * without one the table is unchanged. The JSON view never changes: it stays ISO 8601 UTC.
 */
export function render(data, env = {}) {
  const out = [];
  const human = isConfigured(env);
  if (human) out.push(`as of ${formatFromEnv(data.generatedAt, env)}`, '');
  const fleetRows = data.fleets.map((f) => [
    f.id, f.operator ?? '-', f.enabled ? 'yes' : 'no',
    f.statusIssue ? `${f.statusIssue.repo ?? '?'}#${f.statusIssue.number}` : '-',
    f.error ? '?' : age(f.fleetHeartbeat), f.error ? '?' : age(f.brokerHeartbeat),
    // `relay` is filled in by the cross-fleet relay (#77); `-` until then.
    f.relay ? humanSeconds(f.relay.ageSec) : '-',
  ]);
  out.push('fleets', ...table(['FLEET', 'OPERATOR', 'ENABLED', 'STATUS ISSUE', 'FLEET-HB', 'BROKER-HB', 'RELAY'], fleetRows).map((l) => `  ${l}`));
  out.push('', 'batons');
  const batonRows = data.batons.map((b) => {
    let expires = '-';
    if (b.state === 'error' || b.state === 'unknown') expires = '?';
    else if (b.expiresInSec !== null) expires = b.expiresInSec > 0 ? humanSeconds(b.expiresInSec) : `expired ${humanSeconds(b.expiresInSec)} ago`;
    if (human && b.expiresAt && expires !== '-' && expires !== '?') expires += ` (${formatFromEnv(b.expiresAt, env)})`;
    const holder = b.holder ?? (b.state === 'free' ? '-' : '?');
    return [b.repo, b.role, b.home, b.standby.length ? b.standby.join(',') : '-', holder, expires, b.flag ? '!' : ''];
  });
  if (batonRows.length) out.push(...table(['REPO', 'ROLE', 'HOME', 'STANDBY', 'HOLDER', 'EXPIRES-IN', 'FLAG'], batonRows).map((l) => `  ${l}`));
  else out.push('  no repo roles declared');
  const notes = [
    ...data.fleets.filter((f) => f.error).map((f) => `fleet ${f.id}: ${f.error}`),
    ...data.batons.filter((b) => b.error).map((b) => `baton ${b.repo} ${b.role}: ${b.error}`),
    ...data.batons.filter((b) => b.flag).map((b) => `baton ${b.repo} ${b.role}: held by ${b.holderFleet}, home is ${b.home}`),
  ];
  if (notes.length) out.push('', ...notes.map((n) => `! ${n}`));
  return out;
}

const USAGE = 'usage: federation-status.mjs [--json] [--file federation.yml]';

export async function main(argv, { env = process.env, out = process.stdout, err = process.stderr, cwd = process.cwd(), api, now, leaseFor } = {}) {
  const say = (s) => out.write(`${s}\n`);
  let json = false;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--federation') continue; // `fleet status --federation` hands its flag through
    else if (a === '--file') { file = argv[++i]; if (!file) { err.write(`federation-status: --file needs a path\n`); return 1; } }
    else if (a.startsWith('--file=')) file = a.slice(7);
    else if (a === '-h' || a === '--help') { say(USAGE); return 0; }
    else { err.write(`federation-status: unknown argument ${JSON.stringify(a)}\n${USAGE}\n`); return 1; }
  }
  const target = path.resolve(cwd, file ?? resolveFederationFile(env, cwd));
  try {
    checkFleetId(env.FLEET_ID);
    const reg = loadFederation(target);
    if (!reg) {
      if (json) say(JSON.stringify({ generatedAt: new Date((now ?? Date.now)()).toISOString(), file: target, federation: false, fleets: [], batons: [] }));
      else say(`no federation file (${target}): single-fleet mode`);
      return 0;
    }
    const data = await collect(reg, { file: target, env, ...(api ? { api } : {}), ...(now ? { now } : {}), ...(leaseFor ? { leaseFor } : {}) });
    data.federation = true;
    if (json) say(JSON.stringify(data, null, 2));
    else for (const l of render(data, env)) say(l);
    return 0;
  } catch (e) {
    if (e instanceof FederationError) { err.write(`federation-status: ${e.message}\n`); return 1; }
    throw e;
  }
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
