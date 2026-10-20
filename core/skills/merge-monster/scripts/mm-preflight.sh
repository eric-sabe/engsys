#!/usr/bin/env bash
# mm-preflight.sh — one JSON snapshot for the preflight gate on a single PR.
# `gh pr view --json` has no `reviewThreads` field (thread resolution is only
# available over GraphQL) — this stitches the `gh pr view` fields the model
# needs together with a GraphQL reviewThreads query into one JSON object.
#
# Comments are PROJECTED (engsys#126): a PR thread can hold tens of kilobytes of review dumps, and preflight
# needs only which evidence is there. `comments` becomes
#   { count, markers: {"<!-- name … -->": n, …}, findingAcks: n,
#     items: [ {author, createdAt, url, markers: [...], findingAcks: ["FINDING-ACK …", …], excerpt} ] }
# where a marker is an HTML comment at the very start of a comment body (every consecutive one, whitespace
# collapsed, ≤200 chars), a FINDING-ACK line is any body line that starts with FINDING-ACK (≤200 chars, ≤20
# per comment), and `excerpt` is the first 300 characters after the leading markers (a handoff block's
# fields fit). Only comments with a marker or a FINDING-ACK line are items; the rest are counted. No marker
# name is special-cased: the config's review_marker, a handoff block or any other marker reads the same.
# --full keeps the raw comments instead.
#
# Signed security verdicts (engsys#197, option B; OFF unless --security-verdict is passed): the model passes
# it only when the config sets ready_requirements.signed_security_verdict: true. Then the authentic `nyx-review`
# verdicts (valid HMAC) are ranked by SIGNED timestamp, never comment createdAt, and the latest decides
# (core/lib/security-verdict.mjs): FINDINGS for ANY head fails and is sticky (a push does not clear it; only a
# fresh signed verdict for the current head does), and a PASS counts only when signed for the current head.
# Unsigned, forged or tampered `<!-- nyx-review -->` comments are ignored once an authentic verdict decides;
# with none, such a claim fails the PR (it never passes silently), as does an unreadable key (exit 1, reason
# on stderr). --require-security-verdict also fails a
# PR that has no valid verdict (pass it for PRs that need a security review). Defence in depth, NOT a
# boundary: the key is readable by every process of the fleet's OS user.
#
# The requirement itself is decided HERE, not by the merge session (engsys#229): with the repo's merge-monster config
# (--config FILE; else $ENGSYS_MM_CONFIG; else .claude/merge-monster.yml in the cwd) the script reads
# ready_requirements.signed_security_verdict (true turns --security-verdict on even when the flag is omitted),
# security_sensitive_globs and security_sensitive_label (default `security`), lists the PR's files over REST
# (pulls/N/files: filename and previous_filename, so both sides of a rename are matched, paginated) and requires a
# signed PASS whenever the PR carries the label or any changed file matches a glob (core/lib/security-sensitive.mjs).
# --require-security-verdict can still ask for more, never for less. Fail closed (exit 1, reason on stderr): an
# unreadable config (security_config_unreadable), a file list shorter than the PR's changed_files
# (security_file_list_unreadable), an unreadable key (key_unavailable). A PR with more than 3000 files, which GitHub
# cannot list in full, requires the verdict. Residual: a session that supplies no config and has none discoverable
# keeps the old opt-in behaviour, so the fleet's launch context must pass --config (the capability to probe for is
# the literal security_sensitive_globs in this file).
#
# Usage: mm-preflight.sh --repo owner/name --pr N [--full] [--config FILE]
#                        [--security-verdict [--require-security-verdict] [--security-key-file PATH]]
set -euo pipefail
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve

REPO="" PR="" FULL=0 ISSUE_FILE="" CHECK_CONTRACT=0 SEC_VERDICT=0 SEC_REQUIRE=0 SEC_KEY_FILE="" MM_CONFIG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    --full) FULL=1; shift ;;
    --issue-file) ISSUE_FILE="$2"; shift 2 ;;
    --check-contract) CHECK_CONTRACT=1; shift ;;
    --security-verdict) SEC_VERDICT=1; shift ;;
    --require-security-verdict) SEC_VERDICT=1; SEC_REQUIRE=1; shift ;;
    --security-key-file) SEC_KEY_FILE="$2"; shift 2 ;;
    --config) MM_CONFIG_FILE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$PR" ] || { echo "usage: mm-preflight.sh --repo owner/name --pr N [--full] [--issue-file <path>] [--check-contract]" >&2; exit 2; }

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

