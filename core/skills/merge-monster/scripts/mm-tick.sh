#!/usr/bin/env bash
# mm-tick.sh — Merge Monster's fallback tick in ONE call (engsys#123). Run it on every ScheduleWakeup
# tick instead of separate renew / snapshot / scan / heartbeat calls. In order:
#   1. renew the baton if it is due (`baton.mjs renew --if-due`, which also records the model's pulse
#      for the keepalive);
#   2. snapshot the open PRs (mm-snapshot.sh) and compare its SHA-256 with <state-dir>/.watch/last-snapshot.sha;
#   3. run the subagent watchdog's scan once (mm-agent-watch.sh --once), the backstop for a dead bus;
#   4. write the ledger heartbeat only when one is due (none in the last 0.75 x heartbeat_minutes);
#   5. print `NOOP` when nothing changed, else the delta, one line each:
#        + <item> / - <item>          a PR appeared in / left the snapshot, or changed (one of each); for a
#                                     PR parked mm:blocked, a {"k":"gate",…} line whose comment / review
#                                     counts moved means: run gate-check for it
#        VERDICT_WAKE #N <cause> head=<sha12>  engsys#241: the security-verdict backstop re-ran mm-preflight.sh for a PR
#                                     that carries the review request label or was parked waiting on a verdict, and
#                                     its outcome moved: preflight_pass (the verdict landed: continue, and re-check an
#                                     existing gate request for this head), preflight_fail:<reason> (handle as any
#                                     preflight failure), label_removed_no_verdict (the label is gone but no valid
#                                     verdict is there: request the review again). Once per outcome and head.
#        AGENT_OVERDUE … / AGENT_STALE …   from the watchdog scan
#        HANDBACK_INCOMPLETE …             a subagent handed back unfinished work: resume it or take it over
#        BATON_HANDOVER merge <fleet>      federation.yml moved the role's home (§ Handover)
#        SNAPSHOT_ERROR <why>              the snapshot failed: GitHub state is unknown this tick
#        HEARTBEAT_ERROR <why>             the heartbeat was due and failed
#        ROTATION_REQUESTED …              context is past rotate_context_tokens with nothing active:
#                                          rotate (§ Context discipline)
#        BATON_RENEW_ERROR merge <why>     the renew failed (the fences refuse once the deadline passes)
# NOOP means: nothing to act on, so no state.md rewrite and no journal line this wake.
#
# Exit: 0 (NOOP or a delta) | 1 BATON_LOST: stop all mutations now (§ Lost baton) | 5 this session holds no
# merge baton (standby: run mm-baton.sh startup) | 2 usage.
#
# Usage: mm-tick.sh --repo owner/name --state-dir DIR --issue N
#                   [--config FILE] [--heartbeat-minutes 10] [--status "running"] [--session NAME]
#                   [--stale-min 10] [--no-stale] [--if-due 150s]
#   --config             the monster's yml: heartbeat_minutes and rotate_context_tokens from it when the
#                        flags are absent
#   --rotate-context-tokens  passed to the heartbeat (engsys#125): over it with nothing active, the heartbeat
#                        status becomes `rotation requested — ctx <N>k` and ROTATION_REQUESTED is a delta line
#   --heartbeat-minutes  the tick cadence; a heartbeat is due after 0.75 x this (default 10)
#   The verdict backstop watches the review label preflight names (core/lib/security-sensitive.mjs review-label over the
#   discovered merge configs plus --config; default security-review-requested), reads
#   ready_requirements.security_verdict_key_file from --config, and hands --config to mm-preflight.sh (which can only
#   add requirements from it). MM_PREFLIGHT overrides the preflight script (tests point it at a stub).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../lib/fleet-gh.sh
. "$here/../../../lib/fleet-gh.sh"
fleet_gh_resolve
# shellcheck source=../../../lib/monster.sh
. "$here/../../../lib/monster.sh"

