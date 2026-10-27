# shellcheck shell=bash
# Harness adapter: Google Antigravity CLI, agy (engsys#287). Sourced by launch-agent-sessions.sh after
# lib/session-env.sh; the interface is described in SKILL.md § Harness adapters.

harness_bin() { printf 'agy'; }

# Interactive sessions only: no monster, broker, supervised or security-tier line, and no trust key or merge
# config. Its lines get the fleet's Claude config dir like any other line (claude_config_dir), as they always have.
# remote_control: per-session --remote-control naming (#283) and the opt-in host daemon (harness_prelaunch).
harness_capabilities() { printf 'claude_config_dir remote_control inbox_hook'; }

# Claude-style roster flags → shell-escaped agy flags. When a 2nd argument (<session-name>) is supplied and
# --remote-control (or AGY_REMOTE_CONTROL=1) is active, appends `--remote-control-name <session-name>` unless
# `--remote-control-name` was already passed explicitly (#283). Fails on the security model rather than map it.
harness_translate_flags() { # harness_translate_flags <claude-style flags> <session name>
  local raw="$1" session_name="${2:-}" out=() tok q=() has_rc=0 has_rc_name=0
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
        out+=(--remote-control); has_rc=1 ;;
      --remote-control-name)
        has_rc_name=1
        if [ $# -gt 0 ]; then out+=(--remote-control-name "$1"); shift; fi ;;
      --remote-control-name=*)
        has_rc_name=1
        out+=("$tok") ;;
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
      # ~ is spliced as a literal prefix, never by pattern substitution (an & in HOME, bash 5.2+)
      --*=~ | --*=~/*)
        out+=("${tok%%=\~*}=$HOME${tok#*=\~}") ;;
      \~ | \~/*)
        out+=("$HOME${tok#\~}") ;;
      *)
        out+=("$tok") ;;
    esac
  done
  if [ "${AGY_REMOTE_CONTROL:-0}" = 1 ] && [ "$has_rc" = 0 ]; then
    out+=(--remote-control); has_rc=1
  fi
  if [ "$has_rc" = 1 ] && [ "$has_rc_name" = 0 ] && [ -n "$session_name" ]; then
    out+=(--remote-control-name "$session_name")
  fi
  if [ "${#out[@]}" -gt 0 ]; then
    local item
    for item in "${out[@]}"; do
      q+=("$(printf '%q' "$item")")
    done
    printf '%s' "${q[*]}"
  fi
}

# No positional workdir (#279): the launch line has already cd'd there.
harness_run_cmd() { # harness_run_cmd <name> <prompt> <translated flags>
  local cmdline="agy"
  [ -z "$2" ] || cmdline+=" -i $(printf %q "$2")"
  [ -z "$3" ] || cmdline+=" $3"
  printf '%s' "$cmdline"
}

# Per-session `--remote-control --remote-control-name <name>` is self-contained per tmux TUI process (#283). The
# standalone host background daemon (`agy remote-control start`, which serves saved
# `~/.gemini/antigravity-cli/conversations/*.pb` files from disk in a separate headless process) is strictly opt-in
# via AGY_REMOTE_CONTROL_AUTOSTART=1 and defaults to off (0) so it does not compete with or cold-load `.pb` files
# away from live tmux sessions. Reads the launcher's SESSIONS and NAMESPACE.
harness_prelaunch() {
  [ "${AGY_REMOTE_CONTROL_AUTOSTART:-0}" = 1 ] || return 0
  local agy_needs_rc=0 spec agy_rc_name
  if [ "${AGY_REMOTE_CONTROL:-0}" = 1 ]; then
    agy_needs_rc=1
  else
    for spec in "${SESSIONS[@]}"; do
      case "$spec" in *--remote-control*) agy_needs_rc=1; break ;; esac
    done
  fi
  [ "$agy_needs_rc" = 1 ] || return 0
  if ! agy remote-control status 2>/dev/null | grep -Eqi 'Daemon status:[[:space:]]*(running|active)'; then
    agy_rc_name="${FLEET_ID:-$NAMESPACE}-$(hostname -s 2>/dev/null || echo host)"
    if agy remote-control start --name "$agy_rc_name" >/dev/null 2>&1; then
      echo "started Antigravity remote-control daemon: $agy_rc_name"
    else
      echo "warning: agy remote-control start failed (sessions start anyway)" >&2
    fi
  fi
  return 0
}
