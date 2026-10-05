#!/usr/bin/env bash
# mm-watch.sh — Merge Monster event bus. Designed to run under a persistent
# Monitor: polls GitHub in a shell loop and emits ONE LINE PER STATE CHANGE,
# so the model sleeps free between events and wakes within one interval.
#
# Events:
#   READY #N <title>       PR gained the mm:ready label
#   UNREADY #N             PR lost the mm:ready label (before being queued)
#   CHECK #N <name>: <s>   check on the ACTIVE PR reached a terminal state
#   CONFLICT #N            a queued/ready PR turned DIRTY (needs rebase)
#   DEPENDABOT #N <title>  new Dependabot PR opened
#   MAIN_RED <workflow>    latest default-branch run concluded failure
#                          (merge-gating only: skips event=schedule; deduped
#                          by run id so a persistent failure fires once)
#   BATON_LOST merge <code>   this session lost the merge baton: stop all mutations now (the
#                          bus exits; the alert is already sent)
#   BATON_HANDOVER merge <fleet>  federation.yml moved the role's home: finish (never mid-merge),
#                          post the handover digest, release
#   BATON_RENEW_ERROR merge <code>  renews failing (once per streak); fences refuse past the deadline
#   BATON_IDLE merge …        keepalive stopped: no model activity for --pulse-max
#   STOP                   ledger issue closed (kill switch) — script exits
#
# The active PR number is read each cycle from <state-dir>/active, so one
# persistent monitor serves the whole session.
#
# Usage: mm-watch.sh --repo owner/name --state-dir DIR [--interval 30]
#                    [--default-branch main] [--ledger N]
#                    [--session NAME] [--pulse-max 20m]
#
# Baton keepalive (engsys#62, #87): while <state-dir>/baton-merge.json carries this session's token,
# a `baton.mjs keepalive` renews the lease every 2.5 min (the caller rule: TTL 10 min, renew <= 3m20s;
# the heartbeat tick is far too slow). It runs DETACHED, not as a child of this bus: a Monitor ends
# (expiry, crash, re-arm gap) and the renewer must not end with it. This bus asks `keepalive --detach`
# to adopt the session's running renewer (pidfile <state-dir>/baton-merge.keepalive.pid, checked by
# pid and process start time) or start one, and never kills it on exit. The renewer stops when its
# session process (the claude process found by walking up past the shells) is gone, when the token is
# released or lost, and when the model has not touched the baton for --pulse-max (default 20m, so a
# wedged or dead model never keeps the role). Its BATON_* lines go to <state-dir>/baton-merge.events,
# which this bus relays (offset in <state-dir>/.watch/baton-events.off, so a new bus also reports what
# happened while no bus ran; only `BATON_<NAME> merge …` lines, capped at 300 characters). When the
# session process is not the claude CLI, the renewer runs attached to this bus as before, unless a
# detached one is already running for this state dir. --session defaults to ENGSYS_SESSION.
set -u

REPO="" DIR="" INTERVAL=30 DEFBRANCH=main LEDGER="" SESSION="${ENGSYS_SESSION:-}" PULSE_MAX=20m
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --state-dir) DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --default-branch) DEFBRANCH="$2"; shift 2 ;;
    --ledger) LEDGER="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --pulse-max) PULSE_MAX="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "usage: mm-watch.sh --repo owner/name --state-dir DIR" >&2; exit 2; }

W="$DIR/.watch"
mkdir -p "$W"
touch "$W/ready.tsv" "$W/deps.tsv" "$W/dirty.tsv" "$W/checks.tsv" "$W/mainrun.txt"

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

while true; do
  baton_tick || exit 0
  # --- kill switch: ledger issue closed → STOP and exit -------------------
  if [ -n "$LEDGER" ]; then
    STATE=$(gh issue view "$LEDGER" -R "$REPO" --json state --jq .state 2>/dev/null || echo "")
    if [ "$STATE" = "CLOSED" ]; then echo "STOP"; exit 0; fi
  fi

  # --- new / withdrawn mm:ready PRs ---------------------------------------
  if OUT=$(gh pr list -R "$REPO" --label mm:ready --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/ready.new"
    emit_diff "$W/ready.tsv" "$W/ready.new" "READY" "UNREADY"
  fi

  # --- new Dependabot PRs ---------------------------------------------------
  if OUT=$(gh pr list -R "$REPO" --author "app/dependabot" --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/deps.new"
    emit_diff "$W/deps.tsv" "$W/deps.new" "DEPENDABOT"
  fi

  # --- queued/ready PRs turning DIRTY (conflict) ----------------------------
  if OUT=$(gh pr list -R "$REPO" --json number,labels,mergeStateStatus \
      --jq '.[] | select((.labels | map(.name) | any(. == "mm:ready" or . == "mm:queued" or . == "mm:active"))
                  and .mergeStateStatus == "DIRTY") | "#\(.number)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/dirty.new"
    emit_diff "$W/dirty.tsv" "$W/dirty.new" "CONFLICT"
  fi

  # --- terminal check states on the ACTIVE PR -------------------------------
  # checks.tsv is a session-cumulative union of seen (name,state) pairs, NOT a
  # last-snapshot: the GitHub rollup set can flicker between polls (pagination /
  # superseded runs), and snapshot-diffing re-emits every line that vanishes and
  # returns. Reset only when the active PR changes.
  ACTIVE=$(cat "$DIR/active" 2>/dev/null || true)
  LASTPR=$(cat "$W/checks.pr" 2>/dev/null || true)
  if [ "$ACTIVE" != "$LASTPR" ]; then
    : > "$W/checks.tsv"
    printf '%s' "$ACTIVE" > "$W/checks.pr"
  fi
  if [ -n "$ACTIVE" ]; then
    if OUT=$(gh pr view "$ACTIVE" -R "$REPO" --json statusCheckRollup --jq '
        .statusCheckRollup[]?
        | if .__typename == "CheckRun"
          then select(.status == "COMPLETED") | "\(.name)\t\(.conclusion)"
          else select(.state != "PENDING" and .state != "EXPECTED") | "\(.context)\t\(.state)"
          end' 2>/dev/null); then
      printf '%s\n' "$OUT" | sed '/^$/d' | sort -u > "$W/checks.new"
      comm -13 "$W/checks.tsv" "$W/checks.new" | while IFS="$(printf '\t')" read -r name state; do
        [ -n "$name" ] && echo "CHECK #$ACTIVE $name: $state"
      done
      sort -u "$W/checks.tsv" "$W/checks.new" > "$W/checks.union" && mv "$W/checks.union" "$W/checks.tsv"
      rm -f "$W/checks.new"
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
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --limit 20 \
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

  sleep "$INTERVAL"
done
