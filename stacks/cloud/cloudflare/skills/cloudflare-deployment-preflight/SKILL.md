---
name: cloudflare-deployment-preflight
description: Preflight validation for Cloudflare Workers/Pages deployments via Wrangler. Run before any wrangler deploy. Dry-run builds (wrangler deploy --dry-run), gradual rollout via versions upload + deployments, secrets via wrangler secret, D1 migrations (wrangler d1 migrations), account/auth check (wrangler whoami), bindings correctness in wrangler.toml (vars/KV/R2/D1/Durable Objects/Queues), and wrangler tail for logs. Activate when the active cloud is Cloudflare and the user mentions deploying a Worker/Pages, validating wrangler config, gradual rollout, secrets, D1 migrations, bindings, or preparing for wrangler deploy.
---

# Cloudflare Deployment Preflight

The Cloudflare analogue of pre-deploy validation: build and validate locally, confirm the
target account and bindings, and stage the rollout *before* you push live, so users don't
discover what you could have caught. Works for Workers and Pages (both run on Wrangler).
Continue through all steps even if one fails — capture every issue, then fix them in a
batch.

> Discipline: **batch your fixes.** A Worker `deploy` is global within seconds — there's no
> per-region canary by default. Read the whole config, reason about every issue, fix them
> all, then deploy once behind a gradual rollout. One staged rollout, not one deploy per
> error.

## When to use

- Before `wrangler deploy` / `wrangler versions upload` / `wrangler pages deploy`.
- When preparing or reviewing `wrangler.toml` (bindings, vars, compatibility settings).
- To preview what a deploy will produce (`--dry-run`).
- Before running D1 migrations against a production database.
- When a deploy "worked locally" but the live Worker errors on a missing binding/secret.

## Step 1 — Confirm the target account & auth

Deploying to the wrong account is the most expensive mistake. Wrangler picks up auth from
`wrangler login` (OAuth) or a `CLOUDFLARE_API_TOKEN` env var, and the account from
`account_id` in `wrangler.toml` or `CLOUDFLARE_ACCOUNT_ID`.

```bash
wrangler whoami            # who am I, and which account(s) can I deploy to?
```

Confirm the printed account matches the intended one and that the token has the needed
scopes (Workers Scripts, D1, R2, KV, etc.). If `whoami` shows multiple accounts, pin
`account_id` in `wrangler.toml` so a deploy can't silently land in the wrong account.

## Step 2 — Dry-run the build

`--dry-run` runs the full bundle + binding resolution **without uploading anything** — it
catches build errors, missing modules, oversized bundles, and (with `--outdir`) lets you
inspect the output.

```bash
# Build + validate, upload NOTHING. The core preflight.
wrangler deploy --dry-run --outdir dist/

# Pages equivalent: build locally and inspect, no deploy
wrangler pages functions build        # builds Functions to inspect
```

This is the equivalent of `cdk synth` / `bicep build` / `terraform plan`'s build half —
it will **not** catch a binding that exists in config but not in the account (a KV
namespace / D1 / R2 bucket that was never created), or a missing secret. Those are Steps
3–4. Watch the reported **bundle size** against the plan limit (3MB Free / 10MB paid).

## Step 3 — Validate bindings in wrangler.toml

The #1 cause of "works in dev, 1101/exception in prod" is a binding that's declared but the
underlying resource doesn't exist, or an ID mismatch. Cross-check every binding in
`wrangler.toml` against what actually exists in the account:

| Binding | wrangler.toml | Verify the resource exists |
| --- | --- | --- |
| **Vars** (plaintext) | `[vars]` | non-secret config only — never put secrets here |
| **KV** | `[[kv_namespaces]]` `id` | `wrangler kv namespace list` |
| **R2** | `[[r2_buckets]]` `bucket_name` | `wrangler r2 bucket list` |
| **D1** | `[[d1_databases]]` `database_id` | `wrangler d1 list` / `wrangler d1 info <db>` |
| **Durable Objects** | `[[durable_objects.bindings]]` + `[[migrations]]` | DO classes need a migration tag (see Step 5) |
| **Queues** | `[[queues.producers]]` / `[[queues.consumers]]` | `wrangler queues list` |
| **Service bindings** | `[[services]]` | the target Worker must be deployed |

