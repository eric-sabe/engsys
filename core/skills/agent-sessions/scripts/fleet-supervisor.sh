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
#   Claude Code's login expired (below)          → hold EVERY relaunch, of every
#                                                  session; kill nothing; one
#                                                  action-level alert; resume once
#                                                  the login works
#
# Expired Claude Code login (engsys#103). A relaunched session whose login has expired answers its
# first prompt with Claude Code's own error line (`⏺ Login expired · Please run /login`) and sits idle;
# its launch command still exits 0, so without this check the table above relaunches it every tick and
# nobody is told (2026-10-06: 501 relaunches over ~24 h). Every tick, before the sessions, the supervisor
# reads every live, idle pane in TMUX_SESSION (not only the supervised ones), and after each relaunch it
# watches the new pane for up to AUTH_CHECK_WAIT_SEC. A pane whose LAST message line is one of
# CLAUDE_AUTH_ERRORS (the one list; matched from the start of the message, so a model reply that quotes
# "/login" does not count) is evidence the host's login no longer works. The pane is the signal of record:
# `claude auth status` can report a login that the API rejects.
#   evidence, no hold yet → a test request (AUTH_PROBE, below) succeeds: the error is old, the pane is
#                           acknowledged (logs/fleet-supervisor/auth.acked) and ignored until it shows
#                           something else. Otherwise: hold (state: auth.expired) and post ONE
#                           `NOTIFY_CMD --level action --incident claude-auth-expired` (latch: auth.alerted).
#   held                  → no session is killed or relaunched, for any reason; a relaunch the table
#                           would have made is logged and its session listed (auth.held); the stale-but-
#                           alive ledger comment waits too (the alert already says why). The status-issue
#                           heartbeat carries `auth: expired since <ISO>` plus a line for people.
#   held, then a pane that showed the error answers normally (or shows `⎿ Login successful`), or the test
#                           request succeeds → the hold ends, the alert is resolved, the panes still
#                           showing the old error are acknowledged, and the table runs as usual on the
#                           same tick, so each held session gets its one relaunch through the normal path.
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
#   AUTH_PROBE=on|off          optional (default on): the test request that tells a working login from an
#                              old error line: `claude -p` with one short Haiku prompt, run from an empty
#                              temp dir with only project settings (no plugins, hooks or MCP servers). It
#                              runs only while a pane shows a login error, never on a healthy tick. Off =
#                              the hold ends only when a pane that showed the error answers normally.
#   AUTH_PROBE_TIMEOUT_SEC=<s> optional (default 90): the test request's time limit; a timeout is not a pass
#   AUTH_CHECK_WAIT_SEC=<s>    optional (default 45): how long to watch a freshly relaunched pane for its
#                              first message (a login error holds the rest of the tick); 0 = don't watch
#   STATUS_URL=<url>           optional: the link the login alert carries (`--re`; the fleet kit: its status
#                              issue). Unset = the first session's ledger issue
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

# Text for people (ledger comments) shows times in the operator's zone and clock when the fleet sets
# OPERATOR_TIMEZONE / OPERATOR_CLOCK (fleet-env.sh exports them); the log, latches and every machine
# field stay ISO 8601 UTC. Unset, or any failure, passes the text through unchanged.
OPERATOR_TIME_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../lib" 2>/dev/null && pwd)/operator-time.mjs"
human_text() { # human_text <text> → text with ISO UTC timestamps in the operator's format
  local out
  if [ -n "${OPERATOR_TIMEZONE:-}${OPERATOR_CLOCK:-}" ] && [ -f "$OPERATOR_TIME_LIB" ] && command -v node >/dev/null 2>&1 \
    && out="$(printf '%s' "$1" | node "$OPERATOR_TIME_LIB" humanize 2>/dev/null)"; then
    printf '%s' "$out"
  else
    printf '%s' "$1"
  fi
}

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
AUTH_PROBE=on AUTH_PROBE_TIMEOUT_SEC=90 AUTH_CHECK_WAIT_SEC=45 STATUS_URL=""
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
    AUTH_PROBE=*) AUTH_PROBE="${line#AUTH_PROBE=}" ;;
    AUTH_PROBE_TIMEOUT_SEC=*) AUTH_PROBE_TIMEOUT_SEC="${line#AUTH_PROBE_TIMEOUT_SEC=}" ;;
    AUTH_CHECK_WAIT_SEC=*) AUTH_CHECK_WAIT_SEC="${line#AUTH_CHECK_WAIT_SEC=}" ;;
    STATUS_URL=*) STATUS_URL="${line#STATUS_URL=}" ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "fleet-supervisor: bad conf line: $line" >&2; exit 1 ;;
  esac
