---
name: gcp-deployment-preflight
description: Preflight validation for GCP infrastructure deployments (Terraform / OpenTofu / gcloud / Infrastructure Manager / Cloud Run / Config Connector). Run before any deploy. Validates templates, cleans up stuck operations and revisions, catches globally-unique naming conflicts (GCS buckets, project IDs, Artifact Registry), and checks quota/API enablement.
---

# GCP Deployment Preflight

Validate GCP infrastructure changes locally and clear blocking state *before* you deploy, so CI doesn't discover what you could have caught locally. Continue through all steps even if one fails — capture every issue, then fix them in a single batch.

> **2026 Tooling Note:** Do NOT use sunset `gcloud deployment-manager` (sunset March 2026) or legacy `gsutil` commands. Use **Terraform / OpenTofu**, **GCP Infrastructure Manager (`gcloud infra-manager`)**, **Cloud Run (`gcloud run`)**, and **`gcloud storage`**.

## Step 1 — Detect Project Type & Confirm Context

- **Terraform / OpenTofu (standard GCP IaC):** `*.tf` with `google` / `google-beta` providers and GCS backend → Step 2a.
- **GCP Infrastructure Manager / Cloud Run:** `gcloud infra-manager` deployments or `gcloud run` services → Step 2b.
- **Config Connector (KCC):** Kubernetes-style GCP resource manifests → validate with `kubectl diff` / `nomos vet`.
- Confirm active project, account, and region first:

```bash
gcloud config get-value project
gcloud auth list
gcloud config get-value compute/region
```

## Step 2 — Validate & Preview

### 2a — Terraform / OpenTofu

Use the project's active IaC executable (`IAC_BIN=terraform` or `IAC_BIN=tofu`):

```bash
IAC_BIN="${IAC_BIN:-terraform}" # set to `tofu` for OpenTofu repos
"$IAC_BIN" fmt -check
"$IAC_BIN" validate
"$IAC_BIN" plan -out=tfplan
"$IAC_BIN" show -no-color tfplan
```

Inspect the plan for **destroys or `-/+` replacements of stateful resources** (Cloud SQL, Spanner, GCS buckets, persistent disks) and IAM policy bindings. Never rubber-stamp a stateful resource replacement.

### 2b — Cloud Run & Infrastructure Manager

```bash
# Infrastructure Manager preview deployment
gcloud infra-manager previews create <preview-id> \
  --location=<region> \
  --deployment=<deployment-id> \
  --local-source="."

# Cloud Run (read-only preflight): verify image digest exists in Artifact Registry and inspect current service spec
# (Keep revision-creating `gcloud run deploy` commands behind the operator approval gate)
gcloud artifacts docker images describe <image-digest>
gcloud run services describe <service> --region=<region> --format=export
```

## Step 3 — Inspect Stuck Operations & Blocking Resources

```bash
# Check recent errors in Cloud Logging (read the root cause, not the cascade)
gcloud logging read 'severity>=ERROR' --limit 20 --freshness=1h

# Inspect active Infrastructure Manager or Cloud Run operations
gcloud infra-manager deployments list --location=<region>
gcloud run revisions list --service=<service> --region=<region>
```

Watch for resources that block deletion or replacement: non-empty GCS buckets, Artifact Registry repositories containing images, Cloud SQL / Spanner instances with `deletion_protection = true`, and attached VPC serverless connectors.

## Step 4 — Globally-Unique Naming & Storage Checks

| Resource | Namespace | Verification Command |
| --- | --- | --- |
| **GCS Bucket** | Global across all of GCP | `gcloud storage buckets describe gs://<bucket-name>` |
| **Project ID** | Global, immutable forever | `gcloud projects describe <project-id>` |
| **Artifact Registry** | Per project + region | `gcloud artifacts repositories describe <repo> --location=<region>` |

Never hardcode bare global bucket names without a project/environment suffix. Always use `gcloud storage` (never legacy `gsutil`).

## Step 5 — API Enablement & Quota Headroom

```bash
# Verify required GCP APIs are enabled
gcloud services list --enabled

# Check regional and project quota usage vs. limits
gcloud compute regions describe <region> \
  --format="table(quotas.metric, quotas.limit, quotas.usage)"
gcloud compute project-info describe \
  --format="table(quotas.metric, quotas.limit, quotas.usage)"
```

## Step 6 — Check for In-Flight CI Deploys

```bash
gh run list --workflow="<deploy-workflow>" --limit 3
```

If a deploy run is already in progress, wait for it to finish before triggering another apply.

## Step 7 — Preflight Report

Summarize: validation/plan diff (`create` / `modify` / `destroy` / `replace`), stuck revisions cleared, global naming checks, enabled APIs + quota headroom, and whether it is safe to proceed with the operator-gated deploy.
