#!/usr/bin/env node
// signing.mjs — per-fleet Ed25519 signatures on refs/engsys/memory/* (F5, FeedFrwd/ff-engsys-fleet#60;
// docs/memory-spec.md §9).
//
// WHY. A ref tip's GitHub metadata can't say which fleet wrote it: commits made through the Git Data API are
// committed by `web-flow` (GitHub signs them), with the App's bot only as the AUTHOR, which GitHub derives from
// an email address the caller chooses. So the publisher signs the content itself, with a key only its fleet's
// monsters are handed, and a reader verifies against the public keys in the operator's reviewed, hash-pinned
// memory.yml (`fleet_memory_pubkeys`: one key or a list of keys per fleet).
//
// WHAT IS SIGNED. One payload binds the signature to everything that makes a tip what it is, so a signature can't
// be replayed onto another ref, another parent or other content:
//   engsys-memory-ref-sig\nv1\nfleet=<fleet>\nref=<full ref>\nparent=<40/64 hex | none>\ncontent=<sha256 hex of events.jsonl>\n
// It is stored next to `events.jsonl` in the commit tree as `events.sig`, ONE line, parsed strictly:
//   engsys-memory-sig v1 fleet=<fleet> ref=<ref> parent=<sha|none> content=<sha256> sig=<base64 Ed25519 signature>
// A reader recomputes ref (the ref it read), parent (the commit's own parent) and content (the blob it read) and
// verifies over THOSE, never the values the line claims; the claimed values must also match exactly, so a line that
// disagrees with its commit is rejected even before the signature is checked.
//
// WHAT IT IS NOT. Defence in depth, not an OS boundary: the private key file is mode 0600, but any process running as
// the same OS user can read it (the same caveat as core/lib/security-verdict.mjs). It does stop anyone holding only
// repo `contents: write` (or the bot's token on another host) from writing a ref a reader trusts.
//
// Usage:
//   signing.mjs keygen --key-file PATH                 create PATH (Ed25519 private key, PKCS#8 PEM, 0600; never overwrites)
//   signing.mjs pubkey --key-file PATH [--fleet ID]    print this key's public half as a memory.yml entry (a one-key list)

import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../is-main.mjs';

export const SIG_DOMAIN = 'engsys-memory-ref-sig';
export const SIG_VERSION = 'v1';
export const SIG_FILE = 'events.sig';
// A ref path segment (git check-ref-format rules, as validateMemoryRef applies them): no leading dot (so never `.`,
// `..` or `.git`), no `..` anywhere, no `.lock` suffix. FLEET_ID_RE is one such segment, 1-40 characters.
const SEGMENT_SRC = '(?!\\.)(?![A-Za-z0-9._-]*\\.\\.)(?![A-Za-z0-9._-]*\\.lock(?![A-Za-z0-9._-]))[A-Za-z0-9._-]';
export const FLEET_ID_RE = new RegExp(`^${SEGMENT_SRC}{1,40}$`);
export const REF_SEGMENT_RE = new RegExp(`^${SEGMENT_SRC}+$`);
const REF_RE = new RegExp(`^refs/engsys/memory/${SEGMENT_SRC}+(?:/${SEGMENT_SRC}+)?$`);
const PARENT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|none)$/;
const CONTENT_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const SIG_B64_RE = /^[A-Za-z0-9+/]{86}==$/;
const SIG_LINE_RE =
  /^engsys-memory-sig v1 fleet=([A-Za-z0-9._-]{1,40}) ref=(\S+) parent=([0-9a-f]{40}|[0-9a-f]{64}|none) content=([0-9a-f]{64}) sig=([A-Za-z0-9+/]{86}==)$/;

