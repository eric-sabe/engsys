// plugin-mode-layout.test.mjs — regression test for engsys#140 review finding C1: in plugin
// mode, Claude Code's marketplace installs ONLY the core plugin's `source` directory (`./core`)
// into the plugin cache — nothing outside `core/` exists there. A static `import` that escapes
// `core/` (e.g. the repo-root `lib/yaml.js`) crashes with `ERR_MODULE_NOT_FOUND` while Node is
// still resolving the module graph, which happens BEFORE any try/catch inside the importing
// file's own code runs — so the hook's fail-open contract (always print `{}`, always exit 0)
// does not save it; the process dies before main() is ever called.
//
// This test copies `core/` to a temp dir laid out the way the real plugin cache is
// (`<cache>/engsys/engsys/<version>/`, mirroring `claude plugin list --json`'s `installPath`
// convention from core/fleet/lib/verify-wrappers.mjs) and runs each entry point from there,
// asserting it starts and behaves correctly — no `ERR_MODULE_NOT_FOUND`, no `Cannot find module`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = fileURLToPath(new URL('..', import.meta.url)); // core/scripts/.. = core/

function makePluginRoot() {
	// realpathSync: on macOS, os.tmpdir() is under /tmp, which is itself a symlink to /private/tmp.
	// Node's ESM loader resolves symlinks for module identity, so a script's `import.meta.url`
	// comes back realpath'd even when it was invoked via the symlinked path — using the symlinked
	// path here would make every entry point's `process.argv[1] === fileURLToPath(import.meta.url)`
	// self-check fail, silently skipping main() (exit 0, empty output) with nothing to indicate why.
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'engsys-plugin-sim-')));
	const pluginRoot = join(base, 'engsys', 'engsys', '9.9.9');
	mkdirSync(pluginRoot, { recursive: true });
	cpSync(CORE_DIR, pluginRoot, { recursive: true });
	return { base, pluginRoot };
}

function run(cmd, args, opts = {}) {
	try {
		const stdout = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_NO_WARNINGS: '1' }, ...opts });
		return { code: 0, stdout, stderr: '' };
	} catch (e) {
		return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? e) };
	}
}

function assertNoModuleResolutionCrash(result, label) {
	assert.ok(!result.stderr.includes('ERR_MODULE_NOT_FOUND'), `${label}: must not crash on module resolution — stderr: ${result.stderr}`);
	assert.ok(!result.stderr.includes('Cannot find module'), `${label}: must not crash on module resolution — stderr: ${result.stderr}`);
}

describe('plugin-mode module resolution (engsys#140 C1)', () => {
	test('the SubagentStart hook runs from a plugin-cache-shaped layout without a module-resolution crash', () => {
		const { base, pluginRoot } = makePluginRoot();
		try {
			// `cwd: base` (an isolated, non-git temp dir), not this test process's own cwd: empty
			// stdin makes the hook fall back to `defaultCwd = process.cwd()`, and defaulting to
			// THIS repo checkout would pick up this branch's real diff against origin/main via
			// resolveTouchedPaths' merge-base fallback — nonempty on any PR with real changes,
			// surfacing a real lesson instead of the expected empty brief.
			const result = run('node', [join(pluginRoot, '.claude-plugin', 'subagent-memory-inject.mjs')], { input: '{}', cwd: base });
			assertNoModuleResolutionCrash(result, 'subagent-memory-inject.mjs');
			assert.equal(result.code, 0, 'the hook must always exit 0');
			assert.equal(result.stdout.trim(), '{}', 'empty input yields the empty brief, not a crash');
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('memory-brief.mjs runs from a plugin-cache-shaped layout without a module-resolution crash', () => {
		const { base, pluginRoot } = makePluginRoot();
		try {
			const result = run('node', [join(pluginRoot, 'scripts', 'memory-brief.mjs'), '--repo-root', pluginRoot, '--agent-type', 'isabelle']);
			assertNoModuleResolutionCrash(result, 'memory-brief.mjs');
			assert.equal(result.code, 0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('harvest-findings.mjs runs from a plugin-cache-shaped layout without a module-resolution crash', () => {
		const { base, pluginRoot } = makePluginRoot();
		try {
			// No real `gh`/network call: an empty invocation exercises module loading + the CLI's
			// own "unknown command" path, which is enough to prove the module graph resolved.
			const result = run('node', [join(pluginRoot, 'scripts', 'harvest-findings.mjs')]);
			assertNoModuleResolutionCrash(result, 'harvest-findings.mjs');
			assert.equal(result.code, 1); // "unknown command" — reached its own logic, not a crash
			assert.match(result.stderr, /unknown command/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('validate-lessons.mjs runs from a plugin-cache-shaped layout without a module-resolution crash', () => {
		const { base, pluginRoot } = makePluginRoot();
		try {
			const result = run('node', [join(pluginRoot, 'scripts', 'validate-lessons.mjs'), join(pluginRoot, 'lessons-library')]);
			assertNoModuleResolutionCrash(result, 'validate-lessons.mjs');
			assert.equal(result.code, 0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('memory-sync.mjs runs from a plugin-cache-shaped layout without a module-resolution crash', () => {
		const { base, pluginRoot } = makePluginRoot();
		try {
			const result = run('node', [join(pluginRoot, 'scripts', 'memory-sync.mjs'), '--delta', '--repo-root', pluginRoot]);
			assertNoModuleResolutionCrash(result, 'memory-sync.mjs');
			assert.equal(result.code, 0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

