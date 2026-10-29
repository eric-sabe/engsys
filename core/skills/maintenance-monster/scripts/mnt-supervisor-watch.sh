#!/usr/bin/env bash
# mnt-supervisor-watch.sh — is this host's fleet supervisor still ticking? (ff-engsys-fleet#48)
#
# The supervisor is what pages, so it can't report its own absence: on 2026-10-08 and 10-09 every fleet launchd
# job stopped for 19.5 h / 36 h behind unanswered macOS privacy prompts while the monsters (tmux, not launchd)
# kept their heartbeats fresh. mnt-tick.sh runs this once per tick, from a process launchd does not start.
#
# The record: `fleet supervise` writes $FLEET_STATE/supervisor.tick first thing on every run (epoch=, at=, label=,
# plist=, done=; core/fleet/supervise.sh), and the end stamp named by done= (supervisor.tick.done, epoch= and at=)
# once the tick completed (engsys#308). A fleet-launched session has FLEET_STATE in its env (core/fleet/launch.sh).
# The threshold: --stale-intervals (default 3) x the StartInterval read from the job's plist (300 s when it
# can't be read), or --stale-min minutes outright. Flags win over SUPERVISOR_STALE_INTERVALS / SUPERVISOR_STALE_MIN.
#
# Stale is: the start stamp older than the threshold (the job stopped running), or, while the start stamp is fresh,
# the end stamp older than it (the job runs, but every tick dies before it completes). The end stamp is required only
# when the start stamp names it (done=): a supervisor that predates the end stamp writes no done= and is watched on the
# start stamp alone, so it never alerts for the stamp it doesn't write. A named end stamp that doesn't exist yet ages
# from the first tick of this watch that saw it missing (<state-dir>/.watch/supervisor-done-missing.since).
# A stamp dated more than the threshold ahead of now (clock skew, a corrupt epoch) counts as stale, not fresh, so it
# can't silence the watch; less than that ahead counts as age 0.
#
# Silent (no line, no alert) unless the host runs a supervisor job: no FLEET_STATE and no --tick-file (a session
# the fleet did not launch, a non-fleet install), no tick file (the supervisor never ran here), no plist at the
# path the stamp names (the job is not installed: Linux, an attended-only host, install-jobs removed it), or
# `launchctl print` cannot find the job (booted out on purpose with `fleet install-jobs --unload`).
#
# One alert per stall, latched in <state-dir>/.watch/supervisor-stalled.alerted; resolved once the tick is fresh
# again (or the job is gone). A notify that fails (or takes longer than 30 s, SUPERVISOR_WATCH_NOTIFY_TIMEOUT, killed
# then) leaves no latch, so the next tick tries again. Prints at most one
# line, a delta line for mnt-tick:
#   SUPERVISOR_STALLED last=<iso> age=<m>m threshold=<m>m notified|notify_failed
#   SUPERVISOR_FAILING last=<iso> completed=<iso|never> age=<m>m threshold=<m>m notified|notify_failed
#                                                            (it starts, but no tick completed for <age>)
#   SUPERVISOR_STALLED last=<iso> future=<m>m threshold=<m>m notified|notify_failed   (a stamp from the future)
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
SINCE="$W/supervisor-done-missing.since" # when this watch first saw a named end stamp missing
INCIDENT=fleet-supervisor-stalled
mkdir -p "$W" 2>/dev/null || exit 0

case "$NOW" in '' | *[!0-9]*) NOW="$(date -u +%s)" ;; esac
case "$INTERVALS" in '' | 0 | *[!0-9]*) INTERVALS=3 ;; esac
case "$STALE_MIN" in 0 | *[!0-9]*) STALE_MIN="" ;; esac

NOTIFY_TIMEOUT="${SUPERVISOR_WATCH_NOTIFY_TIMEOUT:-30}" # seconds, as core/lib/lease/baton.mjs defaultNotify
case "$NOTIFY_TIMEOUT" in '' | 0 | *[!0-9]*) NOTIFY_TIMEOUT=30 ;; esac

tree_pids() { # tree_pids <pid> → the pid and all its descendants (pgrep -P, so no ps format differences)
  local c
  echo "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do tree_pids "$c"; done
}

bounded() { # bounded <secs> <cmd...> → the command's status, or 124 once it ran <secs> s (then it and its children die)
  # macOS has no timeout(1), and bash 3.2 has no wait -n: a background job, polled every 0.2 s.
  local secs="$1" pid ticks=0 pids; shift
  "$@" &
  pid=$!
  # Still one of this shell's RUNNING jobs, not just a live pid: once the job ends its pid can be reused, and
  # `jobs -r` drops it even before it is reaped (kill -0 would follow the reused pid).
  while jobs -rp | grep -qx "$pid"; do
    if [ "$ticks" -ge $((secs * 5)) ]; then
      pids="$(tree_pids "$pid")"
      # shellcheck disable=SC2086 # one pid per word
      kill -TERM $pids 2>/dev/null
      sleep 1
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.2; ticks=$((ticks + 1))
  done
  wait "$pid"
}

notify() { # notify <args...> → 0 when the notifier accepted it within NOTIFY_TIMEOUT seconds
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
  bounded "$NOTIFY_TIMEOUT" "${cmd[@]}" "$@" </dev/null >/dev/null
}

field() { sed -n "s/^$1=//p" "$TICK" 2>/dev/null | tail -n 1; }

