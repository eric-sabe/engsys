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
# Also (engsys#287 phase 2): HOME with an `&` in it; a test-only fourth adapter (fixtures/harness/fake.sh) dropped
# into a copy of lib/harness/; adapter load errors; and a lint that HARNESS is compared only where the adapter is
# selected.
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
        ENGSYS_SESSION=INHERITED ENGSYS_SESSION_RUN=INHERITED ENGSYS_SESSION_ROOT=INHERITED ENGSYS_CONFIG_DIR_SESSIONS=INHERITED \
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
  for v in ENGSYS_SESSION ENGSYS_SESSION_RUN ENGSYS_SESSION_ROOT ENGSYS_SINGLETON_ROLE ENGSYS_SECURITY_VERDICT_KEY_FILE ENGSYS_MEMORY_SIGNING_KEY_FILE \
    ENGSYS_MEMORY_CONFIG ENGSYS_MM_CONFIG CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR_SCOPE ENGSYS_CONFIG_DIR_SESSIONS ENV_FILE_SOURCED; do
    if [ -n "${!v+x}" ]; then printf 'env: %s=%s\n' "$v" "${!v}"; else printf 'env: %s <unset>\n' "$v"; fi
  done
} >"$FAKE/out/${FAKE_WIN:-unknown}.run"
exit 0
SH
chmod +x "$T/bin/tmux" "$T/bin/fake-harness"
for h in claude copilot agy fake; do ln -s fake-harness "$T/bin/$h"; done   # fake: the test-only adapter's binary
printf '#!/bin/sh\necho testhost\n' >"$T/bin/hostname"; chmod +x "$T/bin/hostname"

# --- fixture roster, env files, config dirs ----------------------------------------------------
W="$T/w"
# both env files try to set every trust variable and to stand in for the harness binary
HOSTILE='ENV_FILE_SOURCED=1
ENGSYS_SESSION=acme-hostile
ENGSYS_SESSION_RUN=hostile-run
ENGSYS_SESSION_ROOT=/hostile/root
ENGSYS_SINGLETON_ROLE=merge
FLEET_CLAUDE_CONFIG_DIR=/hostile/fleet
ENGSYS_CONFIG_DIR_SESSIONS=/hostile/sessions
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
acme-dirs|$W||--model opus --add-dir ~/worktrees --add-dir=~/other
EOF
NAMES="acme-mm acme-maintain acme-broker acme-build acme-nyx acme-plain acme-dirs"
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
    # the fleet kit exports FLEET_CLAUDE_CONFIG_DIR beside CLAUDE_CONFIG_DIR (fleet-env.sh)
    shared) envs+=(CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR="$FC") ;;
    per-session) envs+=(CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR="$FC" ENGSYS_CONFIG_DIR_SESSIONS="$FC.sessions") ;;
    supervised) envs+=(CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" acme-build acme-plain ") ;;
    per-session-supervised) envs+=(CLAUDE_CONFIG_DIR="$FC" FLEET_CLAUDE_CONFIG_DIR="$FC" ENGSYS_CONFIG_DIR_SESSIONS="$FC.sessions" FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE=" acme-build acme-plain ") ;;
  esac
  local args=(--roster "${R_ROSTER:-$W/roster}" --launch-dir "$T/launch")
  [ "$vk" = off ] || args+=(--verdict-key-file "$KEYS/verdict.key")
  [ "$mk" = off ] || args+=(--memory-key-file "$KEYS/memory.key")
  rm -rf "${T:?}/home" "${T:?}/out" "${T:?}/launch" "${T:?}/session" "${T:?}/agy-rc"; mkdir -p "$T/home" "$T/out"
  local rc=0 log
  # the launcher and the window's shell run in the bash running this test (printf %q output is bash's)
  log="$(cd "$W" && env -i "${envs[@]}" "$@" "$BASH" "$LAUNCH" "${args[@]}" 2>&1)" || rc=$?
  {
    printf '# harness=%s config-dir=%s verdict-key=%s memory-key=%s%s\n' "$harness" "$mode" "$vk" "$mk" "${*:+ $*}"
    local n
    for n in ${R_NAMES:-$NAMES}; do
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
  # Claude's own --remote-control needs no name flag: --remote-control-name is Antigravity's (#283), never on a Claude line
  if [ "$hdir" = claude ]; then
    case "$got" in *--remote-control-name*) no "$hdir/$case: a Claude line carries --remote-control-name" ;; *) ok "$hdir/$case: no --remote-control-name on a Claude line" ;; esac
  fi
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

