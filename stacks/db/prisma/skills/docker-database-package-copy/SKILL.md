---
name: docker-database-package-copy
description: When adding or changing TypeScript under the shared database package that index.ts re-exports, update every service Dockerfile's COPY list or the container build fails with TS2307. Use for database-package modules, Dockerfile edits, or "works locally but the container build breaks".
---

# Docker COPY list for the shared database package

Applies to monorepos where a shared Prisma/database package is consumed by multiple containerized services, and each service Dockerfile copies **specific** source files (not the whole tree).

> Naturalize: replace `services/database` with this repo's database-package path and the package name in `CLAUDE.md`.

## Trigger

- New or renamed source file under the database package **reachable from** its `index.ts`.
- A PR touches the database package's `index.ts` **and** a service `Dockerfile`.

## Do this

1. Find every Dockerfile that copies database sources:
   ```bash
   rg 'COPY services/database/' services -g Dockerfile
   ```
2. For each **new** source file the package needs, add **once per Dockerfile** that copies database sources:

   ```dockerfile
   COPY services/database/<filename>.ts ./services/database/
   ```

   Keep the block with the other `services/database/*.ts` COPY lines.

3. Prefer a quick smoke build before pushing:
   ```bash
   docker build -f services/<any-service>/Dockerfile -t probe .
   ```

## Why

Container images only contain explicitly copied files. A local `pnpm build` uses the full repo tree; **Docker does not**. A missing COPY line surfaces as `TS2307: Cannot find module '.../services/database/<file>'` in CI even though the local build passes.

**Doesn't apply to:** Prisma-only files, CLI-only scripts, anything under the database package that isn't re-exported via `index.ts`.

## Canonical doc

The pack's `claude.fragment.md` (and the rendered `CLAUDE.md`) carries the rest of the Prisma + Docker workflow. If the repo mirrors rules into a Cursor ruleset, keep them in sync.
