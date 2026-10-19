// Guard (engsys#188): any code that reads or fetches `refs/engsys/memory/*` must go through
// `verifyMemoryRefTip` (core/lib/memory/ref-store.mjs). There is deliberately NO consumer of those
// refs' trust today — the fetch is unwired — and this test makes that rule enforceable instead of
// a comment: a new file that touches the memory refs fails here until it is (a) reviewed for
// security (docs/memory-spec.md §3.1, "Wiring a consumer") and (b) added to CONSUMERS below, and a
// listed consumer additionally must call `verifyMemoryRefTip(` in code (not just a comment).
//
// BEST-EFFORT TRIPWIRE against honest mistakes (a contributor wiring the obvious reader API without
// knowing the rule), NOT a defence against a determined author: a textual scan can be evaded by
// obfuscation (string concatenation, dynamic import, a renamed re-export). The real control is the
// security review this guard forces by failing; trust itself rests on verifyMemoryRefTip.
//
// The checker is a pure function over {path -> source text} so its own behavior has positive and
// negative controls on synthetic inputs, then the real repo is scanned.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Anything that names the memory refs or their fetch/list/read helpers.
// Includes the ref store's own reader API (createMemoryRefStore().readEvents(), EVENTS_REF, tailRef): a reader
// does not need to spell the ref path at all.
const REF_TOKENS =
	/refs\/engsys\/(?!leases\b|batons\b)|engsys\/memory|memory-incoming|MEMORY_REF_PREFIX|MEMORY_FETCH_REFSPEC|fetchMemoryRefs|listMemoryRefShas|loadClassBEvents|\bcreateMemoryRefStore\b|\breadEvents\b|\bEVENTS_REF\b|\btailRef\b/;
// Reading a ref's content through the store API (a non-consumer may publish, never read back).
const READ_TOKENS = /\breadEvents\b|listMemoryRefShas|loadClassBEvents/;
// The subset that FETCHES (or stages a fetch of) the refs.
const FETCH_TOKENS = /fetchMemoryRefs|MEMORY_FETCH_REFSPEC|memory-incoming/;

// Files that may mention the refs WITHOUT being a trust consumer, each with the constraint that
// keeps them that way. Adding a file here is a security-relevant change: say why in the PR.
const NON_CONSUMER_RULES = {
	// Defines the primitives (fetchMemoryRefs, verifyMemoryRefTip) and is the WRITER (CAS publish).
	'core/lib/memory/ref-store.mjs': { allowFetchTokens: true },
	// Reads local ref tips only through stripRefEventTrustLabels, which discards every embedded
	// trust label and stamps author_kind 'untrusted_ref' (rejected unconditionally by trust.mjs).
	'core/lib/memory/index-db.mjs': { allowReadTokens: true, mustContain: ['stripRefEventTrustLabels(blobText)'] },
	// Publish-only: writes via the ref store, never reads a ref back.
	'core/scripts/memory-sync.mjs': {},
	// Documents the rejection of unverified ref events; no read.
	'core/lib/memory/trust.mjs': {},
	// Doc comment about what the ref store writes.
	'core/lib/lease/github-backend.mjs': {},
	// `git show-ref` existence probe only; reads no content.
	'core/fleet/lib/xray.mjs': {},
};

