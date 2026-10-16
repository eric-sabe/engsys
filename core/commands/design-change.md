---
description: Adaptive SDD front door — explore context, evaluate the 6 escalation tripwires (TW-1..TW-6), right-size into Tier S (inline issue), Tier M (Melvin+Nyx mini-spec), or Tier L (full multi-agent spec + board)
argument-hint: [optional goal description or warm-chat continuation]
---

Follow the Adaptive SDD workflow in [<engsys-root>/workflows/generate-project.md](<engsys-root>/workflows/generate-project.md).

`/design-change` is the primary front door for designing any feature, architectural change, or multi-file enhancement (with [/generate-project](generate-project.md) preserved as a full alias). It works seamlessly in both **Warm-Chat Mode** (continuing prior freeform ideation in the current chat session) and **Cold-Start Mode** (`$ARGUMENTS` passed directly).

Goal / Context: $ARGUMENTS

## Phase Sequence

1. **Phase 0: Warm-Chat & Argument Intake** — Distill any decisions, constraints, tradeoffs, and rejected alternatives from the current chat conversation alongside `$ARGUMENTS` into a written baseline (`## Context`, `## Operator Inputs`, `## Assumptions`) so downstream subagents (which start with fresh context) inherit the full ideation history.
2. **Phase 1: Explore Context & Evaluate the 6 Escalation Tripwires (`TW-1..TW-6`)**:
   - `TW-1` **Data Model / Schema / State Migration** (DB migrations, persistent state files, lockfile/config schemas)
   - `TW-2` **Public API / CLI / Wire Protocol** (new/modified endpoints, CLI flags, hook JSON envelopes, cross-service contracts)
   - `TW-3` **Auth / Trust Boundary / Security** (permissions, secrets, untrusted-input boundaries, guard hooks — **always invokes `Nyx`**)
   - `TW-4` **Multi-PR / Cross-Subsystem Scope** (`>1` PR or `>5` files across distinct subsystems)
   - `TW-5` **AI / LLM / Agentic Pipeline** (prompts, model routing, structured outputs, evals, memory — **always invokes `Otto` + `Marcelo`**)
   - `TW-6` **Infra / CI / Deploy Topology** (Terraform/IaC, Docker/containers, CI workflows, daemon supervision — **always invokes `Aaron`**)
3. **Adaptive Tier Routing**:
   - **Tier S (Inline Issue)**: `0` tripwires, `<= 3` files, single PR → file a self-contained issue with an `<!-- engsys:issue-meta -->` block via the `issue-tracker-*` skill (`core/workflows/issue-tracking.md`).
   - **Tier M (Mini-Spec, `spec-mini.md.tmpl`)**: `1–2` tripwires, `1–2` PRs → draft `docs/specs/<slug>.md` (`tier: M`) with `non_negotiable_anchors`, run the focused 2-persona loop (`Melvin` + `Nyx`, plus `Otto` on `TW-5` or `Aaron` on `TW-6`), and file ordered issues with `<!-- engsys:issue-meta -->`.
   - **Tier L (Full Spec + Project Board, `spec-full.md.tmpl`)**: `>= 3` tripwires or `TW-4` multi-phase epic → run the full multi-persona design loop (`Leith` + `Melvin` + `Otto`/`Aaron` as triggered → `Nyx` + `Gary` → reconcile → `Marcelo` → `Jody` + fresh Sanity Check) and stand up the phased tracker board.
4. **Executable Contract Invariants**:
   - Every spec in `docs/specs/<slug>.md` carries YAML frontmatter with `spec_id`, `status: draft`, `tier: M|L`, `owners`, `supercedes`, and `non_negotiable_anchors`.
   - Every created issue ends with a valid `<!-- engsys:issue-meta -->` block (`depends_on`, `touches`, `risk`, `needs_judgment`, `spec_refs`, `no_external`) verified by `node <engsys-root>/lib/contract-check.mjs` and sliced via `node <engsys-root>/lib/spec-slice.mjs`.
