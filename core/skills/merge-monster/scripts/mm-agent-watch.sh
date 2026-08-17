#!/usr/bin/env bash
# mm-agent-watch.sh — subagent liveness watchdog (docs/subagent-liveness-design.md
# §3 Layer 2). Sibling of mm-watch.sh; runs under a persistent Monitor and emits
# ONE LINE PER STATE CHANGE for rows in the spawn registry (agents.tsv, written
# via mm-agent-reg.sh). The orchestrator's fallback tick re-arms this script if
# it dies — the wake guarantee rests on the tick, not on this process.
#
# Events (all refer to the HIGHEST generation of a name with status=running):
#   AGENT_OVERDUE <name> gen=<g> task=<ref>          deadline_epoch passed
#   AGENT_STALE <name> gen=<g> idle=<min>m task=<ref> transcript mtime silent
#                                                     past --stale-min
#
# Emission discipline:
#   OVERDUE — once per (name, gen, deadline_epoch): an mm-agent-reg.sh extend
#             moves the deadline, which re-arms exactly one more emission.
#   STALE   — on the fresh→stale transition only; a transcript write clears the
#             latch so a later stall re-emits. Rows whose transcript path is
#             unknown or missing are skipped for STALE (the path layout is
#             undocumented harness internals — absence of a transcript is NOT
#             evidence of death; OVERDUE still covers them).
#
# A dead/fenced/done row emits nothing — liveness events stop the moment the
# orchestrator rewrites the row's status.
#
# Usage: mm-agent-watch.sh --state-dir DIR [--interval 60] [--stale-min 10]
#                          [--once] [--no-stale]
#   --once runs a single scan and exits — used by the fallback tick as a
#   synchronous backstop when the persistent Monitor may have died.
#   --no-stale disables AGENT_STALE emission entirely (arm with this when the
#   config sets liveness.stale_probe: false — no point waking the orchestrator
#   with events it is configured to ignore; OVERDUE still fires).
set -u

DIR="" INTERVAL=60 STALEMIN=10 ONCE=0 NOSTALE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --stale-min) STALEMIN="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --no-stale) NOSTALE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DIR" ] || { echo "usage: mm-agent-watch.sh --state-dir DIR [--interval N] [--stale-min N]" >&2; exit 2; }
case "$INTERVAL" in '' | 0 | *[!0-9]*) echo "error: --interval must be a positive integer" >&2; exit 2 ;; esac
case "$STALEMIN" in '' | *[!0-9]*) echo "error: --stale-min must be a non-negative integer" >&2; exit 2 ;; esac

REG="$DIR/agents.tsv"
W="$DIR/.watch"
mkdir -p "$W"
touch "$W/agents-overdue.tsv" "$W/agents-stale.tsv"

# Scan mutex: the persistent watcher and a tick-driven `--once` backstop can
# overlap; each scan reads the emission latches and appends to them, so two
# unserialized scans could both emit the same transition. One scan is
# milliseconds; a lock older than 30s is a crashed scanner — steal via atomic
# mv (never rmdir a path another waiter may have just re-created).
SCANLOCK="$W/scan.lock"
scan_lock() {
  tries=0
  until mkdir "$SCANLOCK" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      echo "error: could not acquire scan lock $SCANLOCK after 30s" >&2
      exit 4
    fi
    lm=$(stat -c %Y "$SCANLOCK" 2>/dev/null || stat -f %m "$SCANLOCK" 2>/dev/null || echo "")
    case "$lm" in '' | *[!0-9]*) lm=0 ;; esac
    if [ "$lm" -gt 0 ] && [ $(($(date +%s) - lm)) -gt 30 ]; then
      if mv "$SCANLOCK" "$SCANLOCK.stale.$$" 2>/dev/null; then
        rmdir "$SCANLOCK.stale.$$" 2>/dev/null || true
      fi
      continue
    fi
    sleep 0.2
  done
}
scan_unlock() { rmdir "$SCANLOCK" 2>/dev/null || true; }
trap 'scan_unlock' EXIT

# transcript mtime in epoch seconds, portable across Linux (GNU stat) and macOS
# (BSD stat). GNU must be tried FIRST: on GNU, `stat -f %m` is valid syntax for
# FILESYSTEM status and "succeeds" returning the mount point — a silent wrong
# answer, not an error. BSD rejects -c, so the fallback order is safe. Result is
# validated numeric so any residual oddity degrades to "no mtime" (STALE skipped),
# never to a bogus timestamp.
mtime_of() {
  m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo "")
  case "$m" in '' | *[!0-9]*) echo "" ;; *) echo "$m" ;; esac
}

while true; do
  NOW=$(date +%s)
  if [ -f "$REG" ]; then
    scan_lock
    # highest RUNNING generation per name — filter on status BEFORE picking the
    # max gen, so an active lower generation stays visible even if a newer row
    # already reached a terminal state (a running row hidden behind a done one
    # would be a silent corpse, the exact failure this watchdog exists to catch)
    awk -F'\t' '
      $3 == "running" { if (($2+0) > gen[$1]) { gen[$1] = $2+0; row[$1] = $0 } }
      END { for (n in row) print row[n] }' "$REG" |
    while IFS="$(printf '\t')" read -r name gen status _agent_id _session_id _class task _spawn deadline _ext transcript; do
      [ "$status" = "running" ] || continue

      # --- OVERDUE: once per (name, gen, deadline) ---------------------------
      if [ "$NOW" -ge "${deadline:-0}" ]; then
        KEY="$name|$gen|$deadline"
        if ! grep -Fxq -- "$KEY" "$W/agents-overdue.tsv"; then
          echo "AGENT_OVERDUE $name gen=$gen task=$task"
          printf '%s\n' "$KEY" >> "$W/agents-overdue.tsv"
        fi
      fi

      # --- STALE: fresh→stale transition on transcript mtime -----------------
      if [ "$NOSTALE" = "0" ] && [ -n "$transcript" ] && [ "$transcript" != "-" ] && [ -f "$transcript" ]; then
        MT=$(mtime_of "$transcript")
        if [ -n "$MT" ]; then
          IDLE=$(( (NOW - MT) / 60 ))
          LKEY="$name|$gen"
          LATCHED=$(awk -F'|' -v n="$name" -v g="$gen" '$1==n && $2==g {s=$3} END {print s}' "$W/agents-stale.tsv")
          if [ "$IDLE" -ge "$STALEMIN" ]; then
            if [ "${LATCHED:-fresh}" != "stale" ]; then
              echo "AGENT_STALE $name gen=$gen idle=${IDLE}m task=$task"
              printf '%s|stale\n' "$LKEY" >> "$W/agents-stale.tsv"
            fi
          else
            # transcript advanced → clear the latch so a later stall re-emits
            if [ "${LATCHED:-}" = "stale" ]; then
              printf '%s|fresh\n' "$LKEY" >> "$W/agents-stale.tsv"
            fi
          fi
        fi
      fi
    done
    scan_unlock
  fi
  [ "$ONCE" = "1" ] && exit 0
  sleep "$INTERVAL"
done
