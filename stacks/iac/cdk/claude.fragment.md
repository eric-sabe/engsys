## IaC stack

- **Active IaC tool: AWS CDK.** Infrastructure changes go through CDK (synthesizes
  CloudFormation); Aaron loads the `iac-cdk` skill pack.
- **Workflow gate:** `cdk synth` → `cdk diff` (review resource + IAM changes) →
  `cdk deploy`. Never deploy without reading the diff; review security/replacement
  deltas deliberately.
- Run the `aws-deployment-preflight` skill before deploying for stale-stack cleanup
  (`ROLLBACK_COMPLETE`), globally-unique naming (S3/ECR), and quota checks.
- Read-only CLI (`cdk synth`, `cdk diff`, `cdk list`) is allowed; `cdk deploy` /
  `cdk destroy` are gated.
- **IaC-first.** Infra changes land in code and deploy through CI. Console/CLI mutations
  are debug/emergency only — after one, record resource + property old→new, mirror it in
  code, and commit `fix(iac): sync manual hotfix for #<issue>`. No "unblock now, fix IaC
  later": time-box any unavoidable shortcut with a tracked removal issue. Red flags:
  chained CLI updates, env vars or firewall/secret changes set only via CLI.

<!-- naturalize: confirm the CDK app entry (bin/), stack separation, target account +
region, and whether the account is bootstrapped. -->
