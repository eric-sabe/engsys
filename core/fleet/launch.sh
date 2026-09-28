#!/usr/bin/env bash
# launch.sh — launch the fleet sessions (tmux windows) via the engsys agent-sessions launcher.
#
# Renders the instance's templates into <instance>/.fleet/ (machine-local, gitignored):
#   fleet/env/<lane>.env.tmpl  → .fleet/env/<lane>.env   (when GH_APP_ENV is set, each also gets the
#                                                          env-scoped git identity lines appended)
#   fleet/roster.tmpl          → .fleet/roster            (the launcher's roster; a session line's
#                                                          optional 5th field names a per-session env)
# then runs the launcher from PIN_DIR (the sessions' default workdir). Identity preflights belong in
# the roster (PREFLIGHT= lines); they warn, never block.
#
# Usage: launch.sh [--instance <dir>]            # every session in the roster
#        launch.sh [--instance <dir>] <name>     # just one (the supervisor relaunches this way)
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"

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
  fi
  if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then printf 'CLAUDE_CONFIG_DIR=%q\n' "$FLEET_CLAUDE_CONFIG_DIR" >>"$dest"; fi
done
fleet_render "$FLEET_REPO/fleet/roster.tmpl" "$FLEET_STATE/roster"

cd "$PIN_DIR"
if [ $# -gt 0 ]; then
  grep -q "^$1|" "$FLEET_STATE/roster" || fleet_die "no session named '$1' in the roster"
  exec bash "$LAUNCHER" --roster "$FLEET_STATE/roster" "$1"
fi
exec bash "$LAUNCHER" --roster "$FLEET_STATE/roster"
