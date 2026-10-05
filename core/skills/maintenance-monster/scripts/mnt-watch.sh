#!/usr/bin/env bash
# mnt-watch.sh — Maintenance Monster event bus. Designed to run under a
# persistent Monitor: polls GitHub in a shell loop and emits ONE LINE PER
# STATE CHANGE, so the model sleeps free between events and wakes within one
# interval.
#
# Events:
#   DEPENDABOT_PR #N <title>   new open Dependabot PR
#   DEP_ALERT <id> <pkg> <sev> new open Dependabot (dependency) alert
#   CODEQL_ALERT <id> <rule> <sev>  new open code-scanning alert
#   SECRET_ALERT <run>         latest Secret Scan workflow_run concluded failure
#   TRIVY_RED <run>            latest push/dispatch services-ci run concluded failure
#   BATON_LOST maintain <code>   this session lost the maintain baton: stop all mutations now (the
#                          bus exits; the alert is already sent)
#   BATON_HANDOVER maintain <fleet>  federation.yml moved the role's home: finish (never mid-merge),
#                          post the handover digest, release
#   BATON_RENEW_ERROR maintain <code>  renews failing (once per streak); fences refuse past the deadline
#   BATON_IDLE maintain …        keepalive stopped: no model activity for --pulse-max
#   STOP                       ledger issue closed (kill switch) — script exits
#
# GHAS surfaces (Dependabot alerts, CodeQL) may be disabled/forbidden for a
# repo — each gh call is individually guarded so one failing surface never
# kills the loop.
#
# Usage: mnt-watch.sh --repo owner/name --state-dir DIR [--interval 30]
#                     [--default-branch main] [--ledger N]
#                    [--session NAME] [--pulse-max 20m]
#
# Baton keepalive (engsys#62, #87): while <state-dir>/baton-maintain.json carries this session's token,
# a `baton.mjs keepalive` renews the lease every 2.5 min (the caller rule: TTL 10 min, renew <= 3m20s;
# the heartbeat tick is far too slow). It runs DETACHED, not as a child of this bus: a Monitor ends
# (expiry, crash, re-arm gap) and the renewer must not end with it. This bus asks `keepalive --detach`
# to adopt the session's running renewer (pidfile <state-dir>/baton-maintain.keepalive.pid, checked by
# pid and process start time) or start one, and never kills it on exit. The renewer stops when its
# session process (the claude process found by walking up past the shells) is gone, when the token is
# released or lost, and when the model has not touched the baton for --pulse-max (default 20m, so a
# wedged or dead model never keeps the role). Its BATON_* lines go to <state-dir>/baton-maintain.events,
# which this bus relays (offset in <state-dir>/.watch/baton-events.off, so a new bus also reports what
# happened while no bus ran; only `BATON_<NAME> maintain …` lines, capped at 300 characters). When the
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
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "usage: mnt-watch.sh --repo owner/name --state-dir DIR" >&2; exit 2; }

W="$DIR/.watch"
mkdir -p "$W"
touch "$W/deps_pr.tsv" "$W/dep_alerts.tsv" "$W/codeql_alerts.tsv" "$W/secretrun.txt" "$W/trivyrun.txt"

# --- baton keepalive (see the header) ----------------------------------------
BATON_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/lease/baton.mjs"
BATON_STATE="$DIR/baton-maintain.json"
KEEP_PIDFILE="$DIR/baton-maintain.keepalive.pid"
KEEP_EVENTS="$DIR/baton-maintain.events"
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
      | awk -v logf="$DIR/baton-maintain.keepalive.log" '
          $0 == "" { next }
          /^BATON_[A-Z_]+ maintain( |$)/ { print substr($0, 1, 300); next }
          { print "relay: dropped a line that is not a maintain BATON_* event: " substr($0, 1, 120) >> logf }')
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
  if [ -f "$DIR/baton-maintain.lost" ]; then
    if [ "$LOST_SAID" = 0 ]; then
      code=$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' "$DIR/baton-maintain.lost" | head -1)
      echo "BATON_LOST maintain ${code:-lost}"
    fi
    return 1
  fi
  [ -f "$BATON_STATE" ] && grep -q '"token": "' "$BATON_STATE" || return 0
  [ -n "$SESSION" ] || return 0
  if [ -n "$KEEP_PID" ] && kill -0 "$KEEP_PID" 2>/dev/null; then return 0; fi
  if [ "$ENSURED" = 1 ] && keepalive_running; then return 0; fi
  out=$(node "$BATON_LIB" keepalive --detach --role maintain --repo "$REPO" --state-dir "$DIR" --session "$SESSION" \
    --pulse-max "$PULSE_MAX" 2>>"$DIR/baton-maintain.keepalive.log") || true
  ENSURED=1
  case "$out" in
    *'"code":"no_owner"'*)
      # never beside a detached renewer that is already running for this state dir (one renewer)
      keepalive_running && return 0
      node "$BATON_LIB" keepalive --role maintain --repo "$REPO" --state-dir "$DIR" --session "$SESSION" \
        --pulse-max "$PULSE_MAX" &
      KEEP_PID=$! ;;
    *'"code":"idle"'*) relay_events ;;
  esac
  return 0
}