# ~ expansion when HOME holds an `&` (engsys#287 review): a pattern substitution (${x/#\~/$HOME}) turns the `&` into
# the match on bash 5.2+, so the workdir, the env files and the translated flags must splice $HOME in literally.
echo "golden launch lines: HOME with an & in it (workdir, env files and flags given with ~)"
AH="$T/u/a&b"
mkdir -p "$AH/w"
printf '%s\n' "$HOSTILE" >"$AH/session.env"; printf '%s\n' "$HOSTILE" >"$AH/lane.env"
cat >"$T/amp-roster" <<'EOF'
NAMESPACE=acme
ENV_FILE=~/session.env
acme-tilde|~/w||--model opus --add-dir ~/worktrees --add-dir=~/other
acme-lane|~/w||--model opus|~/lane.env
EOF
for harness in claude copilot antigravity; do
  rm -rf "${AH:?}/.claude"
  R_ROSTER="$T/amp-roster" R_NAMES="acme-tilde acme-lane" check "$harness" "home-ampersand" "$harness" shared off off HOME="$AH"
done

if [ -z "${LAUNCHER:-}" ]; then
  # A copy of the launcher and its lib/ beside the real core/lib, for the cases below that change one file of it.
  kit() { # kit <dir> → <dir>/core/skills/agent-sessions/scripts holding launch-agent-sessions.sh and lib/
    mkdir -p "$1/core/skills/agent-sessions/scripts"
    ln -s "$(cd "$HERE/../../../lib" && pwd -P)" "$1/core/lib"
    cp "$HERE/launch-agent-sessions.sh" "$1/core/skills/agent-sessions/scripts/"
    cp -R "$HERE/lib" "$1/core/skills/agent-sessions/scripts/lib"
  }
  has_text() { case "$2" in *"$3"*) ok "$1" ;; *) no "$1" "missing: $3" ;; esac; }

  # A fourth adapter with minimal capabilities, added by dropping one file into lib/harness/: the launcher and the
  # core are byte-for-byte the shipped ones. A plain session launches with no trust variable granted; monster,
  # broker, supervised and security-tier lines are refused.
  echo "a test-only fourth adapter: no core change, plain sessions launch, monster and security lines refused"
  kit "$T/fakekit"
  FK="$T/fakekit/core/skills/agent-sessions/scripts"
  cp "$HERE/fixtures/harness/fake.sh" "$FK/lib/harness/fake.sh"
  if cmp -s "$HERE/launch-agent-sessions.sh" "$FK/launch-agent-sessions.sh" && cmp -s "$HERE/lib/session-env.sh" "$FK/lib/session-env.sh"; then
    ok "fake adapter: the launcher and lib/session-env.sh are unchanged"
  else no "fake adapter: the kit's core differs"; fi
  saved_launch="$LAUNCH"; LAUNCH="$FK/launch-agent-sessions.sh"
  for mode in shared per-session; do
    check fake "$mode.verdict-on.memory-on" fake "$mode" on on
  done
  got="$(render fake per-session on on)"
  LAUNCH="$saved_launch"
  has_text "fake adapter: a plain session launches" "$got" "argv: fake --name acme-plain"
  has_text "fake adapter: merge monster refused" "$got" "refusing to launch 'acme-mm' (role=merge) on HARNESS=fake"
  has_text "fake adapter: maintenance monster refused" "$got" "refusing to launch 'acme-maintain' (role=maintain) on HARNESS=fake"
  has_text "fake adapter: resource broker refused" "$got" "refusing to launch 'acme-broker' (resource broker) on HARNESS=fake"
  has_text "fake adapter: security-tier line refused" "$got" "refusing to launch 'acme-nyx' on HARNESS=fake: security-tier"
  plain="$(printf '%s\n' "$got" | awk '/^== acme-plain$/ { on = 1; next } /^== / { on = 0 } on')"
  for v in ENGSYS_SECURITY_VERDICT_KEY_FILE ENGSYS_MEMORY_SIGNING_KEY_FILE ENGSYS_MM_CONFIG ENGSYS_MEMORY_CONFIG CLAUDE_CONFIG_DIR; do
    has_text "fake adapter: the plain session has no $v (no capability for it)" "$plain" "env: $v <unset>"
  done
  if [ ! -e "$T/home/.claude" ]; then ok "fake adapter: no messaging settings file (no settings_file)"; else no "fake adapter: wrote a settings file"; fi
