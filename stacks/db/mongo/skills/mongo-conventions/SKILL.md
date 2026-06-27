---
name: mongo-conventions
description: MongoDB conventions for this repo — async access via Motor, append-only data-lake discipline, and provenance on every datum. Use when reading/writing Mongo collections, adding ingest or transform pipelines, designing indexes, building an embedding/vector store on Mongo, or reasoning about which data is the system of record.
---

# MongoDB Conventions

Applies to: any code touching MongoDB in this repo (storage layers, ingest scripts, transforms, API routes).

> Naturalize: confirm the driver, database name, and the system-of-record collection(s) in `CLAUDE.md`.

## Async access (Motor)

- Use the **async driver (Motor)** end-to-end in async services; `await` every DB call. Don't block the event loop with the sync `pymongo` client in request paths.
- The sync `pymongo` client is acceptable only for things Motor doesn't cover (e.g. GridFS) or for offline scripts — keep it off the hot path.
- Centralize connection setup: build the connection string from the environment (`MONGODB_URI` / `DATABASE_URL`, falling back to a local default), and detect localhost to skip TLS for dev.
- Create collections and indexes idempotently in an `initialize_collections()`-style routine: check `list_collection_names()` first, then `create_index(...)`. Mark uniqueness explicitly (`unique=True`) on natural keys (e.g. `content_id`).
- Guard in-memory caches (vector indexes, derived state) with an `asyncio.Lock` so concurrent requests don't rebuild them simultaneously.

```python
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

client: AsyncIOMotorClient = AsyncIOMotorClient(connection_string)
db: AsyncIOMotorDatabase = client[db_name]
await client.admin.command("ping")          # verify connectivity
await db.content_raw.create_index("content_id", unique=True)
docs = await db.content_chunks.count_documents({})
```

## Append-only lake discipline

When the source data is expensive to acquire (paid APIs, rate-limited crawls, one-shot captures), keep a **raw lake collection that is the system of record** and treat everything downstream as a replayable transform:

- **Fetch once, keep forever.** Write raw payloads (with original structure and timestamps) into a lake collection (e.g. `*_lake` / `content_raw`). **Never re-fetch what's already in the lake** — re-fetching spends real money/quota.
- **Transforms are replayable and never destructive to the lake.** Chunking, extraction, tagging, embedding all read from the lake and write to *derived* collections. If a derived collection is lost, you can rebuild it for free from the lake.
- **Budget every acquisition run.** Acquisition spends a finite credit allowance; downstream transforms are cheap/free (often local). Make that asymmetry explicit in scripts and logs.
- A lost derived cache should be an inconvenience, not a catastrophe — design caches to be rebuildable rather than precious.

## Provenance on every datum

- **Every stored datum carries its source + timestamp.** Identity fields, extraction results, tags, and derived facts all record where they came from and when. The UI renders provenance; the pipeline must preserve it through every transform.
- **`null` over a guess.** When a field can't be confidently determined, store `null` rather than a plausible-but-wrong value. Known priors are hints for an extractor, never hard fallbacks (e.g. a likely author is a prior, not a default — exceptions exist).
- **Couple derived artifacts to their generator.** Vectors/embeddings are only comparable when query and corpus come from the *same* model. Funnel all query-side embedding through one code path; changing the model requires re-deriving the whole corpus (re-embed + re-index + re-tag) plus recalibrating any model-specific thresholds. Treat the model id as part of the data's provenance.
- **Aggregate numbers link back to primary sources.** Any rolled-up count or score should be traceable to the underlying documents.

## Indexing & schema

- Index the fields you filter/sort on (`source_type`, `speaker`/owner, tenant/owner keys); add a unique index on natural identifiers.
- For text search, combine a `$text` index with vector retrieval and fuse with a rank-combination strategy (e.g. RRF) rather than relying on one signal.
- Store large blobs in GridFS (or external object storage) above a size threshold rather than inlining megabytes into documents.

## Operational notes

- **Restart long-running readers after offline ingest** if they hold an in-memory index — a separate ingest process won't invalidate the running server's cache.
- **Re-derive after bulk ingest** — new raw rows arrive without derived tags/embeddings; run the tagging/embedding transform after any bulk add.
- Back up the lake (it's the irreplaceable part); derived collections are rebuildable by design.

## Hard-won lessons

(MongoDB Atlas-specific — only relevant when the cluster is hosted on Atlas.)

### Flex/M0 clusters can't do private endpoints or peering
**Symptom:** You designed a private DB path (Private Endpoint / VNet) but Atlas
won't let you create one on the cluster.
**Cause:** Private endpoints and network peering are **dedicated-tier (M10+)**
features; Atlas Flex and M0 support IP-allowlist connectivity only.
**Fix:** If the connection must be private, M10+ dedicated is a hard prerequisite,
not just a storage upgrade. On Flex, interim connectivity is IP-allowlist only.

### The Atlas SRV subdomain is per-CLUSTER, not per-project
**Symptom:** After recreating a cluster, the app can't connect — DNS/SRV resolution
points at the old host.
**Cause:** The SRV connection-string subdomain (e.g. `…ijcgrnb…` → `…75tne5…`)
changes whenever the cluster is recreated; it is per-cluster, not per-project. The
DB user and IP access list are project-scoped and carry over, masking the change.
**Fix:** After any cluster recreation, update the connection string in **both** env
vars/`.env` **and** secret stores. Key your config off the immutable project ID, not
the (renamable) project name.

### Disk autoscaling blocks writes while scaling — size disks for bulk restores
**Symptom:** A large restore aborts mid-way with `DiskUseThresholdExceeded`.
**Cause:** Atlas disk auto-scaling **blocks writes while it scales**, so a restore
that crosses the threshold stalls — and transient journal/firehose overhead can spike
usage well above the settled corpus size.
**Fix:** For bulk restores, set a **generous fixed disk** with auto-scaling **off**
(e.g. 32 GB for a ~6 GB corpus). Atlas disks don't shrink, so the chosen size is a
permanent floor — pick deliberately.

### In-place tier upgrades can hang and auto-revert — prefer fresh + restore
**Symptom:** An in-place Flex→M10 upgrade runs ~1h in `UPDATING`, then Atlas
auto-reverts to the old tier on timeout.
**Cause:** In-place tier transitions are not reliable and can be system-aborted;
data survives but the upgrade doesn't land.
**Fix:** When a local/dump master of record exists (so re-restore is cheap),
**provision a clean target cluster** (via IaC) and **restore from a dump** rather
than upgrading in place. Remember the SRV subdomain changes (see above).
