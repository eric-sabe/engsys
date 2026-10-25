#!/usr/bin/env bash
# fleet-supervisor.test.sh — decision-table tests with fake gh/tmux/launcher (run by `npm test`).
set -euo pipefail
unset OPERATOR_TIMEZONE OPERATOR_CLOCK
export SUPERVISOR_NOW_MINUTE="2026-10-15T12:00"
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
# one pane per window; the pane id is "%<window>", and a target is "<session>:<window>" or a pane id
t=""; all=0; for a in "$@"; do [ "${prev:-}" = -t ] && t="$a"; [ "$a" = -s ] && all=1; prev="$a"; done
w="${t#*:}"; w="${w#%}"
case "$1" in
  list-panes)
    if [ "$all" = 1 ]; then # list-panes -s -t <session> -F '#{window_name}|#{pane_id}|#{pane_current_command}'
      for f in "$FAKE"/pane-*; do [ -f "$f" ] && printf '%s|%%%s|%s\n' "${f##*/pane-}" "${f##*/pane-}" "$(cat "$f")"; done; exit 0
    fi
    [ -f "$FAKE/pane-$w" ] || exit 1
    case "$*" in *pane_id*) echo "%$w" ;; *) cat "$FAKE/pane-$w" ;; esac ;;
  capture-pane) cat "$FAKE/capture-$w" 2>/dev/null || true ;;
  kill-window) echo "kill $w" >>"$FAKE/actions"; rm -f "$FAKE/pane-$w" ;;
  send-keys) shift; shift; shift; shift; echo "sendkeys $w $*" >>"$FAKE/actions" ;;
esac
SH
cat >"$T/launch.sh" <<'SH'
#!/usr/bin/env bash
# $FAKE/launch-fail present = the launcher fails the way a missing binary does
if [ -f "$FAKE/launch-fail" ]; then echo "attempt $1" >>"$FAKE/actions"; echo "error: claude not found on PATH" >&2; exit 1; fi
# $FAKE/auth-expired present = the new session answers its first prompt the way it did on 2026-10-06
echo "launch $1" >>"$FAKE/actions"; echo "2.1.300" >"$FAKE/pane-$1"
if [ -f "$FAKE/auth-expired" ]; then cp "$FAKE/fixture-login-expired" "$FAKE/capture-$1"; else printf '⏺ Reading the ledger first.\n' >"$FAKE/capture-$1"; fi
SH
# the test request (`claude -p`, AUTH_PROBE): $FAKE/probe-ok present = the login works
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "probe $*" >>"$FAKE/actions"
echo "probe-cfg ${CLAUDE_CONFIG_DIR:-unset}" >>"$FAKE/actions"
if [ -f "$FAKE/probe-ok" ]; then echo OK; exit 0; fi
echo "Login expired · Please run /login"; exit 1
SH
chmod +x "$T/bin/gh" "$T/bin/tmux" "$T/bin/claude" "$T/launch.sh"
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

# A moved ledger target (engsys#72): launched against issue 1, the conf now says the status-issue block
# (30). A session still on the old version posts `rotation requested` on 1, which is no longer read.
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-broker|30|60|o/fleet|broker-heartbeat\n' "$T" >"$T/w/sup.conf"
oldledger() { # oldledger <minutes-ago> <status> — the per-repo ledger the session was launched against
  jq -n --arg b "last: $(iso "$1") — status: $2" '{state:"OPEN", body:$b}' >"$T/ledger-1.json"
}
moved() { # moved <launch minutes-ago> — a recorded launch against the old target
  mkdir -p "$T/w/logs/fleet-supervisor"
  printf 'o/r|1||%s\n' "$(( $(date +%s) - $1 * 60 ))" >"$T/w/logs/fleet-supervisor/acme-broker.target"
}
reset; status 1 2 "adopted by resource broker"; oldledger 10 "rotation requested"; moved 60; bpane idle; run
expect "moved target: rotation request on the OLD target, newer than launch → relaunch" "^launch acme-broker"
expect "  …and the relaunch is announced on the NEW target" "comment 30: .*relaunched"
oldledger 10 "rotation requested"; run
expect "  …the new launch is recorded, so the old target is no longer read" "!^launch"

reset; status 1 2 "adopted by resource broker"; oldledger 90 "rotation requested"; moved 60; bpane idle; run
expect "moved target: rotation request on the old target older than the launch → ignored" "!^launch"

reset; status 1 2 "adopted by resource broker"; oldledger 10 "ok — working"; moved 60; bpane idle; run
expect "moved target: no rotation request on the old target → nothing" "!^launch"

reset; status 1 2 "adopted by resource broker"; oldledger 10 "rotation requested"; bpane idle; run
expect "no recorded target (first sight) → the old target is not guessed at" "!^launch"
expect "  …but it is recorded, so a later move is seen" "!^kill"
grep -q '^o/fleet|30|broker-heartbeat|' "$T/w/logs/fleet-supervisor/acme-broker.target" && echo x >>"$T/actions"
expect "  …(record holds the current target)" "^x"

reset; status 1 2 "adopted by resource broker"; oldledger 10 "rotation requested"; mkdir -p "$T/w/logs/fleet-supervisor"
printf 'o/fleet|30|broker-heartbeat|%s\n' "$(( $(date +%s) - 3600 ))" >"$T/w/logs/fleet-supervisor/acme-broker.target"; bpane idle; run
expect "unchanged target: rotation request on an unrelated ledger is never read" "!^launch"

# A 6th field (merge|maintain): a singleton monster; every relaunch also needs the lease to allow it
# (engsys#62). The fake BATON_CMD answers from $FAKE/baton (free | expired | expired_self | held_self |
# held_elsewhere | not_home | error) and records each call. expired_self is an expired baton whose tip
# still names this session (`forfeited: true`, engsys#87).
cat >"$T/baton.sh" <<'SH'
#!/usr/bin/env bash
echo "baton $*" >>"$FAKE/actions"
code="$(cat "$FAKE/baton")"
case "$code" in
  expired_self) echo '{"relaunch":true,"code":"expired","forfeited":true,"holder":"alice:acme-mm","reason":"baton of alice:acme-mm expired"}'; exit 0 ;;
  free | expired | malformed) echo "{\"relaunch\":true,\"code\":\"$code\",\"reason\":\"ok\"}"; exit 0 ;;
  held_self)
    if [[ " $* " == *" --rotation-idle "* ]]; then
      echo '{"relaunch":true,"code":"forfeited_rotation","forfeited":true,"holder":"alice:acme-mm","reason":"baton of alice:acme-mm forfeited on idle rotation"}'
      exit 0
    fi
    echo '{"relaunch":false,"code":"held_self","reason":"held by alice:acme-mm"}'; exit 1 ;;
  held_elsewhere | not_home) echo "{\"relaunch\":false,\"code\":\"$code\",\"reason\":\"held by bob:acme-mm\"}"; exit 1 ;;
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
expect "baton: rotation + idle + held_self → forfeited and relaunched (#115)" "^launch acme-mm"
expect "  …passed --rotation-idle to supervise" "^baton --repo o/r --role merge --session acme-mm --rotation-idle"
reset; baton held_self; ledger 10 "rotation requested"; pane busy; run
expect "baton: rotation + busy + held_self → wait (#115)" "!^launch"
reset; baton held_self; ledger 2 "rotation requested"; pane idle; run
expect "baton: rotation within grace + idle + held_self → wait (#115)" "!^launch"
reset; baton held_elsewhere; ledger 10 "rotation requested"; pane idle; run
expect "baton: rotation + idle + held_elsewhere → never relaunched (#115)" "!^launch"

reset; baton expired; ledger 90 "ok — merging #12"; pane idle; run
expect "baton: stale + alive + idle + forfeited baton → relaunched" "^launch acme-mm"
reset; baton expired; ledger 90 "ok — merging #12"; pane busy; run
expect "baton: stale + alive but mid-turn → never killed" "!^launch"
expect "  …escalated instead" "comment 1: .*stale"
reset; baton held_self; ledger 90 "ok — merging #12"; pane idle; run
expect "baton: stale + idle but its baton is still live → escalate, not relaunch" "!^launch"

