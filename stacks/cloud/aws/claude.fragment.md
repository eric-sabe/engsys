## Cloud stack

- **Active cloud: AWS.** Architecture and IaC target AWS; agents load the
  `cloud-architecture-aws` and `aws-deployment-preflight` skill packs.
- **Tool preference order** (when investigating or validating cloud state):
  1. **AWS CLI, read-only** — `aws sts get-caller-identity`, `aws s3 ls`,
     `aws cloudformation describe-stacks/list-stacks`, `aws logs`, `aws kms`,
     `aws service-quotas` and similar inspection commands. Never mutate state to
     answer a question.
  2. **Docs source** — official AWS documentation (docs.aws.amazon.com) for service
     limits, pricing, and API behavior. Verify quotas/pricing against docs rather
     than from memory.
- Mutating actions (deploy/destroy/create/delete) go through the IaC tool and the
  `aws-deployment-preflight` gate, never ad-hoc CLI writes.

<!-- naturalize: confirm the AWS region(s), account boundary, and the path to the
architecture/cost docs Melvin and Aaron should read for concrete topology. -->
