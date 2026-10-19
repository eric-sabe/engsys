#!/usr/bin/env node
// security-verdict.mjs — signed `nyx-review` verdicts (engsys#197, option B).
//
// WHAT IT IS. A security-lane session posts its `nyx-review` verdict with an HMAC-SHA256 over the repo,
// PR number, head SHA, verdict, a timestamp, a nonce and a hash of the review text. Merge-monster
// (mm-preflight.sh --security-verdict) recomputes the MAC and accepts a verdict only when it verifies
// against the CURRENT head SHA. The key lives in a fleet-owned file (mode 0600); the launcher hands
// only the PATH of that file to security-lane sessions (ENGSYS_SECURITY_VERDICT_KEY_FILE), never to
// interactive roles, so a verdict posted from an interactive session carries no valid MAC.
//
// WHAT IT IS NOT. Defence in depth, NOT a security boundary. The key file is readable by any process
// running as the same OS user, so an attended session with a shell can read it and forge a MAC. It stops
// accidental and naive forgery (an interactive or unverified-config session posting a verdict by
// habit, a copied verdict replayed on a new head SHA, a tampered review body), not a hostile session
// on the same account. The boundary is a separate GitHub identity for the security lane (option A,
// tracked in engsys#197's follow-up). docs/fleet-guide.md and the merge-monster skill say the same.
//
// Comment layout (the first marker keeps the existing `nyx-review` convention):
//   <!-- nyx-review -->
//   NYX-VERDICT: PASS | FINDINGS
//   <!-- nyx-verdict-sig v1 sha=<40 hex> verdict=<PASS|FINDINGS> ts=<unix seconds> nonce=<16 hex> body=<64 hex> mac=<64 hex> -->
//   <review text>
//
// Usage:
//   security-verdict.mjs keygen --key-file PATH           create PATH (0600, never overwrites)
//   security-verdict.mjs post --repo O/N --pr N --sha SHA --verdict PASS|FINDINGS --body-file F
//                                                         (needs ENGSYS_SECURITY_VERDICT_KEY_FILE)
//   security-verdict.mjs verify --repo O/N --pr N --sha SHA --key-file PATH [--require] [--max-age-hours H]
//                                                         (comments as JSON on stdin: gh's `comments` array)
// verify prints one JSON object. Exit: 0 ok (or nothing to check) | 1 not verified | 4 verified FINDINGS |
// 2 usage | 3 error (unreadable key, gh failure): never act on 3.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMainEntry } from './is-main.mjs';

export const MARKER = '<!-- nyx-review -->';
export const VERDICTS = ['PASS', 'FINDINGS'];
const DOMAIN = 'engsys-nyx-verdict-v1';
const MIN_KEY_BYTES = 32;
const DEFAULT_MAX_AGE_SEC = 7 * 24 * 3600;
const FUTURE_SKEW_SEC = 300;

const SIG_RE =
  /^<!-- nyx-verdict-sig v1 sha=([0-9a-f]{40}) verdict=(PASS|FINDINGS) ts=(\d{1,12}) nonce=([0-9a-f]{16}) body=([0-9a-f]{64}) mac=([0-9a-f]{64}) -->$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Create the key file: 32 random bytes as hex, mode 0600, exclusive create. Never overwrites. */
