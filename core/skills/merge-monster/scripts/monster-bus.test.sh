#!/usr/bin/env bash
# monster-bus.test.sh — the monsters' watch buses, ticks, heartbeats and preflight, offline (engsys#122–#126).
# A fake gh answers from canned JSON files in $FAKE/resp (keyed by the subcommand) and logs every call;
# no baton is held, so nothing here reaches GitHub. The lease logic is tested in core/lib/lease.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MNT="$HERE/../../maintenance-monster/scripts"
T="$(cd "$(mktemp -d)" && pwd -P)"
BUSES=()
cleanup() {
  local p
  for p in ${BUSES[@]+"${BUSES[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/bin" "$T/resp" "$T/state"
pass=0 fail=0

# The fake gh: `gh <a> <b> …` prints $FAKE/resp/<a>-<b> when it exists (run through --jq when given,
# as gh does), else nothing. `api rate_limit` (the auth probe) always succeeds.
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
key="${1:-}-${2:-}"
case "$key" in api-rate_limit) echo 5000; exit 0 ;; esac
f="$FAKE/resp/$key"
[ -f "$f" ] || exit 0
jq_expr=""
while [ $# -gt 0 ]; do case "$1" in --jq) jq_expr="$2"; shift 2 ;; *) shift ;; esac; done
if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" FAKE="$T" FLEET_GH="$T/bin/gh" ENGSYS_SESSION=acme-mm ENGSYS_SESSION_RUN=r1
unset FLEET_ID FEDERATION_FILE GH_TOKEN GITHUB_TOKEN GH_APP_ENV_FILE FLEET_INBOX_DIR

ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/       /'; }
run() { : >"$T/gh.log"; RC=0; OUT="$("$@" 2>&1)" || RC=$?; }
rc_is() { [ "$RC" = "$2" ] && ok "$1" || bad "$1 (exit $RC, want $2)" "$OUT"; }
has() { case "$OUT" in *"$2"*) ok "$1" ;; *) bad "$1" "$OUT" ;; esac; }
hasnt() { case "$OUT" in *"$2"*) bad "$1" "$OUT" ;; *) ok "$1" ;; esac; }
count_of() { printf '%s\n' "$OUT" | grep -c -- "$1" || true; }
# bus <seconds> <script> <args…>: run a watch bus for a few seconds, then stop it; OUT = what it printed.
bus() {
  local secs="$1"; shift
  : >"$T/bus.out"; : >"$T/gh.log"
  bash "$@" >"$T/bus.out" 2>&1 &
  local pid=$!; BUSES+=("$pid")
  sleep "$secs"; kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  OUT="$(cat "$T/bus.out")"
}
overdue_row() { # overdue_row <name> <task>: a running registry row whose deadline passed a minute ago
  printf '%s\t1\trunning\t-\t-\trebase\t%s\t%s\t%s\t0\t-\n' "$1" "$2" "$(( $(date +%s) - 120 ))" "$(( $(date +%s) - 60 ))"
}

echo "one watcher per monster (engsys#122)"
overdue_row rebase-12 "PR#12" >"$T/state/agents.tsv"
bus 3 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
has "mm-watch.sh reports an overdue subagent itself (no second Monitor)" "AGENT_OVERDUE rebase-12 gen=1 task=PR#12"
[ "$(count_of AGENT_OVERDUE)" = 1 ] && ok "  …once, across several cycles" || bad "  …once, across several cycles" "$OUT"
rm -rf "$T/state/.watch"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1 --no-agents
hasnt "  …and --no-agents leaves the scan out" "AGENT_OVERDUE"
rm -rf "$T/state/.watch"
overdue_row triage-3 "alert#3" >"$T/state/agents.tsv"
bus 2 "$MNT/mnt-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
has "mnt-watch.sh reports it too" "AGENT_OVERDUE triage-3 gen=1 task=alert#3"
rm -rf "$T/state/.watch" "$T/state/agents.tsv"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
hasnt "no registry → no scan output" "AGENT_"
rm -rf "$T/state/.watch"

