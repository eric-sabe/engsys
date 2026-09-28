# Each review layer catches a different class of bug

**Trigger:** A change is "clean" under one reviewer, gate, or bot and someone treats that as sufficient, especially near a merge.

**Failure mode:** Layers are complementary, not redundant. On one already-green PR, over successive rounds: the local automated reviewer found only doc-accuracy nits; an adversarial security reviewer found logic and concurrency flaws but missed a runtime type-confusion (it reasoned about values, not input shape); the static-analysis scanner found that type-confusion, but only *after* push; and an advisory LLM reviewer found four real correctness and compliance bugs the others missed. A precheck that omits the scanner and the integration lane is not CI-green.

**Correct behavior:**
- Do not treat any one green as sufficient; know what each layer is blind to: hygiene review (comments, tests), threat-model review (logic, races), taint/type analysis (runtime shape, ReDoS), delivery and compliance semantics.
- Re-verify a security fix adversarially. First fixes are often partial (handled arity but not shape); a second pass on the fix pays for itself.
- "Advisory" or "precision unproven" does not mean ignore. Verify its critical findings against the code before dismissing.
- Know which checks run only post-push and do not treat local green as clearing them.

**Check:** For this change, which classes of bug did no layer look for?

**Seen in:** recurring in multi-reviewer pipelines.
