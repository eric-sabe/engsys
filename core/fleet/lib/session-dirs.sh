# shellcheck shell=bash
# session-dirs.sh — which roster sessions use the fleet's Claude config dir, and (with
# FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, engsys#205) where each one's own dir is. Sourced by launch.sh,
# verify.sh, sync.sh and config-dir.sh after fleet-env.sh. The classification (interactive, Claude-only, security
# lane, supervised) used to live in launch.sh; it reads the rendered roster in $FLEET_STATE/roster and the host
# roles (fleet_host_init), so call fleet_roster_prepare first when you did not render the roster yourself.
#
# One Claude login per session. Claude Code keeps one refresh token per config dir (the Keychain item is named
# from the dir), rotating on every refresh. Several long-lived processes on one dir race it at the access
# token's expiry (about every 8 hours); the loser persists an emptied credential over the winner's
# (anthropics/claude-code#88583), and every session on the dir shows "Login expired". With the setting on, each
# session that uses the fleet's dir gets its own, <FLEET_CLAUDE_CONFIG_DIR>.sessions/<session name>, so no two
# long-lived processes share a credential, and a lost login costs one session, not all of them.

# fleet_roster_prepare → renders the roster and loads the host roles (idempotent), so the classifiers below work.
fleet_roster_prepare() {
  [ -f "$FLEET_REPO/fleet/roster.tmpl" ] || fleet_die "$FLEET_REPO/fleet/roster.tmpl not found"
  mkdir -p "$FLEET_STATE"
  fleet_render "$FLEET_REPO/fleet/roster.tmpl" "$FLEET_STATE/roster"
  fleet_host_init
}

ROSTER_LINE_RE='^[A-Za-z0-9][A-Za-z0-9._-]*\|'
roster_field() { # roster_field <name> <n> → field n of <name>'s rendered roster line
  awk -F'|' -v n="$1" -v k="$2" '$1 == n { print $k; exit }' "$FLEET_STATE/roster"
}
roster_default_env() { sed -n 's/^ENV_FILE=//p' "$FLEET_STATE/roster" | tail -n 1 | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//'; }
roster_model_header() { sed -n 's/^MODEL=//p' "$FLEET_STATE/roster" | tail -n 1 | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//'; }
norm_words() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--'; }
# A security-tier line, as the launcher reads it (launch-agent-sessions.sh is_security_line): its env file
# (5th field, else the roster's ENV_FILE) is named security or nyx in any case, or any --model in its flags
# (or the roster's MODEL=) names Claude Opus 4.8.
is_security_session() { # is_security_session <name>
  local envf flags b tok prev="" m
  envf="$(roster_field "$1" 5)"; [ -n "$envf" ] || envf="$(roster_default_env)"
  b="${envf##*/}"; b="${b%.*}"; b="$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]' | tr -d "\"' ")"
  case "$b" in security | nyx) return 0 ;; esac
  flags="$(roster_model_header) $(roster_field "$1" 4)"
  set -f
  # shellcheck disable=SC2086
  for tok in $flags; do
    m=""; [ "$prev" = --model ] && m="$tok"; case "$tok" in --model=*) m="${tok#--model=}" ;; esac
    if [ -n "$m" ]; then
      m="$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]' | tr -d "\"'")"
      case "$m" in claude-opus-4-8* | claude-opus-4.8* | security) set +f; return 0 ;; esac
    fi
    prev="$tok"
  done
  set +f
  return 1
}
# Supervised (and security-lane) sessions: merge, maintain, broker, any monster, any ledger-bearing
# session, any prompt that names a monster (with the launcher's tolerance for case, `_` and spaces), and
# any security-tier line. They run on Claude only.
claude_only() { # claude_only <name> → 0 when <name> is a supervised or security-lane session
  case "$(fleet_host_kind_of "$1")" in merge | maintain | broker | monster) return 0 ;; esac
  fleet_ledger_sessions | grep -Fxq -- "$1" && return 0
  case "$(norm_words "$(roster_field "$1" 3)")" in *merge-monster* | *maintenance-monster* | *resource-broker*) return 0 ;; esac
  is_security_session "$1"
}
# Positively interactive: a roster line this host classifies as interactive and that is none of the above.
# Anything else (an unknown or unclassified name) is treated as supervised: it fails toward the fleet dir.
is_interactive() { [ "$(fleet_host_kind_of "$1")" = interactive ] && ! claude_only "$1"; }
# Which sessions get CLAUDE_CONFIG_DIR=<fleet dir>: every one (scope all), or every non-interactive one.
uses_fleet_config_dir() { # uses_fleet_config_dir <name>
  [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || return 1
  [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" = supervised ] || return 0
  ! is_interactive "$1"
}
roster_names() { grep -E "$ROSTER_LINE_RE" "$FLEET_STATE/roster" | cut -d'|' -f1; }

# fleet_session_config_dir <name> → the session's own config dir, <base>.sessions/<name>; rc 1 (and nothing) when
# per-session mode is off or the name is not a plain roster name. A name with a slash, a leading dot or ".." can
# not leave the base, whatever the roster says.
fleet_session_config_dir() {
  [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ] && [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || return 1
  case "$1" in '' | .* | */* | *..* | *[!A-Za-z0-9._-]*) return 1 ;; esac
  printf '%s.sessions/%s' "${FLEET_CLAUDE_CONFIG_DIR%/}" "$1"
}
# fleet_session_dir_names → the roster sessions on this host that get their own dir, one per line (per-session mode).
fleet_session_dir_names() {
  [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ] || return 0
  local n
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    fleet_host_excluded "$n" >/dev/null && continue
    uses_fleet_config_dir "$n" || continue
    fleet_session_config_dir "$n" >/dev/null || { echo "fleet: WARNING session '$n' has a name that can't be a config dir name; skipped" >&2; continue; }
    printf '%s\n' "$n"
  done < <(roster_names)
}
