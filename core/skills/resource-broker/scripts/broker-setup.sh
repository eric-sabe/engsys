#!/usr/bin/env bash
# broker-setup.sh — idempotent Resource Broker setup for a repo.
# Creates the broker:* labels and the pinned ledger issue (the baton, with its heartbeat block);
# prints config lines. Distinct from the Merge Monster and Maintenance Monster ledgers.
#
# Usage: broker-setup.sh [--repo owner/name] [--ledger N] [--no-pin] [--config FILE | --config-dir DIR]
# --repo defaults to `repo` of resource-broker.yml when one is found; --ledger to its `ledger_issue`.
#
# With a ledger issue configured (ledger_issue, or --ledger) setup ADOPTS that issue and never creates
# another: it verifies the issue exists and is open, then makes sure the body carries the
# `<!-- broker-heartbeat -->` marker pair that broker-heartbeat.sh edits:
#   - a body that already has exactly one pair is left alone;
#   - a `last: <ISO> — status: <text>` line outside any broker pair is wrapped in one (together with
#     an older marker pair directly enclosing it, whose lines stay intact inside the new pair);
#   - a body with no such line gets a pair appended, status "adopted by resource broker".
# The labels are created and the issue pinned only if it is not pinned already. Running it again
# changes nothing. With no ledger configured it finds (or creates) the ledger issue by its title.
#
# Multi-fleet mode (broker-config.sh): the ledger is the fleet's status issue in the instance repo, so
# setup adopts that issue (never creates one), creates the labels in the instance repo, and does not
# pin (the status issue is the fleet's, not the broker's). The status issue also carries the
# supervisor's `<!-- fleet-heartbeat -->` block, so adopting it always appends a broker block and never
# wraps an existing `last:` line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=broker-config.sh
. "$here/broker-config.sh"

REPO="" LEDGER="" PIN=1 CONFIG="" CONFIG_DIR=""
usage() { echo "usage: broker-setup.sh [--repo owner/name] [--ledger N] [--no-pin] [--config FILE | --config-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --ledger) [ $# -ge 2 ] || usage; LEDGER="$2"; shift 2 ;;
    --no-pin) PIN=0; shift ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || usage; CONFIG_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
broker_find_config "$CONFIG" "$CONFIG_DIR" || exit 1
broker_fill_ledger REPO LEDGER || exit 1
[ -n "$REPO" ] || usage
APPEND_ONLY=0
if [ -n "$BROKER_FLEET" ]; then
  [ -n "$LEDGER" ] && [ "$LEDGER" != 0 ] || { echo "broker-setup: multi-fleet mode but no status issue resolved" >&2; exit 1; }
  echo "multi-fleet mode: fleet $BROKER_FLEET heartbeats on its status issue $REPO#$LEDGER (ledger_issue in resource-broker.yml is not used)"
  APPEND_ONLY=1 PIN=0
fi
LEDGER="${LEDGER#\#}"
case "$LEDGER" in
  '' | 0) LEDGER="" ;;
  *[!0-9]*) echo "broker-setup: ledger issue must be an issue number (got '$LEDGER')" >&2; exit 2 ;;
esac

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

create_labels() {
  echo "== labels =="
  # gh label create --force updates color/description if the label exists.
  gh label create "broker:escalated"   -R "$REPO" --force --color b60205 --description "Resource Broker: needs a human — diagnosis in a ledger comment"
  gh label create "broker:host-window" -R "$REPO" --force --color fbca04 --description "Resource Broker: a host-tier maintenance window is open (leases drained, host action in progress)"
  echo "labels ok"
}

find_or_create_ledger() {
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
}

# The body of the ledger issue with the broker marker pair in place (stdin -> stdout); a one-line
# description of what it did goes to the file $1. The caller has already checked that the body has no
# broker markers. NOW is the fresh heartbeat time.
adopt_body() {
  BROKER_NOW="$NOW" BROKER_NOTE="$1" BROKER_APPEND="$APPEND_ONLY" awk '
    { line[NR] = $0 }
    END {
      hb = 0
      for (i = 1; i <= NR; i++) {
        l = line[i]; sub(/\r$/, "", l)
        # the same line the fleet supervisor parses (first match wins there too)
        if (ENVIRON["BROKER_APPEND"] != "1" && l ~ /^last: [0-9TZ:-]+ — status: /) { hb = i; break }
      }
      if (hb == 0) {
        for (i = 1; i <= NR; i++) print line[i]
        if (NR > 0 && line[NR] != "") print ""
        print "<!-- broker-heartbeat -->"
        print "last: " ENVIRON["BROKER_NOW"] " — status: adopted by resource broker"
        print "<!-- /broker-heartbeat -->"
        if (ENVIRON["BROKER_APPEND"] == "1") print "appended a broker heartbeat block to the status issue (status: adopted by resource broker)" > ENVIRON["BROKER_NOTE"]
        else print "no heartbeat line in the body: appended a broker heartbeat block (status: adopted by resource broker)" > ENVIRON["BROKER_NOTE"]
        exit
      }
      a = hb; b = hb
      o = line[hb - 1]; c = line[hb + 1]; sub(/\r$/, "", o); sub(/\r$/, "", c)
      if (hb > 1 && hb < NR && o ~ /^<!-- [^\/].* -->$/) {
        name = substr(o, 6, length(o) - 9)
        if (c == "<!-- /" name " -->") { a = hb - 1; b = hb + 1; enclosed = name }
      }
      if (enclosed != "") print "wrapped the existing heartbeat line, and the older <!-- " enclosed " --> pair around it, in the broker heartbeat markers" > ENVIRON["BROKER_NOTE"]
      else print "wrapped the existing heartbeat line in the broker heartbeat markers" > ENVIRON["BROKER_NOTE"]
      for (i = 1; i < a; i++) print line[i]
      print "<!-- broker-heartbeat -->"
      for (i = a; i <= b; i++) print line[i]
      print "<!-- /broker-heartbeat -->"
      for (i = b + 1; i <= NR; i++) print line[i]
    }'
}

