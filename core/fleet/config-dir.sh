#!/usr/bin/env bash
# config-dir.sh (`fleet config-dir init`): create the fleet's own Claude Code config dir and seed it with
# the few settings the unattended sessions need, so a relaunched monster never stops at a first-run or
# permission dialog. The dir is FLEET_CLAUDE_CONFIG_DIR (fleet.conf / fleet.local.conf), or --dir.
#
# Seeded, from the operator's ~/.claude/settings.json (an explicit allowlist; anything absent is skipped):
#   skipDangerousModePermissionPrompt, skipAutoPermissionPrompt, effortLevel,
#   env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
# and always syncClaudeAiSkills / syncClaudeAiPlugins = false: otherwise the first login syncs the account's
# claude.ai skills and plugins into the fleet dir, where verify flags them as user-scope items and they cost
# prompt tokens every turn (engsys#200).
# and hasCompletedOnboarding into <dir>/.claude.json (where Claude Code keeps it). Never copied: plugins,
# marketplaces, hooks, statusLine or other commands, MCP servers, permissions, models, autoMode (the
# monsters run with --dangerously-skip-permissions; add a fleet-specific one by hand if ever needed), any
# other env.
# An existing settings.json or .claude.json is left alone unless --force (an existing settings.json still gets
# the two claude.ai sync switches added, nothing else changed).
#
# Then (fleet-guide.md § 6.1): log in with the fleet seat, accept workspace trust in PIN_DIR once, run
# fleet sync, set FLEET_CLAUDE_CONFIG_DIR, restart.
#
# With FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on (engsys#205) `init` seeds one dir per session that uses the fleet's
# config dir, <FLEET_CLAUDE_CONFIG_DIR>.sessions/<name> (--session <name> for just one), the same way and
# idempotently, and prints the one-time login command for each dir that is not logged in yet. Each session has
# its own login, so no two long-lived processes share a refresh token (anthropics/claude-code#88583).
#
# Usage: config-dir.sh [--instance <dir>] init [--dir <path>] [--session <name>] [--force]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help | '') sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
sub="$1"; shift
[ "$sub" = init ] || { echo "fleet config-dir: unknown subcommand: $sub (init)" >&2; exit 2; }
dir="" force=0 only_session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a path}"; shift ;;
    --force) force=1 ;;
    --session) only_session="${2:?--session needs a name}"; shift ;;
    *) echo "fleet config-dir: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
