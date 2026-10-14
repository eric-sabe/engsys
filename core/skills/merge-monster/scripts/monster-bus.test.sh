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

echo "monster-bus.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
