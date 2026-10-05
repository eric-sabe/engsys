#!/usr/bin/env bash
# federation-status.sh — `fleet status --federation`: every fleet and every baton in one read-only
# view (heartbeat ages from the status issues, live baton holders from refs/engsys/batons/<role>).
# Sources fleet-env.sh so FLEET_ID, FEDERATION_FILE and the fleet's gh identity resolve the way every
# other fleet command resolves them, then execs lib/federation-status.mjs. Flags: --json.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required for the federation view"
command -v gh >/dev/null || fleet_die "gh is required for the federation view"
exec node "$HERE/lib/federation-status.mjs" "$@"
