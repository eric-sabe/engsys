#!/usr/bin/env bash
# federation.test.sh — sandbox test for the registry plumbing (run by `npm test`; no network).
#
# The loader itself (YAML subset, schema, addresses, CLI) is covered by core/fleet/lib/federation.test.mjs.
# This file proves the shell side: fleet.conf FLEET_ID validation in fleet-env.sh, FEDERATION_FILE
# resolution, `fleet federation` and the registry block of `fleet status`, FLEET_ID landing in the
# rendered session envs on `fleet launch`, and `fleet notify` taking its prefix from fleet.conf.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT="$(cd "$HERE/.." && pwd -P)" # core/fleet
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

command -v node >/dev/null || { echo "federation.test.sh: node is required" >&2; exit 1; }
unset FLEET_ID FEDERATION_FILE SLACK_ENV NOTIFY_FALLBACK_ISSUE

# --- a minimal fleet instance, plus a tagged engsys checkout and a stub launcher for `fleet launch` --
I="$T/instance"
P="$T/pin"
E="$T/engsys"
mkdir -p "$I/fleet/env" "$P/.claude" "$E/core/skills/agent-sessions/scripts"
jq -n '{extraKnownMarketplaces: {engsys: {source: {source: "github", repo: "vendor/engsys", ref: "v1.0.0"}}}}' >"$P/.claude/settings.json"
cat >"$E/core/skills/agent-sessions/scripts/launch-agent-sessions.sh" <<'SH'
#!/usr/bin/env bash
echo "launcher $*" >>"$FAKE/launcher.log"
SH
git -C "$E" init -q && git -C "$E" add -A && git -C "$E" commit -q -m engsys && git -C "$E" tag v1.0.0
printf 'NAMESPACE=acme\nacme-build|__PIN_DIR__||\n' >"$I/fleet/roster.tmpl"
printf 'MARKER=1\n' >"$I/fleet/env/session.env.tmpl"

conf() { # conf [extra lines...] — rewrite fleet.conf with the base keys plus extras
  {
    printf 'FLEET_ORG=acme\nPIN_REPO=acme/app\nPIN_DIR=%s\nENGSYS_DIR=%s\n' "$P" "$E"
    for l in "$@"; do printf '%s\n' "$l"; done
  } >"$I/fleet/fleet.conf"
}
fleet() { bash "$KIT/bin/fleet" --instance "$I" "$@"; }

cat >"$T/federation.yml" <<'EOF'
version: 1
operators_team: acme/fleet-operators
fleets:
  alice:
    operator: alice
    github_app: acme-fleet-alice
    github_app_id: 1000001
    enabled: true
  bob:
    operator: bob
    github_app: acme-fleet-bob
    github_app_id: 1000002
    enabled: true
repos:
  acme/app:
    merge:    { home: alice, ledger: 101, standby: [bob] }
    maintain: { home: bob, ledger: 102, standby: [alice], failover: auto }
EOF

echo "== FLEET_ID validation in fleet.conf"
for bad in Alice a 1abc a_b -abc abcdefghijklmnopqrstuv 'al ice'; do
  conf "FLEET_ID=$bad"
  run fleet federation status
  rc_is "FLEET_ID='$bad' is refused" 1
  has "…naming the rule" "$OUT" "FLEET_ID '$bad' must be 2-21 characters"
done
for good in ab alice acme-eu abcdefghijklmnopqrstu; do
  conf "FLEET_ID=$good"
  run fleet federation status
  rc_is "FLEET_ID='$good' is accepted" 0
  has "…and shown" "$OUT" "fleet: $good"
done

echo "== single-fleet mode and where FLEET_ID comes from"
conf
run fleet federation status
rc_is "no FLEET_ID, no registry: status exits 0" 0
has "…single-fleet mode" "$OUT" "fleet: single-fleet mode (no FLEET_ID, no $I/federation.yml)"
FLEET_ID=zed run fleet federation status
has "an inherited FLEET_ID is ignored (fleet.conf is the only source)" "$OUT" "fleet: single-fleet mode"
printf 'FLEET_ID=bob\n' >"$HOME/.config/acme/fleet.local.conf"
run fleet federation status
has "fleet.local.conf can set FLEET_ID" "$OUT" "fleet: bob"
rm -f "$HOME/.config/acme/fleet.local.conf"
conf FLEET_ID=alice
run fleet federation status
has "FLEET_ID without a registry" "$OUT" "fleet: alice"
has "…is still single-fleet mode" "$OUT" "federation: none (no $I/federation.yml)"
run fleet federation home acme/app merge
rc_is "home without a registry exits 3" 3

echo "== a registry at the instance root"
cp "$T/federation.yml" "$I/federation.yml"
run fleet federation validate
rc_is "validate exits 0" 0
has "…and summarizes" "$OUT" "(2 fleets, 2 repo roles)"
run fleet federation home acme/app maintain
eq "home acme/app maintain" "$OUT" "bob"
run fleet federation get repos.acme/app.merge.failover
eq "get fills in the failover default" "$OUT" "escalate"
run fleet federation address acme-build
eq "a bare address resolves to this fleet" "$OUT" '{"fleet":"alice","session":"acme-build"}'
run fleet federation status
rc_is "status exits 0" 0
has "status: fleet id" "$OUT" "fleet: alice"
has "status: the file and its fleets" "$OUT" "federation: $I/federation.yml (2 fleets: alice, bob)"
matches "status: merge is this fleet's" "$OUT" 'acme/app merge +home alice \(this fleet\) +ledger #101 +standby bob +failover escalate'
matches "status: maintain is bob's, unmarked" "$OUT" 'acme/app maintain +home bob +ledger #102 +standby alice +failover auto'
conf FLEET_ID=carol
run fleet federation validate
rc_is "a FLEET_ID the registry doesn't list fails validate" 1
has "…saying so" "$OUT" '"carol" is not declared under fleets'
run fleet federation status
has "…and status warns" "$OUT" 'WARNING FLEET_ID "carol" is not declared'

