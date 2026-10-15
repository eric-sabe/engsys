#!/usr/bin/env node
// harvest-findings.mjs — mine recurring review-finding families out of PR history (marker
// comments, FINDING-ACK lines, PR reviews, inline review threads, standalone single-issue PRs,
// and monster journals) and propose lessons/overlay changes as a reviewable docs PR. Design:
// docs/memory-spec.md §8. Called by core/workflows/project-closeout-ceremony.md Step 4 in place
// of that step's hardcoded single-marker `gh pr view --json comments | jq …` loop.
//
// Zero-dependency ESM, Node >= 20. The only external process is `gh` (injectable `gh(args) ->
// stdout`, same shape as review-bakeoff.mjs's `defaultGh` — no network in tests). Finding
// extraction from a comment body reuses review-bakeoff.mjs's `parseReviewComment` (the fenced-JSON
// + bullet-list parser already hardened for this exact text shape) rather than a second parser.
//
// THE RULE THIS FILE MUST NEVER BREAK (spec §8): output is ALWAYS a reviewable docs PR proposing
// lesson/overlay changes — it never writes to a Class A file on the default branch directly. Every
// write goes through `proposeBranch`/`openProposalPr`, which commit to a fresh branch and open a
// (draft) PR; nothing here calls `git` with `-b main`/`checkout main` for a write, and there is no
// code path that edits `core/lessons-library/**` or `docs/agent-lessons/**` in place.
//
// Usage:
//   node harvest-findings.mjs harvest --repo owner/repo (--prs 12,15,19 | --since 2026-09-01 [--until ...])
//        [--markers '<!-- cr-cli-findings -->,<!-- samuel-review -->'] [--journal-dir docs/agent-lessons]
//        [--min-recurrence 2] [--out proposal.json]
//   node harvest-findings.mjs propose proposal.json [--md out.md]
//   node harvest-findings.mjs run --repo owner/repo (--prs ... | --since ...) [--apply] [--branch NAME]
//        (harvest + propose +, with --apply, open the PR; without --apply, prints the proposal and stops)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainEntry } from '../lib/is-main.mjs';
import { parseArgs, promisify } from 'node:util';
import { parseReviewComment, titleTokens } from './review-bakeoff.mjs';
import { loadConfig } from './memory-brief.mjs';

const execFileP = promisify(execFile);

export async function defaultGh(args) {
	const { stdout } = await execFileP('gh', args, { maxBuffer: 256 * 1024 * 1024 });
	return stdout;
}

async function ghJson(gh, args, what) {
	let raw;
	try {
		raw = await gh(args);
	} catch (err) {
		throw new Error(`gh failed while ${what}: ${String((err && (err.stderr || err.message)) || err).trim()}`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`gh returned non-JSON while ${what}`);
	}
}

// ---------------------------------------------------------------------------------------------
// markers + FINDING-ACK (shared grammar across every text source this harvester reads)
// ---------------------------------------------------------------------------------------------

/** docs/memory-spec.md §8 default: a LEADING `<!-- *-(findings|review) -->` marker — matches
 * `<!-- cr-cli-findings -->`, `<!-- local-review-findings -->`, `<!-- samuel-review -->`, etc. */
export const DEFAULT_MARKER_RE = /^<!--\s*(?:[\w-]+-)?(?:findings|review)\s*-->/;

/** Build the matcher list: the default regex, plus one literal (escaped) leading-match regex per
 * `config.review_markers` entry (docs/memory-spec.md §10). */
