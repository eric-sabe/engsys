## Worker provider: Grok (xAI)

Grok's lane is **adversarial review, critique, and stuck-loop rescue** — never
implementation. See § Worker providers and `.claude/workflows/worker-dispatch.md`.

Two routes, one contract (`providers.workers.grok.via: cli | api | auto`;
auto prefers the subscription CLI):

- **`cli` (subscription)** — the Grok Build CLI (`grok`), signed in with a
  SuperGrok subscription; the same engine xAI's grok-build Claude Code plugin
  shells out to. Tool-capable in a **read-only sandbox**: Grok opens the
  package and reads the repo itself. Login probe: `grok models` succeeds.
- **`api` (metered)** — `XAI_API_KEY`; the adapter inlines the whole package
  plus the `base...HEAD` diff into one request. No tools; oversized changes
  refuse loudly (route those to the CLI route or a tool-capable provider).

Either route may be unable to **run** the gates; the brief requires disclosing
that, and a Grok verdict is never the sole gate on work whose verification
depends on execution. Best fit: second family on Anthropic-authored judgment
surfaces, alternate plans when a loop is stuck, and design/copy critique.
