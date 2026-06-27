# Operator choices are first-class

**Trigger:** A planning/orchestration workflow where an operator picks options and acceptance criteria come from a spec.

**Failure mode:** Operator-selected options get treated as silent assumptions and quietly dropped. Acceptance criteria get paraphrased and drift from the spec. Grouping/sequencing derived from prose in issue bodies disagrees with the tracked board.

**Correct behavior:**
- Turn every operator-selected option into a first-class, tracked item — never a silent assumption.
- Copy acceptance criteria VERBATIM from the spec as checkboxes.
- Use the board's structured Phase field as the authority for grouping, not prose in issue bodies.
- Make each tracked choice auditable back to the operator decision that produced it.

**Check:** Can every plan item be traced to either a spec criterion (verbatim) or a recorded operator choice?

**Seen in:** recurring across multiple production projects.
