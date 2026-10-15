// Tests for harvest-findings.mjs — run by `node --test core/scripts/harvest-findings.test.mjs`.
// No network: every gh/git-touching function takes an injected function; the CLI test (`run`
// without --apply) never reaches the real `openProposalPr`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	aggregateFamilies,
	buildMarkerMatchers,
	DEFAULT_MARKER_RE,
	extractFromJournalText,
	extractFromPr,
	familyKey,
	fetchPr,
	harvest,
	isMarkerBody,
	main,
	openProposalPr,
	parseFindingAcks,
	renderLessonProposal,
	renderProposal,
	resolvePrNumbers,
} from './harvest-findings.mjs';

const MARKER = '<!-- local-review-findings -->';

function markerComment(findings, extra = {}) {
	return `${MARKER}\n### Findings\n\n\`\`\`json\n${JSON.stringify({ findings, ...extra }, null, 2)}\n\`\`\`\n`;
}

const F = (file, title, overrides = {}) => ({ file, title, severity: 'warning', line: 10, ...overrides });

describe('DEFAULT_MARKER_RE / buildMarkerMatchers / isMarkerBody', () => {
	test('matches a leading *-findings or *-review HTML-comment marker', () => {
		for (const m of ['<!-- cr-cli-findings -->', '<!-- local-review-findings -->', '<!-- samuel-review -->']) {
			assert.ok(DEFAULT_MARKER_RE.test(m), `expected ${m} to match`);
		}
	});

	test('does not match a marker that merely mentions findings/review mid-word, or appears later in the body', () => {
		assert.ok(!DEFAULT_MARKER_RE.test('some prose mentioning <!-- cr-cli-findings --> later'));
		assert.ok(!DEFAULT_MARKER_RE.test('<!-- review-a -->')); // bake-off marker, not this grammar
	});

	test('isMarkerBody never matches via includes() on a comment that only mentions the marker', () => {
		const matchers = buildMarkerMatchers({});
		assert.ok(!isMarkerBody('I saw <!-- cr-cli-findings --> in the other PR', matchers));
		assert.ok(isMarkerBody(`${MARKER}\nactual findings here`, matchers));
	});

	test('config.review_markers adds extra literal markers', () => {
		const matchers = buildMarkerMatchers({ review_markers: ['<!-- custom-marker -->'] });
		assert.ok(isMarkerBody('<!-- custom-marker -->\nbody', matchers));
	});
});

describe('parseFindingAcks', () => {
	test('parses id, outcome, and evidence', () => {
		const acks = parseFindingAcks('FINDING-ACK: F1 -> fixed — added a null check\nFINDING-ACK: F2 -> disputed — not a real bug\n');
		assert.deepEqual(acks, [
			{ id: 'F1', outcome: 'fixed', evidence: 'added a null check' },
			{ id: 'F2', outcome: 'disputed', evidence: 'not a real bug' },
		]);
	});

	test('accepts the unicode arrow too', () => {
		const acks = parseFindingAcks('FINDING-ACK: F1 → deferred — tracked in #99');
		assert.equal(acks[0].outcome, 'deferred');
	});

	test('no FINDING-ACK lines yields []', () => {
		assert.deepEqual(parseFindingAcks('nothing to see here'), []);
	});
});

