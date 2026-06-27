---
name: azure-deployment-preflight
description: Preflight validation for Azure infrastructure deployments (Bicep/ARM). Run before any az deployment / azd up. Validates templates (bicep build, az deployment group validate / what-if), cleans up stale failed ARM deployments that block re-deploy, catches globally-unique naming conflicts (Key Vault/ACR/etc.), and checks SKU/tier and service-limit restrictions. Carries the hard-won Bicep lessons (PgBouncer Burstable limit, alert module location, KQL interpolation, ACR SKU). Activate when the active cloud is Azure and the user mentions deploying, validating Bicep, what-if, preview, az deployment, azd provision, or deploy failures.
---

# Azure Deployment Preflight

Validate Bicep/ARM deployments locally and clear blocking state *before* you deploy,
so CI doesn't discover what you could have caught. Supports both `az` CLI and `azd`
workflows. Continue through all steps even if one fails — capture every issue, then fix
them in a batch.

> Discipline: **batch your fixes.** Each push triggers a ~15-30 min CI run. Read the
> entire failing module, reason about *all* potential issues, fix them all, push once.
> One CI run per problem cluster, not one per error message.

## When to use

- Before deploying infrastructure to Azure (`az deployment`, `azd up`, `azd provision`).
- When preparing or reviewing Bicep files.
- To preview what a deployment will change (what-if).
- To verify permissions are sufficient.
- After a failed deployment left ARM in a blocking state.

## Step 1 — Detect project type & locate templates

- **azd project:** `azure.yaml` at root → use the **azd workflow**. Bicep usually under
  `infra/`. Otherwise use the **`az` CLI workflow**.
- **Locate `.bicep` files** (common: `infra/`, `infrastructure/`, `deploy/`, root) and
  the matching parameter file per template: `<name>.bicepparam` (preferred) or
  `<name>.parameters.json`.
- Determine the **deployment scope** from `targetScope` in the template
  (`resourceGroup` default / `subscription` / `managementGroup` / `tenant`) — it picks
  the validate/what-if command in Step 3.
- Confirm context: `az account show` (subscription), resource group, location. Prompt
  for any missing required value before proceeding.

## Step 2 — Validate Bicep syntax

```bash
bicep build <bicep-file> --stdout     # or: az bicep build --file <bicep-file>
```

> **`bicep build` / `az bicep build` only checks syntax.** It will **not** catch metric
> names, KQL scope, secret-ref mismatches, invalid property combinations, or naming
> collisions. Treat it as the first gate, not the gate.

If the Bicep CLI is missing, note it and continue — Azure validates syntax during
validate/what-if anyway.

## Step 3 — Full preflight validation (the real gate)

### azd projects

```bash
azd provision --preview                       # or --environment <env>
```

### Standalone Bicep — `az deployment ... validate` then `what-if`

`validate` catches deployment-time errors (property combos, secret refs, quota where
checkable) that `bicep build` misses. Pass dummy values for required secure params so
validation can run:

```bash
cd infrastructure
az deployment group validate \
  --resource-group <rg-name> \
  --template-file main.bicep \
  --parameters environments/<env>.bicepparam \
  --parameters postgresAdminPassword="dummy" \
  --parameters postgresAdminUsername="dummy"
```

**If it fails locally, fix it locally. Do not push and let CI discover it.**

Then preview changes with what-if (command by scope):

| targetScope | what-if command |
| --- | --- |
| `resourceGroup` (default) | `az deployment group what-if` |
| `subscription` | `az deployment sub what-if --location <loc>` |
| `managementGroup` | `az deployment mg what-if --management-group-id <id> --location <loc>` |
| `tenant` | `az deployment tenant what-if --location <loc>` |

```bash
az deployment group what-if \
  --resource-group <rg-name> \
  --template-file main.bicep \
  --parameters environments/<env>.bicepparam \
  --validation-level Provider
```

**Fallback:** if `--validation-level Provider` fails on RBAC, retry with
`ProviderNoRbac` and note in the report that the user may lack full deploy permissions.

