# shellcheck shell=bash
# Harness adapter: GitHub Copilot CLI (engsys#287). Sourced by launch-agent-sessions.sh after lib/session-env.sh;
# the interface is described in SKILL.md § Harness adapters.

harness_bin() { printf 'copilot'; }

# Interactive sessions only: no monster, broker, supervised or security-tier line, and no trust key or merge
# config. Its lines get the fleet's Claude config dir like any other line (claude_config_dir), as they always have.
harness_capabilities() { printf 'claude_config_dir inbox_hook'; }

# Claude-style roster flags → shell-escaped Copilot CLI flags.
harness_translate_flags() { # harness_translate_flags <claude-style flags> <session name>
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
      # ~ is spliced as a literal prefix, never by pattern substitution (an & in HOME, bash 5.2+)
      --*=~ | --*=~/*)
        out+=("${tok%%=\~*}=$HOME${tok#*=\~}") ;;
      \~ | \~/*)
        out+=("$HOME${tok#\~}") ;;
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

harness_run_cmd() { # harness_run_cmd <name> <prompt> <translated flags>
  local cmdline
  cmdline="copilot --name $(printf %q "$1")"
  [ -z "$2" ] || cmdline+=" -i $(printf %q "$2")"
  [ -z "$3" ] || cmdline+=" $3"
  printf '%s' "$cmdline"
}
