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
#   held, then the test request succeeds (with AUTH_PROBE=off: a pane that showed the error answers normally;
#                           with it on a pane's reply is not enough, engsys#207: a Remote Control notice once
#                           ended a hold while the credential was still empty) → the hold ends, the alert is resolved, the panes still
#                           showing the old error are acknowledged, and the table runs as usual on the
#                           same tick, so each held session gets its one relaunch through the normal path.
#
# Seat limit hold (ff-engsys-fleet#54). When the LAST message of a pane the supervisor launched is Claude Code's
# usage-limit line (`You've hit your [weekly ]limit · resets Oct 20, 9pm (America/New_York)`), the supervisor
# parses the reset time and records logs/fleet-supervisor/<session>.limit-hold (reset, resume_at, rehits).
# While it lasts the decision table skips that session: no stale-heartbeat escalation, no relaunch. After the
# reset plus LIMIT_RESUME_MARGIN_SEC it resumes the session: an idle pane is re-prompted (tmux send-keys), an
# exited one is relaunched (through the same baton/integrity gates as any relaunch), the hold is cleared and
# the seat-limit alert resolves with one info notice naming what resumed. A session that hits the limit again
# within 30 minutes of a resume waits an extra 10 minutes, doubling per re-hit up to 4 h, so it cannot loop.
# A hold also ends when the pane shows something else or is working again (a person got there first), and
# waits while the login hold is on. A reset time that cannot be read (no zone, no clock time, unknown zone, more
# than 8 days out) writes no hold: the alert-only behaviour. Panes the supervisor did not launch never count.
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
#   SESSION_CONFIG_DIR_BASE=<dir> optional (engsys#205, one login per session): every supervised session has its own Claude
#                              config dir <dir>/<name>. The login hold, its alert (claude-auth-expired-<name>) and its
#                              test request then run per session, on that dir; the others keep running.
#   INTEGRITY_SESSION_CMD=<cmd> optional, with SESSION_CONFIG_DIR_BASE: instead of INTEGRITY_CMD, asked as `<cmd> <session>`
#                              for each singleton session once per tick (the fleet kit: `fleet verify ... --session`);
#                              the verdict holds only that session's relaunch.
#   INTEGRITY_CMD=<command>    optional: run once per tick, before the sessions, when any session
#                              line has a 6th field. Exit 0 = the plugin files that guard the
#                              singleton monsters are intact. Anything else (1 = they don't match
#                              their release, 3 = it couldn't check) holds every relaunch of a
#                              session with a 6th field this tick, fail closed; running ones are
#                              never killed for it and their batons are never revoked or broken
#                              (a dead or stale one is relaunched once it passes, as the table says).
#                              The command alerts on its own, once per
#                              incident (the fleet kit: `fleet verify --alert --auto-sync --max-age N`,
#                              engsys#70); a held relaunch is also said once on that session's
#                              ledger.
#   LIMIT_RESUME=on|off        optional (default on): hold a session that hit the Claude usage limit and resume it
#                              after the reset (see "Seat limit hold" above); off = alert only
#   LIMIT_RESUME_MARGIN_SEC=<s> optional (default 120): how long after the reset time in the limit message the
#                              session is resumed
#   AUTH_PROBE=on|off          optional (default on): the test request that tells a working login from an
#                              old error line: `claude -p` with one short Haiku prompt, run from an empty
#                              temp dir with only project settings (no plugins, hooks or MCP servers). It
#                              runs only while a pane shows a login error, never on a healthy tick. Off =
#                              the hold ends only when a pane that showed the error answers normally.
#   AUTH_PROBE_TIMEOUT_SEC=<s> optional (default 90): the test request's time limit; a timeout is not a pass
#   AUTH_CHECK_WAIT_SEC=<s>    optional (default 45): how long to watch a freshly relaunched pane for its
#                              first message (a login error holds the rest of the tick); 0 = don't watch
#   HARNESS=<harness>          optional: the primary harness. Every supervised session is relaunched on it,
#                              always: the fleet is Claude-only, and the supervisor never moves a supervised
#                              session to another harness (HARNESS_FALLBACK, QUOTA_COOLDOWN_MIN and the
#                              older SECURITY_SESSIONS / GATE_* / BATON_REVOKE_CMD lines are accepted and
#                              ignored). A seat limit is reported once (see "Seat limit" below).
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
  lm=$(stat -c %Y "$LOCKDIR" 2>/dev/null || stat -f %m "$LOCKDIR" 2>/dev/null || echo 0)
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
LIMIT_RESUME=on LIMIT_RESUME_MARGIN_SEC=120
INTEGRITY_SESSION_CMD="" SESSION_CONFIG_DIR_BASE=""
HARNESS="${HARNESS:-${FLEET_HARNESS:-claude}}"
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
    BATON_REVOKE_CMD=*) ;; # older confs: the supervisor no longer revokes batons, so it is ignored
    INTEGRITY_CMD=*) INTEGRITY_CMD="${line#INTEGRITY_CMD=}" ;;
    AUTH_PROBE=*) AUTH_PROBE="${line#AUTH_PROBE=}" ;;
    AUTH_PROBE_TIMEOUT_SEC=*) AUTH_PROBE_TIMEOUT_SEC="${line#AUTH_PROBE_TIMEOUT_SEC=}" ;;
    AUTH_CHECK_WAIT_SEC=*) AUTH_CHECK_WAIT_SEC="${line#AUTH_CHECK_WAIT_SEC=}" ;;
    STATUS_URL=*) STATUS_URL="${line#STATUS_URL=}" ;;
    INTEGRITY_SESSION_CMD=*) INTEGRITY_SESSION_CMD="${line#INTEGRITY_SESSION_CMD=}" ;;
    SESSION_CONFIG_DIR_BASE=*) SESSION_CONFIG_DIR_BASE="${line#SESSION_CONFIG_DIR_BASE=}" ;;
    LIMIT_RESUME=*) LIMIT_RESUME="${line#LIMIT_RESUME=}" ;;
    LIMIT_RESUME_MARGIN_SEC=*) LIMIT_RESUME_MARGIN_SEC="${line#LIMIT_RESUME_MARGIN_SEC=}" ;;
    HARNESS=*) HARNESS="${line#HARNESS=}" ;;
    # Accepted from older confs and ignored: the supervisor never fails a supervised session over.
    HARNESS_FALLBACK=* | QUOTA_COOLDOWN_MIN=* | SECURITY_SESSIONS=* | GATE_ISSUE=* | GATE_OPERATORS_TEAM=* | GATE_OPERATORS=* | GATE_CMD=*) ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "fleet-supervisor: bad conf line: $line" >&2; exit 1 ;;
  esac
