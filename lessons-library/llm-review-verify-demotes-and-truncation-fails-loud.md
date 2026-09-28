# An LLM review's verify pass may demote but never delete, and truncation is not "no findings"

**Trigger:** You build or configure an LLM reviewer with a second "verify" or "filter" pass; or a review comes back suspiciously clean, thin, or self-contradicting (a summary describing defects above an empty findings list); or a reviewer's findings block ends mid-JSON.

**Failure mode:**
- **A delete-mode verifier destroys evidence.** It wipes real findings on its own mistakes, leaves a review that contradicts itself, and removes the data you would need to notice it is wrong.
- **A weaker verifier over a stronger generator inverts the quality gradient.** The model least able to see the bug decides whether it is real, and the review still looks calibrated.
- **Truncation reads as a clean review.** An output-token cap (`finish_reason: length`, or an `incomplete` status) cuts the final answer, and on reasoning models the hidden reasoning tokens spend the cap, so the findings block can vanish entirely. A parser that fails closed to an empty list then reports "no findings" for code that was never fully reviewed.
- **A partial verdict list silently changes the result.** Missing verdicts drop findings; a duplicate with a conflicting verdict keeps one you meant to refute.
- **Stacked precision filters** ("leave it out when unsure" in the generator, "default to false when uncertain" in the verifier) systematically suppress judgment-shaped findings.

**Correct behavior:**
- Verify means **demote**: refuted findings drop to info, flagged `unconfirmed`, with the verifier's reason rendered. Never delete. Demoted findings stay countable, so a demoted finding that turns out real measures the verifier's error rate.
- A "false" verdict must cite the specific guard, type or caller that neutralizes the finding; an inconclusive investigation leaves the finding standing.
- The verifier is at least as strong as the generator, or absent. To save cost, disable verification; do not weaken it. Enforce the ordering in configuration at startup.
- Require exactly one in-range verdict per candidate; anything else **fails open** (keep every finding, undemoted) and says so.
- Check the stop reason on every model call, tool-calling turns included. Anything but a clean stop throws with the knob to turn, and the tokens already spent are still accounted. The only valid "no findings" is an explicit, parseable, empty findings array.
- Ask for confidence instead of "drop when unsure".

**Check:** If the verifier were wrong on every finding, would the real ones still be on the page? If the response were cut at the token cap, would the run fail rather than post a clean review?

**Seen in:** recurring in LLM reviewers, judges and filters that run a second pass over a first pass's output.
