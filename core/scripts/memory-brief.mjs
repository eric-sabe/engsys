#!/usr/bin/env node
// memory-brief.mjs — build the push-injected memory brief for a subagent dispatch, and serve the
// on-demand "evidence" pull for a single Class B event. Design: docs/memory-spec.md §5 (brief),
// §2 (trust classes), §13 (tests). Consumed by core/.claude-plugin/subagent-memory-inject.mjs.
//
// Zero-dependency ESM, Node >= 20 (node:sqlite itself needs >= 22.5 — see index-db.mjs; this module
// degrades to an empty brief without it, never throws).
//
// THE SECURITY PROPERTY THIS FILE EXISTS TO HOLD: SubagentStart `additionalContext` reaches the
// subagent with SYSTEM authority (docs/memory-spec.md §6/§12). Class B (anything ingested from
// GitHub or a monster journal, whoever wrote it — bots included) must NEVER appear in that context
// as free text, no matter what a crafted issue title, filename, or frontmatter value contains.
// `renderBrief()` is the single choke point for this: it only ever interpolates (a) Class A lesson
// title/body, which the instance should human-review (§2), and (b) STRUCTURED pointer fields
// (number, kind, path, line, marker, outcome, date, key) through `renderPointerLine()` — never an
// event's `.text`. Free-text evidence is reachable only via `--evidence <key>`, wrapped by
// core/lib/untrusted.mjs, and arrives in a subagent's context as an ordinary Bash tool RESULT
// (model-authority, not system-authority) because the subagent had to call it.
//
// Public API:
//   loadConfig(repoRoot)                                  -> memory.yml, defaults per spec §10
//   resolveExcludedAgents(config, repoRoot)                -> Set<agentType> (config list ∪ every
//                                                             core/optional-agents .md whose own
//                                                             frontmatter sets `security: true`)
//   bm25Terms(prompt)                                      -> query terms for queryIndex()
//   lessonMatchScore(fm, { touchedPaths, agentType, stacks, promptTerms, bm25Score })  -> number
//   resolveSupersession(frontmatterRows, { isReviewed })   -> Set<key> suppressed by `supersedes`
//                                                             (security:true lessons protected per §5;
//                                                             cycles ignored+logged, never followed)
//   selectLessons(frontmatterRows, opts, limit)            -> top Class A lessons, Doc[]
//   pointerScore(event, { touchedPaths, prCountsByFile, totalPrs, now })  -> number (§5 formula)
//   renderPointerLine(event)                               -> one STRUCTURED line, never event.text
//   selectPointers(events, opts, limit)                    -> top Class B pointers, Event[]
//   renderBrief({ overlay, lessons, pointers }, budgetBytes)  -> string, <= budgetBytes (UTF-8)
//   buildBrief(opts)                                       -> { text, lessonKeys, pointerKeys, bytes }
//                                                             fails open to the empty brief on ANY error
//   evidenceText(key, { repoRoot, cacheDir, sqlite })       -> wrapped evidence string | null
//   main(argv, { out, err })                                CLI entry

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvelope } from '../lib/untrusted.mjs';
import {
	ensureIndex,
	listClassAFrontmatter,
	listEvents,
	queryIndex,
	readFrontmatter,
	resolveCacheDir,
} from '../lib/memory/index-db.mjs';
import { parseYaml } from '../../lib/yaml.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = path.resolve(HERE, '..', '..');

export const DEFAULTS = {
	repos: [],
	review_markers: [],
	trusted_bot_user_ids: [],
	operator_user_ids: [],
	exclude_class_b_agents: [],
	high_fanout_globs: [],
	brief_bytes: 2048,
	max_events: 20000,
	publish_role: 'maintain',
};

// ---------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------

/** Load `.claude/memory.yml` (or `memory.yml` directly, if `repoRoot` IS a fleet config dir)
 * merged over DEFAULTS. A missing/unreadable/malformed file is just "use the defaults" — never
 * throws. */
