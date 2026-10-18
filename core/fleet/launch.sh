#!/usr/bin/env bash
# launch.sh — launch the fleet sessions (tmux windows) via the engsys agent-sessions launcher.
#
# Renders the instance's templates into <instance>/.fleet/ (machine-local, gitignored):
#   fleet/env/<lane>.env.tmpl  → .fleet/env/<lane>.env   (when GH_APP_ENV is set, each also gets the
#                                                          env-scoped git identity, the gh shim first
#                                                          on PATH, and GH_TOKEN/GITHUB_TOKEN unset)
#   fleet/roster.tmpl          → .fleet/roster            (the launcher's roster; a session line's
#                                                          optional 5th field names a per-session env)
# Each env also gets FLEET_STATE (this instance's .fleet dir), and FLEET_ID (and FEDERATION_FILE, when that file exists, FLEET_INSTANCE_REPO, when
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
# Merge and maintain sessions start only when `fleet verify --alert` passes (engsys#70): the plugin they
# load matches the pinned engsys release on GitHub. Anything else, a mismatch or a check that could not
# run, refuses a named one and leaves them out of a whole-roster launch, with one alert per incident
# (engsys#86 review H1). Other sessions are never checked. The one way past it is typed by a person:
# `fleet launch <name> --skip-verify`, from an interactive terminal only, which warns loudly and alerts
# (and refuses when the alert can't be delivered).
# No config file or environment variable turns it on, and the supervisor never passes it.
#
# Token mode (engsys#205): with FLEET_CLAUDE_OAUTH_TOKEN_FILE set, each session on the fleet's config dir reads the
# long-lived token from that file when its launch line runs (the line holds the path, never the token); the
# interactive roles under scope supervised unset any inherited one. A token file that is missing, empty,
# group/other-accessible, not owned by the fleet user or inside a git work tree refuses a named launch and is
# SKIPPED in a whole-roster one, for the sessions that would read it.
#
# Claude-only: a merge, maintain, broker (any monster), supervised or security-lane session (5th field
# security*) is refused when HARNESS is anything but claude, whether it came from fleet.conf,
# fleet.local.conf, the environment or a HARNESS= line in the roster. A whole-roster launch starts the
# rest, prints `SKIPPED: <name>` for each refused one, and exits non-zero: a refusal is an error.
#
# Usage: launch.sh [--instance <dir>]                              # every session that runs on this host
#        launch.sh [--instance <dir>] <name> [--force-excluded]    # just one (the supervisor relaunches this way)
#        launch.sh [--instance <dir>] <name> --skip-verify         # a merge/maintain session without the plugin
#                                                                  # check: an operator at a terminal only
#        launch.sh [--instance <dir>] --check <name>               # exit 0 if <name> runs on this host, else
#                                                                  # 1 and the reason (the supervisor's HOST_CHECK_CMD)
#        launch.sh [--instance <dir>] --host-health                 # exit 0, or 1 and an alert when an unreadable
#                                                                  # registry keeps merge/maintain off this host
#                                                                  # (the supervisor's HOST_HEALTH_CMD)
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
name="" check=0 force_excluded=0 health=0 skip_verify=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --force-excluded) force_excluded=1 ;;
    --host-health) health=1 ;;
    --skip-verify) skip_verify=1 ;;
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
[ "$skip_verify" = 0 ] || [ -n "$name" ] || fleet_die "--skip-verify needs a session name (it never applies to a whole-roster launch)"
# Typed by a person, never by a script or a session: both stdin and stdout must be a terminal.
[ "$skip_verify" = 0 ] || { [ -t 0 ] && [ -t 1 ]; } || fleet_die "--skip-verify only works from an interactive terminal"
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

