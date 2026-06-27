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
