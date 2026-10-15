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
import { parseYaml } from '../../../lib/yaml.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// core/lib/memory -> core (bundled lessons-library lives at core/lessons-library)
const CORE_DIR = path.resolve(HERE, '..', '..');

/** Sources an engine built from `docs()` carries, mirroring docs/memory-spec.md §3.3/§4. */
export const SOURCE_KIND = { LESSON: 'lesson', OVERLAY: 'overlay', ADR: 'adr', EVENT: 'event' };

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
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
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
export function resolveClassARoots(repoRoot, opts = {}) {
	const pluginRoot = opts.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? null;
	let lessonsDir = pluginRoot ? path.join(pluginRoot, 'lessons-library') : null;
	if (!lessonsDir || !fs.existsSync(lessonsDir)) {
		const fallback = path.join(CORE_DIR, 'lessons-library');
		if (fs.existsSync(fallback)) lessonsDir = fallback;
	}
	return {
		lessonsDir: lessonsDir && fs.existsSync(lessonsDir) ? lessonsDir : null,
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
		if (e.isDirectory()) yield* walkMd(p);
		else if (e.isFile() && e.name.endsWith('.md')) yield p;
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

/** Load every `.md` file under `dir` (recursively) as a Class A Doc, keyed `<kind>:<slug>` (slug =
 * basename without `.md` — stable across the bundled lessons-library, a project's
 * `docs/agent-lessons/`, and `docs/architecture/adr/`, so `supersedes` references resolve the same
 * way regardless of which root a lesson lives under). Skips README.md. Never throws. */
function loadMdDir(dir, kind, docs, manifest) {
	if (!dir) return;
	for (const file of walkMd(dir)) {
		if (path.basename(file) === 'README.md') continue;
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
		manifest[file] = sha1(text);
		const { fm, body } = readFrontmatter(text);
		const titleMatch = /^#\s+(.+)$/m.exec(body);
		docs.push({
			key: `${kind}:${path.basename(file, '.md')}`,
			class: 'A',
			kind,
			path: file,
			symbol: null,
			roles: fm.roles ?? [],
			globs: fm.globs ?? [],
			stacks: fm.stacks ?? [],
			keywords: fm.keywords ?? [],
			security: fm.security === true,
			supersedes: fm.supersedes ?? [],
			title: titleMatch ? titleMatch[1] : path.basename(file, '.md'),
			body,
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

/** Load every Class A doc from `roots` (as returned by resolveClassARoots). Also fills `manifest`
 * (path -> sha1) in place for the watermark. Never throws. */
export function loadClassADocs(roots, manifest = {}) {
	const raw = [];
	loadMdDir(roots.lessonsDir, SOURCE_KIND.LESSON, raw, manifest);
	loadMdDir(roots.agentLessonsDir, SOURCE_KIND.LESSON, raw, manifest);
	loadMdDir(roots.adrDir, SOURCE_KIND.ADR, raw, manifest);
	loadSingle(roots.overlayFile, SOURCE_KIND.OVERLAY, raw, manifest);
	// A same-named lesson can exist under BOTH the bundled lessons-library and a project's
	// docs/agent-lessons/ (dogfooding this checkout, or a copy-mode project with a same-slug local
	// lesson) — `frontmatter.key` is a SQLite PRIMARY KEY, so a duplicate would throw mid-build and
	// take the whole index down with it (every brief then comes back empty). Dedupe by key here,
	// LAST write wins — agentLessonsDir is loaded after lessonsDir, so the project-local copy wins.
	const byKey = new Map();
	for (const d of raw) byKey.set(d.key, d);
	return { docs: [...byKey.values()], manifest };
}

// ---------------------------------------------------------------------------------------------
// Class B loading (local delta only in this phase — memory-sync, which populates
// `<cacheDir>/delta.jsonl` and `refs/engsys/memory/events`, is a later phase; see docs/memory-spec.md §7)
// ---------------------------------------------------------------------------------------------

/** Parse `<cacheDir>/delta.jsonl` (one JSON event record per line, docs/memory-spec.md §3.2) into
 * Event[]. A missing file, an unreadable file, or a malformed line are all "no events" — never thrown. */
export function loadClassBEvents(cacheDir) {
	if (!cacheDir) return [];
	const file = path.join(cacheDir, 'delta.jsonl');
	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
	const events = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e.k === 'string' && !e.deleted) events.push(e);
		} catch {
			/* one bad line never kills the rest */
		}
	}
	return events;
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

function buildInto(dbPath, { sqlite, docs, events, manifest }) {
	const { DatabaseSync } = sqlite;
	const db = new DatabaseSync(dbPath);
	try {
		db.exec('PRAGMA journal_mode = WAL');
		for (const stmt of DDL) db.exec(stmt);
		const insDoc = db.prepare('INSERT INTO docs (key, class, kind, path, symbol, roles, globs, keywords, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		const insFm = db.prepare('INSERT INTO frontmatter (key, globs, stacks, roles, keywords, security, supersedes, path, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		for (const d of docs) {
			insDoc.run(d.key, d.class, d.kind, d.path, d.symbol, (d.roles || []).join(' '), (d.globs || []).join(' '), (d.keywords || []).join(' '), `${d.title}\n\n${d.body}`);
			insFm.run(d.key, JSON.stringify(d.globs || []), JSON.stringify(d.stacks || []), JSON.stringify(d.roles || []), JSON.stringify(d.keywords || []), d.security ? 1 : 0, JSON.stringify(d.supersedes || []), d.path, d.title);
		}
		const insEv = db.prepare('INSERT INTO events (key, kind, repo, number, path, line, symbol, marker, outcome, author_id, author_kind, editor_id, updated_at, url, flags, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
		const insDocEv = db.prepare('INSERT INTO docs (key, class, kind, path, symbol, roles, globs, keywords, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
		for (const e of events) {
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
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch {
		return null;
	}

	const roots = resolveClassARoots(repoRoot, { pluginRoot: opts.pluginRoot });
	const manifest = {};
	const { docs } = loadClassADocs(roots, manifest);
	const events = loadClassBEvents(cacheDir);
	let eventsFingerprint = 0;
	try {
		const st = fs.statSync(path.join(cacheDir, 'delta.jsonl'));
		eventsFingerprint = `${st.size}:${st.mtimeMs}`;
	} catch {
		eventsFingerprint = 0;
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
		const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			buildInto(tmpPath, { sqlite, docs, events, manifest: watermark });
			fs.renameSync(tmpPath, dbPath); // atomic on the same filesystem — the safe handoff under concurrency
		} catch {
			try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
			// another process may have just finished its own rebuild and already holds a valid
			// dbPath — fall through to opening it read-only below rather than failing outright.
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
		return [];
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
