---
description: Pull the current Drive doc body back, render feedback.md, classify comments, force operator resolution on disagreements
argument-hint: <slug>
---

Collect feedback on a published review. Full workflow reference: [.claude/workflows/review-workflow.md](.claude/workflows/review-workflow.md).

Slug: $ARGUMENTS

> Tooling: uses the project's configured **document-drive MCP**. Tool names are project-defined; the steps below are tool-agnostic.

## Steps

1. **Load state**: read `docs/reviews/<slug>/state.yaml`. Validate:
   - Exists?
   - `phase == published` or `feedback-collected` (latter = re-run; that's fine, idempotent).
   - `drive.file_id` present.

2. **Export the Drive doc as `.docx`** (preserves comments):
   - Download/export the file as `.docx` (the export MIME type that preserves comments).
   - Decode the returned base64 and write to `docs/reviews/<slug>/drive-export.docx`.
   - Also pull a clean text/markdown rendering of the body (used for the diff in step 3 — cleaner than parsing .docx XML for body text).

3. **Diff the body against `package.md`** (the snapshot we uploaded):
   - Read `docs/reviews/<slug>/package.md`.
   - Compute a section-level diff against the body text from step 2. For each H2/H3 section: classify as `unchanged | edited | added | removed`.
   - For edited sections, capture both the original and current text.

4. **Extract comments from the `.docx`**:
   - Use a docx-parsing skill, or unzip directly — `word/comments.xml` for comment bodies + authors, `word/document.xml` for the anchors mapping comment-id → anchored text.
   - For each comment, capture: id, author, anchored selection text, comment body, resolved state if present.
   - **Caveat**: drive `.docx` exports typically include **open** comments; **resolved** comments may be missing. If the comment count looks lower than expected, surface this to the operator and offer the paste-fallback (step 5).

5. **Fallback / supplement** — present what was extracted and ask:

   > "I pulled N comments from the .docx export. If you've resolved any in the doc already (those may not be in the export), paste their text here and I'll include them. Otherwise reply 'continue' and I'll classify."

6. **For each piece of feedback** (body change or comment), classify:
   - **`clarification`** — a question or small ask; will be folded into the next draft.
   - **`disagreement`** — pushback on a decision; needs an explicit operator call (accept / reject / explore-3rd-option).
   - **`plus_one`** — endorsement, no action needed.
   - **`side_discussion`** — adjacent thought, tracked as a follow-up, not blocking.

7. **For every `disagreement`, force operator resolution**:
   - Present the disagreement, the proposer (if known), and the surrounding context.
   - Ask: "Accept and revise the proposal, reject (keep original), or explore a third option?"
   - If "explore" → capture the operator's new direction.
   - Record the resolution in `docs/reviews/<slug>/decisions.md` (create or append).
   - Do **not** proceed to finalize until all disagreements have resolutions.

8. **Render `docs/reviews/<slug>/feedback.md`**:

   ```markdown
   # Feedback — <slug>

   Collected: <timestamp>
   Source: <web_view_link>

   ## Summary

   - N clarifications
   - M disagreements (X resolved, Y unresolved)
   - K plus-ones
   - L side discussions

   ## Per-section feedback

   ### <Section title>

   **Status:** edited | commented | unchanged

   **Original (excerpt):**

   > ...

   **Current (excerpt):**

   > ...

   **Comments:**

   - [clarification] <text> — <author> — _operator note: ..._
   - [disagreement] <text> — <author> — **resolved: accept** (see decisions.md)

   ## Plus-ones

   - <author>: <text or "👍 on announcement">

   ## Side discussions (tracked as follow-ups)

   - <text> — <author>
   ```

9. **Update `state.yaml`**:

   ```yaml
   phase: feedback-collected
   feedback:
     collected_at: <now ISO>
     body_changed: true|false
     comment_count: N
     classification:
       clarification: N
       disagreement: M
       plus_one: K
       side_discussion: L
     unresolved_disagreements: 0
   ```

10. **Report back**: brief summary (counts per category), highlight any unresolved disagreements, and the next step:
    - All resolved → "Ready for `/prep-review-finalize <slug>`."
    - Unresolved remain → "Resolve N disagreements before finalize. Re-run this command after."

11. **Propose a commit message**:

    ```text
    docs(reviews): collect feedback for <slug>
    ```

## Tool notes

- Drive: export as `.docx` (for comments) + a clean body-text read (for the diff). No writes to Drive.
- No chat calls in this phase.
- The classification step is judgment work — don't rubber-stamp. If a comment reads ambiguous, ask the operator before classifying.

## Important

- The `.docx` export typically gives you open comments. If the operator's review pattern resolves comments inline before collect runs, expect to need the paste-fallback. Note this in the announcement (workflow doc has the template).
- `decisions.md` becomes part of the ADR context in finalize — it's the trail of "we considered X, chose Y."
- Don't auto-commit.
