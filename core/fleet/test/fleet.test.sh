#!/usr/bin/env bash
# fleet.test.sh — sandbox tests for the fleet kit (run by `npm test`; no network, no real tmux/claude/gh).
#
# Everything is local: a temp HOME whose git config rewrites https://github.com/ to bare remotes
# under the sandbox, plus stub `claude`, `gh`, `tmux`, `cr` and `launchctl` on PATH that log every
# call (and keep their state in files). The kit under test runs from a sandbox "engsys" checkout that
# is built from this tree and tagged, exactly like a real host runs it from the pinned checkout.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_SRC="$(cd "$HERE/.." && pwd -P)"      # core/fleet
CORE_SRC="$(cd "$KIT_SRC/.." && pwd -P)"  # core
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

: >"$FAKE/shim.log"; : >"$FAKE/claude.log"; : >"$FAKE/tmux.log"; : >"$FAKE/gh.log"; : >"$FAKE/cr.log"; : >"$FAKE/launchctl.log"

# --- stubs -----------------------------------------------------------------------------------
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
# stub claude: plugin list|validate|install, plugin marketplace list|add|remove — state in $FAKE/claude/*.json
set -euo pipefail
S="$FAKE/claude"; mkdir -p "$S"
[ -f "$S/marketplaces.json" ] || echo '[]' >"$S/marketplaces.json"
[ -f "$S/plugins.json" ] || echo '[]' >"$S/plugins.json"
printf '%s\tPATH0=%s\n' "$*" "${PATH%%:*}" >>"$FAKE/claude.log"
[ "${1:-}" = plugin ] || { echo "stub claude: unsupported: $*" >&2; exit 2; }
shift
save() { local f="$1"; shift; jq "$@" "$f" >"$f.new" && mv "$f.new" "$f"; }
case "${1:-}" in
  list) cat "$S/plugins.json" ;;
  validate) echo "Validation passed" ;;
  install)
    id="$2"; m="${id#*@}"
    jq -e --arg m "$m" 'any(.[]; .name == $m)' "$S/marketplaces.json" >/dev/null || { echo "marketplace not found: $m" >&2; exit 1; }
    save "$S/plugins.json" --arg id "$id" '. + [{id: $id, version: "1.0.0", scope: "user", enabled: true}]' ;;
  marketplace)
    case "${2:-}" in
      list) cat "$S/marketplaces.json" ;;
      add)
        arg="$3"; url="${arg%%#*}"; ref=""
        case "$arg" in *'#'*) ref="${arg#*#}" ;; esac
        tmp="$(mktemp -d)"
        if [ -n "$ref" ]; then git clone -q --branch "$ref" "$url" "$tmp/mk"; else git clone -q "$url" "$tmp/mk"; fi
        name="$(jq -r .name "$tmp/mk/.claude-plugin/marketplace.json")"
        if jq -e --arg n "$name" 'any(.[]; .name == $n)' "$S/marketplaces.json" >/dev/null; then echo "marketplace $name already exists" >&2; exit 1; fi
        save "$S/marketplaces.json" --arg n "$name" --arg u "$url" --arg r "$ref" --arg l "$S/mk/$name" \
          '. + [{name: $n, source: "git", url: $u, ref: $r, installLocation: $l}]'
        rm -rf "$tmp" ;;
      remove)
        name="$3"
        save "$S/marketplaces.json" --arg n "$name" 'map(select(.name != $n))'
        save "$S/plugins.json" --arg n "$name" 'map(select(.id | endswith("@" + $n) | not))' ;;
      *) echo "stub claude: unsupported marketplace subcommand: $*" >&2; exit 2 ;;
    esac ;;
  *) echo "stub claude: unsupported: $*" >&2; exit 2 ;;
esac
SH
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
# stub tmux: windows/panes/pane text live in $FAKE/tmux/ (windows, cmd-<w>, pid-<w>, cap-<w>, session)
F="$FAKE/tmux"; mkdir -p "$F"; touch "$F/windows"
{ printf 'tmux'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >>"$FAKE/tmux.log"
sub="${1:-}"; shift || true
t="" fmt="" nm="" prev="" last=""
for a in "$@"; do
  case "$prev" in -t) t="$a" ;; -F) fmt="$a" ;; -n) nm="$a" ;; esac
  prev="$a"; last="$a"
done
w="${t#*:}"
add_window() { grep -Fxq "$1" "$F/windows" || echo "$1" >>"$F/windows"; echo node >"$F/cmd-$1"; }
case "$sub" in
  list-windows) cat "$F/windows" ;;
  list-panes)
    case "$fmt" in
      *pane_pid*) cat "$F/pid-$w" 2>/dev/null || exit 1 ;;
      *) cat "$F/cmd-$w" 2>/dev/null || exit 1 ;;
    esac ;;
  capture-pane) cat "$F/cap-$w" 2>/dev/null || true ;;
  has-session) [ -f "$F/session" ] || exit 1 ;;
  new-session) touch "$F/session"; add_window "$nm" ;;
  new-window) add_window "$nm" ;;
  kill-window) grep -Fxv "$w" "$F/windows" >"$F/windows.new" || true; mv "$F/windows.new" "$F/windows"; rm -f "$F/cmd-$w" "$F/pid-$w" "$F/cap-$w" ;;
  send-keys) if [ "$last" = "/exit" ]; then echo zsh >"$F/cmd-$w"; fi ;;
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
cat >"$T/bin/cr" <<'SH'
#!/usr/bin/env bash
echo "cr $*" >>"$FAKE/cr.log"
exit 0
SH
cat >"$T/bin/launchctl" <<'SH'
#!/usr/bin/env bash
echo "launchctl $*" >>"$FAKE/launchctl.log"
exit 0
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- remotes (seed_repo / commit_all / push_all come from sandbox.sh) ---

