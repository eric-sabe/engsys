## Worker provider: Codex (OpenAI)

Codex is available as a **worker** (implement / review / critique / investigate)
under the engsys worker contract — see § Worker providers for routing and
`.claude/workflows/worker-dispatch.md` for the procedure.

- Default well-specified implementer (Terra-class) and strong independent
  reviewer (Sol-class). **Never let Codex review Codex-authored work** when
  another family is available — author family ≠ reviewer family.
- Dispatch: `node .claude/scripts/worker-package.mjs …` then
  `node .claude/scripts/worker-run.mjs --package …`. Workers never push,
  commit, or open PRs; the conductor commits per issue with a
  `Worker: codex/<model>` trailer.
- Codex's sandbox cannot reach `gh` or the network — the package materializes
  the issue contract for it; never dispatch by pointing it at GitHub.