# The session let its baton run out and stopped on BATON_LOST (engsys#87): relaunch on the next tick,
# not 60 minutes later when the heartbeat goes stale.
reset; baton expired_self; ledger 12 "ok — merging #12"; pane idle; run
expect "baton: expired still naming this session + idle, heartbeat a TTL old → relaunched now" "^launch acme-mm"
expect "  …the reason names the forfeit" "comment 1: .*expired still naming this session"
run   # the relaunched session idles without a heartbeat (its startup failed): same holder name, same lease
expect "  …relaunched once per heartbeat, not every tick" "!^launch"
reset; baton expired; ledger 12 "ok — merging #12"; pane idle; run
expect "baton: expired but naming another holder (not this session's forfeit) → left alone" "!^launch"
expect "  …the lease was asked" "^baton --repo o/r --role merge"
expect "  …and nothing escalated (heartbeat not stale)" "!comment"
reset; baton expired_self; ledger 5 "ok — merging #12"; pane idle; run
expect "baton: heartbeat younger than the TTL → lease not even asked" "!^baton"
reset; baton expired_self; ledger 12 "ok — merging #12"; pane busy; run
expect "baton: forfeited but mid-turn → never killed" "!^launch"
reset; baton expired_self; ledger 12 "session end"; pane idle; run
expect "baton: forfeited after 'session end' → a deliberate stop stays stopped" "!^launch"
reset; baton held_self; ledger 12 "ok — merging #12"; pane idle; run
expect "baton: idle with its baton still live → nothing" "!^launch"

printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; baton expired_self; ledger 12 "ok — merging #12"; pane idle; run
expect "no 6th field → no forfeit trigger" "!^launch"
reset; baton held_elsewhere; ledger 90 "ok — merging #12"; pane exited; run
expect "no 6th field → the lease is never consulted" "!^baton"
expect "  …and the table runs as before" "^launch acme-mm"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nREPO=o/r\nacme-mm|1|60|||deploy\n' "$T" "$T" >"$T/w/sup.conf"
reset; baton free; ledger 90 "ok — merging #12"; pane exited; run
expect "an unknown 6th field skips the line" "!^launch"

# INTEGRITY_CMD (engsys#70, #86 review H1/L1): once per tick when a singleton monster is supervised.
# Anything but 0 (1 = the plugin files guarding merge/maintain differ from their release, 3 = it couldn't
# check) holds every relaunch of a 6th-field session, fail closed, said once on its ledger; a running one
# is never killed for it. The fake answers from $FAKE/integrity (0 | 1 | 3) and records each call.
printf '#!/usr/bin/env bash\necho "integrity $*" >>"$FAKE/actions"; exit "$(cat "$FAKE/integrity")"\n' >"$T/integrity.sh"
printf '#!/usr/bin/env bash\necho "revoke $*" >>"$FAKE/actions"; exit 0\n' >"$T/revoke.sh"
chmod +x "$T/revoke.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nBATON_REVOKE_CMD=bash %s/revoke.sh\nINTEGRITY_CMD=bash %s/integrity.sh --alert\nREPO=o/r\nacme-mm|1|60|||merge\nacme-rel|2|60\n' "$T" "$T" "$T" "$T" >"$T/w/sup.conf"
integrity() { echo "$1" >"$T/integrity"; }
ledger2() { jq -n --arg b "last: $(iso "$1") — status: $2" '{state:"OPEN", body:$b}' >"$T/ledger-2.json"; }
rpane() { echo zsh >"$T/pane-acme-rel"; : >"$T/capture-acme-rel"; }

reset; baton free; integrity 0; ledger 90 "ok — merging #12"; ledger2 2 "ok"; pane exited; rpane; run
expect "integrity: asked once per tick" "^integrity --alert"
expect "  …passes → crash recovery relaunches as before" "^launch acme-mm"
reset; baton free; integrity 1; ledger 90 "ok — merging #12"; ledger2 90 "ok"; pane exited; rpane; run
expect "integrity: mismatch → the singleton monster is not relaunched" "!^launch acme-mm"
expect "  …never revokes or breaks the baton for a mismatch" "!^revoke"
expect "  …the lease is not even asked" "!^baton"
expect "  …a session without a role is still relaunched" "^launch acme-rel"
expect "  …the held relaunch is said on the monster's ledger" "comment 1: .*held: the engsys plugin on this host does not match its release"
run
expect "  …once" "!comment 1: .*held"
integrity 0; run
expect "  …passes again → relaunched" "^launch acme-mm"
integrity 1; ledger 90 "ok — merging #12"; pane exited; run
expect "  …a new hold after a pass is said again" "comment 1: .*held"
grep -q "integrity: MISMATCH" "$T/w/logs/fleet-supervisor/supervisor.log" && { pass=$((pass + 1)); echo "  ok    …logged"; } || { fail=$((fail + 1)); echo "  FAIL  …logged"; }
reset; baton free; integrity 1; ledger 10 "rotation requested"; ledger2 2 "ok"; pane idle; rpane; run
expect "integrity: mismatch + rotation requested + idle → not relaunched, not killed" "!^kill acme-mm"
expect "  …and a RUNNING session's baton is never revoked or broken" "!^revoke"
reset; baton expired; integrity 1; ledger 90 "ok — merging #12"; ledger2 2 "ok"; pane idle; rpane; run
expect "integrity: mismatch + stale + idle → never killed" "!^kill acme-mm"
expect "  …its baton is left alone too" "!^revoke"
expect "  …escalated on the ledger instead" "comment 1: .*stale"
reset; baton free; integrity 3; ledger 90 "ok — merging #12"; ledger2 90 "ok"; pane exited; rpane; run
expect "integrity: couldn't check (GitHub down) → fail closed, not relaunched" "!^launch acme-mm"
expect "  …said on the ledger" "comment 1: .*held: the engsys plugin check could not run (exit 3)"
expect "  …a session without a role is still relaunched" "^launch acme-rel"
grep -q "integrity: the check could not run (exit 3), so no merge/maintain session is relaunched" "$T/w/logs/fleet-supervisor/supervisor.log" && { pass=$((pass + 1)); echo "  ok    …logged"; } || { fail=$((fail + 1)); echo "  FAIL  …logged"; }
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nINTEGRITY_CMD=bash %s/integrity.sh\nREPO=o/r\nacme-rel|2|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; integrity 1; ledger2 90 "ok"; rpane; run
expect "integrity: no singleton monster supervised → never asked" "!^integrity"
expect "  …and the table runs as before" "^launch acme-rel"

# --- operator time format (#89): comments read in the operator's zone, the log stays ISO UTC ----
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nREPO=o/r\nacme-mm|1|60\n' "$T" >"$T/w/sup.conf"
LASTISO="$(iso 90)"
reset; ledger 90 "ok — merging #12"; pane busy; run
expect "no time format: the escalation comment keeps the ISO heartbeat" "comment 1: .*last: $LASTISO"
reset; ledger 90 "ok — merging #12"; pane busy
: >"$T/actions"; (cd "$T/w" && OPERATOR_TIMEZONE=America/New_York OPERATOR_CLOCK=12h bash "$SUP" sup.conf >/dev/null 2>&1)
expect "12h ET: the escalation comment shows the heartbeat as a clock time" "comment 1: .*last: [A-Z][a-z][a-z] [0-9]*, [0-9]*:[0-9][0-9] [AP]M E[SD]T)"
expect "  …and no raw ISO timestamp remains in it" "!comment 1: .*last: [0-9]\{4\}-"
if grep -q "$LASTISO" "$T/w/logs/fleet-supervisor/supervisor.log" 2>/dev/null || grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z ' "$T/w/logs/fleet-supervisor/supervisor.log"; then
  pass=$((pass + 1)); echo "  ok  the supervisor log keeps ISO 8601 UTC"
else fail=$((fail + 1)); echo "  FAIL the supervisor log lost its ISO timestamps"; fi
reset; ledger 90 "ok — merging #12"; pane exited
: >"$T/actions"; (cd "$T/w" && OPERATOR_TIMEZONE=Europe/Berlin OPERATOR_CLOCK=24h bash "$SUP" sup.conf >/dev/null 2>&1)
expect "24h Berlin: the relaunch comment shows the time as 24h CET/CEST" "comment 1: .*relaunched .acme-mm.*[0-9]:[0-9][0-9] CES\?T)"


