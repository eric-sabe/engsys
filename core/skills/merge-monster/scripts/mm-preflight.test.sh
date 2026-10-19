#!/usr/bin/env bash
# mm-preflight.test.sh — the signed security-verdict gate of mm-preflight.sh (engsys#197, option B), offline:
# a fake gh serves one PR's view JSON, and the verdicts are signed with core/lib/security-verdict.mjs using a
# throwaway key in a temp dir. Hermetic: nothing outside $T is read or written.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SV="$HERE/../../../lib/security-verdict.mjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/       /'; }
rc_is() { if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1 (exit $RC, want $2)" "$OUT"; fi; }
has() { case "$OUT" in *"$2"*) ok "$1" ;; *) bad "$1" "$OUT" ;; esac; }
hasnt() { case "$OUT" in *"$2"*) bad "$1" "$OUT" ;; *) ok "$1" ;; esac; }

HEAD_SHA="$(printf 'a%.0s' $(seq 1 40))"
OLD_SHA="$(printf 'b%.0s' $(seq 1 40))"
KEY="$T/security-verdict.key"
OTHER_KEY="$T/other.key"
node "$SV" keygen --key-file "$KEY"
node "$SV" keygen --key-file "$OTHER_KEY"

# The fake gh: `pr view` prints $T/view.json; `api graphql` prints the empty thread list.
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view") cat "$FAKE/view.json" ;;
  "api graphql") echo '{"nodes":[]}' ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
SH
chmod +x "$T/bin/gh"
export FAKE="$T" FLEET_GH="$T/bin/gh"
unset FLEET_STATE GH_APP_ENV_FILE

# sign <key> <sha> <verdict> <text> → a comment body on stdout, signed by the real library
sign() {
  node --input-type=module -e '
    import fs from "node:fs";
    import { readKeyFile, signVerdict } from "'"$SV"'";
    process.stdout.write(signVerdict({ key: readKeyFile(process.argv[1]), repo: "acme/app", pr: 7, sha: process.argv[2], verdict: process.argv[3], reviewText: process.argv[4] }));
  ' "$1" "$2" "$3" "$4"
}
# view <comment body>... → writes $T/view.json with one comment per argument
view() {
  local arr="[]" b
  for b in "$@"; do arr="$(jq -c --arg b "$b" '. + [{body:$b, createdAt:"2026-10-19T10:00:00Z", author:{login:"app[bot]"}}]' <<<"$arr")"; done
  jq -n --argjson c "$arr" --arg h "$HEAD_SHA" '{isDraft:false,mergeable:"MERGEABLE",mergeStateStatus:"CLEAN",baseRefName:"main",headRefOid:$h,body:"Closes #1",comments:$c,files:[],commits:[]}' >"$T/view.json"
}
run() { RC=0; OUT="$(bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 "$@" 2>&1)" || RC=$?; }

GOOD="$(sign "$KEY" "$HEAD_SHA" PASS 'No findings.')"
UNSIGNED=$'<!-- nyx-review -->\nNYX-VERDICT: PASS\n\nLooks fine.'

echo "gate OFF (the default): behaviour is unchanged"
view "$UNSIGNED"
run
rc_is "an unsigned nyx-review comment does not matter without --security-verdict" 0
hasnt "  …and no securityVerdict is reported" "securityVerdict"

echo "gate ON"
view "$GOOD"
run --security-verdict --security-key-file "$KEY"
rc_is "positive control: a verdict signed with the key for the current head passes" 0
has "  …reported as verified" '"state": "verified"'
run --require-security-verdict --security-key-file "$KEY"
rc_is "  …and satisfies --require-security-verdict" 0

view "$UNSIGNED"
run --security-verdict --security-key-file "$KEY"
rc_is "no MAC at all is rejected" 1
has "  …as forged_or_unsigned" "forged_or_unsigned"

view "$(sign "$OTHER_KEY" "$HEAD_SHA" PASS 'No findings.')"
run --security-verdict --security-key-file "$KEY"
rc_is "a verdict signed with the wrong key is rejected" 1

view "${GOOD//No findings./Nothing to see.}"
run --security-verdict --security-key-file "$KEY"
rc_is "a tampered review text is rejected" 1

view "$(sign "$KEY" "$OLD_SHA" PASS 'No findings.')"
run --security-verdict --security-key-file "$KEY"
rc_is "a verdict signed for an older head passes through as no verdict when not required (no replay credit)" 0
has "  …reported as only_stale_verdicts" "only_stale_verdicts"
run --require-security-verdict --security-key-file "$KEY"
rc_is "…and fails when a verdict is required" 1
has "  …as no_valid_verdict" "no_valid_verdict"

view "$(sign "$KEY" "$HEAD_SHA" FINDINGS 'Finding: F1.')"
run --security-verdict --security-key-file "$KEY"
rc_is "a signed FINDINGS verdict for the head blocks" 1
has "  …as findings" signed_findings_for_head

view
run --require-security-verdict --security-key-file "$KEY"
rc_is "--require with no verdict at all fails" 1
run --security-verdict --security-key-file "$KEY"
rc_is "…and without --require a PR with no nyx-review comment passes (presence stays with review_marker)" 0

view "$GOOD"
run --security-verdict --security-key-file "$T/missing.key"
rc_is "an unreadable key fails closed" 1
run --security-verdict
rc_is "no key file configured fails closed" 1
has "  …naming the misconfiguration" "security_verdict_unconfigured"
chmod 644 "$KEY"
run --security-verdict --security-key-file "$KEY"
rc_is "a group/other-readable key is refused" 1
chmod 600 "$KEY"
run --security-verdict --security-key-file "$KEY"
rc_is "…and accepted again once fixed (positive control)" 0

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
