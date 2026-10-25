#!/usr/bin/env bash
# mm-watch.sh — Merge Monster event bus. Designed to run under a persistent
# Monitor: polls GitHub in a shell loop and emits ONE LINE PER STATE CHANGE,
# so the model sleeps free between events and wakes within one interval.
#
# Events:
#   READY #N <title>       PR gained the mm:ready label
#   UNREADY #N             PR lost the mm:ready label (before being queued)
#                          Both from a persistent per-PR record of what was last emitted (.watch/ready.tsv, engsys#272):
#                          a PR whose labels stay put (mm:ready + mm:blocked, the parked-gate state) never re-emits,
#                          a list that is not a JSON array is no answer, and UNREADY needs the PR missing from two
#                          successful polls in a row, so one short or failed read never flaps READY/UNREADY.
#   GATE_REVIEW #N review=<STATE> | merge_state=BLOCKED-><state>
#                          engsys#272: on a PR parked mm:blocked (an operator gate), a review was submitted or the
#                          mergeStateStatus left BLOCKED (an approval often does both): run gate-check for #N now.
#                          Once per change (.watch/gate.tsv); a PR's first parked cycle only records, and a PR missing
#                          from one poll keeps its record (two-poll rule). Both lists come from one GraphQL
#                          repository.pullRequests(labels:) read, never the search-backed `gh pr list --label`.
#   CHECK_FAIL #N <name>: <concl>  a check on the ACTIVE PR ended in a non-success (failure, cancelled,
#                          timed out, …); once per (check, conclusion) per head. Successes are silent.
#   CHECKS_READY #N head=<sha> state=<mergeStateStatus> pending=<n>
#                          ONCE per (PR, head sha): the active PR is CLEAN / HAS_HOOKS / UNSTABLE, or
#                          no check is pending any more (latched in .watch/ready.<pr>.<sha>)
#   CONFLICT #N            a queued/ready PR turned DIRTY (needs rebase)
#   DEPENDABOT #N <title>  new Dependabot PR opened (not with --no-dependabot, which is on by itself
#                          when the --config's dependabot.auto_merge is empty or absent: a maintenance
#                          watchdog owns Dependabot there)
#   MAIN_RED <workflow>    latest default-branch run concluded failure
#                          (merge-gating only: skips event=schedule; deduped
#                          by run id so a persistent failure fires once)
#   BATON_LOST merge <code>   this session lost the merge baton: stop all mutations now (the
#                          bus exits; the alert is already sent)
#   BATON_HANDOVER merge <fleet>  federation.yml moved the role's home: finish (never mid-merge),
#                          post the handover digest, release
#   BATON_RENEW_ERROR merge <code>  renews failing (once per streak); fences refuse past the deadline
#   BATON_IDLE merge …        keepalive stopped: no model activity for --pulse-max
#   FLEET_MSG              a cross-fleet message is waiting in this session's inbox (engsys#77; multi-fleet only):
#                          run the command the line names (msg.mjs inbox --mark-read), then msg.mjs read <url>
#   VERDICT_WAKE #N label_removed | nyx_review_comment
#                          engsys#241: a PR lost the security-review request label (config security_review_label,
#                          default security-review-requested), or a new `<!-- nyx-review -->` comment landed on a PR
#                          that carries it: the verdict may have landed. Re-run preflight for #N (and re-check its
#                          gate request at that head). The tick re-preflights such PRs every time as the backstop.
#                          The labeled list comes from the same mmLists GraphQL read (never search), and label_removed
#                          needs the PR missing from two polls in a row (engsys#272).
#   STOP                   ledger issue closed (kill switch) — script exits
#   HANDBACK_INCOMPLETE <agent> (<id>): <remains>
#                         a subagent handed back unfinished work (the engsys hand-back hook's log
#                         for this session and launch; engsys#126 review)
#   AGENT_OVERDUE / AGENT_STALE …  the subagent watchdog (mm-agent-watch.sh --once, run every cycle
#                          while <state-dir>/agents.tsv exists): one bus per monster (engsys#122)
#   FHD_CHANGE <service> <state>[ — hold merges][, pause claims]   (fixed words only, never board text)
#                          Fleet Health Desk (engsys#98): emitted once per service state change on the
#                          status board (when fhd_board_issue, ENGSYS_FHD_BOARD_ISSUE, or cache is configured)
#
# The active PR number is read each cycle from <state-dir>/active, so one
# persistent monitor serves the whole session.
#
# Usage: mm-watch.sh --repo owner/name --state-dir DIR [--interval 30]
#                    [--default-branch main] [--ledger N]
#                    [--session NAME] [--pulse-max 20m]
#                    [--config FILE] [--health-config FILE] [--heartbeat-minutes 10]
#                    [--stale-min 10] [--no-stale] [--no-agents] [--no-dependabot]
#   --stale-min / --no-stale  passed to the subagent scan (liveness.stale_minutes / stale_probe: false)
#   --no-agents               skip the subagent scan (it is a no-op anyway without a spawn registry)
#   --pulse-max               the keepalive's idle bound. Default (engsys#123): the config's pulse_max, else
#                             2.25 x heartbeat_minutes (--heartbeat-minutes, else the config's), else 20m
#   --stale-lock-minutes      with heartbeat_minutes, bounds pulse_max so the lease always lapses before
#                             the heartbeat reads stale (a CONFIG_WARNING line says when it clamps)
#   --config                  the monster's yml, read for pulse_max, heartbeat_minutes, stale_lock_minutes and dependabot.auto_merge,
#                             and one more source for the review label (core/lib/security-sensitive.mjs review-label)
#   --health-config           optional fleet-health.yml path for Fleet Health Desk board watching (must be
#                             inside the fleet instance repo or FLEET_STATE; default: the trusted one there)
#   --no-dependabot           skip the Dependabot PR poll (no DEPENDABOT events)
#
# Baton keepalive (engsys#62, #87): while <state-dir>/baton-merge.json carries this session's token,
# a `baton.mjs keepalive` renews the lease every 2.5 min (the caller rule: TTL 10 min, renew <= 3m20s;
# the heartbeat tick is far too slow). It runs DETACHED, not as a child of this bus: a Monitor ends
# (expiry, crash, re-arm gap) and the renewer must not end with it. This bus asks `keepalive --detach`
# to adopt the session's running renewer (pidfile <state-dir>/baton-merge.keepalive.pid, checked by
# pid and process start time) or start one, and never kills it on exit. The renewer stops when its
# session process (the claude process found by walking up past the shells) is gone, when the token is
# released or lost, and when the model has not touched the baton for --pulse-max (2.25 x the tick, so a
# wedged or dead model never keeps the role). Its BATON_* lines go to <state-dir>/baton-merge.events,
# which this bus relays (offset in <state-dir>/.watch/baton-events.off, so a new bus also reports what
# happened while no bus ran; only `BATON_<NAME> merge …` lines, capped at 300 characters). When the
# session process is not the claude CLI, the renewer runs attached to this bus as before, unless a
# detached one is already running for this state dir. --session defaults to ENGSYS_SESSION.
set -u
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve
# shellcheck source=../../../lib/monster.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/monster.sh"