# --- an expired Claude Code login (engsys#103) ----------------------------------------------------
# 2026-10-06: the login expired, every relaunched session answered "Login expired · Please run /login"
# and sat idle, the launcher still exited 0, and the supervisor relaunched merge + maintain every tick
# for ~24 h without telling anyone. The fixtures are real Claude Code 2.1.285 panes:
# fixtures/pane-auth-401.txt is a verbatim capture (a session with a rejected OAuth token; paths
# changed), and fixtures/pane-login-expired.txt is the same frame with the incident's reply, taken
# word for word from the transcripts of 2026-10-06 ("Login expired · Please run /login",
# error: authentication_failed).
cp "$HERE/fixtures/pane-login-expired.txt" "$T/fixture-login-expired"
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok" "$T/auth-expired" "$T/notify-fail" "$T/heartbeat-fail"
authconf() { # authconf [extra conf line]
  printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nNOTIFY_CMD=bash %s/notify.sh\nHEARTBEAT_CMD=bash %s/heartbeat.sh\nAUTH_CHECK_WAIT_SEC=4\nREPO=o/r\n%s\nacme-mm|1|60|||merge\nacme-rel|2|60\n' "$T" "$T" "$T" "$T" "${1:-}" >"$T/w/sup.conf"
}
wpane() { # wpane <window> <capture text> — a live, idle pane (a worker, or any window in the session)
  echo "2.1.285" >"$T/pane-$1"; printf '%s\n' "$2" >"$T/capture-$1"
}
count() { grep -c -- "$1" "$T/actions" || true; }
expect_n() { # expect_n <name> <pattern> <count>
  local n; n="$(count "$2")"
  if [ "$n" = "$3" ]; then pass=$((pass + 1)); echo "  ok  $1"; else fail=$((fail + 1)); echo "  FAIL $1 (saw $n, want $3)"; sed 's/^/       /' "$T/actions"; fi
}
SLOG="$T/w/logs/fleet-supervisor"

# The incident replayed: the merge monster was relaunched, answered with the login error and idles; its
# heartbeat is stale and its baton forfeited, so the table would relaunch it. acme-rel crashed.
authconf; reset; baton expired; ledger 90 "ok — merging #12"; ledger2 90 "ok"; rpane
cp "$T/fixture-login-expired" "$T/capture-acme-mm"; echo "2.1.285" >"$T/pane-acme-mm"
run
expect "auth: login error in a pane → the test request is made" "^probe -p"
expect "  …one action-level alert" "^notify --level action --re https://github.com/o/r/issues/1 --incident claude-auth-expired Claude Code login expired on"
expect "  …it tells the operator what to do" "^notify .*Run \`/login\` in any session (or \`claude /login\`); the fleet resumes on the next supervisor tick"
expect "  …the idle monster is not relaunched" "!^launch acme-mm"
expect "  …and not killed" "!^kill"
expect "  …the crashed session is held too (every session, not only monsters)" "!^launch acme-rel"
expect "  …the lease is not even asked" "!^baton"
expect "  …no ledger comments (one calm alert)" "!comment"
expect "  …the status-issue heartbeat says so, in UTC" "^heartbeat sessions: .*; auth: expired since [0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9:]*Z, relaunches held"
expect "  …with a line for people" "^heartbeat .*Claude Code login expired on .* Relaunches held: acme-mm, acme-rel\."
grep -q "^[0-9-]*T[0-9:]*Z$" "$SLOG/auth.expired" && echo state-ok >>"$T/actions"
expect "  …the hold is on disk for \`fleet status\` (first line ISO UTC)" "^state-ok"
run; run
expect "next ticks: no second alert" "!^notify"
expect "  …still no relaunch (no loop)" "!^launch"
expect "  …still nothing killed" "!^kill"
grep -q "acme-mm: heartbeat stale.*but held: Claude Code login expired since" "$SLOG/supervisor.log" && echo logged >>"$T/actions"
expect "  …each held relaunch is logged" "^logged"
touch "$T/probe-ok"; run
expect "login works again → the alert is resolved" "^notify --level info --incident claude-auth-expired --resolve Resolved: Claude Code login works again on .*Relaunching the held sessions once each: acme-mm, acme-rel\."
expect_n "  …the held monster is relaunched once" "^launch acme-mm" 1
expect_n "  …the held crashed session is relaunched once" "^launch acme-rel" 1
expect "  …through the normal path (the lease is asked)" "^baton --repo o/r --role merge --session acme-mm"
expect "  …and the ledger comment says why it waited" "comment 1: .*held while Claude Code.s login was expired"
[ ! -f "$SLOG/auth.expired" ] && [ ! -f "$SLOG/auth.alerted" ] && echo cleared >>"$T/actions"
expect "  …the hold state is cleared" "^cleared"
baton held_self; ledger 1 "ok — merging #12"; ledger2 1 "ok"; run
expect "the relaunched sessions heartbeat → nothing more to do" "!^launch"
expect "  …no alert, no test request" "!^notify\|^probe"

# A relaunch reveals it (no pane showed the error before): the first relaunched session answers with the
# login error, so the rest of the tick is held and the alert goes out once.
authconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; baton free; ledger 90 "ok — merging #12"; ledger2 90 "ok"; pane exited; rpane
touch "$T/auth-expired"; run
expect_n "relaunch shows the login error → that one relaunch happened" "^launch acme-mm" 1
expect "  …the next session in the same tick is held" "!^launch acme-rel"
expect_n "  …one alert" "^notify --level action .*--incident claude-auth-expired" 1
expect "  …no test request needed: the reply is the evidence" "!^probe"
run
expect "next tick: the error pane is not relaunched" "!^launch"
expect "  …no second alert" "!^notify"
expect "  …the test request now runs (to notice a login)" "^probe -p"

# Recovery seen in a pane, with the test request off: the operator runs /login in the monster's window.
authconf "AUTH_PROBE=off"; rm -f "$T/auth-expired"; run
expect "AUTH_PROBE=off → never a test request" "!^probe"
expect "  …still held" "!^launch"
printf '❯ /login\n  ⎿  Login successful\n' >>"$T/capture-acme-mm"; baton expired; run
expect "/login in a held pane (Login successful) → resolved" "^notify --level info --incident claude-auth-expired --resolve"
expect_n "  …the held crashed session is relaunched once" "^launch acme-rel" 1
rm -f "$T"/pane-* "$T"/capture-*

# Only Claude Code's own error line counts. The canary: acme-rel, crashed, is relaunched unless a pane holds it.
authcase() { # authcase <name> <hold|none> <pane text>
  authconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
  wpane acme-w "$3"; run
  if [ "$2" = hold ]; then expect "$1 → held" "!^launch acme-rel"; expect "  …alerted" "^notify --level action"
  else expect "$1 → not a login error" "^launch acme-rel"; expect "  …no alert, no test request" "!^notify\|^probe"; fi
}
authcase "the incident's line" hold "$(cat "$T/fixture-login-expired")"
authcase "the generic 401 reply (verbatim 2.1.285 pane)" hold "$(cat "$HERE/fixtures/pane-auth-401.txt")"
authcase "OAuth token revoked" hold "⏺ OAuth token revoked · Please run /login"
authcase "not logged in" hold "⏺ Not logged in · Please run /login"
authcase "invalid API key" hold "⏺ API Error: 401 Invalid API key · Please run /login"
authcase "Anthropic-profile variant" hold "⏺ Login expired · Run /login to sign in again, or re-authenticate your Anthropic profile"
authcase "the ● marker" hold "● Login expired · Please run /login"
authcase "a model reply quoting the line" none "⏺ The monster printed \"Login expired · Please run /login\", so run /login on the host."
authcase "a reply that starts with the words but goes on" none "⏺ Login expired · Please run /login when you are back, then reply go."
authcase "tool output carrying the line" none "  ⎿  Login expired · Please run /login"
authcase "the line without a message marker" none "    Login expired · Please run /login"
authcase "an error followed by a normal reply" none "⏺ Login expired · Please run /login
❯ go on
⏺ Reading the ledger."
authconf; reset; rm -f "$T"/pane-* "$T"/capture-*; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "⏺ Login expired · Please run /login"; printf '✻ Working… (esc to interrupt)\n' >>"$T/capture-acme-w"; run
expect "a pane mid-turn is not read → no hold" "^launch acme-rel"
authconf; reset; rm -f "$T"/pane-* "$T"/capture-*; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "⏺ Login expired · Please run /login"; echo zsh >"$T/pane-acme-w"; run
expect "an exited pane (shell in front) is not read → no hold" "^launch acme-rel"

