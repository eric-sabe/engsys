#!/usr/bin/env bash
# gate-check.sh — READ-ONLY. Has a human on the operators team approved this gate in GitHub?
# Thin wrapper over <engsys-root>/lib/gate-check.mjs (`check`); full rules in docs/gate-check.md.
#
# Usage: gate-check.sh --repo owner/name (--pr N | --issue N) --gate ID
#                      (--operators-team org/slug | --operators login,login)
#                      [--requester LOGIN] [--target T] [--kind K]
#   --operators-team  config `operators_team` (wins when set)
#   --operators       config `operators` login list, for user-owned repos; neither → exit 1 (fail closed)
#   --requester       the fleet identity that posted the request (recommended: ignores look-alikes)
#   --target / --kind what you are about to act on; a request naming anything else → exit 1
#
# Prints one JSON verdict. Exit: 0 approved, 3 waiting, 4 denied, 1 error (incl. stale/ambiguous).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/../../../lib/gate-check.mjs"
command -v node >/dev/null || { echo "gate-check: node not found" >&2; exit 1; }
[ -f "$lib" ] || { echo "gate-check: $lib not found (engsys core lib/ missing from this install)" >&2; exit 1; }
exec node "$lib" check "$@"
