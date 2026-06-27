---
name: cloud-architecture-aws
description: AWS service-level architecture knowledge — compute (Lambda/Fargate/ECS/EC2), data (DynamoDB/Aurora/RDS), messaging (SQS/SNS/EventBridge/Step Functions), edge (CloudFront/API Gateway), storage (S3/KMS), and Bedrock. Cost models, service quotas, failure modes, and p99/cold-start gotchas. Activate when the active cloud is AWS and the work involves designing, scaling, costing, or diagnosing AWS architecture (Lambda cold starts, Aurora connection limits, DynamoDB hot partitions, NAT egress, Fargate task warm-up).
---

# AWS Architecture Knowledge

Service-level detail for an AWS-backed project. Pairs with Melvin's cloud-agnostic
diagnostic checklist (traffic pattern, state location, SLAs, blast radius, cost
explosion, coordination, limits, observability) — this pack supplies the AWS-specific
answers for each. For concrete project topology, cost tiers, and stack context, read
the architecture docs named in `CLAUDE.md`.

## Compute

### Lambda

- **Cold starts** are the p99 killer. Node/Python ~100-400ms; JVM/.NET worse;
  VPC-attached used to add seconds (now ~sub-100ms with Hyperplane ENI, but still
  non-zero). A function called rarely is *always* cold.
- **Mitigations:** provisioned concurrency (you pay for warm instances), keeping the
  bundle small (esbuild/tree-shake), avoiding heavy module-level init, SnapStart for
  JVM. Provisioned concurrency defeats the "scale to zero" cost story — only buy it
  where the latency SLA demands it.
- **Concurrency limits:** default account limit is 1,000 concurrent executions (raise
  via quota request). Burst concurrency adds a few thousand instantly then scales
  +500/min. A traffic spike past burst headroom = throttles (429), not infinite scale.
- **Reserved concurrency** carves a function's share out of the account pool AND caps
  it — useful to protect a downstream (e.g. a DB) from a stampede, but it can starve
  other functions.
- **15-minute max** execution; 10GB memory ceiling (CPU scales with memory). Payload
  6MB sync / 256KB async. `/tmp` is 512MB default (up to 10GB).
- **Good for:** spiky/event-driven work, glue, APIs with tolerant latency budgets.
  **Bad for:** sustained high-throughput, long-running, or latency-critical-at-tail.

### Fargate / ECS

- Serverless containers — no node management, but **task warm-up** (image pull +
  container start) is tens of seconds. Scale-out is *not* instant; keep a warm pool /
  min task count for latency-sensitive services. This is the Fargate analogue of cold
  starts.
- **Cost:** billed per vCPU-second and GB-second. A perpetually-running over-provisioned
  task (the proverbial 8-vCPU task nobody can explain) bleeds money. Right-size from
  CloudWatch container metrics, don't guess.
- **ECS on EC2** vs Fargate: EC2 is cheaper at steady high utilization and gives GPU /
  special-instance access; Fargate wins on operational simplicity and bursty workloads.
- **EKS** only when you genuinely need the Kubernetes ecosystem (operators, complex
  scheduling, multi-tenant platform). For most app workloads it's operational overhead
  you'll regret — prefer Fargate/ECS or Lambda.

### EC2

- The escape hatch: full control, any instance family (compute/memory/GPU-optimized),
  Spot for fault-tolerant batch (up to ~90% off, can be reclaimed with 2-min warning).
- Savings Plans / Reserved Instances for steady baseline; on-demand for the spiky top.
- You own patching, AMIs, autoscaling groups, health checks. Reach for it when managed
  compute can't meet a hardware, licensing, or latency requirement.

## Data

### DynamoDB

- **Partition key design is everything.** A hot partition (uneven key distribution)
  throttles even when table-level capacity looks fine — each partition has its own
  throughput ceiling (~3,000 RCU / 1,000 WCU). Design keys for even spread; use
  write-sharding for naturally-skewed keys.