```bash
wrangler kv namespace list        # IDs must match [[kv_namespaces]].id
wrangler r2 bucket list           # names must match [[r2_buckets]].bucket_name
wrangler d1 list                  # D1 databases + their IDs
wrangler d1 info <db-name>        # size, region, details for one D1
wrangler queues list              # queues must exist before a consumer deploys
```

A mismatched `id`/`name`, or a `binding` name the code references that isn't in the toml,
is a runtime exception, not a build error — `--dry-run` won't catch it. Confirm the
`compatibility_date` and any `compatibility_flags` (e.g. `nodejs_compat`) are set, since a
stale compat date can change runtime behavior.

## Step 4 — Secrets (never in wrangler.toml)

Secrets are set out-of-band and are **not** in `wrangler.toml` (only non-secret `[vars]`
go there). A Worker that reads `env.MY_SECRET` will get `undefined` and throw if the secret
was never uploaded to that environment.

```bash
wrangler secret list                      # which secrets exist for this Worker/env
wrangler secret put MY_SECRET             # set (prompts for value) — MUTATING, gated
wrangler secret put MY_SECRET --env prod  # per-environment
```

Preflight: `wrangler secret list` and confirm every secret the code reads is present for
the target environment. Setting secrets (`secret put`) is a mutating action — do it
deliberately, per environment, not as part of casual inspection.

## Step 5 — D1 migrations

D1 schema changes go through Wrangler's migration system. Apply to **local first, then a
remote staging DB, then production** — never run an unreviewed migration straight at prod.

```bash
wrangler d1 migrations create <db> <name>   # scaffold a new migration file
wrangler d1 migrations list <db>            # which migrations are applied vs pending
wrangler d1 migrations list <db> --remote   # against the real remote DB
wrangler d1 migrations apply <db> --local   # apply locally first
wrangler d1 migrations apply <db> --remote  # apply to remote — MUTATING, gated
```

> `migrations list` is read-only (safe preflight — see exactly what's pending). `apply`
> and any `d1 execute` are mutating and gated. Remember D1 is **SQLite** with a **10GB
> ceiling** and primary-region writes — a migration that rewrites a large table can be slow
> and bills `rows_written`. Review the SQL; back up / export if it's destructive.

## Step 6 — Stage the rollout (versions + gradual deployment)

`wrangler deploy` publishes **globally within seconds** with no built-in canary. For
anything risky, use the **versions** workflow to upload a version without serving it, then
ramp traffic gradually and roll back instantly if metrics turn.

```bash
# Upload a new version WITHOUT routing any traffic to it
wrangler versions upload

wrangler versions list                  # see versions + which is serving
wrangler versions view <version-id>     # inspect one

# Roll out gradually: split traffic across versions (e.g. 10% new / 90% old)
wrangler versions deploy                # interactive percentage split

# Watch the new version under real traffic, then ramp to 100% — or roll back
# by deploying 100% of the previous version.
```

This is the Cloudflare answer to a canary / change set: ship the version, point a slice of
production at it, watch `wrangler tail` + analytics, then complete or revert. Far safer
than a bare `wrangler deploy` for a change touching a hot path.

## Step 7 — Verify after rollout (tail the logs)

Once a version is taking traffic, watch live requests for new exceptions before ramping to
100%:

```bash
wrangler tail                                   # live request log stream
wrangler tail --status error                    # only errored invocations
wrangler tail --format json | jq '.exceptions'  # structured, filter exceptions
```

Look for `Exceeded CPU`/`Exceeded Memory` (1102), subrequest-limit errors, missing-binding
exceptions, and elevated 5xx/exception rate on the new version. If clean, complete the
rollout; if not, roll back to the prior version immediately.

## Step 8 — Report

Summarize: account confirmed (`whoami`), dry-run build result + bundle size vs limit,
binding/resource cross-check (every KV/R2/D1/DO/Queue binding resolved to a real resource),
secrets present for the target env, D1 migrations pending/applied, and the rollout plan
(version id, traffic split, rollback path). Flag any **destructive D1 migration**, any
**missing binding or secret**, and any **bundle over the plan limit**. State clearly whether
it's safe to deploy and at what initial traffic percentage.

## Tool requirements

`wrangler` CLI (v3+), authenticated via `wrangler login` or `CLOUDFLARE_API_TOKEN`. Verify
auth + account first: `wrangler whoami`. `jq` optional for parsing `wrangler tail --format
json`.
