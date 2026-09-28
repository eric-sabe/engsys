// Tests for review-bakeoff.mjs — run by `node --test core/scripts/review-bakeoff.test.mjs`.
// No network: functions take an injected `gh`, and the CLI tests put a stub `gh` first on PATH.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	findMarkerComments,
	findingKey,
	harvest,
	main,
	matchFindings,
	parseLabels,
	parseReviewComment,
	renderMarkdown,
	scoreAll,
	scorePr,
	titleSimilarity,
} from './review-bakeoff.mjs';

const SCRIPT = fileURLToPath(new URL('./review-bakeoff.mjs', import.meta.url));
const MA = '<!-- review-a -->';
const MB = '<!-- review-b -->';

// ---- fixture comments -------------------------------------------------------------------------

const jsonBlock = (o) => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

/** Reviewer A: fenced JSON block, names its commit, reports cost. */
const commentA = (findings, extra = {}) =>
	`${MA}\n### Reviewer A\n\n2 findings\n\n${jsonBlock({ sha: 'aaaaaaa1111', costUsd: 0.4, findings, ...extra })}\n`;

/** Reviewer B: the plain bullet list, in the rendered (bold + backtick) shape. */
const commentBList = (lines, sha = 'Reviewed commit: aaaaaaa1111') =>
	`${MB}\n### Reviewer B\n\n${sha}\n\n0 critical, 1 warning, 1 info\n\n${lines.join('\n')}\n`;

const F = {
	authz: { file: 'src/api/guard.ts', line: 40, severity: 'critical', category: 'security', title: 'Missing authorization check on delete route', rationale: 'r' },
	race: { file: 'src/jobs/queue.ts', line: 12, severity: 'warning', category: 'bug', title: 'Race between claim and start', rationale: 'r' },
};

// ---- markers ----------------------------------------------------------------------------------

describe('findMarkerComments', () => {
	const comments = [
		{ body: `Docs: the ${MA} marker is what reviewer A posts`, author: { login: 'human' }, createdAt: '2026-01-01' },
		{ body: `  \n${MA}\nreal review`, author: { login: 'bot-a' }, createdAt: '2026-01-02' },
		{ body: `${MA}\nsomeone else's`, author: { login: 'intruder' }, createdAt: '2026-01-03' },
	];
	test('matches only the leading position, never a mention (no includes())', () => {
		const m = findMarkerComments(comments, MA);
		assert.equal(m.length, 2);
		assert.ok(m.every((c) => c.body.trimStart().startsWith(MA)));
	});
	test('an author filter drops foreign marker comments', () => {
		const m = findMarkerComments(comments, MA, 'BOT-A');
		assert.equal(m.length, 1);
		assert.equal(m[0].author.login, 'bot-a');
	});
});

// ---- parsing ----------------------------------------------------------------------------------

