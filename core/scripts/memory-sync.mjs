#!/usr/bin/env node
// memory-sync.mjs — historical ingestion, author/editor eligibility filter, boundary-spoofing
// quarantine, anomaly flagging, incremental cursors + tombstones, and delta/publish/tail modes.
// Design: docs/memory-spec.md §7 (#131); who may write which ref: §9 (F5).
//
// Zero-dependency ESM, Node >= 20. External calls (`gh`, `git`, `refStore`) are injectable for
// deterministic unit tests.

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isMainEntry } from '../lib/is-main.mjs';
import { createMarkerRe, MARKER_RE, normalizeUntrusted } from '../lib/untrusted.mjs';
import {
  EVENTS_REF,
  createMemoryRefStore,
  mergeEvents,
  parseEventsJsonl,
  formatEventsJsonl,
  tailRef,
} from '../lib/memory/ref-store.mjs';
import { FLEET_ID_RE, readSigningKeyFile, signTip } from '../lib/memory/signing.mjs';
import { ensureIndex, resolveCacheDir, resolveReviewedSha } from '../lib/memory/index-db.mjs';
import { isEventTrusted as sharedIsEventTrusted } from '../lib/memory/trust.mjs';
import { loadConfig } from './memory-brief.mjs';
import { buildMarkerMatchers, isMarkerBody, parseFindingAcks } from './harvest-findings.mjs';
import { parseReviewComment } from './review-bakeoff.mjs';
import { exitAfterFlush } from '../lib/exit-after-flush.mjs';

const execFileP = promisify(execFile);

export const OVERLAP_MS = 48 * 60 * 60 * 1000; // 48-hour overlap window (§7.5)
export const INIT_CAPS = Object.freeze({
  commits: 500,
  prs: 250,
  issues: 250,
});

const EVIDENCE_MARKER_RE = createMarkerRe('HISTORICAL REPO EVIDENCE');

// engsys v2.0.1 round 3 (F4): a commit carrying any of these trailers is agent-authored — its
// rationale is the agent's own text, never a human operator's, regardless of who it was
// committed as. Matches three trailer names (`Co-Authored-By:`/`Assisted-by:`/`Generated-by:`,
// whitespace-tolerant before the colon, case-insensitive throughout) followed anywhere on the
// same line by a known agent name/provider identifier or email domain. This is explicitly
// defense-in-depth, NOT the real trust boundary: the real boundary is key custody (see
// docs/memory-spec.md) — no operator signing key reachable from an agent session, and GitHub
// Codespaces GPG auto-signing turned off for operator accounts. A trailer match can never be
// exhaustive against every current and future agent/provider name.
const AGENT_TRAILER_RE =
  /(?:co-authored-by|assisted-by|generated-by)\s*:[^\n]*(?:\bclaude\b|\bcopilot\b|\bgemini\b|\bantigravity\b|\bcodex\b|\bgpt\b|\bopus\b|\bsonnet\b|\bdeepseek\b|\bgrok\b|noreply@anthropic\.com|@openai\.com|@google\.com|google\s*ai)/i;

// ---------------------------------------------------------------------------
// §7.4 Quarantine & Anomaly Tagging
// ---------------------------------------------------------------------------

const QUARANTINE_RULES = [
  {
    id: 'forged_untrusted_marker',
    test(folded) {
      const re = new RegExp(MARKER_RE.source, 'im');
      return re.exec(folded);
    },
  },
  {
    id: 'forged_evidence_marker',
    test(folded) {
      const re = new RegExp(EVIDENCE_MARKER_RE.source, 'im');
      return re.exec(folded);
    },
  },
  {
    id: 'system_tag_spoof',
    test(folded) {
      return /<\s*\/?\s*(?:system-reminder|system|command-name|command-message|command-args|user-prompt-submit-hook)\b[^>]*>/i.exec(
        folded,
      );
    },
  },
  {
    id: 'role_turn_spoof',
    test(folded) {
      return /(?:^|\n)\s*(?:Human|Assistant)\s*:/i.exec(folded);
    },
  },
];

const FLAG_RULES = [
  {
    id: 'imperative_override',
    re: /\b(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|prompts|rules|directions|constraints)\b|\byou\s+are\s+now\s+(?:in\s+)?[a-z0-9_-]+\s+mode\b|\bnew\s+system\s+prompt\b/i,
  },
  {
    id: 'shell_exfiltration',
    re: /\b(?:curl|wget)\s+[^\n]*https?:\/\/|\bnc\s+-[a-z]*e\b|\|\s*(?:ba)?sh\b|\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba)?sh\b|\b(?:GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY)\b/i,
  },
];

/**
 * Inspect text under `normalizeUntrusted()` fold per §7.4.
 * HTML comments (`<!-- ... -->`) are never a signal.
 *
 * @returns {{ quarantined: boolean, rule?: string, span?: string, flags: string[] }}
 */
export function classifyTextSafety(text) {
  const raw = String(text ?? '');
  if (!raw) return { quarantined: false, flags: [] };
  const folded = normalizeUntrusted(raw);

  for (const qRule of QUARANTINE_RULES) {
    const m = qRule.test(folded) || qRule.test(raw);
    if (m) {
      return {
        quarantined: true,
        rule: qRule.id,
        span: String(m[0]).slice(0, 120),
        flags: [],
      };
    }
  }

  const flags = [];
  for (const fRule of FLAG_RULES) {
    if (fRule.re.test(folded) || fRule.re.test(raw)) {
      flags.push(fRule.id);
    }
  }
  return { quarantined: false, flags };
}

export function appendQuarantineLog(cacheDir, entry) {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(cacheDir, 'quarantine.jsonl'), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// §7.2 Author & Editor Eligibility Filter
// ---------------------------------------------------------------------------

const NOISY_BOT_LOGINS = new Set([
  'dependabot',
  'dependabot[bot]',
  'github-actions',
  'github-actions[bot]',
]);

const ELIGIBLE_HUMAN_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const INELIGIBLE_HUMAN_ASSOCIATIONS = new Set([
  'NONE',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
]);

/**
 * Resolve a bot's numeric user `databaseId` from its slug via `GET /users/<slug>%5Bbot%5D`
 * (never the App ID), caching in `<cacheDir>/bot-ids.json`.
 */
export async function resolveBotSlugUserId(slug, { gh, cacheDir } = {}) {
  const cleanSlug = String(slug ?? '')
    .trim()
    .replace(/\[bot\]$/i, '');
  if (!cleanSlug) return null;

  const cacheFile = cacheDir ? path.join(cacheDir, 'bot-ids.json') : null;
  let cache = {};
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
      if (typeof cache[cleanSlug] === 'number') return cache[cleanSlug];
    } catch {
      cache = {};
    }
  }

  if (typeof gh !== 'function') return null;
  try {
    const raw = await gh(['api', `/users/${encodeURIComponent(cleanSlug + '[bot]')}`]);
    const parsed = JSON.parse(raw);
    const id = typeof parsed?.id === 'number' ? parsed.id : null;
    if (id !== null && cacheFile) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        cache[cleanSlug] = id;
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
      } catch {
        // Best effort
      }
    }
    return id;
  } catch {
    return null;
  }
}

function isBotActor(actor) {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.__typename === 'Bot' || actor.type === 'Bot') return true;
  const login = String(actor.login || '');
  return login.endsWith('[bot]') || NOISY_BOT_LOGINS.has(login.toLowerCase());
}

/**
 * Check whether a single actor (author or editor) passes §7.2 eligibility.
 *
 * @returns {{ eligible: boolean, kind: string | null, id: number | null, reason?: string }}
 */
