#!/usr/bin/env bash
# broker-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the Resource Broker ledger
# issue body with the current UTC time and a short status. The block is the line
#
#   last: <ISO-8601 UTC> — status: <text>
#
# between `<!-- broker-heartbeat -->` markers; the fleet supervisor parses exactly that line to decide
# whether the session is fresh, asked to rotate ("rotation requested") or ended ("session end").
#
# Usage: broker-heartbeat.sh [--repo owner/name] [--issue N] [--status "text"]
#                            [--config FILE | --config-dir DIR]
# --repo / --issue default to `repo` / `ledger_issue` of resource-broker.yml.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

REPO="" ISSUE="" STATUS="running" CONFIG="" CONFIG_DIR=""
usage() { echo "usage: broker-heartbeat.sh [--repo owner/name] [--issue N] [--status text] [--config FILE | --config-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --issue) [ $# -ge 2 ] || usage; ISSUE="$2"; shift 2 ;;
    --status) [ $# -ge 2 ] || usage; STATUS="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_var REPO repo
broker_fill_var ISSUE ledger_issue
{ [ -n "$REPO" ] && [ -n "$ISSUE" ] && [ "$ISSUE" != 0 ]; } || { echo "broker-heartbeat: need --repo and --issue (or a resource-broker.yml with repo and a real ledger_issue)" >&2; exit 2; }

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# The status travels through the environment, not `awk -v`, so a backslash in it is never interpreted.
gh issue view "$ISSUE" -R "$REPO" --json body --jq .body | BROKER_NOW="$NOW" BROKER_STATUS="$STATUS" awk '
  /<!-- broker-heartbeat -->/  { print; print "last: " ENVIRON["BROKER_NOW"] " — status: " ENVIRON["BROKER_STATUS"]; skip=1; next }
  /<!-- \/broker-heartbeat -->/ { skip=0 }
  skip != 1 { print }
' > "$TMP"

# Refuse to wipe the body unless exactly one open/close marker pair survived the rewrite: zero means
# the markers were missing, more than one means the body is already malformed; either way
# auto-editing would make it worse.
OPEN_COUNT=$(grep -c "<!-- broker-heartbeat -->" "$TMP" || true)
CLOSE_COUNT=$(grep -c "<!-- /broker-heartbeat -->" "$TMP" || true)
if [ "$OPEN_COUNT" != 1 ] || [ "$CLOSE_COUNT" != 1 ]; then
  echo "ERROR: expected exactly one <!-- broker-heartbeat --> and one <!-- /broker-heartbeat --> marker in issue #$ISSUE body, found $OPEN_COUNT open / $CLOSE_COUNT close — not editing" >&2
  exit 1
fi

gh issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null
echo "heartbeat: $NOW ($STATUS)"
