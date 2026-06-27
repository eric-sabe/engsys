---
description: Publish a staged review package to a shared drive (as native Doc/Slides) and announce in chat
argument-hint: <slug> [--channel #name] [--republish]
---

Publish a review package previously staged by `/prep-review`. Full workflow reference: [.claude/workflows/review-workflow.md](.claude/workflows/review-workflow.md).

Slug: $ARGUMENTS

> Tooling: this command uses the project's configured **document-drive MCP** (e.g. Google Drive) and **chat MCP** (e.g. Slack). The exact tool names are project-defined; the steps below are tool-agnostic.

## Steps

1. **Parse args**: slug (required), `--channel <name>` (default = the project's review channel), `--republish` (delete + repost).

2. **Load state**: read `docs/reviews/<slug>/state.yaml`. Validate:
   - Exists? If not → "Run `/prep-review <path>` first."
   - `phase == drafted` or `published` (latter is a no-op unless `--republish`).
   - `package.md` exists.

3. **Read `package.md`** — this is what gets uploaded.

4. **Drive: locate the review folder** (the project's review folder in its shared drive):
   - If `state.yaml` already has `drive.folder_id` → skip the search, use it directly.
   - Otherwise search the drive for the review folder by name.
   - **If the search returns nothing** (some drive MCPs don't include shared-drive content by default): ask the operator to paste the folder URL. The folder ID is the last path segment of the folder URL.
   - Persist `drive.folder_id` (and `drive.shared_drive_id` if available from metadata) to `state.yaml`. Subsequent publishes skip the lookup.

5. **Drive: generate the artifact with a descriptive filename, prompt drag-drop, detect via folder polling**:
   - Verify the converter is on PATH (e.g. `which pandoc`; bail with install instructions if missing).
   - **Derive the Drive filename from the source H1** (the drive uses the filename as the artifact's title in UI and chat):
     - Take the H1 of `package.md`.
     - Replace any `:` with `—` (filesystem-friendly, reads cleaner).
     - Append the right extension. Example: `Proposal: Review workflow via Drive + chat` → `Proposal — Review workflow via Drive + chat.docx`.
     - **Do not** use generic names like `package.docx` — those become ugly drive titles.
   - **For Doc surface**: convert `package.md` → `.docx` (e.g. `pandoc -f gfm -t docx docs/reviews/<slug>/package.md -o "docs/reviews/<slug>/<Derived>.docx"`).
   - **For Slides surface**: generate `.pptx` via the project's slide skill, same derived-filename pattern.
   - **Baseline the drive folder** before prompting: list existing file IDs in the folder (`baseline_ids`).
   - Print one clear instruction:
     > "Drag `docs/reviews/<slug>/<Derived>.docx` into this folder: `<folder URL>`. I'll detect it automatically — no need to paste anything back. Note: the drive may not auto-prompt to convert .docx → native Doc; that's fine, .docx editing supports comments and suggesting natively."
   - **Poll the folder** every ~7s for up to ~3 min: re-list the folder, diff against `baseline_ids`. New file → grab it.
   - If polling times out: print the folder URL again and ask the operator to paste the new file's URL manually (fallback).
   - Once detected: fetch metadata to capture `mimeType`, `title`, `web_view_link`.
   - **Do not** attempt to create the file via base64 upload — the base64 round-trip through LLM context is impractically slow.

6. **Persist Drive state**:

   ```yaml
   drive:
     folder_id: ...
     file_id: ...
     web_view_link: ...
     uploaded_at: <now ISO>
   phase: published
   ```

7. **Chat: resolve channel**:
   - Search the chat workspace for the channel name (strip leading `#`).
   - If not found → ask the operator for a valid channel.
   - Persist `chat.channel_id` and `chat.channel_name`.

8. **Chat: compose the announcement** (use the template in the workflow doc):

   ```text
   📋 *Review needed:* <H1 title>

   <2–4 sentence TL;DR from package.md>

   *Review objective:* <review_objective from state.yaml>

   *How to weigh in:* Open the doc and leave inline comments / suggestions. Reactions on this message also count.

   📎 <web_view_link>
   ```

9. **Chat: send as a draft first** — use the draft-message tool so the operator reviews wording before it ships. Wait for operator approval, then send.

10. **Persist chat state**:

    ```yaml
    chat:
      channel_id: ...
      channel_name: ...
      message_ts: ...
      permalink: ...
      posted_at: <now ISO>
    ```

11. **Report back**: Drive link, chat permalink, summary of where to find things.

12. **Propose a commit message**:

    ```text
    docs(reviews): publish <slug> review package (Drive + chat)
    ```

## `--republish` behavior

- Confirm with the operator first: "This will delete the existing Drive doc (losing any comments / suggestions on it) and post a fresh chat message. Proceed?"
- If the MCP can't delete, bail and ask the operator to delete in the UI, or skip deletion and overwrite content via a new upload.
- Reset `drive` and `chat` fields in `state.yaml`, then run steps 4–11 fresh.

## Failure modes

- **Drive upload succeeds, chat post fails**: persist Drive state, bail with "Drive done. Re-run `/prep-review-publish <slug>` to retry chat only."
- **Both fail**: no state changes beyond what already succeeded; the operator can re-run safely.
- **Channel not found**: ask the operator to specify or create the channel; do not invent one.

## Important

- This is the first irreversible-ish action (humans will see the doc). Take the gate at step 9 seriously — chat messages can be deleted but the notification already fired.
- Don't call Drive `delete` operations unless explicitly approved — losing comments is destructive.
- Don't auto-commit.