export function buildMarkerMatchers(config = {}) {
	const extra = (config.review_markers ?? []).map((m) => new RegExp(`^${String(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	return [DEFAULT_MARKER_RE, ...extra];
}

/** A comment/body IS a marker finding record when the marker is in LEADING position (never
 * `includes()` — see core/lessons-library/match-marker-comments-by-leading-position-and-author.md). */
export function isMarkerBody(body, matchers) {
	const text = String(body ?? '').trimStart();
	return matchers.some((re) => re.test(text));
}

const ACK_RE = /^FINDING-ACK:\s*([A-Za-z0-9_-]+)\s*(?:→|->)\s*(fixed|disputed|deferred)\b(?:\s*[—-]\s*(.*))?$/gm;

/** Parse every `FINDING-ACK: <id> -> fixed|disputed|deferred — <evidence>` line in `text`. */
export function parseFindingAcks(text) {
	return [...String(text ?? '').matchAll(ACK_RE)].map((m) => ({ id: m[1], outcome: m[2], evidence: (m[3] ?? '').trim() }));
}

// ---------------------------------------------------------------------------------------------
// family classification
// ---------------------------------------------------------------------------------------------

/** Group key for "the same mistake family": the file plus a short signature of its title tokens
 * (falls back to `category`). Deliberately coarser than review-bakeoff's `findingKey` (which
 * includes the line) — a family recurs across DIFFERENT lines/PRs, not the same one. */
export function familyKey(finding) {
	const sig = titleTokens(finding.title).slice(0, 4).join('-') || finding.category || 'untitled';
	return `${finding.file}::${sig}`;
}

/**
 * Aggregate `records` (each `{ finding, prNumber, url, source, outcome }`) into families, ranked
 * by recurrence (distinct PRs) then by how many were NOT `fixed` (an unresolved/disputed pattern
 * is worth a lesson more urgently than one that's always fixed). Drops families seen in fewer than
 * `minRecurrence` distinct PRs/sources (spec: "recurring families").
 */
export function aggregateFamilies(records, { minRecurrence = 2 } = {}) {
	const byKey = new Map();
	for (const r of records) {
		const key = familyKey(r.finding);
		if (!byKey.has(key)) byKey.set(key, { key, file: r.finding.file, title: r.finding.title, severity: r.finding.severity, records: [] });
		byKey.get(key).records.push(r);
	}
	const families = [];
	for (const fam of byKey.values()) {
		const distinctSources = new Set(fam.records.map((r) => r.prNumber ?? r.source));
		if (distinctSources.size < minRecurrence) continue;
		const outcomes = fam.records.reduce((acc, r) => { acc[r.outcome ?? 'unknown'] = (acc[r.outcome ?? 'unknown'] ?? 0) + 1; return acc; }, {});
		families.push({
			...fam,
			count: fam.records.length,
			distinctSources: distinctSources.size,
			outcomes,
			unresolvedCount: fam.records.filter((r) => r.outcome && r.outcome !== 'fixed').length,
			examples: fam.records.slice(0, 3),
		});
	}
	families.sort((a, b) => b.distinctSources - a.distinctSources || b.unresolvedCount - a.unresolvedCount || a.key.localeCompare(b.key));
	return families;
}

// ---------------------------------------------------------------------------------------------
// extraction from one source (a PR, a journal file, …) — pure given the raw text/comments
// ---------------------------------------------------------------------------------------------

/**
 * Extract finding records from one PR's comments + reviews + inline review-thread comments.
 * `FINDING-ACK: F<n> -> outcome` lines are resolved to `findings[n-1]` BY ID, scoped to the time
 * window between this marker comment and the next one (so repeated review rounds, each restarting
 * at F1, never cross-contaminate each other's outcomes). An id with no matching ack in that window
 * leaves that finding's outcome `null` rather than guessed. This is the one place in the harvester
 * that resolves "was this fixed, disputed, or ignored" — getting it wrong would misrank which
 * family most needs a lesson.
 */
/**
 * Strip control characters and collapse newlines out of a title before it's ever used as a
 * family's rendered heading or a lesson's `title` (engsys#140 M2) — a finding's title is
 * attacker-influenceable text (whoever authored the comment it came from), same rationale as the
 * Class B field allowlists in index-db.mjs.
 */
export function sanitizeTitle(title) {
	return String(title ?? '').replace(/[\r\n]+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').trim();
}

/**
 * True iff `source`'s numeric author id is in `trustedIds` (engsys#140 M2 — Nyx F5). `source` is
 * a comment/review (GraphQL shape: `authorId` attached by `harvest()`'s login->id resolution) or
 * a REST review-thread comment (`user.id` is already numeric). An unresolved author id is NEVER
 * trusted — fail toward excluding, the same direction as every other trust gate in this system.
 */
export function isTrustedAuthor(source, trustedIds) {
	const id = source?.authorId ?? source?.user?.id ?? null;
	return id != null && trustedIds.has(id);
}

export function extractFromPr(pr, matchers, { trustedIds = null } = {}) {
	const records = [];
	const withTime = (s) => s.createdAt ?? s.submittedAt ?? null;
	// engsys#140 M2: an untrusted commenter's marker findings and FINDING-ACK lines are dropped
	// before anything else touches them — anyone who can comment on a PR could otherwise seed
	// fabricated "findings" straight into a proposed lesson's title. `trustedIds === null` means
	// "no filtering configured" (only reachable via a caller that bypassed `harvest()`'s own
	// refuse-to-run gate, e.g. a direct unit test of this pure function).
	const trustFilter = trustedIds ? (s) => isTrustedAuthor(s, trustedIds) : () => true;
	const allSources = [...(pr.comments ?? []), ...(pr.reviews ?? [])]
		.filter(trustFilter)
		.slice()
		.sort((a, b) => String(withTime(a) ?? '').localeCompare(String(withTime(b) ?? '')));
	const markerSources = allSources.filter((s) => isMarkerBody(s.body, matchers));

	for (let mi = 0; mi < markerSources.length; mi++) {
		const source = markerSources[mi];
		const parsed = parseReviewComment(source.body);
		if (parsed.error || parsed.unparseable) continue;
		// FINDING-ACK ids (F1, F2, …) are scoped to the fix round for THIS marker comment: acks are
		// looked for only between this marker and the next one (by createdAt/submittedAt, when
		// present). A PR with repeated review rounds — each restarting at F1 — would otherwise have
		// its later round's acks wrongly zipped onto the EARLIER round's findings by raw position.
		const windowStart = withTime(source);
		const windowEnd = mi + 1 < markerSources.length ? withTime(markerSources[mi + 1]) : null;
		const ackText = allSources
			.filter((s) => {
				const t = withTime(s);
				if (windowStart && t && t < windowStart) return false;
				if (windowEnd && t && t >= windowEnd) return false;
				return true;
			})
			.map((s) => s.body)
			.join('\n');
		const ackById = new Map(parseFindingAcks(ackText).map((a) => [a.id, a]));
		parsed.findings.forEach((finding, i) => {
			records.push({
				finding: { ...finding, title: sanitizeTitle(finding.title) },
				prNumber: pr.number,
				url: pr.url ?? null,
				source: 'marker',
				outcome: ackById.get(`F${i + 1}`)?.outcome ?? null,
			});
		});
	}

	// Inline review-thread comments (REST `pulls/{n}/comments`): each one anchors a path+line
	// directly, so it is itself a one-finding record (no marker/ack correlation needed or expected).
	for (const t of pr.reviewThreads ?? []) {
		if (!t.path) continue;
		if (t.in_reply_to_id) continue; // a reply, not the thread's own comment — skip, or every reply inflates the record count
		if (!trustFilter(t)) continue;
		records.push({
			finding: { file: t.path, line: t.line ?? t.original_line ?? null, severity: 'warning', category: 'review-thread', title: sanitizeTitle((t.body ?? '').split('\n')[0].slice(0, 160)) },
			prNumber: pr.number,
			url: t.html_url ?? pr.url ?? null,
			source: 'review_thread',
			// The REST `pulls/{n}/comments` endpoint this is fetched from has no resolution state —
			// that's only `reviewThreads.isResolved` over GraphQL, not implemented here. Tracked as
			// a follow-up (eric-sabe/engsys#143), not a correctness bug: an honest `null` just
			// means this source never ranks as "fixed".
			outcome: null,
		});
	}
	return records;
}

/** Extract findings from a monster journal's plain text (docs/memory-spec.md §7.1/§8: "monster
 * journals, from local state dirs"). Journals carry the same marker + FINDING-ACK grammar as a PR
 * comment, so this is the same extraction applied to one big text blob instead of a comments array. */
export function extractFromJournalText(text, matchers, { source = 'journal' } = {}) {
	const records = [];
	// A journal's marker block runs from a line that opens with a configured marker to the START
	// of the next such line (or end of text) — NOT split on blank lines, since the machine block a
	// marker introduces (a fenced ```json, or a multi-paragraph bullet list) routinely contains
	// blank lines of its own; splitting on those would hand parseReviewComment a truncated,
	// JSON-less fragment and silently find nothing.
	const lineMarkerRe = new RegExp(`^(?:${matchers.map((m) => m.source).join('|')})`, 'm');
	const starts = [];
	const globalRe = new RegExp(lineMarkerRe.source, 'gm');
	let m;
	while ((m = globalRe.exec(text)) !== null) {
		starts.push(m.index);
		if (m[0].length === 0) globalRe.lastIndex++;
	}
	for (let i = 0; i < starts.length; i++) {
		const block = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
		if (!isMarkerBody(block, matchers)) continue; // defensive; starts[] is already marker-anchored
		const parsed = parseReviewComment(block);
		if (parsed.error || parsed.unparseable) continue;
		for (const finding of parsed.findings) {
			records.push({ finding, prNumber: null, url: null, source, outcome: null });
		}
	}
	return records;
}

// ---------------------------------------------------------------------------------------------
// harvesting (gh-touching; thin, injectable)
// ---------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function searchQuery(since, until) {
	for (const d of [since, until]) if (d && !DATE_RE.test(d)) throw new Error(`invalid date "${d}" (expected YYYY-MM-DD)`);
	if (since && until) return `merged:${since}..${until}`;
	if (since) return `merged:>=${since}`;
	if (until) return `merged:<=${until}`;
	throw new Error('resolvePrNumbers: pass --prs, or at least one of --since/--until');
}

