#!/usr/bin/env bash
# launch.sh — launch the fleet sessions (tmux windows) via the engsys agent-sessions launcher.
#
# Renders the instance's templates into <instance>/.fleet/ (machine-local, gitignored):
#   fleet/env/<lane>.env.tmpl  → .fleet/env/<lane>.env   (when GH_APP_ENV is set, each also gets the
#                                                          env-scoped git identity, the gh shim first
#                                                          on PATH, and GH_TOKEN/GITHUB_TOKEN unset)
#   fleet/roster.tmpl          → .fleet/roster            (the launcher's roster; a session line's
#                                                          optional 5th field names a per-session env)
# Each env also gets FLEET_ID (and FEDERATION_FILE, when that file exists, FLEET_INSTANCE_REPO, when
# set, and FLEET_INBOX_DIR, the relay's per-session inbox) when fleet.conf sets FLEET_ID, and
# OPERATOR_TIMEZONE / OPERATOR_CLOCK when the fleet sets a time format.
# then runs the launcher from PIN_DIR (the sessions' default workdir). Identity preflights belong in
# the roster (PREFLIGHT= lines); they warn, never block.
#
# Sessions that are not on this host (ROLES / ROSTER_EXCLUDE in fleet.local.conf, or a singleton monster
# whose registry home is another fleet: lib/host-roles.sh) are left out of a launch with no name, and
# naming one is refused unless --force-excluded. The launcher gets .fleet/roster.host, the roster minus
# those sessions; .fleet/roster stays the whole rendered roster.
#
# Usage: launch.sh [--instance <dir>]                              # every session that runs on this host
#        launch.sh [--instance <dir>] <name> [--force-excluded]    # just one (the supervisor relaunches this way)
#        launch.sh [--instance <dir>] --check <name>               # exit 0 if <name> runs on this host, else
#                                                                  # 1 and the reason (the supervisor's HOST_CHECK_CMD)
#        launch.sh [--instance <dir>] --host-health                 # exit 0, or 1 and an alert when an unreadable
#                                                                  # registry keeps merge/maintain off this host
#                                                                  # (the supervisor's HOST_HEALTH_CMD)
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
name="" check=0 force_excluded=0 health=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --force-excluded) force_excluded=1 ;;
    --host-health) health=1 ;;
    -*) echo "fleet: launch: unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "fleet: launch takes one session name" >&2; exit 2; }; name="$1" ;;
  esac
  shift
done
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
fleet_host_init

if [ "$health" = 1 ]; then
  if fleet_host_registry_alert; then exit 1; fi
  echo "host roles: ok"; exit 0
fi
if [ "$check" = 1 ]; then
  [ -n "$name" ] || fleet_die "launch --check needs a session name"
  fleet_roster_sessions | grep -Fxq "$name" || { echo "$name: not in the roster"; exit 1; }
  if why="$(fleet_host_excluded "$name")"; then echo "$name: not on this host ($why)"; exit 1; fi
  echo "$name: runs on this host"; exit 0
fi
[ "$force_excluded" = 0 ] || [ -n "$name" ] || fleet_die "--force-excluded needs a session name (it never applies to a whole-roster launch)"
if [ -n "$name" ] && why="$(fleet_host_excluded "$name")"; then
  [ "$force_excluded" = 1 ] || fleet_die "$name is not on this host ($why). To start it here anyway: fleet launch $name --force-excluded"
  echo "fleet: WARNING launching $name although it is not on this host ($why), as --force-excluded asks" >&2
fi

fleet_check_engsys
[ -d "$PIN_DIR" ] || fleet_die "PIN_DIR not found: $PIN_DIR (set it in fleet/fleet.conf or ~/.config/$FLEET_ORG/fleet.local.conf)"
[ -f "$FLEET_REPO/fleet/roster.tmpl" ] || fleet_die "$FLEET_REPO/fleet/roster.tmpl not found"
LAUNCHER="$ENGSYS_DIR/core/skills/agent-sessions/scripts/launch-agent-sessions.sh"
[ -f "$LAUNCHER" ] || fleet_die "launcher not found: $LAUNCHER"

[ -z "${WORKTREES_DIR:-}" ] || mkdir -p "$WORKTREES_DIR"   # --add-dir target for interactive roles

