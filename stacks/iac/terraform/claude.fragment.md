## IaC stack

- **Active IaC tool: Terraform / OpenTofu.** Infrastructure changes go through Terraform/OpenTofu; **Aaron** and **Isabelle** load the **`iac-terraform`** skill pack for both operational state/plan/apply discipline and HCL code conventions.
- **Workflow gate:** `<terraform|tofu> fmt` → `validate` → `plan` (review) → `apply` (use the active IaC executable, `terraform` or `tofu`, consistently). Never `apply` without reading the `plan`; plan on PR, apply on merge (behind operator gate for prod).
- Run the active cloud's `*-deployment-preflight` skill before applying for cloud-specific checks (naming, quotas, stale state) that `plan` won't surface.
- Read-only CLI (`fmt`, `validate`, `plan`, `state list`, `show`) is allowed; `apply` and `destroy` are gated.
- **IaC-first.** Infra changes land in code and deploy through CI. Console/CLI mutations are emergency-only — mirror them in code immediately and commit `fix(iac): sync manual hotfix for #<issue>`.

<!-- naturalize: confirm the IaC directory, backend config location, and per-environment state layout. -->
