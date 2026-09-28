# shellcheck shell=bash
# fleet-env.sh — sourced by every fleet command (bash; bin/fleet passes the instance along).
#
# Locates the instance repo (FLEET_INSTANCE, set by `bin/fleet --instance <dir>`; a script run
# directly may take a leading `--instance <dir>` itself), loads <instance>/fleet/fleet.conf then
# ~/.config/$FLEET_ORG/fleet.local.conf, resolves the paths for THIS checkout and machine, and
# provides the shared helpers: rendering of __NAME__ templates, pin derivation, session-name helpers,
# and the fleet's git/gh identity (only when GH_APP_ENV is set).
#
# Contract: fleet/fleet.conf keys are documented in the engsys fleet guide. Every key, plus
# FLEET_REPO, FLEET_STATE, ENV_DIR, LOG_DIR, ENGSYS_REF, INSTANCE_REF and TMUX_SESSION, is available
# to templates as __NAME__.
FLEET_KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fleet_die() { echo "fleet: $*" >&2; exit 1; }

fleet_load_conf() { # KEY=VALUE lines; '#' starts a comment line; a leading ~ is expanded
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$line" in *=*) ;; *) fleet_die "bad line in $1: $line" ;; esac
    case "$key" in *[!A-Za-z0-9_]* | '') fleet_die "bad line in $1: $line" ;; esac
    val="${val/#\~/$HOME}"
    printf -v "$key" '%s' "$val"; export "${key?}"
  done <"$1"
}

# --- Instance and config -----------------------------------------------------------------------
[ -n "${FLEET_INSTANCE:-}" ] || FLEET_INSTANCE="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$FLEET_INSTANCE" ] || fleet_die "no fleet instance: pass --instance <dir>, set FLEET_INSTANCE, or run inside the instance repo"
FLEET_REPO="$(cd "$FLEET_INSTANCE" 2>/dev/null && pwd -P)" || fleet_die "instance directory not found: $FLEET_INSTANCE"
[ -f "$FLEET_REPO/fleet/fleet.conf" ] || fleet_die "$FLEET_REPO/fleet/fleet.conf not found — is that a fleet instance? (engsys fleet init creates one)"
FLEET_STATE="$FLEET_REPO/.fleet"
ENV_DIR="$FLEET_STATE/env"
export FLEET_INSTANCE="$FLEET_REPO" FLEET_REPO FLEET_STATE ENV_DIR FLEET_KIT_DIR

# Derived values are always derived (never inherited from the caller's environment); a conf file
# may still set them.
unset TMUX_SESSION LOG_DIR
fleet_load_conf "$FLEET_REPO/fleet/fleet.conf"
[ -n "${FLEET_ORG:-}" ] || fleet_die "FLEET_ORG is not set in $FLEET_REPO/fleet/fleet.conf"
[ -f "$HOME/.config/$FLEET_ORG/fleet.local.conf" ] && fleet_load_conf "$HOME/.config/$FLEET_ORG/fleet.local.conf"

: "${ENGSYS_DIR:=$HOME/git/engsys}"
: "${ENGSYS_MARKETPLACE:=engsys}"
: "${INSTANCE_MARKETPLACE:=}"
: "${READY_LABEL:=mm:ready}"
: "${REVIEW_BLOCK_REGEX:=critical\\|warning}"
: "${PIN_WAIT_MAX_MIN:=240}"
: "${LOG_DIR:=$HOME/Library/Logs/${FLEET_ORG}-fleet}"
for _k in PIN_REPO PIN_DIR; do
  [ -n "${!_k:-}" ] || fleet_die "$_k is not set in $FLEET_REPO/fleet/fleet.conf (or ~/.config/$FLEET_ORG/fleet.local.conf)"
done
unset _k
export FLEET_ORG PIN_REPO PIN_DIR ENGSYS_DIR ENGSYS_MARKETPLACE INSTANCE_MARKETPLACE READY_LABEL REVIEW_BLOCK_REGEX PIN_WAIT_MAX_MIN LOG_DIR

