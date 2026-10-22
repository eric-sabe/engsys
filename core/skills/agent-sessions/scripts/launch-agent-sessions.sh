#!/usr/bin/env bash
#
# launch-agent-sessions.sh — stand up a fleet of named, cross-session-messaging
# ready Claude Code sessions for a project, as tmux windows on an always-on
# machine.
#
# The fleet is declared in a ROSTER FILE (default: .claude/agent-sessions.roster
# under the cwd — the target repo, or a separate fleet repo that drives one or
# more target repos via per-session workdirs; see roster.example).
# Header lines are KEY=VALUE; session lines are pipe-delimited:
#
#   NAMESPACE=acme                 # required: session-name prefix (the trust fence)
#   TMUX_SESSION=acme              # optional: tmux session name (default: NAMESPACE)
#   ENV_FILE=~/.config/acme/agents.env   # optional: sourced into every session
#   MODEL=--model <model-id>       # optional: appended to every session
#   PREFLIGHT=<command>            # optional, repeatable: run before launching
#                                  # (e.g. a cloud/gh identity-refresh script);
#                                  # failure warns, never blocks the launch
#   <name>|<workdir>|<initial prompt>|<extra claude flags>[|<env file>]
#
#   <name>            must start with "NAMESPACE-" (enforced) — messaging is
#                     scoped to the OS user, not the project, so the prefix IS
#                     the isolation: peers only trust names under their prefix.
#   <workdir>         empty → the cwd the launcher runs from; a leading ~ is
#                     expanded. From a fleet repo, set it per session.
#   <initial prompt>  sent as the session's first turn (e.g. /merge-monster);
#                     empty for a plain interactive session.
#   <extra flags>     appended verbatim (after the prompt, so list-valued flags
#                     like --add-dir are safe). Use --dangerously-skip-permissions ONLY
#                     for a session that runs fully unattended (see SKILL.md
#                     § Permission modes), and understand it composes with
#                     crossSessionInbound=accept so nudges still arrive.
#                     With the optional 5th field present, the extra flags
#                     must not contain a literal "|".
#   <env file>        optional: an env file for THIS session only — absolute,
#                     or relative to the roster file's directory (~ expanded).
#                     It REPLACES the roster-level ENV_FILE for the session
#                     (source the shared one from inside it if you want both),
#                     so one roster can hold lanes with different environments
#                     (e.g. a different model alias set). A missing file is an
#                     error for that session — an explicit per-session
#                     environment never silently falls back.
#
# USAGE
#   launch-agent-sessions.sh [--roster FILE] [--verdict-key-file PATH] [--launch-dir DIR] [session-name]
#     no args          start every session in the roster
#     session-name     start just that one
#
# HOW A SESSION STARTS (engsys#236)
#   Each session's full command line (env, cd, env file, harness) is written to a one-shot launch file
#   in DIR (--launch-dir, else $ENGSYS_LAUNCH_DIR, else ~/.local/state/engsys/launch; 0700, owned by
#   this user), and the window's shell is typed only `. <file>`. The window's shell is still starting
#   when the keys arrive, so its tty is in canonical mode, where macOS keeps at most MAX_CANON (1024)
#   bytes of an unread line and drops the rest, Enter included: a long line typed whole never runs.
#   Sourcing keeps the old semantics: the same interactive shell runs the command, so the harness is
#   the pane's foreground command, and the pane returns to the shell when it exits (what the
#   supervisor reads). The file removes itself just before the harness starts.
#   A launch counts only once it has started: the file is gone and the pane's foreground command is
#   no longer the shell, within LAUNCH_START_TIMEOUT_SEC (default 30; 0 = don't wait). Otherwise it
#   fails with "launch did not start", its window is closed, and the launcher exits non-zero.
#
# PREREQS
#   * tmux; claude >= 2.1.232; run as the machine's normal login user
#     (messaging sockets are per-user)
#
# Attach afterwards:  tmux attach -t <TMUX_SESSION>   (detach: Ctrl-b d)
set -euo pipefail

ROSTER=".claude/agent-sessions.roster"
ONLY=""
# engsys#197: the verdict key PATH arrives as a flag and is scrubbed from the environment here, so neither this
# process nor the tmux server it may start (whose global environment every later window inherits, hand-opened
# ones included) ever carries it; it reaches a session only on that session's own launch line, below.
VERDICT_KEY_FILE=""
LAUNCH_DIR="${ENGSYS_LAUNCH_DIR:-}"
unset ENGSYS_SECURITY_VERDICT_KEY_FILE
unset ENGSYS_MM_CONFIG   # engsys#229: set per merge-role line below, never inherited (nor seen by the tmux server)
unset ENGSYS_MEMORY_CONFIG   # engsys#262: set below for a line on its own per-session login dir, never inherited
while [ $# -gt 0 ]; do
  case "$1" in
    --roster) ROSTER="$2"; shift 2 ;;
    --verdict-key-file) VERDICT_KEY_FILE="$2"; shift 2 ;;
    --launch-dir) LAUNCH_DIR="$2"; shift 2 ;;
    -h | --help) sed -n '2,66p' "$0"; exit 0 ;;
    *) ONLY="$1"; shift ;;
  esac
