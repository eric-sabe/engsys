# Install scenarios

The installer adopts whatever a project already has rather than overwriting it.
Same split as everywhere: **the installer does deterministic plumbing; the model
(`/naturalize`) does the semantic merge.**

## 1. A project that already has Claude infra

A repo with its own `CLAUDE.md`, `.claude/settings.json`, or `.claude/agents/`.

`engsys install` adopts it — nothing is clobbered:

- **Foreign `CLAUDE.md`** (no engsys markers) → backed up to
  `CLAUDE.md.engsys-backup`, and its body is folded into the PROJECT-FACTS region
  of the new CLAUDE.md so the guidance survives. (`--force` overwrites instead.)
- **`settings.json` / `.mcp.json`** → existing `allow`/`deny` and MCP servers are
  **merged** with engsys's, not replaced.
- **The project's own agents / commands / skills** → preserved untouched and
  **reported** (engsys only writes its own files). A same-named collision is
  backed up to `<file>.engsys-backup` first.
- Re-running `install` over an existing engsys install behaves as `update`.

Then run `/naturalize` to reconcile the project's agents with the engsys roster.

## 2. An existing engsys install that needs updating

`engsys update` re-renders from the current engsys + the project's
`engsys.config.yaml`:

- **Preserves** the CLAUDE.md PROJECT-FACTS region and any hand-added permissions.
- **Prunes** managed files orphaned since the last install — deselect a pack
  (e.g. drop `iac: terraform`) and its skills are removed; remove a skill upstream
  and it's cleaned up. Pruning is driven by the lockfile, so it only ever removes
  files engsys previously wrote — **never** the project's own agents/files.
- Reports a **change summary** (`N new, N updated, N removed`) and the engsys
  **version delta**.
- `engsys verify` confirms no drift afterward.

## 3. A repo with Copilot / Cursor config

A repo carrying `.github/copilot-instructions.md`, `.github/agents/*.agent.md`,
`.github/instructions|prompts/*`, `.cursor/rules/*.mdc`, `.cursorrules`,
`.windsurfrules`, or `CONVENTIONS.md`.

On first install, engsys **snapshots** all of it into `docs/imported-ai-config/`
(with an index), leaving the originals in place. The naturalization checklist
flags it. `/naturalize` then folds it in:

- rules/instructions → durable ones merged into CLAUDE.md project facts,
- agent definitions → converted to `.claude/agents/*.md` where engsys has no
  equivalent (editor-specific tool IDs stripped),
- redundant items dropped; `docs/imported-ai-config/` deleted when done.

## Rollback — they might hate us

The first install into a project snapshots **every pre-existing file engsys
touches** (CLAUDE.md, settings, `.mcp.json`, any same-named agent) into
`.claude/.engsys-backup/`, alongside a manifest. One command undoes everything:

```bash
engsys uninstall --into .        # --dry-run to preview
```

It removes every file engsys added (from the lockfile), restores the originals
**byte-for-byte** from the snapshot, and deletes its own bookkeeping. The
project's own agents/commands/skills — never in the lockfile — are left exactly
as they were. After uninstall, the repo is back to its prior system.

Commit `.claude/.engsys-backup/` if you want rollback to work for teammates too,
or add it to `.gitignore` to keep it local.

## Flags

- `--dry-run` — print the full plan (including what would be pruned/imported/backed
  up) and write nothing.
- `--force` — overwrite the generated files (`CLAUDE.md`, `settings.json`,
  `.mcp.json`) instead of merging. Managed files and the project's own files are
  still never deleted except by the normal prune.