# An old error on screen while the login works: the test request passes, so no hold, and that pane is
# acknowledged (not tested again) until it shows something else.
authconf; reset; rm -f "$T"/pane-* "$T"/capture-*; touch "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "⏺ Login expired · Please run /login"; run
expect "old error + working login → not held" "^launch acme-rel"
expect "  …no alert" "!^notify"
ledger2 90 "ok"; rpane; run
expect "  …next tick: the acknowledged pane is not tested again" "!^probe"
wpane acme-w "⏺ Back on the ledger."; run
[ ! -f "$SLOG/auth.acked" ] && echo pruned >>"$T/actions"
expect "  …the pane answers normally → no longer acknowledged" "^pruned"
rm -f "$T/probe-ok"; wpane acme-w "⏺ Login expired · Please run /login"; run
expect "  …a new error in it later counts again" "^notify --level action"
rm -f "$T"/pane-* "$T"/capture-*

# A rotation request while held waits, and is honoured once the login works.
authconf; reset; baton free; ledger 10 "rotation requested"; ledger2 1 "ok"; echo 2.1.285 >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"
wpane acme-w "⏺ Login expired · Please run /login"; run
expect "held + rotation requested + idle → not relaunched" "!^launch acme-mm"
expect "  …not killed" "!^kill"
touch "$T/probe-ok"; run
expect_n "login works → the rotation relaunch happens once" "^launch acme-mm" 1
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"

# The alert is retried until it goes out, and the resolve too.
authconf; reset; ledger 1 "ok"; ledger2 90 "ok"; rpane; wpane acme-w "⏺ Login expired · Please run /login"; touch "$T/notify-fail"; run
expect "notify fails → still held" "!^launch"
rm -f "$T/notify-fail"; run
expect_n "  …the alert is posted on the next tick" "^notify --level action" 1
touch "$T/probe-ok" "$T/notify-fail"; run
expect "  …login works but the resolve fails → relaunches resume anyway" "^launch acme-rel"
rm -f "$T/notify-fail"; ledger2 1 "ok"; run
expect_n "  …the resolve is posted on the next tick" "^notify --level info --incident claude-auth-expired --resolve" 1
run
expect "  …once" "!^notify"
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"

# STATUS_URL is the alert's link; the time in the heartbeat's people line follows the operator's format.
authconf "STATUS_URL=https://github.com/o/fleet/issues/30"; reset; ledger 1 "ok"; ledger2 90 "ok"; rpane; wpane acme-w "⏺ Login expired · Please run /login"
: >"$T/actions"; (cd "$T/w" && OPERATOR_TIMEZONE=America/New_York OPERATOR_CLOCK=12h bash "$SUP" sup.conf >/dev/null 2>&1)
expect "STATUS_URL → the alert links the status issue" "^notify --level action --re https://github.com/o/fleet/issues/30 --incident claude-auth-expired"
expect "  …the heartbeat's machine field stays ISO UTC" "^heartbeat .*auth: expired since [0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T"
expect "  …its people line shows the operator's clock" "^heartbeat .*since [A-Z][a-z][a-z] [0-9]*, [0-9]*:[0-9][0-9] [AP]M E[SD]T\. Run"
rm -f "$T"/pane-* "$T"/capture-*

# engsys#207: the 2026-10-18 15:01Z false resume. The hold started on "Login expired"; later the e2e pane's newest message
# was a Remote Control notice (below, verbatim). It was classed as a normal answer, the hold ended, and the login was still dead.
RC_LINE="⏺ Remote Control disconnected — OAuth token unavailable — run /login to restore Remote Control"
authconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "$(cat "$T/fixture-login-expired")"; run
expect "207: a login error holds" "^notify --level action"
wpane acme-w "$RC_LINE"; run
expect "207: the Remote Control disconnect line keeps the hold (no resolve)" "!--resolve"
expect "  …nothing relaunched" "!^launch"
for line in "⏺ OAuth token refresh failed" "⏺ Signed out of Claude" "⏺ Failed to refresh OAuth token: another Claude Code process is refreshing it" "⏺ OAuth session expired and could not be refreshed" "⏺ Remote Control disconnected — OAuth token unavailable"; do
  authcase "207: $line" hold "$line"
done
# a notice-only pane is not a resume: only the test request ends the hold
authconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "$(cat "$T/fixture-login-expired")"; run
wpane acme-w "⏺ Heads up: a Claude Code notice that is not a login error"; run
expect "207: a pane that shows a notice, not a login error, does not end the hold" "!--resolve"
expect "  …the held session is still not relaunched" "!^launch"
touch "$T/probe-ok"; run
expect "207: a test request that succeeds ends it" "^notify --level info --incident claude-auth-expired --resolve"
expect "  …and the held session is relaunched once" "^launch acme-rel"
rm -f "$T/probe-ok"
# a session escalated before/during the hold is retried once when it ends (no operator fleet restart)
authconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"
echo 2.1.285 >"$T/pane-acme-rel"; : >"$T/capture-acme-rel"; mkdir -p "$SLOG"; touch "$SLOG/acme-rel.escalated"
wpane acme-w "$(cat "$T/fixture-login-expired")"; run
expect "207: an alive, stale, idle session is held (not commented on) while the login is dead" "!comment 2"
expect "  …and not killed" "!^kill"
touch "$T/probe-ok"; run
expect_n "207: the login works again → the escalated session is relaunched once" "^launch acme-rel" 1
expect "  …through a kill of its idle window" "^kill acme-rel"
[ ! -f "$SLOG/acme-rel.escalated" ] && echo latch-cleared >>"$T/actions"
expect "  …and its escalation latch is cleared" "^latch-cleared"
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"

