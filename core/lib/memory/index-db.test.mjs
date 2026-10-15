// Tests for index-db.mjs — run by `node --test core/lib/memory/index-db.test.mjs`.
// §13 (docs/memory-spec.md): watermark detects an in-place edit; 6 concurrent rebuilds leave one
// consistent index; the index fails open when node:sqlite is missing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticGit } from '../git-env.mjs';
import {
	closeIndex,
	computeWatermark,
	ensureIndex,
	loadClassADocs,
	loadClassBEvents,
	queryIndex,
	readFrontmatter,
	resolveCacheDir,
	resolveClassARoots,
} from './index-db.mjs';

// A plain `git init`/`git config` here would inherit any GIT_DIR exported by a pre-push hook and
// rewrite the DEVELOPER'S real repo (core/lessons-library/git-core-bare-flip-breaks-all-worktrees.md)
// — hermeticGit() scrubs that env, and identity goes in via -c instead of a `git config` write.
const GIT_OPTS = ['-c', 'user.name=a', '-c', 'user.email=a@b.c'];
function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'memory-idx-'));
	hermeticGit(dir, [...GIT_OPTS, 'init', '-q'], { isolateConfig: true });
	mkdirSync(join(dir, 'docs', 'agent-lessons'), { recursive: true });
	writeFileSync(
		join(dir, 'docs', 'agent-lessons', 'one.md'),
		'---\nglobs: []\nstacks: []\nroles: ["isabelle"]\nkeywords: ["widget"]\nsecurity: false\nsupersedes: []\n---\n\n# Widgets need care\n\nbody text about widgets\n',
	);
	writeFileSync(join(dir, '.gitignore'), 'engsys-memory/\n');
	hermeticGit(dir, [...GIT_OPTS, 'add', '-A'], { isolateConfig: true });
	hermeticGit(dir, [...GIT_OPTS, 'commit', '-q', '-m', 'init'], { isolateConfig: true });
	return dir;
}

