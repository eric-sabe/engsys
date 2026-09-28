# Prisma: uniqueness lives outside the schema, and upsert only arbitrates one index

**Stack:** prisma (PostgreSQL). Skip if the project does not use Prisma.

**Trigger:** You are designing an upsert, dedupe, or idempotency fix and you decide what constraints exist by reading `schema.prisma`; or `prisma.<model>.upsert` throws an intermittent `P2002` under concurrency from a call site that "can't fail", with `meta.target` naming an index that is not the one in `where`.

**Failure mode:**
- The schema DSL cannot express partial or functional unique indexes (`CREATE UNIQUE INDEX ... WHERE ...`, `lower(email)`); they exist only in raw migration SQL. Concluding "there is no unique constraint on (a, b)" from the schema alone leads to a redundant, possibly destructive `@@unique` migration, or to an upsert that cannot target a partial index at all.
- Prisma's native upsert compiles to `INSERT ... ON CONFLICT (<index in where>)`. Postgres arbitrates conflicts only on that index; every other unique index is checked as an ordinary constraint, so the loser of a concurrent identical insert can hit another one first and get a plain `P2002` (timing-dependent, so it flakes). Hardening a different catch than the one the stack trace shows never fixes it.
- A `P2002` handler that returns the existing row as a "replay" can silently discard the retry's intent when the retried payload differs from what is stored.

**Correct behavior:**
- Before designing around uniqueness, grep migrations for `UNIQUE INDEX` and `WHERE`; treat a model comment saying "migration SQL enforces..." as a signal of invisible constraints.
- For idempotency against a partial index use catch-`P2002` plus re-lookup, find-then-create, or raw `ON CONFLICT (...) WHERE ...`; not `upsert`.
- On `P2002` treat it as "another writer created this row": re-run the preceding lookup once and continue with the winner. Before returning it as an idempotent replay, diff the caller-controlled fields; if they differ, raise a conflict.
- Catch only the race-signal codes (`P2002`, and `P2034` inside serializable transactions). Do not widen to every known request error: FK violations and pool timeouts are not races and must not become a 409.
- Reproduce first: loop the concurrent case 20-50 times and print `code`, `meta.target`, and the top stack frame of every rejection. In unit tests construct real `Prisma.PrismaClientKnownRequestError` instances (the module mock must re-export the namespace or `instanceof` throws).
- Prove a flake is gone by looping the spec locally and recording the tally; one green CI run proves nothing.

**Check:** Which index did the failing insert hit, and does the handler distinguish an identical replay from a conflicting one?

**Seen in:** recurring in multi-tenant services with soft-delete and partial unique indexes.
