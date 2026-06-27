# Keep an immutable source of truth

**Trigger:** You're processing source data into derived artifacts, especially in a pipeline you'll want to improve later.

**Failure mode:** Mutating source data in place, or treating derived artifacts as the only copy, means an improvement to the pipeline can't be applied retroactively — you'd have to re-acquire the raw data, which may be gone. Mutating shared/immutable resources corrupts everyone downstream.

**Correct behavior:**
- Store raw source data immutably; never overwrite it.
- Make every downstream artifact a REPLAYABLE transform of the raw source.
- Design so reprocessing after an improvement is free (just re-run the transform).
- Reference shared/immutable resources; never mutate them in place.

**Check:** After improving the pipeline, can you regenerate all artifacts from raw without re-fetching anything?

**Seen in:** recurring across multiple production projects.
