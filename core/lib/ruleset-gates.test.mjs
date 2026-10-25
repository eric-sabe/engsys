// Tests for ruleset-gates.mjs (engsys#271) — run by `npm test`. No network: rules are fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRules, reviewerRules } from './ruleset-gates.mjs';

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