REPO="" DIR="" INTERVAL=30 DEFBRANCH=main LEDGER="" SESSION="${ENGSYS_SESSION:-}" PULSE_MAX="" CONFIG="" HB_MIN="" STALE_LOCK=""
STALE_MIN=10 NOSTALE="" AGENTS=1 NO_DEPENDABOT=0 HEALTH_CFG="${FLEET_HEALTH_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --state-dir) DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --default-branch) DEFBRANCH="$2"; shift 2 ;;
    --ledger) LEDGER="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --pulse-max) PULSE_MAX="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --health-config) HEALTH_CFG="$2"; shift 2 ;;
    --heartbeat-minutes) HB_MIN="$2"; shift 2 ;;
    --stale-lock-minutes) STALE_LOCK="$2"; shift 2 ;;
    --stale-min) STALE_MIN="$2"; shift 2 ;;
    --no-stale) NOSTALE=1; shift ;;
    --no-agents) AGENTS=0; shift ;;
    --no-dependabot) NO_DEPENDABOT=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "usage: mm-watch.sh --repo owner/name --state-dir DIR" >&2; exit 2; }
[ -n "$HB_MIN" ] || HB_MIN="$(monster_cfg_scalar "$CONFIG" heartbeat_minutes)"
# engsys#124: with no auto-merge categories, Merge Monster never touches a raw Dependabot PR (the
# maintenance watchdog owns them), so the poll would only wake it for nothing.
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ] && monster_cfg_list_empty "$CONFIG" dependabot auto_merge; then NO_DEPENDABOT=1; fi
[ -n "$STALE_LOCK" ] || STALE_LOCK="$(monster_cfg_scalar "$CONFIG" stale_lock_minutes)"
FHD_BOARD_ISSUE="${ENGSYS_FHD_BOARD_ISSUE:-$(monster_cfg_scalar "$CONFIG" fhd_board_issue)}"
PULSE_OUT="$(monster_pulse_max "${PULSE_MAX:-$(monster_cfg_scalar "$CONFIG" pulse_max)}" "$HB_MIN" "$STALE_LOCK")"
PULSE_MAX="${PULSE_OUT%%$'\t'*}" PULSE_WARN="${PULSE_OUT#*$'\t'}"
ROTATE_OUT="$(monster_rotate_tokens "$(monster_cfg_scalar "$CONFIG" rotate_context_tokens)")"
ROTATE_WARN="${ROTATE_OUT#*$'\t'}"
# the label preflight names (the same discovery, --config as one more source; engsys#231)
monster_review_label "$REPO" "$CONFIG"
REVIEW_LABEL="$MONSTER_REVIEW_LABEL"   # a conflict: CONFIG_WARNING below (escalate once), and on stderr

