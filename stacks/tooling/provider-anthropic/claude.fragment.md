## Worker provider: Anthropic (explicit worker lane)

A fresh `claude` child session as a **worker** under the same package/receipt
contract as every other provider — this is the explicit fallback lane, not the
conductor. See § Worker providers and `.claude/workflows/worker-dispatch.md`.

- Use for: judgment-heavy implement work dispatched as a package, and as the
  terminal fallback of the review chain when every other family exited 2.
- The conductor reviewing its own worker-lane output is a **same-family
  exception**: allowed only with explicit operator sign-off, logged as such.
- The adapter strips any `ANTHROPIC_*` remap from the child env and asserts an
  Anthropic model answered — an inherited base-URL remap would silently make
  the "Anthropic reviewer" not Anthropic.
