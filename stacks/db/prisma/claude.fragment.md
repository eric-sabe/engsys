<!-- pack: db/prisma -->
## Database — Prisma + shared package

Prisma schema + generated client, shared across backend services as a workspace package (e.g. `@org/database`). See the `docker-database-package-copy` skill for the container-build discipline summarized below.

> Naturalize: record the database-package path, package name, and DB engine (Postgres assumed below) in Project facts.

### Migration workflow

**Never** run `prisma migrate deploy` against a shared environment (dev/staging/prod) from a laptop — CI only.

Local loop:

1. Edit `schema.prisma`.
2. `npx prisma generate` (or the repo's `db:generate` script).
3. Write the code that uses the new shape.
4. Push the branch.
5. CI opens a migration PR; review the generated SQL.
6. Merge — auto-deploy follows.

### Schema conventions

- **Naming**: camelCase fields in Prisma, snake_case in the DB via `@map`.
- **IDs**: UUID `@id @default(uuid())`.
- **Soft delete**: `deletedAt DateTime?` on tables that need it; default queries filter out soft-deleted rows.
- **Timestamps**: timezone-aware with explicit precision (Postgres: `@db.Timestamptz(3)`).
- **Tenant scoping**: every multi-tenant table has `tenantId String` + `@@index([tenantId])`, enforced at the API gateway (e.g. a tenant-context interceptor).
- **Migrations must be backward-compatible** — services deploy independently of migrations, so old code must still work with the new schema. Add in one release; drop a release later.
- **JSON-preference columns are single-purpose** — give each per-entity runtime flag its own JSONB column rather than a god-`preferences` blob, so analytics queries hit a focused GIN index and migrations stay narrow. Pair a `?`-queried column with a `USING GIN` index.
- **Key-style flag naming**: keys inside JSON-preference columns follow `{surface}_{action}_v{N}` (e.g. `recs_kpi_confirm_v1`); bump `vN` to re-surface rather than reusing a key. Document the convention in the model-field comment.

### Docker COPY discipline

Each consumer service Dockerfile copies **specific** TypeScript files from the database package, not the whole tree:

```dockerfile
COPY services/database/index.ts ./services/database/
COPY services/database/types.ts ./services/database/
```

When you add a new `.ts` file under the database package **and export it through `index.ts`**, every Dockerfile that builds the package needs a matching `COPY` line. Missing COPY → CI fails with `TS2307` even though the local full-tree build passes. Before pushing a new exported file:

```bash
rg 'COPY services/database/' services/*/Dockerfile   # find all consumers
# add a COPY line to every match, then optionally smoke-build one:
docker build -f services/<service>/Dockerfile -t db-probe .
```

**Pre-push gate:** when the Prisma schema is touched, run `prisma generate && <build>`, then rebuild dependent services.
