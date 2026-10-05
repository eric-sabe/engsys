#!/usr/bin/env bash
# mnt-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the
# Maintenance Monster ledger issue body with the current UTC time and a short
# status.
#
# Usage: mnt-heartbeat.sh --repo owner/name --issue N [--status "text"] [--state-dir DIR [--session NAME]]
#   --state-dir  the monster's state_dir: renew this session's maintain baton first (engsys#62). The
#                heartbeat is the HOLDER's human surface, so without a held baton it is not written:
#                exit 1 + BATON_LOST (lost: stop all mutations now) or exit 5 (no baton in this
#                session). The renew retries a transient error (transport, 5xx, 429, secondary
#                rate limit) after 2 s and 6 s while the local deadline holds (engsys#87); an error
#                that remains writes the heartbeat only while the local deadline holds (else exit 3). Prints BATON_HANDOVER <fleet> when federation.yml
#                moved the role's home away from this fleet.
set -euo pipefail

REPO="" ISSUE="" STATUS="running" STATE_DIR="" SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --state-dir=*) STATE_DIR="${1#--state-dir=}"; shift ;;
    --session) SESSION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$ISSUE" ] || { echo "usage: mnt-heartbeat.sh --repo owner/name --issue N [--status text] [--state-dir DIR [--session NAME]]" >&2; exit 2; }

if [ -n "$STATE_DIR" ]; then
  BATON_RC=0
  BATON_OUT=$(node "$(dirname "${BASH_SOURCE[0]}")/../../../lib/lease/baton.mjs" renew --role maintain --repo "$REPO" \
    --state-dir "$STATE_DIR" ${SESSION:+--session "$SESSION"}) || BATON_RC=$?
  case "$BATON_RC" in
    0) if printf '%s' "$BATON_OUT" | jq -e '.handover' >/dev/null 2>&1; then
         echo "BATON_HANDOVER $(printf '%s' "$BATON_OUT" | jq -r '.handover.home // "none"')"
       fi ;;
    1) echo "BATON_LOST maintain: heartbeat not written; stop all mutations now: $BATON_OUT"; exit 1 ;;
    5) echo "baton: this session holds no maintain baton; heartbeat not written: $BATON_OUT"; exit 5 ;;
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
