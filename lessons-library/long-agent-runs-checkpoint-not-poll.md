# Long agent runs: checkpoint, don't poll

**Trigger:** A single agent run is expected to take a long time, or an agent is sitting in a polling loop waiting on a review bot.

**Failure mode:** Long single runs die from stale socket reuse (not a clean hard timeout), losing all uncommitted work. Agents that poll review bots burn time and tokens waiting, and block the orchestrator.

**Correct behavior:**
- Checkpoint long work into short runs that commit/push after each unit, so progress survives a death.
- Don't rely on a single marathon run to finish before something breaks.
- Terminate implementation agents at PR-open instead of polling for review results.
- Let the orchestrator handle review follow-up, freeing the implementation agent.

**Check:** If the run died right now, is the completed work already committed and pushed?

**Seen in:** recurring across multiple production projects.
