#!/usr/bin/env node
// spec-slice.mjs — heading-addressable Markdown spec slicer with path-containment enforcement
// and non-negotiable anchor propagation.
// Design: docs/specs/engsys-sdd-upgrade.md (NA-SDD-1, CT-SDD-01, CT-SDD-02, CT-SDD-08, #147).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from './is-main.mjs';

export function slugifyHeading(text) {
  return String(text ?? '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function makeSliceError(code, message, exitCode = 2) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

/**
 * Split a `docs/specs/foo.md#Heading` reference into `{ specPath, heading }`.
 */
export function parseSpecRef(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw makeSliceError('invalid_spec_path', 'empty spec reference');
  const hashIdx = raw.indexOf('#');
  if (hashIdx === -1) {
    return { specPath: raw, heading: '' };
  }
  return {
    specPath: raw.slice(0, hashIdx).trim(),
    heading: raw.slice(hashIdx + 1).trim(),
  };
}

/**
 * Validate that `specPath` is a relative path strictly inside `<repoRoot>/docs/specs/*.md` (NA-SDD-1).
 * Rejects `..` traversal, absolute paths, and symlink escapes outside `docs/specs/`.
 */
export function validateSpecPath(specPath, repoRoot = process.cwd()) {
  const raw = String(specPath ?? '').trim();
  if (!raw) {
    throw makeSliceError('invalid_spec_path', 'spec path must not be empty');
  }
  if (path.isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\') || raw.includes('\\')) {
    throw makeSliceError('invalid_spec_path', `absolute or backslash path rejected: ${raw}`);
  }
  const segments = raw.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    throw makeSliceError('invalid_spec_path', `path traversal rejected: ${raw}`);
  }
  if (!raw.startsWith('docs/specs/') || !raw.endsWith('.md')) {
    throw makeSliceError('invalid_spec_path', `spec path must reside under docs/specs/*.md: ${raw}`);
  }

  const rootResolved = path.resolve(repoRoot);
  const specsDir = path.join(rootResolved, 'docs', 'specs');
  const targetAbs = path.resolve(rootResolved, raw);
  if (!targetAbs.startsWith(specsDir + path.sep)) {
    throw makeSliceError('invalid_spec_path', `spec path escapes docs/specs/: ${raw}`);
  }

  if (fs.existsSync(targetAbs)) {
    const realSpecsDir = fs.existsSync(specsDir) ? fs.realpathSync(specsDir) : specsDir;
    const realTarget = fs.realpathSync(targetAbs);
    if (!realTarget.startsWith(realSpecsDir + path.sep)) {
      throw makeSliceError('invalid_spec_path', `symlink escapes docs/specs/: ${raw}`);
    }
  }

  return targetAbs;
}

/**
 * Parse YAML frontmatter from a spec Markdown document, extracting `spec_id`, `status`, `tier`,
 * and `non_negotiable_anchors` list items.
 */
export function parseSpecFrontmatter(markdown) {
  const text = String(markdown ?? '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  const fmBlock = m[1];
  const body = text.slice(m[0].length);
  const fm = {
    non_negotiable_anchors: [],
  };

  let inAnchors = false;
  for (const line of fmBlock.split(/\r?\n/)) {
    if (inAnchors) {
      const itemMatch = line.match(/^\s*-\s+(.+)$/);
      if (itemMatch) {
        fm.non_negotiable_anchors.push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
        continue;
      }
      if (/^\S/.test(line)) {
        inAnchors = false;
      } else {
        continue;
      }
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (key === 'non_negotiable_anchors') {
      if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim();
        fm.non_negotiable_anchors = inner
          ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
          : [];
      } else {
        inAnchors = true;
      }
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter: fm, body };
}

/**
 * Slice a Markdown heading subtree from a spec under `docs/specs/`.
 *
 * @param {string} specPathOrRef - Either `docs/specs/foo.md#Heading` or `docs/specs/foo.md`
 * @param {string|null} [headingArg] - Optional heading name/slug if not embedded in `specPathOrRef`
 * @param {object} [opts]
 * @returns {{ specPath: string, heading: string, headingTitle: string, level: number, section: string, anchors: string[], formatted: string, frontmatter: object }}
 */
export function sliceSpecHeading(
  specPathOrRef,
  headingArg = null,
  { repoRoot = process.cwd(), includeAnchors = true } = {},
) {
  const parsed =
    headingArg !== null && headingArg !== undefined && !String(specPathOrRef).includes('#')
      ? { specPath: String(specPathOrRef).trim(), heading: String(headingArg).trim() }
      : parseSpecRef(specPathOrRef);

  const absPath = validateSpecPath(parsed.specPath, repoRoot);
  if (!fs.existsSync(absPath)) {
    throw makeSliceError('spec_not_found', `spec file does not exist: ${parsed.specPath}`);
  }

  const rawText = fs.readFileSync(absPath, 'utf8');
  const { frontmatter, body } = parseSpecFrontmatter(rawText);
  const anchors = Array.isArray(frontmatter.non_negotiable_anchors)
    ? frontmatter.non_negotiable_anchors
    : [];

  let section = body.trim();
  let matchedTitle = '';
  let matchedLevel = 1;

  if (parsed.heading) {
    const wantSlug = slugifyHeading(parsed.heading);
    const wantRawLower = parsed.heading.toLowerCase().trim();
    const lines = rawText.split(/\r?\n/);

    let startIdx = -1;
    let level = 0;
    let inFence = false;
    let subIdx = -1;
    let subLevel = 0;
    let subTitle = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (!h) continue;
      const hLevel = h[1].length;
      const hText = h[2].trim();
      const hSlug = slugifyHeading(hText);
      if (hSlug === wantSlug || hText.toLowerCase() === wantRawLower) {
        startIdx = i;
        level = hLevel;
        matchedTitle = hText;
        matchedLevel = hLevel;
        break;
      }
      if (subIdx === -1 && wantSlug.length >= 4 && hSlug.includes(wantSlug)) {
        subIdx = i;
        subLevel = hLevel;
        subTitle = hText;
      }
    }

    if (startIdx === -1 && subIdx !== -1) {
      startIdx = subIdx;
      level = subLevel;
      matchedTitle = subTitle;
      matchedLevel = subLevel;
    }

    if (startIdx === -1) {
      throw makeSliceError(
        'heading_not_found',
        `section "#${parsed.heading}" not found in ${parsed.specPath}`,
      );
    }

    let endIdx = lines.length;
    inFence = false;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = line.match(/^(#{1,6})\s+/);
      if (h && h[1].length <= level) {
        endIdx = i;
        break;
      }
    }

    section = lines.slice(startIdx, endIdx).join('\n').trim();
  }

  let formatted = section;
  if (includeAnchors && anchors.length > 0) {
    const specLabel = frontmatter.spec_id || parsed.specPath;
    const anchorLines = anchors.map((a) => `> - ${a}`).join('\n');
    formatted = `> **Non-Negotiable Anchors (${specLabel}):**\n${anchorLines}\n\n${section}`;
  }

  return {
    specPath: parsed.specPath,
    heading: parsed.heading,
    headingTitle: matchedTitle,
    level: matchedLevel,
    section,
    anchors,
    formatted,
    frontmatter,
  };
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'repo-root': { type: 'string', default: process.cwd() },
      json: { type: 'boolean', default: false },
      'no-anchors': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (positionals.length === 0) {
    err.write('Usage: spec-slice.mjs [--repo-root <dir>] [--json] <docs/specs/file.md#Heading>...\n');
    return 2;
  }

  const repoRoot = path.resolve(String(values['repo-root'] || process.cwd()));
  const includeAnchors = !values['no-anchors'];
  const results = [];

  try {
    for (const ref of positionals) {
      results.push(sliceSpecHeading(ref, null, { repoRoot, includeAnchors }));
    }
  } catch (e) {
    err.write(`${e?.message || e}\n`);
    return typeof e?.exitCode === 'number' ? e.exitCode : 2;
  }

  if (values.json) {
    out.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  } else {
    out.write(results.map((r) => r.formatted).join('\n\n---\n\n') + '\n');
  }
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(main());
}
