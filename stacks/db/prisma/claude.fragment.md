<!-- pack: db/prisma -->
## Database — Prisma & Shared Database Package

Prisma schema + generated client, shared across backend services as a workspace package:
- **Isabelle**, **Melvin**, and **Bert** load **`prisma-conventions`** when modifying `schema.prisma`, writing migrations, or adding multi-tenant / JSONB indexed models.
- **Isabelle** and **Aaron** load **`docker-database-package-copy`** whenever adding or renaming exported TypeScript modules in the shared database package so container `Dockerfile` `COPY` lists stay in sync.
- **Never** run `prisma migrate deploy` or `prisma migrate reset` against shared environments (`dev`/`staging`/`prod`) from a workstation or agent session — CI only. Use the repository's localhost-only migration command before running local integration or E2E suites.

<!-- naturalize: record the database-package path (e.g. packages/database), package name, localhost migration script, and DB engine in Project facts. -->