# The rendered roster first: classification below reads its 5th fields and flags with __TOKENS__ resolved.
fleet_render "$FLEET_REPO/fleet/roster.tmpl" "$FLEET_STATE/roster"
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
# Token mode (engsys#205): a token file that can't be used keeps every session that would read it from starting
# (the launch line would otherwise fall back to the Keychain login, the refresh path this mode exists to avoid).
TOKEN_PROBLEM=""
[ -z "${FLEET_CLAUDE_OAUTH_TOKEN_FILE:-}" ] || TOKEN_PROBLEM="$(fleet_oauth_token_problem || true)"
# (launch_harness, resolved below from the rendered roster as the launcher reads it, decides whether a session reads the file)
token_refused() { [ -n "$TOKEN_PROBLEM" ] && [ "${launch_harness:-claude}" = claude ] && uses_fleet_config_dir "$1"; }
roster_names() { grep -E "$ROSTER_LINE_RE" "$FLEET_STATE/roster" | cut -d'|' -f1; }
# env_file_users <env file basename> → the roster sessions that source it (5th field, else ENV_FILE)
env_file_users() {
  local def
  def="$(roster_default_env)"
  awk -F'|' -v f="$1" -v def="${def##*/}" '/^[A-Za-z0-9][A-Za-z0-9._-]*[|]/ {
    e = $5; sub(/.*\//, "", e); if (e == "") e = def; if (e == f) print $1 }' "$FLEET_STATE/roster"
}
# The fleet dir goes into an env file only when no interactive session sources it; a file an interactive
# role sources unsets it. Either way the launch line decides last (the launcher sets or unsets it after
# the env file), so a supervised session that shares a file with an interactive one still gets the dir.
env_config_dir_line() { # env_config_dir_line <env file basename>
  [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || return 0
  local n interactive=0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    uses_fleet_config_dir "$n" || interactive=1
  done < <(env_file_users "$1")
  if [ "$interactive" = 1 ]; then
    printf '# FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised: interactive sessions use ~/.claude\nunset CLAUDE_CONFIG_DIR\n'
  else
    printf 'CLAUDE_CONFIG_DIR=%q\n' "$FLEET_CLAUDE_CONFIG_DIR"
  fi
}
if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" = supervised ]; then
  # The launcher unsets CLAUDE_CONFIG_DIR only for these names (and only when it doesn't itself see a
  # monster or security line); every other session keeps the fleet dir.
  FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" "
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    if is_interactive "$n"; then FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE+="$n "; fi
  done < <(roster_names)
  export FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE
else
  unset FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE
fi
unset FLEET_CLAUDE_CONFIG_DIR_SESSIONS

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
  # The fleet state dir (<instance>/.fleet): hooks and the Fleet Health Desk read fleet-owned state
  # (weather cache, trusted fleet-health.yml) only from here, never from the session's working tree.
  printf 'FLEET_STATE=%q\n' "$FLEET_STATE" >>"$dest"
  env_config_dir_line "$(basename "$dest")" >>"$dest"
  # The security lane never inherits a subagent model override: it would move pinned security agents
  # (model: claude-opus-4-8) onto another model. (fleet verify flags the same keys in settings files.)
  # (Named as is_security_session reads it: security or nyx, any case, any prefix of security*.)
  _lane="$(basename "$dest" .env | tr '[:upper:]' '[:lower:]')"
  case "$_lane" in security* | nyx) printf '# Security lane: no inherited subagent model override.\nunset CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_SUBAGENT_MODEL_FORCE\n' >>"$dest" ;; esac
  if [ "${HARNESS:-claude}" != claude ]; then printf 'HARNESS=%q\n' "$HARNESS" >>"$dest"; fi
  if [ "${HARNESS:-claude}" = copilot ] && [ -n "${COPILOT_HOME:-}" ]; then printf 'COPILOT_HOME=%q\n' "$COPILOT_HOME" >>"$dest"; fi
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

# Plugin integrity (engsys#70), asked once per launch and only when a merge or maintain session is in it.
# Fails closed: only a pass lets them start (engsys#86 review H1).
integrity="" why_held="" # integrity: '' = not asked yet | ok | held
singleton_integrity_ok() { # → 0 when merge/maintain sessions may start
  if [ -z "$integrity" ]; then
    local rc=0
    bash "$FLEET_KIT_DIR/verify.sh" --instance "$FLEET_REPO" --alert </dev/null >&2 || rc=$?
    case "$rc" in
      0) integrity=ok ;;
      1) integrity=held why_held="its engsys plugin does not match $ENGSYS_REF" ;;
      *) integrity=held why_held="the engsys plugin check could not run (exit $rc), so the plugin is unverified" ;;
    esac
  fi
  [ "$integrity" = ok ]
}
is_singleton() { case "$(fleet_host_kind_of "$1")" in merge | maintain) return 0 ;; esac; return 1; }

# Claude-only: merge, maintain, broker (and any other monster) and security-lane sessions never start on
# another harness, wherever HARNESS came from (fleet.conf, fleet.local.conf, the environment, or a
# HARNESS= line in the roster).
launch_harness="$(sed -n 's/^HARNESS=//p' "$FLEET_STATE/roster" | tail -n 1 | tr -d '\r' | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//')"
launch_harness="${launch_harness:-${HARNESS:-claude}}"
case "$launch_harness" in agy) launch_harness=antigravity ;; esac
harness_refused() { [ "$launch_harness" != claude ] && claude_only "$1"; }
# The supervisor reads a seat-limit line only from a pane it knows it launched: record the pane of every
# supervised session started here (the supervisor's own relaunches come through here too).
record_panes() { # record_panes <name>...
  local n id sd="$FLEET_REPO/logs/fleet-supervisor"
  for n in "$@"; do
    fleet_ledger_sessions | grep -Fxq -- "$n" || continue
    id="$(tmux list-panes -t "${TMUX_SESSION}:$n" -F '#{pane_id}' 2>/dev/null | head -1 || true)"
    [ -n "$id" ] || continue
    mkdir -p "$sd" && printf '%s\n' "$id" >"$sd/$n.pane"
  done
}

