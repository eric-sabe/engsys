#!/usr/bin/env bash
# fleet-supervisor.sh — deterministic relauncher for ledger-bearing monster
# sessions (Merge Monster, Maintenance Monster, or any other baton-holding role
# that keeps a heartbeat on a ledger issue — list as many as you run). Runs
# under launchd every few minutes; NO LLM in the restart path, so recovery
# works even when the whole fleet is dark.
#
# Decision table (per configured session):
#   ledger issue CLOSED                          → never touch (kill switch)
#   heartbeat "rotation requested" + proc exited → kill window, relaunch
#   heartbeat "rotation requested" + proc ALIVE,  → kill window, relaunch. A
#     idle at its prompt ≥ ROTATE_GRACE_MIN          Claude session can't exit
#     after that heartbeat                           itself: a monster that has
#                                                    posted its final heartbeat
#                                                    and stopped sits at the
#                                                    prompt. Done once per
#                                                    rotation heartbeat, so the
#                                                    relaunched session is never
#                                                    mistaken for the old one.
#   heartbeat stale + proc exited (issue open)   → relaunch (crash recovery)
#   heartbeat "session end"       + proc exited  → leave (deliberate stop)
#   heartbeat stale + proc ALIVE                 → NEVER kill; escalate once
#                                                  on the ledger (hung-or-
#                                                  thinking is probe-then-
#                                                  classify territory, not a
#                                                  script's call — see
#                                                  docs/subagent-liveness.md
#                                                  in engsys)
#   any relaunch that FAILS                      → escalate once on the ledger
#                                                  (with the launcher's error),
#                                                  retry each tick quietly,
#                                                  comment again on recovery
#
# Config: .claude/fleet-supervisor.conf (or pass a path as $1)
#   TMUX_SESSION=<tmux session the fleet runs in>
#   LAUNCH_CMD=<command that launches ONE session; supervisor appends name>
#   REPO=<owner/name>          optional default repo holding the ledgers
#   ROTATE_GRACE_MIN=<minutes> optional (default 3): how long a live session
#                              must sit idle after its "rotation requested"
#                              heartbeat before it is relaunched
#   HOST_CHECK_CMD=<command>   optional: asked first, every tick, for every
#                              session (supervisor appends the name); exit 0 =
#                              this host runs it, anything else = skip the
#                              session entirely (no ledger read, no comment, no
#                              relaunch), so a stale conf can never start a
#                              session another host owns. Fails closed: a check
#                              that errors skips the session too. The engsys
#                              fleet kit sets it to `fleet launch --check`.
#   HOST_HEALTH_CMD=<command>  optional: run once per tick, before the
#                              sessions. Exit 0 = healthy; anything else = its
#                              stdout is an alert, posted ONCE per incident via
#                              NOTIFY_CMD (latch: host-health.alerted), and
#                              resolved once the command exits 0 again. The
#                              fleet kit uses it for an unreadable federation
#                              registry (`fleet launch --host-health`).
#   HOST_HEALTH_INCIDENT=<key> optional (default host-health): the incident key
#   NOTIFY_CMD=<command>       optional: called as `<cmd> --level alert
#                              --incident <key> <text>` and `<cmd> --level info
#                              --incident <key> --resolve <text>` (the fleet
#                              kit: `fleet notify`). Unset or failing = logged
#                              only; a failed alert is retried next tick and
#                              never stops the tick.
#   <session-name>|<ledger-issue>|<stale-minutes>[|<owner/name>]
#                              one line per monster; the 4th field overrides
#                              REPO= for that session (multi-repo fleets)
# Repo resolution per session: 4th field → REPO= → `gh repo view` in the cwd
# (the last is the single-repo mode where the supervisor runs inside the
# target repo; a separate fleet repo must set REPO= or the 4th field).
#
# State/log: logs/fleet-supervisor/ under the cwd (escalation latches +
# supervisor.log). Requires: gh (authed), tmux, jq. launchd sets
# WorkingDirectory — the fleet directory, or the target repo root.
set -euo pipefail

