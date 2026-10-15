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
import { isMainEntry } from '../lib/is-main.mjs';
import {
	ensureIndex,
	listEvents,
	MARKER_SHAPE_RE,
	queryIndex,
	readFrontmatter,
	resolveCacheDir,
	resolveReviewedSha,
	validatePointerEvent,
} from '../lib/memory/index-db.mjs';
import { parseYaml } from '../lib/yaml.js';

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
/**
 * Load `.claude/memory.yml` — the trust allowlists and markers (docs/memory-spec.md §10) — from
 * the REVIEWED SHA, never the working tree (engsys#140 N5 — Nyx re-review): an attacker who could
 * edit an uncommitted/unreviewed `.claude/memory.yml` could otherwise hand themselves a trusted
 * author id or a marker to mine. Falls back to `memory.yml` in the FLEET config dir
 * (`CLAUDE_CONFIG_DIR`, a path genuinely outside the project's working tree — reading it from
 * disk is not a trust violation the way the working tree copy would be), then to defaults.
 */
export function loadConfig(repoRoot, { sha } = {}) {
	const reviewedSha = sha ?? (repoRoot ? resolveReviewedSha(repoRoot) : null);
	if (reviewedSha) {
		try {
			const out = execFileSync('git', ['-C', repoRoot, 'show', `${reviewedSha}:.claude/memory.yml`], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
			return { ...DEFAULTS, ...parseYaml(out) };
		} catch { /* not committed there — fall through to the fleet config dir */ }
	}
	if (process.env.CLAUDE_CONFIG_DIR) {
		try {
			const raw = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'memory.yml'), 'utf8');
			return { ...DEFAULTS, ...parseYaml(raw) };
		} catch { /* no fleet config dir copy either — defaults */ }
	}
	return { ...DEFAULTS };
}

/**
 * Strip an `engsys:` (or any) namespace prefix an agent_type may carry — Claude Code's own
 * dispatcher names subagents `engsys:nyx`, `engsys:isabelle`, etc. (docs/memory-spec.md §12 /
 * engsys#140 H1), while every frontmatter-derived set here (lesson `roles`, the excluded-agents
 * set from filenames) is keyed on the BARE name. Returns `''` for null/empty/non-string input —
 * never throws, never returns something that could accidentally match a real bare name.
 */
export function bareAgentType(agentType) {
	if (typeof agentType !== 'string' || !agentType) return '';
	const parts = agentType.split(':');
	return parts[parts.length - 1];
}

/**
 * Class B exclusion set (docs/memory-spec.md §2 rule 3): `config.exclude_class_b_agents` plus
 * every agent definition whose OWN frontmatter sets `security: true`. Scans BOTH layouts this
 * module can run from — the plugin cache (`<pluginRoot>/agents/`, `<pluginRoot>/optional-agents/`,
 * where `agentsRoot` is `CLAUDE_PLUGIN_ROOT`) and this engsys checkout in dev/dogfood mode
 * (`<repoRoot>/core/agents/`, `<repoRoot>/optional-agents/`) — never the task prompt or any
 * ingested text. Never throws. Returned set holds BARE agent names (no namespace prefix).
 */
export function resolveExcludedAgents(config, { agentsRoot = process.env.CLAUDE_PLUGIN_ROOT ?? REPO_ROOT_DEFAULT } = {}) {
	const excluded = new Set((config?.exclude_class_b_agents ?? []).map((a) => bareAgentType(String(a)) || String(a)));
	const candidateDirs = [
		path.join(agentsRoot, 'core', 'agents'), // repo/dev layout
		path.join(agentsRoot, 'agents'), // plugin layout, when CLAUDE_PLUGIN_ROOT IS set correctly
		path.join(agentsRoot, 'optional-agents'), // both layouts
		// engsys#140 N3: with CLAUDE_PLUGIN_ROOT unset, `agentsRoot` falls back to
		// REPO_ROOT_DEFAULT (this module's own location, two levels up — `<pluginRoot>/scripts/..`,
		// which lands OUTSIDE the plugin cache entirely, not at its root). `HERE/../agents` is
		// always `<pluginRoot>/agents` regardless of any env var, since this file's own location
		// IS inside the plugin cache whenever it's actually running from one.
		path.resolve(HERE, '..', 'agents'),
	];
	let foundAnySecurityAgent = false;
	for (const dir of [...new Set(candidateDirs)]) {
		let files;
		try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
		for (const f of files) {
			let text;
			try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
			const { fm } = readFrontmatter(text);
			if (fm.security === true) {
				excluded.add(f.replace(/\.md$/, ''));
				foundAnySecurityAgent = true;
			}
		}
	}
	// engsys#140 N3: if NO security:true agent definition was found in ANY scanned directory, the
	// scan itself is almost certainly broken (wrong root, agents/ missing, a packaging change) —
	// failing toward "nobody is excluded" would then silently hand Class B to every agent,
	// including the one(s) that are supposed to never get it. Fail toward MORE exclusion instead:
	// every known agent type this module can see is treated as excluded until the scan actually
	// finds at least one real security agent to calibrate against.
	if (!foundAnySecurityAgent) {
		for (const dir of [...new Set(candidateDirs)]) {
			let files;
			try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
			for (const f of files) excluded.add(f.replace(/\.md$/, ''));
		}
	}
	return excluded;
}