W="$DIR/.watch"
mkdir -p "$W"
touch "$W/ready.tsv" "$W/deps.tsv" "$W/dirty.tsv" "$W/checks.tsv" "$W/mainrun.txt"
[ -z "$PULSE_WARN" ] || echo "CONFIG_WARNING ${PULSE_WARN:0:280}"
[ -z "$ROTATE_WARN" ] || echo "CONFIG_WARNING ${ROTATE_WARN:0:280}"
[ -z "$MONSTER_REVIEW_LABEL_WARN" ] || { echo "CONFIG_WARNING ${MONSTER_REVIEW_LABEL_WARN:0:280}"; echo "mm-watch: $MONSTER_REVIEW_LABEL_WARN" >&2; }
monster_handback_prune "$DIR" # drop earlier launches' hand-back lines (engsys#137 review)

# --- baton keepalive (see the header) ----------------------------------------
BATON_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/lease/baton.mjs"
BATON_STATE="$DIR/baton-merge.json"
KEEP_PIDFILE="$DIR/baton-merge.keepalive.pid"
KEEP_EVENTS="$DIR/baton-merge.events"
KEEP_PID=""    # only the attached fallback; a detached renewer is never this bus's to kill
ENSURED=0      # asked baton.mjs once this run (it adopts or replaces another launch's renewer)
LOST_SAID=0
INIT_PPID="$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')"
trap '[ -z "$KEEP_PID" ] || kill "$KEEP_PID" 2>/dev/null || true' EXIT
# keepalive_running → 0 when the pidfile names a live process with the recorded start time (a recycled
# pid has another start time).
keepalive_running() {
  local kp kstart rest
  [ -f "$KEEP_PIDFILE" ] && IFS='|' read -r kp kstart rest <"$KEEP_PIDFILE" || return 1
  case "$kp" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$kstart" ] && [ "$(ps -o lstart= -p "$kp" 2>/dev/null | awk '{$1=$1; print}')" = "$kstart" ]
}
# relay_events: print the renewer's BATON_* lines this bus has not printed yet. Only a line that looks
# like one of this role's events reaches the Monitor (the model's context), capped at 300 characters;
# anything else in the file goes to the log, never to the model.
relay_events() {
  local size off new
  if [ ! -f "$KEEP_EVENTS" ]; then printf '0\n' >"$W/baton-events.off"; return 0; fi
  size=$(wc -c <"$KEEP_EVENTS" | tr -d ' ')
  off=$(cat "$W/baton-events.off" 2>/dev/null || true)
  case "$off" in '' | *[!0-9]*) off="$size" ;; esac # events from before any bus kept an offset: no replay
  [ "$off" -le "$size" ] || off=0                     # the file was replaced
  if [ "$size" -gt "$off" ]; then
    new=$(tail -c +"$((off + 1))" "$KEEP_EVENTS" | head -c "$((size - off))" \
      | awk -v logf="$DIR/baton-merge.keepalive.log" '
          $0 == "" { next }
          /^BATON_[A-Z_]+ merge( |$)/ { print substr($0, 1, 300); next }
          { print "relay: dropped a line that is not a merge BATON_* event: " substr($0, 1, 120) >> logf }')
    [ -z "$new" ] || printf '%s\n' "$new"
    case "$new" in *"BATON_LOST "*) LOST_SAID=1 ;; esac
  fi
  printf '%s\n' "$size" >"$W/baton-events.off"
}
# baton_tick → 1 when the bus must stop (baton lost, or this bus outlived its session).
baton_tick() {
  local out code
  # Orphaned (reparented to init since start): the session is gone. A bus started without a parent
  # can't tell, and leans on the keepalive's own bounds instead.
  if [ "$INIT_PPID" != 1 ] && [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = 1 ]; then return 1; fi
  relay_events
  if [ -f "$DIR/baton-merge.lost" ]; then
    if [ "$LOST_SAID" = 0 ]; then
      code=$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' "$DIR/baton-merge.lost" | head -1)
      echo "BATON_LOST merge ${code:-lost}"
    fi
    return 1
  fi
  [ -f "$BATON_STATE" ] && grep -q '"token": "' "$BATON_STATE" || return 0
  [ -n "$SESSION" ] || return 0
  if [ -n "$KEEP_PID" ] && kill -0 "$KEEP_PID" 2>/dev/null; then return 0; fi
  if [ "$ENSURED" = 1 ] && keepalive_running; then return 0; fi
  out=$(node "$BATON_LIB" keepalive --detach --role merge --repo "$REPO" --state-dir "$DIR" --session "$SESSION" \
    --pulse-max "$PULSE_MAX" 2>>"$DIR/baton-merge.keepalive.log") || true
  ENSURED=1
  case "$out" in
    *'"code":"no_owner"'*)
      # never beside a detached renewer that is already running for this state dir (one renewer)
      keepalive_running && return 0
      node "$BATON_LIB" keepalive --role merge --repo "$REPO" --state-dir "$DIR" --session "$SESSION" \
        --pulse-max "$PULSE_MAX" &
      KEEP_PID=$! ;;
    *'"code":"idle"'*) relay_events ;;
  esac
  return 0
}

