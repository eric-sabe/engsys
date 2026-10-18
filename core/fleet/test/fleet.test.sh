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

: >"$FAKE/shim.log"; : >"$FAKE/claude.log"; : >"$FAKE/claude.cwd"; : >"$FAKE/tmux.log"; : >"$FAKE/gh.log"; : >"$FAKE/cr.log"; : >"$FAKE/launchctl.log"

# --- stubs -----------------------------------------------------------------------------------
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
# stub claude: plugin list|validate|install, plugin marketplace list|add|remove — state in $FAKE/claude/*.json
set -euo pipefail
S="$FAKE/claude"; [ -z "${CLAUDE_CONFIG_DIR:-}" ] || S="$FAKE/claude-cfg/$(printf '%s' "$CLAUDE_CONFIG_DIR" | tr '/' '_')"   # one plugin state per config dir
mkdir -p "$S"
[ -f "$S/marketplaces.json" ] || echo '[]' >"$S/marketplaces.json"
[ -f "$S/plugins.json" ] || echo '[]' >"$S/plugins.json"
printf '%s\tPATH0=%s\tCFG=%s\n' "$*" "${PATH%%:*}" "${CLAUDE_CONFIG_DIR:-unset}" >>"$FAKE/claude.log"
printf '%s\t%s\n' "$(pwd -P)" "$*" >>"$FAKE/claude.cwd"
# one login per session (engsys#205): $FAKE/loggedin/<config dir name> | loggedout/<name> decide `auth status --json`
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  b="$(basename "${CLAUDE_CONFIG_DIR:-default}")"
  if [ -f "$FAKE/loggedout/$b" ]; then echo '{"loggedIn": false}'; exit 1; fi
  if [ -f "$FAKE/loggedin/$b" ]; then echo '{"loggedIn": true}'; exit 0; fi
  exit 2
