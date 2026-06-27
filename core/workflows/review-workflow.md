# Review workflow (`/prep-review` family)

Shared reference for the four slash commands that take a markdown proposal in the repo, get it in front of stakeholders via a shared drive (Docs/Slides) + chat, harvest feedback, and close the loop with an ADR.

The intended audience is stakeholders who have the org's document drive + chat but **no repo access** — this workflow is the bridge. (Tooling: a **document-drive MCP** like Google Drive and a **chat MCP** like Slack. Tool names are project-defined; this doc is tool-agnostic.)

## The four commands

| Phase | Command                                        | What it does                                                                                                      |
| ----- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1     | `/prep-review <path> [--as doc\|slides\|auto]` | Analyze source, pick surface, generate the review package, stage in `docs/reviews/<slug>/`, **gate on operator**. |
| 2     | `/prep-review-publish <slug> [--channel #x]`   | Upload to the drive as a native Doc/Slides, post a chat announcement, persist IDs in `state.yaml`.                |
| 3     | `/prep-review-collect <slug>`                  | Pull the current Drive doc body, render `feedback.md`, classify comments, **force operator resolution** on conflicts. |
| 4     | `/prep-review-finalize <slug>`                 | Draft an ADR matching repo style, post a chat thread summary, promote the final spec to `docs/specs/`.            |

Each command can be run in a fresh session — all state lives in the repo, not the conversation.

## Directory layout

```text
docs/reviews/<slug>/
├── state.yaml         # workflow state, IDs, phase — canonical
├── source.md          # snapshot of the source markdown at /prep-review time
├── package.md         # rendered version that went to the drive
├── feedback.md        # comments + body diff, rendered at /prep-review-collect
└── decisions.md       # operator decisions on each disagreement (challenge phase)
```

On `/prep-review-finalize`:

- ADR → `docs/architecture/adr/NNN-<slug>.md` (next number in sequence)
- Final reviewed spec → `docs/specs/<slug>.md`
- `docs/reviews/<slug>/` stays as the audit trail (do **not** delete)

## `state.yaml` schema

```yaml
slug: opportunity-led-pivot
source: docs/specs/opportunity-led-pivot.md
created_at: 2026-05-26T18:42:00Z
phase: drafted # drafted | published | feedback-collected | finalized
surface: doc # doc | slides
surface_reasoning: |
  One-paragraph explanation of why this surface was picked. Captured at
  /prep-review time. Useful for audit and for forcing honesty when --as auto picks wrong.
review_objective: |
  Decide between (A) shipping now with stubs, or (B) holding until end-to-end.

drive:
  shared_drive_id: 0AHj... # the org shared drive
  folder_id: 1AbCdEf... # the review subfolder
  file_id: 1XyZ...
  web_view_link: https://docs.google.com/document/d/1XyZ.../edit
  uploaded_at: 2026-05-26T19:10:00Z

chat:
  channel_id: C0123ABCDEF
  channel_name: content-review
  message_ts: "1716750600.123456"
  permalink: https://.../archives/C.../p1716750600123456
  posted_at: 2026-05-26T19:12:00Z

feedback:
  collected_at: 2026-05-27T14:00:00Z
  body_changed: true
  classification:
    clarification: 3
    disagreement: 2
    plus_one: 4
    side_discussion: 1
  unresolved_disagreements: 0 # must be 0 before finalize

adr:
  number: 21
  path: docs/architecture/adr/021-opportunity-led-pivot.md
  drafted_at: 2026-05-27T15:20:00Z

final_spec:
  path: docs/specs/opportunity-led-pivot.md
```

Only the fields relevant to the current phase need to be populated. Later commands read what they need.

## Surface selection (`/prep-review` heuristic)

Default `--as auto`. Recommend based on source shape; the operator confirms at the gate.

| Signal in source                                          | Surface                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| > 300 lines, multiple `##` sections, heavy prose          | **Doc**                                                       |
| Heavy bulleted / outline structure, < 100 lines           | **Slides** (if "deck", "pitch", "presentation" in name or H1) |
| Decision-focused, prose + 1–2 diagrams                    | **Doc**                                                       |
| Pitch-shaped (problem → solution → ask, narrative arc)    | **Slides**                                                    |
| Tied to an existing ADR pattern (spec / proposal / brief) | **Doc**                                                       |

If ambiguous: prefer **Doc**. Suggesting mode + threaded comments beat slides for actual review work.

## Drive folder convention

