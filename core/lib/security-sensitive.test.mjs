import { describe, it } from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { compileGlob, loadPolicy, decide, GITHUB_FILE_LIMIT } from './security-sensitive.mjs';

const m = (glob, p) => compileGlob(glob).test(p);

describe('compileGlob: the fleet dialect', () => {
  it('* and ? stay inside one segment', () => {
    assert.ok(m('a/*.ts', 'a/x.ts'));
    assert.ok(!m('a/*.ts', 'a/b/x.ts'));
    assert.ok(m('a/?.ts', 'a/x.ts'));
    assert.ok(!m('a/?.ts', 'a/xy.ts'));
    assert.ok(!m('a/?.ts', 'a//.ts'));
  });
  it('** crosses segments; **/x also matches a root-level x; x/** matches under x', () => {
    assert.ok(m('**/*.bicep', 'main.bicep'));
    assert.ok(m('**/*.bicep', 'infra/deep/main.bicep'));
    assert.ok(!m('**/*.bicep', 'main.bicep.bak'));
    assert.ok(m('a/**', 'a/b/c.ts'));
    assert.ok(!m('a/**', 'a'));
    assert.ok(!m('a/**', 'ab/c.ts'));
    assert.ok(m('a/**/z.ts', 'a/z.ts'));
    assert.ok(m('a/**/z.ts', 'a/b/c/z.ts'));
  });
  it('parentheses, brackets, dots and the rest are literal (Next.js route groups and dynamic segments)', () => {
    assert.ok(m('services/dashboard/app/(auth)/**', 'services/dashboard/app/(auth)/login/page.tsx'));
    assert.ok(!m('services/dashboard/app/(auth)/**', 'services/dashboard/app/auth/login/page.tsx'), '(auth) is not a regex group');
    assert.ok(m('app/api/auth/[...nextauth]/**', 'app/api/auth/[...nextauth]/route.ts'));
    assert.ok(!m('app/api/auth/[...nextauth]/**', 'app/api/auth/n/route.ts'), '[...] is not a character class');
    assert.ok(!m('app/api/auth/[...nextauth]/**', 'app/api/auth/.../route.ts'));
    assert.ok(m('app/[id]/page.tsx', 'app/[id]/page.tsx'));
    assert.ok(!m('app/[id]/page.tsx', 'app/i/page.tsx'));
    assert.ok(m('a.b/c+d/e$f/(x|y)^z', 'a.b/c+d/e$f/(x|y)^z'));
    assert.ok(!m('a.b', 'aXb'));
    assert.ok(m('{a,b}/x', '{a,b}/x'), 'no brace expansion');
    assert.ok(!m('{a,b}/x', 'a/x'));
  });
  it('is anchored and case-sensitive', () => {
    assert.ok(!m('a/b', 'x/a/b'));
    assert.ok(!m('a/b', 'a/b/c'));
    assert.ok(!m('A/b', 'a/b'));
  });
});

describe('loadPolicy', () => {
  it('reads the keys, with the default label', () => {
    const p = loadPolicy('ready_requirements:\n  signed_security_verdict: true\nsecurity_sensitive_globs:\n  - a/**\n  - services/(x)/**\n');
    assert.deepEqual(p, {
      signedVerdict: true, globs: ['a/**', 'services/(x)/**'], label: 'security', reviewLabel: 'security-review-requested', reviewLabelSet: false,
    });
    assert.equal(loadPolicy('security_sensitive_label: sec-review\n').label, 'sec-review');
    assert.equal(loadPolicy('repo: a/b\n').signedVerdict, false);
  });
  it('engsys#231: security_review_label names the review request, and says whether the config set it', () => {
    const p = loadPolicy('security_review_label: needs-nyx\n');
    assert.equal(p.reviewLabel, 'needs-nyx');
    assert.equal(p.reviewLabelSet, true);
    assert.equal(loadPolicy('security_review_label: security-review-requested\n').reviewLabelSet, true, 'set explicitly, even to the default');
  });
  it('refuses malformed values', () => {
    assert.throws(() => loadPolicy('security_sensitive_globs: oops\n'), /list of non-empty strings/);
    assert.throws(() => loadPolicy('security_sensitive_globs:\n  - ""\n'), /non-empty/);
    assert.throws(() => loadPolicy('security_sensitive_label: ""\n'), /non-empty/);
    assert.throws(() => loadPolicy('security_review_label: ""\n'), /non-empty/);
    // removing the request label must never remove the requirement
    assert.throws(() => loadPolicy('security_review_label: Security\n'), /must differ from security_sensitive_label/);
  });
});

describe('decide', () => {
  const policy = { signedVerdict: true, globs: ['sec/**'], label: 'security' };
  const f = (filename, previous_filename) => ({ filename, previous_filename });
  it('new and old paths both count; the label counts', () => {
    assert.equal(decide(policy, { files: [f('docs/a.md')], changedFiles: 1, labels: [] }).required, false);
    assert.equal(decide(policy, { files: [f('sec/a.ts')], changedFiles: 1, labels: [] }).required, true);
    const r = decide(policy, { files: [f('docs/a.md', 'sec/old.ts')], changedFiles: 1, labels: [] });
    assert.equal(r.required, true); assert.deepEqual(r.matched, ['sec/old.ts']);
    assert.equal(decide(policy, { files: [f('docs/a.md')], changedFiles: 1, labels: [{ name: 'Security' }] }).required, true);
  });
  it('fails closed on a short or unusable list; over 3000 files requires the verdict', () => {
    assert.throws(() => decide(policy, { files: [f('a')], changedFiles: 2, labels: [] }), /security_file_list_unreadable: 1 of 2/);
    assert.throws(() => decide(policy, { files: [], changedFiles: null, labels: [] }), /security_file_list_unreadable/);
    assert.throws(() => decide(policy, { changedFiles: 0, labels: [] }), /security_file_list_unreadable/);
    const r = decide(policy, { files: [f('a')], changedFiles: GITHUB_FILE_LIMIT + 1, labels: [] });
    assert.equal(r.required, true); assert.ok(r.reasons.includes(`changed_files_over_${GITHUB_FILE_LIMIT}`));
  });
  it('without globs only the label matters and no file list is needed', () => {
    const none = { signedVerdict: true, globs: [], label: 'security' };
    assert.equal(decide(none, { labels: [] }).required, false);
    assert.equal(decide(none, { labels: [{ name: 'security' }] }).required, true);
  });
});

describe('config.example.yml', () => {
  const { parseYaml } = createRequire(import.meta.url)('./yaml.js');
  const text = fs.readFileSync(new URL('../skills/merge-monster/config.example.yml', import.meta.url), 'utf8');
  it('keeps every ready_requirements key under it, and the security keys at the top level', () => {
    const cfg = parseYaml(text);
    assert.deepEqual(Object.keys(cfg.ready_requirements), ['review_marker', 'signed_security_verdict', 'security_verdict_key_file', 'sdd_contract']);
    assert.equal(cfg.ready_requirements.sdd_contract, false);
    assert.equal(cfg.ready_requirements.signed_security_verdict, false);
    assert.ok('security_sensitive_label' in cfg && !('security_sensitive_label' in cfg.ready_requirements));
    assert.equal(cfg.security_sensitive_label, 'security');
  });
  it('uncommenting the globs example gives the list', () => {
    const on = text.replace('  # - services/dashboard/app/(auth)/**', '  - services/dashboard/app/(auth)/**');
    assert.deepEqual(parseYaml(on).security_sensitive_globs, ['services/dashboard/app/(auth)/**']);
    assert.equal(parseYaml(on).ready_requirements.sdd_contract, false);
  });
});
