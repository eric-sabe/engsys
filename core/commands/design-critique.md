---
description: Sanity-check a proposal, mockup, screenshot, or live screen for design quality (does this make sense? will users bounce off it? are we designing this well?)
argument-hint: <proposal name, route path, file path, screenshot path, URL, or freeform description>
---

Stand-alone design critique. Use this to evaluate a design **before** committing to implementation, or to review a live screen for design quality. It is artifact-agnostic: the target can be a mockup, a proposal, a screenshot, a freeform description, or a live surface.

Target: $ARGUMENTS

For a full reference-vs-live comparison (sanity + fidelity), use [/design-audit](design-audit.md) instead. For a fast live fix loop, use [/design-audit-local](design-audit-local.md).

## What "the reference" is

The project's **design reference** is whatever the project uses as its source of truth — pick whichever exists:

- A **design-proposal pipeline** (mockup HTML / Figma exports / image comps), or
- A **design system as code** (tokens + components) plus a rendered component gallery/showcase, or
- A documented **brand / voice / lexicon** and persona docs.

`CLAUDE.md` (or the project's design docs) declares where these live. A critique asks two things: is the *design idea* sound, and does it *belong to this product's system and voice*?

## Anchors (resolve to the project's actual paths)

| What                    | Where (project-defined)                                          |
| ----------------------- | --------------------------------------------------------------- |
| Design tokens (truth)   | the project's token source (colors, type, spacing, elevation, motion) |
| Components              | the project's component library                                  |
| Component showcase/gallery | the rendered reference, if one exists                        |
| Mockups / proposals     | the proposal pipeline, if one exists                            |
| Brand / voice / lexicon | the project's design/brand brief                                |
| Personas + flows        | the project's persona/flow docs                                 |
| Brand context (agent)   | `.claude/agents/leith.md`                                       |

## Engine

Use the **`design-critique`** skill as the engine if available. Run the **gary** subagent as the critic — cold-open first-contact test, cognitive walkthrough, heuristic sweep with severity ratings; his findings anchor the verdict. Get a second opinion from the **leith** subagent for brand fit (she holds the voice and value prop). Loop in **nyx** if anything raises tenant-isolation, sandbox-escape, or PII concerns. Loop in **otto** if there's an AI/LLM interaction whose cost or latency model looks off.

## The ten questions (work through every one)

| #   | Question                                                                                  | Lens                 |
| --- | ----------------------------------------------------------------------------------------- | -------------------- |
| 1   | Does this serve the actor's actual job-to-be-done?                                         | Product strategy     |
| 2   | Is the IA / mental model right for that actor?                                             | UX architecture      |
| 3   | Is the most important thing the most prominent?                                           | Visual hierarchy     |
| 4   | How many clicks / decisions / words to get value?                                         | Cognitive load       |
| 5   | What does this look like across every realistic state — empty, partial, loading, error, dense, and any lifecycle states? States are the product, not error cases. | Realistic states |
| 6   | Does it feel like *this product*, or generic SaaS chrome?                                  | Brand alignment      |
| 7   | Are we asking for / showing data we shouldn't? Cross-tenant / PII leak risk?               | Privacy/security     |
| 8   | Where does this actor typically get stuck on this kind of screen?                          | Actor empathy        |
| 9   | Better, worse, or same vs the closest competitor for this job?                             | Competitive position |
| 10  | If a new user landed here cold, value understood in < 30s?                                 | Onboarding fitness   |

## Severity scale

- **S0 fundamental** — design needs rework before any implementation; would actively harm the product.
- **S1 significant** — design rework recommended; will frustrate an actor or undercut the value prop.
- **S2 minor** — note for next iteration; works but suboptimal.
- **S3 nitpick** — taste-level; surface but don't block on.

## Finding format

```markdown
### <one-line summary>

- **Severity**: S0 | S1 | S2 | S3
- **Lens**: which of the ten questions
- **Observed**: <what the design does>
- **Concern**: <why this won't serve the actor / brand / user>
- **Evidence**: <persona, competitor, lexicon/voice rule, heuristic, prior failure>
- **Recommended change**: <specific design adjustment — not just "fix it">
- **Effort to redesign**: S | M | L
```

## Output

Two modes depending on scope:

- **Quick critique** (default for small scope — one screen, no implementation file given): respond inline with a findings table + verdict. No file written. Operator reads, decides.
- **Formal critique** (target is a full surface/proposal or operator asks for a deliverable): write `docs/critiques/<target-slug>-<YYYY-MM-DD>.md` (`mkdir -p docs/critiques` first) with findings, verdict, and a recommended next step.

Final verdict, regardless of mode:

- ✅ **Design is sound.** Proceed to implementation (or fidelity audit via `/design-audit` if implementation already exists).
- ⚠️ **Design needs rework on N items.** List the S0/S1s. Recommend a redesign pass before implementation.
- 🛑 **Design is fundamentally broken.** Don't implement. Redesign first.

## Operating rules

- **Be specific.** "This is confusing" is not a finding. "The action panel has three CTAs at equal weight — the user can't tell which to click first" is.
- **Cite evidence.** Reference the actor, a lexicon/voice rule, a token/component the system already provides, a competitor's pattern, or a usability heuristic. Don't critique on taste alone.
- **Distinguish design from implementation.** This command critiques the design itself. If the user asks "is the live page good?", separate "the design is bad" from "the implementation drifted from the system" — that second one is a `/design-audit` conversation.
- **Don't pull punches on brand.** Generic SaaS chrome that doesn't feel like the product is an S1, not an S3. The brand is part of the product.
- **Empty / loading / error / lifecycle states count.** A design that's only good when everything is mid-flight is an S1.
- **Speculate honestly about actor reaction**, and label it as speculation. "Best guess: the user will hesitate here because nothing signals X" — say it, mark it a guess, not a fact.

When in doubt about S1 vs S2, err toward S1. Bad design is hard to recover from later.
