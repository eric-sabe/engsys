#!/usr/bin/env node
// fleet-msg.mjs — the cross-fleet message format and its sender check (multi-fleet P2-A, engsys#76).
// Design: docs/multi-fleet.md § 4 "Talking between fleets". Delivery is the relay (core/fleet/relay.mjs,
// #77); sending is `fleet msg send` (core/fleet/msg.mjs).
//
// A cross-fleet message is a GitHub issue or PR comment whose FIRST line is the header:
//
//   <!-- fleet-msg to="bob:acme-build" from="alice:acme-mm" re="acme/app#412" protocol="1" -->
//   Bounced #412: the migration has no down step. Details in the review comment above.
//
// Public API (pure, node builtins only):
//   PROTOCOL, KNOWN_PROTOCOLS               the protocol this kit writes, and the ones it reads
//   ADDRESS_RE, RE_RE                       `<fleet>:<session>`, `owner/repo#n`
//   hasMarker(text)                         does text contain a fleet-msg header, obfuscated or not
//   render({ to, from, re, body })          the comment body; throws FleetMsgError on bad input
//   parse(commentBody)                      null (no marker) | { ok: true, msg } | { ok: false, code, reason }
//   verify(msg, comment, registry, opts)    { ok: true } | { ok: false, code, reason }
//   REASONS                                 every rejection code parse and verify return
//
// Trust model. The comment body is attacker-influenceable text. parse() reads it against one strict,
// anchored grammar and returns only values that match fixed character classes; nothing else in the
// body is interpreted. Rejection reasons never quote the body: they name an attribute or carry a
// value that already matched its pattern. The sender's identity comes only from the API's
// `user.login` and `user.type` fields, matched against the registry (`<github_app>[bot]` of an
// enabled fleet). An accepted message is a pointer, never authority: receivers re-read GitHub before
// acting on anything it mentions.

import { normalizeUntrusted } from '../../lib/untrusted.mjs';

/** The protocol this kit writes. */
export const PROTOCOL = 1;
/** The protocols this kit can read. A newer one means the sender runs a newer kit: sync the pins. */
export const KNOWN_PROTOCOLS = Object.freeze([1]);

/** `<fleet>:<session>`: a FLEET_ID (federation.mjs FLEET_ID_RE) and a roster session name, capped at 64. */
export const ADDRESS_RE = /^([a-z][a-z0-9-]{1,20}):([a-z0-9][a-z0-9-]{0,63})$/;
/** `owner/repo#n`. */
export const RE_RE = /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;
const PROTOCOL_RE = /^[1-9][0-9]{0,5}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BOT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\[bot\]$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/** The header, anchored at the very start of the comment: single spaces, double-quoted values. */
const HEADER_RE = /^<!-- fleet-msg((?: [a-z]{1,20}="[^"\r\n]{0,200}")+) -->(?:\r?\n|$)/;
const ATTR_RE = /^ ([a-z]{1,20})="([^"\r\n]{0,200})"/;
const ATTRS = Object.freeze(['to', 'from', 're', 'protocol']);
const REQUIRED = Object.freeze(['to', 'from', 'protocol']);
/** A header opener, after NFKC + invisible-character stripping + homoglyph folding. */
const MARKER_RE = /<!--\s*fleet-msg/i;