# engsys (the kit + the agent-sessions launcher), tagged v1.0.0 / v1.1.0 / v1.2.0
E="$T/seed/engsys"
seed_repo vendor/engsys "$E"
mkdir -p "$E/core/skills" "$E/.claude-plugin"
cp -R "$KIT_SRC" "$E/core/fleet"; rm -rf "$E/core/fleet/test"
cp -R "$CORE_SRC/lib" "$E/core/lib"   # federation.mjs (fleet status) reads gate-check's operator-source rules
cp -R "$CORE_SRC/skills/agent-sessions" "$E/core/skills/agent-sessions"
mkdir -p "$E/core/fleet/identity/bin"
cat >"$E/core/fleet/identity/git-env.sh" <<'SH'
# stub of the identity kit's interface: fleet_git_env <file> exports; fleet_git_env_lines <file> prints env-file lines
fleet_git_env() { [ -f "$1" ] || return 1; export FLEET_GIT_ENV=1; }
fleet_git_env_lines() { [ -f "$1" ] || return 1; echo "# stub fleet identity"; echo "GIT_AUTHOR_NAME=fleet-bot"; echo "FLEET_GIT_ENV=1"; }
SH
cat >"$E/core/fleet/identity/bin/gh" <<'SH'
#!/usr/bin/env bash
# stub of the identity shim: note the call, then run the next gh on PATH (as the real shim does)
echo "shim gh $*" >>"$FAKE/shim.log"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
IFS=: read -r -a dirs <<<"$PATH"
for d in "${dirs[@]}"; do
  if [ -x "$d/gh" ] && [ "$(cd "$d" && pwd -P)" != "$here" ]; then exec "$d/gh" "$@"; fi
done
exit 127
SH
chmod +x "$E/core/fleet/identity/bin/gh"
echo '{"name":"engsys","plugins":[]}' >"$E/.claude-plugin/marketplace.json"
commit_all "$E" "engsys 1.0.0"; git -C "$E" tag v1.0.0
# v1.1.0: the kit announces itself when sourced (proves the re-exec runs the NEW code) and a job template moves
printf '%s\n' '[ -z "${FAKE:-}" ] || printf "MARK kit v1.1.0\n" >>"$FAKE/claude.log"' >>"$E/core/fleet/lib/fleet-env.sh"
sed -i.bak 's/Every 5 minutes\./Every 5 minutes (kit 1.1.0)./' "$E/core/fleet/jobs/launchd/fleet-supervisor.plist.tmpl"; rm -f "$E/core/fleet/jobs/launchd/"*.bak
commit_all "$E" "engsys 1.1.0"; git -C "$E" tag v1.1.0
git -C "$E" commit -q --allow-empty -m "engsys 1.2.0"; git -C "$E" tag v1.2.0
push_all "$E"

# the instance repo: v0.1.0 (plus a later untagged commit on main), v0.2.0 comes in phase C
I="$T/seed/acme-fleet"
seed_repo acme/acme-fleet "$I"
mkdir -p "$I/fleet/env" "$I/jobs/launchd" "$I/.claude-plugin"
cat >"$I/fleet/fleet.conf" <<EOF
# acme fleet host defaults
FLEET_ORG=acme
PIN_REPO=acme/app
PIN_DIR=~/git/app
INSTANCE_MARKETPLACE=acme
WORKTREES_DIR=~/git/worktrees
GH_APP_ENV=~/.config/acme/gh-app.env
MERGE_MODEL=model-m
BUILD_MODEL=model-b
SEC_MODEL=model-s
EOF
cat >"$I/fleet/roster.tmpl" <<'EOF'
# acme roster
NAMESPACE=acme
TMUX_SESSION=__FLEET_ORG__   # rendered from the template variables
ENV_FILE=__ENV_DIR__/session.env
PREFLIGHT=echo preflight-ok
# <name>|<workdir>|<prompt>|<extra>|<env>
acme-mm|__PIN_DIR__|/merge-monster|--model __MERGE_MODEL__ --dangerously-skip-permissions
acme-build|||--add-dir __WORKTREES_DIR__ --model __BUILD_MODEL__
acme-security|__PIN_DIR__|/maintenance-monster|--model __SEC_MODEL__|__ENV_DIR__/security.env
acme-rel|||--remote-control|env/rel.env
EOF
printf 'MODEL_ALIAS="__MERGE_MODEL__"\nLANE=session\n' >"$I/fleet/env/session.env.tmpl"
printf '. "__ENV_DIR__/session.env"\nMODEL_ALIAS="__SEC_MODEL__"\nLANE=security\n' >"$I/fleet/env/security.env.tmpl"
printf 'LANE=rel\n' >"$I/fleet/env/rel.env.tmpl"
# BATON_CMD: the lease check for the singleton monsters (engsys#62), faked as "free" so the
# relaunch path below runs offline.
printf '#!/usr/bin/env bash\necho "baton $*" >>"$FAKE/baton.log"; echo "{\\"relaunch\\":true,\\"code\\":\\"free\\",\\"reason\\":\\"no baton\\"}"\n' >"$T/baton-free.sh"
printf 'REPO=acme/app\nBATON_CMD=bash %s/baton-free.sh\n# <session>|<ledger>|<stale minutes>\nacme-mm|11|60\nacme-security|12|60\n' "$T" >"$I/fleet/supervisor.conf.tmpl"
cat >"$I/jobs/launchd/fleet-supervisor.plist.tmpl" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- instance override of the default supervisor job -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__ENGSYS_DIR__/core/fleet/bin/fleet</string>
    <string>--instance</string>
    <string>__FLEET_REPO__</string>
    <string>supervise</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
