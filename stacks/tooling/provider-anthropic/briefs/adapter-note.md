# Adapter note — Anthropic worker lane

- You are a fresh session, not the conductor: you have no memory of the
  conversation that produced this package. The package is complete on purpose —
  work from it, not from guesses about intent.
- You will not commit, push, or open PRs — leave changes in the working tree
  and list changed files per issue in your final message.
- Going idle without a final message counts as a failed run (timeout ⇒ exit 2).
  If you cannot finish, end early with STATUS: BLOCKED and say why — a partial
  report beats silence.