What-if change symbols: `+` create · `-` delete · `~` modify · `=` no change · `*`
ignored · `!` deploy (unknown). Flag any **delete** or replacement of a stateful
resource (PostgreSQL, Key Vault, storage).

## Step 4 — Clean up stale failed ARM deployments

ARM tracks deployment records **by name**. A failed sub-deployment (e.g.
`<proj>-dev-alerts`) blocks a new run with **`DeploymentActive`** even while it sits in
`Failed`. Clean up before each new attempt:

```bash
az deployment group list --resource-group <rg-name> \
  --query "[?properties.provisioningState=='Failed'].name" -o tsv \
  | grep -v "Failure-Anomalies" \
  | xargs -I{} az deployment group delete --name {} --resource-group <rg-name> --no-wait
```

## Step 5 — Globally-unique naming conflicts

Several Azure resource types have **globally-unique** names, and names from a prior /
deleted deployment are either reserved or **soft-deleted** (Key Vault purge protection
keeps the name reserved). Parameterize the name and override on conflict:

| Resource | Typical default (gets taken) | Override pattern |
| --- | --- | --- |
| Key Vault | `<proj>-<env>-kv` | `<proj>-<env>-kv-<suffix>` |
| Storage account | `<proj><env>sa` (3-24, lowercase alnum) | append short unique suffix |
| ACR | `<proj><env>acr` | append short unique suffix |
| Redis / Service Bus / Front Door / App | `<proj>-<env>-<x>` | `...-<suffix>` |

**Pattern:** add `param keyVaultName` / `param <x>Name` to `main.bicep` and set the
override in `environments/*.bicepparam` — don't hard-code the bare default. If a script
(e.g. a Key Vault seeder) defaults the name internally, **pass the override explicitly**
and make every workflow step that references it use the same resolved name.

## Step 6 — SKU / tier & known Bicep gotchas (hard-won)

These were discovered the expensive way — don't rediscover them.

- **ACR SKU:** `Basic` may be unavailable on some subscriptions (e.g. Microsoft for
  Startups). `Standard` works but **`retentionPolicy` requires `Premium`** — remove it
  from dev/staging. If a failed deploy left a broken ACR, create it manually then let
  Bicep treat it as no-change.
- **PgBouncer not on Burstable:** dev/staging on `Standard_B*` (Burstable) cannot run
  PgBouncer (needs GeneralPurpose+). Guard it:
  `resource pgBouncer ... = if (currentSku.tier != 'Burstable') { ... }`.
- **Alert module location:**
  - `Microsoft.Insights/metricAlerts` → `location: 'global'` ✅
  - `Microsoft.Insights/scheduledQueryRules` → `location: 'global'` ❌; use the real
    region (e.g. `eastus2`).
  - `scheduledQueryRules` must scope to the **Log Analytics workspace ID**, not the App
    Insights ID — the `AppRequests` table lives in the workspace.
- **KQL in Bicep:** queries in `'''` verbatim strings **do not interpolate** `${vars}`
  — build the query with string-concatenation variables instead.
- **Metric names:** PostgreSQL Flexible Server uses `active_connections`, not
  `connection_percent` (that's Azure SQL).

## Step 7 — Check for an in-flight deploy before triggering

If CI auto-deploys on push to a branch, don't fire a manual deploy on top — the auto-run
wins and yours sits queued (the user has to cancel it).

```bash
gh run list --workflow="<deploy workflow>" --limit 3
```

If a run is `queued`/`in_progress`, wait.

## Step 8 — Report

Summarize: validation + what-if results (creates / modifies / **deletes** /
replacements), stale deployments cleaned, naming overrides applied, SKU/tier issues, and
whether it's safe to deploy. Note any `ProviderNoRbac` fallback (permission gap).

## Tool requirements

`az` CLI 2.76+ (for `--validation-level`), `azd` (azd projects), `bicep` CLI, `gh` (if
CI-driven). Verify auth: `az account show` / `azd auth login`. For deep Azure service
docs, use the `microsoft-docs` skill (Microsoft Learn MCP).
