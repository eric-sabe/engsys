# Prove causation before acting

**Trigger:** You have a plausible explanation — backed by vendor docs or a web search — and you're about to fix based on it.

**Failure mode:** A plausible hypothesis is not a diagnosis. Anchoring on an adjacent hop that tests green (the source emitted the right thing) while the real decision happens elsewhere (the destination rejected it) leads to fixing the wrong layer.

**Correct behavior:**
- Isolate one variable at a time and observe its effect directly.
- Instrument at the DECIDING boundary — read the destination's actual admission/decision, not the source's intent.
- Don't let "this adjacent step passes" stand in for "the failing step is understood."
- Reproduce the failure under your hypothesis before committing to the fix.

**Check:** Can you show the exact point where good input becomes the bad outcome, observed (not inferred)?

**Seen in:** recurring across multiple production projects.
