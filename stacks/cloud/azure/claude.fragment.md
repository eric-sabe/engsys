## Cloud stack

- **Active cloud: Azure.** Architecture and IaC target Azure; agents load the
  `cloud-architecture-azure` and `azure-deployment-preflight` skill packs.
- **Tool preference order** (when investigating or validating cloud state):
  1. **Azure CLI, read-only** — `az account show`, `az resource list`,
     `az deployment group list`, `az monitor`, `az keyvault list`,
     `az postgres flexible-server show` and similar inspection commands. Never mutate
     state to answer a question.
  2. **Docs source** — the `microsoft-docs` skill (Microsoft Learn MCP:
     `microsoft_docs_search` / `microsoft_docs_fetch`) for service limits, SKU/tier
     behavior, and API details. Verify quotas/SKUs against docs rather than from memory.
- Mutating actions (deploy/provision/delete) go through Bicep + the
  `azure-deployment-preflight` gate, never ad-hoc CLI writes.

<!-- naturalize: confirm the subscription, region(s), resource-group naming, and the
path to the architecture/cost docs Melvin and Aaron should read for concrete topology. -->
