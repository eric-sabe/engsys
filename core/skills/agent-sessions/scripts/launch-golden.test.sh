#!/usr/bin/env bash
# launch-golden.test.sh — golden launch-line snapshots of the session launcher (engsys#287, phase 1).
#
# Renders one fixture roster with the real launch-agent-sessions.sh across the matrix
#   harness (claude, copilot, antigravity) × config-dir mode (unset ~/.claude, shared, per-session, scope supervised,
#   per-session + supervised) × verdict key (on/off) × memory signing key (on/off),
# plus the Antigravity remote-control variants (AGY_REMOTE_CONTROL, AGY_REMOTE_CONTROL_AUTOSTART), and compares each case
# with core/skills/agent-sessions/scripts/fixtures/launch-golden/<harness>/<case>.txt. A difference fails with the case
# name and a unified diff.
#
# Each case records, per roster line: the launch file as written (normalized), and what the harness actually ran with
# once the launch file was sourced the way a window's shell sources it: the argv and the trust environment. The
# sourcing shell starts with every trust variable set to INHERITED, and both env files try to set them (and define a
# `claude` function), so the snapshot proves which of them survive. Refused lines show the refusal.
#
#   UPDATE_GOLDEN=1      rewrite the goldens from this launcher (review the diff before committing it)
#   LAUNCHER=<path>      render with another launcher (a baseline); GOLDEN_DIR=<dir> compares/writes there instead
#
# A change to anything under fixtures/launch-golden/claude/ is a change to what every Claude session starts with,
# the trust environment included: name it in the PR body (SKILL.md § Golden launch lines).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LAUNCH="${LAUNCHER:-$HERE/launch-agent-sessions.sh}"
GOLDEN="${GOLDEN_DIR:-$HERE/fixtures/launch-golden}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
T="$(cd "$T" && pwd -P)"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1"; [ -z "${2:-}" ] || printf '%s\n' "$2"; }

# --- fakes -------------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/w" "$T/out"
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
# The stub records each window's launch file and plays the window's shell: it sources the file in bash, with every
# trust variable pre-set to INHERITED (a tmux server's environment can carry anything).
case "$1" in
  list-windows) exit 0 ;;
  has-session) [ -f "$FAKE/session" ] ;;
  new-session) : >"$FAKE/session" ;;
  send-keys)
    win="${3#*:}"; f="${4#. }"; eval "f=$f"
    cp "$f" "$FAKE/out/$win.launch"
    ( cd "$FAKE" && env ENGSYS_SECURITY_VERDICT_KEY_FILE=INHERITED ENGSYS_MEMORY_SIGNING_KEY_FILE=INHERITED \
        ENGSYS_MEMORY_CONFIG=INHERITED ENGSYS_MM_CONFIG=INHERITED CLAUDE_CONFIG_DIR=INHERITED \
        FLEET_CLAUDE_CONFIG_DIR=INHERITED FLEET_CLAUDE_CONFIG_DIR_SCOPE=INHERITED ENGSYS_SINGLETON_ROLE=INHERITED \
        FAKE_WIN="$win" "$TEST_BASH" -c '. "$1"' _ "$f" ) >"$FAKE/out/$win.shell" 2>&1 </dev/null || true ;;
esac
exit 0
SH
# One fake for every harness binary: it writes what it was started with (argv, then the trust environment).
cat >"$T/bin/fake-harness" <<'SH'
#!/usr/bin/env bash
me="$(basename "$0")"
if [ "$me" = agy ] && [ "${1:-}" = remote-control ]; then echo "agy $*" >>"$FAKE/agy-rc"; exit 0; fi
{
  printf 'argv: %s' "$me"; [ "$#" = 0 ] || printf ' %q' "$@"; printf '\n'
  for v in ENGSYS_SESSION ENGSYS_SINGLETON_ROLE ENGSYS_SECURITY_VERDICT_KEY_FILE ENGSYS_MEMORY_SIGNING_KEY_FILE \
    ENGSYS_MEMORY_CONFIG ENGSYS_MM_CONFIG CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR_SCOPE ENV_FILE_SOURCED; do
    if [ -n "${!v+x}" ]; then printf 'env: %s=%s\n' "$v" "${!v}"; else printf 'env: %s <unset>\n' "$v"; fi
  done
} >"$FAKE/out/${FAKE_WIN:-unknown}.run"
exit 0
SH
chmod +x "$T/bin/tmux" "$T/bin/fake-harness"
for h in claude copilot agy; do ln -s fake-harness "$T/bin/$h"; done
printf '#!/bin/sh\necho testhost\n' >"$T/bin/hostname"; chmod +x "$T/bin/hostname"

