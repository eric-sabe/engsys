// index-db.mjs — the memory index: a local, disposable SQLite FTS5 index over Class A sources
// (lessons, overlay, ADRs) and Class B events (synced GitHub history + monster journals), read by
// memory-brief.mjs. Design: docs/memory-spec.md §3.3 (storage) and §4 (index).
//
// Zero-dependency ESM, Node >= 20 — but `node:sqlite` itself requires Node >= 22.5 (FTS5 verified
// on 22.22, §12). EVERY public function here fails open (returns an empty/default result) rather
// than throwing: a broken index must never cost a subagent its dispatch, let alone block one.
//
// Public API:
//   resolveCacheDir(cwd?)                     -> `$(git rev-parse --git-common-dir)/engsys-memory`,
//                                                or null outside a git repo (fails open, never throws)
//   resolveClassARoots(repoRoot, opts?)        -> concrete { lessonsDir, overlayFile, agentLessonsDir,
//                                                adrDir } paths to scan (opts.pluginRoot overrides the
//                                                bundled-lessons lookup; see `core/.claude-plugin/`)
//   loadClassADocs(roots)                      -> Doc[] parsed from those roots (never throws; a
//                                                missing root or a malformed file is skipped, not fatal)
//   loadClassBEvents(cacheDir)                 -> Event[] from `<cacheDir>/delta.jsonl`, if present
//                                                (memory-sync, which populates it, ships in a later
//                                                phase; an absent/empty file is simply zero events)
//   computeWatermark(docs, events, version)    -> { version, files: {path: sha1}, eventCount } — the
//                                                staleness manifest (§4: directory mtimes are NOT used)
//   ensureIndex(opts)                          -> { db, path } | null — builds into a `.tmp-<pid>` file
//                                                and renames it into place IFF the watermark changed;
//                                                otherwise opens the existing index read-only. Safe
//                                                under concurrent callers (temp-file-then-rename).
//   queryIndex(db, { text, roles, globs, stacks, limit })  -> ranked Doc[] (BM25 + frontmatter boost)
//   closeIndex(db)                             -> best-effort close; never throws
//
// `opts.sqlite` (ensureIndex) and `opts.now`/`opts.fs` are injection points for tests — notably to
// simulate "node:sqlite is unavailable" without needing an actual Node build that lacks it (§13: "the
// index fails open when node:sqlite is missing").

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../../scripts/validate-lessons.mjs';
import { parseYaml } from '../yaml.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// core/lib/memory -> core (bundled lessons-library lives at core/lessons-library)
const CORE_DIR = path.resolve(HERE, '..', '..');

/** Sources an engine built from `docs()` carries, mirroring docs/memory-spec.md §3.3/§4. */
export const SOURCE_KIND = { LESSON: 'lesson', OVERLAY: 'overlay', ADR: 'adr', EVENT: 'event' };

// ---------------------------------------------------------------------------------------------
// Class B field validation (engsys#140 H2 — Nyx F2): a Class B event is attacker-influenceable
// text, whoever wrote it (docs/memory-spec.md §2), and SQLite's INTEGER/TEXT affinity does NOT
// enforce a column's intended shape — a `number`/`line` column happily stores an arbitrary
// string. Lives here (the lower-level module) rather than in memory-brief.mjs so BOTH choke
// points can use the exact same check without a circular import: this module's own insert path
// (`buildInto`, so a malformed row is never even written to the writable, M1-exploitable,
// index.sqlite) and memory-brief.mjs's `selectPointers`/`renderPointerLine` (the last line of
// defense before a value is interpolated into `additionalContext`). A field that fails
// validation DROPS THE WHOLE POINTER — except `line`, which is merely omitted, since a missing
// line number is a normal, harmless degradation `renderPointerLine` already handles.
// ---------------------------------------------------------------------------------------------

const KIND_ENUM = new Set(['pr', 'pr_review', 'review_thread', 'marker_finding', 'finding_ack', 'issue', 'issue_comment', 'commit', 'journal', 'event']);
const OUTCOME_ENUM = new Set(['fixed', 'unresolved', 'disputed', 'bounced', 'merged', 'none']);
/** Bare marker-name shape (no `<!-- -->`): exported so memory-brief.mjs's `allowedMarkerNames`
 * validates a configured marker string against the exact same charset this module enforces. */
