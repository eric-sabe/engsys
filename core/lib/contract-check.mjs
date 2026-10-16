#!/usr/bin/env node
// contract-check.mjs — pre-PR and pre-merge contract verification gate.
// Validates `<!-- engsys:issue-meta -->`, enforces `touches` globs (with `### Co-commit justification`
// override), resolves `spec_refs` via `spec-slice.mjs`, and verifies `CT-*` Testing Strategy case IDs.
// Design: docs/specs/engsys-sdd-upgrade.md (NA-SDD-4, CT-SDD-03..CT-SDD-07, #147).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from './is-main.mjs';
import { sliceSpecHeading } from './spec-slice.mjs';

/**
 * Parse `<!-- engsys:issue-meta ... -->` from an issue body.
 * Returns `{ present: boolean, valid: boolean, meta: object | null, error: string | null }`.
 */
export function parseIssueMeta(body) {
  const text = String(body ?? '');
  if (!/<!--\s*engsys:issue-meta\b/.test(text)) {
    return { present: false, valid: true, meta: null, error: null };
  }
  const m = text.match(/<!--\s*engsys:issue-meta\s*\r?\n([\s\S]*?)-->/);
  if (!m) {
    return {
      present: true,
      valid: false,
      meta: null,
      error: 'unclosed <!-- engsys:issue-meta --> comment block',
    };
  }

  const block = m[1];
  const meta = {};
  let activeListKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (activeListKey && /^\s*-\s+/.test(rawLine)) {
      const item = rawLine
        .replace(/^\s*-\s+/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
      if (item) meta[activeListKey].push(item);
      continue;
    }
    activeListKey = null;
    const kv = trimmed.match(/^([A-Za-z0-9_ -]+?)\s*:\s*(.*)$/);
    if (!kv) {
      return {
        present: true,
        valid: false,
        meta: null,
        error: `malformed line in engsys:issue-meta: "${trimmed}"`,
      };
    }
    const [, rawKey, rawVal] = kv;
    const key = rawKey.trim();
    const val = rawVal.trim();
    if (val === '') {
      meta[key] = [];
      activeListKey = key;
    } else if (val.startsWith('[') || val.endsWith(']')) {
      if (!val.startsWith('[') || !val.endsWith(']')) {
        return {
          present: true,
          valid: false,
          meta: null,
          error: `unbalanced array brackets for key "${key}" in engsys:issue-meta`,
        };
      }
      const inner = val.slice(1, -1).trim();
      meta[key] =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
    } else if (val === 'true' || val === 'false') {
      meta[key] = val === 'true';
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  if (meta.touches !== undefined && (!Array.isArray(meta.touches) || meta.touches.length === 0)) {
    return {
      present: true,
      valid: false,
      meta: null,
      error: 'engsys:issue-meta `touches` must be a non-empty array of globs',
    };
  }

  return { present: true, valid: true, meta, error: null };
}

/**
 * Check whether a PR body contains a non-empty `### Co-commit justification` section (NA-SDD-4).
 */
export function hasCoCommitJustification(prBody) {
  const text = String(prBody ?? '');
  const m = text.match(/^#{2,4}\s+Co-commit\s+justification\s*$/im);
  if (!m) return false;
  const after = text.slice(m.index + m[0].length);
  const nextHeading = after.search(/^#{1,4}\s+/m);
  const sectionBody = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
  return sectionBody.length > 0;
}

/**
 * Match a repo-relative file path against a list of `touches` globs.
 */
export function matchesTouchesGlobs(filePath, globs = []) {
  const normFile = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  for (const rawGlob of globs) {
    const g = String(rawGlob ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!g) continue;
    if (g === normFile) return true;
    if (typeof path.matchesGlob === 'function' && path.matchesGlob(normFile, g)) {
      return true;
    }
    if (g.endsWith('/**')) {
      const prefix = g.slice(0, -3);
      if (normFile === prefix || normFile.startsWith(prefix + '/')) return true;
    }
    if (g.endsWith('/*')) {
      const prefix = g.slice(0, -2);
      if (normFile.startsWith(prefix + '/') && !normFile.slice(prefix.length + 1).includes('/')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract `CT-*` Case IDs from markdown tables in a sliced spec section.
 */
export function extractTestingStrategyCaseIds(sectionText) {
  const ids = new Set();
  const text = String(sectionText ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    for (const m of line.matchAll(/\b(CT-[A-Z0-9-]+)\b/g)) {
      ids.add(m[1]);
    }
  }
  return [...ids];
}

function collectRepoTestFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'worktrees') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectRepoTestFiles(full, out);
    } else if (
      /\.(test|spec)\.(mjs|js|cjs|ts|tsx|sh)$/.test(ent.name) ||
      full.includes(`${path.sep}tests${path.sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Verify issue metadata contracts (`touches`, `spec_refs`, and `CT-*` test obligations) against a worktree/PR.
 */
export function verifyContract({
  repoRoot = process.cwd(),
  issueBodies = [],
  changedFiles = null,
  baseRef = 'origin/main',
  prBody = '',
  tier = null,
  checkTestIds = true,
} = {}) {
  const errors = [];
  const warnings = [];
  const metas = [];

  for (const [idx, body] of issueBodies.entries()) {
    const parsed = parseIssueMeta(body);
    if (!parsed.present) continue;
    if (!parsed.valid) {
      errors.push(`Issue[${idx + 1}]: ${parsed.error}`);
      return {
        ok: false,
        status: 'malformed_issue_meta',
        undeclaredTouches: [],
        missingCaseIds: [],
        resolvedSpecSlices: [],
        errors,
        warnings,
      };
    }
    metas.push(parsed.meta);
  }

  if (metas.length === 0) {
    if (String(tier || '').toUpperCase() === 'S') {
      warnings.push('No <!-- engsys:issue-meta --> block found; bypassed under --tier S.');
      return {
        ok: true,
        status: 'tier_s_bypass',
        undeclaredTouches: [],
        missingCaseIds: [],
        resolvedSpecSlices: [],
        errors: [],
        warnings,
      };
    }
    errors.push('Missing <!-- engsys:issue-meta --> block on non-Tier-S work item.');
    return {
      ok: false,
      status: 'missing_issue_meta',
      undeclaredTouches: [],
      missingCaseIds: [],
      resolvedSpecSlices: [],
      errors,
      warnings,
    };
  }

  const allTouches = [...new Set(metas.flatMap((m) => (Array.isArray(m.touches) ? m.touches : [])))];
  const allSpecRefs = [...new Set(metas.flatMap((m) => (Array.isArray(m.spec_refs) ? m.spec_refs : [])))];

  let files = changedFiles;
  if (!Array.isArray(files)) {
    try {
      const raw = execFileSync('git', ['-C', repoRoot, 'diff', '--name-only', `${baseRef}...HEAD`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      files = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (e) {
      errors.push(`could not diff ${baseRef}...HEAD in ${repoRoot}: ${e?.message || e}`);
      files = [];
    }
  }

  const undeclaredTouches = [];
  if (allTouches.length > 0) {
    for (const f of files) {
      if (!matchesTouchesGlobs(f, allTouches)) {
        undeclaredTouches.push(f);
      }
    }
  }

  const coCommitAllowed = hasCoCommitJustification(prBody);
  if (undeclaredTouches.length > 0 && !coCommitAllowed) {
    errors.push(
      `Undeclared file touches outside engsys:issue-meta \`touches\` globs: ${undeclaredTouches.join(', ')} (add a ### Co-commit justification section in the PR body if intentional)`,
    );
  } else if (undeclaredTouches.length > 0 && coCommitAllowed) {
    warnings.push(
      `Undeclared file touches permitted via ### Co-commit justification: ${undeclaredTouches.join(', ')}`,
    );
  }

  const resolvedSpecSlices = [];
  const requiredCaseIds = new Set();

  for (const ref of allSpecRefs) {
    try {
      const sliced = sliceSpecHeading(ref, null, { repoRoot });
      resolvedSpecSlices.push(sliced);
      for (const cid of extractTestingStrategyCaseIds(sliced.section)) {
        requiredCaseIds.add(cid);
      }
    } catch (e) {
      errors.push(`spec_ref "${ref}" failed validation: ${e?.message || e}`);
    }
  }

  const missingCaseIds = [];
  if (checkTestIds && requiredCaseIds.size > 0) {
    const testFiles = collectRepoTestFiles(repoRoot);
    const combinedTestCorpus = testFiles
      .map((tf) => {
        try {
          return fs.readFileSync(tf, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');

    for (const cid of requiredCaseIds) {
      if (!combinedTestCorpus.includes(cid)) {
        missingCaseIds.push(cid);
      }
    }
    if (missingCaseIds.length > 0) {
      errors.push(
        `Missing Testing Strategy Case IDs in test suite: ${missingCaseIds.join(', ')}`,
      );
    }
  }

  const ok = errors.length === 0;
  const status = ok
    ? 'ok'
    : undeclaredTouches.length > 0 && !coCommitAllowed
      ? 'undeclared_touches'
      : missingCaseIds.length > 0
        ? 'missing_test_case_ids'
        : 'contract_error';

  return {
    ok,
    status,
    undeclaredTouches,
    missingCaseIds,
    resolvedSpecSlices: resolvedSpecSlices.map((s) => ({
      specPath: s.specPath,
      heading: s.heading,
      headingTitle: s.headingTitle,
    })),
    errors,
    warnings,
  };
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'repo-root': { type: 'string', default: '' },
      root: { type: 'string', default: '' },
      'issue-file': { type: 'string', multiple: true, default: [] },
      'pr-body-file': { type: 'string', default: '' },
      'changed-files': { type: 'string', default: '' },
      base: { type: 'string', default: 'origin/main' },
      tier: { type: 'string', default: '' },
      'no-test-id-check': { type: 'boolean', default: false },
    },
    strict: false,
  });

  const repoRoot = path.resolve(String(values['repo-root'] || values.root || process.cwd()));
  const issueBodies = (values['issue-file'] || []).map((f) => fs.readFileSync(path.resolve(f), 'utf8'));
  const prBody = values['pr-body-file']
    ? fs.readFileSync(path.resolve(String(values['pr-body-file'])), 'utf8')
    : '';
  const changedFiles = values['changed-files']
    ? String(values['changed-files'])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const res = verifyContract({
    repoRoot,
    issueBodies,
    changedFiles,
    baseRef: String(values.base || 'origin/main'),
    prBody,
    tier: values.tier ? String(values.tier) : null,
    checkTestIds: !values['no-test-id-check'],
  });

  out.write(JSON.stringify(res, null, 2) + '\n');
  if (!res.ok) {
    for (const e of res.errors) err.write(`contract-check: ${e}\n`);
    return 1;
  }
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(main());
}
