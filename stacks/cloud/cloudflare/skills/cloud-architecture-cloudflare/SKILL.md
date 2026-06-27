---
name: cloud-architecture-cloudflare
description: Cloudflare edge/serverless architecture knowledge — compute (Workers isolates/Containers, smart placement), Pages, storage (R2/D1/KV/Durable Objects/Vectorize), messaging (Queues), AI (Workers AI/AI Gateway), and origin pooling (Hyperdrive/Cache API). CPU-time and subrequest limits, consistency tradeoffs, failure modes, and request+CPU pricing gotchas (no R2 egress). Activate when the active cloud is Cloudflare and the work involves designing, scaling, costing, or diagnosing Cloudflare architecture (Workers CPU limits, D1 write limits, KV eventual consistency, Durable Object single-threading, R2 egress savings, subrequest caps).
---

# Cloudflare Architecture Knowledge

Service-level detail for a Cloudflare-backed project. Pairs with Melvin's cloud-agnostic
diagnostic checklist (traffic pattern, state location, SLAs, blast radius, cost
explosion, coordination, limits, observability) — this pack supplies the Cloudflare-specific
answers for each. Cloudflare's model is fundamentally different from AWS/Azure: there are
no regions you provision into and no VMs — code runs in **V8 isolates** at the edge POP
nearest the user, and state lives in purpose-built edge primitives. For concrete project
topology, cost tiers, and stack context, read the architecture docs named in `CLAUDE.md`.

## Compute

### Workers (isolates)

- **No cold starts.** Workers run as **V8 isolates**, not containers/VMs — a new isolate
  spins up in <5ms (often "zero" perceived) because there's no OS/runtime boot. This is
  the headline architectural difference from Lambda/Cloud Functions/Container Apps: the
  "scale to zero costs you a cold start" tradeoff that dominates AWS/Azure design simply
  doesn't exist here. Design for it — short-lived, stateless request handlers are ideal.
- **CPU-time limit, not wall-clock.** The cap is **CPU time**, default **30s** on paid,
  configurable up to **5 minutes** (`limits.cpu_ms` in `wrangler.toml`, max 300000).
  Free plan is **10ms** CPU/request. Crucially, **time spent awaiting I/O (fetch, KV, D1)
  does not count** against CPU time — a Worker can wait minutes on a slow subrequest and
  burn near-zero CPU. The killer is *compute* (crypto, JSON parsing huge payloads, image
  work, regex backtracking), not waiting. The historical "50ms CPU" number was the old
  default; the platform now allows far more, but **a CPU-bound hot path is still where you
  get `Exceeded CPU` (Error 1102) errors** — profile and offload heavy compute.
- **Subrequest limit** is the other hard ceiling: **50 subrequests/request on Free, 1000
  on paid** (`fetch` + binding calls to KV/D1/R2/service bindings each count). A Worker
  that fans out per-item to an API or DB will hit this — batch, cache, or move the fan-out
  into a Durable Object / Queue consumer. Simultaneous open connections cap at ~6.
- **Memory** is **128MB per isolate** — hard limit, `Exceeded Memory` (1102) on overflow.
  No tuning knob like Lambda's memory→CPU slider. Stream large bodies; never buffer a big
  R2 object fully into memory.
- **Bundle size:** 3MB (Free) / 10MB compressed (paid) per Worker script. Heavy npm deps
  (especially Node built-ins needing `nodejs_compat`) bloat this — tree-shake.
- **Good for:** edge APIs, auth/routing/transform middleware, request shaping, glue.
  **Bad for:** CPU-heavy batch, anything needing >128MB RAM, long-running stateful compute
  (use Containers or push to a real backend via Hyperdrive).

### Workers Containers

- For workloads that don't fit the isolate model (full Linux, large memory, arbitrary
  runtimes, heavy CPU, existing Docker images), **Workers Containers** run actual
  containers, *orchestrated by a Durable Object* and programmatically started/stopped from
  a Worker. Unlike isolates, containers **do have cold starts** (image pull + boot) and
  bill for the time they're running — the AWS Fargate tradeoff reappears here. Use them as
  the escape hatch, not the default; keep the hot path on isolates.

### Smart Placement

- By default a Worker runs at the POP nearest the *user*. If the Worker makes several
  round trips to a **centralized origin** (a DB in one region, a slow upstream API), edge
  placement means each subrequest pays the full user→origin latency. **Smart Placement**
  (`placement = { mode = "smart" }`) lets Cloudflare instead run the Worker near the
  *origin*, collapsing N origin round-trips into one user round-trip. Win when the Worker
  is back-end-chatty; no benefit (or slightly worse) for a Worker that mostly serves edge
  data (KV/cache/static). Pair origin-DB Workers with Smart Placement + Hyperdrive.