done < "$CONF"
PRIMARY_HARNESS="${PRIMARY_HARNESS:-$HARNESS}"
[ -n "$TMUX_SESSION" ] && [ -n "$LAUNCH_CMD" ] || { echo "fleet-supervisor: conf must set TMUX_SESSION and LAUNCH_CMD" >&2; exit 1; }
case "$AUTH_PROBE" in on | off) ;; *) echo "fleet-supervisor: AUTH_PROBE must be on or off" >&2; exit 1 ;; esac
case "$LIMIT_RESUME" in on | off) ;; *) echo "fleet-supervisor: LIMIT_RESUME must be on or off" >&2; exit 1 ;; esac
for v in AUTH_PROBE_TIMEOUT_SEC AUTH_CHECK_WAIT_SEC LIMIT_RESUME_MARGIN_SEC; do
  case "${!v}" in '' | *[!0-9]*) echo "fleet-supervisor: $v must be a whole number" >&2; exit 1 ;; esac
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

# --- Claude Code / Copilot CLI login (engsys#103; header) -----------------------------------------
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
  'Failed to authenticate with GitHub Copilot'
  'Remote Control disconnected — OAuth token unavailable'
  'Remote Control disconnected — .*run /login to restore Remote Control'
  'OAuth token refresh failed'
  'Signed out of Claude'
  'Failed to refresh OAuth token: another Claude Code process is refreshing it'
  'OAuth session expired and could not be refreshed'
  'No Copilot subscription found'
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
AUTH_HELD=0 AUTH_RESUMED="" AUTH_RESOLVE_TEXT="" RELAUNCH_OK=0
# One login per session (SESSION_CONFIG_DIR_BASE set by the fleet kit, engsys#205): each supervised session has its own
# config dir <base>/<name>, so its login expires on its own. The same hold machinery then runs once per session, on
# state files named auth.<name>.* and the incident claude-auth-expired-<name>; AUTH_HELD_SET lists the sessions held
# this tick and nobody else is. Unset (one shared login): one scope, the files auth.*, as before.
AUTH_SCOPE="" AUTH_ONLY_WINDOW="" AUTH_PROBE_CFG="" AUTH_HELD_SET=" "
auth_scope() { # auth_scope <session> → the hold state below is that session's (per-session mode only)
  case "$1" in '' | .* | */* | *..* | *[!A-Za-z0-9._-]*) log "auth: refusing a per-session scope for the name '$1'"; return 1 ;; esac
  AUTH_SCOPE="$1" AUTH_ONLY_WINDOW="$1" AUTH_PROBE_CFG="${SESSION_CONFIG_DIR_BASE%/}/$1" AUTH_HELD=0 AUTH_RESOLVE_TEXT=""
  AUTH_EXPIRED="$STATE_DIR/auth.$1.expired" AUTH_ALERTED="$STATE_DIR/auth.$1.alerted" AUTH_HELD_LIST="$STATE_DIR/auth.$1.held"
  AUTH_SEEN="$STATE_DIR/auth.$1.panes" AUTH_ACKED="$STATE_DIR/auth.$1.acked" AUTH_INCIDENT="claude-auth-expired-$1"
}
auth_is_held() { # auth_is_held <session> → 0 when its relaunch is held for a login
  if [ -n "$SESSION_CONFIG_DIR_BASE" ]; then case "$AUTH_HELD_SET" in *" $1 "*) return 0 ;; esac; return 1; fi
  [ "$AUTH_HELD" = 1 ]
}
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
    [ -z "$AUTH_ONLY_WINDOW" ] || [ "$w" = "$AUTH_ONLY_WINDOW" ] || continue
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

# The test request: does a login/seat work right now? Accepts optional target harness $1. Sets AUTH_PROBE_WHY.
auth_probe() {
  AUTH_PROBE_WHY=""
  [ "$AUTH_PROBE" = on ] || { AUTH_PROBE_WHY="no test request (AUTH_PROBE=off)"; return 1; }
  local probe_bin="claude" h="${1:-${HARNESS:-claude}}"
  case "$h" in
    copilot) probe_bin="copilot" ;;
    antigravity | agy) h="antigravity"; probe_bin="agy" ;;
  esac
  command -v "$probe_bin" >/dev/null 2>&1 || { AUTH_PROBE_WHY="no test request ($probe_bin is not on PATH)"; return 1; }
  local dir pid rc=0 waited=0 last
  dir="$(mktemp -d "${TMPDIR:-/tmp}/fleet-supervisor-auth.XXXXXX")"
  if [ "$h" = "copilot" ]; then
    (cd "$dir" && exec copilot -p 'Reply with the single word OK' -s --no-custom-instructions --disable-builtin-mcps --model claude-haiku-5.5) </dev/null >"$dir/probe.out" 2>&1 &
  elif [ "$h" = "antigravity" ]; then
    (cd "$dir" && exec agy -p 'Reply with the single word OK') </dev/null >"$dir/probe.out" 2>&1 &
  elif [ -n "$AUTH_PROBE_CFG" ]; then
    # per-session mode: the test request runs on that session's own dir, never on another session's credential
    (cd "$dir" && CLAUDE_CONFIG_DIR="$AUTH_PROBE_CFG" exec claude -p --setting-sources project --strict-mcp-config --no-session-persistence --model haiku 'Reply with the single word OK') </dev/null >"$dir/probe.out" 2>&1 &
  else
    (cd "$dir" && exec claude -p --setting-sources project --strict-mcp-config --no-session-persistence --model haiku 'Reply with the single word OK') </dev/null >"$dir/probe.out" 2>&1 &
  fi
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge $((AUTH_PROBE_TIMEOUT_SEC * 2)) ]; then kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.5; waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || rc=$?
  last="$(grep -v '^[[:space:]]*$' "$dir/probe.out" | tail -n 1 | cut -c1-200 || true)"
  rm -rf "${dir:?}"
  if [ "$rc" = 0 ]; then
    case "$h" in
      copilot) AUTH_PROBE_WHY="a test request through Copilot CLI succeeded" ;;
      antigravity) AUTH_PROBE_WHY="a test request through Antigravity CLI succeeded" ;;
      *) AUTH_PROBE_WHY="a test request through Claude Code succeeded" ;;
    esac
    return 0
  fi
  if grep -Eq "$AUTH_RE" <<<"$last"; then AUTH_PROBE_WHY="the test request failed the same way: $last"
  else AUTH_PROBE_WHY="the test request did not succeed (exit $rc): ${last:-no output}"; fi
  return 1
}

# --- Seat limit (Claude-only) ------------------------------------------------------------------------
# The fleet is Claude-only: no supervised session (merge, maintain, broker, any monster) ever moves to
# another harness, whatever HARNESS_FALLBACK says. A seat limit is only reported: once per incident
# (NOTIFY_CMD --level alert --incident seat-limit), when the LAST message of a pane the supervisor itself
# launched for a supervised session (logs/fleet-supervisor/<name>.pane) is Claude Code's own limit line
# (a reply-marker line whose text starts with one of HARNESS_QUOTA_ERRORS). Tool output (`⎿` lines),
# other pane text and panes the supervisor didn't launch never count. The pane is acknowledged so the
# same line doesn't alert again; the alert resolves once no supervised pane shows a limit. A
# harness.fallback file left by an older version is removed: every relaunch uses the primary harness.
HARNESS_QUOTA_ERRORS=(
  "You've hit your( [A-Za-z0-9-]+)* limit"
  "You’ve hit your( [A-Za-z0-9-]+)* limit"
  'Claude usage limit reached'
  'Usage limit reached'
  'Session limit reached'
  'Weekly limit reached'
  '(API Error: 429 )?Rate limit reached'
  'API Error: 429 .*rate_limit_error'
  'You have exceeded your Copilot .*quota'
  'Copilot rate limit exceeded'
)
QUOTA_RE="^($(IFS='|'; printf '%s' "${HARNESS_QUOTA_ERRORS[*]}"))"
FALLBACK_FILE="$STATE_DIR/harness.fallback"       # written by older versions only; removed on sight
QUOTA_ALERTED="$STATE_DIR/seat-limit.alerted"
QUOTA_ACKED="$STATE_DIR/quota.acked"
QUOTA_INCIDENT="seat-limit"
QUOTA_BLOCKED=""
LIMIT_REHIT_WINDOW_SEC=1800 # a session that hits the limit again within this long of a resume is backing off
LIMIT_BACKOFF_BASE_SEC=600  # …by this much on the first re-hit, doubling each time, up to LIMIT_BACKOFF_MAX_SEC
LIMIT_BACKOFF_MAX_SEC=14400
LIMIT_RESUMED_LIST="$STATE_DIR/limit.resumed" # sessions resumed since the last "limit is over" notice
LIMIT_PROMPT="Your Claude usage limit has reset. Carry on where you stopped: re-read your ledger and state, then resume your loop."

# limit_reset_epoch <limit line> → the epoch of the reset time the line names, on stdout; rc 1 when it can't be
# read. The line ends `resets [<Mon> <D>[,] [at] ]<H>[:<MM>]<am|pm> (<IANA zone>)` (`resets 9pm (America/New_York)`,
# `resets Oct 20, 9:30pm (UTC)`). No zone, no clock time or an unknown zone is unreadable: guessing would resume a
# monster hours early or never.
limit_reset_epoch() {
  local tail tz when re mon day h m ap y now ep mon_c ap_c time_s
  grep -qi 'reset' <<<"$1" || return 1
  # what follows the last "reset" / "resets" / "reset at": `9pm (America/New_York)`, `Oct 20, 9:30pm (UTC)`, `5am`
  tail="$(sed -E 's/.*[Rr]esets? (at )?//' <<<"$1" | head -n 1)"
  tz="$(sed -n 's/^[^(]*(\([A-Za-z0-9_+/-]*\)).*$/\1/p' <<<"$tail" | head -n 1)"
  when="$(sed -E 's/\(.*$//; s/[ .]+$//; s/^ +//' <<<"$tail" | tr 'A-Z' 'a-z')"
  [ -n "$when" ] || return 1
  # no zone in the message = the host's local time
  if [ -z "$tz" ]; then tz=LOCAL
  else case "$tz" in UTC | GMT) ;; *) [ -e "/usr/share/zoneinfo/$tz" ] || return 1 ;; esac; fi
  re='^(([a-z]+) ([0-9]{1,2}),? (at )?)?([0-9]{1,2})(:([0-9]{2}))?[[:space:]]*(am|pm)$'
  [[ "$when" =~ $re ]] || return 1
  mon="${BASH_REMATCH[2]}" day="${BASH_REMATCH[3]}" h="${BASH_REMATCH[5]}" m="${BASH_REMATCH[7]:-00}" ap="${BASH_REMATCH[8]}"
  [ "$((10#$h))" -ge 1 ] && [ "$((10#$h))" -le 12 ] && [ "$((10#$m))" -le 59 ] || return 1
  ap_c="$(printf '%s' "$ap" | tr 'a-z' 'A-Z')"
  time_s="$((10#$h)):$m $ap_c"
  now="$(date +%s)"
  if [ -n "$mon" ]; then
    mon_c="$(printf '%s' "${mon:0:1}" | tr 'a-z' 'A-Z')${mon:1:2}"
    y="$(limit_tz_date "$tz" +%Y)"
    ep="$(limit_tz_epoch "$tz" "$y" "$mon_c" "$((10#$day))" "$time_s")" || return 1
    # a date already well behind us belongs to next year (a December limit read in January)
    if [ "$ep" -lt $((now - 172800)) ]; then ep="$(limit_tz_epoch "$tz" "$((y + 1))" "$mon_c" "$((10#$day))" "$time_s")" || return 1; fi
  else
    read -r y mon_c day <<<"$(limit_tz_date "$tz" '+%Y %b %d')"
    ep="$(limit_tz_epoch "$tz" "$y" "$mon_c" "$((10#$day))" "$time_s")" || return 1
    # A clock time with no date is in the future, unless it passed within the last hour (the supervisor was a tick late,
    # or the message was read just after midnight): then it is due now. A time that passed longer ago is tomorrow's, and
    # one still ahead, however far, is today's.
    local yday=$((ep - 86400))
    if [ "$now" -ge "$yday" ] && [ $((now - yday)) -le 3600 ]; then ep="$yday"
    elif [ "$ep" -gt "$now" ]; then :
    elif [ $((now - ep)) -le 3600 ]; then :
    else ep=$((ep + 86400)); fi
  fi
  # a reset more than 8 days out is a misread, not a weekly limit
  [ "$ep" -le $((now + 691200)) ] || return 1
  printf '%s' "$ep"
}
limit_tz_date() { # limit_tz_date <zone|LOCAL> <date args> → date in that zone
  if [ "$1" = LOCAL ]; then shift; date "$@"; else local z="$1"; shift; TZ="$z" date "$@"; fi
}
limit_tz_epoch() { # limit_tz_epoch <zone|LOCAL> <year> <Mon> <day> <H:MM AM> → epoch (BSD date first, GNU fallback)
  if [ "$1" = LOCAL ]; then
    date -j -f '%Y %b %d %I:%M %p' "$2 $3 $4 $5" +%s 2>/dev/null || date -d "$3 $4 $2 $5" +%s 2>/dev/null
  else
    TZ="$1" date -j -f '%Y %b %d %I:%M %p' "$2 $3 $4 $5" +%s 2>/dev/null || TZ="$1" date -d "$3 $4 $2 $5" +%s 2>/dev/null
  fi
}
limit_hold_get() { sed -n "s/^$2=//p" "$STATE_DIR/$1.limit-hold" 2>/dev/null | head -n 1; }
limit_hold_drop() { rm -f "${STATE_DIR:?}/${1:?}.limit-hold"; }
limit_held_names() { # the configured sessions on a seat limit hold, one per line (a hold of a session no longer in the conf is orphaned)
  local s n
  for s in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
    IFS='|' read -r n _ <<<"$s"
    [ -z "$n" ] || [ ! -f "$STATE_DIR/$n.limit-hold" ] || printf '%s\n' "$n"
  done
}
limit_holds_remaining() { [ -n "$(limit_held_names)" ]; }
epoch_iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# limit_hold_begin <name> <pane> <limit line> → record the hold: logs/fleet-supervisor/<name>.limit-hold, with the reset
# time parsed from the line. Nothing is written (alert-only, as before) when LIMIT_RESUME=off or the time is unreadable.
# A session that hits the limit again within LIMIT_REHIT_WINDOW_SEC of a resume backs off: the resume waits an extra
# LIMIT_BACKOFF_BASE_SEC, doubling per re-hit up to LIMIT_BACKOFF_MAX_SEC, so a limit that did not really lift cannot loop.
limit_hold_begin() {
  [ "$LIMIT_RESUME" = on ] || return 0
  local f="$STATE_DIR/$1.limit-hold" reset resume now last rehits=0 extra=0 rec="$STATE_DIR/$1.limit-resumed" why=""
  [ ! -f "$f" ] || return 0
  if ! reset="$(limit_reset_epoch "$3")"; then
    log "$1: seat limit, but the reset time is unreadable ($(printf '%s' "$3" | cut -c1-160)): alert only, no automatic resume"
    return 0
  fi
  now="$(date +%s)"
  if [ -f "$rec" ]; then
    IFS='|' read -r last rehits <"$rec" || true
    case "${last:-}" in '' | *[!0-9]*) last=0 ;; esac
    case "${rehits:-}" in '' | *[!0-9]*) rehits=0 ;; esac
    if [ $((now - last)) -lt "$LIMIT_REHIT_WINDOW_SEC" ]; then
      rehits=$((rehits + 1)); extra=$((LIMIT_BACKOFF_BASE_SEC * (1 << (rehits - 1))))
      [ "$extra" -le "$LIMIT_BACKOFF_MAX_SEC" ] || extra=$LIMIT_BACKOFF_MAX_SEC
      why=" (re-hit $rehits, backing off ${extra}s)"
    else rehits=0; fi
  fi
  resume=$((reset + LIMIT_RESUME_MARGIN_SEC)); [ "$resume" -ge "$now" ] || resume=$now
  resume=$((resume + extra))
  printf 'reset=%s\nresume_at=%s\nresume=%s\nseen=%s\nrehits=%s\npane=%s\nline=%s\n' "$(epoch_iso "$reset")" "$resume" "$(epoch_iso "$resume")" \
    "$(epoch_iso "$now")" "$rehits" "$2" "$(printf '%s' "$3" | tr -d '\n' | cut -c1-200)" >"$f"
  log "$1: seat limit, resets $(epoch_iso "$reset"): holding it (no stale or relaunch escalation), resuming at $(epoch_iso "$resume")$why"
}

# limit_hold_done <name> <how> → the hold ends; the backoff record keeps the resume time. When it was the last hold, the
# one "limit is over" notice goes out (it is the seat-limit alert's resolve).
limit_hold_done() {
  local name="$1" rehits names
  rehits="$(limit_hold_get "$name" rehits)"
  [ "$2" != resumed ] || printf '%s|%s\n' "$(date +%s)" "${rehits:-0}" >"$STATE_DIR/$name.limit-resumed"
  limit_hold_drop "$name"
  [ "$2" != resumed ] || auth_add_lines "$LIMIT_RESUMED_LIST" "$name"
  log "$name: seat limit hold ended ($2)"
  # another pane can still show the limit with no hold (an unreadable reset): the tick's own resolve handles that
  if ! limit_holds_remaining && ! { cat "$QUOTA_ACKED" 2>/dev/null; printf '%s' "$QUOTA_BLOCKED"; } | grep -v -F -- "$name|" | grep -q .; then
    names="$(paste -sd, - <"$LIMIT_RESUMED_LIST" 2>/dev/null | sed 's/,/, /g' || true)"
    if [ ! -f "$QUOTA_ALERTED" ]; then rm -f "${LIMIT_RESUMED_LIST:?}"
    elif notify --level info --incident "$QUOTA_INCIDENT" --resolve "Resolved: the Claude usage limit has reset on $HOST_NAME${names:+; resumed on their own: $names}."; then
      rm -f "${QUOTA_ALERTED:?}" "${LIMIT_RESUMED_LIST:?}" "${QUOTA_ACKED:?}" # a repeat limit is a new incident
    fi
  fi
}

# quota_state_of <pane text> → quota | ok | none: what the pane's LAST message (a reply-marker line) says.
quota_state_of() {
  QUOTA_RE="$QUOTA_RE" MSG_RE="$AUTH_MSG_RE" awk '
    { sub(/\r$/, ""); sub(/ +$/, "") }
    $0 ~ ENVIRON["MSG_RE"] { m = $0; sub(ENVIRON["MSG_RE"], "", m); s = (m ~ ENVIRON["QUOTA_RE"]) ? "quota" : "ok" }
    END { print (s == "" ? "none" : s) }' <<<"$1"
}

# quota_line_of <pane text> → the pane's last message line (the limit line, when quota_state_of said quota).
quota_line_of() {
  MSG_RE="$AUTH_MSG_RE" awk '{ sub(/\r$/, ""); sub(/ +$/, "") } $0 ~ ENVIRON["MSG_RE"] { m = $0 } END { print m }' <<<"$1"
}

# launched_pane_of <name> → the pane id the supervisor launched for <name>, if that pane is still its window's.
launched_pane_of() {
  local rec cur
  rec="$(cat "$STATE_DIR/$1.pane" 2>/dev/null || true)"
  [ -n "$rec" ] || return 1
  cur="$(tmux list-panes -t "${TMUX_SESSION}:$1" -F '#{pane_id}' 2>/dev/null | head -1 || true)"
  [ "$cur" = "$rec" ] || return 1
  printf '%s' "$cur"
}

# QUOTA_BLOCKED: <name>|<pane> of each supervised session whose supervisor-launched pane, idle, shows a
# limit line as its last message (minus acknowledged ones). QUOTA_ANY: any such pane, acknowledged or not.
quota_scan() {
  QUOTA_BLOCKED="" QUOTA_ANY=0
  local s n id text keep=""
  for s in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
    IFS='|' read -r n _ <<<"$s"
    [ -n "$n" ] || continue
    id="$(launched_pane_of "$n")" || continue
    text="$(tmux capture-pane -p -t "$id" -S -60 2>/dev/null || true)"
    grep -q 'esc to interrupt' <<<"$(tail -n 15 <<<"$text")" && continue
    if [ "$(quota_state_of "$text")" = quota ]; then
      QUOTA_ANY=1
      limit_hold_begin "$n" "$id" "$(quota_line_of "$text")"
      if [ -f "$QUOTA_ACKED" ] && grep -Fxq "$n|$id" "$QUOTA_ACKED"; then keep="$keep$n|$id"$'\n'
      else QUOTA_BLOCKED="$QUOTA_BLOCKED$n|$id"$'\n'; fi
    fi
  done
  if [ -f "$QUOTA_ACKED" ]; then
    if [ -n "$keep" ]; then printf '%s' "$keep" >"$QUOTA_ACKED"; else rm -f "$QUOTA_ACKED"; fi
  fi
}

auth_alert() { # the incident's one alert; retried each tick while held until it is posted
  [ ! -f "$AUTH_ALERTED" ] || return 0
  local re="$STATUS_URL" r l text
  if [ -z "$re" ] && [ "${#SESSIONS[@]}" -gt 0 ]; then
    IFS='|' read -r _ l _ r _ _ <<<"${SESSIONS[0]}"
    r="${r:-$DEFAULT_REPO}"
    [ -z "$r" ] || [ -z "$l" ] || re="https://github.com/$r/issues/$l"
  fi
  if [ -n "$AUTH_SCOPE" ]; then
    text="The Claude Code login of session \`$AUTH_SCOPE\` expired on $HOST_NAME (its own config dir ${SESSION_CONFIG_DIR_BASE%/}/$AUTH_SCOPE). Log it in: \`CLAUDE_CONFIG_DIR=${SESSION_CONFIG_DIR_BASE%/}/$AUTH_SCOPE claude\`, then \`/login\` and \`/exit\` (or \`/login\` in its own window); the session resumes on the next supervisor tick. Only \`$AUTH_SCOPE\` is held: the other sessions keep running, and nothing is killed. First seen $(head -n 1 "$AUTH_EXPIRED") in $(sed -n 2p "$AUTH_EXPIRED")."
  else
    text="Claude Code login expired on $HOST_NAME. Run \`/login\` in any session (or \`claude /login\`); the fleet resumes on the next supervisor tick. Until then the supervisor relaunches and kills nothing. First seen $(head -n 1 "$AUTH_EXPIRED") in $(sed -n 2p "$AUTH_EXPIRED")."
  fi
  if [ -n "$re" ]; then set -- --level action --re "$re"; else set -- --level alert; fi # action needs a link
  if notify "$@" --incident "$AUTH_INCIDENT" "$text"; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$AUTH_ALERTED"; log "auth: alert $AUTH_INCIDENT posted"
  else
    log "auth: alert $AUTH_INCIDENT could not be posted (NOTIFY_CMD unset or failing); retrying next tick"
  fi
}

auth_resolve_post() { # resolve the alert; retried each tick until it goes out
  [ -f "$AUTH_ALERTED" ] || return 0
  if notify --level info --incident "$AUTH_INCIDENT" --resolve "${AUTH_RESOLVE_TEXT:-Resolved: Claude Code login${AUTH_SCOPE:+ of session \`$AUTH_SCOPE\`} works again on $HOST_NAME.}"; then
    rm -f "$AUTH_ALERTED"; log "auth: alert $AUTH_INCIDENT resolved"
  else
    log "auth: resolving alert $AUTH_INCIDENT failed (NOTIFY_CMD unset or failing); retrying next tick"
  fi
}

auth_begin() { # auth_begin <where it was seen> <panes> → hold from now on
  [ "$AUTH_HELD" = 0 ] || return 0
  [ -f "$AUTH_EXPIRED" ] || printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >"$AUTH_EXPIRED"
  AUTH_HELD=1
  [ -z "$AUTH_SCOPE" ] || AUTH_HELD_SET="$AUTH_HELD_SET$AUTH_SCOPE "
  auth_add_lines "$AUTH_SEEN" "$2"
  if [ -n "$AUTH_SCOPE" ]; then log "auth: Claude Code login of session $AUTH_SCOPE expired (seen in $1; $AUTH_PROBE_WHY). Holding its relaunch only; nothing is killed"
  else log "auth: Claude Code login expired (seen in $1; $AUTH_PROBE_WHY). Holding every relaunch until it works; nothing is killed"; fi
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
  AUTH_RESUMED="$AUTH_RESUMED$(cat "$AUTH_HELD_LIST" 2>/dev/null || true)"$'\n'
  AUTH_RESOLVE_TEXT="Resolved: Claude Code login${AUTH_SCOPE:+ of session \`$AUTH_SCOPE\`} works again on $HOST_NAME ($1); it had been expired since $since. ${held:+Relaunching the held sessions once each: $held.}"
  rm -f "$AUTH_EXPIRED" "$AUTH_SEEN" "$AUTH_HELD_LIST"
  log "auth: Claude Code login works again ($1); relaunches resume${held:+, held sessions go through the table once: $held}"
  auth_resolve_post
}

auth_hold() { # auth_hold <name> <what the table would have done> → logged and listed, nothing touched
  [ -z "$SESSION_CONFIG_DIR_BASE" ] || { local keep_held="$AUTH_HELD"; auth_scope "$1"; AUTH_HELD="$keep_held"; }
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
        [ -z "$SESSION_CONFIG_DIR_BASE" ] || auth_scope "$1"
        auth_begin "\`$1\`, right after its relaunch" "$1|$(tmux list-panes -t "${TMUX_SESSION}:$1" -F '#{pane_id}' 2>/dev/null | head -1 || true)"
        return 0 ;;
      ok) return 0 ;; # a seat-limit reply is read by the next tick's quota_scan (this pane is recorded)
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
  RELAUNCH_OK=0 # set to 1 below when the launcher succeeded; the seat limit resume reads it
  # the last line of defence for the login hold: whatever path got here, nothing is killed or relaunched
  if auth_is_held "$name"; then auth_hold "$name" "relaunch due ($reason)"; return 0; fi
  if [ -n "$AUTH_RESUMED" ] && grep -Fxq "$name" <<<"$AUTH_RESUMED"; then
    reason="$reason; held while Claude Code's login was expired"
  fi
  local reason_h; reason_h="$(human_text "$reason")" # the comments read to a person; the log keeps $reason as is
  log "$name: relaunching — $reason"
  tmux kill-window -t "${TMUX_SESSION}:$name" 2>/dev/null || true
  out="$(mktemp "${TMPDIR:-/tmp}/fleet-supervisor.XXXXXX")"
  # Every supervised session runs on PRIMARY_HARNESS (Claude-only; "Seat limit" above). The launcher
  # honours FLEET_ACTIVE_HARNESS over any fallback state on the host.
  local use_h="$PRIMARY_HARNESS"
  # LAUNCH_CMD is intentionally word-split (it is a command line, not a path)
  # shellcheck disable=SC2086
  if FLEET_ACTIVE_HARNESS="$use_h" HARNESS="$use_h" $LAUNCH_CMD "$name" >"$out" 2>&1; then
    cat "$out" >>"$LOG"; rm -f "$out"
    log "$name: relaunched${use_h:+ (HARNESS=$use_h)}"
    RELAUNCH_OK=1
    printf '%s|%s\n' "${CUR_TARGET:-$repo|$ledger|}" "$(date +%s)" >"$STATE_DIR/$name.target"
    printf '%s\n' "$use_h" >"$STATE_DIR/$name.harness"
    # the pane this supervisor launched: the only one whose seat-limit line quota_scan reads
    tmux list-panes -t "${TMUX_SESSION}:$name" -F '#{pane_id}' 2>/dev/null | head -1 >"$STATE_DIR/$name.pane" || true
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
baton_allows() { # baton_allows <name> <repo> <role> [rotation_idle] → 0 may relaunch
  local name="$1" repo="$2" role="$3" mode="${4:-}" out rc=0 latch="$STATE_DIR/$1.baton-alerted" rot_flag=""
  [ "$mode" = "rotation_idle" ] && rot_flag="--rotation-idle"
  if [ -n "$BATON_CMD" ]; then
    # shellcheck disable=SC2086 # a command line, like LAUNCH_CMD
    out=$($BATON_CMD --repo "$repo" --role "$role" --session "$name" $rot_flag 2>&1) || rc=$?
  else
    out=$(node "$BATON_LIB" supervise --repo "$repo" --role "$role" --session "$name" --state-dir "$STATE_DIR" $rot_flag 2>&1) || rc=$?
  fi
  out="$(printf '%s' "$out" | tail -n 1 | cut -c1-300)"
  BATON_CODE="$(printf '%s' "$out" | jq -r '.code // empty' 2>/dev/null || true)"
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

NOW=$(date +%s)

# limit_hold_step <name> <ledger> <repo> <role> → 0: handled this tick (held, or resumed; skip the table), 1: no hold
# any more (run the table). Reads the loop's ALIVE / ENDED.
limit_hold_step() {
  local name="$1" at now text
  at="$(limit_hold_get "$name" resume_at)"
  case "$at" in '' | *[!0-9]*) log "$name: limit hold unreadable, dropped"; limit_hold_drop "$name"; return 1 ;; esac
  now="$(date +%s)"
  if [ "$ALIVE" = 1 ]; then
    # somebody got the session going again (a person re-prompted it): the hold has nothing left to do
    if pane_busy "$name"; then limit_hold_done "$name" "the session is working again"; return 1; fi
    text="$(tmux capture-pane -p -t "${TMUX_SESSION}:$name" -S -60 2>/dev/null || true)"
    if [ "$(quota_state_of "$text")" != quota ]; then limit_hold_done "$name" "the pane no longer shows the limit"; return 1; fi
  fi
  if [ "$now" -lt "$at" ]; then
    log "$name: held for the seat limit until $(epoch_iso "$at"): no stale or relaunch escalation meanwhile"
    return 0
  fi
  if auth_is_held "$name"; then auth_hold "$name" "the seat limit has reset, resume due"; return 0; fi
  if [ "$ALIVE" = 1 ]; then
    log "$name: seat limit has reset: re-prompting the idle session"
    tmux send-keys -t "${TMUX_SESSION}:$name" -l "$LIMIT_PROMPT" 2>/dev/null && tmux send-keys -t "${TMUX_SESSION}:$name" Enter 2>/dev/null \
      || { log "$name: re-prompt failed (tmux send-keys), retrying next tick"; return 0; }
    limit_hold_done "$name" resumed
    return 0
  fi
  if [ "$ENDED" = 1 ]; then limit_hold_done "$name" "process exited after 'session end': left alone"; return 1; fi
  if [ -n "$4" ] && ! singleton_allows "$name" "$3" "$4" "$2"; then
    log "$name: seat limit has reset, but the relaunch is held (baton or integrity) — waiting ($BATON_WHY)"
    return 0
  fi
  # the table re-reads the pane right before it kills a window: a person may have started the session meanwhile
  case "$(pane_cmd "$name")" in
    '' | zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) : ;;
    *) log "$name: pane became live before the seat-limit relaunch — aborting it"; limit_hold_done "$name" "the session is running again"; return 0 ;;
  esac
  relaunch "$name" "$2" "$3" "seat limit has reset; the session had exited"
  if [ "$RELAUNCH_OK" = 1 ]; then limit_hold_done "$name" resumed
  else log "$name: seat limit has reset, but the relaunch failed: keeping the hold, retrying next tick"; fi
  return 0
}

# Seat limit (Claude-only, header of that section): report it, never switch harness.
HARNESS="$PRIMARY_HARNESS"; unset FLEET_ACTIVE_HARNESS; export HARNESS
if [ -f "$FALLBACK_FILE" ]; then
  log "quota: removing a harness.fallback left by an older version ($(head -n 1 "$FALLBACK_FILE")): supervised sessions run on $PRIMARY_HARNESS only"
  rm -f "$FALLBACK_FILE"
fi
limit_alert_tail() { # limit_alert_tail <blocked list> → what the alert adds when a session is on hold
  local n t="" r
  while IFS='|' read -r n _; do
    [ -n "$n" ] && [ -f "$STATE_DIR/$n.limit-hold" ] || continue
    r="$(limit_hold_get "$n" resume)"; t="$t \`$n\` ${r:+resumes on its own after $r}"
  done <<<"$1"
  [ -z "$t" ] || printf ' With LIMIT_RESUME on, the supervisor re-prompts each held session once the limit resets:%s.' "$t"
}
quota_scan
if [ -n "$QUOTA_BLOCKED" ]; then
  QUOTA_FIRST="${QUOTA_BLOCKED%%$'\n'*}"
  log "quota: seat limit reached in \`${QUOTA_FIRST%%|*}\`; supervised sessions never fail over to another harness (Claude-only), so it stays on $PRIMARY_HARNESS"
  if [ ! -f "$QUOTA_ALERTED" ]; then
    if notify --level alert --incident "$QUOTA_INCIDENT" "Seat limit reached on \`$PRIMARY_HARNESS\` on $HOST_NAME (seen in \`${QUOTA_FIRST%%|*}\`). The fleet is Claude-only, so no session is moved to another harness: the sessions wait for the limit to reset, or for an operator.$(limit_alert_tail "$QUOTA_BLOCKED")"; then
      date -u +%Y-%m-%dT%H:%M:%SZ >"$QUOTA_ALERTED"
    fi
  fi
  # acknowledged only once the alert is out (an undelivered one is retried next tick)
  [ ! -f "$QUOTA_ALERTED" ] || auth_add_lines "$QUOTA_ACKED" "$QUOTA_BLOCKED"
elif [ "$QUOTA_ANY" = 0 ] && [ -f "$QUOTA_ALERTED" ] && ! limit_holds_remaining; then
  if notify --level info --incident "$QUOTA_INCIDENT" --resolve "Resolved: no supervised session on $HOST_NAME shows a seat limit any more."; then rm -f "${QUOTA_ALERTED:?}" "${LIMIT_RESUMED_LIST:?}" "${QUOTA_ACKED:?}"; fi
fi

# Singleton monsters: the integrity check (INTEGRITY_CMD, once per tick) and then the lease. Sets BATON_WHY.
# A relaunch held by the integrity check is said once on the session's ledger (latch:
# <name>.integrity-held), cleared by the first passing check (engsys#86 review L1).
INTEGRITY_BLOCKED=0 INTEGRITY_WHY="" INTEGRITY_SESSION_DONE="" INTEGRITY_GLOBAL_BLOCKED=0 INTEGRITY_GLOBAL_WHY=""
# One login per session (engsys#205): the plugin check is per session (each has its own config dir), run at most once
# per tick for each, so one tampered, behind or logged-out dir holds only its own session. Sets
# INTEGRITY_BLOCKED / INTEGRITY_WHY for <name>.
integrity_session_check() { # integrity_session_check <name>
  local irc=0 iout
  INTEGRITY_BLOCKED=0 INTEGRITY_WHY=""
  case "$INTEGRITY_SESSION_DONE" in
    *"|$1:"*) INTEGRITY_BLOCKED="$(sed -n "s/.*|$1:\([01]\):.*/\1/p" <<<"$INTEGRITY_SESSION_DONE")"; INTEGRITY_WHY="$(sed -n "s/.*|$1:[01]:\([^|]*\)|.*/\1/p" <<<"$INTEGRITY_SESSION_DONE")" ;;
    *)
      # shellcheck disable=SC2086 # a command line, like LAUNCH_CMD
      iout=$($INTEGRITY_SESSION_CMD "$1" 2>&1 </dev/null) || irc=$?
      printf '%s\n' "$iout" >>"$LOG"
      case "$irc" in
        0) log "integrity ($1): ok" ;;
        1) INTEGRITY_BLOCKED=1 INTEGRITY_WHY="the engsys plugin in $1's own config dir does not match its release"
           log "integrity ($1): MISMATCH, its relaunch is held this tick; running sessions and batons are left alone" ;;
        *) INTEGRITY_BLOCKED=1 INTEGRITY_WHY="the engsys plugin check for $1's own config dir could not run (exit $irc)"
           log "integrity ($1): the check could not run (exit $irc), so its relaunch is held this tick (fail closed): $(printf '%s' "$iout" | tail -n 1 | cut -c1-200)" ;;
      esac
      INTEGRITY_SESSION_DONE="$INTEGRITY_SESSION_DONE|$1:$INTEGRITY_BLOCKED:$INTEGRITY_WHY|" ;;
  esac
  # a conf that also sets INTEGRITY_CMD: its verdict holds every singleton session too
  if [ "$INTEGRITY_GLOBAL_BLOCKED" = 1 ]; then INTEGRITY_BLOCKED=1 INTEGRITY_WHY="$INTEGRITY_GLOBAL_WHY"; fi
}
singleton_allows() { # singleton_allows <name> <repo> <role> <ledger> [rotation_idle] → 0 may relaunch
  local held="$STATE_DIR/$1.integrity-held"
  [ -z "$INTEGRITY_SESSION_CMD" ] || integrity_session_check "$1"
  if [ "$INTEGRITY_BLOCKED" = 1 ]; then
    BATON_WHY="plugin integrity: $INTEGRITY_WHY (fleet verify)"
    if [ ! -f "$held" ]; then
      gh issue comment "$4" -R "$2" --body "⏸️ fleet-supervisor: \`$1\` needs a relaunch, but it is held: $INTEGRITY_WHY. The supervisor relaunches it on its own once \`fleet verify\` passes on the host; the details went to the fleet's alert channel." >/dev/null \
        && date -u +%Y-%m-%dT%H:%M:%SZ >"$held"
    fi
    return 2
  fi
  rm -f "$held"
  baton_allows "$1" "$2" "$3" "${5:-}"
}
if [ -n "$INTEGRITY_SESSION_CMD" ]; then
  # every tick, for every singleton session: this is what alerts, resolves and auto-syncs (the global check's job)
  for spec in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
    IFS='|' read -r s_name _ _ _ _ s_role <<<"$spec"
    [ -n "$s_role" ] && [ -n "$s_name" ] || continue
    integrity_session_check "$s_name"
  done
  INTEGRITY_BLOCKED=0 INTEGRITY_WHY=""