VIEW=$("$FLEET_GH" pr view "$PR" -R "$REPO" \
  --json isDraft,mergeable,mergeStateStatus,baseRefName,headRefOid,body,comments,files,commits,labels)

THREADS=$("$FLEET_GH" api graphql -f owner="$OWNER" -f name="$NAME" -F number="$PR" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { id isResolved }
        }
      }
    }
  }' --jq '.data.repository.pullRequest.reviewThreads')

CONTRACT_JSON="null"
if [ "$CHECK_CONTRACT" -eq 1 ] || [ -n "$ISSUE_FILE" ]; then
  CHANGED_FILES=$(jq -r '[.files[]?.path // empty] | join(",")' <<<"$VIEW")
  PR_BODY_TMP="$(mktemp)"
  jq -r '.body // ""' <<<"$VIEW" >"$PR_BODY_TMP"
  CC_ARGS=(--pr-body-file "$PR_BODY_TMP" --changed-files "$CHANGED_FILES" --no-test-id-check)
  [ -n "$ISSUE_FILE" ] && CC_ARGS+=(--issue-file "$ISSUE_FILE")
  CC_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/contract-check.mjs"
  CONTRACT_JSON=$(node "$CC_SCRIPT" "${CC_ARGS[@]}" 2>/dev/null) || {
    rm -f "$PR_BODY_TMP"
    if [ "$CHECK_CONTRACT" -eq 1 ]; then
      echo "$CONTRACT_JSON" >&2
      exit 1
    fi
    [ -n "$CONTRACT_JSON" ] || CONTRACT_JSON="null"
  }
  rm -f "$PR_BODY_TMP"
fi

# Whether this PR needs a signed security verdict, decided from the config (engsys#229), never from the session's flags.
SS_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/security-sensitive.mjs"
sec_fail() { printf '{"ok":false,"state":"error","reason":%s}\n' "$(jq -Rn --arg r "$1" '$r')" >&2; exit 1; }
[ -n "$MM_CONFIG_FILE" ] || MM_CONFIG_FILE="${ENGSYS_MM_CONFIG:-}"
[ -n "$MM_CONFIG_FILE" ] || { [ ! -f .claude/merge-monster.yml ] || MM_CONFIG_FILE=".claude/merge-monster.yml"; }
SEC_REASONS="[]"
if [ -n "$MM_CONFIG_FILE" ] || [ "$SEC_VERDICT" -eq 1 ]; then
  command -v node >/dev/null && [ -f "$SS_SCRIPT" ] || sec_fail "security_config_unreadable: node or security-sensitive.mjs not found"
  SS_CFG=(); [ -z "$MM_CONFIG_FILE" ] || SS_CFG=(--config "$MM_CONFIG_FILE")
  SS_POLICY=$(node "$SS_SCRIPT" policy ${SS_CFG[@]+"${SS_CFG[@]}"}) || sec_fail "$(jq -r '.reason // "security_config_unreadable"' <<<"$SS_POLICY" 2>/dev/null || echo security_config_unreadable)"
  if [ "$(jq -r '.signedVerdict' <<<"$SS_POLICY")" = true ]; then SEC_VERDICT=1; fi
  if [ "$SEC_VERDICT" -eq 1 ]; then
    SS_FILES="[]" SS_COUNT="null"
    if [ "$(jq -r '.globs' <<<"$SS_POLICY")" -gt 0 ]; then
      SS_FILES=$("$FLEET_GH" api "repos/$REPO/pulls/$PR/files?per_page=100" --paginate | jq -s -c 'add // []') || sec_fail "security_file_list_unreadable: listing the PR files failed"
      SS_COUNT=$("$FLEET_GH" api "repos/$REPO/pulls/$PR" --jq '.changed_files') || sec_fail "security_file_list_unreadable: reading changed_files failed"
      [[ "$SS_COUNT" =~ ^[0-9]+$ ]] || sec_fail "security_file_list_unreadable: changed_files is not a number"
    fi
    SS_OUT=$(jq -n -c --argjson f "$SS_FILES" --argjson n "$SS_COUNT" --argjson l "$(jq -c '.labels // []' <<<"$VIEW")" '{files:$f, changedFiles:$n, labels:$l}' \
      | node "$SS_SCRIPT" decide ${SS_CFG[@]+"${SS_CFG[@]}"}) || sec_fail "$(jq -r '.reason // "security_file_list_unreadable"' <<<"$SS_OUT" 2>/dev/null || echo security_file_list_unreadable)"
    if [ "$(jq -r '.required' <<<"$SS_OUT")" = true ]; then SEC_REQUIRE=1; SEC_REASONS="$(jq -c '.reasons' <<<"$SS_OUT")"; fi
  fi
