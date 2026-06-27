# Async callbacks must verify liveness

**Trigger:** A callback, webhook, or deferred task fires and mutates the state of a target that may have moved on.

**Failure mode:** By the time the callback runs, the target may be stale, superseded, or gone. Writing its state blindly resurrects dead entities or clobbers newer data. In-flight writes that don't gate downstream actions cause ordering bugs.

**Correct behavior:**
- Verify the target is still alive/current before touching its state.
- Gate downstream actions on the completion of in-flight writes.
- Make read-modify-write a single atomic statement, not a check-then-write pair.
- Treat a stale/missing target as a no-op, not an error to force through.

**Check:** If the target was deleted/superseded mid-flight, does the callback safely skip instead of writing?

**Seen in:** recurring across multiple production projects.