export function evaluateActorEligibility(actor, authorAssociation, config = {}) {
  if (!actor || typeof actor !== 'object') {
    return { eligible: false, kind: null, id: null, reason: 'missing_actor' };
  }

  const dbId = typeof actor.databaseId === 'number' ? actor.databaseId : (typeof actor.id === 'number' ? actor.id : null);
  const login = String(actor.login || '').toLowerCase();
  const trustedBots = new Set((config.trusted_bot_user_ids ?? []).map(Number));
  const operators = new Set((config.operator_user_ids ?? []).map(Number));

  // Explicit operator allowlist by numeric databaseId
  if (dbId !== null && operators.has(dbId)) {
    return { eligible: true, kind: 'operator', id: dbId };
  }

  // Bot actors: must be in trusted_bot_user_ids; noisy bots dropped by default
  if (isBotActor(actor)) {
    if (dbId !== null && trustedBots.has(dbId)) {
      return { eligible: true, kind: 'bot', id: dbId };
    }
    if (NOISY_BOT_LOGINS.has(login)) {
      return { eligible: false, kind: 'bot', id: dbId, reason: 'noisy_bot' };
    }
    return { eligible: false, kind: 'bot', id: dbId, reason: 'untrusted_bot' };
  }

  if (NOISY_BOT_LOGINS.has(login)) {
    return { eligible: false, kind: 'bot', id: dbId, reason: 'noisy_bot' };
  }

  // In case a bot comes through without __typename === 'Bot' but its ID is in trusted_bot_user_ids
  if (dbId !== null && trustedBots.has(dbId)) {
    return { eligible: true, kind: 'bot', id: dbId };
  }

  const assoc = String(authorAssociation || '').toUpperCase();
  if (INELIGIBLE_HUMAN_ASSOCIATIONS.has(assoc)) {
    return { eligible: false, kind: null, id: dbId, reason: `ineligible_association:${assoc}` };
  }
  if (ELIGIBLE_HUMAN_ASSOCIATIONS.has(assoc)) {
    // engsys v2.0.1 (L5): `authorAssociation` (OWNER/MEMBER) alone no longer grants trust — it's
    // GitHub's own self-reported, point-in-time label and can drift (org membership changes,
    // org/repo transfers) without this config ever being touched. Trust comes from the SAME
    // numeric-ID allowlists everything else in this module uses: the actor's `databaseId` must
    // also be present in `trusted_member_user_ids` (new) or `operator_user_ids`.
    const trustedMembers = new Set((config.trusted_member_user_ids ?? []).map(Number));
    if (dbId === null || !(trustedMembers.has(dbId) || operators.has(dbId))) {
      return { eligible: false, kind: null, id: dbId, reason: `unallowlisted_member:${assoc}` };
    }
    const kind = assoc === 'OWNER' ? 'owner' : 'member';
    return { eligible: true, kind, id: dbId };
  }

  return { eligible: false, kind: null, id: dbId, reason: `unknown_association:${assoc || 'EMPTY'}` };
}

/**
 * Evaluate a GitHub node (issue, PR, comment, review) for author AND editor eligibility (§7.2, #146).
 * If `lastEditedAt` is set and `editor` differs from `author` (or is null):
 *   - If `editor` is eligible, the node is eligible (recording `editor_id` and `editor_kind`).
 *   - Otherwise, if `userContentEdits.nodes` has an pre-edit revision whose `editor` (or original
 *     author) is eligible and `diff` is present, falls back to that revision; otherwise drops the node.
 */
export function evaluateNodeEligibility(node, config = {}) {
  if (!node || typeof node !== 'object') {
    return { eligible: false, reason: 'empty_node' };
  }
  const authorRes = evaluateActorEligibility(node.author, node.authorAssociation, config);
  if (!authorRes.eligible) {
    return { eligible: false, reason: `author_${authorRes.reason}` };
  }

  if (!node.lastEditedAt) {
    return {
      eligible: true,
      author_id: authorRes.id,
      author_kind: authorRes.kind,
      editor_id: null,
      editor_kind: null,
      bodyText: String(node.body ?? ''),
    };
  }

  // Node was edited: verify editor
  if (node.editor) {
    const sameActor =
      node.editor.databaseId != null &&
      authorRes.id != null &&
      Number(node.editor.databaseId) === Number(authorRes.id);
    if (sameActor) {
      return {
        eligible: true,
        author_id: authorRes.id,
        author_kind: authorRes.kind,
        editor_id: authorRes.id,
        editor_kind: authorRes.kind,
        bodyText: String(node.body ?? ''),
      };
    }
    // Editor is a different user: check if editor is in operator_user_ids or trusted_bot_user_ids
    // or has an eligible association if provided
    const editorAssoc = node.editorAssociation || (sameActor ? node.authorAssociation : null);
    const editorRes = evaluateActorEligibility(node.editor, editorAssoc, config);
    if (editorRes.eligible) {
      return {
        eligible: true,
        author_id: authorRes.id,
        author_kind: authorRes.kind,
        editor_id: editorRes.id,
        editor_kind: editorRes.kind,
        bodyText: String(node.body ?? ''),
      };
    }
  }

  // Fallback: check pre-edit revisions in userContentEdits if available (must have an explicit edit.editor)
  const edits = Array.isArray(node.userContentEdits?.nodes) ? node.userContentEdits.nodes : [];
  for (const edit of edits) {
    if (!edit || typeof edit.diff !== 'string' || !edit.diff.trim()) continue;
    const editActor = edit.editor;
    if (!editActor) continue;
    const editAssoc =
      authorRes.id != null && Number(editActor.databaseId) === Number(authorRes.id)
        ? node.authorAssociation
        : null;
    const editRes = evaluateActorEligibility(editActor, editAssoc, config);
    if (editRes.eligible) {
      return {
        eligible: true,
        author_id: authorRes.id,
        author_kind: authorRes.kind,
        editor_id: editRes.id,
        editor_kind: editRes.kind,
        bodyText: edit.diff,
      };
    }
  }

  return { eligible: false, reason: 'ineligible_editor' };
}

/**
 * Evaluate brief-time trust of a stored Class B event against the current `config` (§7.3, #132).
 * Removing a bot ID from `trusted_bot_user_ids` or an operator from `operator_user_ids` immediately
 * drops its previously synced records at brief-build time.
 */
// engsys v2.0.1 round 2 (F1): this is now a thin delegate to the ONE shared brief-time trust
// gate in ../lib/memory/trust.mjs (imported as `sharedIsEventTrusted` above), kept under its
// original name for every existing caller/test of this module. There is no more
// memory-sync-specific trust logic here — the gate memory-brief.mjs actually runs at brief-build
// time and this one are now, by construction, the same function.
export function isEventTrustedByConfig(event, config = {}) {
  return sharedIsEventTrusted(event, config);
}

// ---------------------------------------------------------------------------
// Event extraction from PRs, Issues, Commits, and Monster Journals
// ---------------------------------------------------------------------------

function extractIssueRefs(text) {
  const refs = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)|(?:^|[\s([,;])#(\d+)\b)/gi)) {
    const n = Number(m[1] || m[2]);
    if (Number.isFinite(n) && n > 0) refs.add(n);
  }
  return [...refs];
}

function sanitizeEventWithQuarantine(event, { cacheDir, now = () => Date.now() } = {}) {
  if (event.deleted === true) return event;
  const textToScan = [event.summary || '', event.text || ''].filter(Boolean).join('\n');
  const safety = classifyTextSafety(textToScan);
  if (safety.quarantined) {
    appendQuarantineLog(cacheDir, {
      ts: new Date(now()).toISOString(),
      k: event.k,
      url: event.url || '',
      author_id: event.author_id ?? null,
      rule: safety.rule,
      span: safety.span,
    });
    return null;
  }
  const mergedFlags = new Set([...(Array.isArray(event.flags) ? event.flags : []), ...safety.flags]);
  return {
    ...event,
    flags: [...mergedFlags],
  };
}

function normalizeOptionalPath(p) {
  const s = String(p ?? '').trim();
  return s ? s : null;
}

function normalizeOptionalRepo(r) {
  const s = String(r ?? '').trim();
  return s && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : null;
}

function normalizeSafeKeySegment(seg) {
  return String(seg ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_./-]/g, '_');
}

/**
 * Extract normalized memory events (and tombstones for minimized/deleted items) from a GraphQL PR node.
 */
