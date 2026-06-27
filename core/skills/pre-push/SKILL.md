---
name: pre-push
description: Run the project's diff-aware pre-push gate before pushing — builds, lints, and tests only what changed. Use when the user says "run precheck", "pre-push check", or "validate before push".
---

# Pre-push Gate

Trigger: user says "run precheck", "pre-push check", "validate before push", or equivalent.

## The Contract

Run the project's pre-push gate from the repo root before every `git push`. The gate is a
**diff-aware contract**: it inspects `git diff origin/main...HEAD`, then runs only the checks
relevant to the files that changed. It should be enforced by a `pre-push` git hook so it runs
automatically on `git push`. Run it manually if you want early feedback before committing.

The gate is invoked through whatever the project defines — a script (`scripts/precheck.sh`), a
package-manager task (`npm/pnpm/yarn run precheck`, `make precheck`, `just precheck`,
`cargo`/`go`/`mvn` equivalents), or a Taskfile target. The name and runner are project-specific;
the contract is not.

```bash
<precheck-command>              # standard — diff-driven, runs relevant gates only
<precheck-command> --full       # force the full suite even if the diff didn't trigger it
PUSH_OVERRIDE=1 git push ...    # emergency bypass — no local gates run, CI is sole safety net
```

## What It Does (diff-aware gate selection)

The gate maps changed paths to checks. Always run **build + lint**; layer on the rest based on
what the diff touched. Each project defines its own table — the shape is always
`changed files → gates triggered`:

| Changed files                          | Gates triggered                                        |
| -------------------------------------- | ------------------------------------------------------ |
| Any                                    | build + lint (always)                                  |
| Source files                           | + unit tests                                           |
| Data/schema/migration files           | + codegen + dependent-package builds                   |
| End-to-end / integration spec files    | + e2e for the changed specs only                       |
| Test-harness / matrix config           | + full e2e suite (harness change can affect all specs) |
| UI / frontend source                   | + browser/e2e suite                                    |
| Infrastructure-as-code files           | + IaC syntax/validate check                            |
| Container/build files (`Dockerfile*`)  | + container build smoke (if the engine is available)   |
| Docs / markdown                        | + doc lint                                             |
| CI workflow files                      | warn — validate manually                               |

The first column is the project's actual path globs; the second is the project's actual commands.
This skill defines the **discipline** (diff-aware, fast, gracefully degrading), not the specific
tooling.

## Design Constraints

- Target: fast enough to run on every push (aim for under ~10 min for a single changed spec).
- Run only the spec/test files affected by the diff, not the full matrix, in the standard path.
- Gates for optional tooling (container engine, IaC CLI, cloud CLI) skip gracefully when the
  tool is not installed — a missing optional tool must not fail the push.

## Full Suite Locally

When the test harness itself changes, or when you want to run the full suite regardless of the
diff, force it:

```bash
# 1. Bring up any infra the full suite needs (db, services, browsers)
<bring-up-infra-command>

# 2. Force the full suite
<precheck-command> --full

# 3. Or run a specific spec manually
<run-single-spec-command>
```

## Review before push (local code review)

Review is local — run a local code review with the built-in `/code-review` skill **before** you
push so the PR opens already-reviewed and CI minutes aren't spent on a post-push review loop.

```bash
git fetch origin   # local main is often stale — compare against the remote
# then run a local code review with the built-in /code-review skill against origin/main:
# structured findings; fix Critical + Warning, then re-run once
```

This is **not** part of the pre-push gate (a multi-minute review shouldn't block every push).
Invoke it deliberately before the push that opens/updates the PR. After opening the PR, persist
the local review findings as a PR comment for the closeout ceremony to mine. Full contract:
[`../code-review/SKILL.md`](../code-review/SKILL.md) and the root CLAUDE.md § Code review.

## Draft-First PR Convention

Draft PRs should skip the expensive full matrices (browser/e2e, a11y, flake audits) in CI; keep
those for Ready-for-review. If your CI opens PRs as ready by default, add a workflow that demotes
opened-as-ready PRs to draft automatically.

Workflow:

1. Run a local code review with the built-in `/code-review` skill → fix Critical + Warning → re-run clean
2. The pre-push gate runs on your diff → push branch
3. `gh pr create --draft` → cheap CI (build/lint/test only) → persist the local review findings as a PR comment
4. Mark **Ready for review** → full matrices fire
5. Matrices pass → human merges

Mark Ready for review only once the local review is resolved and the pre-push gate is green.

## Git Hook

The project's `pre-push` hook (e.g. under `.husky/` or `.git/hooks/`) calls the gate automatically
on every `git push`. To bypass:

```bash
PUSH_OVERRIDE=1 git push origin agent/<branch>
```

Use the bypass only when optional local tooling is unavailable and you are confident CI will pass.