REPO="" DIR="" ISSUE="" CONFIG="" HB_MIN="" STATUS="running" SESSION="" STALE_MIN=10 NOSTALE="" IF_DUE=150s ROTATE=""
usage() { echo "usage: mm-tick.sh --repo owner/name --state-dir DIR --issue N [--config FILE] [--heartbeat-minutes M] [--status text] [--session NAME] [--stale-min N] [--no-stale] [--if-due 150s]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || usage; DIR="$2"; shift 2 ;;
    --state-dir=*) DIR="${1#--state-dir=}"; shift ;;
    --issue) [ $# -ge 2 ] || usage; ISSUE="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --heartbeat-minutes) [ $# -ge 2 ] || usage; HB_MIN="$2"; shift 2 ;;
    --status) [ $# -ge 2 ] || usage; STATUS="$2"; shift 2 ;;
    --session) [ $# -ge 2 ] || usage; SESSION="$2"; shift 2 ;;
    --stale-min) [ $# -ge 2 ] || usage; STALE_MIN="$2"; shift 2 ;;
    --no-stale) NOSTALE=1; shift ;;
    --if-due) [ $# -ge 2 ] || usage; IF_DUE="$2"; shift 2 ;;
    --rotate-context-tokens) [ $# -ge 2 ] || usage; ROTATE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
[ -n "$REPO" ] && [ -n "$DIR" ] && [ -n "$ISSUE" ] || usage
[ -n "$HB_MIN" ] || HB_MIN="$(monster_cfg_scalar "$CONFIG" heartbeat_minutes)"
case "$HB_MIN" in '' | 0 | *[!0-9]*) HB_MIN=10 ;; esac
[ -n "$ROTATE" ] || ROTATE="$(monster_cfg_scalar "$CONFIG" rotate_context_tokens)"
ROTATE_OUT="$(monster_rotate_tokens "$ROTATE")"
ROTATE="${ROTATE_OUT%%$'\t'*}" ROTATE_WARN="${ROTATE_OUT#*$'\t'}"
W="$DIR/.watch"
mkdir -p "$W"
DELTA=()
if [ -n "$ROTATE_WARN" ] && [ ! -f "$W/rotate-warn.said" ]; then
  DELTA+=("CONFIG_WARNING ${ROTATE_WARN:0:280}")
  : >"$W/rotate-warn.said"
fi
HB_DUE=0
monster_heartbeat_due "$DIR" "$HB_MIN" && HB_DUE=1

# 1. renew when due (pulse only when the heartbeat is already fresh; when due, the heartbeat pulses after it writes, #138)
PULSE_FLAG="--pulse"
[ "$HB_DUE" = 0 ] || PULSE_FLAG=""
RC=0
OUT=$(node "$here/../../../lib/lease/baton.mjs" renew $PULSE_FLAG --role merge --repo "$REPO" --state-dir "$DIR" \
  --if-due "$IF_DUE" ${SESSION:+--session "$SESSION"} 2>&1) || RC=$?
case "$RC" in
  0) if printf '%s' "$OUT" | jq -e '.handover' >/dev/null 2>&1; then
       DELTA+=("BATON_HANDOVER merge $(printf '%s' "$OUT" | jq -r '.handover.home // "none"')")
     fi ;;
  1) echo "BATON_LOST merge: stop all mutations now (§ Lost baton): $(printf '%s' "$OUT" | head -c 300)"; exit 1 ;;
  5) echo "STANDBY this session holds no merge baton: run mm-baton.sh startup on this tick"; exit 5 ;;
  *) DELTA+=("BATON_RENEW_ERROR merge $(printf '%s' "$OUT" | tr '\n' ' ' | head -c 200)") ;;
esac

