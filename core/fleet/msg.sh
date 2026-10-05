#!/usr/bin/env bash
# msg.sh — `fleet msg send|inbox`: cross-fleet messages. Sources fleet-env.sh (FLEET_ID,
# FEDERATION_FILE, FLEET_STATE, and the fleet's gh identity when GH_APP_ENV is set), then execs
# msg.mjs. See msg.mjs for the contract.
#
#   fleet msg send --to <fleet>:<session> [--re owner/repo#n] --body-file <file> [--from <session>]
#   fleet msg inbox <session> [--mark-read]
set -euo pipefail
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required for fleet msg"
exec node "$HERE/msg.mjs" "$@"