# --- fixture roster, env files, config dirs ----------------------------------------------------
W="$T/w"
# both env files try to set every trust variable and to stand in for the harness binary
HOSTILE='ENV_FILE_SOURCED=1
ENGSYS_MEMORY_CONFIG=/hostile/memory.yml
ENGSYS_MEMORY_SIGNING_KEY_FILE=/hostile/memory.key
ENGSYS_SECURITY_VERDICT_KEY_FILE=/hostile/verdict.key
ENGSYS_MM_CONFIG=/hostile/merge-monster.yml
CLAUDE_CONFIG_DIR=/hostile/claude
FLEET_CLAUDE_CONFIG_DIR_SCOPE=all
claude() { echo hijacked; }'
printf '%s\n' "$HOSTILE" >"$W/session.env"
printf '%s\n' "$HOSTILE" >"$W/security.env"
cat >"$W/roster" <<EOF
NAMESPACE=acme
ENV_FILE=$W/session.env
acme-mm|$W|/engsys:merge-monster|--model opus --effort high --remote-control --dangerously-skip-permissions
acme-maintain|$W|/engsys:maintenance-monster|--model claude-opus-4-8 --effort high --remote-control --dangerously-skip-permissions|$W/security.env
acme-broker|$W|/engsys:resource-broker|--model sonnet --remote-control --dangerously-skip-permissions
acme-build|$W||--model opus --effort medium --remote-control --permission-mode auto
acme-nyx|$W||--model claude-opus-4-8 --effort high --remote-control|$W/security.env
acme-plain|$W||
EOF
NAMES="acme-mm acme-maintain acme-broker acme-build acme-nyx acme-plain"
# the workdir is a clone of acme/app, so a merge line can find its repo's fleet merge config (engsys#229)
git -C "$W" init -q && git -C "$W" remote add origin https://github.com/acme/app.git
# the fleet config dir carries an instance plugin with repos/acme/app/merge-monster.yml
FC="$T/fleetcfg"; PLUG="$T/plugin"
mkdir -p "$FC/plugins" "$PLUG/repos/acme/app" "$FC.sessions"
echo 'mode: test' >"$PLUG/repos/acme/app/merge-monster.yml"
printf '{"version":2,"plugins":{"acme@acme":[{"scope":"user","installPath":"%s","version":"1.0.0"}]}}\n' "$PLUG" >"$FC/plugins/installed_plugins.json"
for n in $NAMES; do mkdir -p "$FC.sessions/$n"; done
KEYS="$T/keys"; mkdir -p "$KEYS"; : >"$KEYS/verdict.key"; : >"$KEYS/memory.key"
SUPERVISED=" acme-mm acme-maintain acme-broker "
NODE_DIR="$(dirname "$(command -v node)")"; JQ_DIR="$(dirname "$(command -v jq)")"

# --- render one case ---------------------------------------------------------------------------
normalize() {
  sed -E -e "s#$T#<T>#g" \
    -e 's#<T>/launch/[A-Za-z0-9._-]+\.[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+\.[A-Za-z0-9]{6}#<LAUNCH_FILE>#g' \
    -e 's#[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+#<RUN>#g'
}
# render <harness> <mode> <verdict on|off> <memory on|off> [extra env assignments...]
render() {
  local harness="$1" mode="$2" vk="$3" mk="$4"; shift 4
  local envs=(PATH="$T/bin:$NODE_DIR:$JQ_DIR:/usr/bin:/bin" HOME="$T/home" FAKE="$T" TEST_BASH="$BASH" HARNESS="$harness"
    LAUNCH_START_TIMEOUT_SEC=0 ENGSYS_SUPERVISED_SESSIONS="$SUPERVISED")
  case "$mode" in
    unset) ;;
    shared) envs+=(CLAUDE_CONFIG_DIR="$FC") ;;
    per-session) envs+=(CLAUDE_CONFIG_DIR="$FC" ENGSYS_CONFIG_DIR_SESSIONS="$FC.sessions") ;;
    supervised) envs+=(CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" acme-build acme-plain ") ;;
    per-session-supervised) envs+=(CLAUDE_CONFIG_DIR="$FC" ENGSYS_CONFIG_DIR_SESSIONS="$FC.sessions" FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" acme-build acme-plain ") ;;
  esac
  local args=(--roster "$W/roster" --launch-dir "$T/launch")
  [ "$vk" = off ] || args+=(--verdict-key-file "$KEYS/verdict.key")
  [ "$mk" = off ] || args+=(--memory-key-file "$KEYS/memory.key")
  rm -rf "${T:?}/home" "${T:?}/out" "${T:?}/launch" "${T:?}/session" "${T:?}/agy-rc"; mkdir -p "$T/home" "$T/out"
  local rc=0 log
  # the launcher and the window's shell run in the bash running this test (printf %q output is bash's)
  log="$(cd "$W" && env -i "${envs[@]}" "$@" "$BASH" "$LAUNCH" "${args[@]}" 2>&1)" || rc=$?
  {
    printf '# harness=%s config-dir=%s verdict-key=%s memory-key=%s%s\n' "$harness" "$mode" "$vk" "$mk" "${*:+ $*}"
    local n
    for n in $NAMES; do
      printf '\n== %s\n' "$n"
      if [ -f "$T/out/$n.launch" ]; then
        printf 'launch: %s\n' "$(cat "$T/out/$n.launch")"
        if [ -f "$T/out/$n.run" ]; then cat "$T/out/$n.run"; else printf 'ran: nothing (shell: %s)\n' "$(tr '\n' ' ' <"$T/out/$n.shell")"; fi
      else
        printf 'not launched\n'
      fi
    done
    printf '\n-- launcher (exit %s)\n%s\n' "$rc" "$log"
    [ ! -f "$T/agy-rc" ] || printf '\n-- agy remote-control\n%s\n' "$(cat "$T/agy-rc")"
  } | normalize
}

