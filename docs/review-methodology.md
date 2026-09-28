# Review methodology: paired reviewers, honest verification, measured decisions

**Audience:** anyone wiring a local code reviewer into an agent workflow, running a second reviewer
alongside the first, or deciding whether one reviewer should replace another.
**Companions:** the `code-review` skill (`core/skills/code-review/`, the daily workflow), the wrapper
template `core/templates/review/review.sh.tmpl`, and the scorer `core/scripts/review-bakeoff.mjs`.

This document is the *why* and the *rules*. It is provider-neutral: a "reviewer" is any command that
reads a diff and emits findings, whether that is a vendor CLI, an in-house LLM pipeline, or an engsys
worker run (`core/scripts/worker-run.mjs`). Nothing here depends on which.

Two reviewers are called **reviewer-a** and **reviewer-b** below, and their PR comments carry the
markers `<!-- review-a -->` and `<!-- review-b -->`. Use whatever names you like; the tooling takes the
markers as options.

## 1. Gate and advisory

Run more than one reviewer on the same diff and give them different jobs:

| Role | Blocks a push? | Job |
| --- | --- | --- |
| **Gate** | Yes. Its Critical and Warning findings must be resolved, and its exit code is the wrapper's exit code. | The reviewer you trust today. |
| **Advisory** | **Never.** | The candidate you are evaluating. Fix what is obviously real, note the rest, and do not grind. |

The rule that makes a bake-off possible: **an advisory reviewer never blocks.** If it could block, you
would tune your behaviour around its noise, and the data you collect would measure your workarounds
instead of the reviewer. It follows that an advisory reviewer that fails to run (credentials, quota, a
timeout) degrades to a warning and the flow continues. It also follows that only one reviewer gates at a
time; promoting the candidate to gate is a decision (section 8), not a default.

"Advisory" is not "ignore". An advisory reviewer's Critical findings deserve a read against the code.
Each review layer catches a different class of bug (see
[each-review-layer-catches-a-different-bug-class](../lessons-library/each-review-layer-catches-a-different-bug-class.md)),
and the candidate is often catching exactly the class the gate is blind to. That is the reason to run it.

`core/templates/review/review.sh.tmpl` implements this pairing (section 9).

## 2. Generate, then verify (and only demote)

An LLM reviewer produces candidate findings and its false positives are the cost of using it. A second
pass that adjudicates each candidate against the real code can cut that noise. The rules below are the
ones that keep the second pass from doing more harm than good.

**The verify pass may only demote.** For each candidate it returns one of two verdicts:

- **confirmed**: the finding keeps its severity;
- **refuted**: the finding is *demoted* (severity lowered to info, flagged `unconfirmed`) and the
  verifier's one-line reason is rendered next to it.

It never deletes a finding. Three reasons:

1. **A verifier is wrong sometimes, and deletion is unrecoverable.** A demoted real finding is still on
   the page at the bottom; a deleted one is gone. A wrong "false" that buries a defect is far more
   expensive than a wrong "real" that costs the author a minute.
2. **Deletion can leave a self-contradicting review.** A summary that describes the defects above an
   empty findings list is what a delete-mode verifier produces.
3. **The bake-off needs the signal.** Demoted findings are how you measure the verifier itself: label
   one true and you have found a verifier error. If demoted findings vanish, you cannot tell a good
   verifier from a destructive one. The scorer counts them (`Demoted but labelled true positive`).

Rules for the verifier's prompt and its plumbing:

- A "false" verdict must **cite the specific thing that neutralizes the finding**: the guard at a named
  `path:line`, the type that makes the state unrepresentable, the caller that already handles it. "Seems
  handled" and "unlikely in practice" are not refutations.
- **When the investigation is inconclusive, the finding stands.** The generator already investigated;
  unresolved doubt is not evidence against it.
- **Require exactly one verdict per candidate**, by index. If verdicts are missing, duplicated,
  out of range or unparseable, **fail open**: keep every finding, undemoted, and say so in the output.
  A partial verdict list must never silently drop a finding, and a conflicting duplicate must never
  silently keep one.
- **Treat the diff and the candidate findings as untrusted data** when passing them to the verifier
  (both are influenced by model or attacker text). See `core/lib/untrusted.mjs`.

**Never use a verifier weaker than the generator.** A weaker adjudicator vetoing a stronger generator
inverts the quality gradient: the model least able to see the bug decides whether it is real. The
failure is quiet, because the review still looks calibrated. If cost is the concern, turn verification
*off* (a single strong pass) rather than down. A verifier at least as strong as the generator, or none.

