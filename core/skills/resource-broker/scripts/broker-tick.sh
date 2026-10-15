#!/usr/bin/env bash
# broker-tick.sh — Resource Broker's fallback tick in ONE call (engsys#123). Run it on every ScheduleWakeup
# tick instead of separate watch / scan / heartbeat calls. In order:
#   1. (no renew: the broker holds no github baton; its heartbeat is its liveness signal)
#   2. one pass of the event bus (broker-watch.sh --once: the pump's reaping, the nudge channel and the
#      subagent scan), then compare the SHA-256 of the occupancy picture it leaves in <state-dir>/.watch
#      (slots, queue, and the slot counters the bus journals in bash) with <state-dir>/.watch/last-snapshot.sha;
#   3. write the ledger heartbeat only when one is due (none in the last 0.75 x heartbeat_minutes);
#   4. print `NOOP` when nothing changed, else the delta, one line each: the bus's event lines, then
#      `+ <item>` / `- <item>` for occupancy that changed, and HEARTBEAT_ERROR <why> when a due heartbeat
#      failed.
# NOOP means: nothing to act on, so no state.md rewrite and no journal line this wake.
#
# Usage: broker-tick.sh --state-dir DIR [--config FILE | --config-dir DIR] [--heartbeat-minutes M]
#                       [--status "running"] [--stale-min 10] [--no-stale]
# --state-dir is required (it must name the config's state_dir); heartbeat_minutes comes from the config
# when the flag is absent. Exit: 0 (NOOP or a delta) | 1 the bus or the config failed | 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../lib/monster.sh
. "$here/../../../lib/monster.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

DIR="" CONFIG="" CONFIG_DIR="" HB_MIN="" STATUS="running" STALE_MIN=10 NOSTALE=""
usage() { echo "usage: broker-tick.sh --state-dir DIR [--config FILE | --config-dir DIR] [--heartbeat-minutes M] [--status text] [--stale-min N] [--no-stale]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) [ $# -ge 2 ] || usage; DIR="$2"; shift 2 ;;
    --state-dir=*) DIR="${1#--state-dir=}"; shift ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    --heartbeat-minutes) [ $# -ge 2 ] || usage; HB_MIN="$2"; shift 2 ;;
    --status) [ $# -ge 2 ] || usage; STATUS="$2"; shift 2 ;;
    --stale-min) [ $# -ge 2 ] || usage; STALE_MIN="$2"; shift 2 ;;
    --no-stale) NOSTALE=1; shift ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
[ -n "$DIR" ] || usage
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_var HB_MIN heartbeat_minutes
case "$HB_MIN" in '' | 0 | *[!0-9]*) HB_MIN=10 ;; esac
CFG_ARGS=()
[ -z "$CONFIG" ] || CFG_ARGS+=(--config "$CONFIG")
[ -z "$CONFIG_DIR" ] || CFG_ARGS+=(--config-dir "$CONFIG_DIR")
W="$DIR/.watch"
mkdir -p "$W"
DELTA=()

# 2. one bus pass, then the occupancy delta --------------------------------------------------------
RC=0
EV=$(bash "$here/broker-watch.sh" ${CFG_ARGS[@]+"${CFG_ARGS[@]}"} --state-dir "$DIR" --once --stale-min "$STALE_MIN" \
  ${NOSTALE:+--no-stale} 2>&1) || RC=$?
[ "$RC" = 0 ] || { printf '%s\n' "$EV"; exit 1; }
while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done <<<"$EV"
while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done < <(
  [ -s "$W/slot-counters.json" ] || echo '{}' >"$W/slot-counters.json"
  jq -n --slurpfile s "$W/slots.json" --slurpfile q "$W/queue.json" --slurpfile c "$W/slot-counters.json" \
    '{slots: ($s[0] // []), queue: (($q[0] // []) | map(del(.position))), counters: ($c[0] // {})}' 2>/dev/null \
    | monster_snapshot_lines | monster_delta "$W")

# 3. heartbeat when due ----------------------------------------------------------------------------
if monster_heartbeat_due "$DIR" "$HB_MIN"; then
  RC=0
  HB=$(bash "$here/broker-heartbeat.sh" ${CFG_ARGS[@]+"${CFG_ARGS[@]}"} --state-dir "$DIR" --status "$STATUS" 2>&1) || RC=$?
  if [ "$RC" = 0 ]; then
    while IFS= read -r l; do case "$l" in heartbeat:* | '') ;; *) DELTA+=("$l") ;; esac; done <<<"$HB"
  else
    DELTA+=("HEARTBEAT_ERROR $(printf '%s' "$HB" | tr '\n' ' ' | head -c 200)")
  fi
fi

# 4. NOOP or the delta -----------------------------------------------------------------------------
if [ "${#DELTA[@]}" -eq 0 ]; then echo NOOP; else printf '%s\n' "${DELTA[@]}"; fi