/** Resolve the PR numbers to harvest: an explicit `opts.prs` list (covers a standalone
 * single-issue PR just as well as a batch — it's simply a list of one), or a `--since`/`--until`
 * search over merged PRs. */
export async function resolvePrNumbers(opts, { gh = defaultGh } = {}) {
	if (Array.isArray(opts.prs) && opts.prs.length) return opts.prs;
	const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
	const limit = opts.limit ?? 200;
	const list = await ghJson(gh, ['pr', 'list', ...repoArgs, '--state', 'merged', '--search', searchQuery(opts.since, opts.until), '--limit', String(limit), '--json', 'number'], 'listing merged PRs');
	return list.map((p) => p.number);
}

/** Fetch one PR's comments, reviews, and inline review-thread comments. Inline threads use the
 * REST endpoint (`gh api repos/.../pulls/{n}/comments`) rather than GraphQL — simpler, and every
 * thread's first comment already carries the path/line/resolved-ish fields this harvester needs. */
export async function fetchPr(number, opts, { gh = defaultGh } = {}) {
	const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
	const v = await ghJson(gh, ['pr', 'view', String(number), ...repoArgs, '--json', 'number,title,url,comments,reviews'], `reading PR #${number}`);
	let reviewThreads = [];
	if (opts.repo) {
		try {
			reviewThreads = await ghJson(gh, ['api', `repos/${opts.repo}/pulls/${number}/comments`, '--paginate'], `reading PR #${number} review comments`);
		} catch {
			reviewThreads = []; // optional enrichment; a failure here must not sink the whole harvest
		}
	}
	return { ...v, reviewThreads };
}

