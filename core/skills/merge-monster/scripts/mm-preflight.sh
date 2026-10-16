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
# Usage: mm-preflight.sh --repo owner/name --pr N [--full]
set -euo pipefail
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve

REPO="" PR="" FULL=0 ISSUE_FILE="" CHECK_CONTRACT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    --full) FULL=1; shift ;;
    --issue-file) ISSUE_FILE="$2"; shift 2 ;;
    --check-contract) CHECK_CONTRACT=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$PR" ] || { echo "usage: mm-preflight.sh --repo owner/name --pr N [--full] [--issue-file <path>] [--check-contract]" >&2; exit 2; }

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

VIEW=$("$FLEET_GH" pr view "$PR" -R "$REPO" \
  --json isDraft,mergeable,mergeStateStatus,baseRefName,body,comments,files,commits)

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

jq -n --argjson view "$VIEW" --argjson threads "$THREADS" --argjson full "$FULL" --argjson contract "$CONTRACT_JSON" '
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
  | if $full == 1 then . else .comments |= ((. // []) | project) end'

