---
name: iac-terraform
description: Terraform discipline for any project where Terraform is the active IaC tool — modules, remote state, workspaces, backends, plan/apply gates, drift detection, and import/state surgery. Activate when working on *.tf / *.tfvars files, terraform plan/apply/state operations, backend or workspace config, provider versioning, or diagnosing drift and partial applies.
---

# Terraform Discipline

The operational discipline for Terraform as the active IaC tool — cloud-independent.
Service-level resource detail comes from the active `cloud-architecture-<cloud>` pack;
project file layout and backend config come from `CLAUDE.md`. For repo-specific style
(naming, ordering, security defaults) see the `terraform-conventions` skill if present.

## Core stance

- **Infrastructure is software.** If it only works once, it doesn't work. "Just apply it
  again" is not a strategy — understand *why* it failed first.
- **Plan is the contract.** Never `apply` without reading the `plan`. The plan is the
  what-if; treat a surprising plan as a bug to investigate, not a step to skip.
- **Pin everything.** Required Terraform version + provider versions in a lockfile
  (`.terraform.lock.hcl`, committed). Unpinned providers are how "it worked yesterday"
  happens.

## State

- **Remote state with locking, always.** Local state is a single point of failure and
  blocks collaboration. Use a backend with locking (e.g. S3 + DynamoDB lock table, GCS,
  azurerm with blob lease, or Terraform Cloud). Never commit state — it contains secrets.
- **Separate state per major component / environment** — smaller blast radius, faster
  plan/apply, and a failure in one doesn't lock the others. Check the project's
  `backend.tf` / backend config before touching anything stateful.
- **State surgery** when reality and state diverge:
  - `terraform state list` — see what's tracked.
  - `terraform import <addr> <id>` — adopt an existing resource.
  - `terraform state mv` — rename/move without destroy+recreate.
  - `terraform state rm` — stop tracking (does NOT delete the real resource).
  - Always `plan` after surgery to confirm convergence. Back up state first.

## Modules

- **Modules for groups of related resources only.** Don't wrap a single resource in a
  module — that's indirection without benefit.
- Pin module sources to a version/ref. Expose interesting attributes via `output`; mark
  sensitive ones `sensitive = true`.
- Avoid deep nesting and circular dependencies. A module should have a clear, narrow
  interface (typed `variable`s with `description`, validated where it matters).
- Prefer composition (root config wires modules together) over monolithic mega-modules.

## Workspaces & environments

- Workspaces (`terraform workspace`) give you state isolation for *the same config across
  environments* — useful, but they share the same backend key prefix and are easy to
  misuse. For genuinely different environments, **separate backend keys / directories +
  tfvars** is usually clearer and safer than relying on workspace interpolation.
- Never let `dev` and `prod` share state. Parameterize via `*.tfvars` per environment;
  keep secrets out of tfvars (use a secrets manager + data sources / env vars).

## Plan / apply gates

- **`terraform fmt` → `validate` → `plan` → review → `apply`** is the pipeline. In CI:
  plan on PR (post the plan), apply only on merge to the protected branch, behind
  approval for prod.
- **Read the plan for destroys and replacements.** A `-/+` (replace) on a stateful
  resource (database, disk, bucket) is a data-loss event — stop and confirm. Use
  `lifecycle { prevent_destroy = true }` on the truly precious.
- Keep infra applies separate from app deploys unless there's a very good reason not to.
- `-target` is an escape hatch for recovering a broken apply, not a normal workflow —
  it produces partial state. Note it when you use it.

## Drift

- **Detect drift before it bites:** `terraform plan` (or `plan -refresh-only`) on a
  schedule shows out-of-band (click-ops) changes. A non-empty plan on an unchanged config
  *is* drift.
- Resolve drift deliberately: either bring the change into code (and apply), or revert
  the manual change. Don't let an unexplained diff sit — it compounds.
- **No click-ops in production**, ever. Manual changes create snowflake environments that
  can't be recreated.

## Troubleshooting

- **Partial apply:** read which resources succeeded, reconcile state (import/refresh),
  then re-plan. Don't blindly re-apply.
- **API throttling:** tune `-parallelism`, add provider-level retries, back off.
- **Provider auth / IAM:** trace the credential chain and the role/policy actually in
  use; permission errors lie about the real missing action — read them for meaning.
- **Lock held:** a crashed run can leave a stale lock; `force-unlock` only when you're
  certain no apply is in flight.

## Preflight

Before applying, run the active cloud's `*-deployment-preflight` skill — it covers the
cloud-specific concerns (stale/failed deployments, globally-unique naming, quota/SKU
limits) that `terraform plan` alone won't surface.
