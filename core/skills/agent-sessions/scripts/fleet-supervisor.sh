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
#   singleton monster (6th field merge|maintain) → every relaunch above also needs
#                                                  the BATON to allow it (below),
#                                                  and INTEGRITY_CMD to pass
#   any relaunch that FAILS                      → escalate once on the ledger
#                                                  (with the launcher's error),
#                                                  retry each tick quietly,
#                                                  comment again on recovery
#
# Singleton monsters (engsys#62): a session line whose 6th field is `merge` or `maintain` holds that
# role through the github lease (core/lib/lease/baton.mjs), and the lease, not the shared ledger
# heartbeat, says who holds it. Before ANY relaunch of such a session the supervisor asks the lease
# (`baton.mjs supervise`): relaunch only when this fleet is the role's home (federation.yml; always,
# in single-fleet mode) AND nobody holds a live baton (free, released, expired, or malformed). A live
# baton held by another fleet's session, or by this session itself, is a wait: a relaunched session
# could not act on it. A lease or registry read that fails is a wait too, alerted ONCE via NOTIFY_CMD
# (incident baton-read-<name>, resolved when it reads clean). Three triggers exist only for them:
#   heartbeat "handover" + proc exited          → relaunch when the baton allows (the old home released
#                                                  it; its heartbeat on the shared ledger is fresh)
#   heartbeat stale + proc ALIVE, idle at its    → relaunch when the baton allows: a session whose
#     prompt                                       lease ran out (lost, or wedged) never renews again,
#                                                  so staleness + idle + a forfeited lease is three
#                                                  signals, not one. Mid-turn stays never-killed.
#   heartbeat >= FORFEIT_CHECK_MIN old (not yet  → relaunch when `supervise` reports the baton EXPIRED
#     stale, not "session end" / "handover") +     with its tip still naming this session
#     proc ALIVE, idle at its prompt               (`forfeited: true`, engsys#87): the session let its
#                                                  lease run out and stopped on BATON_LOST, so it can
#                                                  never act again; waiting for staleness only leaves
#                                                  the role empty. The lease is read only once the
#                                                  heartbeat is a TTL old, so a healthy session (which
#                                                  heartbeats at most every 10 min) costs ~no reads.
#                                                  Once per heartbeat (latch: <name>.forfeit).
#
# Ledger target moves (engsys#72): the supervisor records, per session, the ledger target it last
# launched the session against (logs/fleet-supervisor/<name>.target: repo|issue|marker|launch-epoch).
# When the configured target later differs (a monster moved from a per-repo ledger issue to the fleet
# status issue's block), a session still running the old version posts `rotation requested` on the
# OLD target, which the supervisor no longer reads. So while the recorded target differs, the old
# target is also read; a `rotation requested` on it, newer than the launch, is honoured exactly like
# one on the new target. Relaunching records the new target, which ends the double read. A session
# with no record is assumed to have been launched against the current target (nothing to compare).
# Rule: when a session's ledger target changes, the rotation handshake must be readable on both
# sides during the transition.
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
#   HEARTBEAT_CMD=<command>    optional: called once per tick as `<cmd> "<one-
#                              line summary>"` (the fleet kit: `fleet
#                              heartbeat`), after every session is classified,
#                              so the fleet's own status issue carries a fresh
#                              `<!-- fleet-heartbeat -->` marker for cross-
#                              fleet work claiming (core/lib/claim.mjs) to read.
#                              Skipped when the UTC minute hasn't changed since
#                              the last call (state: heartbeat.last-minute) or
#                              there were no sessions to classify this tick.
#                              Unset, or the command itself a no-op (single-
#                              fleet mode, no status_issue) or failing = never
#                              stops the tick.
#   BATON_CMD=<command>        optional: the lease check for singleton monsters, called as
#                              `<cmd> --repo <r> --role <role> --session <name>`; prints one JSON
#                              line; exit 0 = may relaunch, 1 = held / not home, anything else =
#                              error (no relaunch, alert once). Default: node core/lib/lease/baton.mjs
#                              supervise (reads FLEET_ID / FEDERATION_FILE from the environment).
#   INTEGRITY_CMD=<command>    optional: run once per tick, before the sessions, when any session
#                              line has a 6th field. Exit 0 = the plugin files that guard the
#                              singleton monsters are intact. Anything else (1 = they don't match
#                              their release, 3 = it couldn't check) holds every relaunch of a
#                              session with a 6th field this tick, fail closed; running ones are
#                              never killed for it. The command alerts on its own, once per
#                              incident (the fleet kit: `fleet verify --alert --max-age N`,
#                              engsys#70); a held relaunch is also said once on that session's
#                              ledger.
#   <session-name>|<ledger-issue>|<stale-minutes>[|<owner/name>[|<marker>[|<role>]]]
#                              one line per monster; the 4th field overrides
#                              REPO= for that session (multi-repo fleets).
#                              The 5th names the block to read the heartbeat
#                              from: only a `last:` line between
#                              `<!-- <marker> -->` and `<!-- /<marker> -->`
#                              counts. Use it when one issue carries several
#                              heartbeats (a fleet status issue: the broker's
#                              broker-heartbeat block beside the supervisor's
#                              own fleet-heartbeat). Without it, the first
#                              `last:` line in the body counts, as before.
#                              The 6th, `merge` or `maintain`, marks a singleton monster
#                              (above). The fleet kit's `fleet supervise` fills it in from the
#                              roster; leave the 4th and 5th empty to skip them (acme-mm|7|60|||merge).
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
HOST_HEALTH_CMD="" HOST_HEALTH_INCIDENT="host-health" NOTIFY_CMD="" HEARTBEAT_CMD="" BATON_CMD="" INTEGRITY_CMD=""
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
    HEARTBEAT_CMD=*) HEARTBEAT_CMD="${line#HEARTBEAT_CMD=}" ;;
    BATON_CMD=*) BATON_CMD="${line#BATON_CMD=}" ;;
    INTEGRITY_CMD=*) INTEGRITY_CMD="${line#INTEGRITY_CMD=}" ;;
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

