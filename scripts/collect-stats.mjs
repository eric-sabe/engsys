#!/usr/bin/env node
/**
 * collect-stats.mjs — GitHub activity collector for the engsys dashboard.
 * Node 18+, ESM, zero external dependencies (uses built-in fetch).
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... node scripts/collect-stats.mjs
 *
 * Writes data/stats.json with opaque repo aliases — no owner/repo names
 * are serialized to the output file (privacy constraint, spec §3.1).
 *
 * Phases covered:
 *   Phase 1 — issues opened/closed, commits, PRs merged (counts + weekly series)
 *   Phase 2 — LOC via PR additions/deletions + direct-push per-commit stats
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync }               from 'node:fs';
import { join, dirname }    from 'node:path';
import { fileURLToPath }    from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// Auto-load .env for local development (does not override already-set vars)
try {
  const envText = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*(?:#.*)?$/);
    if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env — fine in CI */ }

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — identity comes from the environment (.env locally, secrets in CI), so
// no personal details live in this public source file. See the README and the
// `.env.example` for the variables. Tuning knobs below have sensible defaults.
// ═══════════════════════════════════════════════════════════════════════════

// Parse DASHBOARD_OWNERS ("name:type,name:type") → [{ name, type }].
// type is 'user' or 'org'; anything but 'org' is treated as 'user'.
function parseOwners(raw) {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map(spec => {
    const [name, type] = spec.split(':').map(x => x.trim());
    return { name, type: type === 'org' ? 'org' : 'user' };
  });
}

const CONFIG = {
  /** Primary GitHub login to attribute activity to (DASHBOARD_LOGIN) */
  login: process.env.DASHBOARD_LOGIN ?? '',

  /** Commit-author emails belonging to this user (DASHBOARD_EMAILS, comma-separated) */
  emails: new Set((process.env.DASHBOARD_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean)),

  /** Owners to enumerate repos from (DASHBOARD_OWNERS = "you:user,YourOrg:org,…") */
  owners: parseOwners(process.env.DASHBOARD_OWNERS),

  /** Trailing window depth in months */
  windowMonths: 12,

  /** Include archived repos? (usually false — they rarely have new commits) */
  includeArchived: false,

  /** Include forks? */
  includeForks: false,

  /**
   * Data-only commit exclusion (direct-push LOC only).
   * A commit is skipped when EITHER:
   *   (a) additions > dataOnlyLocThreshold AND ≥ dataOnlyRatioThreshold of
   *       those additions (from the files[] list) are in data-file extensions, OR
   *   (b) additions > dataOnlyAbsoluteCap AND the GitHub files[] list is
   *       truncated (capped at 300) — truncation means the ratio is unreliable
   *       and a commit this large is almost never meaningful code.
   * Set dataOnlyLocThreshold to 0 to disable entirely.
   */
  dataOnlyLocThreshold:    10_000,
  dataOnlyRatioThreshold:  0.80,
  dataOnlyAbsoluteCap:     250_000,  // always skip if truncated AND above this size
};
// ═══════════════════════════════════════════════════════════════════════════

// ── CLI flags ────────────────────────────────────────────────────────────────
// --delta          Only fetch since last run, merge into existing stats.json.
// --repo o/name    Collect only the specified repo(s) and merge into existing
//                  stats.json. Can be repeated. Implies full-window collection
//                  for those repos so historical data is corrected. Non-targeted
//                  repos are untouched.
const DELTA_MODE   = process.argv.includes('--delta');
const TARGET_REPOS = process.argv
  .flatMap((a, i, arr) => a === '--repo' ? [arr[i + 1]] : [])
  .filter(Boolean)
  .map(s => s.toLowerCase());

// ── Auth guard ──────────────────────────────────────────────────────────────
// Precedence: explicit GITHUB_TOKEN (CI sets this to the DASHBOARD_PAT secret)
// → DASHBOARD_PAT from .env (the dedicated, read-only dashboard token)
// → GH_TOKEN (a general token in the shell, used only as a last resort).
const GH_TOKEN = process.env.GITHUB_TOKEN ?? process.env.DASHBOARD_PAT ?? process.env.GH_TOKEN;
if (!GH_TOKEN) {
  console.error('ERROR: No GitHub token found.');
  console.error('  Set DASHBOARD_PAT in .env (or export GITHUB_TOKEN) before running.');
  console.error('  Required scopes: repo  read:org  read:user');
  console.error('  Create one at: https://github.com/settings/tokens');
  process.exit(1);
}