export function extractEventsFromPrNode(pr, { repo, config = {}, cacheDir = null, now = () => Date.now() } = {}) {
  const out = [];
  if (!pr || typeof pr.number !== 'number') return out;
  const prNum = pr.number;
  const normRepo = normalizeOptionalRepo(repo);
  const keyPrefix = normRepo || 'local';
  const matchers = buildMarkerMatchers(config);
  const updatedAt = pr.updatedAt || pr.mergedAt || pr.createdAt || new Date(now()).toISOString();

  const touchedPaths = Array.isArray(pr.files?.nodes)
    ? pr.files.nodes.map((f) => f?.path).filter(Boolean)
    : [];
  const primaryPath = normalizeOptionalPath(touchedPaths[0]);
  const prPaginatedTruncated =
    Boolean(pr.comments?.pageInfo?.hasNextPage) ||
    Boolean(pr.reviews?.pageInfo?.hasNextPage) ||
    Boolean(pr.reviewThreads?.pageInfo?.hasNextPage) ||
    Boolean(pr.files?.pageInfo?.hasNextPage);
  const baseFlags = prPaginatedTruncated ? ['truncated'] : [];

  // Collect FINDING-ACK lines across eligible PR body, comments, and reviews
  const ackById = new Map();
  const collectAcks = (text) => {
    for (const ack of parseFindingAcks(text)) {
      ackById.set(ack.id, ack.outcome);
    }
  };

  const prElig = evaluateNodeEligibility(pr, config);
  if (prElig.eligible) {
    collectAcks(prElig.bodyText);
    const prKey = `${keyPrefix}:pr:${prNum}`;
    const ev = sanitizeEventWithQuarantine(
      {
        k: prKey,
        id: prKey,
        kind: 'pr',
        repo: normRepo,
        number: prNum,
        path: primaryPath,
        paths: touchedPaths,
        line: null,
        symbol: null,
        marker: null,
        outcome: pr.mergedAt ? 'merged' : 'none',
        date: (pr.mergedAt || updatedAt).slice(0, 10),
        updated_at: updatedAt,
        author_id: prElig.author_id,
        author_kind: prElig.author_kind,
        editor_id: prElig.editor_id,
        editor_kind: prElig.editor_kind,
        url: pr.url || (normRepo ? `https://github.com/${normRepo}/pull/${prNum}` : ''),
        summary: String(pr.title || '').slice(0, 200),
        text: `${pr.title || ''}\n\n${prElig.bodyText}`.trim(),
        issue_refs: extractIssueRefs(`${pr.title || ''}\n${prElig.bodyText}`),
        flags: [...baseFlags],
      },
      { cacheDir, now },
    );
    if (ev) out.push(ev);
  }

  // Pre-scan comments & reviews for FINDING-ACKs from eligible authors
  for (const c of pr.comments?.nodes ?? []) {
    if (!c || c.isMinimized) continue;
    const elig = evaluateNodeEligibility(c, config);
    if (elig.eligible) collectAcks(elig.bodyText);
  }
  for (const r of pr.reviews?.nodes ?? []) {
    if (!r || r.isMinimized) continue;
    const elig = evaluateNodeEligibility(r, config);
    if (elig.eligible) collectAcks(elig.bodyText);
  }

  // Process PR comments & review bodies (marker findings vs general comments, plus tombstones for isMinimized)
  const reviewLikeNodes = [
    ...(pr.comments?.nodes ?? []).map((n, idx) => ({ node: n, fallbackId: String(idx) })),
    ...(pr.reviews?.nodes ?? []).map((n, idx) => ({ node: n, fallbackId: `r-${idx}` })),
  ];
  for (const { node: c, fallbackId } of reviewLikeNodes) {
    if (!c) continue;
    const cid = normalizeSafeKeySegment(c.id || fallbackId);
    const cUpdated = c.updatedAt || c.createdAt || updatedAt;
    if (c.isMinimized) {
      const tk = `${keyPrefix}:pr_review:${prNum}:${cid}`;
      out.push({
        k: tk,
        id: tk,
        deleted: true,
        updated_at: cUpdated,
      });
      const emittedFindingKeys = new Set();
      if (isMarkerBody(c.body, matchers)) {
        const parsedHidden = parseReviewComment(String(c.body ?? ''));
        const hiddenFindings = Array.isArray(parsedHidden) ? parsedHidden : (parsedHidden?.findings ?? []);
        for (const [fIdx, f] of hiddenFindings.entries()) {
          const fk = `${keyPrefix}:marker_finding:${prNum}:${cid}:${normalizeSafeKeySegment(f.id || `F${fIdx + 1}`)}`;
          emittedFindingKeys.add(fk);
          out.push({ k: fk, id: fk, deleted: true, updated_at: cUpdated });
        }
      }
      if (emittedFindingKeys.size === 0) {
        for (let i = 1; i <= 10; i++) {
          const fk = `${keyPrefix}:marker_finding:${prNum}:${cid}:F${i}`;
          out.push({ k: fk, id: fk, deleted: true, updated_at: cUpdated });
        }
      }
      continue;
    }
    const elig = evaluateNodeEligibility(c, config);
    if (!elig.eligible) continue;
    if (!String(elig.bodyText || '').trim()) continue;

    // Structured finding lines are extracted ONLY from comments/reviews with a leading configured marker (§7.2)
    if (isMarkerBody(elig.bodyText, matchers)) {
      const mMatch = String(elig.bodyText).trimStart().match(/^<!--\s*([a-z0-9-]+)\s*-->/i);
      const markerName = mMatch ? mMatch[1].toLowerCase() : 'local-review-findings';
      const parsed = parseReviewComment(elig.bodyText);
      const findings = Array.isArray(parsed) ? parsed : (parsed?.findings ?? []);
      for (const [fIdx, f] of findings.entries()) {
        const findingId = normalizeSafeKeySegment(f.id || `F${fIdx + 1}`);
        const outcome = ackById.get(findingId) || 'unresolved';
        const fk = `${keyPrefix}:marker_finding:${prNum}:${cid}:${findingId}`;
        const fPath = normalizeOptionalPath(f.file) || primaryPath;
        const ev = sanitizeEventWithQuarantine(
          {
            k: fk,
            id: fk,
            kind: 'marker_finding',
            repo: normRepo,
            number: prNum,
            path: fPath,
            paths: fPath ? [fPath] : touchedPaths,
            line: typeof f.line === 'number' && f.line > 0 ? f.line : null,
            symbol: normalizeOptionalPath(f.symbol),
            marker: markerName,
            severity: f.severity || 'medium',
            category: f.category || '',
            outcome,
            date: cUpdated.slice(0, 10),
            updated_at: cUpdated,
            author_id: elig.author_id,
            author_kind: elig.author_kind,
            editor_id: elig.editor_id,
            editor_kind: elig.editor_kind,
            url: c.url || pr.url || '',
            summary: String(f.title || '').slice(0, 200),
            text: `${f.title || ''}\n\n${f.body || elig.bodyText}`.trim(),
            flags: [...baseFlags],
          },
          { cacheDir, now },
        );
        if (ev) out.push(ev);
      }
    } else {
      const ck = `${keyPrefix}:pr_review:${prNum}:${cid}`;
      const ev = sanitizeEventWithQuarantine(
        {
          k: ck,
          id: ck,
          kind: 'pr_review',
          repo: normRepo,
          number: prNum,
          path: primaryPath,
          paths: touchedPaths,
          line: null,
          symbol: null,
          marker: null,
          outcome: pr.mergedAt ? 'merged' : 'none',
          date: cUpdated.slice(0, 10),
          updated_at: cUpdated,
          author_id: elig.author_id,
          author_kind: elig.author_kind,
          editor_id: elig.editor_id,
          editor_kind: elig.editor_kind,
          url: c.url || pr.url || '',
          summary: String(elig.bodyText).split('\n')[0].slice(0, 200),
          text: elig.bodyText,
          flags: [...baseFlags],
        },
        { cacheDir, now },
      );
      if (ev) out.push(ev);
    }
  }

  // Process review threads (isResolved -> fixed, else unresolved, #143)
  for (const [tIdx, thread] of (pr.reviewThreads?.nodes ?? []).entries()) {
    if (!thread) continue;
    const threadTruncated = Boolean(thread.comments?.pageInfo?.hasNextPage);
    const threadFlags = threadTruncated ? [...new Set([...baseFlags, 'truncated'])] : [...baseFlags];
    const comments = [...(thread.comments?.nodes ?? [])].sort((a, b) =>
      String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? '')),
    );
    const opener = comments[0];
    if (!opener) continue;
    const tid = normalizeSafeKeySegment(thread.id || opener.id || String(tIdx));
    const tUpdated = opener.updatedAt || opener.createdAt || updatedAt;
    const tk = `${keyPrefix}:review_thread:${prNum}:${tid}`;
    if (opener.isMinimized) {
      out.push({
        k: tk,
        id: tk,
        deleted: true,
        updated_at: tUpdated,
      });
      continue;
    }
    const elig = evaluateNodeEligibility(opener, config);
    if (!elig.eligible) continue;

    const outcome = thread.isResolved ? 'fixed' : 'unresolved';
    const tPath = normalizeOptionalPath(thread.path) || primaryPath;
    const ev = sanitizeEventWithQuarantine(
      {
        k: tk,
        id: tk,
        kind: 'review_thread',
        repo: normRepo,
        number: prNum,
        path: tPath,
        paths: tPath ? [tPath] : touchedPaths,
        line: typeof thread.line === 'number' && thread.line > 0 ? thread.line : null,
        symbol: null,
        marker: null,
        outcome,
        date: tUpdated.slice(0, 10),
        updated_at: tUpdated,
        author_id: elig.author_id,
        author_kind: elig.author_kind,
        editor_id: elig.editor_id,
        editor_kind: elig.editor_kind,
        url: opener.url || pr.url || '',
        summary: String(elig.bodyText).split('\n')[0].slice(0, 200),
        text: elig.bodyText,
        flags: threadFlags,
      },
      { cacheDir, now },
    );
    if (ev) out.push(ev);
  }

  return out;
}

/**
 * Extract normalized memory events from a GraphQL Issue node.
 */