/** sha256 hex of the events blob exactly as stored. */
export function contentDigest(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

/** The exact bytes that are signed. Throws on any field outside its strict shape. */
export function signingPayload({ fleet, ref, parent, content }) {
  if (!FLEET_ID_RE.test(String(fleet ?? ''))) throw new Error(`signingPayload: invalid fleet ${JSON.stringify(fleet)}`);
  if (!REF_RE.test(String(ref ?? ''))) throw new Error(`signingPayload: invalid ref ${JSON.stringify(ref)}`);
  const p = parent || 'none';
  if (!PARENT_RE.test(p)) throw new Error(`signingPayload: invalid parent ${JSON.stringify(parent)}`);
  if (!CONTENT_RE.test(String(content ?? ''))) throw new Error('signingPayload: content must be a sha256 hex digest');
  return Buffer.from(`${SIG_DOMAIN}\n${SIG_VERSION}\nfleet=${fleet}\nref=${ref}\nparent=${p}\ncontent=${content}\n`, 'utf8');
}

/** Create the private key file: Ed25519, PKCS#8 PEM, mode 0600, exclusive create. Never overwrites. */
export function generateSigningKeyFile(file) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, pem);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

/**
 * Why `file` can't be used as the signing key, or '' when it can: a regular file (not a symlink; opened with
 * O_NOFOLLOW and checked on the descriptor read from), owned by this user, with no group/other permission bits,
 * holding an Ed25519 private key. Never throws.
 */
export function signingKeyProblem(file) {
  try {
    readSigningKeyFile(file);
    return '';
  } catch (e) {
    return String(e?.message || e);
  }
}

