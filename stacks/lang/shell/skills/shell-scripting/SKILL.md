---
name: shell-scripting
description: Shell scripting conventions for bash/sh/zsh in this repo. Use when writing or editing any *.sh file — including scripts/, .githooks/, and one-off shell snippets. Covers safety flags, structure, error handling, JSON/YAML parsing, and a script template.
---

# Shell Scripting Guidelines

Applies to: any `*.sh` file in this repo. Common locations: `scripts/`, `.githooks/`.

## General Principles

- Clean, simple, concise. Easy to read.
- Comments where helpful for understanding; avoid commentary on what well-named identifiers already say.
- Concise echo for status; avoid noisy logging.
- Use `shellcheck` when available.
- Default assumption: scripts are for automation/testing, not production systems, unless stated.
- Safe expansions: double-quote variable references (`"$var"`), use `${var}` for clarity, never `eval`.
- Prefer modern Bash (`[[ ]]`, `local`, arrays) when portability allows; fall back to POSIX only when needed.
- Use dedicated parsers (`jq`, `yq`) for structured data instead of ad-hoc grep/awk.

## Error Handling & Safety

- Always: `set -euo pipefail`.
- Validate required parameters before doing anything.
- Provide error messages with context.
- Use `trap` to clean up temp files / unexpected exits.
- Declare constants with `readonly`.
- Use `mktemp` for temp files/dirs; remove in cleanup.

## Script Structure

- Shebang: `#!/bin/bash` unless told otherwise.
- Header comment explaining purpose.
- Default values at top.
- Functions for reusable blocks.
- Keep `main` flow readable.

## JSON / YAML

- Prefer `jq` for JSON, `yq` for YAML.
- Quote filters (`jq '.foo'`); use `--raw-output` for plain strings.
- Validate fields exist; check `jq` exit status or `// empty`.
- Combine with `set -euo pipefail` so parse errors are fatal.
- Document parser dependencies at the top; fail fast with a helpful message if missing.

## Cross-Platform & Non-Login Environment Portability (macOS BSD vs. Linux GNU)

Scripts and one-liners often run across macOS (`darwin`, BSD userland, `/bin/bash` 3.2), Linux / WSL2 (`GNU` userland, `/bin/sh` = `dash`), and non-login environments (`launchd`, `cron`, `systemd`, or GUI/IDE harnesses like Antigravity and VS Code).

- **Bootstrap `PATH` in non-login scripts (`launchd` / `cron` / GUI harnesses):**
  ```bash
  export PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:$PATH"
  ```
- **Bash 3.2 (`/bin/bash` on macOS) vs. Bash 5+ (`/opt/homebrew/bin/bash` / Linux):**
  - If a script uses `#!/bin/bash` (or `bash script.sh`), it must work on **Bash 3.2** unless it explicitly re-execs `/opt/homebrew/bin/bash`:
    - Under `set -u`, empty array expansion `"${arr[@]}"` throws `unbound variable` in Bash 3.2 — always write `${arr[@]+"${arr[@]}"}`.
    - Avoid `declare -A`, `mapfile`/`readarray`, and `${var,,}` / `${var^^}` unless Bash 4+ is guaranteed.
- **BSD (macOS) vs. GNU (Linux/WSL2) Rosetta Table:**

| Operation | macOS (BSD) | Linux / WSL2 (GNU) | Portable Pattern |
|---|---|---|---|
| File mtime (epoch) | `stat -f '%m' "$f"` | `stat -c '%Y' "$f"` | `stat -c '%Y' "$f" 2>/dev/null \|\| stat -f '%m' "$f"` |
| File uid / mode | `stat -f '%u %Lp' "$f"` | `stat -c '%u %a' "$f"` | Try GNU `stat -c`, fallback to BSD `stat -f` |
| Epoch → ISO UTC | `date -u -r "$ts" +%Y-%m-%dT%H:%M:%SZ` | `date -u -d "@$ts" +%Y-%m-%dT%H:%M:%SZ` | `date -u -d "@$ts" ... 2>/dev/null \|\| date -u -r "$ts" ...` |
| SHA-256 hex | `shasum -a 256 "$f"` | `sha256sum "$f"` | `sha256sum "$f" 2>/dev/null \|\| shasum -a 256 "$f"` |
| In-place `sed` | `sed -i '' 's/a/b/' "$f"` | `sed -i 's/a/b/' "$f"` | Write to `"$f.tmp"` and `mv "$f.tmp" "$f"` |
| Extended regex `grep -E` | Rejects empty branch `(foo\|)` (`empty (sub)expression`) | Accepts `(foo\|)` | Always use `(foo)?` or chained `grep -v`, never `(foo\|)` |

## Template

```bash
#!/bin/bash

# ============================================================================
# Script Description Here
# ============================================================================

set -euo pipefail

cleanup() {
    if [[ -n "${TEMP_DIR:-}" && -d "$TEMP_DIR" ]]; then
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

# Default values
REQUIRED_PARAM=""
OPTIONAL_PARAM="default-value"
readonly SCRIPT_NAME="$(basename "$0")"

TEMP_DIR=""

usage() {
    echo "Usage: $SCRIPT_NAME [OPTIONS]"
    echo "Options:"
    echo "  -p, --param   Required param"
    echo "  -h, --help    Show this help"
    exit 0
}

validate_requirements() {
    if [[ -z "$REQUIRED_PARAM" ]]; then
        echo "Error: --param is required" >&2
        exit 1
    fi
}

main() {
    validate_requirements
    TEMP_DIR="$(mktemp -d)"
    # main logic here
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--param)
            REQUIRED_PARAM="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

main "$@"
```
