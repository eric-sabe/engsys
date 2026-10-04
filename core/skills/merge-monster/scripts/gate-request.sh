#!/usr/bin/env bash
# gate-request.sh — post a gate request comment (the thing a human approves in GitHub).
# Thin wrapper over <engsys-root>/lib/gate-check.mjs (`request`); see docs/gate-check.md.
#
# Usage: gate-request.sh --repo owner/name (--pr N | --issue N) --kind K --target T --what TEXT
#                        [--gate ID] [--operators-team org/slug | --operators login:id,...] [--dry-run]
#   --kind    merge (approved by PR review) | migration | deploy | risk-accepted | dependency | ...
#   --target  on a PR: owner/name#N@<full 40-hex head sha>; on an issue: e.g. alert:dependabot/42
#   --gate    optional; default <kind>-<utc timestamp>-<4 hex>. Must be [a-z0-9-], unique on the thread.
#
# Prints JSON {id, url, comment_id, author}. Exit 0 posted, 1 error.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/../../../lib/gate-check.mjs"
command -v node >/dev/null || { echo "gate-check: node not found" >&2; exit 1; }
[ -f "$lib" ] || { echo "gate-check: $lib not found (engsys core lib/ missing from this install)" >&2; exit 1; }
exec node "$lib" request "$@"