# emit_diff <old-file> <new-file> <added-prefix> [removed-prefix]
# Files are sorted "key<TAB>rest" lines. Diffs by KEY ONLY (column 1) so
# metadata edits (e.g. a PR title change) don't fire false add/remove events.
emit_diff() {
  old="$1"; new="$2"; addp="$3"; remp="${4:-}"
  cut -f1 "$old" | sort -u > "$old.k"
  cut -f1 "$new" | sort -u > "$new.k"
  comm -13 "$old.k" "$new.k" | while IFS= read -r key; do
    [ -n "$key" ] && echo "$addp $(awk -F'\t' -v k="$key" '$1==k {print; exit}' "$new")"
  done
  if [ -n "$remp" ]; then
    comm -23 "$old.k" "$new.k" | while IFS= read -r key; do
      [ -n "$key" ] && echo "$remp $key"
    done
  fi
  rm -f "$old.k" "$new.k"
  mv "$new" "$old"
}

# ready_diff: READY / UNREADY from .watch/ready.new against the persistent record (engsys#272). ready.tsv holds the
# PRs last emitted READY (key #N, then the title); ready.gone the ones missing from the last successful poll but not
# yet reported. READY only for a key not in the record; UNREADY only for a key missing from two polls in a row. A key
# that comes back while it is pending is still on record: no READY again.
ready_diff() {
  local tab k
  tab="$(printf '\t')"
  touch "$W/ready.tsv" "$W/ready.gone"
  cut -f1 "$W/ready.tsv" | LC_ALL=C sort -u >"$W/ready.old.k"
  cut -f1 "$W/ready.new" | LC_ALL=C sort -u >"$W/ready.new.k"
  LC_ALL=C sort -u -o "$W/ready.gone" "$W/ready.gone"
  LC_ALL=C comm -13 "$W/ready.old.k" "$W/ready.new.k" | while IFS= read -r k; do
    [ -n "$k" ] && echo "READY $(awk -F'\t' -v k="$k" '$1==k {print; exit}' "$W/ready.new")"
  done
  LC_ALL=C comm -23 "$W/ready.old.k" "$W/ready.new.k" >"$W/ready.absent"
  LC_ALL=C comm -12 "$W/ready.gone" "$W/ready.absent" | while IFS= read -r k; do [ -n "$k" ] && echo "UNREADY $k"; done
  LC_ALL=C comm -23 "$W/ready.absent" "$W/ready.gone" >"$W/ready.pending"   # missing for the first time: kept on record
  { cat "$W/ready.new"; awk -F'\t' 'NR==FNR {p[$1]=1; next} ($1 in p)' "$W/ready.pending" "$W/ready.tsv"; } \
    | LC_ALL=C sort -t "$tab" -k1,1 -u >"$W/ready.keep"
  mv "$W/ready.keep" "$W/ready.tsv"; mv "$W/ready.pending" "$W/ready.gone"
  rm -f "$W/ready.old.k" "$W/ready.new.k" "$W/ready.absent" "$W/ready.new"
}

# gate_events: GATE_REVIEW from .watch/gate.new (number, mergeStateStatus, review count, latest review state) against
# .watch/gate.tsv (engsys#272). A PR parked on an operator gate gets its approval as a review, and the approval usually
# moves mergeStateStatus off BLOCKED: either is an unambiguous trigger to run gate-check, which the 20-minute tick
# would otherwise be left to catch. A PR's first parked cycle only records. A row missing from one poll is kept
# (.watch/gate.gone) and dropped only when it is missing from the next one too, the same two-poll rule as READY: a
# transient miss must not reset a parked PR to "first cycle" and swallow an approval that lands meanwhile.
gate_events() {
  touch "$W/gate.tsv" "$W/gate.gone"
  awk -F'\t' 'NR==FNR {mss[$1]=$2; cnt[$1]=$3; next}
    ($1 in cnt) {
      if ($3 + 0 > cnt[$1] + 0) print "GATE_REVIEW #" $1 " review=" $4
      else if (mss[$1] == "BLOCKED" && $2 != "BLOCKED") print "GATE_REVIEW #" $1 " merge_state=BLOCKED->" $2
    }' "$W/gate.tsv" "$W/gate.new"
  cut -f1 "$W/gate.new" | LC_ALL=C sort -u >"$W/gate.new.k"
  # missing for the first time: carried over; missing again (in gate.gone): dropped
  awk -F'\t' 'FILENAME == ARGV[1] {seen[$1]=1; next} FILENAME == ARGV[2] {gone[$1]=1; next}
    !($1 in seen) && !($1 in gone)' "$W/gate.new.k" "$W/gate.gone" "$W/gate.tsv" >"$W/gate.carry"
  cut -f1 "$W/gate.carry" >"$W/gate.gone"
  cat "$W/gate.new" "$W/gate.carry" | LC_ALL=C sort -n >"$W/gate.tsv"
  rm -f "$W/gate.new" "$W/gate.new.k" "$W/gate.carry"
}

