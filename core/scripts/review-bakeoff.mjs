#!/usr/bin/env node
// review-bakeoff.mjs — harvest and score a paired code-review bake-off. Zero dependencies, Node >= 20.
//
// Two reviewers ("a" and "b") review the same PRs and each upserts one marker comment per PR
// (see docs/review-methodology.md). This tool answers "is reviewer b worth keeping, or replacing a?"
// with data instead of a hunch:
//
//   harvest  collect each PR's marker-A and marker-B comment (plus head SHA and author) via `gh`
//   score    parse the findings out of those comments, match them across the two reviewers, and
//            report overlap, each reviewer's unique findings, and (with an operator label file)
//            precision and cost per useful finding
//
// It makes NO model or provider calls. Running a reviewer belongs to the reviewer itself; this
// tool only reads what the reviewers already posted. The only external process is `gh` (harvest).
//
// Usage:
//   node review-bakeoff.mjs harvest --repo owner/repo (--since 2026-09-01 [--until 2026-09-28] | --prs 12,15,19)
//        [--limit 100] [--marker-a '<!-- review-a -->'] [--marker-b '<!-- review-b -->']
//        [--author-a login] [--author-b login] [--name-a reviewer-a] [--name-b reviewer-b]
//        [--out golden.json]
//   node review-bakeoff.mjs score golden.json [--labels labels.json] [--line-tolerance 3]
//        [--min-title-similarity 0.25] [--min-severity info|warning|critical] [--strict-sha]
//        [--name-a NAME] [--name-b NAME] [--md report.md] [--json report.json] [--format md|json]
//
// Comment formats `score` understands (a reviewer needs only one):
//   1. Machine block, preferred: the LAST fenced ```json block, or the LAST `<!-- review-data {...} -->`
//      HTML comment, holding either an array of findings or an object
//      {"sha": "<commit reviewed>", "costUsd": 0.31, "findings": [ ... ]}. A finding is
//      {"file", "line", "severity", "category", "title", "rationale", "unconfirmed", "verifierReason"};
//      only `file` is required for matching. An explicit `"findings": []` is a definitive "no findings".
//   2. Fallback list: one bullet per finding, `- [SEVERITY] path/to/file.ext:LINE — title`. Backticks
//      around the location, **bold** around the title and a trailing `_(category)_` are accepted.
//   A commit SHA is read from the JSON (`sha`) or from a line such as `Reviewed commit: 1a2b3c4`.
//
// A comment whose JSON block is malformed, or whose text lists severity-tagged bullets that yield no
// findings, is reported UNSCOREABLE and excluded. It is never read as "no findings".

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileP = promisify(execFile);

export const DEFAULT_MARKER_A = '<!-- review-a -->';
export const DEFAULT_MARKER_B = '<!-- review-b -->';

// ---------------------------------------------------------------------------------------------
// gh access (injectable: every network-touching function takes a `gh(args) -> stdout` function)
// ---------------------------------------------------------------------------------------------

export async function defaultGh(args) {
	const { stdout } = await execFileP('gh', args, { maxBuffer: 256 * 1024 * 1024 });
	return stdout;
}

async function ghJson(gh, args, what) {
	let raw;
	try {
		raw = await gh(args);
	} catch (err) {
		const detail = (err && (err.stderr || err.message)) || String(err);
		throw new Error(`gh failed while ${what}: ${String(detail).trim()}`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`gh returned non-JSON while ${what}`);
	}
}

// ---------------------------------------------------------------------------------------------
// marker comments
// ---------------------------------------------------------------------------------------------

/**
 * Comments that ARE a given reviewer's review: marker in LEADING position (the reviewer's renderer
 * emits it as line 1) and, when `author` is given, written by that login. A comment that merely
 * MENTIONS the marker in its prose must never match (`includes()` is the bug this rule prevents).
 * Oldest first.
 */
export function findMarkerComments(comments, marker, author = null) {
	return (comments ?? [])
		.filter((c) => typeof c?.body === 'string' && c.body.trimStart().startsWith(marker))
		.filter((c) => !author || String(c.author?.login ?? '').toLowerCase() === author.toLowerCase())
		.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')));
}

