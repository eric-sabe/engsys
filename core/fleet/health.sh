#!/usr/bin/env bash
# health.sh — thin dispatch wrapper for `fleet health` (Fleet Health Desk).
# Sources fleet-env.sh when running inside a fleet instance so FLEET_STATE, FLEET_ID,
# OPERATOR_TIMEZONE, and OPERATOR_CLOCK resolve automatically, then execs health/cli.mjs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

_candidate="${FLEET_INSTANCE:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -n "$_candidate" ] && [ -f "$_candidate/fleet/fleet.conf" ]; then
  # shellcheck source=lib/fleet-env.sh
  . "$HERE/lib/fleet-env.sh"
fi
unset _candidate

command -v node >/dev/null || { echo "fleet health: node is required" >&2; exit 1; }
exec node "$HERE/health/cli.mjs" "$@"