CONF="${1:-.claude/fleet-supervisor.conf}"
[ -f "$CONF" ] || { echo "fleet-supervisor: config not found: $CONF" >&2; exit 1; }

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

TMUX_SESSION="" LAUNCH_CMD="" DEFAULT_REPO="" ROTATE_GRACE_MIN=3 HOST_CHECK_CMD=""
HOST_HEALTH_CMD="" HOST_HEALTH_INCIDENT="host-health" NOTIFY_CMD=""
SESSIONS=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    '' | \#*) continue ;;
    TMUX_SESSION=*) TMUX_SESSION="${line#TMUX_SESSION=}" ;;
    LAUNCH_CMD=*) LAUNCH_CMD="${line#LAUNCH_CMD=}" ;;
    REPO=*) DEFAULT_REPO="${line#REPO=}" ;;
    ROTATE_GRACE_MIN=*) ROTATE_GRACE_MIN="${line#ROTATE_GRACE_MIN=}" ;;
    HOST_CHECK_CMD=*) HOST_CHECK_CMD="${line#HOST_CHECK_CMD=}" ;;
    HOST_HEALTH_CMD=*) HOST_HEALTH_CMD="${line#HOST_HEALTH_CMD=}" ;;
    HOST_HEALTH_INCIDENT=*) HOST_HEALTH_INCIDENT="${line#HOST_HEALTH_INCIDENT=}" ;;
    NOTIFY_CMD=*) NOTIFY_CMD="${line#NOTIFY_CMD=}" ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "fleet-supervisor: bad conf line: $line" >&2; exit 1 ;;
  esac
done < "$CONF"
[ -n "$TMUX_SESSION" ] && [ -n "$LAUNCH_CMD" ] || { echo "fleet-supervisor: conf must set TMUX_SESSION and LAUNCH_CMD" >&2; exit 1; }

# Backward-compatible fallback: the repo the cwd belongs to (resolved lazily,
# once, and only if some session names no repo).
CWD_REPO="" CWD_REPO_TRIED=0
cwd_repo() {
  if [ "$CWD_REPO_TRIED" = 0 ]; then
    CWD_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
    CWD_REPO_TRIED=1
  fi
  printf '%s' "$CWD_REPO"
}

# ISO8601Z → epoch, portable (BSD date first — this runs on macOS; GNU fallback)
iso_to_epoch() {
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
    || date -u -d "$1" +%s 2>/dev/null \
    || echo ""
}

# Foreground command of the session's tmux pane; empty if window gone.
pane_cmd() {
  # tmux exits non-zero for a missing window/session; that must read as "gone", not abort the tick
  tmux list-panes -t "${TMUX_SESSION}:$1" -F '#{pane_current_command}' 2>/dev/null | head -1 || true
}

# Claude Code shows "esc to interrupt" while a turn is running; absent = idle at the prompt.
pane_busy() {
  tmux capture-pane -p -t "${TMUX_SESSION}:$1" -S -15 2>/dev/null | grep -q 'esc to interrupt'
}

