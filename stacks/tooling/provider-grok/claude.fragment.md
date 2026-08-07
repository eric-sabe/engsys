## Worker provider: Grok (xAI)

Grok's lane is **adversarial review, critique, and stuck-loop rescue** — never
implementation. See § Worker providers and `.claude/workflows/worker-dispatch.md`.

- **Harness not yet confirmed** (spec § 10): the adapter refuses loudly
  (`--check` reports NOT READY) until the Grok plugin path or a thin xAI-API
  runner is wired at M2. Until it emits the receipt footer, treat Grok as a
  best-effort critique assistant, not a worker channel — an unavailable gate
  never degrades into a green one.
- Once wired: preferred second family on Anthropic-authored judgment surfaces,
  and the alternate-plan generator when a loop is stuck.
