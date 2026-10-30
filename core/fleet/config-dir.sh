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
# `--per-session` does the per-session init while the flag is still off (what the adoption order needs: create the
# dirs and log each one in first, then turn the flag on; engsys#212). It needs FLEET_CLAUDE_CONFIG_DIR.
#
# Usage: config-dir.sh [--instance <dir>] init [--dir <path>] [--session <name>] [--per-session] [--force]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help | '') sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
sub="$1"; shift
[ "$sub" = init ] || { echo "fleet config-dir: unknown subcommand: $sub (init)" >&2; exit 2; }
dir="" force=0 only_session="" force_per_session=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a path}"; shift ;;
    --force) force=1 ;;
    --per-session) force_per_session=1 ;;
    --session) only_session="${2:?--session needs a name}"; shift ;;
    *) echo "fleet config-dir: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
# shellcheck source=lib/session-dirs.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/session-dirs.sh"
flag_was="${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}"
if [ "$force_per_session" = 1 ]; then
  [ -z "$dir" ] || fleet_die "--per-session and --dir cannot be combined: --dir names one dir, --per-session creates one per session"
  [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || fleet_die "--per-session needs FLEET_CLAUDE_CONFIG_DIR in fleet.conf: the session dirs live beside it"
  FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on  # for this run only; the setting itself is the operator's, in fleet.conf
fi
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
logged_in() { [ "$( (cd "$(fleet_outside_home_dir)" && CLAUDE_CONFIG_DIR="$1" fleet_dir_lock "$1" claude auth status --json </dev/null) 2>/dev/null | jq -r '.loggedIn // empty' 2>/dev/null || true)" = true ]; }

if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ] && [ -z "$dir" ]; then
  fleet_roster_prepare
  names="$(fleet_session_dir_names)"
  if [ -n "$only_session" ]; then
    names="$(fleet_session_dir_names --include-excluded)"
    grep -Fxq -- "$only_session" <<<"$names" || fleet_die "--session $only_session: not a session on this host that uses the fleet's config dir (per session: $(paste -sd' ' - <<<"$names"))"
    names="$only_session"
  fi
  [ -n "$names" ] || fleet_die "no session on this host uses the fleet's config dir, so there is nothing to create"
  login_needed="" login_unknown=""
  while IFS= read -r n; do
    d="$(fleet_session_config_dir "$n")"
    echo "fleet config-dir: session $n -> $d"
    init_dir "$d"
    if ! logged_in "$d"; then
      if fleet_keychain_unreadable; then login_unknown="$login_unknown $n"; else login_needed="$login_needed$n|$d"$'\n'; fi
    fi
  done <<<"$names"
  echo "fleet config-dir: one Claude login per session (FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on): no two long-lived sessions share a refresh token (anthropics/claude-code#88583)."
  if [ -n "$login_unknown" ]; then
    # engsys#210: an SSH shell on macOS can't read the login Keychain, so "not logged in" is no evidence; /login would replace a working login
    echo "fleet config-dir: login state unknown (SSH, Keychain not readable) for:$login_unknown. Not printing /login commands: following them could replace a working login. $(fleet_keychain_advice), then re-run fleet config-dir init${force_per_session:+ --per-session}${only_session:+ --session $only_session} to see which sessions need a login."
  fi
  if [ -n "$login_needed" ]; then
    echo "fleet config-dir: log each of these in once, with the fleet's seat (then /exit), and accept workspace trust in PIN_DIR for each:"
    while IFS='|' read -r n d; do
      [ -n "$n" ] || continue
      echo "  $n: $(fleet_login_cmd "$d")   # /login, then /exit"
      echo "  $n: cd $PIN_DIR && CLAUDE_CONFIG_DIR=$d claude --dangerously-skip-permissions   # trust, /exit"
    done <<<"$login_needed"
  elif [ -z "$login_unknown" ]; then
    echo "fleet config-dir: every session dir is logged in"
  fi
  if [ "$flag_was" != on ]; then
    echo "fleet config-dir: FLEET_CLAUDE_CONFIG_DIR_PER_SESSION is still off. Once every session is logged in, set it to on in fleet/fleet.conf (or fleet.local.conf), then fleet sync, fleet verify, fleet restart --all"
  else
    echo "fleet config-dir: then fleet sync (plugins into every dir), fleet verify, fleet restart --all"
  fi
  exit 0
fi
[ -z "$only_session" ] || fleet_die "--session needs FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on"
dir="${dir:-${FLEET_CLAUDE_CONFIG_DIR:-}}"
[ -n "$dir" ] || fleet_die "no config dir: pass --dir <path> or set FLEET_CLAUDE_CONFIG_DIR in fleet.conf"
init_dir "$dir"
if ! logged_in "$dir" && fleet_keychain_unreadable; then
  # engsys#210: the login state can't be read from here, so no /login commands: they could replace a working login
  echo "fleet config-dir: login state unknown (SSH, Keychain not readable) for $dir. Not printing /login commands: following them could replace a working login. $(fleet_keychain_advice), then re-run fleet config-dir init --dir $dir to see whether it needs a login."
  echo "fleet config-dir: once it is logged in: set FLEET_CLAUDE_CONFIG_DIR=$dir in fleet/fleet.conf, fleet sync, fleet restart --all"
  exit 0
fi
cat <<EOF
fleet config-dir: next, once:
  1. $(fleet_login_cmd "$dir")   # /login with the fleet's seat, then /exit
  2. cd $PIN_DIR && CLAUDE_CONFIG_DIR=$dir claude --dangerously-skip-permissions   # accept workspace trust, /exit
  3. set FLEET_CLAUDE_CONFIG_DIR=$dir in fleet/fleet.conf (or ~/.config/$FLEET_ORG/fleet.local.conf)
  4. fleet sync                                 # installs the pinned plugins into $dir
  5. fleet restart --all                        # the sessions pick up the new dir
EOF
