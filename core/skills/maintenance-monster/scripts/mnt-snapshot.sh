#!/usr/bin/env bash
# mnt-snapshot.sh — one JSON snapshot of the watch surface for triage-queue
# (re)building: open Dependabot PRs, open Dependabot/CodeQL alert counts, and
# the latest push/dispatch conclusions for Secret Scan + services-ci (Trivy).
# The model deep-dives individual findings itself (gh api / gh pr view).
# Also the open PRs that ask the security lane for a signed verdict (engsys#231): security_reviews.items =
# [{number, head}] for PRs carrying the review request label (--review-label, default: security_review_label
# from the merge configs, found by core/lib/security-sensitive.mjs review-label, else security-review-requested), so a new
# request, or a new head on a requested PR, is a tick delta.
#
# Usage: mnt-snapshot.sh --repo owner/name [--default-branch main] [--review-label LABEL]
set -euo pipefail
# shellcheck source=../../../lib/fleet-gh.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/fleet-gh.sh"
fleet_gh_resolve
# shellcheck source=../../../lib/monster.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../lib/monster.sh"

REPO="" DEFBRANCH="main" REVIEW_LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --default-branch) DEFBRANCH="$2"; shift 2 ;;
    --review-label) REVIEW_LABEL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mnt-snapshot.sh --repo owner/name [--default-branch main]" >&2; exit 2; }
assert_gh_auth mnt-snapshot || exit 1

# --- open Dependabot PRs ----------------------------------------------------
DEPENDABOT_PRS=$("$FLEET_GH" pr list -R "$REPO" --author "app/dependabot" --state open --limit 200 \
  --json number,title,labels,mergeStateStatus,createdAt \
  --jq '[ .[] | {
      number, title, createdAt,
      mergeStateStatus,
      mnt: [.labels[].name | select(startswith("mnt:"))]
    } ]' 2>/dev/null || echo "[]")

# --- open Dependabot alerts (may be disabled/forbidden — tolerate) ---------
# Distinguish "0 alerts" (gh succeeded, empty result) from "couldn't read
# alerts" (404/403 — GHAS off/forbidden). A swallowed failure must never
# collapse to an empty array, or the snapshot reads as clean when the
# surface is actually unavailable. --jq emits one object per alert (not an
# array) so --paginate's per-page output concatenates cleanly; slurp after.
if DEP_ALERTS_RAW=$("$FLEET_GH" api --paginate "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
    --jq '.[] | {
      number, severity: .security_advisory.severity,
      package: .dependency.package.name,
      ghsa: .security_advisory.ghsa_id
    }' 2>/dev/null); then
  DEP_ALERTS_AVAILABLE=true
  DEP_ALERTS=$(printf '%s' "$DEP_ALERTS_RAW" | jq -s '.')
  DEP_ALERTS_COUNT=$(echo "$DEP_ALERTS" | jq 'length')
else
  DEP_ALERTS_AVAILABLE=false
  DEP_ALERTS="[]"
  DEP_ALERTS_COUNT="null"
fi

# --- open CodeQL / code-scanning alerts (GHAS may be off — tolerate) -------
# Same available-vs-zero distinction as Dependabot alerts above.
if CODEQL_ALERTS_RAW=$("$FLEET_GH" api --paginate "repos/$REPO/code-scanning/alerts?state=open&per_page=100" \
    --jq '.[] | {
      number, rule: .rule.id, severity: .rule.security_severity_level
    }' 2>/dev/null); then
  CODEQL_ALERTS_AVAILABLE=true
  CODEQL_ALERTS=$(printf '%s' "$CODEQL_ALERTS_RAW" | jq -s '.')
  CODEQL_ALERTS_COUNT=$(echo "$CODEQL_ALERTS" | jq 'length')
else
  CODEQL_ALERTS_AVAILABLE=false
  CODEQL_ALERTS="[]"
  CODEQL_ALERTS_COUNT="null"