echo "== FEDERATION_FILE override"
mkdir -p "$I/cfg"
sed 's/home: bob/home: alice/; s/standby: \[alice\]/standby: [bob]/' "$T/federation.yml" >"$I/cfg/fed.yml"
conf FLEET_ID=alice FEDERATION_FILE=cfg/fed.yml
run fleet federation home acme/app maintain
eq "a relative FEDERATION_FILE resolves against the instance" "$OUT" "alice"
conf FLEET_ID=alice "FEDERATION_FILE=$I/cfg/fed.yml"
run fleet federation home acme/app maintain
eq "an absolute FEDERATION_FILE is used as-is" "$OUT" "alice"
conf FLEET_ID=alice FEDERATION_FILE=cfg/none.yml
run fleet federation status
has "a FEDERATION_FILE that doesn't exist means single-fleet mode" "$OUT" "federation: none (no $I/cfg/none.yml)"

echo "== an invalid registry"
conf FLEET_ID=alice
printf 'version: 1\nfleets:\n  alice:\n    enabled: yes\n' >"$I/federation.yml"
run fleet federation validate
rc_is "validate exits 1" 1
has "…with the line" "$OUT" "federation.yml:4: ambiguous value \"yes\""
run fleet federation status
rc_is "status exits 1" 1
has "…and says INVALID" "$OUT" "federation: INVALID"

echo "== fleet status starts with the registry block"
cp "$T/federation.yml" "$I/federation.yml"
run fleet status
has "fleet status: fleet id" "$OUT" "fleet: alice"
matches "fleet status: role homes" "$OUT" 'acme/app merge +home alice \(this fleet\)'
has "fleet status: the session table still follows" "$OUT" "SESSION"
conf
rm -f "$I/federation.yml"
run fleet status
has "single-fleet fleet status: one line" "$OUT" "fleet: single-fleet mode"

echo "== fleet launch writes FLEET_ID into the session envs"
: >"$FAKE/launcher.log"
conf
run fleet launch
rc_is "single-fleet launch exits 0" 0
hasnt "single-fleet: no FLEET_ID in the env" "$(cat "$I/.fleet/env/session.env")" "FLEET_ID"
hasnt "single-fleet: no inbox dir either" "$(cat "$I/.fleet/env/session.env")" "FLEET_INBOX_DIR"
hasnt "…and no registry warning" "$OUT" "federation"
conf FLEET_ID=alice
run fleet launch
rc_is "launch with FLEET_ID exits 0" 0
S="$(cat "$I/.fleet/env/session.env")"
has "the env keeps its template content" "$S" "MARKER=1"
has "the env carries FLEET_ID" "$S" "FLEET_ID=alice"
has "…and the relay inbox dir for the session-start hook" "$S" "FLEET_INBOX_DIR=$I/.fleet/inbox"
hasnt "no FEDERATION_FILE line while the file does not exist" "$S" "FEDERATION_FILE="
got="$(env -i PATH=/usr/bin:/bin sh -c "set -a; . '$I/.fleet/env/session.env'; set +a; echo \"\$FLEET_ID\"")"
eq "sourcing the env in sh exports FLEET_ID" "$got" "alice"
cp "$T/federation.yml" "$I/federation.yml"
run fleet launch
rc_is "launch with a valid registry exits 0" 0
has "the env carries FEDERATION_FILE once it exists" "$(cat "$I/.fleet/env/session.env")" "FEDERATION_FILE=$I/federation.yml"
hasnt "…and no warning" "$OUT" "WARNING"
printf 'version: 2\nfleets:\n  alice:\n    enabled: true\n' >"$I/federation.yml"
run fleet launch
rc_is "an invalid registry never blocks a launch" 0
has "…but is reported" "$OUT" "WARNING the federation registry above is invalid"
has "…with the problem" "$OUT" "version must be 1"
conf
cp "$T/federation.yml" "$I/federation.yml"
run fleet launch
rc_is "a registry without FLEET_ID still launches" 0
has "…with a warning" "$OUT" "exists but FLEET_ID is not set"
rm -f "$I/federation.yml"

echo "== fleet notify takes the fleet id from fleet.conf"
: >"$FAKE/gh.log"
cat >"$T/bin/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$FAKE/gh.log"
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
conf FLEET_ID=alice NOTIFY_FALLBACK_ISSUE=acme/app#5
run fleet notify --level info "no slack configured"
rc_is "notify without Slack exits 0" 0
has "the fallback comment carries fleet.conf's id" "$(cat "$FAKE/gh.log")" "[alice] ℹ️ no slack configured"
printf 'SLACK_BOT_TOKEN=x\nSLACK_CHANNEL_ID=C1\nSLACK_OPERATORS_GROUP_ID=S1\nFLEET_ID=old\n' >"$T/slack.env"
conf FLEET_ID=alice NOTIFY_FALLBACK_ISSUE=acme/app#5 "SLACK_ENV=$T/slack.env"
: >"$FAKE/gh.log"
SLACK_API_URL="http://127.0.0.1:9" run fleet notify --level info "slack unreachable"
has "a different FLEET_ID in SLACK_ENV is reported" "$OUT" "FLEET_ID in SLACK_ENV (old) differs from fleet.conf (alice); using alice"
has "…and fleet.conf's wins" "$(cat "$FAKE/gh.log")" "[alice] ℹ️ slack unreachable"

finish "federation.test.sh"