### Pages

- Git-integrated hosting for static sites + SPA/SSR frameworks, with **Pages Functions**
  (Workers under the hood, file-based routing in `functions/`). Automatic preview
  deployments per branch/PR. Increasingly converging with Workers (Workers now also serves
  static assets via the `assets` binding) — for new projects prefer **Workers + static
  assets** unless you specifically want Pages' Git/CI ergonomics. Same isolate runtime,
  same limits apply to the Functions.

## Storage & Data

The hardest part of Cloudflare design is **picking the right state primitive** — each has
a sharp consistency/latency/cost profile and they are *not* interchangeable.

### R2 (object storage)

- S3-compatible object storage with the headline feature: **zero egress fees.** You pay
  storage + per-operation (Class A writes/lists ~$4.50/M, Class B reads ~$0.36/M) but
  **never** for data transferred out. This inverts the AWS cost calculus — for
  egress-heavy workloads (media, model weights, large downloads, multi-cloud data sharing)
  R2 can be dramatically cheaper than S3. The cost trap moves to **operation counts**: a
  workload doing millions of tiny PUTs/LISTs pays on Class A ops even though bytes are
  cheap.
- Strongly read-after-write consistent for new objects. Supports multipart upload,
  presigned URLs, lifecycle rules, event notifications (→ Queues), and bucket-level
  jurisdiction (EU). Access from a Worker via an R2 binding (no egress, no auth round
  trip) or via the S3 API. **Stream** objects through the Worker — don't buffer (128MB
  isolate cap).
- **Failure mode:** R2 ops still count as subrequests from a Worker and are subject to the
  per-request subrequest cap.

### D1 (SQLite at the edge)

- Managed **SQLite**, exposed to Workers via a binding. Real SQL, transactions, and now
  **read replicas** (Sessions API routes reads to a nearby replica and guarantees
  read-your-writes for that session). The primary is single-region; replicas are eventually
  consistent — writes always go to the primary, so **write latency from a far POP includes
  the round trip to the primary region.**
- **Limits that bite:** **10GB max per database** (it's SQLite, not a sharded cluster —
  this is a hard product ceiling, plan sharding/partitioning early), max **~50 databases**
  worth of bindings per Worker, **100MB max** per query result / row size limits,
  parameter limits per statement. Billing is by **rows read + rows written** (not queries)
  — an unindexed query that scans the table bills every row scanned. **Index aggressively**;
  watch `rows_read` in the query metadata.
- **Good for:** per-tenant/per-app relational data, config, low-to-moderate write volume.
  **Bad for:** a single large multi-tenant OLTP database (10GB ceiling, single-writer),
  high-write-fan-in. For those, use Hyperdrive → a real Postgres, or many D1s sharded by
  tenant.

### KV (key-value)

- Global, **eventually consistent** key-value store optimized for **high-read, low-write,
  read-from-everywhere** (config, feature flags, routing tables, cached tokens, session
  lookups). Reads are fast at the edge (cached at the POP after first read); writes
  propagate globally with **eventual consistency — up to ~60s** to be visible everywhere.
- **Do not use KV where you need read-after-write or coordination.** Last-write-wins, no
  transactions, no conditional writes across the global view. A counter or a "did I already
  process this" flag in KV will lose updates and read stale — that's a Durable Object job.
- **Limits:** value max 25MB, key max 512 bytes, and a soft guidance of **~1 write/sec per
  key** (writes to the *same* key are rate-limited and the slow-propagation makes
  write-heavy patterns wrong). Billing per read/write/delete/list op + storage.

### Durable Objects (single-threaded coordination)

- The coordination primitive — a **single-threaded, globally-unique, addressable** object
  instance (one per ID, with **transactional, strongly-consistent storage** colocated with
  the compute). Because exactly one instance handles all requests for a given ID,
  **serially**, it's the right tool for anything KV/D1 can't do safely: counters,
  rate limiters, locks, leader election, real-time **WebSocket** rooms/hubs, collaborative
  state, per-entity state machines.
- **Single-threaded = the throughput ceiling.** All requests to one DO ID queue and run one
  at a time. A "hot object" (one room/tenant taking all the traffic) becomes a bottleneck
  no horizontal scaling fixes — **shard the keyspace** so load spreads across many DO IDs.
  This is the DO analogue of DynamoDB's hot partition.