# --- cross-fleet inbox (engsys#77) ---------------------------------------------
# The relay records messages for this session in $FLEET_INBOX_DIR/<session>.jsonl (fleet launch sets
# FLEET_INBOX_DIR in multi-fleet mode). One fixed FLEET_MSG line per new undelivered entry, read with
# grep (no node per tick); the line carries no message content, only the command to run.
INBOX_FILE="" MSG_CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../fleet" 2>/dev/null && pwd)/msg.mjs"
case "$SESSION" in '' | *[!a-z0-9-]*) ;; *) [ -z "${FLEET_INBOX_DIR:-}" ] || INBOX_FILE="$FLEET_INBOX_DIR/$SESSION.jsonl" ;; esac
touch "$W/inbox.seen"
inbox_event() {
  [ -n "$INBOX_FILE" ] && [ -f "$INBOX_FILE" ] || return 0
  grep -F '"delivered_at":null' "$INBOX_FILE" 2>/dev/null | grep -oE '^\{"id":[0-9]+' | sort -u >"$W/inbox.new" || true
  if [ -n "$(comm -13 "$W/inbox.seen" "$W/inbox.new")" ]; then
    echo "FLEET_MSG cross-fleet message waiting: run node $MSG_CLI inbox --mark-read"
  fi
  mv "$W/inbox.new" "$W/inbox.seen"
}

# --- subagent liveness (engsys#122) ---------------------------------------------
# The watchdog's scan runs inside this bus, once per cycle, so a monster keeps ONE Monitor. The scan's
# latches and lock live in <state-dir>/.watch, shared with a tick's `mm-agent-watch.sh --once` backstop,
# so the two never emit the same transition twice.
AGENT_WATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mm-agent-watch.sh"
agents_event() {
  [ "$AGENTS" = 1 ] && [ -f "$DIR/agents.tsv" ] || return 0
  bash "$AGENT_WATCH" --state-dir "$DIR" --once --stale-min "$STALE_MIN" ${NOSTALE:+--no-stale} 2>>"$W/agent-watch.err" || true
}

# --- Fleet Health Desk (engsys#98) ----------------------------------------------
# Watches the status board (with conditional ETag caching) and emits FHD_CHANGE once per state change.
FHD_CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../fleet/health" 2>/dev/null && pwd -P)/cli.mjs"
# The registry comes only from the fleet instance repo or FLEET_STATE (the launcher sets both); never from the
# repo's monster config (fhd_config) or this state dir (engsys#180). An explicit --health-config / FLEET_HEALTH_FILE
# is still checked against those roots by the CLI.
if [ -z "$HEALTH_CFG" ] && [ -f "$FHD_CLI" ]; then HEALTH_CFG="$(node "$FHD_CLI" registry-path 2>/dev/null || true)"; fi
fhd_event() {
  [ -f "$FHD_CLI" ] || return 0
  if [ -n "$FHD_BOARD_ISSUE" ] || [ -n "${ENGSYS_FHD_BOARD_CACHE:-}" ] || [ -f "$DIR/fhd/board-cache.json" ] || { [ -n "$HEALTH_CFG" ] && [ -f "$HEALTH_CFG" ]; }; then
    node "$FHD_CLI" watch-board --state-dir "$DIR" --repo "$REPO" --role merge \
      ${FHD_BOARD_ISSUE:+--issue "$FHD_BOARD_ISSUE"} ${HEALTH_CFG:+--file "$HEALTH_CFG"} 2>>"$W/fhd.err" || true
  fi
}