</dict>
</plist>
EOF
printf '.fleet/\nlogs/\n' >"$I/.gitignore"
echo '{"name":"acme","plugins":[]}' >"$I/.claude-plugin/marketplace.json"
commit_all "$I" "instance 0.1.0"; git -C "$I" tag v0.1.0
echo "later work" >"$I/notes.txt"; commit_all "$I" "post-release work on main"
push_all "$I"

# the pin repo
P="$T/seed/app"
seed_repo acme/app "$P"
mkdir -p "$P/.claude"
write_settings() { # write_settings <engsys-ref> <acme-ref> <extra plugin enabled: true|false>
  jq -n --arg e "$1" --arg a "$2" --argjson x "$3" '{
    extraKnownMarketplaces: {
      engsys: {source: {source: "github", repo: "vendor/engsys", ref: $e}},
      acme: {source: {source: "github", repo: "acme/acme-fleet", ref: $a}}},
    enabledPlugins: {"core@engsys": true, "off@engsys": false, "ctx@acme": true, "extra@acme": $x}}' >"$P/.claude/settings.json"
}
write_settings v1.0.0 v0.1.0 false
commit_all "$P" "pins 1"
push_all "$P"

# the host: pin checkout, engsys checkout (at v1.0.0), instance checkout (on main, NOT at its pin)
git clone -q https://github.com/acme/app.git "$HOME/git/app"
git clone -q https://github.com/vendor/engsys.git "$HOME/git/engsys"
git -C "$HOME/git/engsys" checkout -q v1.0.0
git clone -q https://github.com/acme/acme-fleet.git "$T/inst"
printf 'GH_BOT_AUTHOR_NAME=bot\nGH_BOT_AUTHOR_EMAIL=bot@example.invalid\n' >"$HOME/.config/acme/gh-app.env"