- **Capacity:** on-demand (pay-per-request, instant scaling, ~7x the per-request cost)
  vs provisioned (cheaper at predictable load, autoscaling lags spikes). On-demand for
  unknown/spiky; provisioned+autoscaling for steady, known traffic.
- **Consistency:** eventually consistent reads by default (half the cost); strongly
  consistent on request (single-region, not for GSIs). Global tables = multi-region,
  last-writer-wins, eventually consistent across regions.
- **Single-table design** maximizes performance but is a modeling discipline — get the
  access patterns right *first*. Item size max 400KB. Use conditional writes for
  optimistic concurrency / idempotency.
- **Cost traps:** GSIs double the write cost (every write replicates to each index);
  scans are anti-patterns; large items inflate RCU/WCU.

### Aurora / RDS PostgreSQL

- **Connection limits** are the classic bottleneck. Postgres connections are expensive
  (memory per connection); instance size caps `max_connections`. Lambda + RDS is a
  notorious mismatch — N concurrent Lambdas = N connections. Use **RDS Proxy** (or
  PgBouncer) to pool, or you'll exhaust connections under burst.
- **Aurora** vs RDS: Aurora separates compute from a distributed storage layer — faster
  failover (~30s), up to 15 read replicas sharing storage (no replication lag from
  storage copy), auto-scaling storage. Costs more per hour but often wins on HA + read
  scaling. **Aurora Serverless v2** scales ACUs with load for spiky workloads.
- **Read replicas** scale reads, not writes. Route read traffic deliberately; beware
  replica lag for read-after-write.
- **IOPS cost:** Aurora bills per I/O on the standard config (can dominate the bill on
  I/O-heavy workloads — consider Aurora I/O-Optimized). Provisioned IOPS on RDS gp3/io2
  is a real line item.
- **Failover:** Multi-AZ is a standby promotion (brief downtime, connections drop —
  apps must reconnect/retry). Know what breaks when the primary fails over.

## Messaging & Orchestration

### SQS

- Standard (at-least-once, best-effort ordering, near-unlimited throughput) vs **FIFO**
  (exactly-once-processing, strict order, 300 msg/s without batching / 3,000 with).
  Default to standard unless ordering/dedup is a hard requirement — FIFO throughput is
  a real ceiling.
- **Always configure a DLQ** with a sane `maxReceiveCount`. Poison messages without a
  DLQ loop forever and burn money.
- **Visibility timeout** must exceed worst-case processing time, or you get duplicate
  delivery. Idempotent consumers are mandatory (at-least-once).
- Lambda+SQS event source scales pollers automatically; watch the batch size and the
  interaction with reserved concurrency (can throttle and silently back up the queue).

### SNS / EventBridge

- **SNS:** pub/sub fan-out (topic → many subscribers: SQS, Lambda, HTTP). Simple, high
  throughput.
- **EventBridge:** content-based routing with rule filtering, schema registry, many SaaS
  + AWS-service event sources, scheduler. Higher latency than SNS but far richer routing.
  Use EventBridge when you need to *route by content*; SNS when you just need fan-out.
- EventBridge has per-rule and PutEvents throughput quotas — check before betting a
  high-volume pipeline on it.

### Step Functions

- Managed orchestration for multi-step workflows — retries, error handling, parallel,
  map, wait, human-approval. **Standard** workflows (long-running, up to 1 year, billed
  per state transition — gets expensive at high volume) vs **Express** (≤5 min, billed
  per request+duration, high throughput, cheaper for short high-volume flows).
- Use it to make coordination explicit and observable instead of hiding a state machine
  inside Lambda code. Don't use it for tight inner loops (per-transition cost).

## Edge & Networking

### CloudFront

- CDN + edge caching. Fronts S3 (static), ALB/API Gateway (dynamic), Lambda@Edge /
  CloudFront Functions for edge logic. Cuts origin load and egress cost (CloudFront
  egress is cheaper than direct S3/EC2 egress and the origin fetch is free within AWS).