# 2. snapshot delta --------------------------------------------------------------------------------
# Open operator gates (engsys#126 review): an approval is a comment or a review, which neither the bus nor
# the PR snapshot sees. For each PR parked `mm:blocked`, the snapshot also carries its comment and review
# counts and newest review state, so a new /approve, review or reply on it is a delta line
# ({"k":"gate","pr":N,…}) and the model runs gate-check on it; an untouched gate stays NOOP.
gate_lines() {
  local n
  for n in $(printf '%s' "$SNAP" | jq -r '.[] | select((.mm // []) | index("mm:blocked")) | .number' 2>/dev/null); do
    case "$n" in '' | *[!0-9]*) continue ;; esac
    # totalCount, not the length of a fetched list (gh caps that at 100), plus the newest comment's id
    "$FLEET_GH" api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F number="$n" -f query='
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          headRefOid
          comments(last: 1) { totalCount nodes { id } }
          reviews(last: 1) { totalCount nodes { state } } } } }' \
      --jq ".data.repository.pullRequest | {k: \"gate\", pr: $n, head: .headRefOid, comments: .comments.totalCount, lastComment: (.comments.nodes[0].id // null), reviews: .reviews.totalCount, lastReview: (.reviews.nodes[0].state // null)}" 2>/dev/null \
      || printf '{"k":"gate","pr":%s,"error":"unreadable"}\n' "$n"
  done
}
# the label preflight names (the same discovery, --config as one more source; engsys#231)
REVIEW_LABEL="$(node "$here/../../../lib/security-sensitive.mjs" review-label --repo "$REPO" ${CONFIG:+--config "$CONFIG"} 2>/dev/null)" || REVIEW_LABEL=""
[ -n "$REVIEW_LABEL" ] || REVIEW_LABEL=security-review-requested
SNAP_OK=0
if SNAP=$(bash "$here/mm-snapshot.sh" --repo "$REPO" --review-label "$REVIEW_LABEL" 2>&1); then
  SNAP_OK=1
  while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done < <({ printf '%s' "$SNAP" | monster_snapshot_lines; gate_lines | jq -c . 2>/dev/null; } | monster_delta "$W")
else
  DELTA+=("SNAPSHOT_ERROR $(printf '%s' "$SNAP" | tr '\n' ' ' | head -c 200)")
fi

