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
  send-keys) shift; echo "send-keys $*" >>"$FAKE/actions" ;;
esac
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
  err="$(cd "$T/w" && env HARNESS="$harness" "$@" bash "$LAUNCH" --roster "$T/w/roster" 2>&1 >/dev/null)"
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
