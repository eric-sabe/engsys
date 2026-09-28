# Verify the deployed override, not the code default

**Trigger:** You are reasoning about what a running service actually does (a schedule, a feature flag, a replica cap, a timeout, a model id) and you read the value from a code default, an env-var fallback, or a template parameter default.

**Failure mode:** A config value has at least three layers: the code default, the per-environment override (a parameter file that becomes a container env var), and what is live. Reading only the first produces a confident, wrong premise. Example: a scout reads a daily cron from the config module and concludes "runs once a day", while the deployed environment overrides it to every 15 minutes; the user's own observation contradicts the conclusion.

**Correct behavior:**
- For "what does the running system do", grep the per-environment parameter files and the deploy wiring for that setting, not just the config default:
  ```bash
  rg -n "SCHEDULE|scheduleCron" <service>/src/config      # name + default
  rg -n "<paramName>|<ENV_VAR>" <infra-dir>                # deployed override
  ```
- For values that may have been changed out of band (hotfixed flag, manual scale), confirm against the live platform (`az`/`gcloud`/`kubectl ... show`), not just the IaC.
- Separate a durable design judgment (fine to reason about from code) from a fact-claim about runtime (verify fresh, at the layer that runs).

**Check:** Can you name the layer (default, override, live) the value you quoted came from?

**Seen in:** recurring in investigations that read code but describe production.
