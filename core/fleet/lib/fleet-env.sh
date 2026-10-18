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
# The fleet's identity comes only from its own config files, never from a caller's environment (a
# session env carries FLEET_ID too). The same goes for the per-host role filter (lib/host-roles.sh).
unset FLEET_ID FEDERATION_FILE FLEET_INSTANCE_REPO ROLES ROSTER_EXCLUDE OPERATOR_TIMEZONE OPERATOR_CLOCK
# So do the fleet's Claude config dir and the integrity check's user-plugin allowlist: what `fleet verify`
# accepts must come from the operator's config files, never from whoever ran the command.
unset FLEET_CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR_SCOPE VERIFY_ALLOWED_USER_PLUGINS VERIFY_ALLOWED_USER_HOOKS VERIFY_ALLOWED_USER_FILES
# PIN_SETTINGS (where the pins are read) too: only a conf file, or sync's own pins copy in .fleet/
# (FLEET_SYNC_PINS, set by sync.sh across its re-execs), may point it somewhere else.
_pin_settings_sync="${FLEET_SYNC_RESUMED:+${PIN_SETTINGS:-}}"
unset PIN_SETTINGS
fleet_load_conf "$FLEET_REPO/fleet/fleet.conf"
[ -n "${FLEET_ORG:-}" ] || fleet_die "FLEET_ORG is not set in $FLEET_REPO/fleet/fleet.conf"
[ -f "$HOME/.config/$FLEET_ORG/fleet.local.conf" ] && fleet_load_conf "$HOME/.config/$FLEET_ORG/fleet.local.conf"

: "${ENGSYS_DIR:=$HOME/git/engsys}"
: "${HARNESS:=${FLEET_HARNESS:-claude}}"
case "$HARNESS" in
  claude | copilot | antigravity) ;;
  agy) HARNESS=antigravity ;;
  *) fleet_die "HARNESS must be claude, copilot, or antigravity (got '$HARNESS')" ;;
esac
PRIMARY_HARNESS="$HARNESS"
: "${HARNESS_FALLBACK:=}"
if [ -n "$HARNESS_FALLBACK" ]; then
  _fb_norm="" _fb_part=""
  IFS=',' read -r -a _fb_parts <<<"$HARNESS_FALLBACK"
  for _fb_part in ${_fb_parts[@]+"${_fb_parts[@]}"}; do
    _fb_part="${_fb_part//[[:space:]]/}"
    [ -n "$_fb_part" ] || continue
    case "$_fb_part" in
      claude | copilot | antigravity) ;;
      agy) _fb_part=antigravity ;;
      *) fleet_die "HARNESS_FALLBACK entries must be claude, copilot, or antigravity (got '$_fb_part')" ;;
    esac
    [ "$_fb_part" != "$PRIMARY_HARNESS" ] || continue
    case ",$_fb_norm," in *,"$_fb_part",*) continue ;; esac
    _fb_norm="${_fb_norm:+$_fb_norm,}$_fb_part"
  done
  HARNESS_FALLBACK="$_fb_norm"
  unset _fb_norm _fb_part _fb_parts
fi
: "${QUOTA_COOLDOWN_MIN:=60}"
[[ "$QUOTA_COOLDOWN_MIN" =~ ^[0-9]+$ ]] || fleet_die "QUOTA_COOLDOWN_MIN must be a whole number of minutes (got '$QUOTA_COOLDOWN_MIN')"
if [ -n "${FLEET_ACTIVE_HARNESS:-}" ]; then
  case "$FLEET_ACTIVE_HARNESS" in
    claude | copilot | antigravity) HARNESS="$FLEET_ACTIVE_HARNESS" ;;
    agy) HARNESS=antigravity; FLEET_ACTIVE_HARNESS=antigravity ;;
    *) fleet_die "FLEET_ACTIVE_HARNESS must be claude, copilot, or antigravity (got '$FLEET_ACTIVE_HARNESS')" ;;
  esac