command -v jq >/dev/null || fleet_die "jq is required"

# --- Templates ---------------------------------------------------------------------------------
fleet_render_text() { # fleet_render_text <text> <origin> → rendered text; every __NAME__ resolves from $NAME (fails if unset)
  local out="$1" name val esc
  for name in $(printf '%s' "$out" | grep -oE '__[A-Z][A-Z0-9_]*__' | sort -u | sed 's/^__//; s/__$//'); do
    val="${!name-}"
    [ -n "$val" ] || fleet_die "template $2 needs $name (set it in fleet/fleet.conf or ~/.config/$FLEET_ORG/fleet.local.conf)"
    esc="$(printf '%s' "$val" | sed -e 's/[\\&#]/\\&/g')"
    out="$(printf '%s' "$out" | sed -e "s#__${name}__#${esc}#g")"
  done
  printf '%s\n' "$out"
}

fleet_render() { # fleet_render <template> <dest> [mode]
  local out
  out="$(fleet_render_text "$(cat "$1")" "$1")" || exit 1
  mkdir -p "$FLEET_STATE" && chmod 700 "$FLEET_STATE"
  mkdir -p "$(dirname "$2")"
  printf '%s\n' "$out" >"$2" && chmod "${3:-600}" "$2"
}

# --- Pins --------------------------------------------------------------------------------------
# Single source of truth: the pin repo's .claude/settings.json (the working tree of PIN_DIR — what
# the sessions load). Either ref may be forced through the environment or fleet.local.conf.
PIN_SETTINGS="${PIN_SETTINGS:-$PIN_DIR/.claude/settings.json}"
export PIN_SETTINGS

fleet_pin() { # fleet_pin <marketplace> [settings-file] → the pinned ref ('' if absent)
  jq -r --arg m "$1" '.extraKnownMarketplaces[$m].source.ref // empty' "${2:-$PIN_SETTINGS}" 2>/dev/null || true
}
fleet_pin_repo() { # fleet_pin_repo <marketplace> [settings-file] → owner/repo
  jq -r --arg m "$1" '.extraKnownMarketplaces[$m].source.repo // empty' "${2:-$PIN_SETTINGS}" 2>/dev/null || true
}
fleet_enabled_plugins() { # fleet_enabled_plugins <marketplace> [settings-file] → plugin names, one per line
  jq -r --arg m "$1" '.enabledPlugins // {} | to_entries[] | select(.value == true) | .key
    | select(endswith("@" + $m)) | sub("@" + $m + "$"; "")' "${2:-$PIN_SETTINGS}" 2>/dev/null || true
}
fleet_git_at() { # fleet_git_at <dir> → exact tag at HEAD, else short sha
  git -C "$1" describe --tags --exact-match 2>/dev/null || git -C "$1" rev-parse --short HEAD
}

FLEET_ENGSYS_REF_FORCED=0 FLEET_INSTANCE_REF_FORCED=0
[ -z "${ENGSYS_REF:-}" ] || FLEET_ENGSYS_REF_FORCED=1
[ -z "${INSTANCE_REF:-}" ] || FLEET_INSTANCE_REF_FORCED=1
fleet_refresh_refs() { # (re)derive ENGSYS_REF / INSTANCE_REF from PIN_SETTINGS unless forced
  [ "$FLEET_ENGSYS_REF_FORCED" = 1 ] || ENGSYS_REF="$(fleet_pin "$ENGSYS_MARKETPLACE")"
  if [ -z "$INSTANCE_MARKETPLACE" ]; then
    INSTANCE_REF=""
  elif [ "$FLEET_INSTANCE_REF_FORCED" != 1 ]; then
    INSTANCE_REF="$(fleet_pin "$INSTANCE_MARKETPLACE")"
  fi
}
fleet_refresh_refs
# Deliberately not exported: a stale exported ref would look "forced" to the next process.