# Heartbeat of a ledger body: prints `<ts>|<status>` for the first `last:` line, or only the one
# inside `<!-- marker -->` … `<!-- /marker -->` when a marker is given.
hb_of() { # hb_of <body> <marker>
  if [ -n "$2" ]; then
    printf '%s\n' "$1" | awk -v m="$2" '{ sub(/\r$/, "") } $0 == "<!-- " m " -->" { on = 1; next } $0 == "<!-- /" m " -->" { on = 0 } on' \
      | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1
  else
    printf '%s\n' "$1" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1
  fi
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
    printf '%s|%s\n' "${CUR_TARGET:-$repo|$ledger|}" "$(date +%s)" >"$STATE_DIR/$name.target"
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
# Singleton monsters: may this session be relaunched, as far as the lease is concerned? Sets BATON_WHY.
# Fails closed: anything but a clean "may relaunch" is a wait, and a read error alerts once per
# incident (latch: <name>.baton-alerted), resolved on the first clean read after it.
BATON_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/lease/baton.mjs"
FORFEIT_CHECK_MIN=10 # the baton TTL (baton.mjs TTL_MINUTES): no younger heartbeat can sit on an expired lease
baton_allows() { # baton_allows <name> <repo> <role> → 0 may relaunch
  local name="$1" repo="$2" role="$3" out rc=0 latch="$STATE_DIR/$1.baton-alerted"
  if [ -n "$BATON_CMD" ]; then
    # shellcheck disable=SC2086 # a command line, like LAUNCH_CMD
    out=$($BATON_CMD --repo "$repo" --role "$role" --session "$name" 2>&1) || rc=$?
  else
    out=$(node "$BATON_LIB" supervise --repo "$repo" --role "$role" --session "$name" 2>&1) || rc=$?
  fi
  out="$(printf '%s' "$out" | tail -n 1 | cut -c1-300)"
  BATON_WHY="$(printf '%s' "$out" | jq -r '"\(.code): \(.reason)"' 2>/dev/null || printf '%s' "$out")"
  BATON_FORFEITED="$(printf '%s' "$out" | jq -r 'if .forfeited == true then 1 else 0 end' 2>/dev/null || echo 0)"
  if [ "$rc" = 0 ] || [ "$rc" = 1 ]; then
    if [ -f "$latch" ]; then
      if notify --level info --incident "baton-read-$name" --resolve "Resolved: the $role baton for $repo reads clean again (since $(cat "$latch"))."; then rm -f "$latch"; fi
    fi
    return "$rc"
  fi
  if [ -f "$latch" ]; then
    log "$name: baton unreadable (exit $rc) — already alerted, not relaunching: $BATON_WHY"
  elif notify --level alert --incident "baton-read-$name" "fleet-supervisor: can't read the $role baton for $repo (exit $rc: $BATON_WHY). Not relaunching \`$name\` until it reads clean: a relaunch with an unknown holder could start a second $role monster."; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$latch"; log "$name: baton unreadable (exit $rc) — alerted, not relaunching: $BATON_WHY"
  else
    log "$name: baton unreadable (exit $rc), and the alert could not be posted (NOTIFY_CMD unset or failing); retrying next tick: $BATON_WHY"
  fi
  return 2
}

# Singleton monsters: the integrity check (INTEGRITY_CMD, once per tick) and then the lease. Sets BATON_WHY.
# A relaunch held by the integrity check is said once on the session's ledger (latch:
# <name>.integrity-held), cleared by the first passing check (engsys#86 review L1).
INTEGRITY_BLOCKED=0 INTEGRITY_WHY=""
singleton_allows() { # singleton_allows <name> <repo> <role> <ledger> → 0 may relaunch
  local held="$STATE_DIR/$1.integrity-held"
  if [ "$INTEGRITY_BLOCKED" = 1 ]; then
    BATON_WHY="plugin integrity: $INTEGRITY_WHY (fleet verify)"
    if [ ! -f "$held" ]; then
      gh issue comment "$4" -R "$2" --body "⏸️ fleet-supervisor: \`$1\` needs a relaunch, but it is held: $INTEGRITY_WHY. The supervisor relaunches it on its own once \`fleet verify\` passes on the host; the details went to the fleet's alert channel." >/dev/null \
        && date -u +%Y-%m-%dT%H:%M:%SZ >"$held"
    fi
    return 2
  fi
  rm -f "$held"
  baton_allows "$1" "$2" "$3"
}
if [ -n "$INTEGRITY_CMD" ]; then
  for spec in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
    IFS='|' read -r _ _ _ _ _ s_role <<<"$spec"
    [ -n "$s_role" ] || continue
    # shellcheck disable=SC2086 # a command line, like LAUNCH_CMD
    INTEGRITY_RC=0; INTEGRITY_OUT=$($INTEGRITY_CMD 2>&1 </dev/null) || INTEGRITY_RC=$?
    printf '%s\n' "$INTEGRITY_OUT" >>"$LOG"
    case "$INTEGRITY_RC" in
      0) log "integrity: ok"; rm -f "$STATE_DIR"/*.integrity-held ;;
      1) INTEGRITY_BLOCKED=1 INTEGRITY_WHY="the engsys plugin on this host does not match its release"
         log "integrity: MISMATCH, no merge/maintain session is relaunched this tick; running ones are left alone (alert: INTEGRITY_CMD)" ;;
      *) INTEGRITY_BLOCKED=1 INTEGRITY_WHY="the engsys plugin check could not run (exit $INTEGRITY_RC)"
         log "integrity: the check could not run (exit $INTEGRITY_RC), so no merge/maintain session is relaunched this tick (fail closed): $(printf '%s' "$INTEGRITY_OUT" | tail -n 1 | cut -c1-200)" ;;
    esac
    break
  done
fi

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

# Tallied as each session is classified below, for the once-per-tick heartbeat summary. A session
# skipped before classification (bad conf line, not on this host, closed/unreadable ledger) is left
# out of the tally entirely — it was never actually weighed.
UP=0 ROTATING=0 DOWN=0

for spec in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
  IFS='|' read -r name ledger stale_min repo marker role <<<"$spec"
  [ -n "$name" ] && [ -n "$ledger" ] && [ -n "$stale_min" ] || { log "SKIP bad line: $spec"; continue; }
  case "$marker" in *[!a-z0-9-]*) log "SKIP bad line (marker must be lowercase letters, digits, hyphens): $spec"; continue ;; esac
  case "$role" in '' | merge | maintain) ;; *) log "SKIP bad line (6th field must be merge or maintain): $spec"; continue ;; esac
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
  # only the line inside this session's own block when a marker is given (a shared status issue)
  HB=$(hb_of "$(jq -r .body <<<"$ISSUE")" "$marker")
  HB_TS="${HB%%|*}"
  HB_STATUS="${HB#*|}"
  HB_EPOCH=$(iso_to_epoch "$HB_TS")

  # --- moved ledger target: honour a rotation request left on the old one (engsys#72) -----------
  CUR_TARGET="$REPO_SLUG|$ledger|$marker"
  TARGET_FILE="$STATE_DIR/$name.target"
  if [ -f "$TARGET_FILE" ]; then
    IFS='|' read -r OLD_REPO OLD_LEDGER OLD_MARKER OLD_LAUNCH <"$TARGET_FILE" || true
    if [ "$OLD_REPO|$OLD_LEDGER|$OLD_MARKER" != "$CUR_TARGET" ]; then
      if OLD_ISSUE=$(gh issue view "$OLD_LEDGER" -R "$OLD_REPO" --json state,body 2>/dev/null) \
        && [ "$(jq -r .state <<<"$OLD_ISSUE")" != "CLOSED" ]; then
        OLD_HB=$(hb_of "$(jq -r .body <<<"$OLD_ISSUE")" "$OLD_MARKER")
        OLD_EPOCH=$(iso_to_epoch "${OLD_HB%%|*}")
        case "${OLD_HB#*|}" in
          *[Rr]otation\ requested*)
            if [ -n "$OLD_EPOCH" ] && [ "$OLD_EPOCH" -gt "${OLD_LAUNCH:-0}" ]; then
              log "$name: ledger target moved ($OLD_REPO#$OLD_LEDGER → $REPO_SLUG#$ledger); honouring the rotation request on the old target (${OLD_HB%%|*})"
              HB="$OLD_HB" HB_TS="${OLD_HB%%|*}" HB_STATUS="${OLD_HB#*|}" HB_EPOCH="$OLD_EPOCH"
            fi ;;
        esac
      fi
    fi
  else
    printf '%s|%s\n' "$CUR_TARGET" "$NOW" >"$TARGET_FILE" # first sight: assume launched against the current target
  fi

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
  HANDOVER=0 # singleton monsters only: the old home released the role (engsys#62)
  if [ -n "$role" ]; then case "$HB_STATUS" in *[Hh]andover*) HANDOVER=1 ;; esac; fi

  LATCH="$STATE_DIR/$name.escalated"
  ROTATED="$STATE_DIR/$name.rotated" # the rotation heartbeat we already relaunched for
  MARKED=0; [ -f "$ROTATED" ] && [ "$(cat "$ROTATED")" = "$HB_TS" ] && MARKED=1

  if [ "$ALIVE" = "1" ]; then
    # (relaunched for this rotation but the new session never heartbeated → falls to the stale branch)
    if [ "$ROTATION" = "1" ] && ! { [ "$MARKED" = "1" ] && [ "$STALE" = "1" ]; }; then
      ROTATING=$((ROTATING + 1))
      rm -f "$LATCH"
      AGE=$(( (NOW - ${HB_EPOCH:-$NOW}) / 60 ))
      if [ "$MARKED" = "1" ]; then
        log "$name: relaunched for this rotation (${HB_TS}) — waiting for the new session's first heartbeat"
      elif [ -z "$HB_EPOCH" ] || [ "$AGE" -lt "$ROTATE_GRACE_MIN" ]; then
        log "$name: rotation requested ${AGE}m ago — letting it settle (grace ${ROTATE_GRACE_MIN}m)"
      elif pane_busy "$name"; then
        log "$name: rotation requested but the session is still mid-turn — waiting"
      elif [ -n "$role" ] && ! singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
        log "$name: rotation requested, but a relaunch is held (baton or integrity) — waiting ($BATON_WHY)"
      else
        relaunch "$name" "$ledger" "$REPO_SLUG" "rotation requested; session idle at its prompt ${AGE}m after its final heartbeat"
        printf '%s\n' "$HB_TS" >"$ROTATED"
      fi
    elif [ "$STALE" = "1" ]; then
      DOWN=$((DOWN + 1))
      # hung-or-thinking: never kill; escalate once per incident. The one exception is a singleton
      # monster idle at its prompt whose baton is forfeited (header).
      if [ -n "$role" ] && ! pane_busy "$name" && singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
        rm -f "$LATCH"
        relaunch "$name" "$ledger" "$REPO_SLUG" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt, $role baton forfeited ($BATON_WHY)"
      elif [ ! -f "$LATCH" ]; then
        gh issue comment "$ledger" -R "$REPO_SLUG" --body "⚠️ fleet-supervisor: heartbeat stale (last: ${HB_TS:-never}) but the \`$name\` process is still alive. Not touching it — a live process is never killed on staleness alone (probe-then-classify is a judgment call, not a script's). Needs a probe: operator or maintenance watchdog." >/dev/null \
          && touch "$LATCH" && log "$name: STALE+ALIVE — escalated on ledger $REPO_SLUG#$ledger"
      else
        log "$name: STALE+ALIVE — already escalated, holding"
      fi
    elif [ -n "$role" ] && [ "$ENDED" = "0" ] && [ "$HANDOVER" = "0" ] && [ -n "$HB_EPOCH" ] \
      && [ $(( (NOW - HB_EPOCH) / 60 )) -ge "$FORFEIT_CHECK_MIN" ] \
      && [ "$(cat "$STATE_DIR/$name.forfeit" 2>/dev/null || true)" != "$HB_TS" ] && ! pane_busy "$name" \
      && baton_allows "$name" "$REPO_SLUG" "$role" && [ "$BATON_FORFEITED" = "1" ]; then
      # the session let its lease run out (header): relaunch now instead of after stale_min. Once per
      # heartbeat: the relaunched session carries the same holder name, so until it heartbeats the
      # lease still reads "expired, naming this session"; if it never does, the stale branch takes over.
      DOWN=$((DOWN + 1))
      rm -f "$LATCH"
      relaunch "$name" "$ledger" "$REPO_SLUG" "the $role baton expired still naming this session (last heartbeat ${HB_TS}), session idle at its prompt ($BATON_WHY)"
      printf '%s\n' "$HB_TS" >"$STATE_DIR/$name.forfeit"
    else
      UP=$((UP + 1))
      rm -f "$LATCH"
      log "$name: alive, heartbeat ok — nothing to do"
    fi
    continue
  fi

  # --- process exited ---------------------------------------------------------
  rm -f "$LATCH"
  if [ "$ROTATION" = "1" ] || [ "$HANDOVER" = "1" ] || { [ "$STALE" = "1" ] && [ "$ENDED" = "0" ]; }; then
    if [ "$ROTATION" = "1" ] || [ "$HANDOVER" = "1" ]; then ROTATING=$((ROTATING + 1)); else DOWN=$((DOWN + 1)); fi
    if [ "$ROTATION" = "1" ]; then REASON="rotation requested"
    elif [ "$HANDOVER" = "1" ]; then REASON="handover (${HB_STATUS})"
    else REASON="crash recovery (stale heartbeat, process gone)"; fi
    if [ -n "$role" ] && ! singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
      log "$name: $REASON, but a relaunch is held (baton or integrity) — waiting ($BATON_WHY)"
      continue
    fi
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
    DOWN=$((DOWN + 1))
    log "$name: process exited after 'session end' — deliberate stop, leaving it"
  else
    DOWN=$((DOWN + 1))
    log "$name: process exited, heartbeat fresh (${HB_TS:-?}) — within grace, waiting"
  fi
done

# Status-issue heartbeat: once per tick (deduped to once per UTC minute, in case a tick is ever
# re-entered at the same minute), after every session above has been classified. Fail soft and
# cheap — this never blocks or repeats within the same tick.
if [ -n "$HEARTBEAT_CMD" ] && [ $((UP + ROTATING + DOWN)) -gt 0 ]; then
  MINUTE_NOW=$(date -u +%Y-%m-%dT%H:%M)
  MINUTE_LATCH="$STATE_DIR/heartbeat.last-minute"
  if [ ! -f "$MINUTE_LATCH" ] || [ "$(cat "$MINUTE_LATCH")" != "$MINUTE_NOW" ]; then
    SUMMARY="sessions: $UP up, $ROTATING rotating, $DOWN down"
    # shellcheck disable=SC2086
    if $HEARTBEAT_CMD "$SUMMARY" >>"$LOG" 2>&1; then
      printf '%s\n' "$MINUTE_NOW" >"$MINUTE_LATCH"
      log "heartbeat: $SUMMARY"
    else
      log "heartbeat: HEARTBEAT_CMD failed (soft) — $SUMMARY"
    fi
  else
    log "heartbeat: already written this minute ($MINUTE_NOW) — skipping"
  fi
fi