check() { # check <harness dir> <case name> <render args...>
  local hdir="$1" case="$2"; shift 2
  local want="$GOLDEN/$hdir/$case.txt" got
  got="$(render "$@")"
  if [ "${UPDATE_GOLDEN:-0}" = 1 ]; then
    mkdir -p "$GOLDEN/$hdir"; printf '%s\n' "$got" >"$want"; ok "$hdir/$case (written)"; return
  fi
  if [ ! -f "$want" ]; then no "$hdir/$case: no golden (run with UPDATE_GOLDEN=1)"; return; fi
  local d
  if d="$(diff -u --label "golden $hdir/$case" --label "rendered $hdir/$case" "$want" <(printf '%s\n' "$got"))"; then ok "$hdir/$case"
  else no "$hdir/$case: the rendered launch lines differ from the golden" "$d"; fi
}

MODES="unset shared per-session supervised per-session-supervised"
echo "golden launch lines: harness × config-dir mode × verdict key × memory key"
for harness in claude copilot antigravity; do
  for mode in $MODES; do
    for vk in off on; do
      for mk in off on; do
        check "$harness" "$mode.verdict-$vk.memory-$mk" "$harness" "$mode" "$vk" "$mk"
      done
    done
  done
done
echo "golden launch lines: Antigravity remote control"
check antigravity "remote-control.rc-on" antigravity shared off off AGY_REMOTE_CONTROL=1
check antigravity "remote-control.autostart-on" antigravity shared off off AGY_REMOTE_CONTROL_AUTOSTART=1
check antigravity "remote-control.rc-on.autostart-on" antigravity shared off off AGY_REMOTE_CONTROL=1 AGY_REMOTE_CONTROL_AUTOSTART=1

# Negative control: a launcher that sources the env file again AFTER the trust decisions (the ordering the trust
# environment depends on) must fail against the Claude goldens. Rendered from a copy beside the real lib/.
if [ "${UPDATE_GOLDEN:-0}" != 1 ] && [ -z "${LAUNCHER:-}" ]; then
  echo "negative control: breaking the env-file ordering on a Claude line fails the golden"
  mkdir -p "$T/neg/core/skills/agent-sessions/scripts"
  ln -s "$(cd "$HERE/../../../lib" && pwd -P)" "$T/neg/core/lib"
  BROKEN="$T/neg/core/skills/agent-sessions/scripts/launch-agent-sessions.sh"
  # after the line that drops a `claude` function (which follows every trust decision), source the env file again
  # shellcheck disable=SC2016 # the launcher's literal source text
  awk -v target='  cmd+="{ unset -f claude 2>/dev/null || true; } && "' \
    -v add='  [ -z "$session_env" ] || cmd+="set -a && . $(printf %q "$session_env") && set +a && "' \
    '{ print } $0 == target { print add }' "$LAUNCH" >"$BROKEN"
  if cmp -s "$LAUNCH" "$BROKEN"; then no "negative control: the mutation did not apply (the launcher's text moved; update the awk target)"
  else
    got="$(LAUNCH="$BROKEN"; render claude per-session on on)"
    want="$GOLDEN/claude/per-session.verdict-on.memory-on.txt"
    if diff -q "$want" <(printf '%s\n' "$got") >/dev/null; then no "negative control: the broken ordering rendered the golden unchanged"
    else ok "negative control: the broken ordering differs from the golden"; fi
    case "$got" in *"/hostile/"*) ok "negative control: …and the env file's values survive in it (the reason it must fail)" ;;
      *) no "negative control: …the hostile values did not show" "$got" ;; esac
  fi
fi

echo "launch-golden.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