// ── Identity guard ────────────────────────────────────────────────────────────
if (!CONFIG.login || !CONFIG.owners.length) {
  console.error('ERROR: Dashboard identity is not configured.');
  console.error('  Set these in .env (locally) or as Actions secrets (CI):');
  console.error('    DASHBOARD_LOGIN   your GitHub login                e.g. octocat');
  console.error('    DASHBOARD_OWNERS  owners to scan, "name:type" CSV  e.g. octocat:user,acme:org');
  console.error('    DASHBOARD_EMAILS  commit-author emails (CSV)       e.g. you@example.com');
  console.error('  See the README "Activity dashboard" section for details.');
  process.exit(1);
}

// Extra logins (e.g. consolidated/renamed accounts) treated as primary.
// Loaded from DASHBOARD_EXTRA_LOGINS in .env — never committed.
const EXTRA_LOGINS = (process.env.DASHBOARD_EXTRA_LOGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
CONFIG.allLogins = new Set([CONFIG.login, ...EXTRA_LOGINS]);

const GQL_URL = 'https://api.github.com/graphql';
const REST_URL = 'https://api.github.com';
const BASE_HEADERS = {
  Authorization: `bearer ${GH_TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent':   'engsys-dashboard/1.0',
};

// ── API helpers ──────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors[0])}`);
  }
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Throttle between per-commit direct-push REST calls. 500ms (2 req/s) is a safe
// default for the daily cron; lower it via DIRECT_LOC_SLEEP_MS for fast backfills.
const DIRECT_LOC_SLEEP_MS = Number(process.env.DIRECT_LOC_SLEEP_MS) || 500;

async function restGet(path, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${REST_URL}${path}`, {
      headers: { ...BASE_HEADERS, Accept: 'application/vnd.github.v3+json' },
    });
    if (res.ok) return res.json();

    const remaining  = parseInt(res.headers.get('x-ratelimit-remaining') ?? '-1', 10);
    const resetEpoch = parseInt(res.headers.get('x-ratelimit-reset')     ?? '0',  10);
    const retryAfter = parseInt(res.headers.get('retry-after')           ?? '0',  10);

    // Rate-limit exhaustion: remaining=0, sleep until the reset window opens
    if ((res.status === 403 || res.status === 429) && remaining === 0 && attempt < retries) {
      const waitMs = resetEpoch
        ? Math.max((resetEpoch * 1000) - Date.now() + 2000, 2000)
        : (retryAfter || 60) * 1000;
      console.warn(`  WARN: rate limit exhausted — sleeping ${Math.ceil(waitMs / 1000)}s until reset`);
      await sleep(waitMs);
      continue;
    }

    // Secondary rate-limit (retry-after header present)
    if ((res.status === 403 || res.status === 429) && retryAfter > 0 && attempt < retries) {
      console.warn(`  WARN: secondary rate limit — retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }

    throw new Error(`REST ${res.status}: GET ${path}`);
  }
}

/**
 * Page through a GitHub GraphQL connection.
 * queryFn(afterCursor) returns a promise resolving to the raw data object.
 * extractor(data) pulls out the { nodes, pageInfo } connection from that data.
 */
async function paginate(queryFn, extractor) {
  const nodes  = [];
  let cursor   = null;
  let page     = 0;
  const MAX_PAGES = 100; // safety brake
  do {
    const data = await queryFn(cursor);
    const conn = extractor(data);
    nodes.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (++page >= MAX_PAGES) {
      console.warn('WARN: pagination hit 100-page limit — some data may be truncated');
      break;
    }
  } while (cursor);
  return nodes;
}

// ── Date / week utilities ────────────────────────────────────────────────────

/** Returns { from: Date, to: Date } for the trailing window. */
function windowBounds() {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - CONFIG.windowMonths);
  return { from, to };
}

/**
 * Returns the ISO date string ('YYYY-MM-DD') of the Monday on or before `date`.
 * All weekly buckets are Monday-aligned.
 */
