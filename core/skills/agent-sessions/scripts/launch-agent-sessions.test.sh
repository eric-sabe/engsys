#!/usr/bin/env bash
# launch-agent-sessions.test.sh — harness policy and flag translation of the session launcher, with
# fake tmux/claude/copilot/agy binaries and a throwaway HOME (run by `npm test`).
#
# Covers: merge/maintain monsters and security-tier lines are refused on every non-Claude harness;
# Claude launches them (positive control); Copilot/Antigravity flag translation for the lines that
# may launch; the Antigravity remote-control daemon starts only on explicit opt-in.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LAUNCH="$HERE/launch-agent-sessions.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
T="$(cd "$T" && pwd -P)"   # physical: the launch dir and ENGSYS_MM_CONFIG are resolved paths
mkdir -p "$T/bin" "$T/w" "$T/home"
pass=0 fail=0

# --- fakes -------------------------------------------------------------------------------------
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
# send-keys -t <target> <line> Enter: the line is `. <launch file>` (engsys#236). The fake logs the line, then the
# file's content ("script: …"), and plays the shell: it removes the file (the line's own last step before the
# harness) and the pane runs claude. FAKE_NO_START = the shell never reads the line (the pane stays at zsh);
# FAKE_EXIT_AT_ONCE = the line runs but the harness exits at once (back at zsh).
case "$1" in
  list-windows) exit 0 ;;                       # no windows: every name is free
  has-session) exit 1 ;;                        # no session yet
  send-keys) [ -n "${TMUX_FAIL:-}" ] && exit 1
    echo "send-keys $2 $3 $4 $5" >>"$FAKE/actions"; printf '%s' "$4" >"$FAKE/typed"
    f="${4#. }"; eval "f=$f"; echo "$f" >"$FAKE/launch-file"
    if [ -f "$f" ]; then echo "script: $(cat "$f")" >>"$FAKE/actions"; ls -ln "$f" >"$FAKE/launch-file.ls"; cp "$f" "$FAKE/launch-file.copy"; fi
    if [ -n "${FAKE_NO_START:-}" ]; then echo zsh >"$FAKE/pane"
    elif [ -n "${FAKE_EXIT_AT_ONCE:-}" ]; then rm -f "$f"; echo zsh >"$FAKE/pane"
    else rm -f "$f"; echo claude >"$FAKE/pane"; fi ;;
  list-panes) cat "$FAKE/pane" 2>/dev/null || exit 1 ;;
  capture-pane) echo "zsh: command not found: --remote-contr" ;;
  kill-window) echo "kill-window $3" >>"$FAKE/actions"; rm -f "$FAKE/pane" ;;
esac
# engsys#197: no tmux call may see the verdict key path in its environment (the server would keep it)
if [ -n "${ENGSYS_SECURITY_VERDICT_KEY_FILE+x}" ]; then echo "tmux $1 saw the key path" >>"$FAKE/leak"; fi
exit 0
SH
for b in claude copilot; do printf '#!/usr/bin/env bash\nexit 0\n' >"$T/bin/$b"; done
cat >"$T/bin/agy" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = remote-control ] && echo "agy-rc $*" >>"$FAKE/actions"
exit 0
SH
chmod +x "$T/bin/"*
: >"$T/w/security.env"
: >"$T/w/ordinary.env"
export PATH="$T/bin:$PATH" FAKE="$T" HOME="$T/home" LAUNCH_START_TIMEOUT_SEC=2
unset HARNESS FLEET_HARNESS AGY_REMOTE_CONTROL AGY_REMOTE_CONTROL_AUTOSTART FLEET_ID ENGSYS_LAUNCH_DIR XDG_STATE_HOME 2>/dev/null || true

ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
# run <harness> <roster-body> [env...] — sets $rc, $err (stderr) and $acts (fake actions)
run() {
  local harness="$1" body="$2"; shift 2
  printf 'NAMESPACE=acme\n%s\n' "$body" >"$T/w/roster"
  : >"$T/actions"; rm -f "$T/pane" "$T/typed" "$T/launch-file" "$T/launch-file.ls" "$T/launch-file.copy"
  set +e
  # shellcheck disable=SC2086
  err="$(cd "$T/w" && env HARNESS="$harness" "$@" bash "$LAUNCH" --roster "$T/w/roster" ${LAUNCH_EXTRA:-} 2>&1 >/dev/null)"
  rc=$?
  set -e
  acts="$(cat "$T/actions")"
}
has() { case "$2" in *"$3"*) ok "$1" ;; *) no "$1" "missing: $3 | in: $2" ;; esac; }
lacks() { case "$2" in *"$3"*) no "$1" "unexpected: $3 | in: $2" ;; *) ok "$1" ;; esac; }
refused() { # refused <label> — non-zero exit, a refusal on stderr, and nothing sent to tmux
  if [ "$rc" -ne 0 ]; then ok "$1: exits non-zero"; else no "$1: exits non-zero" "rc=$rc"; fi
  has "$1: says it refuses" "$err" "refusing to launch"
  lacks "$1: launches nothing" "$acts" "send-keys"
}

