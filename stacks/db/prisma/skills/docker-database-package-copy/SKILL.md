---
name: docker-database-package-copy
description: When adding or changing TypeScript under a shared workspace database package that its entrypoint re-exports, update every consumer service Dockerfile's COPY list or the container build fails with TS2307. Use for shared database-package modules, Dockerfile edits, or "works locally but the container build breaks".
---

# Docker COPY Discipline for Shared Workspace Packages

Applies to monorepos where a shared Prisma/database package (e.g., `packages/database`) is consumed by multiple containerized services, and each service `Dockerfile` copies **specific** source files rather than the entire workspace tree.

> Naturalize: replace `packages/database` and `apps/` with this repository's shared database-package path and service directory in `CLAUDE.md`.

## Trigger

- A new or renamed `.ts` source file under the shared database package is reachable from its barrel entrypoint.
- A PR modifies the database package's exports **and** a service `Dockerfile`.

## Procedure

1. Find every `Dockerfile` that copies files from the shared database package:
   ```bash
   rg 'COPY packages/database/' apps -g Dockerfile
   ```
2. For each **new** exported source file, add a matching `COPY` instruction to every consumer `Dockerfile`:
   ```dockerfile
   COPY packages/database/<filename>.ts ./packages/database/
   ```
3. Smoke-build at least one consumer container image before pushing:
   ```bash
   docker build -f apps/<service>/Dockerfile -t db-copy-probe .
   ```

## Why

A local workspace build (`pnpm build`) resolves the full checkout on disk, whereas Docker build stages only see explicitly `COPY`'d files. A missing `COPY` line passes local typechecking and fails in CI container builds with `TS2307: Cannot find module`.