# emit_diff <old-file> <new-file> <added-prefix> [removed-prefix]
# Files are sorted "key<TAB>rest" lines. Diffs by KEY ONLY (column 1) so
# metadata edits (e.g. an alert's summary text) don't fire false add/remove
# events.
emit_diff() {
  old="$1"; new="$2"; addp="$3"; remp="${4:-}"
  # Guard: a transient-empty fetch (gh hiccup/rate-limit returning 0 rows with
  # exit 0) must NOT wipe a populated baseline — the next good fetch would then
  # re-emit the full set as new (a spurious event storm). Empty new + non-empty
  # old → skip this cycle and keep the baseline.
  if [ ! -s "$new" ] && [ -s "$old" ]; then rm -f "$new"; return; fi
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

  # --- new open Dependabot PRs ----------------------------------------------
  if OUT=$(gh pr list -R "$REPO" --author "app/dependabot" --state open --limit 200 --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/deps_pr.new"
    emit_diff "$W/deps_pr.tsv" "$W/deps_pr.new" "DEPENDABOT_PR"
  fi

  # --- new open Dependabot (dependency vulnerability) alerts ---------------
  # Tolerates 404/403 — GHAS Dependabot alerts may be disabled for the repo.
  if OUT=$(gh api --paginate "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
      --jq '.[] | "\(.number)\t\(.dependency.package.name)\t\(.security_advisory.severity)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/dep_alerts.new"
    emit_diff "$W/dep_alerts.tsv" "$W/dep_alerts.new" "DEP_ALERT"
  fi

  # --- new open CodeQL / code-scanning alerts -------------------------------
  # Tolerates 404/403 — GHAS code scanning may be disabled for the repo.
  if OUT=$(gh api --paginate "repos/$REPO/code-scanning/alerts?state=open&per_page=100" \
      --jq '.[] | "\(.number)\t\(.rule.id)\t\(.rule.security_severity_level // "unknown")"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/codeql_alerts.new"
    emit_diff "$W/codeql_alerts.tsv" "$W/codeql_alerts.new" "CODEQL_ALERT"
  fi

  # --- latest Secret Scan workflow_run went red -----------------------------
  # Only record runs with a terminal conclusion — recording an in-progress
  # run id would suppress its SECRET_ALERT when it later concludes failure.
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "Secret Scan" --limit 1 \
      --json databaseId,conclusion \
      --jq '.[0] | "\(.databaseId)\t\(.conclusion)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    LAST=$(cat "$W/secretrun.txt" 2>/dev/null || echo 0)
    if [ -n "$CONCL" ] && [ "$CONCL" != "null" ]; then
      # Guard against GitHub transiently serving a STALE older run as "latest"
      # (seen in practice → repeated false alerts). Run ids increase
      # monotonically, so only act on a genuinely newer id; ignore older reads
      # entirely (no emit, no state regression).
      if [ "${RUNID:-0}" -gt "${LAST:-0}" ] 2>/dev/null; then
        if [ "$CONCL" = "failure" ]; then echo "SECRET_ALERT $RUNID"; fi
        echo "$RUNID" > "$W/secretrun.txt"
      fi
    fi
  fi

  # --- latest push/dispatch services-ci run went red (Trivy is push-only) --
  # Only record runs with a terminal conclusion, same guard as above — an
  # in-progress push run must not suppress its own eventual TRIVY_RED.
  # Deliberately push-scoped, not widened to workflow_dispatch: this loop is
  # a red-main DETECTOR, not the Phase-2 fix-validator, and watching dispatch
  # runs would double-handle the guardrail's own `force_all` runs.
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "services-ci.yml" \
      --event push --limit 1 --json databaseId,conclusion \
      --jq '.[0] | "\(.databaseId)\t\(.conclusion)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    LAST=$(cat "$W/trivyrun.txt" 2>/dev/null || echo 0)
    if [ -n "$CONCL" ] && [ "$CONCL" != "null" ]; then
      # Same stale-read guard as SECRET_ALERT: require a strictly newer run id.
      if [ "${RUNID:-0}" -gt "${LAST:-0}" ] 2>/dev/null; then
        if [ "$CONCL" = "failure" ]; then echo "TRIVY_RED $RUNID"; fi
        echo "$RUNID" > "$W/trivyrun.txt"
      fi
    fi
  fi

  sleep "$INTERVAL"
done