fi
# (No state file on the host selects a harness: the supervisor never fails over, and a file a session
# can write must never move the fleet off Claude.)
FLEET_HARNESS="$HARNESS"
: "${COPILOT_HOME:=$FLEET_STATE/copilot-home}"
: "${ENGSYS_MARKETPLACE:=engsys}"
: "${INSTANCE_MARKETPLACE:=}"
: "${READY_LABEL:=mm:ready}"
: "${REVIEW_BLOCK_REGEX:=critical\\|warning}"
: "${PIN_WAIT_MAX_MIN:=240}"
# How long the supervisor reuses a passing `fleet verify` while the plugin files are unchanged (engsys#70).
: "${VERIFY_MAX_AGE_MIN:=15}"
[[ "$VERIFY_MAX_AGE_MIN" =~ ^[0-9]+$ ]] || fleet_die "VERIFY_MAX_AGE_MIN must be a whole number of minutes (got '$VERIFY_MAX_AGE_MIN')"
: "${LOG_DIR:=$HOME/Library/Logs/${FLEET_ORG}-fleet}"
# `fleet notify` config. SLACK_ENV: path to the bot's env file (SLACK_BOT_TOKEN, SLACK_CHANNEL_ID,
# SLACK_OPERATORS_GROUP_ID, optional SLACK_OPERATOR_ID, FLEET_ID unless fleet.conf sets it) — empty means Slack is
# unconfigured, notify falls back straight to NOTIFY_FALLBACK_ISSUE (owner/repo#N, also empty-ok).
: "${SLACK_ENV:=}"
: "${NOTIFY_FALLBACK_ISSUE:=}"
# Multi-fleet registry (docs/multi-fleet.md § 1). FLEET_ID unset = single-fleet mode, unchanged.
# FEDERATION_FILE is relative to the instance repo unless absolute; no file = single-fleet mode too.
# FLEET_INSTANCE_REPO (owner/name) names the repo holding the fleets' status issues; unset = the instance
# checkout's origin (federation.mjs status-issue).
: "${FLEET_ID:=}"
if [ -n "$FLEET_ID" ] && ! [[ "$FLEET_ID" =~ ^[a-z][a-z0-9-]{1,20}$ ]]; then
  fleet_die "FLEET_ID '$FLEET_ID' must be 2-21 characters: a lowercase letter, then lowercase letters, digits or hyphens"
