<!-- pack: lang/shell -->
## Language — Shell Scripting (Bash / POSIX sh)

This project ships production shell scripts (`*.sh`, CLI entrypoints, hooks, or fleet daemons):
- **Isabelle**, **Aaron**, and **Bert** load **`shell-scripting`** when authoring or modifying shell scripts.
- Enforce `set -euo pipefail`, quote all parameter expansions (`"$var"`), validate with `shellcheck`, prefer arrays over word-split strings (`${arr[@]+"${arr[@]}"}` for Bash 3.2 `set -u` safety), and clean up temp files via `trap ... EXIT`.
- Keep scripts portable across macOS (BSD `stat -f`/`date -r`/`shasum -a 256`, no empty `grep -E` `(a|)` subexpressions) and Linux/WSL2 (GNU `stat -c`/`date -d`/`sha256sum`), and bootstrap `PATH` (`/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin`) in scripts invoked by `launchd`, `cron`, or non-login harnesses.

<!-- naturalize: confirm target shell dialect (bash 5+ / bash 3.2 / zsh / POSIX sh) and shellcheck gate in Project facts. -->
