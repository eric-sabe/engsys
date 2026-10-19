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
mkdir -p "$T/bin" "$T/w" "$T/home"
pass=0 fail=0

# --- fakes -------------------------------------------------------------------------------------
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  list-windows) exit 0 ;;                       # no windows: every name is free
  has-session) exit 1 ;;                        # no session yet
  send-keys) [ -n "${TMUX_FAIL:-}" ] && exit 1; shift; echo "send-keys $*" >>"$FAKE/actions" ;;
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
export PATH="$T/bin:$PATH" FAKE="$T" HOME="$T/home"
unset HARNESS FLEET_HARNESS AGY_REMOTE_CONTROL AGY_REMOTE_CONTROL_AUTOSTART FLEET_ID 2>/dev/null || true

ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
# run <harness> <roster-body> [env...] — sets $rc, $err (stderr) and $acts (fake actions)
run() {
  local harness="$1" body="$2"; shift 2
  printf 'NAMESPACE=acme\n%s\n' "$body" >"$T/w/roster"
  : >"$T/actions"
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
echo "engsys#197: the verdict key path goes only to security-lane lines (defence in depth, not a boundary)"
KEYP="$T/fleet.key"
LAUNCH_EXTRA="--verdict-key-file $KEYP"
rm -f "$T/leak"
run claude "$SEC_MODEL" 
has "claude: a security-model line gets the key path (positive control)" "$acts" "export ENGSYS_SECURITY_VERDICT_KEY_FILE=$KEYP"
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

echo "$pass passed, $fail failed."
[ "$fail" = 0 ]