Review docs land in a dedicated review folder inside the org shared drive — everyone on the team already has access, so no per-doc sharing is needed.

- `/prep-review-publish` first searches the drive for the review folder by name (keep the query simple — some MCPs reject `trashed` / owner query fields). Shared-drive folders generally surface in search despite a misleading `canAddChildren: false` on the result.
- Persist `drive.folder_id` (and `drive.shared_drive_id` from the parent metadata) to `state.yaml` after the first lookup — subsequent publishes skip the search.

## Upload SOP — operator drag-drop, command picks up via folder polling

`/prep-review-publish` generates the artifact locally with a descriptive filename derived from the source H1 (the drive uses the filename as the artifact's title). The operator drag-drops it into the review folder. The command **polls the folder** to detect the new file — no copy-paste of URLs required.

**About the .docx-in-Docs mode**: the drive does **not** reliably auto-prompt to convert `.docx` → a native Doc (workspace-config dependent). That's fine — Docs supports full `.docx` editing (comments, suggesting, real-time collab). The file stays as `.docx` (mime `application/vnd.openxmlformats-officedocument.wordprocessingml.document`), comments get stored in `word/comments.xml` inside the file, and `/prep-review-collect` benefits because the file downloads as-is without an export step. The only cosmetic trade-off: the title in the drive UI shows the `.docx` extension.

**The mechanics:**

1. Verify the converter is on `PATH` (e.g. `pandoc`; bail with install instructions if missing).
2. Derive the filename: source H1 with `:` swapped for `—`, plus the extension. Example: `Proposal: Review workflow` → `Proposal — Review workflow.docx`.
3. Convert: `pandoc -f gfm -t docx docs/reviews/<slug>/package.md -o "docs/reviews/<slug>/<Derived>.docx"`.
4. Baseline the folder (record existing file IDs).
5. Print one clear instruction: "Drag `<path>` into `<folder URL>` — I'll detect it automatically."
6. Poll the folder every ~7s for up to ~3 min, diff against the baseline.
7. New file detected → fetch metadata for mime/title/web_view_link, persist to `state.yaml`, continue to the chat draft.
8. Polling timeout → ask the operator to paste the URL as a fallback.

**Why not fully automated** (recorded so we don't re-litigate it):

- Creating the file from `text/markdown` / `text/html` — the drive keeps the source mime type; no native Doc conversion.
- Creating from `text/plain` — auto-converts to a Doc, but the body shows literal `## heading` / `**bold**` chars. Rejected.
- Creating a `.docx` via base64 upload — technically works but the base64 string round-trips through LLM context; impractically slow and token-heavy. Hard no.
- Some chat workspaces gate canvas/upload features behind a paid tier.

**If the MCP ever adds** an "upload from local path" drive tool, a "convert source X to native Doc" parameter, or the chat workspace upgrades — revisit. Until then, drag-drop is SOP.

## Pulling comments back from the drive

The drive stores comments as a **separate resource** from the doc body. The MCP may not expose a direct `list_comments` tool, but the download/export accepts an `exportMimeType` — and several export formats **preserve comments inline**:

| Export MIME type                                                                  | Comments included?                         |
| --------------------------------------------------------------------------------- | ------------------------------------------ |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (.docx) | **Yes** — as native Word comments in OOXML |
| `application/vnd.oasis.opendocument.text` (.odt)                                  | **Yes** — as ODF annotations               |
| `text/html`                                                                       | **Yes** — typically as footnotes / sidebar |
| `application/pdf`                                                                 | No (export drops them)                     |
| `text/plain` / `text/markdown`                                                    | No                                         |

**Primary path** (`/prep-review-collect`):

1. Export as `.docx` (the `wordprocessingml.document` export MIME type).
2. Decode the base64 to `docs/reviews/<slug>/drive-export.docx`.
3. Parse the `.docx` (it's a zip; `word/comments.xml` holds comment text + author + ids; `word/document.xml` holds the anchors). Use a docx skill or unzip+XML directly.
4. Extract: comment text, author, anchor selection, resolved state (if present).
5. Also pull current body text from the .docx for the diff against `package.md`.

**Known caveat — resolved comments**: the drive's `.docx` export typically includes **open** comments but may omit **resolved** ones. If the operator's review pattern resolves comments before collect runs, those are effectively lost to the export. Mitigations: ask reviewers to leave comments open until collect runs (note this in the announcement); for any "I resolved that already" comments, fall back to operator-paste during classification.

**Fallback path** — if export parsing fails or yields nothing useful, ask the operator to paste comment text directly.

## Comment classification (`/prep-review-collect`)

For every comment / suggestion, classify as one of:

- **`clarification`** — reviewer asks a question or requests a tweak; incorporated into the next draft.
- **`disagreement`** — reviewer pushes back on a decision; **the operator must explicitly choose** accept / reject / explore-3rd-option before finalize. Recorded in `decisions.md`.
- **`plus_one`** — endorsement / "looks good"; tally only.
- **`side_discussion`** — adjacent thought, not blocking; surfaces in finalize as a "follow-ups" section.

`unresolved_disagreements > 0` in `state.yaml` **blocks** `/prep-review-finalize`. Run collect again after operator resolution.

## Chat post conventions

Channel default: the project's review channel (override with `--channel`).

First post (publish phase):

```text
📋 *Review needed:* <title>

<2–4 sentence summary of the proposal — what's being decided>

*Review objective:* <review_objective from state.yaml>

*How to weigh in:* Open the doc and leave inline comments / suggestions. Reactions on this message also count. _Please leave comments open (don't resolve them) until I collect feedback — resolved comments may not survive the export._

📎 <Drive link>
```

Finalize-thread reply:

```text
✅ *Decision recorded:* <ADR title>

<2–3 sentences: decision, key consequence>

📄 ADR: `docs/architecture/adr/NNN-<slug>.md` (in repo)
📄 Final spec: `docs/specs/<slug>.md`

Thanks for the feedback — N comments incorporated, M side-discussions tracked as follow-ups.
```

Use the draft-message tool for both — let the operator review before it ships.

## Commits

Per `CLAUDE.md` — never auto-commit. Each command **stages files and proposes a commit message**; the operator runs the commit. Suggested messages (add a `(#issue)` suffix if the project requires it):

- After `/prep-review`: `docs(reviews): draft review package for <slug>`
- After `/prep-review-publish`: `docs(reviews): publish <slug> review package (Drive + chat)`
- After `/prep-review-collect`: `docs(reviews): collect feedback for <slug>`
- After `/prep-review-finalize`: `docs(adr): ADR-NNN <title>` + `docs(specs): finalize <slug>`

## Idempotency and re-runs

- All commands check `state.yaml.phase` first. Running out-of-order → bail with the right next step.
- `/prep-review` on an already-drafted slug → require `--force` (overwrites `source.md`, `package.md`; keeps Drive/chat state if present).
- `/prep-review-publish` after a successful publish → no-op + report existing links. `--republish` deletes the old Drive file and posts a new chat message (use sparingly; resets comments).
- `/prep-review-collect` is naturally idempotent — re-running re-renders `feedback.md` from the current Drive state.
- `/prep-review-finalize` is idempotent on the ADR file (warns if the ADR number was already claimed).

## ADR style (for finalize)

Match the established shape — read 2–3 recent ADRs from `docs/architecture/adr/` first. The pattern:

```markdown
# ADR-NNN: <title>

|             |                              |
| ----------- | ---------------------------- |
| **Status**  | Proposed                     |
| **Date**    | YYYY-MM-DD                   |
| **Context** | 1–2 sentences + link to spec |
| **Related** | links to prior ADRs / issues |

---

## Context

<3–5 bullets of the situation>

## Decision N — <sub-decision title>

<the decision; sometimes a table>

## Consequences

- **Easier:** ...
- **Harder:** ...
```

Status defaults to `Accepted` on finalize (by the time finalize runs, the operator has incorporated feedback and resolved disagreements via `decisions.md`). The operator can downgrade to `Proposed` manually to leave the decision open.

## Failure paths

| Failure                               | Action                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Drive auth lapsed                     | Report clearly, instruct the operator to re-auth the MCP; do not write partial state              |
| Chat post fails after Drive upload    | Persist Drive IDs to `state.yaml` (so we don't re-upload); retry chat via `/prep-review-publish`  |
| Source markdown missing               | Bail immediately, no state changes                                                                |
| `docs/reviews/<slug>/` already exists | `/prep-review` requires `--force`; other commands proceed (they expect it)                        |

## Why four commands, not one

Each phase has a natural pause and a different operator decision:

1. **draft → publish**: "Does the package look right? Is this the right surface?"
2. **publish → collect**: wait for humans to review (hours to days).
3. **collect → finalize**: "I've thought about the disagreements. Here's my call."
4. **finalize**: emit the durable artifacts.

Cramming this into one command either skips gates or holds open a long-running session.
