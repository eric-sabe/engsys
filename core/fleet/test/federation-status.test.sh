#!/usr/bin/env bash
# federation-status.test.sh — sandbox test for `fleet status --federation` (run by `npm test`; no
# network). A fake `gh` on PATH serves canned status-issue bodies, baton refs and baton commits
# for `gh api -i -X GET <path>`; any other gh call (a write) fails the test. Covers: a holder that is
# not the home fleet (flagged), a status issue with no heartbeat marker, an expired baton, a free
# baton, an unreadable status issue, the `--json` shape, read-only behaviour, and that the singleton
# write guard lets a monster session run the command.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT="$(cd "$HERE/.." && pwd -P)" # core/fleet
GUARD="$KIT/../.claude-plugin/singleton-write-guard.mjs"
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

command -v node >/dev/null || { echo "federation-status.test.sh: node is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "federation-status.test.sh: jq is required" >&2; exit 1; }
unset FLEET_ID FEDERATION_FILE FLEET_INSTANCE_REPO GH_APP_ENV ENGSYS_SINGLETON_ROLE

iso() { node -e 'console.log(new Date(Date.now() + Number(process.argv[1]) * 1000).toISOString().replace(/\.\d+Z$/, "Z"))' -- "$1"; }

# --- instance ---------------------------------------------------------------------------------
I="$T/instance"
mkdir -p "$I/fleet"
cat >"$I/fleet/fleet.conf" <<EOF2
FLEET_ORG=acme
PIN_REPO=acme/fleet
PIN_DIR=$I
FLEET_ID=alice
FLEET_INSTANCE_REPO=acme/fleet
EOF2
cat >"$I/federation.yml" <<'EOF2'
version: 1
fleets:
  alice: { operator: alice, status_issue: 11, enabled: true }
  bob: { operator: bob, status_issue: 12, enabled: true }
  carol: { operator: carol, status_issue: 13, enabled: false }
repos:
  acme/app:
    merge: { home: alice, ledger: 101, standby: [bob] }
    maintain: { home: bob, ledger: 102 }
  acme/other:
    merge: { home: alice }
EOF2
fleet() { bash "$KIT/bin/fleet" --instance "$I" "$@"; }

# --- fake gh ----------------------------------------------------------------------------------
# Fixture files in $FAKE/resp/, named for the API path with / -> _; first line is the HTTP status.
mkdir -p "$FAKE/resp"
cat >"$T/bin/gh" <<'EOF2'
#!/usr/bin/env bash
if [ "${1:-}" = api ] && [ "${2:-}" = -i ] && [ "${3:-}" = -X ] && [ "${4:-}" = GET ] && [ $# -eq 5 ]; then
  f="$FAKE/resp/$(printf '%s' "$5" | tr / _)"
  echo "$5" >>"$FAKE/gh-reads.log"
  if [ -f "$f" ]; then status="$(head -n1 "$f")"; body="$(tail -n +2 "$f")"; else status=404; body='{"message":"Not Found"}'; fi
  printf 'HTTP/2.0 %s X\r\nDate: %s\r\nContent-Type: application/json\r\n\r\n%s\n' "$status" "$(date -u '+%a, %d %b %Y %H:%M:%S GMT')" "$body"
  exit 0
fi
echo "fake gh: unexpected (non-read) call: $*" >>"$FAKE/gh-writes.log"
exit 1
EOF2
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
: >"$FAKE/gh-reads.log"; : >"$FAKE/gh-writes.log"

resp() { printf '%s\n%s\n' "$2" "$3" >"$FAKE/resp/$(printf '%s' "$1" | tr / _)"; }
issue() { resp "/repos/acme/fleet/issues/$1" 200 "$(jq -n --arg b "$2" '{body: $b}')"; }
baton() { # baton <repo> <role> <sha-char> <holder> <expires-iso> <fleet>
  local sha; sha="$(printf '%040d' 0 | tr 0 "$3")"
  resp "/repos/$1/git/ref/engsys/batons/$2" 200 "$(jq -n --arg s "$sha" '{object: {sha: $s, type: "commit"}}')"
  local msg; msg="$(printf 'baton %s: %s until %s\n\nholder: %s\ntoken: tok12345678\nexpires: %s\nprotocol: 1\nfleet: %s' "$2" "$4" "$5" "$4" "$5" "$6")"
  resp "/repos/$1/git/commits/$sha" 200 "$(jq -n --arg m "$msg" '{message: $m, tree: {sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904"}}')"
}

issue 11 "$(printf 'fleet status\n\n<!-- fleet-heartbeat -->\nlast: %s — status: ok\n<!-- /fleet-heartbeat -->\n\n<!-- broker-heartbeat -->\nlast: %s — status: running\n<!-- /broker-heartbeat -->\n' "$(iso -120)" "$(iso -1500)")"
issue 12 "bob's fleet, no markers yet"
resp /repos/acme/fleet/issues/13 404 '{"message":"Not Found"}'
baton acme/app merge a bob:bob-merge "$(iso 540)" bob          # holder bob, home alice
baton acme/app maintain b bob:bob-mnt "$(iso -600)" bob        # expired, holder is home
# acme/other merge: no ref -> free