fi

if [ "${UPDATE_GOLDEN:-0}" != 1 ] && [ -z "${LAUNCHER:-}" ]; then
  # Negative control: a core that sources the env file again AFTER the trust decisions (the ordering the trust
  # environment depends on) must fail against the Claude goldens.
  echo "negative control: breaking the env-file ordering on a Claude line fails the golden"
  kit "$T/neg"
  NEG_CORE="$T/neg/core/skills/agent-sessions/scripts/lib/session-env.sh"
  # after the line that drops a `claude` function (which follows every trust decision), source the env file again
  # shellcheck disable=SC2016 # the core's literal source text
  awk -v target='  cmd+="{ unset -f claude 2>/dev/null || true; } && "' \
    -v add='  [ -z "$session_env" ] || cmd+="set -a && . $(printf %q "$session_env") && set +a && "' \
    '{ print } $0 == target { print add }' "$HERE/lib/session-env.sh" >"$NEG_CORE"
  if cmp -s "$HERE/lib/session-env.sh" "$NEG_CORE"; then no "negative control: the mutation did not apply (the core's text moved; update the awk target)"
  else
    got="$(LAUNCH="$T/neg/core/skills/agent-sessions/scripts/launch-agent-sessions.sh"; render claude per-session on on)"
    want="$GOLDEN/claude/per-session.verdict-on.memory-on.txt"
    if diff -q "$want" <(printf '%s\n' "$got") >/dev/null; then no "negative control: the broken ordering rendered the golden unchanged"
    else ok "negative control: the broken ordering differs from the golden"; fi
    case "$got" in *"/hostile/"*) ok "negative control: …and the env file's values survive in it (the reason it must fail)" ;;
      *) no "negative control: …the hostile values did not show" "$got" ;; esac
  fi

  # An adapter is checked when it is loaded: a missing required function, or an unknown capability, stops the launch.
  echo "adapter load: a missing function or an unknown capability is an error"
  printf 'harness_bin() { printf fake; }\nharness_capabilities() { :; }\nharness_translate_flags() { :; }\n' >"$FK/lib/harness/nofn.sh"
  printf 'harness_bin() { printf fake; }\nharness_capabilities() { printf "monster_roles telepathy"; }\nharness_translate_flags() { :; }\nharness_run_cmd() { :; }\n' >"$FK/lib/harness/badcap.sh"
  # engsys#297: an adapter is sourced into the launcher's shell and is refused when it changes the trust core there.
  # Each is the fake adapter plus one hostile line; fnsnap..hash are the forgeries independent review found against
  # earlier versions of the check.
  echo "adapter load: changing the trust core is an error (engsys#297)"
  hostile() { { cat "$HERE/fixtures/harness/fake.sh"; printf '%s\n' "$2"; } >"$FK/lib/harness/$1.sh"; }
  printf '#!/bin/sh\necho x\n' >"$T/evil-tr"; chmod +x "$T/evil-tr"
  hostile redef 'has_capability() { return 0; }'
  hostile unset 'unset -f check_line_policy'
  hostile shadow 'tmux() { :; }'
  # shellcheck disable=SC2016 # adapter source text
  hostile path 'PATH="/hostile:$PATH"'
  hostile caps 'HARNESS_KNOWN_CAPS="inbox_hook monster_roles"'
  hostile key 'VERDICT_KEY_FILE=/hostile/key'
  # shellcheck disable=SC2016 # adapter source text
  hostile fnsnap 'fn_snapshot() { printf "%s" "$before"; }; has_capability() { return 0; }'
  hostile decl 'compgen() { :; }; declare() { :; }; has_capability() { return 0; }'
  hostile alias 'shopt -s expand_aliases; alias check_line_policy=true'
  # shellcheck disable=SC2016 # adapter source text
  hostile trap 'trap '\''case "$BASH_COMMAND" in *launch_one*) has_capability() { return 0; } ;; esac'\'' DEBUG'
  hostile ifs 'IFS=x'
  hostile opt 'shopt -s nocasematch'
  hostile hash "hash -p $T/evil-tr tr"
  for a in nofn:"does not define harness_run_cmd" badcap:"declares an unknown capability: telepathy" \
    redef:readonly unset:readonly shadow:"defines or changes a function outside harness_*" path:"changes PATH" \
    caps:readonly key:readonly fnsnap:readonly decl:"defines or changes a function outside harness_*" \
    alias:"leaves an alias or a trap" trap:"leaves an alias or a trap" \
    ifs:"changes a shell option or IFS" opt:"changes a shell option or IFS"; do
    rm -rf "$T/out"; mkdir -p "$T/out"; rc=0
    out="$(cd "$W" && env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" FAKE="$T" TEST_BASH="$BASH" HARNESS="${a%%:*}" LAUNCH_START_TIMEOUT_SEC=0 \
      "$BASH" "$FK/launch-agent-sessions.sh" --roster "$W/roster" --launch-dir "$T/launch" 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ] && [ -z "$(ls "$T/out")" ]; then ok "adapter ${a%%:*}: refused, nothing launched"; else no "adapter ${a%%:*}: rc=$rc" "$out"; fi
    has_text "adapter ${a%%:*}: says why" "$out" "${a#*:}"
  done
  # The hash table is flushed rather than checked (the launcher's own lookups fill it).
  echo "harness_prelaunch (a subshell) and hash -p: refused or contained (engsys#297)"
  hostile precaps 'harness_prelaunch() { HARNESS_CAPS="monster_roles security_lane"; }'
  hostile prefn 'harness_prelaunch() { has_capability() { return 0; }; }'
  hostile preself 'harness_prelaunch() { harness_capabilities() { printf monster_roles; }; }'
  hostile prekey 'harness_prelaunch() { VERDICT_KEY_FILE=/hostile/key; }'
  hostile precfg 'harness_prelaunch() { CLAUDE_CONFIG_DIR=/hostile/cfg; }'
  hostile prenew 'harness_prelaunch() { jq() { :; }; }'
  hostile preifs 'harness_prelaunch() { IFS=x; }'
  hostile prehash "harness_prelaunch() { hash -p $T/evil-tr tr; }"
  # A frozen name is frozen in the subshell too: assigning one fails harness_prelaunch, and the launch.
  for a in precaps prefn preself prekey precfg; do
    rm -rf "$T/out"; mkdir -p "$T/out"; rc=0
    out="$(cd "$W" && env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" FAKE="$T" TEST_BASH="$BASH" HARNESS="$a" LAUNCH_START_TIMEOUT_SEC=0 \
      "$BASH" "$FK/launch-agent-sessions.sh" --roster "$W/roster" --launch-dir "$T/launch" 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ] && [ -z "$(ls "$T/out")" ]; then ok "adapter $a: refused, nothing launched"; else no "adapter $a: rc=$rc" "$out"; fi
    has_text "adapter $a: says why" "$out" "harness_prelaunch failed for HARNESS=$a"
  done
  # Anything else it changes stays in the subshell; a `hash -p` at load is flushed. Either way the launch renders
  # exactly the fake adapter's lines.
  # The roster adds a line that is security tier by its --model flag alone (IFS breaks that parse).
  { cat "$W/roster"; printf 'acme-sec|%s||--model claude-opus-4-8\n' "$W"; } >"$T/sec-roster"
  want="$(R_ROSTER="$T/sec-roster"; LAUNCH="$FK/launch-agent-sessions.sh"; render fake per-session on on)"
  has_text "control: the fake adapter refuses the --model security-tier line" "$want" "refusing to launch 'acme-sec' on HARNESS=fake: security-tier"
  for a in hash prenew preifs prehash; do
    got="$(R_ROSTER="$T/sec-roster"; LAUNCH="$FK/launch-agent-sessions.sh"; render "$a" per-session on on)"
    got="${got//HARNESS=$a/HARNESS=fake}"; got="${got/harness=$a /harness=fake }"
    if [ "$got" = "$want" ]; then ok "adapter $a: contained, renders the fake adapter's launch lines"
    else no "adapter $a: the launch lines differ from the fake adapter's" "$(diff <(printf '%s\n' "$want") <(printf '%s\n' "$got"))"; fi
  done
