# Deploy by digest, verify the running revision

**Trigger:** You deployed, and code that's clearly merged appears missing in production.

**Failure mode:** Deploying by a mutable tag (e.g. `:latest`) means the running container may be stale or ambiguous. Without verifying the active revision, "merged but missing" gets misdiagnosed as a code bug when it's actually a deploy/rollout/cache/data-gating issue.

**Correct behavior:**
- Deploy by immutable digest, not a mutable tag.
- Use a unique revision id per deploy.
- After every deploy, verify the ACTIVE revision/digest is the one you intended.
- For "merged but missing", suspect deploy/rollout/cache/data-gating BEFORE suspecting code.

**Check:** Does the live revision's digest match the artifact you just built?

**Seen in:** recurring across multiple production projects.