export function extractEventsFromIssueNode(
  issue,
  { repo, config = {}, cacheDir = null, now = () => Date.now() } = {},
) {
  const out = [];
  if (!issue || typeof issue.number !== 'number') return out;
  const num = issue.number;
  const normRepo = normalizeOptionalRepo(repo);
  const keyPrefix = normRepo || 'local';
  const updatedAt = issue.updatedAt || issue.createdAt || new Date(now()).toISOString();
  const truncated = Boolean(issue.comments?.pageInfo?.hasNextPage);
  const baseFlags = truncated ? ['truncated'] : [];
  const issueOutcome = String(issue.state || '').toUpperCase() === 'CLOSED' ? 'fixed' : 'none';

  const elig = evaluateNodeEligibility(issue, config);
  if (elig.eligible) {
    const ik = `${keyPrefix}:issue:${num}`;
    const ev = sanitizeEventWithQuarantine(
      {
        k: ik,
        id: ik,
        kind: 'issue',
        repo: normRepo,
        number: num,
        path: null,
        paths: [],
        line: null,
        symbol: null,
        marker: null,
        outcome: issueOutcome,
        date: updatedAt.slice(0, 10),
        updated_at: updatedAt,
        author_id: elig.author_id,
        author_kind: elig.author_kind,
        editor_id: elig.editor_id,
        editor_kind: elig.editor_kind,
        url: issue.url || (normRepo ? `https://github.com/${normRepo}/issues/${num}` : ''),
        summary: String(issue.title || '').slice(0, 200),
        text: `${issue.title || ''}\n\n${elig.bodyText}`.trim(),
        flags: [...baseFlags],
      },
      { cacheDir, now },
    );
    if (ev) out.push(ev);
  }

  for (const [idx, c] of (issue.comments?.nodes ?? []).entries()) {
    if (!c) continue;
    const cid = normalizeSafeKeySegment(c.id || String(idx));
    const cUpdated = c.updatedAt || c.createdAt || updatedAt;
    const ck = `${keyPrefix}:issue_comment:${num}:${cid}`;
    if (c.isMinimized) {
      out.push({
        k: ck,
        id: ck,
        deleted: true,
        updated_at: cUpdated,
      });
      continue;
    }
    const cElig = evaluateNodeEligibility(c, config);
    if (!cElig.eligible) continue;
    const ev = sanitizeEventWithQuarantine(
      {
        k: ck,
        id: ck,
        kind: 'issue_comment',
        repo: normRepo,
        number: num,
        path: null,
        paths: [],
        line: null,
        symbol: null,
        marker: null,
        outcome: issueOutcome,
        date: cUpdated.slice(0, 10),
        updated_at: cUpdated,
        author_id: cElig.author_id,
        author_kind: cElig.author_kind,
        editor_id: cElig.editor_id,
        editor_kind: cElig.editor_kind,
        url: c.url || issue.url || '',
        summary: String(cElig.bodyText).split('\n')[0].slice(0, 200),
        text: cElig.bodyText,
        flags: [...baseFlags],
      },
      { cacheDir, now },
    );
    if (ev) out.push(ev);
  }

  return out;
}

/**
 * Normalize a signing-key identifier for comparison (engsys#187). Returns `{ type, id }` or `null`.
 *   - SSH: `SHA256:<base64>` (what `ssh-keygen -l` prints, and how an operator lists a key) — base64 is
 *     case-sensitive, so only the prefix is case-folded and trailing `=` padding is dropped. GitHub's
 *     `SshSignature.keyFingerprint` is the bare base64 with no prefix; `isSigningKeyAllowed` adds it back.
 *   - GPG: hex only (optional `0x`, spaces/colons tolerated) of at least 16 digits — a long key id
 *     (16) or full fingerprint (40). Anything shorter or non-hex is rejected, never prefix-matched.
 */
export function normalizeSigningKeyId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const ssh = /^sha256:([A-Za-z0-9+/]{20,})={0,2}$/i.exec(s);
  if (ssh) return { type: 'ssh', id: ssh[1] };
  const hex = s.replace(/^0x/i, '').replace(/[\s:]/g, '').toLowerCase();
  if (/^[0-9a-f]{16,}$/.test(hex)) return { type: 'gpg', id: hex };
  return null;
}

/**
 * True only when `signingKey` (`{ type: 'gpg'|'ssh', id }` from `fetchCommitTrustBatch`) is on
 * `allowlist`. Fails closed on a missing key, an empty/non-array allowlist, or any malformed entry
 * (which is skipped, never wildcard-matched). Types never cross-match. GitHub exposes only the
 * 64-bit long key id for a GPG signature, so a listed 40-hex fingerprint matches when it ENDS
 * WITH that key id; a listed 16-hex key id must match exactly.
 */
export function isSigningKeyAllowed(signingKey, allowlist) {
  if (!signingKey || !Array.isArray(allowlist) || allowlist.length === 0) return false;
  const got = normalizeSigningKeyId(
    signingKey.type === 'ssh' ? `SHA256:${String(signingKey.id ?? '').replace(/^sha256:/i, '')}` : String(signingKey.id ?? ''),
  );
  if (!got || got.type !== signingKey.type) return false;
  for (const entry of allowlist) {
    const want = normalizeSigningKeyId(entry);
    if (!want || want.type !== got.type) continue;
    if (want.type === 'ssh') {
      if (want.id === got.id) return true;
    } else if (got.id.length === 16 && (want.id === got.id || (want.id.length === 40 && want.id.endsWith(got.id)))) {
      return true;
    } else if (got.id.length === 40 && want.id === got.id) {
      return true;
    }
  }
  return false;
}

/**
 * Extract a normalized memory event from a git commit record per §7.2 commit-ingest filter:
 *   - Skip commits authored or co-authored by Dependabot.
 *   - Always index commit subject + `#123` / `Closes #123` references + touched files.
 *   - Index commit body ONLY when the commit's numeric authorId is in `config.operator_user_ids`
 *     (engsys v2.0.1 M3 — never by author name/email, and never by signature alone).
 */
export function extractEventFromCommit(
  commit,
  { repo = '', config = {}, cacheDir = null, now = () => Date.now() } = {},
) {
  if (!commit || !commit.sha) return null;
  const authorName = String(commit.authorName || '').toLowerCase();
  const authorEmail = String(commit.authorEmail || '').toLowerCase();
  const body = String(commit.body || '');

  if (
    authorName.includes('dependabot') ||
    authorEmail.includes('dependabot') ||
    /co-authored-by:[^\n]*dependabot/i.test(body)
  ) {
    return null;
  }

  // engsys v2.0.1 round 2 (F2): a commit is "operator" only when ALL three hold:
  //   1. a cryptographically verified signature on the commit (`commit.verified === true`,
  //      GitHub's `history().signature.isValid`, fetched in ONE batched GraphQL call per 100
  //      commits by `ingestLocalCommits` — never per-commit REST);
  //   2. the COMMITTER's numeric id (never the author's — GitHub derives `author.id` from the
  //      author EMAIL, which the publisher sets locally; the committer identity from a signed,
  //      GraphQL-verified commit is a materially stronger root) is in `operator_user_ids`;
  //   3. the commit message carries no agent co-author trailer (`Co-Authored-By:` naming
  //      Claude, Copilot, Gemini, or Antigravity) — an agent-authored commit's rationale is the
  //      agent's own text, not a human operator's, regardless of who it was committed as.
  // A commit that fails ANY of these is ingested as an UNLABELED pointer: no author_kind at all,
  // author_id: null, subject + #refs only, no body — exactly the shape a benign non-operator
  // commit always had. It is never `author_kind: 'member'` (round 1 had this wrong): the shared
  // trust gate's member/owner path now requires a trusted_member_user_ids/operator_user_ids ID
  // match, and commits were never meant to carry that burden — they fall through the gate's
  // legacy/unlabeled allowance instead, same as before, carrying nothing sensitive to protect.
  // engsys#187: a fourth, equally required criterion — the signature's KEY must be on the
  // operator-controlled `operator_signing_key_fingerprints` allowlist (repo-at-reviewed-SHA or
  // fleet config only). A verified signature by itself only proves SOME key registered to the
  // committer's account signed; the allowlist pins which key(s) count as the operator's. An
  // empty/missing allowlist trusts nothing.
  const operators = new Set((config.operator_user_ids ?? []).map(Number));
  const committerId = commit.committerId != null ? Number(commit.committerId) : null;
  const hasAgentCoAuthor = AGENT_TRAILER_RE.test(body);
  const isOperatorCommit =
    commit.verified === true &&
    isSigningKeyAllowed(commit.signingKey, config.operator_signing_key_fingerprints) &&
    committerId != null &&
    operators.has(committerId) &&
    !hasAgentCoAuthor;

  const subject = String(commit.subject || '').trim();
  const issueRefs = extractIssueRefs(`${subject}\n${body}`);
  const refSuffix = issueRefs.length > 0 ? ` (refs: ${issueRefs.map((n) => `#${n}`).join(', ')})` : '';
  const textContent = isOperatorCommit && body.trim()
    ? `${subject}\n\n${body.trim()}`
    : `${subject}${refSuffix}`;

  const paths = Array.isArray(commit.files) ? commit.files.filter(Boolean) : [];
  const dateIso = commit.date || new Date(now()).toISOString();
  const normRepo = normalizeOptionalRepo(repo);
  const keyPrefix = normRepo || 'local';
  const shortSha = normalizeSafeKeySegment(commit.sha.slice(0, 12));
  const ck = `${keyPrefix}:commit:${shortSha}`;

  return sanitizeEventWithQuarantine(
    {
      k: ck,
      id: ck,
      kind: 'commit',
      repo: normRepo,
      number: issueRefs[0] || null,
      path: normalizeOptionalPath(paths[0]),
      paths,
      line: null,
      symbol: null,
      marker: null,
      outcome: 'merged',
      date: dateIso.slice(0, 10),
      updated_at: dateIso,
      author_id: isOperatorCommit ? committerId : null,
      author_kind: isOperatorCommit ? 'operator' : null,
      author_email: isOperatorCommit ? authorEmail : null,
      author_login: isOperatorCommit ? authorName : null,
      url: normRepo ? `https://github.com/${normRepo}/commit/${commit.sha}` : '',
      summary: subject.slice(0, 200),
      text: textContent,
      issue_refs: issueRefs,
      flags: [],
    },
    { cacheDir, now },
  );
}

