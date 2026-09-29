#!/usr/bin/env bash
# mnt-fp-candidates.sh — READ-ONLY. List open code-scanning alerts that a standing false-positive
# policy (config `fp_policies:`) covers, and prove each policy's structural tripwire holds at the
# alert's own commit AND at the freshly fetched default branch. It never dismisses anything: the
# per-alert code judgment is the monster's, and mnt-fp-dismiss.sh is the only mutating path.
#
# Usage: mnt-fp-candidates.sh --repo owner/name --config FILE [--policy ID] [--json]
#                             [--repo-dir DIR] [--default-branch NAME]
#   --repo-dir        the local clone to read git objects from (default: the current directory);
#                     its `origin` remote must be the repo
#   --default-branch  overrides the config's default_branch (default: main)
#
# Output, one line per alert (or one JSON array with --json):
#   CANDIDATE <alert#> <policy> <path>:<line> <sha>
#   TRIPWIRE_FAILED <alert#> <policy> <check> <commit|main> <detail>
#   OUT_OF_SCOPE <alert#> <policy> <path> <why>
#   ERROR <reason>            (any gh/git/config problem: no CANDIDATE is printed for that policy)
# Exit: 0 clean, 1 when any ERROR was printed, 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "ERROR node not found"; exit 1; }
exec node "$here/mnt-fp.mjs" candidates "$@"
