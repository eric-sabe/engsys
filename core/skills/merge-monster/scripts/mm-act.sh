#!/usr/bin/env bash
# mm-act.sh — every mutating act of a monster, fenced by its baton (engsys#62). Wraps
# <engsys-root>/lib/lease/baton.mjs: it fences (assertHeld with 60 s left + the local deadline + the
# post-takeover wait), re-checks that under 30 s passed since the fence started, then sends with a
# 30 s timeout. A refused fence sends nothing. MUTATING: deliberately not auto-approved.
#
# Usage: mm-act.sh merge --repo owner/name --state-dir DIR --pr N --sha <validated head> --method merge|squash|rebase
#        mm-act.sh guard --repo owner/name --state-dir DIR -- gh <args…>
#        mm-act.sh guard --repo owner/name --state-dir DIR -- <engsys-root>/skills/merge-monster/scripts/gate-request.sh <args…>
#        mm-act.sh guard --repo owner/name --state-dir DIR -- fleet msg send --to <fleet>:<session> [--re owner/repo#n] --body-file <f>
#        mm-act.sh guard --repo owner/name --state-dir DIR --pr N -- git -C <wt> push --force-with-lease origin HEAD:refs/heads/<PR head branch>
#        mm-act.sh guard --repo owner/name --state-dir DIR --new-branch -- git -C <wt> push origin HEAD:refs/heads/<new branch>
#   [--role maintain]  Maintenance Monster's acts (mnt-act.sh passes it); default merge
#   merge   PUT /pulls/{n}/merge with sha=<validated head>; never retried (exit 3 = unknown: re-snapshot)
#   guard   gh mutations (pr ready, labels, comments, close, api) and gate requests; never `gh pr merge`
#           or --admin; a git push only in the two shapes above (checked against the PR / origin, run with
#           hooks off). Its command's stdout passes through; a JSON status line goes to stderr.
# Exit: merge 0 merged | 1 refused | 3 unknown/error; guard = the command's exit, or 1/3/5 when the
# fence refused (nothing ran).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/../../../lib/lease/baton.mjs"
command -v node >/dev/null || { echo "mm-act: node not found" >&2; exit 3; }
[ -f "$lib" ] || { echo "mm-act: $lib not found (engsys core lib/ missing from this install)" >&2; exit 3; }
op="${1:-}"
case "$op" in
  merge | guard) shift ;;
  *) echo "usage: mm-act.sh merge|guard --repo owner/name --state-dir DIR …" >&2; exit 2 ;;
esac
role=merge args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --role) role="${2:?--role needs a value}"; shift 2 ;;
    --) break ;;
    *) args+=("$1"); shift ;;
  esac
done
exec node "$lib" "$op" --role "$role" ${args[@]+"${args[@]}"} "$@"
