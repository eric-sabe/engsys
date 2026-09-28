#!/usr/bin/env bash
# shellcheck disable=SC2034 # POOL_FILE, STORE and OWNER_PATTERN are consumed by broker_pool / broker_lease in the sourced broker-config.sh
# broker-reconcile.sh — session-startup reconcile against durable truth.
#
# The broker never trusts an in-memory picture of the pool across a restart or compaction. This runs
#   1. the generic durable-lease sweep over the owner fence (`lease-cli reconcile`: reaps expired
#      leases whose owner is inside the fence, reports but never touches foreign records), then
#   2. one pool maintenance pass (`pool-cli pump`: reaps dead slot leases, drops silent queue entries),
# and prints a human-readable summary for the session-start ledger digest, ending in one
# machine-readable line:
#
#   RECONCILE reaped=N dropped=M held=H free=F unknown=U total=T queued=Q
#
# A failing pump is a HARD STOP (exit 1): the script refuses to fabricate an empty pool state, which
# would read as "0/0 slots held", i.e. healthy, when the truth is unknown.
#
# Usage: broker-reconcile.sh [--owner OWNER] [--pool FILE] [--store DIR] [--owner-pattern REGEX]
#                            [--config FILE | --config-dir DIR]
# Every value defaults to resource-broker.yml (lease.owner, lease.pool_file, lease.store,
# lease.owner_pattern); POOL_CLI / LEASE_CLI override where the CLIs are found.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

OWNER="" POOL_FILE="" STORE="" OWNER_PATTERN="" CONFIG="" CONFIG_DIR="" SESSION_NAME=""
usage() { echo "usage: broker-reconcile.sh [--owner OWNER] [--pool FILE] [--store DIR] [--owner-pattern REGEX] [--config FILE | --config-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) [ $# -ge 2 ] || usage; OWNER="$2"; shift 2 ;;
    --pool) [ $# -ge 2 ] || usage; POOL_FILE="$2"; shift 2 ;;
    --store) [ $# -ge 2 ] || usage; STORE="$2"; shift 2 ;;
    --owner-pattern) [ $# -ge 2 ] || usage; OWNER_PATTERN="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_var OWNER lease.owner
broker_fill_var SESSION_NAME session_name
[ -n "$OWNER" ] || OWNER="${SESSION_NAME:-resource-broker}"
broker_fill_path POOL_FILE lease.pool_file
broker_fill_path STORE lease.store
broker_fill_var OWNER_PATTERN lease.owner_pattern
broker_setup_pool || exit 1

# Each CLI prints one JSON object on stdout; anything on stderr is kept apart so it can never corrupt the JSON.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

echo "== durable-lease reconcile (lease-cli reconcile) =="
if ! LEASE_RECONCILE=$(broker_lease reconcile 2>"$ERR"); then
  echo "WARN: lease reconcile failed — continuing with the pool pump anyway" >&2
  echo "$LEASE_RECONCILE" >&2
  cat "$ERR" >&2
  LEASE_RECONCILE='{}'
fi
echo "$LEASE_RECONCILE" | jq '.' 2>/dev/null || echo "$LEASE_RECONCILE"

echo
echo "== pool pump (pool-cli pump --owner $OWNER) =="
if ! POOL_PUMP=$(broker_pool pump --owner "$OWNER" 2>"$ERR") || ! jq -e '.ok == true' >/dev/null 2>&1 <<<"$POOL_PUMP"; then
  echo "ERROR: pool pump failed — refusing to report a fabricated empty pool state" >&2
  echo "  (0/0 slots held would look healthy but is unknown). Do not proceed to the" >&2
  echo "  heartbeat or arm the watcher until this is retried or escalated." >&2
  echo "$POOL_PUMP" >&2
  cat "$ERR" >&2
  exit 1
fi
echo "$POOL_PUMP" | jq '.'

echo
echo "== slots =="
echo "$POOL_PUMP" | jq -r '.status.slots[] | "slot \(.slot_id) (\(.kind)): \(.state)" + (if .holder then " by \(.holder), lease expires \(.expiresAt)" else "" end)'
echo "$POOL_PUMP" | jq -r '.status.queue[] | "waiter #\(.position): \(.session) (\(.mode)), eta ~\((.etaMs / 60000) | ceil)m"'

echo
echo "== summary =="
# Leases the durable-lease sweep reaped (any kind inside the fence) plus the dead slot leases the pump reaped.
LEASE_REAPED=$(echo "$LEASE_RECONCILE" | jq '.reaped // [] | length' 2>/dev/null || echo 0)
PUMP_REAPED=$(echo "$POOL_PUMP" | jq '.reapedSlots // [] | length')
REAPED=$((LEASE_REAPED + PUMP_REAPED))
# `droppedEntries` is the list of dropped queue entries; a count is accepted too.
DROPPED=$(echo "$POOL_PUMP" | jq '.droppedEntries // 0 | if type == "array" then length else . end')
HELD=$(echo "$POOL_PUMP" | jq '[.status.slots[] | select(.state == "held")] | length')
FREE=$(echo "$POOL_PUMP" | jq '[.status.slots[] | select(.state == "free")] | length')
UNKNOWN=$(echo "$POOL_PUMP" | jq '[.status.slots[] | select(.state == "unknown")] | length')
TOTAL=$(echo "$POOL_PUMP" | jq '.status.slots | length')
QUEUED=$(echo "$POOL_PUMP" | jq '.status.queue | length')
echo "reaped $REAPED dead lease(s) ($LEASE_REAPED by the lease sweep, $PUMP_REAPED by the pool pump), dropped $DROPPED stale queue entry(ies) on startup"
echo "pool: $HELD/$TOTAL slots held, $QUEUED waiter(s) queued"
[ "$UNKNOWN" = 0 ] || echo "WARN: $UNKNOWN slot(s) still read unknown after the pump: a lease that could not be reaped needs a look"
echo "RECONCILE reaped=$REAPED dropped=$DROPPED held=$HELD free=$FREE unknown=$UNKNOWN total=$TOTAL queued=$QUEUED"
