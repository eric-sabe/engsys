# lessons-library

Curated, **generalized** lessons that recur across projects — the durable memory
of the engineering system.

Two tiers, kept distinct:

1. **Project-local** lessons live in each project's `docs/agent-lessons/`, written
   during `/project-closeout` by mining that project's local-review findings.
2. **Generalized** lessons live here. When a lesson family recurs across projects
   (e.g. "new E2E spec ⇒ register it in the CI matrix", dependabot triage), it's
   rewritten stack-agnostically and promoted here.

## Promotion

`/project-closeout` ends with: *if a mined lesson generalizes, open a PR against
`engsys/lessons-library/`*. That's the feedback loop that keeps engsys the source
of truth instead of a fork point.

## Format

One lesson per file. Keep them LLM-optimized and trigger-first:

```markdown
# <short title>

**Trigger:** the symptom that should make you recall this.
**Failure mode:** what goes wrong and why.
**Correct behavior:** the checklist / the fix.
**Check:** a quick diagnostic before/after.
**Seen in:** keep it generalized — e.g. "recurring across projects."
```

### Stack-specific lessons

Most lessons are stack-agnostic. A lesson that only applies when a project uses a
particular tool or framework carries both of:

- a **filename prefixed with the stack** (`prisma-…`, `react-…`, `web-…`, `pnpm-…`), and
- a `**Stack:** <name>` line directly under the title, followed by a plain-language
  "skip if the project does not use X" so a reader (or agent) can discard it quickly.

They are listed under **Stack-specific** in the index. Note that the installer seeds every
lesson file regardless of stack; the tag is how a project (or a future seeding filter, keyed on
the filename prefix) tells them apart. Where a stack pack already carries the same guidance as a
skill (for example the web and Prisma stack skills), don't duplicate it as a lesson.

> This library is published publicly (npm + GitHub). Generalize before promoting:
> **never** include private project/repo/company names, secrets, internal hosts,
> or proprietary specifics in a lesson. The pattern is what's portable, not the
> particulars.

## Seeding

A future installer option may seed a project's `docs/agent-lessons/` with the
lessons relevant to its chosen stack. For now, promotion is manual via PR.

## Index

### Verification & review
- [verify-ground-truth-not-reports](verify-ground-truth-not-reports.md) — check real state, not the narration.
- [independent-objective-review-gate](independent-objective-review-gate.md) — fresh reviewer re-runs the gate, binary verdict.
- [tests-can-assert-the-bug](tests-can-assert-the-bug.md) — a green test that contradicts a root cause is a suspect.
- [prove-causation-before-acting](prove-causation-before-acting.md) — observe at the deciding boundary before fixing.
- [re-read-state-before-acting](re-read-state-before-acting.md) — re-read at the moment you act, not at session start.
- [gate-changes-on-measurement-not-vibes](gate-changes-on-measurement-not-vibes.md) — eval/golden-set, not intuition.
- [shift-correctness-left-and-distrust-false-greens](shift-correctness-left-and-distrust-false-greens.md) — pre-push checks; a gate that didn't run is a false green.
- [each-review-layer-catches-a-different-bug-class](each-review-layer-catches-a-different-bug-class.md) — hygiene, threat-model, static-analysis and advisory reviewers have different blind spots.
- [review-and-ci-are-per-commit-not-per-pr](review-and-ci-are-per-commit-not-per-pr.md) — verdicts name a SHA; an appended commit needs re-review and fresh CI.
- [baseline-before-blaming-flakes](baseline-before-blaming-flakes.md) — control run on clean base before overriding "known flakes".
- [scanner-findings-surface-as-pr-review-threads](scanner-findings-surface-as-pr-review-threads.md) — a red code-scanning check can be a real finding in a review thread.
- [e2e-passes-vacuously-against-a-redirect-target](e2e-passes-vacuously-against-a-redirect-target.md) — assert something only the real page can satisfy.
- [llm-judge-parse-defensively-and-start-advisory](llm-judge-parse-defensively-and-start-advisory.md) — strip fences, start advisory, know what was judged.
- [success-only-counters-read-errors-as-unused](success-only-counters-read-errors-as-unused.md) — count attempts and errors, or a broken tool looks unused.
- [verify-the-deployed-override-not-the-code-default](verify-the-deployed-override-not-the-code-default.md) — check the per-environment layer, not just the default.
- [new-convention-applies-to-its-own-pr](new-convention-applies-to-its-own-pr.md) — audit your own diff against the rule it introduces.
- [reconcile-the-whole-doc-when-flipping-status](reconcile-the-whole-doc-when-flipping-status.md) — a status flip must reconcile every body section.
- [new-rule-in-a-shared-scan-inherits-its-scope-filter](new-rule-in-a-shared-scan-inherits-its-scope-filter.md) — a rule added to a shared scan can be filtered out of its own audience.
- [time-predicate-breaks-now-based-fixtures](time-predicate-breaks-now-based-fixtures.md) — fix the fixture factory when adding a temporal gate.