// Files that consume ref CONTENT as trusted input. EMPTY today. A real entry needs a security
// review (docs/memory-spec.md §3.1) and must call verifyMemoryRefTip( in code.
const CONSUMERS = new Set([]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'data', 'tests']);
const SKIP_EXT = new Set(['.md', '.html', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.sqlite', '.db', '.lock']);

// `#` starts a comment only in shell/YAML; in JS a line may legitimately start with `#` (a private field).
const HASH_COMMENT_EXT = /\.(sh|bash|ya?ml)$/;
function stripComments(src, rel = '') {
	const hashComments = HASH_COMMENT_EXT.test(rel);
	return String(src)
		.replace(/^\s*\/\*[\s\S]*?\*\//gm, '') // line-leading block comments only: `refs/engsys/memory/*` in a string must not open one
		.split('\n')
		.filter((l) => !(/^\s*\/\//.test(l) || (hashComments && /^\s*#/.test(l))))
		.join('\n');
}

/** Pure checker: returns a list of human-readable violations for `files` ({ relPath: text }). */
export function findRefConsumerViolations(files, { consumers = CONSUMERS, rules = NON_CONSUMER_RULES } = {}) {
	const violations = [];
	for (const [rel, text] of Object.entries(files)) {
		const code = stripComments(text, rel);
		if (!REF_TOKENS.test(code)) continue;
		const callsVerify = /\bverifyMemoryRefTip\s*\(/.test(code);
		if (consumers.has(rel)) {
			if (!callsVerify) violations.push(`${rel}: listed consumer of refs/engsys/memory/* never calls verifyMemoryRefTip(`);
			continue;
		}
		const rule = rules[rel];
		if (!rule) {
			violations.push(
				`${rel}: touches refs/engsys/memory/* but is neither a reviewed consumer that calls verifyMemoryRefTip( nor a known non-consumer; ` +
					'wiring the memory ref fetch/read requires a security review (docs/memory-spec.md §3.1)',
			);
			continue;
		}
		if (!rule.allowFetchTokens && !rule.allowReadTokens && READ_TOKENS.test(code)) {
			violations.push(`${rel}: non-consumer file reads refs/engsys/memory/* content (readEvents/listMemoryRefShas/loadClassBEvents)`);
		}
		if (!rule.allowFetchTokens && FETCH_TOKENS.test(code)) {
			violations.push(`${rel}: non-consumer file fetches/stages refs/engsys/memory/* (fetchMemoryRefs/MEMORY_FETCH_REFSPEC/memory-incoming)`);
		}
		if (!rule.allowFetchTokens && /['"`]fetch['"`]|\bgit\s+fetch\b/.test(code) && /refs\/engsys/.test(code)) {
			violations.push(`${rel}: non-consumer file runs a git fetch alongside refs/engsys`);
		}
		for (const needle of rule.mustContain ?? []) {
			if (!code.includes(needle)) violations.push(`${rel}: expected \`${needle}\` (the label-stripping read path) but it is gone`);
		}
	}
	return violations;
}

function walk(dir, out, rootDir) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.isSymbolicLink()) continue;
		const abs = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (SKIP_DIRS.has(ent.name)) continue;
			walk(abs, out, rootDir);
		} else if (ent.isFile()) {
			if (SKIP_EXT.has(path.extname(ent.name)) || /\.test\.[a-z]+$/.test(ent.name)) continue;
			const rel = path.relative(rootDir, abs).split(path.sep).join('/');
			if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
			out[rel] = fs.readFileSync(abs, 'utf8');
		}
	}
}

describe('refs/engsys/memory/* consumer guard (engsys#188)', () => {
	it('negative: a new file that fetches the memory refs without verifyMemoryRefTip fails', () => {
		const v = findRefConsumerViolations({ 'core/new-reader.mjs': "import { fetchMemoryRefs } from './ref-store.mjs';\nfetchMemoryRefs(root);\n" });
		assert.equal(v.length, 1);
		assert.match(v[0], /core\/new-reader\.mjs/);
	});
	it('negative: reading a ref by name (git show / for-each-ref) without verifyMemoryRefTip fails', () => {
		assert.equal(findRefConsumerViolations({ 'x.sh': 'git show refs/engsys/memory/events:events.jsonl' }).length, 1);
		assert.equal(findRefConsumerViolations({ 'y.mjs': "const p = 'refs/engsys/' + 'memory';\nlistMemoryRefShas(r)" }).length, 1);
	});
	it('negative: a mention of verifyMemoryRefTip only in a comment does not exempt a reader', () => {
		const src = "// goes through verifyMemoryRefTip\n/* verifyMemoryRefTip( */\nfetchMemoryRefs(root);\n";
		assert.equal(findRefConsumerViolations({ 'z.mjs': src }).length, 1);
	});
	it('negative: even a file that calls verifyMemoryRefTip is rejected until it is a listed (reviewed) consumer', () => {
		const src = "await verifyMemoryRefTip(root, {});\nfetchMemoryRefs(root);\n";
		assert.equal(findRefConsumerViolations({ 'c.mjs': src }).length, 1);
	});
	it('negative: a listed consumer that never calls verifyMemoryRefTip( fails', () => {
		const v = findRefConsumerViolations({ 'c.mjs': 'fetchMemoryRefs(root);' }, { consumers: new Set(['c.mjs']) });
		assert.equal(v.length, 1);
	});
	it('negative: a known non-consumer that starts fetching fails', () => {
		const v = findRefConsumerViolations({ 'core/scripts/memory-sync.mjs': 'fetchMemoryRefs(root);' });
		assert.equal(v.length, 1);
	});
	it('negative: index-db losing its label-stripping read path fails', () => {
		const v = findRefConsumerViolations({ 'core/lib/memory/index-db.mjs': "const p = 'refs/engsys/memory';\napplyJsonlLinesToMap(blobText, byKey);" });
		assert.equal(v.length, 1);
	});

	it('negative: the ref store reader API (createMemoryRefStore().readEvents(), an imported EVENTS_REF or tailRef) is caught without the ref path', () => {
		const reader = "import { createMemoryRefStore } from './ref-store.mjs';\nconst tip = await createMemoryRefStore({ repo }).readEvents();\n";
		assert.equal(findRefConsumerViolations({ 'core/new-reader.mjs': reader }).length, 1);
		assert.equal(findRefConsumerViolations({ 'core/e.mjs': "import { EVENTS_REF } from './ref-store.mjs';\nuse(EVENTS_REF);" }).length, 1);
		assert.equal(findRefConsumerViolations({ 'core/t.mjs': "import { tailRef } from './ref-store.mjs';\nuse(tailRef('a', 'b'));" }).length, 1);
	});
	it('negative: memory-sync (a publisher) that starts reading refs back fails; positive control: publish-only passes', () => {
		assert.equal(findRefConsumerViolations({ 'core/scripts/memory-sync.mjs': 'const s = createMemoryRefStore(o); await s.readEvents({ ref });' }).length, 1);
		assert.deepEqual(findRefConsumerViolations({ 'core/scripts/memory-sync.mjs': 'const s = createMemoryRefStore(o); await s.writeEvents({ ref: EVENTS_REF, events });' }), []);
	});
	it('a JS line starting with # (a private field) is code, not a comment; in a shell file it is a comment', () => {
		const js = 'class A {\n  #store = createMemoryRefStore(o);\n}\n';
		assert.equal(findRefConsumerViolations({ 'core/p.mjs': js }).length, 1);
		assert.deepEqual(findRefConsumerViolations({ 'core/p.sh': '# createMemoryRefStore is not used here\necho hi\n' }), []);
	});

	it('positive control: a listed consumer that calls verifyMemoryRefTip( passes', () => {
		const src = "const r = await verifyMemoryRefTip(root, { sha });\nfetchMemoryRefs(root);\n";
		assert.deepEqual(findRefConsumerViolations({ 'c.mjs': src }, { consumers: new Set(['c.mjs']) }), []);
	});
	it('positive control: files that never name the memory refs are not flagged', () => {
		assert.deepEqual(findRefConsumerViolations({ 'a.mjs': "import fs from 'node:fs';\nfs.readFileSync('x');" }), []);
	});
	it('positive control: the known index-db read path (label-stripped) passes', () => {
		const src = "listMemoryRefShas(root);\napplyJsonlLinesToMap(stripRefEventTrustLabels(blobText), byKey);";
		assert.deepEqual(findRefConsumerViolations({ 'core/lib/memory/index-db.mjs': src }), []);
	});

	it('the real repo: no code reads or fetches refs/engsys/memory/* outside the known non-consumers (there are no consumers, the fetch stays unwired)', () => {
		const files = {};
		walk(ROOT, files, ROOT);
		assert.ok(Object.keys(files).length > 100, 'scan must actually cover the repo');
		assert.ok('core/lib/memory/ref-store.mjs' in files && 'core/lib/memory/index-db.mjs' in files, 'scan covers the known memory files');
		assert.deepEqual(findRefConsumerViolations(files), []);
		assert.equal(CONSUMERS.size, 0, 'wiring a consumer requires a security review; update docs/memory-spec.md §3.1 and this guard together');
	});
});
