#!/usr/bin/env bash
# shellcheck disable=SC2034 # POOL_FILE, STORE and OWNER_PATTERN are consumed by broker_pool / broker_lease in the sourced broker-config.sh
# broker-watch.sh — Resource Broker event bus. Designed to run under a persistent Monitor: polls the
# pool in a shell loop and emits ONE LINE PER STATE CHANGE, so the model sleeps free between events
# and wakes within one interval.
#
# Every tick drives the pool's ACTIVE reaping pass (`pool-cli pump`): the one thing the lazy pool
# cannot do for itself, since it only reaps inside another caller's acquire/request/release. Session
# boundary: this loop only ACTUATES (reap dead leases, relay grant nudges). It never decides
# environment health or what a failure means.
#
# Slot transitions never wake the model (engsys#124): they are journaled here, in bash, to
# <state-dir>/journal-YYYY-MM.{md,jsonl}, with running totals in <state-dir>/.watch/slot-counters.json
# (the tick's occupancy delta carries them):
#   slot_reaped <slot> <prev-owner>   the pump's dead-man's switch freed a slot
#   slot_granted <slot> <holder>      a slot went free/queued -> held (the grant happened in the lessee's
#                                     own process)
#   slot_released <slot>              a held slot went to free/queued
#
# Events:
#   QUEUE_DROPPED <n>                 the pump dropped N silent (dead-waiter) queue entries
#   WAITER_QUEUED <session> <mode> <position>
#                                     a session joined the queue because the pool is saturated
#   NUDGE <session> <json>            a queued async-grant nudge to relay to <session> with
#                                     SendMessage. The JSON is {event, session, request_id, slot_id}
#                                     only: the fencing token and the grant env never leave the store
#   PUMP_FAILED <reason>              the pump failed (first failure of a streak): the watcher is
#                                     blind until PUMP_OK; reconcile before trusting any picture
#   PUMP_OK                           the pump recovered
#   STOP                              ledger issue closed (kill switch); the script exits
#   HANDBACK_INCOMPLETE <agent> (<id>): <remains>
#                                    a subagent handed back unfinished work (the engsys hand-back hook's log
#                                    for this session and launch; engsys#126 review)
#   AGENT_OVERDUE / AGENT_STALE …     the subagent watchdog (merge-monster's mm-agent-watch.sh --once, run
#                                     every tick while <state-dir>/agents.tsv exists): one bus per monster
#                                     (engsys#122)
#
# --once runs a single tick and exits (the synchronous backstop for the fallback tick, and the test
# hook). State lives under <state-dir>/.watch: the last slot picture and a nudge cursor, so a restart
# resumes instead of re-emitting history. On the very first run (no cursor yet) the existing nudge
# history is skipped, not replayed.
#
# Usage: broker-watch.sh [--repo owner/name] [--state-dir DIR] [--interval 30] [--ledger N]
#                        [--owner OWNER] [--pool FILE] [--store DIR] [--owner-pattern REGEX]
#                        [--config FILE | --config-dir DIR] [--once]
#                        [--stale-min 10] [--no-stale] [--no-agents]
# --stale-min / --no-stale go to the subagent scan (liveness.stale_minutes / stale_probe: false);
# --no-agents skips it (a no-op anyway without a spawn registry).
# Every value defaults to resource-broker.yml (repo, state_dir, poll_interval, ledger_issue,
# lease.owner, lease.pool_file, lease.store, lease.owner_pattern). In multi-fleet mode the ledger is the
# fleet's status issue and the owner and fence are fleet-qualified (broker-config.sh).
set -u
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"
# shellcheck source=../../../lib/monster.sh
. "$here/../../../lib/monster.sh"

REPO="" DIR="" INTERVAL="" LEDGER="" OWNER="" POOL_FILE="" STORE="" OWNER_PATTERN="" CONFIG="" CONFIG_DIR="" ONCE=0
STALE_MIN=10 NOSTALE="" AGENTS=1
usage() { echo "usage: broker-watch.sh [--repo owner/name] [--state-dir DIR] [--interval N] [--ledger N] [--owner OWNER] [--pool FILE] [--store DIR] [--config FILE | --config-dir DIR] [--once] [--stale-min N] [--no-stale] [--no-agents]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || usage; DIR="$2"; shift 2 ;;
    --interval) [ $# -ge 2 ] || usage; INTERVAL="$2"; shift 2 ;;
    --ledger) [ $# -ge 2 ] || usage; LEDGER="$2"; shift 2 ;;
    --owner) [ $# -ge 2 ] || usage; OWNER="$2"; shift 2 ;;
    --pool) [ $# -ge 2 ] || usage; POOL_FILE="$2"; shift 2 ;;
    --store) [ $# -ge 2 ] || usage; STORE="$2"; shift 2 ;;
    --owner-pattern) [ $# -ge 2 ] || usage; OWNER_PATTERN="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --stale-min) [ $# -ge 2 ] || usage; STALE_MIN="$2"; shift 2 ;;
    --no-stale) NOSTALE=1; shift ;;
    --no-agents) AGENTS=0; shift ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_ledger REPO LEDGER || exit 2