done < "$CONF"
[ -n "$TMUX_SESSION" ] && [ -n "$LAUNCH_CMD" ] || { echo "fleet-supervisor: conf must set TMUX_SESSION and LAUNCH_CMD" >&2; exit 1; }
case "$AUTH_PROBE" in on | off) ;; *) echo "fleet-supervisor: AUTH_PROBE must be on or off" >&2; exit 1 ;; esac
for v in AUTH_PROBE_TIMEOUT_SEC AUTH_CHECK_WAIT_SEC; do
  case "${!v}" in '' | *[!0-9]*) echo "fleet-supervisor: $v must be a whole number of seconds" >&2; exit 1 ;; esac
done

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

# --- Claude Code login (engsys#103; header) ------------------------------------------------------
# Claude Code's own error lines for a login that no longer works: the ONE list. Each entry is an ERE
# matched against a message's text (after its "⏺ " / "● " marker), anchored at the start of the
# message; a trailing $ means the whole message. Taken from Claude Code 2.1.285, where they are
# constants rendered as the session's reply. The first is the line every relaunched session showed on
# 2026-10-06/07; "Please run /login · API Error: 401" is the generic authentication_failed reply
# (rendered `⏺ Please run /login · API Error: 401 OAuth access token is invalid.`), and "Failed to
# authenticate." is that reply in print mode (what the test request sees).
CLAUDE_AUTH_ERRORS=(
  'Login expired · Please run /login$'
  'Login expired · Run /login to sign in again'
  'OAuth token revoked · Please run /login$'
  'Not logged in · Please run /login$'
  '(API Error: 401 )?Invalid API key · Please run /login$'
  'Please run /login · API Error: 401'
  'Failed to authenticate\. API Error: 401'
)
AUTH_RE="^($(IFS='|'; printf '%s' "${CLAUDE_AUTH_ERRORS[*]}"))"
AUTH_MSG_RE='^(⏺|●) '                      # a message line: the reply or tool-call marker
AUTH_LOGIN_OK_RE='^ *⎿ +Login successful'  # what /login leaves in the pane once it worked
AUTH_EXPIRED="$STATE_DIR/auth.expired"     # held: line 1 since (ISO UTC), line 2 where it was seen
AUTH_ALERTED="$STATE_DIR/auth.alerted"     # the claude-auth-expired alert is posted and not yet resolved
AUTH_HELD_LIST="$STATE_DIR/auth.held"      # sessions whose relaunch was held, one per line
AUTH_SEEN="$STATE_DIR/auth.panes"          # panes (<window>|<pane id>) that showed the error while held
AUTH_ACKED="$STATE_DIR/auth.acked"         # panes whose error is older than a working login
AUTH_INCIDENT="claude-auth-expired"
AUTH_HELD=0 AUTH_RESUMED="" AUTH_RESOLVE_TEXT=""
HOST_NAME="$(hostname -s 2>/dev/null || echo "this host")"

# auth_state_of <pane text> → error | ok | none: what the pane's last message says. A message that
# follows a login error, or `⎿ Login successful` after it, means the session got past it.
auth_state_of() {
  AUTH_RE="$AUTH_RE" MSG_RE="$AUTH_MSG_RE" OK_RE="$AUTH_LOGIN_OK_RE" awk '
    { sub(/\r$/, ""); sub(/ +$/, "") }
    $0 ~ ENVIRON["MSG_RE"] { m = $0; sub(ENVIRON["MSG_RE"], "", m); s = (m ~ ENVIRON["AUTH_RE"]) ? "error" : "ok"; next }
    $0 ~ ENVIRON["OK_RE"] { if (s == "error") s = "ok" }
    END { print (s == "" ? "none" : s) }' <<<"$1"
}

