# repo-gates: gates that keep agent PRs honest

A set of small, copy-and-edit templates for the repository an agent fleet (or any fast-moving team)
pushes to. Each piece exists because a specific failure happens without it. Nothing here is installed
automatically: **you adopt a piece by copying it into your repo and editing its marked config**.

## What each piece prevents

| Piece | Prevents |
|---|---|
| `github/workflows/auto-draft-pr.yml` | Expensive CI (browser matrices, a11y, flake audits) burning minutes on every freshly opened PR. Newly opened PRs are demoted to draft; the author marks Ready when the local review is done. If the repo setting behind the API call is off, the PR gets a comment naming that setting instead of silently staying non-draft. |
| `github/workflows/secret-scan.yml` | A committed secret that got past the local hook (`--no-verify`, or no gitleaks installed). A non-bypassable CI backstop: the gitleaks CLI in its official container (no licence key), scoped to the commits the event introduces, with a SARIF artifact for triage. |
| `github/workflows/required-check-skip.yml.example` | A required check that never reports. When the main CI is path-filtered, a docs-only PR never starts it, the required check stays "Expected, waiting for status", and the PR can never merge. The companion satisfies the check on exactly the paths the main CI ignores. The file's comment block also documents the `!cancelled()` aggregator pattern (below). |
| `husky/pre-commit` | Formatting drift and secrets in staged changes. Runs lint-staged, then gitleaks on the staged diff; if gitleaks is missing it warns loudly and lets the commit through (CI is the backstop), so a missing scanner is never silent and never blocks onboarding. |
| `husky/pre-push` | Pushing something CI will reject. Runs the precheck gate; `PUSH_OVERRIDE=1` is the documented emergency escape. |
| `lint-staged.example.json` | Starter rules for the pre-commit hook. |
| `scripts/precheck.sh.tmpl` | Running everything on every push (slow, so people bypass it) or running nothing (so CI finds it). A table-driven, diff-aware gate selector. See "The precheck skeleton". |
| `scripts/worktree-bootstrap.sh.tmpl` | A worktree that cannot run the app (no deps, no env files, no generated code) **and one where `git push` dies inside the hook**, because husky's generated `_` shim exists only in the main checkout. Idempotent bootstrap that fixes all of it. |
| `markdownlint-cli2.jsonc` | Markdown that renders wrong, without a wall of style noise. An allowlist of correctness rules only (broken fences, lists, tables, links, anchors). |
| `../../scripts/git-prune-merged-branches.sh` | The long tail of local branches that agent sessions leave behind. Deletes branches already merged into the default branch. Dry run by default; keeps the N most recently touched. |

## How to adopt (plugin mode and copy mode)

The templates are the same in both modes. They live in the engsys checkout under
`core/templates/repo-gates/`, and in plugin mode under the plugin's `templates/repo-gates/` (the plugin
root is `core/`; the marketplace clone on the host holds the whole repo, so
`<engsys checkout>/core/templates/repo-gates/` works there too). The installer does **not** copy this
directory into your repo, so in either mode you copy what you want:

```bash
ENGSYS=/path/to/engsys                       # a checkout of the engsys repo at the tag you run
G="$ENGSYS/core/templates/repo-gates"

# workflows
cp "$G"/github/workflows/auto-draft-pr.yml   .github/workflows/
cp "$G"/github/workflows/secret-scan.yml     .github/workflows/
# required-check companion: rename, then edit paths-ignore and the check name
cp "$G"/github/workflows/required-check-skip.yml.example .github/workflows/ci-summary-skip.yml

# hooks (husky v9+): install husky and lint-staged first
npm i -D husky lint-staged && npx husky init      # sets core.hooksPath and a prepare script
cp "$G"/husky/pre-commit "$G"/husky/pre-push .husky/ && chmod +x .husky/pre-commit .husky/pre-push
cp "$G"/lint-staged.example.json .lintstagedrc.json

# scripts: copy, drop the .tmpl suffix, edit the CONFIG block at the top
mkdir -p scripts
cp "$G"/scripts/precheck.sh.tmpl            scripts/precheck.sh
cp "$G"/scripts/worktree-bootstrap.sh.tmpl  scripts/worktree-bootstrap.sh
cp "$ENGSYS"/core/scripts/git-prune-merged-branches.sh scripts/
chmod +x scripts/*.sh

# markdown
cp "$G"/markdownlint-cli2.jsonc .markdownlint-cli2.jsonc
```

Ask an agent instead? Point it at this README and the piece you want; every template carries its own
adoption notes in comments. In **copy mode** you can also let `engsys update` carry the skills that
describe these gates (`github-actions`, `pre-push`); the templates themselves stay yours once copied,
so re-diff them against a newer engsys checkout when you upgrade.

After adopting:

1. **Repo setting for auto-draft.** Settings, Actions, General, Workflow permissions: enable "Allow
   GitHub Actions to create and approve pull requests". Without it the conversion is FORBIDDEN (the
   workflow says so in a PR comment).
2. **Default branch.** The workflows and precheck assume `main` / `origin/main`. Change `branches:`,
   and `BASE_REF` in precheck, if yours differs.
