# Stray control bytes hide changes

**Trigger:** A changed file shows as "Bin" in `git diff --stat`, or review bots / grep silently skip it.

**Failure mode:** NUL or other control bytes make git classify a text file as binary. Review bots ignore binary diffs and grep won't match inside them, so real changes ship unreviewed and unsearchable. Literal control bytes often sneak in via regex character ranges written as raw bytes.

**Correct behavior:**
- Write regex control-character ranges as backslash escapes (e.g. `\x00`), never as literal bytes.
- After editing, confirm every changed file shows +/- line counts in `git diff --stat`, not "Bin".
- If a text file reads as binary, hunt down and remove the stray control byte before committing.

**Check:** Does `git diff --stat` show numeric +/- for every changed text file (no "Bin" entries)?

**Seen in:** recurring across multiple production projects.
