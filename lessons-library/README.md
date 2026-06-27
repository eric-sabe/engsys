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
**Seen in:** which projects surfaced it (+ rough date).
```

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

### Concurrency & safety
- [claim-then-act-for-irreversible-ops](claim-then-act-for-irreversible-ops.md) — stamp the claim atomically, then execute.
- [async-callbacks-verify-liveness](async-callbacks-verify-liveness.md) — confirm the target is still current before mutating it.
- [enforce-your-guarantee-at-your-boundary](enforce-your-guarantee-at-your-boundary.md) — redact/sanitize/audit/authorize where you emit.

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

### Ops & deploy
- [deploy-by-digest-and-verify-the-running-revision](deploy-by-digest-and-verify-the-running-revision.md) — immutable digest; verify the active revision.
- [iac-first-no-console-changes](iac-first-no-console-changes.md) — version-controlled IaC with state and drift detection.
- [worktrees-need-bootstrap-from-origin-main](worktrees-need-bootstrap-from-origin-main.md) — branch off origin/main; bootstrap; absolute paths.
- [shell-safety-pipefail-and-validate-before-teardown](shell-safety-pipefail-and-validate-before-teardown.md) — pipefail; validate the risky step before teardown.

### Tooling
- [prefer-tool-enforced-structured-output](prefer-tool-enforced-structured-output.md) — schema/tool-enforced output over prompt-policed format.
- [dependabot-triage-playbook](dependabot-triage-playbook.md) — 6-phase order for clearing a Dependabot pile.