3. **Action pins.** The workflows pin third-party actions by commit SHA. Verify the pins and keep them
   current (Dependabot can bump them).
4. **Secret allowlist.** Put narrow path/regex allowlist entries in a repo-root `.gitleaks.toml`; both
   the hook and the CI job pick it up.
5. **Required checks.** If you require the aggregator, also add the companion (below), and keep its
   `paths-ignore` identical to the main CI's `paths`.
6. **Worktrees.** Run `bash scripts/worktree-bootstrap.sh` in each new worktree (or wire it into your
   worktree-creation command), so pushes from a worktree still hit the gate.

## The precheck skeleton

`precheck.sh.tmpl` keeps the *machinery* and leaves you the *table*. You edit only the CONFIG block:

```bash
GATES=(
  'build+lint|:build|npm run build && npm run lint'
  'unit-tests|\.[jt]sx?$|npm test'
  'e2e@docker@needs-build|e2e/|npm run test:e2e'
  'repo-config-guard|:always|test "$(git config --get core.bare || echo false)" != true'
)
```

A row is `name|path-regex|command`. The regex is matched against the files changed on the branch
(`git diff origin/main...HEAD`); the gate runs when any file matches. Behaviours worth knowing, and
why each is there:

- **`fail()` sets `FAILED`, and `trap 'FAILED=1' ERR` backs it up.** A gate cannot print `[FAIL]` and
  still exit 0, and an unexpected error mid-run cannot exit 0 either. The summary exits non-zero
  whenever anything failed. All selected gates run even after one fails, so you see everything at once.
- **Docs and agent-config-only diffs skip the `:build` gate** (Markdown, `docs/`, `.claude/`,
  `.agents/`; edit `DOCS_ONLY_REGEX`). They cannot change the build. An **empty** diff still runs it
  (conservative), and so does any diff that selects a gate flagged `@needs-build` (an e2e suite serves
  the artifacts the build produces).
- **Docker preflight.** A gate flagged `@docker` that the diff selected makes the script check the
  daemon up front, and fail in seconds with the remediation command, instead of failing deep into a
  ten-minute run. A triggered gate never skips silently. Gates for *optional* tooling should skip
  themselves when the tool is absent (see the `workflows` row); required runtime is what `@docker` is for.
- **Fail closed on an unresolvable base.** If `origin/main` cannot be resolved the script cannot tell
  what changed, so it runs every gate rather than gating on an empty diff.
- **`PUSH_OVERRIDE=1`** skips everything (no audit trail; CI is the only safety net). `--full` runs
  every gate regardless of the diff; `--dry-run` prints what would run.
- **Regex vs separator.** The default separator is `|`, so the regex field cannot contain alternation:
  write `\.[jt]sx?$`, not `\.(ts|js)$`. If you need alternation, set `GATE_SEP` to something else
  (for example `@@`). A malformed row is a loud startup error (exit 2), never a silently dropped gate.
- Each command gets `PRECHECK_GATE_FILES` (the changed paths matching its regex) and
  `PRECHECK_CHANGED` (all of them), for gates that should run only on what changed.

The `test/repo-gates.test.sh` gate matrix exercises exactly these behaviours against the shipped
machinery, so a change to it is checked, not assumed.

## The required-check patterns

Two patterns, both written up in the `github-actions` skill:

- **Skip companion.** `required-check-skip.yml.example`: a same-named green check on the paths the main
  CI ignores, so a path-filtered CI never leaves a required check pending. `paths-ignore` here must
  mirror `paths` there exactly.
- **Aggregator with `if: ${{ !cancelled() }}`.** One job, named like the required check, that `needs:`
  every gating leg and fails on any non-success result. Use `!cancelled()`, **not** `always()`: with
  `always()`, a run cancelled by concurrency supersession leaves the required context red on that SHA,
  and a later green run cannot clear it. The worked comment block is in the example file.

## Tests

```bash
bash core/templates/repo-gates/test/repo-gates.test.sh
```

Runs shellcheck over the shell templates; the precheck gate matrix (docs-only, code, empty and
Docker-unavailable diffs; `FAILED` propagation; `PUSH_OVERRIDE`) in a temp repo under every bash it can
find, including macOS `/bin/bash` 3.2; the hook behaviours; the prune script against merged and unmerged
branches; the worktree bootstrap (env copy, idempotence, shim link); YAML parsing of the workflows
(and `actionlint` when installed). It needs no network and touches nothing outside a temp directory.
Add it to your `npm test` line to run it in CI.

## Limits

- `git-prune-merged-branches.sh` finds branches git considers merged (tip reachable from the base).
  Branches landed by squash or rebase merge are not reachable, so they are not listed. Delete those
  by hand once the PR merges.
- The hooks target husky v9+. For husky v8, add `. "$(dirname -- "$0")/_/husky.sh"` under each hook's
  header.
- `worktree-bootstrap.sh` copies env files that usually hold secrets, from the main checkout on the
  same machine into a sibling worktree. List only what a worktree needs.
