# shellcheck shell=bash
# Harness adapter: Claude Code (engsys#287). Sourced by launch-agent-sessions.sh after lib/session-env.sh; the
# interface is described in SKILL.md § Harness adapters.

harness_bin() { printf 'claude'; }

# Claude runs every fleet role: the monsters, the security lane (Claude Opus 4.8) and the trust keys, the merge
# config, the Claude config dir, and the messaging settings file. Its own --remote-control needs no adapter
# support, so remote_control (the Antigravity daemon and session naming) is not declared.
harness_capabilities() { printf 'monster_roles security_lane memory_signing mm_config claude_config_dir settings_file inbox_hook'; }

# The roster's flags are Claude's own: passed through verbatim (a ~ stays for the window's shell to expand).
harness_translate_flags() { printf '%s' "$1"; }

# The prompt goes BEFORE the model/extra flags: several claude flags take a list (--add-dir, --allowedTools, …)
# and would swallow a trailing prompt as one more value — the session would start with no instruction.
# `command claude`: a function named claude can't stand in for the binary.
harness_run_cmd() { # harness_run_cmd <name> <prompt> <translated flags>
  local cmdline
  cmdline="command claude --name $(printf %q "$1") --settings $(printf %q "$SETTINGS_FILE")"
  [ -z "$2" ] || cmdline+=" $(printf %q "$2")"
  [ -z "$3" ] || cmdline+=" $3"
  printf '%s' "$cmdline"
}