# --- security verdict landing (engsys#241) -------------------------------------
# The security lane posts a signed `<!-- nyx-review -->` comment and removes the request label: neither is an mm: label
# or a check, so nothing above sees it. secreview.tsv holds the PRs that carried the label last cycle; nyx.seen the
# nyx-review comment ids seen on them (the first cycle of a fresh state dir, and a PR's first labeled cycle, only record, so
# a restart or a new label does not fire for a comment that was already there).
# A failed read changes nothing (no false "label removed"), and the list comes from the mmLists GraphQL read (not search),
# with the two-poll rule for label_removed (engsys#272).
NYX_RE='^\s*<!-- nyx-review -->'
verdict_event() {
  local n ids id woke first=0
  # the review list from this cycle's mmLists read (engsys#272: not search); none this cycle is no answer, never
  # "no label anywhere"
  [ -n "${LISTS_RAW:-}" ] || return 0
  printf '%s' "$LISTS_RAW" | jq -r --arg rl "$(printf '%s' "$REVIEW_LABEL" | tr '[:upper:]' '[:lower:]')" \
    '.data.repository.review.nodes[] | select(any(.labels.nodes[]?; (.name | ascii_downcase) == $rl)) | .number' 2>/dev/null \
    | LC_ALL=C sort -u >"$W/secreview.new" || return 0
  [ -f "$W/secreview.tsv" ] || first=1
  touch "$W/secreview.tsv" "$W/secreview.gone" "$W/nyx.seen"
  LC_ALL=C sort -u -o "$W/secreview.gone" "$W/secreview.gone"
  # label_removed needs the PR missing from two polls in a row (secreview.gone), as READY does: one short read never wakes
  LC_ALL=C comm -23 "$W/secreview.tsv" "$W/secreview.new" >"$W/secreview.absent"
  [ "$first" = 1 ] || LC_ALL=C comm -12 "$W/secreview.gone" "$W/secreview.absent" | while IFS= read -r n; do
    [ -n "$n" ] && echo "VERDICT_WAKE #$n label_removed"
  done
  LC_ALL=C comm -23 "$W/secreview.absent" "$W/secreview.gone" >"$W/secreview.pending"   # missing once: still on record
  : >"$W/nyx.new"
  while IFS= read -r n; do
    case "$n" in '' | *[!0-9]*) continue ;; esac
    ids=$("$FLEET_GH" api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F number="$n" -f query='
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(last: 10) { nodes { id body } } } } }' 2>/dev/null \
      | jq -r --arg re "$NYX_RE" '.data.repository.pullRequest.comments.nodes[]? | select((.body // "") | test($re)) | .id' 2>/dev/null) || continue
    # a PR newly labeled this cycle only records its existing comments: the wake is for a verdict that lands after
    # the request (an older nyx-review comment is preflight's business, and the tick re-preflights the PR anyway)
    woke=0; grep -qxF "$n" "$W/secreview.tsv" || woke=1
    for id in $ids; do
      printf '%s\t%s\n' "$n" "$id" >>"$W/nyx.new"
      if [ "$first" = 0 ] && [ "$woke" = 0 ] && ! grep -qxF "$(printf '%s\t%s' "$n" "$id")" "$W/nyx.seen"; then
        echo "VERDICT_WAKE #$n nyx_review_comment"; woke=1
      fi
    done
  done <"$W/secreview.new"
  # bounded: the newest PRs' entries are kept
  LC_ALL=C sort -u "$W/nyx.seen" "$W/nyx.new" | sort -t "$(printf '\t')" -k1,1n | tail -n 2000 >"$W/nyx.keep" && mv "$W/nyx.keep" "$W/nyx.seen"
  LC_ALL=C sort -u "$W/secreview.new" "$W/secreview.pending" >"$W/secreview.tsv"
  mv "$W/secreview.pending" "$W/secreview.gone"; rm -f "$W/secreview.new" "$W/secreview.absent"
}

while true; do
  baton_tick || exit 0
  agents_event
  monster_handback_events "$DIR" # INCOMPLETE hand-backs (engsys#126 review)
  # Once, after the baton check (a lost baton exits quietly first): an unauthenticated gh must
  # surface as an event, never as a bus that sees nothing (engsys#90).
  if [ -z "${GH_AUTH_CHECKED:-}" ]; then assert_gh_auth mm-watch event || exit 1; GH_AUTH_CHECKED=1; fi
  # --- kill switch: ledger issue closed → STOP and exit -------------------
  if [ -n "$LEDGER" ]; then
    STATE=$(gh issue view "$LEDGER" -R "$REPO" --json state --jq .state 2>/dev/null || echo "")
    if [ "$STATE" = "CLOSED" ]; then echo "STOP"; exit 0; fi
  fi

  # --- new / withdrawn mm:ready PRs, operator-gate wakes on parked PRs, the review request label (engsys#272) ------
  # One GraphQL read of the three label lists from repository.pullRequests(labels:, states: OPEN): the repository's own
  # index, NOT `gh pr list --label`, which goes through the eventually consistent search API and can leave a PR out of
  # a poll while search reindexes it (keystone#4694). An answer without data.repository is no answer. 100 per list.
  # verdict_event (below) reads the review list from LISTS_RAW, set only by a good answer this cycle.
  LISTS_RAW=""
  if RAW=$("$FLEET_GH" api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -f review="$REVIEW_LABEL" -f query='
      query mmLists($owner: String!, $name: String!, $review: String!) { repository(owner: $owner, name: $name) {
        ready: pullRequests(labels: ["mm:ready"], states: OPEN, first: 100) { nodes { number title labels(first: 30) { nodes { name } } } }
        blocked: pullRequests(labels: ["mm:blocked"], states: OPEN, first: 100) {
          nodes { number mergeStateStatus labels(first: 30) { nodes { name } } reviews(last: 1) { totalCount nodes { state } } } }
        review: pullRequests(labels: [$review], states: OPEN, first: 100) { nodes { number labels(first: 30) { nodes { name } } } } } }' 2>/dev/null) \
      && printf '%s' "$RAW" | jq -e '[.data.repository.ready.nodes, .data.repository.blocked.nodes, .data.repository.review.nodes] | all(type == "array")' >/dev/null 2>&1; then
    LISTS_RAW="$RAW"
    printf '%s' "$RAW" | jq -r '.data.repository.ready.nodes[] | select(any(.labels.nodes[]?; .name == "mm:ready"))
        | "#\(.number)\t\(.title // "" | gsub("[\t\r\n]"; " "))"' \
      | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -u > "$W/ready.new"
    ready_diff
    printf '%s' "$RAW" | jq -r '.data.repository.blocked.nodes[] | select(any(.labels.nodes[]?; .name == "mm:blocked"))
        | [.number, (.mergeStateStatus // "UNKNOWN"), (.reviews.totalCount // 0), (.reviews.nodes[-1].state // "-")] | @tsv' \
      | LC_ALL=C sort -n > "$W/gate.new"
    gate_events
  fi

  # --- new Dependabot PRs ---------------------------------------------------
  if [ "$NO_DEPENDABOT" = 0 ] && OUT=$("$FLEET_GH" pr list -R "$REPO" --author "app/dependabot" --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/deps.new"
    emit_diff "$W/deps.tsv" "$W/deps.new" "DEPENDABOT"
  fi

  # --- queued/ready PRs turning DIRTY (conflict) ----------------------------
  if OUT=$("$FLEET_GH" pr list -R "$REPO" --json number,labels,mergeStateStatus \
      --jq '.[] | select((.labels | map(.name) | any(. == "mm:ready" or . == "mm:queued" or . == "mm:active"))
                  and .mergeStateStatus == "DIRTY") | "#\(.number)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/dirty.new"
    emit_diff "$W/dirty.tsv" "$W/dirty.new" "CONFLICT"
  fi

  # --- checks on the ACTIVE PR, coalesced (engsys#124) -----------------------
  # A success wakes nobody. CHECK_FAIL fires once per (check, conclusion) on any terminal non-success;
  # CHECKS_READY fires ONCE per (PR, head sha), latched in .watch/ready.<pr>.<sha>, when GitHub calls the
  # PR mergeable-ish (CLEAN, HAS_HOOKS, UNSTABLE) or no check is pending any more. checks.tsv is a
  # union of the terminal (name, conclusion) pairs seen for this PR at this head, NOT a last snapshot:
  # the rollup can flicker between polls (pagination, superseded runs), and a snapshot diff re-emits
  # whatever vanishes and returns. It resets when the active PR or its head changes.
  # A RE-RUN on the same head (`gh run rerun --failed`): a check seen terminal goes PENDING again. Its
  # pairs leave checks.tsv and the ready latch is cleared, so the re-run's result fires CHECK_FAIL again
  # (same conclusion or not) or CHECKS_READY again; until every re-run check is terminal, no CHECKS_READY
  # (not even on UNSTABLE), so the event carries the re-run's outcome. Re-run names: .watch/rerun.<pr>.<sha>.
  # The PR number from <state-dir>/active ("12", "#12" and a trailing note all read as 12).
  ACTIVE=$(sed -n '1s/^[#[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/active" 2>/dev/null || true)
  if [ -n "$ACTIVE" ]; then
    if OUT=$("$FLEET_GH" pr view "$ACTIVE" -R "$REPO" --json headRefOid,mergeStateStatus,statusCheckRollup --jq '
        "HEAD\t\(.headRefOid)\t\(.mergeStateStatus)",
        (.statusCheckRollup[]?
         | if .__typename == "CheckRun"
           then (if .status == "COMPLETED" then "DONE\t\(.name)\t\(.conclusion)" else "PENDING\t\(.name)\t-" end)
           else (if .state == "PENDING" or .state == "EXPECTED" then "PENDING\t\(.context)\t-" else "DONE\t\(.context)\t\(.state)" end)
           end)' 2>/dev/null); then
      SHA=$(printf '%s\n' "$OUT" | awk -F'\t' '$1 == "HEAD" { print $2; exit }')
      MSS=$(printf '%s\n' "$OUT" | awk -F'\t' '$1 == "HEAD" { print $3; exit }')
      case "$SHA" in '' | *[!0-9a-f]*) SHA="" ;; esac
      if [ -n "$SHA" ]; then
        if [ "$ACTIVE@$SHA" != "$(cat "$W/checks.pr" 2>/dev/null || true)" ]; then
          : > "$W/checks.tsv"
          printf '%s' "$ACTIVE@$SHA" > "$W/checks.pr"
          # latches of other PRs (merged, closed, parked) are done with: a re-activated PR re-fires once
          find "$W" -maxdepth 1 \( -name 'ready.[0-9]*.*' -o -name 'rerun.[0-9]*.*' \) ! -name "ready.$ACTIVE.*" ! -name "rerun.$ACTIVE.*" -exec rm -f {} + 2>/dev/null || true
        fi
        RERUN="$W/rerun.$ACTIVE.$SHA"
        # One collation (C) for every sort and comm here, and the persisted history re-sorted first.
        printf '%s\n' "$OUT" | awk -F'\t' '$1 == "PENDING" && $2 != "" { print $2 }' | LC_ALL=C sort -u > "$W/checks.pending"
        LC_ALL=C sort -u -o "$W/checks.tsv" "$W/checks.tsv"
        # pending names that were terminal before: a re-run
        awk -F'\t' 'FILENAME == ARGV[1] { p[$1] = 1; next } ($1 in p) { print $1 }' "$W/checks.pending" "$W/checks.tsv" | LC_ALL=C sort -u > "$W/checks.rerun"
        if [ -s "$W/checks.rerun" ]; then
          awk -F'\t' 'FILENAME == ARGV[1] { r[$1] = 1; next } !($1 in r)' "$W/checks.rerun" "$W/checks.tsv" > "$W/checks.keep" && mv "$W/checks.keep" "$W/checks.tsv"
          { cat "$W/checks.rerun"; cat "$RERUN" 2>/dev/null || true; } | LC_ALL=C sort -u > "$RERUN.new" && mv "$RERUN.new" "$RERUN"
          rm -f "$W/ready.$ACTIVE.$SHA"
        fi
        # terminal pairs of a check that is also pending (a superseded run beside its re-run) wait for it
        printf '%s\n' "$OUT" | awk -F'\t' '$1 == "DONE" && $2 != "" { print $2 "\t" $3 }' | LC_ALL=C sort -u \
          | awk -F'\t' 'FILENAME == ARGV[1] { p[$1] = 1; next } !($1 in p)' "$W/checks.pending" - > "$W/checks.new"
        LC_ALL=C comm -13 "$W/checks.tsv" "$W/checks.new" | while IFS="$(printf '\t')" read -r name concl; do
          case "$concl" in SUCCESS | NEUTRAL | SKIPPED | '') ;; *) echo "CHECK_FAIL #$ACTIVE $name: $concl" ;; esac
        done
        LC_ALL=C sort -u "$W/checks.tsv" "$W/checks.new" > "$W/checks.union" && mv "$W/checks.union" "$W/checks.tsv"
        rm -f "$W/checks.new" "$W/checks.rerun"
        TOTAL=$(printf '%s\n' "$OUT" | awk -F'\t' '$1 == "DONE" || $1 == "PENDING"' | wc -l | tr -d ' ')
        PENDING=$(printf '%s\n' "$OUT" | awk -F'\t' '$1 == "PENDING"' | wc -l | tr -d ' ')
        READY=0
        case "$MSS" in CLEAN | HAS_HOOKS | UNSTABLE) READY=1 ;; esac
        [ "$TOTAL" -gt 0 ] && [ "$PENDING" = 0 ] && READY=1
        if [ -s "$RERUN" ]; then
          if [ -n "$(LC_ALL=C comm -12 "$RERUN" "$W/checks.pending")" ]; then READY=0; else rm -f "$RERUN"; fi
        fi
        if [ "$READY" = 1 ] && [ ! -e "$W/ready.$ACTIVE.$SHA" ]; then
          : > "$W/ready.$ACTIVE.$SHA"
          echo "CHECKS_READY #$ACTIVE head=${SHA:0:12} state=$MSS pending=$PENDING"
        fi
      fi
    fi
  fi

  # --- default branch went red ----------------------------------------------
  # MAIN_RED is for MERGE-GATING failures only. Scheduled runs (nightly suites,
  # cron jobs) red a background surface, not the merge queue, so a persistent
  # scheduled failure must NOT keep waking the orchestrator. Two guards:
  #   1. Evaluate the newest NON-schedule run (filtered in the query), so a
  #      scheduled run on top of the list can't hide a real failure beneath it.
  #   2. Dedup by run id in a set file: each failing run emits at most once,
  #      even if it keeps resurfacing as "newest".
  # In-progress runs are never recorded, so one still emits once it concludes
  # failure.
  if OUT=$("$FLEET_GH" run list -R "$REPO" --branch "$DEFBRANCH" --limit 20 \
      --json databaseId,conclusion,workflowName,event \
      --jq 'map(select(.event != "schedule")) | .[0] | select(.)
            | "\(.databaseId)\t\(.conclusion)\t\(.workflowName)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    WF=$(echo "$OUT" | cut -f3)
    if [ -n "$RUNID" ] && [ "$CONCL" = "failure" ] \
       && ! grep -qxF "$RUNID" "$W/main-red.tsv" 2>/dev/null; then
      echo "MAIN_RED $WF"
      echo "$RUNID" >> "$W/main-red.tsv"
    fi
  fi

  verdict_event
  fhd_event
  inbox_event
  sleep "$INTERVAL"
done
