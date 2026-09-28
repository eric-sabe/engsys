# Emit only after every write commits, and isolate publish failures

**Trigger:** You add an event publish (message bus, webhook, notification) or any external side effect to a flow that also does durable database writes, especially where a "winner" or "success" step is followed by a publish, or the spec says "after commit" or "publish before finalize".

**Failure mode:**
- **Premature emit.** The event is fired right after the status transaction commits, but the row's other writes (child entities, embeddings, derived columns) happen afterward. A consumer starts work on an entity that is not fully persisted.
- **Publish failure corrupts success.** A rejected publish propagates, and a run whose results were already committed is marked failed.

**Correct behavior:**
- **Order:** emit strictly after every durable write the event implies. If it says "X is ready", all of X (status, entities, embeddings) is committed first. An emit keyed on a status write that precedes the row's other columns is premature.
- **Isolate:** wrap the publish in its own try/catch; log the error *name* only (never the raw error or message); let the committed operation report success. A lost emit is recovered by a reconciliation sweep or durable outbox, not by failing the transaction.
- **Suppress on prior failure:** if a write the event depends on throws, let it throw *before* the emit so the event is not sent for a winner whose persistence failed.
- **Pin the ordering with tests:** a rollback publishes zero events; a publish rejection still completes the run.

**Check:** Between the emit and the last write it describes, is there any await or code path that can still change what a consumer reads?

**Seen in:** recurring in event-driven pipelines that mix transactions with a message bus.