describe('familyKey / aggregateFamilies', () => {
	test('two findings in the same file with similar titles land in one family', () => {
		const a = F('src/x.ts', 'missing null check on user input');
		const b = F('src/x.ts', 'missing null check on request body');
		assert.equal(familyKey(a).split('::')[0], familyKey(b).split('::')[0]);
	});

	test('drops a family seen in fewer than minRecurrence distinct PRs', () => {
		const records = [{ finding: F('a.ts', 'missing null check'), prNumber: 1, outcome: 'fixed' }];
		assert.deepEqual(aggregateFamilies(records, { minRecurrence: 2 }), []);
	});

	test('keeps and ranks a family recurring across distinct PRs, unresolved-first', () => {
		const records = [
			{ finding: F('a.ts', 'missing null check'), prNumber: 1, outcome: 'fixed' },
			{ finding: F('a.ts', 'missing null check'), prNumber: 2, outcome: 'unresolved' },
			{ finding: F('b.ts', 'wrong unique index'), prNumber: 1, outcome: 'fixed' },
			{ finding: F('b.ts', 'wrong unique index'), prNumber: 3, outcome: 'fixed' },
		];
		const families = aggregateFamilies(records, { minRecurrence: 2 });
		assert.equal(families.length, 2);
		assert.equal(families[0].file, 'a.ts'); // has an unresolved occurrence -> ranks first
		assert.equal(families[0].distinctSources, 2);
		assert.equal(families[0].unresolvedCount, 1);
	});

	test('counts distinct PRs, not raw record count, toward recurrence', () => {
		const records = [
			{ finding: F('a.ts', 'missing null check'), prNumber: 1, outcome: 'fixed' },
			{ finding: F('a.ts', 'missing null check guard'), prNumber: 1, outcome: 'fixed' }, // same PR, same family
		];
		assert.deepEqual(aggregateFamilies(records, { minRecurrence: 2 }), []);
	});
});

describe('extractFromPr', () => {
	const matchers = buildMarkerMatchers({});

	test('extracts findings from a marker comment and resolves FINDING-ACK outcomes by Fn id', () => {
		const pr = {
			number: 42,
			url: 'https://example/pr/42',
			comments: [
				{ body: markerComment([{ file: 'a.ts', title: 'missing null check', severity: 'warning' }, { file: 'b.ts', title: 'off by one', severity: 'critical' }]) },
				{ body: 'FINDING-ACK: F1 -> fixed — added guard\nFINDING-ACK: F2 -> disputed — intentional' },
			],
			reviews: [],
		};
		const records = extractFromPr(pr, matchers);
		assert.equal(records.length, 2);
		assert.equal(records[0].outcome, 'fixed');
		assert.equal(records[1].outcome, 'disputed');
		assert.equal(records[0].prNumber, 42);
	});

	test('an unacked finding stays outcome: null — ids are resolved individually, never guessed from a count', () => {
		const pr = {
			number: 1,
			comments: [
				{ body: markerComment([{ file: 'a.ts', title: 'x' }, { file: 'b.ts', title: 'y' }]) },
				{ body: 'FINDING-ACK: F1 -> fixed — only F1 is acked here' },
			],
			reviews: [],
		};
		const records = extractFromPr(pr, matchers);
		assert.equal(records[0].outcome, 'fixed'); // F1 -> findings[0]
		assert.equal(records[1].outcome, null); // no F2 ack posted
	});

	test('two review rounds each restarting at F1 do not cross-contaminate (windowed by comment time)', () => {
		const pr = {
			number: 2,
			comments: [
				{ createdAt: '2026-01-01T00:00:00Z', body: markerComment([{ file: 'a.ts', title: 'round one issue' }]) },
				{ createdAt: '2026-01-01T01:00:00Z', body: 'FINDING-ACK: F1 -> fixed — round one fix' },
				{ createdAt: '2026-01-02T00:00:00Z', body: markerComment([{ file: 'b.ts', title: 'round two issue' }]) },
				{ createdAt: '2026-01-02T01:00:00Z', body: 'FINDING-ACK: F1 -> disputed — round two is a false positive' },
			],
			reviews: [],
		};
		const records = extractFromPr(pr, matchers);
		assert.equal(records.find((r) => r.finding.file === 'a.ts').outcome, 'fixed');
		assert.equal(records.find((r) => r.finding.file === 'b.ts').outcome, 'disputed');
	});

	test('a comment that merely mentions the marker in prose contributes no records', () => {
		const pr = { number: 1, comments: [{ body: `I think ${MARKER} needs updating` }], reviews: [] };
		assert.deepEqual(extractFromPr(pr, matchers), []);
	});

	test('inline review-thread comments become one-finding records anchored at path:line', () => {
		const pr = {
			number: 7,
			comments: [],
			reviews: [],
			reviewThreads: [{ path: 'src/y.ts', line: 12, body: 'this leaks a secret in the log line', html_url: 'https://example/pr/7#r1' }],
		};
		const records = extractFromPr(pr, matchers);
		assert.equal(records.length, 1);
		assert.equal(records[0].finding.file, 'src/y.ts');
		assert.equal(records[0].finding.line, 12);
		assert.equal(records[0].source, 'review_thread');
	});
});