W="$T/w"
MM="acme-mm|$W|/engsys:merge-monster|--model opus --effort high --remote-control --dangerously-skip-permissions"
MAINT="acme-maintain|$W|/engsys:maintenance-monster|--model claude-opus-4-8 --effort high --remote-control --dangerously-skip-permissions|$W/security.env"
SEC_MODEL="acme-sec|$W||--model claude-opus-4-8 --effort high"
SEC_DOTTED="acme-sec|$W||--model claude-opus-4.8"
SEC_ENV="acme-sec|$W||--model opus|$W/security.env"
BUILD="acme-build|$W||--model opus --effort medium --remote-control --permission-mode auto"

echo "claude harness (positive controls)"
run claude "$MM"
[ "$rc" -eq 0 ] && ok "claude: merge monster launches" || no "claude: merge monster launches" "$err"
has "claude: merge monster runs claude with its flags" "$acts" "claude --name acme-mm"
run claude "$MAINT"
has "claude: maintain launches on claude-opus-4-8" "$acts" "--model claude-opus-4-8"
run claude "$SEC_MODEL"
has "claude: security-tier line launches" "$acts" "claude --name acme-sec"

for h in copilot antigravity agy; do
  echo "$h harness: monsters and the security tier are refused"
  run "$h" "$MM";         refused "$h: merge monster"
  run "$h" "$MAINT";      refused "$h: maintenance monster"
  run "$h" "$SEC_MODEL";  refused "$h: --model claude-opus-4-8"
  run "$h" "$SEC_DOTTED"; refused "$h: --model claude-opus-4.8"
  run "$h" "$SEC_ENV";    refused "$h: security.env lane"
  printf 'NAMESPACE=acme\nENV_FILE=%s\n%s\n' "$W/security.env" "acme-sec|$W||--model opus" >"$T/w/roster"
  : >"$T/actions"; set +e
  err="$(cd "$T/w" && HARNESS="$h" bash "$LAUNCH" --roster "$T/w/roster" 2>&1 >/dev/null)"; rc=$?; set -e
  acts="$(cat "$T/actions")"; refused "$h: roster-level security.env"
  printf 'NAMESPACE=acme\nMODEL=--model claude-opus-4-8\n%s\n' "acme-sec|$W||" >"$T/w/roster"
  : >"$T/actions"; set +e
  err="$(cd "$T/w" && HARNESS="$h" bash "$LAUNCH" --roster "$T/w/roster" 2>&1 >/dev/null)"; rc=$?; set -e
  acts="$(cat "$T/actions")"; refused "$h: roster-level MODEL=claude-opus-4-8"
done

echo "security matching is normalized (case, [..] suffix, quotes, date stamp, --model=)"
for m in 'CLAUDE-OPUS-4-8' 'claude-opus-4-8[1m]' '"claude-opus-4.8"' 'claude-opus-4-8-20261001' 'Claude-Opus-4.8@20261001' 'security'; do
  run copilot "acme-sec|$W||--model $m"; refused "copilot: --model $m"