export function generateKeyFile(file) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, `${crypto.randomBytes(MIN_KEY_BYTES).toString('hex')}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

/**
 * Read the key. Fails closed (throws) unless the path is a regular file (not a symlink) owned by this
 * user with no group/other permission bits, holding at least 32 bytes of hex.
 */
export function readKeyFile(file) {
  if (typeof file !== 'string' || !file) throw new Error('no key file configured');
  // Opened with O_NOFOLLOW and checked with fstat on the descriptor we read from, so a symlink (or a swap
  // between a check and a read) can't redirect the read to another file.
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') throw new Error(`key file ${file} is not a regular file (symlink)`);
    throw err;
  }
  let hex;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`key file ${file} is not a regular file`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`key file ${file} is not owned by this user`);
    if ((st.mode & 0o077) !== 0) throw new Error(`key file ${file} must not be readable by group or other (mode ${(st.mode & 0o777).toString(8)})`);
    hex = fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < MIN_KEY_BYTES * 2 || hex.length % 2 !== 0) throw new Error(`key file ${file} does not hold a hex key of at least ${MIN_KEY_BYTES} bytes`);
  return Buffer.from(hex, 'hex');
}

/** The review text as signed: CRs removed and outer whitespace trimmed (GitHub normalizes line endings). */
export function normalizeBody(text) {
  return String(text ?? '').replace(/\r/g, '').trim();
}

function bodyHash(text) {
  return crypto.createHash('sha256').update(normalizeBody(text)).digest('hex');
}

function macOf(key, { repo, pr, sha, verdict, ts, nonce, body }) {
  const msg = [DOMAIN, String(repo).toLowerCase(), String(pr), String(sha).toLowerCase(), verdict, String(ts), nonce, body].join('\n');
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

/** Compose the full comment body for a verdict. Throws on malformed input (never signs a bad claim). */
export function signVerdict({ key, repo, pr, sha, verdict, reviewText = '', now = () => Date.now(), nonce = crypto.randomBytes(8).toString('hex') }) {
  if (!Buffer.isBuffer(key) || key.length < MIN_KEY_BYTES) throw new Error('bad key');
  if (!REPO_RE.test(String(repo))) throw new Error(`bad repo ${JSON.stringify(repo)}`);
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) throw new Error(`bad PR number ${JSON.stringify(pr)}`);
  if (!SHA_RE.test(String(sha).toLowerCase())) throw new Error('sha must be a full 40-hex head SHA');
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`);
  const ts = Math.floor(now() / 1000);
  const fields = { repo, pr: Number(pr), sha: String(sha).toLowerCase(), verdict, ts, nonce, body: bodyHash(reviewText) };
  const mac = macOf(key, fields);
  return [
    MARKER,
    `NYX-VERDICT: ${verdict}`,
    `<!-- nyx-verdict-sig v1 sha=${fields.sha} verdict=${verdict} ts=${ts} nonce=${nonce} body=${fields.body} mac=${mac} -->`,
    '',
    normalizeBody(reviewText),
    '',
  ].join('\n');
}

/** True for a comment that claims to be a nyx-review verdict (starts with the marker). */
export function claimsNyxReview(body) {
  // The exact marker only (`<!-- nyx-review -->`), at the start: `<!-- nyx-review-anything` is not a claim.
  return /^\s*<!-- nyx-review -->/.test(String(body ?? ''));
}

/**
 * Check ONE comment body. Returns { state, reason, ... } where state is:
 *   'valid'   MAC verifies for this repo/PR and sha === headSha
 *   'stale'   MAC verifies but for another head SHA (never counts for the current head)
 *   'invalid' no/odd signature, bad MAC, tampered text, wrong repo/PR, verdict mismatch, bad timestamp
 */