describe('extractFromJournalText', () => {
	test('pulls findings out of a marker paragraph inside free-form journal text', () => {
		const matchers = buildMarkerMatchers({});
		const text = `## Bounce log\n\nsome narrative text\n\n${markerComment([{ file: 'c.ts', title: 'race condition' }])}\n\nmore narrative`;
		const records = extractFromJournalText(text, matchers, { source: 'journal:test.md' });
		assert.equal(records.length, 1);
		assert.equal(records[0].finding.file, 'c.ts');
		assert.equal(records[0].source, 'journal:test.md');
	});

	test('narrative text with no marker paragraph yields []', () => {
		const matchers = buildMarkerMatchers({});
		assert.deepEqual(extractFromJournalText('just narrative, no markers anywhere', matchers), []);
	});
});

describe('renderLessonProposal / renderProposal', () => {
	const family = {
		key: 'a.ts::missing-null-check',
		file: 'a.ts',
		title: 'missing null check',
		distinctSources: 3,
		unresolvedCount: 1,
		outcomes: { fixed: 2, unresolved: 1 },
		examples: [{ finding: { file: 'a.ts', line: 10 }, prNumber: 1, url: 'https://x/1' }],
	};

	test('renders schema-conformant frontmatter (docs/memory-spec.md §2)', () => {
		const text = renderLessonProposal(family);
		assert.match(text, /^---\nglobs: \[\]\nstacks: \[\]\nroles: \[\]\nkeywords: \[.*\]\nsecurity: false\nsupersedes: \[\]\n---\n/);
	});

	test('renderProposal says "nothing proposed" for an empty family list, never fabricates one', () => {
		assert.match(renderProposal([]), /No family recurred/);
	});

	test('renderProposal includes every family and its occurrence count', () => {
		const md = renderProposal([family], { repo: 'o/r' });
		assert.match(md, /missing null check/);
		assert.match(md, /3x, 1 unresolved/);
	});
});