/**
 * Harvest records for every PR in `opts.prs`/`opts.since..until`, plus any journal files under
 * `opts.journalPaths`. Returns `{ records, prsHarvested }`.
 */
/** Resolve each distinct `login` to its numeric user id via `gh api users/<login>`, once per
 * login (cached). A login that fails to resolve maps to `null` (never trusted — see
 * `isTrustedAuthor`), never thrown. */
async function resolveAuthorIds(gh, logins) {
	const cache = new Map();
	for (const login of logins) {
		if (!login || cache.has(login)) continue;
		try {
			const out = await gh(['api', `users/${login}`, '--jq', '.id']);
			const id = Number(String(out).trim());
			cache.set(login, Number.isFinite(id) ? id : null);
		} catch {
			cache.set(login, null);
		}
	}
	return cache;
}

/** Attach a numeric `authorId` to every comment/review in `pr`, resolved via `idByLogin`
 * (comments/reviews only carry `author.login` from `gh pr view --json`; review-thread entries
 * from the REST API already carry a numeric `user.id` and need no resolution). */
function withAuthorIds(pr, idByLogin) {
	const tag = (s) => ({ ...s, authorId: idByLogin.get(s.author?.login) ?? null });
	return { ...pr, comments: (pr.comments ?? []).map(tag), reviews: (pr.reviews ?? []).map(tag) };
}

