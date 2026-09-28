# Merging infrastructure code is a deploy: ship config flips inert at merge

**Trigger:** An infrastructure-as-code PR carries per-environment *values* (feature toggles, allowlists, secret references), and the repo auto-deploys some environment on merge to the main branch.

**Failure mode:** The PR is reviewed as "plumbing", but merging triggers the deploy pipeline and changes live behavior immediately. Two distinct arms of the same mistake:
- A flag says "configured" but the value resolves to an empty fallback, so the deploy succeeds and the app *semantically* locks users out.
- A secret reference points at a secret that has not been seeded, so the new revision fails to provision (a hard deploy failure).
Either way the bad state ships with the merge, and the PR ends up parked and amended.

**Correct behavior:**
- Answer the merge-consequence question in the PR body before routing it: what auto-deploys on merge, what is dispatch-gated, and does the deploy change runtime behavior or restart anything?
- Prefer **inert at merge**: ship plumbing with values equal to the service's current default, and make each real flip its own deliberate one-line PR sequenced after its prerequisites.
- **Seed before reference**: create the secret, then flip the "configured" flag, then deploy. Write that order in a comment next to the parameters.
- Gate secret-backed wiring behind an explicit boolean so the unconfigured path stays valid; mirror the pattern for future values.
- Remember that most platforms resolve secret references at revision creation, so rotating a secret needs a restart to take effect.

**Check:** If this merge deployed to the auto-deploy environment right now, would its behavior be unchanged?

**Seen in:** recurring in projects with push-to-main infrastructure pipelines.