mkdir -p "$ENV_DIR" && chmod 700 "$ENV_DIR"
shopt -s nullglob
for tmpl in "$FLEET_REPO"/fleet/env/*.env.tmpl; do
  dest="$ENV_DIR/$(basename "$tmpl" .env.tmpl).env"
  fleet_render "$tmpl" "$dest"
  if [ -n "${GH_APP_ENV:-}" ]; then
    fleet_git_env_lines "$GH_APP_ENV" >>"$dest" || fleet_die "can't build the fleet git identity for $dest — see above"
    # gh in the session goes through the App shim; a token inherited from the launching shell
    # (e.g. a personal GH_TOKEN) must never override it.
    {
      echo "# Fleet gh identity (core/fleet/launch.sh): the App shim first on PATH, no inherited token."
      echo "unset GH_TOKEN GITHUB_TOKEN"
      printf 'PATH=%q:"$PATH"\n' "$ENGSYS_DIR/core/fleet/identity/bin"
    } >>"$dest"
  fi
  if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then printf 'CLAUDE_CONFIG_DIR=%q\n' "$FLEET_CLAUDE_CONFIG_DIR" >>"$dest"; fi
  if [ -n "$FLEET_ID" ]; then
    printf '# Multi-fleet identity (fleet/fleet.conf FLEET_ID; registry: FEDERATION_FILE when it exists).\nFLEET_ID=%q\n' "$FLEET_ID" >>"$dest"
    if [ -f "$FEDERATION_FILE" ]; then printf 'FEDERATION_FILE=%q\n' "$FEDERATION_FILE" >>"$dest"; fi
    if [ -n "$FLEET_INSTANCE_REPO" ]; then printf 'FLEET_INSTANCE_REPO=%q\n' "$FLEET_INSTANCE_REPO" >>"$dest"; fi
    # Where the relay keeps each session's cross-fleet inbox; the plugin's session-start hook reads it.
    printf 'FLEET_INBOX_DIR=%q\n' "$FLEET_STATE/inbox" >>"$dest"
  fi
  # The operator's time zone and clock (fleet-env.sh resolves them); the session-start context reads these.
  if [ -n "$OPERATOR_TIMEZONE$OPERATOR_CLOCK" ]; then
    printf '# Operator time format (fleet.conf, or federation.yml fleets.<FLEET_ID>.timezone / .clock).\n' >>"$dest"
    if [ -n "$OPERATOR_TIMEZONE" ]; then printf 'OPERATOR_TIMEZONE=%q\n' "$OPERATOR_TIMEZONE" >>"$dest"; fi
    if [ -n "$OPERATOR_CLOCK" ]; then printf 'OPERATOR_CLOCK=%q\n' "$OPERATOR_CLOCK" >>"$dest"; fi
  fi
done
fleet_render "$FLEET_REPO/fleet/roster.tmpl" "$FLEET_STATE/roster"

# A registry that doesn't parse, or doesn't list this fleet, is reported but never blocks a launch
# (the supervisor relaunches through here).
if [ -f "$FEDERATION_FILE" ]; then
  if ! command -v node >/dev/null; then
    echo "fleet: WARNING node not found, $FEDERATION_FILE not checked" >&2
  elif ! node "$FLEET_KIT_DIR/lib/federation.mjs" validate "$FEDERATION_FILE" >/dev/null; then
    echo "fleet: WARNING the federation registry above is invalid or does not list FLEET_ID '${FLEET_ID}' — fix it by PR (fleet federation validate)" >&2
  elif [ -z "$FLEET_ID" ]; then
    echo "fleet: WARNING $FEDERATION_FILE exists but FLEET_ID is not set in fleet/fleet.conf" >&2
  fi
fi

cd "$PIN_DIR"
if [ -n "$name" ]; then
  grep -q "^$name|" "$FLEET_STATE/roster" || fleet_die "no session named '$name' in the roster"
  exec bash "$LAUNCHER" --roster "$FLEET_STATE/roster" "$name"
fi

# The host roster: the rendered roster minus the sessions that are not on this host.
host_roster="$FLEET_STATE/roster.host" kept=0
: >"$host_roster"; chmod 600 "$host_roster"
while IFS= read -r line; do
  case "$line" in
    [a-z0-9]*\|*)
      n="${line%%|*}"
      if why="$(fleet_host_excluded "$n")"; then
        echo "skip: $n is not on this host ($why)"
        printf '# not on this host: %s (%s)\n' "$n" "$why" >>"$host_roster"
        continue
      fi
      kept=$((kept + 1)) ;;
  esac
  printf '%s\n' "$line" >>"$host_roster"
done <"$FLEET_STATE/roster"
if [ "$kept" = 0 ]; then echo "fleet: no roster session runs on this host; nothing to launch"; exit 0; fi
exec bash "$LAUNCHER" --roster "$host_roster"
