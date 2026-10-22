// Tests for signing.mjs — per-fleet Ed25519 signatures on refs/engsys/memory/* (F5, FeedFrwd/ff-engsys-fleet#60).
// Run by `node --test core/lib/memory/signing.test.mjs`.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contentDigest,
  FLEET_ID_RE,
  refFleet,
  generateSigningKeyFile,
  main,
  parsePublicKeyB64,
  parseSigLine,
  publicKeyB64,
  readSigningKeyFile,
  resolveFleetPubkeys,
  signingKeyProblem,
  signingPayload,
  signTip,
  verifyTipSignature,
} from './signing.mjs';
import { parseYaml } from '../yaml.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-signing-'));
  dirs.push(d);
  return d;
}
function keyPair() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKeyB64(privateKey) };
}

const ERIC = keyPair();
const MARK = keyPair();
const PUBKEYS = resolveFleetPubkeys({ fleet_memory_pubkeys: { eric: ERIC.pub, 'mark-fleet': MARK.pub } });
const PARENT = 'a'.repeat(40);
const CONTENT = '{"k":"x","updated_at":"2026-07-01T00:00:00Z"}\n';
const TAIL = 'refs/engsys/memory/fleet/eric/merge';
const EVENTS = 'refs/engsys/memory/fleet/eric/events';
const MARK_EVENTS = 'refs/engsys/memory/fleet/mark-fleet/events';
const SHARED_EVENTS = 'refs/engsys/memory/events';
const OTHER_TAIL = 'refs/engsys/memory/fleet/eric/maintain';

