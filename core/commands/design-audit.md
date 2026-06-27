---
description: Audit a live surface against the design reference (mockups or design system + tokens/components) with a fine-grained eye, produce a remediation spec
argument-hint: <surface name, a route path, a screenshot path, or a supplied mockup file>
---

Compare a live surface to its design reference with a **fine-fine-fine eye** and produce a remediation spec.

Target: $ARGUMENTS

## The mapping (read this first)

The **reference side** is whatever the project uses as design truth — pick whichever the project defines in `CLAUDE.md` / its design docs:

- A **design-proposal pipeline** (mockup HTML / Figma exports / image comps) to diff the live surface against, OR
- A **design system as code** (tokens + components) and its **rendered gallery/showcase**, where the audit checks whether the live surfaces compose that system faithfully (right tokens, right components, right variants/states).

The **live side** is the consuming surface(s) in the app.

This command supports three input forms for `$ARGUMENTS`:

1. **A surface or route** — audit that live surface against the reference.
2. **A screenshot path** — audit the rendered pixels in the image against the reference; you won't have line numbers for the "live" side, so cite the screenshot region and the nearest source file you can locate.
3. **A supplied mockup** (an HTML/image file handed to you for a *not-yet-built* surface) — treat the mockup as the proposed design, run the sanity check on it, and audit how well it would compose the existing system.

## Anchors (resolve to the project's actual paths)

| What                       | Where (project-defined)                                          |
| -------------------------- | --------------------------------------------------------------- |
| Design tokens (truth)      | colors / typography / spacing / elevation / motion sources       |
| Components                 | the project's component library                                  |
| Component showcase (ref)   | the rendered gallery/showcase, if one exists                    |
| Mockups / proposals        | the proposal pipeline, if one exists                            |
| Live surfaces              | the consuming app surfaces                                       |
| Routing / surface split    | the app's router                                                |
| Brand / voice / lexicon    | the project's design/brand brief                                |
| Personas + flows           | the project's persona/flow docs                                 |
| Prior work                 | `gh pr list --state merged --search "<keyword>"` · `gh issue list --search "<keyword>"` |

## Phase 1: Scope

1. Resolve `$ARGUMENTS` to a target (a surface, route, screenshot, or mockup). Confirm by navigating, don't assume.
2. If ambiguous, ask the user once with `AskUserQuestion`.
3. For a live surface, list the component tree that renders it and note which design-system components it consumes vs. hand-rolled local markup.

## Phase 2: Load prior context

Pull what's been tried, what's open:

```bash
gh pr list --state merged --search "<keyword>" --json number,title,mergedAt --limit 20
gh issue list --search "<keyword>" --json number,title,labels --limit 20
```

