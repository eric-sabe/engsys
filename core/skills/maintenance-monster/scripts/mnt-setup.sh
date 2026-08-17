#!/usr/bin/env bash
# mnt-setup.sh — idempotent Maintenance Monster setup for a repo.
# Creates the mnt:* labels (plus the risk-accepted suppression-gate label)
# and the pinned ledger issue; prints config lines.
#
# Usage: mnt-setup.sh --repo owner/name [--no-pin]
set -euo pipefail

REPO="" PIN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --no-pin) PIN=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mnt-setup.sh --repo owner/name [--no-pin]" >&2; exit 2; }

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

echo "== labels =="
# gh label create --force updates color/description if the label exists.
gh label create "mnt:triaging"   -R "$REPO" --force --color fbca04 --description "Maintenance Monster: classifying a finding (severity, exploitability, disposition)"
gh label create "mnt:fix-queued" -R "$REPO" --force --color 0e8a16 --description "Maintenance Monster: fix PR opened and labeled mm:ready for Merge Monster"
gh label create "mnt:escalated"  -R "$REPO" --force --color b60205 --description "Maintenance Monster: needs a human — diagnosis in comment"
gh label create "risk-accepted"  -R "$REPO" --force --color 5319e7 --description "Accepted risk / dismissed finding — operator sign-off (Maintenance Monster suppression gate)"
echo "labels ok"

echo "== ledger issue =="
TITLE="🔧 Maintenance Monster ledger"
# Fail closed: a swallowed lookup error here would create a duplicate ledger.
if ! LIST=$(gh issue list -R "$REPO" --state all --search "\"$TITLE\" in:title" \
    --json number,title,state 2>&1); then
  echo "ERROR: could not query for an existing ledger issue — refusing to create a possible duplicate:" >&2
  echo "$LIST" >&2
  exit 1
fi
MATCHES=$(echo "$LIST" | jq "[.[] | select(.title == \"$TITLE\")]")
MATCH_COUNT=$(echo "$MATCHES" | jq 'length')

if [ "$MATCH_COUNT" -gt 1 ]; then
  DUP_NUMS=$(echo "$MATCHES" | jq -r '[.[].number] | join(", #")')
  echo "ERROR: found $MATCH_COUNT issues titled \"$TITLE\" (#$DUP_NUMS) — refusing to auto-pick one." >&2
  echo "Close/rename the duplicates so exactly one ledger issue remains, then re-run." >&2
  exit 1
elif [ "$MATCH_COUNT" = 1 ]; then
  EXISTING=$(echo "$MATCHES" | jq '.[0]')
  NUM=$(echo "$EXISTING" | jq -r .number)
  STATE=$(echo "$EXISTING" | jq -r .state)
  echo "found existing ledger issue #$NUM ($STATE)"
  if [ "$STATE" = "CLOSED" ]; then
    echo "NOTE: ledger issue is CLOSED — that is the kill switch. Reopen to arm: gh issue reopen $NUM -R $REPO"
  fi
else
  BODY='This issue is the **Maintenance Monster baton** — distinct from the Merge
Monster ledger. While the heartbeat below is fresh, the maintenance watchdog session owns
the security/dependency watch surface in this repo: Dependabot PRs and
alerts, GHAS/CodeQL findings, Secret Scan, and the push-only Trivy image
scan. It classifies each finding, drives safe fixes into the normal PR
process (opened as `mm:ready` for Merge Monster to merge — Maintenance
Monster never merges), and escalates the rest. Closing this issue is the
kill switch.

<!-- mnt-heartbeat -->
last: never — status: not running
<!-- /mnt-heartbeat -->

Protocol: see `.claude/workflows/maintenance-monster-protocol.md` (or the repo CLAUDE.md § Maintenance Monster).'
  NUM=$(gh issue create -R "$REPO" --title "$TITLE" --body "$BODY" | grep -oE '[0-9]+$')
  echo "created ledger issue #$NUM"
fi

if [ "$PIN" = 1 ]; then
  ISSUE_ID=$(gh api "repos/$REPO/issues/$NUM" --jq .node_id)
  if gh api graphql -f query='mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { number } } }' -f id="$ISSUE_ID" >/dev/null 2>&1; then
    echo "pinned issue #$NUM"
  else
    echo "WARN: could not pin issue #$NUM (already pinned, or missing permission) — pinning is cosmetic, continuing"
  fi
fi

cat <<EOF

== paste into .claude/maintenance-monster.yml ==
repo: $REPO
ledger_issue: $NUM
EOF