# engsys#205: one Claude login per session. With SESSION_CONFIG_DIR_BASE the login hold is per session: its own state,
# alert and test request (on that session's dir); the other sessions keep going.
CFGB="$T/cfg.sessions"
pconf() { authconf "SESSION_CONFIG_DIR_BASE=$CFGB
INTEGRITY_SESSION_CMD=bash $T/integrity.sh"; }
printf '#!/usr/bin/env bash\necho "integrity-session $*" >>"$FAKE/actions"\n[ -f "$FAKE/integrity-bad-$1" ] && { echo "mismatch in $1"; exit 1; }\nexit 0\n' >"$T/integrity.sh"
pconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok" "$T"/integrity-bad-*; baton free; ledger 90 "ok — merging #12"; ledger2 90 "ok"
echo zsh >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"
echo 2.1.285 >"$T/pane-acme-rel"; cp "$T/fixture-login-expired" "$T/capture-acme-rel"; run
expect "205: a login error in one session's pane starts a hold for that session" "^notify --level action .*--incident claude-auth-expired-acme-rel "
expect "  …the alert names the session, its dir and the login command" "^notify .*claude-auth-expired-acme-rel .*session .acme-rel. expired .*$CFGB/acme-rel.*CLAUDE_CONFIG_DIR=$CFGB/acme-rel claude"
expect "  …and says only that session is held" "^notify .*Only .acme-rel. is held: the other sessions keep running"
expect "  …no global alert" "!--incident claude-auth-expired "
expect "  …the test request ran on that session's own dir" "^probe-cfg $CFGB/acme-rel"
expect "  …the other session (merge monster, crashed) is relaunched all the same" "^launch acme-mm"
expect "  …the held session is neither killed nor commented on" "!^kill acme-rel\|comment 2"
[ -f "$SLOG/auth.acme-rel.expired" ] && [ ! -f "$SLOG/auth.expired" ] && echo own-state >>"$T/actions"
expect "  …its hold state is its own file" "^own-state"
expect "  …the heartbeat names only that session" "^heartbeat .*auth: own login expired for acme-rel (only those are held)"
run
expect "205: next tick: no second alert, still no relaunch of the held one" "!^notify --level action\|^launch acme-rel"
touch "$T/probe-ok"; run
expect "205: its own test request succeeding resolves its own incident" "^notify --level info --incident claude-auth-expired-acme-rel --resolve Resolved: Claude Code login of session .acme-rel. works again"
expect "  …and the session is relaunched once" "^launch acme-rel"
rm -f "$T/probe-ok"
# a login error in a pane that is not a supervised session's does not hold anything in per-session mode
pconf; reset; rm -f "$T"/pane-* "$T"/capture-*; baton free; ledger 90 "ok — merging #12"; ledger2 1 "ok"
echo zsh >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"; wpane acme-w "$(cat "$T/fixture-login-expired")"; run
expect "205: a login error in an unsupervised window holds no session" "!^notify --level action"
expect "  …the merge monster is relaunched" "^launch acme-mm"
# a session name that can't be a dir name gets no per-session scope
pconf; printf 'acme-a..b|9|60\n' >>"$T/w/sup.conf"; reset; rm -f "$T"/pane-* "$T"/capture-*; baton free; ledger 1 "ok"; ledger2 1 "ok"; run
grep -q "can't be a per-session config dir name" "$SLOG/supervisor.log" && echo name-refused >>"$T/actions"
expect "205: a hostile session name gets no per-session login scope" "^name-refused"
# a login error that shows up right after a relaunch holds that session only, and the heartbeat does not tell the
# operator to /login "in any session" (another session's login does not repair this one's dir)
pconf; reset; rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"; baton free; ledger 90 "ok — merging #12"; ledger2 1 "ok"
echo zsh >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"; touch "$T/auth-expired"; run; rm -f "$T/auth-expired"
expect "205: a relaunch that comes up logged out holds that session" "^notify --level action .*--incident claude-auth-expired-acme-mm "
expect "  …the heartbeat names it and does not say to /login in any session" "^heartbeat .*auth: own login expired for acme-mm"
expect "  …without the shared-login text" "!^heartbeat .*in any session"
# the plugin check is per session: one session's bad dir holds only its relaunch
pconf; reset; rm -f "$T"/pane-* "$T"/capture-*; baton free; ledger 90 "ok — merging #12"; ledger2 90 "ok"; echo zsh >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"
touch "$T/integrity-bad-acme-mm"; run
expect "205: INTEGRITY_SESSION_CMD is asked per session" "^integrity-session acme-mm"
expect "  …a mismatch in acme-mm's dir holds acme-mm" "!^launch acme-mm"
expect "  …and not the other session" "!^integrity-session acme-rel"
rm -f "$T/integrity-bad-acme-mm"; run
expect "  …once its dir verifies again, it is relaunched" "^launch acme-mm"
# a conf that sets both commands: the global verdict still holds the singleton sessions
printf 'INTEGRITY_CMD=bash %s/integrity-global.sh\n' "$T" >>"$T/w/sup.conf"; printf '#!/usr/bin/env bash\necho "integrity-global" >>"$FAKE/actions"; exit 1\n' >"$T/integrity-global.sh"
reset; baton free; ledger 90 "ok — merging #12"; echo zsh >"$T/pane-acme-mm"; : >"$T/capture-acme-mm"; run
expect "205: INTEGRITY_CMD and INTEGRITY_SESSION_CMD both set: the global mismatch still holds the relaunch" "!^launch acme-mm"
rm -f "$T"/pane-* "$T"/capture-*

# CT-14: HARNESS=copilot in launch-agent-sessions.sh and fleet-supervisor.sh auth_probe
cat >"$T/bin/copilot" <<'SH'
#!/usr/bin/env bash
echo "copilot-probe $*" >>"$FAKE/actions"
if [ -f "$FAKE/probe-ok" ]; then echo OK; exit 0; fi
echo "Failed to authenticate with GitHub Copilot"; exit 1
SH
chmod +x "$T/bin/copilot"
authconf "HARNESS=copilot"; reset; rm -f "$T"/pane-* "$T"/capture-*; touch "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "● Failed to authenticate with GitHub Copilot"; run
expect "CT-14: HARNESS=copilot auth_probe runs copilot -p" "^copilot-probe -p Reply with the single word OK -s --no-custom-instructions --disable-builtin-mcps --model claude-haiku-5.5"
expect "CT-14: HARNESS=copilot probe ok → relaunch proceeds" "^launch acme-rel"
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"

# CT-14b: HARNESS=antigravity in fleet-supervisor.sh auth_probe
cat >"$T/bin/agy" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "remote-control" ]; then
  if [ "${2:-}" = "status" ]; then
    echo "Daemon status: not running"
    exit 0
  fi
  echo "agy-rc $*" >>"$FAKE/actions"
  exit 0
fi
echo "agy-probe $*" >>"$FAKE/actions"
if [ -f "$FAKE/probe-ok" ]; then echo OK; exit 0; fi
echo "Login expired · Please run /login"; exit 1
SH
chmod +x "$T/bin/agy"
authconf "HARNESS=antigravity"; reset; rm -f "$T"/pane-* "$T"/capture-*; touch "$T/probe-ok"; ledger 1 "ok"; ledger2 90 "ok"; rpane
wpane acme-w "● Login expired · Please run /login"; run
expect "CT-14b: HARNESS=antigravity auth_probe runs agy -p" "^agy-probe -p Reply with the single word OK"
expect "CT-14b: HARNESS=antigravity probe ok → relaunch proceeds" "^launch acme-rel"
rm -f "$T"/pane-* "$T"/capture-* "$T/probe-ok"

# Seat limit: the fleet is Claude-only. Whatever HARNESS_FALLBACK says, no supervised session (merge,
# broker, any monster, an unclassified one) is ever moved to another harness; a limit line that Claude
# Code itself printed as the last message of a pane the supervisor launched is alerted once.
cat >"$T/launch.sh" <<'SH'
#!/usr/bin/env bash
if [ -f "$FAKE/launch-fail" ]; then echo "attempt $1" >>"$FAKE/actions"; echo "error: claude not found on PATH" >&2; exit 1; fi
echo "launch $1 harness=${FLEET_ACTIVE_HARNESS:-unset}" >>"$FAKE/actions"; echo "2.1.300" >"$FAKE/pane-$1"
printf '⏺ Reading the ledger first.\n' >"$FAKE/capture-$1"
SH
chmod +x "$T/launch.sh"
qconf() { # qconf [extra conf lines...]
  { printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nBATON_CMD=bash %s/baton.sh\nNOTIFY_CMD=bash %s/notify.sh\nHEARTBEAT_CMD=bash %s/heartbeat.sh\nAUTH_CHECK_WAIT_SEC=0\nAUTH_PROBE=off\nHARNESS=claude\nREPO=o/r\n' "$T" "$T" "$T" "$T"
    for l in "$@"; do printf '%s\n' "$l"; done
    printf 'acme-mm|1|60|||merge\nacme-rel|2|60\nacme-broker|3|60\n'; } >"$T/w/sup.conf"
}
ledger3() { jq -n --arg b "last: $(iso "$1") — status: $2" '{state:"OPEN", body:$b}' >"$T/ledger-3.json"; }
launched_by_sup() { mkdir -p "$SLOG"; printf '%%%s\n' "$1" >"$SLOG/$1.pane"; } # as relaunch() records it
live() { echo "2.1.290" >"$T/pane-$1"; printf '%s\n' "$2" >"$T/capture-$1"; } # live <window> <last lines>
qreset() { reset; rm -f "$T"/pane-* "$T"/capture-*; baton free; ledger 2 "ok — merging #12"; ledger2 2 "ok"; ledger3 2 "ok"; }
LIMIT="⏺ You've hit your limit · resets 9pm (America/New_York)"
ALL_FB=("HARNESS_FALLBACK=copilot,antigravity" "QUOTA_COOLDOWN_MIN=1" "GATE_ISSUE=o/r#9" "GATE_OPERATORS=op:1" "SECURITY_SESSIONS=acme-sec")

