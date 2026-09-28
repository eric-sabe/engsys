# LLM-judge gates: strip fences before parsing, start advisory, and know what was judged

**Trigger:** Code calls an LLM and `JSON.parse`s the reply; or you add an LLM-as-judge step to a test suite or CI gate; or such a gate goes red with no code change (a `SyntaxError`, or null scores on every fixture).

**Failure mode:**
- **Format drift.** The model starts wrapping its JSON in a markdown code fence. `JSON.parse` throws, every score becomes null, pass rate drops to zero, and the suite that passed hours ago is red. It is provider-side output drift, not a regression in the code under test.
- **A drifting judge walls off deploys** when it is a required, hard-blocking gate.
- **Unexamined gate.** A judge scoring 0/N can be judging the wrong artifact (for example, fallback template text because the CI environment has only the judge's key and no generation credentials), so the number means nothing until you know what was evaluated.
- Judge complaints are sometimes correct product feedback (a description that merely repeats the rationale); calibrating the rubric down "fixes" the test and leaves the flaw.

**Correct behavior:**
- Strip a leading fence line and trailing fence before parsing, with regression tests that feed fenced payloads. Better, use schema-constrained structured output where the SDK supports it (see `prefer-tool-enforced-structured-output`).
- Start every judge advisory (non-blocking). Promote to blocking only after stability across runs and model versions, with an owner's sign-off; even then prefer advisory plus an alert so humans decide.
- When a judged gate goes red, first establish what artifact it evaluated and check whether the job is advisory before treating it as blocking.
- Read the judge's rationales as possible real feedback before touching the rubric.

**Check:** Does every parse of model output tolerate a fenced payload, and is the judge step non-blocking?

**Seen in:** recurring in eval harnesses and AI regression suites.