export function loadConfig(repoRoot) {
	for (const rel of [path.join('.claude', 'memory.yml'), 'memory.yml']) {
		const p = path.join(repoRoot, rel);
		try {
			const raw = parseYaml(fs.readFileSync(p, 'utf8'));
			return { ...DEFAULTS, ...raw };
		} catch {
			/* try the next candidate / fall through to defaults */
		}
	}
	return { ...DEFAULTS };
}

/**
 * Class B exclusion set (docs/memory-spec.md §2 rule 3): `config.exclude_class_b_agents` plus
 * every agent definition (`core/agents/*.md`, `optional-agents/*.md`) whose OWN frontmatter sets
 * `security: true`. Scans this engsys checkout (via `agentsRoot`, default resolved relative to
 * this module) — never the task prompt or any ingested text. Never throws.
 */
export function resolveExcludedAgents(config, { agentsRoot = REPO_ROOT_DEFAULT } = {}) {
	const excluded = new Set((config?.exclude_class_b_agents ?? []).map(String));
	for (const dir of [path.join(agentsRoot, 'core', 'agents'), path.join(agentsRoot, 'optional-agents')]) {
		let files;
		try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
		for (const f of files) {
			let text;
			try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
			const { fm } = readFrontmatter(text);
			if (fm.security === true) excluded.add(f.replace(/\.md$/, ''));
		}
	}
	return excluded;
}

// ---------------------------------------------------------------------------------------------
// lesson selection (Class A)
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'for', 'with', 'this', 'that']);

