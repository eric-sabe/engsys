---
name: mongo-conventions
description: MongoDB conventions (Python 3.12+ pymongo.AsyncMongoClient and TypeScript/Node official mongodb driver, append-only data-lake discipline, provenance, and MongoDB Atlas operations). Use when reading/writing Mongo collections, adding ingest or transform pipelines, designing indexes, building vector search on Atlas, or reasoning about system-of-record collections.
---

# MongoDB Conventions

Applies to: any code touching MongoDB in this repository (storage layers, ingest pipelines, transforms, API routes, and Atlas infrastructure).

> Naturalize: confirm the language driver (`pymongo.AsyncMongoClient` or Node `mongodb`), database name, and system-of-record collection(s) in `CLAUDE.md`.

## Async Native Drivers (October 2026)

> **CRITICAL:** Do NOT use the EOL Python `motor` driver (which reached official EOL in May 2026). In Python 3.12+, always use PyMongo's native `AsyncMongoClient` (`from pymongo import AsyncMongoClient`). In TypeScript/Node.js, use the official `mongodb` package (`MongoClient`).

- **Await every database operation end-to-end** on async request paths; never block the event loop with synchronous `MongoClient` calls inside async handlers.
- **Centralize connection lifecycle**: build the URI from `MONGODB_URI` / `DATABASE_URL`, reuse a single client pool per process, and verify connectivity at startup with `admin.command("ping")`.
- **Idempotent index creation**: declare indexes in an explicit startup/migration routine with `unique=True` (or `{ unique: true }`) on natural business keys and tenant-scoped compound indexes (`(tenant_id, external_id)`).

### Python 3.12+ (`pymongo.AsyncMongoClient`)

```python
from pymongo import AsyncMongoClient, ASCENDING

client = AsyncMongoClient(mongodb_uri)
db = client[db_name]
await client.admin.command("ping")
await db.raw_events.create_index(
    [("tenant_id", ASCENDING), ("event_id", ASCENDING)],
    unique=True,
)
count = await db.derived_chunks.count_documents({"tenant_id": tenant_id})
```

### TypeScript / Node.js (`mongodb`)

```ts
import { MongoClient } from "mongodb";

export const mongoClient = new MongoClient(process.env.MONGODB_URI!);
export const db = mongoClient.db(process.env.MONGODB_DB_NAME);

await db.command({ ping: 1 });
await db.collection("raw_events").createIndex(
  { tenantId: 1, eventId: 1 },
  { unique: true },
);
```

## Append-Only Data-Lake Discipline

When upstream data is expensive or rate-limited to acquire:

1. **Fetch once, preserve raw payloads**: Write raw payloads with original structure and acquisition timestamps into an append-only lake collection (e.g., `raw_events`). Never destructively overwrite raw lake documents.
2. **Replayable downstream transforms**: Chunking, extraction, classification, and embedding read from the raw lake and write to *derived* collections (`derived_chunks`). If a derived collection or vector index is dropped, it can be deterministically rebuilt from the raw lake without re-spending external API quota.

## Provenance on Every Datum

- **Source + timestamp + model ID**: Every extracted fact, tag, or embedding vector must record its source document ID, timestamp, and generator model ID (e.g., `embedding_model`, `extracted_at`).
- **`null` over a guess**: Store `null` when a field cannot be determined with confidence rather than fabricating default values.
- **Vector consistency**: Query embeddings and corpus embeddings must use the exact same model ID and dimensionality; changing the embedding model requires a corpus re-embed + vector index rebuild.

## Indexing & Schema Discipline

- Always prefix multi-tenant collection indexes with the tenant key (`{ tenantId: 1, ... }`).
- For hybrid search on MongoDB Atlas, combine `$vectorSearch` with `$search` (BM25) using Reciprocal Rank Fusion (`$rankFusion` / RRF).
- Store large binary payloads in object storage (S3/GCS/R2) or GridFS rather than exceeding document working-set budgets.

## MongoDB Atlas Operational Lessons

### Flex / M0 clusters do not support Private Endpoints or VNet Peering
- **Cause:** Private Link and VNet/VPC peering require **M10+ dedicated** clusters; Flex and M0 tiers support IP allowlists only.
- **Fix:** Provision M10+ via IaC whenever private network connectivity is required.

### Atlas SRV connection string subdomains are per-cluster, not per-project
- **Cause:** Recreating an Atlas cluster generates a new SRV hostname suffix even within the same project.
- **Fix:** After any cluster replacement, update `MONGODB_URI` across all secret stores and environment configs.

### Disk auto-scaling blocks writes during bulk restores
- **Cause:** Crossing the disk auto-scale threshold mid-restore pauses writes (`DiskUseThresholdExceeded`).
- **Fix:** Pre-size fixed disk capacity with headroom before running `mongorestore`.
