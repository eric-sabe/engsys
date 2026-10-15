---
name: refactor
description: "Surgical code refactoring to improve maintainability without changing behavior. Covers extracting functions, renaming variables, breaking down god functions, improving type safety, eliminating code smells, and applying design patterns. Less drastic than repo-rebuilder; use for gradual improvements."
license: MIT
---

# Refactor

## Overview

Improve code structure, readability, and type safety **without changing external behavior**. Refactoring is gradual evolution in small, test-verified steps — never mix behavior changes with structural refactoring in the same commit.

## The Golden Rules

1. **Behavior is preserved**: Inputs, outputs, side effects, and error contracts remain identical.
2. **Tests first**: Verify existing tests pass before touching code; add characterization tests first if coverage is missing.
3. **Small atomic steps**: Apply one refactoring transform at a time and re-run tests after each step.
4. **Separate commits**: Never mix refactoring with feature work or bug fixes.
5. **Know when NOT to refactor**: Skip stable code that rarely changes, untested critical paths (until tests are added), or out-of-scope files unrelated to your issue.

## Code Smell → Refactoring Index

| Smell | Symptoms | Primary Transform |
| ----- | -------- | ----------------- |
| **Long Function** | >40–50 lines, multiple levels of abstraction, section comments | Extract Function / Compose Method |
| **Duplicated Logic** | Same conditional or calculation repeated in 2+ call sites | Extract Shared Helper / Parameterize Function |
| **Large Module / God Class** | Unrelated responsibilities, >10 public methods, high churn | Split Module / Extract Collaborator by SRP |
| **Long Parameter List** | >4 positional parameters or boolean flag arguments | Introduce Parameter Object / Split Flagged Function |
| **Feature Envy** | Function accesses another module's fields more than its own | Move Function to data owner |
| **Primitive Obsession** | Raw strings/numbers for domain concepts (IDs, money, status) | Introduce Branded Type / Value Object |
| **Deep Nesting** | 3+ nested `if`/`else`/`try` blocks | Replace Nested Conditional with Guard Clauses |
| **Switch / Type-Code Sprawl** | Repeated `switch (kind)` across multiple functions | Replace Conditional with Polymorphism / Strategy Map |
| **Mutable Shared State** | Variables mutated across distant functions | Encapsulate Variable / Return Immutable Value |

## Workflow

1. **Characterize & Baseline**: Run the test suite (`<test-command>`) and typechecker (`<typecheck-command>`) to confirm a green baseline.
2. **Identify the Smell**: Pinpoint the smallest structural bottleneck blocking clarity or extensibility.
3. **Apply Transform**: Execute a single transform from the index above (e.g., guard clauses first, then extract helpers).
4. **Verify**: Run tests, typecheck, and linter immediately. If anything fails, revert or fix before proceeding.
5. **Checkpoint**: Commit the refactoring (`refactor(scope): <description>`) separately from functional changes.

## Detailed Catalog & Before/After Examples

For complete before/after code diffs across all code smells, design pattern refactorings, and legacy seam extraction techniques, see [`references/catalog.md`](references/catalog.md).