# A real limit line in supervisor-launched panes of every kind of supervised session: alerted, never switched.
qconf "${ALL_FB[@]}"; qreset; launched_by_sup acme-mm; launched_by_sup acme-rel; launched_by_sup acme-broker
live acme-mm "$LIMIT"; live acme-rel "$LIMIT"; live acme-broker "$LIMIT"; run
expect "seat limit: alerted once" "^notify --level alert --incident seat-limit .*Claude-only"
expect "  …no session relaunched onto another harness" "!^launch"
expect "  …no gate request" "!gate"
expect "  …no fallback probe" "!^probe"
if [ ! -f "$SLOG/harness.fallback" ]; then pass=$((pass + 1)); echo "  ok    …no fallback state written"; else fail=$((fail + 1)); echo "  FAIL  …no fallback state written"; fi
grep -q "never fail over to another harness (Claude-only)" "$SLOG/supervisor.log" && { pass=$((pass + 1)); echo "  ok    …logged as Claude-only"; } || { fail=$((fail + 1)); echo "  FAIL  …logged as Claude-only"; }
run
expect "seat limit next tick: no repeated alert" "!^notify --level alert --incident seat-limit"
live acme-mm "⏺ All checks green."; live acme-rel "⏺ ok"; live acme-broker "⏺ ok"; run
expect "seat limit gone: the alert resolves" "^notify --level info --incident seat-limit --resolve"

# Evidence: a limit phrase in tool output (⎿), or in a pane the supervisor didn't launch, is no seat limit.
qconf "${ALL_FB[@]}"; qreset; launched_by_sup acme-rel
live acme-rel "$(printf '⏺ Bash(cat notes.txt)\n  ⎿  Usage limit reached · resets 9pm\n⏺ Done reading.')"
live acme-other "$LIMIT"; live acme-broker "$LIMIT"
run
expect "seat limit evidence: tool output and unlaunched panes never count" "!^notify --level alert --incident seat-limit"

# Relaunches always run on the primary harness, even with a fallback file left by an older version.
qconf "${ALL_FB[@]}"; qreset; mkdir -p "$SLOG"; printf 'copilot\n2026-10-15T10:00:00Z\nclaude\nacme-rel\n9999999999\n' >"$SLOG/harness.fallback"
ledger 90 "ok — merging #12"; ledger3 90 "ok"; echo zsh >"$T/pane-acme-mm"; echo zsh >"$T/pane-acme-broker"
FLEET_ACTIVE_HARNESS=copilot run
expect "old fallback state: the merge monster is relaunched on claude" "^launch acme-mm harness=claude"
expect "  …the broker too" "^launch acme-broker harness=claude"
expect "  …never on the fallback" "!harness=copilot"
if [ ! -f "$SLOG/harness.fallback" ]; then pass=$((pass + 1)); echo "  ok    …the leftover fallback file is removed"; else fail=$((fail + 1)); echo "  FAIL  …the leftover fallback file is removed"; fi

# Positive control: without any fallback config, a crashed session is still relaunched normally.
qconf; qreset; ledger 90 "ok — merging #12"; echo zsh >"$T/pane-acme-mm"; run
expect "no fallback config: a stale exited monster is relaunched as before" "^launch acme-mm harness=claude"
rm -f "$T"/pane-* "$T"/capture-*

# Seat limit hold and automatic resume (ff-engsys-fleet#54): the reset time is read from the limit line, the session
# is held (no stale or relaunch escalation), and resumed once the reset has passed.
lreset() { # lreset <minutes from now> → the "resets …" text of a limit line, in UTC
  local e=$(( $(date +%s) + $1 * 60 ))
  printf 'resets %s (UTC)' "$(date -u -r "$e" '+%b %-d, %-I:%M%p' 2>/dev/null || date -u -d "@$e" '+%b %-d, %-I:%M%p')"
}
hold_has() { grep -q -- "^$2" "$SLOG/$1.limit-hold" 2>/dev/null && echo "hold:$1:$2" >>"$T/actions" || true; }
hold_gone() { [ ! -f "$SLOG/$1.limit-hold" ] && echo "nohold:$1" >>"$T/actions" || true; }
mkhold_due() { sed -i.bak 's/^resume_at=.*/resume_at=1/' "$SLOG/$1.limit-hold" && rm -f "$SLOG/$1.limit-hold.bak"; }
hconf() { qconf "$@"; }

hconf; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your weekly limit · $(lreset 90)"; run
expect "hold: a (weekly) limit line is recognised and alerted" "^notify --level alert --incident seat-limit"
expect "  …the alert says it resumes on its own" "^notify .*seat-limit .*resumes on its own after "
hold_has acme-rel "reset=20"
hold_has acme-rel "resume_at=[0-9]"
expect "  …the hold is on disk with the parsed reset time" "^hold:acme-rel:reset=20"
expect "  …no stale-heartbeat escalation on the ledger" "!comment 2"
run; run
expect "hold: next ticks: still no escalation" "!comment"
expect "  …no re-prompt before the reset" "!^sendkeys"
expect "  …nothing relaunched or killed" "!^launch acme-rel\|^kill"
expect "  …no second alert" "!^notify --level alert"

# after the reset: re-prompted once (the session is alive and idle), the hold cleared, one info notice
mkhold_due acme-rel; run
expect_n "resume: the idle session is re-prompted once" "^sendkeys acme-rel .*usage limit has reset" 1
hold_gone acme-rel
expect "  …the hold is cleared" "^nohold:acme-rel"
expect "  …one info notice (the alert's resolve) naming the session" "^notify --level info --incident seat-limit --resolve Resolved: the Claude usage limit has reset on .*resumed on their own: acme-rel"
expect "  …still no ledger escalation" "!comment"

# back-off: the pane still shows the limit after the re-prompt (it hit the limit again immediately); its reset
# time is already past, so the resume time is exactly the back-off
hconf "LIMIT_RESUME_MARGIN_SEC=0"; live acme-rel "⏺ You've hit your limit · $(lreset -1)"; run
hold_has acme-rel "rehits=1"
expect "re-hit: held again with back-off (rehits=1), not re-prompted in a loop" "^hold:acme-rel:rehits=1"
expect "  …and a repeat limit is a new incident: alerted again" "^notify --level alert --incident seat-limit"
expect "  …no re-prompt this tick" "!^sendkeys"
resume_at="$(sed -n 's/^resume_at=//p' "$SLOG/acme-rel.limit-hold")"
d=$(( resume_at - $(date +%s) )); if [ "$d" -ge 550 ] && [ "$d" -le 610 ]; then echo "backoff-10m" >>"$T/actions"; fi
expect "  …the resume waits exactly the back-off (10m) past now" "^backoff-10m"
mkhold_due acme-rel; run; run
hold_has acme-rel "rehits=2"
expect "second re-hit: back-off doubles (rehits=2)" "^hold:acme-rel:rehits=2"
resume_at="$(sed -n 's/^resume_at=//p' "$SLOG/acme-rel.limit-hold")"
d=$(( resume_at - $(date +%s) )); if [ "$d" -ge 1150 ] && [ "$d" -le 1210 ]; then echo "backoff-20m" >>"$T/actions"; fi
expect "  …to 20m" "^backoff-20m"

# two sessions limited, one with an unreadable reset: the first one's resume does not resolve the alert
hconf; qreset; launched_by_sup acme-rel; launched_by_sup acme-broker; ledger2 2 "ok"; ledger3 2 "ok"
live acme-rel "⏺ You've hit your limit · $(lreset 90)"; live acme-broker "⏺ You've hit your limit · resets whenever"; run
mkhold_due acme-rel; run
expect_n "resume of one while another is limited with no readable reset: re-prompted" "^sendkeys acme-rel .*usage limit has reset" 1
expect "  …but no false \"limit is over\" notice" "!--resolve"

# a reset that is already past (with margin 0): resumed on the same tick the limit is seen
hconf "LIMIT_RESUME_MARGIN_SEC=0"; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset -30)"; run
expect "reset already past → re-prompted on the spot" "^sendkeys acme-rel"