/** Is `agentType` excluded from Class B (fails toward EXCLUDED — less privilege — on a
 * null/empty/unresolved agent type, per engsys#140 H1: "a null agent type fails toward allowing
 * Class B" was the finding; the fix is the opposite default). */
export function isClassBExcluded(agentType, excludedSet) {
	const bare = bareAgentType(agentType);
	if (!bare) return true; // no agent type at all — least privilege
	return excludedSet.has(bare) || excludedSet.has(agentType);
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

// `path.matchesGlob` (Node >= 20.17) handles `*`, `**`, `?` and `{a,b}` brace alternation
// correctly — the hand-rolled regex this replaces escaped `{`/`}` as LITERAL characters, so a
// brace glob like `**/*.{ts,tsx}` (the exact example the index-db.mjs docs use) never matched.
function globMatchesAny(globs, touchedPaths) {
	if (!globs?.length || !touchedPaths?.length) return false;
	return globs.some((g) => touchedPaths.some((p) => path.matchesGlob(p, g) || path.matchesGlob(path.basename(p), g)));
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
	// Roles in frontmatter are bare names ("nyx", "aaron"); agentType may carry an `engsys:`
	// namespace prefix (engsys#140 H1) — compare bare-to-bare.
	const bareAgent = bareAgentType(agentType);
	if (bareAgent && fm.roles?.length && fm.roles.includes(bareAgent)) score += 2;
	if (fm.stacks?.length) {
		const normalizedStacks = new Set(stacks.map(normalizeStackId));
		if (fm.stacks.some((s) => normalizedStacks.has(normalizeStackId(s)))) score += 1;
	}
	return score;
}

/**
 * Resolve which lesson keys are suppressed via `supersedes`. A security:true lesson is protected:
 * it is suppressed only when the SUPERSEDING lesson is itself `isReviewed(supersederDoc) === true`
 * (docs/memory-spec.md §5). `isReviewed` defaults to "no" (fail toward NOT suppressing a security
 * lesson) — callers that can really tell (buildBrief, via git) pass a real check. A supersede
 * cycle is detected and ignored (logged via `log`), never followed.
 */
function resolveTargetKey(target) {
	return target.includes(':') ? target : `lesson:${target}`;
}

/**
 * Every key that participates in a supersede CYCLE (A -> B -> ... -> A, including the direct
 * A -> A case), via a standard white/gray/black DFS over the `supersedes` graph. A lesson in a
 * cycle is never suppressed by it — the relationship is self-contradictory, so there is no
 * trustworthy "which one is the real successor" answer. Each distinct cycle is logged once.
 */
function findCycleMembers(frontmatterRows, byKey, log) {
	const color = new Map(); // key -> 'gray' (on the current DFS stack) | 'black' (fully explored)
	const members = new Set();
	const loggedCycles = new Set();
	const edgesOf = (key) => (byKey.get(key)?.supersedes ?? []).map(resolveTargetKey).filter((t) => byKey.has(t));

	function dfs(key, stack) {
		color.set(key, 'gray');
		stack.push(key);
		for (const next of edgesOf(key)) {
			if (color.get(next) === 'gray') {
				const cycleStart = stack.indexOf(next);
				const cycle = stack.slice(cycleStart).concat(next);
				const cycleId = [...new Set(cycle)].sort().join(',');
				if (!loggedCycles.has(cycleId)) {
					loggedCycles.add(cycleId);
					log(`memory-brief: supersede cycle ignored: ${cycle.join(' -> ')}`);
				}
				for (const k of cycle) members.add(k);
			} else if (!color.has(next)) {
				dfs(next, stack);
			}
		}
		stack.pop();
		color.set(key, 'black');
	}

	for (const row of frontmatterRows) if (!color.has(row.key)) dfs(row.key, []);
	return members;
}

export function resolveSupersession(frontmatterRows, { isReviewed = () => false, log = () => {} } = {}) {
	const byKey = new Map(frontmatterRows.map((r) => [r.key, r]));
	const cycleMembers = findCycleMembers(frontmatterRows, byKey, log);
	const suppressed = new Set();
	for (const row of frontmatterRows) {
		if (cycleMembers.has(row.key)) continue; // never follow an edge that's part of a cycle
		for (const target of row.supersedes ?? []) {
			const targetKey = resolveTargetKey(target);
			if (cycleMembers.has(targetKey)) continue;
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

/** Bare (no `<!-- -->`) marker names this instance accepts, from `config.review_markers` plus the
 * house defaults (docs/memory-spec.md §8's own examples) — used to reject a pointer whose marker
 * isn't actually one this instance is configured to mine (engsys#140 H2). */
export function allowedMarkerNames(config) {
	const set = new Set(['local-review-findings', 'cr-cli-findings', 'samuel-review']);
	for (const raw of config?.review_markers ?? []) {
		const bare = String(raw).replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '').trim();
		if (MARKER_SHAPE_RE.test(bare)) set.add(bare);
	}
	return set;
}

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
	// The last choke point before a field is interpolated into `additionalContext` — re-validate
	// even though `selectPointers` already should have (defense in depth against a forged/writable
	// index.sqlite row that reached here some other way, per engsys#140 M1/H2). `null` here means
	// the CALLER must drop this pointer entirely; it is never silently rendered as a blank line.
	const safe = validatePointerEvent(event);
	if (!safe) return null;
	const date = safe.updated_at ? String(safe.updated_at).slice(0, 10) : 'unknown-date';
	const loc = safe.line ? `${safe.path}:${safe.line}` : (safe.path ?? safe.symbol ?? '?');
	const num = safe.number ? `#${safe.number}` : (safe.repo ?? '?');
	return `[${num} ${safe.kind ?? 'event'} ${loc} ${safe.marker ?? '-'} ${safe.outcome ?? 'none'} ${date}] key=${safe.key}`;
}

/** Top Class B pointers (up to 3 per spec §5), highest pointerScore first, ties broken by key for
 * determinism. */
export function selectPointers(events, opts = {}, limit = 3) {
	const valid = events
		.map((e) => validatePointerEvent(e, { allowedMarkers: opts.allowedMarkers }))
		.filter(Boolean);
	return valid
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
	for (const p of pointers) {
		const line = renderPointerLine(p);
		if (line) sections.push(line);
	}

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

// Default `origin/main`, NOT `HEAD` or any local branch — the whole point of this check is telling
// a merged/reviewed lesson apart from one a feature branch is adding uncommitted or unreviewed
// (README.md: "reviewed path (not just a feature branch)"). HEAD on a feature branch already
// contains that branch's own commits, so it would rubber-stamp exactly the case this must catch.
export function isReviewedOnDefaultBranch(doc, { repoRoot, sha }) {
	try {
		if (!sha) return false; // unresolvable reviewed ref — conservative: not reviewed
		const rel = path.relative(repoRoot, doc.path);
		if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside repoRoot — never "reviewed"
		// A pinned SHA, never a short ref name (engsys#140 N1) — `resolveReviewedSha`'s own comment
		// has the full rationale (a tag/branch literally named "origin/main" would otherwise shadow it).
		const committed = execFileSync('git', ['-C', repoRoot, 'show', `${sha}:${rel}`], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
		return committed === fs.readFileSync(doc.path, 'utf8');
	} catch {
		return false; // not committed there (yet), or no such sha/path — treat as NOT reviewed, the conservative direction
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
		const classBAllowed = !isClassBExcluded(opts.agentType, excluded);

		const handle = ensureIndex({ repoRoot, pluginRoot: opts.pluginRoot, cacheDir: opts.cacheDir, version: opts.version ?? 'dev', sqlite: opts.sqlite });
		if (!handle) return empty;

		// Reviewed-ref content only, via `handle.docs` (loadClassADocs -> loadProjectClassADocs) — NOT
		// a direct fs.readFileSync here, which would re-introduce exactly what H3 closed: an
		// uncommitted/unpushed overlay injected before review, and a symlinked overlay followed
		// straight into every subagent's system-authority context (engsys#140, cr review).
		const overlay = handle.docs.find((d) => d.kind === 'overlay')?.body ?? '';

		const terms = bm25Terms(opts.prompt);
		const bm25Rows = terms.length ? queryIndex(handle.db, { text: terms.join(' '), limit: 50 }) : [];
		// queryIndex already flips sqlite's bm25() sign so higher `r.score` = more relevant.
		// engsys#140 N2 (Nyx re-review): the DB is index.sqlite — writable, and its watermark is
		// recomputed from the same filesystem state an attacker could also control. A forged EXTRA
		// row (a key with no corresponding fresh doc at all) must score as if it doesn't exist —
		// filtered by `docsByKey` membership below, not trusted just because it came back from a
		// MATCH query.
		const docsByKey = new Map(handle.docs.map((d) => [d.key, d]));
		const bm25ByKey = new Map(bm25Rows.filter((r) => r.class === 'A' && docsByKey.has(r.key)).map((r) => [r.key, Math.max(0, r.score)]));

		// engsys#140 N2: ALL selection metadata (globs/roles/stacks/security/supersedes/path/title)
		// comes from the FRESH docs this run just parsed — never from `frontmatter` in index.sqlite.
		// A forged DB row's `supersedes`/`security`/`path` previously had real power: it could
		// suppress a real security:true lesson, or claim to be "reviewed" via a forged path. Now
		// the DB contributes nothing but a BM25 relevance number, keyed by a key that must already
		// exist in `docsByKey` to mean anything.
		const frontmatterRows = handle.docs.map((d) => ({
			key: d.key, globs: d.globs, stacks: d.stacks, roles: d.roles, keywords: d.keywords,
			security: d.security, supersedes: d.supersedes, path: d.path, title: d.title,
		}));

		const lessons = selectLessons(
			frontmatterRows,
			bm25ByKey,
			{
				touchedPaths: opts.touchedPaths ?? [],
				agentType: opts.agentType ?? null,
				stacks: opts.stacks ?? [],
				// A pinned SHA, NOT a short ref name — see resolveReviewedSha's own comment (N1):
				// a tag/branch literally named "origin/main" would otherwise shadow the real ref.
				isReviewed: (doc) => isReviewedOnDefaultBranch(doc, { repoRoot, sha: opts.reviewedSha ?? resolveReviewedSha(repoRoot, { defaultBranch: opts.defaultBranch }) }),
			},
			5,
		);

		let pointers = [];
		if (classBAllowed) {
			const events = listEvents(handle.db);
			pointers = selectPointers(events, { touchedPaths: opts.touchedPaths ?? [], now: opts.now ?? Date.now(), allowedMarkers: allowedMarkerNames(config) }, 3);
		}

		// engsys#140 M1: render Class A title/body from the FRESHLY LOADED source docs
		// (`handle.docs`, read from disk/origin-this-run), never from `index.sqlite` — the cache
		// file is writable and its watermark is recomputed from the same filesystem state an
		// attacker could also control, so a forged row would otherwise persist into every brief
		// until the next rebuild. The DB (`frontmatterRows`, `bm25ByKey`) is used ONLY to rank
		// which keys win; the rendered text always comes from this run's own parse. (`docsByKey`
		// is the same map built above for the N2 fix.)
		const renderLessons = lessons.map((fm) => {
			const doc = docsByKey.get(fm.key);
			return { key: fm.key, title: doc?.title ?? '(untitled)', body: doc?.body ?? '' };
		});

		const text = renderBrief({ overlay, lessons: renderLessons, pointers }, budgetBytes);
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

/**
 * A minimal `--key value` / `--key=value` parser. The `=` form is the one callers MUST use for a
 * value that can itself start with `--` (a task prompt like "--fix the build", or a touched path
 * that starts with a flag-looking token) — the space form would otherwise read it as the next
 * flag and silently drop the real value (degrading, not failing: the brief loses its targeting
 * but still fails open, which is why this was a minor finding, not a security one).
 */
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const eq = a.indexOf('=');
		if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
		out[key] = next;
		i++;
	}
	return out;
}

// Bare pack name -> category, mirroring eric-sabe/engsys's own stacks/<category>/<name> layout
// (and .claude-plugin/marketplace.json's plugin -> source mapping). A copy-mode project's
// engsys.config.yaml already writes canonical `category/name` ids (see detectStacks below); this
// table exists so a PLUGIN-MODE project's bare `.claude/settings.json` plugin name — just
// "engsys-prisma", no category — normalizes to the same `db/prisma` form. Kept in sync by hand;
// an unrecognized bare name falls through `normalizeStackId` unchanged rather than being dropped.
const STACK_PACK_CATEGORY = {
	aws: 'cloud', azure: 'cloud', cloudflare: 'cloud', gcp: 'cloud',
	bicep: 'iac', cdk: 'iac', terraform: 'iac',
	mongo: 'db', prisma: 'db',
	kotlin: 'lang', python: 'lang', shell: 'lang', swift: 'lang', typescript: 'lang',
	android: 'platform', ios: 'platform', web: 'platform',
	'mobile-growth': 'domain',
	'issue-tracker-github': 'tooling', 'issue-tracker-linear': 'tooling',
	'provider-anthropic': 'tooling', 'provider-codex': 'tooling', 'provider-deepseek': 'tooling', 'provider-grok': 'tooling',
};

/**
 * Canonicalize a stack id to `category/name` so a lesson's frontmatter (which may write either
 * form) and a project's detected packs (ditto) compare equal regardless of which form either side
 * used (engsys#140 P9). Already-qualified ids (contain `/`) and unrecognized bare names pass
 * through unchanged.
 */
export function normalizeStackId(id) {
	if (typeof id !== 'string' || id === '' || id.includes('/')) return id;
	const cat = STACK_PACK_CATEGORY[id];
	return cat ? `${cat}/${id}` : id;
}

/**
 * The project's selected stack packs (e.g. `["lang/typescript", "platform/web"]`), matching the
 * same ids lesson frontmatter's `stacks:` field uses. Two sources, merged (engsys#140 P9 — a
 * plugin-mode project like keystone has no `engsys.config.*`, only `.claude/settings.json`):
 *   1. `engsys.config.{yaml,yml,json}`'s `stack` block (copy-mode installs) — the file the
 *      installer itself resolves packs from.
 *   2. `.claude/settings.json`'s `enabledPlugins` map (plugin-mode installs) — each key is
 *      `<plugin-name>@<marketplace>`; `engsys-<pack>` entries (not bare `engsys` or any
 *      non-`engsys-` plugin, e.g. `feedfrwd`) normalize via `normalizeStackId`.
 * Never throws; returns `[]` if neither file exists or parses. engsys#140 W2 — this was
 * previously never computed, so the `stacks` term in `lessonMatchScore` always scored 0.
 */
export function detectStacks(repoRoot) {
	const packs = new Set();

	for (const name of ['engsys.config.yaml', 'engsys.config.yml', 'engsys.config.json']) {
		let raw;
		try { raw = fs.readFileSync(path.join(repoRoot, name), 'utf8'); } catch { continue; }
		let config;
		try { config = name.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw); } catch { continue; }
		const stack = config?.stack ?? {};
		for (const cat of ['cloud', 'iac', 'db', 'lang', 'platform', 'domain']) {
			for (const val of [].concat(stack[cat] ?? [])) {
				if (val && val !== 'none') packs.add(normalizeStackId(`${cat}/${val}`));
			}
		}
		break; // first config file found wins, same as before
	}

	try {
		const raw = fs.readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8');
		const settings = JSON.parse(raw);
		for (const rawKey of Object.keys(settings?.enabledPlugins ?? {})) {
			if (settings.enabledPlugins[rawKey] !== true) continue;
			const name = rawKey.split('@')[0];
			if (name === 'engsys' || !name.startsWith('engsys-')) continue;
			packs.add(normalizeStackId(name.slice('engsys-'.length)));
		}
	} catch { /* no settings.json, or it doesn't parse — fine, config-file packs (if any) stand */ }

	return [...packs];
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
	const stacks = typeof args.stacks === 'string' ? args.stacks.split(',').filter(Boolean) : detectStacks(repoRoot);
	const result = buildBrief({
		repoRoot,
		agentType: typeof args['agent-type'] === 'string' ? args['agent-type'] : null,
		prompt: typeof args.prompt === 'string' ? args.prompt : '',
		issue: args.issue,
		touchedPaths,
		stacks,
		budgetBytes: args.budget ? Number(args.budget) : undefined,
	});
	// --json: the structured result (text + the key lists the injection log needs), for callers
	// like subagent-memory-inject.mjs that must log what was pushed without re-deriving it.
	out(args.json ? JSON.stringify(result) : result.text);
	return 0;
}

if (isMainEntry(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