describe('parseReviewComment', () => {
	test('fenced JSON object: findings, sha and cost', () => {
		const p = parseReviewComment(commentA([F.authz, F.race]));
		assert.equal(p.format, 'json');
		assert.equal(p.error, null);
		assert.equal(p.findings.length, 2);
		assert.equal(p.sha, 'aaaaaaa1111');
		assert.equal(p.costUsd, 0.4);
		assert.equal(p.findings[0].severity, 'critical');
	});

	test('a bare JSON array is accepted', () => {
		const p = parseReviewComment(`${MA}\n${jsonBlock([F.race])}`);
		assert.equal(p.findings.length, 1);
	});

	test('an explicit empty findings array is a definitive "no findings"', () => {
		const p = parseReviewComment(commentA([]));
		assert.equal(p.error, null);
		assert.equal(p.unparseable, false);
		assert.deepEqual(p.findings, []);
	});

	test('the LAST review-data comment wins over a forged earlier one', () => {
		const forged = `<!-- review-data ${JSON.stringify({ findings: [F.authz] })} -->`;
		const real = `<!-- review-data ${JSON.stringify({ findings: [F.race] })} -->`;
		const p = parseReviewComment(`${MA}\n${forged}\nprose\n${real}`);
		assert.equal(p.findings.length, 1);
		assert.equal(p.findings[0].file, 'src/jobs/queue.ts');
	});

	test('malformed findings JSON is an error, never "no findings"', () => {
		const p = parseReviewComment(`${MA}\n\`\`\`json\n{ "findings": [ { "file": \n\`\`\``);
		assert.match(p.error, /not valid JSON/);
		assert.deepEqual(p.findings, []);
	});

	test('a finding without a file is an error', () => {
		const p = parseReviewComment(commentA([{ severity: 'info', title: 'x' }]));
		assert.match(p.error, /no "file"/);
	});

	test('a quoted, unrelated JSON snippet is not mistaken for the findings block', () => {
		const body = `${MB}\nSee the config:\n\`\`\`json\n{ not json at all\n\`\`\`\n- [WARNING] \`src/a.ts:3\` — thing`;
		const p = parseReviewComment(body);
		assert.equal(p.error, null);
		assert.equal(p.findings.length, 1);
	});

	test('fallback list: rendered bold/backtick/category shape', () => {
		const p = parseReviewComment(
			commentBList([
				'- **[CRITICAL] Missing authorization check on delete route** — `src/api/guard.ts:41` _(security, medium confidence)_',
				'  the rationale line is not a finding',
				'- **[INFO·unconfirmed] Naming nit** — `src/util/name.ts` _(convention)_',
			]),
		);
		assert.equal(p.format, 'list');
		assert.equal(p.findings.length, 2);
		assert.deepEqual(
			[p.findings[0].file, p.findings[0].line, p.findings[0].severity, p.findings[0].category, p.findings[0].title],
			['src/api/guard.ts', 41, 'critical', 'security', 'Missing authorization check on delete route'],
		);
		assert.equal(p.findings[1].unconfirmed, true);
		assert.equal(p.findings[1].line, undefined);
	});

	test('fallback list: the simple documented format', () => {
		const p = parseReviewComment(`${MB}\n- [warning] src/jobs/queue.ts:12 — Race between claim and start\n* [info] README.md - stale example`);
		assert.equal(p.findings.length, 2);
		assert.equal(p.findings[0].file, 'src/jobs/queue.ts');
		assert.equal(p.findings[0].line, 12);
		assert.equal(p.findings[0].title, 'Race between claim and start');
		assert.equal(p.findings[1].file, 'README.md');
	});

	test('prose such as "e.g." and "and/or" is not read as a file', () => {
		const p = parseReviewComment(`${MB}\n- [warning] Validate input and/or escape it, e.g. in \`src/a.ts:9\``);
		assert.equal(p.findings[0].file, 'src/a.ts');
	});

	test('a severity-count header on a clean review is NOT unparseable', () => {
		const p = parseReviewComment(`${MB}\n### Reviewer B\n\n**0 critical, 0 warning, 0 info**\n\nNo findings.`);
		assert.equal(p.unparseable, false);
		assert.deepEqual(p.findings, []);
	});

	test('severity-tagged bullets with no locations are flagged unparseable', () => {
		const p = parseReviewComment(`${MB}\n- Critical: the retry loop is unbounded\n- Warning: naming`);
		assert.equal(p.unparseable, true);
		assert.deepEqual(p.findings, []);
	});

	test('the reviewed SHA is read from prose, and hex-looking words are not SHAs', () => {
		assert.equal(parseReviewComment(`${MB}\nReviewed commit: 1a2b3c4d5e\n`).sha, '1a2b3c4d5e');
		assert.equal(parseReviewComment(`${MB}\nThe reviewed code defaced nothing\n`).sha, null);
	});
});

// ---- matching ---------------------------------------------------------------------------------

