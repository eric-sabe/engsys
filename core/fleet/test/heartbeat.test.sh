#!/usr/bin/env bash
# heartbeat.test.sh — sandbox test for `fleet heartbeat` (run by `npm test`; no network): writes the
# `<!-- fleet-heartbeat -->` marker onto this fleet's status issue, preserves everything else in the
# body, creates the block when it's missing, no-ops in single-fleet mode / with no status_issue
# declared, and fails soft (never a non-zero exit) when gh itself fails. Also proves round-trip
# against core/lib/claim.mjs's own parseHeartbeat, so the writer and the cross-fleet reader agree on
# the marker shape without duplicating claim.mjs's reader logic here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT="$(cd "$HERE/.." && pwd -P)" # core/fleet
ROOT="$(cd "$KIT/../.." && pwd -P)" # engsys repo root
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

export FLEET_HEARTBEAT_RETRY_SECS=0 # no real delay between retries in this test

command -v node >/dev/null || { echo "heartbeat.test.sh: node is required" >&2; exit 1; }

# --- a minimal fleet instance (just enough for fleet-env.sh) ------------------------------------
I="$T/instance"
mkdir -p "$I/fleet" "$I/.claude"
echo '{}' >"$I/.claude/settings.json"
cat >"$I/fleet/fleet.conf" <<EOF
FLEET_ORG=acme
PIN_REPO=acme/acme-fleet
PIN_DIR=$I
FLEET_ID=acme
EOF
cat >"$I/federation.yml" <<'EOF'
version: 1
fleets:
  acme:
    status_issue: 42
  bob:
    enabled: true
EOF

# --- stub gh: `repo view`, `issue view <n> --json body`, `issue edit <n> --body-file <f>` --------
: >"$FAKE/gh.log"
BODY_FILE="$T/body.txt"
printf 'Some fleet status notes.\n' >"$BODY_FILE"
cat >"$T/bin/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$FAKE/gh.log"
[ -f "$FAKE/gh-fail" ] && exit 1
case "\$1 \$2" in
  "repo view") echo '{"nameWithOwner":"acme/acme-fleet"}' | jq -r '.nameWithOwner' ;; # emulate --json/--jq like real gh
  "issue view") cat "$BODY_FILE" ;;
  "issue edit")
    # \$FAKE/gh-race simulates a concurrent writer's edit landing right after ours: our own edit
    # is accepted by gh (exit 0) but never actually sticks, so the next read-back won't see it.
    if [ -f "$FAKE/gh-race" ] && [ "\$(cat "$FAKE/gh-race")" -gt 0 ]; then
      echo "\$(( \$(cat "$FAKE/gh-race") - 1 ))" >"$FAKE/gh-race"
    else
      # the --body-file path is always the last arg
      cp "\${!#}" "$BODY_FILE"
    fi
    ;;
esac
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

heartbeat() { ( cd "$I" && bash "$KIT/bin/fleet" --instance "$I" heartbeat "$1" ); }

# --- no marker yet: the block is appended, existing text is kept -------------------------------
run heartbeat "3 up, 0 rotating, 0 down"
rc_is "first heartbeat (no existing marker) exits 0" 0
has "existing body text is preserved" "$(cat "$BODY_FILE")" "Some fleet status notes."
has "the block was created" "$(cat "$BODY_FILE")" "<!-- fleet-heartbeat -->"
matches "a last: line with the status text" "$(cat "$BODY_FILE")" 'last: [0-9TZ:-]+ — status: 3 up, 0 rotating, 0 down'
has "the closing marker is present" "$(cat "$BODY_FILE")" "<!-- /fleet-heartbeat -->"

# --- marker already present: rewritten in place, text around it kept ---------------------------
FIRST_LAST="$(grep '^last:' "$BODY_FILE")"
sleep 1.1 # the timestamp must actually move for the next assertion to mean anything
run heartbeat "2 up, 1 rotating, 0 down"
rc_is "second heartbeat (marker present) exits 0" 0
SECOND_LAST="$(grep '^last:' "$BODY_FILE")"
[ "$FIRST_LAST" != "$SECOND_LAST" ] && ok "the last: line moved" || bad "the last: line moved" "still: $SECOND_LAST"
has "the new status text is in the marker" "$(cat "$BODY_FILE")" "status: 2 up, 1 rotating, 0 down"
has "the body text above the block is still there" "$(cat "$BODY_FILE")" "Some fleet status notes."
N_BLOCKS="$(grep -c '<!-- fleet-heartbeat -->' "$BODY_FILE")"
eq "exactly one block (never duplicated)" "$N_BLOCKS" 1