# Every live pane in TMUX_SESSION that is not mid-turn: AUTH_BLOCKED lists those whose last message is
# a login error (minus acknowledged ones), AUTH_ANSWERED those whose last message is anything else.
# An acknowledged pane stays acknowledged only while it still shows the old error.
auth_scan() {
  AUTH_BLOCKED="" AUTH_ANSWERED=""
  local panes w id cmd text keep=""
  panes="$(tmux list-panes -s -t "$TMUX_SESSION" -F '#{window_name}|#{pane_id}|#{pane_current_command}' 2>/dev/null || true)"
  while IFS='|' read -r w id cmd; do
    [ -n "$id" ] || continue
    case "$cmd" in '' | zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) continue ;; esac
    text="$(tmux capture-pane -p -t "$id" -S -60 2>/dev/null || true)"
    grep -q 'esc to interrupt' <<<"$(tail -n 15 <<<"$text")" && continue
    case "$(auth_state_of "$text")" in
      error)
        if [ -f "$AUTH_ACKED" ] && grep -Fxq "$w|$id" "$AUTH_ACKED"; then keep="$keep$w|$id"$'\n'
        else AUTH_BLOCKED="$AUTH_BLOCKED$w|$id"$'\n'; fi ;;
      ok) AUTH_ANSWERED="$AUTH_ANSWERED$w|$id"$'\n' ;;
    esac
  done <<<"$panes"
  if [ -f "$AUTH_ACKED" ]; then
    if [ -n "$keep" ]; then printf '%s' "$keep" >"$AUTH_ACKED"; else rm -f "$AUTH_ACKED"; fi
  fi
}

auth_add_lines() { # auth_add_lines <file> <lines> → appended, each line once
  local l
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    [ -f "$1" ] && grep -Fxq "$l" "$1" && continue
    printf '%s\n' "$l" >>"$1"
  done <<<"$2"
}

# The test request: does a login work right now? Runs only when a pane shows a login error. Sets AUTH_PROBE_WHY.
auth_probe() {
  AUTH_PROBE_WHY=""
  [ "$AUTH_PROBE" = on ] || { AUTH_PROBE_WHY="no test request (AUTH_PROBE=off)"; return 1; }
  command -v claude >/dev/null 2>&1 || { AUTH_PROBE_WHY="no test request (claude is not on PATH)"; return 1; }
  local dir pid rc=0 waited=0 last
  dir="$(mktemp -d "${TMPDIR:-/tmp}/fleet-supervisor-auth.XXXXXX")"
  (cd "$dir" && exec claude -p --setting-sources project --strict-mcp-config --no-session-persistence --model haiku 'Reply with the single word OK') </dev/null >"$dir.out" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge $((AUTH_PROBE_TIMEOUT_SEC * 2)) ]; then kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.5; waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || rc=$?
  last="$(grep -v '^[[:space:]]*$' "$dir.out" | tail -n 1 | cut -c1-200 || true)"
  rm -rf "$dir" "$dir.out"
  if [ "$rc" = 0 ]; then AUTH_PROBE_WHY="a test request through Claude Code succeeded"; return 0; fi
  if grep -Eq "$AUTH_RE" <<<"$last"; then AUTH_PROBE_WHY="the test request failed the same way: $last"
  else AUTH_PROBE_WHY="the test request did not succeed (exit $rc): ${last:-no output}"; fi
  return 1
}

