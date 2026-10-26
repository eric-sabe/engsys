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
#   launch-agent-sessions.sh [--roster FILE] [--verdict-key-file PATH] [--memory-key-file PATH] [--launch-dir DIR] [session-name]
#     no args          start every session in the roster
#     session-name     start just that one
#
# HOW A SESSION STARTS (engsys#236)
#   Each session's full command line (env, cd, env file, harness) is written to a one-shot launch file
#   in DIR (--launch-dir, else $ENGSYS_LAUNCH_DIR, else ~/.local/state/engsys/launch; 0700, owned by
#   this user), and the window's shell is typed only `. <file>`. The window's shell is still starting
#   when the keys arrive, so its tty is in canonical mode, where macOS keeps at most MAX_CANON (1024)
#   bytes of an unread line and drops the rest, Enter included: a long line typed whole never runs.
#   Sourcing keeps the old semantics: the same interactive shell runs the command, so the harness is
#   the pane's foreground command, and the pane returns to the shell when it exits (what the
#   supervisor reads). The file removes itself just before the harness starts.
#   A launch counts only once it has started: the file is gone and the pane's foreground command is
#   no longer the shell, within LAUNCH_START_TIMEOUT_SEC (default 30; 0 = don't wait). Otherwise it
#   fails with "launch did not start", its window is closed, and the launcher exits non-zero.
#
# PREREQS
#   * tmux; claude >= 2.1.232; run as the machine's normal login user
#     (messaging sockets are per-user)
#
# Attach afterwards:  tmux attach -t <TMUX_SESSION>   (detach: Ctrl-b d)
set -euo pipefail

ROSTER=".claude/agent-sessions.roster"
ONLY=""
# engsys#197: the verdict key PATH arrives as a flag and is scrubbed from the environment here, so neither this
# process nor the tmux server it may start (whose global environment every later window inherits, hand-opened
# ones included) ever carries it; it reaches a session only on that session's own launch line, below.
VERDICT_KEY_FILE=""
LAUNCH_DIR="${ENGSYS_LAUNCH_DIR:-}"
unset ENGSYS_SECURITY_VERDICT_KEY_FILE
# F5: the memory signing key PATH arrives the same way (--memory-key-file) and reaches only merge/maintain lines.
MEMORY_KEY_FILE=""
unset ENGSYS_MEMORY_SIGNING_KEY_FILE
unset ENGSYS_MM_CONFIG   # engsys#229: set per merge-role line (lib/session-env.sh), never inherited (nor seen by the tmux server)
unset ENGSYS_MEMORY_CONFIG   # engsys#262: set for a line on its own per-session login dir (lib/session-env.sh), never inherited
# engsys#287: the fleet's Claude config dir as the fleet kit gave it to this launcher (fleet-env.sh exports it); a line
# gets this value or none, never what its window inherited
LAUNCHER_FLEET_CFG="${FLEET_CLAUDE_CONFIG_DIR:-}"
# and the per-session dirs' parent (the fleet kit passes it; core/lib/mm-config.mjs searches it inside a session)
LAUNCHER_CFG_SESSIONS="${ENGSYS_CONFIG_DIR_SESSIONS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --roster) ROSTER="$2"; shift 2 ;;
    --verdict-key-file) VERDICT_KEY_FILE="$2"; shift 2 ;;
    --memory-key-file) MEMORY_KEY_FILE="$2"; shift 2 ;;
    --launch-dir) LAUNCH_DIR="$2"; shift 2 ;;
    -h | --help) sed -n '2,66p' "$0"; exit 0 ;;
    *) ONLY="$1"; shift ;;
  esac
done

# engsys#287: the harness-neutral core (identity, line policy, the trust environment) and, below, one harness adapter.
LAUNCHER_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib"
# shellcheck source=lib/session-env.sh
. "$LAUNCHER_LIB/session-env.sh"

REPO="$(pwd)"
ROSTER_DIR="$(cd "$(dirname "$ROSTER")" 2>/dev/null && pwd)" || ROSTER_DIR="$REPO"
[ -f "$ROSTER" ] || { echo "error: roster not found: $ROSTER (see the agent-sessions skill's roster.example)" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "error: tmux not found on PATH" >&2; exit 1; }
LAUNCH_DIR="${LAUNCH_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/engsys/launch}"
LAUNCH_START_TIMEOUT_SEC="${LAUNCH_START_TIMEOUT_SEC:-30}"
case "$LAUNCH_START_TIMEOUT_SEC" in '' | *[!0-9]*) echo "error: LAUNCH_START_TIMEOUT_SEC must be a whole number of seconds" >&2; exit 1 ;; esac
# The one line typed into a window, `. <launch file>`, stays far below MAX_CANON (1024 bytes); a launch dir whose
# path would push it past this is refused rather than truncated.
LAUNCH_LINE_MAX=512
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
    ENV_FILE=*) ENV_FILE="${line#ENV_FILE=}"; ENV_FILE="$(expand_tilde "$ENV_FILE")" ;;
    MODEL=*) MODEL="${line#MODEL=}" ;;
    HARNESS=*) HARNESS="${line#HARNESS=}" ;;
    PREFLIGHT=*) PREFLIGHTS+=("${line#PREFLIGHT=}") ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "error: unrecognized roster line: $line" >&2; exit 1 ;;
  esac
