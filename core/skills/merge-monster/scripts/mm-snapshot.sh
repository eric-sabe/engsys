#!/usr/bin/env bash
# mm-snapshot.sh — one JSON snapshot of the open-PR landscape for queue
# (re)building. The model deep-dives individual PRs itself (gh pr view).
#
# Usage: mm-snapshot.sh --repo owner/name
set -euo pipefail

REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mm-snapshot.sh --repo owner/name" >&2; exit 2; }

gh pr list -R "$REPO" --state open --limit 100 \
  --json number,title,author,isDraft,labels,mergeStateStatus,mergeable,baseRefName,headRefName,createdAt,additions,deletions \
  --jq '[ .[] | {
      number, title, isDraft, mergeStateStatus, mergeable,
      base: .baseRefName, head: .headRefName, createdAt,
      author: .author.login,
      size: (.additions + .deletions),
      mm: [.labels[].name | select(startswith("mm:"))],
      dependabot: (.author.login == "app/dependabot" or .author.login == "dependabot")
    } ]'
