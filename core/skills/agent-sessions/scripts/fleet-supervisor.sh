#!/usr/bin/env bash
# fleet-supervisor.sh — deterministic relauncher for ledger-bearing monster
# sessions (Merge Monster, Maintenance Monster). Runs under launchd every few
# minutes; NO LLM in the restart path, so recovery works even when the whole
# fleet is dark.
#
# Decision table (per configured session):
#   ledger issue CLOSED                          → never touch (kill switch)
#   heartbeat "rotation requested" + proc exited → kill window, relaunch
#   heartbeat stale + proc exited (issue open)   → relaunch (crash recovery)
#   heartbeat "session end"       + proc exited  → leave (deliberate stop)
#   heartbeat stale + proc ALIVE                 → NEVER kill; escalate once
#                                                  on the ledger (hung-or-
#                                                  thinking is probe-then-
#                                                  classify territory, not a
#                                                  script's call — see
#                                                  docs/subagent-liveness.md
#                                                  in engsys)
#
# Config: .claude/fleet-supervisor.conf
#   TMUX_SESSION=<tmux session the fleet runs in>
#   LAUNCH_CMD=<command that launches ONE session; supervisor appends name>
#   <session-name>|<ledger-issue>|<stale-minutes>     (one line per monster)
#
# State/log: logs/fleet-supervisor/ (escalation latches + supervisor.log).
# Requires: gh (authed), tmux, jq. Run from the repo root (launchd sets
# WorkingDirectory).
set -euo pipefail

CONF="${1:-.claude/fleet-supervisor.conf}"
[ -f "$CONF" ] || { echo "fleet-supervisor: config not found: $CONF" >&2; exit 1; }

REPO_SLUG=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
[ -n "$REPO_SLUG" ] || { echo "fleet-supervisor: cannot resolve repo (gh auth / cwd?)" >&2; exit 1; }

STATE_DIR="logs/fleet-supervisor"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/supervisor.log"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# One supervisor run at a time: launchd tick + a manual invocation overlapping
# could both classify-then-act. mkdir lock; a lock older than 10 min is a
# crashed run — steal via atomic mv (never rmdir a path another waiter may
# have just re-created).
LOCKDIR="$STATE_DIR/run.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  lm=$(stat -f %m "$LOCKDIR" 2>/dev/null || stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0)
  case "$lm" in '' | *[!0-9]*) lm=0 ;; esac
  if [ "$lm" -gt 0 ] && [ $(($(date +%s) - lm)) -gt 600 ]; then
    mv "$LOCKDIR" "$LOCKDIR.stale.$$" 2>/dev/null && rmdir "$LOCKDIR.stale.$$" 2>/dev/null || true
    mkdir "$LOCKDIR" 2>/dev/null || { echo "fleet-supervisor: another run holds the lock" >&2; exit 0; }
  else
    echo "fleet-supervisor: another run holds the lock — exiting" >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

TMUX_SESSION="" LAUNCH_CMD=""
SESSIONS=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    '' | \#*) continue ;;
    TMUX_SESSION=*) TMUX_SESSION="${line#TMUX_SESSION=}" ;;
    LAUNCH_CMD=*) LAUNCH_CMD="${line#LAUNCH_CMD=}" ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "fleet-supervisor: bad conf line: $line" >&2; exit 1 ;;
  esac
done < "$CONF"
[ -n "$TMUX_SESSION" ] && [ -n "$LAUNCH_CMD" ] || { echo "fleet-supervisor: conf must set TMUX_SESSION and LAUNCH_CMD" >&2; exit 1; }

# ISO8601Z → epoch, portable (BSD date first — this runs on macOS; GNU fallback)
iso_to_epoch() {
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
    || date -u -d "$1" +%s 2>/dev/null \
    || echo ""
}

# Foreground command of the session's tmux pane; empty if window gone.
pane_cmd() {
  tmux list-panes -t "${TMUX_SESSION}:$1" -F '#{pane_current_command}' 2>/dev/null | head -1
}

NOW=$(date +%s)