export const MARKER_SHAPE_RE = /^[a-z0-9-]{1,40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UPDATED_AT_RE = /^\d{4}-\d{2}-\d{2}/;
const KEY_RE = /^[A-Za-z0-9:_./-]{1,80}$/;

/** The `key` allowlist alone, for a caller that only has a bare key string (e.g. the injection
 * log — engsys#140 Nyx F8), not a full event object to pass to `validatePointerEvent`. */
export function isValidPointerKey(key) {
	return typeof key === 'string' && KEY_RE.test(key);
}
// Deliberately an ALLOWLIST (not a denylist of control/bidi/zero-width/`<`/`>`/backtick): an
// allowlisted charset structurally excludes every one of those by construction, including
// obfuscations a denylist might miss (e.g. a right-to-left override hiding mid-path).
const PATHISH_RE = /^[A-Za-z0-9_./@+-]{1,200}$/;

function isSafePositiveInt(n) {
	return Number.isSafeInteger(n) && n > 0;
}

/**
 * Validate every field of a Class B event against its strict allowlist. Returns a (possibly
 * `line`-stripped) copy on success, or `null` to mean "drop this pointer entirely" — `null` is
 * the ONLY failure signal; this never throws, and never returns a partially-sanitized object for
 * a field it rejected (the whole event is rejected instead, except for `line`'s documented
 * omit-not-drop case). `opts.allowedMarkers` (a Set of bare marker names) is optional — when
 * omitted (as at this module's own insert-time call), only the marker's CHARSET is checked, not
 * instance-specific configured-marker membership (which needs config this module doesn't have).
 */
export function validatePointerEvent(event, { allowedMarkers } = {}) {
	if (!event || typeof event !== 'object') return null;
	const key = event.key ?? event.k;
	if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
	if (event.kind != null && !KIND_ENUM.has(event.kind)) return null;
	if (event.outcome != null && !OUTCOME_ENUM.has(event.outcome)) return null;
	if (event.marker != null) {
		if (!MARKER_SHAPE_RE.test(event.marker)) return null;
		if (allowedMarkers && !allowedMarkers.has(event.marker)) return null;
	}
	if (event.repo != null && !REPO_RE.test(event.repo)) return null;
	if (event.updated_at != null && !UPDATED_AT_RE.test(String(event.updated_at))) return null;
	if (event.path != null && !PATHISH_RE.test(event.path)) return null;
	if (event.symbol != null && !PATHISH_RE.test(event.symbol)) return null;
	if (event.number != null && !isSafePositiveInt(event.number)) return null;
	const line = event.line != null && isSafePositiveInt(event.line) ? event.line : null;
	return { ...event, key, line };
}

// ---------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------

/** `$(git rev-parse --git-common-dir)/engsys-memory`, absolute. Null outside a git repo or if git
 * is unavailable — callers treat null as "no cache; build in memory only / fail open". */
export function resolveCacheDir(cwd = process.cwd()) {
	try {
		const common = execFileSync(
			'git',
			['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
			{ encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		if (!common) return null;
		return path.join(common, 'engsys-memory');
	} catch {
		return null;
	}
}

/**
 * Concrete Class A roots to scan (docs/memory-spec.md §2's path allowlist), relative to `repoRoot`
 * (the project being worked on — NOT necessarily this engsys checkout).
 *
 *   - `docs/agent-lessons/**`                         project-local lessons (always; may not exist)
 *   - `.claude/workflows/briefs/project-brief-overlay.md`   the project's brief overlay (copy mode)
 *   - `docs/architecture/adr/**`                      ADRs (always; may not exist)
 *   - the bundled `lessons-library`: `opts.pluginRoot` (normally `process.env.CLAUDE_PLUGIN_ROOT`,
 *     set by Claude Code in plugin mode) if given and it has a `lessons-library/` child; otherwise
 *     resolved relative to THIS module (`core/lib/memory/../../lessons-library` = `core/lessons-library`)
 *     — which is correct both when memory-brief itself runs from inside an engsys checkout (dev /
 *     dogfood) and as the plugin-mode fallback when the env var isn't set for some reason. A
 *     copy-mode-installed consumer project has no `core/` at all; there, the seeded copy already
 *     lives under `docs/agent-lessons/library/**`, covered by the first bullet — this bullet
 *     resolves to a non-existent directory there and is silently skipped.
 */
/** True iff `p` exists and is (or resolves through) a symlink. Never throws — a path that
 * doesn't exist, or that errors on lstat, is NOT reported as a symlink (callers already treat
 * "doesn't exist" as absent via their own existsSync/readdir checks; this is only the extra
 * "don't trust a symlink" gate, engsys#140 H3 — Nyx F3). */
function isSymlink(p) {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

export function resolveClassARoots(repoRoot, opts = {}) {
	const pluginRoot = opts.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
	let lessonsDir = pluginRoot ? path.join(pluginRoot, 'lessons-library') : null;
	if (!lessonsDir || !fs.existsSync(lessonsDir) || isSymlink(lessonsDir)) {
		const fallback = path.join(CORE_DIR, 'lessons-library');
		if (fs.existsSync(fallback) && !isSymlink(fallback)) lessonsDir = fallback;
		else lessonsDir = null;
	}
	return {
		// The bundled library is read from disk (it's the plugin's OWN trusted content, never a
		// project's working tree) — but NEVER if the resolved root itself is a symlink.
		lessonsDir: lessonsDir && fs.existsSync(lessonsDir) && !isSymlink(lessonsDir) ? lessonsDir : null,
		overlayFile: path.join(repoRoot, '.claude', 'workflows', 'briefs', 'project-brief-overlay.md'),
		agentLessonsDir: path.join(repoRoot, 'docs', 'agent-lessons'),
		adrDir: path.join(repoRoot, 'docs', 'architecture', 'adr'),
	};
}

// ---------------------------------------------------------------------------------------------
// Class A loading
// ---------------------------------------------------------------------------------------------

function sha1(text) {
	return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function* walkMd(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (isSymlink(p)) continue; // engsys#140 H3 — never follow a symlinked file OR directory
		if (e.isDirectory()) yield* walkMd(p);
		else if (e.isFile() && e.name.endsWith('.md')) yield p;
	}
}

/** Strip control (C0/C1), bidi-override/formatting, and zero-width characters from `s` before it
 * is ever used as a rendered title or a derived key (engsys#140 H3 — Nyx F3): a crafted filename
 * or `# heading` committed to a branch is still attacker-influenceable text, even once it's read
 * from a REVIEWED ref. Uses the same Unicode property this repo's untrusted-data envelope
 * (core/lib/untrusted.mjs) strips for the identical reason. */
function stripControlAndBidi(s) {
	return String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
}

// ---------------------------------------------------------------------------------------------
// Reading PROJECT Class A content from the REVIEWED default branch, not the working tree
// (engsys#140 H3 — Nyx F3): an uncommitted or feature-branch-only lesson/overlay/ADR must never
// be injected with system authority before a human has actually reviewed it on the repo's own
// terms (a merge to its default branch). The bundled lessons-library is the one exception — it
// is the plugin's OWN content, not the project's working tree, so it's still read from disk
// (resolveClassARoots / loadMdDir above). `git ls-tree`/`git show` against a ref also sidesteps
// symlink-following entirely: a tree listing is independent of what the WORKING TREE's symlinks
// point at, and a git symlink entry (mode 120000) is detected and skipped explicitly below.
// ---------------------------------------------------------------------------------------------

/**
 * Resolve the project's reviewed-content commit ONCE, as a full SHA — never a short name like
 * `origin/main` anywhere downstream (engsys#140 N1 — Nyx re-review): a local tag or branch
 * literally named `origin/main` shadows the real remote-tracking ref, and `git fetch` of a fork
 * remote can auto-follow such a tag. `isReviewedOnDefaultBranch` and every git-tree/cat-file call
 * below take this SHA, never a ref name.
 *
 * Resolution order: `git symbolic-ref refs/remotes/origin/HEAD` (must itself resolve under
 * `refs/remotes/origin/`, or it's discarded) → `opts.defaultBranch` → `main`/`master` — each
 * candidate name is then pinned with `git rev-parse --verify --end-of-options
 * refs/remotes/origin/<name>^{commit}`, which refuses an ambiguous or non-remote-tracking name
 * outright rather than guessing. Returns `null` if nothing resolves. Never throws.
 *
 * SECURITY NOTE: a local attacker who can write `refs/remotes/origin/*` directly (not through a
 * normal `git fetch`) is out of scope — at that point they could fabricate the "reviewed" ref
 * itself. This function's job is only to stop a `tag`/`heads` namesake from shadowing it.
 */
export function resolveReviewedSha(repoRoot, { defaultBranch } = {}) {
	const names = [];
	try {
		const symref = execFileSync('git', ['-C', repoRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		const m = /^refs\/remotes\/origin\/(.+)$/.exec(symref);
		if (m) names.push(m[1]);
	} catch { /* fall through to the named candidates below */ }
	if (defaultBranch) names.push(defaultBranch);
	names.push('main', 'master');
	for (const name of [...new Set(names)]) {
		try {
			const sha = execFileSync(
				'git',
				['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${name}^{commit}`],
				{ encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
			).trim();
			if (/^[0-9a-f]{40}$/.test(sha)) return sha;
		} catch { /* try the next candidate */ }
	}
	return null;
}

/**
 * ONE `git ls-tree -r -z <sha> -- <relPaths...>` call covering every project Class A root at once
 * (engsys#140 P2/P3 — the per-file-read design this replaces took 2.25s on a 211-lesson corpus
 * and always blew the hook's 2s budget). `-z` NUL-delimits records so a path containing a literal
 * tab/newline can't desynchronize parsing. Returns every blob entry (type `blob`, ANY mode,
 * including 120000 symlinks — callers filter) as `{mode, blobSha, relPath}`. Never throws; an
 * unresolvable sha/path is simply zero entries.
 */
function listGitTree(repoRoot, sha, relPaths) {
	if (!sha || relPaths.length === 0) return [];
	let out;
	try {
		out = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '-z', sha, '--', ...relPaths], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return [];
	}
	const entries = [];
	for (const rec of out.split('\0')) {
		if (!rec) continue;
		const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(rec);
		if (!m) continue;
		const [, mode, type, blobSha, relPath] = m;
		if (type !== 'blob') continue;
		entries.push({ mode, blobSha, relPath });
	}
	return entries;
}

/**
 * Read every blob in `blobShas` through ONE `git cat-file --batch` process (engsys#140 P3) —
 * streams every sha to its stdin, then parses the length-prefixed `<sha> <type> <size>\n<content>\n`
 * (or `<sha> missing\n`) records out of stdout. Returns `Map<blobSha, string>`; a missing/unreadable
 * object is simply absent from the map. Never throws.
 */
function readBlobsBatch(repoRoot, blobShas) {
	const result = new Map();
	if (blobShas.length === 0) return result;
	let buf;
	try {
		// No `encoding` option at all — execFileSync's `encoding` must be a real Buffer encoding
		// name (there is no 'buffer' encoding; omitting it is how you get a raw Buffer back).
		buf = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
			input: blobShas.map((s) => `${s}\n`).join(''),
			timeout: 5000,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'ignore'],
		});
	} catch {
		return result;
	}
	let offset = 0;
	while (offset < buf.length) {
		const nl = buf.indexOf(0x0a, offset);
		if (nl === -1) break;
		const header = buf.slice(offset, nl).toString('utf8');
		const missing = /^([0-9a-f]+)\s+missing$/.exec(header);
		if (missing) { offset = nl + 1; continue; }
		const m = /^([0-9a-f]+)\s+(\S+)\s+(\d+)$/.exec(header);
		if (!m) break; // unparseable — stop rather than risk misreading the rest as content
		const [, sha, , sizeStr] = m;
		const size = Number(sizeStr);
		const contentStart = nl + 1;
		result.set(sha, buf.slice(contentStart, contentStart + size).toString('utf8'));
		offset = contentStart + size + 1; // +1 skips the single trailing \n git appends after content
	}
	return result;
}

/**
 * Load every project Class A doc (lessons, ADRs, the overlay) as of `sha` in ONE `ls-tree` call
 * (engsys#140 P3) plus ONE `cat-file --batch` read of every surviving blob — never a per-file
 * `git show`. `dirSpecs` is `[{relDir, kind, provenanceFor}]` for recursively-scanned directories;
 * `fileSpecs` is `[{relPath, kind}]` for single files (the overlay). A mode-120000 (symlink) tree
 * entry is dropped before its blob is ever read (engsys#140 H3) — the content it WOULD return is
 * the symlink's target string, not real content, and is never worth reading at all. Never throws.
 */
function loadProjectClassADocs(repoRoot, sha, dirSpecs, fileSpecs, docs, manifest) {
	if (!sha) return;
	const allPaths = [...dirSpecs.map((d) => d.relDir), ...fileSpecs.map((f) => f.relPath)];
	const entries = listGitTree(repoRoot, sha, allPaths);
	const wanted = [];
	for (const e of entries) {
		if (e.mode === '120000') continue; // never read a symlink's target string as content
		const dirSpec = dirSpecs.find((d) => e.relPath === d.relDir || e.relPath.startsWith(`${d.relDir}/`));
		if (dirSpec) {
			if (!e.relPath.endsWith('.md') || path.basename(e.relPath) === 'README.md') continue;
			wanted.push({ ...e, kind: dirSpec.kind, provenanceFor: dirSpec.provenanceFor, isSingle: false });
			continue;
		}
		const fileSpec = fileSpecs.find((f) => e.relPath === f.relPath);
		if (fileSpec) wanted.push({ ...e, kind: fileSpec.kind, provenanceFor: () => 'project-local', isSingle: true });
	}
	const blobs = readBlobsBatch(repoRoot, [...new Set(wanted.map((w) => w.blobSha))]);
	for (const w of wanted) {
		const text = blobs.get(w.blobSha);
		if (text === undefined) continue;
		const absPath = path.join(repoRoot, w.relPath);
		manifest[absPath] = w.blobSha; // the blob sha IS the content hash — no need to sha1() it again
		if (w.isSingle) {
			docs.push({
				key: `${w.kind}:${absPath}`,
				class: 'A',
				kind: w.kind,
				path: absPath,
				symbol: null,
				roles: [],
				globs: [],
				stacks: [],
				keywords: [],
				security: false,
				supersedes: [],
				title: stripControlAndBidi(path.basename(w.relPath, '.md')),
				body: text,
			});
			continue;
		}
		const { fm, body } = readFrontmatterSafe(text, w.relPath);
		if (fm === null) continue; // malformed frontmatter — skipped and logged, never fatal (engsys#140 P4)
		const titleMatch = /^#\s+(.+)$/m.exec(body);
		const slug = stripControlAndBidi(path.basename(w.relPath, '.md'));
		docs.push({
			key: `${w.kind}:${slug}`,
			class: 'A',
			kind: w.kind,
			path: absPath,
			symbol: null,
			roles: fm.roles,
			globs: fm.globs,
			stacks: fm.stacks,
			keywords: fm.keywords,
			security: fm.security === true,
			supersedes: fm.supersedes,
			title: stripControlAndBidi(titleMatch ? titleMatch[1] : slug),
			body,
			provenance: w.provenanceFor(w.relPath),
		});
	}
}

/** Parse a leading `---`-delimited YAML frontmatter block (flat scalars/lists only — the subset
 * every lesson/agent frontmatter in this repo uses). Exported for reuse by memory-brief.mjs (agent
 * `security: true` exclusion) and subagent-memory-inject.mjs tests. Never throws. */
export function readFrontmatter(text) {
	const { frontmatter, body } = splitFrontmatter(text);
	if (frontmatter === null) return { fm: {}, body: text };
	// Delegates to the SAME parser validate-lessons.mjs validates frontmatter with (lib/yaml.js's
	// parseYaml) — a hand-rolled `split(',')` here previously broke on a quoted list element that
	// itself contains a comma (e.g. a brace glob `"**/*.{ts,tsx}"`), silently storing a value the
	// validator would have accepted as-is. A malformed block degrades to {} rather than throwing.
	let fm;
	try { fm = parseYaml(frontmatter) ?? {}; } catch { fm = {}; }
	return { fm, body };
}

const ARRAY_FM_FIELDS = ['globs', 'stacks', 'roles', 'keywords', 'supersedes'];

/**
 * `readFrontmatter`, with every list field COERCED to an array (engsys#140 P4): a parser quirk
 * (a prettier-formatted multi-line flow sequence, or any other YAML shape this subset parser
 * doesn't fully handle) can still make a field come back as `{}` or a string instead of `[]` —
 * downstream code calls `.length`/`.includes`/`.some`/`.join` on these fields unconditionally,
 * and one malformed lesson among hundreds must degrade that ONE document, never abort the whole
 * index build (`rebuild-failures.jsonl` showing a `.join is not a function` crash on a real
 * 211-lesson corpus was the actual failure this fixes). `onSkipped(relPath, reason)` is called,
 * never thrown, if parsing the frontmatter block itself raises — the document is then skipped
 * entirely (not rendered with defaults, since its OTHER fields can't be trusted either).
 */
function readFrontmatterSafe(text, relPath, onSkipped = () => {}) {
	let fm;
	let body;
	try {
		({ fm, body } = readFrontmatter(text));
	} catch (e) {
		onSkipped(relPath, String(e?.message ?? e));
		return { fm: null, body: '' };
	}
	const coerced = { security: fm.security === true };
	for (const field of ARRAY_FM_FIELDS) coerced[field] = Array.isArray(fm[field]) ? fm[field] : [];
	return { fm: coerced, body };
}

/** Load every `.md` file under `dir` (recursively) as a Class A Doc, keyed `<kind>:<slug>` (slug =
 * basename without `.md` — stable across the bundled lessons-library, a project's
 * `docs/agent-lessons/`, and `docs/architecture/adr/`, so `supersedes` references resolve the same
 * way regardless of which root a lesson lives under). Skips README.md. Never throws. */
/**
 * How "official" a loaded doc's root is — used ONLY to decide which doc wins a KEY COLLISION when
 * one of the colliding docs is `security: true` (see loadClassADocs). Higher wins.
 *   bundled (3)       — the engsys lessons-library itself (plugin mode: read in place; dev/dogfood:
 *                        resolved relative to this module)
 *   seeded (2)         — a copy-mode project's seeded copy of that same library, conventionally
 *                        under `docs/agent-lessons/<seedSubdir>/` (default `library`, matching
 *                        `lessons.into` in engsys.config.yaml / lib/commands.js)
 *   project-local (1)  — anything else the project itself wrote under docs/agent-lessons/
 */
export const PROVENANCE_RANK = { bundled: 3, seeded: 2, 'project-local': 1, adr: 1, overlay: 1 };

function loadMdDir(dir, kind, docs, manifest, { provenanceFor = () => 'project-local' } = {}) {
	if (!dir) return;
	for (const file of walkMd(dir)) {
		if (path.basename(file) === 'README.md') continue;
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
		manifest[file] = sha1(text);
		const { fm, body } = readFrontmatterSafe(text, file);
		if (fm === null) continue; // malformed — skipped, not fatal to the whole build (engsys#140 P4)
		const titleMatch = /^#\s+(.+)$/m.exec(body);
		docs.push({
			key: `${kind}:${path.basename(file, '.md')}`,
			class: 'A',
			kind,
			path: file,
			symbol: null,
			roles: fm.roles,
			globs: fm.globs,
			stacks: fm.stacks,
			keywords: fm.keywords,
			security: fm.security,
			supersedes: fm.supersedes,
			title: stripControlAndBidi(titleMatch ? titleMatch[1] : path.basename(file, '.md')),
			body,
			provenance: provenanceFor(file),
		});
	}
}

/** Load a single Class A file (overlay or one ADR) if it exists. Never throws. */
function loadSingle(file, kind, docs, manifest) {
	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
	manifest[file] = sha1(text);
	docs.push({
		key: `${kind}:${file}`,
		class: 'A',
		kind,
		path: file,
		symbol: null,
		roles: [],
		globs: [],
		stacks: [],
		keywords: [],
		security: false,
		supersedes: [],
		title: path.basename(file, '.md'),
		body: text,
	});
}

/**
 * Coerce a config list field (#155): an array passes through, a non-empty string or number becomes
 * a one-item array (logging via `log`), and anything else (null/undefined/empty/object/boolean)
 * becomes `[]` (logging when a non-empty non-list value was dropped).
 */
export function coerceListField(val, { field = '', log = null } = {}) {
	if (val === undefined || val === null) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		const s = val.trim();
		if (!s) return [];
		if (log) log(`memory: coerced scalar ${field || 'field'} ${JSON.stringify(s)} to single-item list`);
		return [s];
	}
	if (typeof val === 'number' && Number.isFinite(val)) {
		if (log) log(`memory: coerced scalar ${field || 'field'} ${val} to single-item list`);
		return [val];
	}
	if (log) log(`memory: ignored non-list ${field || 'field'}`);
	return [];
}

/**
 * Normalize a git remote URL (HTTPS, SSH, git://, SCP-style git@host:owner/repo, or bare
 * `owner/repo`) to lowercase `owner/repo`, or `null` if it does not match a 2-segment repository
 * slug (#145). Bare filesystem paths (`/tmp/foo/bar`, `./foo/bar`) never match.
 */
export function normalizeRepoUrl(url) {
	if (typeof url !== 'string') return null;
	const s = url.trim().replace(/\/+$/, '');
	if (!s || s.startsWith('/') || s.startsWith('.')) return null;
	const urlMatch = /^(?:https?|ssh|git):\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(s);
	if (urlMatch) {
		const slug = urlMatch[1].replace(/\.git$/i, '');
		return REPO_RE.test(slug) ? slug.toLowerCase() : null;
	}
	const scpMatch = /^[^@/\s]+@[^:/\s]+:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(s);
	if (scpMatch) {
		const slug = scpMatch[1].replace(/\.git$/i, '');
		return REPO_RE.test(slug) ? slug.toLowerCase() : null;
	}
	const bare = s.replace(/\.git$/i, '');
	if (REPO_RE.test(bare)) return bare.toLowerCase();
	return null;
}

/**
 * Resolve `repoRoot`'s `origin` remote URL to normalized `owner/repo`, or `null` if `repoRoot` is
 * a git submodule (`--show-superproject-working-tree` non-empty) or has no normalizable `origin`
 * remote (#145).
 */
export function resolveOriginRepo(repoRoot) {
	if (!repoRoot) return null;
	try {
		const superproj = execFileSync(
			'git',
			['-C', repoRoot, 'rev-parse', '--show-superproject-working-tree'],
			{ encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		if (superproj) return null; // a vendored submodule checkout is never trusted as the top-level project repo
	} catch {
		return null;
	}
	try {
		const url = execFileSync(
			'git',
			['-C', repoRoot, 'remote', 'get-url', 'origin'],
			{ encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		return normalizeRepoUrl(url);
	} catch {
		return null;
	}
}

/**
 * Trusted `repos` allowlist (#145) from fleet config (`CLAUDE_CONFIG_DIR/memory.yml`), plugin
 * config (`<pluginRoot>/memory.yml`), explicit `opts.allowedRepos`, or `ENGSYS_MEMORY_REPOS`.
 * NEVER reads `repoRoot/.claude/memory.yml` — a third-party clone or submodule must not be able to
 * allowlist itself.
 */
export function resolveAllowedRepos(opts = {}) {
	const raw = [];
	if (Array.isArray(opts.allowedRepos)) raw.push(...opts.allowedRepos);
	if (process.env.ENGSYS_MEMORY_REPOS) {
		raw.push(...process.env.ENGSYS_MEMORY_REPOS.split(',').map((s) => s.trim()).filter(Boolean));
	}
	const configDirs = [
		process.env.CLAUDE_CONFIG_DIR ?? null,
		opts.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? null,
	].filter(Boolean);
	for (const dir of configDirs) {
		try {
			const text = fs.readFileSync(path.join(dir, 'memory.yml'), 'utf8');
			const parsed = parseYaml(text);
			raw.push(...coerceListField(parsed?.repos));
		} catch { /* absent or unreadable */ }
	}
	const set = new Set();
	for (const entry of raw) {
		const norm = normalizeRepoUrl(String(entry));
		if (norm) set.add(norm);
	}
	return set;
}

/**
 * True iff `repoRoot` is not a submodule and its `git remote get-url origin` normalizes to an
 * `owner/repo` in the trusted `repos` allowlist (#145).
 */
export function isRepoAllowlisted(repoRoot, opts = {}) {
	const allowed = opts.allowed instanceof Set ? opts.allowed : resolveAllowedRepos(opts);
	if (allowed.size === 0) return false;
	const originRepo = resolveOriginRepo(repoRoot);
	return originRepo !== null && allowed.has(originRepo);
}

/** Load every Class A doc from `roots` (as returned by resolveClassARoots). Also fills `manifest`
 * (path -> sha1) in place for the watermark. Never throws. */
export function loadClassADocs(roots, manifest = {}, opts = {}) {
	const seedSubdir = opts.seedSubdir ?? 'library'; // matches lessons.into: docs/agent-lessons/library
	const seededPrefix = `${seedSubdir}/`; // relDir below is always `/`-joined (git path convention), not path.sep
	const raw = [];
	// Bundled lessons-library: the plugin's OWN content, read from disk (never the project's
	// working tree) — see the module-level comment above loadProjectClassADocs for why this is the one
	// exception to "project Class A comes from the reviewed default branch" (engsys#140 H3).
	loadMdDir(roots.lessonsDir, SOURCE_KIND.LESSON, raw, manifest, { provenanceFor: () => 'bundled' });

	// Everything else is PROJECT content. `opts.repoRoot` OMITTED entirely is a direct/unit-test
	// call with no git context at all — falls back to reading the working tree (the pre-H3
	// behavior), since there is no "reviewed ref" concept without a repo. `opts.repoRoot` GIVEN
	// (the real path: `ensureIndex` always passes it) requires BOTH that `repoRoot` is allowlisted
	// via `repos` in fleet/plugin config (#145) AND reads from `origin/<default>` instead of the
	// working tree (engsys#140 H3 — Nyx F3); otherwise this degrades to "bundled lessons only".
	const repoRoot = opts.repoRoot;
	if (repoRoot === undefined) {
		loadMdDir(roots.agentLessonsDir, SOURCE_KIND.LESSON, raw, manifest, {
			provenanceFor: (file) => (path.relative(roots.agentLessonsDir, file).startsWith(`${seedSubdir}${path.sep}`) ? 'seeded' : 'project-local'),
		});
		loadMdDir(roots.adrDir, SOURCE_KIND.ADR, raw, manifest, { provenanceFor: () => 'adr' });
		loadSingle(roots.overlayFile, SOURCE_KIND.OVERLAY, raw, manifest);
	} else if (opts.allowlisted ?? isRepoAllowlisted(repoRoot, { pluginRoot: opts.pluginRoot, allowedRepos: opts.allowedRepos })) {
		// engsys#140 N1: resolve the reviewed commit ONCE, as a SHA — never a short ref name —
		// and reuse it for every subsequent git call this function makes.
		const sha = opts.reviewedSha ?? resolveReviewedSha(repoRoot, { defaultBranch: opts.defaultBranch });
		if (sha) {
			const relAgentLessons = path.relative(repoRoot, roots.agentLessonsDir).split(path.sep).join('/');
			const relAdr = path.relative(repoRoot, roots.adrDir).split(path.sep).join('/');
			const relOverlay = path.relative(repoRoot, roots.overlayFile).split(path.sep).join('/');
			loadProjectClassADocs(
				repoRoot,
				sha,
				[
					{ relDir: relAgentLessons, kind: SOURCE_KIND.LESSON, provenanceFor: (relPath) => (relPath.startsWith(`${relAgentLessons}/${seededPrefix}`) ? 'seeded' : 'project-local') },
					{ relDir: relAdr, kind: SOURCE_KIND.ADR, provenanceFor: () => 'adr' },
				],
				[{ relPath: relOverlay, kind: SOURCE_KIND.OVERLAY }],
				raw,
				manifest,
			);
		}
	}
	// A same-named lesson can exist under BOTH the bundled lessons-library and a project's
	// docs/agent-lessons/ (dogfooding this checkout, or a copy-mode project with a same-slug local
	// lesson, or — in copy mode specifically — the project's OWN top-level docs/agent-lessons/ file
	// colliding with the engsys-seeded docs/agent-lessons/library/ copy of the same lesson)
	// — `frontmatter.key` is a SQLite PRIMARY KEY, so a duplicate would throw mid-build and take
	// the whole index down with it (every brief then comes back empty).
	//
	// Dedupe by key here. For an ORDINARY collision (neither candidate is a protected security
	// doc) it's plain last-write-wins, same as always. But once ANY candidate for a key is BOTH
	// `security: true` AND loaded from an "official" root (bundled or seeded — see
	// PROVENANCE_RANK), that doc wins NO MATTER what order `walkMd`'s readdirSync happened to
	// return (filesystem order is not something to trust for a security decision), and no matter
	// what a lower-provenance challenger claims about its OWN `security` flag. Without this, an
	// unreviewed `docs/agent-lessons/<slug>.md` could neutralize the engsys-seeded
	// `docs/agent-lessons/library/<slug>.md` copy of a bundled security lesson — exactly the
	// bypass this whole mechanism exists to close.
	const isProtected = (d) => d?.security && PROVENANCE_RANK[d.provenance] >= 2;
	const byKey = new Map();
	for (const d of raw) {
		const prev = byKey.get(d.key);
		if (!prev) { byKey.set(d.key, d); continue; }
		const prevProtected = isProtected(prev);
		const dProtected = isProtected(d);
		if (prevProtected && !dProtected) continue; // protected incumbent resists an unprotected challenger
		if (dProtected && !prevProtected) { byKey.set(d.key, d); continue; } // a protected challenger always displaces an unprotected incumbent
		if (prevProtected && dProtected) { // both protected: the more "official" root wins; tie keeps the incumbent
			if (PROVENANCE_RANK[d.provenance] > PROVENANCE_RANK[prev.provenance]) byKey.set(d.key, d);
			continue;
		}
		byKey.set(d.key, d); // neither protected: ordinary last-write-wins
	}
	return { docs: [...byKey.values()], manifest };
}

// ---------------------------------------------------------------------------------------------
// Class B loading (local delta only in this phase — memory-sync, which populates
// `<cacheDir>/delta.jsonl` and `refs/engsys/memory/events`, is a later phase; see docs/memory-spec.md §7)
// ---------------------------------------------------------------------------------------------

/**
 * List local `refs/engsys/memory/*` refs and their tip SHAs in `repoRoot` (#132).
 * Returns `Array<{ ref: string, sha: string }>` sorted by `ref`. Never throws.
 */
export function listMemoryRefShas(repoRoot) {
	if (!repoRoot) return [];
	try {
		const out = execFileSync(
			'git',
			['-C', repoRoot, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/engsys/memory'],
			{ encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
		);
		const refs = [];
		for (const line of out.split('\n')) {
			const m = /^(refs\/engsys\/memory\/\S+)\s+([0-9a-f]{40})$/.exec(line.trim());
			if (m) refs.push({ ref: m[1], sha: m[2] });
		}
		return refs.sort((a, b) => a.ref.localeCompare(b.ref));
	} catch {
		return [];
	}
}

function eventUpdatedMs(e) {
	if (!e || typeof e !== 'object') return 0;
	if (typeof e.updated_at === 'string' && e.updated_at) {
		const t = Date.parse(e.updated_at);
		if (!Number.isNaN(t)) return t;
	}
	return 0;
}

function applyJsonlLinesToMap(text, byKey) {
	if (!text) return;
	for (const line of String(text).split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (!e || typeof e.k !== 'string') continue;
			const prev = byKey.get(e.k);
			if (!prev || eventUpdatedMs(e) >= eventUpdatedMs(prev)) {
				byKey.set(e.k, e);
			}
		} catch {
			/* one bad line never kills the rest */
		}
	}
}

/**
 * Parse synced `refs/engsys/memory/*` (`events.jsonl` blobs) plus `<cacheDir>/delta.jsonl`
 * (docs/memory-spec.md §3.2, #132) into Event[], merging by `k` (last-writer-wins by `updated_at`)
 * and dropping tombstones (`deleted: true`). Never throws.
 */
export function loadClassBEvents(cacheDir, { repoRoot = null, refShas = null } = {}) {
	const byKey = new Map();
	if (repoRoot) {
		const refs = Array.isArray(refShas) ? refShas : listMemoryRefShas(repoRoot);
		for (const r of refs) {
			try {
				const blobText = execFileSync(
					'git',
					['-C', repoRoot, 'show', `${r.sha}:events.jsonl`],
					{ encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
				);
				applyJsonlLinesToMap(blobText, byKey);
			} catch {
				/* ref without events.jsonl or unreadable */
			}
		}
	}
	if (cacheDir) {
		const file = path.join(cacheDir, 'delta.jsonl');
		try {
			const text = fs.readFileSync(file, 'utf8');
			applyJsonlLinesToMap(text, byKey);
		} catch {
			/* missing or unreadable delta.jsonl */
		}
	}
	const out = [];
	for (const e of byKey.values()) {
		if (e.deleted) continue;
		out.push(e);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------------------------

/** The staleness manifest: engsys version + a path->sha1 map for every Class A source + the Class
 * B event count (events themselves aren't content-hashed here; delta.jsonl's own mtime/size is a
 * cheap enough proxy and is folded in by the caller via `eventsFingerprint`). Directory mtimes are
 * deliberately not used (§4: they miss in-place edits and git checkout resets them). */
export function computeWatermark(manifest, eventsFingerprint, version) {
	return { version, files: manifest, events: eventsFingerprint };
}

function stableStringify(obj) {
	if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------------------------
// the index itself
// ---------------------------------------------------------------------------------------------

const DDL = [
	"CREATE VIRTUAL TABLE docs USING fts5(key, class, kind, path, symbol, roles, globs, keywords, body, tokenize = 'porter unicode61')",
	'CREATE TABLE frontmatter (key TEXT PRIMARY KEY, globs TEXT, stacks TEXT, roles TEXT, keywords TEXT, security INTEGER, supersedes TEXT, path TEXT, title TEXT)',
	'CREATE TABLE events (key TEXT PRIMARY KEY, kind TEXT, repo TEXT, number INTEGER, path TEXT, line INTEGER, symbol TEXT, marker TEXT, outcome TEXT, author_id INTEGER, author_kind TEXT, editor_id INTEGER, updated_at TEXT, url TEXT, flags TEXT, text TEXT)',
	'CREATE TABLE watermark (id INTEGER PRIMARY KEY CHECK (id = 0), manifest TEXT)',
];

const DDL_FALLBACK_DOCS = 'CREATE TABLE docs (key TEXT, class TEXT, kind TEXT, path TEXT, symbol TEXT, roles TEXT, globs TEXT, keywords TEXT, body TEXT)';

function buildInto(dbPath, { sqlite, docs, events, manifest }) {
	const { DatabaseSync } = sqlite;
	const db = new DatabaseSync(dbPath);
	try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort; the cache DIR's 0700 is the primary control */ }
	try {
		// NOT WAL: this file is written once by a single process, then renamed into place and
		// reopened read-only by every caller afterward. WAL would need a -wal/-shm sidecar that
		// `renameSync` (main file only) leaves orphaned in the cache dir, and a read-only open can
		// need to create that sidecar itself on a filesystem that won't allow it. DELETE needs
		// neither: every write before `close()` lands directly in the main file.
		db.exec('PRAGMA journal_mode = DELETE');
		try {
			db.exec(DDL[0]);
		} catch (e) {
			if (!/no such module:\s*fts5/i.test(String(e?.message ?? e))) throw e;
			// Node 22.5–22.15 ships node:sqlite without SQLITE_ENABLE_FTS5; fall back to a plain
			// table so the index still builds and queryIndex can rank rows in JS.
			db.exec(DDL_FALLBACK_DOCS);
		}
		for (const stmt of DDL.slice(1)) db.exec(stmt);
		const insDoc = db.prepare('INSERT INTO docs (key, class, kind, path, symbol, roles, globs, keywords, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		const insFm = db.prepare('INSERT INTO frontmatter (key, globs, stacks, roles, keywords, security, supersedes, path, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		for (const d of docs) {
			insDoc.run(d.key, d.class, d.kind, d.path, d.symbol, (d.roles || []).join(' '), (d.globs || []).join(' '), (d.keywords || []).join(' '), `${d.title}\n\n${d.body}`);
			insFm.run(d.key, JSON.stringify(d.globs || []), JSON.stringify(d.stacks || []), JSON.stringify(d.roles || []), JSON.stringify(d.keywords || []), d.security ? 1 : 0, JSON.stringify(d.supersedes || []), d.path, d.title);
		}
		const insEv = db.prepare('INSERT INTO events (key, kind, repo, number, path, line, symbol, marker, outcome, author_id, author_kind, editor_id, updated_at, url, flags, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
		const insDocEv = db.prepare('INSERT INTO docs (key, class, kind, path, symbol, roles, globs, keywords, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		for (const raw of events) {
			// engsys#140 H2: validate at insert too, not just at render — a malformed/forged
			// field never even reaches the writable index.sqlite. `opts.allowedMarkers` is
			// intentionally omitted here (this module has no config access); the
			// configured-marker-membership check happens again, with config, at render time.
			const e = validatePointerEvent(raw);
			if (!e) continue;
			insEv.run(e.k, e.kind ?? null, e.repo ?? null, e.number ?? null, e.path ?? null, e.line ?? null, e.symbol ?? null, e.marker ?? null, e.outcome ?? null, e.author_id ?? null, e.author_kind ?? null, e.editor_id ?? null, e.updated_at ?? null, e.url ?? null, JSON.stringify(e.flags ?? []), e.text ?? '');
			insDocEv.run(e.k, 'B', SOURCE_KIND.EVENT, e.path ?? null, e.symbol ?? null, '', '', '', e.text ?? '');
		}
		db.prepare('INSERT INTO watermark (id, manifest) VALUES (0, ?)').run(stableStringify(manifest));
	} finally {
		db.close();
	}
}

/**
 * Build (if the watermark changed) or reuse the on-disk index. `opts`:
 *   repoRoot (required), cacheDir (default resolveCacheDir()), pluginRoot, version (default 'dev'),
 *   sqlite (injected node:sqlite-shaped module, for tests), fs (unused hook reserved for tests).
 *
 * Returns `{ db, docs, manifestPath }` with `db` a read-only-reopened handle, or `null` on ANY
 * failure (no node:sqlite, no writable cache dir, a build error) — callers must treat null as
 * "no memory available right now", never throw it onward.
 */
export function ensureIndex(opts = {}) {
	const repoRoot = opts.repoRoot ?? process.cwd();
	const cacheDir = opts.cacheDir !== undefined ? opts.cacheDir : resolveCacheDir(repoRoot);
	if (!cacheDir) return null;
	let sqlite;
	try {
		sqlite = opts.sqlite ?? loadSqliteSync();
	} catch {
		return null;
	}
	if (!sqlite || !sqlite.DatabaseSync) return null;

	try {
		// 0700: this cache holds the full rendered content of every lesson/event a brief could
		// ever surface (engsys#140 M1) — other local users/processes have no business reading it,
		// on top of it being untrustworthy to WRITE to from outside this tool's own logic.
		fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(cacheDir, 0o700); // mkdirSync's mode is masked by umask; force it explicitly
	} catch {
		return null;
	}

	const roots = resolveClassARoots(repoRoot, { pluginRoot: opts.pluginRoot });
	const manifest = {};
	const { docs } = loadClassADocs(roots, manifest, { repoRoot, pluginRoot: opts.pluginRoot, allowedRepos: opts.allowedRepos, defaultBranch: opts.defaultBranch, reviewedSha: opts.reviewedSha });
	const refShas = listMemoryRefShas(repoRoot);
	const events = loadClassBEvents(cacheDir, { repoRoot, refShas });
	let eventsFingerprint = 0;
	try {
		const st = fs.statSync(path.join(cacheDir, 'delta.jsonl'));
		eventsFingerprint = `${st.size}:${st.mtimeMs}`;
	} catch {
		eventsFingerprint = 0;
	}
	if (refShas.length > 0) {
		eventsFingerprint = `${eventsFingerprint}|refs:${refShas.map((r) => `${r.ref}=${r.sha}`).join(',')}`;
	}
	const watermark = computeWatermark(manifest, eventsFingerprint, opts.version ?? 'dev');
	const watermarkJson = stableStringify(watermark);

	const dbPath = path.join(cacheDir, 'index.sqlite');
	let needsBuild = true;
	try {
		if (fs.existsSync(dbPath)) {
			const ro = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				const row = ro.prepare('SELECT manifest FROM watermark WHERE id = 0').get();
				needsBuild = !row || row.manifest !== watermarkJson;
			} finally {
				ro.close();
			}
		}
	} catch {
		needsBuild = true; // a corrupt/partial index is rebuilt, not fatal
	}

	if (needsBuild) {
		// A dispatch killed mid-build (subagent-memory-inject.mjs's hard SIGKILL timeout) skips the
		// catch block below entirely, so its tmp file is never cleaned up — sweep stale siblings
		// (older than a build could plausibly still be running) before starting a new one, rather
		// than letting them accumulate unbounded (cr review, round 3).
		try {
			for (const f of fs.readdirSync(cacheDir)) {
				if (!f.startsWith('index.sqlite.tmp-')) continue;
				const p = path.join(cacheDir, f);
				try { if (Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.rmSync(p, { force: true }); } catch { /* best effort */ }
			}
		} catch { /* best effort */ }
		const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			buildInto(tmpPath, { sqlite, docs, events, manifest: watermark });
			fs.renameSync(tmpPath, dbPath); // atomic on the same filesystem — the safe handoff under concurrency
		} catch (err) {
			try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
			// Another process may have just finished its own rebuild and already holds a valid
			// dbPath — fall through to opening it read-only below rather than failing outright. But a
			// PERSISTENT failure (bad event data hitting a DDL/insert error every time) would
			// otherwise silently serve the same stale index forever with no trace of why it never
			// updates — log it, best-effort, so that's at least diagnosable.
			try {
				fs.appendFileSync(path.join(cacheDir, 'rebuild-failures.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), error: String(err?.message ?? err) })}\n`);
			} catch { /* logging must never cost the fail-open fallback below */ }
		}
	}

	try {
		const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
		return { db, docs, cacheDir, dbPath };
	} catch {
		return null;
	}
}

function loadSqliteSync() {
	// node:sqlite has no async-only surface worth awaiting for; createRequire keeps ensureIndex
	// synchronous (the brief's 2s budget is a wall-clock budget set by the caller, not by this).
	// Throws on Node < 22.5 or a build without the module — every caller treats that as fail-open.
	return require('node:sqlite');
}

/** Best-effort close. Never throws. */
export function closeIndex(handle) {
	try { handle?.db?.close(); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------------------------
// querying
// ---------------------------------------------------------------------------------------------

function simpleStem(word) {
	const w = word.toLowerCase();
	if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
	if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
	if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
	if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
	return w;
}

function fallbackRankDocs(db, terms, limit) {
	try {
		const allRows = db.prepare('SELECT key, class, kind, path, symbol, roles, globs, keywords, body FROM docs').all();
		const qStems = [...new Set(terms.map(simpleStem))];
		const scored = [];
		for (const r of allRows) {
			const hay = `${r.roles ?? ''} ${r.globs ?? ''} ${r.keywords ?? ''} ${r.symbol ?? ''} ${r.path ?? ''} ${r.body ?? ''}`;
			const words = (hay.match(/[A-Za-z0-9_][A-Za-z0-9_-]*/g) || []).map(simpleStem);
			if (words.length === 0) continue;
			let hits = 0;
			for (const qs of qStems) {
				let tf = 0;
				for (const w of words) if (w === qs) tf++;
				if (tf > 0) hits += 1 + Math.log(1 + tf);
			}
			if (hits > 0) {
				scored.push({ ...r, score: -(hits / (1 + 0.001 * words.length)) });
			}
		}
		scored.sort((a, b) => a.score - b.score);
		return scored.slice(0, limit);
	} catch {
		return [];
	}
}

/**
 * BM25-rank `docs` FTS5 rows matching `text`, restricted to `class` ('A' or 'B', default both).
 * Returns `[{ key, class, kind, path, symbol, title, body, score, frontmatter }]`, best first.
 * `frontmatter` is the parsed row from the `frontmatter` table when `class === 'A'`, else null.
 * Never throws — a malformed FTS query (stray punctuation) degrades to an empty result.
 */
export function queryIndex(db, { text = '', limit = 20 } = {}) {
	if (!db) return [];
	const terms = String(text).match(/[A-Za-z0-9_][A-Za-z0-9_-]*/g) || [];
	if (terms.length === 0) return [];
	const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
	let rows;
	try {
		rows = db
			.prepare('SELECT key, class, kind, path, symbol, body, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?')
			.all(match, limit);
	} catch {
		rows = fallbackRankDocs(db, terms, limit);
	}
	return rows.map((r) => {
		let fm = null;
		if (r.class === 'A') {
			try {
				fm = db.prepare('SELECT * FROM frontmatter WHERE key = ?').get(r.key);
				if (fm) {
					fm = {
						...fm,
						globs: JSON.parse(fm.globs || '[]'),
						stacks: JSON.parse(fm.stacks || '[]'),
						roles: JSON.parse(fm.roles || '[]'),
						keywords: JSON.parse(fm.keywords || '[]'),
						supersedes: JSON.parse(fm.supersedes || '[]'),
						security: !!fm.security,
					};
				}
			} catch {
				fm = null;
			}
		}
		return { key: r.key, class: r.class, kind: r.kind, path: r.path, symbol: r.symbol, body: r.body, score: -r.score, frontmatter: fm };
	});
}

/** Every Class A frontmatter row (for the globs/roles/stacks pre-filter memory-brief applies
 * before blending in BM25 — see memory-brief.mjs). Never throws. */
export function listClassAFrontmatter(db) {
	if (!db) return [];
	try {
		return db.prepare('SELECT * FROM frontmatter').all().map((fm) => ({
			...fm,
			globs: JSON.parse(fm.globs || '[]'),
			stacks: JSON.parse(fm.stacks || '[]'),
			roles: JSON.parse(fm.roles || '[]'),
			keywords: JSON.parse(fm.keywords || '[]'),
			supersedes: JSON.parse(fm.supersedes || '[]'),
			security: !!fm.security,
		}));
	} catch {
		return [];
	}
}

/** Every Class B event row (for memory-brief's pointer scoring). Never throws. */
export function listEvents(db) {
	if (!db) return [];
	try {
		return db.prepare('SELECT * FROM events').all().map((e) => ({ ...e, flags: JSON.parse(e.flags || '[]') }));
	} catch {
		return [];
	}
}