describe('matching', () => {
	const f = (file, line, title) => ({ file, line, title, severity: 'warning' });

	test('title similarity is normalized and null (wildcard) when a title is missing', () => {
		assert.ok(titleSimilarity('Missing authorization check on delete route', 'missing authorization checks in the delete route') > 0.6);
		assert.equal(titleSimilarity('', 'anything'), null);
		assert.ok(titleSimilarity('null deref in parser', 'unbounded retry loop') < 0.1);
	});

	test('matches on file + line tolerance + title similarity', () => {
		const m = matchFindings(
			[f('src/a.ts', 10, 'Missing null check on user')],
			[f('src/a.ts', 12, 'null check missing for user')],
		);
		assert.equal(m.both.length, 1);
	});

	test('a line outside the tolerance does not match; the tolerance is configurable', () => {
		const a = [f('src/a.ts', 10, 'Missing null check')];
		const b = [f('src/a.ts', 20, 'Missing null check')];
		assert.equal(matchFindings(a, b).both.length, 0);
		assert.equal(matchFindings(a, b, { lineTolerance: 10 }).both.length, 1);
	});

	test('the same place with an unrelated title is two findings; similarity 0 disables the criterion', () => {
		const a = [f('src/a.ts', 10, 'SQL injection in query builder')];
		const b = [f('src/a.ts', 10, 'variable naming inconsistent')];
		assert.equal(matchFindings(a, b).both.length, 0);
		assert.equal(matchFindings(a, b, { minTitleSimilarity: 0 }).both.length, 1);
	});

	test('a missing line is a wildcard, and a shorter path suffix still matches', () => {
		const m = matchFindings([f('packages/x/src/a.ts', undefined, 'Missing null check')], [f('src/a.ts', 99, 'Missing null check')]);
		assert.equal(m.both.length, 1);
	});

	test('matching is 1:1 and picks the best partner first', () => {
		const a = [f('src/a.ts', 10, 'Missing null check on user'), f('src/a.ts', 11, 'Missing null check on user id')];
		const b = [f('src/a.ts', 11, 'Missing null check on user id')];
		const m = matchFindings(a, b);
		assert.equal(m.both.length, 1);
		assert.equal(m.both[0].a.line, 11);
		assert.equal(m.aOnly.length, 1);
		assert.equal(m.bOnly.length, 0);
	});
});

// ---- scoring ----------------------------------------------------------------------------------

const entry = (over = {}) => ({
	pr: 101,
	title: 'Add delete route',
	headSha: 'aaaaaaa1111222233334444',
	a: { body: commentA([F.authz, F.race]) },
	b: {
		body: commentBList([
			'- **[CRITICAL] Authorization check missing on delete route** — `src/api/guard.ts:42` _(security)_',
			'- **[INFO] Unused import** — `src/api/guard.ts:1` _(convention)_',
		]),
	},
	...over,
});

describe('scorePr', () => {
	test('splits findings into both / a-only / b-only', () => {
		const s = scorePr(entry());
		assert.equal(s.scoreable, true);
		assert.equal(s.both.length, 1);
		assert.equal(s.aOnly.length, 1);
		assert.equal(s.aOnly[0].file, 'src/jobs/queue.ts');
		assert.equal(s.bOnly.length, 1);
		assert.equal(s.divergent, true);
		assert.equal(s.costA, 0.4);
	});

	test('an unpaired PR is not scoreable', () => {
		const s = scorePr(entry({ b: null }));
		assert.equal(s.paired, false);
		assert.equal(s.scoreable, false);
	});

	test('an unparseable comment excludes the PR instead of reading as "no findings"', () => {
		const s = scorePr(entry({ a: { body: `${MA}\n\`\`\`json\n{"findings": [ oops\n\`\`\`` } }));
		assert.equal(s.scoreable, false);
		assert.match(s.excluded, /reviewer-a comment unparseable/);
	});

	test('a review naming a non-head SHA warns, and strict mode excludes it', () => {
		const stale = entry({ headSha: 'bbbbbbb9999' });
		const lenient = scorePr(stale);
		assert.equal(lenient.scoreable, true);
		assert.ok(lenient.warnings.some((w) => /not the PR head/.test(w)));
		const strict = scorePr(stale, { strictSha: true });
		assert.equal(strict.scoreable, false);
		assert.match(strict.excluded, /stale/);
	});

	test('a short SHA prefix counts as the head', () => {
		const s = scorePr(entry({ headSha: 'aaaaaaa1111222233334444' }), { strictSha: true });
		assert.equal(s.shaStatusA, 'current');
		assert.equal(s.shaStatusB, 'current');
	});

	test('min severity drops low-severity findings before matching', () => {
		const s = scorePr(entry(), { minSeverity: 'warning' });
		assert.equal(s.bOnly.length, 0);
	});
});