auth_alert() { # the incident's one alert; retried each tick while held until it is posted
  [ ! -f "$AUTH_ALERTED" ] || return 0
  local re="$STATUS_URL" r l text
  if [ -z "$re" ] && [ "${#SESSIONS[@]}" -gt 0 ]; then
    IFS='|' read -r _ l _ r _ _ <<<"${SESSIONS[0]}"
    r="${r:-$DEFAULT_REPO}"
    [ -z "$r" ] || [ -z "$l" ] || re="https://github.com/$r/issues/$l"
  fi
  text="Claude Code login expired on $HOST_NAME. Run \`/login\` in any session (or \`claude /login\`); the fleet resumes on the next supervisor tick. Until then the supervisor relaunches and kills nothing. First seen $(head -n 1 "$AUTH_EXPIRED") in $(sed -n 2p "$AUTH_EXPIRED")."
  if [ -n "$re" ]; then set -- --level action --re "$re"; else set -- --level alert; fi # action needs a link
  if notify "$@" --incident "$AUTH_INCIDENT" "$text"; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$AUTH_ALERTED"; log "auth: alert $AUTH_INCIDENT posted"
  else
    log "auth: alert $AUTH_INCIDENT could not be posted (NOTIFY_CMD unset or failing); retrying next tick"
  fi
}

auth_resolve_post() { # resolve the alert; retried each tick until it goes out
  [ -f "$AUTH_ALERTED" ] || return 0
  if notify --level info --incident "$AUTH_INCIDENT" --resolve "${AUTH_RESOLVE_TEXT:-Resolved: Claude Code login works again on $HOST_NAME.}"; then
    rm -f "$AUTH_ALERTED"; log "auth: alert $AUTH_INCIDENT resolved"
  else
    log "auth: resolving alert $AUTH_INCIDENT failed (NOTIFY_CMD unset or failing); retrying next tick"
  fi
}

auth_begin() { # auth_begin <where it was seen> <panes> → hold from now on
  [ "$AUTH_HELD" = 0 ] || return 0
  [ -f "$AUTH_EXPIRED" ] || printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >"$AUTH_EXPIRED"
  AUTH_HELD=1
  auth_add_lines "$AUTH_SEEN" "$2"
  log "auth: Claude Code login expired (seen in $1; $AUTH_PROBE_WHY). Holding every relaunch until it works; nothing is killed"
  auth_alert
}

auth_held_names() { # the held sessions as "a, b" ('' when none)
  [ -s "$AUTH_HELD_LIST" ] || return 0
  paste -sd, - <"$AUTH_HELD_LIST" | sed 's/,/, /g'
}

auth_resume() { # auth_resume <how we know> → the hold ends; the table runs as usual this tick
  local since held
  since="$(head -n 1 "$AUTH_EXPIRED")"
  held="$(auth_held_names)"
  auth_add_lines "$AUTH_ACKED" "$AUTH_BLOCKED" # panes still showing the old error must not start a new hold
  AUTH_RESUMED="$(cat "$AUTH_HELD_LIST" 2>/dev/null || true)"
  AUTH_RESOLVE_TEXT="Resolved: Claude Code login works again on $HOST_NAME ($1); it had been expired since $since. ${held:+Relaunching the held sessions once each: $held.}"
  rm -f "$AUTH_EXPIRED" "$AUTH_SEEN" "$AUTH_HELD_LIST"
  log "auth: Claude Code login works again ($1); relaunches resume${held:+, held sessions go through the table once: $held}"
  auth_resolve_post
}

auth_hold() { # auth_hold <name> <what the table would have done> → logged and listed, nothing touched
  log "$1: $2, but held: Claude Code login expired since $(head -n 1 "$AUTH_EXPIRED" 2>/dev/null) (nothing is killed or relaunched until it works)"
  auth_add_lines "$AUTH_HELD_LIST" "$1"
}

auth_after_launch() { # auth_after_launch <name> → watch the fresh pane for its first message
  local waited=0 text
  while :; do
    text="$(tmux capture-pane -p -t "${TMUX_SESSION}:$1" -S -60 2>/dev/null || true)"
    case "$(auth_state_of "$text")" in
      error)
        AUTH_PROBE_WHY="its first reply was a login error"
        auth_begin "\`$1\`, right after its relaunch" "$1|$(tmux list-panes -t "${TMUX_SESSION}:$1" -F '#{pane_id}' 2>/dev/null | head -1 || true)"
        return 0 ;;
      ok) return 0 ;;
    esac
    [ "$waited" -lt "$AUTH_CHECK_WAIT_SEC" ] || return 0
    sleep 2; waited=$((waited + 2))
  done
}

