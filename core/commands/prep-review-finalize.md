---
description: Draft the ADR from a reviewed proposal, close the loop in chat, promote the final spec to docs/specs/
argument-hint: <slug>
---

Close out a review: ADR + chat thread reply + promote the final spec. Full workflow reference: [.claude/workflows/review-workflow.md](.claude/workflows/review-workflow.md).

Slug: $ARGUMENTS

> Tooling: uses the project's configured **document-drive MCP** and **chat MCP**. Tool names are project-defined; the steps below are tool-agnostic.

## Steps

1. **Load state**: read `docs/reviews/<slug>/state.yaml`. Validate:
   - `phase == feedback-collected`.
   - `feedback.unresolved_disagreements == 0` (else bail: "Run `/prep-review-collect <slug>` again — N disagreements still unresolved.").
   - `decisions.md` exists if any disagreements were recorded.
   - `feedback.md` exists.

2. **Gather all inputs**:
   - `source.md` (original)
   - `package.md` (what went to Drive)
   - Current Drive body (read via the drive MCP using `drive.file_id`)
   - `feedback.md` (classifications + per-section)
   - `decisions.md` (operator's resolutions on disagreements)

3. **Determine the next ADR number**:
   - List `docs/architecture/adr/*.md`, parse the `NNN-` prefix, take max + 1.
   - Watch for any existing collision pattern (e.g. two files sharing a number). Confirm with the operator if there's ambiguity.

4. **Read 2–3 recent ADRs** for voice and structure. Match the format:
   - `# ADR-NNN: <title>`
   - Header table: Status | Date | Context | Related
   - `## Context` (3–5 bullets)
   - `## Decision N — <sub-title>` sections (often a table for enums/options)
   - `## Consequences` (Easier / Harder bullets)
   - Optional `## Follow-up` (out-of-scope side-discussions go here)

5. **Draft the ADR** at `docs/architecture/adr/NNN-<slug>.md`:
   - **Status:** `Accepted` by default (the operator has already reviewed feedback and resolved disagreements via `decisions.md`). Operator can manually downgrade to `Proposed` to leave the decision open for further input.
   - **Date:** today.
   - **Context:** 1–2 sentences citing `docs/specs/<slug>.md` (the final spec we're about to write) and any related ADRs.
   - **Related:** prior ADRs that touch the same area, the source spec path, the Drive review link.
   - **Decisions:** one per significant call. For each disagreement that landed in `decisions.md`, capture the decision + the rationale (why we chose accept/reject/explore).
   - **Consequences:** honest trade-offs from the synthesis. Don't overstate the upside.
   - **Follow-up:** the `side_discussion` items from `feedback.md`, listed as tracked but out-of-scope for this ADR.

6. **Promote the final spec** to `docs/specs/<slug>.md`:
   - This is the **post-review** version, not the original source.
   - Start from the current Drive body — it includes accepted suggestions.
   - Layer in any clarifications from `feedback.md` that weren't body-edited.
   - Add a header block linking back to the ADR and the review trail:

     ```markdown
     # <Title>

     > **Status:** Finalized after review · See [ADR-NNN](../architecture/adr/NNN-<slug>.md) · Review trail: [`docs/reviews/<slug>/`](../reviews/<slug>/)
     ```

   - If the source markdown was already at `docs/specs/<slug>.md`, **diff** the new content vs the old before overwriting and report the changes.

7. **Gate on operator** — present:
   - ADR draft (full text, inline)
   - Final spec diff vs source
   - Chat reply draft (next step)
   - **Ask explicitly**: "Looks good? Reply 'post' to send the chat reply and finalize, 'iterate' to revise either, or 'abort'."

8. **Chat: compose the thread reply** (template in the workflow doc):

   ```text
   ✅ *Decision recorded:* <ADR title>

   <2–3 sentences: decision summary, key consequence>

   📄 ADR: `docs/architecture/adr/NNN-<slug>.md` (in repo)
   📄 Final spec: `docs/specs/<slug>.md`

   Thanks for the feedback — N comments incorporated, M side-discussions tracked as follow-ups.
   ```

   - Reply **in-thread** on the original announcement (`thread_ts` = `chat.message_ts`).
   - Optionally broadcast back to the main channel if the decision is worth re-surfacing (ask the operator).

9. **Update `state.yaml`**:

   ```yaml
   phase: finalized
   adr:
     number: NNN
     path: docs/architecture/adr/NNN-<slug>.md
     drafted_at: <now ISO>
   final_spec:
     path: docs/specs/<slug>.md
   chat:
     finalize_reply_ts: <reply ts>
     finalize_reply_permalink: ...
   ```

10. **Report back**: ADR path, final spec path, chat thread permalink, summary.

11. **Propose commit message(s)** — suggest splitting into separate commits for clarity:

    ```text
    docs(adr): ADR-NNN <title>
    docs(specs): finalize <slug> after review
    docs(reviews): mark <slug> finalized
    ```

## Tool notes

- Drive: only read the current body (to pull into the final spec). No writes to Drive.
- Chat: reply in-thread. Use a draft first if the operator hasn't seen the wording.
- Read recent ADRs from `docs/architecture/adr/` before drafting — don't invent the format.

## Important

- The ADR is durable. It will get cited for years. Take this draft seriously: clear context, sharp decisions, honest consequences. Read recent ADRs for voice — terse, tabular where it helps, no marketing language.
- The Drive doc stays untouched. The review trail in `docs/reviews/<slug>/` is preserved as the audit log.
- **Do not** delete `docs/reviews/<slug>/` after finalize. It's the receipts.
- If the source markdown was outside `docs/specs/`, ask the operator where the final spec belongs — don't auto-relocate.
- Don't auto-commit.
