# Naturalization — the model's half

The installer guarantees faithful **plumbing** (directories, files, merged
settings). Naturalization is the only **model-driven** step, and it is strictly
about *project facts* — never folder/plumbing setup. This split is the whole fix
for "Claude won't set up the structure faithfully": the model is never *asked* to
do plumbing, so it cannot skip it.

## Order of operations

```
engsys install --into .     # deterministic: structure + content + merged config
   ↓
/naturalize                 # model: fill project facts, replace placeholders
   ↓
engsys verify --into .      # confirm nothing drifted
```

## What naturalization may touch

- The fenced `PROJECT-FACTS` region of `CLAUDE.md` (between the
  `ENGSYS:PROJECT-FACTS:START/END` markers). `engsys update` regenerates
  everything *outside* this region and never overwrites what's inside.
- `<naturalize: ...>` / `<proj>` / `<rg>` / `<env>` / `<suffix>` placeholders in
  `.mcp.json`. This one is safe to hand-edit in place: `engsys update`
  deep-merges each mcpServer entry and only refreshes fields still carrying the
  literal `<naturalize: ...>` marker, so a naturalized value survives every
  future update.
- The project's `engsys.config.yaml` `naturalize:` block (model_strategy,
  hook_patterns, invariants) — edit there and re-run `engsys update` rather than
  hand-editing generated files. `invariants` renders as a bullet list appended
  to the PROJECT-FACTS seed on first install.

## What naturalization must NOT touch

- Directory creation or file moves. If structure is missing, that's an installer
  bug — report it.
- Agent personas, command bodies, skills (managed, drift-tracked files). Stack
  differences belong in *packs*, selected via config — not in edits to a
  persona. If Melvin feels "too generic," the fix is a richer
  `cloud-architecture-<cloud>` pack in engsys, not a per-project edit.
- Content outside the PROJECT-FACTS fence in CLAUDE.md — this includes the
  `## Stack` section, which is a pack's `claude.fragment.md` spliced in
  verbatim and fully regenerated on every `engsys update`. Any `<!-- naturalize:
  ... -->` comment there is an installer-owned example, not a fill-in-the-blank
  — a hand-edit is silently reverted by the next update. Capture the resolved
  facts in the PROJECT-FACTS region instead.

## Good project facts

High-signal, verifiable, and the kind of thing that breaks correctness or trust
if ignored. Examples drawn from real projects:

- The exact pre-push/precheck command and what it runs.
- Hard invariants ("eval must hold before ship", "restart the API after ingest",
  "never log card data", editorial red lines).
- Where architecture docs and ADRs live; the spec-of-record file.
- Runtime/version constraints that bite (JDK mismatch, Node version, no iOS CI).

Keep it tight. Link to `docs/` for depth. Don't restate what the packs already
carry, and don't invent stack details you didn't verify in the repo.
