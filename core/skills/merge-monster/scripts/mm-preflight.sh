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
# (--config FILE, $ENGSYS_MM_CONFIG, .claude/merge-monster.yml in the cwd and the fleet-config-dir copy found by
# core/lib/mm-config.mjs: every one that exists counts, the strictest wins, so --config can add requirements but never
# replace the discoverable ones; a fleet-managed repo with no merge config anywhere fails closed) the script reads
# ready_requirements.signed_security_verdict (true turns --security-verdict on even when the flag is omitted),
# security_sensitive_globs and security_sensitive_label (default `security`), lists the PR's files over REST
# (pulls/N/files: filename and previous_filename, so both sides of a rename are matched, paginated) and requires a
# signed PASS whenever the PR carries the label or any changed file matches a glob (core/lib/security-sensitive.mjs).
# --require-security-verdict can still ask for more, never for less. Fail closed (exit 1, reason on stderr): an
# unreadable config (security_config_unreadable), a file list shorter than the PR's changed_files
# (security_file_list_unreadable), an unreadable key (key_unavailable). A PR with more than 3000 files, which GitHub
# cannot list in full, requires the verdict. Residual: a repo that is not fleet-managed, has no
# in-repo config and no exported ENGSYS_MM_CONFIG keeps the old opt-in behaviour (the launcher exports ENGSYS_MM_CONFIG
# for merge-role lines; --config is optional and only adds). The capability probe is --capabilities, not this text.
#
# Verdict required, none valid (engsys#231): a PR the gate requires a verdict for, with no authentic FINDINGS and no
# authentic PASS for its head (verify's `no_valid_verdict`; an unsigned or forged claim beside it is ignored once a signed
# verdict lands), is not a failure of the PR, it only needs a review. That case
# has its own exit code and reason so the merge session can request the review without parsing text: exit 3, the full
# snapshot on stdout as on success (securityVerdict carries reviewRequired: true, reviewLabel and requiredBy, so the
# rest of the preflight can still be judged: engsys#240's early gate request needs "clean apart from the verdict"), and
# one JSON line on stderr: {"ok":false,"state":"missing","reason":"security_review_required","verdictReason":
# "no_valid_verdict","reviewLabel":L,"head":SHA,"requiredBy":[...]}. reviewLabel is security_review_label from the
# config (default security-review-requested; set explicitly in two sources, the values must agree). Every other verdict
# failure stays exit 1.
#
# What this defends: a forgotten flag, a wrong --config, a model mistake, fully (every discoverable source counts and the
# strictest wins). A prompt injection only partially: a session runs as the same OS user, so it can still run this script with
# a different environment or reach the key file; the boundary is a separate GitHub identity for the security lane (#220).
#
# Usage: mm-preflight.sh --capabilities     (prints security-verdict, security-sensitive-globs and security-review-request,
#                                           exit 0; unknown flag = old kit)
#        mm-preflight.sh --repo owner/name --pr N [--full] [--config FILE]
#                        [--security-verdict [--require-security-verdict] [--security-key-file PATH]]
set -euo pipefail
# --capabilities (engsys#229): one token per line, no GitHub, no config. An older kit has no such flag and exits 2
# ("unknown arg"), which is how a caller tells the two apart without grepping source text.
if [ "${1:-}" = --capabilities ] && [ $# -eq 1 ]; then printf 'security-verdict\nsecurity-sensitive-globs\nsecurity-review-request\n'; exit 0; fi
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
# Every config source that exists counts and the strictest wins, so a session-supplied --config can add requirements
# but never replace the discoverable ones (a file with only `repo: x` cannot lower them): $ENGSYS_MM_CONFIG (for the
# fleet's launch context to export), .claude/merge-monster.yml in the cwd, and --config. Each must be readable.
# The fleet-config-dir copy (the instance plugin's repos/<owner>/<repo>/merge-monster.yml, found through the session's
# Claude config dir by core/lib/mm-config.mjs) counts too. A fleet-managed repo (that directory exists) with no readable
# merge config anywhere, in-repo or fleet, fails closed rather than silently staying opt-in.
MC_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/mm-config.mjs"
FLEET_MM_CONFIGS=()
if command -v node >/dev/null && [ -f "$MC_SCRIPT" ]; then
  MC_JSON=$(node "$MC_SCRIPT" resolve --repo "$REPO" 2>/dev/null) || sec_fail "security_config_unreadable: could not look for the fleet config of $REPO"
  while IFS= read -r c; do [ -z "$c" ] || FLEET_MM_CONFIGS+=("$c"); done < <(jq -r '.configs[]?' <<<"$MC_JSON")
  if [ "$(jq -r '.missing' <<<"$MC_JSON")" = true ] && [ ! -f .claude/merge-monster.yml ]; then
    sec_fail "security_config_unreadable: $REPO is fleet-managed ($(jq -r '.fleetDirs[0]' <<<"$MC_JSON")) but no readable merge-monster.yml was found there or in the repo"
  fi
fi
# ENGSYS_MM_CONFIG is a versioned cache path the launcher resolved at session start; if that version directory was
# pruned since, a readable discovered copy stands in for it (with a warning) instead of failing every PR. With no
# readable strict source left it is still kept, so the unreadable path fails closed below.
MM_ENV_CONFIG="${ENGSYS_MM_CONFIG:-}"
if [ -n "$MM_ENV_CONFIG" ] && [ ! -r "$MM_ENV_CONFIG" ] && { [ "${#FLEET_MM_CONFIGS[@]}" -gt 0 ] || [ -f .claude/merge-monster.yml ]; }; then
  echo "mm-preflight: warning: ENGSYS_MM_CONFIG ($MM_ENV_CONFIG) is not readable; using the discovered merge config instead" >&2
  MM_ENV_CONFIG=""
fi
SS_CONFIGS=()
for c in "$MM_ENV_CONFIG" "$([ ! -f .claude/merge-monster.yml ] || echo .claude/merge-monster.yml)" ${FLEET_MM_CONFIGS[@]+"${FLEET_MM_CONFIGS[@]}"} "$MM_CONFIG_FILE"; do
  [ -n "$c" ] || continue
  SS_CONFIGS+=("$c")   # no de-duplication: a repeat is harmless, and a substring match could drop a config
done
SEC_REASONS="[]"
REVIEW_LABEL="security-review-requested"   # security_review_label (engsys#231); the first source that sets it, all must agree
REVIEW_LABEL_FROM=""
if [ "${#SS_CONFIGS[@]}" -gt 0 ] || [ "$SEC_VERDICT" -eq 1 ]; then
  command -v node >/dev/null && [ -f "$SS_SCRIPT" ] || sec_fail "security_config_unreadable: node or security-sensitive.mjs not found"
  SS_LIST=("${SS_CONFIGS[@]+"${SS_CONFIGS[@]}"}"); [ "${#SS_LIST[@]}" -gt 0 ] || SS_LIST=("")
  SS_GLOBS=0
  for c in "${SS_LIST[@]}"; do
    SS_CFG=(); [ -z "$c" ] || SS_CFG=(--config "$c")
    SS_POLICY=$(node "$SS_SCRIPT" policy ${SS_CFG[@]+"${SS_CFG[@]}"}) || sec_fail "$(jq -r '.reason // "security_config_unreadable"' <<<"$SS_POLICY" 2>/dev/null || echo security_config_unreadable)"
    if [ "$(jq -r '.signedVerdict' <<<"$SS_POLICY")" = true ]; then SEC_VERDICT=1; fi
    if [ "$(jq -r '.reviewLabelSet // false' <<<"$SS_POLICY")" = true ]; then
      RL="$(jq -r '.reviewLabel' <<<"$SS_POLICY")"
      if [ -z "$REVIEW_LABEL_FROM" ]; then REVIEW_LABEL="$RL" REVIEW_LABEL_FROM="$c"
      elif [ "$(printf '%s' "$RL" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$REVIEW_LABEL" | tr '[:upper:]' '[:lower:]')" ]; then
        sec_fail "security_config_unreadable: security_review_label is '$REVIEW_LABEL' in $REVIEW_LABEL_FROM but '$RL' in $c"
      fi
    fi
    SS_GLOBS=$((SS_GLOBS + $(jq -r '.globs' <<<"$SS_POLICY")))
  done
  if [ "$SEC_VERDICT" -eq 1 ]; then
    # the list is projected to the two path fields (the API also returns each file's patch text) and handed to jq as a
    # file, never as an argument: a large PR would otherwise exceed the argument size limit (E2BIG)
    SS_FILES_TMP="$(mktemp)"; trap 'rm -f "$SS_FILES_TMP"' EXIT
    echo "[]" >"$SS_FILES_TMP"; SS_COUNT="null"
    if [ "$SS_GLOBS" -gt 0 ]; then
      "$FLEET_GH" api "repos/$REPO/pulls/$PR/files?per_page=100" --paginate | jq -s -c 'add // [] | map({filename, previous_filename})' >"$SS_FILES_TMP" || sec_fail "security_file_list_unreadable: listing the PR files failed"
      [ -s "$SS_FILES_TMP" ] || sec_fail "security_file_list_unreadable: the file list is empty"
      # read after the file list, with the head it describes: if the head moved since `pr view`, the verdict check below
      # would be judging another commit than the file list, so fail closed (the next tick sees the new head)
      SS_META=$("$FLEET_GH" api "repos/$REPO/pulls/$PR" --jq '"\(.changed_files) \(.head.sha)"') || sec_fail "security_file_list_unreadable: reading changed_files failed"
      SS_COUNT="${SS_META%% *}"
      [ "${SS_META#* }" = "$(jq -r '.headRefOid // ""' <<<"$VIEW")" ] || sec_fail "security_file_list_unreadable: the PR head moved while it was read"
      [[ "$SS_COUNT" =~ ^[0-9]+$ ]] || sec_fail "security_file_list_unreadable: changed_files is not a number"
    fi
    for c in "${SS_LIST[@]}"; do
      SS_CFG=(); [ -z "$c" ] || SS_CFG=(--config "$c")
      SS_OUT=$(jq -n -c --slurpfile f "$SS_FILES_TMP" --argjson n "$SS_COUNT" --argjson l "$(jq -c '.labels // []' <<<"$VIEW")" '{files:$f[0], changedFiles:$n, labels:$l}' \
        | node "$SS_SCRIPT" decide ${SS_CFG[@]+"${SS_CFG[@]}"}) || sec_fail "$(jq -r '.reason // "security_file_list_unreadable"' <<<"$SS_OUT" 2>/dev/null || echo security_file_list_unreadable)"
      if [ "$(jq -r '.required' <<<"$SS_OUT")" = true ]; then SEC_REQUIRE=1; SEC_REASONS="$(jq -c -n --argjson a "$SEC_REASONS" --argjson b "$(jq -c '.reasons' <<<"$SS_OUT")" '$a + $b | unique')"; fi
    done
  fi
fi

SECURITY_JSON="null"
REVIEW_NEEDED=0
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
  # verdict required, none valid: its own outcome (exit 3 below), never a plain failure (engsys#231)
  if [ "$SV_RC" -eq 1 ] && [ "$SEC_REQUIRE" -eq 1 ] && [ "$(jq -r '.state // ""' <<<"$SECURITY_JSON" 2>/dev/null)" = missing ]; then
    REVIEW_NEEDED=1; SV_RC=0
  fi
  [ "$SV_RC" -ne 0 ] || [ -z "$SECURITY_JSON" ] || SECURITY_JSON=$(jq -c --argjson r "$SEC_REQUIRE" --argjson why "$SEC_REASONS" --arg l "$REVIEW_LABEL" --argjson need "$REVIEW_NEEDED" \
    '. + {requiredBy: (if $r == 1 then $why else [] end), reviewLabel: $l} + (if $need == 1 then {reviewRequired: true} else {} end)' <<<"$SECURITY_JSON" 2>/dev/null || printf '%s' "$SECURITY_JSON")
  if [ "$SV_RC" -ne 0 ]; then
    if [ -n "$SECURITY_JSON" ]; then echo "$SECURITY_JSON" >&2
    else echo '{"ok":false,"state":"error","reason":"security_verdict_check_failed"}' >&2; fi
    exit 1
  fi
fi

if [ "$REVIEW_NEEDED" -eq 1 ]; then
  jq -c -n --argjson s "$SECURITY_JSON" --arg h "$(jq -r '.headRefOid // ""' <<<"$VIEW")" \
    '{ok: false, state: "missing", reason: "security_review_required", verdictReason: ($s.reason // "no_valid_verdict"), reviewLabel: $s.reviewLabel, head: $h, requiredBy: ($s.requiredBy // [])}' >&2
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
[ "$REVIEW_NEEDED" -eq 0 ] || exit 3
