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

echo "monster-bus.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
