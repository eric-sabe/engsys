# Verify ground truth, not reports

**Trigger:** Something or someone says "done", "passing", "merged", "deployed", or "I will…" — and you're about to act on that claim.

**Failure mode:** Agents narrate intent ("I will run the tests") as if it already happened; status reports are optimistic; local-green is mistaken for CI-green. Acting on the narration instead of the state means building on a result that never actually landed.

**Correct behavior:**
- Check real state directly: the merged PR view, the pushed SHA, the actual CI run, the rendered UI — not the prose describing it.
- Re-run the gate yourself rather than trusting that it was run.
- Treat local-green and CI-green as different facts; CI is the authority.
- Watch CI to completion; a started run is not a passed run.

**Check:** Can you point to a concrete artifact (run URL, SHA, screenshot) that proves the claim, independent of who reported it?

**Seen in:** recurring across multiple production projects.