/** Every rejection code, with what it means (the relay logs the code and a reason built from it). */
export const REASONS = Object.freeze({
  // parse
  malformed: 'the header is not the first line, or does not follow the grammar',
  'unknown-attribute': 'the header has an attribute other than to, from, re, protocol',
  'duplicate-attribute': 'the header repeats an attribute',
  'missing-attribute': 'the header lacks to, from or protocol',
  'bad-address': 'to or from is not <fleet>:<session>',
  'bad-re': 're is not owner/repo#n',
  'bad-protocol': 'protocol is not a positive integer',
  'multiple-blocks': 'the comment carries more than one fleet-msg header',
  // verify
  'no-registry': 'no registry, or FLEET_ID is not declared in it',
  'not-for-us': 'the message is addressed to another fleet',
  'bad-comment': 'the comment lacks the API fields the check needs',
  'author-not-bot': 'the comment author is not a GitHub App bot',
  'author-unregistered': 'the comment author is not the App of any fleet in the registry',
  'author-shared-app': 'several fleets share the author App, so the sender cannot be told apart',
  'author-app-mismatch': 'the comment was not made through the App id the registry pins for that fleet',
  'author-app-unpinned': 'the registry has two or more enabled fleets but no github_app_id for the sender',
  'sender-mismatch': 'the from fleet is not the fleet whose App wrote the comment',
  'sender-disabled': 'the sending fleet is disabled in the registry',
  'self-sender': 'a message from this fleet to itself (same-fleet messages use SendMessage)',
  edited: 'the comment was edited after it was posted',
  'protocol-newer': 'the protocol is newer than this kit knows',
  'protocol-unknown': 'the protocol is not one this kit reads',
  'unknown-session': 'the to session is not in this fleet\'s roster',
  're-unlisted': 're names a repo that is neither in the registry nor the instance repo',
  're-unconfirmed': 'the PR or issue named by re could not be confirmed to exist',
});

export class FleetMsgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FleetMsgError';
  }
}

const reject = (code, detail) => ({ ok: false, code, reason: detail ? `${REASONS[code]} (${detail})` : REASONS[code] });

/** True when text contains a fleet-msg header opener, including obfuscated spellings. */
export function hasMarker(text) {
  if (typeof text !== 'string' || text === '') return false;
  return MARKER_RE.test(text) || MARKER_RE.test(normalizeUntrusted(text));
}

function address(value) {
  const m = ADDRESS_RE.exec(value);
  return m ? { address: value, fleet: m[1], session: m[2] } : null;
}

function reference(value) {
  const m = RE_RE.exec(value);
  return m ? { ref: value, repo: m[1], number: Number(m[2]) } : null;
}

/**
 * Render a message comment. `re` is optional (owner/repo#n). The header is generated here and only
 * here; a body that carries a header of its own (in any spelling) is refused.
 */
export function render({ to, from, re = null, body } = {}) {
  if (!address(to ?? '')) throw new FleetMsgError(`to must be <fleet>:<session>, got ${JSON.stringify(to)}`);
  if (!address(from ?? '')) throw new FleetMsgError(`from must be <fleet>:<session>, got ${JSON.stringify(from)}`);
  if (re !== null && re !== undefined && re !== '' && !reference(re)) throw new FleetMsgError(`re must be owner/repo#n, got ${JSON.stringify(re)}`);
  if (typeof body !== 'string' || body.trim() === '') throw new FleetMsgError('the message body is empty');
  if (hasMarker(body)) throw new FleetMsgError('the body contains a fleet-msg header; the header is generated, never taken from the body');
  const reAttr = re ? ` re="${re}"` : '';
  return `<!-- fleet-msg to="${to}" from="${from}"${reAttr} protocol="${PROTOCOL}" -->\n${body.trimEnd()}`;
}

/**
 * Parse a comment body. Returns null when it carries no fleet-msg marker at all (an ordinary comment),
 * `{ ok: true, msg }` for a well-formed message, else `{ ok: false, code, reason }`.
 * msg = { to: {address, fleet, session}, from: {...}, re: {ref, repo, number} | null, protocol, body }.
 */
export function parse(commentBody) {
  if (!hasMarker(commentBody)) return null;
  const m = HEADER_RE.exec(commentBody);
  if (!m) return reject('malformed');
  const attrs = Object.create(null);
  let rest = m[1];
  while (rest.length) {
    const a = ATTR_RE.exec(rest);
    if (!a) return reject('malformed');
    const [whole, key, value] = a;
    if (!ATTRS.includes(key)) return reject('unknown-attribute', key);
    if (key in attrs) return reject('duplicate-attribute', key);
    attrs[key] = value;
    rest = rest.slice(whole.length);
  }
  for (const k of REQUIRED) if (!(k in attrs)) return reject('missing-attribute', k);
  const to = address(attrs.to);
  if (!to) return reject('bad-address', 'to');
  const from = address(attrs.from);
  if (!from) return reject('bad-address', 'from');
  let re = null;
  if (attrs.re !== undefined && attrs.re !== '') {
    re = reference(attrs.re);
    if (!re) return reject('bad-re');
  }
  if (!PROTOCOL_RE.test(attrs.protocol)) return reject('bad-protocol');
  const body = commentBody.slice(m[0].length);
  if (hasMarker(body)) return reject('multiple-blocks');
  return { ok: true, msg: { to, from, re, protocol: Number(attrs.protocol), body } };
}

