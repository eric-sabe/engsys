#!/usr/bin/env bash
# mnt-fp-dismiss.sh — the ONLY mutating path of the standing false-positive policies. Re-runs the
# candidate evaluation for one alert (the tripwire may have tripped since the list was made) and, only
# if it is still a CANDIDATE and --shape is verbatim one of the policy's known_fp_shapes, dismisses it
# as "false positive" with an auditable comment and appends a line to <state-dir>/fp-dispositions.jsonl.
#
# Usage: mnt-fp-dismiss.sh --repo owner/name --config FILE --alert N --policy ID
#                          --shape "<known_fp_shape, verbatim>" --evidence "<one line: what the code does>"
#                          [--state-dir DIR] [--repo-dir DIR] [--default-branch NAME] [--no-baton]
#   --state-dir  where the journal goes (default: the config's state_dir); in a monster session also
#                where its maintain baton lives: the dismissal is sent only under a passing fence
#   --no-baton   an operator at a shell, outside any monster session: skip the fence. Refused when
#                ENGSYS_SESSION is set (a launched session); the skills never pass it
#
# Needs the GitHub permission "Code scanning alerts: Read and write" (security_events: write).
# Output: `DISMISSED <alert#> <policy> <path>:<line> <sha>`, `REFUSED <alert#> <policy> <why>` or
# `ERROR <reason>`. Exit: 0 dismissed, 1 refused/failed (nothing was PATCHed unless DISMISSED), 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "ERROR node not found"; exit 1; }
# shellcheck source=../../../lib/fleet-gh.sh
. "$here/../../../lib/fleet-gh.sh"
fleet_gh_resolve
exec node "$here/mnt-fp.mjs" dismiss "$@"