fi
: "${FEDERATION_FILE:=federation.yml}"
case "$FEDERATION_FILE" in /*) ;; *) FEDERATION_FILE="$FLEET_REPO/$FEDERATION_FILE" ;; esac
: "${FLEET_INSTANCE_REPO:=}"
# Operator time format (core/lib/operator-time.mjs): how times read to a person. Multi-fleet mode takes
# fleets.<FLEET_ID>.timezone / .clock from the registry; single-fleet mode reads OPERATOR_TIMEZONE /
# OPERATOR_CLOCK from fleet.conf. Unset = UTC, 24h. Machine-read timestamps are always ISO 8601 UTC.
: "${OPERATOR_TIMEZONE:=}"
: "${OPERATOR_CLOCK:=}"
if [ -n "$FLEET_ID" ] && [ -f "$FEDERATION_FILE" ] && command -v node >/dev/null 2>&1; then
  _v="$(node "$FLEET_KIT_DIR/lib/federation.mjs" get "fleets.$FLEET_ID.timezone" --file "$FEDERATION_FILE" 2>/dev/null)" && [ -n "$_v" ] && OPERATOR_TIMEZONE="$_v"
  _v="$(node "$FLEET_KIT_DIR/lib/federation.mjs" get "fleets.$FLEET_ID.clock" --file "$FEDERATION_FILE" 2>/dev/null)" && [ -n "$_v" ] && OPERATOR_CLOCK="$_v"
  unset _v
fi
for _k in PIN_REPO PIN_DIR; do
  [ -n "${!_k:-}" ] || fleet_die "$_k is not set in $FLEET_REPO/fleet/fleet.conf (or ~/.config/$FLEET_ORG/fleet.local.conf)"
done
unset _k
export FLEET_ORG PIN_REPO PIN_DIR ENGSYS_DIR HARNESS PRIMARY_HARNESS HARNESS_FALLBACK QUOTA_COOLDOWN_MIN FLEET_HARNESS COPILOT_HOME ENGSYS_MARKETPLACE INSTANCE_MARKETPLACE READY_LABEL REVIEW_BLOCK_REGEX PIN_WAIT_MAX_MIN VERIFY_MAX_AGE_MIN LOG_DIR SLACK_ENV NOTIFY_FALLBACK_ISSUE FLEET_ID FEDERATION_FILE FLEET_INSTANCE_REPO OPERATOR_TIMEZONE OPERATOR_CLOCK

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
# A sync re-exec may carry its own pins copy, and only one under this instance's .fleet/.
if [ -z "${PIN_SETTINGS:-}" ] && [ -n "$_pin_settings_sync" ] && [ "$_pin_settings_sync" = "$FLEET_STATE/pins.settings.json" ]; then
  PIN_SETTINGS="$_pin_settings_sync"
fi
unset _pin_settings_sync
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
  grep -E '^[A-Za-z0-9][A-Za-z0-9._-]*\|' "$FLEET_REPO/fleet/roster.tmpl" | cut -d'|' -f1 || true
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

# Which roster sessions run on this host (ROLES, ROSTER_EXCLUDE, the registry): fleet_host_init + readers.
# shellcheck source=host-roles.sh
. "$FLEET_KIT_DIR/lib/host-roles.sh"

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
# Optional separate Claude Code config dir for the fleet (a machine shared with a person's own Claude
# use): its own login (the fleet's seat), user settings and plugin installs. Set = every fleet command
# (`claude plugin` in sync, `claude plugin list` in verify, the supervisor's login probe) and every
# session the fleet launches (or, with FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised, only the supervised and
# security-lane ones) run with CLAUDE_CONFIG_DIR=<it>. Unset = the account's default ~/.claude,
# and an inherited CLAUDE_CONFIG_DIR is dropped so what verify checks is what the sessions load.
: "${VERIFY_ALLOWED_USER_PLUGINS:=}" "${VERIFY_ALLOWED_USER_HOOKS:=}" "${VERIFY_ALLOWED_USER_FILES:=}"
export VERIFY_ALLOWED_USER_PLUGINS VERIFY_ALLOWED_USER_HOOKS VERIFY_ALLOWED_USER_FILES
# FLEET_CLAUDE_CONFIG_DIR_SCOPE: which launched sessions run with the fleet's dir. all (default) = every
# one; supervised = only the sessions the host classifies as supervised (merge, maintain, broker, any
# monster, a ledger-bearing session) and security-lane lines, while the interactive roles keep ~/.claude
# (CLAUDE_CONFIG_DIR unset). Fleet commands (verify, sync, the supervisor) always use the fleet's dir.
: "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:=all}"
case "$FLEET_CLAUDE_CONFIG_DIR_SCOPE" in all | supervised) ;; *) fleet_die "FLEET_CLAUDE_CONFIG_DIR_SCOPE must be all or supervised (got '$FLEET_CLAUDE_CONFIG_DIR_SCOPE')" ;; esac
export FLEET_CLAUDE_CONFIG_DIR_SCOPE
if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then
  case "$FLEET_CLAUDE_CONFIG_DIR" in /*) ;; *) fleet_die "FLEET_CLAUDE_CONFIG_DIR must be an absolute path (or start with ~), got '$FLEET_CLAUDE_CONFIG_DIR'" ;; esac
  export FLEET_CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR="$FLEET_CLAUDE_CONFIG_DIR"
else
  unset CLAUDE_CONFIG_DIR
fi
