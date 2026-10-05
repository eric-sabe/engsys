#!/usr/bin/env bash
# host-roles.test.sh — sandbox tests for the per-host role filter (run by `npm test`; no network, no real
# tmux/claude/gh/launchctl).
#
# Covers lib/host-roles.sh and every command that honors it: ROLES / ROSTER_EXCLUDE in fleet.local.conf,
# the registry default (a merge/maintain monster whose home is another fleet is excluded with no config),
# `fleet launch` (no name, an explicit name, --force-excluded, --check), `fleet restart`, `fleet status`,
# `fleet install-jobs`, `fleet sync` and the supervisor (filtered conf, and HOST_CHECK_CMD against a
# stale conf). Single-fleet mode with no filter must behave exactly as before.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_SRC="$(cd "$HERE/.." && pwd -P)"      # core/fleet
CORE_SRC="$(cd "$KIT_SRC/.." && pwd -P)"  # core
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

command -v node >/dev/null || { echo "host-roles.test.sh: node is required" >&2; exit 1; }
unset FLEET_ID FEDERATION_FILE ROLES ROSTER_EXCLUDE SLACK_ENV NOTIFY_FALLBACK_ISSUE GH_APP_ENV
: >"$FAKE/tmux.log"; : >"$FAKE/gh.log"; : >"$FAKE/launchctl.log"; : >"$FAKE/claude.log"

# --- stubs -----------------------------------------------------------------------------------
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
# stub tmux: windows/panes live in $FAKE/tmux/ (windows, cmd-<w>, cap-<w>, session)
F="$FAKE/tmux"; mkdir -p "$F"; touch "$F/windows"
{ printf 'tmux'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >>"$FAKE/tmux.log"
sub="${1:-}"; shift || true
t="" fmt="" nm="" prev=""
for a in "$@"; do
  case "$prev" in -t) t="$a" ;; -F) fmt="$a" ;; -n) nm="$a" ;; esac
  prev="$a"
done
w="${t#*:}"
add_window() { grep -Fxq "$1" "$F/windows" || echo "$1" >>"$F/windows"; echo node >"$F/cmd-$1"; }
case "$sub" in
  list-windows) cat "$F/windows" ;;
  list-panes) case "$fmt" in *pane_pid*) exit 1 ;; *) cat "$F/cmd-$w" 2>/dev/null || exit 1 ;; esac ;;
  capture-pane) cat "$F/cap-$w" 2>/dev/null || true ;;
  has-session) [ -f "$F/session" ] || exit 1 ;;
  new-session) touch "$F/session"; add_window "$nm" ;;
  new-window) add_window "$nm" ;;
  kill-window) grep -Fxv "$w" "$F/windows" >"$F/windows.new" || true; mv "$F/windows.new" "$F/windows"; rm -f "$F/cmd-$w" ;;
esac
exit 0
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
case "${1:-} ${2:-}" in
  "issue view") cat "$FAKE/ledger-$3.json" ;;
esac
exit 0
SH
cat >"$T/bin/launchctl" <<'SH'
#!/usr/bin/env bash
# stub launchctl: a label is "loaded" while $FAKE/loaded/<label> exists
echo "launchctl $*" >>"$FAKE/launchctl.log"
mkdir -p "$FAKE/loaded"
case "${1:-}" in
  bootout) l="${2##*/}"; [ -f "$FAKE/loaded/$l" ] || exit 3; rm -f "$FAKE/loaded/$l" ;;
  bootstrap) l="$(basename "$3" .plist)"; touch "$FAKE/loaded/$l" ;;
esac
exit 0
SH
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
# stub claude: just enough of `plugin` for fleet sync (one marketplace, its ref in $FAKE/mk-ref)
echo "claude $*" >>"$FAKE/claude.log"
case "$*" in
  "plugin list --json") echo '[{"id":"core@engsys"}]' ;;
  "plugin marketplace list --json") r="$(cat "$FAKE/mk-ref" 2>/dev/null || true)"; [ -z "$r" ] && echo '[]' || echo "[{\"name\":\"engsys\",\"ref\":\"$r\"}]" ;;
  "plugin marketplace remove engsys") rm -f "$FAKE/mk-ref" ;;
  "plugin marketplace add "*) echo "${3#*#}" >"$FAKE/mk-ref" ;;
  "plugin install "*) ;;
