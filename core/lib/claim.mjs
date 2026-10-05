#!/usr/bin/env node
// claim.mjs — cross-fleet work claiming: a `fleet:<id>` label (plus an optional project board Owner
// field) that stops two fleets from picking up the same issue, and the fleet-prefixed branch-name
// helpers implement-issue/implement-project use once a fleet is claimed.
//
// Design: docs/multi-fleet.md § 3 "Fleet and host roles"; operator guide: fleet-guide.md § 6.10.
// Zero-dependency ESM, Node >= 20. The only external process is `gh`, via gate-check.mjs's
// `ghApiClient` (same shape, same injectable `api` for tests — no network, no real `gh` in tests).
//
// Public API (pure unless it takes `api`):
//   FLEET_ID_RE, CLAIM_LABEL_RE, CLAIM_LABEL_COLOR, STALE_MS, HEARTBEAT_FRESH_MS   constants
//   claimLabel(fleetId)                     -> 'fleet:<id>'
//   parseClaimLabel(name)                   -> fleet id, or null if not a claim label
//   branchName(fleetId, slug)               -> 'agent/<fleet>/<slug>' or 'agent/<slug>' (no fleet)
//   issueBranchSlug(number, slug)           -> '<number>-<slug>' (what branchName composes for an issue)
//   parseRef(ref)                           -> { repo, number } from 'owner/repo#123'
//   parseHeartbeat(body, now)               -> true/false/null (fresh/stale/no marker) — see below
//   isClaimActive({ labeledAt, heartbeatFresh, now })   the refusal rule
//   EXIT                                    { OK: 0, ERROR: 1, FOREIGN: 4 }
//   acquireClaim(api, opts), releaseClaim(api, opts), claimStatus(api, opts)   the gh-backed verbs
//   main(argv, { api, env, out, err })      the CLI
//
// Single-fleet mode: when FLEET_ID is unset (no `env.FLEET_ID` / `--fleet-id`), acquire and release
// are no-ops that exit 0 (nothing to claim against; every caller behaves exactly as before this
// module existed), and branchName returns the unprefixed name.
//
// Heartbeat marker (status issue), same shape as mm-heartbeat.sh's ledger block:
//   <!-- fleet-heartbeat -->
//   last: 2026-10-04T12:00:00Z — status: ...
//   <!-- /fleet-heartbeat -->
// No marker in the status issue body means "unresolvable": the age rule alone decides (per
// docs/multi-fleet.md § 3: "or that fleet's status issue heartbeat is fresh (if resolvable from
// federation.yml; else just the 7-day rule)"). A marker whose timestamp cannot be parsed is treated
// the same way — never silently resolved as stale.
//
// Trust model: an issue's labels, timeline and a status issue's body are all attacker-influenceable
// text (anyone who can comment or label can try to shape this). The claim decision is read only from
// structured API fields (label name, timeline event type + timestamp) and the heartbeat marker's own
// anchored grammar, never from free text, and a takeover always requires the caller's own
// `--takeover` flag — nothing in the issue body can force one.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ghApiClient } from './gate-check.mjs';
import { FLEET_ID_RE, loadFederation, resolveFederationFile, checkFleetId } from '../fleet/lib/federation.mjs';

export { FLEET_ID_RE };

/** A `fleet:<id>` label name. */
export const CLAIM_LABEL_RE = /^fleet:([a-z][a-z0-9-]{1,20})$/;
/** Neutral, non-alarming label color (light gray-blue) — this is bookkeeping, not a status signal. */
export const CLAIM_LABEL_COLOR = 'c5def5';
const CLAIM_LABEL_DESC = (id) => `Claimed by fleet "${id}" (cross-fleet work claiming, engsys multi-fleet §3)`;
/** A foreign claim younger than this is "fresh" by the age rule alone, whatever the heartbeat says. */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** A status-issue heartbeat marker older than this reads as stale (same order as mm/mnt heartbeats). */
export const HEARTBEAT_FRESH_MS = 30 * 60 * 1000;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const HEARTBEAT_RE = /<!--\s*fleet-heartbeat\s*-->\s*\nlast:\s*([^\s—-]\S*)/;

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, FOREIGN: 4 });

// --- pure helpers ----------------------------------------------------------------------------------

/** The label name for a fleet's claim. */
export function claimLabel(fleetId) {
  if (!FLEET_ID_RE.test(fleetId ?? '')) throw new TypeError(`claim: invalid fleet id ${JSON.stringify(fleetId)}`);
  return `fleet:${fleetId}`;
}

/** The fleet id a claim label names, or null if `name` is not a `fleet:<id>` label. */
export function parseClaimLabel(name) {
  const m = typeof name === 'string' ? CLAIM_LABEL_RE.exec(name) : null;
  return m ? m[1] : null;
}

