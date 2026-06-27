---
name: terraform-conventions
description: Terraform code conventions — security, modularity, maintainability, style, documentation, and testing expectations for any *.tf file. Activate when writing or reviewing Terraform configuration (typically under infra/terraform/ or the project's IaC directory) to enforce consistent structure and safe defaults.
---

# Terraform Conventions

Applies to any `*.tf` file. Primary location is the project's IaC directory (commonly
`infra/terraform/` — confirm in `CLAUDE.md`). These are code conventions; for the
operational discipline (state, plan/apply gates, drift, imports) see the `iac-terraform`
skill, and for service-level resource detail see the active `cloud-architecture-<cloud>`
pack.

## Security

- Use the latest stable Terraform + provider versions; patch regularly. Pin versions and
  commit `.terraform.lock.hcl`.
- **Secrets never in state files, variables, or version control.** Store them in the
  cloud's secret manager (AWS Secrets Manager / SSM, Azure Key Vault, GCP Secret Manager)
  and reference them via data sources or environment variables. Rotate; automate rotation
  where possible.
- Mark any sensitive variable/output `sensitive = true`.
- Least-privilege IAM/roles. Restrict network access with the cloud's native controls
  (security groups + NACLs, NSGs, firewall rules).
- Resources in private subnets/networks by default; public only for load balancers / NAT
  / similar entry points.
- Encryption at rest (disks, object storage, managed databases) and in transit (TLS).
- Scan with `trivy`, `tfsec`, or `checkov` in CI.

## Modularity

- Separate state/projects for major components — reduces blast radius, speeds up
  plan/apply.
- Modules for groups of related resources only. Don't wrap a single resource in a module.
- Avoid deep nesting and circular dependencies.
- Expose interesting attributes via `output`; mark sensitive ones.

## Maintainability

- Prefer readable, explicit configs over clever ones.
- Variables (with sensible defaults where appropriate) instead of hard-coded values.
- Data sources for *existing* external resources; outputs for in-config references.
- `locals` for repeated values to enforce consistency.
- Avoid stale/unnecessary data sources — they slow plan/apply.

## Style

- 2-space indents. Run `terraform fmt`, `terraform validate`, `tflint`.
- File naming by resource grouping (`providers.tf`, `variables.tf`, `network.tf`,
  `outputs.tf`, etc.).
- Alphabetize providers, variables, data sources, resources, and outputs.
- Order within a resource: `depends_on` → `for_each`/`count` → attributes (required, then
  optional) → `lifecycle`.
- Use `for_each` for collections; `count` for numeric iteration.
- Blank lines to separate logical sections.

## Documentation

- `description` + `type` on every variable and output.
- Comment intent and non-obvious decisions, not the obvious.
- `README.md` per project; consider `terraform-docs` for generated module docs.

## Testing

- Use `.tftest.hcl` for tests.
- Cover positive and negative scenarios.
- Tests must be idempotent.

## This repo's stack

- The active cloud, services, and IaC directory are declared in `CLAUDE.md`; the
  `cloud-architecture-<cloud>` pack carries the service-level detail.
- Check the backend config (`backend.tf` or equivalent) before changing anything
  stateful.

## Hard-won lessons

### Span two control planes? Use a multi-provider tool so one apply wires both sides
**Symptom:** Infrastructure crosses a cloud *and* a managed SaaS (e.g. Azure +
MongoDB Atlas, where a Private Endpoint requires resources on **both** the Atlas
Private Link service and the Azure side, cross-referenced).
**Cause:** Single-cloud IaC (Bicep, CDK, raw ARM) can only manage its own cloud — it
structurally cannot touch the SaaS half, so that half drops back to console clicks or
a second tool, breaking "everything repeatable" for the exact resources that matter.
**Fix:** Choose **Terraform** (multi-provider — e.g. `azurerm` + `mongodbatlas` in
one graph) so a single `terraform apply` wires both sides of the integration. Adopt
pre-existing/shared resources as data sources or `terraform import`; don't recreate.