If the work is tracked on a ProjectV2 board, use `gh project item-list <num> --owner <owner> --format json` (the MCP can't do ProjectV2). Note any **tried-and-stuck** patterns — closed issues with PRs that didn't land the design correctly need a different approach than untouched gaps.

## Phase 3: Design sanity check (does this design even make sense?)

**Before** spending cycles on fidelity, ask: is the design itself good? A faithful build of a bad design is still a bad product.

Use the **`design-critique`** skill as the engine if available. Pass it the target (surface source, screenshot, or mockup), the project's actors/personas, and the brand/voice brief. Get a second opinion from **leith** for brand fit. Loop in **nyx** if anything touches a security boundary (tenant isolation, trust frame, sandbox). Loop in **otto** if an AI/LLM interaction's cost or latency looks off.

Work through the ten sanity questions from [/design-critique](design-critique.md) for the surface, and record sanity findings separately from fidelity findings:

```markdown
### Sanity finding: <one-line summary>

- **Severity**: S0 fundamental (redesign before implementing) | S1 significant (rework recommended) | S2 minor (next iteration) | S3 nitpick
- **Lens**: one of the ten sanity questions
- **Observed**: <what the design does>
- **Concern**: <why this won't serve the actor / brand>
- **Evidence**: <persona, lexicon/voice rule, heuristic, prior failure>
- **Recommended change**: <specific design adjustment, not just "fix it">
```

**Stop-flag** — if you find any **S0**, surface it loudly. A fidelity audit on top of a fundamentally flawed design is wasted effort.

## Phase 4: Audit (fine-fine-fine)

For each surface, work through every dimension. Use the **leith** subagent for UX/brand judgment calls — pass her the live source paths and the reference.

**Dimensions** (don't skip any):

| Dimension         | What to check                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Layout & IA**   | Grid, section order, surface chrome, nav entry, breadcrumbs.                                                        |
| **Components**    | Does the surface use the **design-system component**, or hand-roll markup the system already provides? Right variant? Right default state? Compare against the reference (gallery / mockup / component source). |
| **Copy**          | Headings, labels, microcopy, button text, empty-state, error-state, tooltips. Must follow the lexicon and the project's voice. Often the most-divergent dimension. |
| **Design tokens** | Colors/type/spacing/radii/elevation must be the project's tokens — **no magic hex / magic px** in surface code.      |
| **States**        | Empty, loading, error, dense, plus any product lifecycle states. Find the states the live surface is missing.        |
| **Interactions**  | Hover/active/focus. Transitions honor the motion tokens and `prefers-reduced-motion`. Click affordances, disabled states, form validation. |
| **Responsive**    | Layout holds at desktop / tablet / mobile. No horizontal scroll.                                                    |
| **Accessibility** | Contrast meets WCAG AA. Visible focus ring. ARIA on icon-only buttons. Logical heading order. Keyboard nav. (Lean on the project's a11y/contrast checks if it ships any.) |

For each gap found, record:

```markdown
### Gap: <one-line summary>

- **Severity**: P0 broken | P1 visual drift | P2 polish | P3 nice-to-have
- **Type**: missing | wrong-state | wrong-tokens | wrong-copy | wrong-component | wrong-interaction | wrong-layout | a11y
- **Reference**: <gallery demo / mockup / component / token file>
- **Implementation**: `<surface file>:<line>` (or screenshot region if the input was an image)
- **Observed**: <what's actually there>
- **Expected**: <what the system / reference prescribes>
- **Proposed fix**: <concrete change>
- **Effort**: S | M | L
- **Prior attempt**: <link to issue/PR if one already tried this>
```

**Optional live verification** — if the app's dev server is running and a browser-control MCP (e.g. `chrome-devtools`) is available, capture the actual rendered DOM/computed CSS and diff against the reference for any gap where the static read is ambiguous (e.g. "is that the token or a magic hex?"). Otherwise rely on source analysis.

> For a **fast compare-and-fix loop** against the running app — where edits land immediately rather than into a spec — use [/design-audit-local](design-audit-local.md). This command (`/design-audit`) is the thorough, spec-producing audit; they share the P0–P3 / S0–S3 vocabulary so findings move between them.

## Phase 5: Write the spec

Output path: `docs/specs/fidelity-<surface>-<YYYY-MM-DD>.md` (`mkdir -p docs/specs` first).

Skeleton:

```markdown
# <Surface> Fidelity Audit — <date>

Status: Draft
Owner: <operator>
Generated by: /design-audit

## Goal

Bring `<surface>` to fidelity with the design reference. **If the design sanity check below surfaced S0/S1 concerns, address those before fidelity work.**

## Scope

- Surface(s) audited: <list>
- Implementation files in scope: <list>
- Reference: <design-system components + gallery, or mockup pipeline>
- Prior attempts: <merged PRs, open issues>

## Design sanity (does this design make sense?)

### S0 — Fundamental (redesign before implementing)

<entries — or "None">

### S1 — Significant (rework recommended in parallel with fidelity fixes)

<entries>

### S2 — Minor (note for next iteration)

<entries>

### S3 — Nitpick

<entries>

**Verdict**: <one of>

- ✅ Design is sound — proceed straight to fidelity remediation.
- ⚠️ Design needs rework on N items — recommend a redesign pass before / alongside fidelity work.
- 🛑 Design is fundamentally broken — stop fidelity work; redesign first.

## Fidelity findings

### P0 — Broken

<gap entries>

### P1 — Visual drift

<gap entries>

### P2 — Polish

<gap entries>

### P3 — Nice-to-have

<gap entries>

## Phased remediation plan

### Phase 1: P0 fixes (one PR)

- <issue stubs>

### Phase 2: P1 visual drift (one PR)

- <issue stubs>

### Phase 3: P2 polish (one or more PRs)

- <issue stubs>

P3s deferred unless explicitly pulled in.

## Tried-and-stuck patterns

<attempts that didn't land the design correctly + a recommended different approach>

## Acceptance criteria (per phase)

<testable criteria for "done" — Marcelo should verify these are testable before handoff>

## Open questions

<anything the operator needs to decide before implementation>
```

## Phase 6: Testability pass

Hand the draft to the **marcelo** subagent for a testability review. Every acceptance criterion must be specific and testable ("the sign-in CTA renders the primary `Button` with text `Sign in`" — not "button works"). Update the spec with Marcelo's revisions.

## Phase 7: Report

Final response to operator:

- Spec path.
- **Design sanity verdict** — sound / rework / broken. Counts: S0 / S1 / S2 / S3.
- **Fidelity counts**: P0 / P1 / P2 / P3.
- Top 3 most-impactful fixes (mix of sanity + fidelity, prioritized by actor impact).
- Anything from prior attempts that needs a different approach this time.
- **If any S0 sanity findings**, lead with them — "⚠️ This design needs rework on X before fidelity work is worthwhile."
- Explicit request: "review the spec; when ready, run `/generate-project @<spec-path>` to convert it to a tracker project with phased issues."

## Operating rules

- **Sanity before fidelity.** Run Phase 3 first. If you find an S0, surface it immediately and shortcut the fine-fine-fine fidelity audit — a perfect build of a broken design is still broken. Operator decides whether to redesign or proceed.
- **No surface-level scans.** Open every relevant file. Read every design-system component the surface uses. The whole point of this command is the fine eye.
- **Use the system, don't reinvent it.** Hand-rolled markup that duplicates a design-system component is a finding even if it looks identical — the system is the contract.
- **Token compliance is not optional.** Any color/spacing/type/radius/shadow not from the project's tokens is a P1, even if visually close.
- **Don't auto-create issues yet.** The user reviews the spec first. Issue creation happens via `/generate-project` on the operator's command.
- **Cite, don't summarize.** Findings reference the reference side and `<surface file>:<line>` so the reviewer can verify each gap in 30 seconds.
- **States count.** A design that breaks down on empty/error/lifecycle states is a finding — those states are the product, not error cases.

See `CLAUDE.md` § Filing issues for how the eventual issues should be shaped.