broker_fill_var DIR state_dir
broker_fill_var INTERVAL poll_interval
broker_fill_owner OWNER OWNER_PATTERN || exit 2
[ -n "$DIR" ] || DIR="logs/resource-broker"
[ -n "$INTERVAL" ] || INTERVAL=30
broker_fill_path POOL_FILE lease.pool_file
broker_fill_path STORE lease.store

{ [ -n "$REPO" ] && [ -n "$LEDGER" ] && [ "$LEDGER" != 0 ]; } || {
  echo "broker-watch: need --repo and --ledger (or a resource-broker.yml with repo and a real ledger_issue)" >&2
  exit 2
}
case "$INTERVAL" in
  '' | *[!0-9]*)
    echo "broker-watch: --interval must be a positive integer (got '$INTERVAL')" >&2
    exit 2
    ;;
esac
if [ "$INTERVAL" -le 0 ]; then
  echo "broker-watch: --interval must be a positive integer (got '$INTERVAL'): a zero interval would busy-loop the pool CLI" >&2
  exit 2
fi
assert_gh_auth broker-watch event || exit 1
broker_setup_pool || exit 2

W="$DIR/.watch"
mkdir -p "$W"
[ -s "$W/slots.json" ] || echo '[]' >"$W/slots.json"
PUMP_BAD=0
POOL_DIR=""

# slot_journal <event> <slot> [who]: one line in each monthly journal, and the running counters.
slot_journal() {
  local ev="$1" slot="$2" who="${3:-}" ts month c
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); month=$(date -u +%Y-%m)
  jq -cn --arg ts "$ts" --arg ev "$ev" --arg slot "$slot" --arg who "$who" \
    '{ts: $ts, event: $ev, slot: $slot} + (if $who == "" then {} else {who: $who} end) + {by: "broker-watch"}' \
    >>"$DIR/journal-$month.jsonl"
  printf -- '- %s %s slot %s%s (broker-watch)\n' "$ts" "$ev" "$slot" "${who:+ $who}" >>"$DIR/journal-$month.md"
  c="$W/slot-counters.json"
  [ -s "$c" ] || echo '{}' >"$c"
  jq -c --arg ev "$ev" '.[$ev] = ((.[$ev] // 0) + 1)' "$c" >"$c.tmp" 2>/dev/null && mv "$c.tmp" "$c"
}

# The subagent watchdog's scan, once per tick, so the broker keeps ONE Monitor (engsys#122). Its latches
# and lock live in <state-dir>/.watch, shared with a fallback tick's backstop scan.
AGENT_WATCH="$here/../../merge-monster/scripts/mm-agent-watch.sh"
agents_event() {
  [ "$AGENTS" = 1 ] && [ -f "$DIR/agents.tsv" ] || return 0
  bash "$AGENT_WATCH" --state-dir "$DIR" --once --stale-min "$STALE_MIN" ${NOSTALE:+--no-stale} 2>>"$W/agent-watch.err" || true
}

