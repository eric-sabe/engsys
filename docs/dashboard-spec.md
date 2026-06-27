# Personal Activity Dashboard — Spec & Build Plan

> Status: **DRAFT spec, pre-implementation.** Charts your GitHub activity (issues,
> commits, PRs, LOC) across owned repos. Complements the engsys `index.html`.
> Author: eric-sabe. Drafted 2026-06-26.

## 1. Goal

A static, zero-backend dashboard that charts, over time and across all of your
repositories:

- Issues **opened** and **closed**
- **Commits** authored
- **PRs merged**
- **LOC added** and **LOC removed**

Hosted on GitHub Pages alongside the existing `index.html`. Data is refreshed on a
schedule by a GitHub Action that writes a pre-baked `stats.json`; the page only
draws charts. No server, no secrets in the browser.

## 2. Scope: which repositories

Configurable allowlist of **owners** (users/orgs), then enumerate repos under each
and keep those with your activity, e.g.:

- your user account (all repos)
- one or more orgs you contribute to

Org enumeration uses `organization(login).repositories`; the user account uses
`user(login).repositories`. Token needs `read:org` for org private repos.

Identity for attribution: commits/PRs/issues authored by your login (also collect
the set of commit-author emails you use, for the direct-push `git`-stats path).
The login, owner list, and email set come from the environment
(`DASHBOARD_LOGIN` / `DASHBOARD_OWNERS` / `DASHBOARD_EMAILS`) — `.env` locally,
Actions secrets in CI — so no personal details live in the public source.

## 3. Key decisions to lock before building

1. **Data privacy / where it lives.** ✅ **RESOLVED:** stays in the public `engsys`
   repo. Aggregate activity numbers (issues/commits/PRs/LOC, totals + time series)
   are acceptable to publish. **Hard constraint: no repo names may appear in the
   published output.** This means:
   - `perRepo` entries use **opaque aliases** (`Repo A`, `Repo B`, …), never
     `nameWithOwner`. The alias↔real-name mapping is **never written** to `stats.json`.
   - Org/owner names and your login are likewise **omitted** from the published
     JSON — the `owners` list stays in the environment/secrets only, not in the output.
   - Issue/PR titles, branch names, and commit messages are never emitted (we only
     ever read counts and additions/deletions, so this is automatic).
   - Reminder: anyone can still see public-repo activity via your GitHub profile;
     this constraint is about not *aggregating + labeling* private-repo work.
2. **LOC source of truth.** Primary = PR `additions`/`deletions`. Supplement =
   per-commit stats for **direct-to-main** commits only (see §5). Accept that very
   old direct pushes pre-dating the window are out of scope. **Confirm PR-primary is acceptable.**
3. **Charting library.** `index.html` ships zero JS deps. Either match that
   (hand-rolled inline SVG) or pull **Chart.js via CDN** on the dashboard page only.
   **Recommendation:** Chart.js via CDN for v1 (fast), revisit hand-rolled SVG if
   you want the dashboard to be dependency-free like the landing page.
4. **History depth & buckets.** `contributionsCollection` caps at ~1 year per query;
   multi-year requires year-by-year stitching. **Recommendation:** start with
   trailing 12 months, **weekly** buckets. Extend to multi-year later.

## 4. Architecture

```
.github/workflows/dashboard.yml   (cron: daily + manual dispatch)
  └─ runs scripts/collect-stats.mjs  (Node 18+, uses GITHUB_TOKEN/PAT)
       ├─ GraphQL: enumerate repos per owner
       ├─ GraphQL: merged PRs (additions/deletions/mergedAt/commit SHAs) per repo
       ├─ GraphQL: issues authored (createdAt/closedAt/state) per repo
       ├─ GraphQL: commit history on default branch per repo
       ├─ derive direct-push SHAs = on-main MINUS PR-associated  (§5)
       ├─ REST: per-commit stats for direct-push SHAs only
       └─ writes data/stats.json
  └─ commits stats.json  (or uploads as artifact — see decision #1)

dashboard.html  (static)
  └─ fetch('data/stats.json') → render charts (Chart.js CDN or inline SVG)
```

No browser-side auth. The PAT lives only in Actions secrets.

## 5. Direct-to-main commit detection (the LOC completeness piece)

PR-based LOC misses work pushed straight to `main`. Detect those cheaply:

1. For each repo, page through **merged PRs** and collect every associated commit
   SHA (`pullRequest.commits` nodes, plus the merge/squash SHA). → `prShaSet`.
2. Page through **commits on the default branch** (`history` connection) within the
   window: collect `{sha, committedDate, author}`. → `mainCommits`.
3. **Direct pushes = `mainCommits` whose SHA ∉ `prShaSet`** and whose author matches
   your email set. Typically a small handful.
