#!/usr/bin/env bash
# time.sh — `fleet time <iso|epoch|now> [--date|--time|--relative]`: render a time the way this
# fleet's operator reads it. Sources fleet-env.sh (which resolves OPERATOR_TIMEZONE / OPERATOR_CLOCK
# from federation.yml or fleet.conf), then execs core/lib/operator-time.mjs. Output is for people;
# machine-read timestamps stay ISO 8601 UTC.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required"
exec node "$HERE/../lib/operator-time.mjs" "$@"