echo "single-call ticks (engsys#123)"
pr_json() { # pr_json <number> <mergeStateStatus>
  printf '{"number":%s,"title":"PR %s","author":{"login":"alice"},"isDraft":true,"labels":[{"name":"mm:ready"}],"mergeStateStatus":"%s","mergeable":"MERGEABLE","baseRefName":"main","headRefName":"b%s","createdAt":"2026-10-01T00:00:00Z","additions":1,"deletions":1}' "$1" "$1" "$2" "$1"
}
held() { # held <role>: this launch holds a baton renewed just now (so renew --if-due needs no network)
  printf '{\n  "v": 1,\n  "holder": "alice:acme-mm",\n  "run": "r1",\n  "token": "11111111-1111-4111-8111-111111111111",\n  "deadlineMs": %s,\n  "lastRenewOkMs": %s,\n  "pulseMs": %s,\n  "notBeforeMs": 0\n}\n' \
    "$(( ($(date +%s) + 600) * 1000 ))" "$(( $(date +%s) * 1000 ))" "$(( $(date +%s) * 1000 ))" >"$T/state/baton-$1.json"
}
TICK=(bash "$HERE/mm-tick.sh" --repo acme/app --state-dir "$T/state" --issue 7)
run "${TICK[@]}"
rc_is "no baton in this session → exit 5" 5
has "  …STANDBY, pointing at startup" "STANDBY this session holds no merge baton"
case "$(cat "$T/gh.log")" in "") ok "  …and nothing reached GitHub" ;; *) bad "  …and nothing reached GitHub" "$(cat "$T/gh.log")" ;; esac
held merge; date +%s >"$T/state/.watch/last-heartbeat" 2>/dev/null || { mkdir -p "$T/state/.watch"; date +%s >"$T/state/.watch/last-heartbeat"; }
printf '[%s,%s]\n' "$(pr_json 12 BLOCKED)" "$(pr_json 13 CLEAN)" >"$T/resp/pr-list"
run env FLEET_ID=alice "${TICK[@]}"
rc_is "held, first tick → exit 0" 0
has "  …the delta names each PR (+ lines)" '+ {"number":12'
has "  …both of them" '+ {"number":13'
run env FLEET_ID=alice "${TICK[@]}"
[ "$OUT" = NOOP ] && ok "an unchanged snapshot, no heartbeat due → exactly NOOP" || bad "an unchanged snapshot, no heartbeat due → exactly NOOP" "$OUT"
case "$(cat "$T/gh.log")" in *"issue edit"*) bad "  …and no heartbeat was written" "$(cat "$T/gh.log")" ;; *) ok "  …and no heartbeat was written" ;; esac
[ -s "$T/state/.watch/last-snapshot.sha" ] && ok "  …the snapshot SHA-256 is kept in .watch/last-snapshot.sha" || bad "  …the snapshot SHA-256 is kept in .watch/last-snapshot.sha"
printf '[%s,%s]\n' "$(pr_json 12 CLEAN)" "$(pr_json 13 CLEAN)" >"$T/resp/pr-list"
run env FLEET_ID=alice "${TICK[@]}"
has "a changed PR → its old line…" '- {"number":12,"title":"PR 12","isDraft":true,"mergeStateStatus":"BLOCKED"'
has "  …and its new line" '+ {"number":12,"title":"PR 12","isDraft":true,"mergeStateStatus":"CLEAN"'
hasnt "  …and nothing about the unchanged one" '"number":13'
overdue_row fix-13 "PR#13" >"$T/state/agents.tsv"
run env FLEET_ID=alice "${TICK[@]}"
has "the tick runs the subagent backstop scan" "AGENT_OVERDUE fix-13 gen=1 task=PR#13"
hasnt "  …with no NOOP beside it" "NOOP"
rm -f "$T/state/agents.tsv"
echo $(( $(date +%s) - 3600 )) >"$T/state/.watch/last-heartbeat"
run env FLEET_ID=alice "${TICK[@]}" --heartbeat-minutes 10
# Offline, the heartbeat's own full renew cannot reach GitHub, so a due heartbeat shows as its error.
has "a due heartbeat is attempted by the tick (offline it fails, and says so)" "HEARTBEAT_ERROR"
date +%s >"$T/state/.watch/last-heartbeat"
run env FLEET_ID=alice "${TICK[@]}" --heartbeat-minutes 10
[ "$OUT" = NOOP ] && ok "  …a recent heartbeat is not due: NOOP" || bad "  …a recent heartbeat is not due: NOOP" "$OUT"
. "$HERE/../../../lib/monster.sh"
echo $(( $(date +%s) - 14 * 60 )) >"$T/state/.watch/last-heartbeat"
monster_heartbeat_due "$T/state" 20 && bad "  …due only after 0.75 x heartbeat_minutes (14m of 20 is not)" || ok "  …due only after 0.75 x heartbeat_minutes (14m of 20 is not)"
echo $(( $(date +%s) - 15 * 60 )) >"$T/state/.watch/last-heartbeat"
monster_heartbeat_due "$T/state" 20 && ok "  …15m of 20 is" || bad "  …15m of 20 is"
monster_heartbeat_mark "$T/state"
monster_heartbeat_due "$T/state" 20 && bad "  …and a heartbeat resets it" || ok "  …and a heartbeat resets it"
printf '{"at":"2026-10-04T12:00:00.000Z","code":"lost"}\n' >"$T/state/baton-merge.lost"
run env FLEET_ID=alice "${TICK[@]}"
rc_is "a lost baton → exit 1" 1
has "  …BATON_LOST" "BATON_LOST merge"
rm -rf "$T/state"/baton-* "$T/state/.watch"
held maintain
mkdir -p "$T/state/.watch"; date +%s >"$T/state/.watch/last-heartbeat"
echo '[]' >"$T/resp/pr-list"; echo '[]' >"$T/resp/run-list"
MTICK=(bash "$MNT/mnt-tick.sh" --repo acme/app --state-dir "$T/state" --issue 8)
run env FLEET_ID=alice "${MTICK[@]}"
rc_is "mnt-tick.sh, held → exit 0" 0
has "  …first tick reports the surface" '+ {"k":"codeql_alerts","available":true,"count":0}'
run env FLEET_ID=alice "${MTICK[@]}"
[ "$OUT" = NOOP ] && ok "  …then NOOP" || bad "  …then NOOP" "$OUT"
rm -rf "$T/state"/baton-* "$T/state/.watch" "$T/resp"/*

echo "pulse_max (engsys#123)"
[ "$(monster_pulse_max "" 20)" = 2700s ] && ok "default: 2.25 x heartbeat_minutes (20 → 45m)" || bad "default: 2.25 x heartbeat_minutes" "$(monster_pulse_max "" 20)"
[ "$(monster_pulse_max 45 10)" = 45m ] && ok "a bare number is minutes" || bad "a bare number is minutes" "$(monster_pulse_max 45 10)"
[ "$(monster_pulse_max 1350s 10)" = 1350s ] && ok "a duration passes through" || bad "a duration passes through"
[ "$(monster_pulse_max "" "")" = 20m ] && ok "neither → 20m (the keepalive's own default)" || bad "neither → 20m"
printf 'repo: acme/app\nheartbeat_minutes: 20 # tick\n# pulse_max: 99m\n' >"$T/cfg.yml"
[ "$(monster_cfg_scalar "$T/cfg.yml" heartbeat_minutes)" = 20 ] && ok "the config's heartbeat_minutes is read, comment stripped" || bad "config heartbeat_minutes"
[ -z "$(monster_cfg_scalar "$T/cfg.yml" pulse_max)" ] && ok "a commented-out pulse_max is absent" || bad "commented pulse_max"
echo 'pulse_max: "45m"' >>"$T/cfg.yml"
[ "$(monster_cfg_scalar "$T/cfg.yml" pulse_max)" = 45m ] && ok "a quoted pulse_max is read" || bad "quoted pulse_max"

echo "coalesced watcher events (engsys#124)"
SHA1=1111111111111111111111111111111111111111 SHA2=2222222222222222222222222222222222222222
rollup() { # rollup <sha> <mergeStateStatus> <check json>…
  local sha="$1" mss="$2"; shift 2
  printf '{"headRefOid":"%s","mergeStateStatus":"%s","statusCheckRollup":[%s]}\n' "$sha" "$mss" "$(IFS=,; echo "$*")" >"$T/resp/pr-view"
}
run_() { printf '{"__typename":"CheckRun","name":"%s","status":"%s","conclusion":"%s"}' "$1" "$2" "${3:-}"; }
ctx() { printf '{"__typename":"StatusContext","context":"%s","state":"%s"}' "$1" "$2"; }
echo 12 >"$T/state/active"
rollup "$SHA1" BLOCKED "$(run_ build COMPLETED SUCCESS)" "$(run_ e2e IN_PROGRESS)" "$(run_ lint COMPLETED FAILURE)" "$(ctx deploy/preview ERROR)"
bus 3 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
has "a failed check → CHECK_FAIL #N <name>: <conclusion>" "CHECK_FAIL #12 lint: FAILURE"
has "  …a status context's error too" "CHECK_FAIL #12 deploy/preview: ERROR"
hasnt "  …a success wakes nobody" "build"
[ "$(count_of 'CHECK_FAIL #12 lint')" = 1 ] && ok "  …once, across cycles" || bad "  …once, across cycles" "$OUT"
hasnt "  …no CHECKS_READY while a check is pending and the PR is BLOCKED" "CHECKS_READY"
rollup "$SHA1" BLOCKED "$(run_ build COMPLETED SUCCESS)" "$(run_ e2e COMPLETED SUCCESS)" "$(run_ lint COMPLETED FAILURE)" "$(ctx deploy/preview ERROR)"
bus 3 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
has "pending reaches 0 → CHECKS_READY" "CHECKS_READY #12 head=111111111111 state=BLOCKED pending=0"
[ "$(count_of CHECKS_READY)" = 1 ] && ok "  …exactly once per (PR, head sha)" || bad "  …exactly once per (PR, head sha)" "$OUT"
hasnt "  …and the failures already reported are not repeated" "CHECK_FAIL"
[ -e "$T/state/.watch/ready.12.$SHA1" ] && ok "  …latched in .watch/ready.<pr>.<sha>" || bad "  …latched in .watch/ready.<pr>.<sha>"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
hasnt "a new bus on the same head stays quiet (the latch is on disk)" "CHECKS_READY"
rollup "$SHA2" UNSTABLE "$(run_ build COMPLETED SUCCESS)" "$(run_ e2e IN_PROGRESS)" "$(run_ lint COMPLETED FAILURE)"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
has "a new head: its checks are new (lint fails again)" "CHECK_FAIL #12 lint: FAILURE"
has "  …and UNSTABLE is ready even with a check pending" "CHECKS_READY #12 head=222222222222 state=UNSTABLE pending=1"
rollup "$SHA2" CLEAN
rm -f "$T/state/active"; echo 13 >"$T/state/active"
rollup "0000000000000000000000000000000000000013" BLOCKED
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
hasnt "no checks registered yet on a BLOCKED PR → not ready" "CHECKS_READY"
rm -rf "$T/state/.watch" "$T/state/active" "$T/resp"/*

printf '[{"number":40,"title":"Bump x"}]\n' >"$T/resp/pr-list"
printf 'repo: acme/app\ndependabot:\n  auto_merge: [patch_dev]\n' >"$T/cfg-dep.yml"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1 --config "$T/cfg-dep.yml"
has "auto_merge has categories → DEPENDABOT events" "DEPENDABOT #40"
rm -rf "$T/state/.watch"
printf 'repo: acme/app\ndependabot:\n  auto_merge: [] # the maintenance watchdog owns them\n' >"$T/cfg-dep.yml"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1 --config "$T/cfg-dep.yml"
hasnt "auto_merge empty → --no-dependabot is on by itself" "DEPENDABOT"
grep -q -- '--author app/dependabot' "$T/gh.log" && bad "  …and the poll is not even made" "$(cat "$T/gh.log")" || ok "  …and the poll is not even made"
rm -rf "$T/state/.watch"
bus 2 "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1 --no-dependabot
hasnt "--no-dependabot by hand" "DEPENDABOT"
rm -rf "$T/state/.watch" "$T/resp"/*

echo "context-aware rotation (engsys#125)"
TR="$T/transcript.jsonl"
usage_line() { # usage_line <input> <cache_create> <cache_read> [sidechain]
  printf '{"type":"assistant","isSidechain":%s,"message":{"usage":{"input_tokens":%s,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s,"output_tokens":9}}}\n' "${4:-false}" "$1" "$2" "$3"
}
{ printf 'x%.0s' $(seq 1 70000); echo; usage_line 10 20 30; echo '{"type":"user","message":{}}'; usage_line 1000 2000 397000; usage_line 5 5 5 true; } >"$TR"
[ "$(monster_context_tokens "$TR")" = 400000 ] && ok "usage = input + cache creation + cache read of the last main-thread assistant turn (a subagent's is skipped)" || bad "context tokens" "$(monster_context_tokens "$TR")"
{ usage_line 1 1 1; printf 'y%.0s' $(seq 1 70000); echo; } >"$T/old.jsonl"
[ -z "$(monster_context_tokens "$T/old.jsonl")" ] && ok "  …read from the last 64 KB only" || bad "  …read from the last 64 KB only" "$(monster_context_tokens "$T/old.jsonl")"
SD="$T/rot"; mkdir -p "$SD"
monster_rotation_status "$SD" running 300000 "$TR"
[ "$MONSTER_STATUS" = "rotation requested — ctx 400k" ] && [ "$MONSTER_ROTATION" = 1 ] && ok "over the threshold, nothing active → rotation requested — ctx 400k" || bad "rotation status" "$MONSTER_STATUS"
usage_line 1 1 1 >>"$TR"
monster_rotation_status "$SD" running 300000 "$TR"
[ "$MONSTER_STATUS" = "rotation requested — ctx 400k" ] && ok "  …sticky for that transcript (even after usage drops)" || bad "  …sticky" "$MONSTER_STATUS"
monster_rotation_status "$SD" "session end" 300000 "$TR"
[ "$MONSTER_STATUS" = "session end" ] && ok "  …never replaces session end / handover" || bad "  …session end" "$MONSTER_STATUS"
rm -rf "$SD/.watch"; usage_line 1000 2000 397000 >>"$TR"
echo 12 >"$SD/active"
monster_rotation_status "$SD" running 300000 "$TR"
[ "$MONSTER_STATUS" = running ] && [ "$MONSTER_CTX" = 400000 ] && ok "an active PR holds it off" || bad "active holds off" "$MONSTER_STATUS"
: >"$SD/active"; printf 'fix\t1\trunning\t-\t-\tfix\tPR#1\t0\t9999999999\t0\t-\n' >"$SD/agents.tsv"
monster_rotation_status "$SD" running 300000 "$TR"
[ "$MONSTER_STATUS" = running ] && ok "  …so does a running subagent" || bad "running subagent holds off" "$MONSTER_STATUS"
rm -f "$SD/agents.tsv"
monster_rotation_status "$SD" running 0 "$TR"
[ "$MONSTER_STATUS" = running ] && ok "rotate_context_tokens 0 = off" || bad "0 = off" "$MONSTER_STATUS"
monster_rotation_status "$SD" running 500000 "$TR"
[ "$MONSTER_STATUS" = running ] && ok "under the threshold → status unchanged" || bad "under threshold" "$MONSTER_STATUS"
mkdir -p "$T/sessions"
printf '{"transcript_path":"%s"}\n' "$TR" >"$T/sessions/acme-mm.json"
[ "$(ENGSYS_SESSIONS_DIR="$T/sessions" monster_transcript)" = "$TR" ] && ok "the transcript the SessionStart hook recorded for ENGSYS_SESSION is found" || bad "transcript lookup"
[ -z "$(ENGSYS_SESSIONS_DIR="$T/sessions" ENGSYS_SESSION=other monster_transcript)" ] && ok "  …and only for this session" || bad "  …only this session"
printf '{"transcript_path":"relative.jsonl"}\n' >"$T/sessions/acme-mm.json"
[ -z "$(ENGSYS_SESSIONS_DIR="$T/sessions" monster_transcript)" ] && ok "  …a relative path is refused" || bad "  …relative refused"

echo "preflight comment projection (engsys#126)"
BIG="$(printf 'finding detail %.0s' $(seq 1 2000))"
jq -n --arg big "$BIG" '{isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", baseRefName: "main", body: "Closes #1", files: [], commits: [],
  comments: [
    {author: {login: "alice"}, createdAt: "t1", url: "u1", body: ("<!-- review-findings -->\n## Findings\n" + $big)},
    {author: {login: "bob"}, createdAt: "t2", url: "u2", body: "<!-- mm-handoff -->\ndepends_on: [7]\nmigration: true\n"},
    {author: {login: "carol"}, createdAt: "t3", url: "u3", body: "  <!--  other-bot   v=2 -->\n<!-- second -->\nhi"},
    {author: {login: "dave"}, createdAt: "t4", url: "u4", body: "Thanks!\nFINDING-ACK F1 fixed in abc123\n  FINDING-ACK F2 wontfix: by design"},
    {author: {login: "erin"}, createdAt: "t5", url: "u5", body: "looks good <!-- not-leading -->"},
    {author: {login: "alice"}, createdAt: "t6", url: "u6", body: "<!-- review-findings -->\nround 2"}
  ]}' >"$T/resp/pr-view"
echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t","isResolved":true}]}}}}}' >"$T/resp/api-graphql"
run bash "$HERE/mm-preflight.sh" --repo acme/app --pr 12
rc_is "mm-preflight.sh exits 0" 0
C="$(jq -c .comments <<<"$OUT")"
[ "$(jq -r .count <<<"$C")" = 6 ] && ok "every comment is counted" || bad "every comment is counted" "$C"
[ "$(jq -c .markers <<<"$C")" = '{"<!-- review-findings -->":2,"<!-- mm-handoff -->":1,"<!-- other-bot v=2 -->":1,"<!-- second -->":1}' ] \
  && ok "leading markers are counted by their text, none special-cased (whitespace collapsed)" || bad "marker counts" "$(jq -c .markers <<<"$C")"
[ "$(jq -r .findingAcks <<<"$C")" = 2 ] && ok "FINDING-ACK lines are counted" || bad "FINDING-ACK count" "$C"
[ "$(jq -c '[.items[] | .url]' <<<"$C")" = '["u1","u2","u3","u4","u6"]' ] && ok "items: only comments with a marker or a FINDING-ACK (a mid-body marker does not count)" || bad "items" "$(jq -c '[.items[] | .url]' <<<"$C")"
[ "$(jq -c '.items[] | select(.url == "u4") | .findingAcks' <<<"$C")" = '["FINDING-ACK F1 fixed in abc123","FINDING-ACK F2 wontfix: by design"]' ] && ok "  …each FINDING-ACK line is kept" || bad "acks" "$C"
jq -e '.items[] | select(.url == "u2") | .excerpt | startswith("depends_on: [7]\nmigration: true")' <<<"$C" >/dev/null && ok "  …a marked comment keeps a short excerpt (a handoff block's fields)" || bad "excerpt" "$C"
[ "${#OUT}" -lt 4000 ] && ok "  …and the 30 KB review dump is gone (${#OUT} bytes)" || bad "projection size" "${#OUT}"
[ "$(jq -r '.reviewThreads.nodes | length' <<<"$OUT")" = 1 ] && [ "$(jq -r .mergeStateStatus <<<"$OUT")" = BLOCKED ] && ok "  …the other preflight fields are unchanged" || bad "other fields" "$OUT"
run bash "$HERE/mm-preflight.sh" --repo acme/app --pr 12 --full
[ "$(jq -r '.comments | type' <<<"$OUT")" = array ] && ok "--full keeps the raw comments" || bad "--full" "$(jq -c '.comments | type' <<<"$OUT")"
grep -n 'review-findings\|mm-handoff' "$HERE/mm-preflight.sh" | grep -v '^[0-9]*:#' >/dev/null \
  && bad "no marker name is hardcoded in the script's code" "$(grep -n 'review-findings\|mm-handoff' "$HERE/mm-preflight.sh")" || ok "no marker name is hardcoded in the script's code"
rm -f "$T/resp"/*

echo "monster-bus.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