export async function harvest(opts, { gh = defaultGh, readFile = (p) => fs.readFileSync(p, 'utf8'), log = () => {} } = {}) {
	const config = opts.config ?? {};
	const matchers = buildMarkerMatchers(config);
	// engsys#140 M2 — Nyx F5: with NO trust allowlist configured at all, "mine every commenter's
	// findings" is exactly the attack this gate exists to prevent — refuse outright rather than
	// silently trusting everyone.
	const trustedIds = new Set([...(config.trusted_bot_user_ids ?? []), ...(config.operator_user_ids ?? [])]);
	if (trustedIds.size === 0) {
		throw new Error('harvest-findings: refusing to run with no trust allowlist configured — set trusted_bot_user_ids and/or operator_user_ids in .claude/memory.yml (docs/memory-spec.md §10), or every commenter\'s findings/FINDING-ACK lines would be mined unchecked');
	}
	const numbers = await resolvePrNumbers(opts, { gh });
	const records = [];
	for (const n of numbers) {
		let pr = await fetchPr(n, opts, { gh });
		const logins = [...(pr.comments ?? []), ...(pr.reviews ?? [])].map((s) => s.author?.login).filter(Boolean);
		const idByLogin = await resolveAuthorIds(gh, [...new Set(logins)]);
		pr = withAuthorIds(pr, idByLogin);
		const prRecords = extractFromPr(pr, matchers, { trustedIds });
		records.push(...prRecords);
		log(`harvested #${n}: ${prRecords.length} finding(s)`);
	}
	for (const jp of opts.journalPaths ?? []) {
		let text;
		try { text = readFile(jp); } catch { continue; }
		const jRecords = extractFromJournalText(text, matchers, { source: `journal:${path.basename(jp)}` });
		records.push(...jRecords);
		log(`harvested ${jp}: ${jRecords.length} finding(s)`);
	}
	return { records, prsHarvested: numbers };
}

// ---------------------------------------------------------------------------------------------
// proposal rendering — the lesson/overlay DIFF a reviewer approves, never a direct Class A edit
// ---------------------------------------------------------------------------------------------

function slugify(s) {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finding';
}

/**
 * One disambiguated slug per family, in order, as a `Map<family, slug>`. Two families can
 * slugify to the same base (e.g. the same finding title recurring in two different files) — a
 * collision gets a `-2`, `-3`, … suffix so the second family's write never silently overwrites
 * the first. `existingSlugs` (optional) additionally avoids colliding with a file already on
 * disk/branch (e.g. a previous harvest's proposal that hasn't merged yet).
 */
export function uniqueSlugs(families, existingSlugs = new Set()) {
	const used = new Set(existingSlugs);
	const bySlug = new Map();
	for (const fam of families) {
		const base = slugify(fam.title || fam.key);
		let slug = base;
		let n = 2;
		while (used.has(slug)) { slug = `${base}-${n}`; n++; }
		used.add(slug);
		bySlug.set(fam, slug);
	}
	return bySlug;
}

/** Render ONE proposed lesson file's content, schema-conformant with E10's frontmatter (docs/memory-spec.md §2). */
export function renderLessonProposal(family) {
	const title = family.title || family.key;
	const keywords = titleTokens(title).slice(0, 6);
	const fm = [
		'---',
		'globs: []',
		'stacks: []',
		'roles: []',
		`keywords: ${JSON.stringify(keywords.length ? keywords : [slugify(title)])}`,
		'security: false',
		'supersedes: []',
		'---',
		'',
	].join('\n');
	const examples = family.examples.map((e) => `- ${e.finding.file}${e.finding.line ? `:${e.finding.line}` : ''} (PR ${e.prNumber ?? e.source}${e.url ? `, ${e.url}` : ''})`).join('\n');
	return [
		fm,
		`# ${title}`,
		'',
		'> **Title above is untrusted harvested text** — taken from PR/review comment bodies, which anyone who can comment could have written. Verify the trigger/failure-mode/correct-behavior below yourself before merging; don\'t trust the title as a factual claim.',
		'',
		`**Trigger:** _fill in — recurred ${family.distinctSources} times across: see examples below._`,
		'',
		'**Failure mode:** _fill in._',
		'',
		'**Correct behavior:** _fill in._',
		'',
		'**Check:** _fill in._',
		'',
		`**Seen in:** harvested automatically (harvest-findings.mjs) — ${family.distinctSources} occurrence(s), outcomes: ${JSON.stringify(family.outcomes)}.`,
		'',
		'### Occurrences',
		examples,
		'',
	].join('\n');
}

