#!/usr/bin/env bash
# mm-session-sync.sh — optional SessionStart hook (matcher "startup"): tells
# every NEW session in the repo whether a Merge Monster holds the baton right
# now, and the rules that follow. Stdout is injected into the session's
# starting context.
#
# Must be FAST and never block session start: the one network call is
# timeout-guarded (portable watchdog — macOS ships without coreutils
# `timeout`) and everything fails open (silence beats a hung session).
#
# Usage: mm-session-sync.sh [config]   (default: .claude/merge-monster.yml)
# Reads repo / ledger_issue / stale_lock_minutes from the config; exits
# silently when the config or ledger is absent. Fleet-dir configs: pass the
# absolute path as the argument in the hook command.
CONF="${1:-.claude/merge-monster.yml}"
[ -f "$CONF" ] || exit 0

val() { sed -n "s/^$1:[[:space:]]*\"\{0,1\}\([^\"#[:space:]]*\).*/\1/p" "$CONF" | head -1; }
REPO=$(val repo)
LEDGER=$(val ledger_issue)
STALE=$(val stale_lock_minutes)
case "$STALE" in '' | *[!0-9]*) STALE=45 ;; esac
case "$LEDGER" in '' | 0 | *[!0-9]*) exit 0 ;; esac
[ -n "$REPO" ] || exit 0

BODY=$(
  {
    gh issue view "$LEDGER" -R "$REPO" --json state,body \
      --jq 'if .state == "CLOSED" then "CLOSED" else .body end' &
    GH=$!
    ( sleep 6; kill "$GH" 2>/dev/null ) &
    WD=$!
    wait "$GH" 2>/dev/null
    kill "$WD" 2>/dev/null
  } 2>/dev/null
)

if [ "$BODY" = "CLOSED" ]; then
  echo "🧌 Merge Monster: ledger #$LEDGER is CLOSED (kill switch) — normal manual merge discipline applies."
elif [ -n "$BODY" ]; then
  LAST=$(printf '%s' "$BODY" | sed -n 's/^last: \([0-9TZ:.-]*\).*/\1/p' | head -1)
  NOW_S=$(date -u +%s)
  LAST_S=""
  [ -n "$LAST" ] && LAST_S=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST" +%s 2>/dev/null || date -u -d "$LAST" +%s 2>/dev/null)
  if [ -z "$LAST_S" ]; then
    # Unparseable heartbeat: don't guess in either direction.
    echo "🧌 Merge Monster status UNKNOWN (could not parse the heartbeat on $REPO#$LEDGER) — check that issue before marking PRs ready or merging."
  elif [ $(( (NOW_S - LAST_S) / 60 )) -lt "$STALE" ]; then
    AGE=$(( (NOW_S - LAST_S) / 60 ))
    echo "🧌 Merge Monster is ACTIVE (baton heartbeat ${AGE}m ago, $REPO#$LEDGER). Rules:"
    echo "1. NEVER 'gh pr ready' or 'gh pr merge'. Finish your PR (local review + evidence comment if required, pre-push gate green, threads resolved), leave it DRAFT, add label 'mm:ready' (+ optional <!-- mm-handoff --> comment). The orchestrator pilots ready→CI→merge and reports on your PR."
    echo "2. Never add 'mm:active', never write the orchestrator's state files, never start a second /merge-monster session."
    echo "3. Protocol: the merge-monster enqueue protocol (.claude/workflows/merge-monster-protocol.md or CLAUDE.md § Merge Monster)."
  else
    echo "🧌 Merge Monster baton is STALE (last heartbeat: ${LAST:-unknown}) — manual merge discipline applies until a monster session resumes."
  fi
fi
exit 0