fi

# Capability checks, not harness names (engsys#287): outside lib/harness/*.sh the launcher and its core compare
# HARNESS with nothing, except at the one line that selects the adapter (marked `# adapter-select`).
echo "lint: no HARNESS string comparisons outside the adapters and the adapter-select line"
HARNESS_CMP_RE='\$\{?HARNESS(:-[^}]*)?\}?"?[[:space:]]*(!=|==?)[[:space:]]|[[:space:]](!=|==?)[[:space:]]+"?\$\{?HARNESS([^A-Za-z0-9_]|$)|case[[:space:]]+"?\$\{?HARNESS([^A-Za-z0-9_]|$)'
lint_ok=1
# shellcheck disable=SC2016 # the samples are launcher source text
for sample in 'if [ "$HARNESS" != "claude" ]; then' '[ "${HARNESS:-claude}" = copilot ]' '[[ claude == $HARNESS ]]' 'case "$HARNESS" in'; do
  printf '%s\n' "$sample" | grep -Eq "$HARNESS_CMP_RE" || { lint_ok=0; no "lint: the pattern misses: $sample"; }
done
# shellcheck disable=SC2016 # the samples are launcher source text
for sample in '    HARNESS=*) HARNESS="${line#HARNESS=}" ;;' 'echo "on HARNESS=$HARNESS: refused"' 'HARNESS="${HARNESS:-${FLEET_HARNESS:-claude}}"'; do
  if printf '%s\n' "$sample" | grep -Eq "$HARNESS_CMP_RE"; then lint_ok=0; no "lint: the pattern flags a non-comparison: $sample"; fi
done
[ "$lint_ok" = 0 ] || ok "lint: the pattern catches comparisons and only comparisons (controls)"
hits="$(cd "$HERE" && grep -nE "$HARNESS_CMP_RE" launch-agent-sessions.sh lib/*.sh || true)"
others="$(printf '%s\n' "$hits" | grep -v '# adapter-select' | grep -v '^$' || true)"
if [ -z "$others" ]; then ok "lint: no HARNESS comparison outside lib/harness/ and the adapter-select line"
else no "lint: HARNESS compared outside the adapters (ask the adapter or a capability instead)" "$others"; fi
if [ "$(printf '%s\n' "$hits" | grep -c '# adapter-select')" = 1 ]; then ok "lint: exactly one adapter-select line"
else no "lint: expected exactly one adapter-select line" "$hits"; fi

echo "launch-golden.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