- **WebSockets:** DOs are *the* way to do stateful WebSockets at the edge. Use the
  **Hibernation API** — a DO with idle WebSockets can be evicted from memory (you stop
  paying for active duration) while keeping connections open, rehydrating on the next
  message. Without hibernation, thousands of idle long-lived sockets pin the DO in memory
  and bill continuously.
- **Alarms:** a DO can schedule itself to wake later (`storage.setAlarm`) — the primitive
  for per-object timers, retries, scheduled flushes, debouncing, and reliable background
  work without a cron. Survives eviction.
- **Placement:** a DO lives in one location (near first access, or pinned by jurisdiction).
  Cross-region access to a DO pays that latency — colocate the DO with its primary traffic.
- **Cost:** billed on **active duration (GB-s) + requests**; SQLite-backed DOs add
  rows-read/written billing. Hibernation is the key lever to avoid paying for idle.

### Vectorize

- Managed **vector database** for embeddings — semantic search and RAG over Workers AI /
  external embeddings. Create indexes with a fixed dimension + distance metric (cosine/
  euclidean/dot). Supports metadata filtering and namespaces. **Limits** on vectors per
  index, dimensions, and metadata size — check before betting a large corpus on it; for
  very large/complex vector workloads a dedicated vector DB via Hyperdrive may fit better.
  Pairs naturally with Workers AI (embed) + an LLM (generate) for an all-edge RAG stack.

### Cache API

- Programmatic access to Cloudflare's **CDN cache** from inside a Worker
  (`caches.default.match/put`). Distinct from KV: it's **per-POP** (not global — a cache
  put in one POP isn't visible in another), tied to the CDN, and ideal for caching
  subrequest/compute results at the edge with normal HTTP cache semantics. Use it to
  collapse repeated origin/compute work per-POP and stay under the subrequest cap. Respect
  `Cache-Control`; a bad cache key (unique query param) tanks hit ratio just like CloudFront.

## Messaging

### Queues

- Managed **message queue** with Worker producers and consumers, **at-least-once** delivery
  (idempotent consumers mandatory), **batching** (consumer gets a batch — tune
  `max_batch_size` / `max_batch_timeout`), **retries** with configurable `max_retries`, and
  a **dead-letter queue** for poison messages (always configure one, exactly as with SQS).
- The right tool to **decouple** work from the request path and to **get under the
  subrequest limit**: instead of fanning out 500 API calls inside one Worker, enqueue 500
  messages and let the consumer process them in batches across many invocations. Also
  smooths spikes and isolates a slow downstream from user latency.
- Throughput/message-size limits apply (message ≤128KB, throughput quotas per queue) —
  check before betting a very high-volume pipeline on it.

## AI

### Workers AI

- Run inference (LLMs, embeddings, image, speech, classification) on Cloudflare's **GPU
  edge network** via a binding — no infra, no GPU to provision. Billed on **Neurons** (a
  normalized compute unit) with a daily free allocation. **Quotas/rate limits per model**
  will throttle a naive high-volume pipeline — back off and batch. Model availability and
  context limits vary by model; pick the smallest model that does the job (don't run a
  large LLM for a classification). Pairs with Vectorize for edge RAG.

### AI Gateway

- A **proxy/control-plane in front of *any* model provider** (Workers AI, OpenAI,
  Anthropic, etc.) that adds **caching** (dedup identical prompts → big cost saver),
  **rate limiting**, **retries/fallbacks** across providers, request logging, and analytics
  — without changing your application code beyond the endpoint. Use it as the single
  chokepoint for all LLM traffic to control cost, observe spend, and add resilience. The
  caching layer alone often pays for itself on repetitive prompts.

## Origin connectivity

### Hyperdrive

- **Connection pooling + query caching in front of an external origin database**
  (Postgres/MySQL — e.g. RDS, Cloud SQL, Neon, Supabase). Solves the exact problem that
  bites serverless + Postgres everywhere: each Worker invocation would otherwise open a new
  DB connection and exhaust `max_connections` (the Lambda+RDS mismatch). Hyperdrive
  **pools** connections at the edge so thousands of Workers share a small pool, and
  **caches** read queries to cut round trips. It also keeps a warm connection to the
  origin, hiding connection-setup latency.
- Use it whenever Workers talk to a traditional regional SQL database. Pair with **Smart
  Placement** so the Worker runs near the origin. This is the Cloudflare answer to RDS
  Proxy / PgBouncer — without it, a busy Worker fleet will knock over the origin DB on
  connection count alone.

## Consistency model cheat-sheet (pick the right primitive)

