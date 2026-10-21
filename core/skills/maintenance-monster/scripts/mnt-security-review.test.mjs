// Tests for mnt-security-review.mjs (engsys#231) — run by `node --test`. Offline: a stub gh (FLEET_GH) answers from
// files in a temp dir; every config dir and HOME point into it, so no real plugin install is read.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handoffSessions, namesSession, classify, reviewLabelOf, SKIP_MARKER } from './mnt-security-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const handoff = (session) => `<!-- mm-handoff -->\nsession: ${session}\ndepends_on: []\n`;

describe('handoffSessions / namesSession', () => {
  test('every block outside a code fence, in order', () => {
    const text = `${handoff('acme-build')}\n\`\`\`\n${handoff('fenced-out')}\`\`\`\nmore\n${handoff('acme-maintain # the fixer')}`;
    assert.deepEqual(handoffSessions(text), ['acme-build', 'acme-maintain']);
    assert.deepEqual(handoffSessions('> <!-- mm-handoff -->\n> session: quoted'), []);
    assert.deepEqual(handoffSessions(null), []);
  });
  test('bare name, or <fleet>:name (only this fleet when FLEET_ID is set), case-insensitive', () => {
    assert.ok(namesSession('acme-maintain', 'acme-maintain'));
    assert.ok(namesSession('Acme-Maintain', 'acme-maintain'));
    assert.ok(namesSession('alice:acme-maintain', 'acme-maintain'), 'single-fleet: any fleet prefix (fail closed)');
    assert.ok(namesSession('alice:acme-maintain', 'acme-maintain', 'alice'));
    assert.ok(!namesSession('bob:acme-maintain', 'acme-maintain', 'alice'), "another fleet's session of the same name is not us");
    assert.ok(!namesSession('acme-maintain-2', 'acme-maintain'));
    assert.ok(!namesSession('acme-build', 'acme-maintain'));
    assert.ok(!namesSession('', 'acme-maintain'));
  });
});

describe('classify: is this PR the security lane\'s own work?', () => {
  const S = 'acme-maintain';
  test('a handoff naming the session in the PR body → self', () => {
    const r = classify({ issue: { body: `Fix CVE\n\n${handoff(S)}` }, comments: [], session: S });
    assert.equal(r.selfAuthored, true);
    assert.match(r.selfWhy, /PR body names session acme-maintain/);
  });
  test('…or in any comment, whoever wrote it (a false self only leaves the PR to an operator)', () => {
    const r = classify({ issue: { body: handoff('acme-build') }, comments: [{ body: handoff(`alice:${S}`), user: { login: 'mallory' }, html_url: 'u2' }], session: S, fleetId: 'alice' });
    assert.equal(r.selfAuthored, true);
    assert.match(r.selfWhy, /u2/);
  });
  test('another session\'s PR is not self', () => {
    const r = classify({ issue: { body: handoff('acme-build') }, comments: [{ body: 'lgtm' }], session: S });
    assert.deepEqual(r, { selfAuthored: false, selfWhy: '', skipNoted: false });
  });
  test('no session name: every PR counts as self (fail closed)', () => {
    const r = classify({ issue: { body: handoff('acme-build') }, comments: [], session: '' });
    assert.equal(r.selfAuthored, true);
    assert.match(r.selfWhy, /no session name/);
  });
  test('skipNoted when the skip comment is already there', () => {
    assert.equal(classify({ issue: { body: handoff(S) }, comments: [{ body: `${SKIP_MARKER}\nskipped` }], session: S }).skipNoted, true);
    assert.equal(classify({ issue: { body: handoff(S) }, comments: [{ body: `quoting ${SKIP_MARKER}` }], session: S }).skipNoted, false);
  });
});

describe('reviewLabelOf', () => {
  test('default, first explicit source, agreement in another case, conflict', () => {
    assert.deepEqual(reviewLabelOf([]), { label: 'security-review-requested', source: 'default' });
    assert.deepEqual(reviewLabelOf([{ source: 'a', text: 'repo: x\n' }, { source: 'b', text: 'security_review_label: needs-nyx\n' }]), { label: 'needs-nyx', source: 'b' });
    assert.equal(reviewLabelOf([{ source: 'a', text: 'security_review_label: needs-nyx\n' }, { source: 'b', text: 'security_review_label: NEEDS-NYX\n' }]).label, 'needs-nyx');
    assert.throws(() => reviewLabelOf([{ source: 'a', text: 'security_review_label: x\n' }, { source: 'b', text: 'security_review_label: y\n' }]), /'x' in a but 'y' in b/);
    assert.throws(() => reviewLabelOf([{ source: 'a', text: 'security_sensitive_globs: oops\n' }]), /security_config_unreadable: a/);
  });
});

