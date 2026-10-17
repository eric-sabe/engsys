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
#   launch-agent-sessions.sh [--roster FILE] [session-name]
#     no args          start every session in the roster
#     session-name     start just that one
#
# PREREQS
#   * tmux; claude >= 2.1.232; run as the machine's normal login user
#     (messaging sockets are per-user)
#
# Attach afterwards:  tmux attach -t <TMUX_SESSION>   (detach: Ctrl-b d)
set -euo pipefail

ROSTER=".claude/agent-sessions.roster"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --roster) ROSTER="$2"; shift 2 ;;
    -h | --help) sed -n '2,53p' "$0"; exit 0 ;;
    *) ONLY="$1"; shift ;;
  esac
done

REPO="$(pwd)"
ROSTER_DIR="$(cd "$(dirname "$ROSTER")" 2>/dev/null && pwd)" || ROSTER_DIR="$REPO"
[ -f "$ROSTER" ] || { echo "error: roster not found: $ROSTER (see the agent-sessions skill's roster.example)" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "error: tmux not found on PATH" >&2; exit 1; }
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

# A security-tier roster line: its model is Claude Opus 4.8 (any spelling, or the `security` alias), or
# it runs in the security lane's env file (security.env). Prints "yes" or "no".
is_security_line() {
  local flags="$1" env_file="$2" tok prev=""
  case "${env_file##*/}" in security.env) echo yes; return ;; esac
  set -f
  # shellcheck disable=SC2086
  set -- $flags
  set +f
  for tok in "$@"; do
    if [ "$prev" = "--model" ]; then
      case "$tok" in claude-opus-4-8 | claude-opus-4.8 | security) echo yes; return ;; esac
    fi
    case "$tok" in --model=claude-opus-4-8 | --model=claude-opus-4.8 | --model=security) echo yes; return ;; esac
    prev="$tok"
  done
  echo no
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

  local cmd run role=""
  # The session's own name and a per-launch id, for the monsters' baton (engsys#62): the holder is
  # <fleet>:<ENGSYS_SESSION>, and a fencing token on disk is honored only by the launch that took it.
  # A merge or maintenance monster (by its prompt, as lib/host-roles.sh reads it) also gets
  # ENGSYS_SINGLETON_ROLE, which arms the plugin's singleton-write guard hook for the session and
  # every agent it dispatches; any other session has it unset.
  run="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  case "$prompt" in
    *merge-monster*) role=merge ;;
    *maintenance-monster*) role=maintain ;;
  esac
  # The monsters and the security lane are Claude-only: the merge and maintain batons and security work
  # stay on Claude (security on Claude Opus 4.8), so a non-Claude harness never launches them.
  if [ "$HARNESS" != "claude" ]; then
    if [ -n "$role" ]; then
      echo "error: refusing to launch '$name' (role=$role) on HARNESS=$HARNESS: merge and maintenance monsters run only on HARNESS=claude" >&2
      return 1
    fi
    if [ "$(is_security_line "${MODEL:+$MODEL }${extra:-}" "${session_env:-}")" = yes ]; then
      echo "error: refusing to launch '$name' on HARNESS=$HARNESS: security-tier sessions run only on HARNESS=claude with claude-opus-4-8" >&2
      return 1
    fi
  fi
  # ENGSYS_SESSION_ROOT is the directory the session was launched in: a guarded `fleet msg send`
  # takes its --body-file only from <root>/tmp, wherever the session cd's later (engsys#108).
  local root
  root="$(cd "$workdir" && pwd -P)" || { echo "error: cannot resolve workdir for '$name': $workdir" >&2; return 1; }
  cmd="export ENGSYS_SESSION=$(printf %q "$name") ENGSYS_SESSION_RUN=$(printf %q "$run") ENGSYS_SESSION_ROOT=$(printf %q "$root")"
  if [ -n "$role" ]; then cmd+=" ENGSYS_SINGLETON_ROLE=$role && "; else cmd+=" && unset ENGSYS_SINGLETON_ROLE && "; fi
  cmd+="cd $(printf %q "$workdir") && "
  if [ -n "$session_env" ]; then
    cmd+="set -a && . $(printf %q "$session_env") && set +a && "
  fi
  if [ "$HARNESS" = "copilot" ]; then
    cmd+="copilot --name $(printf %q "$name")"
    [ -n "$prompt" ] && cmd+=" -i $(printf %q "$prompt")"
    local copilot_flags
    copilot_flags="$(translate_copilot_flags "${MODEL:+$MODEL }${extra:-}")"
    [ -n "$copilot_flags" ] && cmd+=" $copilot_flags"
  elif [ "$HARNESS" = "antigravity" ]; then
    cmd+="agy $(printf %q "$workdir")"
    [ -n "$prompt" ] && cmd+=" -i $(printf %q "$prompt")"
    local agy_flags
    agy_flags="$(translate_antigravity_flags "${MODEL:+$MODEL }${extra:-}")"
    [ -n "$agy_flags" ] && cmd+=" $agy_flags"
  else
    cmd+="claude --name $(printf %q "$name") --settings $(printf %q "$SETTINGS_FILE")"
    # The prompt goes BEFORE the model/extra flags: several claude flags take a
    # list (--add-dir, --allowedTools, …) and would swallow a trailing prompt as
    # one more value — the session would start with no instruction.
    [ -n "$prompt" ] && cmd+=" $(printf %q "$prompt")"
    [ -n "$MODEL" ] && cmd+=" $MODEL"
    [ -n "$extra" ] && cmd+=" $extra"
  fi

  # A duplicate logical name ANYWHERE the same user runs claude makes Claude
  # Code suffix this one (name-2), which breaks name addressing. Reject a name
  # already present in any window on the whole tmux server. Sessions launched
  # OUTSIDE tmux can't be seen here — `claude` + ListAgents to confirm free.
  if tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -Fxq -- "$name"; then
    echo "skip: a tmux window named '$name' already exists on this server" >&2
    return 0
  fi

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Trailing colon matters: `-t session` (no colon) is a WINDOW target — the
    # session's current window — and the second launch dies with "index 0 in
    # use". `-t session:` means "next free index in this session".
    tmux new-window -t "${TMUX_SESSION}:" -n "$name"
  else
    tmux new-session -d -s "$TMUX_SESSION" -n "$name"
  fi
  tmux send-keys -t "${TMUX_SESSION}:${name}" "$cmd" Enter
  echo "launched: $name  ($workdir)"
}

launched=0
for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r name workdir prompt extra env_file <<<"$spec"
  [ -z "$name" ] && continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then
    continue
  fi
  launch_one "$name" "$workdir" "$prompt" "$extra" "$env_file"
  launched=$((launched + 1))
done

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
