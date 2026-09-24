---
name: microsoft-docs
description: Query official Microsoft documentation (Azure service limits, SKU/tier behavior, CLI/API reference, Bicep resource schemas, .NET, Entra, Microsoft Graph) via the Microsoft Learn MCP server, with Context7 for Microsoft-ecosystem docs that live outside learn.microsoft.com (VS Code, GitHub, Aspire). Use whenever an Azure answer depends on a quota, SKU capability, API version, or property name — verify against docs instead of answering from memory.
---

# Microsoft Docs

Research skill for the Microsoft/Azure ecosystem. Backed by the `microsoft-docs` MCP
server (Microsoft Learn, `https://learn.microsoft.com/api/mcp`, no auth) that the
`cloud/azure` pack wires into `.mcp.json`.

## Default: Microsoft Learn MCP

Use for **everything on learn.microsoft.com** — Azure services, Bicep/ARM resource
reference, `az` CLI reference, Entra ID, .NET, Microsoft Graph, M365.

| Tool | Purpose |
| --- | --- |
| `microsoft_docs_search` | Search Learn — concepts, limits, how-tos, configuration |
| `microsoft_code_sample_search` | Working code snippets from Learn; pass `language` (`bicep`, `typescript`, `python`, `csharp`, …) |
| `microsoft_docs_fetch` | Full page content for a URL, when search excerpts are truncated or you need every option |

Search first, then `microsoft_docs_fetch` the most relevant hit when you need the
complete table (SKU matrix, quota list, full property schema).

## Outside learn.microsoft.com — use Context7

Resolve the library ID once per session (`resolve-library-id`), then query it.

| Docs | Lives on | Context7 library (typical) |
| --- | --- | --- |
| VS Code (user docs / extension API) | code.visualstudio.com | `/websites/code_visualstudio`, `/websites/code_visualstudio_api` |
| GitHub (Actions, API, `gh` CLI) | docs.github.com, cli.github.com | `/websites/github_en`, `/websites/cli_github` |
| .NET Aspire | aspire.dev | `/microsoft/aspire.dev` (or the Aspire MCP's own docs tools on CLI 13.2+) |

If neither MCP is available, fall back to web search restricted to the official domain.

## Writing effective queries

Be specific — include service, version, intent, and language:

- Too broad: `"Container Apps"`, `"Key Vault"`.
- Specific: `"Azure Container Apps revision scaling rules KEDA HTTP"`,
  `"PostgreSQL flexible server Burstable tier PgBouncer support"`,
  `"Bicep Microsoft.Insights/scheduledQueryRules location property"`.

Add the **intent** (`limits`, `quickstart`, `API reference`, `pricing tier comparison`)
and the **language** for polyglot docs.

## When to reach for it

- Before asserting a quota, SKU capability, or regional availability (the
  `azure-deployment-preflight` and `cloud-architecture-azure` skills defer here).
- When a Bicep `validate` / `what-if` error names a property or API version you don't
  recognize.
- When choosing between services or tiers — cite the doc URL in the ADR / plan.