done
run copilot "acme-sec|$W||--model=claude-opus-4-8"; refused "copilot: --model=claude-opus-4-8"
for e in Security.env nyx.env NYX.ENV; do
  : >"$W/$e"; run copilot "acme-sec|$W||--model opus|$W/$e"; refused "copilot: env file $e is the security lane"
done
: >"$W/session.env"; run copilot "acme-x|$W||--model opus|$W/session.env"
[ "$rc" -eq 0 ] && ok "copilot: an ordinary env file is not the security lane (positive control)" || no "copilot: ordinary env file" "$err"

echo "role inference is case- and separator-insensitive"
for p in '/engsys:Merge-Monster' '/engsys:merge_monster' 'run the merge monster' '/engsys:MAINTENANCE_MONSTER'; do
  run copilot "acme-r|$W|$p|--model opus"; refused "copilot: prompt '$p'"
done

echo "host-classified monsters and supervised sessions are refused off Claude"
BROKER="acme-broker|$W|/engsys:resource-broker|--model opus"
run copilot "$BROKER" ENGSYS_SUPERVISED_SESSIONS="acme-mm acme-broker"; refused "copilot: supervised acme-broker"
run antigravity "$BROKER" ENGSYS_SUPERVISED_SESSIONS="acme-broker"; refused "antigravity: supervised acme-broker"
run copilot "$BROKER" ENGSYS_SUPERVISED_SESSIONS="acme-mm"; refused "copilot: a resource-broker prompt, even unclassified"
run copilot "acme-Broker2|$W|run the Resource_Broker|--model opus"; refused "copilot: broker prompt, any case/separator"
run copilot "acme-watch|$W|/custom-watch|--model opus" ENGSYS_SUPERVISED_SESSIONS="acme-mm"
[ "$rc" -eq 0 ] && ok "copilot: an unsupervised non-monster session launches (positive control)" || no "copilot: unsupervised" "$err"
run copilot "acme-watch|$W|/custom-watch|--model opus" ENGSYS_SUPERVISED_SESSIONS="acme-watch"; refused "copilot: a host-supervised custom session"
run claude "$BROKER" ENGSYS_SUPERVISED_SESSIONS="acme-broker"
[ "$rc" -eq 0 ] && ok "claude: supervised sessions launch on Claude (positive control)" || no "claude: supervised" "$err"

echo "Claude: the maintain and security.env lanes must run on claude-opus-4-8"
run claude "acme-maintain|$W|/engsys:maintenance-monster|--model opus --effort high|$W/security.env"; refused "claude: maintain on --model opus"
run claude "acme-maintain|$W|/engsys:maintenance-monster|--effort high"; refused "claude: maintain with no --model"
run claude "acme-sec|$W||--model claude-opus-5-5|$W/security.env"; refused "claude: security.env on claude-opus-5-5"
run claude "acme-sec|$W||--model security|$W/security.env"; refused "claude: security.env on the bare security alias"
run claude "acme-sec|$W||--model claude-opus-4-8 --model opus|$W/security.env"; refused "claude: a second --model overriding the security model"
run claude "acme-sec|$W||--model claude-opus-4-8|$W/security.env"
[ "$rc" -eq 0 ] && ok "claude: security.env on claude-opus-4-8 launches (positive control)" || no "claude: security.env on opus-4-8" "$err"

echo "a refused line is skipped; the rest of the roster still launches"
run copilot "$MM
$BUILD"
if [ "$rc" -ne 0 ]; then ok "roster: exits non-zero when a line is refused"; else no "roster: exits non-zero" "rc=$rc"; fi
has "roster: names the skipped line" "$err" "SKIPPED: acme-mm"
has "roster: the next line still launches" "$acts" "copilot --name acme-build"
lacks "roster: the refused line launches nothing" "$acts" "acme-mm"