done

REPO="$(pwd)"
ROSTER_DIR="$(cd "$(dirname "$ROSTER")" 2>/dev/null && pwd)" || ROSTER_DIR="$REPO"
[ -f "$ROSTER" ] || { echo "error: roster not found: $ROSTER (see the agent-sessions skill's roster.example)" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "error: tmux not found on PATH" >&2; exit 1; }
LAUNCH_DIR="${LAUNCH_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/engsys/launch}"
LAUNCH_START_TIMEOUT_SEC="${LAUNCH_START_TIMEOUT_SEC:-30}"
case "$LAUNCH_START_TIMEOUT_SEC" in '' | *[!0-9]*) echo "error: LAUNCH_START_TIMEOUT_SEC must be a whole number of seconds" >&2; exit 1 ;; esac
# The one line typed into a window, `. <launch file>`, stays far below MAX_CANON (1024 bytes); a launch dir whose
# path would push it past this is refused rather than truncated.
LAUNCH_LINE_MAX=512
# launchd jobs (the fleet supervisor) run with a fixed PATH that may not include where Claude Code was
# installed: the native installer uses ~/.local/bin. Look in the standard install locations before failing.
HARNESS="${HARNESS:-${FLEET_HARNESS:-claude}}"

# ---------------------------------------------------------------------------
# Parse roster
# ---------------------------------------------------------------------------
NAMESPACE="" TMUX_SESSION="" ENV_FILE="" MODEL=""
SESSIONS=() PREFLIGHTS=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    [A-Z]*=*) # header: drop a trailing " # comment" and trailing blanks
      line=$(printf '%s' "$line" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  case "$line" in
    '' | \#*) continue ;;
    NAMESPACE=*) NAMESPACE="${line#NAMESPACE=}" ;;
    TMUX_SESSION=*) TMUX_SESSION="${line#TMUX_SESSION=}" ;;
    ENV_FILE=*) ENV_FILE="${line#ENV_FILE=}"; ENV_FILE="${ENV_FILE/#\~/$HOME}" ;;
    MODEL=*) MODEL="${line#MODEL=}" ;;
    HARNESS=*) HARNESS="${line#HARNESS=}" ;;
    PREFLIGHT=*) PREFLIGHTS+=("${line#PREFLIGHT=}") ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "error: unrecognized roster line: $line" >&2; exit 1 ;;
  esac
done < "$ROSTER"

case "$HARNESS" in
  claude | copilot | antigravity) ;;
  agy) HARNESS=antigravity ;;
  *) echo "error: unsupported HARNESS '$HARNESS' (expected claude, copilot, or antigravity)" >&2; exit 1 ;;
esac

HARNESS_BIN="claude"
case "$HARNESS" in
  copilot) HARNESS_BIN="copilot" ;;
  antigravity) HARNESS_BIN="agy" ;;
esac
if ! command -v "$HARNESS_BIN" >/dev/null 2>&1; then
  for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/$HARNESS_BIN" ]; then PATH="$d:$PATH"; export PATH; break; fi
  done
fi
command -v "$HARNESS_BIN" >/dev/null 2>&1 || { echo "error: $HARNESS_BIN not found on PATH (also looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)" >&2; exit 1; }

