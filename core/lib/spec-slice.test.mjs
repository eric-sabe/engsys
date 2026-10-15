import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main, sliceSpecHeading, validateSpecPath } from './spec-slice.mjs';

describe('spec-slice.mjs (#147)', () => {
  it('CT-SDD-01 & CT-SDD-08: extracts exact Markdown heading subtrees and prepends non_negotiable_anchors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-slice-test-'));
    try {
      const specsDir = path.join(tmpDir, 'docs', 'specs');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(
        path.join(specsDir, 'sample.md'),
        [
          '---',
          'spec_id: SPEC-TEST-01',
          'status: draft',
          'tier: M',
          'non_negotiable_anchors:',
          '  - "NA-1: Never bypass path validation"',
          '  - "NA-2: Always verify touches globs"',
          '---',
          '',
          '# Sample Spec',
          '',
          '## Intro',
          'Intro paragraph.',
          '',
          '## Architecture Specification',
          'Top-level architecture overview.',
          '',
          '### Sub-component A',
          'Details of sub-component A.',
          '',
          '## Security and Privacy Specification',
          'Security details that must not leak into Architecture slice.',
        ].join('\n'),
        'utf8',
      );

      const res = sliceSpecHeading('docs/specs/sample.md#Architecture Specification', null, {
        repoRoot: tmpDir,
      });
      assert.equal(res.headingTitle, 'Architecture Specification');
      assert.equal(res.level, 2);
      assert.ok(res.section.includes('Top-level architecture overview.'));
      assert.ok(res.section.includes('### Sub-component A'));
      assert.ok(!res.section.includes('Security details'));
      assert.equal(res.anchors.length, 2);
      assert.ok(res.formatted.includes('Non-Negotiable Anchors (SPEC-TEST-01)'));
      assert.ok(res.formatted.includes('NA-1: Never bypass path validation'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CT-SDD-02 & NA-SDD-1: rejects paths outside docs/specs/, traversal (..), and missing headings with exit 2', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-slice-neg-'));
    try {
      const specsDir = path.join(tmpDir, 'docs', 'specs');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, 'valid.md'), '# Title\n\n## Known Section\nHello\n', 'utf8');

      for (const bad of [
        'docs/specs/../../etc/passwd',
        '../docs/specs/valid.md',
        '/etc/passwd',
        'README.md',
        'docs/specs/not-markdown.txt',
      ]) {
        assert.throws(
          () => validateSpecPath(bad, tmpDir),
          (err) => err.code === 'invalid_spec_path' && err.exitCode === 2,
          `expected invalid_spec_path for ${bad}`,
        );
      }

      assert.throws(
        () => sliceSpecHeading('docs/specs/valid.md#NonExistentHeading', null, { repoRoot: tmpDir }),
        (err) => err.code === 'heading_not_found' && err.exitCode === 2,
      );

      let errBuf = '';
      const code = main(['--repo-root', tmpDir, 'docs/specs/../../etc/passwd#Foo'], {
        out: { write: () => {} },
        err: { write: (s) => (errBuf += s) },
      });
      assert.equal(code, 2);
      assert.match(errBuf, /invalid_spec_path/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