echo "a failed tmux call is a failed launch, not a launched session"
run claude "$BUILD" TMUX_FAIL=1
if [ "$rc" -ne 0 ]; then ok "tmux failure: exits non-zero"; else no "tmux failure: exits non-zero" "rc=$rc"; fi
has "tmux failure: names the failed call" "$err" "tmux send-keys failed for 'acme-build'"
has "tmux failure: the line is reported skipped" "$err" "SKIPPED: acme-build"

echo "translate_antigravity_flags fails hard on the security model"
eval "$(sed -n -e '/^norm_model()/,/^}/p' -e '/^is_security_model()/,/^}/p' -e '/^translate_antigravity_flags()/,/^}/p' "$LAUNCH")"
for m in claude-opus-4-8 claude-opus-4.8 'CLAUDE-OPUS-4-8[1m]' security; do
  set +e; out="$(translate_antigravity_flags "--model $m" 2>/dev/null)"; trc=$?; set -e
  if [ "$trc" -ne 0 ] && [ -z "$out" ]; then ok "agy translate: --model $m fails, nothing mapped"; else no "agy translate: --model $m" "rc=$trc out=$out"; fi
done
set +e; out="$(translate_antigravity_flags "--model opus" 2>/dev/null)"; trc=$?; set -e
[ "$trc" -eq 0 ] && [ "$out" = "--model gemini-4-argon" ] && ok "agy translate: opus → gemini-4-argon (positive control)" || no "agy translate opus" "rc=$trc out=$out"

echo "copilot flag translation (interactive line)"
run copilot "$BUILD"
[ "$rc" -eq 0 ] && ok "copilot: interactive line launches" || no "copilot: interactive line launches" "$err"
has "copilot: --model opus → claude-opus-5.5, --effort → --reasoning-effort, --remote-control → --remote" "$acts" "copilot --name acme-build --model claude-opus-5.5 --reasoning-effort medium --remote"
lacks "copilot: --permission-mode auto is not turned into --yolo" "$acts" "--yolo"
run copilot "acme-x|$W||--model sonnet --model haiku --permission-mode bypassPermissions --dangerously-skip-permissions"
has "copilot: sonnet → claude-sonnet-5.5" "$acts" "--model claude-sonnet-5.5"
has "copilot: haiku → claude-haiku-5.5" "$acts" "--model claude-haiku-5.5"
has "copilot: bypassPermissions → --yolo" "$acts" "--yolo"
has "copilot: --dangerously-skip-permissions → --yolo --mode autopilot --no-ask-user" "$acts" "--yolo --mode autopilot --no-ask-user"

