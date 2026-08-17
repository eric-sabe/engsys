#!/usr/bin/env bash
#
# launch-agent-sessions.sh — stand up a fleet of named, cross-session-messaging
# ready Claude Code sessions for a project, as tmux windows on an always-on
# machine. Generalized from the FeedFrwd/keystone launcher (2026-08-16).
#
# The fleet is declared in a ROSTER FILE (default: .claude/agent-sessions.roster
# in the repo the launcher runs from — see roster.example next to this script).
# Header lines are KEY=VALUE; session lines are pipe-delimited:
#
#   NAMESPACE=acme                 # required: session-name prefix (the trust fence)
#   TMUX_SESSION=acme              # optional: tmux session name (default: NAMESPACE)
#   ENV_FILE=~/.config/acme/agents.env   # optional: sourced into every session
#   MODEL=--model claude-opus-4-8  # optional: appended to every session
#   <name>|<workdir>|<initial prompt>|<extra claude flags>
#
#   <name>            must start with "NAMESPACE-" (enforced) — messaging is
#                     scoped to the OS user, not the project, so the prefix IS
#                     the isolation: peers only trust names under their prefix.
#   <workdir>         empty → the repo root the launcher runs from.
#   <initial prompt>  sent as the session's first turn (e.g. /merge-monster);
#                     empty for a plain interactive session.
#   <extra flags>     appended verbatim. Use --dangerously-skip-permissions ONLY
#                     for a session that runs fully unattended (see SKILL.md
#                     § Permission modes), and understand it composes with
#                     crossSessionInbound=accept so nudges still arrive.
#
# USAGE
#   launch-agent-sessions.sh [--roster FILE] [session-name]
#     no args          start every session in the roster
#     session-name     start just that one
#
# PREREQS
#   * tmux; claude >= 2.1.232; run as the machine's normal login user
#     (messaging sockets are per-user)
#
# Attach afterwards:  tmux attach -t <TMUX_SESSION>   (detach: Ctrl-b d)
set -euo pipefail

ROSTER=".claude/agent-sessions.roster"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --roster) ROSTER="$2"; shift 2 ;;
    -h | --help) sed -n '2,35p' "$0"; exit 0 ;;
    *) ONLY="$1"; shift ;;
  esac
done

REPO="$(pwd)"
[ -f "$ROSTER" ] || { echo "error: roster not found: $ROSTER (see the agent-sessions skill's roster.example)" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "error: tmux not found on PATH" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "error: claude not found on PATH" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Parse roster
# ---------------------------------------------------------------------------
NAMESPACE="" TMUX_SESSION="" ENV_FILE="" MODEL=""
SESSIONS=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    '' | \#*) continue ;;
    NAMESPACE=*) NAMESPACE="${line#NAMESPACE=}" ;;
    TMUX_SESSION=*) TMUX_SESSION="${line#TMUX_SESSION=}" ;;
    ENV_FILE=*) ENV_FILE="${line#ENV_FILE=}"; ENV_FILE="${ENV_FILE/#\~/$HOME}" ;;
    MODEL=*) MODEL="${line#MODEL=}" ;;
    *\|*) SESSIONS+=("$line") ;;
    *) echo "error: unrecognized roster line: $line" >&2; exit 1 ;;
  esac
done < "$ROSTER"

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

# Optional per-machine env (credentials, endpoints — e.g. a durable cloud
# identity). Must be injected into each WINDOW's command line: a pre-existing
# tmux server does not inherit this launcher's exports.
if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  echo "warning: ENV_FILE not found: $ENV_FILE — sessions start without it" >&2
  ENV_FILE=""
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
launch_one() {
  local name="$1" workdir="$2" prompt="$3" extra="$4"

  case "$name" in
    "$NAMESPACE"-*) ;;
    *) echo "error: session name '$name' must start with '${NAMESPACE}-' (the namespace fence)" >&2; return 1 ;;
  esac
  [ -n "$workdir" ] || workdir="$REPO"

  local cmd
  cmd="cd $(printf %q "$workdir") && "
  if [ -n "$ENV_FILE" ]; then
    cmd+="set -a && . $(printf %q "$ENV_FILE") && set +a && "
  fi
  cmd+="claude --name $(printf %q "$name") --settings $(printf %q "$SETTINGS_FILE")"
  [ -n "$MODEL" ] && cmd+=" $MODEL"
  [ -n "$extra" ] && cmd+=" $extra"
  [ -n "$prompt" ] && cmd+=" $(printf %q "$prompt")"

  # A duplicate logical name ANYWHERE the same user runs claude makes Claude
  # Code suffix this one (name-2), which breaks name addressing. Reject a name
  # already present in any window on the whole tmux server. Sessions launched
  # OUTSIDE tmux can't be seen here — `claude` + ListAgents to confirm free.
  if tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -Fxq -- "$name"; then
    echo "skip: a tmux window named '$name' already exists on this server" >&2
    return 0
  fi

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Trailing colon matters: `-t session` (no colon) is a WINDOW target — the
    # session's current window — and the second launch dies with "index 0 in
    # use". `-t session:` means "next free index in this session".
    tmux new-window -t "${TMUX_SESSION}:" -n "$name"
  else
    tmux new-session -d -s "$TMUX_SESSION" -n "$name"
  fi
  tmux send-keys -t "${TMUX_SESSION}:${name}" "$cmd" Enter
  echo "launched: $name  ($workdir)"
}

launched=0
for spec in "${SESSIONS[@]}"; do
  IFS='|' read -r name workdir prompt extra <<<"$spec"
  [ -z "$name" ] && continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then
    continue
  fi
  launch_one "$name" "$workdir" "$prompt" "$extra"
  launched=$((launched + 1))
done

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
