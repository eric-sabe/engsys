---
name: cloud-architecture-gcp
description: GCP service-level architecture knowledge — compute (Cloud Run/GKE/Cloud Functions/GCE), data (Cloud SQL/Spanner/Firestore/Bigtable), messaging (Pub/Sub/Cloud Tasks/Workflows), analytics (BigQuery), edge (Cloud CDN/Load Balancing/API Gateway), storage + secrets (GCS/Secret Manager/Artifact Registry), and Vertex AI. Cost models, quotas, failure modes, and cold-start gotchas. Activate when the active cloud is GCP and the work involves designing, scaling, costing, or diagnosing GCP architecture (Cloud Run cold starts, Cloud SQL connection limits, Spanner hot spots, egress, Pub/Sub backlog).
---

# GCP Architecture Knowledge

Service-level detail for a GCP-backed project. Pairs with Melvin's cloud-agnostic
diagnostic checklist (traffic pattern, state location, SLAs, blast radius, cost
explosion, coordination, limits, observability) — this pack supplies the GCP-specific
answers. For concrete topology, cost tiers, and stack context, read the architecture
docs named in `CLAUDE.md`.

## Compute

### Cloud Run

- Serverless containers, request- or instance-billed, **scales to zero**. The
  cost win and the latency trap: a scaled-to-zero service pays a **cold start** (image
  pull + container start) on the next request. Set **`min-instances >= 1`** to keep a
  warm instance for latency-sensitive paths — the Cloud Run analogue of provisioned
  concurrency.
- **Concurrency:** one Cloud Run instance serves *multiple* concurrent requests
  (default up to 80, tunable) — unlike Lambda's one-request-per-instance. Right concurrency
  setting massively affects cost and tail latency; CPU-bound work wants lower concurrency,
  IO-bound can go higher. `--cpu-throttling` (CPU only during requests) vs always-on CPU
  (for background work) is a real cost lever.
- **Limits:** per-service max instances (set it to cap blast radius and spend), request
  timeout up to 60 min, memory/CPU per instance. Cloud Run **jobs** for run-to-completion
  batch (vs services for request serving).
- **Good for:** HTTP APIs, event consumers (Eventarc/Pub/Sub push), web apps. Prefer it
  over GKE unless you need Kubernetes primitives.

### GKE

- Managed Kubernetes. **Autopilot** (Google manages nodes, pay per pod resource — less
  ops, good default) vs **Standard** (you manage node pools — more control, GPUs, custom
  scheduling). Reach for GKE only when you need the K8s ecosystem (operators, mesh,
  complex scheduling, multi-tenant platform); otherwise Cloud Run is far less overhead.

### Cloud Functions

- Event-driven serverless (2nd gen runs on Cloud Run + Eventarc under the hood — same
  cold-start and concurrency model). Triggers: HTTP, Pub/Sub, GCS, Firestore, Eventarc.
  Good for glue and event handlers; for sustained or latency-critical work, Cloud Run
  with min-instances.

### Compute Engine (GCE)

- VMs: any machine type (general/compute/memory/GPU/TPU), **Spot/Preemptible** for
  fault-tolerant batch (deep discount, can be reclaimed), **Committed Use Discounts**
  (1/3-yr) and Sustained Use Discounts for steady baseline. The escape hatch when
  managed compute can't meet a hardware/licensing/latency need.

## Data

### Cloud SQL (PostgreSQL / MySQL)

- Managed relational. **Connection limits** scale with tier and are the classic
  bottleneck — serverless/many-instance apps exhaust them. Use the **Cloud SQL Auth
  Proxy** + a pooler (PgBouncer) or built-in connection pooling; serverless callers
  should pool aggressively. HA = regional (synchronous standby; failover drops
  connections — apps must reconnect/retry). Read replicas scale reads, not writes.
- IOPS/throughput scale with disk size and tier; watch on write-heavy workloads. Right-
  size the tier from metrics, don't over-provision.

### Spanner

- Horizontally-scalable, strongly-consistent relational (global). **Schema / primary-key
  design is everything** — monotonically increasing keys (timestamps, sequential IDs)
  create **hot spots** on one split; use hashed/UUID or bit-reversed keys for even
  distribution. Billed by **node/processing-unit + storage**; not cheap — justify it
  with genuine horizontal-scale or global-consistency needs over Cloud SQL.

### Firestore

- Serverless document DB, auto-scaling, real-time listeners. Strong consistency,
  multi-region options. **Cost is per-operation** (reads/writes/deletes) + storage —
  read-heavy fan-out and unbounded queries get expensive; **avoid N+1 read patterns**
  and design for composite indexes. Great for app/user data with realtime needs.

### Bigtable

- Wide-column NoSQL for massive scale + low-latency (time-series, IoT, analytics
  serving). **Row-key design is everything** — sequential keys hot-spot a single node;
  design for even distribution. Billed per node + storage. Reach for it at very high
  throughput where Firestore/Spanner don't fit.

## Messaging & Orchestration

### Pub/Sub

- Global, auto-scaling messaging. **Push** (delivers to an endpoint — Cloud Run/Functions)
  vs **pull** (consumer fetches). At-least-once delivery → **idempotent consumers
  required**; **ordering keys** for ordered delivery (lower throughput per key).
- Configure **ack deadline** > processing time or you get redelivery, and a **dead-letter
  topic** with max delivery attempts for poison messages. Subscription **backlog**
  (`num_undelivered_messages` / oldest-unacked-age) is the metric that predicts pain.