# 2b. security-verdict backstop (engsys#241) ------------------------------------------------------------
# A verdict arrives as a PR comment plus the removal of a non-mm: label, which the snapshot delta alone reports late or
# not at all. So, whatever the deltas, every tick re-runs mm-preflight.sh for each PR that carries the review request
# label, or was parked waiting on a verdict (remembered in .watch/verdict-wait while preflight keeps answering exit 3 and
# the PR keeps an mm: label),
# and reports a VERDICT_WAKE line when the outcome moved (latched per PR in .watch/verdict.<N>: outcome and head), so
# an unchanged wait stays NOOP. It only wakes the model; the model's own preflight still decides.
PREFLIGHT="${MM_PREFLIGHT:-$here/mm-preflight.sh}"
KEY_FILE="$(monster_cfg_child "$CONFIG" ready_requirements security_verdict_key_file)"
verdict_lines() {
  local n rc out err head key why labeled wait_new="$W/verdict-wait.new" open cands f
  : >"$wait_new"
  open=$(printf '%s' "$SNAP" | jq -r '.[].number' 2>/dev/null | sort -u)
  cands=$( { printf '%s' "$SNAP" | jq -r '.[] | select(.securityReview == true) | .number' 2>/dev/null
             cat "$W/verdict-wait" 2>/dev/null || true; } | sort -un)
  # a latch outlives neither the label nor the wait: a PR asked again later is judged afresh
  for f in "$W"/verdict.[0-9]*; do
    [ -f "$f" ] || continue
    printf '%s\n' "$cands" | grep -qx "${f##*.}" || rm -f "$f"
  done
  for n in $cands; do
    case "$n" in '' | *[!0-9]*) continue ;; esac
    printf '%s\n' "$open" | grep -qx "$n" || { rm -f "$W/verdict.$n"; continue; } # closed or merged: forget it
    labeled=$(printf '%s' "$SNAP" | jq -r --argjson n "$n" '[.[] | select(.number == $n and .securityReview == true)] | length' 2>/dev/null)
    # a remembered PR that left the pipeline (no mm: label: bounced, or withdrawn) is no longer parked
    if [ "$labeled" = 0 ] && [ "$(printf '%s' "$SNAP" | jq -r --argjson n "$n" '[.[] | select(.number == $n) | (.mm // [])[]] | length' 2>/dev/null)" = 0 ]; then
      rm -f "$W/verdict.$n"; continue
    fi
    rc=0
    out=$(bash "$PREFLIGHT" --repo "$REPO" --pr "$n" ${CONFIG:+--config "$CONFIG"} ${KEY_FILE:+--security-key-file "$KEY_FILE"} 2>"$W/verdict.err") || rc=$?
    err=$(tail -n 1 "$W/verdict.err" 2>/dev/null || true)
    head=$(printf '%s' "$out" | jq -r '.headRefOid // empty' 2>/dev/null | head -c 12)
    [ -n "$head" ] || head=$(printf '%s' "$err" | jq -r '.head // empty' 2>/dev/null | head -c 12)
    case "$rc" in
      3) printf '%s\n' "$n" >>"$wait_new"
         if [ "$labeled" = 0 ]; then key="label_removed_no_verdict"; else rm -f "$W/verdict.$n"; continue; fi ;;
      0) key="preflight_pass" ;;
      *) why=$(printf '%s' "$err" | jq -r '.reason // empty' 2>/dev/null | cut -d: -f1 | tr -c 'A-Za-z0-9_\n-' '_' | head -c 60)
         key="preflight_fail:${why:-exit_$rc}" ;;
    esac
    [ "$(cat "$W/verdict.$n" 2>/dev/null || true)" != "$key ${head:--}" ] || continue
    printf '%s %s\n' "$key" "${head:--}" >"$W/verdict.$n"
    printf 'VERDICT_WAKE #%s %s head=%s\n' "$n" "$key" "${head:--}"
  done
  mv "$wait_new" "$W/verdict-wait"
}
if [ "$SNAP_OK" = 1 ]; then
  while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done < <(verdict_lines)
fi

# 3. subagent backstop scan ------------------------------------------------------------------------
if [ -f "$DIR/agents.tsv" ]; then
  while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done < <(bash "$here/mm-agent-watch.sh" --state-dir "$DIR" --once \
    --stale-min "$STALE_MIN" ${NOSTALE:+--no-stale} 2>>"$W/agent-watch.err" || true)
fi

# 3c. INCOMPLETE hand-backs the bus has not relayed (engsys#126 review) ----------------------------
while IFS= read -r l; do [ -n "$l" ] && DELTA+=("$l"); done < <(monster_handback_events "$DIR")

# 4. heartbeat when due ----------------------------------------------------------------------------
if monster_heartbeat_due "$DIR" "$HB_MIN"; then
  RC=0
  HB=$(bash "$here/mm-heartbeat.sh" --repo "$REPO" --issue "$ISSUE" --state-dir "$DIR" --status "$STATUS" \
    --rotate-context-tokens "$ROTATE" ${SESSION:+--session "$SESSION"} 2>&1) || RC=$?
  case "$RC" in
    0) while IFS= read -r l; do case "$l" in heartbeat:* | '') ;; *) DELTA+=("$l") ;; esac; done <<<"$HB" ;;
    1) printf '%s\n' "$HB"; exit 1 ;;
    5) echo "STANDBY $(printf '%s' "$HB" | head -c 200)"; exit 5 ;;
    *) DELTA+=("HEARTBEAT_ERROR $(printf '%s' "$HB" | tr '\n' ' ' | head -c 200)") ;;
  esac
fi

# 5. NOOP or the delta -----------------------------------------------------------------------------
if [ "${#DELTA[@]}" -eq 0 ]; then echo NOOP; else printf '%s\n' "${DELTA[@]}"; fi