fi

# --- security-review requests (engsys#231) ---------------------------------
# A failed read is `available: false`, never an empty (clean-looking) list.
# An unresolved label (a cross-config conflict) is reported in security_reviews.label_error (a tick delta) and on
# stderr, never silently replaced by the default.
REVIEW_LABEL_ERROR=""
if [ -z "$REVIEW_LABEL" ]; then
  monster_review_label "$REPO"
  REVIEW_LABEL="$MONSTER_REVIEW_LABEL" REVIEW_LABEL_ERROR="$MONSTER_REVIEW_LABEL_WARN"
  [ -z "$REVIEW_LABEL_ERROR" ] || echo "mnt-snapshot: $REVIEW_LABEL_ERROR" >&2
fi
if REVIEW_RAW=$("$FLEET_GH" pr list -R "$REPO" --state open --limit 200 --label "$REVIEW_LABEL" --json number,headRefOid,labels 2>/dev/null) \
  && REVIEW_PRS=$(printf '%s' "$REVIEW_RAW" | jq -c --arg rl "$(printf '%s' "$REVIEW_LABEL" | tr '[:upper:]' '[:lower:]')" \
    '[ .[] | select(any(.labels[]; (.name | ascii_downcase) == $rl)) | {number, head: .headRefOid} ] | sort_by(.number)' 2>/dev/null) \
  && [ -n "$REVIEW_PRS" ]; then
  REVIEW_AVAILABLE=true
else
  REVIEW_AVAILABLE=false REVIEW_PRS="[]"
fi

# --- latest Secret Scan workflow_run on the default branch -----------------
SECRET_SCAN=$("$FLEET_GH" run list -R "$REPO" --branch "$DEFBRANCH" --workflow "Secret Scan" --limit 1 \
  --json databaseId,conclusion,status \
  --jq '.[0] // {}' 2>/dev/null || echo "{}")

# --- latest push/dispatch services-ci run on the default branch (Trivy) ----
# Trivy image-scan runs push/dispatch only, not pull_request — see
# docs/agent-lessons/ (Trivy image-scan gate is push-only).
SERVICES_CI=$("$FLEET_GH" run list -R "$REPO" --branch "$DEFBRANCH" --workflow "services-ci.yml" \
  --event push --limit 1 \
  --json databaseId,conclusion,status,headSha \
  --jq '.[0] // {}' 2>/dev/null || echo "{}")

jq -n \
  --argjson dependabot_prs "$DEPENDABOT_PRS" \
  --argjson dep_alerts_available "$DEP_ALERTS_AVAILABLE" \
  --argjson dep_alerts "$DEP_ALERTS" \
  --argjson dep_alerts_count "$DEP_ALERTS_COUNT" \
  --argjson codeql_alerts_available "$CODEQL_ALERTS_AVAILABLE" \
  --argjson codeql_alerts "$CODEQL_ALERTS" \
  --argjson codeql_alerts_count "$CODEQL_ALERTS_COUNT" \
  --argjson secret_scan "$SECRET_SCAN" \
  --argjson services_ci "$SERVICES_CI" \
  --argjson review_available "$REVIEW_AVAILABLE" \
  --argjson review_prs "$REVIEW_PRS" \
  --arg review_label_error "$REVIEW_LABEL_ERROR" \
  '{
    dependabot_prs: $dependabot_prs,
    dependabot_alerts: { available: $dep_alerts_available, count: $dep_alerts_count, items: $dep_alerts },
    codeql_alerts: { available: $codeql_alerts_available, count: $codeql_alerts_count, items: $codeql_alerts },
    secret_scan_latest: $secret_scan,
    services_ci_latest_push: $services_ci,
    security_reviews: ({ available: $review_available, count: ($review_prs | length), items: $review_prs }
      + (if $review_label_error != "" then {label_error: $review_label_error} else {} end))
  }'
