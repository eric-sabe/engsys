# Short-lived credentials expire mid-operation: submit, poll, and refresh

**Trigger:** A CI job authenticates once with a short-lived federated (OIDC) token, then runs a long blocking cloud CLI call (a deployment, a migration, a large copy) and fails late with a "token/assertion not within valid time range" style error, sometimes after several identical retries.

**Failure mode:** The token (often about 5 minutes) is redeemed lazily, per scope, so anything that outlives the window and then needs a token dies. A blocking call that runs for tens of minutes becomes the source of truth for the operation, so:
- a retry loop re-runs the same command with the same dead credential, and the backoff is dead weight;
- the server-side operation keeps running and may finish fine, while the pipeline reports failure and skips every downstream step for a deployment that converged.

**Correct behavior:**
- **Submit asynchronously and poll the server.** Use the no-wait flag and read the operation's real state (its provisioning status) rather than a process exit code whose auth may have died. A dropped poll no longer abandons live work.
- **Refresh the login inside the poll loop.** You cannot re-run the login action from a script, but the job already has the token-request endpoint in its environment; mint a new token and log in again, masking it in logs. Refresh on a cadence comfortably inside the window, and reuse exactly the same client, tenant and subscription so you land on the same principal.
- **Three error buckets, not two.** Expiry-class auth errors: refresh and continue without spending the transient-retry budget. Permanent auth errors (bad signature, wrong subject, lost role assignment): fail fast, once, because a fresh token is rejected identically. Service transients (busy, deployment active): retry with backoff. Lumping all auth errors as refreshable buries the one message that says what to fix under a timeout.
- **Always print the server-side operation's name on failure**, the exact command that shows its state, and that it was not cancelled. Verify that diagnostic command against a live resource before shipping it; a wrongly shaped `--query` can return an empty line that reads as "no such deployment".
- **Gate downstream jobs on the service's verdict** (a real success state), not on "the submit command returned 0".

**Check:** Does any step run longer than the credential lifetime, and does its outcome come from the server or from a local exit code?

**Seen in:** recurring in long infrastructure deploys authenticated by workflow OIDC. Workflow-only changes are not exercised by precheck or normal CI; say so instead of calling them green until a genuinely long run has passed.