# shellcheck source=lib/session-dirs.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/session-dirs.sh"
dir="${dir/#\~/$HOME}"
check_dir() { # check_dir <dir>
  case "$1" in /*) ;; *) fleet_die "the config dir must be an absolute path (got '$1')" ;; esac
  [ "$(cd "$1" 2>/dev/null && pwd -P || echo "$1")" != "$(cd "$HOME/.claude" 2>/dev/null && pwd -P || echo "$HOME/.claude")" ] \
    || fleet_die "$1 is your own ~/.claude: the fleet's config dir must be a separate one"
}
src="$HOME/.claude/settings.json" srcj="$HOME/.claude.json"
seed_settings() {
  if [ -f "$src" ]; then
    jq '{skipDangerousModePermissionPrompt, skipAutoPermissionPrompt, effortLevel,
         env: ({CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: (.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // null)})}
        | .env |= with_entries(select(.value != null)) | with_entries(select(.value != null and .value != {}))
        | . + {syncClaudeAiSkills: false, syncClaudeAiPlugins: false}' "$src"
  else
    echo '{"syncClaudeAiSkills": false, "syncClaudeAiPlugins": false}'
  fi
}
init_dir() { # init_dir <dir> → creates and seeds it (idempotent)
local dir="$1" f tmp
check_dir "$dir"
mkdir -p "$dir" && chmod 700 "$dir"
for f in settings.json .claude.json; do
  if [ -e "$dir/$f" ] && [ "$force" != 1 ]; then
    # An existing settings.json is left alone except for the claude.ai sync switches (engsys#200): added when
    # missing or not false, every other key untouched. Re-running init retrofits a fleet dir seeded before them.
    if [ "$f" = settings.json ] && jq -e 'type == "object"' "$dir/$f" >/dev/null 2>&1 \
      && ! jq -e '.syncClaudeAiSkills == false and .syncClaudeAiPlugins == false' "$dir/$f" >/dev/null 2>&1; then
      tmp="$(mktemp "$dir/.$f.XXXXXX")"
      jq '. + {syncClaudeAiSkills: false, syncClaudeAiPlugins: false}' "$dir/$f" >"$tmp" && chmod 600 "$tmp" && mv "$tmp" "$dir/$f"
      echo "fleet config-dir: $dir/$f exists, left alone except syncClaudeAiSkills/syncClaudeAiPlugins set to false"
    else
      echo "fleet config-dir: $dir/$f exists, left alone (--force to reseed)"
    fi
    continue
  fi
  tmp="$(mktemp "$dir/.$f.XXXXXX")"
  if [ "$f" = settings.json ]; then seed_settings >"$tmp"
  else
    if [ -f "$srcj" ] && [ "$(jq -r '.hasCompletedOnboarding // false' "$srcj" 2>/dev/null)" = true ]; then echo '{"hasCompletedOnboarding": true}' >"$tmp"; else echo '{}' >"$tmp"; fi
  fi
  chmod 600 "$tmp" && mv "$tmp" "$dir/$f"
  echo "fleet config-dir: wrote $dir/$f ($(jq -c 'keys' "$dir/$f"))"
done
}
# logged_in <dir> → 0 only when claude says so explicitly (an unknown answer prints the login command too)
logged_in() { [ "$( (cd "${TMPDIR:-/tmp}" && CLAUDE_CONFIG_DIR="$1" fleet_dir_lock "$1" claude auth status --json </dev/null) 2>/dev/null | jq -r '.loggedIn // empty' 2>/dev/null || true)" = true ]; }

if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ] && [ -z "$dir" ]; then
  fleet_roster_prepare
  names="$(fleet_session_dir_names)"
  if [ -n "$only_session" ]; then
    grep -Fxq -- "$only_session" <<<"$names" || fleet_die "--session $only_session: not a session on this host that uses the fleet's config dir (per session: $(paste -sd' ' - <<<"$names"))"
    names="$only_session"
  fi
  [ -n "$names" ] || fleet_die "no session on this host uses the fleet's config dir, so there is nothing to create"
  login_needed=""
  while IFS= read -r n; do
    d="$(fleet_session_config_dir "$n")"
    echo "fleet config-dir: session $n -> $d"
    init_dir "$d"
    logged_in "$d" || login_needed="$login_needed$n|$d"$'\n'
  done <<<"$names"
  echo "fleet config-dir: one Claude login per session (FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on): no two long-lived sessions share a refresh token (anthropics/claude-code#88583)."
  if [ -n "$login_needed" ]; then
    echo "fleet config-dir: log each of these in once, with the fleet's seat (then /exit), and accept workspace trust in PIN_DIR for each:"
    while IFS='|' read -r n d; do
      [ -n "$n" ] || continue
      echo "  $n: CLAUDE_CONFIG_DIR=$d claude                      # /login, then /exit"
      echo "  $n: cd $PIN_DIR && CLAUDE_CONFIG_DIR=$d claude --dangerously-skip-permissions   # trust, /exit"
    done <<<"$login_needed"
  else
    echo "fleet config-dir: every session dir is logged in"
  fi
  echo "fleet config-dir: then fleet sync (plugins into every dir), fleet verify, fleet restart --all"
  exit 0
fi
[ -z "$only_session" ] || fleet_die "--session needs FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
dir="${dir:-${FLEET_CLAUDE_CONFIG_DIR:-}}"
[ -n "$dir" ] || fleet_die "no config dir: pass --dir <path> or set FLEET_CLAUDE_CONFIG_DIR in fleet.conf"
init_dir "$dir"
cat <<EOF
fleet config-dir: next, once:
  1. CLAUDE_CONFIG_DIR=$dir claude            # /login with the fleet's seat, then /exit
  2. cd $PIN_DIR && CLAUDE_CONFIG_DIR=$dir claude --dangerously-skip-permissions   # accept workspace trust, /exit
  3. set FLEET_CLAUDE_CONFIG_DIR=$dir in fleet/fleet.conf (or ~/.config/$FLEET_ORG/fleet.local.conf)
  4. fleet sync                                 # installs the pinned plugins into $dir
  5. fleet restart --all                        # the sessions pick up the new dir
EOF
