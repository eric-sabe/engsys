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

BODY="$(gh issue view "$ISSUE" -R "$REPO" --json body --jq .body 2>/dev/null)" || exit 0

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

printf '%s\n' "$BODY" | awk -v now="$NOW" -v status="$STATUS_TEXT" '
  /<!-- fleet-heartbeat -->/   { print; print "last: " now " — status: " status; found=1; skip=1; next }
  /<!-- \/fleet-heartbeat -->/ { skip=0 }
  skip != 1                    { print }
  END {
    if (!found) {
      print ""
      print "<!-- fleet-heartbeat -->"
      print "last: " now " — status: " status
      print "<!-- /fleet-heartbeat -->"
    }
  }
' >"$TMP"

gh issue edit "$ISSUE" -R "$REPO" --body-file "$TMP" >/dev/null 2>&1 || exit 0