/** Render the full proposal markdown (what a human reviews before merging the docs PR). */
export function renderProposal(families, { repo = null, slugs = null } = {}) {
	if (families.length === 0) return '# Review-finding harvest\n\nNo family recurred at least `--min-recurrence` times — nothing proposed.\n';
	const slugOf = slugs ?? uniqueSlugs(families);
	const lines = [`# Review-finding harvest${repo ? ` — ${repo}` : ''}`, '', `${families.length} recurring famil${families.length === 1 ? 'y' : 'ies'} found.`, ''];
	for (const fam of families) {
		lines.push(`## ${fam.title || fam.key} (${fam.distinctSources}x, ${fam.unresolvedCount} unresolved)`);
		lines.push('', '_(heading above is untrusted harvested text from PR/review comments — verify before trusting)_', '');
		lines.push('', `Proposed: \`docs/agent-lessons/${slugOf.get(fam)}.md\` (or promote to the engsys lessons-library if it generalizes).`, '');
		lines.push('<details><summary>Proposed lesson file</summary>', '', '```markdown', renderLessonProposal(fam).trimEnd(), '```', '</details>', '');
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// opening the docs PR (never a direct Class A edit on the default branch)
// ---------------------------------------------------------------------------------------------

async function defaultGit(args, { cwd } = {}) {
	const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

/**
 * Write one proposed lesson file per family to a FRESH branch (never the default branch) and open
 * a draft PR via `gh`. `families` with `unresolvedCount === 0` are still proposed (a
 * consistently-fixed-but-recurring pattern is exactly the "lesson exists but wasn't applied at
 * authoring time" case the closeout ceremony calls out) — this function doesn't filter further;
 * `aggregateFamilies`'s `minRecurrence` already did that.
 *
 * Returns `{ branch, files, prUrl }` on success. Every git/gh call is injectable for tests; no real
 * process is ever spawned by the test suite.
 */
export async function openProposalPr(families, opts, { git = defaultGit, gh = defaultGh, now = () => Date.now() } = {}) {
	const cwd = opts.cwd ?? process.cwd();
	const branch = opts.branch ?? `agent/memory-harvest-${now()}`;
	const defaultBranch = opts.defaultBranch ?? 'main';
	// engsys#140 Nyx F7: a caller-supplied --branch must never be the default branch (or any
	// branch name outside the `agent/` convention this whole module's proposals use) — the
	// `-b`/explicit-refspec push below already stop a push FROM landing ON an unintended branch
	// by accident, but reject the obviously-wrong input outright rather than relying on that.
	if (branch === defaultBranch || branch === 'main' || branch === 'master' || !branch.startsWith('agent/')) {
		throw new Error(`openProposalPr: --branch must start with "agent/" and must not be the default branch, got ${JSON.stringify(branch)}`);
	}
	// Do all of this in an ISOLATED `git worktree`, not the caller's own checkout: `cwd` may be the
	// operator's active working tree (uncommitted changes, a different branch mid-task) — checking
	// out a new branch there, succeeding or failing, would collide with or silently carry over
	// whatever the operator is doing, and leave them stranded on the harvest branch afterward.
	const worktreeDir = opts.worktreeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-proposal-'));
	try {
		await git(['fetch', 'origin', defaultBranch], { cwd });
		// `-b` (not `-B`): refuses outright on an existing branch name instead of silently resetting it.
		await git(['worktree', 'add', worktreeDir, '-b', branch, `origin/${defaultBranch}`], { cwd });
		const files = [];
		const dir = path.join(worktreeDir, 'docs', 'agent-lessons');
		fs.mkdirSync(dir, { recursive: true });
		// Disambiguate up front (two families can slugify to the same base — same finding title in
		// two different files, say) and seed it with whatever's already on disk/branch, so a
		// collision gets a -2/-3 suffix instead of the second family's write overwriting the first.
		const existing = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
		const slugOf = uniqueSlugs(families, existing);
		for (const fam of families) {
			const file = path.join(dir, `${slugOf.get(fam)}.md`);
			fs.writeFileSync(file, renderLessonProposal(fam));
			files.push(path.relative(worktreeDir, file));
		}
		await git(['add', ...files], { cwd: worktreeDir });
		await git(['commit', '-m', `docs(memory): propose ${files.length} harvested lesson(s)`], { cwd: worktreeDir });
		// An explicit refspec (not just the branch name) so there is no ambiguity about which ref
		// on `origin` this lands on, even if `branch` happened to collide with some other local
		// ref-like shorthand (engsys#140 Nyx F7).
		await git(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktreeDir });
		const body = renderProposal(families, { repo: opts.repo, slugs: slugOf });
		const prArgs = ['pr', 'create', '--draft', '--title', `docs: propose ${files.length} harvested lesson(s)`, '--body', body, '--head', branch];
		if (opts.repo) prArgs.push('--repo', opts.repo);
		const prUrl = (await gh(prArgs)).trim();
		return { branch, files, prUrl };
	} finally {
		// Best-effort cleanup — a failure here must never mask the real result/error above, and
		// must never touch the caller's own checkout (`cwd`), only the throwaway worktree.
		try { await git(['worktree', 'remove', worktreeDir, '--force'], { cwd }); } catch { /* best effort */ }
		try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export async function main(argv, { gh = defaultGh, git = defaultGit, out = console.log, err = console.error, cwd = process.cwd() } = {}) {
	const [cmd, ...rest] = argv;
	const { values } = parseArgs({
		args: rest,
		options: {
			repo: { type: 'string' },
			prs: { type: 'string' },
			since: { type: 'string' },
			until: { type: 'string' },
			markers: { type: 'string' },
			'trusted-bot-ids': { type: 'string' },
			'operator-ids': { type: 'string' },
			'journal-dir': { type: 'string' },
			'min-recurrence': { type: 'string', default: '2' },
			out: { type: 'string' },
			md: { type: 'string' },
			apply: { type: 'boolean', default: false },
			branch: { type: 'string' },
		},
		allowPositionals: true,
	});

	const config = loadConfig(cwd);
	if (values.markers) config.review_markers = [...(config.review_markers ?? []), ...values.markers.split(',').filter(Boolean)];
	// CLI overrides for the trust allowlists (engsys#140 M2) — additive to .claude/memory.yml's own
	// lists, not a replacement, so a one-off `--operator-ids` doesn't require editing the config file.
	const parseIds = (s) => s.split(',').map(Number).filter(Number.isFinite);
	if (values['trusted-bot-ids']) config.trusted_bot_user_ids = [...(config.trusted_bot_user_ids ?? []), ...parseIds(values['trusted-bot-ids'])];
	if (values['operator-ids']) config.operator_user_ids = [...(config.operator_user_ids ?? []), ...parseIds(values['operator-ids'])];

	const opts = {
		repo: values.repo,
		prs: values.prs ? values.prs.split(',').map(Number).filter((n) => Number.isFinite(n)) : undefined,
		since: values.since,
		until: values.until,
		config,
		journalPaths: values['journal-dir'] && fs.existsSync(values['journal-dir'])
			? fs.readdirSync(values['journal-dir']).filter((f) => /journal/i.test(f)).map((f) => path.join(values['journal-dir'], f))
			: [],
	};

	if (cmd === 'harvest' || cmd === 'run') {
		// A clean, expected refusal (no trust allowlist, bad --since/--until, …) is a usage error,
		// not a crash — caught here so `main()` always returns a code/message, never a rejected
		// promise that only the top-level `.catch()` would turn into one.
		let records;
		try {
			({ records } = await harvest(opts, { gh }));
		} catch (e) {
			err(String(e?.message ?? e));
			return 1;
		}
		const families = aggregateFamilies(records, { minRecurrence: Number(values['min-recurrence']) || 2 });
		if (cmd === 'harvest') {
			const payload = JSON.stringify({ families, harvestedAt: new Date().toISOString(), repo: opts.repo ?? null }, null, 2);
			if (values.out) fs.writeFileSync(values.out, payload);
			else out(payload);
			return 0;
		}
		// run: propose, and only open the PR with --apply.
		out(renderProposal(families, { repo: opts.repo }));
		if (values.apply && families.length) {
			const result = await openProposalPr(families, { ...opts, cwd, branch: values.branch }, { git, gh });
			out(`opened: ${result.prUrl}`);
		}
		return 0;
	}

	if (cmd === 'propose') {
		const file = rest.find((a) => !a.startsWith('--'));
		if (!file) { err('propose: missing proposal.json path'); return 1; }
		const { families } = JSON.parse(fs.readFileSync(file, 'utf8'));
		const md = renderProposal(families, { repo: opts.repo });
		if (values.md) fs.writeFileSync(values.md, md);
		else out(md);
		return 0;
	}

	err(`harvest-findings: unknown command ${JSON.stringify(cmd)} (expected harvest|propose|run)`);
	return 1;
}

if (isMainEntry(import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code ?? 0))
		.catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