| Need | Use | Consistency |
| --- | --- | --- |
| High-read config / flags / global lookups | **KV** | Eventual (~60s) |
| Relational data, real SQL, transactions | **D1** | Strong on primary; replicas eventual |
| Coordination / counters / locks / WebSockets / per-entity state | **Durable Objects** | Strong, serialized, single-writer |
| Large blobs / media / egress-heavy | **R2** | Read-after-write (new objects) |
| Per-POP HTTP/compute caching | **Cache API** | Per-POP, TTL-based |
| Pool/cache to an external SQL DB | **Hyperdrive** | Inherits origin |
| Vector/embedding search | **Vectorize** | Index-level |

The classic mistake: reaching for KV because it's simple, then needing read-after-write or
a counter — that's always a Durable Object. And reaching for D1 for a single big
multi-tenant DB — that's the 10GB ceiling and single-writer, so shard D1 or use Hyperdrive.

## Failure modes (what breaks and how it shows up)

- **`Exceeded CPU` / `Exceeded Memory` (Error 1102)** — CPU-bound or >128MB hot path.
  Profile, offload heavy compute, stream large bodies, raise `limits.cpu_ms` if it's
  legitimately compute-heavy and on paid.
- **Subrequest limit exceeded** — per-item fan-out inside one Worker. Batch, cache (Cache
  API), or move fan-out to Queues / a Durable Object.
- **KV stale reads / lost writes** — using KV where read-after-write or coordination was
  needed. Move to a Durable Object.
- **D1 `rows_read` blowup / slow queries** — unindexed scans (bills every row) or hitting
  the 10GB / single-writer ceiling. Index, shard, or move to Hyperdrive+Postgres.
- **Durable Object hot-object bottleneck** — all traffic to one DO ID serializes. Shard
  the keyspace across many IDs.
- **DB connections exhausted** — Workers opening direct connections to a regional Postgres.
  Put **Hyperdrive** in front.
- **Idle WebSocket memory/billing** — DOs pinned by idle sockets. Use the Hibernation API.

## Cost realism (where Cloudflare bills behave differently)

1. **No R2 egress** — the headline saving; egress-heavy workloads are far cheaper than S3.
   The cost moves to **Class A/B operation counts** — millions of tiny ops add up.
2. **Workers = requests + CPU time**, not GB-seconds of wall-clock. Idle-waiting on I/O is
   nearly free; the bill is driven by request count and *compute*. A handler that does
   little CPU and waits on fetches is cheap even if slow.
3. **D1 = rows read + rows written**, not queries — unindexed scans are the silent
   multiplier. Index and watch `rows_read`.
4. **Durable Objects = active duration (GB-s) + requests** — idle DOs pinned in memory
   (esp. WebSockets without hibernation) bill continuously. Hibernate.
5. **KV = per-op + storage** — read-heavy is its sweet spot; write-heavy is both wrong and
   costly.
6. **Workers AI = Neurons per inference** — model size and volume drive it; AI Gateway
   caching cuts repetitive spend.
7. **Queues = per-operation** on push/pull/retry — fine, but DLQ loops on poison messages
   waste ops.

Levers: AI Gateway caching, Cache API + good cache keys, batching to stay under subrequest
limits, indexing D1, DO hibernation, sharding hot DOs, and Smart Placement to cut origin
round trips.

## Limits to check before betting on them (request increases early)

Workers CPU-time (30s default / 300s max paid, 10ms Free), **subrequests 50 Free / 1000
paid**, 128MB isolate memory, bundle size (3MB/10MB), **D1 10GB/database** + rows-billing,
KV value 25MB / ~1 write/s per key / ~60s propagation, R2 operation classes, Durable Object
single-thread throughput, Queues message ≤128KB + throughput quotas, Workers AI per-model
rate limits, Vectorize index dimension/count limits. Many are plan-tier (Free vs Paid vs
Enterprise) — verify the current numbers against Cloudflare docs (they change), and confirm
the plan tier before designing around a limit.

## Observability

`wrangler tail` for live request logs, **Workers Logs / Logpush** for persisted logs to a
destination, **Analytics Engine** for high-cardinality custom metrics written from a
Worker, **Workers Trace Events / Tail Workers** for structured per-invocation traces, and
the dashboard's per-binding analytics (D1 query metrics, KV/R2 op counts, DO duration,
Queue depth, AI Gateway logs). Alarm on the things that predict pain: Worker error rate +
CPU-limit (1102) exceptions, subrequest-limit errors, D1 `rows_read` trends, DO duration +
queue-up, Queue backlog/DLQ depth, and Workers AI rate-limit (429) responses.
