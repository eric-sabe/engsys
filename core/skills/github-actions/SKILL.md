---
name: github-actions
description: GitHub Actions workflow authoring guidance — the `${{ }}` expression function set, shell-injection and multi-line-output safety in `run:` steps, draft-gated CI triggers, and GraphQL rate-limit handling. Activate when editing `.github/workflows/*.yml`/`*.yaml`, authoring or reviewing GitHub Actions workflows, or debugging a CI gate that runs/skips unexpectedly.
---

# GitHub Actions

Practical, hard-won guidance for authoring and reviewing GitHub Actions workflows.
GitHub is the assumed code host for every project here — PRs and CI live on GitHub — so
this skill is installed everywhere. It complements core `gh-cli` (which covers `gh run`,
`gh workflow`, `gh secret` from the command line); this skill is about the workflow YAML
itself.

Each lesson below is something that **looks right but is silently wrong**: it passes
review, ships, and then fails open (a gate never runs, a value truncates, an injection
lands). Apply the review checklist at the bottom to any workflow PR.

## 1. The `${{ }}` expression language has a tiny function set

GitHub Actions expressions are **not JavaScript**. The only built-in functions are:

```text
contains  startsWith  endsWith  format  join  toJSON  fromJSON  hashFiles
```

There is **no** `toLower`, `toUpper`, `trim`, or `replace`. Typing one does not error —
the expression evaluates to an empty string **silently**, so a condition that was meant
to exclude something fails open and never excludes it.

```yaml
# ❌ WRONG — toLower() does not exist; the whole expression is "" and the guard never fires
if: ${{ !contains(toLower(github.event.pull_request.title), 'release') }}
```

Workaround A — enumerate the case variants with the functions that do exist:

```yaml
# ✅ Cover the common cases explicitly
if: |
  !startsWith(github.event.pull_request.title, 'Release') &&
  !startsWith(github.event.pull_request.title, 'release') &&
  !startsWith(github.event.pull_request.title, 'RELEASE')
```

Workaround B — do the string munging in a `run:` step (shell has real `tr`, `sed`, etc.)
and emit a normalized value as a step output, then branch on that:

```yaml
- id: norm
  env:
    TITLE: ${{ github.event.pull_request.title }}
  run: |
    lower="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]')"
    echo "is_release=$(case "$lower" in release*) echo true;; *) echo false;; esac)" >> "$GITHUB_OUTPUT"
- if: steps.norm.outputs.is_release == 'false'
  run: ...
```

Reference: <https://docs.github.com/en/actions/learn-github-actions/expressions#functions>.
Any `toLower`/`toUpper`/`trim`/`replace` inside `${{ }}` is a bug — rewrite it.

## 2. `run:` step safety — outputs and injection

### Multi-line step outputs need a heredoc delimiter

Writing `echo "result=$value" >> "$GITHUB_OUTPUT"` captures only the **first line** when
`$value` is multi-line (e.g. a failed `gh api` JSON body, a `git log`/`git diff`
aggregation, anything piped through `jq`/`yq` without `-r .field`). Downstream steps then
branch on a truncated, present-but-stale string — silent state corruption.

```yaml
# ❌ WRONG — truncates at the first newline
- id: convert
  run: |
    output="$(gh api graphql ... 2>&1)"
    echo "result=$output" >> "$GITHUB_OUTPUT"

# ✅ CORRECT — heredoc delimiter; runner reads until the closing EOF
- id: convert
  run: |
    output="$(gh api graphql ... 2>&1)"
    {
      echo "result<<EOF"
      echo "$output"
      echo "EOF"
    } >> "$GITHUB_OUTPUT"
```

The delimiter (`EOF`, or any unique string not present in the payload) tells the runner
to read to the matching closer instead of splitting on `\n`. When in doubt, use it — the
cost is two lines, the bug is invisible.

### Never inline-expand `${{ github.* }}` inside a `run:` body

`${{ ... }}` is **textually substituted before the shell parses the line**. If the value
contains shell metacharacters — quotes, backticks, `$(...)`, `;` — the shell executes
them. With attacker-influenced inputs (PR title, `head_ref`, branch name, issue body,
fork commit messages) this is direct command injection.