SEC_ENV_OK="acme-sec|$W||--model claude-opus-4-8|$W/security.env"
echo "engsys#197/#229: the verdict key path goes only to security-ENV lines (defence in depth, not a boundary)"
KEYP="$T/fleet.key"
LAUNCH_EXTRA="--verdict-key-file $KEYP"
rm -f "$T/leak"
run claude "$SEC_MODEL" 
lacks "claude: an Opus 4.8 line that is not the security env (a merge session) is NOT given the key path" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
has "claude: …it has it unset, so security-verdict post refuses there" "$acts" "unset ENGSYS_SECURITY_VERDICT_KEY_FILE"
run claude "acme-mm|$W|/merge-monster|--model claude-opus-4-8 --dangerously-skip-permissions" 
lacks "claude: a merge monster on Opus 4.8 is NOT given the key path" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
run claude "acme-mm|$W|/merge-monster|--model claude-opus-4-8 --dangerously-skip-permissions|$W/security.env" 
lacks "claude: a merge-role line is NOT given the key path even on a security env file" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
has "claude: …and it did launch, with the key path unset" "$acts" "unset ENGSYS_SECURITY_VERDICT_KEY_FILE"
run claude "acme-sec|$W||--model claude-opus-4-8|$W/nyx.env" 
has "claude: a nyx env-file line gets the key path (positive control)" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE=$KEYP"
run claude "$SEC_ENV_OK" 
has "claude: a security env-file line gets the key path (positive control)" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE=$KEYP"
run claude "$BUILD" 
lacks "claude: an interactive line is NOT given the key path" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
has "claude: an interactive line has it unset" "$acts" "unset ENGSYS_SECURITY_VERDICT_KEY_FILE"
run claude "$MM" 
lacks "claude: the merge monster is NOT given the key path by the launcher" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
LAUNCH_EXTRA="" run claude "$SEC_MODEL"
lacks "claude: nothing is exported when the launcher has no key configured" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE"
# an inherited key path in the launcher's own environment is scrubbed, never forwarded and never seen by tmux
LAUNCH_EXTRA="" run claude "$SEC_MODEL" ENGSYS_SECURITY_VERDICT_KEY_FILE=/inherited/key
lacks "claude: an inherited key path is not forwarded to a launch line" "$acts" "/inherited/key"
LAUNCH_EXTRA="--verdict-key-file $KEYP" run claude "$SEC_ENV_OK" ENGSYS_SECURITY_VERDICT_KEY_FILE=/inherited/key
lacks "claude: …nor does the launcher's own env leak into the line when a key flag is also given" "$acts" "/inherited/key"
if [ ! -s "$T/leak" ]; then ok "no tmux call ever saw the key path in its environment (the server's global env stays clean)"; else no "tmux saw the key path" "$(cat "$T/leak")"; fi
echo "export-before-claude ordering: the key decision is repeated after the env file"
run claude "$SEC_ENV_OK" 
case "$acts" in *"set +a && export ENGSYS_SECURITY_VERDICT_KEY_FILE"*) ok "claude: the key decision is re-applied after the env file is sourced" ;; *) no "claude: re-applied after the env file" "$acts" ;; esac
run claude "acme-build|$W||--model opus|$W/ordinary.env" 
case "$acts" in *"set +a && unset ENGSYS_SECURITY_VERDICT_KEY_FILE"*) ok "claude: an env file cannot add the key path to an ordinary session (unset after sourcing)" ;; *) no "claude: unset after the env file" "$acts" ;; esac
echo "engsys#229: a merge-role line is told where its repo's fleet merge config is (ENGSYS_MM_CONFIG), nothing else is"
git -C "$T/w" init -q 2>/dev/null; git -C "$T/w" remote add origin https://github.com/acme/app.git 2>/dev/null || true
MMCFG="$T/mmcfg"; MMPLUG="$MMCFG/plugins/cache/acme-fleet/acme/1.0.0"
mkdir -p "$MMPLUG/repos/acme/app"; printf 'repo: acme/app\n' >"$MMPLUG/repos/acme/app/merge-monster.yml"
MMLINE="acme-mm|$W|/merge-monster|--model claude-opus-4-8 --dangerously-skip-permissions"
run claude "$MMLINE" CLAUDE_CONFIG_DIR="$MMCFG"
has "claude: a merge-role line gets ENGSYS_MM_CONFIG pointing at the fleet copy" "$acts" "export ENGSYS_MM_CONFIG="
has "claude: …the instance plugin's merge-monster.yml for its repo" "$acts" "repos/acme/app/merge-monster.yml"
run claude "$BUILD" CLAUDE_CONFIG_DIR="$MMCFG"
lacks "claude: an interactive line is not given it" "$acts" "export ENGSYS_MM_CONFIG"
has "claude: …it has it unset" "$acts" "unset ENGSYS_MM_CONFIG"
run claude "$MMLINE" CLAUDE_CONFIG_DIR="$T/nocfg"
lacks "claude: a merge-role line whose repo has no fleet copy gets none" "$acts" "export ENGSYS_MM_CONFIG"
run claude "$MMLINE" CLAUDE_CONFIG_DIR="$MMCFG" ENGSYS_MM_CONFIG=/inherited/mm.yml
lacks "claude: an inherited ENGSYS_MM_CONFIG is never forwarded" "$acts" "/inherited/mm.yml"
echo "antigravity flag translation and the remote-control daemon"
run antigravity "$BUILD"
[ "$rc" -eq 0 ] && ok "antigravity: interactive line launches" || no "antigravity: interactive line launches" "$err"
has "antigravity: --model opus → gemini-4-argon, --effort and --remote-control forwarded" "$acts" "--model gemini-4-argon --effort medium --remote-control"
lacks "antigravity: daemon is not started by default" "$acts" "agy-rc"
run antigravity "$BUILD" AGY_REMOTE_CONTROL_AUTOSTART=0
lacks "antigravity: daemon stays off with AGY_REMOTE_CONTROL_AUTOSTART=0" "$acts" "agy-rc"
run antigravity "$BUILD" AGY_REMOTE_CONTROL_AUTOSTART=1
has "antigravity: AGY_REMOTE_CONTROL_AUTOSTART=1 starts the daemon (opt-in)" "$acts" "agy-rc remote-control start --name acme-"
run antigravity "acme-build|$W||--model haiku" AGY_REMOTE_CONTROL_AUTOSTART=1
lacks "antigravity: opt-in alone, with no --remote-control session, starts nothing" "$acts" "agy-rc remote-control start"
has "antigravity: haiku → gemini-3.8-flash" "$acts" "--model gemini-3.8-flash"

