#!/usr/bin/env bash
# mnt-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the
# Maintenance Monster ledger issue body with the current UTC time and a short
# status.
#
# Usage: mnt-heartbeat.sh --repo owner/name --issue N [--status "text"]
set -euo pipefail

REPO="" ISSUE="" STATUS="running"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$ISSUE" ] || { echo "usage: mnt-heartbeat.sh --repo owner/name --issue N [--status text]" >&2; exit 2; }

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

gh issue view "$ISSUE" -R "$REPO" --json body --jq .body | awk -v now="$NOW" -v status="$STATUS" '
  /<!-- mnt-heartbeat -->/  { print; print "last: " now " — status: " status; skip=1; next }
  /<!-- \/mnt-heartbeat -->/ { skip=0 }
  skip != 1 { print }
' > "$TMP"

# Refuse to wipe the body unless exactly one open/close marker pair survived
# the rewrite — zero means the markers were missing, more than one means the
# body is already malformed; either way auto-editing would make it worse.
OPEN_COUNT=$(grep -c "<!-- mnt-heartbeat -->" "$TMP" || true)
CLOSE_COUNT=$(grep -c "<!-- /mnt-heartbeat -->" "$TMP" || true)
if [ "$OPEN_COUNT" != 1 ] || [ "$CLOSE_COUNT" != 1 ]; then
  echo "ERROR: expected exactly one <!-- mnt-heartbeat --> and one <!-- /mnt-heartbeat --> marker in issue #$ISSUE body, found $OPEN_COUNT open / $CLOSE_COUNT close — not editing" >&2
  exit 1
fi

gh issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null
echo "heartbeat: $NOW ($STATUS)"