describe('sign / verify', () => {
  it('round trip: a tail signed by its own fleet verifies', () => {
    const sigText = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.deepEqual(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }), { ok: true, fleet: 'eric' });
  });

  it('a parentless (first or compacted) commit signs and verifies with parent=none', () => {
    const sigText = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: null, content: CONTENT });
    assert.match(sigText, / parent=none /);
    assert.equal(verifyTipSignature({ ref: TAIL, parent: null, content: CONTENT, sigText, pubkeys: PUBKEYS }).ok, true);
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }).reason, 'parent_mismatch');
  });

  it('a fleet\'s own events ref, signed by that fleet, verifies (engsys#266)', () => {
    const sigText = signTip({ privateKey: MARK.privateKey, fleet: 'mark-fleet', ref: MARK_EVENTS, parent: PARENT, content: CONTENT });
    assert.deepEqual(verifyTipSignature({ ref: MARK_EVENTS, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }), { ok: true, fleet: 'mark-fleet' });
  });

  it('a per-fleet events ref signed by ANOTHER listed fleet is rejected: events follow the tail rule now (engsys#266)', () => {
    const markOwn = signTip({ privateKey: MARK.privateKey, fleet: 'mark-fleet', ref: MARK_EVENTS, parent: PARENT, content: CONTENT });
    const ontoEric = markOwn.replace(`ref=${MARK_EVENTS}`, `ref=${EVENTS}`);
    assert.equal(verifyTipSignature({ ref: EVENTS, parent: PARENT, content: CONTENT, sigText: ontoEric, pubkeys: PUBKEYS }).reason, 'fleet_mismatch');
    assert.equal(verifyTipSignature({ ref: EVENTS, parent: PARENT, content: CONTENT, sigText: markOwn, pubkeys: PUBKEYS }).reason, 'ref_mismatch');
  });

  it('the retired shared events ref and the pre-#266 tail layout are never trusted and can\'t be signed', () => {
    for (const ref of [SHARED_EVENTS, 'refs/engsys/memory/merge/eric', 'refs/engsys/memory/fleet/eric/other', 'refs/engsys/memory/fleet/eric']) {
      assert.equal(refFleet(ref), null, ref);
      assert.throws(() => signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref, parent: PARENT, content: CONTENT }), /invalid ref/, ref);
    }
    const good = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: EVENTS, parent: PARENT, content: CONTENT });
    const moved = good.replace(`ref=${EVENTS}`, `ref=${SHARED_EVENTS}`);
    assert.equal(verifyTipSignature({ ref: SHARED_EVENTS, parent: PARENT, content: CONTENT, sigText: moved, pubkeys: PUBKEYS }).ok, false);
    assert.equal(refFleet(EVENTS), 'eric');
    assert.equal(refFleet(TAIL), 'eric');
  });

  it('signingPayload binds the fleet to the ref\'s namespace: a fleet can\'t sign another fleet\'s ref', () => {
    assert.throws(() => signTip({ privateKey: MARK.privateKey, fleet: 'mark-fleet', ref: TAIL, parent: PARENT, content: CONTENT }), /not fleet mark-fleet's ref/);
  });

  it('replay onto another ref, another parent or other content is rejected', () => {
    const sigText = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.equal(verifyTipSignature({ ref: OTHER_TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }).reason, 'ref_mismatch');
    assert.equal(verifyTipSignature({ ref: EVENTS, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }).reason, 'ref_mismatch');
    assert.equal(verifyTipSignature({ ref: TAIL, parent: 'b'.repeat(40), content: CONTENT, sigText, pubkeys: PUBKEYS }).reason, 'parent_mismatch');
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: `${CONTENT}{"k":"y"}\n`, sigText, pubkeys: PUBKEYS }).reason, 'content_mismatch');
  });

  it('a line rewritten to claim the new ref/parent/content still fails: the signature covers them', () => {
    const sigText = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    const other = `${CONTENT}{"k":"y"}\n`;
    const forged = sigText.replace(`content=${contentDigest(CONTENT)}`, `content=${contentDigest(other)}`);
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: other, sigText: forged, pubkeys: PUBKEYS }).reason, 'bad_signature');
    const forgedRef = sigText.replace(`ref=${TAIL}`, `ref=${OTHER_TAIL}`);
    assert.equal(verifyTipSignature({ ref: OTHER_TAIL, parent: PARENT, content: CONTENT, sigText: forgedRef, pubkeys: PUBKEYS }).reason, 'bad_signature');
  });

  it('wrong fleet key: a tail signed by another fleet, or a claimed fleet whose key did not sign, is rejected', () => {
    const markOwnTail = signTip({ privateKey: MARK.privateKey, fleet: 'mark-fleet', ref: 'refs/engsys/memory/fleet/mark-fleet/merge', parent: PARENT, content: CONTENT });
    const markOnEricTail = markOwnTail.replace('ref=refs/engsys/memory/fleet/mark-fleet/merge', `ref=${TAIL}`);
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText: markOnEricTail, pubkeys: PUBKEYS }).reason, 'fleet_mismatch');
    const markClaimsEric = signTip({ privateKey: MARK.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText: markClaimsEric, pubkeys: PUBKEYS }).reason, 'bad_signature');
  });

  it('a fleet with no key entry is untrusted', () => {
    const stranger = keyPair();
    const STRANGER = 'refs/engsys/memory/fleet/stranger/events';
    const sigText = signTip({ privateKey: stranger.privateKey, fleet: 'stranger', ref: STRANGER, parent: PARENT, content: CONTENT });
    assert.equal(verifyTipSignature({ ref: STRANGER, parent: PARENT, content: CONTENT, sigText, pubkeys: PUBKEYS }).reason, 'unknown_fleet');
    assert.equal(verifyTipSignature({ ref: STRANGER, parent: PARENT, content: CONTENT, sigText, pubkeys: new Map() }).reason, 'unknown_fleet');
    assert.equal(verifyTipSignature({ ref: STRANGER, parent: PARENT, content: CONTENT, sigText, pubkeys: undefined }).reason, 'unknown_fleet');
  });

  it('the signature line is parsed strictly', () => {
    const good = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.ok(parseSigLine(good));
    for (const bad of [
      null, '', `${good}${good}`, good.replace('\n', '\r\n'), `x${good}`, good.replace(' v1 ', ' v2 '),
      good.replace(/sig=\S+/, 'sig=AAAA'), good.replace('fleet=eric', 'fleet=../x'), good.replace(' content=', '  content='),
    ]) {
      assert.equal(parseSigLine(bad), null, JSON.stringify(bad));
      assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText: bad, pubkeys: PUBKEYS }).ok, false);
    }
  });

  it('signingPayload refuses fields outside their shape (no ambiguous payloads)', () => {
    const digest = contentDigest(CONTENT);
    assert.throws(() => signingPayload({ fleet: 'a\nb', ref: TAIL, parent: PARENT, content: digest }));
    assert.throws(() => signingPayload({ fleet: 'eric', ref: 'refs/heads/main', parent: PARENT, content: digest }));
    assert.throws(() => signingPayload({ fleet: 'eric', ref: TAIL, parent: 'HEAD', content: digest }));
    assert.throws(() => signingPayload({ fleet: 'eric', ref: TAIL, parent: PARENT, content: 'x' }));
    assert.match(signingPayload({ fleet: 'eric', ref: TAIL, parent: PARENT, content: digest }).toString(), /^engsys-memory-ref-sig\nv1\nfleet=eric\n/);
  });
});