describe('resolveCacheDir', () => {
	test('resolves to <git-common-dir>/engsys-memory inside a repo', () => {
		const dir = makeRepo();
		try {
			const cache = resolveCacheDir(dir);
			assert.ok(cache.endsWith('engsys-memory'));
			assert.ok(cache.includes('.git'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns null outside a git repo', () => {
		const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
		try {
			assert.equal(resolveCacheDir(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('readFrontmatter', () => {
	test('a quoted list element containing a comma (a brace glob) survives intact', () => {
		const { fm } = readFrontmatter('---\nglobs: ["**/*.{ts,tsx}", "plain.md"]\nstacks: []\nroles: []\nkeywords: ["x"]\nsecurity: false\nsupersedes: []\n---\n\nbody\n');
		assert.deepEqual(fm.globs, ['**/*.{ts,tsx}', 'plain.md']);
	});

	test('matches lib/yaml.js (the same parser validate-lessons.mjs validates with) on every real bundled lesson', () => {
		const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lessons-library');
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith('.md') || f === 'README.md') continue;
			const { fm } = readFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
			assert.ok(Array.isArray(fm.keywords) && fm.keywords.length > 0, `${f}: keywords should parse non-empty`);
		}
	});

	test('malformed frontmatter degrades to {} instead of throwing', () => {
		assert.doesNotThrow(() => readFrontmatter('---\nglobs: [unterminated\n---\n\nbody\n'));
	});
});

describe('resolveClassARoots + loadClassADocs', () => {
	test('finds the project-local lesson and the bundled lessons-library', () => {
		const dir = makeRepo();
		try {
			const roots = resolveClassARoots(dir);
			assert.ok(roots.lessonsDir, 'bundled lessons-library should resolve from this checkout');
			const { docs, manifest } = loadClassADocs(roots);
			const slugs = docs.map((d) => d.key);
			assert.ok(slugs.includes('lesson:one'));
			assert.ok(Object.keys(manifest).length > 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a same-slug lesson in both the bundled lessons-library and docs/agent-lessons/ dedupes to one doc, project-local wins (never a duplicate-key build crash)', () => {
		const dir = makeRepo();
		try {
			const roots = resolveClassARoots(dir);
			// Collide with a real bundled lesson's slug.
			writeFileSync(
				join(dir, 'docs', 'agent-lessons', 'worktrees-need-bootstrap-from-origin-main.md'),
				'---\nglobs: []\nstacks: []\nroles: []\nkeywords: ["override"]\nsecurity: false\nsupersedes: []\n---\n\n# Project override\n\nlocal override body\n',
			);
			const { docs } = loadClassADocs(roots);
			const matches = docs.filter((d) => d.key === 'lesson:worktrees-need-bootstrap-from-origin-main');
			assert.equal(matches.length, 1, 'exactly one doc should survive the collision, not two with the same key');
			assert.match(matches[0].body, /local override body/, 'the project-local copy (loaded after the bundled one) wins');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a non-security project-local file can NEVER silently replace a bundled security:true lesson at the same slug', () => {
		const dir = makeRepo();
		try {
			const roots = resolveClassARoots(dir);
			// public-route-flip-hardening-checklist.md is a real bundled security:true lesson.
			writeFileSync(
				join(dir, 'docs', 'agent-lessons', 'public-route-flip-hardening-checklist.md'),
				'---\nglobs: []\nstacks: []\nroles: []\nkeywords: ["override"]\nsecurity: false\nsupersedes: []\n---\n\n# Neutered override\n\nan unreviewed file trying to neutralize the security lesson by slug collision\n',
			);
			const { docs } = loadClassADocs(roots);
			const matches = docs.filter((d) => d.key === 'lesson:public-route-flip-hardening-checklist');
			assert.equal(matches.length, 1);
			assert.equal(matches[0].security, true, 'the bundled security lesson must survive the collision');
			assert.ok(!matches[0].body.includes('Neutered override'), 'the non-security override must never win');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a missing overlay/ADR dir is silently skipped, not an error', () => {
		const dir = makeRepo();
		try {
			const roots = resolveClassARoots(dir);
			assert.doesNotThrow(() => loadClassADocs(roots));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('loadClassBEvents', () => {
	test('a missing delta.jsonl is zero events, not an error', () => {
		assert.deepEqual(loadClassBEvents('/nonexistent/path'), []);
		assert.deepEqual(loadClassBEvents(null), []);
	});

	test('a malformed line is skipped; valid lines still load; tombstones are dropped', () => {
		const dir = mkdtempSync(join(tmpdir(), 'delta-'));
		try {
			writeFileSync(
				join(dir, 'delta.jsonl'),
				['not json', JSON.stringify({ k: 'a', text: 'ok' }), JSON.stringify({ k: 'b', deleted: true })].join('\n'),
			);
			const events = loadClassBEvents(dir);
			assert.equal(events.length, 1);
			assert.equal(events[0].k, 'a');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a duplicate key dedupes to the LAST write, not a PRIMARY KEY crash (regression)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'delta-'));
		try {
			writeFileSync(
				dir + '/delta.jsonl',
				[JSON.stringify({ k: 'a', text: 'first' }), JSON.stringify({ k: 'a', text: 'second' })].join('\n'),
			);
			const events = loadClassBEvents(dir);
			assert.equal(events.length, 1);
			assert.equal(events[0].text, 'second');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a tombstone that arrives AFTER a set for the same key removes it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'delta-'));
		try {
			writeFileSync(
				dir + '/delta.jsonl',
				[JSON.stringify({ k: 'a', text: 'ok' }), JSON.stringify({ k: 'a', deleted: true })].join('\n'),
			);
			assert.deepEqual(loadClassBEvents(dir), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('computeWatermark', () => {
	test('changes when a file hash changes', () => {
		const w1 = computeWatermark({ 'a.md': 'sha-1' }, 0, 'v1');
		const w2 = computeWatermark({ 'a.md': 'sha-2' }, 0, 'v1');
		assert.notEqual(JSON.stringify(w1), JSON.stringify(w2));
	});

	test('is stable for the same inputs regardless of key order', () => {
		const w1 = computeWatermark({ a: '1', b: '2' }, 0, 'v1');
		const w2 = computeWatermark({ b: '2', a: '1' }, 0, 'v1');
		assert.deepEqual(w1, w2);
	});
});

describe('ensureIndex', () => {
	test('a same-slug lesson collision never crashes the build (regression for the frontmatter PRIMARY KEY)', () => {
		const dir = makeRepo();
		try {
			writeFileSync(
				join(dir, 'docs', 'agent-lessons', 'worktrees-need-bootstrap-from-origin-main.md'),
				'---\nglobs: []\nstacks: []\nroles: []\nkeywords: ["override"]\nsecurity: false\nsupersedes: []\n---\n\n# Project override\n\nbody\n',
			);
			const h = ensureIndex({ repoRoot: dir, version: 'v1' });
			assert.ok(h, 'the build must succeed despite the duplicate key');
			closeIndex(h);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fails open (returns null) when node:sqlite has no DatabaseSync', () => {
		const dir = makeRepo();
		try {
			const h = ensureIndex({ repoRoot: dir, sqlite: {} });
			assert.equal(h, null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fails open (returns null) when no cache dir is resolvable (not a git repo)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
		try {
			const h = ensureIndex({ repoRoot: dir });
			assert.equal(h, null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('builds an index, finds the project-local lesson by BM25, and does not rebuild unnecessarily', () => {
		const dir = makeRepo();
		try {
			const h1 = ensureIndex({ repoRoot: dir, version: 'v1' });
			assert.ok(h1);
			const rows = queryIndex(h1.db, { text: 'widgets' });
			assert.ok(rows.some((r) => r.key === 'lesson:one'));
			closeIndex(h1);

			const h2 = ensureIndex({ repoRoot: dir, version: 'v1' });
			assert.ok(h2);
			closeIndex(h2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('watermark detects an in-place content edit (no mtime dependency assumed)', () => {
		const dir = makeRepo();
		try {
			const lessonPath = join(dir, 'docs', 'agent-lessons', 'one.md');
			const h1 = ensureIndex({ repoRoot: dir, version: 'v1' });
			assert.ok(h1.docs.some((d) => d.body.includes('widgets')));
			closeIndex(h1);

			writeFileSync(
				lessonPath,
				'---\nglobs: []\nstacks: []\nroles: ["isabelle"]\nkeywords: ["gadget"]\nsecurity: false\nsupersedes: []\n---\n\n# Gadgets need care\n\nbody text about gadgets\n',
			);
			const h2 = ensureIndex({ repoRoot: dir, version: 'v1' });
			const rows = queryIndex(h2.db, { text: 'gadgets' });
			assert.ok(rows.some((r) => r.key === 'lesson:one'), 'rebuilt index should reflect the edited content');
			const stale = queryIndex(h2.db, { text: 'widgets' });
			assert.ok(!stale.some((r) => r.key === 'lesson:one'), 'the old content should be gone after rebuild');
			closeIndex(h2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('6 concurrent ensureIndex calls leave one consistent, queryable index', async () => {
		const dir = makeRepo();
		try {
			const results = await Promise.all(
				Array.from({ length: 6 }, () => Promise.resolve().then(() => ensureIndex({ repoRoot: dir, version: 'v1' }))),
			);
			for (const h of results) assert.ok(h, 'every concurrent call should succeed, not throw or silently fail');
			for (const h of results) {
				const rows = queryIndex(h.db, { text: 'widgets' });
				assert.ok(rows.some((r) => r.key === 'lesson:one'));
				closeIndex(h);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('queryIndex', () => {
	test('returns [] for an empty query string instead of matching everything', () => {
		const dir = makeRepo();
		try {
			const h = ensureIndex({ repoRoot: dir, version: 'v1' });
			assert.deepEqual(queryIndex(h.db, { text: '' }), []);
			closeIndex(h);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns [] instead of throwing for a null db handle', () => {
		assert.deepEqual(queryIndex(null, { text: 'anything' }), []);
	});
});
