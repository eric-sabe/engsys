# Model identity with stable ids and provenance

**Trigger:** You're joining records, deduping, or attributing data across sources or over time.

**Failure mode:** Joining on mutable names/handles breaks when they change or collide, silently merging distinct entities. Dropping provenance means you can't tell where a datum came from or how fresh it is. Guessing an identity to avoid a null fabricates wrong links.

**Correct behavior:**
- Join on stable, unique ids — never on mutable names/handles.
- Carry source + timestamp provenance on every datum, end-to-end, so the UI can render it.
- Prefer null over a guessed identity.
- Surface provenance to users so they can judge freshness and origin.

**Check:** For any displayed datum, can you trace its source and timestamp without guessing?

**Seen in:** recurring across multiple production projects.
