#!/usr/bin/env bash
# mnt-heartbeat.sh — refresh the baton: rewrite the heartbeat block in the
# Maintenance Monster ledger issue body with the current UTC time and a short
# status.
#
# Usage: mnt-heartbeat.sh --repo owner/name --issue N [--status "text"] [--state-dir DIR [--session NAME]]
#                       [--rotate-context-tokens 300000] [--transcript PATH]
#   --state-dir  the monster's state_dir: renew this session's maintain baton first (engsys#62). The
#                heartbeat is the HOLDER's human surface, so without a held baton it is not written:
#                exit 1 + BATON_LOST (lost: stop all mutations now) or exit 5 (no baton in this
#                session). The renew retries a transient error (transport, 5xx, 429, secondary
#                rate limit) after 2 s and 6 s while the local deadline holds (engsys#87); an error
#                that remains writes the heartbeat only while the local deadline holds (else exit 3). Prints BATON_HANDOVER <fleet> when federation.yml
#                moved the role's home away from this fleet.
#   --rotate-context-tokens  context-aware rotation (engsys#125), with --state-dir: when the session's last
#                main-thread usage (input + cache creation + cache read, from the last 64 KB of its
#                transcript) is over this (default 300000; 0 = off) and nothing is active (no
#                <state-dir>/active, no running subagent), the status becomes `rotation requested — ctx <N>k`
#                and stays so for that transcript, and a ROTATION_REQUESTED line says what to do. The
#                transcript is the one the SessionStart hook recorded for ENGSYS_SESSION (--transcript wins).
set -euo pipefail
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve
# shellcheck source=../../../lib/monster.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/monster.sh"

REPO="" ISSUE="" STATUS="running" STATE_DIR="" SESSION="" ROTATE=300000 TRANSCRIPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --state-dir=*) STATE_DIR="${1#--state-dir=}"; shift ;;
    --session) SESSION="$2"; shift 2 ;;
    --rotate-context-tokens) ROTATE="$2"; shift 2 ;;
    --transcript) TRANSCRIPT="$2"; shift 2 ;;
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

MONSTER_ROTATION=0
if [ -n "$STATE_DIR" ]; then
  monster_rotation_status "$STATE_DIR" "$STATUS" "$ROTATE" "$TRANSCRIPT"
  STATUS="$MONSTER_STATUS"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

"$FLEET_GH" issue view "$ISSUE" -R "$REPO" --json body --jq .body | awk -v now="$NOW" -v status="$STATUS" '
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

"$FLEET_GH" issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null
[ -z "$STATE_DIR" ] || monster_heartbeat_mark "$STATE_DIR" # the tick writes the next one only when due
echo "heartbeat: $NOW ($STATUS)"
if [ "$MONSTER_ROTATION" = 1 ]; then
  echo "ROTATION_REQUESTED maintain ($STATUS) with nothing active: post the session-end digest, release the baton (mnt-baton.sh release --reason rotation) and stop; the fleet supervisor relaunches the session"
fi
