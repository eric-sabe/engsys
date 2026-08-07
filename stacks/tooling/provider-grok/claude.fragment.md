## Worker provider: Grok (xAI)

Grok's lane is **adversarial review, critique, and stuck-loop rescue** — never
implementation. See § Worker providers and `.claude/workflows/worker-dispatch.md`.

- Harness: **thin xAI-API runner** (packaged-diff lane). Requires `XAI_API_KEY`
  in the environment. The adapter inlines the whole package plus the
  `base...HEAD` diff into one request.
- **No tools.** Grok cannot open files or run the gates; its brief requires it
  to disclose that, and its verdict is one family's read of the packaged
  evidence. Use it for family-diverse adversarial reads — never as the sole
  gate on work whose verification depends on running anything.
- Oversized changes (package + diff past the adapter's cap) refuse loudly —
  route those reviews to a tool-capable provider instead.
- Best fit: second family on Anthropic-authored judgment surfaces, alternate
  plans when a loop is stuck, and design/copy critique.
