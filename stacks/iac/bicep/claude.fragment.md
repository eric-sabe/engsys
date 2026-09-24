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
- A post-edit reminder (this pack's hook) nudges the validate/what-if gate after any
  `*.bicep` / `*.bicepparam` edit.
- **IaC-first.** Infra changes land in code and deploy through CI. Console/CLI mutations
  are debug/emergency only — after one, record resource + property old→new, mirror it in
  code, and commit `fix(iac): sync manual hotfix for #<issue>`. No "unblock now, fix IaC
  later": time-box any unavoidable shortcut with a tracked removal issue. Red flags:
  chained CLI updates, env vars or firewall/secret changes set only via CLI.

<!-- naturalize: confirm the infrastructure/ layout, resource group(s), and per-env
.bicepparam files. -->