export function checkVerdictBody({ key, repo, pr, headSha, body, now = () => Date.now(), maxAgeSec = DEFAULT_MAX_AGE_SEC }) {
  const lines = normalizeBody(body).split('\n');
  if ((lines[0] ?? '').trim() !== MARKER) return { state: 'invalid', reason: 'marker_not_first_line' };
  const vm = /^NYX-VERDICT:\s*(PASS|FINDINGS)\s*$/.exec(lines[1] ?? '');
  if (!vm) return { state: 'invalid', reason: 'verdict_line_missing' };
  const sm = SIG_RE.exec((lines[2] ?? '').trim());
  if (!sm) return { state: 'invalid', reason: 'signature_missing_or_malformed' };
  const [, sha, signedVerdict, tsStr, nonce, bodyH, mac] = sm;
  if (signedVerdict !== vm[1]) return { state: 'invalid', reason: 'verdict_line_differs_from_signed_verdict' };
  const reviewText = lines.slice(3).join('\n');
  if (bodyHash(reviewText) !== bodyH) return { state: 'invalid', reason: 'review_text_tampered' };
  const ts = Number(tsStr);
  const nowSec = Math.floor(now() / 1000);
  if (ts > nowSec + FUTURE_SKEW_SEC) return { state: 'invalid', reason: 'timestamp_in_future' };
  const want = macOf(key, { repo, pr, sha, verdict: signedVerdict, ts, nonce, body: bodyH });
  const a = Buffer.from(want, 'hex');
  const b = Buffer.from(mac, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { state: 'invalid', reason: 'bad_mac' };
  // From here the MAC verified: `verdict`, `ts`, `nonce` and `sha` are authentic whatever the state below.
  const authentic = { verdict: signedVerdict, ts, nonce, sha };
  if (sha !== String(headSha).toLowerCase()) return { state: 'stale', reason: 'signed_for_another_head', ...authentic };
  if (maxAgeSec > 0 && nowSec - ts > maxAgeSec) return { state: 'stale', reason: 'expired', ...authentic };
  return { state: 'valid', ...authentic };
}

/**
 * Decide the security gate for a PR from its comments (gh's `comments` array: {body, createdAt, author}).
 * Only comments whose MAC verifies ("authentic") take part; they are ranked by their SIGNED timestamp, never
 * by the comment's createdAt (anyone can re-post an old authentic body, which would otherwise outrank a
 * later verdict), a repeated nonce counts once, and on equal timestamps FINDINGS outranks PASS. The latest
 * authentic verdict L decides:
 *   - L is FINDINGS, for ANY head -> not ok (exit 4), in both modes. It is sticky: pushing a new commit
 *     does not clear it, only a fresh signed verdict for the current head (later than L) does.
 *   - L is PASS signed for the current head -> ok (verified).
 *   - otherwise (nothing authentic, or L is a PASS for an earlier head or expired):
 *       `require` -> not ok (no_valid_verdict);
 *       a nyx-review claim that is invalid (unsigned, forged, tampered) -> not ok (forged_or_unsigned): a
 *       claimed verdict that does not verify never passes silently;
 *       else ok, state 'none'.
 * Invalid comments are ignored when an authentic verdict decides. Returns { ok, state, reason, exit, counts };
 * exit: 0 ok | 1 not ok | 4 findings.
 */
export function evaluateSecurityVerdicts({ key, repo, pr, headSha, comments, require = false, now = () => Date.now(), maxAgeSec = DEFAULT_MAX_AGE_SEC }) {
  if (!SHA_RE.test(String(headSha ?? '').toLowerCase())) return { ok: false, state: 'error', reason: 'head_sha_unknown', exit: 1, counts: {} };
  const counts = { claimed: 0, valid: 0, stale: 0, invalid: 0, duplicate: 0 };
  const nonces = new Set();
  let latest = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!claimsNyxReview(c?.body)) continue;
    counts.claimed += 1;
    const r = checkVerdictBody({ key, repo, pr, headSha, body: c.body, now, maxAgeSec });
    if (r.nonce === undefined) { counts.invalid += 1; continue; } // MAC did not verify
    if (nonces.has(r.nonce)) { counts.duplicate += 1; continue; } // a re-post of an authentic body
    nonces.add(r.nonce);
    counts[r.state] += 1;
    if (!latest || r.ts > latest.ts || (r.ts === latest.ts && r.verdict === 'FINDINGS')) latest = r;
  }
  if (latest?.verdict === 'FINDINGS') {
    return {
      ok: false,
      state: 'findings',
      reason: latest.sha === String(headSha).toLowerCase() ? 'signed_findings_for_head' : 'signed_findings_on_earlier_head_unresolved',
      exit: 4,
      counts,
    };
  }
  if (latest?.state === 'valid') return { ok: true, state: 'verified', reason: 'signed_pass_for_head', exit: 0, counts };
  if (require) return { ok: false, state: 'missing', reason: 'no_valid_verdict', exit: 1, counts };
  if (counts.invalid > 0) return { ok: false, state: 'invalid', reason: 'forged_or_unsigned', exit: 1, counts };
  return { ok: true, state: 'none', reason: counts.stale > 0 ? 'only_stale_verdicts' : 'no_verdict_claimed', exit: 0, counts };
}