fi
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
         # Hold and alert only. A running session's baton is never revoked or broken for a mismatch: a
         # flapping check must not take a live merge down mid-flight (the operator decides, from the alert).
         log "integrity: MISMATCH, no merge/maintain session is relaunched this tick; running ones and their batons are left alone (alert: INTEGRITY_CMD)" ;;
      *) INTEGRITY_BLOCKED=1 INTEGRITY_WHY="the engsys plugin check could not run (exit $INTEGRITY_RC)"
         log "integrity: the check could not run (exit $INTEGRITY_RC), so no merge/maintain session is relaunched this tick (fail closed): $(printf '%s' "$INTEGRITY_OUT" | tail -n 1 | cut -c1-200)" ;;
    esac
    break
  done
fi
INTEGRITY_GLOBAL_BLOCKED=$INTEGRITY_BLOCKED INTEGRITY_GLOBAL_WHY=$INTEGRITY_WHY

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

# Claude Code login (header): read the panes, then hold, keep holding, or resume. With one login per session
# (SESSION_CONFIG_DIR_BASE) this runs once per supervised session, each on its own state and its own pane.
auth_tick() {
  auth_scan
  if [ -f "$AUTH_EXPIRED" ]; then
    AUTH_HOW=""
    # A pane that answered is not proof the login works (engsys#207: a Remote Control notice line ended a hold while the
    # credential was still empty). With the test request on, only the test request ends a hold; with it off a
    # pane's reply after the error is all the evidence there is.
    if [ "$AUTH_PROBE" = off ] && [ -f "$AUTH_SEEN" ] && [ -n "$AUTH_ANSWERED" ]; then
      while IFS= read -r p; do
        [ -n "$p" ] && grep -Fxq "$p" <<<"$AUTH_ANSWERED" && { AUTH_HOW="\`${p%%|*}\` answered normally after the error"; break; }
      done <"$AUTH_SEEN"
    fi
    if [ -z "$AUTH_HOW" ] && auth_probe; then AUTH_HOW="$AUTH_PROBE_WHY"; fi
    if [ -n "$AUTH_HOW" ]; then
      auth_resume "$AUTH_HOW"
    else
      AUTH_HELD=1
      [ -z "$AUTH_SCOPE" ] || AUTH_HELD_SET="$AUTH_HELD_SET$AUTH_SCOPE "
      auth_add_lines "$AUTH_SEEN" "$AUTH_BLOCKED"
      if [ -n "$AUTH_SCOPE" ]; then log "auth: session $AUTH_SCOPE still expired (since $(head -n 1 "$AUTH_EXPIRED")): holding its relaunch only; $AUTH_PROBE_WHY"
      else log "auth: still expired (since $(head -n 1 "$AUTH_EXPIRED")): holding every relaunch; $AUTH_PROBE_WHY"; fi
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
}
if [ -n "$SESSION_CONFIG_DIR_BASE" ]; then
  for spec in ${SESSIONS[@]+"${SESSIONS[@]}"}; do
    IFS='|' read -r auth_n _ <<<"$spec"
    [ -n "$auth_n" ] || continue
    case "$auth_n" in .* | */* | *..* | *[!A-Za-z0-9._-]*) log "auth: session name '$auth_n' can't be a per-session config dir name; no login hold for it"; continue ;; esac
    auth_scope "$auth_n"; auth_tick
  done
  AUTH_HELD=0 AUTH_SCOPE="" AUTH_ONLY_WINDOW="" AUTH_PROBE_CFG=""   # the loop below asks auth_is_held <name>
else
  auth_tick
fi

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
      limit_hold_drop "$name" # a hold nobody here will resume must not keep the seat-limit alert open
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
    limit_hold_drop "$name"
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

  # A seat limit hold (header): no escalation or relaunch from the table while it lasts; once the reset time plus
  # the margin has passed, the session is resumed instead (re-prompted if alive, relaunched if it exited).
  if [ -f "$STATE_DIR/$name.limit-hold" ] && limit_hold_step "$name" "$ledger" "$REPO_SLUG" "$role"; then
    DOWN=$((DOWN + 1))
    continue
  fi

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
      elif auth_is_held "$name"; then
        auth_hold "$name" "rotation requested ${AGE}m ago, session idle at its prompt"
      elif [ -n "$role" ] && ! singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger" rotation_idle; then
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
      if auth_is_held "$name"; then
        # idle at its prompt: listed, so the hold's end gives it its one relaunch even when it was escalated before (engsys#207)
        if ! pane_busy "$name"; then auth_hold "$name" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt"
        else log "$name: STALE+ALIVE — ledger comment deferred while Claude Code's login is expired"; fi
      elif [ -n "$role" ] && ! pane_busy "$name" && singleton_allows "$name" "$REPO_SLUG" "$role" "$ledger"; then
        rm -f "$LATCH"
        relaunch "$name" "$ledger" "$REPO_SLUG" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt, $role baton forfeited ($BATON_WHY)"
      elif [ -z "$role" ] && ! pane_busy "$name" && [ -n "$AUTH_RESUMED" ] && grep -Fxq "$name" <<<"$AUTH_RESUMED"; then
        # held while the login was expired, stale and idle: one relaunch now that it works, escalated before or not (engsys#207)
        rm -f "$LATCH"
        relaunch "$name" "$ledger" "$REPO_SLUG" "heartbeat stale (last: ${HB_TS:-never}), session idle at its prompt"
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
      if auth_is_held "$name"; then
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
    if auth_is_held "$name"; then auth_hold "$name" "$REASON"; continue; fi
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
    log "$name: process exited, heartbeat fresh (${HB_TS:-?}) — not stale yet, waiting"
  fi
done

# Status-issue heartbeat: once per tick (deduped to once per UTC minute, in case a tick is ever
# re-entered at the same minute), after every session above has been classified. Fail soft and
# cheap — this never blocks or repeats within the same tick.
if [ -n "$HEARTBEAT_CMD" ] && [ $((UP + ROTATING + DOWN)) -gt 0 ]; then
  case "${SUPERVISOR_NOW_MINUTE:-}" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]) MINUTE_NOW="$SUPERVISOR_NOW_MINUTE" ;;
    *) MINUTE_NOW="$(date -u +%Y-%m-%dT%H:%M)" ;;
  esac
  MINUTE_LATCH="$STATE_DIR/heartbeat.last-minute"
  if [ ! -f "$MINUTE_LATCH" ] || [ "$(cat "$MINUTE_LATCH")" != "$MINUTE_NOW" ]; then
    SUMMARY="sessions: $UP up, $ROTATING rotating, $DOWN down"
    if [ -f "$QUOTA_ALERTED" ]; then SUMMARY="$SUMMARY; seat limit reached since $(head -n 1 "$QUOTA_ALERTED")"; fi
    if limit_holds_remaining; then SUMMARY="$SUMMARY; limit hold: $(limit_held_names | paste -sd, - | sed 's/,/, /g')"; fi
    set -- "$SUMMARY"
    if [ "$AUTH_HELD" = 1 ] && [ -z "$SESSION_CONFIG_DIR_BASE" ]; then
      # the summary keeps machine fields in ISO UTC; the second line is for people (operator's time, #89)
      AUTH_SINCE="$(head -n 1 "$AUTH_EXPIRED")"
      AUTH_HELD_NAMES="$(auth_held_names)"
      SUMMARY="$SUMMARY; auth: expired since $AUTH_SINCE, relaunches held"
      set -- "$SUMMARY" "$(human_text "Claude Code login expired on $HOST_NAME since $AUTH_SINCE. Run \`/login\` in any session (or \`claude /login\`); the fleet resumes on the next supervisor tick.${AUTH_HELD_NAMES:+ Relaunches held: $AUTH_HELD_NAMES.}")"
    elif [ -n "$SESSION_CONFIG_DIR_BASE" ] && [ "$AUTH_HELD_SET" != " " ]; then
      AUTH_HELD_NAMES="$(printf '%s' "$AUTH_HELD_SET" | xargs | sed 's/ /, /g')"
      SUMMARY="$SUMMARY; auth: own login expired for $AUTH_HELD_NAMES (only those are held)"
      set -- "$SUMMARY" "$(human_text "The Claude Code login of $AUTH_HELD_NAMES expired on $HOST_NAME (each session has its own login; the other sessions keep running). Log each in with CLAUDE_CONFIG_DIR=${SESSION_CONFIG_DIR_BASE%/}/<session> claude, then /login; it resumes on the next supervisor tick.")"
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
