#!/usr/bin/env bash
# mm-preflight.sh — one JSON snapshot for the preflight gate on a single PR.
# `gh pr view --json` has no `reviewThreads` field (thread resolution is only
# available over GraphQL) — this stitches the `gh pr view` fields the model
# needs together with a GraphQL reviewThreads query into one JSON object.
#
# Usage: mm-preflight.sh --repo owner/name --pr N
set -euo pipefail

REPO="" PR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$PR" ] || { echo "usage: mm-preflight.sh --repo owner/name --pr N" >&2; exit 2; }

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

VIEW=$(gh pr view "$PR" -R "$REPO" \
  --json isDraft,mergeable,mergeStateStatus,baseRefName,body,comments,files,commits)

THREADS=$(gh api graphql -f owner="$OWNER" -f name="$NAME" -F number="$PR" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { id isResolved }
        }
      }
    }
  }' --jq '.data.repository.pullRequest.reviewThreads')

jq -n --argjson view "$VIEW" --argjson threads "$THREADS" '$view + {reviewThreads: $threads}'
