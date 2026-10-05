#!/usr/bin/env bash
# fleet-supervisor.test.sh — decision-table tests with fake gh/tmux/launcher (run by `npm test`).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SUP="$HERE/fleet-supervisor.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/w"
pass=0 fail=0

# --- fakes -------------------------------------------------------------------------------------
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
# gh issue view <n> -R <repo> --json state,body  |  gh issue comment <n> -R <repo> --body <text>
case "$1 $2" in
  "issue view") cat "$FAKE/ledger-$3.json" ;;
  "issue comment") echo "comment $3: $7" >>"$FAKE/actions" ;;
esac
SH
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
t=""; for a in "$@"; do [ "${prev:-}" = -t ] && t="$a"; prev="$a"; done
w="${t#*:}"
case "$1" in
  list-panes) [ -f "$FAKE/pane-$w" ] && cat "$FAKE/pane-$w" || exit 1 ;;
  capture-pane) cat "$FAKE/capture-$w" 2>/dev/null || true ;;
  kill-window) echo "kill $w" >>"$FAKE/actions"; rm -f "$FAKE/pane-$w" ;;
esac
SH
cat >"$T/launch.sh" <<'SH'
#!/usr/bin/env bash
# $FAKE/launch-fail present = the launcher fails the way a missing binary does
if [ -f "$FAKE/launch-fail" ]; then echo "attempt $1" >>"$FAKE/actions"; echo "error: claude not found on PATH" >&2; exit 1; fi
echo "launch $1" >>"$FAKE/actions"; echo "2.1.300" >"$FAKE/pane-$1"; : >"$FAKE/capture-$1"
SH
chmod +x "$T/bin/gh" "$T/bin/tmux" "$T/launch.sh"
export PATH="$T/bin:$PATH" FAKE="$T"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" >"$T/w/sup.conf"

iso() { date -u -r "$(( $(date +%s) - $1 * 60 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(( $(date +%s) - $1 * 60 ))" +%Y-%m-%dT%H:%M:%SZ; }
ledger() { # ledger <minutes-ago> <status>
  jq -n --arg b "last: $(iso "$1") — status: $2" '{state:"OPEN", body:$b}' >"$T/ledger-1.json"
}
pane() { case "$1" in exited) echo zsh ;; *) echo "2.1.290" ;; esac >"$T/pane-acme-mm"; [ "$1" = busy ] && echo "✻ Working… (esc to interrupt)" >"$T/capture-acme-mm" || : >"$T/capture-acme-mm"; }
run() { : >"$T/actions"; (cd "$T/w" && bash "$SUP" sup.conf >/dev/null 2>&1); }
expect() { # expect <name> <grep-pattern | !pattern>
  local name="$1" pat="$2" ok
  if [ "${pat#!}" != "$pat" ]; then ! grep -q -- "${pat#!}" "$T/actions" && ok=1 || ok=0; else grep -q -- "$pat" "$T/actions" && ok=1 || ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass + 1)); echo "  ok  $name"; else fail=$((fail + 1)); echo "  FAIL $name"; sed 's/^/       /' "$T/actions"; fi
}
reset() { rm -rf "$T/w/logs" "$T/launch-fail"; }

# --- cases -------------------------------------------------------------------------------------
reset; ledger 10 "rotation requested"; pane idle; run
expect "alive + idle 10m after rotation heartbeat → relaunch" "^launch acme-mm"
expect "  …and says so on the ledger" "comment 1: .*relaunched"
run
expect "next tick: same heartbeat, new session → left alone" "!^launch acme-mm"

reset; ledger 1 "rotation requested"; pane idle; run
expect "alive + rotation 1m ago (grace 3m) → wait" "!^launch"

reset; ledger 10 "rotation requested"; pane busy; run
expect "alive + rotation but mid-turn → wait" "!^launch"

reset; ledger 2 "ok — merging #12"; pane idle; run
expect "alive + fresh ordinary heartbeat → nothing" "!^launch"

reset; ledger 90 "ok — merging #12"; pane idle; run
expect "alive + stale heartbeat → never killed" "!^kill acme-mm"
expect "  …escalated instead" "comment 1: .*stale"

