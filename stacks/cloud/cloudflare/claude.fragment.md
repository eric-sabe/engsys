## Cloud stack

- **Active cloud: Cloudflare.** Architecture and deploys target Cloudflare's edge
  (Workers/Pages + R2/D1/KV/Durable Objects/Queues); agents load the
  `cloud-architecture-cloudflare` and `cloudflare-deployment-preflight` skill packs.
- **Tool preference order** (when investigating or validating cloud state):
  1. **Wrangler CLI, read-only** — `wrangler whoami`, `wrangler deploy --dry-run`,
     `wrangler d1 list` / `wrangler d1 info`, `wrangler kv namespace list`,
     `wrangler r2 bucket list`, `wrangler queues list`, `wrangler versions list`,
     `wrangler secret list`, `wrangler tail` and similar inspection commands. Never
     mutate state to answer a question.
  2. **Docs source** — official Cloudflare documentation (developers.cloudflare.com) for
     service limits, plan tiers, pricing, and binding/API behavior. Limits are plan-tier
     dependent and change — verify against docs rather than from memory.
- Mutating actions (`wrangler deploy`, `secret put`, `d1 execute`, `d1 migrations apply`,
  `r2 object delete`, `delete`) go through the `cloudflare-deployment-preflight` gate and
  a staged `versions upload` + gradual rollout, never an ad-hoc bare deploy.

<!-- naturalize: confirm the Cloudflare account, the plan tier (Free/Paid/Enterprise —
limits depend on it), the state primitives in use (KV/D1/DO/R2), and the path to the
architecture/cost docs Melvin and Aaron should read for concrete topology. -->