- Cache key design and TTLs determine hit ratio — a bad cache key (e.g. including a
  unique query param) tanks it. Honor `Cache-Control`; use cache policies deliberately.

### API Gateway

- REST (feature-rich, caching, usage plans, request validation — higher cost/latency)
  vs **HTTP API** (cheaper, lower latency, fewer features — prefer it unless you need
  REST-only features) vs WebSocket. Built-in throttling (account + per-method) protects
  backends; tune it.

### VPC / Networking — the cost landmines

- **NAT Gateway** is the silent budget-eater: hourly charge **plus per-GB processing on
  all egress through it**. High-egress workloads behind NAT bleed money. Mitigate with
  **VPC Gateway/Interface Endpoints** (S3 + DynamoDB gateway endpoints are *free* and
  bypass NAT entirely; PrivateLink interface endpoints have an hourly+per-GB cost but
  beat NAT for AWS-service traffic).
- **Cross-AZ data transfer** is charged per GB *each direction* — chatty cross-AZ
  traffic adds up fast. Cross-region is more expensive still.
- Default to private subnets; public only for ALBs / NAT / bastions.

## Storage & Crypto

### S3

- Eleven 9s durability. Storage classes: Standard → Intelligent-Tiering (auto, good
  default for unknown access) → Standard-IA / One Zone-IA → Glacier tiers (retrieval
  latency + cost). Lifecycle policies to age data down.
- **Cost:** storage + **per-request** (GET/PUT/LIST add up at high volume) + egress.
  Globally-unique bucket names (see preflight). Enable encryption (SSE-S3/KMS),
  versioning, and block public access by default.

### KMS

- Envelope encryption: KMS-managed CMK wraps per-object data keys (DEKs). Pattern for
  crypto-shred (delete the key → data is unrecoverable). KMS request volume is cheap —
  it's a rounding error on most bills; don't over-optimize it. Customer-managed keys
  cost a small monthly fee + per-request; key rotation is built-in.

## Bedrock

- Managed access to foundation models (Anthropic Claude, Amazon Nova/Titan, Meta Llama,
  Mistral, etc.) via a single API — no infra to run. On-demand (per-token) vs
  **Provisioned Throughput** (reserved model units for guaranteed capacity/latency,
  committed spend).
- **Quotas matter:** per-model requests-per-minute and tokens-per-minute limits will
  throttle a naive high-volume pipeline — request increases early and build in backoff.
- Knobs: Guardrails (content filtering), Knowledge Bases (managed RAG), Agents. Cold
  region availability varies by model — check the model is available in your region.