# a clock-only reset (no date) that passed minutes ago is due now, not tomorrow (CodeRabbit on this change)
{
  lclock() { local e=$(( $(date +%s) + $1 * 60 )); printf 'resets %s (UTC)' "$(date -u -r "$e" '+%-I:%M%p' 2>/dev/null || date -u -d "@$e" '+%-I:%M%p')"; }
  hconf "LIMIT_RESUME_MARGIN_SEC=0"; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lclock -10)"; run
  expect "clock-only reset that passed 10 minutes ago → re-prompted on the spot, not held until tomorrow (also across midnight)" "^sendkeys acme-rel"
  hconf "LIMIT_RESUME_MARGIN_SEC=0"; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lclock -50)"; run
  expect "  …and one that passed 50 minutes ago" "^sendkeys acme-rel"
}

# an exited session: held (not relaunched by crash recovery) until the reset, then relaunched once
hconf; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset 90)"; echo zsh >"$T/pane-acme-rel"; run
expect "exited + limit hold → not relaunched before the reset" "!^launch acme-rel"
hold_has acme-rel "resume_at=[0-9]"
expect "  …the hold is recorded" "^hold:acme-rel:resume_at"
run
expect "  …still not relaunched next tick" "!^launch acme-rel"
touch "$T/launch-fail"; mkhold_due acme-rel; run
expect "exited + reset passed, but the launcher fails → the hold is kept" "^attempt acme-rel"
hold_has acme-rel "resume_at="
expect "  …still held (not recorded as resumed)" "^hold:acme-rel:resume_at"
expect "  …and no \"limit is over\" notice" "!--resolve"
rm -f "$T/launch-fail"; run
expect_n "exited + reset passed → relaunched once" "^launch acme-rel" 1
hold_gone acme-rel
expect "  …hold cleared" "^nohold:acme-rel"

# a held session whose ledger is then closed (kill switch) drops its hold, so the alert can resolve
hconf; qreset; launched_by_sup acme-rel; ledger2 2 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset 90)"; run
hold_has acme-rel "resume_at="
expect "closed ledger: a hold exists first" "^hold:acme-rel:resume_at"
echo '{"state":"CLOSED","body":""}' >"$T/ledger-2.json"; rm -f "$T"/pane-acme-rel "$T"/capture-acme-rel; run
hold_gone acme-rel
expect "closed ledger (kill switch) → the orphaned hold is dropped" "^nohold:acme-rel"
run
expect "  …and the seat-limit alert resolves on the next tick" "^notify --level info --incident seat-limit --resolve"

# the session is working again before the reset (a person re-prompted it): the hold just ends
hconf; qreset; launched_by_sup acme-rel; ledger2 2 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset 90)"; run
live acme-rel "⏺ Back on the ledger."; run
hold_gone acme-rel
expect "pane answers normally before the reset → hold dropped, no re-prompt" "^nohold:acme-rel"
expect "  …no re-prompt" "!^sendkeys"

# unreadable reset time: alert-only, as before (the stale heartbeat is escalated normally)
for bad in "⏺ You've hit your limit · resets soon (UTC)" "⏺ You've hit your limit · resets 9pm (Mars/Olympus)" "⏺ You've hit your limit · resets 25pm (UTC)"; do
  hconf; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "$bad"; run
  hold_gone acme-rel
  expect "unreadable reset ($bad) → no hold" "^nohold:acme-rel"
  expect "  …still alerted" "^notify --level alert --incident seat-limit"
  expect "  …and the stale session escalated as before" "comment 2: .*heartbeat stale"
done

# The reset parser, unit-tested on an injected clock (SUPERVISOR_NOW_EPOCH), so nothing here depends on the time of day,
# the day, or a DST change. America/New_York changes on 2026-03-08 (spring forward) and 2026-11-01 (fall back).
lre() { ( SUPERVISOR_NOW_EPOCH="$1"; . "$HERE/limit-reset.sh"; limit_reset_epoch "$2" ); }
ep_in() { TZ="$1" date -j -f '%Y-%m-%d %H:%M:%S' "$2:00" +%s 2>/dev/null || TZ="$1" date -d "$2:00" +%s; }   # seconds pinned to :00
ep_local() { date -j -f '%Y-%m-%d %H:%M:%S' "$1:00" +%s 2>/dev/null || date -d "$1:00" +%s; }
NY=America/New_York
eq_ep() { # eq_ep <name> <got> <want>
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ok  $1"; else fail=$((fail + 1)); echo "  FAIL $1 (got $2, want $3)"; fi
}
eq_ep "DST: 'resets 3am' read the evening before fall back is 03:00 EST, not 02:00" "$(lre "$(ep_in $NY '2026-10-31 23:00')" "⏺ You've hit your limit · resets 3am ($NY)")" "$(ep_in $NY '2026-11-01 03:00')"
eq_ep "DST: 'resets 3pm' read the evening before spring forward is 15:00 EDT, not 16:00" "$(lre "$(ep_in $NY '2026-03-07 20:00')" "⏺ You've hit your limit · resets 3pm ($NY)")" "$(ep_in $NY '2026-03-08 15:00')"
eq_ep "DST: 'resets 11:45pm' read at 00:30 on fall-back day passed 45 min ago (due now)" "$(lre "$(ep_in $NY '2026-11-01 00:30')" "⏺ You've hit your limit · resets 11:45pm ($NY)")" "$(ep_in $NY '2026-10-31 23:45')"
eq_ep "no DST: 'resets 9pm' read at 20:00 is 21:00 today" "$(lre "$(ep_in $NY '2026-06-10 20:00')" "⏺ You've hit your limit · resets 9pm ($NY)")" "$(ep_in $NY '2026-06-10 21:00')"
eq_ep "a clock-only time 13 h ahead is today's, not passed" "$(lre "$(ep_in $NY '2026-06-10 08:00')" "⏺ You've hit your limit · resets 9pm ($NY)")" "$(ep_in $NY '2026-06-10 21:00')"
eq_ep "a dated reset in the zone" "$(lre "$(ep_in UTC '2026-10-18 12:00')" "⏺ You've hit your limit · resets Oct 20, 9:30pm (UTC)")" "$(ep_in UTC '2026-10-20 21:30')"
# engsys#257: the parse is locale-independent (%b/%p need LC_ALL=C); a non-English locale reads the same instants.
for loc in fr_FR.UTF-8 de_DE.UTF-8; do
  locale -a 2>/dev/null | grep -x "$loc" >/dev/null || continue   # no -q: an early exit SIGPIPEs locale under pipefail
  eq_ep "locale $loc: a dated reset reads the same" "$(LC_ALL="$loc" LANG="$loc" lre "$(ep_in UTC '2026-10-18 12:00')" "⏺ You've hit your limit · resets Oct 20, 9:30pm (UTC)")" "$(ep_in UTC '2026-10-20 21:30')"
  eq_ep "locale $loc: a clock-only reset across DST reads the same" "$(LC_ALL="$loc" LANG="$loc" lre "$(ep_in $NY '2026-10-31 23:00')" "⏺ You've hit your limit · resets 3am ($NY)")" "$(ep_in $NY '2026-11-01 03:00')"
done
# the fixture wordings, at every hour of a day: always read as due (passed within the hour) or ahead (within a day), never
# unreadable and never tomorrow's-by-mistake; a 24 h sweep, because a wall-clock fixture is "just passed" once a day
sweep_bad=0
# fixture: <line>|<target second of the UTC day>, or |local for the host-local one (range only)
for hh in 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23; do
  now="$(ep_in UTC "2026-10-18 $hh:30")"
  for fx in "⏺ You've hit your limit · resets 9pm ($NY)|3600" "⏺ You've hit your weekly limit · resets 5am|local" "⏺ You've hit your Opus limit · resets 3pm (UTC)|54000" "⏺ You’ve hit your limit · resets 9pm (UTC)|75600" "⏺ Claude usage limit reached. Your limit will reset at 5pm (UTC)|61200"; do
    line="${fx%|*}" tgt="${fx##*|}"
    got="$(lre "$now" "$line")" || { sweep_bad=$((sweep_bad + 1)); echo "       unreadable at $hh:30Z: $line"; continue; }
    if [ "$tgt" = local ]; then
      if [ "$got" -lt $((now - 3600)) ] || [ "$got" -ge $((now + 86400)) ]; then sweep_bad=$((sweep_bad + 1)); echo "       out of range at $hh:30Z: $line ($((got - now)) s)"; fi
    else
      # exactly the first occurrence of that time of day at or after one hour ago
      base=$((now - 3600)); want=$((base + (tgt - base % 86400 + 86400) % 86400))
      if [ "$got" != "$want" ]; then sweep_bad=$((sweep_bad + 1)); echo "       at $hh:30Z: $line got $((got - now)) s from now, want $((want - now)) s"; fi
    fi
  done
