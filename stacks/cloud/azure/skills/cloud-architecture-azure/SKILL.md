---
name: cloud-architecture-azure
description: Azure service-level architecture knowledge — compute (Container Apps/AKS/Functions), data (PostgreSQL Flexible Server/Cosmos DB), messaging (Service Bus/Event Grid/Event Hubs), edge (Front Door/API Management), identity (Entra), storage + secrets (Blob/Key Vault/ACR), and Azure OpenAI. Cost models, service limits, failure modes, and cold-start gotchas. Activate when the active cloud is Azure and the work involves designing, scaling, costing, or diagnosing Azure architecture (Container Apps cold starts, PostgreSQL connection limits, Service Bus quotas, Front Door, NAT egress).
---

# Azure Architecture Knowledge

Service-level detail for an Azure-backed project. Pairs with Melvin's cloud-agnostic
diagnostic checklist (traffic pattern, state location, SLAs, blast radius, cost
explosion, coordination, limits, observability) — this pack supplies the Azure-specific
answers. For concrete topology, cost tiers, and stack context, read the architecture
docs named in `CLAUDE.md`. For deep service docs use the `microsoft-docs` skill
(Microsoft Learn MCP).

## Compute

### Azure Container Apps (ACA)

- Serverless containers on managed Kubernetes (KEDA-based autoscaling). **Scale to
  zero** is the cost win — and the latency trap: a scaled-to-zero app pays a **cold
  start** (image pull + container start, seconds) on the next request. For latency-
  sensitive services set **`minReplicas >= 1`** (a warm replica) — the ACA analogue of
  provisioned concurrency.
- **Revisions:** each config/image change creates a revision; traffic-split between
  them for blue/green and canary. The phantom "revision nobody recognizes" is usually a
  stale active revision still taking traffic — check the revision list and traffic split.
- **Scaling:** KEDA scale rules on HTTP concurrency, CPU/memory, or queue length
  (Service Bus, etc.). Per-app and per-environment replica ceilings apply — know them
  before you bet a spike on autoscale.
- **Good for:** microservices, HTTP APIs, queue/event workers. Prefer it over AKS unless
  you genuinely need Kubernetes primitives.

### AKS

- Full Kubernetes — reach for it only when you need operators, complex scheduling,
  service mesh, or a multi-tenant platform. Otherwise it's operational overhead you'll
  regret; Container Apps or Functions usually suffice.

### Azure Functions

- Event-driven serverless. **Consumption** plan scales to zero (cold starts) and bills
  per execution+GB-s; **Premium** keeps pre-warmed instances (no cold start, VNet
  integration); **Dedicated/App Service** for predictable steady load. Durable Functions
  for orchestration/fan-out-fan-in workflows.

## Data

### PostgreSQL Flexible Server

- **Connection limits** scale with tier/size and are the classic bottleneck —
  serverless/many-replica apps exhaust them. Use **PgBouncer** (built-in pooler) — but
  it is **not available on the Burstable tier**; only GeneralPurpose+ supports it (see
  the IaC lessons). On Burstable, pool in-app or upsize.
- **Tiers:** Burstable (`B`-series — dev/cheap, throttled baseline CPU, no PgBouncer) →
  GeneralPurpose (`D`-series) → MemoryOptimized (`E`-series). HA = zone-redundant standby
  (failover drops connections — apps must reconnect/retry). Read replicas scale reads.