fi

SECURITY_JSON="null"
if [ "$SEC_VERDICT" -eq 1 ]; then
  # Fail closed on every path below: no key, no head SHA, no node, or any non-zero verdict exit.
  [ -n "$SEC_KEY_FILE" ] || SEC_KEY_FILE="${FLEET_STATE:+$FLEET_STATE/security-verdict.key}"
  SV_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/security-verdict.mjs"
  HEAD_SHA=$(jq -r '.headRefOid // ""' <<<"$VIEW")
  if [ -z "$SEC_KEY_FILE" ] || [ -z "$HEAD_SHA" ] || ! command -v node >/dev/null || [ ! -f "$SV_SCRIPT" ]; then
    echo '{"ok":false,"state":"error","reason":"security_verdict_unconfigured: need a key file (--security-key-file or FLEET_STATE), the PR head SHA, node and security-verdict.mjs"}' >&2
    exit 1
  fi
  SV_ARGS=(verify --repo "$REPO" --pr "$PR" --sha "$HEAD_SHA" --key-file "$SEC_KEY_FILE")
  [ "$SEC_REQUIRE" -eq 1 ] && SV_ARGS+=(--require)
  SV_RC=0
  SECURITY_JSON=$(jq -c '.comments // []' <<<"$VIEW" | node "$SV_SCRIPT" "${SV_ARGS[@]}") || SV_RC=$?
  [ "$SV_RC" -ne 0 ] || [ -z "$SECURITY_JSON" ] || SECURITY_JSON=$(jq -c --argjson r "$SEC_REQUIRE" --argjson why "$SEC_REASONS" '. + {requiredBy: (if $r == 1 then $why else [] end)}' <<<"$SECURITY_JSON" 2>/dev/null || printf '%s' "$SECURITY_JSON")
  if [ "$SV_RC" -ne 0 ]; then
    if [ -n "$SECURITY_JSON" ]; then echo "$SECURITY_JSON" >&2
    else echo '{"ok":false,"state":"error","reason":"security_verdict_check_failed"}' >&2; fi
    exit 1
  fi
fi

jq -n --argjson view "$VIEW" --argjson security "$SECURITY_JSON" --argjson threads "$THREADS" --argjson full "$FULL" --argjson contract "$CONTRACT_JSON" '
  def leading_markers: (capture("^(?<lead>(\\s*<!--[\\s\\S]*?-->)+)")? // {lead: ""}).lead
    | [scan("<!--[\\s\\S]*?-->") | gsub("\\s+"; " ") | .[0:200]];
  def project:
    [ .[] | (.body // "") as $b
      | { author: (.author.login // null), createdAt, url,
          markers: ($b | leading_markers),
          findingAcks: ([$b | split("\n")[] | select(test("^\\s*FINDING-ACK\\b")) | sub("^\\s+"; "") | .[0:200]] | .[0:20]),
          excerpt: ($b | sub("^(\\s*<!--[\\s\\S]*?-->)+"; "") | sub("^\\s+"; "") | .[0:300]) } ] as $all
    | { count: ($all | length),
        markers: (reduce ($all[].markers[]) as $m ({}; .[$m] += 1)),
        findingAcks: ([$all[].findingAcks[]] | length),
        items: [ $all[] | select((.markers | length) > 0 or (.findingAcks | length) > 0) ] };
  $view + {reviewThreads: $threads}
  | if $contract != null then . + {contractCheck: $contract} else . end
  | if $security != null then . + {securityVerdict: $security} else . end
  | if $full == 1 then . else .comments |= ((. // []) | project) end'