# Kill the window (if any) and launch the session fresh; report on the ledger.
# A failed launch is escalated ONCE per incident (latch: <name>.launch-failed) with the launcher's own
# error lines, then retried quietly every tick; the first successful launch after that clears the latch
# and says so. Without the latch a persistent cause (e.g. claude not on the job's PATH) posts a comment
# every tick and buries the alert.
relaunch() { # relaunch <name> <ledger> <repo> <reason>
  local name="$1" ledger="$2" repo="$3" reason="$4" out failed="$STATE_DIR/$1.launch-failed"
  # the last line of defence for the login hold: whatever path got here, nothing is killed or relaunched
  if [ "$AUTH_HELD" = 1 ]; then auth_hold "$name" "relaunch due ($reason)"; return 0; fi
  if [ -n "$AUTH_RESUMED" ] && grep -Fxq "$name" <<<"$AUTH_RESUMED"; then
    reason="$reason; held while Claude Code's login was expired"
  fi
  local reason_h; reason_h="$(human_text "$reason")" # the comments read to a person; the log keeps $reason as is
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
      gh issue comment "$ledger" -R "$repo" --body "✅ fleet-supervisor: \`$name\` relaunched after failed attempts since $(human_text "$(cat "$failed")") ($reason_h, $(human_text "$(date -u +%Y-%m-%dT%H:%M:%SZ)")). Startup reconcile recovers state from this ledger + state.md." >/dev/null || true
      rm -f "$failed"
    else
      gh issue comment "$ledger" -R "$repo" --body "🔁 fleet-supervisor: relaunched \`$name\` ($reason_h, $(human_text "$(date -u +%Y-%m-%dT%H:%M:%SZ)")). Startup reconcile recovers state from this ledger + state.md." >/dev/null || true
    fi
    # the launch command exits 0 even when the new session can't log in: read its first reply
    [ "$AUTH_CHECK_WAIT_SEC" = 0 ] || auth_after_launch "$name"
  else
    local tail_lines
    tail_lines="$(tail -n 5 "$out" | cut -c1-200)"
    cat "$out" >>"$LOG"; rm -f "$out"
    if [ -f "$failed" ]; then
      log "$name: RELAUNCH FAILED — already escalated (failing since $(cat "$failed")), retrying next tick"
    else
      log "$name: RELAUNCH FAILED — escalating on ledger $repo#$ledger"
      gh issue comment "$ledger" -R "$repo" --body "🚨 fleet-supervisor: relaunch of \`$name\` FAILED ($reason_h). Operator needed. The supervisor retries every tick without commenting again, and comments once more when a relaunch succeeds. Launcher output:
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

# Claude Code login (header): read the panes, then hold, keep holding, or resume.
auth_scan
if [ -f "$AUTH_EXPIRED" ]; then
  AUTH_HOW=""
  if [ -f "$AUTH_SEEN" ] && [ -n "$AUTH_ANSWERED" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] && grep -Fxq "$p" <<<"$AUTH_ANSWERED" && { AUTH_HOW="\`${p%%|*}\` answered normally after the error"; break; }
    done <"$AUTH_SEEN"
  fi
  if [ -z "$AUTH_HOW" ] && auth_probe; then AUTH_HOW="$AUTH_PROBE_WHY"; fi
  if [ -n "$AUTH_HOW" ]; then
    auth_resume "$AUTH_HOW"
  else
    AUTH_HELD=1
    auth_add_lines "$AUTH_SEEN" "$AUTH_BLOCKED"
    log "auth: still expired (since $(head -n 1 "$AUTH_EXPIRED")): holding every relaunch; $AUTH_PROBE_WHY"
    auth_alert
  fi
elif [ -n "$AUTH_BLOCKED" ]; then
  AUTH_FIRST="${AUTH_BLOCKED%%$'\n'*}"
  if auth_probe; then
    auth_add_lines "$AUTH_ACKED" "$AUTH_BLOCKED"
    log "auth: \`${AUTH_FIRST%%|*}\` shows a login error, but $AUTH_PROBE_WHY: an old error, ignored until that pane shows something else"
  else
    auth_begin "the \`${AUTH_FIRST%%|*}\` window" "$AUTH_BLOCKED"
  fi
else
  auth_resolve_post # a resolve that failed to post on the tick the hold ended
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
      elif [ "$AUTH_HELD" = 1 ]; then
        auth_hold "$name" "rotation requested ${AGE}m ago, session idle at its prompt"
      elif [ -n "$role" ] && ! singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
        log "$name: rotation requested, but a relaunch is held (baton or integrity) — waiting ($BATON_WHY)"
      else
        relaunch "$name" "$ledger" "$REPO_SLUG" "rotation requested; session idle at its prompt ${AGE}m after its final heartbeat"
        printf '%s\n' "$HB_TS" >"$ROTATED"
      fi
    elif [ "$STALE" = "1" ]; then
      DOWN=$((DOWN + 1))
      # hung-or-thinking: never kill; escalate once per incident. The one exception is a singleton
      # monster idle at its prompt whose baton is forfeited (header). While the login is held, neither:
      # the relaunch waits, and so does the ledger comment (the login alert already says why).
      if [ "$AUTH_HELD" = 1 ]; then
        if [ -n "$role" ] && ! pane_busy "$name"; then auth_hold "$name" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt"
        else log "$name: STALE+ALIVE — ledger comment deferred while Claude Code's login is expired"; fi
      elif [ -n "$role" ] && ! pane_busy "$name" && singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
        rm -f "$LATCH"
        relaunch "$name" "$ledger" "$REPO_SLUG" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt, $role baton forfeited ($BATON_WHY)"
      elif [ ! -f "$LATCH" ]; then
        gh issue comment "$ledger" -R "$REPO_SLUG" --body "⚠️ fleet-supervisor: heartbeat stale (last: $(human_text "${HB_TS:-never}")) but the \`$name\` process is still alive. Not touching it — a live process is never killed on staleness alone (probe-then-classify is a judgment call, not a script's). Needs a probe: operator or maintenance watchdog." >/dev/null \
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
      if [ "$AUTH_HELD" = 1 ]; then
        auth_hold "$name" "the $role baton expired still naming this session, session idle at its prompt"
      else
        relaunch "$name" "$ledger" "$REPO_SLUG" "the $role baton expired still naming this session (last heartbeat ${HB_TS}), session idle at its prompt ($BATON_WHY)"
        printf '%s\n' "$HB_TS" >"$STATE_DIR/$name.forfeit"
      fi
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
    if [ "$AUTH_HELD" = 1 ]; then auth_hold "$name" "$REASON"; continue; fi
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
    set -- "$SUMMARY"
    if [ "$AUTH_HELD" = 1 ]; then
      # the summary keeps machine fields in ISO UTC; the second line is for people (operator's time, #89)
      AUTH_SINCE="$(head -n 1 "$AUTH_EXPIRED")"
      AUTH_HELD_NAMES="$(auth_held_names)"
      SUMMARY="$SUMMARY; auth: expired since $AUTH_SINCE, relaunches held"
      set -- "$SUMMARY" "$(human_text "Claude Code login expired on $HOST_NAME since $AUTH_SINCE. Run \`/login\` in any session (or \`claude /login\`); the fleet resumes on the next supervisor tick.${AUTH_HELD_NAMES:+ Relaunches held: $AUTH_HELD_NAMES.}")"
    fi
    # shellcheck disable=SC2086
    if $HEARTBEAT_CMD "$@" >>"$LOG" 2>&1; then
      printf '%s\n' "$MINUTE_NOW" >"$MINUTE_LATCH"
      log "heartbeat: $SUMMARY"
    else
      log "heartbeat: HEARTBEAT_CMD failed (soft) — $SUMMARY"
    fi
  else
    log "heartbeat: already written this minute ($MINUTE_NOW) — skipping"
  fi
fi