[ -n "$NAMESPACE" ] || { echo "error: roster must set NAMESPACE=" >&2; exit 1; }
TMUX_SESSION="${TMUX_SESSION:-$NAMESPACE}"
[ ${#SESSIONS[@]} -gt 0 ] || { echo "error: roster has no session lines" >&2; exit 1; }

SETTINGS_FILE="$HOME/.claude/${NAMESPACE}-messaging-settings.json"

# ---------------------------------------------------------------------------
# Messaging settings: crossSessionInbound=accept — an autonomous session must
# not hold inbound nudges behind an approval dialog nobody is watching. An
# absent file is created; an existing file gets ONLY that key patched (jq).
# The naming convention is only *safe* because the monster skills validate
# every inbound message against the repo before acting.
# ---------------------------------------------------------------------------
if [ "$HARNESS" = "claude" ]; then
  if [ ! -f "$SETTINGS_FILE" ]; then
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    printf '{\n  "crossSessionInbound": "accept"\n}\n' > "$SETTINGS_FILE"
    echo "wrote messaging settings: $SETTINGS_FILE"
  elif command -v jq >/dev/null 2>&1; then
    if [ "$(jq -r '.crossSessionInbound // empty' "$SETTINGS_FILE")" != "accept" ]; then
      tmp="$(mktemp "${SETTINGS_FILE}.XXXXXX")"
      jq '.crossSessionInbound = "accept"' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
      echo "patched messaging settings: $SETTINGS_FILE (crossSessionInbound=accept)"
    fi
  else
    echo "warning: jq not found — verify crossSessionInbound=accept in $SETTINGS_FILE manually" >&2
  fi
fi

# Optional per-machine env (credentials, endpoints — e.g. a durable cloud
# identity). Must be injected into each WINDOW's command line: a pre-existing
# tmux server does not inherit this launcher's exports.
if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  echo "warning: ENV_FILE not found: $ENV_FILE — sessions start without it" >&2
  ENV_FILE=""
fi

# Optional preflights (identity refresh etc.). Run on EVERY invocation —
# including the supervisor's single-session relaunches — so a durable identity
# is re-checked before a session that depends on it starts. Fail-open: a
# failed preflight warns and the fleet starts anyway (surfaces that need the
# identity will error visibly instead of the whole fleet staying dark).
for pf in ${PREFLIGHTS[@]+"${PREFLIGHTS[@]}"}; do
  bash -c "$pf" || echo "warning: preflight failed (sessions start anyway): $pf" >&2
done

# Translate Claude-style roster flags into shell-escaped Copilot CLI flags when HARNESS=copilot.
translate_copilot_flags() {
  local raw="$1" out=() tok q=()
  set -f
  # shellcheck disable=SC2086
  set -- $raw
  set +f
  while [ $# -gt 0 ]; do
    tok="$1"; shift
    case "$tok" in
      --dangerously-skip-permissions)
        out+=(--yolo --mode autopilot --no-ask-user) ;;
      --remote-control)
        out+=(--remote) ;;
      --permission-mode)
        if [ "${1:-}" = "bypassPermissions" ]; then out+=(--yolo); fi
        [ $# -eq 0 ] || shift ;;
      --effort)
        if [ $# -gt 0 ]; then out+=(--reasoning-effort "$1"); shift; fi ;;
      --model)
        if [ $# -gt 0 ]; then
          case "$1" in
            opus | fable | claude-opus-5* | claude-fable-*) out+=(--model claude-opus-5.5) ;;
            claude-opus-4-8) out+=(--model claude-opus-4.8) ;;
            sonnet | claude-sonnet-5*) out+=(--model claude-sonnet-5.5) ;;
            haiku | claude-haiku-*) out+=(--model claude-haiku-5.5) ;;
            *) out+=(--model "$1") ;;
          esac
          shift
        fi ;;
      *)
        out+=("$tok") ;;
    esac
  done
  if [ "${#out[@]}" -gt 0 ]; then
    local item
    for item in "${out[@]}"; do
      q+=("$(printf '%q' "$item")")
    done
    printf '%s' "${q[*]}"
  fi
}

# Translate Claude-style roster flags into shell-escaped Antigravity CLI (agy) flags when HARNESS=antigravity.
translate_antigravity_flags() {
  local raw="$1" out=() tok q=()
  set -f
  # shellcheck disable=SC2086
  set -- $raw
  set +f
  while [ $# -gt 0 ]; do
    tok="$1"; shift
    case "$tok" in
      --dangerously-skip-permissions)
        out+=(--dangerously-skip-permissions) ;;
      --remote-control)
        out+=(--remote-control) ;;
      --permission-mode)
        if [ "${1:-}" = "bypassPermissions" ]; then out+=(--dangerously-skip-permissions); fi
        [ $# -eq 0 ] || shift ;;
      --effort)
        if [ $# -gt 0 ]; then out+=(--effort "$1"); shift; fi ;;
      --model)
        if [ $# -gt 0 ]; then
          if is_security_model "$1"; then
            echo "error: Antigravity cannot run the security model ($1); refusing to map it to another model" >&2
            return 1
          fi
          case "$1" in
            opus | sonnet | fable | claude-* | pro) out+=(--model gemini-4-argon) ;;
            haiku | flash) out+=(--model gemini-3.8-flash) ;;
            inherit) ;;
            *) out+=(--model "$1") ;;
          esac
          shift
        fi ;;
      *)
        out+=("$tok") ;;
    esac
  done
  if [ "${#out[@]}" -gt 0 ]; then
    local item
    for item in "${out[@]}"; do
      q+=("$(printf '%q' "$item")")
    done
    printf '%s' "${q[*]}"
  fi
}

# Antigravity Remote Control is opt-in. Unlike Claude Code (where --remote-control is self-contained per
# session), Antigravity needs a host-level background daemon (`agy remote-control start`), which exposes
# the host's sessions for remote driving. The launcher never starts it on its own: set
# AGY_REMOTE_CONTROL_AUTOSTART=1 to start it when HARNESS=antigravity and a roster session uses
# --remote-control (or AGY_REMOTE_CONTROL=1). Default off.
if [ "$HARNESS" = "antigravity" ] && [ "${AGY_REMOTE_CONTROL_AUTOSTART:-0}" = 1 ]; then
  agy_needs_rc=0
  if [ "${AGY_REMOTE_CONTROL:-0}" = 1 ]; then
    agy_needs_rc=1
  else
    for spec in "${SESSIONS[@]}"; do
      case "$spec" in *--remote-control*) agy_needs_rc=1; break ;; esac
    done
  fi
  if [ "$agy_needs_rc" = 1 ]; then
    if ! agy remote-control status 2>/dev/null | grep -qi 'Daemon status:[[:space:]]*running'; then
      agy_rc_name="${FLEET_ID:-$NAMESPACE}-$(hostname -s 2>/dev/null || echo host)"
      if agy remote-control start --name "$agy_rc_name" >/dev/null 2>&1; then
        echo "started Antigravity remote-control daemon: $agy_rc_name"
      else
        echo "warning: agy remote-control start failed (sessions start anyway)" >&2
      fi
    fi
  fi