# Kill the window (if any) and launch the session fresh; report on the ledger.
# A failed launch is escalated ONCE per incident (latch: <name>.launch-failed) with the launcher's own
# error lines, then retried quietly every tick; the first successful launch after that clears the latch
# and says so. Without the latch a persistent cause (e.g. claude not on the job's PATH) posts a comment
# every tick and buries the alert.
relaunch() { # relaunch <name> <ledger> <repo> <reason>
  local name="$1" ledger="$2" repo="$3" reason="$4" out failed="$STATE_DIR/$1.launch-failed"
  log "$name: relaunching — $reason"
  tmux kill-window -t "${TMUX_SESSION}:$name" 2>/dev/null || true
  out="$(mktemp "${TMPDIR:-/tmp}/fleet-supervisor.XXXXXX")"
  # LAUNCH_CMD is intentionally word-split (it is a command line, not a path)
  # shellcheck disable=SC2086
  if $LAUNCH_CMD "$name" >"$out" 2>&1; then
    cat "$out" >>"$LOG"; rm -f "$out"
    log "$name: relaunched"
    if [ -f "$failed" ]; then
      gh issue comment "$ledger" -R "$repo" --body "✅ fleet-supervisor: \`$name\` relaunched after failed attempts since $(cat "$failed") ($reason, $(date -u +%Y-%m-%dT%H:%M:%SZ)). Startup reconcile recovers state from this ledger + state.md." >/dev/null || true
      rm -f "$failed"
    else
      gh issue comment "$ledger" -R "$repo" --body "🔁 fleet-supervisor: relaunched \`$name\` ($reason, $(date -u +%Y-%m-%dT%H:%M:%SZ)). Startup reconcile recovers state from this ledger + state.md." >/dev/null || true
    fi
  else
    local tail_lines
    tail_lines="$(tail -n 5 "$out" | cut -c1-200)"
    cat "$out" >>"$LOG"; rm -f "$out"
    if [ -f "$failed" ]; then
      log "$name: RELAUNCH FAILED — already escalated (failing since $(cat "$failed")), retrying next tick"
    else
      log "$name: RELAUNCH FAILED — escalating on ledger $repo#$ledger"
      gh issue comment "$ledger" -R "$repo" --body "🚨 fleet-supervisor: relaunch of \`$name\` FAILED ($reason). Operator needed. The supervisor retries every tick without commenting again, and comments once more when a relaunch succeeds. Launcher output:
\`\`\`
${tail_lines:-(no output)}
\`\`\`
Full log: logs/fleet-supervisor/supervisor.log on the host." >/dev/null \
        && date -u +%Y-%m-%dT%H:%M:%SZ >"$failed"
    fi
  fi
}

# Host health: one alert per incident, resolved on recovery. Never stops the tick.
notify() { # notify <args...> → 0 when NOTIFY_CMD ran and succeeded
  [ -n "$NOTIFY_CMD" ] || return 1
  # shellcheck disable=SC2086
  $NOTIFY_CMD "$@" >>"$LOG" 2>&1
}
if [ -n "$HOST_HEALTH_CMD" ]; then
  HEALTH_LATCH="$STATE_DIR/host-health.alerted"
  # shellcheck disable=SC2086
  if HEALTH_MSG=$($HOST_HEALTH_CMD 2>/dev/null); then
    if [ -f "$HEALTH_LATCH" ]; then
      if notify --level info --incident "$HOST_HEALTH_INCIDENT" --resolve "Resolved: host health is ok again (since $(cat "$HEALTH_LATCH") on $(hostname -s 2>/dev/null || echo this host))."; then
        rm -f "$HEALTH_LATCH"; log "host health: ok again, alert $HOST_HEALTH_INCIDENT resolved"
      else
        log "host health: ok again, but resolving alert $HOST_HEALTH_INCIDENT failed (NOTIFY_CMD unset or failing); retrying next tick"
      fi
    fi
  else
    HEALTH_MSG="$(printf '%s' "${HEALTH_MSG:-host health check failed}" | head -n 5)"
    if [ -f "$HEALTH_LATCH" ]; then
      log "host health: still failing, alert $HOST_HEALTH_INCIDENT already posted"
    elif notify --level alert --incident "$HOST_HEALTH_INCIDENT" "$HEALTH_MSG"; then
      date -u +%Y-%m-%dT%H:%M:%SZ >"$HEALTH_LATCH"; log "host health: FAILING, alert $HOST_HEALTH_INCIDENT posted: $HEALTH_MSG"
    else
      log "host health: FAILING, and the alert could not be posted (NOTIFY_CMD unset or failing); retrying next tick: $HEALTH_MSG"
    fi
  fi
fi

NOW=$(date +%s)

for spec in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
  IFS='|' read -r name ledger stale_min repo <<<"$spec"
  [ -n "$name" ] && [ -n "$ledger" ] && [ -n "$stale_min" ] || { log "SKIP bad line: $spec"; continue; }
  if [ -n "$HOST_CHECK_CMD" ]; then
    # word-split on purpose, like LAUNCH_CMD
    # shellcheck disable=SC2086
    if ! WHY=$($HOST_CHECK_CMD "$name" 2>&1); then
      log "$name: not on this host, never touched here ($(printf '%s' "${WHY:-host check failed}" | tail -n 1 | cut -c1-200))"
      continue
    fi
  fi
  REPO_SLUG="${repo:-$DEFAULT_REPO}"
  [ -n "$REPO_SLUG" ] || REPO_SLUG=$(cwd_repo)
  [ -n "$REPO_SLUG" ] || { log "$name: cannot resolve repo (set REPO= or the 4th field; gh auth?) — skipping"; continue; }

  # --- ledger: kill switch + heartbeat ---------------------------------------
  if ! ISSUE=$(gh issue view "$ledger" -R "$REPO_SLUG" --json state,body 2>/dev/null); then
    log "$name: ledger $REPO_SLUG#$ledger unreadable (gh error) — skipping this cycle"
    continue
  fi
  STATE=$(jq -r .state <<<"$ISSUE")
  if [ "$STATE" = "CLOSED" ]; then
    log "$name: ledger $REPO_SLUG#$ledger CLOSED (kill switch) — not touching"
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
  ROTATED="$STATE_DIR/$name.rotated" # the rotation heartbeat we already relaunched for
  MARKED=0; [ -f "$ROTATED" ] && [ "$(cat "$ROTATED")" = "$HB_TS" ] && MARKED=1

  if [ "$ALIVE" = "1" ]; then
    # (relaunched for this rotation but the new session never heartbeated → falls to the stale branch)
    if [ "$ROTATION" = "1" ] && ! { [ "$MARKED" = "1" ] && [ "$STALE" = "1" ]; }; then
      rm -f "$LATCH"
      AGE=$(( (NOW - ${HB_EPOCH:-$NOW}) / 60 ))
      if [ "$MARKED" = "1" ]; then
        log "$name: relaunched for this rotation (${HB_TS}) — waiting for the new session's first heartbeat"
      elif [ -z "$HB_EPOCH" ] || [ "$AGE" -lt "$ROTATE_GRACE_MIN" ]; then
        log "$name: rotation requested ${AGE}m ago — letting it settle (grace ${ROTATE_GRACE_MIN}m)"
      elif pane_busy "$name"; then
        log "$name: rotation requested but the session is still mid-turn — waiting"
      else
        relaunch "$name" "$ledger" "$REPO_SLUG" "rotation requested; session idle at its prompt ${AGE}m after its final heartbeat"
        printf '%s\n' "$HB_TS" >"$ROTATED"
      fi
    elif [ "$STALE" = "1" ]; then
      # hung-or-thinking: never kill; escalate once per incident
      if [ ! -f "$LATCH" ]; then
        gh issue comment "$ledger" -R "$REPO_SLUG" --body "⚠️ fleet-supervisor: heartbeat stale (last: ${HB_TS:-never}) but the \`$name\` process is still alive. Not touching it — a live process is never killed on staleness alone (probe-then-classify is a judgment call, not a script's). Needs a probe: operator or maintenance watchdog." >/dev/null \
          && touch "$LATCH" && log "$name: STALE+ALIVE — escalated on ledger $REPO_SLUG#$ledger"
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
    relaunch "$name" "$ledger" "$REPO_SLUG" "$REASON"
    if [ "$ROTATION" = "1" ]; then printf '%s\n' "$HB_TS" >"$ROTATED"; fi
  elif [ "$ENDED" = "1" ]; then
    log "$name: process exited after 'session end' — deliberate stop, leaving it"
  else
    log "$name: process exited, heartbeat fresh (${HB_TS:-?}) — within grace, waiting"
  fi
done