/** Read the private key; throws (fails closed) on any problem `signingKeyProblem` names. */
export function readSigningKeyFile(file) {
  if (typeof file !== 'string' || !file) throw new Error('no memory signing key configured');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') throw new Error(`signing key ${file} is not a regular file (symlink)`);
    if (err.code === 'ENOENT') throw new Error(`signing key ${file} does not exist`);
    throw err;
  }
  let pem;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`signing key ${file} is not a regular file`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`signing key ${file} is not owned by this user`);
    if ((st.mode & 0o077) !== 0) throw new Error(`signing key ${file} must not be readable by group or other (mode ${(st.mode & 0o777).toString(8)})`);
    pem = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error(`signing key ${file} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`signing key ${file} is not an Ed25519 key (${key.asymmetricKeyType})`);
  return key;
}

/** The raw 32-byte public key, standard base64 (the `fleet_memory_pubkeys` value form). */
export function publicKeyB64(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** A `fleet_memory_pubkeys` value as a KeyObject, or null unless it is exactly 32 bytes of standard base64. */
export function parsePublicKeyB64(value) {
  if (typeof value !== 'string' || !PUBKEY_RE.test(value)) return null;
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * `config.fleet_memory_pubkeys` as Map<fleet, KeyObject[]>. A fleet's value is one key or a list of keys (one per
 * host, and an overlap window while a key rotates); a ref verifies against any of its fleet's keys. A bad fleet name
 * or a malformed key is dropped and logged, never guessed at (a malformed key in a list drops only that key); a fleet
 * left with no valid key is absent, and anything that isn't a mapping is an empty map (nothing trusted).
 */
export function resolveFleetPubkeys(config, { log = () => {} } = {}) {
  const raw = config?.fleet_memory_pubkeys;
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [fleet, value] of Object.entries(raw)) {
    if (!FLEET_ID_RE.test(fleet)) { log(`fleet_memory_pubkeys: ignoring invalid fleet name ${JSON.stringify(fleet)}`); continue; }
    const keys = [];
    for (const v of Array.isArray(value) ? value : [value]) {
      const key = parsePublicKeyB64(v);
      if (key) keys.push(key);
      else log(`fleet_memory_pubkeys: ignoring malformed key for fleet ${fleet}`);
    }
    if (keys.length) out.set(fleet, keys);
  }
  return out;
}

/** The `events.sig` line for this tip. */
export function signTip({ privateKey, fleet, ref, parent, content }) {
  const digest = contentDigest(content);
  const sig = crypto.sign(null, signingPayload({ fleet, ref, parent, content: digest }), privateKey).toString('base64');
  return `engsys-memory-sig ${SIG_VERSION} fleet=${fleet} ref=${ref} parent=${parent || 'none'} content=${digest} sig=${sig}\n`;
}

/** Parse an `events.sig` blob strictly: exactly one line (one trailing newline allowed), every field in shape. */
export function parseSigLine(text) {
  if (typeof text !== 'string') return null;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.includes('\n') || body.includes('\r')) return null;
  const m = SIG_LINE_RE.exec(body);
  if (!m) return null;
  const [, fleet, ref, parent, content, sig] = m;
  if (!FLEET_ID_RE.test(fleet) || !REF_RE.test(ref) || !SIG_B64_RE.test(sig)) return null;
  return { fleet, ref, parent, content, sig };
}

/** The fleet a tail ref names (`refs/engsys/memory/<role>/<fleet>`), or null for `events` / anything else. */
export function tailRefFleet(ref) {
  const r = String(ref ?? '');
  if (!REF_RE.test(r)) return null;
  const parts = r.slice('refs/engsys/memory/'.length).split('/');
  return parts.length === 2 ? parts[1] : null;
}

/**
 * Verify a tip's signature. `ref` is the ref that was read, `parent` the commit's own parent (null/'' for a
 * parentless compaction commit), `content` the events.jsonl blob, `sigText` the events.sig blob, `pubkeys` a Map
 * from `resolveFleetPubkeys`. A tail ref must be signed by the fleet it names; `events` by any listed fleet.
 * Returns `{ ok: true, fleet }` or `{ ok: false, reason }`. Never throws.
 */
export function verifyTipSignature({ ref, parent, content, sigText, pubkeys }) {
  try {
    const line = parseSigLine(sigText);
    if (!line) return { ok: false, reason: 'missing_or_malformed_signature' };
    const wantParent = parent || 'none';
    const digest = contentDigest(content);
    if (line.ref !== ref) return { ok: false, reason: 'ref_mismatch' };
    if (line.parent !== wantParent) return { ok: false, reason: 'parent_mismatch' };
    if (line.content !== digest) return { ok: false, reason: 'content_mismatch' };
    const namedFleet = tailRefFleet(ref);
    if (namedFleet !== null && namedFleet !== line.fleet) return { ok: false, reason: 'fleet_mismatch' };
    const entry = pubkeys instanceof Map ? pubkeys.get(line.fleet) : null;
    const keys = Array.isArray(entry) ? entry : entry ? [entry] : [];
    if (!keys.length) return { ok: false, reason: 'unknown_fleet' };
    const payload = signingPayload({ fleet: line.fleet, ref, parent: wantParent, content: digest });
    const sig = Buffer.from(line.sig, 'base64');
    const ok = keys.some((key) => crypto.verify(null, payload, key, sig));
    return ok ? { ok: true, fleet: line.fleet } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'verify_error' };
  }
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const [op, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { 'key-file': { type: 'string' }, fleet: { type: 'string' } }, strict: true }));
  } catch (e) {
    err.write(`signing: ${e.message}\n`);
    return 2;
  }
  const file = values['key-file'];
  if (!file || (op !== 'keygen' && op !== 'pubkey')) {
    err.write('usage: signing.mjs keygen --key-file PATH | pubkey --key-file PATH [--fleet ID]\n');
    return 2;
  }
  try {
    if (op === 'keygen') {
      generateSigningKeyFile(file);
      out.write(`created ${file}\n`);
      return 0;
    }
    const pub = publicKeyB64(readSigningKeyFile(file));
    const fleet = values.fleet;
    if (fleet && !FLEET_ID_RE.test(fleet)) { err.write(`signing: invalid --fleet ${JSON.stringify(fleet)}\n`); return 2; }
    // A list, so a fleet with several hosts (or a key mid-rotation) adds this line's key to its existing list.
    out.write(fleet ? `fleet_memory_pubkeys:\n  ${fleet}: [${pub}]\n` : `${pub}\n`);
    return 0;
  } catch (e) {
    err.write(`signing: ${e.message}\n`);
    return 3;
  }
}

if (isMainEntry(import.meta.url)) process.exitCode = main();
