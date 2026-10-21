#!/usr/bin/env bash
# mm-snapshot.sh — one JSON snapshot of the open-PR landscape for queue
# (re)building. The model deep-dives individual PRs itself (gh pr view).
#
# A PR carrying the security-review request label (engsys#231, config security_review_label, default
# security-review-requested; matched case-insensitively) gets `"securityReview": true`; other PRs carry no such key, so
# their lines (and the tick's delta) are unchanged. Removing the label is therefore a delta line (engsys#241).
#
# Usage: mm-snapshot.sh --repo owner/name [--review-label LABEL]
set -euo pipefail
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve

REPO="" REVIEW_LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --review-label) REVIEW_LABEL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mm-snapshot.sh --repo owner/name [--review-label LABEL]" >&2; exit 2; }
[ -n "$REVIEW_LABEL" ] || REVIEW_LABEL=security-review-requested
assert_gh_auth mm-snapshot || exit 1

"$FLEET_GH" pr list -R "$REPO" --state open --limit 100 \
  --json number,title,author,isDraft,labels,mergeStateStatus,mergeable,baseRefName,headRefName,createdAt,additions,deletions \
  | jq -c --arg rl "$(printf '%s' "$REVIEW_LABEL" | tr '[:upper:]' '[:lower:]')" '[ .[] | {
      number, title, isDraft, mergeStateStatus, mergeable,
      base: .baseRefName, head: .headRefName, createdAt,
      author: .author.login,
      size: (.additions + .deletions),
      mm: [.labels[].name | select(startswith("mm:"))],
      dependabot: (.author.login == "app/dependabot" or .author.login == "dependabot" or .author.login == "dependabot[bot]")
    } + (if any(.labels[]; (.name | ascii_downcase) == $rl) then {securityReview: true} else {} end) ]'