# --- round-trip against claim.mjs's own reader --------------------------------------------------
BODY_JSON="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$BODY_FILE")"
FRESH="$(node --input-type=module -e "
import { parseHeartbeat } from '$ROOT/core/lib/claim.mjs';
process.stdout.write(String(parseHeartbeat($BODY_JSON)));
")"
eq "claim.mjs's parseHeartbeat reads the freshly-written marker as fresh" "$FRESH" "true"

# --- gh failure: soft, never a non-zero exit, body left untouched ------------------------------
BEFORE="$(cat "$BODY_FILE")"
touch "$FAKE/gh-fail"
run heartbeat "0 up, 0 rotating, 3 down"
rc_is "gh failure: heartbeat.sh still exits 0 (fail soft)" 0
eq "body left exactly as it was (the failed edit never landed)" "$(cat "$BODY_FILE")" "$BEFORE"
rm -f "$FAKE/gh-fail"

# --- concurrent edit (#54's broker on the same status issue): retried until it sticks ----------
echo 2 >"$FAKE/gh-race"
: >"$FAKE/gh.log"
run heartbeat "after a race"
rc_is "a lost edit is retried until it sticks" 0
has "it eventually landed" "$(cat "$BODY_FILE")" "status: after a race"
EDIT_CALLS="$(grep -c '^issue edit' "$FAKE/gh.log")"
eq "it took 3 attempts (2 lost to the race, 1 that stuck)" "$EDIT_CALLS" 3
has "each lost attempt is logged" "$OUT" "lost to a concurrent edit"
RETRY_LOGS="$(grep -c "lost to a concurrent edit" <<<"$OUT")"
eq "...exactly twice (the 3rd attempt is the one that stuck, no retry logged after it)" "$RETRY_LOGS" 2
rm -f "$FAKE/gh-race"

# --- a race that never clears: gives up softly after 3 attempts, body left as it was ------------
echo 99 >"$FAKE/gh-race"
BEFORE="$(cat "$BODY_FILE")"
run heartbeat "never lands"
rc_is "gives up after 3 attempts, still exits 0 (soft)" 0
eq "body untouched (ours never stuck, and it never clobbers whatever is there)" "$(cat "$BODY_FILE")" "$BEFORE"
has "the give-up is logged (not silent)" "$OUT" "gave up on acme/acme-fleet#42 after 3 attempts"
rm -f "$FAKE/gh-race"

# --- never touches another writer's block on the same issue -------------------------------------
printf '%s\n\n<!-- broker-heartbeat -->\nlast: 2026-01-01T00:00:00Z — status: broker working\n<!-- /broker-heartbeat -->\n' "$(cat "$BODY_FILE")" >"$BODY_FILE.new"
mv "$BODY_FILE.new" "$BODY_FILE"
sleep 1.1
run heartbeat "beside the broker"
rc_is "heartbeat beside another writer's block exits 0" 0
has "the broker's own block is untouched" "$(cat "$BODY_FILE")" "<!-- broker-heartbeat -->"
has "...its line too" "$(cat "$BODY_FILE")" "status: broker working"
has "our own line still updates" "$(cat "$BODY_FILE")" "status: beside the broker"
N_FLEET_BLOCKS="$(grep -c '<!-- fleet-heartbeat -->' "$BODY_FILE")"
N_BROKER_BLOCKS="$(grep -c '<!-- broker-heartbeat -->' "$BODY_FILE")"
eq "still exactly one fleet-heartbeat block" "$N_FLEET_BLOCKS" 1
eq "still exactly one broker-heartbeat block" "$N_BROKER_BLOCKS" 1

# --- no-op modes: never call gh at all -------------------------------------------------------
: >"$FAKE/gh.log"
sed -i.bak 's/^FLEET_ID=acme$//' "$I/fleet/fleet.conf" # single-fleet mode: no FLEET_ID
run heartbeat "x"
rc_is "single-fleet mode (no FLEET_ID) exits 0" 0
eq "...and never calls gh" "$(cat "$FAKE/gh.log")" ""
mv "$I/fleet/fleet.conf.bak" "$I/fleet/fleet.conf"

mv "$I/federation.yml" "$I/federation.yml.bak"
run heartbeat "x"
rc_is "no federation file exits 0" 0
eq "...and never calls gh" "$(cat "$FAKE/gh.log")" ""
mv "$I/federation.yml.bak" "$I/federation.yml"

cat >"$I/federation.yml" <<'EOF'
version: 1
fleets:
  acme:
    enabled: true
EOF
run heartbeat "x"
rc_is "no status_issue declared for this fleet exits 0" 0
eq "...and never calls gh" "$(cat "$FAKE/gh.log")" ""

finish "heartbeat.test.sh"
