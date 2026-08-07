#!/usr/bin/env node
// worker-package.mjs — build ONE work package for worker-run.mjs.
//
// docs/multi-provider-spec.md § 4. The conductor runs this, not the worker:
// `gh` is unreachable from worker sandboxes, so the issue bodies must be
// materialized here or the worker implements against whatever it can infer
// from the spec — a contract nobody agreed to.
//
// Usage:
//   node .claude/scripts/worker-package.mjs \
//        --role implement|review|critique|investigate \
//        --provider codex|deepseek|grok|anthropic \
//        --worktree <path> --issues 244,250 [--repo owner/name] \
//        [--base origin/main] [--hypothesis "…"]... [--focus "free text"] \
//        [--findings <file>] [--spec docs/specs/foo.md#Section]... \
//        [--run-id <id>] [--model <id>] [--effort <level>] [--allow-bare-overlay]
//
// Output: the package directory and its PACKAGE_HASH. Exit 2 on anything that
// would make the envelope lie about itself — same rule as the runner: a
// package that cannot be built honestly must not be built at all.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const SCRIPT_DIR = import.meta.dirname;
const args = process.argv.slice(2);

function fatal(what, remedy) {
	console.error(`\nworker-package: NOT BUILT — ${what}`);
	console.error(`worker-package: ${remedy}`);
	process.exit(2);
}
process.on('uncaughtException', (err) => {
	fatal(`unexpected error: ${err?.stack || err}`, 'This is a bug in worker-package.mjs.');
});

const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	if (i === args.length - 1 || args[i + 1].startsWith('--')) {
		fatal(`--${name} was passed with no value.`, `Give it one: --${name} <value>.`);
	}
	return args[i + 1];
};
const argAll = (name) => {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === `--${name}`) {
			if (i === args.length - 1 || args[i + 1].startsWith('--')) fatal(`--${name} was passed with no value.`, `Give it one.`);
			out.push(args[++i]);
		}
	}
	return out;
};

const role = arg('role') ?? fatal('--role is required.', 'implement | review | critique | investigate');
if (!['implement', 'review', 'critique', 'investigate'].includes(role)) {
	fatal(`unknown role "${role}".`, 'implement | review | critique | investigate');
}
const provider = arg('provider') ?? fatal('--provider is required.', 'codex | deepseek | grok | anthropic');
const worktree = resolve(arg('worktree', process.cwd()));
const base = arg('base', 'origin/main');
const issues = (arg('issues', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!issues.length) fatal('--issues is required.', 'Pass the issue numbers: --issues 244,250');
if (issues.some((n) => !/^\d+$/.test(n))) fatal(`--issues has a non-number: ${issues.join(',')}`, 'Bare numbers only.');

// ---------------------------------------------------------------------------
// Provider config (family, models, timeouts) from the generated providers.json.
// ---------------------------------------------------------------------------

const providersPath = join(SCRIPT_DIR, 'providers.json');
if (!existsSync(providersPath)) fatal('providers.json missing beside this script.', 'The installer generates it; re-run install.');
const providers = JSON.parse(readFileSync(providersPath, 'utf8'));
const pconf = (providers.workers || {})[provider];
if (!pconf || pconf.enabled === false) fatal(`provider "${provider}" is not enabled in providers.json.`, 'Enable it in engsys.config.yaml and re-install.');
const family = pconf.family || provider;
const model = arg('model', (pconf.models || {})[role]);
const effort = arg('effort', 'high');
const timeoutSec = Number((providers.timeouts || {})[role] || 3600);

const git = (...a) => {
	try {
		return execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		fatal(`\`git ${a.join(' ')}\` failed: ${(err.stderr || err.message || '').toString().trim()}`, 'Check --worktree.');
	}
};

const originUrl = git('remote', 'get-url', 'origin');
const originSlug = originUrl.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1];
const repo = arg('repo', originSlug);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
	fatal(`could not determine an owner/name repo (origin: "${originUrl}").`, 'Pass --repo owner/name.');
}
if (originSlug && repo.toLowerCase() !== originSlug.toLowerCase()) {
	fatal(`--repo "${repo}" is not the worktree's origin ("${originSlug}").`, 'The contract would come from a different repository than the diff.');
}
const head = git('rev-parse', 'HEAD');

