# A push runs the pre-push gate: budget the timeout, and treat a timeout as "unknown"

**Trigger:** A `git push` (or `precheck && git push`) issued through an agent's shell tool reports a timeout or error near the tool's default limit (often 2 minutes). Or an agent goes quiet with committed-but-unpushed work and a green local gate.

**Failure mode:** A pre-push hook re-runs the full gate (build, lint, unit, sometimes browser E2E), which routinely takes 3-10 minutes even when green. Two opposite things then happen, and both get misread:
- The tool kills the process mid-hook: nothing is pushed, no PR exists, and the agent surfaces no error. It looks like the agent stalled.
- The tool call reports a timeout but the underlying process keeps running and the push lands. Reacting to the report as a real failure produces a duplicate push, a torn-down worktree, or a rescue agent re-doing work for a PR that already opened.

**Correct behavior:**
- Give every push an explicit timeout above the gate's real duration (at least 5 minutes; up to the tool maximum when browser tests are in the diff), or run it in the background and check back. Run it foreground so failures are visible; report the hook output on any failure.
- Treat a timed-out push as **unknown**, not **failed**. Query the remote before any recovery: `git ls-remote origin <branch>` (does the SHA match local `HEAD`?) and `gh pr view <branch> --json state,headRefOid`. Retry or re-dispatch only if the remote lacks the commit.
- An orchestrator should do that check itself rather than trust an agent's self-report of a failed push.
- Commit per unit of work before the ship step, so a lost push costs "push an already-verified commit", never "redo the implementation".
- The hook re-running a gate you just ran is expected, not a hang.

**Check:** After any push-related tool call ends in timeout or error, did you run `git ls-remote` before doing anything else?

**Seen in:** recurring across projects with heavyweight pre-push gates and agent-driven shipping.