reset; ledger 10 "rotation requested"; pane exited; run
expect "exited + rotation → relaunch (unchanged)" "^launch acme-mm"

reset; ledger 90 "rotation requested"; pane idle; run; run   # same ledger text on the next tick
expect "relaunched session never heartbeats → stale escalation, not another kill" "comment 1: .*stale"
expect "  …and no second relaunch" "!^launch"

reset; ledger 10 "session end"; pane exited; run
expect "exited after session end → left stopped" "!^launch"

reset; ledger 90 "ok — merging #12"; rm -f "$T/pane-acme-mm"; run   # no window at all (tmux server gone): tmux exits non-zero
expect "no window + stale heartbeat → relaunch, the tick is not aborted" "^launch acme-mm"

reset; ledger 90 "ok — merging #12"; pane exited; touch "$T/launch-fail"; run
expect "launcher fails → escalated on the ledger" "comment 1: .*relaunch of .acme-mm. FAILED"
expect "  …with the launcher's own error" "claude not found on PATH"
run
expect "still failing next tick → retried" "^attempt acme-mm"
expect "  …but no second comment" "!comment 1"
rm -f "$T/launch-fail"; run
expect "launcher works again → relaunched" "^launch acme-mm"
expect "  …and the recovery is reported once" "comment 1: .*relaunched after failed attempts since"
ledger 90 "ok — merging #12"; pane exited; run
expect "a later ordinary relaunch → plain relaunch comment, no stale latch" "comment 1: .*fleet-supervisor: relaunched .acme-mm."

# HOST_CHECK_CMD: a session this host doesn't run is never touched, however stale (multi-fleet, #53)
printf '#!/usr/bin/env bash\necho "check $1" >>"$FAKE/actions"; [ -f "$FAKE/host-ok" ]\n' >"$T/check.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nHOST_CHECK_CMD=bash %s/check.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; rm -f "$T/host-ok"; ledger 90 "ok — merging #12"; pane exited; run
expect "host check says no + stale + exited → never relaunched" "!^launch"
expect "  …the check was asked" "^check acme-mm"
expect "  …and nothing posted to a ledger another host owns" "!comment"
reset; ledger 10 "rotation requested"; pane idle; run
expect "host check says no + rotation → not relaunched either" "!^launch"
reset; touch "$T/host-ok"; ledger 90 "ok — merging #12"; pane exited; run
expect "host check says yes → the decision table runs as before" "^launch acme-mm"

# HOST_HEALTH_CMD + NOTIFY_CMD: one alert per incident, no repeat, resolved on recovery (#53)
printf '#!/usr/bin/env bash\n[ -f "$FAKE/healthy" ] && exit 0; echo "registry unreadable: line 3: bad"; exit 1\n' >"$T/health.sh"
printf '#!/usr/bin/env bash\n[ -f "$FAKE/notify-fail" ] && exit 1; echo "notify $*" >>"$FAKE/actions"\n' >"$T/notify.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nHOST_HEALTH_CMD=bash %s/health.sh\nHOST_HEALTH_INCIDENT=fleet-registry-unreadable\nNOTIFY_CMD=bash %s/notify.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" "$T" >"$T/w/sup.conf"
reset; rm -f "$T/healthy" "$T/notify-fail"; ledger 2 "ok — merging #12"; pane idle; run
expect "unhealthy host → one alert" "^notify --level alert --incident fleet-registry-unreadable registry unreadable: line 3: bad"
run
expect "still unhealthy next tick → no repeat" "!^notify"
touch "$T/healthy"; run
expect "healthy again → resolved" "^notify --level info --incident fleet-registry-unreadable --resolve"
run
expect "  …once" "!^notify"
reset; rm -f "$T/healthy"; touch "$T/notify-fail"; ledger 90 "ok — merging #12"; pane exited; run
expect "notify fails → nothing posted, the tick goes on (soft)" "!^notify"
expect "  …and the sessions are still handled" "^launch acme-mm"
rm -f "$T/notify-fail"; run
expect "  …the alert is retried next tick" "^notify --level alert"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nHOST_HEALTH_CMD=bash %s/health.sh\nNOTIFY_CMD=bash %s/notify.sh\nREPO=o/r\n' "$T" "$T" "$T" >"$T/w/sup.conf"
reset; run
expect "no sessions at all: the alert still goes out" "^notify --level alert --incident host-health"

