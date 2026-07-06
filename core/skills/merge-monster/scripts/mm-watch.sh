#!/usr/bin/env bash
# mm-watch.sh — Merge Monster event bus. Designed to run under a persistent
# Monitor: polls GitHub in a shell loop and emits ONE LINE PER STATE CHANGE,
# so the model sleeps free between events and wakes within one interval.
#
# Events:
#   READY #N <title>       PR gained the mm:ready label
#   UNREADY #N             PR lost the mm:ready label (before being queued)
#   CHECK #N <name>: <s>   check on the ACTIVE PR reached a terminal state
#   CONFLICT #N            a queued/ready PR turned DIRTY (needs rebase)
#   DEPENDABOT #N <title>  new Dependabot PR opened
#   MAIN_RED <workflow>    latest default-branch run concluded failure
#   STOP                   ledger issue closed (kill switch) — script exits
#
# The active PR number is read each cycle from <state-dir>/active, so one
# persistent monitor serves the whole session.
#
# Usage: mm-watch.sh --repo owner/name --state-dir DIR [--interval 30]
#                    [--default-branch main] [--ledger N]
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
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "usage: mm-watch.sh --repo owner/name --state-dir DIR" >&2; exit 2; }

W="$DIR/.watch"
mkdir -p "$W"
touch "$W/ready.tsv" "$W/deps.tsv" "$W/dirty.tsv" "$W/checks.tsv" "$W/mainrun.txt"

# emit_diff <old-file> <new-file> <added-prefix> [removed-prefix]
# Files are sorted "key<TAB>rest" lines; prints one event line per delta.
emit_diff() {
  old="$1"; new="$2"; addp="$3"; remp="${4:-}"
  comm -13 "$old" "$new" | while IFS= read -r line; do
    [ -n "$line" ] && echo "$addp $line"
  done
  if [ -n "$remp" ]; then
    comm -23 "$old" "$new" | while IFS= read -r line; do
      [ -n "$line" ] && echo "$remp $(echo "$line" | cut -f1)"
    done
  fi
  mv "$new" "$old"
}

while true; do
  # --- kill switch: ledger issue closed → STOP and exit -------------------
  if [ -n "$LEDGER" ]; then
    STATE=$(gh issue view "$LEDGER" -R "$REPO" --json state --jq .state 2>/dev/null || echo "")
    if [ "$STATE" = "CLOSED" ]; then echo "STOP"; exit 0; fi
  fi

  # --- new / withdrawn mm:ready PRs ---------------------------------------
  if OUT=$(gh pr list -R "$REPO" --label mm:ready --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/ready.new"
    emit_diff "$W/ready.tsv" "$W/ready.new" "READY" "UNREADY"
  fi

  # --- new Dependabot PRs ---------------------------------------------------
  if OUT=$(gh pr list -R "$REPO" --author "app/dependabot" --json number,title \
      --jq '.[] | "#\(.number)\t\(.title)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/deps.new"
    emit_diff "$W/deps.tsv" "$W/deps.new" "DEPENDABOT"
  fi

  # --- queued/ready PRs turning DIRTY (conflict) ----------------------------
  if OUT=$(gh pr list -R "$REPO" --json number,labels,mergeStateStatus \
      --jq '.[] | select((.labels | map(.name) | any(. == "mm:ready" or . == "mm:queued" or . == "mm:active"))
                  and .mergeStateStatus == "DIRTY") | "#\(.number)"' 2>/dev/null); then
    printf '%s\n' "$OUT" | sed '/^$/d' | sort > "$W/dirty.new"
    emit_diff "$W/dirty.tsv" "$W/dirty.new" "CONFLICT"
  fi

  # --- terminal check states on the ACTIVE PR -------------------------------
  ACTIVE=$(cat "$DIR/active" 2>/dev/null || true)
  if [ -n "$ACTIVE" ]; then
    if OUT=$(gh pr view "$ACTIVE" -R "$REPO" --json statusCheckRollup --jq '
        .statusCheckRollup[]?
        | if .__typename == "CheckRun"
          then select(.status == "COMPLETED") | "\(.name)\t\(.conclusion)"
          else select(.state != "PENDING" and .state != "EXPECTED") | "\(.context)\t\(.state)"
          end' 2>/dev/null); then
      printf '%s\n' "$OUT" | sed '/^$/d' | sort -u > "$W/checks.new"
      comm -13 "$W/checks.tsv" "$W/checks.new" | while IFS="$(printf '\t')" read -r name state; do
        [ -n "$name" ] && echo "CHECK #$ACTIVE $name: $state"
      done
      mv "$W/checks.new" "$W/checks.tsv"
    fi
  else
    : > "$W/checks.tsv"   # no active PR → clear so the next one diffs fresh
  fi

  # --- default branch went red ----------------------------------------------
  if OUT=$(gh run list -R "$REPO" --branch "$DEFBRANCH" --limit 1 \
      --json databaseId,conclusion,workflowName \
      --jq '.[0] | "\(.databaseId)\t\(.conclusion)\t\(.workflowName)"' 2>/dev/null); then
    RUNID=$(echo "$OUT" | cut -f1)
    CONCL=$(echo "$OUT" | cut -f2)
    WF=$(echo "$OUT" | cut -f3)
    LAST=$(cat "$W/mainrun.txt" 2>/dev/null || true)
    if [ "$CONCL" = "failure" ] && [ "$RUNID" != "$LAST" ]; then
      echo "MAIN_RED $WF"
    fi
    echo "$RUNID" > "$W/mainrun.txt"
  fi

  sleep "$INTERVAL"
done
