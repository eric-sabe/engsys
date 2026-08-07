## Worker provider: DeepSeek

DeepSeek is available as a **worker** via an env-remapped `claude` CLI child
session (Anthropic-compatible endpoint) — see § Worker providers for routing
and `.claude/workflows/worker-dispatch.md` for the procedure.

- Best fit: high-volume mechanical work, tests, boilerplate (**Flash**) and
  capable low-cost implement/review overflow (**Pro**). Its value is parallel
  overflow capacity and family diversity, not primarily savings.
- Requires `DEEPSEEK_API_KEY` in the environment (metered billing).
- The adapter builds the child env from an allowlist (the worker never inherits
  this session) and **asserts the responding model id** — DeepSeek's compat
  endpoint silently aliases unknown model names to `deepseek-v4-flash`.
- Issues marked `no_external: true` in their engsys:issue-meta block will
  refuse to package for DeepSeek — route those to codex or anthropic.