// ---------------------------------------------------------------------------------------------- CLI

function die(msg, code) {
  process.stderr.write(`security-verdict: ${msg}\n`);
  process.exit(code);
}

export async function main(argv = process.argv.slice(2), { exec = execFileSync, env = process.env, readStdin = () => fs.readFileSync(0, 'utf8'), now = () => Date.now() } = {}) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'key-file': { type: 'string' }, repo: { type: 'string' }, pr: { type: 'string' }, sha: { type: 'string' },
      verdict: { type: 'string' }, 'body-file': { type: 'string' }, require: { type: 'boolean', default: false },
      'max-age-hours': { type: 'string' },
    },
    strict: true,
  });
  if (cmd === 'keygen') {
    if (!values['key-file']) die('usage: keygen --key-file PATH', 2);
    try { generateKeyFile(values['key-file']); } catch (e) { die(`keygen: ${e.message}`, 3); }
    return 0;
  }
  if (cmd === 'post') {
    const { repo, pr, sha, verdict } = values;
    if (!repo || !pr || !sha || !verdict || !values['body-file']) die('usage: post --repo O/N --pr N --sha SHA --verdict PASS|FINDINGS --body-file F', 2);
    // Only a security-lane session is handed the key file path (the launcher unsets it everywhere else).
    const keyFile = env.ENGSYS_SECURITY_VERDICT_KEY_FILE;
    if (!keyFile) die('not a security-lane session (ENGSYS_SECURITY_VERDICT_KEY_FILE is unset); refusing to sign a verdict', 1);
    let key;
    try { key = readKeyFile(keyFile); } catch (e) { die(e.message, 3); }
    // Never sign a verdict for a SHA that is not the PR's head right now.
    let head;
    try {
      head = exec('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'headRefOid', '--jq', '.headRefOid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim().toLowerCase();
    } catch (e) { die(`could not read the PR head: ${e.message}`, 3); }
    if (head !== String(sha).toLowerCase()) die(`--sha ${sha} is not the PR head ${head}; refusing to sign`, 1);
    let comment;
    try {
      comment = signVerdict({ key, repo, pr, sha, verdict, reviewText: fs.readFileSync(values['body-file'], 'utf8'), now });
    } catch (e) { die(e.message, 2); }
    const tmp = `${values['body-file']}.signed.${crypto.randomBytes(6).toString('hex')}`;
    // Exclusive create (wx) with mode 0600: never follows or reuses an existing path.
    fs.writeFileSync(tmp, comment, { mode: 0o600, flag: 'wx' });
    try {
      exec('gh', ['pr', 'comment', String(pr), '-R', repo, '--body-file', tmp], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000 });
    } catch (e) { die(`gh pr comment failed: ${e.message}`, 3); } finally { fs.rmSync(tmp, { force: true }); }
    return 0;
  }
  if (cmd === 'verify') {
    const { repo, pr, sha } = values;
    if (!repo || !pr || !sha || !values['key-file']) die('usage: verify --repo O/N --pr N --sha SHA --key-file PATH [--require] [--max-age-hours H]', 2);
    let key;
    try { key = readKeyFile(values['key-file']); } catch (e) {
      process.stdout.write(`${JSON.stringify({ ok: false, state: 'error', reason: `key_unavailable: ${e.message}` })}\n`);
      return 3;
    }
    let comments;
    try { comments = JSON.parse(readStdin()); } catch { die('stdin must be the PR comments as a JSON array', 2); }
    const maxAgeSec = values['max-age-hours'] != null ? Number(values['max-age-hours']) * 3600 : DEFAULT_MAX_AGE_SEC;
    if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) die('--max-age-hours must be a non-negative number', 2);
    const r = evaluateSecurityVerdicts({ key, repo, pr, headSha: sha, comments, require: values.require, now, maxAgeSec });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.exit;
  }
  return die('usage: security-verdict.mjs keygen|post|verify ...', 2);
}

if (isMainEntry(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => die(e.message, 3));
}