const COMMIT_TRUST_GQL = `query($owner:String!,$name:String!,$expr:String!,$first:Int!,$after:String,$since:GitTimestamp){
  repository(owner:$owner,name:$name){
    object(expression:$expr){
      ... on Commit{
        history(first:$first,after:$after,since:$since){
          pageInfo{hasNextPage endCursor}
          nodes{oid signature{isValid wasSignedByGitHub ... on GpgSignature{keyId} ... on SshSignature{keyFingerprint}} committer{user{databaseId}}}
        }
      }
    }
  }
}`;

/**
 * Resolve signature validity + the COMMITTER's numeric id for up to `maxCount` commits reachable
 * from `sha`, via `history`, in batches of (at most) 100 — ONE or a handful of GraphQL calls
 * total, never one REST call per commit (cr review round 2, F2/F5: the per-commit REST lookup
 * this replaced made --init do up to 500 sequential network round-trips, and it ran inside the
 * maintenance heartbeat). Returns a `Map<sha, { verified: boolean, signingKey: {type,id}|null, committerId: number|null }>`.
 * Fails closed: any error/missing `repo` stops pagination and returns whatever was already
 * fetched (possibly empty) — never retries into a hang.
 *
 * cr review (round 2): pass `since` (the SAME watermark `ingestLocalCommits`' `git log --since`
 * uses) so a `--delta` run — a handful of commits — doesn't still page through up to `maxCount`
 * (500) commits' worth of GraphQL history on every heartbeat.
 */
