#!/usr/bin/env bash
# mm-setup.sh — idempotent Merge Monster setup for a repo.
# Creates the mm:* labels and the pinned ledger issue; prints config lines.
#
# Usage: mm-setup.sh --repo owner/name [--no-pin]
set -euo pipefail

REPO="" PIN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --no-pin) PIN=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mm-setup.sh --repo owner/name [--no-pin]" >&2; exit 2; }

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

echo "== labels =="
# gh label create --force updates color/description if the label exists.
gh label create "mm:ready"     -R "$REPO" --force --color 0e8a16 --description "PR is done (local review + gate clean) — enqueue for Merge Monster"
gh label create "mm:queued"    -R "$REPO" --force --color c5def5 --description "Merge Monster: acknowledged, position + reasoning in comment"
gh label create "mm:active"    -R "$REPO" --force --color 1d76db --description "Merge Monster: piloting through ready → CI → merge"
gh label create "mm:blocked"   -R "$REPO" --force --color d93f0b --description "Merge Monster: parked with stated reason (see comment)"
gh label create "mm:escalated" -R "$REPO" --force --color b60205 --description "Merge Monster: needs a human — diagnosis in comment"
echo "labels ok"

echo "== ledger issue =="
TITLE="🧌 Merge Monster ledger"
# Fail closed: a swallowed lookup error here would create a duplicate ledger.
if ! LIST=$(gh issue list -R "$REPO" --state all --search "\"$TITLE\" in:title" \
    --json number,title,state 2>&1); then
  echo "ERROR: could not query for an existing ledger issue — refusing to create a possible duplicate:" >&2
  echo "$LIST" >&2
  exit 1
fi
EXISTING=$(echo "$LIST" | jq "[.[] | select(.title == \"$TITLE\")][0] // empty")

if [ -n "$EXISTING" ]; then
  NUM=$(echo "$EXISTING" | jq -r .number)
  STATE=$(echo "$EXISTING" | jq -r .state)
  echo "found existing ledger issue #$NUM ($STATE)"
  if [ "$STATE" = "CLOSED" ]; then
    echo "NOTE: ledger issue is CLOSED — that is the kill switch. Reopen to arm: gh issue reopen $NUM -R $REPO"
  fi
else
  BODY='This issue is the **Merge Monster baton**. While the heartbeat below is fresh, Merge Monster owns merging in this repo — do not mark-ready or merge; label your PR `mm:ready` instead. Closing this issue is the kill switch.

<!-- mm-heartbeat -->
last: never — status: not running
<!-- /mm-heartbeat -->

Protocol: see `.claude/workflows/merge-monster-protocol.md` (or the repo CLAUDE.md § Merge Monster).'
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

== paste into .claude/merge-monster.yml ==
repo: $REPO
ledger_issue: $NUM
EOF