- **The metric is `active_connections`**, not `connection_percent` (that's Azure SQL) —
  matters for alerts (see IaC lessons).
- IOPS and storage scale together up to a point; provisioned IOPS available on higher
  tiers. Watch IOPS on write-heavy workloads.

### Cosmos DB

- Globally-distributed multi-model. **Partition key design is everything** — a hot
  partition throttles (429) regardless of total RU/s; each physical partition caps
  ~10,000 RU/s. Pick a high-cardinality, evenly-accessed key.
- **Throughput:** provisioned RU/s (manual or autoscale) vs **serverless** (pay-per-
  request, good for spiky/dev). Five tunable consistency levels (Strong → Eventual) —
  stronger costs more RU and latency; Session is the usual default.
- Cost is RU-driven: large items, cross-partition queries, and indexing-everything
  inflate it. Tune the indexing policy.

## Messaging & Orchestration

### Service Bus

- Enterprise broker: **queues** (point-to-point) and **topics/subscriptions** (pub/sub
  with SQL/correlation filters). **Sessions** for ordered/grouped processing, **DLQ**
  built-in (configure max delivery count), scheduled + deferred messages, duplicate
  detection.
- **Tiers:** Basic (queues only) / Standard (topics, pay-per-op) / **Premium**
  (dedicated capacity, predictable latency, VNet, larger messages, required for serious
  throughput). Standard has per-namespace throughput limits — Premium for high volume.
- Lock duration must exceed processing time or you get redelivery — idempotent consumers
  required.

### Event Grid / Event Hubs

- **Event Grid:** lightweight reactive pub/sub for discrete events (resource changes,
  custom topics) with filtering — fan-out, low latency, cheap.
- **Event Hubs:** high-throughput streaming/ingestion (Kafka-compatible), partitioned,
  consumer groups — telemetry, log/event firehose. Use Event Hubs for *streams*, Event
  Grid for *discrete events*, Service Bus for *transactional work queues*.

### Durable Functions / Logic Apps

- Durable Functions for code-first orchestration; Logic Apps for low-code connector-
  driven integration workflows.

## Edge & Networking

### Front Door

- Global L7 load balancer + CDN + WAF at the edge. Anycast routing, TLS termination,
  caching, path/host routing to origins. Use it for global entry, edge caching, and WAF;
  cache key + rules drive hit ratio.

### API Management (APIM)

- Full API gateway: policies (rate limiting, transformation, auth), product/subscription
  keys, developer portal. Heavier (and pricier — Consumption tier for serverless-style
  billing, Developer/Standard/Premium otherwise) than Front Door routing; use when you
  need real API-management features.

### VNet / Networking — cost landmines

- **NAT Gateway** + outbound data processing, and **cross-zone / cross-region data
  transfer** are the egress budget-eaters (same shape as every cloud). Use **Private
  Endpoints / Private Link** to keep traffic off the public path and **Service
  Endpoints** where applicable. Default to private; public only where required.

## Identity

### Microsoft Entra

- **Entra ID** (workforce) and **Entra External ID** (customers/CIAM — the successor to
  Azure AD B2C) for app auth: OIDC/OAuth2, social + federated IdPs, MFA, conditional
  access. **Managed identities** (system- or user-assigned) are the right way for
  Azure resources to authenticate to each other — no secrets in code. Prefer managed
  identity + Key Vault references over connection strings everywhere.

## Storage, Secrets & Registry

### Blob Storage

- Tiers: Hot → Cool → Cold → Archive (retrieval latency/cost). Lifecycle policies to
  age data down. Encryption at rest by default. Cost = storage + transactions + egress.

### Key Vault

- Secrets, keys, certs. Reference from Container Apps / App Service as secret refs and
  from Bicep via `getSecret()` — keep secrets out of templates and env files. **Name is
  globally unique** and **soft-deleted on delete** (purge protection can block name
  reuse) — see IaC lessons. RBAC or access-policy authorization model; managed identity
  for access.

### Azure Container Registry (ACR)

- Private image registry. **SKU restrictions bite** (see IaC lessons): Basic may be
  unavailable on some subscriptions; `retentionPolicy` requires **Premium** (remove it
  from Standard dev/staging). Use managed identity / ACR tokens for pulls.

## Azure OpenAI / AI

- Managed OpenAI + Azure-hosted models via deployments. **Capacity is in TPM (tokens-
  per-minute) quota per deployment per region** — the throughput ceiling; a naive high-
  volume pipeline hits 429s, so request quota early and add backoff. **Provisioned
  Throughput Units (PTUs)** reserve guaranteed capacity/latency (committed spend) vs
  pay-as-you-go. Model availability varies by region. Pair with **Azure AI Search** for
  managed RAG. Cost is token-driven — right-size the model per task.

## Cost realism (where Azure bills explode)

1. **NAT Gateway / outbound data processing** — per-GB egress. Use Private Endpoints.
2. **Cross-zone / cross-region data transfer** — per-GB.
3. **Container Apps / Functions over-provisioning** — vCPU-s on idle min-replicas.
4. **PostgreSQL IOPS + over-sized tier**; Cosmos RU/s over-provisioning.
5. **Service Bus Premium** dedicated capacity; APIM tier.
6. **Azure OpenAI tokens / PTUs**.
7. **Front Door + Blob egress**.

Levers: Reservations / Savings Plans (steady baseline), Spot VMs (fault-tolerant batch),
right-sizing from Azure Monitor, Private Endpoints, Blob lifecycle tiering, Cost
Management budgets + alerts.

## Service limits (check before betting on them)

Container Apps replicas per app/environment, Functions scale limits, Service Bus per-
namespace throughput (Standard) + entity counts, PostgreSQL `max_connections` per tier,
Cosmos RU/s per partition, Front Door routes, APIM throughput per tier, Azure OpenAI
TPM/PTU per region, Key Vault transactions/sec, subscription-level vCPU quotas per
region/family. Raise soft quotas via support with lead time.

## Observability

Azure Monitor (metrics + alerts), **Log Analytics workspace** (the store the
`AppRequests`/`ContainerAppConsoleLogs` tables live in — KQL queries scope to the
*workspace*, not App Insights), Application Insights (APM/distributed tracing). Alarm on
Container Apps replica count + restarts, Service Bus DLQ depth + active message count,
PostgreSQL `active_connections` + CPU, Cosmos 429 rate + RU consumption, Front Door
backend health.

## Hard-won lessons

### Container Apps VNet integration cannot be retrofitted
**Symptom:** You need Private Endpoints (e.g. a private DB path) but the Container
Apps environment was created without VNet integration; there's no in-place toggle.
**Cause:** A VNet-integrated ACA environment routes egress through the VNet — that's
a creation-time property of the *environment*, not a setting you can flip later.
**Fix:** Create the environment **VNet-integrated from the start** whenever Private
Endpoints/Link are on the roadmap (do it while the resource group is still empty).
Retrofitting means tearing down and recreating the environment.

### Deploy by immutable digest + unique revision; verify the active revision
**Symptom:** A "green" deploy reports success but the running app is still the old
build — the new code never actually took traffic.
**Cause:** A mutable image tag (`:latest`) can resolve to a stale layer, or a config
change that produces no new revision leaves the prior revision active.
**Fix:** Deploy by **immutable image digest** with a **unique revision suffix**, then
**verify the active revision** after deploy (revision list + traffic split). Treat
the post-deploy revision check as part of the deploy, not an afterthought.