fi

# Model names are normalized before any policy match: lowercase, quotes dropped, a `[…]` suffix (for
# example a context-window tag) and a trailing date stamp stripped.
norm_model() {
  local m
  m="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d "\"'")"
  m="${m%%\[*}"
  m="$(printf '%s' "$m" | sed -E 's/[-@.]?(19|20)[0-9]{2}-?[0-9]{2}-?[0-9]{2}$//')"
  printf '%s' "$m"
}
# 0 when a model names Claude Opus 4.8 in any spelling (claude-opus-4-8, claude-opus-4.8, …) or the
# `security` alias.
is_security_model() {
  local m
  m="$(norm_model "$1")"
  case "$m" in claude-opus-4-8* | claude-opus-4.8* | security) return 0 ;; esac
  return 1
}
# engsys#229: the repo's merge-monster config inside the fleet config dir (the instance plugin's
# repos/<owner>/<repo>/merge-monster.yml, core/lib/mm-config.mjs), for a merge-role line's ENGSYS_MM_CONFIG. Prints the
# first readable one, or nothing. Looked up in the session's own Claude config dir, then the launcher's.
resolve_mm_config() { # resolve_mm_config <workdir> <session config dir>
  local script args=() d out
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../lib" 2>/dev/null && pwd)/mm-config.mjs"
  [ -f "$script" ] && command -v node >/dev/null && command -v jq >/dev/null || return 0
  for d in "$2" "${CLAUDE_CONFIG_DIR:-}"; do [ -z "$d" ] || args+=(--config-dir "$d"); done
  [ "${#args[@]}" -gt 0 ] || args+=(--config-dir "$HOME/.claude")
  out="$(node "$script" resolve --cwd "$1" "${args[@]}" 2>/dev/null)" || return 0
  jq -r '.configs[0] // empty' <<<"$out" 2>/dev/null || true
}
# 0 when an env file is the security lane: its name, without directory and extension, normalizes to
# `security` or `nyx`.
is_security_env() {
  local b
  [ -n "$1" ] || return 1
  b="${1##*/}"; b="${b%.*}"
  b="$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]' | tr -d "\"' ")"
  case "$b" in security | nyx) return 0 ;; esac
  return 1
}
# The --model value(s) in a flag string, one per line (both `--model X` and `--model=X`).
model_values() {
  local tok prev=""
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  for tok in "$@"; do
    [ "$prev" = "--model" ] && printf '%s\n' "$tok"
    case "$tok" in --model=*) printf '%s\n' "${tok#--model=}" ;; esac
    prev="$tok"
  done
  return 0
}
# A security-tier roster line: a model that names Claude Opus 4.8, or the security env lane.
is_security_line() { # is_security_line <flags> <env file> → 0 when security tier
  local m
  is_security_env "$2" && return 0
  while IFS= read -r m; do
    [ -n "$m" ] && is_security_model "$m" && return 0
  done < <(model_values "$1")
  return 1
}
# The monster role a prompt runs, case-insensitively and with `_`, spaces or `-` between the words:
# merge | maintain, or empty.
prompt_role() {
  local p
  p="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--')"
  case "$p" in
    *merge-monster*) echo merge ;;
    *maintenance-monster*) echo maintain ;;
  esac
  return 0
}
# 0 when a prompt runs the resource broker (the third monster), with the same tolerance as prompt_role.
prompt_is_broker() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--')" in *resource-broker*) return 0 ;; esac
  return 1
}
# 0 when the host (fleet launch) classified this session as a monster or a supervised session.
is_supervised_session() {
  case " ${ENGSYS_SUPERVISED_SESSIONS:-} " in *" $1 "*) return 0 ;; esac
  return 1
}

