#!/usr/bin/env bash
# mm-baton.test.sh — the monsters' baton wiring in their scripts (engsys#62), offline: every case here
# is decided before any request (no baton in this session, or a lost one), so a fake gh that only logs
# proves nothing was written. The lease logic itself is tested in core/lib/lease/baton.test.mjs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MNT="$HERE/../../maintenance-monster/scripts"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state"
pass=0 fail=0
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" FAKE="$T" ENGSYS_SESSION=acme-mm ENGSYS_SESSION_RUN=r1
unset FLEET_ID FEDERATION_FILE GH_TOKEN GITHUB_TOKEN GH_APP_ENV_FILE

ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/       /'; }
run() { : >"$T/gh.log"; RC=0; OUT="$("$@" 2>&1)" || RC=$?; }
rc_is() { [ "$RC" = "$2" ] && ok "$1" || bad "$1 (exit $RC, want $2)" "$OUT"; }
has() { case "$OUT" in *"$2"*) ok "$1" ;; *) bad "$1" "$OUT" ;; esac; }
no_gh() { [ ! -s "$T/gh.log" ] && ok "$1" || bad "$1" "$(cat "$T/gh.log")"; }
lost() { printf '{"at":"2026-10-04T12:00:00.000Z","code":"lost"}\n' >"$T/state/baton-$1.lost"; }

echo "heartbeat"
run bash "$HERE/mm-heartbeat.sh" --repo acme/app --issue 7 --state-dir "$T/state" --status running
rc_is "no baton in this session → exit 5" 5
has "  …says so" "holds no merge baton; heartbeat not written"
no_gh "  …and never touches the ledger"
lost merge
run bash "$HERE/mm-heartbeat.sh" --repo acme/app --issue 7 --state-dir "$T/state" --status running
rc_is "a lost baton → exit 1" 1
has "  …BATON_LOST" "BATON_LOST merge"
no_gh "  …heartbeat not written"
lost maintain
run bash "$MNT/mnt-heartbeat.sh" --repo acme/app --issue 8 --state-dir "$T/state" --status running
rc_is "maintenance heartbeat: a lost baton → exit 1" 1
has "  …BATON_LOST maintain" "BATON_LOST maintain"
no_gh "  …heartbeat not written"
rm -f "$T/state"/baton-*

echo "baton wrappers"
run bash "$HERE/mm-baton.sh" guard --repo acme/app --state-dir "$T/state" -- gh pr ready 1
rc_is "mm-baton.sh runs bookkeeping ops only (guard is mm-act.sh)" 2
run bash "$HERE/mm-baton.sh" fence --repo acme/app --state-dir "$T/state" --role maintain
rc_is "mm-baton.sh fence with no baton → exit 5" 5
has "  …the role is always merge, whatever --role says" '"role":"merge"'
run bash "$MNT/mnt-baton.sh" fence --repo acme/app --state-dir "$T/state"
has "mnt-baton.sh speaks for maintain" '"role":"maintain"'

echo "fenced acts"
run bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" -- gh pr ready 12
rc_is "guard with no baton → exit 5" 5
no_gh "  …and the command never ran"
lost merge
run bash "$HERE/mm-act.sh" merge --repo acme/app --state-dir "$T/state" --pr 12 --sha "$(printf 'a%.0s' $(seq 40))" --method squash
rc_is "merge after a lost baton → exit 1" 1
has "  …refused before any request" '"code":"lost_earlier"'
run bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" -- gh pr merge 12
rc_is "gh pr merge is never run under guard" 2
run bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" -- rm -rf /
rc_is "guard runs gh or gate-request.sh only" 2
run bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" -- git push origin agent/1-x
rc_is "a guarded git push needs --pr or --new-branch" 2
run bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" --pr 5 -- git push --receive-pack=x origin agent/1-x
rc_is "  …and refuses any flag but --force-with-lease" 2
no_gh "  …nothing ran"
run bash "$MNT/mnt-act.sh" guard --repo acme/app --state-dir "$T/state" -- gh issue comment 3 --body x
rc_is "mnt-act.sh fences the maintain baton (none here) → exit 5" 5
no_gh "  …nothing ran"
run bash "$MNT/mnt-act.sh" merge --repo acme/app --state-dir "$T/state" --pr 1
rc_is "mnt-act.sh never merges" 2

rm -f "$T/state"/baton-*
printf '{"v":1,"holder":"alice:acme-mm","run":"r1","token":"11111111-1111-4111-8111-111111111111","deadlineMs":%s,"notBeforeMs":0}\n' "$(( ($(date +%s) + 600) * 1000 ))" >"$T/state/baton-merge.json"
run env FLEET_ID=alice bash "$HERE/mm-act.sh" guard --repo acme/app --state-dir "$T/state" -- gh pr ready 12
rc_is "a fence that can't reach GitHub (no token here) is an error, never held → exit 3" 3
case "$(cat "$T/gh.log")" in *"pr ready"*) bad "  …and the command never ran" "$(cat "$T/gh.log")" ;; *) ok "  …and the command never ran" ;; esac
run env FLEET_ID=alice bash "$HERE/mm-heartbeat.sh" --repo acme/app --issue 7 --state-dir "$T/state" --status running
rc_is "a renew that errors with no known local deadline → heartbeat not written, exit 3" 3
case "$(cat "$T/gh.log")" in *"issue edit"* | *"issue view"*) bad "  …the ledger untouched" "$(cat "$T/gh.log")" ;; *) ok "  …the ledger untouched" ;; esac
rm -f "$T/state"/baton-*

echo "watch bus"
lost merge
run bash "$HERE/mm-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
rc_is "mm-watch.sh exits at once on a lost baton" 0
no_gh "  …before polling anything"
has "  …and tells the Monitor (BATON_LOST from the marker, engsys#87)" "BATON_LOST merge lost"
lost maintain
run bash "$MNT/mnt-watch.sh" --repo acme/app --state-dir "$T/state" --interval 1
rc_is "mnt-watch.sh too" 0
no_gh "  …before polling anything"
has "  …BATON_LOST maintain" "BATON_LOST maintain lost"

echo "mm-baton.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
