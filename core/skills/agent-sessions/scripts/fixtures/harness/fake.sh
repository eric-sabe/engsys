# shellcheck shell=bash
# Test-only harness adapter (engsys#287): the smallest adapter that satisfies the interface, with minimal
# capabilities. launch-golden.test.sh drops it into a copy of lib/harness/ beside an unchanged launcher and core,
# and checks that a plain session launches while monster, broker, supervised and security-tier lines are refused,
# and that no trust variable is granted. Never shipped in lib/harness/.

harness_bin() { printf 'fake'; }

harness_capabilities() { printf 'inbox_hook'; }

harness_translate_flags() { printf '%s' "$1"; }

harness_run_cmd() { # harness_run_cmd <name> <prompt> <translated flags>
  local cmdline
  cmdline="fake --name $(printf %q "$1")"
  [ -z "$2" ] || cmdline+=" --prompt $(printf %q "$2")"
  [ -z "$3" ] || cmdline+=" $3"
  printf '%s' "$cmdline"
}
