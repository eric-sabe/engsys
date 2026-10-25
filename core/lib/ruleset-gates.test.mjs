// Tests for ruleset-gates.mjs (engsys#271) — run by `npm test`. No network: rules are fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, matchRules, reviewerRules } from './ruleset-gates.mjs';

const RULES = [
  { type: 'deletion', ruleset_id: 1, parameters: {} },
  { type: 'pull_request', ruleset_id: 13606201, parameters: { required_reviewers: [
    { file_patterns: ['.claude/**', 'infrastructure/**', '**/CLAUDE.md', '.gitleaks.toml'], minimum_approvals: 1, reviewer: { id: 19613410, type: 'Team' } },
    { file_patterns: [], minimum_approvals: 1, reviewer: { id: 5, type: 'Team' } },
  ] } },
  { type: 'pull_request', ruleset_id: 2, parameters: { required_approving_review_count: 1 } },
];

test('reviewerRules keeps only path-based required reviewers, with their ruleset and team', () => {
  assert.deepEqual(reviewerRules(RULES), [{ rulesetId: 13606201, reviewer: { type: 'Team', id: 19613410 }, minimumApprovals: 1, patterns: ['.claude/**', 'infrastructure/**', '**/CLAUDE.md', '.gitleaks.toml'] }]);
  assert.deepEqual(reviewerRules(null), []);
  assert.deepEqual(reviewerRules([{ type: 'pull_request', parameters: {} }]), []);
});

test('matchRules: a matching file gates the PR; others do not', () => {
  const rules = reviewerRules(RULES);
  const g = matchRules(rules, ['.claude/settings.json', 'README.md']);
  assert.equal(g.gated, true);
  assert.deepEqual(g.rules[0].files, ['.claude/settings.json']);
  assert.equal(matchRules(rules, ['CLAUDE.md']).gated, true, '**/ also matches at the root');
  assert.equal(matchRules(rules, ['services/a/CLAUDE.md']).gated, true);
  assert.equal(matchRules(rules, ['.gitleaks.toml']).gated, true);
  assert.equal(matchRules(rules, ['docs/.gitleaks.toml', 'src/infrastructure/x.ts', 'claude/settings.json']).gated, false, 'patterns are anchored');
  assert.deepEqual(matchRules(rules, []), { gated: false, rules: [] });
  assert.deepEqual(matchRules([], ['.claude/x']), { gated: false, rules: [] });
});

test('compilePattern: GitHub fnmatch (PATHNAME | DOTMATCH | EXTGLOB) for ruleset file patterns', () => {
  const m = (p, f) => { const c = compilePattern(p); assert.ok(c.re, `${p}: ${c.unknown}`); return c.re.test(f); };
  assert.equal(m('.claude/**', '.claude/a/b.json'), true, 'x/** is everything under x');
  assert.equal(m('.claude/**', '.claude'), false);
  assert.equal(m('**/CLAUDE.md', 'CLAUDE.md'), true, '**/ also at the root');
  assert.equal(m('docs/**/x.md', 'docs/a/b/x.md'), true);
  assert.equal(m('docs/**/x.md', 'docs/x.md'), true);
  assert.equal(m('foo**', 'foobar'), true, '** inside a segment is *');
  assert.equal(m('foo**', 'foo/bar'), false, '…and never crosses / (no over-gating)');
  assert.equal(m('a**b/c', 'a/x/b/c'), false);
  assert.equal(m('*.{yml,yaml}', 'ci.yaml'), true, 'braces');
  assert.equal(m('{infra,ops}/**', 'ops/x/y'), true);
  assert.equal(m('src/[abc].ts', 'src/b.ts'), true, 'classes');
  assert.equal(m('src/[a-c].ts', 'src/d.ts'), false);
  assert.equal(m('src/[!abc].ts', 'src/d.ts'), true, 'negated classes');
  assert.equal(m('src/[^abc].ts', 'src/a.ts'), false);
  assert.equal(m('src/[!x].ts', 'src//.ts'), false, 'a class never matches /');
  assert.equal(m('*', '.hidden'), true, 'DOTMATCH');
  assert.equal(m('*', 'a/b'), false, 'PATHNAME');
  assert.equal(m('a\\*b', 'a*b'), true, 'escapes');
  assert.equal(m('a\\*b', 'axb'), false);
  assert.equal(m('/.github/workflows/**', '.github/workflows/ci.yml'), true, 'a leading / is the repo root');
});

test('compilePattern / matchRules: syntax outside the subset is unknown and never gates', () => {
  for (const p of ['!infrastructure/**', 'a[b', '{a,{b}}', 'x{y', '']) assert.ok(compilePattern(p).unknown, p);
  const rules = [{ rulesetId: 9, reviewer: { type: 'Team', id: 1 }, minimumApprovals: 1, patterns: ['!docs/**', 'a[b'] }];
  const r = matchRules(rules, ['docs/x.md', 'a[b']);
  assert.equal(r.gated, false);
  assert.deepEqual(r.unknown.map((u) => [u.rulesetId, u.pattern]), [[9, '!docs/**'], [9, 'a[b']]);
  const mixed = matchRules([{ ...rules[0], patterns: ['!docs/**', '.claude/**'] }], ['.claude/x']);
  assert.equal(mixed.gated, true, 'a known pattern in the same rule still gates');
});