export function fetchCommitTrustBatch(repo, sha, { maxCount = INIT_CAPS.commits, since = null, exec = execFileSync } = {}) {
  const result = new Map();
  const normRepo = normalizeOptionalRepo(repo);
  if (!normRepo || !sha) return result;
  const [owner, name] = normRepo.split('/');
  let after = null;
  let fetched = 0;
  while (fetched < maxCount) {
    const first = Math.min(100, maxCount - fetched);
    const args = [
      'api', 'graphql',
      '-f', `query=${COMMIT_TRUST_GQL}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `expr=${sha}`,
      '-F', `first=${first}`,
    ];
    if (after) args.push('-F', `after=${after}`);
    if (since) args.push('-f', `since=${since}`);
    let out;
    try {
      out = exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      break;
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      break;
    }
    const history = parsed?.data?.repository?.object?.history;
    const nodes = Array.isArray(history?.nodes) ? history.nodes : [];
    for (const n of nodes) {
      if (!n || typeof n.oid !== 'string') continue;
      // engsys#187: capture WHICH key signed. A GitHub-signed commit (web UI / web-flow) is never
      // the operator's own key, so it yields no signingKey. Absent/odd shapes yield null.
      let signingKey = null;
      if (n.signature?.wasSignedByGitHub !== true) {
        if (typeof n.signature?.keyId === 'string' && n.signature.keyId) signingKey = { type: 'gpg', id: n.signature.keyId };
        else if (typeof n.signature?.keyFingerprint === 'string' && n.signature.keyFingerprint) signingKey = { type: 'ssh', id: n.signature.keyFingerprint };
      }
      result.set(n.oid, {
        verified: n.signature?.isValid === true,
        signingKey,
        committerId: n.committer?.user?.databaseId != null ? Number(n.committer.user.databaseId) : null,
      });
    }
    fetched += nodes.length;
    if (nodes.length === 0 || !history?.pageInfo?.hasNextPage) break;
    after = history.pageInfo.endCursor;
  }
  return result;
}

/**
 * Parse local git log commits (`--max-count`, optional `--since`).
 *
 * engsys v2.0.1 (M3): this always logs the **resolved reviewed SHA** (`resolveReviewedSha`,
 * `refs/remotes/origin/<default-branch>`), never the checked-out `HEAD` — a worktree can be on an
 * unreviewed branch or an attacker-controlled checkout. When no reviewed SHA can be resolved
 * (e.g. no `origin` remote), this fails closed and returns no commit events rather than falling
 * back to `HEAD`. Pass `ref` to pin an explicit SHA (tests only).
 */
export function ingestLocalCommits(
  repoRoot,
  {
    repo = '',
    config = {},
    cacheDir = null,
    maxCount = INIT_CAPS.commits,
    since = null,
    ref = null,
    exec = execFileSync,
    resolveSha = resolveReviewedSha,
    fetchTrustBatch = fetchCommitTrustBatch,
    now = () => Date.now(),
  } = {},
) {
  const effectiveRef = ref || resolveSha(repoRoot);
  if (!effectiveRef) return [];

  const nonce = crypto.randomBytes(8).toString('hex');
  const recSep = `__REC_${nonce}__`;
  const fldSep = `__FLD_${nonce}__`;
  const endSep = `__END_${nonce}__`;
  const args = [
    '-C',
    repoRoot,
    'log',
    effectiveRef,
    `--max-count=${maxCount}`,
    `--format=${recSep}%H${fldSep}%an${fldSep}%ae${fldSep}%aI${fldSep}%s${fldSep}%b${endSep}`,
    '--name-only',
  ];
  if (since) args.push(`--since=${since}`);
  let raw = '';
  try {
    raw = exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }

  const useNonce = raw.includes(recSep);
  const rSep = useNonce ? recSep : '\x1e';
  const fSep = useNonce ? fldSep : '\x1f';
  const eSep = useNonce ? endSep : '\x1d';

  // engsys v2.0.1 round 2 (F2/F5): ONE batched GraphQL `history` call (paginated at 100/page, not
  // one REST call per commit) resolves signature validity + the committer's numeric id for every
  // commit in this batch at once. Skipped entirely when no operator_user_ids are configured —
  // there's nothing for the result to be matched against either way.
  // engsys#187: also skipped when no signing-key allowlist is configured — no commit could be
  // trusted without one, so the lookup would be wasted.
  const wantTrust =
    (config.operator_user_ids ?? []).length > 0 &&
    (config.operator_signing_key_fingerprints ?? []).length > 0 &&
    normalizeOptionalRepo(repo);
  const trustBySha = wantTrust ? fetchTrustBatch(repo, effectiveRef, { maxCount, since, exec }) : new Map();

  const events = [];
  for (const record of raw.split(rSep)) {
    if (!record.trim()) continue;
    const [headerPart, filesPart = ''] = record.split(eSep);
    const [sha, authorName, authorEmail, date, subject, body] = headerPart.split(fSep);
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) continue;
    const files = filesPart
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const trimmedSha = sha.trim();
    const trust = trustBySha.get(trimmedSha);
    const ev = extractEventFromCommit(
      {
        sha: trimmedSha,
        authorName: authorName?.trim() || '',
        authorEmail: authorEmail?.trim() || '',
        date: date?.trim() || '',
        subject: subject?.trim() || '',
        body: body?.trim() || '',
        files,
        committerId: trust?.committerId ?? null,
        verified: trust?.verified === true,
        signingKey: trust?.signingKey ?? null,
      },
      { repo, config, cacheDir, now },
    );
    if (ev) events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// §7.5 Cursors & Delta Storage
// ---------------------------------------------------------------------------

export function readCursors(cacheDir) {
  if (!cacheDir) return {};
  const file = path.join(cacheDir, 'cursors.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeCursors(cacheDir, cursors) {
  if (!cacheDir) return;
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'cursors.json'), JSON.stringify(cursors, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Compute the effective query watermark timestamp with the 48-hour overlap window (§7.5).
 */
export function computeOverlapSince(cursorIso, overlapMs = OVERLAP_MS) {
  if (!cursorIso) return null;
  const ms = Date.parse(cursorIso);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.max(0, ms - overlapMs)).toISOString();
}

export function readDeltaEvents(cacheDir) {
  if (!cacheDir) return [];
  const file = path.join(cacheDir, 'delta.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    return parseEventsJsonl(fs.readFileSync(file, 'utf8')).events;
  } catch {
    return [];
  }
}

export function writeDeltaEvents(cacheDir, incomingEvents) {
  if (!cacheDir) return [];
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const existing = readDeltaEvents(cacheDir);
  const merged = mergeEvents(existing, incomingEvents);
  fs.writeFileSync(path.join(cacheDir, 'delta.jsonl'), formatEventsJsonl(merged), { encoding: 'utf8', mode: 0o600 });
  return merged;
}

// ---------------------------------------------------------------------------
// §9 Writers (F5): who may write which ref, the baton fence, and the journal tail
// ---------------------------------------------------------------------------

// The baton roles (core/lib/lease/baton.mjs ROLES). Only these may write a memory ref, and only the
// maintain baton holder writes the shared `events` ref: merge never does (docs/memory-spec.md §9).
export const WRITER_ROLES = Object.freeze(['merge', 'maintain']);
export const EVENTS_WRITER_ROLE = 'maintain';
// A fleet id becomes a ref path segment and part of every tail event key (index-db's KEY_RE caps keys
// at 80 characters), so it is length-capped as well as charset-checked (FLEET_ID_RE, signing.mjs).
const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Which ref a write run targets, or why it may not write at all. Pure; checked before any collection
 * or network call. `publish` always targets `refs/engsys/memory/events` and only for the maintain role
 * (and only while config `publish_role` is still `maintain`); an explicit `--ref` naming anything else
 * is refused, never honoured. `tail` targets the role's own `<role>/<fleet>` ref. Both need a state dir
 * (the baton fence reads it) and an `owner/repo`.
 */
export function resolveWriteTarget({ mode, role = '', fleet = '', ref = '', stateDir = '', repo = '', config = {} } = {}) {
  if (mode !== 'publish' && mode !== 'tail') return { ok: true, ref: null };
  if (!REPO_NAME_RE.test(String(repo || ''))) return { ok: false, reason: `--${mode} needs --repo owner/name` };
  if (!WRITER_ROLES.includes(role)) return { ok: false, reason: `--${mode} needs --role ${WRITER_ROLES.join('|')}` };
  if (!stateDir) return { ok: false, reason: `--${mode} needs --state-dir (the baton fence reads it)` };
  // Every write is signed as its fleet (signing.mjs), so both modes need the fleet id.
  if (!FLEET_ID_RE.test(String(fleet || ''))) return { ok: false, reason: `--${mode} needs --fleet <id> (1-40 of A-Z a-z 0-9 . _ -)` };
  if (mode === 'publish') {
    if (ref && ref !== EVENTS_REF) return { ok: false, reason: `--publish writes only ${EVENTS_REF}; a tail ref is written by --tail` };
    if (role !== EVENTS_WRITER_ROLE) return { ok: false, reason: `only the ${EVENTS_WRITER_ROLE} baton holder publishes ${EVENTS_REF} (got --role ${role})` };
    const configured = config?.publish_role ?? EVENTS_WRITER_ROLE;
    if (configured !== EVENTS_WRITER_ROLE) return { ok: false, reason: `publish_role ${JSON.stringify(configured)} is not supported: only ${EVENTS_WRITER_ROLE} publishes` };
    return { ok: true, ref: EVENTS_REF };
  }
  if (ref && ref !== EVENTS_REF) return { ok: false, reason: '--tail takes no --ref: it writes the role\'s own <role>/<fleet> ref' };
  return { ok: true, ref: tailRef(role, fleet) };
}

/**
 * The default baton fence: `baton.mjs fence` for this role and state dir (exit 0 only while this session
 * holds the baton with at least 60 s left, FENCE_MIN_REMAINING_MS). Resolves `{ held, reason }`, never
 * throws; anything but exit 0 is "not held".
 */
export function createBatonFence({ role, repo, stateDir, session = '', execFileFn = execFileP, env = process.env } = {}) {
  const batonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'lease', 'baton.mjs');
  return async () => {
    const args = [batonScript, 'fence', '--role', role, '--repo', repo, '--state-dir', stateDir];
    if (session) args.push('--session', session);
    try {
      await execFileFn(process.execPath, args, { encoding: 'utf8', timeout: 30_000, env });
      return { held: true };
    } catch (e) {
      const detail = String(e?.stdout || e?.message || e).trim().slice(0, 300);
      return { held: false, reason: `baton fence refused (exit ${e?.code ?? '?'}): ${detail}` };
    }
  };
}

// The journal files a tail mirrors: the monsters' own `journal-YYYY-MM.jsonl` decision logs in their
// state dir (merge-monster/maintenance-monster SKILL.md, "Write the ledger"). Nothing else in the state
// dir is read.
const JOURNAL_FILE_RE = /^journal-\d{4}-\d{2}\.jsonl$/;
export const TAIL_MAX_EVENTS = 200;
const TAIL_READ_BYTES = 256 * 1024;
const JOURNAL_EVENT_RE = /^[a-z][a-z0-9_.:-]{0,39}$/;

function readFileTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // A read that started mid-file drops its first (partial) line.
    return size > maxBytes ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The journal tail for `<role>/<fleet>`: the newest `max` lines of the state dir's journal files, as
 * STRUCTURED `kind: journal` events only. A journal line is model-written text, so nothing free-form is
 * carried: the event name (a short token, else the line is skipped), its timestamp, and a PR/issue
 * number when the line names one. Symlinked or non-regular journal files are skipped. Never throws.
 */
export function journalTailEvents(stateDir, { role, fleet, repo, max = TAIL_MAX_EVENTS } = {}) {
  let names;
  try {
    names = fs.readdirSync(stateDir).filter((n) => JOURNAL_FILE_RE.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const events = [];
  for (const name of names) {
    if (events.length >= max) break;
    const file = path.join(stateDir, name);
    let lines;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue; // a symlink (or anything else) is never followed
      lines = readFileTail(file, TAIL_READ_BYTES).split('\n').filter((l) => l.trim());
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && events.length < max; i--) {
      const line = lines[i];
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const event = typeof rec.event === 'string' ? rec.event : '';
      const tsMs = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
      if (!JOURNAL_EVENT_RE.test(event) || Number.isNaN(tsMs)) continue;
      const num = [rec.pr, rec.number, rec.issue].find((n) => Number.isSafeInteger(n) && n > 0);
      const digest = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
      events.push({
        k: `journal:${role}/${fleet}:${digest}`,
        kind: 'journal',
        repo,
        ...(num ? { number: num } : {}),
        updated_at: new Date(tsMs).toISOString(),
        outcome: 'none',
        flags: [],
        text: event,
      });
    }
  }
  return events.reverse();
}

// ---------------------------------------------------------------------------
// §7.6 Sync Modes: --init, --delta, --publish
// ---------------------------------------------------------------------------

async function defaultGh(args) {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const SYNC_REPO_GQL_QUERY = `
query($owner: String!, $name: String!, $prCount: Int!, $issueCount: Int!, $prAfter: String, $issueAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $prCount, after: $prAfter, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        url
        createdAt
        updatedAt
        mergedAt
        lastEditedAt
        authorAssociation
        author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        files(first: 50) { pageInfo { hasNextPage } nodes { path } }
        comments(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            id
            databaseId
            body
            url
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
            authorAssociation
            author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
            editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
          }
        }
        reviews(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            id
            databaseId
            body
            url
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
            authorAssociation
            author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
            editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
          }
        }
        reviewThreads(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 30) {
              pageInfo { hasNextPage }
              nodes {
                id
                databaseId
                body
                url
                createdAt
                updatedAt
                lastEditedAt
                isMinimized
                authorAssociation
                author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
                editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
              }
            }
          }
        }
      }
    }
    issues(first: $issueCount, after: $issueAfter, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        lastEditedAt
        authorAssociation
        author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        comments(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            id
            databaseId
            body
            url
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
            authorAssociation
            author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
            editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
          }
        }
      }
    }
  }
}`;

/**
 * Fetch recent PRs and Issues for `repo` (`owner/name`) via GitHub GraphQL (`gh api graphql`),
 * paging until `sinceIso` is reached or `INIT_CAPS` (`prs: 250`, `issues: 250`) are met.
 * Fails open (`{ prs: [], issues: [] }`) if `gh` fails or `repo` is not `owner/name`.
 */
export async function fetchRepoPrsAndIssues(
  repo,
  { gh = defaultGh, isInit = false, sinceIso = null, cursorIso = null } = {},
) {
  const normRepo = normalizeOptionalRepo(repo);
  if (!normRepo || typeof gh !== 'function') {
    return { prs: [], issues: [], ok: false, complete: false };
  }
  const [owner, name] = normRepo.split('/');
  // A delta fetches one item past its cap of 100 as a probe: only an item that really exists (and is newer than
  // sinceIso, since older ones stop the paging) proves the cap cut the window short.
  const prCap = isInit ? INIT_CAPS.prs : 100;
  const issueCap = isInit ? INIT_CAPS.issues : 100;
  const maxPrs = isInit ? prCap : prCap + 1;
  const maxIssues = isInit ? issueCap : issueCap + 1;
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;

  const prs = [];
  const issues = [];
  let prAfter = null;
  let issueAfter = null;
  let fetchMorePrs = true;
  let fetchMoreIssues = true;
  let ok = true;

  while ((fetchMorePrs && prs.length < maxPrs) || (fetchMoreIssues && issues.length < maxIssues)) {
    const prPageSize = fetchMorePrs ? Math.min(50, maxPrs - prs.length) : 0;
    const issuePageSize = fetchMoreIssues ? Math.min(50, maxIssues - issues.length) : 0;
    if (prPageSize <= 0 && issuePageSize <= 0) break;

    const gqlArgs = [
      'api',
      'graphql',
      '-f',
      `query=${SYNC_REPO_GQL_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `prCount=${Math.max(1, prPageSize)}`,
      '-F',
      `issueCount=${Math.max(1, issuePageSize)}`,
    ];
    if (prAfter) gqlArgs.push('-F', `prAfter=${prAfter}`);
    if (issueAfter) gqlArgs.push('-F', `issueAfter=${issueAfter}`);

    let repoData = null;
    try {
      const raw = await gh(gqlArgs);
      repoData = JSON.parse(raw)?.data?.repository ?? null;
    } catch {
      ok = false;
      break;
    }
    if (!repoData) {
      ok = false;
      break;
    }

    if (fetchMorePrs) {
      const prConn = repoData.pullRequests;
      const nodes = Array.isArray(prConn?.nodes) ? prConn.nodes : [];
      for (const n of nodes) {
        if (!n) continue;
        if (sinceMs != null && n.updatedAt && Date.parse(n.updatedAt) < sinceMs) {
          fetchMorePrs = false;
          break;
        }
        if (prs.length < maxPrs) {
          prs.push(n);
        } else {
          fetchMorePrs = false;
          break;
        }
      }
      if (!prConn?.pageInfo?.hasNextPage || !prConn?.pageInfo?.endCursor || nodes.length === 0) {
        fetchMorePrs = false;
      } else if (prs.length >= maxPrs) {
        fetchMorePrs = false;
      } else {
        prAfter = prConn.pageInfo.endCursor;
      }
    }

    if (fetchMoreIssues) {
      const issueConn = repoData.issues;
      const nodes = Array.isArray(issueConn?.nodes) ? issueConn.nodes : [];
      for (const n of nodes) {
        if (!n) continue;
        if (sinceMs != null && n.updatedAt && Date.parse(n.updatedAt) < sinceMs) {
          fetchMoreIssues = false;
          break;
        }
        if (issues.length < maxIssues) {
          issues.push(n);
        } else {
          fetchMoreIssues = false;
          break;
        }
      }
      if (!issueConn?.pageInfo?.hasNextPage || !issueConn?.pageInfo?.endCursor || nodes.length === 0) {
        fetchMoreIssues = false;
      } else if (issues.length >= maxIssues) {
        fetchMoreIssues = false;
      } else {
        issueAfter = issueConn.pageInfo.endCursor;
      }
    }
  }

  // `capped`: the fetch succeeded but the delta cap left items NEWER THAN THE CURSOR unfetched (a busy repo).
  // Unlike `ok: false` (a failed call, retried over the same window), this is a volume condition (engsys#189).
  // Items past the cap that are only inside the 48h overlap (at or before the cursor) were already ingested on an
  // earlier run, so they don't count: nothing is lost and the run is complete.
  const cursorMs = cursorIso ? Date.parse(cursorIso) : NaN;
  const lossy = (nodes, cap) => {
    if (nodes.length <= cap) return false;
    nodes.length = cap; // drop the probe item
    const oldestKept = Date.parse(nodes[cap - 1]?.updatedAt ?? '');
    return Number.isNaN(cursorMs) || Number.isNaN(oldestKept) || oldestKept > cursorMs;
  };
  const prLossy = !isInit && lossy(prs, prCap);
  const issueLossy = !isInit && lossy(issues, issueCap);
  const capped = ok && (prLossy || issueLossy);
  const complete = ok && (isInit || !capped);
  return { prs, issues, ok, complete, capped };
}

