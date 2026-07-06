#!/usr/bin/env bash
# mm-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the
# ledger issue body with the current UTC time and a short status.
#
# Usage: mm-heartbeat.sh --repo owner/name --issue N [--status "text"]
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
[ -n "$REPO" ] && [ -n "$ISSUE" ] || { echo "usage: mm-heartbeat.sh --repo owner/name --issue N [--status text]" >&2; exit 2; }

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

gh issue view "$ISSUE" -R "$REPO" --json body --jq .body | awk -v now="$NOW" -v status="$STATUS" '
  /<!-- mm-heartbeat -->/  { print; print "last: " now " — status: " status; skip=1; next }
  /<!-- \/mm-heartbeat -->/ { skip=0 }
  skip != 1 { print }
' > "$TMP"

# Refuse to wipe the body if the markers were missing.
if ! grep -q "mm-heartbeat" "$TMP"; then
  echo "ERROR: heartbeat markers not found in issue #$ISSUE body — not editing" >&2
  exit 1
fi

gh issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null
echo "heartbeat: $NOW ($STATUS)"
