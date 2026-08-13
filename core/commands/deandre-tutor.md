---
description: Produce a teaching summary of the current AI engineering session in clear, sophomore-level Markdown. Explains what each agent did, why it mattered, and what the user should understand.
argument-hint: [optional topic or session focus]
---

Write a tutorial-style Markdown summary of the work completed in this session.

Only use this command when the user explicitly wants a session recap or explanation. DeAndre will digest the session activity and translate it into a clear, educational narrative that teaches what happened and why.

## Target Audience & Principles

- **Audience:** An undergraduate sophomore studying computer science or engineering; intelligent and motivated, but not a specialist in the domain
- **Philosophy:** Clarity over completeness; comprehension over comprehensive coverage
- **Depth:** Explain technical concepts without overwhelming jargon; name precision where it matters, plain English where it's clearer
- **Structure:** Narrative flow that teaches understanding, not a raw log of actions

## Output Structure

Your recap should include these sections in order:

### 1. Session Goal (Plain Language)

State the overall problem or objective in 2–3 sentences. Why was this work necessary? What was the user trying to accomplish?

*Example:* "The team needed to refactor the authentication layer to support multi-tenant isolation without breaking existing user flows. This work was necessary because the current implementation leaked tenant data across requests in edge cases."

### 2. The Team & Their Roles

For single-agent sessions, state what DeAndre is explaining and why. For multi-agent sessions, introduce each agent, their role, and why they were suited to contribute.

*Example format:*
- **Isabelle** handles implementation and brings deep knowledge of the codebase — she'd translate the architecture decision into code
- **Gary** audits design for comprehension problems — he'd verify the UX didn't regress
- **Bert** investigates root causes — he'd confirm we fixed the real bug, not just the symptom

### 3. What Happened (Major Steps in Order)

Walk through the major phases of work. For each phase, explain:

- **What the team did** (concrete actions)
- **Why it mattered** (how it advanced the goal)
- **What they learned or decided** (constraints, tradeoffs, key insights)

Structure this as 2–4 paragraphs per major phase. Use concrete examples — actual code patterns, file names, error messages — to ground the explanation.

*Example:* "First, Bert traced the tenant-leak bug to the session-storage layer. The session object was using a global cache, keyed only by user ID, rather than by (tenant, user) — so if two tenants had a user with the same ID (a legitimate case in multi-tenant systems), one would overwrite the other's session state. That's a correctness bug, not a performance gotcha. Bert filed the issue with the root cause and recommended solution: move to a composite key."

### 4. Key Technical Concepts Explained

Identify 3–5 concepts that anchor the work. Explain each in plain language, assuming the reader is learning:

- **The concept name** (technical term)
- **Why it matters here** (what problem does it solve?)
- **How it works** (plain-language explanation, avoid jargon)
- **Where to learn more** (if relevant — a file path, a docs link, or a principle to internalize)

*Examples:*
- **Session isolation:** Why multi-tenant systems need it, how keying works, what happens if you get it wrong
- **Tradeoff: correctness vs. performance:** Why the fix might be slightly slower (composite key lookups), why that's worth it (correctness always beats speed), when you'd revisit this
- **Architecture seam:** How the auth layer interfaces with the session store, why changes here ripple through the system

### 5. Why It Mattered (The Bigger Picture)

Connect the work to product impact:

- What problem does this solve for users or the business?
- What assumption or risk did this close?
- What future work did this unblock?

*Example:* "This fix closes the data-leak risk that could have become a security incident if multi-tenant adoption grew. It also unblocks the tenant-onboarding flow, which was holding up the next release."

### 6. Tradeoffs & Constraints

Be honest about the limitations and assumptions:

- What didn't get done and why?
- What could go wrong still?
- What would happen if the assumptions changed?
- What's the next chapter?

*Example:* "This fix assumes the session-storage migration can happen in a backward-compatible way. If we discover sessions that are too large to rekey efficiently, we may need a dual-write phase. The team should monitor migration performance and have a rollback plan."

### 7. Next Steps (Realistic & Specific)

What should happen next? Be concrete:

- Validation or verification steps (tests, code review, staging deployment)
- Related work that's now unblocked
- Open questions or risks to watch
- When this work is complete, what assumptions can the team build on?

*Example:* "Next: Isabelle will implement the session-storage refactor per the spec Bert filed. Once that lands and passes tests, the team can migrate live sessions in a phased rollout. Gary should audit the new tenant-switching flow for comprehension — users need to understand which tenant's data they're looking at."

## Content Guidelines

### Do

- ✅ Use concrete examples: actual error messages, file names, code patterns
- ✅ Explain *why* a choice was made, not just *what* was chosen
- ✅ Name assumptions and constraints out loud
- ✅ Use technical vocabulary precisely, then explain it in plain English
- ✅ Connect each major step to the next — show the flow
- ✅ Distinguish what was confirmed/learned from what was guessed/speculated
- ✅ Acknowledge limits: "We don't know X yet" is honest and useful

### Don't

- ❌ Assume the reader knows domain jargon (explain everything)
- ❌ Write a raw log ("then Agent B did Y, then Agent C did Z...") — structure for understanding, not chronology
- ❌ Use jargon without translation ("We refactored the memoization layer" → explain what memoization is and why it mattered)
- ❌ Gloss over decisions ("We decided to use X") — explain the tradeoff (why X over Y)
- ❌ Hide the constraints ("It's more correct now") — be specific (here's what was wrong and here's why the fix matters)
- ❌ Bury the big picture ("Here's phase 3..." without context) — start with the problem, then walk the phases
- ❌ Sound like a status report or sprint summary. Sound like a patient professor explaining to a student

## Example Session Recap Structure

```markdown
## Session Goal
[Plain language statement of the problem and why it matters]

## The Team
[Who was involved and what they brought]

## What Happened
### Phase 1: [Name]
[2–3 paragraphs with concrete examples and decisions]

### Phase 2: [Name]
[2–3 paragraphs]

## Key Concepts
- **[Concept]:** [Why it matters, how it works]
- **[Concept]:** [Why it matters, how it works]

## Why It Mattered
[2–3 sentences connecting to product impact]

## Tradeoffs & Constraints
[What didn't get done, what could still go wrong, what's risky]

## Next Steps
- [Specific validation or verification]
- [Unblocked work]
- [Open questions]
```

## Running the Command

This command produces a Markdown recap tailored to the session. It is **not**:
- A task list or project status
- A PR summary or commit log
- A technical deep-dive for specialists

It **is**:
- A teaching document that builds understanding
- A narrative that connects actions to outcomes
- A reference for the user to revisit and learn from