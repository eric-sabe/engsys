## IaC stack

- **Active IaC tool: Terraform.** Infrastructure changes go through Terraform; Aaron
  loads the `iac-terraform` and `terraform-conventions` skill packs.
- **Workflow gate:** `terraform fmt` → `validate` → `plan` (review) → `apply`. Never
  `apply` without reading the `plan`; plan on PR, apply on merge (approval for prod).
- Run the active cloud's `*-deployment-preflight` skill before applying for the
  cloud-specific checks (naming, quotas, stale state) `plan` won't surface.
- Read-only CLI (`fmt`, `validate`, `plan`, `state list`, `show`) is allowed; `apply`
  and `destroy` are gated.
- **IaC-first.** Infra changes land in code and deploy through CI. Console/CLI mutations
  are debug/emergency only — after one, record resource + property old→new, mirror it in
  code, and commit `fix(iac): sync manual hotfix for #<issue>`. No "unblock now, fix IaC
  later": time-box any unavoidable shortcut with a tracked removal issue. Red flags:
  chained CLI updates, env vars or firewall/secret changes set only via CLI.

<!-- naturalize: confirm the IaC directory, backend config location, and per-environment
state layout. -->