### Concurrency & safety
- [claim-then-act-for-irreversible-ops](claim-then-act-for-irreversible-ops.md) — stamp the claim atomically, then execute.
- [async-callbacks-verify-liveness](async-callbacks-verify-liveness.md) — confirm the target is still current before mutating it.
- [enforce-your-guarantee-at-your-boundary](enforce-your-guarantee-at-your-boundary.md) — redact/sanitize/audit/authorize where you emit.
- [emit-after-commit-isolate-publish-failure](emit-after-commit-isolate-publish-failure.md) — publish after every write commits; a failed publish must not fail the work.
- [public-route-flip-hardening-checklist](public-route-flip-hardening-checklist.md) — making a route anonymous changes its threat model; run the checklist.
- [normalize-on-write-must-match-on-read-and-be-linear](normalize-on-write-must-match-on-read-and-be-linear.md) — one idempotent normalizer for write and read; no superlinear regex on untrusted input.
- [deterministic-tiebreak-on-every-row-pick](deterministic-tiebreak-on-every-row-pick.md) — total order on every pick; kill switches restore the exact old order.

### Data & identity
- [keep-an-immutable-source-of-truth](keep-an-immutable-source-of-truth.md) — raw immutable; downstream is a replayable transform.
- [model-identity-with-stable-ids-and-provenance](model-identity-with-stable-ids-and-provenance.md) — join on stable ids; carry source+timestamp.
- [read-layer-tolerates-unbackfilled-rows](read-layer-tolerates-unbackfilled-rows.md) — handle legacy rows during the backfill window.

### Workflow & git
- [change-isnt-done-until-every-surface-updated](change-isnt-done-until-every-surface-updated.md) — update every rippled surface in the same PR.
- [operator-choices-are-first-class](operator-choices-are-first-class.md) — track operator choices; copy criteria verbatim.
- [co-commit-entangled-work](co-commit-entangled-work.md) — co-commit file-sharing issues; skip already-merged commits on rebase.
- [stray-control-bytes-hide-changes](stray-control-bytes-hide-changes.md) — control bytes turn files binary and silence review.
- [long-agent-runs-checkpoint-not-poll](long-agent-runs-checkpoint-not-poll.md) — checkpoint into short runs; end agents at PR-open.
- [git-core-bare-flip-breaks-all-worktrees](git-core-bare-flip-breaks-all-worktrees.md) — hooks export `GIT_DIR`; scrub it in test git calls, guard `core.bare` on push.
- [match-marker-comments-by-leading-position-and-author](match-marker-comments-by-leading-position-and-author.md) — leading-position + author match for marker comments; never `includes()` or `--edit-last`.
- [push-runs-the-precheck-hook-budget-the-timeout](push-runs-the-precheck-hook-budget-the-timeout.md) — budget the timeout; a timed-out push is unknown, check the remote.
- [husky-hooks-not-linked-in-worktrees](husky-hooks-not-linked-in-worktrees.md) — link the hook shim; run the gate by hand before `--no-verify`; check for autofix strays.

### Ops & deploy
- [deploy-by-digest-and-verify-the-running-revision](deploy-by-digest-and-verify-the-running-revision.md) — immutable digest; verify the active revision.
- [iac-first-no-console-changes](iac-first-no-console-changes.md) — version-controlled IaC with state and drift detection.
- [worktrees-need-bootstrap-from-origin-main](worktrees-need-bootstrap-from-origin-main.md) — branch off origin/main; bootstrap; absolute paths.
- [shell-safety-pipefail-and-validate-before-teardown](shell-safety-pipefail-and-validate-before-teardown.md) — pipefail; validate the risky step before teardown.
- [infra-merge-is-a-deploy](infra-merge-is-a-deploy.md) — ship config flips inert at merge; seed secrets before referencing them.
- [short-lived-credentials-expire-mid-operation](short-lived-credentials-expire-mid-operation.md) — submit and poll, refresh the login, bucket auth errors three ways.

### Tooling
- [prefer-tool-enforced-structured-output](prefer-tool-enforced-structured-output.md) — schema/tool-enforced output over prompt-policed format.
- [dependabot-triage-playbook](dependabot-triage-playbook.md) — 6-phase order for clearing a Dependabot pile.

### Stack-specific
- [prisma-uniqueness-and-upsert-beyond-the-schema](prisma-uniqueness-and-upsert-beyond-the-schema.md) — `stack: prisma` — partial indexes live in migrations; upsert arbitrates one index.
- [react-lazy-usestate-init-freezes-async-value](react-lazy-usestate-init-freezes-async-value.md) — `stack: react` — derive per render, don't lazy-init from async data.
- [web-contrast-compute-on-the-composited-surface](web-contrast-compute-on-the-composited-surface.md) — `stack: web` — luminance formula on the real composited background.
- [pnpm-install-in-a-non-member-dir-installs-the-root](pnpm-install-in-a-non-member-dir-installs-the-root.md) — `stack: pnpm` — make the package a workspace member.
