# Re-read state at the moment you act

**Trigger:** You're about to act on a spec, file, or assumption you read earlier in the session.

**Failure mode:** Content reconciles and changes under you between read and act. Acting on a snapshot from session start — or asserting "X doesn't exist" against a stale working tree — produces decisions based on a world that no longer exists.

**Correct behavior:**
- Re-read specs/files at the moment of acting, not just at session start.
- Verify "X doesn't exist / X still says Y" against origin/main (or current truth), not a possibly-stale local copy.
- After any reconcile/merge/regen step, re-read before continuing.

**Check:** Is the content you're acting on the current version, fetched just now?

**Seen in:** recurring across multiple production projects.
