# Match marker comments by leading position and author, never `includes()`

**Trigger:** A bot or script keeps "its own" PR/issue comment by a hidden marker (an HTML comment such as `review-findings`, `ci-summary`), and it updates, upserts or harvests comments by marker. Also: a comment you own got overwritten with another tool's output, or you end up with two comments carrying the same marker and none carrying the other.

**Failure mode:** Several marker-comment protocols share one thread and often one identity (one shared token, or one operator's `gh` login).
- `body.includes(MARKER)` matches any comment that merely *mentions* the marker in prose or quoted docs (backticks don't help, the substring is still there). The older foreign comment becomes the "canonical" upsert target and is overwritten, destroying that record.
- `gh pr comment --edit-last` edits the latest comment by that user. Once another script has posted under the same identity, "your last comment" is not yours, and the edit clobbers it.
- Foreign or untrusted text rendered into a marked comment can carry marker/delimiter sequences (`<!--`, `-->`, a forged machine block) that capture a later parse; parsing the first embedded block lets a forged earlier one win.

**Correct behavior:**
- Match the marker in **leading position**: `body.trimStart().startsWith(MARKER)`. Your renderer emits the marker as line 1, so a mention anywhere else must never match.
- Upsert only comments the **authenticated identity authored** (the API's "viewer did author" flag, or compare the comment author). If only foreign marker-bearing comments exist, create your own; never patch theirs.
- Never use `--edit-last` on a thread where any other script posts under the same identity. Resolve the comment id by marker + author, then PATCH that id. Better: write a combined comment once, after the other tools have posted.
- Neutralize marker and comment-delimiter sequences in untrusted or model-authored text before rendering it into a marked comment. When you embed a machine-readable block that your own renderer appends **last**, parse the LAST occurrence.
- When writing docs or comments that talk about a marker, name it without the full delimiter syntax ("the review-findings-marked comment") so prose can't collide with matchers that predate this rule.

**Check:** Post a comment that mentions the marker in the middle of its prose (and one by a different author that starts with it); run the upsert; the mention-only and foreign comments are untouched and your own comment is created or updated. Grep for `includes(` / `contains(` / `grep -F` against marker constants.

**Seen in:** recurring across projects that run more than one comment-posting bot or script on the same PRs.