fi
[ "${1:-}" = plugin ] || { echo "stub claude: unsupported: $*" >&2; exit 2; }
shift
save() { local f="$1"; shift; jq "$@" "$f" >"$f.new" && mv "$f.new" "$f"; }
# The real CLI also edits the project settings of its cwd: a `marketplace remove` drops the marketplace and
# its plugins from them (engsys#112). The stub does that whatever --scope says, so only a cwd outside every
# project is safe; FAKE_CLAUDE_WIPE=<file> forces it. Only files inside the sandbox are ever touched.
proj_settings() {
  local d; d="$(pwd -P)"
  while [ "$d" != / ]; do
    if [ "$d" != "$HOME" ] && [ -f "$d/.claude/settings.json" ]; then echo "$d/.claude/settings.json"; return; fi
    d="$(dirname "$d")"
  done
}
wipe_project() { # wipe_project <settings file> <marketplace>
  case "$1" in "${FAKE%/fake}"/*) ;; *) return 0 ;; esac
  save "$1" --arg n "$2" 'del(.extraKnownMarketplaces[$n]) | .enabledPlugins |= with_entries(select(.key | endswith("@" + $n) | not))'
}
case "${1:-}" in
  list) cat "$S/plugins.json" ;;
  validate) echo "Validation passed" ;;
  install)
    id="$2"; m="${id#*@}"
    jq -e --arg m "$m" 'any(.[]; .name == $m)' "$S/marketplaces.json" >/dev/null || { echo "marketplace not found: $m" >&2; exit 1; }
    ver="$(jq -r --arg m "$m" '.[] | select(.name == $m) | .ref' "$S/marketplaces.json")"; ver="${ver#v}"
    save "$S/plugins.json" --arg id "$id" --arg v "${ver:-1.0.0}" '. + [{id: $id, version: $v, scope: "user", enabled: true}]' ;;
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
        # A marketplace declared only by a project's settings: the real CLI refuses a user-scoped remove (engsys#200).
        if [ "${FAKE_CLAUDE_REMOVE_FAIL:-}" = 1 ]; then echo "remove exploded" >&2; exit 1; fi
        if [ "${FAKE_CLAUDE_PROJECT_DECLARED:-}" = "$name" ] && [ "${4:-}" = --scope ]; then
          echo "Marketplace '$name' is not declared in user settings. Omit --scope to remove it from all scopes." >&2; exit 1
        fi
        f="${FAKE_CLAUDE_WIPE:-$(proj_settings)}"; [ -z "$f" ] || wipe_project "$f" "$name"
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
# a launched session shows its first reply; the supervisor reads it for a login error (engsys#103)
add_window() { grep -Fxq "$1" "$F/windows" || echo "$1" >>"$F/windows"; echo node >"$F/cmd-$1"; echo "⏺ Reading the ledger." >"$F/cap-$1"; }
case "$sub" in
  list-windows) cat "$F/windows" ;;
  list-panes)
    case "$fmt" in
      *pane_pid*) cat "$F/pid-$w" 2>/dev/null || exit 1 ;;
      *pane_id*) [ -f "$F/cmd-$w" ] || exit 1; echo "%pane-$w" ;;
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
# `fleet verify` (which gates the merge and maintain monsters) checks the plugin against these tags.
# shellcheck source=fake-release.sh
. "$HERE/fake-release.sh"
fake_release "$T/remotes/vendor/engsys.git"

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
SEC_MODEL=claude-opus-4-8
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

mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
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
# The same heal from inside a fleet job (what verify --auto-sync runs): never touches launchd.
git -C "$ENGSYS_HOST" checkout -q v1.0.0
: >"$FAKE/launchctl.log"
run fleet sync --no-jobs
rc_is "sync --no-jobs heals the checkout too" 0
has "…says the job files changed and asks for install-jobs" "$OUT" "not reloading them. Run: fleet install-jobs"
eq "…and never called launchctl" "$(cat "$FAKE/launchctl.log")" ""
run fleet sync --check; rc_is "in sync again (no-jobs)" 0

echo "== D2. FLEET_CLAUDE_CONFIG_DIR: sync installs the pinned plugins into the fleet's own Claude config dir"
FCFG="$T/fleet-claude"; mkdir -p "$FCFG"
LC="$HOME/.config/acme/fleet.local.conf"; cp "$LC" "$T/flc.bak" 2>/dev/null || : >"$T/flc.bak"
printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$FCFG" >>"$LC"
# a fresh fleet dir: the sync has real plugin work to do there
m="$(mark)"; CLAUDE_CONFIG_DIR="$T/inherited" run fleet sync
rc_is "sync with FLEET_CLAUDE_CONFIG_DIR exits 0" 0
has "…it ran the plugin step" "$(since "$m")" "plugin marketplace add https://github.com/vendor/engsys.git"
eq "…every claude call ran with CLAUDE_CONFIG_DIR=<the fleet's dir>" "$(since "$m" | grep -v '^MARK' | grep -vc "CFG=$FCFG\$" || true)" 0
has "…and sync says which config dir it used" "$OUT" "claude config dir: $FCFG (FLEET_CLAUDE_CONFIG_DIR)"
cp "$T/flc.bak" "$LC"
m="$(mark)"; CLAUDE_CONFIG_DIR="$T/inherited" run fleet sync --check
rc_is "unset again: in sync" 0
eq "…every claude call ran with no CLAUDE_CONFIG_DIR (an inherited one is dropped)" "$(since "$m" | grep -v '^MARK' | grep -vc 'CFG=unset$' || true)" 0
has "…reporting the default dir" "$OUT" "claude config dir: $HOME/.claude"
printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$T/missing-cfg" >>"$LC"
run fleet sync
rc_is "a FLEET_CLAUDE_CONFIG_DIR that doesn't exist stops sync" 1
has "…with the one-time setup" "$OUT" "log in with CLAUDE_CONFIG_DIR=$T/missing-cfg claude"
cp "$T/flc.bak" "$LC"
# A fleet dir seeded before the claude.ai sync switches existed: sync adds them, keeps every other key, and
# never touches ~/.claude/settings.json (engsys#200).
cp "$T/flc.bak" "$LC"; printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$FCFG" >>"$LC"
echo '{"effortLevel":"high"}' >"$FCFG/settings.json"; mkdir -p "$HOME/.claude"; echo '{"keep":"me"}' >"$HOME/.claude/settings.json"
run fleet sync
rc_is "sync with a pre-existing fleet-dir settings.json exits 0" 0
eq "…it gained the claude.ai sync switches, other keys kept" "$(jq -cS . "$FCFG/settings.json")" '{"effortLevel":"high","syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}'
eq "…and ~/.claude/settings.json is untouched" "$(cat "$HOME/.claude/settings.json")" '{"keep":"me"}'
cp "$FCFG/settings.json" "$T/fcfg-settings.1"; run fleet sync
eq "…a second sync leaves it byte-identical" "$(cat "$FCFG/settings.json")" "$(cat "$T/fcfg-settings.1")"
rm -f "$HOME/.claude/settings.json" "$FCFG/settings.json"
cp "$T/flc.bak" "$LC"
# FLEET_CLAUDE_CONFIG_DIR pointing at the operator's own ~/.claude (directly, or through a symlink): the sync-off
# retrofit must not touch its settings.json (engsys#204).
for how in direct symlink; do
  if [ "$how" = direct ]; then OWN="$HOME/.claude"; else OWN="$T/own-link"; ln -sfn "$HOME/.claude" "$OWN"; fi
  cp "$T/flc.bak" "$LC"; printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$OWN" >>"$LC"
  echo '{"keep":"me"}' >"$HOME/.claude/settings.json"
  run fleet sync
  eq "$how ~/.claude as FLEET_CLAUDE_CONFIG_DIR: settings.json untouched (#204)" "$(cat "$HOME/.claude/settings.json")" '{"keep":"me"}'
  has "…and sync warns about it" "$OUT" "is your own ~/.claude"
  rm -f "$HOME/.claude/settings.json"
done
rm -f "$T/own-link"; cp "$T/flc.bak" "$LC"

echo "== D3. FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised: sync reconciles both the fleet dir and ~/.claude"
FS="$FAKE/claude-cfg/$(printf '%s' "$FCFG" | tr '/' '_')"
printf 'FLEET_CLAUDE_CONFIG_DIR=%s\nFLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised\n' "$FCFG" >>"$LC"
# both dirs behind: the fleet dir missing a plugin, ~/.claude on an old marketplace ref
jq 'map(select(.id != "ctx@acme"))' "$FS/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FS/plugins.json"
jq 'map(if .name == "engsys" then .ref = "v1.0.0" else . end)' "$FAKE/claude/marketplaces.json" >"$FAKE/m.json" && mv "$FAKE/m.json" "$FAKE/claude/marketplaces.json"
run fleet sync --check
rc_is "--check: drift in either dir is drift" 1
has "…reports the fleet dir" "$OUT" "claude config dir: $FCFG (FLEET_CLAUDE_CONFIG_DIR, scope supervised)"
has "…and ~/.claude for the interactive roles" "$OUT" "claude config dir: $HOME/.claude (interactive roles)"
has "…the fleet dir's drift" "$OUT" "plugin ctx@acme not installed"
has "…~/.claude's drift" "$OUT" "marketplace engsys is at 'v1.0.0'"
# ~/.claude is the operator's: moving the engsys marketplace ref would uninstall their own unpinned
# plugin of it and another project's project-scope install, so the step is refused (drift, no damage).
cp "$FAKE/claude/plugins.json" "$T/user-plugins.bak"
jq '. + [{id: "engsys-swift@engsys", version: "1.0.0", scope: "user", enabled: true},
         {id: "core@engsys", version: "1.0.0", scope: "project", projectPath: "/other/proj", enabled: true}]' "$T/user-plugins.bak" >"$FAKE/claude/plugins.json"
m="$(mark)"; run fleet sync
rc_is "sync with unpinned plugins in ~/.claude still exits 0 (the fleet dir is synced)" 0
has "…warns that moving it would uninstall unpinned plugins" "$OUT" "would uninstall plugins the fleet doesn't pin:"
has "…with advice that works for a ref-pinned marketplace" "$OUT" "claude plugin marketplace remove engsys, then claude plugin marketplace add https://github.com/vendor/engsys.git#v1.1.0"
has "…naming the operator's plugin" "$OUT" "engsys-swift@engsys (user)"
has "…and the project-scope install" "$OUT" "core@engsys (project /other/proj)"
has "…while the fleet dir is synced all the same" "$(since "$m" | grep "CFG=$FCFG\$")" "plugin install ctx@acme"
eq "…never ran marketplace remove in ~/.claude" "$(since "$m" | grep 'CFG=unset$' | grep -c 'marketplace remove' || true)" 0
has "…the operator's own plugin survives" "$(jq -r '.[].id' "$FAKE/claude/plugins.json")" "engsys-swift@engsys"
has "…and the other project's install" "$(jq -c '.[] | select(.scope == "project")' "$FAKE/claude/plugins.json")" '"projectPath":"/other/proj"'
run fleet sync --check
rc_is "…and --check reports the drift" 1
# This host's real layout: ~/.claude holds every pinned plugin twice, at user scope and at project scope
# for PIN_DIR itself (keystone's own installs), beside other marketplaces' plugins. Those PIN_DIR installs
# are the fleet's own: the pin bump moves them.
jq --arg pin "$HOME/git/app" '[.[] | select(.id | endswith("@engsys") or endswith("@acme"))] as $fleet
  | . + [$fleet[] | .scope = "project" | .projectPath = $pin]
  + [{id: "codex@openai-codex", version: "1.0.6", scope: "user", enabled: true},
     {id: "design@synced", version: "1.2.0", scope: "synced", enabled: true}]' "$T/user-plugins.bak" >"$FAKE/claude/plugins.json"
m="$(mark)"; run fleet sync
rc_is "the real layout (pinned plugins also at project scope for PIN_DIR): sync exits 0" 0
hasnt "…without refusing" "$OUT" "would uninstall plugins the fleet doesn't pin"
has "…the marketplace moved in ~/.claude" "$(since "$m" | grep 'CFG=unset$')" "plugin marketplace add https://github.com/vendor/engsys.git#v1.1.0"
has "…the other marketplaces' plugins survive" "$(jq -r '.[].id' "$FAKE/claude/plugins.json")" "codex@openai-codex"
run fleet sync --check; rc_is "…and the host is in sync" 0
run fleet verify; rc_is "…and fleet verify passes on it" 0
cp "$T/user-plugins.bak" "$FAKE/claude/plugins.json"
jq 'map(if .name == "engsys" then .ref = "v1.0.0" else . end)' "$FAKE/claude/marketplaces.json" >"$FAKE/m.json" && mv "$FAKE/m.json" "$FAKE/claude/marketplaces.json"
m="$(mark)"; run fleet sync
rc_is "sync with scope supervised exits 0" 0
has "…and reconciled ~/.claude (user scope)" "$(since "$m" | grep 'CFG=unset$')" "plugin marketplace add https://github.com/vendor/engsys.git"
eq "…~/.claude: only user-scope plugin calls" "$(since "$m" | grep 'CFG=unset$' | grep -E 'marketplace (add|remove)|install ' | grep -vc -- '--scope user' || true)" 0
eq "fleet dir plugins" "$(jq -r '.[].id' "$FS/plugins.json" | sort | paste -sd' ' -)" "core@engsys ctx@acme extra@acme"
eq "~/.claude plugins" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"
run fleet sync --check; rc_is "both dirs in sync" 0
run fleet status
has "fleet status: the fleet dir's login" "$OUT" "claude config dir: $FCFG (FLEET_CLAUDE_CONFIG_DIR, scope supervised), login unknown"
has "fleet status: ~/.claude's login" "$OUT" "claude config dir: $HOME/.claude (interactive roles), login unknown"
# scope all (the default): the fleet dir only
cp "$T/flc.bak" "$LC"; printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$FCFG" >>"$LC"
m="$(mark)"; run fleet sync --check
rc_is "scope all: in sync" 0
eq "…no claude call against ~/.claude" "$(since "$m" | grep -v '^MARK' | grep -c 'CFG=unset$' || true)" 0
hasnt "…and no ~/.claude line" "$OUT" "(interactive roles)"
printf 'FLEET_CLAUDE_CONFIG_DIR_SCOPE=sometimes\n' >>"$LC"
run fleet sync --check
rc_is "an unknown scope is refused" 1
has "…named" "$OUT" "FLEET_CLAUDE_CONFIG_DIR_SCOPE must be all or supervised"
cp "$T/flc.bak" "$LC"

echo "== D2. the plugin step never touches project settings (engsys#112)"
APP_SETTINGS="$HOME/git/app/.claude/settings.json"
cp -p "$APP_SETTINGS" "$T/app-settings.orig"
cwd_mark() { wc -l <"$FAKE/claude.cwd" | tr -d ' '; }
cwd_since() { tail -n +"$(($1 + 1))" "$FAKE/claude.cwd"; }
stale_engsys() { jq 'map(if .name == "engsys" then .ref = "v1.0.0" else . end)' "$FAKE/claude/marketplaces.json" >"$FAKE/m.json" && mv "$FAKE/m.json" "$FAKE/claude/marketplaces.json"; }
# Like the incident: run from the pin checkout, with the engsys marketplace off its pin (remove → add → install).
stale_engsys; c="$(cwd_mark)"; b="$(mark)"
run bash -c "cd '$HOME/git/app' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' --instance '$INST' sync"
rc_is "sync from the pin checkout exits 0" 0
has "engsys marketplace swapped" "$OUT" "marketplace engsys: v1.0.0 → v1.1.0"
if cmp -s "$T/app-settings.orig" "$APP_SETTINGS"; then ok "pin checkout settings byte-identical after sync"; else bad "pin checkout settings byte-identical after sync" "$(diff "$T/app-settings.orig" "$APP_SETTINGS" || true)"; fi
seg="$(since "$b")"
has "remove is user-scoped" "$seg" "plugin marketplace remove engsys --scope user"
has "add is user-scoped" "$seg" "plugin marketplace add https://github.com/vendor/engsys.git#v1.1.0 --scope user"
has "every enabled plugin of the swapped marketplace gets an install call" "$seg" "plugin install core@engsys --scope user"
eq "plugins all back" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"
cwds="$(cwd_since "$c" | cut -f1 | sort -u)"
[ -n "$cwds" ] && ok "plugin calls were recorded" || bad "plugin calls were recorded"
eq "no plugin call ran inside a project (the pin checkout, the instance, the engsys checkout)" \
  "$(grep -E "^($HOME/git|$INST)(/|\$)" <<<"$cwds" || true)" ""
eq "every plugin call ran from sync's own empty dir" "$(grep -cvE '/fleet-sync\.[^/]+/cwd$' <<<"$cwds" || true)" 0
d="$(sed -n 's#/cwd$##p' <<<"$cwds" | head -1)"
[ -n "$d" ] && [ ! -e "$d" ] && ok "sync removed its temp dir" || bad "sync removed its temp dir" "${d:-none} still exists"

# A CLI that rewrites the project settings anyway: sync restores them and fails loudly, never "synced".
stale_engsys
run env FAKE_CLAUDE_WIPE="$APP_SETTINGS" bash -c "cd '$HOME/git/app' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' --instance '$INST' sync"
rc_is "a settings rewrite fails the sync" 1
has "…saying which call and which file" "$OUT" "marketplace remove engsys changed project settings ($APP_SETTINGS)"
has "…and that it restored them" "$OUT" "restored them from the snapshot"
hasnt "…never claims synced" "$OUT" "fleet-sync: synced."
if cmp -s "$T/app-settings.orig" "$APP_SETTINGS"; then ok "the rewritten settings were restored byte-identical"; else bad "the rewritten settings were restored byte-identical" "$(diff "$T/app-settings.orig" "$APP_SETTINGS" || true)"; fi
run fleet sync
rc_is "a plain re-run heals the host" 0
eq "plugins back after the re-run" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"

# A marketplace declared only by project settings: the scoped remove is refused, sync retries without --scope
# (from the same empty cwd) and still finishes at the pin (engsys#200).
stale_engsys; b="$(mark)"; c="$(cwd_mark)"
run env FAKE_CLAUDE_PROJECT_DECLARED=engsys bash -c "cd '$HOME/git/app' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' --instance '$INST' sync"
rc_is "a project-declared marketplace no longer fails the sync" 0
has "…the marketplace moved" "$OUT" "marketplace engsys: v1.0.0 → v1.1.0"
seg="$(since "$b")"
has "…the scoped remove was tried first" "$seg" "plugin marketplace remove engsys --scope user"
eq "…exactly one unscoped remove" "$(grep -E 'plugin marketplace remove engsys' <<<"$seg" | grep -vc -- '--scope' || true)" 1
eq "…plugins all back" "$(json_names plugins '.[].id')" "core@engsys ctx@acme extra@acme"
eq "…no plugin call ran inside a project" "$(cwd_since "$c" | cut -f1 | sort -u | grep -cE "^($HOME/git|$INST)(/|\$)" || true)" 0
if cmp -s "$T/app-settings.orig" "$APP_SETTINGS"; then ok "…pin checkout settings byte-identical"; else bad "…pin checkout settings byte-identical" "$(diff "$T/app-settings.orig" "$APP_SETTINGS" || true)"; fi
# Any other remove failure stays fatal (no blind retry).
stale_engsys
run env FAKE_CLAUDE_PROJECT_DECLARED=engsys FAKE_CLAUDE_REMOVE_FAIL=1 bash -c "cd '$HOME/git/app' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' --instance '$INST' sync"
rc_is "an unrelated remove failure still fails the sync" 1
run fleet sync
rc_is "…and a plain re-run heals the host" 0
# The unscoped fallback removes from EVERY scope: refused while another project has a project-scope install.
stale_engsys
jq '. + [{id: "core@engsys", version: "1.0.0", scope: "project", projectPath: "/somewhere/else/project"}]' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
m="$(mark)"
run env FAKE_CLAUDE_PROJECT_DECLARED=engsys bash -c "cd '$HOME/git/app' && bash '$ENGSYS_HOST/core/fleet/bin/fleet' --instance '$INST' sync"
rc_is "an unscoped fallback is refused while another project has an install" 1
has "…naming the other project's plugin" "$OUT" "/somewhere/else/project"
eq "…and no unscoped remove ran" "$(since "$m" | grep 'plugin marketplace remove engsys' | grep -vc -- '--scope' || true)" 0
jq 'map(select(.projectPath == null))' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
run fleet sync
rc_is "…and once that install is gone a plain sync heals the host" 0

# An enabled plugin installed at the wrong version: --check names it, sync refuses to say synced.
jq 'map(if .id == "core@engsys" then .version = "0.9.0" else . end)' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
run fleet sync --check
rc_is "a plugin off its pinned version is drift" 1; has "…named" "$OUT" "plugin core@engsys is at 0.9.0 (pin 1.1.0)"
run fleet sync
rc_is "sync fails on a plugin off its pinned version" 1
has "…naming it" "$OUT" "core@engsys (at 0.9.0, pin 1.1.0)"
has "…with the re-run instruction" "$OUT" "claude plugin uninstall --scope user <plugin@marketplace>"
hasnt "…never claims synced" "$OUT" "fleet-sync: synced."
jq 'map(if .id == "core@engsys" then .version = "1.1.0" else . end)' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
# A project-scope install (`claude plugin list` shows those too) doesn't count as installed.
jq 'map(if .id == "ctx@acme" then .scope = "project" else . end)' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
run fleet sync --check
rc_is "a project-scope install alone is drift" 1; has "…named" "$OUT" "plugin ctx@acme not installed"
jq 'map(select(.id != "ctx@acme" or .scope == "user"))' "$FAKE/claude/plugins.json" >"$FAKE/p.json" && mv "$FAKE/p.json" "$FAKE/claude/plugins.json"
run fleet sync
rc_is "sync installs it at user scope" 0; has "…" "$OUT" "installed ctx@acme"
run fleet sync --check; rc_is "in sync again" 0

echo "== E. launch: rendering, the 5th roster field, the launcher command lines"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
run fleet launch
rc_is "launch exits 0" 0
eq "fleet launch records each supervised session's pane (the supervisor reads seat limits only there)" "$(cat "$INST/logs/fleet-supervisor/acme-mm.pane" 2>/dev/null)" "%pane-acme-mm"
[ ! -f "$INST/logs/fleet-supervisor/acme-build.pane" ] && ok "…and not an interactive one's" || bad "…and not an interactive one's"
has "preflight ran" "$OUT" "preflight-ok"
[ -d "$HOME/git/worktrees" ] && ok "WORKTREES_DIR created" || bad "WORKTREES_DIR created"
S_ENV="$(cat "$STATE/env/session.env")"; X_ENV="$(cat "$STATE/env/security.env")"
has "session env rendered from the (v0.2.0) template" "$S_ENV" 'MODEL_ALIAS="model-m"'
has "…including the new line" "$S_ENV" "EXTRA=v2"
has "session env gets the identity lines" "$S_ENV" "GIT_AUTHOR_NAME=fleet-bot"
has "session env puts the gh shim first on PATH" "$S_ENV" "core/fleet/identity/bin"
has "session env drops an inherited GH_TOKEN" "$S_ENV" "unset GH_TOKEN GITHUB_TOKEN"
has "security env sources the session env" "$X_ENV" ". \"$STATE/env/session.env\""
has "security env overrides the model" "$X_ENV" 'MODEL_ALIAS="claude-opus-4-8"'
has "security env never inherits a subagent model override" "$X_ENV" "unset CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_SUBAGENT_MODEL_FORCE"
hasnt "…only the security lane" "$S_ENV" "unset CLAUDE_CODE_SUBAGENT_MODEL"
has "every rendered env gets the identity lines" "$X_ENV" "GIT_AUTHOR_NAME=fleet-bot"
has "…even the relative-path lane" "$(cat "$STATE/env/rel.env")" "GIT_AUTHOR_NAME=fleet-bot"
eq "env files are 0600" "$(mode_of "$STATE/env/session.env")" 600
ROSTER_OUT="$(cat "$STATE/roster")"
has "roster: tmux session rendered" "$ROSTER_OUT" "TMUX_SESSION=acme"
has "roster: ENV_FILE points at the rendered lane env" "$ROSTER_OUT" "ENV_FILE=$STATE/env/session.env"
has "roster: 5th field rendered" "$ROSTER_OUT" "acme-security|$HOME/git/app|/maintenance-monster|--model claude-opus-4-8|$STATE/env/security.env"
has "roster: monster line" "$ROSTER_OUT" "acme-mm|$HOME/git/app|/merge-monster|--model model-m --dangerously-skip-permissions"
tl() { grep -F "[send-keys] [-t] [acme:$1]" "$FAKE/tmux.log" | head -1; } # the launch command line for a window
has "mm: default env (roster ENV_FILE)" "$(tl acme-mm)" "cd $HOME/git/app && set -a && . $STATE/env/session.env && set +a && unset -f claude 2>/dev/null; unset FLEET_CLAUDE_CONFIG_DIR_SCOPE && unset CLAUDE_CONFIG_DIR && command claude --name acme-mm"
has "mm: prompt before the extra flags" "$(tl acme-mm)" "/merge-monster --model model-m --dangerously-skip-permissions"
has "security: the 5th field replaces ENV_FILE" "$(tl acme-security)" "set -a && . $STATE/env/security.env && set +a && unset -f claude 2>/dev/null; unset FLEET_CLAUDE_CONFIG_DIR_SCOPE && unset CLAUDE_CONFIG_DIR && command claude --name acme-security"
hasnt "security: the roster-level env is NOT used" "$(tl acme-security)" "session.env"
has "security: prompt before the extra flags" "$(tl acme-security)" "/maintenance-monster --model claude-opus-4-8"
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

# Claude-only: monsters and the security lane never start on another harness, whatever sets HARNESS.
for how in "HARNESS=copilot" "FLEET_ACTIVE_HARNESS=antigravity"; do
  : >"$FAKE/tmux.log"
  run env "$how" bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" launch acme-mm
  rc_is "$how: launching the merge monster is refused" 1
  has "…saying why" "$OUT" "run on Claude only"
  run env "$how" bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" launch acme-security
  rc_is "$how: launching the security lane is refused" 1
  eq "…nothing reached tmux" "$(grep -c send-keys "$FAKE/tmux.log" || true)" 0
done
cp "$INST/fleet/roster.tmpl" "$T/roster.bak"; sed -i.x '1a\
HARNESS=copilot' "$INST/fleet/roster.tmpl"; rm -f "$INST/fleet/roster.tmpl.x"
run fleet launch acme-mm
rc_is "a HARNESS= line in the roster: the merge monster is refused too" 1
cp "$T/roster.bak" "$INST/fleet/roster.tmpl"
# An interactive session on the security lane (5th field security*) is Claude-only as well; a plain
# interactive one is not refused for it (positive control).
printf 'acme-audit|||--model m|__ENV_DIR__/security.env\n' >>"$INST/fleet/roster.tmpl"
run env HARNESS=copilot bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" launch acme-audit
rc_is "HARNESS=copilot: a security-lane interactive session is refused" 1
has "…saying why" "$OUT" "run on Claude only"
run env HARNESS=copilot bash "$ENGSYS_HOST/core/fleet/bin/fleet" --instance "$INST" launch acme-build
hasnt "HARNESS=copilot: a plain interactive session is not refused as Claude-only" "$OUT" "run on Claude only"
cp "$T/roster.bak" "$INST/fleet/roster.tmpl"
# A harness.fallback file on the host (session-writable) never selects a harness any more.
LC="$HOME/.config/acme/fleet.local.conf"; cp "$LC" "$T/flc0.bak" 2>/dev/null || : >"$T/flc0.bak"
printf 'HARNESS_FALLBACK=copilot\n' >>"$LC"; mkdir -p "$INST/logs/fleet-supervisor"; echo copilot >"$INST/logs/fleet-supervisor/harness.fallback"
grep -Fxv acme-build "$FAKE/tmux/windows" >"$FAKE/w.new" || true; mv "$FAKE/w.new" "$FAKE/tmux/windows"; : >"$FAKE/tmux.log"
run fleet launch acme-build
rc_is "with a harness.fallback file present, a launch still works" 0
has "…on Claude (positive control: the interactive session starts)" "$(tl acme-build)" "claude --name acme-build"
cp "$T/flc0.bak" "$LC"; rm -f "$INST/logs/fleet-supervisor/harness.fallback"

# The fleet's Claude config dir reaches every launched session (monsters, interactive, security): R1.
has "no FLEET_CLAUDE_CONFIG_DIR: a launched session drops any inherited CLAUDE_CONFIG_DIR" "$(tl acme-build)" "unset CLAUDE_CONFIG_DIR && "
FCFG="$T/fleet-claude"; mkdir -p "$FCFG"
LC="$HOME/.config/acme/fleet.local.conf"; cp "$LC" "$T/flc.bak" 2>/dev/null || : >"$T/flc.bak"
printf 'FLEET_CLAUDE_CONFIG_DIR=%s\n' "$FCFG" >>"$LC"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
CLAUDE_CONFIG_DIR="$T/inherited" run fleet launch
rc_is "launch with FLEET_CLAUDE_CONFIG_DIR exits 0" 0
for w in acme-mm acme-security acme-build; do
  has "$w: launched with CLAUDE_CONFIG_DIR=<the fleet's dir>" "$(tl "$w")" "CLAUDE_CONFIG_DIR=$FCFG"
  hasnt "$w: …never the inherited one" "$(tl "$w")" "$T/inherited"
done
has "the rendered session env carries it too" "$(cat "$STATE/env/session.env")" "CLAUDE_CONFIG_DIR=$FCFG"
has "…and the security env" "$(cat "$STATE/env/security.env")" "CLAUDE_CONFIG_DIR=$FCFG"
for w in acme-mm acme-security acme-build; do
  has "$w (scope all): the dir is set after the env file, so no env-file variable can move it" "$(tl "$w")" "set +a && unset -f claude 2>/dev/null; unset FLEET_CLAUDE_CONFIG_DIR_SCOPE && export CLAUDE_CONFIG_DIR=$FCFG && command claude"
done
# FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised: monsters and the security lane keep the fleet dir; the
# interactive roles run on ~/.claude (unset on the launch line and in their env file).
printf 'FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised\n' >>"$LC"
printf 'acme-audit|||--model claude-opus-4-8|__ENV_DIR__/security.env\n' >>"$INST/fleet/roster.tmpl"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
CLAUDE_CONFIG_DIR="$T/inherited" run fleet launch
rc_is "launch with scope supervised exits 0" 0
for w in acme-mm acme-security acme-audit; do
  has "$w (supervised / security lane): CLAUDE_CONFIG_DIR=<the fleet dir>" "$(tl "$w")" "export CLAUDE_CONFIG_DIR=$FCFG && "
done
has "acme-build (interactive): CLAUDE_CONFIG_DIR unset, ~/.claude" "$(tl acme-build)" "FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised && unset CLAUDE_CONFIG_DIR && command claude"
hasnt "…never the fleet dir" "$(tl acme-build)" "export CLAUDE_CONFIG_DIR=$FCFG"
has "a monster learns the fleet dir and the scope (the baton refuses a session off it)" "$(tl acme-mm)" "export FLEET_CLAUDE_CONFIG_DIR=$FCFG FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised && "
has "…an interactive one too, so its baton calls are refused" "$(tl acme-build)" "FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised"
has "acme-rel (interactive, its own env): unset too" "$(tl acme-rel)" "unset CLAUDE_CONFIG_DIR && "
has "session.env (interactive users): unsets it" "$(cat "$STATE/env/session.env")" "unset CLAUDE_CONFIG_DIR"
hasnt "…and doesn't set it" "$(cat "$STATE/env/session.env")" "CLAUDE_CONFIG_DIR=$FCFG"
has "security.env (security lane only): the fleet dir" "$(cat "$STATE/env/security.env")" "CLAUDE_CONFIG_DIR=$FCFG"
# a security env that also sources session.env (which unsets it) still ends on the fleet dir
has "…after it sources session.env" "$(sed -n '/session.env/,$p' "$STATE/env/security.env")" "CLAUDE_CONFIG_DIR=$FCFG"
# named relaunch (the supervisor's path) of a supervised session: the fleet dir too
grep -Fxv acme-mm "$FAKE/tmux/windows" >"$FAKE/w.new" || true; mv "$FAKE/w.new" "$FAKE/tmux/windows"; : >"$FAKE/tmux.log"
run fleet launch acme-mm
has "named relaunch of a supervised session: the fleet dir" "$(tl acme-mm)" "export CLAUDE_CONFIG_DIR=$FCFG && "
# Lines the launcher arms as monsters or security tier, whatever spelling: they must get the fleet dir.
cp "$INST/fleet/roster.tmpl" "$T/roster.pre-f1"
cp "$INST/fleet/env/security.env.tmpl" "$INST/fleet/env/nyx.env.tmpl"
cat >>"$INST/fleet/roster.tmpl" <<'R'
acme-nl|__PIN_DIR__|Run the merge monster skill now|--dangerously-skip-permissions
acme-us|__PIN_DIR__|/engsys:merge_monster|--dangerously-skip-permissions
acme-Merge|__PIN_DIR__|/merge-monster|--dangerously-skip-permissions
acme-nyx|||--model claude-opus-4-8|__ENV_DIR__/nyx.env
acme-o48|||--model claude-opus-4-8
R
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
run fleet launch
has "nyx.env (a security lane) unsets the subagent model override" "$(cat "$STATE/env/nyx.env")" "unset CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_SUBAGENT_MODEL_FORCE"
for w in acme-nl acme-us acme-Merge acme-nyx acme-o48; do
  has "$w: launched on the fleet dir" "$(tl "$w")" "export CLAUDE_CONFIG_DIR=$FCFG && "
done
has "acme-Merge is gated by fleet verify like any merge monster" "$OUT" "fleet verify: Claude config dir"
has "positive control: acme-build still runs on ~/.claude" "$(tl acme-build)" "unset CLAUDE_CONFIG_DIR && command claude"
# The launcher itself never puts a monster or security line on ~/.claude, even if told it's interactive.
printf 'NAMESPACE=acme\nacme-nl|%s|Run the merge monster skill now|--x\nacme-o48|%s||--model claude-opus-4-8\nacme-plain|%s||--x\n' "$HOME/git/app" "$HOME/git/app" "$HOME/git/app" >"$T/f1.roster"
: >"$FAKE/tmux.log"; rm -rf "$FAKE/tmux"
CLAUDE_CONFIG_DIR="$FCFG" FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" acme-nl acme-o48 acme-plain " run bash "$ENGSYS_HOST/core/skills/agent-sessions/scripts/launch-agent-sessions.sh" --roster "$T/f1.roster"
has "launcher: a monster prompt keeps the fleet dir though listed interactive" "$(tl acme-nl)" "export CLAUDE_CONFIG_DIR=$FCFG && "
has "launcher: an opus-4-8 line keeps it too" "$(tl acme-o48)" "export CLAUDE_CONFIG_DIR=$FCFG && "
has "launcher: positive control, a plain listed line gets ~/.claude" "$(tl acme-plain)" "unset CLAUDE_CONFIG_DIR && command claude"
cp "$T/roster.pre-f1" "$INST/fleet/roster.tmpl"; rm -f "$INST/fleet/env/nyx.env.tmpl"
cp "$T/roster.bak2" "$INST/fleet/roster.tmpl" 2>/dev/null || sed -i.x '/^acme-audit|/d' "$INST/fleet/roster.tmpl"; rm -f "$INST/fleet/roster.tmpl.x"
cp "$T/flc.bak" "$LC"

echo "== K. FLEET_CLAUDE_CONFIG_DIR_PER_SESSION: one Claude login per session (engsys#205)"
mkdir -p "$FAKE/loggedin" "$FAKE/loggedout"
SESS="$FCFG.sessions"
setconf() { cp "$T/flc.bak" "$LC"; printf '%s\n' "$@" >>"$LC"; }
login_all() { local n; for n in "$@"; do touch "$FAKE/loggedin/$n"; rm -f "$FAKE/loggedout/$n"; done; }
setconf "FLEET_CLAUDE_CONFIG_DIR=$FCFG" "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
run fleet config-dir init
rc_is "per-session init exits 0" 0
for n in acme-mm acme-build acme-security acme-rel; do
  [ -f "$SESS/$n/settings.json" ] && ok "init: $n has its own dir" || bad "init: $n has its own dir"
  eq "…seeded with the claude.ai sync off" "$(jq -c '[.syncClaudeAiSkills, .syncClaudeAiPlugins]' "$SESS/$n/settings.json")" '[false,false]'
  has "…and the one-time login command is printed for it" "$OUT" "$n: CLAUDE_CONFIG_DIR=$SESS/$n claude"
  eq "…mode 700" "$(mode_of "$SESS/$n")" 700
done
login_all acme-mm
run fleet config-dir init
hasnt "init (idempotent): a logged-in dir is not asked to log in again" "$OUT" "acme-mm: CLAUDE_CONFIG_DIR"
has "…the others still are" "$OUT" "acme-build: CLAUDE_CONFIG_DIR=$SESS/acme-build claude"
run fleet config-dir init --session acme-mm
has "init --session: just that one" "$OUT" "session acme-mm -> $SESS/acme-mm"
hasnt "…not the others" "$OUT" "session acme-build"
run fleet config-dir init --session acme-nope
rc_is "init --session for an unknown session is refused" 1
login_all acme-mm acme-build acme-security acme-rel
# launch: every session has its own CLAUDE_CONFIG_DIR, set last on the launch line; no two share
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"; run fleet launch
rc_is "per-session launch exits 0" 0
for n in acme-mm acme-build acme-security acme-rel; do
  has "$n: launched on its own dir" "$(tl "$n")" "export CLAUDE_CONFIG_DIR=$SESS/$n && command claude"
done
eq "no two sessions share a config dir" "$(for n in acme-mm acme-build acme-security acme-rel; do tl "$n" | grep -o "export CLAUDE_CONFIG_DIR=[^ ]*"; done | sort | uniq -d | wc -l | tr -d ' ')" 0
hasnt "the shared base dir is on no launch line" "$(cat "$FAKE/tmux.log")" "export CLAUDE_CONFIG_DIR=$FCFG &&"
hasnt "a shared env file carries no one session's dir" "$(cat "$STATE/env/session.env")" "CLAUDE_CONFIG_DIR=$SESS"
# scope supervised: interactive roles keep ~/.claude, the monsters keep their own dirs
setconf "FLEET_CLAUDE_CONFIG_DIR=$FCFG" "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on" "FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"; run fleet launch
rc_is "per-session + scope supervised: launch exits 0" 0
has "acme-mm: its own dir" "$(tl acme-mm)" "export CLAUDE_CONFIG_DIR=$SESS/acme-mm && command claude"
has "…the baton gate sees the same dir as FLEET_CLAUDE_CONFIG_DIR" "$(tl acme-mm)" "export FLEET_CLAUDE_CONFIG_DIR=$SESS/acme-mm FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised"
has "acme-security: its own dir" "$(tl acme-security)" "export CLAUDE_CONFIG_DIR=$SESS/acme-security && command claude"
has "acme-build (interactive): ~/.claude" "$(tl acme-build)" "unset CLAUDE_CONFIG_DIR && command claude"
hasnt "…never a session dir" "$(tl acme-build)" "$SESS/acme-build"
run fleet config-dir init
hasnt "init under scope supervised: no dir for an interactive role" "$OUT" "session acme-build"
# a session with no dir, or a logged-out one, is held alone with the command that fixes it
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
mv "$SESS/acme-mm" "$SESS/acme-mm.away"; run fleet launch acme-mm
rc_is "no dir yet: the launch is refused" 1
has "…saying what to run" "$OUT" "fleet config-dir init --session acme-mm"
has "…and how to log in" "$OUT" "CLAUDE_CONFIG_DIR=$SESS/acme-mm claude"
eq "…nothing reached tmux" "$(grep -c send-keys "$FAKE/tmux.log" || true)" 0
mv "$SESS/acme-mm.away" "$SESS/acme-mm"
rm -f "$FAKE/loggedin/acme-security"; touch "$FAKE/loggedout/acme-security"
run fleet launch
rc_is "one logged-out session dir: the whole launch exits non-zero" 1
has "…naming it and the command" "$OUT" "SKIPPED: acme-security (its own Claude login ($SESS/acme-security) is not logged in: CLAUDE_CONFIG_DIR=$SESS/acme-security claude"
has "…while the other sessions start" "$(tl acme-mm)" "export CLAUDE_CONFIG_DIR=$SESS/acme-mm"
hasnt "…and the logged-out one does not" "$(cat "$FAKE/tmux.log")" "[acme:acme-security]"
login_all acme-security
# sync: the pinned plugins go into every session dir; a missing dir is drift for that session only
rm -rf "$SESS/acme-rel"; setconf "FLEET_CLAUDE_CONFIG_DIR=$FCFG" "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
m="$(mark)"; run fleet sync
rc_is "per-session sync exits 0 (a missing dir is a warning)" 0
has "…says which session has no dir" "$OUT" "session acme-rel has no config dir yet"
for n in acme-mm acme-build acme-security; do
  has "sync: $n's own dir got the plugins" "$(since "$m" | grep "CFG=$SESS/$n\$")" "plugin install"
done
run fleet sync --check
rc_is "--check: the missing session dir is drift" 1
has "…each dir is reported as its session's own" "$OUT" "claude config dir: $SESS/acme-mm (session acme-mm, own login)"
login_all acme-rel; run fleet config-dir init --session acme-rel >/dev/null; run fleet sync
rc_is "after init, sync covers acme-rel too" 0
run fleet sync --check
rc_is "…and everything is in sync" 0
# verify: a verdict per session dir; one bad dir fails only its session
run fleet verify
rc_is "per-session verify passes when every dir does" 0
has "…one block per session" "$OUT" "== session acme-mm ($SESS/acme-mm) =="
echo '{"enabledPlugins":{"stray@market":true},"syncClaudeAiSkills":false,"syncClaudeAiPlugins":false}' >"$SESS/acme-security/settings.json"
run fleet verify
rc_is "a stray plugin in one session's dir: the run is a mismatch" 1
has "…named in that session's block" "$(sed -n '/== session acme-security/,$p' <<<"$OUT")" "$SESS/acme-security/settings.json enables unpinned plugin stray@market"
run fleet verify --session acme-mm
rc_is "…another session verifies clean on its own" 0
run fleet launch acme-security
rc_is "…and only the bad one is refused a launch" 1
has "…saying its dir" "$OUT" "its engsys plugin (in $SESS/acme-security) does not match"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"; run fleet launch acme-mm
rc_is "…while the good one launches" 0
echo '{"syncClaudeAiSkills":false,"syncClaudeAiPlugins":false}' >"$SESS/acme-security/settings.json"
rm -f "$FAKE/loggedin/acme-mm"; touch "$FAKE/loggedout/acme-mm"; rm -f "$STATE/auth-ok.acme-mm"
run fleet verify
rc_is "a logged-out session dir is 'not verified' (a hold) for that session" 3
has "…naming its dir and the login command" "$(sed -n '/== session acme-mm/,/== session acme-build/p' <<<"$OUT")" "CLAUDE_CONFIG_DIR=$SESS/acme-mm claude, then /login"
run fleet verify --session acme-security
rc_is "…the others still pass" 0
login_all acme-mm
# a login that works is not asked about again within --max-age (and a logged-out one never is cached)
: >"$FAKE/claude.log"; run fleet verify --session acme-mm --max-age 15; run fleet verify --session acme-mm --max-age 15
eq "verify --max-age: one auth status per dir" "$(grep -c '^auth status' "$FAKE/claude.log" || true)" 1
# claude calls fleet commands make against one session dir never overlap (the CLI contacts the API even for status/list)
setconf "FLEET_CLAUDE_CONFIG_DIR=$FCFG" "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
: >"$T/lock.order"
(
  export FLEET_INSTANCE="$INST"
  # shellcheck source=/dev/null
  . "$ENGSYS_HOST/core/fleet/lib/fleet-env.sh"
  for i in 1 2; do fleet_dir_lock "$SESS/acme-mm" bash -c "echo start >>'$T/lock.order'; sleep 1; echo end >>'$T/lock.order'" & done
  wait
)
eq "per-dir lock: two calls on one dir run one after the other" "$(paste -sd' ' "$T/lock.order")" "start end start end"
# path safety
(
  export FLEET_INSTANCE="$INST"
  # shellcheck source=/dev/null
  . "$ENGSYS_HOST/core/fleet/lib/fleet-env.sh"
  . "$ENGSYS_HOST/core/fleet/lib/session-dirs.sh"
  for bad in '../x' 'a/b' '.hidden' 'a..b' '' '..' 'x y' '/etc'; do
    if fleet_session_config_dir "$bad" >/dev/null; then bad "path safety: '$bad' must not get a dir"; else ok "path safety: '$bad' is refused"; fi
  done
  eq "path safety: a plain name maps under the base" "$(fleet_session_config_dir acme-mm)" "$FCFG.sessions/acme-mm"
)
printf 'NAMESPACE=acme\nacme-a..b|%s|/p|--x\n' "$HOME/git/app" >"$T/hostile.roster"; : >"$FAKE/tmux.log"; rm -rf "$FAKE/tmux"
CLAUDE_CONFIG_DIR="$FCFG" ENGSYS_CONFIG_DIR_SESSIONS="$FCFG.sessions" run bash "$ENGSYS_HOST/core/skills/agent-sessions/scripts/launch-agent-sessions.sh" --roster "$T/hostile.roster"
has "the launcher refuses a session name that could leave the base" "$OUT" "can't be a per-session Claude config dir name"
eq "…nothing reached tmux" "$(grep -c send-keys "$FAKE/tmux.log" || true)" 0
# off again: the shared dir, as before
setconf "FLEET_CLAUDE_CONFIG_DIR=$FCFG"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"; run fleet launch
has "per-session off: the shared base dir again" "$(tl acme-mm)" "export CLAUDE_CONFIG_DIR=$FCFG && command claude"
setconf "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
run fleet verify
rc_is "per-session on without FLEET_CLAUDE_CONFIG_DIR is a config error" 3
has "…saying so" "$OUT" "needs FLEET_CLAUDE_CONFIG_DIR"
cp "$T/flc.bak" "$LC"; rm -rf "$SESS" "$FAKE/tmux"; : >"$FAKE/tmux.log"

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
has "conf: INTEGRITY_CMD defaulted to fleet verify, throttled to 15 min (engsys#70)" "$SUP" "INTEGRITY_CMD=bash $ENGSYS_HOST/core/fleet/bin/fleet --instance $INST verify --alert --auto-sync --max-age 15"
has "the integrity check ran in the tick and passed" "$(cat "$INST/logs/fleet-supervisor/supervisor.log")" "integrity: ok"
eq "the relaunched supervised session's pane is recorded (seat-limit evidence)" "$(cat "$INST/logs/fleet-supervisor/acme-mm.pane" 2>/dev/null)" "%pane-acme-mm"
hasnt "supervisor conf: no harness fallback is handed to the supervisor (Claude-only)" "$(cat "$STATE/supervisor.conf")" "HARNESS_FALLBACK"
has "stale monster with no window is relaunched through the kit" "$(grep -F '[new-session]' "$FAKE/tmux.log" | grep -F '[acme-mm]' || true)" "[acme-mm]"
hasnt "closed ledger (kill switch) is left alone" "$(cat "$FAKE/tmux.log")" "[acme-security]"
has "supervisor log kept in the instance" "$(cat "$INST/logs/fleet-supervisor/supervisor.log")" "acme-security: ledger acme/app#12 CLOSED"
has "relaunch reported on the ledger" "$(cat "$FAKE/gh.log")" "issue comment 11 -R acme/app"
has "the supervisor's gh calls went through the identity shim" "$(cat "$FAKE/shim.log")" "shim gh issue view 11"

echo "== F2. a pin checkout behind main with changed auto-loaded files: the supervisor auto-syncs"
APPD="$HOME/git/app"
behind() { # behind <file> — main moves on with a change to a file sessions load
  mkdir -p "$P/$(dirname "$1")"; printf 'v%s\n' "$RANDOM" >>"$P/$1"; git -C "$P" pull -q origin main 2>/dev/null || true
  commit_all "$P" "move $1"; push_all "$P"
}
run fleet verify; rc_is "positive control: in step with main, verify passes" 0
behind .claude/agents/helper.md
run fleet verify
rc_is "behind main with a changed .claude file: a stale mismatch" 1
has "…named stale" "$OUT" "stale      .claude/agents/helper.md differs from main"
h0="$(git -C "$APPD" rev-parse HEAD)"; run fleet verify
eq "…and plain verify doesn't touch the checkout" "$(git -C "$APPD" rev-parse HEAD)" "$h0"
run fleet verify --alert
has "…its alert says behind main, not tampering" "$OUT" "is behind main, and files the sessions load changed there"
has "…and, without --auto-sync, asks for fleet sync instead of claiming it runs" "$OUT" "Run fleet sync (a supervised host also does it on its own"
hasnt "…" "$OUT" "Auto-syncing: fleet sync is running"
rm -f "$STATE/verify-wrappers.alerted"
: >"$FAKE/launchctl.log"
run fleet verify --auto-sync
rc_is "--auto-sync on a clean checkout of main: syncs and passes" 0
eq "…without touching launchd (it runs inside the supervisor's job)" "$(cat "$FAKE/launchctl.log")" ""
has "…saying it auto-syncs" "$OUT" "auto-syncing (fleet sync, no restarts)"
eq "…the checkout is at main now" "$(git -C "$APPD" rev-parse HEAD)" "$(git -C "$P" rev-parse HEAD)"
behind notes.txt; git -C "$APPD" pull -q --ff-only origin main   # a tracked, ordinary file to dirty
behind CLAUDE.md
printf 'local edit\n' >>"$APPD/notes.txt"
run fleet verify --auto-sync
rc_is "a dirty checkout is not auto-synced: mismatch stands" 1
has "…saying why" "$OUT" "could not auto-sync: the pin checkout has uncommitted changes to tracked files"
git -C "$APPD" checkout -q -- notes.txt
# Claude Code's own runtime files in .claude/ (not even gitignored here) never block the auto-sync.
git -C "$APPD" pull -q --ff-only origin main; behind CLAUDE.md
printf '{}' >"$APPD/.claude/settings.local.json"; printf '1' >"$APPD/.claude/scheduled_tasks.lock"
run fleet verify --auto-sync
rc_is "runtime files in .claude/: still auto-synced" 0
rm -f "$APPD/.claude/settings.local.json" "$APPD/.claude/scheduled_tasks.lock"
behind CLAUDE.md
git -C "$APPD" -c user.name=t -c user.email=t@x commit -q --allow-empty -m "local only"
run fleet verify --auto-sync
rc_is "a diverged checkout is not auto-synced: mismatch" 1
has "…it is not an ancestor of main" "$OUT" "is not main or an ancestor of it"
hasnt "…and no sync was tried" "$OUT" "auto-syncing"
git -C "$APPD" fetch -q origin; git -C "$APPD" reset -q --hard refs/remotes/origin/main
run fleet verify; rc_is "back on main: passes" 0
# A local branch and a local tag named origin/main (which make `symbolic-ref --short` ambiguous) never
# break sync or auto-sync: refs are read in full.
git -C "$APPD" remote set-head origin main >/dev/null 2>&1 || git -C "$APPD" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$APPD" branch -q origin/main HEAD~1 2>/dev/null || git -C "$APPD" branch -q origin/main
git -C "$APPD" tag origin/main HEAD
run fleet sync --check
rc_is "a planted branch and tag named origin/main: sync --check still works" 0
behind CLAUDE.md
run fleet verify --auto-sync
rc_is "…and auto-sync still fast-forwards and passes" 0
eq "…to the real origin/main" "$(git -C "$APPD" rev-parse HEAD)" "$(git -C "$P" rev-parse HEAD)"
git -C "$APPD" branch -q -D origin/main; git -C "$APPD" tag -d origin/main >/dev/null
grep -q -- '--auto-sync' "$STATE/supervisor.conf" && ok "the supervisor's INTEGRITY_CMD passes --auto-sync" || bad "the supervisor's INTEGRITY_CMD passes --auto-sync" "$(cat "$STATE/supervisor.conf")"

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
hasnt "no login hold → no auth line" "$OUT" "auth: expired"
# the supervisor holds relaunches for an expired Claude Code login (engsys#103): status says so
mkdir -p "$INST/logs/fleet-supervisor"; printf '2026-10-06T12:44:25Z\nthe `acme-mm` window\n' >"$INST/logs/fleet-supervisor/auth.expired"
printf 'acme-mm\nacme-rel\n' >"$INST/logs/fleet-supervisor/auth.held"
run fleet restart --status
has "login hold → auth: expired since <time>" "$OUT" "auth: expired since 6 Oct 12:44 UTC. The supervisor relaunches and kills nothing until it works (held: acme-mm, acme-rel); run /login in any session, or claude /login"
run fleet status
has "  …in \`fleet status\` too" "$OUT" "auth: expired since"
rm -f "$INST/logs/fleet-supervisor/auth.expired" "$INST/logs/fleet-supervisor/auth.held"
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
eq "without GH_APP_ENV no shim is put on PATH" "$(since "$b" | grep -v -e "PATH0=$T/bin" -e "PATH0=$T/fake-release" -e '^MARK' || true)" ""
reset_tmux
run fleet launch
rc_is "launch works without an identity" 0
hasnt "env files carry no identity lines" "$(cat "$STATE/env/session.env")" "GIT_AUTHOR_NAME"
hasnt "env files carry no gh shim without identity" "$(cat "$STATE/env/session.env")" "core/fleet/identity/bin"
run fleet install-jobs --dry-run
has "gh-app-login job is not installed without GH_APP_ENV" "$OUT" "skipped: com.acme.fleet.gh-app-login (GH_APP_ENV is not set)"
rm -f "$HOME/.config/acme/fleet.local.conf"

# --- fleet time: the operator time format (#89) ---------------------------------------------------
YR="$(date -u +%Y)"
run fleet time "$YR-10-05T19:44:00Z"
rc_is "fleet time with no setting" 0
eq "defaults to UTC, 24h" "$OUT" "5 Oct 19:44 UTC"
printf 'OPERATOR_TIMEZONE=America/New_York\nOPERATOR_CLOCK=12h\n' >"$HOME/.config/acme/fleet.local.conf"
run fleet time "$YR-10-05T19:44:00Z"
eq "single-fleet mode reads OPERATOR_TIMEZONE / OPERATOR_CLOCK from the conf" "$OUT" "Oct 5, 3:44 PM EDT"
run fleet time "$YR-10-05T19:44:00Z" --time
eq "--time" "$OUT" "3:44 PM EDT"
printf 'OPERATOR_TIMEZONE=Nope/Zone\n' >"$HOME/.config/acme/fleet.local.conf"
run fleet time "$YR-10-05T19:44:00Z"
rc_is "an invalid zone still renders" 0
has "  …falling back to UTC" "$OUT" "5 Oct 19:44 UTC"
has "  …with a warning" "$OUT" "not an IANA time zone"
printf 'version: 1\nfleets:\n  eric:\n    timezone: Europe/Berlin\n    clock: 24h\n' >"$T/operator-time-fed.yml"
printf 'FLEET_ID=eric\nFEDERATION_FILE=%s\nOPERATOR_TIMEZONE=America/New_York\nOPERATOR_CLOCK=12h\n' "$T/operator-time-fed.yml" >"$HOME/.config/acme/fleet.local.conf"
run fleet time "$YR-10-05T19:44:00Z"
eq "multi-fleet mode: the registry's timezone and clock win over the conf" "$OUT" "5 Oct 21:44 CEST"
run fleet launch
S_ENV="$(cat "$STATE/env/session.env")"
has "session env carries the zone" "$S_ENV" "OPERATOR_TIMEZONE=Europe/Berlin"
has "session env carries the clock" "$S_ENV" "OPERATOR_CLOCK=24h"
rm -f "$HOME/.config/acme/fleet.local.conf"

echo "== J. CT-13: per-instance worktree isolation and Copilot plugin sync"
git -C "$ENGSYS_HOST" checkout -q v1.1.0
printf 'INSTANCE_MARKETPLACE=\nGH_APP_ENV=\nENGSYS_REF=v1.2.0\nHARNESS=copilot\nFLEET_ISOLATE_ENGSYS_WORKTREE=1\n' >"$HOME/.config/acme/fleet.local.conf"
run fleet sync
rc_is "CT-13: isolated worktree + copilot sync exits 0" 0
has "CT-13: isolated worktree created at pin" "$OUT" "engsys (isolated worktree): absent → v1.2.0"
eq "CT-13: host ENGSYS_DIR checkout was NOT moved (sibling fleet safe)" "$(git -C "$ENGSYS_HOST" describe --tags --exact-match)" v1.1.0
eq "CT-13: per-instance worktree at $STATE/engsys is at v1.2.0" "$(git -C "$STATE/engsys" describe --tags --exact-match)" v1.2.0
[ -f "$STATE/copilot-home/config.json" ] && ok "CT-13: copilot config.json written in per-instance COPILOT_HOME" || bad "CT-13: copilot config.json written"
rm -f "$HOME/.config/acme/fleet.local.conf"
git -C "$ENGSYS_HOST" worktree remove --force "$STATE/engsys" >/dev/null 2>&1 || true

# =============================================================================================
finish fleet.test