function pickComment(matches) {
	if (matches.length === 0) return null;
	// An upsert leaves one comment; if several exist, the latest is the current review.
	const c = matches[matches.length - 1];
	return {
		body: c.body,
		author: c.author?.login ?? null,
		url: c.url ?? null,
		createdAt: c.createdAt ?? null,
		count: matches.length,
	};
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function searchQuery(since, until) {
	for (const d of [since, until]) {
		if (d && !DATE_RE.test(d)) throw new Error(`invalid date "${d}" (expected YYYY-MM-DD)`);
	}
	if (since && until) return `merged:${since}..${until}`;
	if (since) return `merged:>=${since}`;
	return `merged:<=${until}`;
}

/**
 * Collect PR entries carrying each reviewer's marker comment.
 * opts: { repo?, prs?: number[], since?, until?, limit?, markerA, markerB, authorA?, authorB?, nameA?, nameB? }
 */
export async function harvest(opts, { gh = defaultGh, log = () => {} } = {}) {
	const markerA = opts.markerA ?? DEFAULT_MARKER_A;
	const markerB = opts.markerB ?? DEFAULT_MARKER_B;
	if (markerA === markerB) throw new Error('marker A and marker B must differ');
	const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
	const hasRange = Boolean(opts.since || opts.until);
	const hasList = Array.isArray(opts.prs) && opts.prs.length > 0;
	if (hasRange === hasList) throw new Error('give exactly one of --prs or --since/--until');

	let numbers;
	if (hasList) {
		numbers = opts.prs;
	} else {
		const limit = opts.limit ?? 100;
		const list = await ghJson(
			gh,
			['pr', 'list', ...repoArgs, '--state', 'merged', '--search', searchQuery(opts.since, opts.until), '--limit', String(limit), '--json', 'number'],
			'listing merged PRs',
		);
		numbers = list.map((p) => p.number);
		if (numbers.length >= limit) {
			log(`warning: ${numbers.length} PRs hit --limit ${limit}; the range may hold more (raise --limit)`);
		}
	}

	const prs = [];
	for (const n of numbers) {
		const v = await ghJson(
			gh,
			['pr', 'view', String(n), ...repoArgs, '--json', 'number,title,url,state,mergedAt,headRefOid,mergeCommit,comments'],
			`reading PR #${n}`,
		);
		const a = pickComment(findMarkerComments(v.comments, markerA, opts.authorA));
		const b = pickComment(findMarkerComments(v.comments, markerB, opts.authorB));
		prs.push({
			pr: v.number,
			title: v.title,
			url: v.url ?? null,
			state: v.state ?? null,
			mergedAt: v.mergedAt ?? null,
			mergeCommit: v.mergeCommit?.oid ?? null,
			headSha: v.headRefOid ?? null,
			a,
			b,
		});
		log(`harvested #${v.number} (a: ${a ? 'yes' : 'NO'}, b: ${b ? 'yes' : 'NO'})`);
	}
	return {
		version: 1,
		repo: opts.repo ?? null,
		harvestedAt: new Date().toISOString(),
		markers: { a: markerA, b: markerB },
		authors: { a: opts.authorA ?? null, b: opts.authorB ?? null },
		names: { a: opts.nameA ?? 'reviewer-a', b: opts.nameB ?? 'reviewer-b' },
		prs,
	};
}

// ---------------------------------------------------------------------------------------------
// parsing findings out of a comment
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const SEVERITY_ALIASES = {
	critical: 'critical', error: 'critical', blocker: 'critical', high: 'critical',
	warning: 'warning', warn: 'warning', major: 'warning', medium: 'warning',
	info: 'info', minor: 'info', low: 'info', nit: 'info', note: 'info',
};

export function normalizeSeverity(s) {
	if (typeof s !== 'string') return 'info';
	return SEVERITY_ALIASES[s.trim().toLowerCase()] ?? 'info';
}

/** Remove HTML comments to a fixed point (one non-greedy pass can leave a reconstructed `<!--`). */
function stripHtmlComments(s) {
	let out = s;
	let prev;
	do {
		prev = out;
		out = out.replace(/<!--[\s\S]*?--!?>/g, '');
	} while (out !== prev);
	return out;
}

/** Last fenced ```json block: from the LAST opener to the LAST closing fence (tolerates ``` inside strings). */
function lastFencedJson(text) {
	const open = text.lastIndexOf('```json');
	if (open === -1) return null;
	const start = open + '```json'.length;
	const close = text.lastIndexOf('```');
	if (close <= start) return null;
	return text.slice(start, close).trim() || null;
}

function lastDataComment(text) {
	let last = null;
	for (const m of text.matchAll(/<!--\s*review-data\s+([\s\S]*?)\s*--!?>/g)) last = m[1];
	return last;
}

const SHA_KEYS = ['sha', 'commit', 'headSha', 'reviewedSha'];

function normalizeLine(v) {
	if (v === undefined || v === null || v === '') return undefined;
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function normalizeFinding(f, i) {
	if (!f || typeof f !== 'object' || typeof f.file !== 'string' || !f.file.trim()) {
		throw new Error(`finding #${i} has no "file"`);
	}
	return {
		file: f.file.trim().replace(/^\.\//, ''),
		line: normalizeLine(f.line),
		severity: normalizeSeverity(f.severity),
		category: typeof f.category === 'string' && f.category ? f.category.toLowerCase() : undefined,
		title: typeof f.title === 'string' ? f.title.trim() : '',
		unconfirmed: f.unconfirmed === true,
		verifierReason: typeof f.verifierReason === 'string' ? f.verifierReason : undefined,
	};
}

/** A path-like token with an optional :line. Requires an extension or a directory separator. */
const LOC_RE = /((?:[\w@.~+-]+\/)*[\w@.~+-]+\.[A-Za-z][A-Za-z0-9]{0,7}|(?:[\w@.~+-]+\/)+[\w@.~+-]+)(?::(\d+))?/;

function parseListLine(raw) {
	const bullet = raw.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
	if (!bullet) return null;
	let rest = bullet[1];
	const sev = rest.match(/\[\s*(critical|error|blocker|high|warning|warn|major|medium|info|minor|low|nit|note)\b[^\]]*\]/i);
	if (!sev) return null;
	const unconfirmed = /unconfirmed/i.test(sev[0]);
	rest = rest.replace(sev[0], ' ');

	let category;
	const cat = rest.match(/_\(([^)]*)\)_/);
	if (cat) {
		category = cat[1].split(',')[0].trim().toLowerCase() || undefined;
		rest = rest.replace(cat[0], ' ');
	}

	// Prefer a backticked location, then a bare one.
	let loc = null;
	for (const m of rest.matchAll(/`([^`]+)`/g)) {
		const inner = m[1].match(new RegExp(`^${LOC_RE.source}$`));
		if (inner) { loc = { text: m[0], file: inner[1], line: inner[2] }; break; }
	}
	if (!loc) {
		// Bare tokens: accept only what is unmistakably a path (has a line, a directory, or a 2+ letter
		// extension), so prose such as "e.g." or "and/or" is not read as a file.
		const bareRe = new RegExp(`(?:^|[\\s(])${LOC_RE.source}(?=$|[\\s),.;—–-])`, 'g');
		for (const m of rest.matchAll(bareRe)) {
			const ext = m[1].includes('.') ? m[1].slice(m[1].lastIndexOf('.') + 1) : '';
			if (m[2] || (m[1].includes('/') && !/^and\/or$|^\w\/\w$/i.test(m[1])) || ext.length >= 2) {
				loc = { text: m[0].trim(), file: m[1], line: m[2] };
				break;
			}
		}
	}
	if (!loc) return null;
	rest = rest.replace(loc.text, ' ');

	const title = rest
		.replace(/\*\*|__/g, ' ')
		.replace(/`/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[\s—–:-]+|[\s—–:-]+$/g, '')
		.trim();
	return normalizeFinding(
		{ file: loc.file, line: loc.line, severity: sev[1], category, title, unconfirmed },
		0,
	);
}

