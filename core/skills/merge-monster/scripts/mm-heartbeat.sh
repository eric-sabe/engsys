#!/usr/bin/env bash
# mm-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the
# ledger issue body with the current UTC time and a short status.
#
# Usage: mm-heartbeat.sh --repo owner/name --issue N [--status "text"] [--state-dir DIR [--session NAME]]
#   --state-dir  the monster's state_dir: renew this session's merge baton first (engsys#62). The
#                heartbeat is the HOLDER's human surface, so without a held baton it is not written:
#                exit 1 + BATON_LOST (lost: stop all mutations now) or exit 5 (no baton in this
#                session). A renew error writes the heartbeat only while the local deadline holds
#                (else exit 3). Prints BATON_HANDOVER <fleet> when federation.yml
#                moved the role's home away from this fleet.
set -euo pipefail

REPO="" ISSUE="" STATUS="running" STATE_DIR="" SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$ISSUE" ] || { echo "usage: mm-heartbeat.sh --repo owner/name --issue N [--status text] [--state-dir DIR [--session NAME]]" >&2; exit 2; }

if [ -n "$STATE_DIR" ]; then
  BATON_RC=0
  BATON_OUT=$(node "$(dirname "${BASH_SOURCE[0]}")/../../../lib/lease/baton.mjs" renew --role merge --repo "$REPO" \
    --state-dir "$STATE_DIR" ${SESSION:+--session "$SESSION"}) || BATON_RC=$?
  case "$BATON_RC" in
    0) if printf '%s' "$BATON_OUT" | jq -e '.handover' >/dev/null 2>&1; then
         echo "BATON_HANDOVER $(printf '%s' "$BATON_OUT" | jq -r '.handover.home // "none"')"
       fi ;;
    1) echo "BATON_LOST merge: heartbeat not written; stop all mutations now: $BATON_OUT"; exit 1 ;;
    5) echo "baton: this session holds no merge baton; heartbeat not written: $BATON_OUT"; exit 5 ;;
    *) # A renew that errored: write the heartbeat only while the local deadline still holds, so a
       # session that may have lost the baton never keeps the shared ledger looking fresh.
       if printf '%s' "$BATON_OUT" | jq -e '(.deadlineInMs // 0) > 0' >/dev/null 2>&1; then
         echo "WARNING baton renew failed (exit $BATON_RC), still inside the local deadline; writing the heartbeat: $BATON_OUT" >&2
       else
         echo "baton renew failed (exit $BATON_RC) and the local deadline has passed (or is unknown); heartbeat not written: $BATON_OUT"
         exit 3
       fi ;;
  esac
fi

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