describe('harvest (injected gh) and resolvePrNumbers', () => {
	test('resolvePrNumbers returns the explicit list unchanged (covers a standalone single-issue PR)', async () => {
		const numbers = await resolvePrNumbers({ prs: [99] }, { gh: async () => { throw new Error('must not be called'); } });
		assert.deepEqual(numbers, [99]);
	});

	test('resolvePrNumbers searches merged PRs by date range when no explicit list is given', async () => {
		const calls = [];
		const gh = async (args) => { calls.push(args); return JSON.stringify([{ number: 5 }, { number: 6 }]); };
		const numbers = await resolvePrNumbers({ since: '2026-01-01' }, { gh });
		assert.deepEqual(numbers, [5, 6]);
		assert.ok(calls[0].includes('merged:>=2026-01-01'));
	});

	test('fetchPr degrades gracefully when the inline-comments call fails', async () => {
		const gh = async (args) => {
			if (args[0] === 'pr') return JSON.stringify({ number: 1, title: 't', url: 'u', comments: [], reviews: [] });
			throw new Error('api down');
		};
		const pr = await fetchPr(1, { repo: 'o/r' }, { gh });
		assert.deepEqual(pr.reviewThreads, []);
	});

	test('harvest aggregates records across PRs and journal files without ever shelling out for real', async () => {
		const calls = [];
		const gh = async (args) => {
			calls.push(args);
			if (args.includes('list')) return JSON.stringify([{ number: 1 }]);
			if (args[0] === 'pr') return JSON.stringify({ number: 1, title: 't', url: 'u', comments: [{ body: markerComment([{ file: 'a.ts', title: 'x' }]) }], reviews: [] });
			return JSON.stringify([]);
		};
		const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
		try {
			const journal = join(dir, 'journal-2026-10.md');
			writeFileSync(journal, markerComment([{ file: 'a.ts', title: 'x' }]));
			const { records, prsHarvested } = await harvest({ prs: [1], journalPaths: [journal] }, { gh });
			assert.deepEqual(prsHarvested, [1]);
			assert.equal(records.length, 2); // one from the PR, one from the journal
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('openProposalPr — never touches the default branch, everything injected', () => {
	test('checks out a fresh branch, writes proposal files, commits, pushes, and opens a draft PR', async () => {
		const gitCalls = [];
		const ghCalls = [];
		const dir = mkdtempSync(join(tmpdir(), 'harvest-pr-'));
		try {
			const family = { key: 'a.ts::x', file: 'a.ts', title: 'x', distinctSources: 2, unresolvedCount: 0, outcomes: {}, examples: [] };
			const result = await openProposalPr(
				[family],
				{ cwd: dir, repo: 'o/r', branch: 'agent/memory-harvest-test' },
				{
					git: async (args) => { gitCalls.push(args); return ''; },
					gh: async (args) => { ghCalls.push(args); return 'https://github.com/o/r/pull/123\n'; },
					now: () => 1234,
				},
			);
			assert.equal(result.branch, 'agent/memory-harvest-test');
			assert.equal(result.prUrl, 'https://github.com/o/r/pull/123');
			assert.ok(gitCalls.some((c) => c[0] === 'fetch' && c.includes('origin') && c.includes('main')), 'fetches the default branch before branching from it');
			assert.ok(gitCalls.some((c) => c[0] === 'checkout' && c[1] === '-b' && c.includes('agent/memory-harvest-test') && c.includes('origin/main')), 'branches from origin/main with -b, never -B');
			assert.ok(gitCalls.some((c) => c[0] === 'commit'));
			assert.ok(gitCalls.some((c) => c[0] === 'push'));
			// "Never touches the default branch" means never checked out ONTO main/master itself —
			// fetching/branching FROM origin/main (above) is exactly how that's avoided, not something
			// to forbid; what's actually forbidden is a plain `checkout main` / `checkout -B main`.
			assert.ok(!gitCalls.some((c) => c[0] === 'checkout' && (c.includes('main') || c.includes('master')) && c[1] !== '-b'), 'must never check out onto the default branch itself');
			assert.ok(ghCalls.some((c) => c[0] === 'pr' && c.includes('--draft')), 'the PR must be opened as a draft');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('CLI', () => {
	test('`run` without --apply prints the proposal and never calls git/gh for a write', async () => {
		let gitCalled = false;
		const gh = async (args) => {
			if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 1 }, { number: 2 }]);
			if (args[0] === 'pr' && args[1] === 'view') {
				return JSON.stringify({
					number: Number(args[2]), title: 't', url: 'u',
					comments: [{ body: markerComment([{ file: 'a.ts', title: 'repeat offender' }]) }],
					reviews: [],
				});
			}
			return JSON.stringify([]);
		};
		const git = async () => { gitCalled = true; return ''; };
		const lines = [];
		await main(['run', '--since', '2026-01-01'], { gh, git, out: (s) => lines.push(s), err: () => {}, cwd: process.cwd() });
		assert.ok(!gitCalled, 'run without --apply must never write');
		assert.ok(lines.join('\n').includes('repeat offender'));
	});

	test('an unknown command exits 1 with an error, not a crash', async () => {
		const code = await main(['bogus'], { err: () => {}, out: () => {} });
		assert.equal(code, 1);
	});
});
