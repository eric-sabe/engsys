#!/usr/bin/env bash
# config-dir.sh (`fleet config-dir init`): create the fleet's own Claude Code config dir and seed it with
# the few settings the unattended sessions need, so a relaunched monster never stops at a first-run or
# permission dialog. The dir is FLEET_CLAUDE_CONFIG_DIR (fleet.conf / fleet.local.conf), or --dir.
#
# Seeded, from the operator's ~/.claude/settings.json (an explicit allowlist; anything absent is skipped):
#   skipDangerousModePermissionPrompt, skipAutoPermissionPrompt, autoMode, effortLevel,
#   env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
# and hasCompletedOnboarding into <dir>/.claude.json (where Claude Code keeps it). Never copied: plugins,
# marketplaces, hooks, statusLine or other commands, MCP servers, permissions, models, any other env.
# An existing settings.json or .claude.json is left alone unless --force.
#
# Then (fleet-guide.md § 6.1): log in with the fleet seat, accept workspace trust in PIN_DIR once, run
# fleet sync, set FLEET_CLAUDE_CONFIG_DIR, restart.
#
# Usage: config-dir.sh [--instance <dir>] init [--dir <path>] [--force]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help | '') sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
sub="$1"; shift
[ "$sub" = init ] || { echo "fleet config-dir: unknown subcommand: $sub (init)" >&2; exit 2; }
dir="" force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a path}"; shift ;;
    --force) force=1 ;;
    *) echo "fleet config-dir: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
dir="${dir:-${FLEET_CLAUDE_CONFIG_DIR:-}}"
dir="${dir/#\~/$HOME}"
[ -n "$dir" ] || fleet_die "no config dir: pass --dir <path> or set FLEET_CLAUDE_CONFIG_DIR in fleet.conf"
case "$dir" in /*) ;; *) fleet_die "the config dir must be an absolute path (got '$dir')" ;; esac
[ "$(cd "$dir" 2>/dev/null && pwd -P || echo "$dir")" != "$(cd "$HOME/.claude" 2>/dev/null && pwd -P || echo "$HOME/.claude")" ] \
  || fleet_die "$dir is your own ~/.claude: the fleet's config dir must be a separate one"

mkdir -p "$dir" && chmod 700 "$dir"
src="$HOME/.claude/settings.json" srcj="$HOME/.claude.json"
seed_settings() {
  if [ -f "$src" ]; then
    jq '{skipDangerousModePermissionPrompt, skipAutoPermissionPrompt, autoMode, effortLevel,
         env: ({CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: (.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // null)})}
        | .env |= with_entries(select(.value != null)) | with_entries(select(.value != null and .value != {}))' "$src"
  else
    echo '{}'
  fi
}
for f in settings.json .claude.json; do
  if [ -e "$dir/$f" ] && [ "$force" != 1 ]; then echo "fleet config-dir: $dir/$f exists, left alone (--force to reseed)"; continue; fi
  tmp="$(mktemp "$dir/.$f.XXXXXX")"
  if [ "$f" = settings.json ]; then seed_settings >"$tmp"
  else
    if [ -f "$srcj" ] && [ "$(jq -r '.hasCompletedOnboarding // false' "$srcj" 2>/dev/null)" = true ]; then echo '{"hasCompletedOnboarding": true}' >"$tmp"; else echo '{}' >"$tmp"; fi
  fi
  chmod 600 "$tmp" && mv "$tmp" "$dir/$f"
  echo "fleet config-dir: wrote $dir/$f ($(jq -c 'keys' "$dir/$f"))"
done
cat <<EOF
fleet config-dir: next, once:
  1. CLAUDE_CONFIG_DIR=$dir claude            # /login with the fleet's seat, then /exit
  2. cd $PIN_DIR && CLAUDE_CONFIG_DIR=$dir claude --dangerously-skip-permissions   # accept workspace trust, /exit
  3. set FLEET_CLAUDE_CONFIG_DIR=$dir in fleet/fleet.conf (or ~/.config/$FLEET_ORG/fleet.local.conf)
  4. fleet sync                                 # installs the pinned plugins into $dir
  5. fleet restart --all                        # the sessions pick up the new dir
EOF
