---
name: typescript-conventions
description: TypeScript conventions for this repo (TS 5.x targeting ES2022, Node 22, pnpm workspaces). Use when writing or reviewing any *.ts file. Covers naming, type-system expectations, async/error handling, the pnpm-monorepo @smithy hoisting gotcha, and lib-DOM-for-fetch.
---

# TypeScript Conventions

Applies to: `*.ts` across the repo's TypeScript packages. Target: TS 5.x → ES2022. Runtime: Node 22. Build: esbuild (or the project's bundler). Test: Vitest.

> Naturalize: confirm the exact package paths, bundler, and test runner in `CLAUDE.md`. The defaults below assume a pnpm workspace shipping to a Node 22 runtime.

## Core Intent

- Respect existing architecture; extend abstractions before inventing new ones.
- Readable, explicit solutions over clever ones.
- Pure ES modules — never `require` / `module.exports` / CJS helpers.

## Naming & Style

- kebab-case filenames (`user-session.ts`, `data-service.ts`).
- PascalCase for classes, interfaces, enums, type aliases. camelCase for everything else.
- No `I`-prefix on interfaces.
- Name for behavior/domain meaning, not implementation.

## Type System

- Avoid `any` (implicit or explicit). Prefer `unknown` + narrowing.
- Discriminated unions for state machines and event payloads.
- Centralize shared contracts in a `shared`/`common` package rather than duplicating across packages.
- Use TS utility types (`Readonly`, `Partial`, `Record`, etc.) to express intent.

## Async, Events, Errors

- `async/await` with try/catch and structured errors.
- Guard edge cases early to avoid deep nesting.
- Route errors through the project's logging/telemetry utilities.

## Architecture

- Single-purpose modules.
- Keep transport / domain / presentation layers decoupled.
- Instantiate clients (cloud SDKs, DB clients, etc.) outside hot paths; inject for testability.

## pnpm monorepo: known gotchas

If the repo uses pnpm workspaces, two patterns repeatedly bite:

### `@smithy/*` hoisting for the AWS SDK v3

pnpm's virtual store (`.pnpm/`) is **not** traversed by TypeScript's module resolution. `@smithy/smithy-client` is the base class that provides `Client.send()` on every AWS SDK v3 client. Without hoisting you get:

```
Property 'send' does not exist on type 'SQSClient'
Property 'send' does not exist on type 'SecretsManagerClient'
```

**Fix:** root `.npmrc` must contain:

```
public-hoist-pattern[]=@smithy*
```

Then `pnpm install`. (The same class of fix applies to any SDK that ships a base client via a separate hoisted package.)

### `DOM` lib for fetch / Response / Headers

Any handler that uses `fetch()`, `Response`, or `Headers` needs `"DOM"` in `tsconfig` `lib`:

```json
{ "compilerOptions": { "lib": ["ES2022", "DOM"] } }
```

Without it: `Property 'ok' does not exist on type 'Response'`.

## Testing

- Vitest. Add or update unit tests alongside changes.
- Avoid brittle timing assertions; prefer fake timers or injected clocks.

## Build / verification

- `pnpm typecheck` at the root runs `tsc --noEmit` across packages.
- `pnpm lint`, `pnpm test`, `pnpm build` work per-package via `pnpm -r`.
- `esbuild` bundles for the deploy target; uses the `default` export condition.

## Security

- Validate external input with schema validators or type guards (prefer a `zod`-style schema layer in the shared package).
- Parameterized queries for any persistence; never string-concatenate untrusted input into queries.
- Secrets via the cloud secret store (Secrets Manager / Key Vault / Secret Manager), never env-var-in-code-comment.
- Patch dependencies promptly; pin vulnerable transitives via `pnpm overrides` in root `package.json`.