4. Only for those SHAs, fetch per-commit stats (REST `GET /repos/{o}/{r}/commits/{sha}`
   → `stats.additions/deletions`, or `git log --numstat` on a shallow clone).

**No double-counting:** PR commits are excluded from the direct set. Total LOC =
Σ(PR additions/deletions) + Σ(direct-push commit stats). Bucket each by date.

This keeps the expensive per-commit calls proportional to *direct pushes only*,
which PR discipline keeps small → rate-limit friendly.

## 6. Data model (`stats.json`)

```jsonc
{
  "generatedAt": "2026-06-26T00:00:00Z",
  "window": { "from": "2025-06-26", "to": "2026-06-26", "bucket": "week" },
  // NOTE: no owner/repo names in published output (privacy constraint, §3.1)
  "repoCount": 7,
  "totals": {
    "issuesOpened": 0, "issuesClosed": 0,
    "commits": 0, "prsMerged": 0,
    "locAdded": 0, "locRemoved": 0
  },
  "series": [
    { "weekStart": "2025-06-23",
      "issuesOpened": 0, "issuesClosed": 0,
      "commits": 0, "prsMerged": 0,
      "locAdded": 0, "locRemoved": 0,
      "locAddedViaPR": 0, "locAddedDirect": 0 }
    // ...one per week
  ],
  "perRepo": [
    { "alias": "Repo A",            // opaque label only — NEVER nameWithOwner (§3.1)
      "totals": { /* same shape as top-level totals */ } }
  ]
}
```

`locAddedViaPR` vs `locAddedDirect` split is kept so the dashboard can show how much
work bypassed PR review.

**Alias stability:** assign aliases by a deterministic order (e.g. repos sorted by
total activity descending, or alphabetical by a *hash* of the name) so `Repo A`
refers to the same repo run-to-run without ever recording which repo it is. The
real-name mapping, if ever needed for your own reference, lives only in the
collector's local memory and is never serialized.

## 7. API & rate-limit notes

- **GraphQL** (5000 points/hr): repo enumeration, PRs, issues, commit history. Each
  paginated query costs ~1 pt + node weight. Even with dozens of repos this is well
  under budget for a daily run.
- **REST** (5000 req/hr authenticated): only the direct-push per-commit stat calls.
  Small set by design.
- **Token scopes:** `repo` (read private), `read:org`, `read:user`. A fine-grained
  PAT scoped to the three owners + contents/metadata/PR/issues read is the tighter
  option.
- `contributionsCollection` is a convenient cross-repo roll-up for commit/issue/PR
  *counts*, but it does **not** carry LOC — hence the per-repo PR/commit walk.

## 8. Visual design

Match the landing page tokens (`--cyan #34e0d2`, `--violet #9d8cff`, `--amber`,
`--green`, dark `--bg #0a0e14`, mono+sans stacks). Proposed charts:

- **Stacked area / line:** LOC added vs removed over time (added = green, removed = red).
- **Grouped bars:** issues opened vs closed per week.
- **Line:** commits and PRs merged per week (dual series).
- **Stat cards** up top: trailing-12-mo totals for each metric.
- **Per-repo table** with sparkline + totals; sortable.
- Toggle: PR-LOC only vs PR+direct.

## 9. Build plan (phased)

- **Phase 0 — decisions:** resolve §3 (privacy/host, LOC source, chart lib, window).
- **Phase 1 — collector, counts only:** `scripts/collect-stats.mjs` emitting issues +
  commits + PRs merged counts → `stats.json`. Run locally with a PAT, eyeball numbers.
- **Phase 2 — LOC:** add PR additions/deletions, then direct-push detection (§5) +
  per-commit stats. Verify totals against a manual `git log --numstat` on one repo.
- **Phase 3 — dashboard.html:** static page, fetch `stats.json`, render charts in the
  engsys visual language.
- **Phase 4 — automation:** `.github/workflows/dashboard.yml` on daily cron +
  `workflow_dispatch`; wire PAT secret; commit-or-artifact per decision #1.
- **Phase 5 — polish:** per-repo table, toggles, multi-year stitching, caching of
  unchanged repos (skip repos with no new activity since last run).

## 10. Open questions

- ~~Owner types (user vs org)?~~ **Resolved: declared per-owner as `name:type` in `DASHBOARD_OWNERS`.**
- ~~"Issues closed" — yours, or anyone's?~~ **Resolved: issues *you* opened/closed**
  (you as the actor). Count `issuesOpened` by `author = your login`; `issuesClosed`
  by the close-event actor = your login (via `timelineItems` `ClosedEvent.actor`,
  not just issue state).
- Include forks / archived repos?
- Count only `main`/default-branch commits, or all branches?
- Squash-merge vs merge-commit workflow per repo (affects which SHA represents PR work).
```
