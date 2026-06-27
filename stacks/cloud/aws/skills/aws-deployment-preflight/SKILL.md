---
name: aws-deployment-preflight
description: Preflight validation for AWS infrastructure deployments (CloudFormation/CDK). Run before any cdk deploy / aws cloudformation deploy. Validates templates (cdk synth, cdk diff, CloudFormation validate-template / lint), cleans up stale or failed stacks that block re-deploy, catches globally-unique naming conflicts (S3/ECR/etc.), and checks service quota / capacity limits. Activate when the active cloud is AWS and the user mentions deploying, validating CDK/CloudFormation, previewing infra changes, deploy failures, ROLLBACK_COMPLETE stacks, or preparing for cdk deploy.
---

# AWS Deployment Preflight

The AWS analogue of pre-deploy validation: validate locally and clean up state
*before* you deploy, so CI doesn't discover what you could have caught. Works for
both AWS CDK projects and raw CloudFormation. Continue through all steps even if one
fails — capture every issue, then fix them in a batch.

> Discipline: **batch your fixes.** Each deploy/CI run costs real minutes. Read the
> whole failing stack, reason about every issue, fix them all, push once. One run per
> problem cluster, not one per error message.

## When to use

- Before `cdk deploy`, `cdk destroy`, `aws cloudformation deploy/create-stack`.
- When preparing or reviewing CDK / CloudFormation templates.
- To preview what a deploy will change.
- After a failed deploy left a stack stuck (`ROLLBACK_COMPLETE`, `*_FAILED`).
- Before an "it worked yesterday" infra mystery becomes a CI run.

## Step 1 — Detect project type

- **CDK project:** `cdk.json` at root; stacks in `bin/` + `lib/` (TS) or app entry
  (Python). Identify the app and stack names: `cdk list`.
- **Raw CloudFormation:** `.yaml`/`.json` templates (`AWSTemplateFormatVersion`,
  `Resources:`), often under `infra/`, `cloudformation/`, `templates/`.
- Confirm the target account/region: `aws sts get-caller-identity` and
  `aws configure get region` (or `$AWS_REGION`). Deploying to the wrong account is the
  most expensive mistake of all.

## Step 2 — Validate the template

### CDK

```bash
# Synthesize — fails on construct/TypeScript/context errors before any AWS call
cdk synth

# Diff against the deployed stack — the what-if. Shows resource + IAM changes.
cdk diff
```

`cdk synth` emits CloudFormation under `cdk.out/`. `cdk diff` flags **IAM/security
changes** (the `--require-approval` gate) — review those deliberately, never rubber-stamp.

### CloudFormation (raw)

```bash
# Server-side structural validation
aws cloudformation validate-template --template-body file://template.yaml

# Deeper linting — catches resource-property errors validate-template misses
cfn-lint template.yaml            # pip install cfn-lint

# Preview changes without applying: change sets
aws cloudformation deploy --template-file template.yaml --stack-name <name> \
  --no-execute-changeset           # creates a change set you can inspect
aws cloudformation describe-change-set --change-set-name <arn>
```

> `validate-template` only checks structure/syntax — like `bicep build` or
> `terraform validate`, it will **not** catch invalid property combinations, quota
> issues, or naming collisions. `cfn-lint` + `cdk diff` / a change set are the real gate.

## Step 3 — Clean up stale / failed stacks

A failed `create-stack` leaves the stack in **`ROLLBACK_COMPLETE`** — it cannot be
updated, only deleted and recreated. `UPDATE_ROLLBACK_FAILED` needs
`continue-update-rollback`. Find and clear blockers before re-deploying:

```bash
# Stacks stuck in a state that blocks a clean deploy
aws cloudformation list-stacks \
  --stack-status-filter ROLLBACK_COMPLETE CREATE_FAILED DELETE_FAILED \
  --query "StackSummaries[].{Name:StackName,Status:StackStatus}" --output table

# Inspect why one failed (read the FIRST failure event, not the cascade)
aws cloudformation describe-stack-events --stack-name <name> \
  --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" \
  --output table

# A ROLLBACK_COMPLETE stack must be deleted before recreating
aws cloudformation delete-stack --stack-name <name>
```

