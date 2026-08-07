# Worker Dispatch

How the conductor (this Claude session) delegates work to provider workers —
Codex, DeepSeek, Grok, Anthropic-as-worker — under the engsys worker contract.
Design and rationale: `docs/multi-provider-spec.md` in the engsys repo. This
doc is the operating procedure.

The division of labor is absolute: **workers produce diffs and reports;
the conductor owns diligence** — fresh base, package build, gates, commits,
PR creation, review dispatch, merge decision. A worker never pushes, commits,
or opens a PR, and a worker's own gate numbers are never the gate.

---

## The contract in one glance

```text
worker-package.mjs  →  tmp/worker-package/<run-id>/   (the envelope)
worker-run.mjs      →  spawns the provider, validates the protocol
exit 0  protocol complete + positive  (STATUS: IMPLEMENTED/COMPLETE, VERDICT: CLEAN)
exit 1  protocol complete + negative  (VERDICT: FINDINGS, STATUS: REFUSED/BLOCKED)
exit 2  did not run / protocol violated — NEVER read as findings, NEVER as a pass
```

Every worker's final message ends with a `RECEIPT:` line (echoing the package
hash and issue list) and a `VERDICT:`/`STATUS:` footer. worker-run validates
both; a missing or wrong receipt is exit 2 regardless of how good the
transcript looks. Exit 1 is a *successful communication* — findings to route,
or a refusal with premise evidence worth more than compliant wrong work.

## Dispatching an implement run

```bash
node .claude/scripts/worker-package.mjs --role implement --provider codex \
     --worktree <path> --issues 244,250 \
     --hypothesis "the cause is X (unverified)" \
     --spec "docs/specs/foo.md#Section"
node .claude/scripts/worker-run.mjs --package tmp/worker-package/<run-id>
```

1. **Fresh base first.** `git fetch` and branch from the updated tip before
   building the package — a stale base produces a competent implementation of
   the wrong premise, and nothing looks wrong.
2. **Pre-audit the issue bodies** before dispatch. The package materializes
   them verbatim; a stale or wrong body poisons every downstream step.
3. Provider choice: `providers.json` routing — `implement_default` for
   well-specified work, `overflow` for mechanical bulk, the conductor's own
   personas (Isabelle) for `needs_judgment` issues. Escalate tier (Sol / Pro)
   via `--model` when the default failed once or the issue spans many modules.
4. After exit 0: **run `verify.md` yourself from scratch** — the worker's
   numbers are claims. Then commit per issue from the worker's per-issue file
   map, one commit per issue, each ending with the trailer:

   ```text
   Worker: <provider>/<model>
   ```

   The trailer is how the review chain later knows the author family; commit it
   faithfully.
5. Exit 2 twice from one provider: **change the channel, not the volume** —
   worker-run refuses the third dispatch itself. Route to the next provider or
   take the work back inline.

## Dispatching the objective review (the merge gate)

```bash
node .claude/scripts/worker-package.mjs --role review --provider <reviewer> \
     --worktree <path> --issues 244,250 --base origin/main
node .claude/scripts/worker-run.mjs --package tmp/worker-package/<run-id>
```

1. **Determine the author family** from the phase's `Worker:` trailers (absent
   trailer = the conductor authored it = anthropic).
2. **Walk `review_fallback_chain` minus the author's family.** Exit 2 → log it
   loudly, next provider in the chain.
3. **Chain exhausted → stop and report.** Never degrade to the author's family
   silently. Conductor-Anthropic reviewing Anthropic-authored work requires
   explicit operator sign-off, recorded as a same-family exception in the PR.
4. `risk: high` phases (from the issues' engsys:issue-meta): **two** families
   must return CLEAN before merge.
5. A design-lens pass (`--brief .claude/workflows/briefs/review-design.md`)
   never substitutes for the correctness gate — both run on user-facing work.

## Fix rounds

When a review returns FINDINGS:

1. Write the findings to a file, severity-tagged with stable ids:
   `- [F1] Critical src/x.ts:42 — concrete failure scenario`.
2. Rebuild an implement package with `--findings <file>` (same or stronger
   tier; same provider unless it authored the defect pattern twice).
3. worker-run enforces the close of the loop: every `[Fn]` Critical/Warning
   must be `FINDING-ACK: Fn -> fixed | disputed | deferred — evidence` in the
   worker's final message, or the run is exit 2. Disputed ACKs come back to the
   conductor to adjudicate — do not silently re-dispatch.
4. Re-run the review after the fix round. FINDINGS → fix is not CLEAN.

## What the conductor never delegates

- Base freshness, issue pre-audit, package building
- Running `verify.md` as the gate
- Commits (with `Worker:` trailers), pushes, PR creation
- The merge decision and the review-chain walk
- Adjudicating disputed findings and same-family exceptions

## Failure playbook

| Symptom | Meaning | Action |
|---|---|---|
| exit 2, "NOT READY" | binary/auth/env missing | fix or next provider; `engsys verify` prints the doctor matrix |
| exit 2, no receipt / wrong hash | message didn't land as behavior | retry ONCE with a smaller package, then next provider |
| exit 2, tree drift on a read-only role | reviewer mutated the tree | reset to the frozen commit, re-run |
| exit 2, alias trap (deepseek) | wrong model answered | fix the model id in providers config — do not accept the Flash run |
| exit 1, STATUS: REFUSED with evidence | the premise was wrong | fix the premise; this run saved a round, treat it as a win |
| repeated idle / timeout (anthropic lane) | channel failed open | fall back; never wait out a silent worker |