echo "engsys#236: only a short '. <launch file>' line is typed; the full command lives in the file"
LAUNCH_EXTRA=""
bytes() { printf '%s' "$1" | LC_ALL=C wc -c | tr -d ' '; }
# a long roster line: long --add-dir flags, a long config dir path (so a long ENGSYS_MM_CONFIG), a merge role
LONG="$T/$(printf 'very-long-directory-name-%.0s' 1 2 3 4 5 6 7 8)"
LONGFLAGS="--model claude-opus-4-8 --effort high --remote-control --dangerously-skip-permissions"
for i in 1 2 3 4 5 6 7 8 9 10; do LONGFLAGS+=" --add-dir $LONG/worktree-$i"; done
LMMCFG="$LONG/claude-config"; mkdir -p "$LMMCFG/plugins/cache/acme-fleet/acme/1.0.0/repos/acme/app"
printf 'repo: acme/app\n' >"$LMMCFG/plugins/cache/acme-fleet/acme/1.0.0/repos/acme/app/merge-monster.yml"
run claude "acme-mm|$W|/engsys:merge-monster|$LONGFLAGS" CLAUDE_CONFIG_DIR="$LMMCFG"
[ "$rc" -eq 0 ] && ok "long merge line: launches" || no "long merge line: launches" "$err"
typed="$(cat "$T/typed")"; script="$(cat "$T/launch-file.copy")"
[ "$(bytes "$script")" -gt 1024 ] && ok "long merge line: the full command is over 1024 bytes ($(bytes "$script"))" || no "long merge line: over 1024 bytes" "$(bytes "$script")"
[ "$(bytes "$typed")" -lt 1024 ] && ok "long merge line: the typed line is under 1024 bytes ($(bytes "$typed"): $typed)" || no "typed under 1024" "$typed"
case "$typed" in ". $T/home/.local/state/engsys/launch/acme-mm."*) ok "long merge line: it sources a launch file in the default launch dir" ;; *) no "typed sources the launch file" "$typed" ;; esac
has "long merge line: the file has ENGSYS_MM_CONFIG" "$script" "export ENGSYS_MM_CONFIG=$LMMCFG/plugins/cache/acme-fleet/acme/1.0.0/repos/acme/app/merge-monster.yml && "
has "long merge line: …and every flag, to the last" "$script" "--add-dir $LONG/worktree-10"
lf="$(cat "$T/launch-file")"
case "$script" in *"&& command rm -f -- $lf && command claude --name acme-mm "*) ok "the file removes itself as its last step before the harness" ;; *) no "self-removal right before claude" "$script" ;; esac
case "$(cat "$T/launch-file.ls")" in -rw-------*) ok "the launch file is mode 0600" ;; *) no "launch file 0600" "$(cat "$T/launch-file.ls")" ;; esac
[ "$(stat -c %a "$T/home/.local/state/engsys/launch" 2>/dev/null || stat -f %Lp "$T/home/.local/state/engsys/launch")" = 700 ] && ok "the launch dir is mode 0700" || no "launch dir 0700"
[ ! -e "$lf" ] && ok "a started launch leaves no launch file behind" || no "launch file removed" "$lf"
# a security line: long key path, the verdict key export, the env file sourced before it
LONGKEY="$LONG/fleet-security-verdict.key"
LAUNCH_EXTRA="--verdict-key-file $LONGKEY" run claude "acme-sec|$W||$LONGFLAGS|$W/security.env" CLAUDE_CONFIG_DIR="$LMMCFG"
LAUNCH_EXTRA=""
typed="$(cat "$T/typed")"; script="$(cat "$T/launch-file.copy")"
[ "$rc" -eq 0 ] && ok "long security line: launches" || no "long security line: launches" "$err"
[ "$(bytes "$typed")" -lt 1024 ] && ok "long security line: the typed line is under 1024 bytes ($(bytes "$typed"))" || no "security typed under 1024" "$typed"
lacks "long security line: the key path is not typed" "$typed" "$LONGKEY"
case "$script" in *"&& unset ENGSYS_MM_CONFIG && cd "*" && set -a && . $W/security.env && set +a && export ENGSYS_SECURITY_VERDICT_KEY_FILE=$LONGKEY && "*"export CLAUDE_CONFIG_DIR=$LMMCFG && command rm -f -- "*" && command claude --name acme-sec "*)
  ok "long security line: the file sources the env file, then sets the key path and the config dir, then claude" ;;
  *) no "security ordering in the launch file" "$script" ;; esac
