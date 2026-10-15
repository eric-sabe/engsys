---
name: iac-terraform
description: Terraform & OpenTofu discipline and HCL code conventions — modules, remote state, workspaces, backends, plan/apply gates, drift detection, state surgery, security defaults, style, and .tftest.hcl testing. Activate when working on *.tf / *.tfvars files, terraform/tofu plan/apply/state operations, backend or workspace config, provider versioning, or diagnosing drift and partial applies.
---

# Terraform & OpenTofu Discipline and Conventions

Operational discipline and HCL coding conventions for Terraform and OpenTofu (`*.tf`, `*.tfvars`, `*.tftest.hcl`) — cloud-independent. Service-level resource detail comes from the active `cloud-architecture-<cloud>` pack; project file layout and backend config come from `CLAUDE.md`.

## Core Stance

- **Infrastructure is software.** If it only works once, it doesn't work. "Just apply it again" is not a strategy — understand *why* it failed first.
- **Plan is the contract.** Never `apply` without reading the `plan`. Treat a surprising plan as a bug to investigate, not a step to skip.
- **Pin everything.** Pin required Terraform/OpenTofu versions and provider versions in `.terraform.lock.hcl` (committed).

## State Management & Surgery

- **Remote state with locking, always** (S3 + DynamoDB/native lock, GCS, Azure Blob lease, or Terraform Cloud). Never commit `.tfstate` files.
- **Separate state per major component and environment** (`dev` vs. `prod` never share state) to minimize blast radius and lock contention.
- **State surgery** when reality and state diverge:
  - `terraform state list` — inspect tracked resources
  - `terraform import <addr> <id>` (or `import {}` blocks) — adopt existing resources
  - `moved { from = ... to = ... }` or `terraform state mv` — refactor without destroy+recreate
  - `terraform state rm` — stop tracking without deleting the underlying cloud resource
  - Always run `plan` immediately after state surgery to confirm zero unintended diffs.

## Security & Safe Defaults

- **Never store secrets in `.tf`, `.tfvars`, or state where avoidable.** Reference secrets from AWS Secrets Manager / SSM, Azure Key Vault, or GCP Secret Manager, and mark sensitive variables/outputs with `sensitive = true`.
- Enforce least-privilege IAM/OIDC roles, private networking by default, encryption at rest and in transit, and static IaC scanning (`trivy`, `checkov`, or `tflint`) in CI.
- Protect stateful resources (databases, disks, buckets) with `lifecycle { prevent_destroy = true }`.

## Modularity, Style & Testing Conventions

- **Modules**: Group cohesive resources into version-pinned modules with typed, documented `variable` and `output` contracts. Never wrap a single resource in a thin pass-through module.
- **File layout & ordering**: Group by domain (`providers.tf`, `variables.tf`, `main.tf`, `network.tf`, `outputs.tf`). Within a resource block, order: `depends_on` → `for_each`/`count` → required attributes → optional attributes → `lifecycle`. Prefer `for_each` (keyed by stable string ID) over positional `count`.
- **Formatting & validation**: Run `terraform fmt -check`, `terraform validate`, and `tflint` before every commit.
- **Testing**: Author idempotent `.tftest.hcl` test suites covering both nominal and invalid variable inputs.

## Plan / Apply Gates & Drift

- **Pipeline gate**: `fmt` → `validate` → `plan` (posted on PR) → operator approval gate → `apply` on merge.
- **Inspect for `-/+` replacements**: Never rubber-stamp a replacement on a stateful resource.
- **Drift**: Schedule `plan -refresh-only` checks; reconcile any out-of-band click-ops back into `.tf` immediately.
- **Preflight**: Always run the active cloud's `*-deployment-preflight` skill before applying.

## Hard-Won Lessons

### Span two control planes? Use a multi-provider graph so one apply wires both sides
- **Symptom:** Infrastructure crosses a cloud *and* a managed SaaS (e.g., Azure + MongoDB Atlas Private Endpoint), and single-cloud IaC (Bicep/CDK) leaves the SaaS half to manual console clicks.
- **Fix:** Use Terraform/OpenTofu multi-provider composition (e.g., `azurerm` + `mongodbatlas` in one root module) so a single `plan`/`apply` wires both sides of the boundary deterministically.