/**
 * Parse one review comment. Never throws: a malformed comment comes back with `error` set and
 * `findings: []`, and the scorer excludes it (a broken parse is not "no findings").
 * Returns { findings, sha, costUsd, format: 'json'|'list'|'none', error, unparseable }.
 */
export function parseReviewComment(body) {
	const result = { findings: [], sha: null, costUsd: null, format: 'none', error: null, unparseable: false };
	const text = String(body ?? '');
	const prose = stripHtmlComments(text);

	// 1) machine block: data comment first, else last fenced json.
	let block = lastDataComment(text);
	let blockKind = 'data comment';
	if (block === null) {
		block = lastFencedJson(text);
		blockKind = 'json block';
	}
	if (block !== null) {
		let parsed;
		try {
			parsed = JSON.parse(block);
		} catch (e) {
			// An unrelated quoted snippet is not a findings block; anything that looks like one is an error.
			if (blockKind === 'data comment' || /"findings"|"severity"/.test(block)) {
				result.error = `${blockKind} is not valid JSON (${e.message})`;
				result.format = 'json';
				return result;
			}
			parsed = undefined;
		}
		if (parsed !== undefined) {
			const findings = Array.isArray(parsed) ? parsed : parsed?.findings;
			if (Array.isArray(findings)) {
				result.format = 'json';
				try {
					result.findings = findings.map(normalizeFinding);
				} catch (e) {
					result.findings = [];
					result.error = `${blockKind}: ${e.message}`;
					return result;
				}
				if (parsed && !Array.isArray(parsed)) {
					for (const k of SHA_KEYS) if (typeof parsed[k] === 'string' && parsed[k]) { result.sha = parsed[k]; break; }
					if (typeof parsed.costUsd === 'number' && Number.isFinite(parsed.costUsd)) result.costUsd = parsed.costUsd;
				}
			} else if (blockKind === 'data comment') {
				result.error = 'data comment has no "findings" array';
				result.format = 'json';
				return result;
			}
		}
	}

	// 2) fallback list.
	if (result.format !== 'json') {
		for (const line of prose.split('\n')) {
			const f = parseListLine(line);
			if (f) result.findings.push(f);
		}
		if (result.findings.length > 0) result.format = 'list';
		else if (/^\s*(?:[-*]|\d+[.)])\s.*\b(critical|warning|major|minor|error)\b/im.test(prose)) {
			// Severity-tagged bullets but nothing locatable: a parsing artifact, not a clean review.
			result.unparseable = true;
		}
	}

	if (!result.sha) {
		const m = prose.match(/\b(?:reviewed|covers?|commit|sha|head)\b[^\n]{0,40}?\b((?=[0-9a-f]*\d)[0-9a-f]{7,40})\b/i);
		if (m) result.sha = m[1];
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set([
	'a', 'an', 'the', 'of', 'in', 'on', 'to', 'is', 'are', 'be', 'for', 'and', 'or', 'not', 'no',
	'when', 'with', 'this', 'that', 'it', 'as', 'by', 'at', 'from', 'can', 'may', 'does', 'do',
]);

export function titleTokens(title) {
	return String(title ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.split(' ')
		.filter((t) => t && !STOPWORDS.has(t))
		.map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Jaccard similarity of normalized title tokens; null when either side has no title (a wildcard). */
export function titleSimilarity(a, b) {
	const ta = new Set(titleTokens(a));
	const tb = new Set(titleTokens(b));
	if (ta.size === 0 || tb.size === 0) return null;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter += 1;
	return inter / (ta.size + tb.size - inter);
}

/** Same path, tolerating one side citing a shorter repo-relative suffix. */
export function sameFile(a, b) {
	if (a === b) return true;
	return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function findingKey(f) {
	const slug = titleTokens(f.title).slice(0, 5).join('-') || 'untitled';
	return `${f.file}:${f.line ?? ''}:${slug}`;
}

/**
 * Greedy 1:1 matching, best pairs first. A pair matches when the files agree, the lines are within
 * `lineTolerance` (a missing line on either side is a wildcard) and the normalized title similarity
 * reaches `minTitleSimilarity` (a missing title is a wildcard; 0 disables the title criterion).
 */
export function matchFindings(as, bs, { lineTolerance = 3, minTitleSimilarity = 0.25 } = {}) {
	const candidates = [];
	as.forEach((a, i) => {
		bs.forEach((b, j) => {
			if (!sameFile(a.file, b.file)) return;
			let lineDistance = 0;
			if (a.line !== undefined && b.line !== undefined) {
				lineDistance = Math.abs(a.line - b.line);
				if (lineDistance > lineTolerance) return;
			}
			const sim = titleSimilarity(a.title, b.title);
			if (sim !== null && sim < minTitleSimilarity) return;
			candidates.push({ i, j, sim: sim ?? 0, lineDistance });
		});
	});
	candidates.sort((x, y) => y.sim - x.sim || x.lineDistance - y.lineDistance || x.i - y.i || x.j - y.j);
	const usedA = new Set();
	const usedB = new Set();
	const both = [];
	for (const c of candidates) {
		if (usedA.has(c.i) || usedB.has(c.j)) continue;
		usedA.add(c.i);
		usedB.add(c.j);
		both.push({ a: as[c.i], b: bs[c.j], similarity: c.sim, lineDistance: c.lineDistance });
	}
	return {
		both,
		aOnly: as.filter((_, i) => !usedA.has(i)),
		bOnly: bs.filter((_, j) => !usedB.has(j)),
	};
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

const VERDICTS = {
	'true-positive': 'tp', tp: 'tp', true: 'tp', real: 'tp',
	'false-positive': 'fp', fp: 'fp', false: 'fp',
	unsure: 'unsure',
};

/** Parse the operator label file: a JSON array of {prId, findingKey, verdict, reviewer?}. */
export function parseLabels(json) {
	if (!Array.isArray(json)) throw new Error('label file must be a JSON array of {prId, findingKey, verdict}');
	return json.map((l, i) => {
		const prId = Number(String(l?.prId ?? '').replace(/^#/, ''));
		const verdict = VERDICTS[String(l?.verdict ?? '').toLowerCase()];
		if (!Number.isInteger(prId) || typeof l?.findingKey !== 'string' || !l.findingKey) {
			throw new Error(`label #${i}: needs a numeric prId and a findingKey`);
		}
		if (!verdict) throw new Error(`label #${i}: verdict must be true-positive, false-positive or unsure (got "${l?.verdict}")`);
		const reviewer = l.reviewer === undefined ? null : String(l.reviewer).toLowerCase();
		if (reviewer !== null && reviewer !== 'a' && reviewer !== 'b') throw new Error(`label #${i}: reviewer must be "a" or "b"`);
		return { prId, findingKey: l.findingKey, verdict, reviewer };
	});
}

// ---------------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------------

function shaMatches(x, y) {
	if (!x || !y) return false;
	const a = x.toLowerCase();
	const b = y.toLowerCase();
	return a.startsWith(b) || b.startsWith(a);
}

function shaStatus(sha, head) {
	if (!sha) return 'unnamed';
	if (!head) return 'unknown-head';
	return shaMatches(sha, head) ? 'current' : 'stale';
}

function withKeys(findings) {
	const seen = new Map();
	return findings.map((f) => {
		let key = findingKey(f);
		const n = (seen.get(key) ?? 0) + 1;
		seen.set(key, n);
		if (n > 1) key = `${key}#${n}`;
		return { ...f, key };
	});
}

/** Score one harvested PR entry. */
export function scorePr(entry, opts = {}) {
	const minRank = SEVERITY_RANK[opts.minSeverity ?? 'info'] ?? 0;
	const out = {
		pr: entry.pr,
		title: entry.title ?? '',
		url: entry.url ?? null,
		headSha: entry.headSha ?? null,
		paired: Boolean(entry.a && entry.b),
		scoreable: false,
		excluded: null,
		warnings: [],
		shaA: null, shaB: null, shaStatusA: null, shaStatusB: null,
		costA: null, costB: null,
		a: [], b: [], both: [], aOnly: [], bOnly: [],
		divergent: false,
	};
	if (!out.paired) {
		out.excluded = `unpaired: no reviewer-${[!entry.a && 'a', !entry.b && 'b'].filter(Boolean).join(' or reviewer-')} comment`;
		return out;
	}
	const pa = parseReviewComment(entry.a.body);
	const pb = parseReviewComment(entry.b.body);
	out.shaA = pa.sha; out.shaB = pb.sha;
	out.shaStatusA = shaStatus(pa.sha, entry.headSha);
	out.shaStatusB = shaStatus(pb.sha, entry.headSha);
	out.costA = pa.costUsd; out.costB = pb.costUsd;
	for (const [side, p] of [['a', pa], ['b', pb]]) {
		if (p.error) { out.excluded = `reviewer-${side} comment unparseable: ${p.error}`; }
		else if (p.unparseable) { out.excluded = `reviewer-${side} comment lists severity-tagged items with no file locations (score manually)`; }
	}
	if (out.excluded) return out;

	for (const [side, st, p] of [['a', out.shaStatusA, pa], ['b', out.shaStatusB, pb]]) {
		if (st === 'stale') out.warnings.push(`reviewer-${side} names ${p.sha}, not the PR head ${entry.headSha}`);
		if (st === 'unnamed') out.warnings.push(`reviewer-${side} does not name the commit it reviewed`);
	}
	if (out.shaStatusA === 'current' && out.shaStatusB === 'current') { /* same code */ }
	else if (pa.sha && pb.sha && !shaMatches(pa.sha, pb.sha)) out.warnings.push('the two reviewers covered different commits');
	if (opts.strictSha && (out.shaStatusA === 'stale' || out.shaStatusB === 'stale' || (pa.sha && pb.sha && !shaMatches(pa.sha, pb.sha)))) {
		out.excluded = 'stale review (strict SHA mode)';
		return out;
	}

	const keep = (f) => (SEVERITY_RANK[f.severity] ?? 0) >= minRank;
	out.a = withKeys(pa.findings.filter(keep));
	out.b = withKeys(pb.findings.filter(keep));
	const m = matchFindings(out.a, out.b, opts);
	out.both = m.both;
	out.aOnly = m.aOnly;
	out.bOnly = m.bOnly;
	out.scoreable = true;
	out.divergent = m.aOnly.length + m.bOnly.length > 0;
	return out;
}

const ratio = (n, d) => (d > 0 ? n / d : null);

/** Score a whole harvest. `labels` is the parsed label array (or []). */
export function scoreAll(golden, labels = [], opts = {}) {
	const entries = Array.isArray(golden) ? golden : golden.prs;
	const names = { a: 'reviewer-a', b: 'reviewer-b', ...(golden.names ?? {}), ...(opts.names ?? {}) };
	const scores = entries.map((e) => scorePr(e, opts));

	// Resolve labels: own key, then the matched partner's key. Any label may name either reviewer.
	const labelIndex = new Map(); // `${pr}\0${key}` -> [{verdict, reviewer, used}]
	for (const l of labels) {
		const k = `${l.prId}\0${l.findingKey}`;
		if (!labelIndex.has(k)) labelIndex.set(k, []);
		labelIndex.get(k).push({ ...l, used: false });
	}
	const lookup = (pr, side, key) => {
		const hits = (labelIndex.get(`${pr}\0${key}`) ?? []).filter((l) => l.reviewer === null || l.reviewer === side);
		hits.forEach((h) => { h.used = true; });
		const decisive = hits.find((h) => h.verdict !== 'unsure');
		return decisive ? decisive.verdict : null;
	};
	const stats = {
		a: { name: names.a, total: 0, unique: 0, tp: 0, fp: 0, uniqueTp: 0, uniqueFp: 0, demoted: 0, demotedTp: 0, cost: null, runsWithCost: 0 },
		b: { name: names.b, total: 0, unique: 0, tp: 0, fp: 0, uniqueTp: 0, uniqueFp: 0, demoted: 0, demotedTp: 0, cost: null, runsWithCost: 0 },
	};
	const tally = (side, f, verdict, unique) => {
		const s = stats[side];
		s.total += 1;
		if (unique) s.unique += 1;
		if (f.unconfirmed) s.demoted += 1;
		if (verdict === 'tp') { s.tp += 1; if (unique) s.uniqueTp += 1; if (f.unconfirmed) s.demotedTp += 1; }
		if (verdict === 'fp') { s.fp += 1; if (unique) s.uniqueFp += 1; }
		f.verdict = verdict;
	};
	for (const sc of scores) {
		if (!sc.scoreable) continue;
		for (const { a, b } of sc.both) {
			const va = lookup(sc.pr, 'a', a.key);
			const vb = lookup(sc.pr, 'b', b.key);
			const v = va ?? vb;
			tally('a', a, v, false);
			tally('b', b, v, false);
		}
		for (const a of sc.aOnly) tally('a', a, lookup(sc.pr, 'a', a.key), true);
		for (const b of sc.bOnly) tally('b', b, lookup(sc.pr, 'b', b.key), true);
		for (const [side, c] of [['a', sc.costA], ['b', sc.costB]]) {
			if (c !== null) { stats[side].cost = (stats[side].cost ?? 0) + c; stats[side].runsWithCost += 1; }
		}
	}
	for (const s of Object.values(stats)) {
		s.precision = ratio(s.tp, s.tp + s.fp);
		s.labelled = s.tp + s.fp;
		s.labelCoverage = ratio(s.labelled, s.total);
		s.costPerUsefulFinding = s.cost !== null && s.tp > 0 ? s.cost / s.tp : null;
	}

	const scoreable = scores.filter((s) => s.scoreable);
	const both = scoreable.reduce((n, s) => n + s.both.length, 0);
	const totalA = stats.a.total;
	const totalB = stats.b.total;
	const unusedLabels = [...labelIndex.values()].flat().filter((l) => !l.used);
	const summary = {
		harvested: scores.length,
		paired: scores.filter((s) => s.paired).length,
		scoreable: scoreable.length,
		excluded: scores.filter((s) => s.paired && !s.scoreable).length,
		divergent: scoreable.filter((s) => s.divergent).length,
		agreeingPrs: scoreable.filter((s) => !s.divergent).length,
		both,
		overlap: ratio(both, totalA + totalB - both), // Jaccard over findings
		aFindingsAlsoInB: ratio(both, totalA),
		bFindingsAlsoInA: ratio(both, totalB),
	};
	return { names, options: { lineTolerance: opts.lineTolerance ?? 3, minTitleSimilarity: opts.minTitleSimilarity ?? 0.25, minSeverity: opts.minSeverity ?? 'info', strictSha: Boolean(opts.strictSha) }, summary, reviewers: stats, prs: scores, unusedLabels: unusedLabels.map(({ prId, findingKey: k, verdict, reviewer }) => ({ prId, findingKey: k, verdict, reviewer })) };
}

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const usd = (x) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(2)}`);
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;');

function fmtFinding(f) {
	const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
	const flags = f.unconfirmed ? ' (demoted by verifier)' : '';
	const verdict = f.verdict ? ` — labelled ${f.verdict === 'tp' ? 'true positive' : 'false positive'}` : '';
	return `[${f.severity}] \`${loc}\` ${md(f.title) || '(no title)'}${flags}${verdict}\n  key: \`${f.key}\``;
}

export function renderMarkdown(report) {
	const { names, summary: s, reviewers: r } = report;
	const L = [];
	L.push('# Review bake-off report', '');
	L.push(
		`${s.harvested} PRs harvested, ${s.paired} paired (both reviewers commented), ${s.scoreable} scoreable, ` +
			`${s.excluded} excluded, ${s.divergent} divergent. Matching: same file, lines within ±${report.options.lineTolerance}, ` +
			`title similarity ≥ ${report.options.minTitleSimilarity}; severity ≥ ${report.options.minSeverity}` +
			`${report.options.strictSha ? '; strict SHA' : ''}.`,
		'',
	);
	L.push('## Agreement', '');
	L.push(`- Findings found by both: **${s.both}** (overlap ${pct(s.overlap)} of the union)`);
	L.push(`- ${names.a} findings also raised by ${names.b}: ${pct(s.aFindingsAlsoInB)}`);
	L.push(`- ${names.b} findings also raised by ${names.a}: ${pct(s.bFindingsAlsoInA)}`);
	L.push(`- PRs where the reviewers agree exactly: ${s.agreeingPrs} of ${s.scoreable}`, '');

	L.push('## Reviewers', '');
	L.push(`| | ${md(names.a)} | ${md(names.b)} |`, '| --- | --- | --- |');
	const row = (label, f) => L.push(`| ${label} | ${f(r.a)} | ${f(r.b)} |`);
	row('Findings', (x) => x.total);
	row('Unique (not raised by the other)', (x) => x.unique);
	row('Labelled true positive', (x) => x.tp);
	row('Labelled false positive', (x) => x.fp);
	row('Precision (labelled)', (x) => `${pct(x.precision)}${x.labelled ? ` (n=${x.labelled})` : ''}`);
	row('Label coverage', (x) => pct(x.labelCoverage));
	row('Unique true positives', (x) => x.uniqueTp);
	row('Unique false positives', (x) => x.uniqueFp);
	row('Demoted by verifier', (x) => x.demoted);
	row('Demoted but labelled true positive', (x) => x.demotedTp);
	row('Cost (reviews that report it)', (x) => (x.cost === null ? 'n/a' : `${usd(x.cost)} over ${x.runsWithCost} run(s)`));
	row('Cost per useful finding', (x) => usd(x.costPerUsefulFinding));
	L.push('');
	if (r.a.labelled + r.b.labelled === 0) {
		L.push('_No operator labels supplied: precision and cost per useful finding are n/a. Label the findings in the adjudication queue below (`--labels`)._', '');
	}

	L.push('## Adjudication queue (divergent PRs)', '');
	const divergent = report.prs.filter((p) => p.divergent);
	if (divergent.length === 0) L.push('_none: every scoreable PR agrees_', '');
	for (const p of divergent) {
		L.push(`### PR #${p.pr} ${md(p.title)}`, '');
		if (p.aOnly.length) { L.push(`**${md(names.a)} only** (real, or a false positive?)`); p.aOnly.forEach((f) => L.push(`- ${fmtFinding(f)}`)); L.push(''); }
		if (p.bOnly.length) { L.push(`**${md(names.b)} only** (real, or a false positive?)`); p.bOnly.forEach((f) => L.push(`- ${fmtFinding(f)}`)); L.push(''); }
	}

	const agreed = report.prs.filter((p) => p.both.length > 0);
	if (agreed.length > 0) {
		L.push('## Raised by both reviewers', '');
		L.push('_A label on either key covers the pair. Labelling these too keeps precision from being computed on disagreements alone._', '');
		for (const p of agreed) {
			L.push(`**PR #${p.pr}**`);
			p.both.forEach((m) => L.push(`- ${fmtFinding(m.a)}${m.b.key === m.a.key ? '' : `\n  ${md(names.b)} key: \`${m.b.key}\``}`));
			L.push('');
		}
	}

	L.push('## Per PR', '');
	L.push(`| PR | status | ${md(names.a)} | ${md(names.b)} | both | ${md(names.a)} only | ${md(names.b)} only |`, '| --- | --- | --- | --- | --- | --- | --- |');
	for (const p of report.prs) {
		const status = p.scoreable ? (p.divergent ? 'divergent' : 'agree') : p.paired ? 'excluded' : 'unpaired';
		L.push(`| #${p.pr} | ${status} | ${p.a.length} | ${p.b.length} | ${p.both.length} | ${p.aOnly.length} | ${p.bOnly.length} |`);
	}
	L.push('');

	const notes = [];
	for (const p of report.prs) {
		if (p.paired && !p.scoreable) notes.push(`#${p.pr} excluded: ${p.excluded}`);
		for (const w of p.warnings) notes.push(`#${p.pr}: ${w}`);
	}
	for (const l of report.unusedLabels) notes.push(`label for PR ${l.prId} key "${l.findingKey}" matched no finding (typo, or that PR was excluded)`);
	if (notes.length) { L.push('## Warnings', ''); notes.forEach((n) => L.push(`- ${md(n)}`)); L.push(''); }
	return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  review-bakeoff.mjs harvest --repo owner/repo (--since YYYY-MM-DD [--until YYYY-MM-DD] | --prs 1,2,3)
      [--limit N] [--marker-a M] [--marker-b M] [--author-a LOGIN] [--author-b LOGIN]
      [--name-a NAME] [--name-b NAME] [--out golden.json]
  review-bakeoff.mjs score <golden.json> [--labels labels.json] [--line-tolerance N]
      [--min-title-similarity X] [--min-severity info|warning|critical] [--strict-sha]
      [--name-a NAME] [--name-b NAME] [--md report.md] [--json report.json] [--format md|json]
`;

class UsageError extends Error {}

export async function main(argv, { gh = defaultGh, stdout = process.stdout, stderr = process.stderr } = {}) {
	const [cmd, ...rest] = argv;
	const log = (m) => stderr.write(`${m}\n`);
	if (!cmd || cmd === '-h' || cmd === '--help') { stdout.write(USAGE); return cmd ? 0 : 2; }
	let parsed;
	try {
		parsed = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, prs: { type: 'string' },
				limit: { type: 'string' }, out: { type: 'string' },
				'marker-a': { type: 'string' }, 'marker-b': { type: 'string' },
				'author-a': { type: 'string' }, 'author-b': { type: 'string' },
				'name-a': { type: 'string' }, 'name-b': { type: 'string' },
				labels: { type: 'string' }, 'line-tolerance': { type: 'string' }, 'min-title-similarity': { type: 'string' },
				'min-severity': { type: 'string' }, 'strict-sha': { type: 'boolean' },
				md: { type: 'string' }, json: { type: 'string' }, format: { type: 'string' },
			},
		});
	} catch (e) {
		log(`review-bakeoff: ${e.message}\n${USAGE}`);
		return 2;
	}
	const v = parsed.values;
	const num = (name, x, def) => {
		if (x === undefined) return def;
		const n = Number(x);
		if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
		return n;
	};
	try {
		if (cmd === 'harvest') {
			const prs = v.prs ? v.prs.split(',').map((x) => Number(x.trim().replace(/^#/, ''))) : undefined;
			if (prs && prs.some((n) => !Number.isInteger(n) || n <= 0)) throw new UsageError('--prs must be a comma-separated list of PR numbers');
			if (!prs && !v.since && !v.until) throw new UsageError('give --since/--until or --prs');
			if (prs && (v.since || v.until)) throw new UsageError('give exactly one of --prs or --since/--until');
			const golden = await harvest(
				{
					repo: v.repo, prs, since: v.since, until: v.until, limit: v.limit ? num('limit', v.limit) : undefined,
					markerA: v['marker-a'], markerB: v['marker-b'], authorA: v['author-a'], authorB: v['author-b'],
					nameA: v['name-a'], nameB: v['name-b'],
				},
				{ gh, log },
			);
			const text = `${JSON.stringify(golden, null, 2)}\n`;
			if (v.out) writeFileSync(v.out, text);
			else stdout.write(text);
			const n = golden.prs;
			log(`${n.length} PRs: ${n.filter((p) => p.a).length} with marker A, ${n.filter((p) => p.b).length} with marker B, ${n.filter((p) => p.a && p.b).length} paired.`);
			return 0;
		}
		if (cmd === 'score') {
			if (parsed.positionals.length !== 1) throw new UsageError('score takes exactly one harvest file');
			const format = v.format ?? 'md';
			if (format !== 'md' && format !== 'json') throw new UsageError('--format must be md or json');
			const minSeverity = v['min-severity'] ?? 'info';
			if (!Object.hasOwn(SEVERITY_RANK, minSeverity)) throw new UsageError('--min-severity must be info, warning or critical');
			const golden = JSON.parse(readFileSync(parsed.positionals[0], 'utf8'));
			const labels = v.labels ? parseLabels(JSON.parse(readFileSync(v.labels, 'utf8'))) : [];
			const names = {};
			if (v['name-a']) names.a = v['name-a'];
			if (v['name-b']) names.b = v['name-b'];
			const report = scoreAll(golden, labels, {
				lineTolerance: num('line-tolerance', v['line-tolerance'], 3),
				minTitleSimilarity: num('min-title-similarity', v['min-title-similarity'], 0.25),
				minSeverity, strictSha: v['strict-sha'] === true, names,
			});
			const markdown = renderMarkdown(report);
			if (v.md) writeFileSync(v.md, `${markdown}\n`);
			if (v.json) writeFileSync(v.json, `${JSON.stringify(report, null, 2)}\n`);
			stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${markdown}\n`);
			return 0;
		}
		throw new UsageError(`unknown command "${cmd}"`);
	} catch (e) {
		if (e instanceof UsageError) { log(`review-bakeoff: ${e.message}\n${USAGE}`); return 2; }
		log(`review-bakeoff: ${e.message}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
