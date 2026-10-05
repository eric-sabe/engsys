#!/usr/bin/env node
// gate-check.mjs — human approval happens in GitHub: post gate requests, verify approvals.
//
// Zero-dependency ESM, Node >= 20. The only external process is `gh` (injectable for tests).
// Design: docs/multi-fleet.md § 6 "Human approval happens in GitHub" and docs/gate-check.md.
//
// Public API (pure; every network-touching function takes an `api` object, see `ghApiClient`):
//   GATE_ID_RE, KIND_RE, TARGET_RE, OPERATORS_TEAM_RE, LOGIN_RE, OPERATOR_ENTRY_RE   input formats
//   operatorSource(opts)                    -> { type: team|list, ... } | null (team wins; null fails closed)
//   parseIncluded(raw), nextLink(link)      -> gh api -i parsing; Link rel="next" as an API path
//   EXIT                                    { APPROVED: 0, ERROR: 1, WAITING: 3, DENIED: 4 }
//   parseGateRequest(body)                  -> { id, kind, target } | null (marker in leading position)
//   parsePrTarget(target)                   -> { repo, number, sha } | null (`owner/repo#N@<40-hex>`)
//   parseCommand(body)                      -> { verb: 'approve'|'deny', id, reason } | null
//   renderGateRequest(opts)                 -> the request comment body
//   newGateId(kind, now?)                   -> a fresh `<kind>-<yyyymmddhhmmss>-<4 hex>` id
//   evaluateGate(facts, opts)               -> verdict; pure, the whole rule set lives here
//   collectFacts(api, opts)                 -> facts; reads GitHub through `api`
//   checkGate(api, opts)                    -> verdict (collectFacts + evaluateGate)
//   postGateRequest(api, opts)              -> { id, url, comment_id, author }
//
// CLI:
//   node gate-check.mjs check   --repo o/r (--pr N | --issue N) --gate ID
//                               (--operators-team org/slug | --operators login:id,login:id)
//                               --requester LOGIN --target T --kind K
//   node gate-check.mjs request --repo o/r (--pr N | --issue N) --kind K --target T --what TEXT
//                               [--gate ID] [--operators-team org/slug | --operators login:id,...] [--dry-run]
// `check` prints one JSON verdict on stdout. Exit: 0 approved, 3 waiting, 4 denied, 1 error (bad
// input, missing config, unreadable API, stale or ambiguous gate). Anything unexpected fails closed.
//
// Trust model. Every comment and review body is attacker-influenceable text. It is matched against
// two strict, anchored grammars (the request marker and `/approve|/deny <id>`) and otherwise never
// interpreted, executed, or echoed, with one exception: a deny reason, which is reported defanged
// and inside the untrusted-data envelope (see untrusted.mjs). Identity comes only from API fields
// (`user.login`, `user.id`, `user.type`) plus a live read of the operator source, never from text.
// The operator source is `operators_team` when set (live team membership, state active), else the
// `operators` allowlist of `login:id` pins (matched on the numeric account id, and a live
// GET /user/{id} says type User). Neither set: fail closed.
//
// Self-approval. The identity running the check (GET /user) and the gate request's author can never
// approve, deny, or clear an objection, even when they are operators: an agent whose `gh` runs as an
// operator's own login must not be able to open its own gate. An App installation token has no user
// (GET /user answers 403 "Resource not accessible by integration") and is recorded as `caller: app`.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wrapUntrusted } from './untrusted.mjs';
import { formatFromEnv, isConfigured } from './operator-time.mjs';

export const EXIT = Object.freeze({ APPROVED: 0, ERROR: 1, WAITING: 3, DENIED: 4 });

/** Gate ids: lowercase slug, starts and ends alphanumeric, at most 80 characters. */
export const GATE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
/** Gate kinds: lowercase slug (`merge`, `migration`, `risk-accepted`, `deploy`, `dependency`, ...). */
export const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** Targets: a conservative charset with no quote, angle bracket, whitespace or comment terminator. */
export const TARGET_RE = /^[A-Za-z0-9._/#@:+=-]{1,200}$/;
/** `org/team-slug`. */
export const OPERATORS_TEAM_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** A GitHub user login (no `[bot]` suffix: bots are never operators). */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** An allowlist entry: `login:numeric-account-id` (the id survives renames; the login is a label). */
export const OPERATOR_ENTRY_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})):([1-9][0-9]{0,15})$/;
/** Logins that are never an operator, whatever the API says (`ghost` is the deleted-user placeholder). */
const DENIED_LOGINS = new Set(['ghost']);
const NODE_ID_RE = /^[A-Za-z0-9_=-]{1,100}$/;

/**
 * Which operator source applies: the team when `operatorsTeam` is set (it wins), else the
 * `operators` allowlist (an array or a comma-separated string of `login:id` entries), else null
 * (fail closed). Throws on a malformed team or entry so a typo never silently widens or empties it.
 */
