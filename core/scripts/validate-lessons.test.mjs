// Tests for validate-lessons.mjs — run by `node --test core/scripts/validate-lessons.test.mjs`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, validateFrontmatter, validateDir } from './validate-lessons.mjs';

const SCRIPT = fileURLToPath(new URL('./validate-lessons.mjs', import.meta.url));

const VALID_FM = [
	'---',
	'globs: []',
	'stacks: []',
	'roles: ["isabelle"]',
	'keywords: ["foo", "bar"]',
	'security: false',
	'supersedes: []',
	'---',
	'',
	'# Title',
	'',
	'body',
	'',
].join('\n');

function withDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'validate-lessons-'));
	try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('splitFrontmatter', () => {
	test('splits a valid frontmatter block from the body', () => {
		const { frontmatter, body } = splitFrontmatter(VALID_FM);
		assert.match(frontmatter, /security: false/);
		assert.match(body, /# Title/);
	});

	test('returns null frontmatter when there is no leading --- block', () => {
		const { frontmatter, body } = splitFrontmatter('# Title\n\nbody\n');
		assert.equal(frontmatter, null);
		assert.equal(body, '# Title\n\nbody\n');
	});

	test('does not treat a `---` horizontal rule mid-body as a second frontmatter block', () => {
		const text = `${VALID_FM}\nmore\n\n---\n\nmore still\n`;
		const { body } = splitFrontmatter(text);
		assert.match(body, /---/); // the mid-body rule survives in the body untouched
	});
});

describe('validateFrontmatter', () => {
	test('accepts a fully-populated, schema-conformant object', () => {
		const fm = { globs: [], stacks: [], roles: ['isabelle'], keywords: ['x'], security: false, supersedes: [] };
		assert.deepEqual(validateFrontmatter(fm), []);
	});

	test('rejects a missing frontmatter block outright', () => {
		const errors = validateFrontmatter(null);
		assert.ok(errors.length > 0);
		assert.match(errors[0], /missing or malformed/);
	});

	test('flags each missing required key', () => {
		const errors = validateFrontmatter({});
		for (const key of ['globs', 'stacks', 'roles', 'keywords', 'security', 'supersedes']) {
			assert.ok(errors.some((e) => e.includes(`"${key}"`)), `expected an error mentioning ${key}`);
		}
	});

	test('rejects a non-boolean security value', () => {
		const fm = { globs: [], stacks: [], roles: [], keywords: ['x'], security: 'true', supersedes: [] };
		const errors = validateFrontmatter(fm);
		assert.ok(errors.some((e) => e.includes('security')));
	});

	test('rejects an empty keywords array', () => {
		const fm = { globs: [], stacks: [], roles: [], keywords: [], security: false, supersedes: [] };
		const errors = validateFrontmatter(fm);
		assert.ok(errors.some((e) => e.includes('keywords')));
	});

	test('flags an unknown frontmatter key', () => {
		const fm = { globs: [], stacks: [], roles: [], keywords: ['x'], security: false, supersedes: [], extra: 1 };
		const errors = validateFrontmatter(fm);
		assert.ok(errors.some((e) => e.includes('unknown frontmatter key "extra"')));
	});

	test('flags a dangling supersedes reference against knownSlugs', () => {
		const fm = { globs: [], stacks: [], roles: [], keywords: ['x'], security: false, supersedes: ['ghost-lesson'] };
		const errors = validateFrontmatter(fm, { knownSlugs: new Set(['other-lesson']) });
		assert.ok(errors.some((e) => e.includes('ghost-lesson')));
	});

	test('flags a lesson that supersedes itself', () => {
		const fm = { globs: [], stacks: [], roles: [], keywords: ['x'], security: false, supersedes: ['self-lesson'] };
		const errors = validateFrontmatter(fm, { knownSlugs: new Set(['self-lesson']), selfSlug: 'self-lesson' });
		assert.ok(errors.some((e) => e.includes('cannot reference itself')));
	});
});

describe('validateDir', () => {
	test('a directory of all-valid lessons reports zero bad files', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'a.md'), VALID_FM);
			writeFileSync(join(dir, 'README.md'), '# not a lesson, no frontmatter needed\n');
			assert.deepEqual(validateDir(dir), []);
		});
	});

	test('a lesson with no frontmatter is reported invalid', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'bad.md'), '# Title\n\nno frontmatter here\n');
			const bad = validateDir(dir);
			assert.equal(bad.length, 1);
			assert.equal(bad[0].file, 'bad.md');
		});
	});

	test('malformed YAML inside the frontmatter fence is reported, not thrown', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'bad.md'), '---\nglobs: [unterminated\n---\n\n# Title\n');
			const bad = validateDir(dir);
			assert.equal(bad.length, 1);
		});
	});
});

describe('CLI', () => {
	test('exits 0 and prints OK for a valid directory', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'a.md'), VALID_FM);
			const out = execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' });
			assert.match(out, /OK — 1 lesson/);
		});
	});

	test('exits 1 and prints per-file errors for an invalid directory', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'bad.md'), '# Title\n\nno frontmatter\n');
			assert.throws(() => execFileSync('node', [SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' }));
		});
	});

	test('the real core/lessons-library directory (default arg) is itself valid', () => {
		const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
		assert.match(out, /OK — \d+ lesson/);
	});
});
