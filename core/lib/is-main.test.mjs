// Tests for is-main.mjs — run by `node --test core/lib/is-main.test.mjs`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainEntry } from './is-main.mjs';

describe('isMainEntry', () => {
	test('true when argv[1] names the same file as metaUrl', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ismain-')));
		try {
			const file = join(dir, 'x.mjs');
			writeFileSync(file, '');
			assert.ok(isMainEntry(pathToFileURL(file).href, [process.execPath, file]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('false when argv[1] names a different file', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ismain-')));
		try {
			const a = join(dir, 'a.mjs');
			const b = join(dir, 'b.mjs');
			writeFileSync(a, '');
			writeFileSync(b, '');
			assert.ok(!isMainEntry(pathToFileURL(a).href, [process.execPath, b]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('true when argv[1] is a SYMLINK to the file metaUrl resolves to (the realpath mismatch this exists to fix)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ismain-'));
		try {
			const real = join(dir, 'real.mjs');
			const link = join(dir, 'link.mjs');
			writeFileSync(real, '');
			symlinkSync(real, link);
			// Simulate Node's ESM loader behavior: import.meta.url for a module loaded via `link`
			// comes back pointing at the REALPATH, while argv[1] (what was typed on the command
			// line) stays the symlinked path.
			assert.ok(isMainEntry(pathToFileURL(realpathSync(real)).href, [process.execPath, link]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('false when there is no argv[1] (e.g. a REPL), never throws', () => {
		assert.equal(isMainEntry('file:///whatever.mjs', [process.execPath]), false);
	});

	test('a nonexistent argv[1] falls back to the plain comparison instead of throwing', () => {
		assert.equal(isMainEntry('file:///a.mjs', [process.execPath, '/definitely/does/not/exist.mjs']), false);
	});
});