adopt_ledger() {
  NUM="$LEDGER"
  echo "== ledger issue =="
  # Fail closed: never create anything when the configured issue cannot be verified.
  if ! STATE=$(gh issue view "$NUM" -R "$REPO" --json state --jq .state 2>&1); then
    echo "ERROR: could not read the configured ledger issue #$NUM in $REPO — not adopting, and not creating another:" >&2
    echo "$STATE" >&2
    exit 1
  fi
  if [ "$STATE" != OPEN ]; then
    echo "ERROR: configured ledger issue #$NUM in $REPO is $STATE — a closed ledger is the kill switch. Reopen it (gh issue reopen $NUM -R $REPO) and re-run; not adopting." >&2
    exit 1
  fi
  echo "adopting configured ledger issue #$NUM (OPEN); no issue is created"
  local open close
  cur=$(mktemp) new=$(mktemp) note=$(mktemp) # global: the EXIT trap outlives this function
  trap 'rm -f "$cur" "$new" "$note"' EXIT
  if ! gh issue view "$NUM" -R "$REPO" --json body --jq .body >"$cur"; then
    echo "ERROR: could not read the body of ledger issue #$NUM" >&2
    exit 1
  fi
  open=$(grep -c "<!-- broker-heartbeat -->" "$cur" || true)
  close=$(grep -c "<!-- /broker-heartbeat -->" "$cur" || true)
  if [ "$open" = 1 ] && [ "$close" = 1 ]; then
    echo "ledger body already has the broker heartbeat markers: unchanged"
  elif [ "$open" != 0 ] || [ "$close" != 0 ]; then
    echo "ERROR: ledger issue #$NUM body has $open <!-- broker-heartbeat --> and $close <!-- /broker-heartbeat --> markers; expected one pair or none — fix the body by hand, then re-run (not editing)" >&2
    exit 1
  else
    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    adopt_body "$note" <"$cur" >"$new"
    cat "$note"
    gh issue edit "$NUM" -R "$REPO" --body-file "$new" >/dev/null
    echo "updated the body of ledger issue #$NUM"
  fi
}

if [ -n "$LEDGER" ]; then
  adopt_ledger
  create_labels
else
  create_labels
  find_or_create_ledger
fi

if [ "$PIN" = 1 ]; then
  ISSUE_ID=$(gh api "repos/$REPO/issues/$NUM" --jq .node_id)
  # Pin only if not pinned already; when the check itself fails, fall through and try to pin.
  PINNED=$(gh api graphql -f query='query($id: ID!) { node(id: $id) { ... on Issue { isPinned } } }' -f id="$ISSUE_ID" --jq .data.node.isPinned 2>/dev/null || true)
  if [ "$PINNED" = true ]; then
    echo "issue #$NUM is already pinned"
  elif gh api graphql -f query='mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { number } } }' -f id="$ISSUE_ID" >/dev/null 2>&1; then
    echo "pinned issue #$NUM"
  else
    echo "WARN: could not pin issue #$NUM (missing permission, or three issues are already pinned) — pinning is cosmetic, continuing"
  fi
fi

if [ -n "$BROKER_FLEET" ]; then
  cat <<EOF

== multi-fleet: nothing to paste ==
The broker of fleet $BROKER_FLEET heartbeats on $REPO#$NUM between <!-- broker-heartbeat --> markers.
\`fleet supervise\` points this fleet's broker line in fleet/supervisor.conf.tmpl at that issue itself.
EOF
  exit 0
fi

cat <<EOF

== paste into resource-broker.yml (the fleet config dir, or .claude/resource-broker.yml) ==
repo: $REPO
ledger_issue: $NUM

== and into the fleet's supervisor conf (fleet/supervisor.conf.tmpl): <session>|<ledger>|<stale minutes> ==
<ns>-broker|$NUM|60
EOF
