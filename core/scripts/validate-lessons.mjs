#!/usr/bin/env node
// validate-lessons.mjs — enforce the lesson frontmatter schema (docs/memory-spec.md §2) on every
// `lessons-library/*.md`. Wired into `npm test` (scripts/run-tests.mjs) so a lesson PR that omits
// or malforms frontmatter fails CI the same way any other suite would.
//
// Zero-dependency ESM, Node >= 20. Reuses the repo's own CJS YAML-subset parser (lib/yaml.js) for
// the frontmatter block — frontmatter is a flat map of scalars/lists, well inside that parser's
// supported subset.
//
// Schema (all six keys required on every lesson file except README.md):
//   globs:      string[]   file globs this lesson is relevant to; [] = not path-anchored
//   stacks:     string[]   stack-pack ids (stacks/<category>/<value>); [] = every stack
//   roles:      string[]   agent types (bare, no `engsys:` namespace); [] = every role
//   keywords:   string[]   non-empty; terms blended into the brief's BM25 match
//   security:   boolean
//   supersedes: string[]   slugs (filenames without .md) of lessons this one replaces; each must
//                          exist in the same directory (a dangling reference is almost always a typo)
//
// CLI:
//   node validate-lessons.mjs [dir]   (default: core/lessons-library, resolved from this file)
// Exit 0 if every file is valid, 1 otherwise. Prints one line per error, `-- <file>: <message>`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../lib/yaml.js';
import { isMainEntry } from '../lib/is-main.mjs';

const REQUIRED_ARRAY_KEYS = ['globs', 'stacks', 'roles', 'keywords', 'supersedes'];
const SCHEMA_KEYS = new Set([...REQUIRED_ARRAY_KEYS, 'security']);

/** Split `text` into `{ frontmatter, body }`. `frontmatter` is the raw YAML (no delimiters), or
 * null if the file has no leading `---` block. Never throws. */
export function splitFrontmatter(text) {
	if (!text.startsWith('---\n') && text !== '---') return { frontmatter: null, body: text };
	const end = text.indexOf('\n---', 4);
	if (end === -1) return { frontmatter: null, body: text };
	// the close fence is '\n---' followed by end-of-string, '\n', or (rare) '\r\n'
	const afterFence = end + 4;
	const rest = text.slice(afterFence);
	if (rest !== '' && !/^\r?\n/.test(rest)) return { frontmatter: null, body: text };
	return { frontmatter: text.slice(4, end), body: rest.replace(/^\r?\n/, '') };
}

/**
 * Validate one lesson's already-parsed frontmatter object against the schema.
 * Returns an array of error strings (empty = valid). `knownSlugs` (a Set) is used to check
 * `supersedes` references; pass null to skip that check (e.g. validating a single file in
 * isolation).
 */
export function validateFrontmatter(fm, { knownSlugs = null, selfSlug = null } = {}) {
	const errors = [];
	if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
		return ['missing or malformed frontmatter block (expected a leading `---`-delimited YAML map)'];
	}
	for (const key of Object.keys(fm)) {
		if (!SCHEMA_KEYS.has(key)) errors.push(`unknown frontmatter key "${key}"`);
	}
	for (const key of REQUIRED_ARRAY_KEYS) {
		if (!(key in fm)) { errors.push(`missing required key "${key}"`); continue; }
		const v = fm[key];
		if (!Array.isArray(v)) { errors.push(`"${key}" must be an array, got ${JSON.stringify(v)}`); continue; }
		if (!v.every((x) => typeof x === 'string')) errors.push(`"${key}" must be an array of strings`);
	}
	if (!('security' in fm)) errors.push('missing required key "security"');
	else if (typeof fm.security !== 'boolean') errors.push(`"security" must be a boolean, got ${JSON.stringify(fm.security)}`);

	if (Array.isArray(fm.keywords) && fm.keywords.length === 0) errors.push('"keywords" must not be empty');

	if (Array.isArray(fm.supersedes)) {
		if (selfSlug && fm.supersedes.includes(selfSlug)) errors.push(`"supersedes" cannot reference itself (${selfSlug})`);
		if (knownSlugs) {
			for (const slug of fm.supersedes) {
				if (!knownSlugs.has(slug)) errors.push(`"supersedes" references unknown lesson "${slug}"`);
			}
		}
	}
	return errors;
}

/** Validate every `*.md` file in `dir` except README.md. Returns `{ file, errors }[]` for files
 * with at least one error (empty array = all valid). */
export function validateDir(dir) {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
	const knownSlugs = new Set(files.map((f) => f.replace(/\.md$/, '')));
	const results = [];
	for (const f of files) {
		const slug = f.replace(/\.md$/, '');
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const { frontmatter } = splitFrontmatter(text);
		let fm = null;
		let parseError = null;
		if (frontmatter !== null) {
			try { fm = parseYaml(frontmatter); } catch (err) { parseError = err?.message || String(err); }
		}
		const errors = parseError
			? [`frontmatter did not parse as YAML: ${parseError}`]
			: validateFrontmatter(fm, { knownSlugs, selfSlug: slug });
		if (errors.length) results.push({ file: f, errors });
	}
	return results;
}

function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
	const dir = argv[0]
		? path.resolve(cwd, argv[0])
		: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lessons-library');
	if (!fs.existsSync(dir)) { err(`validate-lessons: no such directory: ${dir}`); return 1; }
	const bad = validateDir(dir);
	const total = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
	if (bad.length === 0) { out(`validate-lessons: OK — ${total} lesson(s) valid in ${dir}`); return 0; }
	for (const { file, errors } of bad) for (const e of errors) err(`-- ${file}: ${e}`);
	err(`validate-lessons: ${bad.length}/${total} lesson(s) invalid in ${dir}`);
	return 1;
}

if (isMainEntry(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