case "$script" in *"export ENGSYS_SECURITY_VERDICT_KEY_FILE=$LONGKEY && unset ENGSYS_MM_CONFIG"*) ok "long security line: the key path is also set before the env file (overwritten after it either way)" ;; *) no "key before env file" "$script" ;; esac
for h in copilot antigravity; do
  run "$h" "$BUILD"
  case "$(cat "$T/typed")" in ". $T/home/.local/state/engsys/launch/acme-build."*) ok "$h: goes through a launch file too" ;; *) no "$h launch file" "$(cat "$T/typed")" ;; esac
done

echo "engsys#236: the launch dir is private and never a symlink"
mkdir -p "$T/real-launch"; ln -sfn "$T/real-launch" "$T/link-launch"
run claude "$BUILD" ENGSYS_LAUNCH_DIR="$T/link-launch"
if [ "$rc" -ne 0 ]; then ok "a symlinked launch dir: exits non-zero"; else no "symlinked launch dir: exits non-zero"; fi
has "…says why" "$err" "is a symlink; refusing to write launch files through it"
lacks "…nothing reaches tmux" "$acts" "send-keys"
[ -z "$(ls -A "$T/real-launch")" ] && ok "…and nothing is written where it points" || no "nothing written through the symlink" "$(ls -A "$T/real-launch")"
LAUNCH_EXTRA="--launch-dir $T/link-launch" run claude "$BUILD"
has "--launch-dir: a symlink is refused the same way" "$err" "is a symlink"
mkdir -p "$T/own-launch"; chmod 700 "$T/own-launch"
run claude "$BUILD" ENGSYS_LAUNCH_DIR="$T/own-launch"
[ "$rc" -eq 0 ] && ok "ENGSYS_LAUNCH_DIR: launches from that dir" || no "ENGSYS_LAUNCH_DIR launches" "$err"
case "$(cat "$T/typed")" in ". $T/own-launch/acme-build."*) ok "…the file is in it" ;; *) no "file in ENGSYS_LAUNCH_DIR" "$(cat "$T/typed")" ;; esac
mkdir -p "$T/open-launch"; chmod 755 "$T/open-launch"
run claude "$BUILD" ENGSYS_LAUNCH_DIR="$T/open-launch"
if [ "$rc" -ne 0 ]; then ok "an existing launch dir open to others: refused"; else no "open launch dir refused"; fi
has "…says so" "$err" "is open to other users (mode 755)"
[ "$(stat -c %a "$T/open-launch" 2>/dev/null || stat -f %Lp "$T/open-launch")" = 755 ] && ok "…and its mode is left alone (never chmod'ed)" || no "open launch dir mode untouched"
lacks "…nothing reaches tmux" "$acts" "send-keys"
# the prune: an hour-old launch file goes, anything else in the dir stays
touch "$T/own-launch/acme-old.20261001T000000Z-1-2.AbCdEf" "$T/own-launch/roster" "$T/own-launch/notes.txt"
touch -t 202610010000 "$T/own-launch/acme-old.20261001T000000Z-1-2.AbCdEf" "$T/own-launch/roster" "$T/own-launch/notes.txt"
run claude "$BUILD" ENGSYS_LAUNCH_DIR="$T/own-launch"
[ ! -e "$T/own-launch/acme-old.20261001T000000Z-1-2.AbCdEf" ] && ok "prune: an hour-old launch file is removed" || no "prune removes old launch file"
[ -e "$T/own-launch/roster" ] && [ -e "$T/own-launch/notes.txt" ] && ok "prune: other old files in the dir are left alone" || no "prune keeps other files"
DEEP="$T/$(printf 'd%.0s' $(seq 1 200))/$(printf 'e%.0s' $(seq 1 200))/$(printf 'f%.0s' $(seq 1 200))"
run claude "$BUILD" ENGSYS_LAUNCH_DIR="$DEEP"
if [ "$rc" -ne 0 ]; then ok "a launch dir too long for a short line: refused"; else no "too-long launch dir refused"; fi
has "…says to use a shorter one" "$err" "use a shorter --launch-dir"
lacks "…nothing reaches tmux" "$acts" "send-keys"

