# Adapter note — DeepSeek

- You are running in a Claude Code harness pointed at DeepSeek's API. Project
  tools work; `gh` and publishing do not — the package in `contract/` is your
  binding contract.
- You will not commit — leave changes in the working tree; the conductor
  commits per issue. List your changed files per issue in your final message.
- Keep exploration narrow: the package was sized for your task. If the
  contract seems to require reading far outside the declared churn, say so in
  your final message rather than wandering.
