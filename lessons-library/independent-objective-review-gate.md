# Independent, objective review gate

**Trigger:** A change is "ready"; the author (human or agent) is signing off on their own work.

**Failure mode:** Authors rationalize past their own blind spots — the same assumptions that produced the bug excuse it in review. For visual/CSS changes, reading the stylesheet "looks right" while the rendered page is broken.

**Correct behavior:**
- Have a fresh reviewer with no stake re-review from scratch, not just skim the diff.
- The reviewer re-runs the gate independently rather than trusting the author's run.
- Return a binary verdict (pass/fail), not a vibe.
- For visual changes, inspect the RENDERED result (headless browser, screenshot), never just the source.

**Check:** Did someone who didn't write the change independently reproduce the passing state?

**Seen in:** recurring across multiple production projects.