done < "$ROSTER"

# The one place a harness is chosen by name (engsys#287): HARNESS selects the adapter lib/harness/<HARNESS>.sh, and
# everything after this asks the adapter (harness_*) or its declared capabilities (has_capability), never the name.
# launch-golden.test.sh lints that no other HARNESS comparison exists outside lib/harness/.
case "$HARNESS" in agy) HARNESS=antigravity ;; esac # adapter-select: `agy` is an alias
adapter_name_ok() { case "$1" in '' | *[!a-z0-9_-]*) return 1 ;; esac; return 0; }
if ! adapter_name_ok "$HARNESS" || [ ! -f "$LAUNCHER_LIB/harness/$HARNESS.sh" ]; then
  echo "error: unsupported HARNESS '$HARNESS' (expected claude, copilot, or antigravity)" >&2; exit 1
fi
# load_harness_adapter <file>: source it, and fail now when it lacks a required function or declares an unknown
# capability. HARNESS_CAPS is read once, here.
load_harness_adapter() {
  local f cap
  unset -f harness_bin harness_capabilities harness_translate_flags harness_run_cmd harness_prelaunch
  # shellcheck source=/dev/null
  . "$1"
  for f in harness_bin harness_capabilities harness_translate_flags harness_run_cmd; do
    declare -F "$f" >/dev/null || { echo "error: harness adapter $1 does not define $f" >&2; return 1; }
  done
  HARNESS_CAPS="$(harness_capabilities)"
  for cap in $HARNESS_CAPS; do
    case " $HARNESS_KNOWN_CAPS " in *" $cap "*) ;; *) echo "error: harness adapter $1 declares an unknown capability: $cap" >&2; return 1 ;; esac
  done
  HARNESS_BIN="$(harness_bin)"
  [ -n "$HARNESS_BIN" ] || { echo "error: harness adapter $1 names no binary (harness_bin)" >&2; return 1; }
}
load_harness_adapter "$LAUNCHER_LIB/harness/$HARNESS.sh" || exit 1

# launchd jobs (the fleet supervisor) run with a fixed PATH that may not include where Claude Code was
# installed: the native installer uses ~/.local/bin. Look in the standard install locations before failing.
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
if has_capability settings_file; then
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

# One-time per launch, after the preflights: the adapter's own pre-launch step (e.g. the agy remote-control daemon).
if declare -F harness_prelaunch >/dev/null; then harness_prelaunch; fi