/**
 * Run a sync pass (`init`, `delta`, `publish` or `tail`). `publish` and `tail` write a memory ref and are
 * gated by `resolveWriteTarget` (who may write which ref) and, right before each ref update, the baton fence.
 */
export async function runMemorySync({
  mode = 'delta',
  repo = '',
  repoRoot = process.cwd(),
  cacheDir = resolveCacheDir(repoRoot),
  config = null,
  gh = null,
  exec = execFileSync,
  refStore = null,
  ref = EVENTS_REF,
  prNodes = null,
  issueNodes = null,
  deletedKeys = [],
  now = () => Date.now(),
  rebuildIndex = true,
  // F5 writers (§9): the baton role and fleet this run writes as, the monster state dir and session the
  // baton fence checks, and an injectable fence (default: `baton.mjs fence`). Read only by publish/tail.
  role = '',
  fleet = '',
  stateDir = '',
  session = '',
  fence = null,
  // F5 fleet signing: the private key file (default: the launcher's ENGSYS_MEMORY_SIGNING_KEY_FILE), or an
  // injected KeyObject for tests. No usable key = no write (skipped, never blocking).
  signingKeyFile = process.env.ENGSYS_MEMORY_SIGNING_KEY_FILE || '',
  signingKey = null,
} = {}) {
  const cfg = config || loadConfig(repoRoot);
  // Who may write what is decided before anything is collected or fetched: a refused run writes nothing.
  const target = resolveWriteTarget({ mode, role, fleet, ref, stateDir, repo, config: cfg });
  if (!target.ok) {
    return { ok: false, mode, refused: true, reason: target.reason, publishResult: null };
  }
  let signer = null;
  if (target.ref) {
    let privateKey = signingKey;
    if (!privateKey) {
      try {
        privateKey = readSigningKeyFile(signingKeyFile);
      } catch (e) {
        return { ok: false, mode, skipped: 'no_signing_key', reason: String(e?.message || e), publishResult: null };
      }
    }
    signer = ({ ref: signRef, parent, content }) => signTip({ privateKey, fleet, ref: signRef, parent, content });
  }
  const writeGate = target.ref ? (fence || createBatonFence({ role, repo, stateDir, session })) : null;
  const openStore = () => refStore || createMemoryRefStore({ repo, maxEvents: cfg.max_events || 20_000, now });
  if (mode === 'tail') {
    // A tail is this session's own journal, mirrored to its own ref: no GitHub fetch, and the shared
    // delta.jsonl and cursors are left alone.
    const tailEvents = journalTailEvents(stateDir, { role, fleet, repo });
    const tailResult = await openStore().writeEvents({
      ref: target.ref,
      events: tailEvents,
      message: `memory-sync: ${role}/${fleet} journal tail (${tailEvents.length})`,
      cacheDir,
      beforeCas: writeGate,
      signer,
    });
    return {
      ok: Boolean(tailResult.ok),
      mode,
      ref: target.ref,
      tailCount: tailEvents.length,
      ...(tailResult.error?.code === 'fence_refused' ? { skipped: 'baton_not_held' } : {}),
      publishResult: tailResult,
    };
  }
  const cursors = readCursors(cacheDir);
  const repoCursor = cursors[repo || '_local'] || {};
  const isInit = mode === 'init';
  const hasGhRepo = Boolean(normalizeOptionalRepo(repo));

  const prevCommitCursor = repoCursor.commitUpdatedAt ?? (!hasGhRepo ? repoCursor.updatedAt : null) ?? '';
  const prevGhCursor = repoCursor.ghUpdatedAt ?? (hasGhRepo ? repoCursor.updatedAt : null) ?? '';

  const commitSinceIso = isInit ? null : computeOverlapSince(prevCommitCursor);
  const ghSinceIso = isInit ? null : computeOverlapSince(prevGhCursor);
  const collected = [];

  // 1. Local git commits (capped at 500 on --init)
  const commitEvents = ingestLocalCommits(repoRoot, {
    repo,
    config: cfg,
    cacheDir,
    maxCount: INIT_CAPS.commits,
    since: commitSinceIso,
    exec,
    now,
  });
  collected.push(...commitEvents);

  // 2. PRs & Issues (injected nodes or fetched via GraphQL when `repo` is provided on init/delta)
  let resolvedPrNodes = prNodes;
  let resolvedIssueNodes = issueNodes;
  let ghFetchComplete = true;
  let ghFetchCapped = false;
  let ghFetched = false; // a GitHub fetch actually ran (not publish mode, not injected nodes)
  if (resolvedPrNodes !== null || resolvedIssueNodes !== null) {
    resolvedPrNodes = resolvedPrNodes ?? [];
    resolvedIssueNodes = resolvedIssueNodes ?? [];
  } else if (mode !== 'publish' && hasGhRepo) {
    const fetched = await fetchRepoPrsAndIssues(repo, {
      gh: gh || defaultGh,
      isInit,
      sinceIso: ghSinceIso,
      cursorIso: prevGhCursor || null,
    });
    resolvedPrNodes = fetched.prs;
    resolvedIssueNodes = fetched.issues;
    ghFetchComplete = Boolean(fetched.complete);
    ghFetchCapped = Boolean(fetched.capped);
    ghFetched = true;
  }

  const ghEvents = [];
  const prs = Array.isArray(resolvedPrNodes)
    ? resolvedPrNodes.slice(0, isInit ? INIT_CAPS.prs : resolvedPrNodes.length)
    : [];
  for (const pr of prs) {
    if (ghSinceIso && pr.updatedAt && Date.parse(pr.updatedAt) < Date.parse(ghSinceIso)) continue;
    ghEvents.push(...extractEventsFromPrNode(pr, { repo, config: cfg, cacheDir, now }));
  }

  const issues = Array.isArray(resolvedIssueNodes)
    ? resolvedIssueNodes.slice(0, isInit ? INIT_CAPS.issues : resolvedIssueNodes.length)
    : [];
  for (const issue of issues) {
    if (ghSinceIso && issue.updatedAt && Date.parse(issue.updatedAt) < Date.parse(ghSinceIso)) continue;
    ghEvents.push(...extractEventsFromIssueNode(issue, { repo, config: cfg, cacheDir, now }));
  }
  collected.push(...ghEvents);

  // 3. Explicit tombstones for deleted sources (§7.5)
  const nowIso = new Date(now()).toISOString();
  for (const k of deletedKeys) {
    if (!k) continue;
    collected.push({ k, id: k, deleted: true, updated_at: nowIso });
  }

  // 4. Merge into delta.jsonl and advance cursors independently for local commits vs GitHub PRs/issues
  const mergedDelta = writeDeltaEvents(cacheDir, collected);
  let nextCommitCursor = prevCommitCursor;
  for (const ev of commitEvents) {
    if (ev.updated_at && String(ev.updated_at) > nextCommitCursor) {
      nextCommitCursor = String(ev.updated_at);
    }
  }
  // The GraphQL connections are newest-first. A fetch that hit the delta page cap ingested the newest N
  // items, so its cursor still moves forward to the newest of them; holding it would make every later
  // heartbeat re-query the same ever-growing window and hit the cap again, forever (engsys#189). That is
  // the same "newest N" truncation --init accepts: the items between the old cursor and the oldest ingested
  // one are skipped, so a capped run is counted (ghCappedStreak); `main` warns on stderr from the 3rd, and the
  // heartbeat path (monster_memory_tail_sync) forwards that line and keeps it in <state>/memory-sync-capped.warn. A failed
  // fetch (ok: false) keeps the cursor: nothing was lost, and the retry covers the same window.
  const ghAdvance = ghFetchComplete || ghFetchCapped;
  const prevCappedStreak = Number.isInteger(repoCursor.ghCappedStreak) ? repoCursor.ghCappedStreak : 0;
  const ghCappedStreak = ghFetchCapped ? prevCappedStreak + 1 : ghFetched && ghFetchComplete ? 0 : prevCappedStreak;
  let nextGhCursor = prevGhCursor;
  if (ghAdvance) {
    for (const ev of ghEvents) {
      if (ev.updated_at && String(ev.updated_at) > nextGhCursor) {
        nextGhCursor = String(ev.updated_at);
      }
    }
  }
  const effectiveUpdatedAt = hasGhRepo
    ? nextGhCursor || (ghAdvance ? nextCommitCursor || nowIso : prevGhCursor)
    : nextCommitCursor || prevCommitCursor || nowIso;

  cursors[repo || '_local'] = {
    updatedAt: effectiveUpdatedAt,
    ghUpdatedAt: nextGhCursor || null,
    ghCappedStreak,
    commitUpdatedAt: nextCommitCursor || null,
    lastMode: mode,
    syncedAt: nowIso,
  };
  writeCursors(cacheDir, cursors);

  // 5. Rebuild local SQLite FTS index if requested
  if (rebuildIndex) {
    try {
      ensureIndex({ repoRoot, cacheDir });
    } catch {
      // Fail-open
    }
  }

  // 6. Publish to refs/engsys/memory/* if mode === 'publish'
  let publishResult = null;
  if (mode === 'publish') {
    publishResult = await openStore().writeEvents({
      ref: target.ref,
      events: mergedDelta,
      message: `memory-sync: publish ${mergedDelta.length} events`,
      cacheDir,
      beforeCas: writeGate,
      signer,
    });
  }

  return {
    ok: publishResult ? Boolean(publishResult.ok) : true,
    mode,
    ...(publishResult?.error?.code === 'fence_refused' ? { skipped: 'baton_not_held' } : {}),
    collectedCount: collected.length,
    deltaCount: mergedDelta.length,
    sinceIso: hasGhRepo ? ghSinceIso : commitSinceIso,
    ghSinceIso,
    commitSinceIso,
    cursorUpdatedAt: effectiveUpdatedAt,
    ghCapped: ghFetchCapped,
    ghCappedStreak,
    publishResult,
  };
}