Enforce this in configuration, not in a comment: compare the two model settings at startup and refuse to
run when the verifier ranks below the generator.

## 3. Fail loudly on truncation

A model response that stopped for any reason other than a clean stop is not a review. Typical causes are
an output-token cap (`finish_reason` of `length`, or a Responses-style `status: incomplete` with reason
`max_output_tokens`), a content filter, or a failed response. Reasoning models make the first one
worse: hidden reasoning tokens count against the cap, so a capped response can arrive with the findings
block cut off mid-JSON, or with no visible output at all.

The dangerous failure is a parser that turns that into **"zero findings"**. Every downstream reader then
sees a clean review of code that was never fully reviewed.

- Check the stop reason on **every** model call in the loop, the tool-calling turns as well as the final
  answer. A truncated tool-call turn derails the loop just as a truncated answer does.
- Anything other than a clean, completed stop **throws**, with the knob to turn (raise the output cap).
- Still account for the tokens that were consumed before throwing; a truncated call cost money.
- A missing or malformed findings block is an error state, not an empty list. The same holds in the
  consumer: the bake-off scorer excludes a comment whose findings block does not parse instead of
  counting it as "no findings".
- The only valid "no findings" is an explicit, parseable, empty findings array.

Give the reviewer output-cap headroom sized for reasoning plus a full findings block, not the default
sized for a short brief.

## 4. Structured findings

Have the reviewer emit findings through a **schema-enforced channel** (a tool call, or a response schema)
rather than asking for JSON in prose. Prompt-policed formatting drifts: fences appear, prose creeps in,
fields go missing. See
[prefer-tool-enforced-structured-output](../lessons-library/prefer-tool-enforced-structured-output.md)
and, for what to do when you cannot enforce it,
[llm-judge-parse-defensively-and-start-advisory](../lessons-library/llm-judge-parse-defensively-and-start-advisory.md).

Minimum schema for one finding:

| Field | Type | Notes |
| --- | --- | --- |
| `file` | string, required | Repo-relative path. The matching key for everything downstream. |
| `line` | integer, optional | Zero is valid; test for presence, not truthiness. |
| `severity` | `critical` \| `warning` \| `info` | The gate blocks on the first two. |
| `category` | enum | For example `bug`, `security`, `correctness`, `api-misuse`, `convention`, `performance`, `test-gap`. |
| `title` | string, short | One line. The scorer compares titles across reviewers. |
| `rationale` | string | Why it is a defect, in this code. |
| optional | `suggestion`, `confidence`, `unconfirmed`, `verifierReason` | `confidence` (high, medium, low) is report-with-confidence rather than drop-when-unsure: a "leave it out when unsure" instruction suppresses exactly the judgment-shaped findings that a deep review exists to find. |

Order the comment's content so the machine-readable block comes **last** (section 5, rule 4).

## 5. Marker comments

Each reviewer keeps exactly one PR comment, edited in place on re-runs, identified by a hidden HTML
marker on its first line. Several reviewers often share one PR and sometimes one identity, so the
protocol needs rules. They come from a live bug in which one reviewer's comment merely *mentioned*
another's marker in prose, was matched by a substring test, and was overwritten. The general rule is
recorded in
[match-marker-comments-by-leading-position-and-author](../lessons-library/match-marker-comments-by-leading-position-and-author.md)
(added in v1.2.0). Summary:

1. **One unique marker per reviewer**, emitted as line 1 of the comment (`<!-- review-a -->`).
2. **Match by leading position, never `includes()`.** `body.trimStart().startsWith(MARKER)`. A comment
   that discusses the marker in its prose, in backticks or in a quoted doc must not match.
3. **Upsert only comments the authenticated identity authored.** Compare the comment author (or the API's
   "viewer did author" flag). If only foreign marker-bearing comments exist, create your own; never patch
   theirs. If several of your own exist, update the oldest and warn about the extras.
4. **Neutralize delimiters in model-authored text** (`<!--`, `-->`, `--!>`) before rendering it into a
   marked comment, so injected text cannot forge a marker or terminate the comment. Append your own
   machine block **last** and parse the **last** occurrence, so a forged earlier block never wins.
5. **Never `gh pr comment --edit-last`** on a PR where any other script posts under the same identity.
   "Your last comment" is not yours. Resolve the comment id by marker and author, then PATCH that id.
