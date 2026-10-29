#!/usr/bin/env bash
# mnt-supervisor-watch.sh — is this host's fleet supervisor still ticking? (ff-engsys-fleet#48)
#
# The supervisor is what pages, so it can't report its own absence: on 2026-10-08 and 10-09 every fleet launchd
# job stopped for 19.5 h / 36 h behind unanswered macOS privacy prompts while the monsters (tmux, not launchd)
# kept their heartbeats fresh. mnt-tick.sh runs this once per tick, from a process launchd does not start.
#
# The record: `fleet supervise` writes $FLEET_STATE/supervisor.tick first thing on every run (epoch=, at=, label=,
# plist=; core/fleet/supervise.sh). A fleet-launched session has FLEET_STATE in its env (core/fleet/launch.sh).
# The threshold: --stale-intervals (default 3) x the StartInterval read from the job's plist (300 s when it
# can't be read), or --stale-min minutes outright. Flags win over SUPERVISOR_STALE_INTERVALS / SUPERVISOR_STALE_MIN.
#
# Silent (no line, no alert) unless the host runs a supervisor job: no FLEET_STATE and no --tick-file (a session
# the fleet did not launch, a non-fleet install), no tick file (the supervisor never ran here), no plist at the
# path the stamp names (the job is not installed: Linux, an attended-only host, install-jobs removed it), or
# `launchctl print` cannot find the job (booted out on purpose with `fleet install-jobs --unload`).
#
# One alert per stall, latched in <state-dir>/.watch/supervisor-stalled.alerted; resolved once the tick is fresh
# again (or the job is gone). A notify that fails leaves no latch, so the next tick tries again. Prints at most one
# line, a delta line for mnt-tick:
#   SUPERVISOR_STALLED last=<iso> age=<m>m threshold=<m>m notified|notify_failed
#   SUPERVISOR_RECOVERED last=<iso> age=<m>m resolved|resolve_failed
#   SUPERVISOR_UNWATCHED <why> resolved|resolve_failed     (an open alert, and the job is no longer installed)
# Exit 0 always (2 on usage): it never fails the tick.
#
# Notifier: BATON_NOTIFY_CMD (full command), else FLEET_BIN notify, else this kit's core/fleet/bin/fleet notify,
# with --instance <dirname of FLEET_STATE> (as core/lib/lease/baton.mjs resolves it, plus the instance).
# Test seam: SUPERVISOR_WATCH_LAUNCHCTL (the launchctl to ask; `none` skips the loaded check).
#
# Usage: mnt-supervisor-watch.sh --state-dir DIR [--tick-file FILE] [--stale-intervals N] [--stale-min M] [--now EPOCH]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DIR="" TICK="" INTERVALS="${SUPERVISOR_STALE_INTERVALS:-}" STALE_MIN="${SUPERVISOR_STALE_MIN:-}" NOW=""
usage() { echo "usage: mnt-supervisor-watch.sh --state-dir DIR [--tick-file FILE] [--stale-intervals N] [--stale-min M]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) [ $# -ge 2 ] || usage; DIR="$2"; shift 2 ;;
    --tick-file) [ $# -ge 2 ] || usage; TICK="$2"; shift 2 ;;
    --stale-intervals) [ $# -ge 2 ] || usage; INTERVALS="$2"; shift 2 ;;
    --stale-min) [ $# -ge 2 ] || usage; STALE_MIN="$2"; shift 2 ;;
    --now) [ $# -ge 2 ] || usage; NOW="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$DIR" ] || usage

INSTANCE=""
if [ -z "$TICK" ]; then
  [ -n "${FLEET_STATE:-}" ] || exit 0
  TICK="${FLEET_STATE%/}/supervisor.tick"
fi
[ -z "${FLEET_STATE:-}" ] || INSTANCE="$(dirname "${FLEET_STATE%/}")"
W="$DIR/.watch"
LATCH="$W/supervisor-stalled.alerted"
INCIDENT=fleet-supervisor-stalled
mkdir -p "$W" 2>/dev/null || exit 0

case "$NOW" in '' | *[!0-9]*) NOW="$(date -u +%s)" ;; esac
case "$INTERVALS" in '' | 0 | *[!0-9]*) INTERVALS=3 ;; esac
case "$STALE_MIN" in 0 | *[!0-9]*) STALE_MIN="" ;; esac

notify() { # notify <args...> → 0 when the notifier accepted it
  local cmd=()
  if [ -n "${BATON_NOTIFY_CMD:-}" ]; then
    read -r -a cmd <<<"$BATON_NOTIFY_CMD"
  elif [ -n "${FLEET_BIN:-}" ]; then
    cmd=("$FLEET_BIN")
    [ -z "$INSTANCE" ] || cmd+=(--instance "$INSTANCE")
    cmd+=(notify)
  else
    cmd=(bash "$here/../../../fleet/bin/fleet")
    [ -z "$INSTANCE" ] || cmd+=(--instance "$INSTANCE")
    cmd+=(notify)
  fi
  [ "${#cmd[@]}" -gt 0 ] || return 1
  "${cmd[@]}" "$@" </dev/null >/dev/null
}

