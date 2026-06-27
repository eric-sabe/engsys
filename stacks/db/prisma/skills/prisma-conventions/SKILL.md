---
name: prisma-conventions
description: Prisma ORM conventions for this repo — schema/migration discipline, constraints Prisma can't express, and the @@map/@map gotcha that bites $queryRaw. Activate when writing or reviewing Prisma schema (schema.prisma), migrations, generated-client usage, or raw SQL through Prisma ($queryRaw/$executeRaw), or when debugging P2002 unique-constraint errors or "relation does not exist" at runtime.
---

# Prisma Conventions

Applies to any code touching Prisma in this repo — `schema.prisma`, migrations under
`prisma/migrations/`, the generated client, and raw SQL via `$queryRaw`/`$executeRaw`.

> Naturalize: confirm the schema path, datasource provider, and the database-package
> location in `CLAUDE.md`.

## Hard-won lessons

### Prisma can't express partial / conditional unique constraints
**Symptom:** You need uniqueness only under a condition (e.g. unique email *among
non-deleted rows*, or unique slug *per tenant where active*), but `@@unique` applies
unconditionally and rejects legitimate rows.
**Cause:** Prisma's schema DSL has no syntax for partial/filtered unique indexes —
`@@unique` maps to a plain `UNIQUE` constraint with no `WHERE`.
**Fix:** Hand-write the index in a migration —
`CREATE UNIQUE INDEX … ON … (…) WHERE …;` — and keep it out of the schema's
`@@unique`. Because Prisma doesn't model it, catch the violation in the service layer
by handling the **P2002** error code rather than relying on schema-level validation.

### `$queryRaw` uses DB names (@@map/@map), not Prisma model names
**Symptom:** Mocked/unit tests pass, but against a real database `$queryRaw` /
`$executeRaw` throws `relation "User" does not exist` (or a missing-column error).
**Cause:** Raw SQL **bypasses the ORM** and goes straight to Postgres. Prisma model
and field names are a client-side abstraction; the actual table/column names are the
`@@map`/`@map` values from the schema (e.g. model `User` → table `users`). Mocks
don't hit the DB, so they never reveal the mismatch.
**Fix:** In any raw SQL, reference the **mapped** table and column names (the
`@@map`/`@map` values), never the Prisma model/field names. Grep the schema for the
relevant `@@map`/`@map` before writing the query, and prefer an integration test that
hits a real database for any raw-SQL path.
