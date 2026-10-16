import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseIssueMeta, verifyContract } from './contract-check.mjs';

describe('contract-check.mjs (#147)', () => {
  it('CT-SDD-03 & CT-SDD-04: flags undeclared file touches unless ### Co-commit justification is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-touches-'));
    try {
      const specsDir = path.join(tmpDir, 'docs', 'specs');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(
        path.join(specsDir, 'feat.md'),
        '# Feat\n\n## Architecture\nDetails.\n',
        'utf8',
      );

      const issueBody = [
        'Implement feature.',
        '',
        '<!-- engsys:issue-meta',
        'depends_on: []',
        'touches: ["core/lib/**"]',
        'risk: low',
        'needs_judgment: false',
        'spec_refs: ["docs/specs/feat.md#Architecture"]',
        'no_external: false',
        '-->',
      ].join('\n');

      // 1. Touching an undeclared path fails with undeclared_touches
      const failRes = verifyContract({
        repoRoot: tmpDir,
        issueBodies: [issueBody],
        changedFiles: ['core/lib/spec-slice.mjs', 'stacks/db/prisma/SKILL.md'],
        prBody: ' Summary\nCloses #147',
      });
      assert.equal(failRes.ok, false);
      assert.equal(failRes.status, 'undeclared_touches');
      assert.deepEqual(failRes.undeclaredTouches, ['stacks/db/prisma/SKILL.md']);

      // 2. Adding ### Co-commit justification allows the undeclared path with a warning
      const passRes = verifyContract({
        repoRoot: tmpDir,
        issueBodies: [issueBody],
        changedFiles: ['core/lib/spec-slice.mjs', 'stacks/db/prisma/SKILL.md'],
        prBody: '## Summary\n\n### Co-commit justification\nShared type export needed by prisma skill.\n',
      });
      assert.equal(passRes.ok, true);
      assert.equal(passRes.warnings.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CT-SDD-05: verifies Testing Strategy CT-* Case IDs exist in repository test files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-ct-'));
    try {
      const specsDir = path.join(tmpDir, 'docs', 'specs');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(
        path.join(specsDir, 'feat.md'),
        [
          '# Feat',
          '',
          '## Testing Strategy',
          '| Case ID | Scenario |',
          '| --- | --- |',
          '| `CT-FEAT-01` | Happy path |',
          '| `CT-FEAT-02` | Negative path |',
        ].join('\n'),
        'utf8',
      );

      const issueBody = [
        '<!-- engsys:issue-meta',
        'depends_on: []',
        'touches: ["core/**"]',
        'spec_refs: ["docs/specs/feat.md#Testing Strategy"]',
        '-->',
      ].join('\n');

      fs.mkdirSync(path.join(tmpDir, 'core'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'core', 'feat.test.mjs'),
        '// covers CT-FEAT-01 only\n',
        'utf8',
      );

      const missingRes = verifyContract({
        repoRoot: tmpDir,
        issueBodies: [issueBody],
        changedFiles: ['core/feat.test.mjs'],
      });
      assert.equal(missingRes.ok, false);
      assert.equal(missingRes.status, 'missing_test_case_ids');
      assert.deepEqual(missingRes.missingCaseIds, ['CT-FEAT-02']);

      fs.writeFileSync(
        path.join(tmpDir, 'core', 'feat.test.mjs'),
        '// covers CT-FEAT-01 and CT-FEAT-02\n',
        'utf8',
      );
      const completeRes = verifyContract({
        repoRoot: tmpDir,
        issueBodies: [issueBody],
        changedFiles: ['core/feat.test.mjs'],
      });
      assert.equal(completeRes.ok, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CT-SDD-06 & CT-SDD-07: supports --tier S bypass on missing meta and fails closed on malformed engsys:issue-meta', () => {
    const bypassRes = verifyContract({
      issueBodies: ['Simple Tier S bugfix without meta comment.'],
      changedFiles: ['core/lib/foo.mjs'],
      tier: 'S',
    });
    assert.equal(bypassRes.ok, true);
    assert.equal(bypassRes.status, 'tier_s_bypass');

    const malformedBody = '<!-- engsys:issue-meta\ntouches: ["unclosed\n-->';
    const parsed = parseIssueMeta(malformedBody);
    assert.equal(parsed.valid, false);

    const malformedRes = verifyContract({
      issueBodies: [malformedBody],
      changedFiles: ['core/lib/foo.mjs'],
    });
    assert.equal(malformedRes.ok, false);
    assert.equal(malformedRes.status, 'malformed_issue_meta');
  });

  it('parses multi-line YAML block lists and spaced keys from jody.md / bert.md templates', () => {
    const blockBody = [
      '<!-- engsys:issue-meta',
      'schema: 1',
      'track: feature',
      'Recommended agent: isabelle',
      'depends_on: []',
      'touches:',
      '  - core/lib/**',
      '  - core/agents/isabelle.md',
      'spec_refs:',
      '  - docs/specs/feat.md#Architecture',
      'verify:',
      '  - npm test',
      '-->',
    ].join('\n');
    const parsed = parseIssueMeta(blockBody);
    assert.equal(parsed.present, true);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.meta['Recommended agent'], 'isabelle');
    assert.deepEqual(parsed.meta.touches, ['core/lib/**', 'core/agents/isabelle.md']);
    assert.deepEqual(parsed.meta.spec_refs, ['docs/specs/feat.md#Architecture']);
    assert.deepEqual(parsed.meta.verify, ['npm test']);
  });
});