6. In prose about a marker (docs, comments), name it without the full delimiter syntax if an older matcher
   could still see it.

The scorer applies the same matching when it harvests (leading position, optional author filter).

## 6. A review is valid for one commit

A verdict belongs to a commit, not to "the PR". A commit pushed after the review is unreviewed code, and
a CI result computed for an older head does not cover it. See
[review-and-ci-are-per-commit-not-per-pr](../lessons-library/review-and-ci-are-per-commit-not-per-pr.md).

- **Every posted review names the SHA (or range) it covered.** Put it in the machine block
  (`"sha": "<full or short sha>"`) and a human line (`Reviewed commit: 1a2b3c4`). The wrapper exports the
  current head as `REVIEW_HEAD_SHA` for this purpose.
- **An appended commit invalidates the sign-off.** Re-run the reviewers, or re-review
  `git diff <reviewed-sha>..HEAD`, and require a fresh CI run for the new head.
- After a rebase, carry a verdict forward by **evidence**, not assertion: `git range-diff` with every row
  `=`, or a hash of the diff.
- Always review against the freshly fetched remote base (`origin/main`), never a local branch that may be
  stale. A stale base reviews every upstream commit you do not have, and it silently invalidates the review.
  The wrapper treats a failed fetch as fatal for this reason.

The bake-off scorer reads each comment's SHA and compares it to the PR head. Stale reviews are flagged, and
`--strict-sha` excludes them so the two reviewers are compared on the same code.

## 7. The bake-off: decide with data

To choose between reviewers, or to decide whether a candidate earns the gate, measure. Intuition about
which reviewer "feels" better is dominated by the last memorable bug.

**Collect passively, on real work.** Run both reviewers on every branch (the wrapper does this). Each PR
that merges then carries a labelled pair: one comment per marker. There is no separate benchmark to
maintain and no replay to run; the corpus is your actual pull requests.

**Harvest.** For a repository and a date range or PR list, gather each PR's marker-A and marker-B comment,
with the comment author and the PR head SHA:

```bash
node core/scripts/review-bakeoff.mjs harvest --repo owner/repo \
  --since 2026-09-01 --until 2026-09-28 \
  --marker-a '<!-- review-a -->' --marker-b '<!-- review-b -->' \
  --author-a acme-bot-a --author-b acme-bot-b --out golden.json
# or an explicit list:  --prs 41,44,52
```

`gh` must be authenticated; harvest is read-only. A `gh` failure aborts the run rather than producing a
short list.

**Score.** Parse each comment's findings, pair them across reviewers, and report:

```bash
node core/scripts/review-bakeoff.mjs score golden.json --labels labels.json \
  --md report.md --json report.json
```

| Measure | Meaning |
| --- | --- |
| Overlap | Findings raised by both, as a share of the union. Agreement, not correctness. |
| Unique findings | Each reviewer's findings the other did not raise. These are the adjudication queue. |
| Precision | Labelled true positives divided by labelled findings, per reviewer. The make-or-break metric: a reviewer whose findings are mostly wrong trains people to ignore it. |
| Recall against the gate | The share of the gate's findings the candidate also raised. Only meaningful as a parity check on the severities that block. |
| Unique true positives | Labelled-true findings only that reviewer raised. This is what switching would gain. |
| Cost per useful finding | Reported cost divided by labelled true positives. Needs `costUsd` in the review's data block. |
| Demoted but true | Findings the verify pass demoted that an operator labelled true. Measures the verifier. |

**Matching.** Two findings are the same when the file matches (a shorter path suffix is tolerated), the
lines are within a tolerance (default 3; a missing line is a wildcard), and the normalized title
similarity clears a threshold (default 0.25; a missing title is a wildcard). Matching is greedy one to one,
best pairs first. Tune with `--line-tolerance` and `--min-title-similarity`, and do not tune to flatter
either reviewer.

**Labels are human.** Overlap tells you where the reviewers differ. Only an operator can say which side
was right, and the gate's silence is not ground truth (it misses things too, which is partly why you are
running the bake-off). The report prints a stable `key` under every finding; label them in a JSON file:

```json
[
  { "prId": 41, "findingKey": "src/api/guard.ts:40:missing-authorization-check-delete-route", "verdict": "true-positive" },
  { "prId": 41, "findingKey": "src/util/name.ts:7:naming-inconsistent", "verdict": "false-positive" }
]
```