function weekOf(date) {
  const d = new Date(typeof date === 'string' ? date : date.toISOString());
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();                   // 0=Sun … 6=Sat
  const delta = day === 0 ? -6 : 1 - day;      // days back to Monday
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Returns an ordered array of week-start strings (Monday) spanning [from, to]. */
function buildWeeks(from, to) {
  const weeks = [];
  const cur   = new Date(weekOf(from));        // first Monday ≤ from
  const end   = new Date(to);
  while (cur <= end) {
    weeks.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return weeks;
}

/** Fresh bucket object for one week. */
function emptyBucket() {
  return {
    issuesOpened:   0,
    issuesClosed:   0,
    commits:        0,
    prsMerged:      0,
    locAdded:       0,
    locRemoved:     0,
    locAddedViaPR:  0,   // LOC from merged PRs (no direct-push LOC)
    locAddedDirect: 0,   // LOC from direct-to-main commits only
  };
}

/** Aggregate totals shape (omits locAddedViaPR / locAddedDirect split). */
function emptyTotals() {
  return {
    issuesOpened: 0, issuesClosed: 0,
    commits:      0, prsMerged:    0,
    locAdded:     0, locRemoved:   0,
  };
}

// ── Repo enumeration ─────────────────────────────────────────────────────────

async function getRepos({ name, type }) {
  const field = type === 'org' ? 'organization' : 'user';
  const Q = `
    query($login: String!, $after: String) {
      ${field}(login: $login) {
        repositories(first: 100, after: $after,
            orderBy: { field: PUSHED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            nameWithOwner
            defaultBranchRef { name }
            isArchived
            isFork
          }
        }
      }
    }`;

  const nodes = await paginate(
    (after) => gql(Q, { login: name, after }),
    (data)  => data[field].repositories,
  );

  return nodes.filter(r =>
    (CONFIG.includeArchived || !r.isArchived) &&
    (CONFIG.includeForks    || !r.isFork)     &&
    r.defaultBranchRef,                        // skip completely empty repos
  );
}

// ── Issues ───────────────────────────────────────────────────────────────────

/**
 * Returns issues opened by CONFIG.login within the window.
 * Uses filterBy.createdBy server-side; double-checks createdAt client-side
 * because filterBy.since applies to updatedAt, not createdAt.
 */
async function fetchOpenedIssues(owner, name, fromISO) {
  const Q = `
    query($owner: String!, $name: String!, $author: String!, $since: DateTime!, $after: String) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, after: $after,
            filterBy: { createdBy: $author, since: $since }) {
          pageInfo { hasNextPage endCursor }
          nodes { createdAt }
        }
      }
    }`;

  // Run once per login — issues have a single author, so no dedup needed.
  const all = [];
  for (const author of CONFIG.allLogins) {
    const nodes = await paginate(
      (after) => gql(Q, { owner, name, author, since: fromISO, after }),
      (data)  => data.repository.issues,
    );
    all.push(...nodes.filter(i => i.createdAt >= fromISO));
  }
  return all;
}

/**
 * Returns an array of ISO date strings for ClosedEvents within the window
 * where the closing actor was CONFIG.login.
 *
 * Spec §10: issuesClosed counts close-events whose actor is the configured
 * login (via timelineItems ClosedEvent.actor — not just issue state).
 */
async function fetchClosedByMe(owner, name, fromISO) {
  // Only page through CLOSED issues updated since the window start —
  // if an issue was closed inside the window, its updatedAt >= fromISO.
  const Q = `
    query($owner: String!, $name: String!, $since: DateTime!, $after: String) {
      repository(owner: $owner, name: $name) {
        issues(first: 50, after: $after, states: [CLOSED],
            filterBy: { since: $since }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            # Up to 10 close/reopen events; sufficient for typical issues
            timelineItems(first: 10, itemTypes: [CLOSED_EVENT]) {
              nodes {
                ... on ClosedEvent {
                  createdAt
                  actor { login }
                }
              }
            }
          }
        }
      }
    }`;

  const nodes = await paginate(
    (after) => gql(Q, { owner, name, since: fromISO, after }),
    (data)  => data.repository.issues,
  );

  const closedDates = [];
  for (const issue of nodes) {
    for (const event of issue.timelineItems.nodes) {
      if (CONFIG.allLogins.has(event?.actor?.login) && event.createdAt >= fromISO) {
        closedDates.push(event.createdAt);
      }
    }
  }
  return closedDates;
}

// ── Pull requests ─────────────────────────────────────────────────────────────

/**
 * Returns merged PRs authored by CONFIG.login within the window.
 * Includes additions/deletions for LOC (Phase 2) and all commit SHAs
 * needed for direct-push detection (spec §5).
 *
 * mergeCommit.oid is included so squash-merged PRs don't appear as
 * direct pushes (the squash SHA differs from any commit in the branch).
 */
async function fetchMergedPRs(owner, name, fromISO) {
  const Q = `
    query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 50, after: $after, states: [MERGED],
            orderBy: { field: UPDATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            mergedAt
            author { login }
            additions
            deletions
            # Merge/squash commit SHA — different from branch commits for squash merges
            mergeCommit { oid }
            # Branch commits (pre-rebase SHAs for rebase-merge workflows)
            commits(first: 100) {
              nodes { commit { oid } }
            }
          }
        }
      }
    }`;

  const allPRs = [];
  let cursor   = null;
  let page     = 0;

  // Early-terminate once PRs are older than the window (ordered by UPDATED_AT DESC)
  while (true) {
    const data = await gql(Q, { owner, name, after: cursor });
    const conn = data.repository.pullRequests;

    let hitFloor = false;
    for (const pr of conn.nodes) {
      if (!pr.mergedAt || pr.mergedAt < fromISO) { hitFloor = true; break; }
      if (CONFIG.allLogins.has(pr.author?.login)) allPRs.push(pr);
    }

    if (hitFloor || !conn.pageInfo.hasNextPage || ++page >= 100) break;
    cursor = conn.pageInfo.endCursor;
  }

  return allPRs;
}

// ── Commits on the default branch ────────────────────────────────────────────

/**
 * Returns commits on `branch` authored by CONFIG.login within the window.
 * Matching is by email (CONFIG.emails) OR GitHub login (CONFIG.login).
 */
async function fetchMainCommits(owner, name, branch, fromISO) {
  const Q = `
    query($owner: String!, $name: String!, $branch: String!, $since: GitTimestamp!, $after: String) {
      repository(owner: $owner, name: $name) {
        ref(qualifiedName: $branch) {
          target {
            ... on Commit {
              history(first: 100, after: $after, since: $since) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  oid
                  committedDate
                  authoredDate
                  author {
                    email
                    user { login }
                  }
                }
              }
            }
          }
        }
      }
    }`;

  const nodes = await paginate(
    (after) => gql(Q, { owner, name, branch, since: fromISO, after }),
    (data)  => data.repository.ref.target.history,
  );

  // Filter to commits authored by this user
  return nodes.filter(c => {
    const login = c.author?.user?.login;
    const email = c.author?.email;
    return CONFIG.allLogins.has(login) || CONFIG.emails.has(email);
  });
}

// ── Per-commit stats (direct pushes only — Phase 2) ──────────────────────────

// Extensions treated as data/corpus files rather than source code.
// A direct-push commit where ≥ dataOnlyRatioThreshold of its additions
// land in these extensions is excluded from LOC counts (see CONFIG).
const DATA_EXTENSIONS = new Set([
  // structured data / corpora
  'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'txt', 'xml',
  'sql', 'bson', 'dump',
  // archives / binaries
  'gz', 'tar', 'zip', 'whl', 'egg',
  // columnar / ML formats
  'parquet', 'arrow', 'feather', 'pkl', 'pickle', 'h5', 'hdf5', 'pb', 'onnx', 'pt', 'pth',
  // generated output — coverage reports, source maps, lock files, logs
  'html', 'lcov', 'info',          // coverage reports (lcov-report etc.)
  'map',                            // JS/CSS source maps
  'lock',                           // yarn.lock, Pipfile.lock, poetry.lock
  'log',                            // log files
]);

function fileExt(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Fetches additions/deletions for a single commit via the REST API.
 * Only called for direct-to-main commits (i.e. not in any merged PR).
 * The set of these is small by design (spec §5).
 *
 * Commits that exceed CONFIG.dataOnlyLocThreshold and whose additions are
 * ≥ CONFIG.dataOnlyRatioThreshold data-extension lines are excluded from
 * LOC totals — they represent corpus/data imports, not code authorship.
 */
async function fetchCommitStats(owner, name, sha) {
  try {
    const data     = await restGet(`/repos/${owner}/${name}/commits/${sha}`);
    const additions = data.stats?.additions ?? 0;
    const deletions = data.stats?.deletions ?? 0;

    // Data-only exclusion: large commits that are predominantly data files.
    if (CONFIG.dataOnlyLocThreshold > 0 && additions > CONFIG.dataOnlyLocThreshold && data.files?.length) {
      const files      = data.files;
      const truncated  = files.length === 300;  // GitHub hard-caps files[] at 300
      const dataAdds   = files
        .filter(f => DATA_EXTENSIONS.has(fileExt(f.filename)))
        .reduce((sum, f) => sum + (f.additions ?? 0), 0);
      const ratio      = additions > 0 ? dataAdds / additions : 0;

      // (b) Truncated list + very large commit: ratio is unreliable, apply absolute cap.
      if (truncated && additions > CONFIG.dataOnlyAbsoluteCap) {
        console.log(`    skip data-only ${sha.slice(0, 7)} (+${additions.toLocaleString()} lines, files[] truncated at 300)`);
        return { additions: 0, deletions: 0 };
      }

      // (a) Ratio check on the visible files.
      if (ratio >= CONFIG.dataOnlyRatioThreshold) {
        console.log(`    skip data-only ${sha.slice(0, 7)} (+${additions.toLocaleString()} lines, ${Math.round(ratio * 100)}% data files)`);
        return { additions: 0, deletions: 0 };
      }
    }

    return { additions, deletions };
  } catch (err) {
    console.warn(`  WARN: skipping LOC for ${sha.slice(0, 7)} — ${err.message}`);
    return { additions: 0, deletions: 0 };
  }
}

/**
 * Fetches the language byte-breakdown for a repo via REST.
 * Returns { [language]: bytes }. Used only for the aggregate language donut —
 * no repo name is ever associated with this in the output.
 */
async function fetchLanguages(owner, name) {
  try {
    return await restGet(`/repos/${owner}/${name}/languages`) ?? {};
  } catch {
    return {};
  }
}

// ── Alias assignment ──────────────────────────────────────────────────────────

const ADJECTIVES = [
  'Amber','Ancient','Astral','Autumn','Brave','Bright','Brisk','Calm','Careful',
  'Cheerful','Clever','Cloudy','Cozy','Crispy','Cryptic','Dapper','Daring','Dazzling',
  'Dizzy','Dreamy','Drifting','Dusty','Electric','Fancy','Feisty','Fierce','Fluffy',
  'Foggy','Frosty','Fuzzy','Gentle','Giddy','Gilded','Glacial','Gleaming','Grumpy',
  'Happy','Hazy','Hollow','Humble','Icy','Jolly','Jumpy','Lanky','Lazy','Lofty',
  'Lucky','Lunar','Luminous','Misty','Mossy','Murky','Mystic','Nimble','Noble',
  'Peppy','Phantom','Plucky','Proud','Quiet','Quirky','Radiant','Regal','Restless',
  'Rustic','Sassy','Serene','Shaggy','Shiny','Silly','Sleepy','Sneaky','Snowy',
  'Spicy','Spooky','Stormy','Sturdy','Swift','Tangy','Timid','Turbulent','Twilight',
  'Wandering','Whimsy','Wild','Wily','Windy','Witty','Wobbly','Woolly','Zesty',
];

const ANIMALS = [
  'Aardvark','Albatross','Alligator','Alpaca','Armadillo','Axolotl','Badger','Bat',
  'Bear','Beaver','Bison','Boar','Bumblebee','Capybara','Cassowary','Chameleon',
  'Cheetah','Chinchilla','Chipmunk','Cobra','Cormorant','Coyote','Crane','Crocodile',
  'Crow','Dingo','Dolphin','Dragonfly','Duck','Eagle','Echidna','Elephant','Elk',
  'Falcon','Ferret','Finch','Flamingo','Fox','Frog','Gecko','Gibbon','Giraffe',
  'Gnu','Gorilla','Hamster','Hedgehog','Heron','Hippo','Hornet','Hummingbird',
  'Hyena','Ibis','Iguana','Jackal','Jaguar','Jellyfish','Kangaroo','Kestrel',
  'Kingfisher','Kiwi','Koala','Komodo','Lemur','Leopard','Llama','Lobster','Lynx',
  'Manatee','Meerkat','Mongoose','Monkey','Moose','Narwhal','Newt','Octopus',
  'Opossum','Orca','Osprey','Ostrich','Otter','Owl','Panda','Panther','Parrot',
  'Pelican','Penguin','Platypus','Porcupine','Puffin','Quokka','Raccoon','Raven',
  'Rhinoceros','Salamander','Seahorse','Skunk','Sloth','Snail','Squid','Squirrel',
  'Stingray','Stork','Tapir','Toucan','Vulture','Walrus','Warthog','Weasel',
  'Wolf','Wolverine','Wombat','Yak','Zebra',
];

// Deterministic hash — same string always produces the same number.
function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = Math.imul(h, 31) + str.charCodeAt(i) | 0;
  return Math.abs(h);
}

/**
 * Assigns fun animal-adjective aliases ("Sleepy Penguin", "Brave Axolotl", …)
 * to repo nameWithOwners. Each repo hashes to a stable slot in the
 * adjective×animal grid; collisions are resolved by linear probing in
 * sorted order. No mapping is ever serialized to the output (spec §3.1).
 */
function assignAliases(nameWithOwners) {
  const total  = ADJECTIVES.length * ANIMALS.length;  // 90 × 110 = 9,900 combos
  const used   = new Set();
  const map    = new Map();
  // Sort so collision-probing order is deterministic regardless of input order.
  const sorted = [...nameWithOwners].sort();
  for (const nwo of sorted) {
    let idx = stableHash(nwo) % total;
    while (used.has(idx)) idx = (idx + 1) % total;
    used.add(idx);
    map.set(nwo, `${ADJECTIVES[Math.floor(idx / ANIMALS.length)]} ${ANIMALS[idx % ANIMALS.length]}`);
  }
  return map;
}

// ── Summation helpers ─────────────────────────────────────────────────────────

function addBucket(target, src) {
  target.issuesOpened   += src.issuesOpened;
  target.issuesClosed   += src.issuesClosed;
  target.commits        += src.commits;
  target.prsMerged      += src.prsMerged;
  target.locAdded       += src.locAdded;
  target.locRemoved     += src.locRemoved;
  target.locAddedViaPR  += src.locAddedViaPR;
  target.locAddedDirect += src.locAddedDirect;
}

function bucketsToTotals(weekMap) {
  const t = emptyTotals();
  for (const b of weekMap.values()) {
    t.issuesOpened += b.issuesOpened;
    t.issuesClosed += b.issuesClosed;
    t.commits      += b.commits;
    t.prsMerged    += b.prsMerged;
    t.locAdded     += b.locAdded;
    t.locRemoved   += b.locRemoved;
  }
  return t;
}

// ── Existing stats loader (delta mode) ───────────────────────────────────────

async function loadExisting(outPath) {
  try {
    return JSON.parse(await readFile(outPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Recompute global totals by summing every week in a series array. */
function seriesToTotals(series) {
  const t = emptyTotals();
  for (const w of series) {
    t.issuesOpened += w.issuesOpened ?? 0;
    t.issuesClosed += w.issuesClosed ?? 0;
    t.commits      += w.commits      ?? 0;
    t.prsMerged    += w.prsMerged    ?? 0;
    t.locAdded     += w.locAdded     ?? 0;
    t.locRemoved   += w.locRemoved   ?? 0;
  }
  return t;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const outDir  = join(ROOT, 'data');
  const outPath = join(outDir, 'stats.json');

  // Delta mode: load existing data and set the fetch window to start from the
  // beginning of the week in which the last run occurred. This ensures the
  // current (partial) week is always re-fetched and merged, while weeks before
  // it are left untouched — no re-fetching historical data.
  let existing = null;
  if (DELTA_MODE || TARGET_REPOS.length) {
    existing = await loadExisting(outPath);
    if (!existing && DELTA_MODE) {
      console.warn('WARN: --delta requested but no existing stats.json found — running full collection.');
    }
  }

  const { from: fullFrom, to } = windowBounds();
  const deltaFrom = existing
    ? (() => { const d = new Date(weekOf(existing.generatedAt)); return d; })()
    : null;
  const from = (DELTA_MODE && deltaFrom) ? deltaFrom : fullFrom;

  const fromISO  = from.toISOString();
  const fromDate = from.toISOString().slice(0, 10);
  const toDate   = to.toISOString().slice(0, 10);
  const weeks    = buildWeeks(from, to);

  const modeLabel = TARGET_REPOS.length ? `[targeted: ${TARGET_REPOS.join(', ')}]`
                  : DELTA_MODE          ? '[delta]'
                  :                       '[full]';
  console.log(`engsys dashboard collector ${modeLabel}`);
  console.log(`Window : ${fromDate} → ${toDate}  (${weeks.length} weeks)${existing ? `  (last run: ${existing.generatedAt.slice(0,10)})` : ''}`);
  const aliasNote = EXTRA_LOGINS.length ? `  (+ ${EXTRA_LOGINS.join(', ')})` : '';
  console.log(`Login  : ${CONFIG.login}${aliasNote}`);
  console.log(`Owners : ${CONFIG.owners.map(o => o.name).join(', ')}\n`);

  // ── 1. Enumerate repos ─────────────────────────────────────────────────────
  console.log('Enumerating repos…');
  const allRepos = [];
  for (const owner of CONFIG.owners) {
    const repos = await getRepos(owner);
    console.log(`  ${owner.name}: ${repos.length} eligible repos`);
    allRepos.push(...repos);
  }
  // Apply --repo filter if specified.
  const reposToCollect = TARGET_REPOS.length
    ? allRepos.filter(r => TARGET_REPOS.includes(r.nameWithOwner.toLowerCase()))
    : allRepos;
  if (TARGET_REPOS.length) {
    const found = reposToCollect.map(r => r.nameWithOwner);
    const missing = TARGET_REPOS.filter(t => !found.map(f => f.toLowerCase()).includes(t));
    if (missing.length) console.warn(`  WARN: repos not found: ${missing.join(', ')}`);
  }
  console.log(`Total: ${reposToCollect.length}${TARGET_REPOS.length ? ` (targeted, of ${allRepos.length})` : ''} repos\n`);

  // ── 2. Collect per-repo data ───────────────────────────────────────────────
  console.log('Collecting activity…');
  const activeRepos = []; // { nameWithOwner, totals, weekMap }

  for (const repo of reposToCollect) {
    const [owner, name] = repo.nameWithOwner.split('/');
    const branch        = repo.defaultBranchRef.name;

    process.stdout.write(`  ${repo.nameWithOwner} …`);

    // Per-repo week map (keyed by 'YYYY-MM-DD' Monday dates)
    const weekMap = new Map(weeks.map(w => [w, emptyBucket()]));

    // ── issues opened in window by CONFIG.login ──
    const opened = await fetchOpenedIssues(owner, name, fromISO);
    for (const issue of opened) {
      const b = weekMap.get(weekOf(issue.createdAt));
      if (b) b.issuesOpened++;
    }

    // ── issues closed in window by CONFIG.login ──
    const closedDates = await fetchClosedByMe(owner, name, fromISO);
    for (const date of closedDates) {
      const b = weekMap.get(weekOf(date));
      if (b) b.issuesClosed++;
    }

    // ── merged PRs: counts + LOC + PR commit SHA collection ──
    const mergedPRs = await fetchMergedPRs(owner, name, fromISO);
    const prShaSet  = new Set();

    for (const pr of mergedPRs) {
      const b = weekMap.get(weekOf(pr.mergedAt));
      if (b) {
        b.prsMerged++;
        b.locAdded      += pr.additions;
        b.locRemoved    += pr.deletions;
        b.locAddedViaPR += pr.additions;
      }
      // Collect all SHAs associated with this PR to exclude from direct-push set
      if (pr.mergeCommit?.oid) prShaSet.add(pr.mergeCommit.oid); // squash/merge SHA on main
      for (const node of pr.commits.nodes) prShaSet.add(node.commit.oid); // branch commits
    }

    // ── commits on default branch ──
    const mainCommits   = await fetchMainCommits(owner, name, branch, fromISO);

    // Direct pushes = on-main commits NOT associated with any merged PR (spec §5)
    const directCommits = mainCommits.filter(c => !prShaSet.has(c.oid));

    // Daily commit counts (for the contribution heatmap) — keyed YYYY-MM-DD.
    // authoredDate reflects when the work was done (committedDate can shift on rebase).
    const dayCounts = {};
    for (const commit of mainCommits) {
      const b = weekMap.get(weekOf(commit.committedDate));
      if (b) b.commits++;
      const day = (commit.authoredDate ?? commit.committedDate).slice(0, 10);
      dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    }

    // ── LOC for direct pushes (REST per-commit stats) ──
    // This set is small by design; kept proportional to direct-push frequency.
    // 500ms between calls = ~2 req/s, well under GitHub's secondary rate limit.
    for (const commit of directCommits) {
      await sleep(DIRECT_LOC_SLEEP_MS);
      const { additions, deletions } = await fetchCommitStats(owner, name, commit.oid);
      const b = weekMap.get(weekOf(commit.committedDate));
      if (b) {
        b.locAdded       += additions;
        b.locRemoved     += deletions;
        b.locAddedDirect += additions;
      }
    }

    // ── record if any activity found ──
    const totals     = bucketsToTotals(weekMap);
    const hasActivity = Object.values(totals).some(v => v > 0);
    process.stdout.write(` ${hasActivity
      ? `${totals.commits}c ${totals.prsMerged}pr ${totals.locAdded}+`
      : 'quiet'}\n`);

    if (hasActivity) {
      // Language bytes — only fetched for repos with activity (keeps REST calls down).
      const languages = await fetchLanguages(owner, name);
      activeRepos.push({ nameWithOwner: repo.nameWithOwner, totals, weekMap, daily: dayCounts, languages });
    }
  }

  // ── 3. Assign opaque aliases (no names in output) ─────────────────────────
  // Each repo gets a stable _id (hash of nwo) stored in stats.json so we can
  // match repos across runs without ever persisting the actual name.
  function repoId(nwo) {
    return stableHash(nwo).toString(16).padStart(8, '0');
  }

  // Recover alias assignments from existing data via _id, then assign fresh
  // aliases (from full aliasMap) for any repo not seen before.
  const existingIdToAlias = new Map(
    (existing?.perRepo ?? []).filter(r => r._id).map(r => [r._id, r.alias])
  );
  // Build a full aliasMap for all active repos so new repos get consistent aliases.
  const fullAliasMap = assignAliases(activeRepos.map(r => r.nameWithOwner));
  const aliasMap = new Map(activeRepos.map(r => [
    r.nameWithOwner,
    existingIdToAlias.get(repoId(r.nameWithOwner)) ?? fullAliasMap.get(r.nameWithOwner),
  ]));

  // ── 4. Build this-run perRepo entries (include weekly series) ─────────────
  const runPerRepo = activeRepos.map(r => ({
    _id:    repoId(r.nameWithOwner),   // persisted for stable matching; not a name
    alias:  aliasMap.get(r.nameWithOwner),
    totals: r.totals,
    series: weeks.map(w => ({ weekStart: w, ...r.weekMap.get(w) })),
    daily:  r.daily,                   // { 'YYYY-MM-DD': commitCount } — heatmap source
    languages: r.languages,            // { language: bytes } — donut source
  }));

  // ── 5. Merge into existing (delta / targeted / full) ──────────────────────
  let finalPerRepo;

  if (existing && (DELTA_MODE || TARGET_REPOS.length)) {
    // Key existing entries by _id (preferred) or alias (older format without _id).
    const repoMap = new Map(existing.perRepo.map(r => [r._id ?? r.alias, { ...r }]));

    if (TARGET_REPOS.length) {
      // Targeted: replace only the collected repos; leave all others intact.
      for (const rr of runPerRepo) {
        repoMap.set(rr._id, rr);
      }
    } else {
      // Delta: splice new weeks into each repo's series; add unseen repos.
      const deltaWeekStart = fromDate;
      for (const rr of runPerRepo) {
        const key = rr._id;
        if (repoMap.has(key)) {
          const ex = repoMap.get(key);
          const keptOld = (ex.series ?? []).filter(w => w.weekStart < deltaWeekStart);
          // Daily: keep old days before the delta window; the freshly-collected
          // days (all ≥ deltaWeekStart) replace anything in the current window.
          const keptDays = Object.fromEntries(
            Object.entries(ex.daily ?? {}).filter(([d]) => d < deltaWeekStart)
          );
          repoMap.set(key, {
            ...rr,
            series: [...keptOld, ...rr.series],
            daily:  { ...keptDays, ...rr.daily },
          });
        } else {
          repoMap.set(key, rr);
        }
      }
    }
    finalPerRepo = [...repoMap.values()];
  } else {
    finalPerRepo = runPerRepo;
  }

  // ── 6. Rebuild global series ───────────────────────────────────────────────
  console.log(`\nActive repos: ${activeRepos.length} / ${allRepos.length}`);

  // Only rebuild from per-repo series when ALL repos have series data.
  // If any are missing (old format, or partial targeted run before a full run),
  // fall back to the existing global series so we don't wipe historical data.
  const allHaveSeries = finalPerRepo.every(r => r.series?.length > 0);
  let finalSeries;

  if (allHaveSeries) {
    const allWeekStarts = [...new Set(finalPerRepo.flatMap(r => r.series.map(w => w.weekStart)))].sort();
    const globalWeekMap = new Map(allWeekStarts.map(w => [w, emptyBucket()]));
    for (const repo of finalPerRepo) {
      for (const w of repo.series) {
        const g = globalWeekMap.get(w.weekStart);
        if (g) addBucket(g, w);
      }
    }
    finalSeries = allWeekStarts.map(w => ({ weekStart: w, ...globalWeekMap.get(w) }));
  } else {
    // Per-repo series not yet fully established — keep existing global series intact.
    // Run a full collection (no flags) to establish per-repo series, after which
    // targeted and delta runs will update the global series accurately.
    if (existing?.series) {
      console.warn('WARN: some repos lack per-repo series — keeping existing global series.');
      console.warn('      Run without flags for a full collection to enable accurate merges.');
    }
    finalSeries = existing?.series ?? weeks.map(w => ({ weekStart: w, ...emptyBucket() }));
  }

  // ── 7. Build and write output ──────────────────────────────────────────────
  const finalTotals = seriesToTotals(finalSeries);
  const windowFrom  = existing?.window?.from ?? fromDate; // preserve original bootstrap start

  // Per-repo totals are a DERIVED projection of per-repo series — never merged
  // independently (delta/targeted merges would otherwise drift them out of sync
  // with the series, as the global totals stay correct). Recompute from series
  // whenever a series exists; fall back to any stored totals only for the rare
  // old-format entry that has no series.
  for (const r of finalPerRepo) {
    if (r.series?.length) r.totals = seriesToTotals(r.series);
  }

  // Global daily commit counts (heatmap) and language bytes (donut) are DERIVED
  // by summing across per-repo entries — same model as totals/series, so
  // delta/targeted merges stay consistent. Neither leaks a repo name.
  const globalDaily = {};
  const globalLanguages = {};
  for (const r of finalPerRepo) {
    for (const [day, n] of Object.entries(r.daily ?? {})) {
      globalDaily[day] = (globalDaily[day] ?? 0) + n;
    }
    for (const [lang, bytes] of Object.entries(r.languages ?? {})) {
      globalLanguages[lang] = (globalLanguages[lang] ?? 0) + bytes;
    }
  }
  // Sort daily by date and languages by descending bytes for stable, readable output.
  const daily = Object.fromEntries(Object.entries(globalDaily).sort(([a], [b]) => a < b ? -1 : 1));
  const languages = Object.fromEntries(Object.entries(globalLanguages).sort(([, a], [, b]) => b - a));

  const output = {
    generatedAt: new Date().toISOString(),
    window: { from: windowFrom, to: toDate, bucket: 'week' },
    // NOTE: no owner/repo names appear below this point (privacy, spec §3.1)
    repoCount: finalPerRepo.length,
    totals: finalTotals,
    series: finalSeries,
    daily,        // { 'YYYY-MM-DD': commits } across all repos — contribution heatmap
    languages,    // { language: bytes } across all repos — language donut
    // Strip internal _nwo field before serializing — never write repo names to output.
    perRepo: finalPerRepo.map(({ _nwo: _, ...rest }) => rest),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nWrote ${outPath}`);
  console.log('Global totals:');
  for (const [k, v] of Object.entries(finalTotals)) console.log(`  ${k}: ${v}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
