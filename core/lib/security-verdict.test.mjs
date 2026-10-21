import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateKeyFile,
  readKeyFile,
  signVerdict,
  checkVerdictBody,
  evaluateSecurityVerdicts,
  claimsNyxReview,
  main,
} from './security-verdict.mjs';

const REPO = 'acme/app';
const PR = 42;
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = Date.parse('2026-10-19T12:00:00Z');
const now = () => NOW;
const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);
const REVIEW = 'No injection paths found.\nNA-1 holds.';

const sign = (over = {}) => signVerdict({ key, repo: REPO, pr: PR, sha: SHA, verdict: 'PASS', reviewText: REVIEW, now, ...over });
const evalOne = (body, over = {}) =>
  evaluateSecurityVerdicts({ key, repo: REPO, pr: PR, headSha: SHA, comments: [{ body, createdAt: '2026-10-19T11:00:00Z' }], now, ...over });

describe('signed nyx-review verdicts (engsys#197 option B)', () => {
  it('positive control: a verdict signed with the key verifies for the current head', () => {
    const body = sign();
    assert.equal(claimsNyxReview(body), true);
    const c = checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body, now });
    assert.deepEqual({ state: c.state, verdict: c.verdict, ts: c.ts, sha: c.sha }, { state: 'valid', verdict: 'PASS', ts: NOW / 1000, sha: SHA });
    const r = evalOne(body);
    assert.equal(r.ok, true);
    assert.equal(r.state, 'verified');
    assert.equal(r.exit, 0);
  });

  it('positive control: GitHub-style CRLF line endings and outer whitespace do not break verification', () => {
    const body = `\n${sign().replace(/\n/g, '\r\n')}\r\n\r\n`;
    assert.equal(evalOne(body).state, 'verified');
  });

  it('negative: a verdict with NO MAC at all (the plain pre-#197 comment) is rejected', () => {
    const r = evalOne(`<!-- nyx-review -->\nNYX-VERDICT: PASS\n\n${REVIEW}\n`);
    assert.equal(r.ok, false);
    assert.equal(r.state, 'invalid');
    assert.equal(r.reason, 'forged_or_unsigned');
    assert.equal(r.exit, 1);
  });

  it('negative: a verdict signed with the WRONG key is rejected', () => {
    const r = evalOne(sign({ key: otherKey }));
    assert.equal(r.ok, false);
    assert.equal(r.counts.invalid, 1);
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: sign({ key: otherKey }), now }).reason, 'bad_mac');
  });

  it('negative: a tampered verdict is rejected (flipping FINDINGS to PASS, in either line)', () => {
    const findings = sign({ verdict: 'FINDINGS' });
    const flippedLineOnly = findings.replace('NYX-VERDICT: FINDINGS', 'NYX-VERDICT: PASS');
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: flippedLineOnly, now }).reason, 'verdict_line_differs_from_signed_verdict');
    const flippedBoth = flippedLineOnly.replace('verdict=FINDINGS', 'verdict=PASS');
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: flippedBoth, now }).reason, 'bad_mac');
    assert.equal(evalOne(flippedBoth).ok, false);
  });

  it('negative: tampered review text is rejected', () => {
    const r = checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: sign().replace('NA-1 holds.', 'NA-1 does not hold.'), now });
    assert.equal(r.state, 'invalid');
    assert.equal(r.reason, 'review_text_tampered');
  });

  it('negative: a verdict signed for another head SHA does not count (no replay onto a new SHA)', () => {
    const oldHead = sign({ sha: SHA2 });
    const r = checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: oldHead, now });
    assert.equal(r.state, 'stale');
    // Without --require a stale-only PR is "no verdict claimed for this head"; with --require it fails.
    assert.equal(evalOne(oldHead).state, 'none');
    assert.equal(evalOne(oldHead, { require: true }).ok, false);
    assert.equal(evalOne(oldHead, { require: true }).reason, 'no_valid_verdict');
    // Editing the sha field to the new head breaks the MAC.
    const retargeted = oldHead.replace(`sha=${SHA2}`, `sha=${SHA}`);
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: retargeted, now }).reason, 'bad_mac');
  });

  it('negative: a verdict replayed onto another PR or repo is rejected', () => {
    const body = sign();
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR + 1, headSha: SHA, body, now }).reason, 'bad_mac');
    assert.equal(checkVerdictBody({ key, repo: 'acme/other', pr: PR, headSha: SHA, body, now }).reason, 'bad_mac');
  });

  it('negative: expired and future-dated verdicts do not verify', () => {
    const old = sign({ now: () => NOW - 8 * 24 * 3600 * 1000 });
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: old, now }).reason, 'expired');
    const future = sign({ now: () => NOW + 3600 * 1000 });
    assert.equal(checkVerdictBody({ key, repo: REPO, pr: PR, headSha: SHA, body: future, now }).reason, 'timestamp_in_future');
  });

  it('negative: --require fails with no verdict at all; without it a PR with no nyx-review comment passes through', () => {
    assert.equal(evaluateSecurityVerdicts({ key, repo: REPO, pr: PR, headSha: SHA, comments: [], require: true, now }).ok, false);
    const r = evaluateSecurityVerdicts({ key, repo: REPO, pr: PR, headSha: SHA, comments: [{ body: 'LGTM' }], now });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'none');
  });

  const at = (min) => () => NOW - min * 60 * 1000; // sign "min minutes ago"
  const cm = (body, createdAt) => ({ body, createdAt });

  it('a signed FINDINGS verdict for the head blocks (exit 4), and the LATEST SIGNED verdict decides', () => {
    const base = { key, repo: REPO, pr: PR, headSha: SHA, now };
    const findings = cm(sign({ verdict: 'FINDINGS', now: at(120) }), '2026-10-19T09:00:00Z');
    const pass = cm(sign({ verdict: 'PASS', now: at(60) }), '2026-10-19T10:00:00Z');
    const findingsLater = cm(sign({ verdict: 'FINDINGS', now: at(30) }), '2026-10-19T11:00:00Z');
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [findings] }).exit, 4);
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [findings, pass] }).ok, true);
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [findings, pass, findingsLater] }).exit, 4);
  });

  it('REGRESSION (replay): re-posting an earlier authentic PASS after a later signed FINDINGS does not flip the outcome', () => {
    const base = { key, repo: REPO, pr: PR, headSha: SHA, now };
    const pass = sign({ verdict: 'PASS', now: at(120) });
    const findings = sign({ verdict: 'FINDINGS', now: at(60) });
    const comments = [cm(pass, '2026-10-19T10:00:00Z'), cm(findings, '2026-10-19T11:00:00Z'), cm(pass, '2026-10-19T11:30:00Z')];
    const r = evaluateSecurityVerdicts({ ...base, comments });
    assert.equal(r.exit, 4, 'the replayed PASS (newer createdAt, older signed ts) must not outrank the FINDINGS');
    assert.equal(r.counts.duplicate, 1);
    // Positive control: a genuinely newer signed PASS does clear it.
    const newer = sign({ verdict: 'PASS', now: at(10) });
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [...comments, cm(newer, '2026-10-19T11:40:00Z')] }).ok, true);
    // Equal signed timestamps: FINDINGS outranks PASS (fail closed), whatever the comment order.
    const tiedP = sign({ verdict: 'PASS', now: at(5), nonce: '1'.repeat(16) });
    const tiedF = sign({ verdict: 'FINDINGS', now: at(5), nonce: '2'.repeat(16) });
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [cm(tiedF, 'a'), cm(tiedP, 'b')] }).exit, 4);
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [cm(tiedP, 'a'), cm(tiedF, 'b')] }).exit, 4);
  });

  it('REGRESSION (sticky FINDINGS): FINDINGS@A is not cleared by a push to B, in either mode, until a fresh signed verdict exists for B', () => {
    const findingsA = cm(sign({ sha: SHA2, verdict: 'FINDINGS', now: at(60) }), '2026-10-19T10:00:00Z');
    const onB = { key, repo: REPO, pr: PR, headSha: SHA, now }; // head moved from SHA2 (A) to SHA (B)
    for (const require of [false, true]) {
      const r = evaluateSecurityVerdicts({ ...onB, comments: [findingsA], require });
      assert.equal(r.ok, false, `require=${require}`);
      assert.equal(r.exit, 4);
      assert.equal(r.reason, 'signed_findings_on_earlier_head_unresolved');
    }
    // Still sticky when the FINDINGS has expired (age never clears it).
    const old = cm(sign({ sha: SHA2, verdict: 'FINDINGS', now: at(60 * 24 * 30) }), '2026-09-19T10:00:00Z');
    assert.equal(evaluateSecurityVerdicts({ ...onB, comments: [old] }).exit, 4);
    // A signed PASS for B (later than the FINDINGS) clears it; so does a fresh FINDINGS@B (still blocks, for B).
    const passB = cm(sign({ sha: SHA, verdict: 'PASS', now: at(5) }), '2026-10-19T11:50:00Z');
    assert.equal(evaluateSecurityVerdicts({ ...onB, comments: [findingsA, passB] }).ok, true);
    assert.equal(evaluateSecurityVerdicts({ ...onB, comments: [findingsA, passB], require: true }).ok, true);
    // A PASS for the OLD head (after the FINDINGS) does not satisfy --require on the new head, and is no replay credit.
    const passA = cm(sign({ sha: SHA2, verdict: 'PASS', now: at(30) }), '2026-10-19T11:00:00Z');
    assert.equal(evaluateSecurityVerdicts({ ...onB, comments: [findingsA, passA], require: true }).ok, false);
    assert.equal(evaluateSecurityVerdicts({ ...onB, comments: [findingsA, passA] }).state, 'none');
  });

  it('a forged unsigned PASS next to a genuine signed one does not poison a valid verdict, but alone it blocks', () => {
    const forged = { body: '<!-- nyx-review -->\nNYX-VERDICT: PASS\n', createdAt: '2026-10-19T11:30:00Z' };
    const real = { body: sign(), createdAt: '2026-10-19T10:00:00Z' };
    const base = { key, repo: REPO, pr: PR, headSha: SHA, now };
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [real, forged] }).ok, true);
    assert.equal(evaluateSecurityVerdicts({ ...base, comments: [forged] }).ok, false);
  });

  it('only the exact marker is a claim: `<!-- nyx-review-anything` is not', () => {
    assert.equal(claimsNyxReview('<!-- nyx-review -->\nNYX-VERDICT: PASS'), true);
    assert.equal(claimsNyxReview('<!-- nyx-review-extra -->\nNYX-VERDICT: PASS'), false);
    assert.equal(claimsNyxReview('<!--nyx-review-->'), false);
    assert.equal(claimsNyxReview('<!-- NYX-REVIEW -->'), false);
    assert.equal(evalOne('<!-- nyx-review-extra -->\nNYX-VERDICT: PASS').state, 'none');
  });

  it('refuses to sign malformed claims', () => {
    assert.throws(() => sign({ sha: 'abc' }), /40-hex/);
    assert.throws(() => sign({ verdict: 'APPROVED' }), /verdict/);
    assert.throws(() => sign({ repo: 'not a repo' }), /repo/);
    assert.throws(() => sign({ pr: 0 }), /PR number/);
    assert.throws(() => sign({ key: Buffer.alloc(4) }), /key/);
  });

  it('an unknown head SHA fails closed', () => {
    const r = evaluateSecurityVerdicts({ key, repo: REPO, pr: PR, headSha: '', comments: [{ body: sign() }], now });
    assert.equal(r.ok, false);
  });
});