const runId = arg('run-id', `${role}-${provider}-${head.slice(0, 7)}-${Date.now().toString(36)}`);
if (!/^[\w.-]+$/.test(runId)) fatal(`--run-id "${runId}" has unsafe characters.`, 'Letters, digits, dot, dash, underscore.');
const pkgDir = join(worktree, 'tmp', 'worker-package', runId);
if (existsSync(join(pkgDir, 'manifest.json'))) {
	fatal(`package ${runId} already exists.`, 'Packages are immutable once built — pick a new --run-id.');
}
mkdirSync(join(pkgDir, 'contract'), { recursive: true });

const files = {}; // rel -> content (hashed at the end)
const put = (rel, content) => {
	files[rel] = content;
};

// ---------------------------------------------------------------------------
// Contract: materialized issue bodies + their engsys:issue-meta blocks.
// ---------------------------------------------------------------------------

// Jody writes machine-readable fields into an HTML comment so the GitHub
// rendering stays clean (see generate-project.md § issue metadata):
//   <!-- engsys:issue-meta
//   depends_on: [12]
//   touches: ["src/lib/**"]
//   risk: low
//   needs_judgment: false
//   spec_refs: ["docs/specs/foo.md#Section Name"]
//   no_external: false
//   -->
function parseIssueMeta(body) {
	const m = body.match(/<!--\s*engsys:issue-meta\s*\n([\s\S]*?)-->/);
	if (!m) return null;
	const meta = {};
	for (const line of m[1].split('\n')) {
		const kv = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
		if (!kv) continue;
		let v = kv[2].trim();
		if (v.startsWith('[') && v.endsWith(']')) {
			const inner = v.slice(1, -1).trim();
			meta[kv[1]] = inner === '' ? [] : inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
		} else if (v === 'true' || v === 'false') meta[kv[1]] = v === 'true';
		else meta[kv[1]] = v.replace(/^["']|["']$/g, '');
	}
	return meta;
}

const issueMeta = {};
const specRefs = argAll('spec');
let ordered = [...issues];

for (const n of issues) {
	let raw;
	try {
		raw = execFileSync('gh', ['issue', 'view', n, '--repo', repo, '--json', 'title,body,state'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		// Loud, not degraded: without the bodies the worker reviews/implements a
		// contract nobody agreed to. That failure is the reason this script exists.
		fatal(`could not read issue #${n}: ${(err.stderr || err.message || '').toString().trim()}`, 'Run `gh auth login`, or check the number and --repo.');
	}
	const { title, body, state } = JSON.parse(raw);
	// A CLOSED issue is usually a wrong number, and a package built against
	// already-shipped acceptance criteria produces a confidently wrong run.
	if (state !== 'OPEN') console.warn(`worker-package: WARNING — issue #${n} is ${state}. Is that the right number?`);

	const meta = parseIssueMeta(body || '');
	issueMeta[n] = meta;
	if (meta) {
		if (meta.no_external === true && family !== 'anthropic' && family !== 'openai') {
			fatal(
				`issue #${n} is marked no_external and provider "${provider}" (family ${family}) is outside the allowed boundary.`,
				'Route this issue to codex or anthropic.',
			);
		}
		for (const ref of meta.spec_refs || []) if (!specRefs.includes(ref)) specRefs.push(ref);
	}

	const churn =
		meta && Array.isArray(meta.touches) && meta.touches.length
			? `\n\n## Declared churn (binding)\n\nThis issue may touch only:\n${meta.touches.map((t) => `- \`${t}\``).join('\n')}\n\nTouching anything else is a review finding unless the contract says otherwise.\n`
			: '';
	put(`contract/issue-${n}.md`, `# #${n} — ${title}\n\n${body || ''}\n${churn}`);
}

// Dependency-order the contract listing: an issue listed before its dependency
// invites implementing against state that does not exist yet.
ordered.sort((a, b) => {
	const da = (issueMeta[a]?.depends_on || []).map(String);
	if (da.includes(String(b))) return 1;
	const db = (issueMeta[b]?.depends_on || []).map(String);
	if (db.includes(String(a))) return -1;
	return issues.indexOf(a) - issues.indexOf(b);
});
for (const n of ordered) {
	for (const d of issueMeta[n]?.depends_on || []) {
		if (!issues.includes(String(d))) {
			console.warn(`worker-package: WARNING — issue #${n} depends_on #${d}, which is not in this package. Confirm #${d} is merged.`);
		}
	}
}

// ---------------------------------------------------------------------------
// Spec slices — the cited sections, not the catalog. Pointers to docs/specs/
// are how workers miss constraints under time pressure.
// ---------------------------------------------------------------------------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function extractSection(file, anchor) {
	const abs = join(worktree, file);
	if (!existsSync(abs)) fatal(`spec ref file not found: ${file}`, 'Fix the spec_refs / --spec path.');
	const text = readFileSync(abs, 'utf8');
	if (!anchor) return text;
	const lines = text.split('\n');
	const want = slug(anchor);
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
		if (h && (slug(h[2]) === want || slug(h[2]).includes(want))) {
			start = i;
			level = h[1].length;
			break;
		}
	}
	if (start === -1) fatal(`section "#${anchor}" not found in ${file}.`, 'Check the heading text in the spec ref.');
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const h = lines[i].match(/^(#{1,6})\s/);
		if (h && h[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

for (const ref of specRefs) {
	const [file, anchor] = ref.split('#');
	const section = extractSection(file, anchor);
	put(`contract/spec-${slug(file.replace(/\.md$/, ''))}${anchor ? `-${slug(anchor)}` : ''}.md`, `> Extracted from \`${ref}\` at ${head.slice(0, 7)} — the cited slice, quoted so it cannot be skimmed past.\n\n${section}\n`);
}

// ---------------------------------------------------------------------------
// Brief: core role skeleton + project overlay + provider adapter note.
// ---------------------------------------------------------------------------

const briefsDir = join(worktree, '.claude', 'workflows', 'briefs');
const roleBriefName = role === 'review' ? 'review-correctness.md' : `${role}.md`;
const roleBriefPath = arg('brief', join(briefsDir, roleBriefName));
if (!existsSync(roleBriefPath)) {
	fatal(`role brief not found: ${roleBriefPath}`, 'The installer places core briefs in .claude/workflows/briefs/. Re-run install, or pass --brief.');
}
if (resolve(roleBriefPath) !== resolve(join(briefsDir, roleBriefName))) {
	// A swapped lens changes what the run IS. Announce it so a design pass can
	// never be silently counted as the correctness gate.
	console.log(`worker-package: brief=${roleBriefPath}  (NON-DEFAULT — this is not the standing ${role} brief)`);
}
const roleBrief = readFileSync(roleBriefPath, 'utf8');

const overlayPath = join(briefsDir, 'project-brief-overlay.md');
const overlay = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : '';
const overlayBare = !overlay || /TODO\(naturalize\)/.test(overlay) || !/\p{L}/u.test(overlay);
if (overlayBare && role === 'review' && !flag('allow-bare-overlay')) {
	// A reviewer with no local priors is a review in name only — the generalized
	// form of the empty-brief refusal. The overlay is where the project's own
	// failure corpus lives; without it the reviewer hunts generic nitpicks.
	fatal(
		'the project brief overlay is unfilled (.claude/workflows/briefs/project-brief-overlay.md).',
		'Run /naturalize to fill it (house defects, invariants, gate commands), or pass --allow-bare-overlay to accept a generic review.',
	);
}
if (overlayBare) console.warn('worker-package: WARNING — project brief overlay is unfilled; the worker gets generic priors only.');

const adapterNotePath = join(briefsDir, 'adapters', `${provider}.md`);
const adapterNote = existsSync(adapterNotePath) ? `\n\n---\n\n${readFileSync(adapterNotePath, 'utf8').trim()}\n` : '';

put(
	'brief.md',
	`${roleBrief.trim()}\n\n---\n\n# Project overlay\n\n${overlayBare ? '_No project overlay yet — generic priors only._' : overlay.trim()}${adapterNote}`,
);

// ---------------------------------------------------------------------------
// verify.md — the exact gates the conductor will run. Extracted from the
// overlay's "## Verify commands" fenced block: diligence is supplied as an
// artifact, not requested as prose (briefs already failed that test).
// ---------------------------------------------------------------------------

const verifyBlock = overlay.match(/##\s*Verify commands[\s\S]*?```(?:sh|bash)?\n([\s\S]*?)```/);
if (role === 'implement' || role === 'review') {
	if (!verifyBlock || !/\p{L}/u.test(verifyBlock[1])) {
		fatal(
			'no Verify commands block found in the project brief overlay.',
			'Add a "## Verify commands" section with a fenced sh block to .claude/workflows/briefs/project-brief-overlay.md (via /naturalize).',
		);
	}
	put(
		'verify.md',
		`# Verify commands\n\nThe conductor runs these after your work, from scratch. You MAY run them for\nyour own feedback — your numbers are not the gate.\n\n\`\`\`sh\n${verifyBlock[1].trim()}\n\`\`\`\n`,
	);
}

// ---------------------------------------------------------------------------
// focus.md — hypotheses, labeled as such. The conductor has been wrong; a
// diagnosis shipped as fact costs a full round for both sides.
// ---------------------------------------------------------------------------

const hypotheses = argAll('hypothesis');
const focusText = arg('focus', '');
if (hypotheses.length || focusText) {
	const numbered = hypotheses.map((h, i) => `${i + 1}. [UNVERIFIED] ${h}`).join('\n');
	put(
		'focus.md',
		`# Focus — hypotheses, not facts\n\nEvery item below is the conductor's UNVERIFIED belief. Verify each premise\nagainst the code before building on it; if one is false, say so and stop.\n\n${numbered}${numbered && focusText ? '\n\n' : ''}${focusText}\n`,
	);
}

// ---------------------------------------------------------------------------
// prior-findings.md — fix rounds only, ids required so ACKs are checkable.
// ---------------------------------------------------------------------------

const findingsPath = arg('findings');
let fixRound = false;
if (findingsPath) {
	if (!existsSync(findingsPath)) fatal(`--findings file not found: ${findingsPath}`, 'Point at the severity-tagged findings list.');
	const pf = readFileSync(findingsPath, 'utf8');
	const ids = [...pf.matchAll(/\[(F\d+)\]\s*(Critical|Warning)/g)].map((m) => m[1]);
	if (!ids.length) {
		fatal(
			'the findings file has no [Fn] Critical/Warning ids.',
			'Write findings as `- [F1] Critical file:line — concrete failure scenario` so each ACK is checkable.',
		);
	}
	const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
	if (dupes.length) fatal(`duplicate finding ids: ${[...new Set(dupes)].join(', ')}.`, 'Ids must be unique to be ACKable.');
	put('prior-findings.md', pf);
	fixRound = true;
}

// ---------------------------------------------------------------------------
// Manifest + hashes. The package_hash is what the worker echoes in its
// RECEIPT — proof it saw THIS envelope, not a memory of a previous one.
// ---------------------------------------------------------------------------

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const fileHashes = {};
for (const [rel, content] of Object.entries(files)) {
	writeFileSync(join(pkgDir, rel), content);
	fileHashes[rel] = sha256(content);
}
const hasher = createHash('sha256');
for (const [rel, h] of Object.entries(fileHashes).sort(([a], [b]) => (a < b ? -1 : 1))) {
	hasher.update(rel).update('\0').update(h).update('\n');
}
const packageHash = hasher.digest('hex');

const manifest = {
	run_id: runId,
	role,
	provider,
	family,
	model: model || null,
	effort,
	repo,
	worktree,
	base,
	head,
	issues: ordered.map(Number),
	issue_meta: issueMeta,
	fix_round: fixRound,
	force: {
		binding: ['contract/', ...(role === 'implement' || role === 'review' ? ['verify.md'] : []), ...(fixRound ? ['prior-findings.md'] : [])],
		priors: ['brief.md'],
		hypothesis: 'focus.md' in files ? ['focus.md'] : [],
	},
	files: fileHashes,
	package_hash: packageHash,
	timeout_sec: timeoutSec,
	created_at: new Date().toISOString(),
};
writeFileSync(join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`worker-package: built ${pkgDir}`);
console.log(`worker-package: role=${role} provider=${provider}${model ? ` model=${model}` : ''} issues=${ordered.join(',')}${fixRound ? ' fix_round' : ''}`);
console.log(`worker-package: PACKAGE_HASH=${packageHash.slice(0, 8)} (${Object.keys(fileHashes).length} files)`);
console.log(`\nNext: node .claude/scripts/worker-run.mjs --package ${join('tmp', 'worker-package', runId)}`);
