#!/usr/bin/env bash
# supervise.sh — one LLM-free supervisor tick (launchd, every 5 min): relaunch crashed or rotating
# monsters, never touch a live one, respect closed ledgers (the kill switch). Renders
# fleet/supervisor.conf.tmpl to .fleet/supervisor.conf and runs the engsys fleet-supervisor.sh
# (decision table in its header) with LAUNCH_CMD pointing back at `fleet --instance <dir> launch`.
# State + log: logs/fleet-supervisor/ in the instance checkout. gh calls authenticate through the
# identity shim when GH_APP_ENV is set (fleet-env.sh puts it on PATH).
#
# Usage: supervise.sh [--instance <dir>]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"

fleet_check_engsys
[ -f "$FLEET_REPO/fleet/supervisor.conf.tmpl" ] || fleet_die "no fleet/supervisor.conf.tmpl — the supervisor is not enabled for this instance"
conf="$FLEET_STATE/supervisor.conf"
fleet_render "$FLEET_REPO/fleet/supervisor.conf.tmpl" "$conf"
# LAUNCH_CMD / TMUX_SESSION default to the kit's own when the template doesn't set them.
grep -q '^LAUNCH_CMD=' "$conf" || printf 'LAUNCH_CMD=%s\n' "$LAUNCH_CMD" >>"$conf"
grep -q '^TMUX_SESSION=' "$conf" || printf 'TMUX_SESSION=%s\n' "$TMUX_SESSION" >>"$conf"
cd "$FLEET_REPO"
exec bash "$ENGSYS_DIR/core/skills/agent-sessions/scripts/fleet-supervisor.sh" "$conf"