# HEARTBEAT_CMD: once per tick, after classification, with a summary of up/rotating/down; soft on
# failure (#58, follow-up to #40/#57 — the status-issue heartbeat cross-fleet claiming reads).
cat >"$T/heartbeat.sh" <<'SH'
#!/usr/bin/env bash
if [ -f "$FAKE/heartbeat-fail" ]; then echo "heartbeat-attempt $*" >>"$FAKE/actions"; exit 1; fi
echo "heartbeat $*" >>"$FAKE/actions"
SH
chmod +x "$T/heartbeat.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nHEARTBEAT_CMD=bash %s/heartbeat.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"

reset; ledger 2 "ok — merging #12"; pane idle; run
expect "alive + fresh heartbeat → heartbeat written once" "^heartbeat sessions: 1 up, 0 rotating, 0 down"
run
expect "  …same tick-minute, not written again" "!^heartbeat"

reset; ledger 90 "ok — merging #12"; pane exited; run
expect "crash recovery → counted as down in the summary" "^heartbeat sessions: 0 up, 0 rotating, 1 down"

reset; ledger 10 "rotation requested"; pane idle; run
expect "rotation in progress → counted as rotating" "^heartbeat sessions: 0 up, 1 rotating, 0 down"

reset; ledger 2 "ok — merging #12"; pane idle; touch "$T/heartbeat-fail"; run
expect "HEARTBEAT_CMD fails → attempted" "^heartbeat-attempt"
expect "  …but soft: the tick is not aborted" "!^launch"
rm -f "$T/heartbeat-fail"

printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" >"$T/w/sup.conf"
reset; ledger 90 "ok — merging #12"; pane exited; run
expect "HEARTBEAT_CMD unset → never called, the tick still runs" "!^heartbeat"
expect "  …and the session is still relaunched" "^launch acme-mm"

# A 5th field (marker): one status issue carries several heartbeats; only the named block counts (#54)
status() { # status <fleet-heartbeat minutes-ago> <broker minutes-ago|none> <broker status>
  local b
  b="Fleet status.

<!-- fleet-heartbeat -->
last: $(iso "$1") — status: 3 up
<!-- /fleet-heartbeat -->"
  [ "$2" = none ] || b="$b

<!-- broker-heartbeat -->
last: $(iso "$2") — status: $3
<!-- /broker-heartbeat -->"
  jq -n --arg b "$b" '{state:"OPEN", body:$b}' >"$T/ledger-30.json"
}
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-broker|30|60|o/fleet|broker-heartbeat\n' "$T" >"$T/w/sup.conf"
bpane() { case "$1" in exited) echo zsh ;; *) echo "2.1.290" ;; esac >"$T/pane-acme-broker"; : >"$T/capture-acme-broker"; }
reset; status 1 90 "working"; bpane exited; run
expect "marker: a fresh fleet-heartbeat never stands in for a stale broker block" "^launch acme-broker"
reset; status 90 2 "working"; bpane exited; run
expect "marker: a fresh broker block counts, whatever the fleet-heartbeat says" "!^launch"
reset; status 1 none ""; bpane exited; run
expect "marker: no broker block yet reads as never heartbeated (stale)" "^launch acme-broker"
reset; status 1 10 "rotation requested"; bpane idle; run
expect "marker: the rotation request is read from the broker block" "^launch acme-broker"
reset; status 1 10 "session end"; bpane exited; run
expect "marker: session end in the broker block leaves it stopped" "!^launch"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-broker|30|60|o/fleet|Bad Marker\n' "$T" >"$T/w/sup.conf"
reset; status 1 90 "working"; bpane exited; run
expect "marker: an invalid marker skips the line" "!^launch"