`verdict` is `true-positive` (also `tp`, `true`, `real`), `false-positive` (`fp`, `false`) or `unsure`. An
optional `"reviewer": "a"` or `"b"` restricts a label when both reviewers happen to share a key. A label
on either side of a matched pair covers the pair. A label that matches no finding is reported, because a
typo there silently changes the result.

**Decide against thresholds you set beforehand.** Write the switch criterion down before the data
arrives, so it cannot bend to the result. An example, to adapt rather than copy: over at least 30 PRs,
candidate precision of at least 0.8 on Critical and Warning, recall against the gate of at least 0.9 on
those severities, and non-negative net-new true positives. Until then keep both; the second reviewer is
cheap insurance. Use `--min-severity warning` to score only what blocks.

### What the scorer reads

A reviewer needs to emit **one** of these in its comment.

**Machine block (preferred).** The last fenced `json` block, or the last `<!-- review-data {...} -->`
comment. It holds an array of findings or an object:

```json
{
  "sha": "1a2b3c4d5e6f",
  "costUsd": 0.31,
  "findings": [
    { "file": "src/api/guard.ts", "line": 40, "severity": "critical", "category": "security",
      "title": "Missing authorization check on delete route", "rationale": "…" }
  ]
}
```

Only `file` is required for matching. `unconfirmed: true` and `verifierReason` record a demotion. An
empty `findings` array is a definitive "no findings".

**Fallback list.** One bullet per finding, so a plain-markdown reviewer needs no JSON:

```markdown
Reviewed commit: 1a2b3c4d5e6f

- [WARNING] src/jobs/queue.ts:12 — Race between claim and start
- **[CRITICAL] Missing authorization check on delete route** — `src/api/guard.ts:40` _(security)_
```

Severity tag in square brackets, a location as `path` or `path:line`, then the title. Backticks and bold
are accepted, and a trailing `_(category)_` is read as the category. `[INFO·unconfirmed]` marks a demotion.

**Failure handling.** A machine block that does not parse, a finding with no `file`, or a comment that
lists severity-tagged bullets but no locations is reported **unscoreable** and excluded. It is never read
as "no findings". Score those PRs by hand. Unpaired PRs (only one reviewer commented) are counted but not
scored.

## 8. When the candidate wins

The bake-off ends in one of three outcomes: keep both (the default while the data is thin), promote the
candidate to gate and keep the old one as advisory for a period, or retire the candidate. Promotion is a
configuration change to the wrapper, not a code change. Keep the demote-only verifier and the marker
protocol either way. They are properties of a good review pipeline and not of the bake-off.

## 9. The wrapper

`core/templates/review/review.sh.tmpl` runs both reviewers as one deliberate command. It is a template you
copy into the repository (`scripts/review.sh`) and configure in a marked block at the top:

- `GATE_CMD`, `ADVISORY_CMD` (empty skips the advisory half), `BASE_REF` (default `origin/main`),
  `ADVISORY_POST_FLAG` (default `--post`).
- **`git fetch` first, and a failure is fatal.** A stale base invalidates both reviews.
- **The gate's exit code is the script's exit code.** The advisory reviewer runs afterwards on the same base
  and cannot change the result.
- **`--post` is passed to the advisory reviewer only when the branch has a PR.** The check uses
  `gh pr view` and distinguishes "no pull requests found" from every other `gh` error (authentication,
  network, not a repository). The other errors are surfaced as a warning, not misread as "no PR yet".
- The advisory command failing to run produces a warning and never blocks.

Invoke it on purpose, before the push that opens or updates the PR. Do not wire it into a pre-push hook: a
multi-minute review would tax every push. Reviewers that are engsys worker runs fit directly, since
`worker-run.mjs` already exits `0` (clean), `1` (findings) or `2` (did not run), and a `2` is never a pass.
The wrapper treats any non-zero gate exit as blocking.

## 10. Checklist

- One reviewer gates; every other reviewer is advisory and never blocks.
- The verify pass demotes and never deletes; the verifier is at least as strong as the generator.
- Any stop other than a clean one is an error; a missing findings block is not "no findings".
- Findings come through a schema-enforced channel: file, line, severity, category, title, rationale.
- One unique marker per reviewer; match by leading position and author; upsert only your own comment.
- Every review names the commit it covered; an appended commit re-opens the review.
- The base is freshly fetched; a fetch failure aborts.
- Decide on labelled precision, overlap and cost, against thresholds written down beforehand.
