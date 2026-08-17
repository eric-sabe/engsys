#!/usr/bin/env bash
# mnt-snapshot.sh — one JSON snapshot of the watch surface for triage-queue
# (re)building: open Dependabot PRs, open Dependabot/CodeQL alert counts, and
# the latest push/dispatch conclusions for Secret Scan + services-ci (Trivy).
# The model deep-dives individual findings itself (gh api / gh pr view).
#
# Usage: mnt-snapshot.sh --repo owner/name [--default-branch main]
set -euo pipefail

REPO="" DEFBRANCH="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --default-branch) DEFBRANCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: mnt-snapshot.sh --repo owner/name [--default-branch main]" >&2; exit 2; }

# --- open Dependabot PRs ----------------------------------------------------
DEPENDABOT_PRS=$(gh pr list -R "$REPO" --author "app/dependabot" --state open --limit 200 \
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
if DEP_ALERTS_RAW=$(gh api --paginate "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
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
if CODEQL_ALERTS_RAW=$(gh api --paginate "repos/$REPO/code-scanning/alerts?state=open&per_page=100" \
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

# --- latest Secret Scan workflow_run on the default branch -----------------
SECRET_SCAN=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "Secret Scan" --limit 1 \
  --json databaseId,conclusion,status \
  --jq '.[0] // {}' 2>/dev/null || echo "{}")

# --- latest push/dispatch services-ci run on the default branch (Trivy) ----
# Trivy image-scan runs push/dispatch only, not pull_request — see
# docs/agent-lessons/ (Trivy image-scan gate is push-only).
SERVICES_CI=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "services-ci.yml" \
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
  '{
    dependabot_prs: $dependabot_prs,
    dependabot_alerts: { available: $dep_alerts_available, count: $dep_alerts_count, items: $dep_alerts },
    codeql_alerts: { available: $codeql_alerts_available, count: $codeql_alerts_count, items: $codeql_alerts },
    secret_scan_latest: $secret_scan,
    services_ci_latest_push: $services_ci
  }'