/**
 * Decide whether a parsed message is accepted. Pure: everything it needs is passed in.
 *   msg        parse(...).msg
 *   comment    the REST issue comment ({ user: { login, type }, performed_via_github_app: { id },
 *              created_at, updated_at })
 *   registry   loadFederation(...) output (validated, defaults filled in)
 *   opts.selfFleet     FLEET_ID of the receiving fleet
 *   opts.instanceRepo  owner/name of the instance repo (holds the status issues), or null
 *   opts.roster        session names of this fleet; when non-empty, `to` must name one
 *   opts.reExists      true once the caller confirmed the `re` PR/issue exists; anything else rejects
 *                      a message with `re` as 're-unconfirmed' (the caller confirms, then asks again)
 */
export function verify(msg, comment, registry, { selfFleet = null, instanceRepo = null, roster = null, reExists } = {}) {
  if (!registry?.fleets || !selfFleet || !registry.fleets[selfFleet]) return reject('no-registry');
  if (msg.to.fleet !== selfFleet) return reject('not-for-us', msg.to.fleet);

  const login = comment?.user?.login;
  if (typeof login !== 'string' || !ISO_RE.test(comment?.created_at ?? '') || typeof comment?.updated_at !== 'string') return reject('bad-comment');
  if (comment.user.type !== 'Bot' || !BOT_LOGIN_RE.test(login)) return reject('author-not-bot');

  const slug = login.slice(0, -'[bot]'.length).toLowerCase();
  const authors = Object.keys(registry.fleets).filter((id) => registry.fleets[id].github_app === slug);
  if (authors.length === 0) return reject('author-unregistered', login);
  if (authors.length > 1) return reject('author-shared-app', `${login}: ${authors.join(', ')}`);
  const author = authors[0];
  if (author !== msg.from.fleet) return reject('sender-mismatch', `written by ${author}'s App, claims ${msg.from.fleet}`);
  if (!registry.fleets[author].enabled) return reject('sender-disabled', author);
  // The login slug alone can be re-registered once an App is renamed or deleted; the numeric App id
  // (performed_via_github_app.id, which the issue-comments API returns for every App-made comment)
  // cannot. Required once messages can flow, i.e. with two or more enabled fleets.
  const appId = registry.fleets[author].github_app_id;
  if (appId) {
    if (comment.performed_via_github_app?.id !== appId) return reject('author-app-mismatch', `${author} pins App id ${appId}`);
  } else if (Object.values(registry.fleets).filter((f) => f.enabled).length >= 2) {
    return reject('author-app-unpinned', `set fleets.${author}.github_app_id`);
  }
  if (author === selfFleet) return reject('self-sender');

  if (comment.updated_at !== comment.created_at) return reject('edited');

  const newest = Math.max(...KNOWN_PROTOCOLS);
  if (msg.protocol > newest) return reject('protocol-newer', `protocol ${msg.protocol}, this kit reads up to ${newest}: sync your pins`);
  if (!KNOWN_PROTOCOLS.includes(msg.protocol)) return reject('protocol-unknown', `protocol ${msg.protocol}`);

  if (Array.isArray(roster) && roster.length && !roster.includes(msg.to.session)) return reject('unknown-session', msg.to.session);

  if (msg.re) {
    const listed = Object.keys(registry.repos ?? {}).some((r) => r.toLowerCase() === msg.re.repo.toLowerCase());
    const isInstance = typeof instanceRepo === 'string' && REPO_RE.test(instanceRepo) && instanceRepo.toLowerCase() === msg.re.repo.toLowerCase();
    if (!listed && !isInstance) return reject('re-unlisted', msg.re.repo);
    if (reExists !== true) return reject('re-unconfirmed', msg.re.ref);
  }
  return { ok: true };
}
