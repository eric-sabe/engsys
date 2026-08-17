#!/usr/bin/env bash
# mnt-watch.sh — Maintenance Monster event bus. Designed to run under a
# persistent Monitor: polls GitHub in a shell loop and emits ONE LINE PER
# STATE CHANGE, so the model sleeps free between events and wakes within one
# interval.
#
# Events:
#   DEPENDABOT_PR #N <title>   new open Dependabot PR
#   DEP_ALERT <id> <pkg> <sev> new open Dependabot (dependency) alert
#   CODEQL_ALERT <id> <rule> <sev>  new open code-scanning alert
#   SECRET_ALERT <run>         latest Secret Scan workflow_run concluded failure
#   TRIVY_RED <run>            latest push/dispatch services-ci run concluded failure
#   STOP                       ledger issue closed (kill switch) — script exits
#
# GHAS surfaces (Dependabot alerts, CodeQL) may be disabled/forbidden for a
# repo — each gh call is individually guarded so one failing surface never
# kills the loop.
#
# Usage: mnt-watch.sh --repo owner/name --state-dir DIR [--interval 30]
#                     [--default-branch main] [--ledger N]
set -u

REPO="" DIR="" INTERVAL=30 DEFBRANCH=main LEDGER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --state-dir) DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --default-branch) DEFBRANCH="$2"; shift 2 ;;
    --ledger) LEDGER="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "usage: mnt-watch.sh --repo owner/name --state-dir DIR" >&2; exit 2; }

W="$DIR/.watch"
mkdir -p "$W"
touch "$W/deps_pr.tsv" "$W/dep_alerts.tsv" "$W/codeql_alerts.tsv" "$W/secretrun.txt" "$W/trivyrun.txt"

# emit_diff <old-file> <new-file> <added-prefix> [removed-prefix]
# Files are sorted "key<TAB>rest" lines. Diffs by KEY ONLY (column 1) so
# metadata edits (e.g. an alert's summary text) don't fire false add/remove
# events.
emit_diff() {
  old="$1"; new="$2"; addp="$3"; remp="${4:-}"
  cut -f1 "$old" | sort -u > "$old.k"
  cut -f1 "$new" | sort -u > "$new.k"
  comm -13 "$old.k" "$new.k" | while IFS= read -r key; do
    [ -n "$key" ] && echo "$addp $(awk -F'\t' -v k="$key" '$1==k {print; exit}' "$new")"
  done
  if [ -n "$remp" ]; then
    comm -23 "$old.k" "$new.k" | while IFS= read -r key; do
      [ -n "$key" ] && echo "$remp $key"
    done
  fi
  rm -f "$old.k" "$new.k"
  mv "$new" "$old"
}

while true; do
  # --- kill switch: ledger issue closed → STOP and exit -------------------
  if [ -n "$LEDGER" ]; then
    STATE=$(gh issue view "$LEDGER" -R "$REPO" --json state --jq .state 2>/dev/null || echo "")
    if [ "$STATE" = "CLOSED" ]; then echo "STOP"; exit 0; fi
  fi

  # --- new open Dependabot PRs ----------------------------------------------
  if OUT=$(gh pr list -R "$REPO" --author "app/dependabot" --state open --limit 200 --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/deps_pr.new"
    emit_diff "$W/deps_pr.tsv" "$W/deps_pr.new" "DEPENDABOT_PR"
  fi

  # --- new open Dependabot (dependency vulnerability) alerts ---------------
  # Tolerates 404/403 — GHAS Dependabot alerts may be disabled for the repo.
  if OUT=$(gh api --paginate "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
      --jq '.[] | "\(.number)\t\(.dependency.package.name)\t\(.security_advisory.severity)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/dep_alerts.new"
    emit_diff "$W/dep_alerts.tsv" "$W/dep_alerts.new" "DEP_ALERT"
  fi

  # --- new open CodeQL / code-scanning alerts -------------------------------
  # Tolerates 404/403 — GHAS code scanning may be disabled for the repo.
  if OUT=$(gh api --paginate "repos/$REPO/code-scanning/alerts?state=open&per_page=100" \
      --jq '.[] | "\(.number)\t\(.rule.id)\t\(.rule.security_severity_level // "unknown")"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/codeql_alerts.new"
    emit_diff "$W/codeql_alerts.tsv" "$W/codeql_alerts.new" "CODEQL_ALERT"
  fi

  # --- latest Secret Scan workflow_run went red -----------------------------
  # Only record runs with a terminal conclusion — recording an in-progress
  # run id would suppress its SECRET_ALERT when it later concludes failure.
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "Secret Scan" --limit 1 \
      --json databaseId,conclusion \
      --jq '.[0] | "\(.databaseId)\t\(.conclusion)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    LAST=$(cat "$W/secretrun.txt" 2>/dev/null || true)
    if [ -n "$CONCL" ] && [ "$CONCL" != "null" ]; then
      if [ "$CONCL" = "failure" ] && [ "$RUNID" != "$LAST" ]; then
        echo "SECRET_ALERT $RUNID"
      fi
      echo "$RUNID" > "$W/secretrun.txt"
    fi
  fi

  # --- latest push/dispatch services-ci run went red (Trivy is push-only) --
  # Only record runs with a terminal conclusion, same guard as above — an
  # in-progress push run must not suppress its own eventual TRIVY_RED.
  # Deliberately push-scoped, not widened to workflow_dispatch: this loop is
  # a red-main DETECTOR, not the Phase-2 fix-validator, and watching dispatch
  # runs would double-handle the guardrail's own `force_all` runs.
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --workflow "services-ci.yml" \
      --event push --limit 1 --json databaseId,conclusion \
      --jq '.[0] | "\(.databaseId)\t\(.conclusion)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    LAST=$(cat "$W/trivyrun.txt" 2>/dev/null || true)
    if [ -n "$CONCL" ] && [ "$CONCL" != "null" ]; then
      if [ "$CONCL" = "failure" ] && [ "$RUNID" != "$LAST" ]; then
        echo "TRIVY_RED $RUNID"
      fi
      echo "$RUNID" > "$W/trivyrun.txt"
    fi
  fi

  sleep "$INTERVAL"
done
