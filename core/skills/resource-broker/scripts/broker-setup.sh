#!/usr/bin/env bash
# broker-setup.sh — idempotent Resource Broker setup for a repo.
# Creates the broker:* labels and the pinned ledger issue (the baton, with its heartbeat block);
# prints config lines. Distinct from the Merge Monster and Maintenance Monster ledgers.
#
# Usage: broker-setup.sh [--repo owner/name] [--no-pin] [--config FILE | --config-dir DIR]
# --repo defaults to `repo` of resource-broker.yml when one is found.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

REPO="" PIN=1 CONFIG="" CONFIG_DIR=""
usage() { echo "usage: broker-setup.sh [--repo owner/name] [--no-pin] [--config FILE | --config-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --no-pin) PIN=0; shift ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_var REPO repo
[ -n "$REPO" ] || usage

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

echo "== labels =="
# gh label create --force updates color/description if the label exists.
gh label create "broker:escalated"   -R "$REPO" --force --color b60205 --description "Resource Broker: needs a human — diagnosis in a ledger comment"
gh label create "broker:host-window" -R "$REPO" --force --color fbca04 --description "Resource Broker: a host-tier maintenance window is open (leases drained, host action in progress)"
echo "labels ok"

echo "== ledger issue =="
TITLE="🛰️ Resource Broker ledger"
# Fail closed: a swallowed lookup error here would create a duplicate ledger.
if ! LIST=$(gh issue list -R "$REPO" --state all --search "\"$TITLE\" in:title" \
    --json number,title,state 2>&1); then
  echo "ERROR: could not query for an existing ledger issue — refusing to create a possible duplicate:" >&2
  echo "$LIST" >&2
  exit 1
fi
MATCHES=$(echo "$LIST" | jq --arg t "$TITLE" '[.[] | select(.title == $t)]')
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
  BODY='This issue is the **Resource Broker baton**, distinct from the Merge Monster and Maintenance
Monster ledgers. While the heartbeat below is fresh, the broker session arbitrates the host'"'"'s
scarce shared resources (the slots of a resource pool: ports, databases, emulators): it reaps
grants whose holder died, relays grant nudges to waiting sessions, and actuates
host-tier actions when directed. It actuates access; it does **not** decide environment health or
what a failure means: that stays with the session that owns the decision (the decide-vs-actuate
seam). Closing this issue is the kill switch.

<!-- broker-heartbeat -->
last: never — status: not running
<!-- /broker-heartbeat -->

Protocol: the `resource-broker` skill in engsys; pool primitives: the `durable-lease` skill.'
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

== paste into resource-broker.yml (the fleet config dir, or .claude/resource-broker.yml) ==
repo: $REPO
ledger_issue: $NUM

== and into the fleet's supervisor conf (fleet/supervisor.conf.tmpl): <session>|<ledger>|<stale minutes> ==
<ns>-broker|$NUM|60
EOF