field() { sed -n "s/^$1=//p" "$TICK" 2>/dev/null | tail -n 1; }

stand_down() { # stand_down <why>: the job is not (or no longer) on this host; close an open alert
  [ -f "$LATCH" ] || exit 0
  if notify --level info --incident "$INCIDENT" --resolve "Fleet supervisor watch on $(hostname -s 2>/dev/null || echo this host) stood down: $1. The stall alert is closed."; then
    rm -f "$LATCH"; echo "SUPERVISOR_UNWATCHED $1 resolved"
  else
    echo "SUPERVISOR_UNWATCHED $1 resolve_failed"
  fi
  exit 0
}

[ -f "$TICK" ] || stand_down "no supervisor tick file"
EPOCH="$(field epoch)" AT="$(field at)" LABEL="$(field label)" PLIST="$(field plist)"
case "$EPOCH" in '' | *[!0-9]*) stand_down "the supervisor tick file is unreadable" ;; esac
[ -n "$PLIST" ] && [ -f "$PLIST" ] || stand_down "no supervisor launchd job installed"
LCTL="${SUPERVISOR_WATCH_LAUNCHCTL:-launchctl}"
UIDN="$(id -u)"
if [ "$LCTL" != none ] && [ -n "$LABEL" ] && command -v "$LCTL" >/dev/null 2>&1; then
  "$LCTL" print "gui/$UIDN/$LABEL" >/dev/null 2>&1 || stand_down "the supervisor launchd job is not loaded"
fi

# StartInterval from the plist (XML, as install-jobs writes it); 300 s when it can't be read.
INTERVAL="$(awk '/<key>StartInterval<\/key>/ { want = 1 } want && match($0, /<integer>[0-9]+<\/integer>/) { s = substr($0, RSTART + 9, RLENGTH - 19); print s; exit }' "$PLIST" 2>/dev/null)"
case "$INTERVAL" in '' | 0 | *[!0-9]*) INTERVAL=300 ;; esac
if [ -n "$STALE_MIN" ]; then
  THRESH=$((STALE_MIN * 60)) WHY="${STALE_MIN} min"
else
  THRESH=$((INTERVALS * INTERVAL)) WHY="${INTERVALS} x the job's ${INTERVAL}s StartInterval"
fi
AGE=$((NOW - EPOCH))
[ "$AGE" -ge 0 ] || AGE=0
AGE_M=$((AGE / 60)) THRESH_M=$(((THRESH + 59) / 60))
HOST="$(hostname -s 2>/dev/null || echo this host)"
[ -n "$AT" ] || AT="epoch ${EPOCH}"

if [ "$AGE" -gt "$THRESH" ]; then
  [ ! -f "$LATCH" ] || exit 0 # already alerted for this stall
  text="Fleet supervisor on ${HOST} has not ticked since ${AT} (${AGE_M} min ago; the alert threshold is ${THRESH_M} min, ${WHY}). Its launchd jobs (supervisor, relay, App-token and Azure logins) have most likely stalled behind an unanswered macOS privacy prompt on the host's desktop, so nothing relaunches a dead or rotating monster until it is cleared. Check: launchctl print gui/${UIDN}/${LABEL} (runs not increasing, pended nondemand spawn = interval). Recover: answer the prompts at the Mac as the fleet user (Don't Allow is fine), then launchctl kickstart -k gui/${UIDN}/${LABEL} and confirm runs increases. Runbook: ff-engsys-fleet docs/runbooks/operate.md, Supervisor stalled."
  if notify --level alert --incident "$INCIDENT" "$text"; then
    printf '%s %s\n' "$EPOCH" "$NOW" >"$LATCH"
    echo "SUPERVISOR_STALLED last=${AT} age=${AGE_M}m threshold=${THRESH_M}m notified"
  else
    echo "SUPERVISOR_STALLED last=${AT} age=${AGE_M}m threshold=${THRESH_M}m notify_failed"
  fi
  exit 0
fi

[ -f "$LATCH" ] || exit 0
if notify --level info --incident "$INCIDENT" --resolve "Fleet supervisor on ${HOST} is ticking again (last tick ${AT})."; then
  rm -f "$LATCH"; echo "SUPERVISOR_RECOVERED last=${AT} age=${AGE_M}m resolved"
else
  echo "SUPERVISOR_RECOVERED last=${AT} age=${AGE_M}m resolve_failed"
fi
exit 0
