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
  "repo view") echo '{"nameWithOwner":"acme/acme-fleet"}' ;;
  "issue view") cat "$BODY_FILE" ;;
  "issue edit")
    # the --body-file path is always the last arg
    cp "\${!#}" "$BODY_FILE"
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
