---
name: iac-cdk
description: AWS CDK discipline for any project where CDK is the active IaC tool — app/stack structure, constructs (L1/L2/L3), synth/diff/deploy flow, stack separation, context and environment config, asset bundling, and bootstrapping. Activate when working on CDK code (bin/ + lib/ TypeScript or app.py), cdk synth/diff/deploy, construct design, or diagnosing CDK/CloudFormation deploy failures.
---

# AWS CDK Discipline

The operational discipline for AWS CDK as the active IaC tool. CDK synthesizes
CloudFormation, so it inherits CloudFormation's behavior. Pairs with the
`cloud-architecture-aws` pack (service-level detail) and the `aws-deployment-preflight`
skill (the pre-deploy gate). Project file layout and account/region facts come from
`CLAUDE.md`.

## Core stance

- **Infrastructure is software** — and CDK makes that literal: it's real TypeScript/
  Python. Apply the same discipline (types, tests, no copy-paste, narrow interfaces) you'd
  apply to app code. Resist the temptation to be "clever" in synth-time logic.
- **CDK is a CloudFormation generator.** What deploys is the synthesized template. When in
  doubt, read `cdk synth` output — the abstraction is convenient, not magic.
- **`cdk diff` is the contract.** Never `deploy` without reading the diff. It shows
  resource changes *and* IAM/security changes (the `--require-approval` gate) — review
  security deltas deliberately, never rubber-stamp.

## App & stack structure

```
bin/<app>.ts        # the App: instantiates stacks, sets env (account/region)
lib/
  <x>-stack.ts       # one stack per deployment unit / lifecycle boundary
  constructs/        # reusable L3 constructs (your own abstractions)
cdk.json             # app entry + context
```

- **Separate stacks by lifecycle and blast radius** — e.g. network / data / compute /
  edge / security. A stateful stack (databases, buckets) should be independently
  deployable from churny app stacks so a compute redeploy can't threaten data.
- Stacks have a **500-resource CloudFormation limit** — split before you hit it. Nested
  stacks help but complicate diffs; prefer multiple top-level stacks with cross-stack
  references via `Stack` props (passing constructs) over brittle string exports/imports.
- **Set `env` explicitly** (account + region) on stacks — environment-agnostic stacks
  silently use ambient credentials and can deploy to the wrong account.

## Constructs (L1 / L2 / L3)

- **L1 (`Cfn*`)** — raw CloudFormation, 1:1 with resources. Escape hatch for properties
  L2 doesn't expose yet (`addPropertyOverride`). Verbose, no defaults.
- **L2** — curated constructs with sane defaults, IAM grants (`grantRead`, etc.), and
  helper methods. **The default choice** — prefer them; they encode best practice.
- **L3 (patterns / your own)** — opinionated multi-resource compositions. Write your own
  for genuinely-repeated patterns; don't over-abstract a one-off.
- Use the **`grant*` methods** for IAM rather than hand-writing policies — least-privilege
  by construction, and they wire the right principal.

## The synth → diff → deploy flow

```bash
cdk synth                 # generate the template; fails on construct/TS errors first
cdk diff                  # the what-if: resource + IAM changes vs the deployed stack
cdk deploy <stack>        # apply (CI: behind approval for prod)
```

- **Bootstrap once per account+region:** `cdk bootstrap` creates the CDKToolkit stack
  (asset bucket, ECR repo, deploy roles). A missing bootstrap is a common first-deploy
  failure.
- **Review the diff for replacements** — a property change that forces a replacement on a
  stateful resource (RDS, DynamoDB, S3) is a data-loss event. Use `RemovalPolicy.RETAIN`
  on precious resources; know that RETAIN-ed resources then block stack deletion until
  cleared manually (see preflight).
- Deploy stacks in dependency order (CDK handles this within one `deploy '*'`, but explicit
  ordering in CI is clearer).

## Context & configuration

- **`cdk.json` context** + `cdk.context.json` (cached lookups like AZs, AMIs, VPCs).
  Cached context can go stale — `cdk context --clear` to refresh. Commit `cdk.context.json`
  so synth is deterministic across machines/CI.
- Pass per-environment config via **stack props / construct parameters**, not via
  scattered `tryGetContext` reads. Keep env selection explicit (e.g. `-c env=prod` →
  typed config object), not implicit.
- Pin the CDK library + construct-library versions; CDK moves fast and minor versions
  change synthesized output.

## Assets & bundling

- Lambda/container assets are bundled and uploaded to the bootstrap bucket/ECR on deploy.
  Keep bundles small (esbuild for Node, layers/`--platform` for native deps) — bundle size
  drives cold start (see `cloud-architecture-aws`). Docker is required for some bundling
  modes.

## Troubleshooting

- **`ROLLBACK_COMPLETE`** stack can't be updated — delete and recreate (`cdk destroy` then
  deploy). Read the **first** failed CloudFormation event, not the rollback cascade.
- **Drift:** out-of-band console changes diverge from the template; `cdk diff` won't show
  console drift directly — use CloudFormation drift detection. No click-ops in prod.
- **Cross-stack deadlock:** a hard export that another stack imports can't be changed/
  deleted until the consumer stops importing it — refactor cross-stack refs deliberately.

## Preflight

Before deploying, run the `aws-deployment-preflight` skill — it covers
`cdk synth`/`cdk diff` validation, stale/failed-stack cleanup (`ROLLBACK_COMPLETE`),
globally-unique naming (S3/ECR), and service-quota checks that the diff alone won't surface.
