---
name: gcp-deployment-preflight
description: Preflight validation for GCP infrastructure deployments (Terraform / gcloud / Deployment Manager / Config Connector). Run before any deploy. Validates templates (terraform validate/plan or gcloud deployment preview), cleans up stale/failed deployments and stuck resources, catches globally-unique naming conflicts (GCS bucket, project IDs, Artifact Registry), and checks quota/capacity limits. Activate when the active cloud is GCP and the user mentions deploying, validating, previewing infra changes, gcloud deploy, terraform plan/apply on GCP, or deploy failures.
---

# GCP Deployment Preflight

Validate GCP infrastructure changes locally and clear blocking state *before* you
deploy, so CI doesn't discover what you could have caught. Continue through all steps
even if one fails — capture every issue, then fix them in a batch.

> Discipline: **batch your fixes.** Each deploy/CI run costs real minutes. Read the
> whole failing config, reason about every issue, fix them all, push once. One run per
> problem cluster, not one per error message.

## When to use

- Before `terraform apply`, `gcloud run deploy`, `gcloud deployment-manager deployments
  create/update`, or Config Connector / KCC applies.
- When preparing or reviewing GCP IaC (Terraform google provider, Deployment Manager,
  Config Connector manifests).
- To preview what a deploy will change.
- After a failed deploy left a deployment or resource stuck.

## Step 1 — Detect project type & confirm context

- **Terraform (most common for GCP IaC):** `*.tf` with the `google`/`google-beta`
  provider, backend in GCS. → use the Terraform flow (Step 2a).
- **gcloud / Deployment Manager:** `*.yaml`/`*.jinja` DM configs, or imperative
  `gcloud` deploys. → Step 2b.
- **Config Connector / KCC:** Kubernetes-style GCP-resource manifests applied to a
  cluster.
- Confirm context — wrong project is the expensive mistake:

```bash
gcloud config get-value project
gcloud auth list                       # active account
gcloud config get-value compute/region
```

## Step 2 — Validate & preview

### 2a — Terraform

```bash
terraform fmt -check
terraform validate
terraform plan -out=tfplan             # the what-if; review creates/changes/destroys
terraform show -no-color tfplan        # inspect details
```

Review the plan for **destroys / replacements of stateful resources** (Cloud SQL,
Spanner, GCS buckets, persistent disks) and any IAM-binding changes. Never rubber-stamp
a replacement of a data store.

### 2b — gcloud / Deployment Manager

```bash
# Deployment Manager dry-run preview
gcloud deployment-manager deployments update <name> --config config.yaml --preview
gcloud deployment-manager deployments describe <name>     # inspect the preview

# Cloud Run: validate the service spec without serving traffic
gcloud run deploy <svc> --image <img> --no-traffic --tag preflight  # revision w/o traffic
```

## Step 3 — Clean up stale / failed deployments & stuck resources

```bash
# Deployment Manager: failed deployments block re-create
gcloud deployment-manager deployments list \
  --filter="operation.status!=DONE OR operation.error:*"
gcloud deployment-manager deployments delete <name>        # if stuck/failed

# Recent failed operations (root cause — read the first error, not the cascade)
gcloud logging read 'severity>=ERROR' --limit 20 --freshness=1h
```

Terraform: a partial apply leaves real resources with no/partial state. Use
`terraform state list` + `terraform import` to reconcile, or `-target` a clean re-apply.
Watch for **resources that block deletion** — non-empty GCS buckets, Artifact Registry
repos with images, resources with `deletion_protection = true` (Cloud SQL, Spanner),
in-use IPs/networks. Clear them first.

## Step 4 — Globally-unique naming conflicts

| Resource | Namespace | Conflict mode |
| --- | --- | --- |
| **GCS bucket** | Global (all of GCP) | name taken / recently-deleted names reserved |
| **Project ID** | Global, **immutable**, not reusable | must be unique forever |
| **Artifact Registry repo** | Per project+location | already-exists |
| Cloud Run service, Pub/Sub topic, etc. | Per project (+region) | recreate collisions after partial deploys |

**Pattern:** never hard-code a globally-unique name — add a short unique suffix
(project-id fragment / random) via a Terraform variable or `random_id`, and check
availability before deploy (`gsutil ls -b gs://<name>` / `gcloud artifacts repositories
describe`). Project IDs especially are permanent — pick deliberately.

## Step 5 — Quota & capacity check

Deploys fail late when a quota is hit. Pre-check what the change will consume:

```bash
gcloud compute regions describe <region> \
  --format="table(quotas.metric, quotas.limit, quotas.usage)"
gcloud compute project-info describe \
  --format="table(quotas.metric, quotas.limit, quotas.usage)"
```

Common deploy-blocking quotas: Compute CPUs / in-use external IPs per region, GPUs/TPUs,
Cloud Run CPU + max-instances quota, Cloud SQL instances, Spanner nodes, VPC networks/
subnets, and **API enablement** — a deploy fails if the required API isn't enabled
(`gcloud services list --enabled`; enable with `gcloud services enable`). Soft quotas
need an IAM & Admin → Quotas request with lead time — raise them before the deploy.

## Step 6 — Check for an in-flight deploy before triggering

If CI auto-deploys on push, don't fire a manual deploy on top — the runs race.

```bash
gh run list --workflow="<deploy workflow>" --limit 3
gcloud deployment-manager operations list --filter="status!=DONE"
```

If a deploy is in progress, wait.

## Step 7 — Report

Summarize: validate/plan results (creates / modifies / **destroys** / replacements),
deployments cleaned up, naming overrides applied, required-API + quota headroom, and
whether it's safe to deploy. Flag any replacement of a stateful resource and any IAM
change.

## Tool requirements

`gcloud` CLI, `terraform` (for TF projects), `gsutil`, `gh` (if CI-driven). Verify auth:
`gcloud auth list` / `gcloud config get-value project`.