describe('key file handling', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secverdict-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('positive control: keygen creates a 0600 key that reads back; it never overwrites', () => {
    const f = path.join(dir, 'a.key');
    generateKeyFile(f);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(readKeyFile(f).length, 32);
    assert.throws(() => generateKeyFile(f), /EEXIST/);
  });

  it('negative: a group/other-readable key, a symlinked key, a short key and a missing key are all refused', () => {
    const loose = path.join(dir, 'loose.key');
    generateKeyFile(loose);
    fs.chmodSync(loose, 0o640);
    assert.throws(() => readKeyFile(loose), /must not be readable/);
    const good = path.join(dir, 'good.key');
    generateKeyFile(good);
    const link = path.join(dir, 'link.key');
    fs.symlinkSync(good, link);
    assert.throws(() => readKeyFile(link), /not a regular file \(symlink\)/);
    const short = path.join(dir, 'short.key');
    fs.writeFileSync(short, 'abcd\n', { mode: 0o600 });
    assert.throws(() => readKeyFile(short), /at least 32 bytes/);
    assert.throws(() => readKeyFile(path.join(dir, 'missing.key')));
    assert.throws(() => readKeyFile(''), /no key file/);
  });
});

describe('CLI', () => {
  let dir; let keyFile;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secverdict-cli-'));
    keyFile = path.join(dir, 'k.key');
    generateKeyFile(keyFile);
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const capture = async (argv, opts) => {
    let out = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { out += s; return true; };
    try { return { code: await main(argv, opts), out }; } finally { process.stdout.write = orig; }
  };

  it('post -> verify round trip through the CLI with a fake gh (positive control), and the gate disabled path needs no CLI at all', async () => {
    const posted = [];
    const exec = (cmd, args) => {
      assert.equal(cmd, 'gh');
      if (args[0] === 'pr' && args[1] === 'view') return `${SHA}\n`;
      if (args[0] === 'pr' && args[1] === 'comment') { posted.push(fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8')); return ''; }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const bodyFile = path.join(dir, 'review.md');
    fs.writeFileSync(bodyFile, REVIEW);
    const r = await capture(['post', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--verdict', 'PASS', '--body-file', bodyFile], { exec, env: { ENGSYS_SECURITY_VERDICT_KEY_FILE: keyFile }, now });
    assert.equal(r.code, 0);
    assert.equal(posted.length, 1);
    const v = await capture(['verify', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--key-file', keyFile], { readStdin: () => JSON.stringify([{ body: posted[0], createdAt: '2026-10-19T11:00:00Z' }]), now });
    assert.equal(v.code, 0);
    assert.equal(JSON.parse(v.out).state, 'verified');
    // The same comments against a different head fail when --require is set.
    const stale = await capture(['verify', '--repo', REPO, '--pr', String(PR), '--sha', SHA2, '--key-file', keyFile, '--require'], { readStdin: () => JSON.stringify([{ body: posted[0] }]), now });
    assert.equal(stale.code, 1);
    // An unreadable key is exit 3: never act.
    const bad = await capture(['verify', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--key-file', path.join(dir, 'nope.key')], { readStdin: () => '[]', now });
    assert.equal(bad.code, 3);
  });

  it('engsys#231: post reads the review text from stdin with --body-file - (the baton guard hands it over that way)', async () => {
    const posted = [];
    const exec = (cmd, args) => {
      if (args[1] === 'view') return `${SHA}\n`;
      const f = args[args.indexOf('--body-file') + 1];
      assert.ok(!f.startsWith(dir), 'the signed copy lives in its own temp dir, not beside the review');
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
      posted.push({ f, body: fs.readFileSync(f, 'utf8') });
      return '';
    };
    const r = await capture(['post', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--verdict', 'FINDINGS', '--body-file', '-'], { exec, env: { ENGSYS_SECURITY_VERDICT_KEY_FILE: keyFile }, readStdin: () => REVIEW, now });
    assert.equal(r.code, 0);
    assert.equal(posted.length, 1);
    assert.ok(!fs.existsSync(posted[0].f), 'and is removed after posting');
    const v = await capture(['verify', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--key-file', keyFile], { readStdin: () => JSON.stringify([{ body: posted[0].body }]), now });
    assert.equal(JSON.parse(v.out).state, 'findings');
  });

  it('negative: post refuses outside a security-lane session (no key path in the env), and for a SHA that is not the PR head', async () => {
    const bodyFile = path.join(dir, 'r2.md');
    fs.writeFileSync(bodyFile, REVIEW);
    const args = ['post', '--repo', REPO, '--pr', String(PR), '--sha', SHA, '--verdict', 'PASS', '--body-file', bodyFile];
    const exits = [];
    const realExit = process.exit;
    process.exit = (c) => { exits.push(c); throw new Error('exit'); };
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await assert.rejects(main(args, { exec: () => { throw new Error('gh must not be called'); }, env: {}, now }));
      await assert.rejects(main(args, { exec: (c, a) => (a[1] === 'view' ? `${SHA2}\n` : ''), env: { ENGSYS_SECURITY_VERDICT_KEY_FILE: keyFile }, now }));
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
    }
    assert.deepEqual(exits, [1, 1]);
  });
});