/**
 * Fleet-prefixed branch name: `agent/<fleet>/<slug>` when a fleet id is given, else the unchanged
 * `agent/<slug>` (single-fleet mode — docs/multi-fleet.md § 3). `slug` is everything after `agent/`
 * today: `<n>-<slug>` for an issue, a project/phase slug for a batch.
 */
export function branchName(fleetId, slug) {
  if (typeof slug !== 'string' || slug === '') throw new TypeError('claim: branchName needs a non-empty slug');
  if (fleetId === null || fleetId === undefined || fleetId === '') return `agent/${slug}`;
  if (!FLEET_ID_RE.test(fleetId)) throw new TypeError(`claim: invalid fleet id ${JSON.stringify(fleetId)}`);
  return `agent/${fleetId}/${slug}`;
}

/** The `<n>-<slug>` half of a single-issue branch, so callers don't hand-roll the join. */
export function issueBranchSlug(number, slug) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`claim: issue number must be a positive integer, got ${JSON.stringify(number)}`);
  if (typeof slug !== 'string' || slug === '') throw new TypeError('claim: slug must be a non-empty string');
  return `${n}-${slug}`;
}

/** Parse `owner/repo#123` (what every command below takes as its work-item ref). */
export function parseRef(ref) {
  const m = typeof ref === 'string' ? /^([^#]+)#([1-9][0-9]*)$/.exec(ref.trim()) : null;
  if (!m || !REPO_RE.test(m[1])) throw new TypeError(`claim: ref must be owner/repo#N, got ${JSON.stringify(ref)}`);
  return { repo: m[1], number: Number(m[2]) };
}

/**
 * Read the `<!-- fleet-heartbeat -->` marker from a status issue body: true (fresh), false (stale),
 * or null (no marker, or a timestamp that doesn't parse — "unresolvable", per the module doc).
 */
export function parseHeartbeat(body, now = new Date()) {
  const m = typeof body === 'string' ? HEARTBEAT_RE.exec(body) : null;
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (!Number.isFinite(t)) return null;
  return now.getTime() - t < HEARTBEAT_FRESH_MS;
}

/**
 * Is a foreign claim still active (acquire must refuse)? Active when the label is younger than
 * `STALE_MS`, OR the holder's heartbeat reads fresh. `heartbeatFresh` is `null` when unresolvable
 * (no federation entry, no status issue, no marker) — the age rule alone decides then.
 */
export function isClaimActive({ labeledAt, heartbeatFresh = null, now = Date.now() }) {
  const t = labeledAt instanceof Date ? labeledAt.getTime() : typeof labeledAt === 'string' ? Date.parse(labeledAt) : labeledAt;
  if (!Number.isFinite(t)) return true; // can't prove an age — never treat an unprovable claim as takeover-able
  if (now - t < STALE_MS) return true;
  return heartbeatFresh === true;
}

// --- gh-backed verbs ---------------------------------------------------------------------------

async function getOk(api, path, what) {
  const { status, json } = await api.request('GET', path);
  if (status !== 200) throw new Error(`HTTP ${status} while ${what}${json?.message ? `: ${json.message}` : ''}`);
  return json;
}

/** The issue's current labels (name only is used by callers). */
async function issueLabels(api, repo, number) {
  const issue = await getOk(api, `/repos/${repo}/issues/${number}`, 'reading issue labels');
  return Array.isArray(issue.labels) ? issue.labels.map((l) => (typeof l === 'string' ? l : l.name)) : [];
}

/**
 * When the foreign label was added: the most recent `labeled` timeline event naming it. Returns
 * null if no such event can be found (the label may predate the timeline, or was added via a
 * bulk/import path that skips it) — callers then treat the claim as unprovable, hence active.
 */
async function labeledAt(api, repo, number, label) {
  let best = null;
  let page = `/repos/${repo}/issues/${number}/timeline?per_page=100`;
  for (let guard = 0; guard < 50 && page; guard++) {
    const { status, json, headers } = await api.request('GET', page);
    if (status !== 200) throw new Error(`HTTP ${status} while reading the issue timeline`);
    for (const e of json ?? []) {
      if (e.event !== 'labeled' || e.label?.name !== label) continue;
      const t = Date.parse(e.created_at);
      if (Number.isFinite(t) && (!best || t > best)) best = t;
    }
    page = nextLinkPath(headers?.link);
  }
  return best === null ? null : new Date(best).toISOString();
}

/** Same Link-header-following shape as gate-check.mjs's nextLink, inlined to keep this zero-dep. */
function nextLinkPath(link) {
  if (typeof link !== 'string') return null;
  for (const part of link.split(',')) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (m) { const u = new URL(m[1]); return `${u.pathname}${u.search}`; }
  }
  return null;
}

/** Ensure the repo has this claim label, creating it (neutral color) if missing. */
async function ensureLabel(api, repo, fleetId) {
  const name = claimLabel(fleetId);
  const { status } = await api.request('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
  if (status === 200) return;
  if (status !== 404) throw new Error(`HTTP ${status} while checking for label ${name}`);
  const create = await api.request('POST', `/repos/${repo}/labels`, { name, color: CLAIM_LABEL_COLOR, description: CLAIM_LABEL_DESC(fleetId) });
  // Another caller may have created it between the GET and this POST; 422 "already_exists" is fine.
  if (create.status !== 201 && !(create.status === 422 && /already_exists/i.test(JSON.stringify(create.json ?? '')))) {
    throw new Error(`HTTP ${create.status} while creating label ${name}${create.json?.message ? `: ${create.json.message}` : ''}`);
  }
}

/**
 * Whether the foreign holder's status-issue heartbeat is fresh: null when unresolvable (no
 * federation file, fleet not declared, no status_issue, issue unreadable, no marker).
 */
async function foreignHeartbeatFresh(api, foreignFleet, { env = process.env, cwd = process.cwd() } = {}) {
  let reg;
  try {
    reg = loadFederation(resolveFederationFile(env, cwd));
  } catch {
    return null;
  }
  const statusIssue = reg?.fleets?.[foreignFleet]?.status_issue;
  const statusRepo = env.FLEET_REPO_SLUG || env.FLEET_INSTANCE_REPO; // owner/repo of the instance repo, if known
  if (!statusIssue || !statusRepo || !REPO_RE.test(statusRepo)) return null;
  try {
    const issue = await getOk(api, `/repos/${statusRepo}/issues/${statusIssue}`, 'reading the foreign fleet status issue');
    return parseHeartbeat(issue.body);
  } catch {
    return null;
  }
}

/**
 * Acquire the claim on `repo#number` for `fleetId`. Resolves `{ status: 'acquired' | 'already-own' }`
 * or throws `ClaimError` (`.foreign`, `.exit`) when a foreign claim is active, or stale but
 * `--takeover` was not given.
 */
export class ClaimError extends Error {
  constructor(message, { exit = EXIT.FOREIGN, foreign = null } = {}) {
    super(message);
    this.name = 'ClaimError';
    this.exit = exit;
    this.foreign = foreign;
  }
}

export async function acquireClaim(api, { repo, number, fleetId, takeover = false, now = Date.now(), env, cwd } = {}) {
  if (!REPO_RE.test(repo ?? '')) throw new TypeError(`claim: repo must be owner/name, got ${JSON.stringify(repo)}`);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`claim: number must be a positive integer, got ${JSON.stringify(number)}`);
  if (!FLEET_ID_RE.test(fleetId ?? '')) throw new TypeError(`claim: invalid fleet id ${JSON.stringify(fleetId)}`);

  const labels = await issueLabels(api, repo, number);
  const mine = claimLabel(fleetId);
  if (labels.includes(mine)) return { status: 'already-own', fleet: fleetId };

  const foreignLabel = labels.find((l) => parseClaimLabel(l) && parseClaimLabel(l) !== fleetId);
  if (foreignLabel) {
    const foreignFleet = parseClaimLabel(foreignLabel);
    const at = await labeledAt(api, repo, number, foreignLabel);
    const heartbeatFresh = await foreignHeartbeatFresh(api, foreignFleet, { env, cwd });
    const active = isClaimActive({ labeledAt: at, heartbeatFresh, now });
    const since = at ? `since ${at}` : 'at an unknown time (no labeled timeline event found)';
    const hb = heartbeatFresh === true ? ', heartbeat fresh' : heartbeatFresh === false ? ', heartbeat stale' : '';
    if (active) {
      throw new ClaimError(`${repo}#${number} is already claimed by fleet "${foreignFleet}" (${since}${hb})`, {
        exit: EXIT.FOREIGN, foreign: { fleet: foreignFleet, labeledAt: at, heartbeatFresh },
      });
    }
    if (!takeover) {
      throw new ClaimError(`${repo}#${number} carries a stale claim from fleet "${foreignFleet}" (${since}${hb}); pass --takeover to reclaim it`, {
        exit: EXIT.FOREIGN, foreign: { fleet: foreignFleet, labeledAt: at, heartbeatFresh, stale: true },
      });
    }
    await api.request('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(foreignLabel)}`);
    await api.request('POST', `/repos/${repo}/issues/${number}/comments`, {
      body: `Takeover: fleet "${fleetId}" is claiming this issue from fleet "${foreignFleet}"'s stale claim (${since}${hb}).`,
    });
  }

  await ensureLabel(api, repo, fleetId);
  const added = await api.request('POST', `/repos/${repo}/issues/${number}/labels`, { labels: [mine] });
  if (added.status !== 200) throw new Error(`HTTP ${added.status} while adding label ${mine}${added.json?.message ? `: ${added.json.message}` : ''}`);
  return { status: 'acquired', fleet: fleetId, took_over: !!foreignLabel || undefined };
}

/** Release the claim: remove our `fleet:<id>` label. A no-op (not an error) if it was already gone. */
export async function releaseClaim(api, { repo, number, fleetId } = {}) {
  if (!REPO_RE.test(repo ?? '')) throw new TypeError(`claim: repo must be owner/name, got ${JSON.stringify(repo)}`);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`claim: number must be a positive integer, got ${JSON.stringify(number)}`);
  if (!FLEET_ID_RE.test(fleetId ?? '')) throw new TypeError(`claim: invalid fleet id ${JSON.stringify(fleetId)}`);
  const name = claimLabel(fleetId);
  const { status, json } = await api.request('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`);
  if (status !== 200 && status !== 404) throw new Error(`HTTP ${status} while removing label ${name}${json?.message ? `: ${json.message}` : ''}`);
  return { status: 'released', fleet: fleetId, held: status === 200 };
}

/** Who currently holds the claim (or null), for `claim status`. */
export async function claimStatus(api, { repo, number } = {}) {
  if (!REPO_RE.test(repo ?? '')) throw new TypeError(`claim: repo must be owner/name, got ${JSON.stringify(repo)}`);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`claim: number must be a positive integer, got ${JSON.stringify(number)}`);
  const labels = await issueLabels(api, repo, number);
  const held = labels.map(parseClaimLabel).filter(Boolean);
  if (!held.length) return { held_by: null };
  const fleet = held[0];
  const at = await labeledAt(api, repo, number, claimLabel(fleet));
  return { held_by: fleet, since: at };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: claim.mjs acquire <owner/repo#n> [--takeover] [--fleet-id ID]
       claim.mjs release <owner/repo#n> [--fleet-id ID]
       claim.mjs status  <owner/repo#n>
No FLEET_ID (env or --fleet-id): acquire/release are no-ops, exit 0 (single-fleet mode).`;

export async function main(argv, { api = ghApiClient(), env = process.env, cwd = process.cwd(), out = process.stdout, err = process.stderr } = {}) {
  const say = (s) => out.write(`${s}\n`);
  const warn = (s) => err.write(`claim: ${s}\n`);
  const args = [];
  let takeover = false;
  let fleetIdArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--takeover') takeover = true;
    else if (argv[i] === '--fleet-id') fleetIdArg = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') { say(USAGE); return EXIT.OK; }
    else args.push(argv[i]);
  }
  const [cmd, ref] = args;
  if (!cmd || !ref) { warn(USAGE); return EXIT.ERROR; }

  let fleetId;
  try {
    fleetId = checkFleetId(fleetIdArg ?? env.FLEET_ID);
  } catch (e) {
    warn(e.message);
    return EXIT.ERROR;
  }

  let repo, number;
  try {
    ({ repo, number } = parseRef(ref));
  } catch (e) {
    warn(e.message);
    return EXIT.ERROR;
  }

  try {
    switch (cmd) {
      case 'acquire': {
        if (!fleetId) { say(`single-fleet mode: nothing to claim for ${repo}#${number}`); return EXIT.OK; }
        const res = await acquireClaim(api, { repo, number, fleetId, takeover, env, cwd });
        say(JSON.stringify(res));
        return EXIT.OK;
      }
      case 'release': {
        if (!fleetId) { say(`single-fleet mode: nothing to release for ${repo}#${number}`); return EXIT.OK; }
        const res = await releaseClaim(api, { repo, number, fleetId });
        say(JSON.stringify(res));
        return EXIT.OK;
      }
      case 'status': {
        const res = await claimStatus(api, { repo, number });
        say(JSON.stringify(res));
        return EXIT.OK;
      }
      default:
        warn(`unknown command ${JSON.stringify(cmd)}\n${USAGE}`);
        return EXIT.ERROR;
    }
  } catch (e) {
    if (e instanceof ClaimError) { warn(e.message); return e.exit; }
    warn(e.message ?? String(e));
    return EXIT.ERROR;
  }
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`claim: ${e?.stack ?? e}\n`); process.exitCode = EXIT.ERROR; },
  );
}