esac
exit 0
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- engsys (the kit, run from a tagged host checkout like a real host), pin repo, instance ------
E="$T/seed/engsys"
seed_repo vendor/engsys "$E"
mkdir -p "$E/core/skills"
cp -R "$KIT_SRC" "$E/core/fleet"; rm -rf "$E/core/fleet/test"
cp -R "$CORE_SRC/lib" "$E/core/lib"
cp -R "$CORE_SRC/skills/agent-sessions" "$E/core/skills/agent-sessions"
commit_all "$E" "engsys 1.0.0"; git -C "$E" tag v1.0.0
sed -i.bak 's/Every 5 minutes\./Every 5 minutes (kit 1.1.0)./' "$E/core/fleet/jobs/launchd/fleet-supervisor.plist.tmpl"; rm -f "$E/core/fleet/jobs/launchd/"*.bak
commit_all "$E" "engsys 1.1.0"; git -C "$E" tag v1.1.0
push_all "$E"
# `fleet verify` (which gates the merge and maintain monsters) checks the plugin against these tags.
# shellcheck source=fake-release.sh
. "$HERE/fake-release.sh"
fake_release "$T/remotes/vendor/engsys.git"
git clone -q https://github.com/vendor/engsys.git "$HOME/git/engsys"
git -C "$HOME/git/engsys" checkout -q v1.1.0
EH="$HOME/git/engsys"

P="$T/seed/app"
seed_repo acme/app "$P"
mkdir -p "$P/.claude"
pins() { # pins <engsys-ref>
  jq -n --arg e "$1" '{extraKnownMarketplaces: {engsys: {source: {source: "github", repo: "vendor/engsys", ref: $e}}},
    enabledPlugins: {"core@engsys": true}}' >"$P/.claude/settings.json"
}
pins v1.1.0; commit_all "$P" "pins"; push_all "$P"
git clone -q https://github.com/acme/app.git "$HOME/git/app"

I="$T/instance"
mkdir -p "$I/fleet/env"
printf 'FLEET_ORG=acme\nPIN_REPO=acme/app\nPIN_DIR=~/git/app\n' >"$I/fleet/fleet.conf"
printf 'LANE=session\n' >"$I/fleet/env/session.env.tmpl"
cat >"$I/fleet/roster.tmpl" <<'EOF'
NAMESPACE=acme
ENV_FILE=__ENV_DIR__/session.env
acme-mm|__PIN_DIR__|/engsys:merge-monster|--dangerously-skip-permissions
acme-maintain|__PIN_DIR__|/engsys:maintenance-monster|--dangerously-skip-permissions
acme-broker|__PIN_DIR__|/engsys:resource-broker|--dangerously-skip-permissions
acme-odd|__PIN_DIR__|/custom-watch|--dangerously-skip-permissions
acme-build|__PIN_DIR__||--remote-control
acme-design|__PIN_DIR__||--remote-control
EOF
printf 'REPO=acme/app\nacme-mm|11|60\nacme-maintain|12|60\nacme-broker|13|60\nacme-odd|14|60\n' >"$I/fleet/supervisor.conf.tmpl"
STATE="$I/.fleet"
LOCAL="$HOME/.config/acme/fleet.local.conf"
LA="$HOME/Library/LaunchAgents"
SUP_PLIST="$LA/com.acme.fleet.fleet-supervisor.plist"

