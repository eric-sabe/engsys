#!/usr/bin/env bash
# shellcheck disable=SC2034 # POOL_FILE, STORE and OWNER_PATTERN are consumed by broker_pool / broker_lease in the sourced broker-config.sh
# broker-host-window.sh — actuate a host-tier maintenance window: drain -> lock -> act -> verify -> all-clear.
#
# The host tier is the one place the broker holds real leverage over its neighbours: a host action
# (restarting a container runtime, say) bounces every resource on the machine. So the broker:
#
#   1. DRAIN + LOCK  takes every slot lease of the pool under its own owner, waiting for each held slot
#                    to be released (or to expire). While it holds them, waiters queue and nobody is
#                    granted a slot; nothing already running is interrupted.
#   2. ACT           runs the configured restart command (host.restart_cmd) once, everything drained.
#   3. VERIFY        polls the configured health command (host.health_cmd) until it succeeds.
#   4. ALL-CLEAR     releases every slot lease. The next grant provisions a clean slot as usual.
#
# It never destroys data: a restart command that reads as destructive (delete, destroy, prune,
# wipe, purge, rm) is refused before anything is touched. Slot leases are released on every exit
# path (an EXIT trap), and they carry a TTL (host.window_minutes, default 30) as the safety net if the
# script itself is killed.
#
# Progress goes to stdout, one line each, for the model to broadcast:
#   WINDOW_DRAINING <slot> <holder>   still waiting for that slot
#   WINDOW_LOCKED                     every slot is held by the broker: the fleet is drained
#   WINDOW_ACTED                      the restart command exited 0
#   WINDOW_HEALTHY                    the health command passed (or none is configured)
#   WINDOW_ALL_CLEAR                  every slot lease released
#   WINDOW_ABORTED <reason>           drain_timeout | lease_error | restart_failed | unhealthy |
#                                     release_unconfirmed; leases released (or expiring), exit 1
# The model does the broadcasting: announce before running this, and again on all-clear or abort.
#
# Usage: broker-host-window.sh [--reason TEXT] [--drain-timeout-secs 600] [--health-timeout-secs 300]
#                              [--restart-cmd CMD] [--health-cmd CMD] [--window-minutes N] [--dry-run]
#                              [--repo owner/name] [--ledger N] [--owner OWNER] [--pool FILE]
#                              [--store DIR] [--owner-pattern REGEX] [--config FILE | --config-dir DIR]
# Values default to resource-broker.yml (host.restart_cmd, host.health_cmd, host.window_minutes,
# lease.*). With --repo and --ledger (or the config's), the ledger issue carries the
# `broker:host-window` label for the duration, best effort. In multi-fleet mode that issue is the
# fleet's status issue and the owner and fence are fleet-qualified (broker-config.sh).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

REPO="" LEDGER="" OWNER="" POOL_FILE="" STORE="" OWNER_PATTERN="" CONFIG="" CONFIG_DIR=""
RESTART_CMD="" HEALTH_CMD="" WINDOW_MIN="" REASON="host maintenance" DRAIN_SECS=600 HEALTH_SECS=300 DRY=0
DRAIN_POLL="${BROKER_WINDOW_POLL_SECS:-2}"
usage() { echo "usage: broker-host-window.sh [--reason TEXT] [--drain-timeout-secs N] [--health-timeout-secs N] [--restart-cmd CMD] [--health-cmd CMD] [--dry-run] [--config FILE | --config-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --reason) [ $# -ge 2 ] || usage; REASON="$2"; shift 2 ;;
    --drain-timeout-secs) [ $# -ge 2 ] || usage; DRAIN_SECS="$2"; shift 2 ;;
    --health-timeout-secs) [ $# -ge 2 ] || usage; HEALTH_SECS="$2"; shift 2 ;;
    --restart-cmd) [ $# -ge 2 ] || usage; RESTART_CMD="$2"; shift 2 ;;
    --health-cmd) [ $# -ge 2 ] || usage; HEALTH_CMD="$2"; shift 2 ;;
    --window-minutes) [ $# -ge 2 ] || usage; WINDOW_MIN="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --ledger) [ $# -ge 2 ] || usage; LEDGER="$2"; shift 2 ;;
    --owner) [ $# -ge 2 ] || usage; OWNER="$2"; shift 2 ;;
    --pool) [ $# -ge 2 ] || usage; POOL_FILE="$2"; shift 2 ;;
    --store) [ $# -ge 2 ] || usage; STORE="$2"; shift 2 ;;
    --owner-pattern) [ $# -ge 2 ] || usage; OWNER_PATTERN="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_ledger REPO LEDGER || exit 2
broker_fill_owner OWNER OWNER_PATTERN || exit 2
broker_fill_path POOL_FILE lease.pool_file
broker_fill_path STORE lease.store
broker_fill_var RESTART_CMD host.restart_cmd
broker_fill_var HEALTH_CMD host.health_cmd
broker_fill_var WINDOW_MIN host.window_minutes
[ -n "$WINDOW_MIN" ] || WINDOW_MIN=30
for n in "$DRAIN_SECS" "$HEALTH_SECS" "$WINDOW_MIN"; do
  case "$n" in '' | *[!0-9]*) echo "broker-host-window: timeouts and --window-minutes must be positive integers (got '$n')" >&2; exit 2 ;; esac