done
eq_ep "24 h sweep: every fixture wording parses to a time within the last hour .. next day, at every hour" "$sweep_bad" 0

# every wording of the limit line parses and holds: session, weekly (no zone: the host's local time), Opus, the
# curly apostrophe, and "reset at"
# the clock is injected (noon in each line's own zone), so every one is deterministically "held until the reset"
for fx in "⏺ You've hit your limit · resets 9pm (America/New_York)|$NY" "⏺ You've hit your weekly limit · resets 5am|local" "⏺ You've hit your Opus limit · resets 3pm (UTC)|UTC" "⏺ You’ve hit your limit · resets 9pm (UTC)|UTC" "⏺ Claude usage limit reached. Your limit will reset at 5pm (UTC)|UTC"; do
  line="${fx%|*}" z="${fx##*|}"
  if [ "$z" = local ]; then export SUPERVISOR_NOW_EPOCH="$(ep_local '2026-10-18 12:00')"; else export SUPERVISOR_NOW_EPOCH="$(ep_in "$z" '2026-10-18 12:00')"; fi
  hconf; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "$line"; run
  hold_has acme-rel "resume_at="
  expect "limit line parses and holds until the reset: $line" "^hold:acme-rel:resume_at"
  expect "  …not re-prompted" "!^sendkeys"
  expect "  …alerted too" "^notify --level alert --incident seat-limit"
done
unset SUPERVISOR_NOW_EPOCH
# a clock-only reset 13 h ahead is tomorrow-ish, not "passed": held until then (no re-prompt into the limit)
hconf "LIMIT_RESUME_MARGIN_SEC=0"; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lclock 780)"; run
resume_at="$(sed -n 's/^resume_at=//p' "$SLOG/acme-rel.limit-hold")"; d=$(( resume_at - $(date +%s) ))
if [ "$d" -ge 42000 ] && [ "$d" -le 48000 ]; then echo "held-13h" >>"$T/actions"; fi
expect "a clock-only reset 13 h ahead is held until then, not read as past" "^held-13h"
expect "  …and not re-prompted" "!^sendkeys"

# LIMIT_RESUME=off: alert only
hconf "LIMIT_RESUME=off"; qreset; launched_by_sup acme-rel; ledger2 90 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset 90)"; run
hold_gone acme-rel
expect "LIMIT_RESUME=off → no hold, alert only" "^nohold:acme-rel"

# the auth hold wins: a resume that is due waits for the login
hconf; qreset; launched_by_sup acme-rel; ledger2 2 "ok"; live acme-rel "⏺ You've hit your limit · $(lreset 90)"; run
mkhold_due acme-rel; wpane acme-w "⏺ Login expired · Please run /login"; run
expect "resume due while the login is expired → held, not re-prompted" "!^sendkeys"
rm -f "$T"/pane-* "$T"/capture-*

# engsys#236: a failed relaunch is alerted once via NOTIFY_CMD (not only on the ledger), and resolved on recovery
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/launch.sh\nNOTIFY_CMD=bash %s/notify.sh\nAUTH_CHECK_WAIT_SEC=0\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; rm -f "$T/notify-fail"; ledger 90 "ok — merging #12"; pane exited; touch "$T/launch-fail"; run
expect "236: launcher fails → one alert via NOTIFY_CMD, with its error" "^notify --level alert --incident launch-failed-acme-mm fleet-supervisor: relaunch of .acme-mm. on .* FAILED (.*): error: claude not found on PATH"
expect "  …and the ledger escalation as before" "comment 1: .*relaunch of .acme-mm. FAILED"
run
expect "236: still failing next tick → no second alert" "!^notify"
rm -f "$T/launch-fail"; run
expect "236: launcher works again → the alert is resolved" "^notify --level info --incident launch-failed-acme-mm --resolve Resolved: .acme-mm. relaunched on"
ledger 90 "ok — merging #12"; pane exited; run
expect "  …once" "!^notify"
reset; touch "$T/launch-fail"; ledger 90 "ok — merging #12"; pane exited; run
rm -f "$T/launch-fail"; pane idle; ledger 2 "ok — merging #12"; run   # an operator started it by hand
expect "236: a session seen running resolves its launch-failed alert, however it started" "^notify --level info --incident launch-failed-acme-mm --resolve Resolved: .acme-mm. is running on"
run
expect "  …once" "!^notify"
reset; touch "$T/notify-fail" "$T/launch-fail"; ledger 90 "ok — merging #12"; pane exited; run
rm -f "$T/notify-fail"; run
expect "236: an alert that could not be delivered is retried next tick" "^notify --level alert --incident launch-failed-acme-mm"
rm -f "$T/launch-fail"

# engsys#236 end to end: the real launcher, whose new window's shell never runs the launch line (a fake tmux whose
# pane stays at zsh): the supervisor alerts and logs RELAUNCH FAILED, never "relaunched"
LAUNCHER="$HERE/launch-agent-sessions.sh"
mkdir -p "$T/lbin" "$T/home"
cat >"$T/lbin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  list-windows) exit 0 ;;
  has-session) exit 1 ;;
  send-keys) echo "lsend $4" >>"$FAKE/actions" ;;
  list-panes) echo zsh ;;
  capture-pane) echo "% " ;;
  kill-window) echo "lkill $3" >>"$FAKE/actions" ;;
esac
exit 0
SH
chmod +x "$T/lbin/tmux"
printf 'NAMESPACE=acme\nacme-mm|%s|/merge-monster|--model opus --remote-control\n' "$T/w" >"$T/w/real.roster"
printf '#!/usr/bin/env bash\nexport PATH="$FAKE/lbin:$PATH" HOME="$FAKE/home" LAUNCH_START_TIMEOUT_SEC=1\nunset ENGSYS_LAUNCH_DIR XDG_STATE_HOME\ncd "$FAKE/w" && exec bash %q --roster "$FAKE/w/real.roster" "$@"\n' "$LAUNCHER" >"$T/real-launch.sh"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=bash %s/real-launch.sh\nNOTIFY_CMD=bash %s/notify.sh\nAUTH_CHECK_WAIT_SEC=0\nREPO=o/r\nacme-mm|1|60\n' "$T" "$T" >"$T/w/sup.conf"
reset; rm -f "$T/notify-fail"; ledger 90 "ok — merging #12"; pane exited; run
expect "236 e2e: the real launcher types only a short line" "^lsend \. /.*/home/.local/state/engsys/launch/acme-mm\.[^ ]*$"
expect "  …the launch never starts → the supervisor alerts" "^notify --level alert --incident launch-failed-acme-mm .*error: launch did not start for 'acme-mm' within 1s: the launch line has not reached the harness yet"
expect "  …the launcher closed the window it opened" "^lkill acme:acme-mm"
expect "  …and the ledger says FAILED" "comment 1: .*relaunch of .acme-mm. FAILED"
expect "  …never a relaunched comment" "!fleet-supervisor: relaunched"
grep -q "acme-mm: RELAUNCH FAILED (error: launch did not start for 'acme-mm'" "$T/w/logs/fleet-supervisor/supervisor.log" && echo "log-failed" >>"$T/actions"
grep -q "acme-mm: relaunched" "$T/w/logs/fleet-supervisor/supervisor.log" && echo "log-relaunched" >>"$T/actions"
expect "  …the log says RELAUNCH FAILED with the reason" "^log-failed"
expect "  …and never 'relaunched'" "!^log-relaunched"
[ -z "$(ls -A "$T/home/.local/state/engsys/launch" 2>/dev/null)" ] && echo "no-launch-file" >>"$T/actions"
expect "  …and no launch file is left behind" "^no-launch-file"

# launch-agent-sessions.sh harness policy and flag translation: launch-agent-sessions.test.sh.

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