describe('scoreAll with operator labels', () => {
	const golden = { names: { a: 'gate', b: 'candidate' }, prs: [entry(), entry({ pr: 102, a: null }), entry({ pr: 103 })] };
	const s0 = scorePr(entry());
	const race = s0.aOnly[0].key;
	const unused = s0.bOnly[0].key;
	const both = s0.both[0].a.key;

	const labels = parseLabels([
		{ prId: 101, findingKey: race, verdict: 'true-positive' },
		{ prId: '#101', findingKey: unused, verdict: 'false-positive' },
		{ prId: 101, findingKey: both, verdict: 'tp' },
		{ prId: 103, findingKey: race, verdict: 'fp' },
		{ prId: 999, findingKey: 'no/such.ts:1:x', verdict: 'tp' },
	]);
	const report = scoreAll(golden, labels);

	test('summary counts and overlap', () => {
		assert.equal(report.summary.harvested, 3);
		assert.equal(report.summary.paired, 2);
		assert.equal(report.summary.scoreable, 2);
		assert.equal(report.summary.both, 2);
		assert.equal(report.names.a, 'gate');
		assert.ok(Math.abs(report.summary.overlap - 2 / 6) < 1e-9);
	});

	test('per-reviewer unique findings, precision and unique true positives', () => {
		const { a, b } = report.reviewers;
		assert.equal(a.total, 4);
		assert.equal(a.unique, 2);
		assert.equal(b.unique, 2);
		// a: matched authz (tp), race pr101 (tp), race pr103 (fp), matched authz pr103 (unlabelled)
		assert.equal(a.tp, 2);
		assert.equal(a.fp, 1);
		assert.ok(Math.abs(a.precision - 2 / 3) < 1e-9);
		assert.equal(a.uniqueTp, 1);
		// b: matched authz on pr101 inherits the pair's label; the unused-import is fp.
		assert.equal(b.tp, 1);
		assert.equal(b.fp, 1);
		assert.equal(b.precision, 0.5);
	});

	test('cost per useful finding = cost / labelled true positives', () => {
		const { a, b } = report.reviewers;
		assert.ok(Math.abs(a.cost - 0.8) < 1e-9);
		assert.ok(Math.abs(a.costPerUsefulFinding - 0.4) < 1e-9);
		assert.equal(b.cost, null);
		assert.equal(b.costPerUsefulFinding, null);
	});

	test('a label matching no finding is reported', () => {
		assert.equal(report.unusedLabels.length, 1);
		assert.equal(report.unusedLabels[0].prId, 999);
	});

	test('without labels, precision is null (never 0)', () => {
		const r = scoreAll(golden, []);
		assert.equal(r.reviewers.a.precision, null);
		assert.equal(r.reviewers.a.costPerUsefulFinding, null);
	});

	test('demoted findings stay in the data; a demoted true positive is counted as a verifier error', () => {
		const demoted = { ...F.race, severity: 'info', unconfirmed: true, verifierReason: 'guard at x:1' };
		const g = [{
			pr: 7, title: 't', headSha: 'aaaaaaa1111',
			a: { body: commentA([demoted]) },
			b: { body: `${MB}\nReviewed commit: aaaaaaa1111\n\n_no findings_\n` },
		}];
		const key = scorePr(g[0]).aOnly[0].key;
		const r = scoreAll(g, parseLabels([{ prId: 7, findingKey: key, verdict: 'real' }]));
		assert.equal(r.reviewers.a.total, 1);
		assert.equal(r.reviewers.a.demoted, 1);
		assert.equal(r.reviewers.a.demotedTp, 1);
	});

	test('markdown report carries the queue, keys and warnings', () => {
		const text = renderMarkdown(report);
		assert.match(text, /# Review bake-off report/);
		assert.match(text, /Adjudication queue/);
		assert.match(text, /Raised by both reviewers/);
		assert.ok(text.includes(`key: \`${both}\``));
		assert.ok(text.includes(`key: \`${race}\``));
		assert.match(text, /\| #102 \| unpaired \|/);
		assert.match(text, /matched no finding/);
		assert.match(text, /\| Precision \(labelled\) \| 67% \(n=3\) \| 50% \(n=2\) \|/);
	});

	test('findingKey is stable and file:line:title-slug shaped', () => {
		assert.equal(findingKey(F.authz), 'src/api/guard.ts:40:missing-authorization-check-delete-route');
	});
});

describe('parseLabels', () => {
	test('rejects a bad verdict loudly', () => {
		assert.throws(() => parseLabels([{ prId: 1, findingKey: 'k', verdict: 'maybe' }]), /verdict must be/);
	});
	test('rejects a non-array', () => {
		assert.throws(() => parseLabels({}), /JSON array/);
	});
});

// ---- harvest (injected gh) --------------------------------------------------------------------

function fakeGh(prs, calls = []) {
	return async (args) => {
		calls.push(args);
		if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(Object.keys(prs).map((n) => ({ number: Number(n) })));
		if (args[0] === 'pr' && args[1] === 'view') {
			const n = args[2];
			if (!prs[n]) throw Object.assign(new Error('boom'), { stderr: `no PR ${n}` });
			return JSON.stringify(prs[n]);
		}
		throw new Error(`unexpected gh call: ${args.join(' ')}`);
	};
}

const view = (number, comments) => ({
	number, title: `PR ${number}`, url: `https://example.test/pr/${number}`, state: 'MERGED',
	mergedAt: '2026-09-10T00:00:00Z', headRefOid: 'aaaaaaa1111222233334444', mergeCommit: { oid: 'ccc' }, comments,
});
const cm = (login, body, createdAt) => ({ author: { login }, body, createdAt, url: `https://example.test/c/${createdAt}` });

describe('harvest', () => {
	const prs = {
		101: view(101, [
			cm('human', `Note: reviewer A posts ${MA} on every PR`, '2026-09-01T00:00:00Z'),
			cm('bot-a', `${MA}\nold`, '2026-09-02T00:00:00Z'),
			cm('bot-a', `${MA}\nnew`, '2026-09-03T00:00:00Z'),
			cm('bot-b', `${MB}\nb`, '2026-09-03T00:00:00Z'),
		]),
		102: view(102, [cm('bot-a', `${MA}\nonly a`, '2026-09-03T00:00:00Z')]),
	};

	test('collects the latest marker-A and marker-B comment with author and head SHA', async () => {
		const calls = [];
		const g = await harvest({ repo: 'acme/app', since: '2026-09-01', until: '2026-09-28', markerA: MA, markerB: MB }, { gh: fakeGh(prs, calls) });
		assert.deepEqual(calls[0].slice(0, 6), ['pr', 'list', '--repo', 'acme/app', '--state', 'merged']);
		assert.ok(calls[0].includes('merged:2026-09-01..2026-09-28'));
		assert.equal(g.prs.length, 2);
		const p = g.prs[0];
		assert.equal(p.headSha, 'aaaaaaa1111222233334444');
		assert.equal(p.mergeCommit, 'ccc');
		assert.equal(p.a.body, `${MA}\nnew`);
		assert.equal(p.a.count, 2);
		assert.equal(p.a.author, 'bot-a');
		assert.equal(p.b.author, 'bot-b');
		assert.equal(g.prs[1].b, null);
		assert.deepEqual(g.markers, { a: MA, b: MB });
	});

	test('an explicit PR list skips the search, and an author filter excludes foreign comments', async () => {
		const calls = [];
		const g = await harvest({ repo: 'acme/app', prs: [101], authorA: 'someone-else' }, { gh: fakeGh(prs, calls) });
		assert.ok(calls.every((c) => c[1] === 'view'));
		assert.equal(g.prs[0].a, null);
		assert.ok(g.prs[0].b);
	});

	test('default markers are the neutral review-a / review-b', async () => {
		const g = await harvest({ prs: [101] }, { gh: fakeGh(prs) });
		assert.deepEqual(g.markers, { a: '<!-- review-a -->', b: '<!-- review-b -->' });
		assert.ok(g.prs[0].a);
	});

	test('a gh failure is fatal and names the PR', async () => {
		await assert.rejects(harvest({ prs: [555] }, { gh: fakeGh(prs) }), /reading PR #555.*no PR 555/);
	});

	test('option validation', async () => {
		await assert.rejects(harvest({}, { gh: fakeGh(prs) }), /exactly one of/);
		await assert.rejects(harvest({ since: 'yesterday' }, { gh: fakeGh(prs) }), /invalid date/);
		await assert.rejects(harvest({ prs: [1], markerA: MA, markerB: MA }, { gh: fakeGh(prs) }), /must differ/);
	});
});

// ---- CLI (stub gh on PATH) --------------------------------------------------------------------

describe('cli', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bakeoff-test-'));
	process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

	const prData = {
		201: view(201, [
			cm('bot-a', commentA([F.authz, F.race]), '2026-09-03T00:00:00Z'),
			cm('bot-b', commentBList(['- **[CRITICAL] Authorization check missing on delete route** — `src/api/guard.ts:42` _(security)_']), '2026-09-03T00:00:01Z'),
		]),
	};
	writeFileSync(join(dir, 'prs.json'), JSON.stringify(prData));
	mkdirSyncBin();
	function mkdirSyncBin() {
		const bin = join(dir, 'bin');
		execFileSync('mkdir', ['-p', bin]);
		writeFileSync(
			join(bin, 'gh'),
			`#!/usr/bin/env node
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'prs.json'))}, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') { console.log(JSON.stringify(Object.keys(data).map((n) => ({ number: +n })))); }
else if (a[0] === 'pr' && a[1] === 'view') { console.log(JSON.stringify(data[a[2]])); }
else { console.error('unexpected: ' + a.join(' ')); process.exit(1); }
`,
		);
		chmodSync(join(bin, 'gh'), 0o755);
	}
	const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
	const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

	test('harvest then score end to end, with a label file and both outputs', () => {
		const golden = join(dir, 'golden.json');
		run('harvest', '--repo', 'acme/app', '--since', '2026-09-01', '--out', golden);
		const g = JSON.parse(readFileSync(golden, 'utf8'));
		assert.equal(g.prs.length, 1);
		assert.ok(g.prs[0].a && g.prs[0].b);

		const key = scorePr(g.prs[0]).aOnly[0].key;
		const labels = join(dir, 'labels.json');
		writeFileSync(labels, JSON.stringify([{ prId: 201, findingKey: key, verdict: 'true-positive' }]));
		const mdOut = join(dir, 'report.md');
		const jsonOut = join(dir, 'report.json');
		const stdout = run('score', golden, '--labels', labels, '--md', mdOut, '--json', jsonOut, '--name-a', 'gate', '--name-b', 'candidate');
		assert.match(stdout, /# Review bake-off report/);
		assert.match(readFileSync(mdOut, 'utf8'), /candidate/);
		const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
		assert.equal(report.summary.both, 1);
		assert.equal(report.reviewers.a.uniqueTp, 1);

		const asJson = JSON.parse(run('score', golden, '--format', 'json'));
		assert.equal(asJson.summary.scoreable, 1);
	});

	test('usage errors exit 2', async () => {
		const sink = { write() {} };
		assert.equal(await main([], { stdout: sink, stderr: sink }), 2);
		assert.equal(await main(['bogus'], { stdout: sink, stderr: sink }), 2);
		assert.equal(await main(['score'], { stdout: sink, stderr: sink }), 2);
		assert.equal(await main(['harvest', '--prs', '1', '--since', '2026-01-01'], { stdout: sink, stderr: sink }), 2);
		assert.equal(await main(['score', 'x.json', '--min-severity', 'toString'], { stdout: sink, stderr: sink }), 2);
	});

	test('a runtime failure exits 1 (gh error) and never prints a partial harvest', async () => {
		let out = '';
		const code = await main(['harvest', '--prs', '999'], {
			gh: async () => { throw new Error('gh: HTTP 502'); },
			stdout: { write: (s) => { out += s; } },
			stderr: { write() {} },
		});
		assert.equal(code, 1);
		assert.equal(out, '');
	});
});