# engsys#236: the launch dir (header). Checked once per run: owned by this user, open to nobody else, never a
# symlink, and absolute, because the window's shell reads the file from its own cwd. A missing one is created 0700;
# an existing one open to others is refused, never chmod'ed (it may be a directory with another purpose).
# Leftovers of a launcher killed mid-wait (a launch file normally removes itself, and a failed launch removes it)
# are pruned after an hour: only files named as launch files (<name>.<run id>.XXXXXX), nothing else in the dir.
LAUNCH_DIR_READY=0
prepare_launch_dir() {
  [ "$LAUNCH_DIR_READY" = 0 ] || return 0
  local mode
  if [ -L "$LAUNCH_DIR" ]; then echo "error: launch dir $LAUNCH_DIR is a symlink; refusing to write launch files through it" >&2; return 1; fi
  (umask 077 && mkdir -p "$LAUNCH_DIR") || { echo "error: can't create launch dir $LAUNCH_DIR" >&2; return 1; }
  if [ -L "$LAUNCH_DIR" ] || [ ! -d "$LAUNCH_DIR" ] || [ ! -O "$LAUNCH_DIR" ]; then
    echo "error: launch dir $LAUNCH_DIR is not a directory owned by $(id -un)" >&2; return 1
  fi
  # GNU first: GNU `stat -f` is filesystem status and would print before failing; BSD `stat -c` fails silently
  mode="$(stat -c %a "$LAUNCH_DIR" 2>/dev/null || stat -f %Lp "$LAUNCH_DIR" 2>/dev/null || true)"
  case "$mode" in
    *[0-7]00) ;;
    *) echo "error: launch dir $LAUNCH_DIR is open to other users (mode ${mode:-unknown}); it must be private: chmod 700 it, or use another --launch-dir" >&2; return 1 ;;
  esac
  LAUNCH_DIR="$(cd -P "$LAUNCH_DIR" && pwd)" || { echo "error: can't resolve launch dir $LAUNCH_DIR" >&2; return 1; }
  find "$LAUNCH_DIR" -maxdepth 1 -type f -mmin +60 \
    -name '*.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*-*.??????' \
    -exec rm -f {} + 2>/dev/null || true
  LAUNCH_DIR_READY=1
}
# The login shells a fresh window runs (the same list as the supervisor's pane_cmd checks).
is_shell_cmd() {
  case "$1" in zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) return 0 ;; esac
  return 1
}
# wait_started <name> <launch file> → 0 once the session has started: the launch file is gone (the shell ran the
# line up to the harness, which removes it just before starting) and the pane's foreground command is no longer
# the shell. Otherwise, after LAUNCH_START_TIMEOUT_SEC, says why (with the pane's last lines) and returns 1.
# The file is checked BEFORE the pane is read, and a pane at `rm` is not started: the line's `command rm` unlinks
# the file before it exits, so a sample can see the file gone with `rm` still in the foreground, and the harness
# may yet fail to exec.
wait_started() {
  local name="$1" file="$2" target="${TMUX_SESSION}:$1" waited=0 cur why gone
  while :; do
    gone=0; [ -e "$file" ] || gone=1
    cur="$(tmux list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null | head -1 || true)"
    if [ -z "$cur" ]; then why="its window closed"; break; fi
    if [ "$gone" = 1 ] && ! is_shell_cmd "$cur" && [ "$cur" != rm ]; then return 0; fi
    if [ "$waited" -ge "$LAUNCH_START_TIMEOUT_SEC" ]; then
      if [ -e "$file" ]; then why="the launch line has not reached the harness yet (the pane is still at $cur)"
      else why="the launch line ran, but $HARNESS_BIN is not running (the pane is back at $cur)"; fi
      break
    fi
    sleep 1; waited=$((waited + 1))
  done
  echo "error: launch did not start for '$name' within ${LAUNCH_START_TIMEOUT_SEC}s: $why" >&2
  { tmux capture-pane -p -t "$target" -S -20 2>/dev/null || true; } | grep -v '^[[:space:]]*$' | tail -n 3 | cut -c1-200 | sed 's/^/  pane: /' >&2 || true
  return 1
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
launch_one() {
  local name="$1" workdir="$2" prompt="$3" extra="$4" env_file="${5:-}"

  case "$name" in
    "$NAMESPACE"-*) ;;
    *) echo "error: session name '$name' must start with '${NAMESPACE}-' (the namespace fence)" >&2; return 1 ;;
  esac
  [ -n "$workdir" ] || workdir="$REPO"
  workdir="${workdir/#\~/$HOME}"
  [ -d "$workdir" ] || { echo "error: workdir for '$name' not found: $workdir" >&2; return 1; }

  # Per-session env (5th roster field) replaces the roster-level ENV_FILE.
  local session_env="$ENV_FILE"
  if [ -n "$env_file" ]; then
    env_file="${env_file/#\~/$HOME}"
    case "$env_file" in /*) ;; *) env_file="$ROSTER_DIR/$env_file" ;; esac
    [ -f "$env_file" ] || { echo "error: env file for '$name' not found: $env_file" >&2; return 1; }
    session_env="$env_file"
  fi

  local cmd run_cmd="" run role=""
  # The session's own name and a per-launch id, for the monsters' baton (engsys#62): the holder is
  # <fleet>:<ENGSYS_SESSION>, and a fencing token on disk is honored only by the launch that took it.
  # A merge or maintenance monster (by its prompt, as lib/host-roles.sh reads it) also gets
  # ENGSYS_SINGLETON_ROLE, which arms the plugin's singleton-write guard hook for the session and
  # every agent it dispatches; any other session has it unset.
  run="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  role="$(prompt_role "$prompt")"
  # The monsters and the security lane are Claude-only: the merge and maintain batons and security work
  # stay on Claude (security on Claude Opus 4.8), so a non-Claude harness never launches them.
  local flags="${MODEL:+$MODEL }${extra:-}"
  if [ "$HARNESS" != "claude" ]; then
    if [ -n "$role" ]; then
      echo "error: refusing to launch '$name' (role=$role) on HARNESS=$HARNESS: merge and maintenance monsters run only on HARNESS=claude" >&2
      return 1
    fi
    if prompt_is_broker "$prompt"; then
      echo "error: refusing to launch '$name' (resource broker) on HARNESS=$HARNESS: monsters run only on HARNESS=claude" >&2
      return 1
    fi
    if is_supervised_session "$name"; then
      echo "error: refusing to launch '$name' on HARNESS=$HARNESS: the host classifies it as a monster or supervised session, which runs only on HARNESS=claude" >&2
      return 1
    fi
    if is_security_line "$flags" "${session_env:-}"; then
      echo "error: refusing to launch '$name' on HARNESS=$HARNESS: security-tier sessions run only on HARNESS=claude with claude-opus-4-8" >&2
      return 1
    fi
  elif [ "$role" = maintain ] || is_security_env "${session_env:-}"; then
    # On Claude, the maintenance monster and the security env lane run on Claude Opus 4.8 and nothing else.
    local m ok=0
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      if is_security_model "$m" && [ "$(norm_model "$m")" != security ]; then ok=1; else ok=0; break; fi
    done < <(model_values "$flags")
    if [ "$ok" != 1 ]; then
      echo "error: refusing to launch '$name': the maintenance monster and the security lane must run with --model claude-opus-4-8 (got: $(model_values "$flags" | tr '\n' ' '))" >&2
      return 1
    fi
  fi
  # ENGSYS_SESSION_ROOT is the directory the session was launched in: a guarded `fleet msg send`
  # takes its --body-file only from <root>/tmp, wherever the session cd's later (engsys#108).
  local root
  root="$(cd "$workdir" && pwd -P)" || { echo "error: cannot resolve workdir for '$name': $workdir" >&2; return 1; }
  cmd="export ENGSYS_SESSION=$(printf %q "$name") ENGSYS_SESSION_RUN=$(printf %q "$run") ENGSYS_SESSION_ROOT=$(printf %q "$root")"
  if [ -n "$role" ]; then cmd+=" ENGSYS_SINGLETON_ROLE=$role && "; else cmd+=" && unset ENGSYS_SINGLETON_ROLE && "; fi
  # engsys#197 (option B), narrowed by engsys#229: only a security-ENV session (security.env / nyx.env, the
  # security lane) on Claude is handed the PATH of the fleet's verdict key (ENGSYS_SECURITY_VERDICT_KEY_FILE, passed
  # by core/fleet/launch.sh as --verdict-key-file from FLEET_SECURITY_VERDICT_KEY=on); every other session has it
  # unset, whatever its model or env file (a merge-role line never gets it). A merge session on Opus 4.8 reads attacker-authored PR content, so it must not be
  # able to mint a PASS; it still verifies, because mm-preflight.sh reads the key file by path. Decided here, before the env
  # file, so a later assignment in an env file is overwritten below. Defence in depth, not a boundary: the
  # key file is readable by the same OS user (core/lib/security-verdict.mjs).
  local verdict_key_file="$VERDICT_KEY_FILE"
  if [ -n "$verdict_key_file" ] && [ "$HARNESS" = claude ] && [ "$role" != merge ] && is_security_env "${session_env:-}"; then
    cmd+="export ENGSYS_SECURITY_VERDICT_KEY_FILE=$(printf %q "$verdict_key_file") && "
  else
    cmd+="unset ENGSYS_SECURITY_VERDICT_KEY_FILE && "
  fi
  cmd+="unset ENGSYS_MEMORY_CONFIG && "   # engsys#262: cleared here, set again below for a line on a per-session login dir
  cmd+="unset ENGSYS_MM_CONFIG && "   # engsys#229: cleared here, set again below for a merge-role line once its config dir is known
  cmd+="cd $(printf %q "$workdir") && "
  if [ -n "$session_env" ]; then
    cmd+="set -a && . $(printf %q "$session_env") && set +a && "
    # and again after it, when a key is configured: an env file can neither add the key path to a
    # non-security session nor drop it from a security one
    if [ -n "$verdict_key_file" ]; then
      if [ "$HARNESS" = claude ] && [ "$role" != merge ] && is_security_env "${session_env:-}"; then
        cmd+="export ENGSYS_SECURITY_VERDICT_KEY_FILE=$(printf %q "$verdict_key_file") && "
      else
        cmd+="unset ENGSYS_SECURITY_VERDICT_KEY_FILE && "
      fi
    fi
  fi
  # The Claude Code config dir comes from the launcher's own environment (the fleet kit sets it from
  # FLEET_CLAUDE_CONFIG_DIR), never from the tmux server's, which may predate it, and it is decided after
  # the env file, so an accidental assignment there can't move a session to another dir. (Env files are
  # trusted, PR-reviewed shell code: a PATH wrapper, a DEBUG trap, `enable -n` or NODE_OPTIONS in one can
  # still change what runs. This guards against mistakes, not a hostile env file.) With
  # FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE set (scope supervised), only the sessions it names run with it
  # unset (~/.claude), and never one this launcher itself sees as a monster, the resource broker, a
  # supervised session or a security-tier line: an unknown session fails toward the fleet dir.
  local cfg_dir="${CLAUDE_CONFIG_DIR:-}"
  if [ -n "$cfg_dir" ] && [ -n "${FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE+x}" ]; then
    case "$FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE" in
      *" $name "*)
        if [ -z "$role" ] && ! prompt_is_broker "$prompt" && ! is_supervised_session "$name" \
          && ! is_security_line "$flags" "${session_env:-}"; then cfg_dir=""; fi ;;
    esac
  fi
  # One login per session (engsys#205): the fleet kit passes ENGSYS_CONFIG_DIR_SESSIONS (<fleet dir>.sessions) and a
  # session that gets the fleet dir runs on <that>/<its name>. The name is validated here too: nothing with a
  # slash, a leading dot or ".." can step out of that directory.
  local gate_dir="${CLAUDE_CONFIG_DIR:-}" memory_cfg=""
  if [ -n "$cfg_dir" ] && [ -n "${ENGSYS_CONFIG_DIR_SESSIONS:-}" ]; then
    case "$name" in
      '' | .* | */* | *..* | *[!A-Za-z0-9._-]*) echo "error: refusing to launch '$name': its name can't be a per-session Claude config dir name" >&2; return 1 ;;
    esac
    cfg_dir="${ENGSYS_CONFIG_DIR_SESSIONS%/}/$name"
    # engsys#262: a per-session login dir carries no memory.yml (by design: engsys#230 pins only the fleet dir's
    # copy), so the memory brief is pointed at the fleet dir's own, the launcher's CLAUDE_CONFIG_DIR.
    [ -z "${CLAUDE_CONFIG_DIR:-}" ] || memory_cfg="${CLAUDE_CONFIG_DIR%/}/memory.yml"
  fi
  [ -z "$cfg_dir" ] || gate_dir="$cfg_dir"
  # A function named claude in an env file must not stand in for the binary either. The whole line is one
  # fail-closed && chain (engsys#236 review): a `;` here restarted it, so an env file whose last command failed
  # skipped `set +a` and the key path's re-decision above, and claude still ran. zsh's `unset -f` fails for a
  # function that doesn't exist, hence the `|| true`.
  cmd+="{ unset -f claude 2>/dev/null || true; } && "
  # Under scope supervised the session knows the fleet dir and the scope, so the baton can refuse a
  # session that isn't on it (lib/lease/baton.mjs launchedSessionGate).
  if [ -n "${FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE+x}" ] && [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    cmd+="export FLEET_CLAUDE_CONFIG_DIR=$(printf %q "$gate_dir") FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised && "
  else
    cmd+="unset FLEET_CLAUDE_CONFIG_DIR_SCOPE && "
  fi
  # engsys#262: decided after the env file, like the config dir itself, so an env file can neither move it nor set
  # one on a line that gets none (it would outrank the reviewed memory.yml).
  if [ -n "$memory_cfg" ]; then cmd+="export ENGSYS_MEMORY_CONFIG=$(printf %q "$memory_cfg") && "; else cmd+="unset ENGSYS_MEMORY_CONFIG && "; fi
  if [ -n "$cfg_dir" ]; then cmd+="export CLAUDE_CONFIG_DIR=$(printf %q "$cfg_dir") && "; else cmd+="unset CLAUDE_CONFIG_DIR && "; fi
  # engsys#229, belt and braces beside mm-preflight's own discovery: a merge-role line is told where its repo's fleet merge
  # config is; every other line has it unset (above, before the env file). Decided after the env file, so an env file
  # cannot move it.
  local mm_cfg=""
  [ "$role" != merge ] || [ "$HARNESS" != claude ] || mm_cfg="$(resolve_mm_config "$workdir" "$cfg_dir")"
  if [ -n "$mm_cfg" ]; then cmd+="export ENGSYS_MM_CONFIG=$(printf %q "$mm_cfg") && "; fi
  # The harness itself (run_cmd) follows the launch file's self-removal (below).
  if [ "$HARNESS" = "copilot" ]; then
    run_cmd+="copilot --name $(printf %q "$name")"
    [ -n "$prompt" ] && run_cmd+=" -i $(printf %q "$prompt")"
    local copilot_flags
    copilot_flags="$(translate_copilot_flags "${MODEL:+$MODEL }${extra:-}")"
    [ -n "$copilot_flags" ] && run_cmd+=" $copilot_flags"
  elif [ "$HARNESS" = "antigravity" ]; then
    run_cmd+="agy $(printf %q "$workdir")"
    [ -n "$prompt" ] && run_cmd+=" -i $(printf %q "$prompt")"
    local agy_flags
    agy_flags="$(translate_antigravity_flags "${MODEL:+$MODEL }${extra:-}")" || { echo "error: refusing to launch '$name' on HARNESS=antigravity" >&2; return 1; }
    [ -n "$agy_flags" ] && run_cmd+=" $agy_flags"
  else
    run_cmd+="command claude --name $(printf %q "$name") --settings $(printf %q "$SETTINGS_FILE")"
    # The prompt goes BEFORE the model/extra flags: several claude flags take a
    # list (--add-dir, --allowedTools, …) and would swallow a trailing prompt as
    # one more value — the session would start with no instruction.
    [ -n "$prompt" ] && run_cmd+=" $(printf %q "$prompt")"
    [ -n "$MODEL" ] && run_cmd+=" $MODEL"
    [ -n "$extra" ] && run_cmd+=" $extra"
  fi

  # A duplicate logical name ANYWHERE the same user runs claude makes Claude
  # Code suffix this one (name-2), which breaks name addressing. Reject a name
  # already present in any window on the whole tmux server. Sessions launched
  # OUTSIDE tmux can't be seen here — `claude` + ListAgents to confirm free.
  if tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -Fxq -- "$name"; then
    echo "skip: a tmux window named '$name' already exists on this server" >&2
    return 0
  fi

  # engsys#236: the command goes into a one-shot launch file and only `. <file>` is typed (header). mktemp creates
  # it new (O_EXCL, so never through an existing path or symlink), mode 0600, with a unique name per session and
  # launch, in a 0700 dir only this user can touch. It holds the key file's PATH for a security line, never key
  # material. The export/unset order is the line's own: the env file is sourced, then the verdict key, the config
  # dir and ENGSYS_MM_CONFIG are decided after it. Its last step before the harness removes it, so its absence
  # tells the start check that the shell got that far.
  prepare_launch_dir || return 1
  local launch_file line nbytes
  launch_file="$(umask 077 && mktemp "$LAUNCH_DIR/${name//[^A-Za-z0-9._-]/_}.$run.XXXXXX")" \
    || { echo "error: can't create a launch file for '$name' in $LAUNCH_DIR" >&2; return 1; }
  if [ -L "$launch_file" ] || [ ! -f "$launch_file" ] || [ ! -O "$launch_file" ]; then
    echo "error: launch file for '$name' is not a regular file owned by $(id -un): $launch_file" >&2; return 1
  fi
  printf '%s\n' "${cmd}command rm -f -- $(printf %q "$launch_file") && ${run_cmd}" >"$launch_file" \
    || { rm -f "$launch_file"; echo "error: can't write the launch file for '$name': $launch_file" >&2; return 1; }
  line=". $(printf %q "$launch_file")"
  nbytes="$(printf '%s' "$line" | LC_ALL=C wc -c | tr -d ' ')"
  if [ "$nbytes" -gt "$LAUNCH_LINE_MAX" ]; then
    rm -f "$launch_file"
    echo "error: the launch line for '$name' would be $nbytes bytes (limit $LAUNCH_LINE_MAX, MAX_CANON 1024): use a shorter --launch-dir" >&2
    return 1
  fi

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Trailing colon matters: `-t session` (no colon) is a WINDOW target — the
    # session's current window — and the second launch dies with "index 0 in
    # use". `-t session:` means "next free index in this session".
    tmux new-window -t "${TMUX_SESSION}:" -n "$name" || { rm -f "$launch_file"; echo "error: tmux new-window failed for '$name'" >&2; return 1; }
  else
    tmux new-session -d -s "$TMUX_SESSION" -n "$name" || { rm -f "$launch_file"; echo "error: tmux new-session failed for '$name'" >&2; return 1; }
  fi
  # The window keeps its name (engsys#236 review): the harness renames it with an escape sequence (ESC k … ESC \)
  # when allow-rename is on, and a renamed window is lost to every name-addressed call here and in the supervisor
  # (the start check reads "window closed", kill-window misses it, the live session is orphaned and the next tick
  # launches a duplicate). -n already turns automatic-rename off; it is set again explicitly.
  if ! tmux set-option -w -t "${TMUX_SESSION}:${name}" allow-rename off || ! tmux set-option -w -t "${TMUX_SESSION}:${name}" automatic-rename off; then
    rm -f "$launch_file"; tmux kill-window -t "${TMUX_SESSION}:${name}" 2>/dev/null || true
    echo "error: tmux set-option (allow-rename/automatic-rename off) failed for '$name'" >&2; return 1
  fi
  tmux send-keys -t "${TMUX_SESSION}:${name}" "$line" Enter || { rm -f "$launch_file"; echo "error: tmux send-keys failed for '$name'" >&2; return 1; }
  # Sent is not started (engsys#236): a launch that never starts closes its window, so nothing half-started is left
  # for a later tick to mistake for an exited session, and its launch file can't run late.
  if [ "$LAUNCH_START_TIMEOUT_SEC" -gt 0 ] && ! wait_started "$name" "$launch_file"; then
    rm -f "$launch_file"
    tmux kill-window -t "${TMUX_SESSION}:${name}" 2>/dev/null || true
    return 1
  fi
  echo "launched: $name  ($workdir)"
}

launched=0 failed=0
for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r name workdir prompt extra env_file <<<"$spec"
  [ -z "$name" ] && continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then
    continue
  fi
  # A refused or broken line is skipped loudly; the rest of the roster still launches.
  if launch_one "$name" "$workdir" "$prompt" "$extra" "$env_file"; then
    launched=$((launched + 1))
  else
    failed=$((failed + 1))
    echo "SKIPPED: $name (see the error above)" >&2
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "error: $failed roster session(s) not launched; $launched launched" >&2
  exit 1
fi
if [ "$launched" -eq 0 ]; then
  if [ -n "$ONLY" ]; then
    echo "no session named '$ONLY' in the roster" >&2
    exit 1
  fi
  echo "no sessions launched (empty roster)" >&2
  exit 1
fi

echo
echo "done. attach with:  tmux attach -t ${TMUX_SESSION}"
echo "cross-session messaging is name-addressed under the '${NAMESPACE}-' namespace."