echo "engsys#236: sent is not started — a launch that never starts fails loudly"
run claude "$BUILD" FAKE_NO_START=1
if [ "$rc" -ne 0 ]; then ok "pane never leaves the shell: exits non-zero"; else no "never started: exits non-zero" "rc=$rc"; fi
has "…launch did not start, naming the session and the wait" "$err" "error: launch did not start for 'acme-build' within 2s: the shell never ran the launch line (the pane is still at zsh)"
has "…shows the pane's last lines" "$err" "  pane: zsh: command not found: --remote-contr"
has "…the line is reported skipped" "$err" "SKIPPED: acme-build"
has "…its window is closed" "$acts" "kill-window acme:acme-build"
[ ! -e "$(cat "$T/launch-file")" ] && ok "…its launch file is removed (it can't run late)" || no "never-started launch file removed"
run claude "$BUILD" FAKE_EXIT_AT_ONCE=1
if [ "$rc" -ne 0 ]; then ok "harness exits at once: exits non-zero"; else no "exits at once: non-zero" "rc=$rc"; fi
has "…says the line ran but claude is not running" "$err" "the launch line ran, but claude is not running (the pane is back at zsh)"
run claude "$BUILD" FAKE_NO_START=1 LAUNCH_START_TIMEOUT_SEC=0
[ "$rc" -eq 0 ] && ok "LAUNCH_START_TIMEOUT_SEC=0: no start check (sent = launched)" || no "timeout 0 skips the check" "$err"
run claude "$BUILD" LAUNCH_START_TIMEOUT_SEC=soon
if [ "$rc" -ne 0 ]; then ok "LAUNCH_START_TIMEOUT_SEC must be a number"; else no "bad timeout rejected"; fi
run claude "$BUILD
acme-mm|$W|/engsys:merge-monster|--model opus" FAKE_NO_START=1
has "a whole roster: every session that never starts is counted" "$err" "error: 2 roster session(s) not launched; 0 launched"

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
