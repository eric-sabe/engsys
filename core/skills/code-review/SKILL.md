---
name: code-review
description: 'Local code review before push. Default code-review skill. Trigger for any explicit review request AND autonomously when the agent thinks a review is needed (code/PR/quality/security).'
metadata:
  version: '0.2.0'
---

# Local Code Review

Local pre-push review uses the **built-in `/code-review` skill**. Run a local code review with
`/code-review` before `git push` so PRs open already-reviewed and CI minutes aren't spent on a
post-push review loop.

## How to Review

1. `git fetch origin` so `origin/main` is current before scoping the diff.
2. Run a local code review with the built-in `/code-review` skill against `origin/main`.
3. Triage findings by severity — fix **Critical** + **Warning**; **Info** at discretion.
4. Re-run to confirm clean; cap at ~2 passes.
5. After opening the PR, persist the local review findings as a PR comment so the closeout
   ceremony can mine them.

For deeper, security-focused passes, the built-in `/security-review` command is also available.

> Note: prefer the built-in `/code-review` skill for local pre-push review rather than a
> post-push cloud review tool, so PRs open already-reviewed.
