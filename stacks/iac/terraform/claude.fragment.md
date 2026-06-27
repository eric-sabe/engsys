## IaC stack

- **Active IaC tool: Terraform.** Infrastructure changes go through Terraform; Aaron
  loads the `iac-terraform` and `terraform-conventions` skill packs.
- **Workflow gate:** `terraform fmt` → `validate` → `plan` (review) → `apply`. Never
  `apply` without reading the `plan`; plan on PR, apply on merge (approval for prod).
- Run the active cloud's `*-deployment-preflight` skill before applying for the
  cloud-specific checks (naming, quotas, stale state) `plan` won't surface.
- Read-only CLI (`fmt`, `validate`, `plan`, `state list`, `show`) is allowed; `apply`
  and `destroy` are gated.

<!-- naturalize: confirm the IaC directory, backend config location, and per-environment
state layout. -->