/** Lowercase word terms from a task prompt, stripped of stopwords/short noise. */
export function bm25Terms(prompt) {
	const words = String(prompt ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
	return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

function globMatchesAny(globs, touchedPaths) {
	if (!globs?.length || !touchedPaths?.length) return false;
	const toRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
	return globs.some((g) => {
		const re = toRe(g);
		return touchedPaths.some((p) => re.test(p) || re.test(path.basename(p)));
	});
}

/** docs/memory-spec.md §5's lesson match score: frontmatter overlap (globs/roles/stacks) blended
 * with the caller-supplied BM25 score over the prompt. Pure, deterministic. */
export function lessonMatchScore(fm, { touchedPaths = [], agentType = null, stacks = [], bm25Score = 0 } = {}) {
	// An empty globs/roles/stacks list means "applies everywhere" (docs/memory-spec.md §10) — that's
	// the baseline every lesson already gets by not being filtered out; it earns no extra bonus here,
	// or a stack-agnostic lesson would always outrank a specifically-matching one on tie-break alone.
	// Only a SPECIFIC match (this file area / this agent / this stack) adds to the BM25 base score.
	let score = bm25Score;
	if (globMatchesAny(fm.globs, touchedPaths)) score += 3;
	if (agentType && fm.roles?.length && fm.roles.includes(agentType)) score += 2;
	if (fm.stacks?.length && fm.stacks.some((s) => stacks.includes(s))) score += 1;
	return score;
}

/**
 * Resolve which lesson keys are suppressed via `supersedes`. A security:true lesson is protected:
 * it is suppressed only when the SUPERSEDING lesson is itself `isReviewed(supersederDoc) === true`
 * (docs/memory-spec.md §5). `isReviewed` defaults to "no" (fail toward NOT suppressing a security
 * lesson) — callers that can really tell (buildBrief, via git) pass a real check. A supersede
 * cycle is detected and ignored (logged via `log`), never followed.
 */
export function resolveSupersession(frontmatterRows, { isReviewed = () => false, log = () => {} } = {}) {
	const byKey = new Map(frontmatterRows.map((r) => [r.key, r]));
	const suppressed = new Set();
	for (const row of frontmatterRows) {
		const seen = new Set([row.key]);
		let cur = row;
		for (const target of row.supersedes ?? []) {
			const targetKey = target.includes(':') ? target : `lesson:${target}`;
			if (seen.has(targetKey)) { log(`memory-brief: supersede cycle involving ${row.key} -> ${targetKey}, ignored`); continue; }
			const targetRow = byKey.get(targetKey);
			if (!targetRow) continue;
			if (targetRow.security && !isReviewed(row)) continue; // protected: superseder not (provably) reviewed
			suppressed.add(targetKey);
		}
	}
	return suppressed;
}

/** Top Class A lessons: BM25 rows (from queryIndex, class 'A') re-scored with lessonMatchScore,
 * supersession applied, highest first. `limit` default 5 (spec: "top 3-5"). */
export function selectLessons(frontmatterRows, bm25ByKey, opts = {}, limit = 5) {
	const suppressed = resolveSupersession(frontmatterRows, opts);
	return frontmatterRows
		.filter((fm) => !suppressed.has(fm.key))
		.map((fm) => ({ fm, score: lessonMatchScore(fm, { ...opts, bm25Score: bm25ByKey.get(fm.key) ?? 0 }) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => x.fm);
}

// ---------------------------------------------------------------------------------------------
// pointer selection (Class B) — structured fields only, see the file-top security note
// ---------------------------------------------------------------------------------------------

const OUTCOME_WEIGHT = { fixed: 1.0, unresolved: 0.5, disputed: 0.2, bounced: 0.3, merged: 0.8, none: 0.1 };

/** docs/memory-spec.md §5's pointer score: anchor × idf(file) × recency × outcome. */
export function pointerScore(event, { touchedPaths = [], touchedLines = {}, prCountsByFile = {}, totalPrs = 1, now = Date.now() } = {}) {
	if (!event.path) return 0;
	let anchor = 0;
	const base = path.basename(event.path);
	const touchedSame = touchedPaths.some((p) => p === event.path || path.basename(p) === base);
	if (touchedSame) {
		const lines = touchedLines[event.path] || touchedLines[base];
		anchor = lines && event.line && lines.some((l) => Math.abs(l - event.line) <= 2) ? 1.0 : 0.5;
	} else if (touchedPaths.some((p) => path.dirname(p) === path.dirname(event.path))) {
		anchor = 0.2;
	}
	if (anchor === 0) return 0;
	// idf = log(N_prs / (1 + prs_touching_file)) (spec §5). Fanout data (totalPrs/prCountsByFile)
	// comes from memory-sync, which ships in a later phase; absent that data, `idf` falls back to a
	// neutral 1 rather than log(1/1)=0, which would zero out every pointer regardless of anchor.
	const fanout = prCountsByFile[event.path];
	const idf = fanout === undefined ? 1 : Math.log(Math.max(totalPrs, 1) / (1 + fanout));
	const ageDays = event.updated_at ? Math.max(0, (now - new Date(event.updated_at).getTime()) / 86400000) : 365;
	const recency = 0.5 ** (ageDays / 90);
	const outcome = OUTCOME_WEIGHT[event.outcome] ?? 0.1;
	const flagPenalty = (event.flags?.length ?? 0) > 0 ? 0.3 : 1;
	return Math.max(0, anchor * idf * recency * outcome * flagPenalty);
}

/**
 * Render ONE pointer line from STRUCTURED event fields only — `event.text` is never read here.
 * Format (spec §5): `[#412 review_thread src/api/tenant.ts:88 local-review-findings fixed
 * 2026-10-12] key=<k>`.
 */
export function renderPointerLine(event) {
	const date = event.updated_at ? String(event.updated_at).slice(0, 10) : 'unknown-date';
	const loc = event.line ? `${event.path}:${event.line}` : (event.path ?? event.symbol ?? '?');
	const num = event.number ? `#${event.number}` : (event.repo ?? '?');
	return `[${num} ${event.kind ?? 'event'} ${loc} ${event.marker ?? '-'} ${event.outcome ?? 'none'} ${date}] key=${event.key ?? event.k}`;
}

/** Top Class B pointers (up to 3 per spec §5), highest pointerScore first, ties broken by key for
 * determinism. */
export function selectPointers(events, opts = {}, limit = 3) {
	return events
		.map((e) => ({ e, score: pointerScore(e, opts) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || String(a.e.key).localeCompare(String(b.e.key)))
		.slice(0, limit)
		.map((x) => x.e);
}

// ---------------------------------------------------------------------------------------------
// rendering (the byte cap + the Class A/B boundary)
// ---------------------------------------------------------------------------------------------

function byteLen(s) {
	return Buffer.byteLength(s, 'utf8');
}

/** Truncate `s` to fit within `maxBytes` UTF-8 bytes without splitting a multi-byte codepoint. */
function truncateToBytes(s, maxBytes) {
	if (byteLen(s) <= maxBytes) return s;
	let lo = 0;
	let hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	return s.slice(0, lo);
}

/**
 * Render the final brief text: the overlay, then up to `lessons.length` Class A lesson
 * title+excerpt blocks, then each pointer as ONE structured line (renderPointerLine — never free
 * text). The whole thing is capped at `budgetBytes` (default 2048), dropping from the END
 * (pointers first, then lessons) rather than mid-truncating a block, so what survives is always
 * whole lines/sections.
 */
export function renderBrief({ overlay = '', lessons = [], pointers = [] } = {}, budgetBytes = DEFAULTS.brief_bytes) {
	const sections = [];
	if (overlay) sections.push(overlay.trim());
	for (const l of lessons) {
		const excerpt = (l.title ? `**${l.title}**` : '') + (l.body ? ` — ${firstLine(l.body)}` : '');
		sections.push(`[lesson ${l.key}] ${excerpt}`.trim());
	}
	for (const p of pointers) sections.push(renderPointerLine(p));

	let text = sections.join('\n');
	// Drop whole sections from the end until it fits — never emit a half-line.
	while (byteLen(text) > budgetBytes && sections.length > 0) {
		sections.pop();
		text = sections.join('\n');
	}
	return truncateToBytes(text, budgetBytes);
}

function firstLine(body) {
	const m = /^[\s\S]*?\*\*Trigger:\*\*\s*(.+)$/m.exec(body);
	if (m) return m[1].split('\n')[0];
	const m2 = /\S.*/.exec(body.replace(/^#.*\n/, ''));
	return m2 ? m2[0].slice(0, 160) : '';
}

// ---------------------------------------------------------------------------------------------
// git helpers (best-effort; a failure here never blocks a brief)
// ---------------------------------------------------------------------------------------------

function isReviewedOnDefaultBranch(doc, { repoRoot, ref = 'HEAD' }) {
	try {
		const rel = path.relative(repoRoot, doc.path);
		const committed = execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return committed === fs.readFileSync(doc.path, 'utf8');
	} catch {
		return false; // not committed there (yet) — treat as NOT reviewed, the conservative direction
	}
}

// ---------------------------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------------------------

/**
 * Build the full brief. `opts`: agentType, prompt, issue, touchedPaths (string[]), repoRoot,
 * pluginRoot, budgetBytes, now. ALWAYS resolves (never rejects/throws) — any internal failure
 * (no node:sqlite, no index, bad config) yields the empty brief, per the hook's fail-open contract.
 */
export function buildBrief(opts = {}) {
	const repoRoot = opts.repoRoot ?? process.cwd();
	const empty = { text: '', lessonKeys: [], pointerKeys: [], bytes: 0 };
	try {
		const config = loadConfig(repoRoot);
		const budgetBytes = opts.budgetBytes ?? config.brief_bytes ?? DEFAULTS.brief_bytes;
		const excluded = resolveExcludedAgents(config);
		const classBAllowed = !excluded.has(opts.agentType);

		const handle = ensureIndex({ repoRoot, pluginRoot: opts.pluginRoot, cacheDir: opts.cacheDir, version: opts.version ?? 'dev', sqlite: opts.sqlite });
		if (!handle) return empty;

		let overlay = '';
		try {
			const overlayPath = path.join(repoRoot, '.claude', 'workflows', 'briefs', 'project-brief-overlay.md');
			overlay = fs.readFileSync(overlayPath, 'utf8');
		} catch { /* no overlay installed — fine */ }

		const terms = bm25Terms(opts.prompt);
		const bm25Rows = terms.length ? queryIndex(handle.db, { text: terms.join(' '), limit: 50 }) : [];
		// queryIndex already flips sqlite's bm25() sign so higher `r.score` = more relevant.
		const bm25ByKey = new Map(bm25Rows.filter((r) => r.class === 'A').map((r) => [r.key, Math.max(0, r.score)]));
		const frontmatterRows = listClassAFrontmatter(handle.db);

		const lessons = selectLessons(
			frontmatterRows,
			bm25ByKey,
			{
				touchedPaths: opts.touchedPaths ?? [],
				agentType: opts.agentType ?? null,
				stacks: opts.stacks ?? [],
				isReviewed: (doc) => isReviewedOnDefaultBranch(doc, { repoRoot, ref: opts.reviewedRef ?? 'HEAD' }),
			},
			5,
		);

		let pointers = [];
		if (classBAllowed) {
			const events = listEvents(handle.db);
			pointers = selectPointers(events, { touchedPaths: opts.touchedPaths ?? [], now: opts.now ?? Date.now() }, 3);
		}

		const text = renderBrief({ overlay, lessons, pointers }, budgetBytes);
		return { text, lessonKeys: lessons.map((l) => l.key), pointerKeys: pointers.map((p) => p.key), bytes: byteLen(text) };
	} catch {
		return empty;
	}
}

/** `--evidence <key>`: the ONLY path a subagent can reach Class B free text, and only via a Bash
 * tool call (model authority), wrapped by untrusted.mjs. Returns null (not thrown) if the key is
 * unknown or anything fails. */
export function evidenceText(key, opts = {}) {
	const repoRoot = opts.repoRoot ?? process.cwd();
	try {
		const handle = ensureIndex({ repoRoot, pluginRoot: opts.pluginRoot, cacheDir: opts.cacheDir, sqlite: opts.sqlite });
		if (!handle) return null;
		const row = handle.db.prepare('SELECT * FROM events WHERE key = ?').get(key);
		if (!row) return null;
		const env = createEnvelope({ label: 'HISTORICAL REPO EVIDENCE' });
		const header = `${row.kind ?? 'event'} ${row.url ?? ''} author_kind=${row.author_kind ?? 'unknown'} updated_at=${row.updated_at ?? 'unknown'}`;
		return env.wrap(row.text ?? '', { header });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
		out[key] = next;
		i++;
	}
	return out;
}

export function main(argv, { out = console.log, err = console.error, cwd = process.cwd() } = {}) {
	const args = parseArgs(argv);
	const repoRoot = args['repo-root'] ? path.resolve(cwd, args['repo-root']) : cwd;

	if (args.evidence) {
		const text = evidenceText(String(args.evidence), { repoRoot });
		if (text === null) { err(`memory-brief: no evidence for key ${JSON.stringify(args.evidence)}`); return 1; }
		out(text);
		return 0;
	}

	const touchedPaths = typeof args.paths === 'string' ? args.paths.split(',').filter(Boolean) : [];
	const result = buildBrief({
		repoRoot,
		agentType: typeof args['agent-type'] === 'string' ? args['agent-type'] : null,
		prompt: typeof args.prompt === 'string' ? args.prompt : '',
		issue: args.issue,
		touchedPaths,
		budgetBytes: args.budget ? Number(args.budget) : undefined,
	});
	// --json: the structured result (text + the key lists the injection log needs), for callers
	// like subagent-memory-inject.mjs that must log what was pushed without re-deriving it.
	out(args.json ? JSON.stringify(result) : result.text);
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