fleet() { bash "$EH/core/fleet/bin/fleet" --instance "$I" "$@"; }
local_conf() { if [ $# -eq 0 ]; then rm -f "$LOCAL"; else printf '%s\n' "$@" >"$LOCAL"; fi; }
conf() { printf 'FLEET_ORG=acme\nPIN_REPO=acme/app\nPIN_DIR=~/git/app\n' >"$I/fleet/fleet.conf"; for l in "$@"; do printf '%s\n' "$l" >>"$I/fleet/fleet.conf"; done; }
registry() { # registry <merge home> <maintain home> [repo]
  cat >"$I/federation.yml" <<EOF
version: 1
fleets:
  alice:
    enabled: true
  bob:
    enabled: true
repos:
  ${3:-acme/app}:
    merge: { home: $1, ledger: 11 }
    maintain: { home: $2, ledger: 12 }
EOF
}
no_registry() { rm -f "$I/federation.yml"; }
reset_tmux() { rm -rf "$FAKE/tmux"; mkdir -p "$FAKE/tmux"; : >"$FAKE/tmux/windows"; : >"$FAKE/tmux.log"; }
windows() { sort "$FAKE/tmux/windows" | paste -sd' ' -; }
iso() { date -u -r "$(($(date +%s) - $1 * 60))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(($(date +%s) - $1 * 60))" +%Y-%m-%dT%H:%M:%SZ; }
stale_ledgers() { local n; for n in 11 12 13 14; do jq -n --arg b "last: $(iso 300) — status: working" '{state: "OPEN", body: $b}' >"$FAKE/ledger-$n.json"; done; }
checks() { # checks → "name:0|1 ..." for every roster session (fleet launch --check exit codes)
  local n out=""
  for n in acme-mm acme-maintain acme-broker acme-odd acme-build acme-design; do
    if fleet launch --check "$n" >/dev/null 2>&1; then out="$out $n:0"; else out="$out $n:1"; fi
  done
  echo "${out# }"
}
ALL_RUN="acme-mm:0 acme-maintain:0 acme-broker:0 acme-odd:0 acme-build:0 acme-design:0"

# =============================================================================================
echo "== A. single-fleet mode, no filter: unchanged"
conf; local_conf; no_registry; reset_tmux
eq "every session runs here" "$(checks)" "$ALL_RUN"
run fleet launch --check acme-mm
rc_is "--check exits 0 for a session that runs here" 0; has "…saying so" "$OUT" "acme-mm: runs on this host"
run fleet launch --check acme-nope
rc_is "--check of a name not in the roster exits 1" 1
run fleet launch
rc_is "launch exits 0" 0
hasnt "nothing is skipped" "$OUT" "skip: "
eq "all six sessions launched" "$(windows)" "acme-broker acme-build acme-design acme-maintain acme-mm acme-odd"
run fleet restart --status
hasnt "status: no 'not on this host'" "$OUT" "not on this host"
hasnt "status: no warnings" "$OUT" "WARNING"
run fleet install-jobs --dry-run --only fleet-supervisor
has "the supervisor job renders" "$OUT" "===== would write $SUP_PLIST"
conf FLEET_ID=bob
eq "FLEET_ID without a registry file: still unchanged" "$(checks)" "$ALL_RUN"
conf; registry alice alice
run fleet launch --check acme-mm
rc_is "a registry without FLEET_ID: still unchanged" 0
no_registry

echo "== B. registry: a monster whose home is another fleet is excluded with no config"
conf FLEET_ID=bob; registry alice alice; local_conf; reset_tmux
eq "merge + maintain excluded; broker, unknown monster and interactive roles run" "$(checks)" \
  "acme-mm:1 acme-maintain:1 acme-broker:0 acme-odd:0 acme-build:0 acme-design:0"
run fleet launch --check acme-mm
rc_is "--check exits 1 for an excluded session" 1
has "…naming the registry home" "$OUT" "acme-mm: not on this host (merge home for acme/app is fleet alice)"
run fleet launch
rc_is "launch exits 0" 0
has "launch says what it skipped" "$OUT" "skip: acme-mm is not on this host (merge home for acme/app is fleet alice)"
has "…both monsters" "$OUT" "skip: acme-maintain is not on this host (maintain home for acme/app is fleet alice)"
eq "only the sessions on this host have windows" "$(windows)" "acme-broker acme-build acme-design acme-odd"
has "the host roster marks the excluded lines" "$(cat "$STATE/roster.host")" "# not on this host: acme-mm"
has "the full rendered roster is still written" "$(cat "$STATE/roster")" "acme-mm|$HOME/git/app|/engsys:merge-monster"
: >"$FAKE/tmux.log"
run fleet launch acme-mm
rc_is "an explicit name of an excluded session is refused" 1
has "…with the reason and the override" "$OUT" "acme-mm is not on this host (merge home for acme/app is fleet alice). To start it here anyway: fleet launch acme-mm --force-excluded"
eq "…and nothing reached tmux" "$(cat "$FAKE/tmux.log")" ""
run fleet launch --force-excluded
rc_is "--force-excluded without a name is refused" 1
has "…it never applies to a whole-roster launch" "$OUT" "--force-excluded needs a session name"

run fleet restart --status
matches "status: an excluded monster is 'not on this host', not missing" "$OUT" '^acme-mm +monster +not on this host \(merge home for acme/app is fleet alice\)$'
matches "status: …the other one too" "$OUT" '^acme-maintain +monster +not on this host'
hasnt "status: nothing is reported missing" "$OUT" "missing"
has "status: the unplaceable monster is warned about" "$OUT" "WARNING acme-odd is supervised but its roster prompt names no known monster"
run fleet status
has "fleet status carries the same rows" "$OUT" "not on this host (merge home for acme/app is fleet alice)"

: >"$FAKE/tmux.log"
run fleet restart --all
has "restart --all leaves excluded sessions alone" "$OUT" "not on this host, left alone: acme-mm acme-maintain"
hasnt "…and never relaunches them" "$(cat "$FAKE/tmux.log")" "[acme-mm]"
run fleet restart acme-mm
has "restart <excluded name> is skipped" "$OUT" "acme-mm: not on this host (merge home for acme/app is fleet alice), skipped"

run fleet launch acme-mm --force-excluded
rc_is "--force-excluded launches it anyway" 0
has "…with a warning" "$OUT" "WARNING launching acme-mm although it is not on this host"
has "…in its own window" "$(windows)" "acme-mm"
run fleet restart --status
matches "status: a forced window shows its state and the note" "$OUT" '^acme-mm +monster +idle .*window present, but not on this host'
echo $(($(date +%s) + 1000)) >"$STATE/last-change"; : >"$FAKE/tmux.log"
run fleet restart --stale
hasnt "restart --stale never cycles an excluded session" "$(cat "$FAKE/tmux.log")" "[acme:acme-mm]"
rm -f "$STATE/last-change"

echo "== B2. registry variations"
registry alice bob
eq "maintain home is this fleet: it runs, merge doesn't" "$(checks | cut -d' ' -f1-2)" "acme-mm:1 acme-maintain:0"
registry bob bob
eq "home of both: everything runs" "$(checks)" "$ALL_RUN"
registry alice alice acme/other
eq "no role declared for the monster's repo: not excluded" "$(checks | cut -d' ' -f1-2)" "acme-mm:0 acme-maintain:0"
run fleet restart --status
has "…but status warns" "$OUT" "WARNING acme-mm runs the merge monster, but the registry declares no merge role for acme/app"
printf 'REPO=acme/app\nacme-mm|11|60|acme/other\nacme-maintain|12|60\nacme-broker|13|60\nacme-odd|14|60\n' >"$I/fleet/supervisor.conf.tmpl"
eq "the supervisor conf's 4th field names the monster's repo" "$(checks | cut -d' ' -f1-2)" "acme-mm:1 acme-maintain:0"
printf 'REPO=acme/app\nacme-mm|11|60\nacme-maintain|12|60\nacme-broker|13|60\nacme-odd|14|60\n' >"$I/fleet/supervisor.conf.tmpl"
conf FLEET_ID=carol; registry carol carol
sed -i.bak '/^  bob:/,/^    enabled/d; s/^  alice:/  dave:/' "$I/federation.yml"; rm -f "$I/federation.yml.bak"
eq "FLEET_ID not declared in the registry: singleton monsters excluded" "$(checks | cut -d' ' -f1-3)" "acme-mm:1 acme-maintain:1 acme-broker:0"
conf FLEET_ID=bob
printf 'version: 1\nfleets: [unterminated\n' >"$I/federation.yml"
eq "an unreadable registry: singleton monsters excluded (fail closed)" "$(checks)" \
  "acme-mm:1 acme-maintain:1 acme-broker:0 acme-odd:0 acme-build:0 acme-design:0"
run fleet launch --check acme-mm
has "…saying why" "$OUT" "registry unreadable; no singleton monster starts here"
run fleet restart --status
has "…and status warns" "$OUT" "WARNING registry unreadable"

echo "== B3. enabled: false in the registry (the per-fleet kill switch)"
conf FLEET_ID=bob; registry bob bob
sed -i.bak '/^  bob:/,/^    enabled/s/enabled: true/enabled: false/' "$I/federation.yml"; rm -f "$I/federation.yml.bak"
eq "every monster off, interactive roles untouched" "$(checks)" "acme-mm:1 acme-maintain:1 acme-broker:1 acme-odd:1 acme-build:0 acme-design:0"
run fleet launch --check acme-broker
has "…reason" "$OUT" "acme-broker: not on this host (fleet bob disabled in registry)"
run fleet restart --status
matches "status shows it" "$OUT" '^acme-maintain +monster +not on this host \(fleet bob disabled in registry\)$'
has "…and warns once" "$OUT" "WARNING fleet bob is disabled in the registry (enabled: false)"
run fleet launch --host-health
rc_is "a disabled fleet is deliberate: no registry alert" 0
conf FLEET_ID=alice
eq "another fleet's enabled: false changes nothing here (alice is home of nothing)" "$(checks | cut -d' ' -f1-3)" "acme-mm:1 acme-maintain:1 acme-broker:0"

echo "== B4. an unreadable registry raises one alert from the supervisor, resolved on recovery"
conf FLEET_ID=bob NOTIFY_FALLBACK_ISSUE=acme/app#99; local_conf; registry bob bob
run fleet launch --host-health
rc_is "a readable registry: --host-health exits 0" 0
printf 'version: 1\nfleets: [unterminated\n' >"$I/federation.yml"
run fleet launch --host-health
rc_is "an unreadable registry: --host-health exits 1" 1
has "…naming the validator's first error" "$OUT" "cannot be read on this host: federation:"
has "…what is paused" "$OUT" "Paused: merge/maintain (acme-mm acme-maintain) will not be relaunched on this host"
has "…and what to do" "$OUT" "correct federation.yml by PR"
has "…including the emergency override" "$OUT" "fleet launch <name> --force-excluded"
reset_tmux; stale_ledgers; : >"$FAKE/gh.log"; rm -rf "$I/logs" "$STATE/notify"
run fleet supervise
rc_is "supervise exits 0" 0
has "conf: HOST_HEALTH_CMD points at fleet launch --host-health" "$(cat "$STATE/supervisor.conf")" "HOST_HEALTH_CMD=bash $EH/core/fleet/bin/fleet --instance $I launch --host-health"
has "conf: the incident key" "$(cat "$STATE/supervisor.conf")" "HOST_HEALTH_INCIDENT=fleet-registry-unreadable"
eq "the alert went out once (here through fleet notify's GitHub fallback)" "$(grep -c 'issue comment 99 -R acme/app' "$FAKE/gh.log")" 1
has "…carrying the text" "$(grep 'issue comment 99' "$FAKE/gh.log")" "will not be relaunched on this host"
run fleet supervise
eq "next tick: no repeat" "$(grep -c 'issue comment 99 -R acme/app' "$FAKE/gh.log")" 1
registry bob bob
run fleet supervise
[ ! -e "$I/logs/fleet-supervisor/host-health.alerted" ] && ok "registry fixed: the alert latch is cleared" || bad "registry fixed: the alert latch is cleared"
has "…and the resolve logged" "$(cat "$I/logs/fleet-supervisor/supervisor.log")" "alert fleet-registry-unreadable resolved"
printf 'version: 1\nfleets: [unterminated\n' >"$I/federation.yml"; local_conf ROLES=merge,maintain; : >"$FAKE/gh.log"
run fleet supervise
eq "nothing else to supervise: the alert still goes out" "$(grep -c 'issue comment 99 -R acme/app' "$FAKE/gh.log")" 1
registry alice alice
run fleet supervise
[ ! -e "$I/logs/fleet-supervisor/host-health.alerted" ] && ok "…and is resolved even when the fix leaves nothing to supervise" || bad "…and is resolved even when the fix leaves nothing to supervise"
run fleet supervise
has "with nothing to supervise and no open alert, the tick is a no-op again" "$OUT" "nothing to do"
local_conf; registry bob bob; conf FLEET_ID=bob

echo "== C. ROLES and ROSTER_EXCLUDE in fleet.local.conf (single-fleet)"
conf; no_registry
local_conf ROLES=build,design
eq "ROLES by name without the namespace" "$(checks)" "acme-mm:1 acme-maintain:1 acme-broker:1 acme-odd:1 acme-build:0 acme-design:0"
run fleet launch --check acme-broker
has "…reason" "$OUT" "acme-broker: not on this host (not in ROLES)"
local_conf "ROLES=acme-build acme-mm"
eq "ROLES by full name, space separated" "$(checks)" "acme-mm:0 acme-maintain:1 acme-broker:1 acme-odd:1 acme-build:0 acme-design:1"
local_conf ROLES=interactive
eq "ROLES=interactive" "$(checks)" "acme-mm:1 acme-maintain:1 acme-broker:1 acme-odd:1 acme-build:0 acme-design:0"
local_conf ROLES=monster
eq "ROLES=monster (every supervised or monster-prompt session)" "$(checks)" "acme-mm:0 acme-maintain:0 acme-broker:0 acme-odd:0 acme-build:1 acme-design:1"
local_conf ROLES=merge,broker
eq "ROLES by monster kind" "$(checks)" "acme-mm:0 acme-maintain:1 acme-broker:0 acme-odd:1 acme-build:1 acme-design:1"
local_conf ROSTER_EXCLUDE=acme-broker,maintain
eq "ROSTER_EXCLUDE alone" "$(checks)" "acme-mm:0 acme-maintain:1 acme-broker:1 acme-odd:0 acme-build:0 acme-design:0"
run fleet launch --check acme-broker
has "…reason" "$OUT" "not on this host (ROSTER_EXCLUDE lists acme-broker)"
local_conf ROLES=monster ROSTER_EXCLUDE=broker
eq "both: ROSTER_EXCLUDE wins over ROLES" "$(checks)" "acme-mm:0 acme-maintain:0 acme-broker:1 acme-odd:0 acme-build:1 acme-design:1"
local_conf ROLES=build,desing
run fleet restart --status
has "a ROLES entry matching nothing is warned about" "$OUT" "WARNING ROLES/ROSTER_EXCLUDE entry 'desing' matches no roster session"
local_conf
ROLES=build run fleet launch --check acme-mm
rc_is "ROLES from the caller's environment is ignored (config files only)" 0
conf ROLES=build
run fleet launch --check acme-mm
rc_is "fleet.conf can set it too (fleet.local.conf overrides it)" 1
conf
conf FLEET_ID=bob; registry alice alice; local_conf ROLES=merge,build
run fleet launch --check acme-mm
rc_is "ROLES cannot override the registry" 1
has "…the registry reason wins" "$OUT" "merge home for acme/app is fleet alice"

echo "== D. supervise: a filtered conf, and nothing to do when nothing is left"
conf FLEET_ID=bob; registry alice alice; local_conf; reset_tmux; stale_ledgers; : >"$FAKE/gh.log"
run fleet supervise
rc_is "supervise exits 0" 0
SUP="$(cat "$STATE/supervisor.conf")"
has "conf: excluded sessions are dropped" "$SUP" "# not on this host: acme-mm (merge home for acme/app is fleet alice)"
hasnt "conf: …no line for them" "$SUP" "acme-mm|11|60"
has "conf: the rest stay" "$SUP" "acme-odd|14|60"
has "conf: multi-fleet with no status issue for this fleet: the broker is not supervised on the shared ledger" "$SUP" "# broker not supervised: acme-broker (status issue unresolved: fleets.bob.status_issue is not declared"
hasnt "conf: …no line on ledger 13" "$SUP" "acme-broker|13|60"
has "…and the tick warns" "$OUT" "WARNING acme-broker not supervised: fleet bob's status issue can't be resolved"
has "conf: HOST_CHECK_CMD points at fleet launch --check" "$SUP" "HOST_CHECK_CMD=bash $EH/core/fleet/bin/fleet --instance $I launch --check"
hasnt "the excluded monsters' ledgers are never read" "$(cat "$FAKE/gh.log")" "issue view 11"
hasnt "…and never commented on" "$(cat "$FAKE/gh.log")" "issue comment 12"
hasnt "a stale excluded monster is not relaunched" "$(windows)" "acme-mm"
has "a stale monster this host runs is relaunched" "$(windows)" "acme-odd"
hasnt "the unsupervised broker is not" "$(windows)" "acme-broker"
# bob declares its status issue: the broker's line now points at it, read through its own block (#54)
sed -i.bak 's/^  bob:/  bob:\n    status_issue: 22/' "$I/federation.yml"; rm -f "$I/federation.yml.bak"
conf FLEET_ID=bob FLEET_INSTANCE_REPO=acme/acme-fleet; reset_tmux; stale_ledgers; : >"$FAKE/gh.log"
jq -n --arg b "<!-- fleet-heartbeat -->
last: $(iso 1) — status: 2 up
<!-- /fleet-heartbeat -->

<!-- broker-heartbeat -->
last: $(iso 300) — status: working
<!-- /broker-heartbeat -->" '{state: "OPEN", body: $b}' >"$FAKE/ledger-22.json"
run fleet supervise
rc_is "supervise with a status issue exits 0" 0
SUP="$(cat "$STATE/supervisor.conf")"
has "conf: the broker line is rewritten to the fleet's status issue and the broker block" "$SUP" "acme-broker|22|60|acme/acme-fleet|broker-heartbeat"
has "the status issue is read in the instance repo" "$(cat "$FAKE/gh.log")" "issue view 22 -R acme/acme-fleet"
hasnt "the shared ledger 13 is never read" "$(cat "$FAKE/gh.log")" "issue view 13"
has "a stale broker block is relaunched, the fresh fleet-heartbeat beside it notwithstanding" "$(windows)" "acme-broker"
conf; no_registry; reset_tmux; stale_ledgers
run fleet supervise
has "single-fleet: the broker stays on its ledger" "$(cat "$STATE/supervisor.conf")" "acme-broker|13|60"
conf FLEET_ID=bob; registry alice alice
local_conf ROLES=build,design; : >"$FAKE/gh.log"
run fleet supervise
rc_is "nothing left to supervise: exits 0" 0
has "…and says so" "$OUT" "no supervised session runs on this host"
eq "…without touching GitHub" "$(cat "$FAKE/gh.log")" ""

echo "== E. the supervisor never relaunches an excluded session, even from a stale conf"
reset_tmux; stale_ledgers; : >"$FAKE/gh.log"; mkdir -p "$T/sup"
LCMD="bash $EH/core/fleet/bin/fleet --instance $I launch"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=%s\nHOST_CHECK_CMD=%s --check\nREPO=acme/app\nacme-mm|11|60\nacme-build|15|60\n' "$LCMD" "$LCMD" >"$T/sup/stale.conf"
jq -n --arg b "last: $(iso 300) — status: working" '{state: "OPEN", body: $b}' >"$FAKE/ledger-15.json"
run bash -c "cd '$T/sup' && bash '$EH/core/skills/agent-sessions/scripts/fleet-supervisor.sh' stale.conf"
rc_is "the supervisor exits 0" 0
hasnt "stale conf + stale ledger: the excluded monster is never relaunched" "$(windows)" "acme-mm"
has "…the log says why" "$(cat "$T/sup/logs/fleet-supervisor/supervisor.log")" "acme-mm: not on this host, never touched here (acme-mm: not on this host (merge home for acme/app is fleet alice))"
hasnt "…its ledger is not read" "$(cat "$FAKE/gh.log")" "issue view 11"
has "a session the check allows is still handled" "$(windows)" "acme-build"
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=%s\nHOST_CHECK_CMD=false\nREPO=acme/app\nacme-build|15|60\n' "$LCMD" >"$T/sup/broken.conf"
reset_tmux; rm -rf "$T/sup/logs"
run bash -c "cd '$T/sup' && bash '$EH/core/skills/agent-sessions/scripts/fleet-supervisor.sh' broken.conf"
eq "a failing host check fails closed (nothing relaunched)" "$(windows)" ""
printf 'TMUX_SESSION=acme\nLAUNCH_CMD=%s\nREPO=acme/app\nacme-mm|11|60\n' "$LCMD" >"$T/sup/old.conf"
reset_tmux; rm -rf "$T/sup/logs"
run bash -c "cd '$T/sup' && bash '$EH/core/skills/agent-sessions/scripts/fleet-supervisor.sh' old.conf"
eq "a conf from before HOST_CHECK_CMD: fleet launch itself refuses the excluded session" "$(windows)" ""
has "…logged as a refused launch" "$(cat "$T/sup/logs/fleet-supervisor/supervisor.log")" "acme-mm is not on this host"

echo "== F. install-jobs: no supervisor where nothing is supervised"
conf FLEET_ID=bob; registry alice alice; local_conf ROLES=build,design
mkdir -p "$LA" "$FAKE/loaded"; echo old >"$SUP_PLIST"; touch "$FAKE/loaded/com.acme.fleet.fleet-supervisor"; : >"$FAKE/launchctl.log"
run fleet install-jobs --dry-run
has "dry-run: skipped with the reason" "$OUT" "skipped: com.acme.fleet.fleet-supervisor (no supervised session runs on this host; not on this host: acme-mm acme-maintain acme-broker acme-odd)"
has "dry-run: says it would unload" "$OUT" "would boot out com.acme.fleet.fleet-supervisor"
eq "dry-run: launchctl untouched" "$(cat "$FAKE/launchctl.log")" ""
[ -f "$SUP_PLIST" ] && ok "dry-run: plist left in place" || bad "dry-run: plist left in place"
run fleet install-jobs
rc_is "install-jobs exits 0" 0
has "a loaded supervisor is booted out" "$OUT" "booted out: com.acme.fleet.fleet-supervisor (it was loaded)"
has "…and its plist removed" "$OUT" "removed: $SUP_PLIST"
[ ! -e "$SUP_PLIST" ] && ok "plist gone" || bad "plist gone"
hasnt "the supervisor is never bootstrapped" "$(grep -F bootstrap "$FAKE/launchctl.log" || true)" "fleet-supervisor"
has "…while the relay job (multi-fleet mode) is" "$(cat "$FAKE/launchctl.log")" "com.acme.fleet.fleet-relay.plist"
run fleet install-jobs --only fleet-supervisor
has "--only: nothing loaded now" "$OUT" "not loaded: com.acme.fleet.fleet-supervisor"
local_conf ROLES=build,design,broker
run fleet install-jobs --only fleet-supervisor
has "one supervised session on this host: installed" "$OUT" "installed + loaded: com.acme.fleet.fleet-supervisor"
[ -f "$FAKE/loaded/com.acme.fleet.fleet-supervisor" ] && ok "…and loaded" || bad "…and loaded"

echo "== G. sync on a host with only interactive roles leaves the supervisor unloaded"
local_conf ROLES=build,design
git -C "$EH" checkout -q v1.0.0; echo v1.0.0 >"$FAKE/mk-ref"; : >"$FAKE/launchctl.log"
run fleet sync
rc_is "sync exits 0" 0
has "engsys moves to its pin" "$OUT" "engsys: v1.0.0 → v1.1.0"
has "the changed job template triggers a reinstall" "$OUT" "launchd templates changed — reinstalling jobs"
has "…which skips the supervisor" "$OUT" "skipped: com.acme.fleet.fleet-supervisor (no supervised session runs on this host"
has "…booting out the copy that was loaded" "$OUT" "booted out: com.acme.fleet.fleet-supervisor"
[ ! -e "$SUP_PLIST" ] && ok "no supervisor plist after sync" || bad "no supervisor plist after sync"
hasnt "the supervisor was never bootstrapped" "$(cat "$FAKE/launchctl.log")" "fleet-supervisor.plist"
echo old >"$SUP_PLIST"; touch "$FAKE/loaded/com.acme.fleet.fleet-supervisor"
run fleet sync
has "an in-sync sync still unloads a supervisor left installed" "$OUT" "no supervised session runs on this host: unloading it"
[ ! -e "$SUP_PLIST" ] && ok "…plist removed" || bad "…plist removed"
[ ! -e "$FAKE/loaded/com.acme.fleet.fleet-supervisor" ] && ok "…and unloaded" || bad "…and unloaded"
conf; no_registry; local_conf; echo old >"$SUP_PLIST"
run fleet sync
hasnt "single-fleet, no filter: sync leaves an installed supervisor alone" "$OUT" "unloading it"
[ -f "$SUP_PLIST" ] && ok "…plist kept" || bad "…plist kept"

# =============================================================================================
finish host-roles.test
