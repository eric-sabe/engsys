---
name: iac-bicep
description: Bicep / ARM discipline for any project where Bicep is the active IaC tool — modules/environments/main.bicep layout, parameter files (.bicepparam), the az validate → what-if flow, deployment scopes, and the hard-won Azure Bicep gotchas (globally-unique names, ACR SKU, PgBouncer Burstable limit, alert module location, KQL interpolation, metric names). Activate when working on *.bicep / *.bicepparam files, az deployment / azd provision, ARM deployment failures, or diagnosing Bicep validation and drift.
---

# Bicep / ARM Discipline

The operational discipline for Bicep as the active IaC tool (Azure). Pairs with the
`cloud-architecture-azure` pack (service-level detail) and the
`azure-deployment-preflight` skill (the pre-deploy gate). Project file layout and
resource-group/subscription facts come from `CLAUDE.md`.

## Core stance

- **Infrastructure is software.** If it only works once, it doesn't work. "Just deploy it
  again" is not a strategy — understand *why* it failed.
- **`bicep build` only checks syntax.** It does NOT catch invalid property combinations,
  metric names, KQL scope, secret-ref mismatches, or naming collisions. The real gate is
  `az deployment group validate` + `what-if` (see `azure-deployment-preflight`).
- **Batch your fixes.** Each push triggers a long CI run — read the whole failing module,
  fix every issue, push once. One run per problem cluster, not one per error message.

## Project layout

A conventional, recreatable structure (confirm exact paths in `CLAUDE.md`):

```
infrastructure/
  main.bicep                 # orchestration: wires modules together, declares params
  modules/                   # reusable modules, one concern each (db, acr, alerts, …)
    <concern>.bicep
  environments/
    dev.bicepparam           # per-env parameter files (preferred over .parameters.json)
    staging.bicepparam
    prod.bicepparam
  scripts/                   # helper scripts (e.g. seed-keyvault.sh)
```

- **`main.bicep`** is the orchestrator: declare `param`s, set defaults, instantiate
  modules with explicit dependencies, expose `output`s.
- **Modules** group related resources with a narrow, typed interface (`param` +
  `@description`). Don't wrap a single resource unless it earns reuse.
- **`.bicepparam`** files (typed, support expressions and `getSecret()`) are preferred
  over JSON parameter files. Keep one per environment; never hard-code per-env values in
  `main.bicep`.

## Deployment scopes

The `targetScope` declaration picks the deploy/validate command:

| `targetScope` | command family |
| --- | --- |
| `resourceGroup` (default) | `az deployment group ...` |
| `subscription` | `az deployment sub ... --location <loc>` |
| `managementGroup` | `az deployment mg ... --management-group-id <id> --location <loc>` |
| `tenant` | `az deployment tenant ... --location <loc>` |

## The validate → what-if flow (run before every deploy)

```bash
cd infrastructure
bicep build main.bicep --stdout            # 1. syntax only

az deployment group validate \             # 2. real deploy-time validation
  --resource-group <rg> \
  --template-file main.bicep \
  --parameters environments/<env>.bicepparam \
  --parameters postgresAdminPassword="dummy" --parameters postgresAdminUsername="dummy"

az deployment group what-if \              # 3. the preview (creates/modifies/DELETES)
  --resource-group <rg> \
  --template-file main.bicep \
  --parameters environments/<env>.bicepparam \
  --validation-level Provider              # fall back to ProviderNoRbac on RBAC errors
```

**If it fails locally, fix it locally.** Don't push and let CI discover it. Review the
what-if for **deletes/replacements of stateful resources** (PostgreSQL, Key Vault,
storage). See `azure-deployment-preflight` for stale-deployment cleanup and the full gate.

## Secrets

- No secrets in templates or param files. Reference **Key Vault** from `.bicepparam` via
  `getSecret()` and from app resources as secret references.
- Prefer **managed identities** for resource-to-resource auth over connection strings.

## Hard-won Bicep gotchas (don't rediscover the expensive way)

- **Globally-unique names** (Key Vault, storage, ACR, Redis, Front Door) collide or are
  soft-deleted from prior attempts. Parameterize the name (`param keyVaultName` etc.) and
  override in `*.bicepparam` with a short unique suffix — don't hard-code the bare default.
  If a helper script (Key Vault seeder) defaults the name internally, **pass the override
  explicitly** and ensure every workflow step uses the same resolved name.
- **ACR SKU:** `Basic` may be unavailable on some subscriptions; `Standard` works but
  `retentionPolicy` requires `Premium` — remove it from dev/staging. If a failed deploy
  left a broken ACR, create it manually and let Bicep treat it as no-change.
- **PgBouncer not on Burstable:** Burstable (`Standard_B*`) PostgreSQL can't run PgBouncer
  (needs GeneralPurpose+). Guard with `= if (currentSku.tier != 'Burstable') { ... }`.
- **Alert module location:** `metricAlerts` → `location: 'global'`; `scheduledQueryRules`
  → real region (NOT `global`), and they must scope to the **Log Analytics workspace ID**,
  not the App Insights ID (the `AppRequests` table lives in the workspace).
- **KQL in verbatim strings doesn't interpolate:** `${vars}` inside `'''...'''` are NOT
  substituted — build the query with string-concatenation variables.
- **Metric names:** PostgreSQL Flexible Server uses `active_connections`, not
  `connection_percent` (that's Azure SQL).

## Drift & troubleshooting

- ARM tracks deployments by name; a **failed sub-deployment blocks re-deploy**
  (`DeploymentActive`) even while `Failed` — clean it up (see preflight Step 4).
- Bicep/ARM is declarative-incremental by default (Complete mode deletes anything not in
  the template — use with care). What-if before every deploy surfaces out-of-band drift.
- No click-ops in production; manual changes create snowflakes that the next deploy fights.