stand_down() { # stand_down <why>: the job is not (or no longer) on this host; close an open alert
  rm -f "$SINCE"
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
HOST="$(hostname -s 2>/dev/null || echo this host)"
[ -n "$AT" ] || AT="epoch ${EPOCH}"
THRESH_M=$(((THRESH + 59) / 60))

# age <epoch> → AGE (seconds since it, 0 when slightly ahead) and AHEAD (seconds ahead of now when more than the
# threshold ahead: clock skew or a corrupt epoch, counted as stale so it can't silence the watch; 0 otherwise)
age() {
  AGE=$((NOW - $1)) AHEAD=0
  if [ "$AGE" -lt 0 ]; then
    [ $((0 - AGE)) -le "$THRESH" ] || AHEAD=$((0 - AGE))
    AGE=0
  fi
}

alert() { # alert <SUPERVISOR_ line, without the outcome> <text>: once per stall (latched)
  [ ! -f "$LATCH" ] || exit 0 # already alerted for this stall
  if notify --level alert --incident "$INCIDENT" "$2"; then
    printf '%s %s\n' "$EPOCH" "$NOW" >"$LATCH"
    echo "$1 notified"
  else
    echo "$1 notify_failed"
  fi
  exit 0
}

CHECK="Check: launchctl print gui/${UIDN}/${LABEL} (runs not increasing, pended nondemand spawn = interval)."
age "$EPOCH"
# The start stamp is stale: an end stamp missing since before then would age from a time the job didn't run.
[ "$AHEAD" = 0 ] && [ "$AGE" -le "$THRESH" ] || rm -f "$SINCE"
if [ "$AHEAD" -gt 0 ]; then
  alert "SUPERVISOR_STALLED last=${AT} future=$((AHEAD / 60))m threshold=${THRESH_M}m" \
    "Fleet supervisor on ${HOST}: its tick stamp ${TICK} is dated ${AT}, $((AHEAD / 60)) min in the future (more than the ${THRESH_M} min alert threshold, ${WHY}), so the watch can't tell whether the supervisor still ticks: the host clock is off or the stamp is corrupt. Check the clock (date -u) and the stamp; the next supervisor run rewrites it. ${CHECK} Runbook: ff-engsys-fleet docs/runbooks/operate.md, Supervisor stalled."
fi
if [ "$AGE" -gt "$THRESH" ]; then
  alert "SUPERVISOR_STALLED last=${AT} age=$((AGE / 60))m threshold=${THRESH_M}m" \
    "Fleet supervisor on ${HOST} has not ticked since ${AT} ($((AGE / 60)) min ago; the alert threshold is ${THRESH_M} min, ${WHY}). Its launchd jobs (supervisor, relay, App-token and Azure logins) have most likely stalled behind an unanswered macOS privacy prompt on the host's desktop, so nothing relaunches a dead or rotating monster until it is cleared. ${CHECK} Recover: answer the prompts at the Mac as the fleet user (Don't Allow is fine), then launchctl kickstart -k gui/${UIDN}/${LABEL} and confirm runs increases. Runbook: ff-engsys-fleet docs/runbooks/operate.md, Supervisor stalled."
fi
START_AGE_M=$((AGE / 60))

# The end stamp (engsys#308), only when the start stamp names it (a supervisor that writes one).
DONE="$(field "done")"
if [ -n "$DONE" ]; then
  D_EPOCH="$(sed -n 's/^epoch=//p' "$DONE" 2>/dev/null | tail -n 1)" D_AT="$(sed -n 's/^at=//p' "$DONE" 2>/dev/null | tail -n 1)"
  case "$D_EPOCH" in
    '' | *[!0-9]*) # missing (or unreadable): it ages from the first time this watch saw it so
      S="$(cat "$SINCE" 2>/dev/null)"
      case "$S" in '' | *[!0-9]*) S="$NOW"; printf '%s\n' "$S" >"$SINCE" 2>/dev/null ;; esac
      D_EPOCH="$S" D_AT=never ;;
    *) rm -f "$SINCE"; [ -n "$D_AT" ] || D_AT="epoch ${D_EPOCH}" ;;
  esac
  age "$D_EPOCH"
  if [ "$AHEAD" -gt 0 ] || [ "$AGE" -gt "$THRESH" ]; then
    if [ "$AHEAD" -gt 0 ]; then how="its completed-tick stamp ${DONE} is dated ${D_AT}, $((AHEAD / 60)) min in the future (the host clock is off or the stamp is corrupt)"
    elif [ "$D_AT" = never ]; then how="no tick has completed in the $((AGE / 60)) min this watch has seen it start (no ${DONE} yet)"
    else how="the last tick that completed was at ${D_AT}, $((AGE / 60)) min ago"; fi
    alert "SUPERVISOR_FAILING last=${AT} completed=${D_AT} age=$((AGE / 60))m threshold=${THRESH_M}m" \
      "Fleet supervisor on ${HOST} starts (last at ${AT}) but its ticks don't complete: ${how}; the alert threshold is ${THRESH_M} min, ${WHY}. Each run most likely dies early (an engsys checkout fleet verify rejects, a missing fleet/supervisor.conf.tmpl, a supervisor error), so nothing relaunches a dead or rotating monster. Check: fleet supervise by hand, and the supervisor's log (the launchd job's stderr, logs/fleet-supervisor/ in the instance checkout). Runbook: ff-engsys-fleet docs/runbooks/operate.md, Supervisor stalled."
  fi
else
  rm -f "$SINCE"
fi

[ -f "$LATCH" ] || exit 0
# An open alert waits for a completed tick: a named end stamp still missing is not a recovery yet.
[ -z "$DONE" ] || [ "$D_AT" != never ] || exit 0
if notify --level info --incident "$INCIDENT" --resolve "Fleet supervisor on ${HOST} is ticking again (last tick ${AT})."; then
  rm -f "$LATCH"; echo "SUPERVISOR_RECOVERED last=${AT} age=${START_AGE_M}m resolved"
else
  echo "SUPERVISOR_RECOVERED last=${AT} age=${START_AGE_M}m resolve_failed"
fi
exit 0
