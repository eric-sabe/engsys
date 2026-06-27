# Shell safety: pipefail and validate before teardown

**Trigger:** A shell script with a pipeline, a risky one-shot step (synth, change-set, single deploy), or sourcing a `.env`.

**Failure mode:** Without `pipefail`, a failed upstream command in a pipe is masked by a successful filter — the script "succeeds" on broken data. Tearing down a working path before validating the novel step leaves you with neither. Unquoted `.env` values with spaces split and corrupt env.

**Correct behavior:**
- Set `set -o pipefail` and/or check `${PIPESTATUS[0]}` so a filtered pipeline doesn't mask an upstream failure.
- Validate the novel/risky step (synth, change-set, single deploy) BEFORE tearing down the working path.
- Quote `.env` values containing spaces when sourcing in bash.

**Check:** Does the script fail loudly when an upstream pipe command fails, and is the old path still intact until the new one is proven?

**Seen in:** recurring across multiple production projects.
