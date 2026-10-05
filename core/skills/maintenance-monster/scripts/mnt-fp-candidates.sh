#!/usr/bin/env bash
# mnt-fp-candidates.sh — READ-ONLY. List open code-scanning alerts that a standing false-positive
# policy (config `fp_policies:`) covers, and prove each policy's structural tripwire holds at the
# alert's own commit AND at the freshly fetched default branch. It never dismisses anything: the
# per-alert code judgment is the monster's, and mnt-fp-dismiss.sh is the only mutating path.
#
# It scans the default branch AND each open pull request (refs/pull/<n>/merge, falling back to /head),
# because the alerts that block a merge live on PR refs. Alerts are deduped by number. The tripwire is
# evaluated at each alert instance's commit and at the default branch.
#
# Usage: mnt-fp-candidates.sh --repo owner/name --config FILE [--policy ID] [--json]
#                             [--prs all|none|<n,n>] [--repo-dir DIR] [--default-branch NAME]
#   --prs             which PRs to scan: all open PRs (default), none, or a comma list of PR numbers
#   --repo-dir        the local clone to read git objects from (default: the current directory);
#                     its `origin` remote must be the repo
#   --default-branch  overrides the config's default_branch (default: main)
#
# Output, one line per alert (or one JSON array with --json); `pr=<n>` is appended when the alert
# instance is on a PR ref:
#   CANDIDATE <alert#> <policy> <path>:<line> <sha> [pr=<n>]
#   TRIPWIRE_FAILED <alert#> <policy> <check> <commit|main> <detail> [pr=<n>]
#   OUT_OF_SCOPE <alert#> <policy> <path> <why> [pr=<n>]
#   ERROR <reason>
# ERROR scope: `ERROR alert <n>: ...` (its commit could not be fetched or read) and `ERROR pr <n>: ...`
# (its alerts could not be listed) affect only that alert or PR; an invalid policy, a failed
# default-branch fetch or a failed default-branch alert listing fails the whole policy closed (no
# CANDIDATE for it).
# Exit: 0 clean, 1 when any ERROR was printed, 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "ERROR node not found"; exit 1; }
# shellcheck source=../../../lib/fleet-gh.sh
. "$here/../../../lib/fleet-gh.sh"
fleet_gh_resolve
assert_gh_auth mnt-fp-candidates || exit 1
exec node "$here/mnt-fp.mjs" candidates "$@"