tick() {
  # Kill switch: ledger issue closed.
  STATE=$(gh issue view "$LEDGER" -R "$REPO" --json state --jq .state 2>/dev/null || echo "")
  if [ "$STATE" = "CLOSED" ]; then
    echo "STOP"
    return 1
  fi
  agents_event
  monster_handback_events "$DIR" # INCOMPLETE hand-backs (engsys#126 review)

  # Active reaping pass (dead-man's-switch sweep + stale-queue-entry drop).
  PUMP_ERR=$(mktemp)
  if PUMP=$(broker_pool pump --owner "$OWNER" 2>"$PUMP_ERR") && jq -e '.ok == true' >/dev/null 2>&1 <<<"$PUMP"; then
    if [ "$PUMP_BAD" = 1 ]; then echo "PUMP_OK"; PUMP_BAD=0; fi
  else
    if [ "$PUMP_BAD" = 0 ]; then
      echo "PUMP_FAILED $(head -c 200 "$PUMP_ERR" | tr '\n' ' ')"
      PUMP_BAD=1
    fi
    rm -f "$PUMP_ERR"
    return 0
  fi
  rm -f "$PUMP_ERR"

  jq -c '.reapedSlots // [] | .[]' <<<"$PUMP" 2>/dev/null | while IFS= read -r reaped; do
    id=$(jq -r '.slot_id' <<<"$reaped")
    prev=$(jq -r '.previousOwner // "unknown"' <<<"$reaped")
    slot_journal slot_reaped "$id" "$prev"
  done

  DROPPED=$(jq -r '.droppedEntries // 0 | if type == "array" then length else . end' <<<"$PUMP" 2>/dev/null || echo 0)
  case "$DROPPED" in '' | *[!0-9]*) DROPPED=0 ;; esac
  [ "$DROPPED" -gt 0 ] && echo "QUEUE_DROPPED $DROPPED"

  # Diff slot held/free state since the last tick (visibility only: grants happen in the lessee's own
  # process via acquire/request, not here). Slot ids may be numbers or strings, so compare as text.
  NEW_SLOTS=$(jq -c '.status.slots // []' <<<"$PUMP" 2>/dev/null || echo '[]')
  if [ -n "$NEW_SLOTS" ] && [ "$NEW_SLOTS" != "null" ]; then
    OLD_SLOTS=$(cat "$W/slots.json" 2>/dev/null || echo '[]')
    jq -c '.[]' <<<"$NEW_SLOTS" 2>/dev/null | while IFS= read -r slot; do
      id=$(jq -r '.slot_id' <<<"$slot")
      state=$(jq -r '.state' <<<"$slot")
      holder=$(jq -r '.holder // "none"' <<<"$slot")
      prev_state=$(jq -r --arg id "$id" '[.[] | select((.slot_id | tostring) == $id) | .state] | first // "unknown"' <<<"$OLD_SLOTS" 2>/dev/null)
      if [ "$state" = "held" ] && [ "$prev_state" != "held" ]; then
        slot_journal slot_granted "$id" "$holder"
      elif [ "$state" != "held" ] && [ "$prev_state" = "held" ]; then
        slot_journal slot_released "$id"
      fi
    done
    echo "$NEW_SLOTS" >"$W/slots.json"
  fi

  # New waiters (saturation made a session queue): visibility for the saturation escalation.
  NEW_QUEUE=$(jq -c '.status.queue // []' <<<"$PUMP" 2>/dev/null || echo '[]')
  OLD_QUEUE=$(cat "$W/queue.json" 2>/dev/null || echo '[]')
  jq -r --argjson old "$OLD_QUEUE" '.[] | select((.request_id as $r | ($old | map(.request_id) | index($r))) == null) | "WAITER_QUEUED \(.session) \(.mode) \(.position)"' <<<"$NEW_QUEUE" 2>/dev/null
  echo "$NEW_QUEUE" >"$W/queue.json"

  # Drain the async-grant nudge channel: the durable jsonl the pool appends to on every async grant.
  # A cursor-based tail, so a restart resumes instead of re-emitting history.
  POOL_DIR=$(jq -r '.status.poolDir // empty' <<<"$PUMP" 2>/dev/null)
  NUDGE_FILE="${POOL_DIR:+$POOL_DIR/nudges.jsonl}"
  if [ -n "$NUDGE_FILE" ]; then
    TOTAL=0
    [ -f "$NUDGE_FILE" ] && TOTAL=$(wc -l <"$NUDGE_FILE" 2>/dev/null | tr -d ' ')
    case "$TOTAL" in '' | *[!0-9]*) TOTAL=0 ;; esac
    if [ ! -f "$W/nudge.cursor" ]; then
      echo "$TOTAL" >"$W/nudge.cursor" # first run: start at the end, never replay old history
    fi
    CURSOR=$(cat "$W/nudge.cursor" 2>/dev/null || echo 0)
    case "$CURSOR" in '' | *[!0-9]*) CURSOR=0 ;; esac
    [ "$CURSOR" -le "$TOTAL" ] || CURSOR=0 # the file was truncated or rotated: start over
    if [ "$TOTAL" -gt "$CURSOR" ]; then
      tail -n "+$((CURSOR + 1))" "$NUDGE_FILE" | head -n "$((TOTAL - CURSOR))" | while IFS= read -r line; do
        [ -n "$line" ] || continue
        session=$(jq -r '.session // empty' <<<"$line" 2>/dev/null)
        [ -n "$session" ] || continue
        slim=$(jq -c '{event, session, request_id, slot_id: (.grant.slot_id // null)}' <<<"$line" 2>/dev/null) || continue
        echo "NUDGE $session $slim"
      done
      echo "$TOTAL" >"$W/nudge.cursor"
    fi
  fi
  return 0
}

if [ "$ONCE" = 1 ]; then
  tick || true
  exit 0
fi
while true; do
  tick || exit 0
  sleep "$INTERVAL"
done