const CAPPED_STREAK_WARN = 3; // consecutive capped delta runs before `main` warns on stderr

/** The stderr warning for a run of capped delta fetches ('' until the streak reaches CAPPED_STREAK_WARN). */
export function cappedWarning(res, repoName) {
  const streak = res?.ghCappedStreak ?? 0;
  if (streak < CAPPED_STREAK_WARN) return '';
  return `memory-sync: ${repoName || 'the repo'} hit the GraphQL page cap on ${streak} consecutive delta runs; items newer than the cursor may have been skipped. Run the heartbeat more often or raise the caps.\n`;
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      init: { type: 'boolean', default: false },
      delta: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      repo: { type: 'string', default: '' },
      'repo-root': { type: 'string', default: process.cwd() },
      'cache-dir': { type: 'string', default: '' },
      ref: { type: 'string', default: EVENTS_REF },
      role: { type: 'string', default: '' },
      fleet: { type: 'string', default: '' },
      tail: { type: 'boolean', default: false },
      'state-dir': { type: 'string', default: '' },
      session: { type: 'string', default: '' },
      'signing-key-file': { type: 'string', default: '' },
    },
    strict: false,
  });

  const modes = ['init', 'delta', 'publish', 'tail'].filter((m) => values[m]);
  if (modes.length > 1) {
    err.write(`memory-sync: pick one of --init, --delta, --publish, --tail (got ${modes.map((m) => `--${m}`).join(' ')})\n`);
    return 2;
  }
  const mode = modes[0] || 'delta';
  const repoRoot = path.resolve(String(values['repo-root'] || process.cwd()));
  const cacheDir = values['cache-dir']
    ? path.resolve(String(values['cache-dir']))
    : resolveCacheDir(repoRoot);
  const stateDir = values['state-dir'] ? path.resolve(String(values['state-dir'])) : '';

  try {
    const res = await runMemorySync({
      mode,
      repo: String(values.repo || ''),
      repoRoot,
      cacheDir,
      ref: String(values.ref || EVENTS_REF),
      role: String(values.role || ''),
      fleet: String(values.fleet || ''),
      stateDir,
      session: String(values.session || ''),
      ...(values['signing-key-file'] ? { signingKeyFile: path.resolve(String(values['signing-key-file'])) } : {}),
    });
    out.write(JSON.stringify(res) + '\n');
    if (res.refused) {
      err.write(`memory-sync: refused: ${res.reason}\n`);
      return 2;
    }
    if (res.skipped === 'no_signing_key') err.write(`memory-sync: not written, no usable signing key: ${res.reason}\n`);
    const warning = cappedWarning(res, String(values.repo || ''));
    if (warning) err.write(warning);
    return res.ok ? 0 : 1;
  } catch (e) {
    err.write(`memory-sync error: ${e?.message || e}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  main().then((code) => exitAfterFlush(code));
}
