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
  "api repos/acme/app/pulls/7/files"*) [ ! -f "$FAKE/files-fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$FAKE/files.json" ;;
  "api repos/acme/app/pulls/7") [ ! -f "$FAKE/files-fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "$FAKE/changed" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
SH
chmod +x "$T/bin/gh"
export FAKE="$T" FLEET_GH="$T/bin/gh"
unset FLEET_STATE GH_APP_ENV_FILE

# sign <key> <sha> <verdict> <text> [minutes-ago] → a comment body on stdout, signed by the real library
sign() {
  node --input-type=module -e '
    import fs from "node:fs";
    import { readKeyFile, signVerdict } from "'"$SV"'";
    process.stdout.write(signVerdict({ key: readKeyFile(process.argv[1]), repo: "acme/app", pr: 7, sha: process.argv[2], verdict: process.argv[3], reviewText: process.argv[4], now: () => Date.now() - Number(process.argv[5] || 0) * 60000 }));
  ' "$1" "$2" "$3" "$4" "${5:-0}"
}
# view <comment body>... → writes $T/view.json with one comment per argument
view() {
  local arr="[]" b
  for b in "$@"; do arr="$(jq -c --arg b "$b" '. + [{body:$b, createdAt:"2026-10-19T10:00:00Z", author:{login:"app[bot]"}}]' <<<"$arr")"; done
  jq -n --argjson c "$arr" --arg h "$HEAD_SHA" --argjson LBL "${LABELS:-[]}" '{isDraft:false,mergeable:"MERGEABLE",mergeStateStatus:"CLEAN",baseRefName:"main",headRefOid:$h,body:"Closes #1",comments:$c,files:[],commits:[],labels:$LBL}' >"$T/view.json"
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

echo "a FINDINGS verdict is sticky across a push (engsys#197 review)"
FIND_OLD="$(sign "$KEY" "$OLD_SHA" FINDINGS 'Finding: F1.' 60)"
view "$FIND_OLD"
run --security-verdict --security-key-file "$KEY"
rc_is "FINDINGS signed for the OLD head still fails on the new head (a whitespace push does not clear it)" 1
has "  …as unresolved on an earlier head" "signed_findings_on_earlier_head_unresolved"
run --require-security-verdict --security-key-file "$KEY"
rc_is "  …in require mode too" 1
view "$FIND_OLD" "$(sign "$KEY" "$HEAD_SHA" PASS 'Fixed; no findings.' 5)"
run --security-verdict --security-key-file "$KEY"
rc_is "a later signed PASS for the new head clears it (positive control)" 0
EARLY_PASS="$(sign "$KEY" "$HEAD_SHA" PASS 'ok' 120)"
view "$EARLY_PASS" "$(sign "$KEY" "$HEAD_SHA" FINDINGS 'bad' 60)" "$EARLY_PASS"
run --security-verdict --security-key-file "$KEY"
rc_is "re-posting an earlier authentic PASS after a later FINDINGS does not flip it" 1

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

echo "engsys#229: preflight decides --require-security-verdict itself, from the repo's config"
CFG="$T/merge-monster.yml"
cat >"$CFG" <<'YML'
repo: acme/app
ready_requirements:
  signed_security_verdict: true
security_sensitive_label: security
security_sensitive_globs:
  - services/dashboard/app/(auth)/**
  - services/dashboard/app/api/auth/[...nextauth]/**
  - "**/*.bicep"
  - .github/workflows/**
YML
files() { # files <name>... → $T/files.json (one array) and the changed_files count
  local arr="[]" f
  for f in "$@"; do arr="$(jq -c --arg f "$f" '. + [{filename:$f, status:"modified"}]' <<<"$arr")"; done
  printf '%s\n' "$arr" >"$T/files.json"; printf '%s\n' "$#" >"$T/changed"
}
view
files README.md services/api/src/x.ts
run --config "$CFG" --security-key-file "$KEY"
rc_is "config on, no sensitive file: passes without a verdict, and the flag was omitted" 0
has "  …the gate ran (turned on by the config)" "\"state\": \"none\""
files "services/dashboard/app/(auth)/login/page.tsx"
view
run --config "$CFG" --security-key-file "$KEY"
rc_is "a route-group path with no signed PASS is blocked although the session omitted the flag" 1
has "  …reason" "no_valid_verdict"
view "$UNSIGNED"
run --config "$CFG" --security-key-file "$KEY"
rc_is "…an unsigned PASS comment does not satisfy it" 1
view "$GOOD"
run --config "$CFG" --security-key-file "$KEY"
rc_is "…a signed PASS for the head does (positive control)" 0
has "  …recorded why it was required" "glob:services/dashboard/app/(auth)/**"
view
files "services/dashboard/app/api/auth/[...nextauth]/route.ts"
run --config "$CFG" --security-key-file "$KEY"
rc_is "a [...nextauth] path matches literally and needs the verdict" 1
files "services/dashboard/app/api/auth/n/route.ts" "services/dashboard/app/auth/page.tsx" "services/dashboard/app/authx/page.tsx"
run --config "$CFG" --security-key-file "$KEY"
rc_is "brackets and parentheses are not regex: n/ and auth/ do not match" 0
files infrastructure/main.bicep
run --config "$CFG" --security-key-file "$KEY"
rc_is "**/x.bicep matches a nested file" 1
files main.bicep
run --config "$CFG" --security-key-file "$KEY"
rc_is "…and a root-level one" 1
# renames: both the new and the old path count
jq -n '[{filename:"docs/moved.md", previous_filename:"services/dashboard/app/(auth)/old.tsx", status:"renamed"}]' >"$T/files.json"; echo 1 >"$T/changed"
run --config "$CFG" --security-key-file "$KEY"
rc_is "a rename OUT of a sensitive path is sensitive (old path)" 1
jq -n '[{filename:"services/dashboard/app/(auth)/new.tsx", previous_filename:"docs/old.md", status:"renamed"}]' >"$T/files.json"
run --config "$CFG" --security-key-file "$KEY"
rc_is "a rename INTO a sensitive path is sensitive (new path)" 1
# the label alone
files README.md
LABELS='[{"name":"Security"}]' view
run --config "$CFG" --security-key-file "$KEY"
rc_is "the security label alone requires the verdict (case-insensitive)" 1
LABELS='[{"name":"docs"}]' view
run --config "$CFG" --security-key-file "$KEY"
rc_is "…another label does not (positive control)" 0
# pagination: pages come back as concatenated arrays
printf '[{"filename":"a.md"}]\n[{"filename":".github/workflows/ci.yml"}]\n' >"$T/files.json"; echo 2 >"$T/changed"
run --config "$CFG" --security-key-file "$KEY"
rc_is "a sensitive file on page 2 is found" 1
# fail closed
printf '[{"filename":"a.md"}]\n' >"$T/files.json"; echo 5 >"$T/changed"
run --config "$CFG" --security-key-file "$KEY"
rc_is "a file list shorter than changed_files fails closed" 1
has "  …naming it" "security_file_list_unreadable"
printf '[{"filename":"a.md"}]\n' >"$T/files.json"; echo 3001 >"$T/changed"
run --config "$CFG" --security-key-file "$KEY"
rc_is "more than 3000 changed files cannot be listed in full: the verdict is required" 1
has "  …naming the reason" "no_valid_verdict"
view "$GOOD"
run --config "$CFG" --security-key-file "$KEY"
rc_is "…and a signed PASS satisfies it" 0
view; touch "$T/files-fail"
run --config "$CFG" --security-key-file "$KEY"
rc_is "an unreadable file list (API error) fails closed" 1
has "  …naming it" "security_file_list_unreadable"
rm -f "$T/files-fail"
run --config "$T/nope.yml" --security-key-file "$KEY"
rc_is "an unreadable config fails closed" 1
has "  …naming it" "security_config_unreadable"
printf 'security_sensitive_globs: oops\n' >"$T/bad.yml"
run --config "$T/bad.yml" --security-verdict --security-key-file "$KEY"
rc_is "a malformed glob list fails closed" 1
# the key
files "services/dashboard/app/(auth)/x.tsx"; view "$GOOD"
run --config "$CFG" --security-key-file "$T/missing.key"
rc_is "an unreadable key fails closed" 1
has "  …as key_unavailable" "key_unavailable"
# the config does not opt in: unchanged behaviour; discovery
printf 'repo: acme/app\nsecurity_sensitive_globs:\n  - services/**\n' >"$T/off.yml"
run --config "$T/off.yml" --security-key-file "$KEY"
rc_is "config without signed_security_verdict: the gate stays off (opt-in unchanged)" 0
view
RC=0; OUT="$(ENGSYS_MM_CONFIG="$CFG" bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 --security-key-file "$KEY" 2>&1)" || RC=$?
rc_is "ENGSYS_MM_CONFIG supplies the config when --config is omitted" 1
mkdir -p "$T/wd/.claude"; cp "$CFG" "$T/wd/.claude/merge-monster.yml"
RC=0; OUT="$(cd "$T/wd" && bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 --security-key-file "$KEY" 2>&1)" || RC=$?
rc_is "…and so does .claude/merge-monster.yml in the cwd" 1
# a session-supplied --config can add requirements, never replace the discoverable ones (CodeRabbit, major)
printf 'repo: x\n' >"$T/weak.yml"
files "services/dashboard/app/(auth)/x.tsx"; view
RC=0; OUT="$(ENGSYS_MM_CONFIG="$CFG" bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 --config "$T/weak.yml" --security-key-file "$KEY" 2>&1)" || RC=$?
rc_is "a weak --config does not replace ENGSYS_MM_CONFIG" 1
RC=0; OUT="$(cd "$T/wd" && bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 --config "$T/weak.yml" --security-key-file "$KEY" 2>&1)" || RC=$?
rc_is "…nor the repo's .claude/merge-monster.yml" 1
run --config "$T/weak.yml" --security-key-file "$KEY"
rc_is "…and on its own a weak config (no globs, gate not on) is what it says, unchanged (positive control)" 0
RC=0; OUT="$(ENGSYS_MM_CONFIG="$T/nope.yml" bash "$HERE/mm-preflight.sh" --repo acme/app --pr 7 --config "$CFG" --security-key-file "$KEY" 2>&1)" || RC=$?
rc_is "an unreadable discoverable config fails closed even when --config is fine" 1
# --require-security-verdict can still ask for more, never for less
files README.md
run --config "$CFG" --require-security-verdict --security-key-file "$KEY"
rc_is "the flag still requires a verdict when nothing sensitive changed" 1
# the capability the fleet probes for, and the signing grant
if grep -q 'security_sensitive_globs' "$HERE/mm-preflight.sh" && grep -q -- '--security-verdict' "$HERE/mm-preflight.sh"; then ok "mm-preflight.sh carries the capability literals the fleet probes"; else bad "capability literals"; fi
printf 'review\n' >"$T/body.md"
RC=0; OUT="$(env -u ENGSYS_SECURITY_VERDICT_KEY_FILE node "$SV" post --repo acme/app --pr 7 --sha "$HEAD_SHA" --verdict PASS --body-file "$T/body.md" 2>&1)" || RC=$?
rc_is "security-verdict post refuses without ENGSYS_SECURITY_VERDICT_KEY_FILE" 1
has "  …saying why" "not a security-lane session"
view "$GOOD"; files README.md
run --config "$CFG" --security-key-file "$KEY"
rc_is "…while verification by key-file path keeps working (positive control)" 0

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