export function operatorSource({ operatorsTeam, operators } = {}) {
  if (operatorsTeam) {
    if (!OPERATORS_TEAM_RE.test(operatorsTeam)) throw new TypeError(`operators_team must be org/team-slug, got ${JSON.stringify(operatorsTeam)}`);
    return { type: 'team', team: operatorsTeam, label: `team ${operatorsTeam}` };
  }
  const list = Array.isArray(operators) ? operators : typeof operators === 'string' ? operators.split(',') : [];
  const raw = list.map((l) => String(l).trim()).filter(Boolean);
  if (raw.length === 0) return null;
  const entries = raw.map((e) => {
    const m = OPERATOR_ENTRY_RE.exec(e);
    if (!m) throw new TypeError(`operators entry must be login:numeric-id (e.g. alice:1234567), got ${JSON.stringify(e)}`);
    if (DENIED_LOGINS.has(m[1].toLowerCase())) throw new TypeError(`operators entry ${JSON.stringify(e)} names a login that can never be an operator`);
    return { login: m[1].toLowerCase(), id: Number(m[2]) };
  });
  return { type: 'list', entries, ids: entries.map((e) => e.id), label: 'operators allowlist' };
}

/** Kinds approved by a PR review (anything that merges). Every other kind needs `/approve <id>`. */
export const REVIEW_KINDS = new Set(['merge']);

/** The request marker, anchored at the very start of the comment body. */
const REQUEST_MARKER_RE = /^<!-- gate-request id="([^"\n]*)" kind="([^"\n]*)" target="([^"\n]*)" -->/;
const PR_TARGET_RE = /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})@([0-9a-f]{40})$/;
// `/approve <id>`: the whole (trimmed) body, one line, exact verb, lowercase.
const APPROVE_RE = /^\/approve[ \t]+(\S+)$/;
// `/deny <id> [reason]`: verb + id on the first line, an optional reason after whitespace.
const DENY_RE = /^\/deny[ \t]+([^\s]+)(?:\s+([\s\S]*))?$/;
const MAX_PAGES = 50; // 5000 items per list; beyond that we fail closed rather than read partially
const REQUESTER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;

// ---------------------------------------------------------------------------------------------
// parsing (pure)
// ---------------------------------------------------------------------------------------------

/** Parse a gate-request marker at the START of `body`. Returns null unless every field is valid. */
export function parseGateRequest(body) {
  if (typeof body !== 'string') return null;
  const m = REQUEST_MARKER_RE.exec(body);
  if (!m) return null;
  const [, id, kind, target] = m;
  if (!GATE_ID_RE.test(id) || !KIND_RE.test(kind) || !TARGET_RE.test(target)) return null;
  return { id, kind, target };
}

/** Parse a SHA-bound PR target `owner/repo#N@<full 40-hex sha>`; null for any other shape. */
export function parsePrTarget(target) {
  const m = typeof target === 'string' ? PR_TARGET_RE.exec(target) : null;
  return m ? { repo: m[1], number: Number(m[2]), sha: m[3] } : null;
}

/**
 * Parse a human command. The trimmed body must be exactly `/approve <id>` (nothing else, one line)
 * or start `/deny <id>` followed by an optional reason. Quoted replies, extra prose, other casing
 * and look-alike characters all fail the grammar. The id is returned raw; callers compare it to the
 * gate id with strict equality.
 */
export function parseCommand(body) {
  if (typeof body !== 'string') return null;
  const text = body.trim();
  let m = APPROVE_RE.exec(text);
  if (m) return { verb: 'approve', id: m[1], reason: '' };
  m = DENY_RE.exec(text);
  if (m) return { verb: 'deny', id: m[1], reason: m[2] ?? '' };
  return null;
}

