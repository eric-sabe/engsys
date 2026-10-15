<!-- pack: lang/shell -->
## Language — Shell Scripting (Bash / POSIX sh)

This project ships production shell scripts (`*.sh`, CLI entrypoints, hooks, or fleet daemons):
- **Isabelle**, **Aaron**, and **Bert** load **`shell-scripting`** when authoring or modifying shell scripts.
- Enforce `set -euo pipefail`, quote all parameter expansions (`"$var"`), validatewith `shellcheck`, prefer arrays over word-split strings, and clean up temp files via `trap ... EXIT`.

<!-- naturalize: confirm target shell dialect (bash 5+ / zsh / POSIX sh) and shellcheck gate in Project facts. -->