describe('fleet ids and ref segments (Nyx LOW 1)', () => {
  it('a fleet id is one safe ref segment: no leading dot, no "..", no ".lock" suffix, 1-40 characters', () => {
    for (const ok of ['eric', 'mark-fleet', 'a.b', 'x.lockfile', '_x', 'a'.repeat(40)]) assert.ok(FLEET_ID_RE.test(ok), ok);
    for (const bad of ['', '.', '..', '.git', '.hidden', 'a..b', 'x.lock', 'a/b', 'a b', 'a'.repeat(41)]) assert.ok(!FLEET_ID_RE.test(bad), bad);
  });

  it('signingPayload, the signature line and refFleet refuse dot segments in the ref and the fleet', () => {
    const digest = contentDigest(CONTENT);
    for (const ref of ['refs/engsys/memory/fleet/../merge', 'refs/engsys/memory/fleet/./merge', 'refs/engsys/memory/fleet/.git/merge', 'refs/engsys/memory/fleet/x.lock/merge', 'refs/engsys/memory/fleet/a..b/events']) {
      assert.throws(() => signingPayload({ fleet: 'eric', ref, parent: PARENT, content: digest }), /invalid ref/, ref);
      assert.equal(refFleet(ref), null, ref);
    }
    for (const fleet of ['.', '..', '.git', 'x.lock']) assert.throws(() => signingPayload({ fleet, ref: TAIL, parent: PARENT, content: digest }), /invalid fleet/, fleet);
    const good = signTip({ privateKey: ERIC.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.equal(parseSigLine(good.replace('fleet=eric', 'fleet=..')), null);
    assert.equal(parseSigLine(good.replace('fleet=eric', 'fleet=.git')), null);
    assert.equal(parseSigLine(good.replace(`ref=${TAIL}`, 'ref=refs/engsys/memory/fleet/../merge')), null);
    assert.equal(resolveFleetPubkeys({ fleet_memory_pubkeys: { '.git': ERIC.pub, '..': ERIC.pub } }).size, 0);
  });
});

describe('public keys (fleet_memory_pubkeys)', () => {
  it('malformed entries are dropped and logged; only exact 32-byte standard base64 counts', () => {
    const logs = [];
    const urlSafe = ERIC.pub.replace(/\+/g, '-').replace(/\//g, '_');
    const map = resolveFleetPubkeys({
      fleet_memory_pubkeys: {
        eric: ERIC.pub,
        short: ERIC.pub.slice(0, 20),
        long: `${ERIC.pub}AAAA`,
        number: 12345,
        nopad: ERIC.pub.replace(/=$/, ''),
        '../evil': MARK.pub,
        ...(urlSafe !== ERIC.pub ? { urlsafe: urlSafe } : {}),
      },
    }, { log: (m) => logs.push(m) });
    assert.deepEqual([...map.keys()], ['eric']);
    assert.ok(logs.some((l) => /invalid fleet name/.test(l)));
    assert.ok(logs.some((l) => /malformed key for fleet short/.test(l)));
    assert.equal(parsePublicKeyB64(undefined), null);
  });

  it('a fleet may list several keys (one per host, or a rotation overlap): a ref verifies against any of them (review L5)', () => {
    const host2 = keyPair();
    const map = resolveFleetPubkeys(parseYaml(`fleet_memory_pubkeys:\n  eric: [${ERIC.pub}, ${host2.pub}]\n  mark-fleet:\n    - ${MARK.pub}\n    - not-a-key\n`), { log: () => {} });
    assert.equal(map.get('eric').length, 2);
    assert.equal(map.get('mark-fleet').length, 1, 'a malformed key in a list drops only that key');
    for (const priv of [ERIC.privateKey, host2.privateKey]) {
      const sigText = signTip({ privateKey: priv, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
      assert.deepEqual(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: map }), { ok: true, fleet: 'eric' });
    }
    const markOnly = resolveFleetPubkeys({ fleet_memory_pubkeys: { eric: ['bad', 'worse'] } });
    assert.equal(markOnly.has('eric'), false, 'a fleet left with no valid key is absent (untrusted)');
    const stranger = keyPair();
    const sigText = signTip({ privateKey: stranger.privateKey, fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: map }).reason, 'bad_signature');
  });

  it('a value that is not a mapping trusts nobody', () => {
    for (const v of [undefined, null, 'eric: x', ['eric'], 7]) assert.equal(resolveFleetPubkeys({ fleet_memory_pubkeys: v }).size, 0);
  });
});

describe('the private key file', () => {
  it('keygen creates a 0600 Ed25519 key and never overwrites one', () => {
    const file = path.join(tmp(), 'memory-signing.key');
    generateSigningKeyFile(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const key = readSigningKeyFile(file);
    assert.equal(key.asymmetricKeyType, 'ed25519');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => generateSigningKeyFile(file), /EEXIST/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('refuses a group/other-readable key, a symlink, a missing file, a non-PEM file and a non-Ed25519 key', () => {
    const d = tmp();
    const file = path.join(d, 'k');
    generateSigningKeyFile(file);
    fs.chmodSync(file, 0o640);
    assert.match(signingKeyProblem(file), /must not be readable by group or other/);
    fs.chmodSync(file, 0o600);
    assert.equal(signingKeyProblem(file), '');
    const link = path.join(d, 'link');
    fs.symlinkSync(file, link);
    assert.match(signingKeyProblem(link), /symlink/);
    assert.match(signingKeyProblem(path.join(d, 'absent')), /does not exist/);
    assert.match(signingKeyProblem(''), /no memory signing key configured/);
    const junk = path.join(d, 'junk');
    fs.writeFileSync(junk, 'not a key\n', { mode: 0o600 });
    assert.match(signingKeyProblem(junk), /not a PEM private key/);
    const rsa = path.join(d, 'rsa');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    fs.writeFileSync(rsa, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    assert.match(signingKeyProblem(rsa), /not an Ed25519 key/);
    const dir = path.join(d, 'dir');
    fs.mkdirSync(dir, { mode: 0o700 });
    assert.match(signingKeyProblem(dir), /not a regular file/);
  });

  it('the pubkey CLI prints a memory.yml entry that resolves back to the same key', () => {
    const file = path.join(tmp(), 'k');
    generateSigningKeyFile(file);
    const out = [];
    const io = { out: { write: (s) => out.push(s) }, err: { write: () => {} } };
    assert.equal(main(['pubkey', '--key-file', file, '--fleet', 'eric'], io), 0);
    const text = out.join('');
    assert.match(text, /^fleet_memory_pubkeys:\n {2}eric: \[[A-Za-z0-9+/]{43}=\]\n$/, 'a one-key list, ready to merge into the fleet\'s list');
    const map = resolveFleetPubkeys(parseYaml(text));
    const sigText = signTip({ privateKey: readSigningKeyFile(file), fleet: 'eric', ref: TAIL, parent: PARENT, content: CONTENT });
    assert.equal(verifyTipSignature({ ref: TAIL, parent: PARENT, content: CONTENT, sigText, pubkeys: map }).ok, true);
    assert.equal(main(['pubkey', '--key-file', file, '--fleet', '../x'], io), 2);
    assert.equal(main(['keygen', '--key-file', file], io), 3, 'keygen over an existing key fails');
    assert.equal(main(['nope', '--key-file', file], io), 2);
  });
});