done
[ -n "$RESTART_CMD" ] || { echo "broker-host-window: no restart command (host.restart_cmd in resource-broker.yml, or --restart-cmd): a host-tier action is not configured for this host" >&2; exit 2; }
# Defence in depth for the hard rule: a host window restarts things, it never destroys data.
if printf '%s' "$RESTART_CMD" | grep -Eiq '(^|[^a-z])(delete|destroy|prune|wipe|purge|rm)([^a-z]|$)'; then
  echo "broker-host-window: refusing a restart command that reads as destructive: $RESTART_CMD" >&2
  exit 2
fi
broker_setup_pool || exit 2

SLOT_KINDS=$(broker_pool status | jq -r '.slots[].kind')
[ -n "$SLOT_KINDS" ] || { echo "broker-host-window: the pool reports no slots" >&2; exit 1; }
if [ "$DRY" = 1 ]; then
  echo "dry run: would drain and lock: $(echo "$SLOT_KINDS" | paste -sd' ' -)"
  echo "dry run: would run: $RESTART_CMD"
  echo "dry run: would verify with: ${HEALTH_CMD:-(no health command configured)}"
  exit 0
fi

# kind -> lease token, as two parallel arrays (bash 3.2 has no associative arrays).
HELD_KINDS=() HELD_TOKENS=()
LABELED=0

label() { # label add|remove: the durable "a window is open" marker, best effort
  [ -n "$REPO" ] && [ -n "$LEDGER" ] && [ "$LEDGER" != 0 ] && command -v gh >/dev/null || return 0
  if [ "$1" = add ]; then
    gh issue edit "$LEDGER" -R "$REPO" --add-label "broker:host-window" >/dev/null 2>&1 && LABELED=1 || echo "WARN: could not label the ledger broker:host-window" >&2
  else
    gh issue edit "$LEDGER" -R "$REPO" --remove-label "broker:host-window" >/dev/null 2>&1 || echo "WARN: could not remove the broker:host-window label from the ledger" >&2
    LABELED=0
  fi
}

# Release every slot lease we hold; unconditional and idempotent, wired to EXIT before the first acquire.
# shellcheck disable=SC2329 # invoked via the EXIT trap
release_all() {
  local i unconfirmed=0
  for ((i = 0; i < ${#HELD_KINDS[@]}; i++)); do
    [ -n "${HELD_TOKENS[$i]}" ] || continue
    if broker_lease release --kind "${HELD_KINDS[$i]}" --owner "$OWNER" --token "${HELD_TOKENS[$i]}" >/dev/null 2>&1; then
      HELD_TOKENS[i]=""
    else
      unconfirmed=1
      echo "WARN: release of ${HELD_KINDS[$i]} did not confirm; its lease expires after ${WINDOW_MIN}m" >&2
    fi
  done
  if [ "$unconfirmed" = 0 ] && [ "$LABELED" = 1 ]; then label remove; fi
  return "$unconfirmed"
}
trap release_all EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

abort() { echo "WINDOW_ABORTED $1"; exit 1; }

PAYLOAD=$(jq -cn --arg r "$REASON" '{window: "host", reason: $r}')
for kind in $SLOT_KINDS; do HELD_KINDS+=("$kind"); HELD_TOKENS+=(""); done
label add

# 1. DRAIN + LOCK
deadline=$(( $(date +%s) + DRAIN_SECS ))
while :; do
  pending=0
  for ((i = 0; i < ${#HELD_KINDS[@]}; i++)); do
    [ -z "${HELD_TOKENS[$i]}" ] || continue
    rc=0
    out=$(broker_lease acquire --kind "${HELD_KINDS[$i]}" --owner "$OWNER" --ttl "$WINDOW_MIN" --payload "$PAYLOAD" 2>/dev/null) || rc=$?
    if [ "$rc" = 0 ]; then
      HELD_TOKENS[i]=$(jq -r '.record.token' <<<"$out")
    elif [ "$rc" != 1 ]; then
      abort lease_error # a usage or internal error (owner fence, bad store): waiting will not fix it
    else
      pending=$((pending + 1))
      holder=$(jq -r '.holder // "unknown"' <<<"$out" 2>/dev/null || echo unknown)
      echo "WINDOW_DRAINING ${HELD_KINDS[$i]} $holder"
    fi
  done
  [ "$pending" = 0 ] && break
  [ "$(date +%s)" -lt "$deadline" ] || abort drain_timeout
  sleep "$DRAIN_POLL"
done
echo "WINDOW_LOCKED"

# 2. ACT
if ! sh -c "$RESTART_CMD" >&2; then abort restart_failed; fi
echo "WINDOW_ACTED"

# 3. VERIFY
if [ -n "$HEALTH_CMD" ]; then
  deadline=$(( $(date +%s) + HEALTH_SECS ))
  until sh -c "$HEALTH_CMD" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || abort unhealthy
    sleep "$DRAIN_POLL"
  done
fi
echo "WINDOW_HEALTHY"

# 4. ALL-CLEAR
if ! release_all; then abort release_unconfirmed; fi
echo "WINDOW_ALL_CLEAR"
