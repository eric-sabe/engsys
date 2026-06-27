## IaC stack

- **Active IaC tool: Bicep.** Infrastructure changes go through Bicep; Aaron loads the
  `iac-bicep` skill pack.
- **Workflow gate:** `bicep build` (syntax) → `az deployment group validate` →
  `what-if` (review) → deploy. `bicep build` alone is not the gate — validate + what-if
  are. Fix failures locally; don't let CI discover them.
- Run the `azure-deployment-preflight` skill before deploying for stale-deployment
  cleanup, globally-unique naming, and SKU/tier checks.
- Read-only CLI (`bicep build`, `validate`, `what-if`, `azd provision --preview`) is
  allowed; `deployment create` / `azd up` are gated.

<!-- naturalize: confirm the infrastructure/ layout, resource group(s), and per-env
.bicepparam files. -->