export HARNESS="${HARNESS:-claude}"
# Sessions this host classifies as a monster or a supervised session (fleet_host_kind, supervisor.conf
# membership). The launcher refuses them on a non-Claude harness, whatever their prompt says.
ENGSYS_SUPERVISED_SESSIONS="$(printf '%s' "$FLEET_HOST_TABLE" | awk -F'|' '$2 ~ /^(merge|maintain|broker|monster)$/ { printf "%s ", $1 }')"
export ENGSYS_SUPERVISED_SESSIONS
cd "$PIN_DIR"
if [ -n "$name" ]; then
  grep -q "^$name|" "$FLEET_STATE/roster" || fleet_die "no session named '$name' in the roster"
  harness_refused "$name" && fleet_die "not launching $name on HARNESS=$launch_harness: merge, maintain, broker and security sessions run on Claude only"
  ! token_refused "$name" || fleet_die "not launching $name: $TOKEN_PROBLEM"
  if is_singleton "$name" && [ "$skip_verify" = 1 ]; then
    {
      echo "fleet: ################################################################################"
      echo "fleet: WARNING launching $name WITHOUT the plugin integrity check (--skip-verify)."
      echo "fleet: Its guard hook and fenced wrappers are not confirmed to match $ENGSYS_REF. The team is alerted."
      echo "fleet: ################################################################################"
    } >&2
    # The alert is the control here, so the launch waits on it: no alert delivered, no launch.
    node "$FLEET_KIT_DIR/notify.mjs" --level alert --require-delivery --incident wrapper-integrity-skipped "Plugin check skipped on $(hostname -s 2>/dev/null || echo this host): someone launched $name with --skip-verify, so its engsys plugin was not checked against $ENGSYS_REF. If that wasn't planned, please stop the session and run fleet verify." >&2 \
      || fleet_die "not launching $name: the --skip-verify alert could not be posted (Slack and NOTIFY_FALLBACK_ISSUE both failed, above). Fix the alert path first."
  elif is_singleton "$name" && ! singleton_integrity_ok; then
    fleet_die "not launching $name: $why_held (above). Check the running sessions, fix or reinstall the plugin, then: fleet verify"
  fi
  lrc=0; bash "$LAUNCHER" --roster "$FLEET_STATE/roster" "$name" || lrc=$?
  [ "$lrc" != 0 ] || record_panes "$name"
  exit "$lrc"
fi

# The host roster: the rendered roster minus the sessions that are not on this host.
host_roster="$FLEET_STATE/roster.host" kept=0 refused=0
: >"$host_roster"; chmod 600 "$host_roster"
while IFS= read -r line; do
  case "$line" in
    [A-Za-z0-9]*\|*)
      n="${line%%|*}"
      if why="$(fleet_host_excluded "$n")"; then
        echo "skip: $n is not on this host ($why)"
        printf '# not on this host: %s (%s)\n' "$n" "$why" >>"$host_roster"
        continue
      fi
      if harness_refused "$n"; then
        echo "SKIPPED: $n (a Claude-only session, and HARNESS=$launch_harness)" >&2
        printf '# claude-only: %s (HARNESS=%s)\n' "$n" "$launch_harness" >>"$host_roster"
        refused=$((refused + 1))
        continue
      fi
      if token_refused "$n"; then
        echo "SKIPPED: $n ($TOKEN_PROBLEM)" >&2
        printf '# token file unusable: %s\n' "$n" >>"$host_roster"
        refused=$((refused + 1))
        continue
      fi
      if is_singleton "$n" && ! singleton_integrity_ok; then
        echo "skip: $n, $why_held (fleet verify)"
        printf '# plugin integrity held: %s (%s)\n' "$n" "$why_held" >>"$host_roster"
        continue
      fi
      kept=$((kept + 1)) ;;
  esac
  printf '%s\n' "$line" >>"$host_roster"
done <"$FLEET_STATE/roster"
if [ "$kept" = 0 ]; then
  [ "$refused" = 0 ] || fleet_die "$refused session(s) refused (SKIPPED above: a Claude-only session on HARNESS=$launch_harness, or an unusable token file); nothing else to launch"
  echo "fleet: no roster session runs on this host; nothing to launch"; exit 0
fi
lrc=0; bash "$LAUNCHER" --roster "$host_roster" || lrc=$?
# shellcheck disable=SC2046 # names are [a-z0-9-] only
record_panes $(awk -F'|' '/^[A-Za-z0-9][A-Za-z0-9._-]*\|/ { print $1 }' "$host_roster")
[ "$refused" != 0 ] || exit "$lrc"
echo "fleet: $refused session(s) refused (SKIPPED above: a Claude-only session on HARNESS=$launch_harness, or an unusable token file)" >&2
exit $(( lrc != 0 ? lrc : 1 ))
