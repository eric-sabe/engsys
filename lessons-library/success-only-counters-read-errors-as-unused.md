# A success-only counter makes a broken capability look unused

**Trigger:** A tool or capability shows zero usage in a metric ("the agent never calls the search tool") and someone is about to conclude it is low-value and defer or remove it. Or any telemetry counter increments only on the success path of an operation that can throw.

**Failure mode:** The capability was never wired (a missing endpoint or credential), so every call threw, was caught, and returned an error string to the model, which quietly fell back to another tool. The counter incremented only *after* the awaited call, so attempted-but-errored calls recorded zero, indistinguishable from "never tried". That created circular reasoning: "zero usage, so low value, so don't wire it", when the zero was caused by not being wired. An offline eval that ran with the capability disabled cannot compare the two either.

**Correct behavior:**
- Count attempts and outcomes separately: attempted, succeeded, errored, disabled. Increment the attempt counter *before* the call and record the error on throw.
- Make the human-facing surface distinguish "not attempted", "attempted N times, unavailable", "disabled this run", and "N succeeded". Summarize failure as "unavailable"; never leak raw errors, endpoints, or secrets into a public surface.
- Before using a metric to justify "X is low-value", confirm X can actually run. A structurally-zero metric says nothing about value.
- Real production signal after wiring beats a confounded offline eval.

**Check:** For a metric near zero, can you show the code path reached the increment at least once in a dry run?

**Seen in:** recurring in agent tool telemetry and feature-adoption dashboards.