for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r name ledger stale_min <<<"$spec"
  [ -n "$name" ] && [ -n "$ledger" ] && [ -n "$stale_min" ] || { log "SKIP bad line: $spec"; continue; }

  # --- ledger: kill switch + heartbeat ---------------------------------------
  if ! ISSUE=$(gh issue view "$ledger" -R "$REPO_SLUG" --json state,body 2>/dev/null); then
    log "$name: ledger #$ledger unreadable (gh error) — skipping this cycle"
    continue
  fi
  STATE=$(jq -r .state <<<"$ISSUE")
  if [ "$STATE" = "CLOSED" ]; then
    log "$name: ledger #$ledger CLOSED (kill switch) — not touching"
    continue
  fi
  HB=$(jq -r .body <<<"$ISSUE" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1)
  HB_TS="${HB%%|*}"
  HB_STATUS="${HB#*|}"
  HB_EPOCH=$(iso_to_epoch "$HB_TS")

  # --- process state ----------------------------------------------------------
  # Do NOT match the claude binary by name — it renames its process to its
  # version string (e.g. "2.1.233"). Invert instead: when claude exits, the
  # pane's foreground command falls back to the login SHELL; any non-shell
  # foreground means the session process is alive. Missing window = exited.
  CMD=$(pane_cmd "$name")
  ALIVE=1
  case "$CMD" in
    '' | zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) ALIVE=0 ;;
  esac

  # --- classify ---------------------------------------------------------------
  STALE=0
  if [ -z "$HB_EPOCH" ]; then
    STALE=1 # unparseable/never heartbeat counts as stale, never as fresh
  elif [ $(( (NOW - HB_EPOCH) / 60 )) -ge "$stale_min" ]; then
    STALE=1
  fi
  ROTATION=0; case "$HB_STATUS" in *[Rr]otation\ requested*) ROTATION=1 ;; esac
  ENDED=0;    case "$HB_STATUS" in *[Ss]ession\ end*) ENDED=1 ;; esac

  LATCH="$STATE_DIR/$name.escalated"

  if [ "$ALIVE" = "1" ]; then
    if [ "$STALE" = "1" ] && [ "$ROTATION" = "0" ]; then
      # hung-or-thinking: never kill; escalate once per incident
      if [ ! -f "$LATCH" ]; then
        gh issue comment "$ledger" -R "$REPO_SLUG" --body "⚠️ fleet-supervisor: heartbeat stale (last: ${HB_TS:-never}) but the \`$name\` process is still alive. Not touching it — a live process is never killed on staleness alone (probe-then-classify is a judgment call, not a script's). Needs a probe: operator or maintenance watchdog." >/dev/null \
          && touch "$LATCH" && log "$name: STALE+ALIVE — escalated on ledger #$ledger"
      else
        log "$name: STALE+ALIVE — already escalated, holding"
      fi
    else
      rm -f "$LATCH"
      log "$name: alive, heartbeat ok — nothing to do"
    fi
    continue
  fi

  # --- process exited ---------------------------------------------------------
  rm -f "$LATCH"
  if [ "$ROTATION" = "1" ] || { [ "$STALE" = "1" ] && [ "$ENDED" = "0" ]; }; then
    REASON=$([ "$ROTATION" = "1" ] && echo "rotation requested" || echo "crash recovery (stale heartbeat, process gone)")
    # TOCTOU guard: re-read the pane immediately before killing the window —
    # a process may have appeared since classification (manual relaunch,
    # overlapping recovery). A now-live pane aborts this action entirely.
    RECHECK=$(pane_cmd "$name")
    case "$RECHECK" in
      '' | zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) : ;;
      *) log "$name: pane became live between classify and act ($RECHECK) — aborting relaunch"; continue ;;
    esac
    log "$name: relaunching — $REASON"
    tmux kill-window -t "${TMUX_SESSION}:$name" 2>/dev/null || true
    # LAUNCH_CMD is intentionally word-split (it is a command line, not a path)
    # shellcheck disable=SC2086
    if $LAUNCH_CMD "$name" >>"$LOG" 2>&1; then
      log "$name: relaunched"
      gh issue comment "$ledger" -R "$REPO_SLUG" --body "🔁 fleet-supervisor: relaunched \`$name\` ($REASON, $(date -u +%Y-%m-%dT%H:%M:%SZ)). Startup reconcile recovers state from this ledger + state.md." >/dev/null || true
    else
      log "$name: RELAUNCH FAILED — see $LOG"
      gh issue comment "$ledger" -R "$REPO_SLUG" --body "🚨 fleet-supervisor: relaunch of \`$name\` FAILED ($REASON). Operator needed — see logs/fleet-supervisor/supervisor.log on the host." >/dev/null || true
    fi
  elif [ "$ENDED" = "1" ]; then
    log "$name: process exited after 'session end' — deliberate stop, leaving it"
  else
    log "$name: process exited, heartbeat fresh (${HB_TS:-?}) — within grace, waiting"
  fi
done
