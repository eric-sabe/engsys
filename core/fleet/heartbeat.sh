#!/usr/bin/env bash
# heartbeat.sh — fleet heartbeat: write this fleet's own heartbeat onto its status issue
# (federation.yml fleets.<FLEET_ID>.status_issue, in the instance repo), for cross-fleet work
# claiming (core/lib/claim.mjs's parseHeartbeat/HEARTBEAT_FRESH_MS) to read freshness from.
# Design: docs/multi-fleet.md § 3 "Fleet and host roles" (follow-up to #40, #57); the supervisor
# calls this once per tick as its HEARTBEAT_CMD (core/skills/agent-sessions/scripts/fleet-supervisor.sh).
#
#   fleet heartbeat "<one-line summary>"
#
# No-op (exit 0, nothing written) when: FLEET_ID is unset (single-fleet mode), no federation file,
# this fleet has no status_issue declared, or the instance repo can't be resolved. Every gh/node
# call is soft — a failure anywhere is a silent no-op, never a non-zero exit, so a HEARTBEAT_CMD
# failure never shows up as "the command failed" to the supervisor; it only ever shows up as "the
# marker didn't move", which the claim-side age rule tolerates on its own.
#
# Marker (same shape as mm-heartbeat.sh's ledger block; claim.mjs's HEARTBEAT_RE reads it):
#   <!-- fleet-heartbeat -->
#   last: <ISO> — status: <summary>
#   <!-- /fleet-heartbeat -->
# Unlike mm-heartbeat.sh (which refuses to edit a ledger missing the marker), this APPENDS the
# block when the status issue body doesn't have one yet — the status issue is this fleet's own,
# scaffolded once and never hand-authored with the marker pre-written.
#
# The status issue is shared (#54's resource-broker writes its own `<!-- broker-heartbeat -->`
# block on the same issue in multi-fleet mode), so this rewrites only the fleet-heartbeat block —
# never anything outside it — then reads the body back and retries (3 attempts, short jittered
# backoff) when a concurrent edit of the same body dropped the line, the same way
# broker-heartbeat.sh does. Giving up after 3 attempts is still soft (logged to stderr, exit 0):
# the next tick tries again.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

STATUS_TEXT="${1:-ok}"

# Single-fleet mode, or no registry at all: nothing to write.
[ -n "$FLEET_ID" ] || exit 0
[ -f "$FEDERATION_FILE" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

ISSUE="$(node "$FLEET_KIT_DIR/lib/federation.mjs" get "fleets.$FLEET_ID.status_issue" 2>/dev/null)" || exit 0
case "$ISSUE" in '' | *[!0-9]*) exit 0 ;; esac # not declared, or not a bare integer — no-op

REPO="$(cd "$FLEET_REPO" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || exit 0
[ -n "$REPO" ] || exit 0

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The line travels through the environment, not `awk -v`, so a backslash in the status text is
# never interpreted (awk -v runs command-line-assignment escape processing on its value; ENVIRON
# does not).
LINE="last: $NOW — status: $STATUS_TEXT"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

attempt=0
while :; do
  attempt=$((attempt + 1))
  BODY="$(gh issue view "$ISSUE" -R "$REPO" --json body --jq .body 2>/dev/null)" || exit 0

  printf '%s\n' "$BODY" | FLEET_LINE="$LINE" awk '
    /<!-- fleet-heartbeat -->/   { print; print ENVIRON["FLEET_LINE"]; found=1; skip=1; next }
    /<!-- \/fleet-heartbeat -->/ { skip=0 }
    skip != 1                    { print }
    END {
      if (!found) {
        print ""
        print "<!-- fleet-heartbeat -->"
        print ENVIRON["FLEET_LINE"]
        print "<!-- /fleet-heartbeat -->"
      }
    }
  ' >"$TMP"

  # Refuse to wipe the body unless exactly one open/close marker pair survived the rewrite: zero
  # (before the append above) never happens, but more than one means the body is already malformed
  # (someone hand-duplicated the block) — editing it further would only make that worse.
  OPEN_COUNT=$(grep -c "<!-- fleet-heartbeat -->" "$TMP" || true)
  CLOSE_COUNT=$(grep -c "<!-- /fleet-heartbeat -->" "$TMP" || true)
  [ "$OPEN_COUNT" = 1 ] && [ "$CLOSE_COUNT" = 1 ] || exit 0

  gh issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null 2>&1 || exit 0
  # Read back: the broker's own read-modify-write of the same issue can land after ours and drop
  # our line (or vice versa for its block, which this script never touches either way).
  if gh issue view "$ISSUE" -R "$REPO" --json body --jq .body 2>/dev/null | tr -d '\r' | grep -Fxq -- "$LINE"; then
    exit 0
  fi
  if [ "$attempt" -ge 3 ]; then
    # soft: give up quietly (logged, the tick continues) — the next tick tries again
    echo "fleet heartbeat: gave up on $REPO#$ISSUE after $attempt attempts (a concurrent edit kept winning)" >&2
    exit 0
  fi
  echo "fleet heartbeat: lost to a concurrent edit of $REPO#$ISSUE, retrying" >&2
  # Short jittered backoff, so two writers racing the same issue don't just keep re-colliding in lockstep.
  base="${FLEET_HEARTBEAT_RETRY_SECS:-2}"
  sleep "$base.$(printf '%03d' "$((RANDOM % 1000))")"
done