/** A fresh, unique-enough gate id: `<kind>-<yyyymmddhhmmss>-<4 hex>` (UTC). */
export function newGateId(kind, now = new Date()) {
  if (!KIND_RE.test(kind)) throw new TypeError(`gate-check: invalid kind ${JSON.stringify(kind)}`);
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${kind}-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Collapse agent-supplied prose to one safe line: no comment markers, no control characters. */
function oneLine(s, max) {
  return String(s ?? '')
    .replace(/<!--|-->/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Render the request comment. The marker is always line 1 (check reads it only in leading
 * position). `what` is agent prose and is flattened to one line with comment markers removed.
 */
export function renderGateRequest({ id, kind, target, what, operatorsTeam, operators, thread = 'pr', requestedAt = null }) {
  if (!GATE_ID_RE.test(id ?? '')) throw new TypeError(`gate-check: invalid gate id ${JSON.stringify(id)}`);
  if (!KIND_RE.test(kind ?? '')) throw new TypeError(`gate-check: invalid kind ${JSON.stringify(kind)}`);
  if (!TARGET_RE.test(target ?? '')) throw new TypeError(`gate-check: invalid target ${JSON.stringify(target)}`);
  const pr = parsePrTarget(target);
  if ((REVIEW_KINDS.has(kind) || thread === 'pr') && !pr) {
    throw new TypeError('gate-check: a gate on a pull request (and every merge gate) needs a target of the form owner/repo#N@<40-hex head sha>');
  }
  const src = operatorSource({ operatorsTeam, operators });
  const who = src?.type === 'team' ? `a member of @${src.team}` : src?.type === 'list' ? `an operator (${src.entries.map((e) => `@${e.login}`).join(', ')})` : 'an operator';
  const lines = [
    `<!-- gate-request id="${id}" kind="${kind}" target="${target}" -->`,
    `### Gate request \`${id}\` (${kind})`,
    '',
    `**What:** ${oneLine(what, 300) || '(not stated)'}`,
    `**Target:** \`${target}\``,
    ...(requestedAt ? [`**Requested:** ${oneLine(requestedAt, 60)}`] : []),
    '',
  ];
  if (REVIEW_KINDS.has(kind)) {
    lines.push(
      `**To approve:** ${who} submits a PR review with **Approve** on commit \`${pr.sha.slice(0, 12)}\` ` +
        '(Files changed, then Review changes, then Approve). Pushing new commits invalidates the approval; ' +
        'a review submitted before this request does not count.',
    );
  } else {
    lines.push(
      `**To approve:** ${who} comments exactly \`/approve ${id}\` on this ${thread === 'pr' ? 'pull request' : 'issue'}.`,
      `**To refuse:** comment \`/deny ${id} <reason>\`.`,
      '',
      'Edited comments do not count; post a new one. Chat or Slack replies do not open this gate.',
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// the rule set (pure)
// ---------------------------------------------------------------------------------------------

const ts = (s) => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : NaN;
};
const isHumanUser = (u) =>
  !!u && u.type === 'User' && typeof u.login === 'string' && u.login.length > 0 && !/\[bot\]$/i.test(u.login) &&
  !DENIED_LOGINS.has(u.login.toLowerCase());
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = (gate, message, extra = {}) => ({ status: 'error', exit: EXIT.ERROR, gate, message, ...extra });

/** Defang + flatten + cap a deny reason, then wrap it as untrusted data. Never interpreted. */
function untrustedReason(reason) {
  const flat = String(reason ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return wrapUntrusted(flat || '(no reason given)', { header: 'deny reason (operator comment text)' });
}

/**
 * Decide a gate from already-collected facts. Pure: no I/O, so every rule is unit-testable.
 *
 * facts = {
 *   repo, number, thread: 'pr'|'issue',
 *   comments: [issue comment objects, REST shape],
 *   pr: { state, head_sha, merged } | null,          // PR threads only
 *   reviews: [review objects, REST shape] | null,    // PR threads only
 *   reviewDecision: 'APPROVED'|'CHANGES_REQUESTED'|'REVIEW_REQUIRED'|null,  // PR threads only
 *   dismissals: Map<reviewId, { actor, at, state }>, // review_dismissed timeline events, PR threads only
 *   pushFloor: { at: ISO, source } | null,           // latest push signal, PR threads only
 *   edited: Map<commentId, boolean>,                 // GraphQL lastEditedAt != null, for the request + approvals
 *   members: Map<login, 'active'|'pending'|'none'>,  // live reads of the operator source
 *   caller: { type: 'app' } | { type: 'user', login, id, user },  // the identity running the check
 * }
 * opts = { gate, operatorsTeam? | operators?, requester, target, kind }  (all three pins required)
 */
export function evaluateGate(facts, opts) {
  const gate = opts.gate;
  let source;
  try { source = operatorSource(opts); } catch (e) { return fail(gate, e.message); }
  if (!source) return fail(gate, 'neither operators_team nor operators is configured; refusing to open any gate (fail closed)');
  if (!GATE_ID_RE.test(gate ?? '')) return fail(gate, `invalid gate id ${JSON.stringify(gate)}`);
  if (!opts.requester || !opts.target || !opts.kind) {
    return fail(gate, '--requester, --target and --kind are required: pin the request author and the exact act you are about to perform');
  }
  if (!facts.caller || (facts.caller.type !== 'app' && facts.caller.type !== 'user')) return fail(gate, 'the checking identity was not read');

  // 1. Find the gate request: exactly one, unedited, from the requester when one is pinned.
  const requests = [];
  for (const c of facts.comments) {
    const req = parseGateRequest(c.body);
    if (!req || req.id !== gate) continue;
    if (c.user?.login !== opts.requester) continue;
    requests.push({ comment: c, ...req });
  }
  if (requests.length === 0) return fail(gate, `no gate request with id "${gate}" on ${facts.repo}#${facts.number}`);
  if (requests.length > 1) {
    return fail(gate, `ambiguous: ${requests.length} gate requests carry id "${gate}"; post a new request with a fresh id (pin --requester)`);
  }
  const request = requests[0];
  const rc = request.comment;
  const requestAt = ts(rc.created_at);
  if (!Number.isFinite(requestAt)) return fail(gate, 'gate request has no readable created_at');
  if (rc.updated_at !== rc.created_at || facts.edited?.get(rc.id) !== false) {
    return fail(gate, facts.edited?.has(rc.id) || rc.updated_at !== rc.created_at
      ? 'gate request was edited after posting; post a new request'
      : 'could not verify that the gate request is unedited');
  }
  if (opts.target !== request.target) {
    return fail(gate, `gate request target "${request.target}" does not match the expected target "${opts.target}"`);
  }
  if (opts.kind !== request.kind) {
    return fail(gate, `gate request kind "${request.kind}" does not match the expected kind "${opts.kind}"`);
  }

  const base = {
    gate,
    kind: request.kind,
    target: request.target,
    request: { url: rc.html_url, at: rc.created_at, author: rc.user?.login ?? null },
  };
  const reviewKind = REVIEW_KINDS.has(request.kind);
  const prTarget = parsePrTarget(request.target);

  // 2. SHA binding and the time floor ("newer than the request and the PR's latest push").
  let floor = requestAt;
  let floorSource = 'gate request';
  if (facts.thread === 'pr') {
    if (!facts.pr || !/^[0-9a-f]{40}$/.test(facts.pr.head_sha ?? '')) return fail(gate, 'could not read the PR head', base);
    if (!prTarget) return fail(gate, 'a gate on a pull request must be SHA-bound (target owner/repo#N@<40-hex head sha)', base);
    if (prTarget.repo.toLowerCase() !== facts.repo.toLowerCase() || prTarget.number !== facts.number) {
      return fail(gate, `gate target ${request.target} names a different PR than ${facts.repo}#${facts.number}`, base);
    }
    if (prTarget.sha !== facts.pr.head_sha) {
      return {
        ...fail(gate, `stale: the PR head moved to ${facts.pr.head_sha.slice(0, 12)} since the request (target ${prTarget.sha.slice(0, 12)}); post a new gate request`, base),
        stale: true,
      };
    }
    const push = facts.pushFloor ? ts(facts.pushFloor.at) : NaN;
    if (facts.pushFloor && !Number.isFinite(push)) return fail(gate, 'could not read the latest push time', base);
    if (Number.isFinite(push) && push > floor) {
      floor = push;
      floorSource = facts.pushFloor.source;
    }
  } else if (prTarget) {
    return fail(gate, 'a SHA-bound PR target must be checked with --pr, not --issue', base);
  }
  if (reviewKind) {
    if (facts.thread !== 'pr' || !prTarget) return fail(gate, `a ${request.kind} gate must be SHA-bound to a PR (owner/repo#N@sha)`, base);
    if (facts.pr.state !== 'open') return fail(gate, `the PR is ${facts.pr.merged ? 'merged' : facts.pr.state}; a ${request.kind} gate needs an open PR`, base);
  }
  base.floor = { at: new Date(floor).toISOString(), source: floorSource };
  base.operator_source = source.label;
  base.caller = facts.caller.type === 'app' ? 'app' : facts.caller.login;

  /** Is `user` an operator per the configured source (identity only; no self/author exclusion)? */
  const isOperator = (user) => {
    if (!isHumanUser(user)) return 'actor is not a human User account';
    if (source.type === 'list' && !source.ids.includes(user.id)) return 'not on the operators allowlist (matched by account id)';
    const state = facts.members.get(user.login);
    if (state === undefined) return source.type === 'team' ? 'team membership was not read' : 'user account was not verified';
    if (state === 'active') return null;
    if (source.type === 'list') return 'allowlisted login is not a live User account';
    return state === 'pending' ? 'team membership is pending, not active' : `not a member of ${source.team}`;
  };
  /** May `user` act on this gate: an operator who is neither the checking identity nor the requester. */
  const qualifies = (user) => {
    if (facts.caller.type === 'user' && user && (sameLogin(user.login, facts.caller.login) || (user.id !== undefined && user.id === facts.caller.id))) {
      return 'actor is the identity running gate-check (self-approval is never accepted)';
    }
    if (user && sameLogin(user.login, rc.user?.login)) return 'actor is the author of the gate request';
    return isOperator(user);
  };
  if (facts.caller.type === 'user' && isOperator(facts.caller.user) === null) base.self_is_operator = true;
  const ignored = [];
  const ignore = (actor, via, url, reason) => ignored.push({ actor: actor ?? null, via, url: url ?? null, reason });

  // 3. Deny: a qualifying `/deny <gate>` newer than the request closes the gate, whatever else
  //    happened. Deny is the safe direction, so an edited deny still counts.
  for (const c of facts.comments) {
    if (c === rc) continue;
    const cmd = parseCommand(c.body);
    if (!cmd || cmd.verb !== 'deny' || cmd.id !== gate) continue;
    const at = ts(c.created_at);
    if (!(at > requestAt)) { ignore(c.user?.login, 'comment', c.html_url, 'deny is not newer than the gate request'); continue; }
    const why = qualifies(c.user);
    if (why) { ignore(c.user?.login, 'comment', c.html_url, `deny ignored: ${why}`); continue; }
    return {
      ...base,
      status: 'denied',
      exit: EXIT.DENIED,
      denial: { actor: c.user.login, at: c.created_at, url: c.html_url, source: source.label, reason: untrustedReason(cmd.reason) },
      ignored,
    };
  }

  // 4a. Review kinds: the qualifying reviewer's LATEST decisive review is APPROVED, on the target
  //     SHA, newer than the floor; and GitHub's own state agrees.
  if (reviewKind) {
    const latest = new Map(); // login -> latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED)
    const ordered = [...(facts.reviews ?? [])].sort((a, b) => ts(a.submitted_at) - ts(b.submitted_at) || a.id - b.id);
    for (const r of ordered) {
      if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
      if (r.user?.login) latest.set(r.user.login, r);
    }
    // A dismissed change request still blocks unless a qualifying operator (not the checking identity,
    // not the requester) dismissed it. A DISMISSED review whose dismissal event is missing blocks too:
    // we cannot tell a dismissed objection from a dismissed approval.
    const objecting = (r) => {
      if (r.state === 'CHANGES_REQUESTED') return true;
      if (r.state !== 'DISMISSED') return false;
      const d = facts.dismissals?.get(r.id);
      if (!d) { ignore(r.user?.login, 'review', r.html_url, 'dismissed review with no readable dismissal event: still blocking'); return true; }
      const state = String(d.state ?? '').toLowerCase();
      if (state === 'approved' || state === 'commented') return false; // never an objection
      if (state !== 'changes_requested') {
        ignore(r.user?.login, 'review', r.html_url, `dismissed review in unknown state ${JSON.stringify(String(d.state ?? '')).slice(0, 40)}: still blocking`);
        return true;
      }
      const why = qualifies(d.actor);
      if (why) { ignore(d.actor?.login, 'dismissal', r.html_url, `change request dismissal does not count: ${why}`); return true; }
      return false;
    };
    const changesRequested = [...latest.values()].filter(objecting).map((r) => r.user.login);
    let approval = null;
    for (const r of latest.values()) {
      if (r.state !== 'APPROVED') continue;
      const url = r.html_url;
      if (r.commit_id !== prTarget.sha) { ignore(r.user.login, 'review', url, `approval is on ${String(r.commit_id).slice(0, 12)}, not the gate's head`); continue; }
      const at = ts(r.submitted_at);
      if (!(at > floor)) { ignore(r.user.login, 'review', url, `approval is not newer than the ${floorSource}`); continue; }
      const why = qualifies(r.user);
      if (why) { ignore(r.user.login, 'review', url, why); continue; }
      if (!approval || at > ts(approval.submitted_at)) approval = r;
    }
    const waiting = (reason) => ({ ...base, status: 'waiting', exit: EXIT.WAITING, reason, ignored });
    if (!approval) return waiting(`no qualifying review approval on ${prTarget.sha.slice(0, 12)} newer than the ${floorSource}`);
    if (changesRequested.length) return waiting(`outstanding change requests from ${changesRequested.join(', ')}`);
    // APPROVED: GitHub agrees. Empty/null: the base branch requires no review for this PR, so the
    // qualifying operator approval above (with no change requests) is the whole decision.
    // REVIEW_REQUIRED / CHANGES_REQUESTED (or anything unknown): GitHub disagrees, keep waiting.
    const rd = facts.reviewDecision ?? null;
    if (rd !== 'APPROVED' && rd !== null && rd !== '') return waiting(`GitHub reviewDecision is ${rd}, not APPROVED`);
    return {
      ...base,
      status: 'approved',
      exit: EXIT.APPROVED,
      approval: {
        actor: approval.user.login, at: approval.submitted_at, url: approval.html_url, via: 'review', commit: approval.commit_id,
        source: source.label, review_decision: rd || 'none (no review required)',
      },
      ignored,
    };
  }

  // 4b. Comment kinds: an unedited `/approve <gate>` from a qualifying human, newer than the floor.
  let approval = null;
  for (const c of facts.comments) {
    if (c === rc) continue;
    const cmd = parseCommand(c.body);
    if (!cmd || cmd.verb !== 'approve') continue;
    if (cmd.id !== gate) { ignore(c.user?.login, 'comment', c.html_url, 'names a different gate id'); continue; }
    if (c.updated_at !== c.created_at || facts.edited?.get(c.id) === true) { ignore(c.user?.login, 'comment', c.html_url, 'comment was edited after posting'); continue; }
    if (facts.edited?.get(c.id) !== false) { ignore(c.user?.login, 'comment', c.html_url, 'could not verify the comment is unedited'); continue; }
    const at = ts(c.created_at);
    if (!(at > floor)) { ignore(c.user?.login, 'comment', c.html_url, `approval is not newer than the ${floorSource}`); continue; }
    const why = qualifies(c.user);
    if (why) { ignore(c.user?.login, 'comment', c.html_url, why); continue; }
    if (!approval) approval = c; // comments are oldest-first; the first qualifying one opens the gate
  }
  if (!approval) {
    return { ...base, status: 'waiting', exit: EXIT.WAITING, reason: `no qualifying "/approve ${gate}" comment newer than the ${floorSource}`, ignored };
  }
  return {
    ...base,
    status: 'approved',
    exit: EXIT.APPROVED,
    approval: { actor: approval.user.login, at: approval.created_at, url: approval.html_url, via: 'comment', source: source.label },
    ignored,
  };
}

// ---------------------------------------------------------------------------------------------
// GitHub access
// ---------------------------------------------------------------------------------------------

/**
 * The thin API layer. `request(method, path, body?)` resolves `{ status, json }` and never throws
 * on an HTTP status (only on a transport failure); `graphql(query, vars)` resolves the `data`
 * object or throws. The default implementation shells out to `gh api -i`, which prints the status
 * line even on 4xx, so a 404 is a value, not an exception.
 */
export function ghApiClient({ gh = defaultGh } = {}) {
  return {
    async request(method, path, body) {
      const args = ['api', '-i', '-X', method, path];
      let input;
      if (body !== undefined) {
        args.push('--input', '-');
        input = JSON.stringify(body);
      }
      const raw = await gh(args, input);
      return parseIncluded(raw);
    },
    async graphql(query, vars) {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
      const raw = await gh(args);
      const parsed = JSON.parse(raw);
      if (parsed.errors?.length) throw new Error(`graphql: ${parsed.errors.map((e) => e.message).join('; ')}`);
      return parsed.data;
    },
  };
}

/** Run `gh`; resolve stdout even when gh exits non-zero (`-i` already printed the HTTP status). */
export function defaultGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(`gh ${args.slice(0, 4).join(' ')} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Parse `gh api -i` output: status line, headers, blank line, JSON body. */
export function parseIncluded(raw) {
  const text = String(raw ?? '');
  const m = /^HTTP\/[0-9.]+ (\d{3})/.exec(text);
  if (!m) throw new Error('gh api returned no HTTP status line');
  const sep = text.search(/\r?\n\r?\n/);
  const bodyText = sep === -1 ? '' : text.slice(sep).trim();
  let json = null;
  if (bodyText) {
    try { json = JSON.parse(bodyText); } catch { throw new Error(`gh api returned a non-JSON body (HTTP ${m[1]})`); }
  }
  const headers = {};
  const head = sep === -1 ? text : text.slice(0, sep);
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), json, headers };
}

/** The `rel="next"` URL of a Link header, as an API path (origin stripped), or null. */
export function nextLink(link) {
  if (typeof link !== 'string') return null;
  for (const part of link.split(',')) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (!m) {
      // A next relation we cannot parse must never read as "last page": that would silently truncate.
      if (/rel\s*=\s*"?[^",;]*\bnext\b/i.test(part)) throw new Error('unparseable rel="next" in Link header');
      continue;
    }
    let u;
    try { u = new URL(m[1]); } catch { throw new Error('unparseable Link header'); }
    if (u.protocol !== 'https:') throw new Error('Link header next URL is not https');
    return `${u.pathname}${u.search}`;
  }
  return null;
}

async function getOk(api, path, what) {
  const { status, json } = await api.request('GET', path);
  if (status !== 200) throw new Error(`HTTP ${status} while ${what}${json?.message ? `: ${json.message}` : ''}`);
  return json;
}

/**
 * Read a whole list by following `Link: rel="next"`. GitHub's next links for these endpoints are
 * still page offsets, so a deletion mid-read can shift an item past a page boundary; callers that
 * need completeness cross-check the count (see `listComments`).
 */
async function listAll(api, path, what) {
  const out = [];
  let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, json, headers } = await api.request('GET', next);
    if (status !== 200) throw new Error(`HTTP ${status} while ${what}${json?.message ? `: ${json.message}` : ''}`);
    if (!Array.isArray(json)) throw new Error(`expected a list while ${what}`);
    out.push(...json);
    next = nextLink(headers?.link);
    if (!next) return out;
  }
  throw new Error(`more than ${MAX_PAGES} pages while ${what}; refusing to decide on a partial read`);
}

/**
 * All issue comments, with a deletion-race check: the collected count must equal the issue's own
 * `comments` total from a fresh read taken after the listing. On mismatch, re-list once; a second
 * mismatch fails closed rather than decide on a list that may have skipped a comment.
 */
async function listComments(api, repo, number) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const comments = await listAll(api, `/repos/${repo}/issues/${number}/comments`, 'reading comments');
    const issue = await getOk(api, `/repos/${repo}/issues/${number}`, 'reading the comment total');
    if (Number.isInteger(issue?.comments) && issue.comments === comments.length) return comments;
  }
  throw new Error('the comment list and the comment total disagree twice (comments changed during the read); refusing to decide');
}

/**
 * The PR's latest push signal: the later of (a) the newest `head_ref_force_pushed` timeline event
 * and (b) the head commit's committer date. A regular push changes the head SHA, which the
 * SHA binding already catches; (a) catches a force-push back to an earlier SHA; (b) is a cheap
 * extra floor (it is pusher-controlled, so it can only ever raise the floor, never open a gate).
 */
async function latestPush(api, repo, timeline, headSha) {
  let best = null;
  for (const e of timeline) {
    if (e.event !== 'head_ref_force_pushed') continue;
    const t = ts(e.created_at);
    if (Number.isFinite(t) && (!best || t > ts(best.at))) best = { at: e.created_at, source: 'latest force-push' };
  }
  const commit = await getOk(api, `/repos/${repo}/commits/${headSha}`, 'reading the head commit');
  const committed = commit?.commit?.committer?.date;
  if (typeof committed === 'string' && Number.isFinite(ts(committed)) && (!best || ts(committed) > ts(best.at))) {
    best = { at: committed, source: 'head commit date' };
  }
  return best;
}

/** Allowlisted account id is a live account of type User: 'active' | 'none'. 404 → none; other non-200 throws. */
async function liveUserById(api, id) {
  const { status, json } = await api.request('GET', `/user/${id}`);
  if (status === 404) return 'none';
  if (status !== 200) throw new Error(`HTTP ${status} reading user id ${id}${json?.message ? `: ${json.message}` : ''}`);
  return json?.type === 'User' && json.id === id && !DENIED_LOGINS.has(String(json.login).toLowerCase()) ? 'active' : 'none';
}

/**
 * Who is running the check. GET /user answers 200 for a user token (a laptop or personal `gh`) and
 * 403/401 "Resource not accessible by integration" for a GitHub App installation token, which has
 * no user and can never be an operator. Anything else throws (exit 1).
 */
async function readCaller(api) {
  const { status, json } = await api.request('GET', '/user');
  if (status === 200 && typeof json?.login === 'string') return { type: 'user', login: json.login, id: json.id, user: json };
  if ((status === 403 || status === 401) && /resource not accessible by integration/i.test(json?.message ?? '')) return { type: 'app' };
  throw new Error(`cannot identify the checking identity (GET /user: HTTP ${status}${json?.message ? `, ${json.message}` : ''})`);
}

/** lastEditedAt for issue comments by node id: Map<commentId, boolean>. A missing node throws. */
async function readEdits(api, comments) {
  const edited = new Map();
  for (let i = 0; i < comments.length; i += 50) {
    const chunk = comments.slice(i, i + 50);
    for (const c of chunk) if (!NODE_ID_RE.test(c.node_id ?? '')) throw new Error(`comment ${c.id} has no usable node_id`);
    // Node ids are validated above, so inlining them as string literals is injection-safe.
    const query = `query{${chunk.map((c, k) => `c${k}:node(id:"${c.node_id}"){... on IssueComment{lastEditedAt}}`).join(' ')}}`;
    const data = await api.graphql(query, {});
    chunk.forEach((c, k) => {
      const node = data?.[`c${k}`];
      if (!node || !('lastEditedAt' in node)) throw new Error(`could not read the edit history of comment ${c.id}`);
      edited.set(c.id, node.lastEditedAt !== null);
    });
  }
  return edited;
}

/** Live membership: 'active' | 'pending' | 'none'. 404 means not a member; anything else non-200 throws. */
async function membership(api, operatorsTeam, login) {
  const [org, slug] = operatorsTeam.split('/');
  const { status, json } = await api.request('GET', `/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(login)}`);
  if (status === 404) return 'none';
  if (status !== 200) throw new Error(`HTTP ${status} reading ${operatorsTeam} membership for ${login}${json?.message ? `: ${json.message}` : ''}`);
  return json?.state === 'active' ? 'active' : json?.state === 'pending' ? 'pending' : 'none';
}

/** Read everything `evaluateGate` needs. Throws on any API problem (the CLI turns that into exit 1). */
export async function collectFacts(api, { repo, number, thread, operatorsTeam, operators, gate }) {
  const source = operatorSource({ operatorsTeam, operators });
  if (!source) throw new Error('neither operators_team nor operators is configured; gate-check fails closed');
  if (source.type === 'team') {
    const [org, slug] = source.team.split('/');
    const team = await api.request('GET', `/orgs/${org}/teams/${slug}`);
    if (team.status !== 200) {
      throw new Error(
        `cannot read team ${source.team} (HTTP ${team.status}); check operators_team and that the token can read org members (Members: read)`,
      );
    }
  }
  const caller = await readCaller(api);
  const comments = await listComments(api, repo, number);
  const facts = {
    repo, number, thread, comments, pr: null, reviews: null, reviewDecision: null, dismissals: new Map(), pushFloor: null,
    edited: new Map(), members: new Map(), caller,
  };
  if (thread === 'pr') {
    const pr = await getOk(api, `/repos/${repo}/pulls/${number}`, 'reading the PR');
    facts.pr = { state: pr.state, merged: !!pr.merged, head_sha: pr.head?.sha };
    facts.reviews = await listAll(api, `/repos/${repo}/pulls/${number}/reviews`, 'reading reviews');
    const [owner, name] = repo.split('/');
    const data = await api.graphql(
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}',
      { owner, name, number },
    );
    const prNode = data?.repository?.pullRequest;
    // Only a PRESENT pullRequest whose field is null means "no review required"; a missing object is
    // a read failure, never a reason to skip GitHub's review requirement.
    if (!prNode || typeof prNode !== 'object' || !('reviewDecision' in prNode)) throw new Error('GraphQL returned no pullRequest object; cannot read reviewDecision');
    facts.reviewDecision = prNode.reviewDecision;
    const timeline = await listAll(api, `/repos/${repo}/issues/${number}/timeline`, 'reading the PR timeline');
    for (const e of timeline) {
      if (e.event !== 'review_dismissed' || !e.dismissed_review) continue;
      facts.dismissals.set(e.dismissed_review.review_id, { actor: e.actor ?? null, at: e.created_at, state: e.dismissed_review.state });
    }
    facts.pushFloor = await latestPush(api, repo, timeline, facts.pr.head_sha);
  }
  // Edit history (GraphQL lastEditedAt) for the gate request(s) and the approvals naming this gate.
  const toCheck = comments.filter((c) => parseGateRequest(c.body)?.id === gate || (parseCommand(c.body)?.verb === 'approve' && parseCommand(c.body).id === gate));
  facts.edited = await readEdits(api, toCheck);
  // The operator source is read only for human candidates: a command naming this gate, an approving
  // review, a change-request dismisser, and the checking identity (for `self_is_operator`).
  const users = new Map();
  const add = (u) => { if (isHumanUser(u) && !users.has(u.login)) users.set(u.login, u); };
  for (const c of comments) if (parseCommand(c.body)?.id === gate) add(c.user);
  for (const r of facts.reviews ?? []) if (r.state === 'APPROVED') add(r.user);
  for (const d of facts.dismissals.values()) add(d.actor);
  if (caller.type === 'user') add(caller.user);
  for (const [login, u] of users) {
    if (source.type === 'team') facts.members.set(login, await membership(api, source.team, login));
    else if (source.ids.includes(u.id)) facts.members.set(login, await liveUserById(api, u.id));
    else facts.members.set(login, 'none'); // not listed: no API call needed
  }
  return facts;
}

function validateCommon({ repo, pr, issue, operatorsTeam, operators }, needSource) {
  if (!REPO_RE.test(repo ?? '')) throw new TypeError(`--repo must be owner/name, got ${JSON.stringify(repo)}`);
  if ((pr === undefined) === (issue === undefined)) throw new TypeError('pass exactly one of --pr N or --issue N');
  const n = Number(pr ?? issue);
  if (!Number.isInteger(n) || n < 1 || String(pr ?? issue) !== String(n)) throw new TypeError(`--pr/--issue must be a positive integer`);
  const source = operatorSource({ operatorsTeam, operators }); // throws on a malformed team or login
  if (needSource && !source) {
    throw new TypeError('neither operators_team (--operators-team org/slug) nor operators (--operators login,login) is configured; gate-check fails closed');
  }
  return { number: n, thread: pr !== undefined ? 'pr' : 'issue' };
}

/** Collect + evaluate. Never throws: problems come back as an `error` verdict (exit 1). */
export async function checkGate(api, opts) {
  try {
    const { number, thread } = validateCommon(opts, true);
    if (!opts.requester || !opts.target || !opts.kind) throw new TypeError('--requester, --target and --kind are required for check');
    if (!REQUESTER_RE.test(opts.requester)) throw new TypeError('--requester must be a GitHub login');
    if (!TARGET_RE.test(opts.target)) throw new TypeError('--target has characters a gate target never contains');
    if (!KIND_RE.test(opts.kind)) throw new TypeError('--kind must be a lowercase slug');
    const facts = await collectFacts(api, { repo: opts.repo, number, thread, operatorsTeam: opts.operatorsTeam, operators: opts.operators, gate: opts.gate });
    return evaluateGate(facts, opts);
  } catch (err) {
    return fail(opts.gate ?? null, err?.message ?? String(err));
  }
}

/** The request time in the operator's zone and clock, or null when the fleet sets no time format. */
function operatorRequestedAt(env, now = new Date()) {
  return isConfigured(env) ? formatFromEnv(now, env, { now }) : null;
}

/** Post a gate request. Refuses an id already used on the thread. */
export async function postGateRequest(api, opts) {
  const { number, thread } = validateCommon(opts, false);
  const id = opts.gate ?? newGateId(opts.kind);
  const body = renderGateRequest({ id, kind: opts.kind, target: opts.target, what: opts.what, operatorsTeam: opts.operatorsTeam, operators: opts.operators, thread, requestedAt: operatorRequestedAt(opts.env ?? process.env) });
  const comments = await listAll(api, `/repos/${opts.repo}/issues/${number}/comments`, 'reading comments');
  if (comments.some((c) => parseGateRequest(c.body)?.id === id)) throw new Error(`a gate request with id "${id}" already exists on ${opts.repo}#${number}`);
  if (opts.dryRun) return { id, dry_run: true, body };
  const { status, json } = await api.request('POST', `/repos/${opts.repo}/issues/${number}/comments`, { body });
  if (status !== 201) throw new Error(`HTTP ${status} posting the gate request${json?.message ? `: ${json.message}` : ''}`);
  return { id, url: json.html_url, comment_id: json.id, author: json.user?.login ?? null };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  gate-check.mjs check   --repo o/r (--pr N | --issue N) --gate ID
                         (--operators-team org/slug | --operators login:id,login:id)
                         --requester LOGIN --target T --kind K
  gate-check.mjs request --repo o/r (--pr N | --issue N) --kind K --target T --what TEXT
                         [--gate ID] [--operators-team org/slug | --operators login:id,...] [--dry-run]
exit (check): 0 approved, 3 waiting, 4 denied, 1 error`;

export async function main(argv, { api = ghApiClient(), out = process.stdout, err = process.stderr } = {}) {
  const [cmd, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        repo: { type: 'string' }, pr: { type: 'string' }, issue: { type: 'string' }, gate: { type: 'string' },
        'operators-team': { type: 'string' }, operators: { type: 'string' }, requester: { type: 'string' }, target: { type: 'string' },
        kind: { type: 'string' }, what: { type: 'string' }, 'dry-run': { type: 'boolean' },
      },
    }));
  } catch (e) {
    err.write(`gate-check: ${e.message}\n${USAGE}\n`);
    return EXIT.ERROR;
  }
  const opts = {
    repo: values.repo, pr: values.pr, issue: values.issue, gate: values.gate,
    operatorsTeam: values['operators-team'], operators: values.operators, requester: values.requester, target: values.target,
    kind: values.kind, what: values.what, dryRun: !!values['dry-run'],
  };
  if (cmd === 'check') {
    const verdict = await checkGate(api, opts);
    out.write(JSON.stringify(verdict, null, 2) + '\n');
    if (verdict.status === 'error') err.write(`gate-check: ${verdict.message}\n`);
    return verdict.exit;
  }
  if (cmd === 'request') {
    try {
      if (!opts.kind || !opts.target) throw new TypeError('request needs --kind and --target');
      const res = await postGateRequest(api, opts);
      out.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    } catch (e) {
      err.write(`gate-check: ${e.message}\n`);
      return EXIT.ERROR;
    }
  }
  err.write(`${USAGE}\n`);
  return EXIT.ERROR;
}

const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`gate-check: ${e?.stack ?? e}\n`); process.exitCode = EXIT.ERROR; },
  );
}