CDK: `cdk destroy <stack>` for the same effect. Watch for **resources that block
deletion** — non-empty S3 buckets, ECR repos with images, retained `RemovalPolicy`
resources, security groups with dependencies. Empty/detach them first.

## Step 4 — Globally-unique naming conflicts

Several AWS resource names live in a **global or account-region namespace** and collide
or are reserved/soft-deleted from prior attempts. The AWS analogue of Azure's Key
Vault / ACR name clashes — parameterize the name and override on conflict:

| Resource | Namespace | Conflict mode |
| --- | --- | --- |
| **S3 bucket** | Global (all accounts) | `BucketAlreadyExists` / `...OwnedByYou`. Names are not reusable immediately after delete. |
| **ECR repository** | Per account+region | `RepositoryAlreadyExistsException` |
| CloudFront / OAI, ACM cert | Global / regional | reuse vs recreate |
| IAM role/policy names | Per account (global) | `EntityAlreadyExists` if a prior stack left it |
| DynamoDB table, SQS/SNS, Log groups | Per account+region | recreate collisions after partial deploys |

**Pattern:** never hard-code a globally-unique name. Let CDK auto-name (it appends a
hash) or add a short unique suffix (account id fragment / random) via a CloudFormation
parameter, and override it when a name is taken. Prefer `aws s3api head-bucket` /
`aws ecr describe-repositories` to check availability before deploy.

## Step 5 — Service quota & capacity check

Deploys fail late when a quota is hit. Pre-check the limits the stack will consume:

```bash
# What's the current limit + usage for a service
aws service-quotas list-service-quotas --service-code lambda --output table
aws service-quotas get-service-quota --service-code vpc --quota-code <code>
```

Common deploy-blocking quotas: VPCs / EIPs / NAT Gateways per region, Elastic IP count,
Lambda concurrent executions, ECS/Fargate task limits, RDS instances, **CloudFormation
500-resource-per-stack limit** (split large stacks), IAM roles per account. Soft quotas
need a Service Quotas / support request with lead time — raise them *before* the deploy,
not during the incident.

## Step 6 — Check for an in-flight deploy before triggering

If CI auto-deploys on push, don't fire a manual deploy on top of it — the runs race.

```bash
gh run list --workflow="<deploy workflow>" --limit 3
aws cloudformation describe-stacks --stack-name <name> \
  --query "Stacks[0].StackStatus"     # *_IN_PROGRESS means a deploy is running
```

If a stack is `*_IN_PROGRESS`, wait — concurrent operations on one stack are rejected.

## Step 7 — Report

Summarize: validation results (synth/diff/lint), stacks cleaned up, naming overrides
applied, quota headroom, and the change set / `cdk diff` summary (creates / modifies /
**deletes** / replacements — flag any replacement of a stateful resource, and any IAM
change). State clearly whether it's safe to deploy.

## Tool requirements

`aws` CLI v2, `cdk` (for CDK projects), `cfn-lint` (recommended), `gh` (if CI-driven).
Verify auth first: `aws sts get-caller-identity`.

## Hard-won lessons

### CloudFormation cross-stack export deadlock on re-pointing a reference
**Symptom:** Moving a resource (e.g. ALB public→private) drops a consumer stack's
reference to a producer stack's export; the deploy rolls back with `Cannot delete
export … as it is in use by <consumer-stack>`.
**Cause:** The deadlock isn't about the *new* template — it's about the **delta**
versus the **live** stack. Removing a consumer's reference makes CFN prune the
producer's export while the old consumer is still deployed and using it.
**Fix:** Treat any change that drops a cross-stack reference as a **two-phase** op:
either retain the export across the transition (`stack.exportValue()`), or remove
the live consumer before re-pointing it. Apply the two-phase pattern by default once
you've hit this — don't reason your way out of the precaution.