# A 6th field (merge|maintain): a singleton monster; every relaunch also needs the lease to allow it
# (engsys#62). The fake BATON_CMD answers from $FAKE/baton (free | expired | held_self | held_elsewhere |
# not_home | error) and records each call.
cat >"$T/baton.sh" <<'SH'
#!/usr/bin/env bash
echo "baton $*" >>"$FAKE/actions"
code="$(cat "$FAKE/baton")"
case "$code" in
  free | expired | malformed) echo "{\"relaunch\":true,\"code\":\"$code\",\"reason\":\"ok\"}"; exit 0 ;;
  held_self | held_elsewhere | not_home) echo "{\"relaunch\":false,\"code\":\"$code\",\"reason\":\"held by bob:acme-mm\"}"; exit 1 ;;
  *) echo "{\"relaunch\":false,\"code\":\"error\",\"reason\":\"baton unreadable: 502\"}"; exit 3 ;;
esac
SH
chmod +x "$T/baton.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nNOTIFY_CMD=bash %s/notify.sh\nREPO=o/r\nacme-mm|1|60|||merge\n' "$T" "$T" "$T" >"$T/w/sup.conf"
baton() { echo "$1" >"$T/baton"; }

reset; baton free; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: crash recovery asks the lease with repo, role and session" "^baton --repo o/r --role merge --session acme-mm"
expect "  …free → relaunched" "^launch acme-mm"
reset; baton expired; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: expired → relaunched" "^launch acme-mm"
reset; baton held_elsewhere; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: another fleet holds a live baton → never relaunched" "!^launch"
reset; baton held_self; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: this session's own unexpired baton → wait for it to expire" "!^launch"
reset; baton not_home; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: not home → never relaunched" "!^launch"

reset; rm -f "$T/notify-fail"; baton error; ledger 90 "ok — merging #12"; pane exited; run
expect "baton: lease read error → no relaunch (fail closed)" "!^launch"
expect "  …one alert" "^notify --level alert --incident baton-read-acme-mm"
run
expect "  …not repeated next tick" "!^notify"
expect "  …still no relaunch" "!^launch"
baton free; run
expect "  …reads clean again → resolved" "^notify --level info --incident baton-read-acme-mm --resolve"
expect "  …and relaunched" "^launch acme-mm"

reset; baton free; ledger 2 "handover to bob — digest posted"; pane exited; run
expect "baton: 'handover' heartbeat + exited + free → relaunched (fresh heartbeat is the old home's)" "^launch acme-mm"
reset; baton held_elsewhere; ledger 2 "handover to bob"; pane exited; run
expect "baton: handover but the old home still holds → wait" "!^launch"
reset; baton free; ledger 2 "ok — merging #12"; pane exited; run
expect "baton: fresh ordinary heartbeat + exited → grace, lease not even asked" "!^baton"
reset; baton free; ledger 10 "session end"; pane exited; run
expect "baton: session end stays a deliberate stop" "!^launch"

reset; baton held_self; ledger 10 "rotation requested"; pane idle; run
expect "baton: rotation + idle but the baton is still held → wait" "!^launch"
baton free; run
expect "  …released → relaunched" "^launch acme-mm"

reset; baton expired; ledger 90 "ok — merging #12"; pane idle; run
expect "baton: stale + alive + idle + forfeited baton → relaunched" "^launch acme-mm"
reset; baton expired; ledger 90 "ok — merging #12"; pane busy; run
expect "baton: stale + alive but mid-turn → never killed" "!^launch"
expect "  …escalated instead" "comment 1: .*stale"
reset; baton held_self; ledger 90 "ok — merging #12"; pane idle; run
expect "baton: stale + idle but its baton is still live → escalate, not relaunch" "!^launch"

printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; baton held_elsewhere; ledger 90 "ok — merging #12"; pane exited; run
expect "no 6th field → the lease is never consulted" "!^baton"
expect "  …and the table runs as before" "^launch acme-mm"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nREPO=o/r\nacme-mm|1|60|||deploy\n' "$T" "$T" >"$T/w/sup.conf"
reset; baton free; ledger 90 "ok — merging #12"; pane exited; run
expect "an unknown 6th field skips the line" "!^launch"

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