INST="$T/inst"
ENGSYS_HOST="$HOME/git/engsys"
STATE="$INST/.fleet"
fleet() { bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" "$@"; }
mark() { wc -l <"$FAKE/claude.log" | tr -d ' '; }
since() { tail -n +"$(($1 + 1))" "$FAKE/claude.log"; }
lineno() { grep -n -m1 -- "$2" <<<"$1" | cut -d: -f1; } # lineno <text> <fixed pattern> → first line number ('' if none)
json_names() { jq -r "$2" "$FAKE/claude/$1.json" | sort | paste -sd' ' -; }
iso() { date -u -r "$(($(date +%s) - $1 * 60))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(($(date +%s) - $1 * 60))" +%Y-%m-%dT%H:%M:%SZ; }

# =============================================================================================
echo "== dispatcher and config"
run bash "$ENGSYS_HOST/core/fleet/bin/fleet" help
rc_is "fleet help exits 0" 0; has "help lists the commands" "$OUT" "install-jobs"
run bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" frobnicate
rc_is "unknown command exits 2" 2
if [ -f "$KIT_SRC/pin.sh" ]; then
  ok "pin.sh present (dispatcher hands over to it)"
else
  run fleet pin; rc_is "pin without pin.sh exits 1" 1; has "pin says not implemented yet" "$OUT" "not implemented yet"
fi
run bash -c "cd '$T' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' sync --check"
rc_is "no instance anywhere is an error" 1; has "…that says how to name one" "$OUT" "--instance"
run bash -c "cd '$INST' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' install-jobs --dry-run --only gh-app-login"
rc_is "instance defaults to the git toplevel of the cwd" 0
run env FLEET_INSTANCE="$INST" bash -c "cd '$T' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' install-jobs --dry-run --only gh-app-login"
rc_is "FLEET_INSTANCE is honoured" 0

# rendering + config helpers, straight from the library
(
  export FLEET_INSTANCE="$INST"
  # shellcheck source=/dev/null
  . "$ENGSYS_HOST/core/fleet/lib/fleet-env.sh"
  eq "conf: ~ expands, PIN_DIR" "$PIN_DIR" "$HOME/git/app"
  eq "conf: ENGSYS_DIR defaults to ~/git/engsys" "$ENGSYS_DIR" "$HOME/git/engsys"
  eq "conf: ENGSYS_MARKETPLACE defaults to engsys" "$ENGSYS_MARKETPLACE" engsys
  eq "conf: READY_LABEL default" "$READY_LABEL" "mm:ready"
  eq "conf: REVIEW_BLOCK_REGEX default" "$REVIEW_BLOCK_REGEX" 'critical\|warning'
  eq "conf: PIN_WAIT_MAX_MIN default" "$PIN_WAIT_MAX_MIN" 240
  eq "derived: LOG_DIR" "$LOG_DIR" "$HOME/Library/Logs/acme-fleet"
  eq "derived: TMUX_SESSION from the roster header (templated)" "$TMUX_SESSION" acme
  eq "pins: ENGSYS_REF from settings.json" "$ENGSYS_REF" v1.0.0
  eq "pins: INSTANCE_REF from settings.json" "$INSTANCE_REF" v0.1.0
  eq "pins: fleet_pin_repo" "$(fleet_pin_repo acme)" acme/acme-fleet
  eq "pins: fleet_enabled_plugins only the enabled ones" "$(fleet_enabled_plugins engsys)" core
  eq "sessions: roster" "$(fleet_roster_sessions | paste -sd' ' -)" "acme-mm acme-build acme-security acme-rel"
  eq "sessions: monsters come from the supervisor conf" "$(fleet_ledger_sessions | paste -sd' ' -)" "acme-mm acme-security"
  eq "render: substitutes conf keys" "$(fleet_render_text 'm=__MERGE_MODEL__' t)" "m=model-m"
  export ESC_TEST='a&b\c#d'
  eq "render: sed metacharacters in values stay literal" "$(fleet_render_text '<__ESC_TEST__>' t)" '<a&b\c#d>'
  if (fleet_render_text 'x __NOT_SET_ANYWHERE__' tmpl-under-test) >/dev/null 2>"$T/render.err"; then
    bad "render: an unset name fails"
  else
    has "render: an unset name fails and names it" "$(cat "$T/render.err")" "NOT_SET_ANYWHERE"
  fi
) || bad "library checks aborted"

mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
SHIM="$ENGSYS_HOST/core/fleet/identity/bin"

# =============================================================================================
echo "== A. first sync from empty"
run fleet sync
rc_is "sync exits 0" 0
has "instance moves to its pin" "$OUT" "→ v0.1.0"
eq "instance checkout is at its pin" "$(git -C "$INST" describe --tags --exact-match)" v0.1.0
eq "instance step ran once (one re-exec)" "$(grep -c '^fleet-sync: instance: ' <<<"$OUT")" 1
has "engsys marketplace added at its ref" "$OUT" "marketplace engsys: absent → v1.0.0"
has "instance marketplace added at its ref" "$OUT" "marketplace acme: absent → v0.1.0"
has "enabled engsys plugin installed" "$OUT" "installed core@engsys"
has "enabled instance plugin installed" "$OUT" "installed ctx@acme"
hasnt "disabled plugin skipped" "$OUT" "off@engsys"
eq "marketplaces at the pinned refs" "$(json_names marketplaces '.[] | .name + "#" + .ref')" "acme#v0.1.0 engsys#v1.0.0"
eq "plugins installed" "$(json_names plugins '.[].id')" "core@engsys ctx@acme"
has "marketplace add uses the pin repo url + #ref" "$(cat "$FAKE/claude.log")" "plugin marketplace add https://github.com/vendor/engsys.git#v1.0.0"
eq "fleet processes had the gh shim first on PATH" "$(grep -v -e "PATH0=$SHIM" -e '^MARK' "$FAKE/claude.log" || true)" ""
[ -s "$STATE/last-change" ] && ok "last-change stamped" || bad "last-change stamped"
has "sync.log records the pins" "$(cat "$STATE/sync.log")" "engsys=v1.0.0 acme=v0.1.0"
matches "ends with the session table (nothing running yet)" "$OUT" '^acme-mm +monster +missing'

echo "== B. idempotent re-run"
b="$(mark)"; lc="$(cat "$STATE/last-change")"
run fleet sync
rc_is "re-run exits 0" 0
has "says already in sync" "$OUT" "already in sync."
eq "no marketplace/plugin mutations" "$(since "$b" | grep -cE 'marketplace (add|remove)|plugin install' || true)" 0
eq "last-change untouched" "$(cat "$STATE/last-change")" "$lc"
run fleet sync --check
rc_is "--check is clean" 0; has "…and says so" "$OUT" "host is in sync with the pins"
run fleet status
rc_is "status exits 0" 0; has "status shows the sync check" "$OUT" "in sync with the pins"; has "status shows the sessions" "$OUT" "SESSION"
has "status opens with the registry block (single-fleet here)" "$OUT" "fleet: single-fleet mode"

echo "== C. the pins move: pin checkout, instance re-exec, engsys re-exec, marketplace swap"
write_settings v1.1.0 v0.2.0 true
commit_all "$P" "pins 2"; push_all "$P"
cat >"$I/jobs/launchd/acme-extra.plist.tmpl" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/true</string>
  </array>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/acme-extra.log</string>
</dict>
</plist>
PL
printf 'MODEL_ALIAS="__MERGE_MODEL__"\nLANE=session\nEXTRA=v2\n' >"$I/fleet/env/session.env.tmpl"
commit_all "$I" "instance 0.2.0"; git -C "$I" tag v0.2.0; push_all "$I"
run fleet sync --check
rc_is "--check reports drift" 1; has "…the pin checkout is behind" "$OUT" "pin checkout is behind origin/main"
b="$(mark)"; : >"$FAKE/launchctl.log"
run fleet sync
rc_is "sync exits 0" 0
has "pin checkout fast-forwarded" "$OUT" "pin checkout: fast-forwarded"
has "instance moved" "$OUT" "instance: v0.1.0 → v0.2.0"
has "engsys checkout moved" "$OUT" "engsys: v1.0.0 → v1.1.0"
has "engsys marketplace swapped" "$OUT" "marketplace engsys: v1.0.0 → v1.1.0"
has "instance marketplace swapped" "$OUT" "marketplace acme: v0.1.0 → v0.2.0"
has "newly enabled plugin installed" "$OUT" "installed extra@acme"
has "changed job templates trigger a reinstall" "$OUT" "launchd templates changed — reinstalling jobs"
seg="$(since "$b")"
mk="$(lineno "$seg" "MARK kit v1.1.0")"; rm1="$(lineno "$seg" "plugin marketplace remove engsys")"
if [ -n "$mk" ] && [ -n "$rm1" ] && [ "$mk" -lt "$rm1" ]; then ok "the NEW kit (v1.1.0) took over before the plugin step"; else bad "the NEW kit took over before the plugin step" "MARK at ${mk:-none}, first remove at ${rm1:-none}"; fi
rm2="$(lineno "$seg" "plugin marketplace remove acme")"; ad2="$(lineno "$seg" "plugin marketplace add https://github.com/acme/acme-fleet.git#v0.2.0")"
if [ -n "$rm2" ] && [ -n "$ad2" ] && [ "$rm2" -lt "$ad2" ]; then ok "remove precedes add (instance marketplace)"; else bad "remove precedes add" "$seg"; fi
eq "engsys checkout at its pin" "$(git -C "$ENGSYS_HOST" describe --tags --exact-match)" v1.1.0
eq "instance checkout at its pin" "$(git -C "$INST" describe --tags --exact-match)" v0.2.0
eq "marketplaces" "$(json_names marketplaces '.[] | .name + "#" + .ref')" "acme#v0.2.0 engsys#v1.1.0"
eq "plugins" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"
has "sync.log records the new pins" "$(cat "$STATE/sync.log")" "engsys=v1.1.0 acme=v0.2.0"
has "jobs reinstalled through launchctl" "$(cat "$FAKE/launchctl.log")" "com.acme.fleet.acme-extra.plist"
run fleet sync --check
rc_is "in sync afterwards" 0

echo "== D. drift detection and healing from a stale kit"
run fleet sync --check; rc_is "clean baseline" 0
jq 'map(select(.id != "ctx@acme"))' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
run fleet sync --check
rc_is "missing plugin is drift" 1; has "…named" "$OUT" "plugin ctx@acme not installed"
jq 'map(if .name == "acme" then .ref = "v0.1.0" else . end)' "$FAKE/claude/marketplaces.json" >"$FAKE/m.json" && mv "$FAKE/m.json" "$FAKE/claude/marketplaces.json"
run fleet sync --check
rc_is "marketplace at the wrong ref is drift" 1; has "…named" "$OUT" "marketplace acme is at 'v0.1.0' (pin v0.2.0)"
git -C "$ENGSYS_HOST" checkout -q v1.0.0
run fleet sync --check
rc_is "engsys checkout off its pin is drift" 1; has "…named" "$OUT" "engsys checkout is at v1.0.0 (pin v1.1.0)"
b="$(mark)"; : >"$FAKE/launchctl.log"
run fleet sync
rc_is "sync heals it (running the v1.0.0 kit, re-exec'd into v1.1.0)" 0
has "engsys moved forward" "$OUT" "engsys: v1.0.0 → v1.1.0"
has "engsys-side job template change reinstalls jobs" "$OUT" "launchd templates changed — reinstalling jobs"
has "marketplace repaired" "$OUT" "marketplace acme: v0.1.0 → v0.2.0"
eq "plugins back" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"
run fleet sync --check; rc_is "in sync again" 0

echo "== E. launch: rendering, the 5th roster field, the launcher command lines"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
run fleet launch
rc_is "launch exits 0" 0
has "preflight ran" "$OUT" "preflight-ok"
[ -d "$HOME/git/worktrees" ] && ok "WORKTREES_DIR created" || bad "WORKTREES_DIR created"
S_ENV="$(cat "$STATE/env/session.env")"; X_ENV="$(cat "$STATE/env/security.env")"
has "session env rendered from the (v0.2.0) template" "$S_ENV" 'MODEL_ALIAS="model-m"'
has "…including the new line" "$S_ENV" "EXTRA=v2"
has "session env gets the identity lines" "$S_ENV" "GIT_AUTHOR_NAME=fleet-bot"
has "session env puts the gh shim first on PATH" "$S_ENV" "core/fleet/identity/bin"
has "session env drops an inherited GH_TOKEN" "$S_ENV" "unset GH_TOKEN GITHUB_TOKEN"
has "security env sources the session env" "$X_ENV" ". \"$STATE/env/session.env\""
has "security env overrides the model" "$X_ENV" 'MODEL_ALIAS="model-s"'
has "every rendered env gets the identity lines" "$X_ENV" "GIT_AUTHOR_NAME=fleet-bot"
has "…even the relative-path lane" "$(cat "$STATE/env/rel.env")" "GIT_AUTHOR_NAME=fleet-bot"
eq "env files are 0600" "$(mode_of "$STATE/env/session.env")" 600
ROSTER_OUT="$(cat "$STATE/roster")"
has "roster: tmux session rendered" "$ROSTER_OUT" "TMUX_SESSION=acme"
has "roster: ENV_FILE points at the rendered lane env" "$ROSTER_OUT" "ENV_FILE=$STATE/env/session.env"
has "roster: 5th field rendered" "$ROSTER_OUT" "acme-security|$HOME/git/app|/maintenance-monster|--model model-s|$STATE/env/security.env"
has "roster: monster line" "$ROSTER_OUT" "acme-mm|$HOME/git/app|/merge-monster|--model model-m --dangerously-skip-permissions"
tl() { grep -F "[send-keys] [-t] [acme:$1]" "$FAKE/tmux.log" | head -1; } # the launch command line for a window
has "mm: default env (roster ENV_FILE)" "$(tl acme-mm)" "cd $HOME/git/app && set -a && . $STATE/env/session.env && set +a && claude --name acme-mm"
has "mm: prompt before the extra flags" "$(tl acme-mm)" "/merge-monster --model model-m --dangerously-skip-permissions"
has "security: the 5th field replaces ENV_FILE" "$(tl acme-security)" "set -a && . $STATE/env/security.env && set +a && claude --name acme-security"
hasnt "security: the roster-level env is NOT used" "$(tl acme-security)" "session.env"
has "security: prompt before the extra flags" "$(tl acme-security)" "/maintenance-monster --model model-s"
has "rel: a relative 5th field resolves against the roster's directory" "$(tl acme-rel)" "set -a && . $STATE/env/rel.env && set +a"
has "build: empty workdir runs from PIN_DIR" "$(tl acme-build)" "cd $HOME/git/app && set -a && . $STATE/env/session.env"
has "build: --add-dir from WORKTREES_DIR" "$(tl acme-build)" "--add-dir $HOME/git/worktrees --model model-b"
eq "four windows started" "$(grep -c . "$FAKE/tmux/windows")" 4
run fleet launch
has "a second launch skips live windows" "$OUT" "skip: a tmux window named 'acme-mm' already exists"
grep -Fxv acme-build "$FAKE/tmux/windows" >"$FAKE/w.new" || true; mv "$FAKE/w.new" "$FAKE/tmux/windows"
: >"$FAKE/tmux.log"
run fleet launch acme-build
rc_is "launching one session works" 0; has "…that one" "$OUT" "launched: acme-build"; hasnt "…only" "$OUT" "launched: acme-mm"
run fleet launch acme-nope
rc_is "unknown session is an error" 1; has "…named" "$OUT" "no session named 'acme-nope'"
printf 'NAMESPACE=acme\nacme-x|%s|/p|--flag|gone.env\n' "$HOME/git/app" >"$T/x.roster"
run bash -c "cd '$T' && bash '$ENGSYS_HOST/core/skills/agent-sessions/scripts/launch-agent-sessions.sh' --roster x.roster"
rc_is "launcher: a missing per-session env file is an error" 1
has "…naming the resolved path" "$OUT" "env file for 'acme-x' not found: $T/gone.env"

echo "== F. supervise"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"; : >"$FAKE/gh.log"
jq -n --arg b "last: $(iso 200) — status: working" '{state: "OPEN", body: $b}' >"$FAKE/ledger-11.json"
jq -n '{state: "CLOSED", body: ""}' >"$FAKE/ledger-12.json"
run fleet supervise
rc_is "supervise exits 0" 0
SUP="$(cat "$STATE/supervisor.conf")"
has "conf: LAUNCH_CMD points back at the dispatcher" "$SUP" "LAUNCH_CMD=bash $ENGSYS_HOST/core/fleet/bin/fleet --instance $INST launch"
has "conf: TMUX_SESSION defaulted" "$SUP" "TMUX_SESSION=acme"
has "conf: sessions from the template" "$SUP" "acme-mm|11|60"
has "conf: the merge monster carries its role, so the supervisor asks the lease (engsys#62)" "$SUP" "acme-mm|11|60|||merge"
has "conf: …and the maintenance monster too" "$SUP" "acme-security|12|60|||maintain"
has "conf: HEARTBEAT_CMD defaulted to the dispatcher" "$SUP" "HEARTBEAT_CMD=bash $ENGSYS_HOST/core/fleet/bin/fleet --instance $INST heartbeat"
has "stale monster with no window is relaunched through the kit" "$(grep -F '[new-session]' "$FAKE/tmux.log" | grep -F '[acme-mm]' || true)" "[acme-mm]"
hasnt "closed ledger (kill switch) is left alone" "$(cat "$FAKE/tmux.log")" "[acme-security]"
has "supervisor log kept in the instance" "$(cat "$INST/logs/fleet-supervisor/supervisor.log")" "acme-security: ledger acme/app#12 CLOSED"
has "relaunch reported on the ledger" "$(cat "$FAKE/gh.log")" "issue comment 11 -R acme/app"
has "the supervisor's gh calls went through the identity shim" "$(cat "$FAKE/shim.log")" "shim gh issue view 11"

echo "== G. install-jobs"
LA="$HOME/Library/LaunchAgents"
rm -rf "$LA"; : >"$FAKE/launchctl.log"
run fleet install-jobs --dry-run
rc_is "dry-run exits 0" 0
has "renders the supervisor job at its label path" "$OUT" "===== would write $LA/com.acme.fleet.fleet-supervisor.plist"
has "label is com.<org>.fleet.<name>" "$OUT" "<string>com.acme.fleet.fleet-supervisor</string>"
has "the instance template overrides the default of the same name" "$OUT" "instance override of the default supervisor job"
has "…(its interval, not the default's)" "$OUT" "<integer>60</integer>"
hasnt "…and the default is not also rendered" "$OUT" "<integer>300</integer>"
has "default gh-app-login job calls the identity kit" "$OUT" "<string>$ENGSYS_HOST/core/fleet/identity/gh-app-login.sh</string>"
has "…with the env file" "$OUT" "<string>$HOME/.config/acme/gh-app.env</string>"
has "log dir under the org's Logs" "$OUT" "$HOME/Library/Logs/acme-fleet/gh-app-login.log"
has "instance-only jobs are included" "$OUT" "<string>com.acme.fleet.acme-extra</string>"
hasnt "no placeholder left" "$OUT" "__LABEL__"
hasnt "no placeholder left (engsys dir)" "$OUT" "__ENGSYS_DIR__"
[ ! -e "$LA" ] && ok "dry-run wrote nothing" || bad "dry-run wrote nothing"
eq "…and never called launchctl" "$(cat "$FAKE/launchctl.log")" ""
run fleet install-jobs --dry-run --only gh-app-login
eq "--only <job> renders one" "$(grep -c '^===== would write' <<<"$OUT")" 1
run fleet install-jobs --dry-run --only com.acme.fleet.acme-extra
eq "--only <label> renders one" "$(grep -c '^===== would write' <<<"$OUT")" 1
run fleet install-jobs --dry-run --only nope
rc_is "--only <unknown> is an error" 1; has "…listing what exists" "$OUT" "no job template named 'nope'"
mv "$INST/jobs/launchd/fleet-supervisor.plist.tmpl" "$T/override.tmpl"
run fleet install-jobs --dry-run --only fleet-supervisor
has "without an override the engsys default renders" "$OUT" "<integer>300</integer>"
has "…the (v1.1.0) default from the pinned checkout" "$OUT" "(kit 1.1.0)"
has "…which runs the dispatcher for this instance" "$OUT" "<string>$INST</string>"
mv "$T/override.tmpl" "$INST/jobs/launchd/fleet-supervisor.plist.tmpl"
printf '<plist><dict><key>Label</key><string>__LABEL__</string><key>X</key><string>__NOPE__</string></dict></plist>\n' >"$INST/jobs/launchd/broken.plist.tmpl"
run fleet install-jobs --dry-run --only broken
rc_is "a template with an unset name fails" 1; has "…naming it" "$OUT" "NOPE"
rm -f "$INST/jobs/launchd/broken.plist.tmpl"
mv "$INST/fleet/supervisor.conf.tmpl" "$T/sup.tmpl"
run fleet install-jobs --dry-run
has "no supervisor conf → no supervisor job" "$OUT" "skipped: com.acme.fleet.fleet-supervisor (no fleet/supervisor.conf.tmpl)"
has "single-fleet mode → no relay job" "$OUT" "skipped: com.acme.fleet.fleet-relay (single-fleet mode"
mv "$T/sup.tmpl" "$INST/fleet/supervisor.conf.tmpl"
run fleet install-jobs
rc_is "install exits 0" 0
for j in fleet-supervisor gh-app-login acme-extra; do
  [ -f "$LA/com.acme.fleet.$j.plist" ] && ok "installed $j" || bad "installed $j"
done
eq "plist mode 644" "$(mode_of "$LA/com.acme.fleet.gh-app-login.plist")" 644
LC="$(cat "$FAKE/launchctl.log")"
has "old copy booted out first" "$LC" "bootout gui/$(id -u)/com.acme.fleet.fleet-supervisor"
has "then bootstrapped" "$LC" "bootstrap gui/$(id -u) $LA/com.acme.fleet.fleet-supervisor.plist"
if command -v plutil >/dev/null 2>&1; then
  bad_plist=0; for f in "$LA"/*.plist; do plutil -lint "$f" >/dev/null 2>&1 || bad_plist=1; done
  eq "every installed plist lints" "$bad_plist" 0
fi
: >"$FAKE/launchctl.log"
run fleet install-jobs --unload
rc_is "--unload exits 0" 0
eq "--unload boots out every job" "$(grep -c '^launchctl bootout' "$FAKE/launchctl.log")" 4

echo "== H. restart: status parsing, BEHIND, cycling"
FT="$FAKE/tmux"
reset_tmux() { rm -rf "$FT"; mkdir -p "$FT"; : >"$FT/windows"; : >"$FAKE/tmux.log"; }
start_pane() { # start_pane <window> — a fake pane: a shell stand-in whose child (a sleep) plays the claude process
  bash -c 'sleep 300 & wait' >/dev/null 2>&1 &
  local pid=$! n=0
  PIDS+=("$pid")
  while ! pgrep -P "$pid" >/dev/null 2>&1 && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
  echo "$pid" >"$FT/pid-$1"; echo node >"$FT/cmd-$1"; echo "$1" >>"$FT/windows"
}
reset_tmux
start_pane acme-mm
start_pane acme-build; echo "✻ Working… (esc to interrupt)" >"$FT/cap-acme-build"
echo acme-rel >>"$FT/windows"; echo zsh >"$FT/cmd-acme-rel"
echo $(($(date +%s) + 1000)) >"$STATE/last-change"
run fleet restart --status
rc_is "status exits 0" 0
matches "monster, idle, started before the last change → BEHIND" "$OUT" '^acme-mm +monster +idle +[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} +BEHIND$'
matches "interactive, busy (esc to interrupt) → BEHIND" "$OUT" '^acme-build +interactive +busy +[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} +BEHIND$'
matches "no window → missing" "$OUT" '^acme-security +monster +missing +- +-$'
matches "shell in the foreground → exited" "$OUT" '^acme-rel +interactive +exited +- +-$'
has "last host change shown from sync.log" "$OUT" "last host change:"
echo 1 >"$STATE/last-change"
run fleet restart --status
matches "started after the last change → current" "$OUT" '^acme-mm +monster +idle +[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} +current$'
rm -f "$STATE/last-change"
run fleet restart
matches "no last-change stamp → current" "$OUT" '^acme-build +interactive +busy .* current$'
hasnt "…and no 'last host change' line" "$OUT" "last host change:"
run fleet restart --stale
has "--stale with no stamp says so" "$OUT" "no host change recorded yet"

echo $(($(date +%s) + 1000)) >"$STATE/last-change"; : >"$FAKE/tmux.log"
run fleet restart --stale
rc_is "--stale exits 0" 0
has "monster is asked to rotate, not killed" "$OUT" "acme-mm: rotation requested"
has "the rotation request names the pins" "$(cat "$FAKE/tmux.log")" "Operator: the fleet host was upgraded (pins: engsys v1.1.0, acme v0.2.0)"
has "busy interactive session is skipped" "$OUT" "acme-build: busy mid-turn — skipped"
hasnt "exited windows are not touched by --stale" "$OUT" "acme-rel"
hasnt "nothing was killed" "$(cat "$FAKE/tmux.log")" "[kill-window]"
: >"$FT/cap-acme-build"; : >"$FAKE/tmux.log"
run fleet restart --stale
has "idle interactive session: /exit then relaunched" "$OUT" "acme-build: relaunched"
has "…via /exit" "$(cat "$FAKE/tmux.log")" "[acme:acme-build] [-l] [/exit]"
run fleet restart acme-rel
has "an exited window is relaunched directly" "$OUT" "acme-rel: relaunched"
run fleet restart acme-nope
has "unknown names are skipped" "$OUT" "acme-nope: not in the roster"
run fleet restart --all
has "--all relaunches a missing monster window" "$OUT" "acme-security: relaunched"

echo "== I. no instance marketplace, no identity, forced ref"
printf '# per-machine overrides\nINSTANCE_MARKETPLACE=\nGH_APP_ENV=\nENGSYS_REF=v1.2.0\n' >"$HOME/.config/acme/fleet.local.conf"
rm -rf "$FAKE/claude"; b="$(mark)"
run fleet sync
rc_is "sync exits 0" 0
seg="$(since "$b")"
has "the forced engsys ref wins over the pin" "$OUT" "pins: engsys v1.2.0"
has "engsys checkout follows it" "$OUT" "engsys: v1.1.0 → v1.2.0"
hasnt "no instance step" "$OUT" "instance:"
hasnt "no instance marketplace calls" "$seg" "acme"
eq "only the engsys marketplace" "$(json_names marketplaces '.[] | .name + "#" + .ref')" "engsys#v1.2.0"
eq "only its plugins" "$(json_names plugins '.[].id')" "core@engsys"
eq "instance checkout untouched" "$(git -C "$INST" describe --tags --exact-match)" v0.2.0
eq "without GH_APP_ENV no shim is put on PATH" "$(since "$b" | grep -v -e "PATH0=$T/bin" -e '^MARK' || true)" ""
reset_tmux
run fleet launch
rc_is "launch works without an identity" 0
hasnt "env files carry no identity lines" "$(cat "$STATE/env/session.env")" "GIT_AUTHOR_NAME"
hasnt "env files carry no gh shim without identity" "$(cat "$STATE/env/session.env")" "core/fleet/identity/bin"
run fleet install-jobs --dry-run
has "gh-app-login job is not installed without GH_APP_ENV" "$OUT" "skipped: com.acme.fleet.gh-app-login (GH_APP_ENV is not set)"
rm -f "$HOME/.config/acme/fleet.local.conf"

# =============================================================================================
finish fleet.test
