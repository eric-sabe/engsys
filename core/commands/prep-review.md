---
description: Stage a markdown proposal for stakeholder review — generate a review-ready package, pick a surface (Doc/Slides), gate on operator
argument-hint: <path-to-markdown> [--as doc|slides|auto] [--force]
---

Stage a review package for stakeholders who live outside the repo (no source access — reviewing via Docs/Slides + chat). Full workflow reference: [.claude/workflows/review-workflow.md](.claude/workflows/review-workflow.md).

Source: $ARGUMENTS

## Steps

1. **Parse args**: source path (required), `--as doc|slides|auto` (default `auto`), `--force` (overwrite existing).

2. **Read the source markdown.** If missing → bail clearly. Derive a slug from the filename (kebab-case, no extension).

3. **Check `docs/reviews/<slug>/`**:
   - Doesn't exist → proceed.
   - Exists without `--force` → bail with: "Already drafted. Re-run with `--force` to overwrite, or `/prep-review-publish <slug>` to ship it, or `/prep-review-collect <slug>` if it's already published."
   - `--force` → preserve `state.yaml` Drive/chat fields if present (so we don't lose IDs); only overwrite `source.md` and `package.md`.

4. **Analyze the source** for surface recommendation (only if `--as auto`):
   - Count `##`/`###` headings, list lines, paragraphs, tables, image refs.
   - Look at filename + H1 for words like "deck", "pitch", "presentation" → tilt Slides.
   - Length > 300 lines or heavy prose → tilt Doc.
   - Decision-focused / spec-shaped → Doc.
   - See the surface heuristic in the workflow doc.
   - If `--as doc` or `--as slides` is explicit, skip analysis.

5. **Extract the review objective.** Look for a `## Review objective` (or `## Decision needed` / `## What we need from you`) section in the source. If missing, **ask the operator** for a 1–3 sentence statement before proceeding — this is what stakeholders are being asked to decide.

6. **Generate the review package** at `docs/reviews/<slug>/package.md`:
   - Lead with a 3–5 sentence **TL;DR**, stakeholder-facing. If the source already has a TL;DR, **don't just copy it** — the source TL;DR is repo-facing ("here's what this doc is"); the package TL;DR is stakeholder-facing ("here's what we need from you"). End it with an explicit "What we need from you" clause if not already obvious.
   - Then the **Review objective** verbatim.
   - Then the full source content (lightly reformatted only if the surface is Slides — see below).
   - Trailing **"How to leave feedback"** block: "Use suggesting mode for prose changes. Use inline comments for questions or disagreements. React 👍 on the announcement if you're aligned with no comments. **Please leave comments open** (don't resolve them) until you're told feedback has been collected — resolved comments may not survive the export."
   - For **Slides**: restructure into slide-shaped chunks separated by `---`. One concept per slide. Move long prose to speaker-notes-style indented blocks. **Ask the operator to confirm the slide structure** before publish.

7. **Snapshot the source** to `docs/reviews/<slug>/source.md` (raw copy, for diffing later).

8. **Write `state.yaml`** with: slug, source path, created_at (ISO 8601), `phase: drafted`, `surface`, `surface_reasoning` (one-paragraph honest explanation — captures *why* this surface was picked, for audit and to force honesty when `--as auto` picks wrong), `review_objective`. No Drive/chat fields yet.

9. **Gate on operator** — present:
   - Surface choice + 1-line reasoning ("Recommended Doc because 480 lines, 12 sections, no deck signal in title")
   - TL;DR you wrote
   - Review objective
   - File list staged
   - **Ask explicitly**: "Look good? Reply 'publish' to run `/prep-review-publish <slug>`, 'iterate' to revise, or 'abort' to back out."

10. **Propose a commit message** (do not run it):

    ```text
    docs(reviews): draft review package for <slug>
    ```

## Tool notes

- Use `Read` for the source, `Write` for all generated files.
- Don't call any Drive or chat tools — this phase is local only.
- Don't auto-commit (`CLAUDE.md` rule).

## Important

- The package is what stakeholders will read. Quality matters — this isn't a mechanical conversion. Add a TL;DR, ensure section flow makes sense out of repo context, expand acronyms on first use.
- The source markdown stays untouched. Only `docs/reviews/<slug>/` is written.
- If the operator says "iterate", make the revision in `package.md` (not the source), then re-gate.