describe('the CLI against a stub gh', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-sr-'));
  const stub = path.join(T, 'gh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
case "$1 $2" in
  "api rate_limit") echo 5000 ;;
  "pr list") cat "$FAKE/prs.json" ;;
  "api repos/acme/app/issues/"[0-9]*) n="\${2##*/}"; cat "$FAKE/issue-$n.json" ;;
  "api --paginate") n="\${3%/comments*}"; n="\${n##*/}"; cat "$FAKE/comments-$n.json" ;;
  *) echo "stub gh: unexpected $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
  const write = (name, v) => fs.writeFileSync(path.join(T, name), typeof v === 'string' ? v : JSON.stringify(v));
  const label = (name) => ({ name });
  write('prs.json', [
    { number: 31, headRefOid: 'a'.repeat(40), url: 'u31', author: { login: 'fleet-bot' }, isDraft: false, labels: [label('mm:ready'), label('security-review-requested')] },
    { number: 30, headRefOid: 'b'.repeat(40), url: 'u30', author: { login: 'fleet-bot' }, isDraft: true, labels: [label('Security-Review-Requested')] },
    { number: 32, headRefOid: 'c'.repeat(40), url: 'u32', author: { login: 'x' }, isDraft: false, labels: [label('other')] },
  ]);
  write('issue-31.json', { body: handoff('acme-build') });
  write('comments-31.json', '[{"body":"hi"}]\n[{"body":"page two"}]\n');
  write('issue-30.json', { body: handoff('acme-maintain') });
  write('comments-30.json', '[]');
  fs.mkdirSync(path.join(T, 'home'));
  fs.mkdirSync(path.join(T, 'cwd'));
  const env = { PATH: process.env.PATH, HOME: path.join(T, 'home'), CLAUDE_CONFIG_DIR: path.join(T, 'home'), FAKE: T, FLEET_GH: stub, ENGSYS_SESSION: 'acme-maintain' };
  const run = (args, extra = {}) => {
    fs.writeFileSync(path.join(T, 'gh.log'), '');
    const r = spawnSync('bash', [path.join(HERE, 'mnt-security-reviews.sh'), ...args], { cwd: path.join(T, 'cwd'), env: { ...env, ...extra }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };

  test('lists the labeled PRs (label verified, case-insensitive), classifies them, reads every comment page', () => {
    const r = run(['--repo', 'acme/app']);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(r.json.label, 'security-review-requested');
    assert.equal(r.json.labelSource, 'default');
    assert.equal(r.json.session, 'acme-maintain');
    assert.equal(r.json.signer, false);
    assert.deepEqual(r.json.prs.map((p) => [p.number, p.selfAuthored]), [[30, true], [31, false]]);
    assert.equal(r.json.prs[1].head, 'a'.repeat(40));
    const log = fs.readFileSync(path.join(T, 'gh.log'), 'utf8');
    assert.match(log, /pr list -R acme\/app --state open --limit 200 --label security-review-requested/);
    assert.doesNotMatch(log, /issues\/32/, 'a PR without the label is not read');
  });
  test('signer reflects ENGSYS_SECURITY_VERDICT_KEY_FILE; --session overrides the env', () => {
    const r = run(['--repo', 'acme/app', '--session', 'acme-build'], { ENGSYS_SECURITY_VERDICT_KEY_FILE: '/k' });
    assert.equal(r.json.signer, true);
    assert.deepEqual(r.json.prs.map((p) => [p.number, p.selfAuthored]), [[30, false], [31, true]]);
  });
  test('the label comes from the merge config (ENGSYS_MM_CONFIG, the repo, --config); a conflict is an error', () => {
    write('mm.yml', 'security_review_label: needs-nyx\n');
    let r = run(['--repo', 'acme/app'], { ENGSYS_MM_CONFIG: path.join(T, 'mm.yml') });
    assert.equal(r.json.label, 'needs-nyx');
    assert.match(fs.readFileSync(path.join(T, 'gh.log'), 'utf8'), /--label needs-nyx/);
    write('other.yml', 'security_review_label: something-else\n');
    r = run(['--repo', 'acme/app', '--config', path.join(T, 'other.yml')], { ENGSYS_MM_CONFIG: path.join(T, 'mm.yml') });
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /security_review_label is 'needs-nyx'/);
    r = run(['--repo', 'acme/app', '--label', 'manual'], { ENGSYS_MM_CONFIG: path.join(T, 'mm.yml') });
    assert.equal(r.json.label, 'manual');
    assert.equal(r.json.labelSource, '--label');
  });
  test('a gh failure is exit 1, never an empty list', () => {
    fs.renameSync(path.join(T, 'prs.json'), path.join(T, 'prs.bak'));
    const r = run(['--repo', 'acme/app']);
    fs.renameSync(path.join(T, 'prs.bak'), path.join(T, 'prs.json'));
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
  });
  test('usage', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run(['--repo', 'not a repo']).code, 2);
  });
  after(() => fs.rmSync(T, { recursive: true, force: true }));
});