- Cost is token-driven; long contexts and large outputs dominate. Cache/trim prompts,
  pick the right model size per task (don't use a frontier model for a classification).

## Cost realism (where AWS bills explode)

1. **NAT Gateway egress** — per-GB on everything leaving via NAT. Use VPC endpoints.
2. **Cross-AZ / cross-region data transfer** — per-GB each way.
3. **Fargate/EC2 over-provisioning** — vCPU-seconds on idle headroom.
4. **Aurora/RDS IOPS** — per-I/O can exceed compute cost on I/O-heavy workloads.
5. **DynamoDB** — on-demand premium, GSI write amplification, scans.
6. **Lambda provisioned concurrency** — pays for warm = no scale-to-zero savings.
7. **S3 request volume** — per-request charges at high object counts.
8. **Bedrock tokens** — context + output length.

Levers: Savings Plans / Reserved Instances (steady baseline), Spot (fault-tolerant
batch), right-sizing from CloudWatch, VPC endpoints, Intelligent-Tiering, Cost Explorer
+ budgets/alarms.

## Service quotas (request increases *before* they bite)

Lambda concurrent executions (1,000 default), VPC/EIP/ENI counts, Fargate task limits,
DynamoDB table/account throughput, RDS instances + Postgres `max_connections`, API
Gateway throttle rates, SQS FIFO throughput, Bedrock per-model RPM/TPM, S3 globally-
unique bucket namespace, ECR repos. Many are soft — raise via Service Quotas console /
support — but a few are hard. Check `aws service-quotas list-service-quotas` for the
service and plan around the hard ones.

## Observability

CloudWatch (metrics, logs, alarms), CloudWatch Embedded Metric Format for high-cardinality
custom metrics, X-Ray for distributed tracing, Cost Explorer + Budgets for spend. Alarm
on the things that predict pain: Lambda throttles/errors/duration p99, SQS queue depth +
age-of-oldest-message, DynamoDB throttled requests, Aurora connections + replica lag, NAT
bytes processed.

## Hard-won lessons

### CloudFront VPC Origins preserve CloudFront's PUBLIC source IP
**Symptom:** CloudFront → internal-ALB VPC Origin returns 504; ALB `RequestCount`
is exactly 0; flow logs show the managed ENI's SYN with no SYN-ACK back.
**Cause:** VPC Origins forward to the origin with **CloudFront's public origin-facing
source IP preserved** (`130.176.x` ∈ prefix list `pl-3b927c52`), not the managed
ENI's private VPC IP — so an ALB SG that admits only the VPC CIDR (`10.20.0.0/16`)
REJECTs every CloudFront packet at the ALB-node ENI's ingress.
**Fix:** Admit the service-managed `CloudFront-VPCOrigins-Service-SG` (an SG-to-SG
rule, one per listener port) — or the origin-facing managed prefix list. A
"looks-equivalent" VPC-CIDR rule is not a substitute.

### Black-box 5xx: is the origin even hit? RequestCount + Flow Logs first
**Symptom:** A fronted service (CloudFront/ELB) returns 5xx and you can't tell
whether the request reached the origin, the targets, or the app.
**Cause:** Reasoning from indirect proofs (Reachability Analyzer, intra-VPC curl)
validates *adjacent* customer-controlled hops, not the actual managed path — they
mislead you into "propagation" or "subnet" theories.
**Fix:** Read ALB `RequestCount` first (0 = nothing completed → look upstream), then
VPC Flow Logs filtered to the two ENI IPs. For an SG drop, read the **destination**
ENI's *ingress* ACCEPT/REJECT — a source-side egress ACCEPT proves nothing about
admission. Localize before hypothesizing.

### Endpoint-only (NAT-less) VPC silently breaks public-internet egress
**Symptom:** Server-side SSO token exchange (OAuth/JWKS) and SES email fail with a
generic error, but only on the first *real* user — cloud smoke tests pass.
**Cause:** VPC interface/gateway endpoints cover only **AWS** services (ECR, KMS,
S3, Secrets Manager, Logs). Anything on the public internet that isn't an AWS
PrivateLink service has no route out without NAT.
**Fix:** Enumerate every public-internet dependency (OAuth/JWKS, SES/SMTP, webhooks,
third-party APIs) before calling a private network "done"; each needs a NAT gateway
or proxy. Add NAT additively (keep subnets isolated, attach NAT + `0.0.0.0/0`); a
task whose SG denies egress stays isolated regardless.

### One-off ECS task on a multi-container task def: judge by container NAME
**Symptom:** A migration/job run on a shared multi-essential-container task def
flakily fails the deploy with an exit-137 it didn't cause.
**Cause:** When the overridden container (`host`) exits 0, ECS SIGKILLs the still-
running sibling (`mcp` → 137). Reading `task.containers[0].exitCode` misattributes
it because `DescribeTasks` container ordering is **not guaranteed**.
**Fix:** Select the overridden container by **name** (`containers.find(c => c.name
=== …)`), never by index. Better: give one-off jobs a dedicated single-container
task definition so there's no sibling to kill.
