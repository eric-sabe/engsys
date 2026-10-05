#!/usr/bin/env bash
# supervise.sh — one LLM-free supervisor tick (launchd, every 5 min): relaunch crashed or rotating
# monsters, never touch a live one, respect closed ledgers (the kill switch). Renders
# fleet/supervisor.conf.tmpl to .fleet/supervisor.conf and runs the engsys fleet-supervisor.sh
# (decision table in its header) with LAUNCH_CMD pointing back at `fleet --instance <dir> launch`.
# State + log: logs/fleet-supervisor/ in the instance checkout. gh calls authenticate through the
# identity shim when GH_APP_ENV is set (fleet-env.sh puts it on PATH).
#
# Sessions that are not on this host (ROLES / ROSTER_EXCLUDE, or a monster whose registry home is
# another fleet: lib/host-roles.sh) are dropped from the rendered conf, and the conf gets
# HOST_CHECK_CMD so the supervisor re-asks `fleet launch --check <name>` before it touches any session,
# even from a conf rendered before the filter changed. No session left: the tick does nothing, except
# for the registry alert below.
# The conf also gets HOST_HEALTH_CMD (`fleet launch --host-health`) and NOTIFY_CMD (`fleet notify`):
# when an unreadable registry keeps merge/maintain monsters off this host, the supervisor posts one
# `fleet notify --level alert --incident fleet-registry-unreadable` and resolves it once the registry
# reads clean again.
# It also gets HEARTBEAT_CMD (`fleet heartbeat`): once per tick the supervisor writes this fleet's
# own status-issue heartbeat (federation.yml fleets.<FLEET_ID>.status_issue), which cross-fleet work
# claiming (core/lib/claim.mjs) reads for freshness. No-op in single-fleet mode or with no
# status_issue declared.
#
# Multi-fleet mode (FLEET_ID set and the federation file present): the resource broker heartbeats on
# its fleet's status issue, not on the repo ledger named in the template (docs/multi-fleet.md § 3), so
# the broker's line is rewritten to `<name>|<status issue>|<stale>|<instance repo>|broker-heartbeat`:
# the supervisor then reads only the broker's own block of that issue, never the fleet-heartbeat
# block beside it. The status issue comes from `federation.mjs status-issue` (FLEET_INSTANCE_REPO in
# fleet.conf, else the instance checkout's origin, names its repo). If it can't be resolved, the line
# is commented out with a warning rather than left on the shared ledger another fleet's broker may use.
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
fleet_host_init
kept=0 dropped="" status_target="" status_why=""
if [ -n "$FLEET_ID" ] && [ -f "$FEDERATION_FILE" ]; then
  status_target="$(node "$FLEET_KIT_DIR/lib/federation.mjs" status-issue --file "$FEDERATION_FILE" 2>&1)" || { status_why="${status_target#federation: }"; status_target=""; }
  [ -n "$status_target" ] || [ -n "$status_why" ] || status_why="no status issue resolved"
fi
while IFS= read -r line; do
  case "$line" in
    [a-z0-9]*\|*)
      n="${line%%|*}"
      if why="$(fleet_host_excluded "$n")"; then dropped="$dropped $n"; printf '# not on this host: %s (%s)\n' "$n" "$why"; continue; fi
      if [ "$(fleet_host_kind_of "$n")" = broker ] && { [ -n "$status_target" ] || [ -n "$status_why" ]; }; then
        if [ -z "$status_target" ]; then
          echo "fleet supervise: WARNING $n not supervised: fleet $FLEET_ID's status issue can't be resolved ($status_why)" >&2
          printf '# broker not supervised: %s (status issue unresolved: %s)\n' "$n" "$status_why"
          continue
        fi
        IFS='|' read -r _ _ stale _ <<<"$line"
        line="$n|${status_target##*#}|$stale|${status_target%%#*}|broker-heartbeat"
      fi
      kept=$((kept + 1)) ;;
  esac
  printf '%s\n' "$line"
done <"$conf" >"$conf.host"
mv "$conf.host" "$conf" && chmod 600 "$conf"
# LAUNCH_CMD / TMUX_SESSION / HOST_CHECK_CMD default to the kit's own when the template doesn't set them.
grep -q '^LAUNCH_CMD=' "$conf" || printf 'LAUNCH_CMD=%s\n' "$LAUNCH_CMD" >>"$conf"
grep -q '^TMUX_SESSION=' "$conf" || printf 'TMUX_SESSION=%s\n' "$TMUX_SESSION" >>"$conf"
grep -q '^HOST_CHECK_CMD=' "$conf" || printf 'HOST_CHECK_CMD=bash %s/bin/fleet --instance %s launch --check\n' "$FLEET_KIT_DIR" "$FLEET_REPO" >>"$conf"
grep -q '^HOST_HEALTH_CMD=' "$conf" || printf 'HOST_HEALTH_CMD=bash %s/bin/fleet --instance %s launch --host-health\n' "$FLEET_KIT_DIR" "$FLEET_REPO" >>"$conf"
grep -q '^HOST_HEALTH_INCIDENT=' "$conf" || printf 'HOST_HEALTH_INCIDENT=fleet-registry-unreadable\n' >>"$conf"
grep -q '^NOTIFY_CMD=' "$conf" || printf 'NOTIFY_CMD=bash %s/bin/fleet --instance %s notify\n' "$FLEET_KIT_DIR" "$FLEET_REPO" >>"$conf"
grep -q '^HEARTBEAT_CMD=' "$conf" || printf 'HEARTBEAT_CMD=bash %s/bin/fleet --instance %s heartbeat\n' "$FLEET_KIT_DIR" "$FLEET_REPO" >>"$conf"
# Nothing to supervise, but an unreadable registry is what paused the monsters (or an open alert needs
# resolving): run the tick anyway, for the alert.
if [ "$kept" = 0 ] && { fleet_host_registry_alert >/dev/null || [ -f "$FLEET_REPO/logs/fleet-supervisor/host-health.alerted" ]; }; then
  kept=alert
fi
if [ "$kept" = 0 ]; then
  echo "fleet supervise: no supervised session runs on this host${dropped:+ (not on this host:$dropped)}; nothing to do"
  exit 0
fi
cd "$FLEET_REPO"
exec bash "$ENGSYS_DIR/core/skills/agent-sessions/scripts/fleet-supervisor.sh" "$conf"