```yaml
# ❌ WRONG — injection surface; substituted before the shell parses it
- run: |
    gh api graphql -F id='${{ github.event.pull_request.node_id }}' -f query='...'

# ✅ CORRECT — pass via env:, dereference the (quoted) env var
- env:
    PR_NODE_ID: ${{ github.event.pull_request.node_id }}
  run: |
    gh api graphql -F id="$PR_NODE_ID" -f query='...'
```

Rule of thumb: **`${{ ... }}` belongs in `with:`, `env:`, `if:`, and `name:` — not in
`run:` script bodies.** The bar is not "is this field safe today?" but "will the pattern
still be safe when someone copies it and substitutes the PR title?" Genuinely safe
exceptions: `${{ secrets.* }}` in an `env:` mapping, and `${{ runner.os }}` / `${{ matrix.* }}`
defined entirely by the workflow itself. For user-influenced data there are no exceptions.

(Optional but cheap: `pipx install zizmor && zizmor .github/workflows` flags the
`template-injection` category automatically.)

## 3. Draft-gated jobs need `ready_for_review` in the trigger

A job guarded by `if: github.event.pull_request.draft == false` only runs on events the
workflow is actually subscribed to. A `pull_request:` trigger with no `types:` key
defaults to `[opened, synchronize, reopened]` — which does **not** include
`ready_for_review`.

Consequence: you mark the PR Ready expecting the required gate to run, but no new run is
scheduled. The gated leg stays `SKIPPED` from the last draft run, and GitHub treats a
SKIPPED required check as satisfied — so the PR shows mergeable as a **hollow green**.

```yaml
# ❌ Marking Ready never schedules a run — ready_for_review isn't subscribed
on:
  pull_request:
    branches: [main]

# ✅ The draft→ready transition itself fires the workflow
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
```

Add `synchronize` too (it's in the default set, but list it explicitly once you specify
`types:`, since specifying `types:` replaces the default entirely). Until the trigger is
fixed, the manual workaround is to force a `synchronize` event:

```bash
git commit --allow-empty -m "chore: trigger CI after ready-for-review" && git push
gh pr checks <pr-number> --watch   # confirm the gated leg shows COMPLETED/SUCCESS, not SKIPPED
```

Before merging a draft-gated PR: confirm `mergeStateStatus == CLEAN` (not merely
`MERGEABLE`), the specific leg shows COMPLETED/SUCCESS, and that run was triggered **after**
the PR was marked Ready.

## 4. GraphQL / API rate limits — defer, don't block the run

`gh api graphql`, `gh project item-edit`, and `gh issue edit --add-assignee` consume the
**per-user** GraphQL budget (5,000/hr), shared across every tool and agent on that token.
A burst of parallel mutations drains it in minutes; the error is
`API rate limit already exceeded for user ID …`.

- **Don't block the whole run on it.** Capture the GraphQL-dependent work (assign issues,
  flip board status) and continue with everything that doesn't need GraphQL. Most REST
  calls (`gh issue view`, `gh pr create`, `gh api repos/...`) draw on the separate `core`
  budget. Retry the deferred work after the `reset` timestamp passes (~15 min).
- **Mutate sequentially, not in parallel.** A tight `for` loop (one mutation per item)
  is gentler than bursty parallel calls, which compound the problem.
- Peek before a long sequence of board mutations; below ~200 remaining, defer:

```bash
gh api rate_limit --jq '.resources'   # compare .graphql.remaining vs .core.remaining
```

## Review checklist (any workflow PR)

```text
[ ] No toLower/toUpper/trim/replace inside ${{ }} — only contains/startsWith/endsWith/
    format/join/toJSON/fromJSON/hashFiles exist; munge strings in a run: step instead.
[ ] Every `>> $GITHUB_OUTPUT` for a possibly-multi-line value uses the heredoc
    delimiter form (or the value is guaranteed single-line via `-r .field`/`head -n1`).
[ ] No ${{ github.* }} / ${{ steps.* }} / ${{ inputs.* }} inline-expanded inside a
    run: body — pass via env: and dereference the quoted env var.
[ ] Any draft-gated required job: `ready_for_review` (and `synchronize`) is in the
    pull_request: types: list, so marking Ready actually schedules the gate.
[ ] GraphQL-heavy steps tolerate a rate limit (defer, don't fail the run) and mutate
    sequentially rather than in parallel.
```