- **Pub/Sub Lite** is a cheaper, zonal, capacity-provisioned variant for high-volume
  cost-sensitive streaming — fewer features, you manage capacity.

### Cloud Tasks / Workflows

- **Cloud Tasks:** managed task queues with rate limiting + scheduled/deferred dispatch
  to HTTP targets — good for decoupling and controlled throughput to a downstream.
- **Workflows:** serverless orchestration (YAML/JSON) of service calls with retries,
  error handling, and parallel steps — the explicit-state-machine option (vs hiding
  coordination in code). **Eventarc** routes events (GCS, Pub/Sub, audit logs) to Cloud
  Run/Functions/Workflows.

## Analytics

### BigQuery

- Serverless data warehouse. **Two pricing models:** **on-demand** (per TB *scanned* —
  a `SELECT *` or unpartitioned full scan is a budget event) vs **capacity/slots**
  (reserved compute, predictable). Control cost with **partitioning + clustering**,
  selecting only needed columns, and `--maximum-bytes-billed` guards. Streaming inserts
  and storage are separate line items. Not an OLTP store — it's analytics.

## Edge & Networking

### Cloud Load Balancing + Cloud CDN

- Global external HTTP(S) load balancer (Anycast, single global IP) with **Cloud CDN**
  edge caching and **Cloud Armor** WAF/DDoS. Cache key + TTL design drive hit ratio.
  Use it for global entry, edge caching, and WAF.

### API Gateway / Apigee

- **API Gateway** (lightweight, managed, for serverless backends) vs **Apigee** (full
  enterprise API management — policies, monetization, developer portal; heavier and
  pricier). Pick by how much API-management you actually need.

### VPC / Networking — cost landmines

- **Cloud NAT** for egress from private instances (per-GB + hourly), and **egress data
  transfer** — inter-zone, inter-region, and internet egress are all per-GB (internet
  and cross-region the most). Use **Private Google Access** / **Private Service Connect**
  to reach Google APIs/services without public egress, and **VPC Service Controls** for
  data-exfil boundaries. Default to private; public only where required.

## Storage, Secrets & Registry

### Cloud Storage (GCS)

- Object storage. Classes: Standard → Nearline → Coldline → Archive (retrieval cost +
  minimum storage duration). Lifecycle rules to age data down. **Globally-unique bucket
  names** (see preflight). Cost = storage + **operations** (per-1000 Class A/B) + egress.
  Uniform bucket-level access + IAM; encryption at rest by default (CMEK via Cloud KMS).

### Secret Manager

- Versioned secrets with IAM access control; reference from Cloud Run/Functions as
  mounted secrets or env. Keep secrets out of images and config. Pair with **Workload
  Identity** so services authenticate without long-lived keys.

### Artifact Registry

- Container images + language packages (successor to Container Registry). Use Workload
  Identity / service-account auth for pulls; regional repos to avoid cross-region pull
  egress.

## Vertex AI

- Managed ML + GenAI: **Model Garden** (Gemini, plus third-party and open models),
  online **prediction endpoints** (deploy a model behind an autoscaling endpoint — set
  min replicas to avoid cold start, max to cap cost), batch prediction, training
  pipelines, **Vector Search** for managed RAG.
- **Quotas matter:** per-model/region requests-per-minute and tokens-per-minute (or QPM)
  limits will throttle a naive high-volume pipeline — request increases early and add
  backoff. Provisioned Throughput for guaranteed capacity (committed spend). Cost is
  token/prediction-driven; model availability varies by region. Right-size the model per
  task.

## Cost realism (where GCP bills explode)

1. **Egress** — internet + cross-region + inter-zone data transfer, per-GB.
2. **Cloud NAT** — per-GB processing + hourly. Use Private Google Access / PSC.
3. **BigQuery on-demand scans** — per-TB; partition/cluster and limit columns.
4. **Cloud Run / GKE over-provisioning** — instance-seconds on idle min-instances /
   always-on CPU; over-large GKE node pools.
5. **Spanner / Bigtable nodes** — billed even when idle.
6. **Firestore operations** — per read/write at high fan-out.
7. **Vertex AI tokens / always-on endpoints**.

Levers: Committed Use Discounts + Sustained Use Discounts (steady baseline), Spot/
Preemptible (fault-tolerant batch), right-sizing from Cloud Monitoring, Private Google
Access, GCS lifecycle tiering, BigQuery partitioning + `maximum-bytes-billed`, budgets +
alerts.

## Quotas (request increases *before* they bite)

Per-project/region: Compute CPUs + GPUs/TPUs per family, in-use external IPs, Cloud Run
max instances + CPU quota, Cloud Functions instances, Cloud SQL connections + instances,
Spanner nodes, Pub/Sub publish/throughput, BigQuery concurrent queries + slots, Vertex
AI per-model RPM/TPM, GCS request rate. Many are soft (raise via IAM & Admin → Quotas
with lead time); some are hard. Check `gcloud compute regions describe` / the Quotas page
and plan around the hard ones.

## Observability

Cloud **Operations Suite**: Cloud Monitoring (metrics + alerting policies), Cloud Logging
(Log Explorer + log-based metrics), Cloud Trace (distributed tracing), Error Reporting,
Profiler. Alert on the predictors of pain: Cloud Run instance count + request latency p99
+ container startup, Pub/Sub subscription backlog + oldest-unacked-age, Cloud SQL
connections + CPU + replica lag, Spanner CPU + hot-split, BigQuery bytes-billed,
Cloud NAT allocation/dropped connections.
