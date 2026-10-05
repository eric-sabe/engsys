#!/usr/bin/env bash
# relay.sh — `fleet relay`: one poll of the cross-fleet message relay (what the fleet-relay launchd job
# runs), or `fleet relay status` (the line `fleet status` prints). Sources fleet-env.sh so FLEET_ID,
# FEDERATION_FILE and FLEET_STATE resolve the way every other fleet command resolves
# them, passes the roster's session names along, then execs relay.mjs. See relay.mjs for the contract.
#
#   fleet relay [poll]      one poll; a no-op in single-fleet mode
#   fleet relay status      relay age and undelivered inbox counts (nothing in single-fleet mode)
set -euo pipefail
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required for the relay"
# The launchd job appends to $LOG_DIR/fleet-relay.log; keep one rotated copy past 1 MB. (launchd opens
# the file for each run, so this run's output lands in .1 and the next run starts a fresh file.)
RELAY_LOG="$LOG_DIR/fleet-relay.log"
if [ "${1:-poll}" = poll ] && [ -f "$RELAY_LOG" ] && [ "$(wc -c <"$RELAY_LOG" | tr -d ' ')" -gt "${RELAY_LOG_MAX_BYTES:-1048576}" ]; then
  mv -f "$RELAY_LOG" "$RELAY_LOG.1"
fi
FLEET_ROSTER="$(fleet_roster_sessions)"
export FLEET_ROSTER
exec node "$HERE/relay.mjs" "$@"