fleet_check_engsys() { # the host scripts must come from the same engsys release as the plugins
  [ -n "$ENGSYS_REF" ] || fleet_die "no engsys pin found in $PIN_SETTINGS"
  [ -e "$ENGSYS_DIR/.git" ] || fleet_die "engsys checkout not found at $ENGSYS_DIR — git clone <engsys repo> $ENGSYS_DIR, then run: fleet sync"
  local have
  have="$(fleet_git_at "$ENGSYS_DIR")"
  [ "$have" = "$ENGSYS_REF" ] || echo "fleet: WARNING engsys checkout is at '$have', the pin is '$ENGSYS_REF' — run: fleet sync" >&2
  return 0
}

# --- Sessions ----------------------------------------------------------------------------------
fleet_ledger_sessions() { # names of the ledger-bearing (supervised) sessions
  [ -f "$FLEET_REPO/fleet/supervisor.conf.tmpl" ] || return 0
  grep -E '^[a-z0-9-]+\|[0-9]+\|' "$FLEET_REPO/fleet/supervisor.conf.tmpl" | cut -d'|' -f1 || true
}
fleet_roster_sessions() { # every session name in the roster template
  [ -f "$FLEET_REPO/fleet/roster.tmpl" ] || return 0
  grep -E '^[a-z0-9-]+\|' "$FLEET_REPO/fleet/roster.tmpl" | cut -d'|' -f1 || true
}
fleet_roster_header() { # fleet_roster_header <KEY> → its value from the roster template ('' if absent), rendered
  local raw
  [ -f "$FLEET_REPO/fleet/roster.tmpl" ] || return 0
  raw="$(sed -n "s/^$1=//p" "$FLEET_REPO/fleet/roster.tmpl" | head -1 | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//')"
  [ -n "$raw" ] || return 0
  fleet_render_text "$raw" "roster.tmpl $1" | head -1
}
if [ -z "${TMUX_SESSION:-}" ]; then
  TMUX_SESSION="$(fleet_roster_header TMUX_SESSION)"
  [ -n "$TMUX_SESSION" ] || TMUX_SESSION="$(fleet_roster_header NAMESPACE)"
  : "${TMUX_SESSION:=$FLEET_ORG}"
fi
export TMUX_SESSION

# The command that launches ONE session; the supervisor appends the session name. (The supervisor
# word-splits it, so keep the kit and instance paths free of spaces.)
LAUNCH_CMD="bash $FLEET_KIT_DIR/bin/fleet --instance $FLEET_REPO launch"
export LAUNCH_CMD

# --- Identity ----------------------------------------------------------------------------------
# GH_APP_ENV set = identity kit on: every gh call from the fleet host tooling goes through the App
# shim, and every git call authenticates and authors as the App via env-scoped config — never
# ~/.gitconfig. Unset = the machine's own gh/git identity is used unchanged.
if [ -n "${GH_APP_ENV:-}" ]; then
  export GH_APP_ENV_FILE="$GH_APP_ENV"
  PATH="$ENGSYS_DIR/core/fleet/identity/bin:$PATH"; export PATH
  if [ -f "$ENGSYS_DIR/core/fleet/identity/git-env.sh" ]; then
    # shellcheck source=/dev/null
    . "$ENGSYS_DIR/core/fleet/identity/git-env.sh"
    fleet_git_env "$GH_APP_ENV" || echo "fleet: WARNING git will NOT act as the fleet identity (see above)" >&2
  else
    echo "fleet: WARNING GH_APP_ENV is set but $ENGSYS_DIR/core/fleet/identity/git-env.sh is missing — git identity not applied" >&2
  fi
fi
# Optional separate Claude Code config dir for the fleet (a machine shared with a person's own
# Claude use). Unset = the account's default ~/.claude.
if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then export CLAUDE_CONFIG_DIR="$FLEET_CLAUDE_CONFIG_DIR"; fi