# --- table --------------------------------------------------------------------------------------
echo "== table"
run fleet status --federation
rc_is "exits 0" 0
echo "$OUT" | sed 's/^/    /'
matches "alice row: operator, enabled, status issue, both heartbeat ages, relay -" "$OUT" '^  alice +alice +yes +acme/fleet#11 +2m +25m +-$'
matches "bob row: no marker shows - for both ages" "$OUT" '^  bob +bob +yes +acme/fleet#12 +- +- +-$'
matches "carol row: unreadable status issue shows ?, disabled" "$OUT" '^  carol +carol +no +acme/fleet#13 +\? +\? +-$'
has "unreadable issue is explained" "$OUT" 'fleet carol: status issue unreadable: HTTP 404'
matches "holder != home is flagged !" "$OUT" '^  acme/app +merge +alice +bob +bob:bob-merge +[0-9]+m +!$'
has "the flag is explained" "$OUT" 'baton acme/app merge: held by bob, home is alice'
matches "expired baton shows expired, no flag when holder is home" "$OUT" '^  acme/app +maintain +bob +- +bob:bob-mnt +expired 10m ago$'
matches "a free baton shows - for holder and expiry" "$OUT" '^  acme/other +merge +alice +- +- +-$'
eq "exactly one flag" "$(grep -c ' !$' <<<"$OUT")" 1

# --- json ---------------------------------------------------------------------------------------
echo "== --json"
run fleet status --federation --json
rc_is "json exits 0" 0
J="$OUT"
eq "json is valid" "$(jq -e type <<<"$J")" '"object"'
eq "fleet ids" "$(jq -r '[.fleets[].id] | join(",")' <<<"$J")" "alice,bob,carol"
eq "alice fleet heartbeat age" "$(jq -r '.fleets[0].fleetHeartbeat.ageSec | if . >= 119 and . <= 125 then "ok" else tostring end' <<<"$J")" ok
eq "alice broker heartbeat age" "$(jq -r '.fleets[0].brokerHeartbeat.ageSec | if . >= 1499 and . <= 1505 then "ok" else tostring end' <<<"$J")" ok
eq "alice status issue" "$(jq -c '.fleets[0].statusIssue' <<<"$J")" '{"repo":"acme/fleet","number":11}'
eq "bob heartbeats are null" "$(jq -c '[.fleets[1].fleetHeartbeat, .fleets[1].brokerHeartbeat]' <<<"$J")" '[null,null]'
eq "relay is null until #77" "$(jq -c '[.fleets[].relay]' <<<"$J")" '[null,null,null]'
eq "carol is disabled with an error" "$(jq -r '.fleets[2] | "\(.enabled) \(.error)"' <<<"$J")" "false status issue unreadable: HTTP 404 Not Found"
eq "baton keys" "$(jq -r '.batons[0] | keys | join(",")' <<<"$J")" "expiresAt,expiresInSec,flag,holder,holderFleet,home,repo,role,standby,state"
eq "merge baton: holder, state, flag" "$(jq -r '.batons[0] | "\(.holder) \(.state) \(.flag) \(.home) \(.standby | join(","))"' <<<"$J")" "bob:bob-merge held true alice bob"
eq "maintain baton: expired, not flagged, negative expiry" "$(jq -r '.batons[1] | "\(.state) \(.flag) \(.expiresInSec < 0)"' <<<"$J")" "expired false true"
eq "free baton: no holder" "$(jq -c '.batons[2] | [.state, .holder, .expiresAt, .flag]' <<<"$J")" '["free",null,null,false]'

# --- read-only ----------------------------------------------------------------------------------
echo "== read-only"
eq "no write ever reached gh" "$(wc -c <"$FAKE/gh-writes.log" | tr -d ' ')" 0
eq "every gh call was a GET api read" "$(grep -vc '^/repos/' "$FAKE/gh-reads.log" || true)" 0

# --- single-fleet and bad input -------------------------------------------------------------------
echo "== edge cases"
rm "$I/federation.yml"
run fleet status --federation
rc_is "no federation file exits 0" 0
has "single-fleet message" "$OUT" "single-fleet mode"
printf 'version: 2\n' >"$I/federation.yml"
run fleet status --federation
rc_is "an invalid registry exits 1" 1

# --- the singleton write guard lets a monster run it ------------------------------------------------
echo "== guard"
for role in merge maintain; do
  for cmd in "fleet status --federation" "$KIT/bin/fleet --instance $I status --federation --json" "scripts/fleet status --federation"; do
    out="$(printf '%s' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$(jq -Rn --arg c "$cmd" '$c')}}" | ENGSYS_SINGLETON_ROLE=$role node "$GUARD")"
    eq "$role monster: '$cmd' is not denied" "$out" ""
  done
done

finish federation-status.test.sh