# engsys#236: the launch dir (header). Checked once per run: owned by this user, open to nobody else, never a
# symlink, and absolute, because the window's shell reads the file from its own cwd. A missing one is created 0700;
# an existing one open to others is refused, never chmod'ed (it may be a directory with another purpose).
# Leftovers of a launcher killed mid-wait (a launch file normally removes itself, and a failed launch removes it)
# are pruned after an hour: only files named as launch files (<name>.<run id>.XXXXXX), nothing else in the dir.
LAUNCH_DIR_READY=0
prepare_launch_dir() {
  [ "$LAUNCH_DIR_READY" = 0 ] || return 0
  local mode
  if [ -L "$LAUNCH_DIR" ]; then echo "error: launch dir $LAUNCH_DIR is a symlink; refusing to write launch files through it" >&2; return 1; fi
  (umask 077 && mkdir -p "$LAUNCH_DIR") || { echo "error: can't create launch dir $LAUNCH_DIR" >&2; return 1; }
  if [ -L "$LAUNCH_DIR" ] || [ ! -d "$LAUNCH_DIR" ] || [ ! -O "$LAUNCH_DIR" ]; then
    echo "error: launch dir $LAUNCH_DIR is not a directory owned by $(id -un)" >&2; return 1
  fi
  # GNU first: GNU `stat -f` is filesystem status and would print before failing; BSD `stat -c` fails silently
  mode="$(stat -c %a "$LAUNCH_DIR" 2>/dev/null || stat -f %Lp "$LAUNCH_DIR" 2>/dev/null || true)"
  case "$mode" in
    *[0-7]00) ;;
    *) echo "error: launch dir $LAUNCH_DIR is open to other users (mode ${mode:-unknown}); it must be private: chmod 700 it, or use another --launch-dir" >&2; return 1 ;;
  esac
  LAUNCH_DIR="$(cd -P "$LAUNCH_DIR" && pwd)" || { echo "error: can't resolve launch dir $LAUNCH_DIR" >&2; return 1; }
  find "$LAUNCH_DIR" -maxdepth 1 -type f -mmin +60 \
    -name '*.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*-*.??????' \
    -exec rm -f {} + 2>/dev/null || true
  LAUNCH_DIR_READY=1
}
# The login shells a fresh window runs (the same list as the supervisor's pane_cmd checks).
is_shell_cmd() {
  case "$1" in zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) return 0 ;; esac
  return 1
}
# wait_started <name> <launch file> → 0 once the session has started: the launch file is gone (the shell ran the
# line up to the harness, which removes it just before starting) and the pane's foreground command is no longer
# the shell. Otherwise, after LAUNCH_START_TIMEOUT_SEC, says why (with the pane's last lines) and returns 1.
# The file is checked BEFORE the pane is read, and a pane at `rm` is not started: the line's `command rm` unlinks
# the file before it exits, so a sample can see the file gone with `rm` still in the foreground, and the harness
# may yet fail to exec.
wait_started() {
  local name="$1" file="$2" target="${TMUX_SESSION}:$1" waited=0 cur why gone
  while :; do
    gone=0; [ -e "$file" ] || gone=1
    cur="$(tmux list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null | head -1 || true)"
    if [ -z "$cur" ]; then why="its window closed"; break; fi
    if [ "$gone" = 1 ] && ! is_shell_cmd "$cur" && [ "$cur" != rm ]; then return 0; fi
    if [ "$waited" -ge "$LAUNCH_START_TIMEOUT_SEC" ]; then
      if [ -e "$file" ]; then why="the launch line has not reached the harness yet (the pane is still at $cur)"
      else why="the launch line ran, but $HARNESS_BIN is not running (the pane is back at $cur)"; fi
      break
    fi
    sleep 1; waited=$((waited + 1))
  done
  echo "error: launch did not start for '$name' within ${LAUNCH_START_TIMEOUT_SEC}s: $why" >&2
  { tmux capture-pane -p -t "$target" -S -20 2>/dev/null || true; } | grep -v '^[[:space:]]*$' | tail -n 3 | cut -c1-200 | sed 's/^/  pane: /' >&2 || true
  return 1
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
  workdir="$(expand_tilde "$workdir")"
  [ -d "$workdir" ] || { echo "error: workdir for '$name' not found: $workdir" >&2; return 1; }

  # Per-session env (5th roster field) replaces the roster-level ENV_FILE.
  local session_env="$ENV_FILE"
  if [ -n "$env_file" ]; then
    env_file="$(expand_tilde "$env_file")"
    case "$env_file" in /*) ;; *) env_file="$ROSTER_DIR/$env_file" ;; esac
    [ -f "$env_file" ] || { echo "error: env file for '$name' not found: $env_file" >&2; return 1; }
    session_env="$env_file"
  fi

  local cmd run_cmd run role
  run="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  role="$(prompt_role "$prompt")"
  # The line's Claude-style flags: the roster MODEL, then its own (a space between them only when both are set).
  local flags="${MODEL}${MODEL:+${extra:+ }}${extra:-}"
  # Which lines this harness may run is decided by the adapter's capabilities (lib/session-env.sh, rule 5).
  check_line_policy "$name" "$prompt" "$role" "$flags" "${session_env:-}" || return 1
  local root identity
  root="$(cd "$workdir" && pwd -P)" || { echo "error: cannot resolve workdir for '$name': $workdir" >&2; return 1; }
  identity="$(session_identity "$name" "$run" "$root" "$role")"
  # The trust environment (engsys#287): one harness-neutral function, its rules written down in lib/session-env.sh.
  cmd="$(assemble_trust_env "$name" "$prompt" "$role" "$flags" "${session_env:-}" "$workdir" "$identity")" || return 1
  # The harness itself (run_cmd) follows the launch file's self-removal (below). An adapter refuses a line by
  # failing its flag translation.
  local harness_flags
  harness_flags="$(harness_translate_flags "$flags" "$name")" || { echo "error: refusing to launch '$name' on HARNESS=$HARNESS" >&2; return 1; }
  run_cmd="$(harness_run_cmd "$name" "$prompt" "$harness_flags")"

  # A duplicate logical name ANYWHERE the same user runs claude makes Claude
  # Code suffix this one (name-2), which breaks name addressing. Reject a name
  # already present in any window on the whole tmux server. Sessions launched
  # OUTSIDE tmux can't be seen here — `claude` + ListAgents to confirm free.
  if tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -Fxq -- "$name"; then
    echo "skip: a tmux window named '$name' already exists on this server" >&2
    return 0
  fi

  # engsys#236: the command goes into a one-shot launch file and only `. <file>` is typed (header). mktemp creates
  # it new (O_EXCL, so never through an existing path or symlink), mode 0600, with a unique name per session and
  # launch, in a 0700 dir only this user can touch. It holds the key file's PATH for a security line, never key
  # material. The export/unset order is the line's own: the env file is sourced, then the verdict key, the config
  # dir and ENGSYS_MM_CONFIG are decided after it. Its last step before the harness removes it, so its absence
  # tells the start check that the shell got that far.
  prepare_launch_dir || return 1
  local launch_file line nbytes
  launch_file="$(umask 077 && mktemp "$LAUNCH_DIR/${name//[^A-Za-z0-9._-]/_}.$run.XXXXXX")" \
    || { echo "error: can't create a launch file for '$name' in $LAUNCH_DIR" >&2; return 1; }
  if [ -L "$launch_file" ] || [ ! -f "$launch_file" ] || [ ! -O "$launch_file" ]; then
    echo "error: launch file for '$name' is not a regular file owned by $(id -un): $launch_file" >&2; return 1
  fi
  printf '%s\n' "${cmd}command rm -f -- $(printf %q "$launch_file") && ${run_cmd}" >"$launch_file" \
    || { rm -f "$launch_file"; echo "error: can't write the launch file for '$name': $launch_file" >&2; return 1; }
  line=". $(printf %q "$launch_file")"
  nbytes="$(printf '%s' "$line" | LC_ALL=C wc -c | tr -d ' ')"
  if [ "$nbytes" -gt "$LAUNCH_LINE_MAX" ]; then
    rm -f "$launch_file"
    echo "error: the launch line for '$name' would be $nbytes bytes (limit $LAUNCH_LINE_MAX, MAX_CANON 1024): use a shorter --launch-dir" >&2
    return 1
  fi

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Trailing colon matters: `-t session` (no colon) is a WINDOW target — the
    # session's current window — and the second launch dies with "index 0 in
    # use". `-t session:` means "next free index in this session".
    tmux new-window -t "${TMUX_SESSION}:" -n "$name" || { rm -f "$launch_file"; echo "error: tmux new-window failed for '$name'" >&2; return 1; }
  else
    tmux new-session -d -s "$TMUX_SESSION" -n "$name" || { rm -f "$launch_file"; echo "error: tmux new-session failed for '$name'" >&2; return 1; }
  fi
  # The window keeps its name (engsys#236 review): the harness renames it with an escape sequence (ESC k … ESC \)
  # when allow-rename is on, and a renamed window is lost to every name-addressed call here and in the supervisor
  # (the start check reads "window closed", kill-window misses it, the live session is orphaned and the next tick
  # launches a duplicate). -n already turns automatic-rename off; it is set again explicitly.
  if ! tmux set-option -w -t "${TMUX_SESSION}:${name}" allow-rename off || ! tmux set-option -w -t "${TMUX_SESSION}:${name}" automatic-rename off; then
    rm -f "$launch_file"; tmux kill-window -t "${TMUX_SESSION}:${name}" 2>/dev/null || true
    echo "error: tmux set-option (allow-rename/automatic-rename off) failed for '$name'" >&2; return 1
  fi
  tmux send-keys -t "${TMUX_SESSION}:${name}" "$line" Enter || { rm -f "$launch_file"; echo "error: tmux send-keys failed for '$name'" >&2; return 1; }
  # Sent is not started (engsys#236): a launch that never starts closes its window, so nothing half-started is left
  # for a later tick to mistake for an exited session, and its launch file can't run late.
  if [ "$LAUNCH_START_TIMEOUT_SEC" -gt 0 ] && ! wait_started "$name" "$launch_file"; then
    rm -f "$launch_file"
    tmux kill-window -t "${TMUX_SESSION}:${name}" 2>/dev/null || true
    return 1
  fi
  echo "launched: $name  ($workdir)"
}

launched=0 failed=0
for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r name workdir prompt extra env_file <<<"$spec"
  [ -z "$name" ] && continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then
    continue
  fi
  # A refused or broken line is skipped loudly; the rest of the roster still launches.
  if launch_one "$name" "$workdir" "$prompt" "$extra" "$env_file"; then
    launched=$((launched + 1))
  else
    failed=$((failed + 1))
    echo "SKIPPED: $name (see the error above)" >&2
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "error: $failed roster session(s) not launched; $launched launched" >&2
  exit 1
fi
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
