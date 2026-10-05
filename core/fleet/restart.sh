#!/usr/bin/env bash
# restart.sh — see which fleet sessions are behind the host, and restart them when you're ready.
#
# "Behind" = the session's claude process started before the last change `fleet sync` made
# (.fleet/last-change). Restarting is deliberately separate from syncing: sessions keep working on
# their loaded versions until you choose to cycle them.
#
# How each kind is cycled:
#   monsters (ledger-bearing: the sessions in fleet/supervisor.conf.tmpl) — typed a rotation request;
#       the monster finishes its current step (never mid-merge), posts its digest + a final
#       `rotation requested` heartbeat, and exits (or sits idle); the supervisor relaunches it on the
#       new versions within ~5 min.
#   interactive roles (everything else in the roster) — if idle: `/exit`, then relaunched. If busy
#       (mid-turn) they're skipped unless --force (which interrupts the turn first).
#   exited or missing windows — relaunched directly.
# Sessions that are not on this host (ROLES / ROSTER_EXCLUDE, or a monster whose registry home is
# another fleet: lib/host-roles.sh) are never cycled; status lists them as "not on this host".
#
# Usage: restart.sh [--instance <dir>]               # status only (same as --status)
#        restart.sh --stale                          # cycle every session that's behind
#        restart.sh --all                            # cycle every session
#        restart.sh <name>...                        # cycle these (e.g. acme-build acme-design)
#        add --force to also cycle busy interactive sessions
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"

mode=status force=0 names=()
while [ $# -gt 0 ]; do
  case "$1" in
    --status) mode=status ;;
    --stale) mode=stale ;;
    --all) mode=all ;;
    --force) force=1 ;;
    -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    -*) fleet_die "unknown option: $1" ;;
    *) mode=names; names+=("$1") ;;
  esac
  shift
done

LAST_CHANGE="$(cat "$FLEET_STATE/last-change" 2>/dev/null || echo 0)"
LEDGER="$(fleet_ledger_sessions)"
ROSTER="$(fleet_roster_sessions)"
fleet_host_init
HOST_ROSTER="$(fleet_host_sessions)"

is_monster() { grep -Fxq "$1" <<<"$LEDGER"; }
win() { echo "${TMUX_SESSION}:$1"; }
has_window() { # capture first: `grep -q` closing the pipe early would fail the pipeline under pipefail
  local w
  w="$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null)" || return 1
  grep -Fxq "$1" <<<"$w"
}
pane_cmd() { tmux list-panes -t "$(win "$1")" -F '#{pane_current_command}' 2>/dev/null | head -1; }
is_alive() { # the launcher runs claude from the window's login shell; shell in the foreground = exited
  case "$(pane_cmd "$1")" in '' | zsh | -zsh | bash | -bash | sh | -sh | fish | -fish) return 1 ;; esac
}
started_at() { # epoch the session's claude process started ('' if none)
  local pp pid lstart
  pp="$(tmux list-panes -t "$(win "$1")" -F '#{pane_pid}' 2>/dev/null | head -1)"
  case "$pp" in '' | *[!0-9]*) return 0 ;; esac
  pid="$(pgrep -P "$pp" 2>/dev/null | head -1)"
  [ -n "$pid" ] || return 0
  lstart="$(LC_ALL=C ps -o lstart= -p "$pid" | sed 's/  */ /g; s/^ //; s/ *$//')"
  LC_ALL=C date -j -f '%a %b %d %T %Y' "$lstart" +%s 2>/dev/null || date -d "$lstart" +%s 2>/dev/null || true
}
is_busy() {
  local c
  c="$(tmux capture-pane -p -t "$(win "$1")" -S -15 2>/dev/null)" || return 1
  grep -q 'esc to interrupt' <<<"$c"
}

state_of() { # → missing | exited | busy | idle
  has_window "$1" || { echo missing; return; }
  is_alive "$1" || { echo exited; return; }
  if is_busy "$1"; then echo busy; else echo idle; fi
}
is_behind() { local s; s="$(started_at "$1")"; [ -n "$s" ] && [ "$s" -lt "$LAST_CHANGE" ]; }

fmt_time() { date -r "$1" '+%m-%d %H:%M' 2>/dev/null || date -d "@$1" '+%m-%d %H:%M'; }
status() {
  local n kind st s when behind
  printf '%-22s %-12s %-8s %-17s %s\n' SESSION KIND STATE STARTED VERSION
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    kind=interactive; if is_monster "$n"; then kind=monster; fi
    st="$(state_of "$n")"; s=""; when="-"; behind="-"
    if why="$(fleet_host_excluded "$n")" && [ "$st" = missing ]; then
      printf '%-22s %-12s %s\n' "$n" "$kind" "not on this host ($why)"
      continue
    fi
    if [ "$st" = busy ] || [ "$st" = idle ]; then
      s="$(started_at "$n")"
      [ -z "$s" ] || when="$(fmt_time "$s")"
      if is_behind "$n"; then behind="BEHIND"; else behind="current"; fi
    fi
    if why="$(fleet_host_excluded "$n")"; then behind="$behind  (window present, but not on this host: $why)"; fi
    printf '%-22s %-12s %-8s %-17s %s\n' "$n" "$kind" "$st" "$when" "$behind"
  done <<<"$ROSTER"
  fleet_host_warnings
  if [ "$LAST_CHANGE" != 0 ]; then
    echo "last host change: $(date -r "$LAST_CHANGE" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$LAST_CHANGE" '+%Y-%m-%d %H:%M')  ($(tail -1 "$FLEET_STATE/sync.log" 2>/dev/null | cut -d' ' -f2-))"
  fi
  echo "cycle: fleet restart --stale | <name>...   (monsters rotate themselves; busy interactive sessions are skipped)"
}

relaunch() { # window gone or at a shell prompt → fresh launch
  if has_window "$1"; then tmux kill-window -t "$(win "$1")"; fi
  if bash "$FLEET_KIT_DIR/launch.sh" "$1" >/dev/null; then echo "$1: relaunched"; else echo "$1: RELAUNCH FAILED — run: fleet launch $1" >&2; fi
}

pins_text="engsys ${ENGSYS_REF:-?}"
[ -z "$INSTANCE_MARKETPLACE" ] || pins_text="$pins_text, $INSTANCE_MARKETPLACE ${INSTANCE_REF:-?}"
ROTATE_MSG="Operator: the fleet host was upgraded (pins: $pins_text). Rotate at your next safe point — finish the current step, never mid-merge: post your digest and a final ledger heartbeat with status \`rotation requested\`, then exit. The supervisor relaunches you on the new versions."

cycle() {
  local n="$1" st
  grep -Fxq "$n" <<<"$ROSTER" || { echo "$n: not in the roster — skipped" >&2; return 0; }
  local why
  if why="$(fleet_host_excluded "$n")"; then echo "$n: not on this host ($why), skipped (fleet launch $n --force-excluded starts it anyway)"; return 0; fi
  st="$(state_of "$n")"
  case "$st" in
    missing | exited) relaunch "$n"; return 0 ;;
  esac
  if is_monster "$n"; then
    tmux send-keys -t "$(win "$n")" -l "$ROTATE_MSG"; tmux send-keys -t "$(win "$n")" Enter
    echo "$n: rotation requested (it exits at its next safe point; the supervisor relaunches it)"
    return 0
  fi
  if [ "$st" = busy ]; then
    [ "$force" = 1 ] || { echo "$n: busy mid-turn — skipped (retry later, or --force to interrupt)"; return 0; }
    tmux send-keys -t "$(win "$n")" Escape; sleep 2
  fi
  tmux send-keys -t "$(win "$n")" -l "/exit"; tmux send-keys -t "$(win "$n")" Enter
  for _ in $(seq 1 30); do is_alive "$n" || break; sleep 1; done
  if is_alive "$n"; then echo "$n: didn't exit within 30s — left running (check the window)" >&2; return 0; fi
  relaunch "$n"
}

case "$mode" in
  status) status ;;
  stale)
    [ "$LAST_CHANGE" != 0 ] || { echo "no host change recorded yet (run: fleet sync)"; exit 0; }
    any=0
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      st="$(state_of "$n")"
      { [ "$st" = busy ] || [ "$st" = idle ]; } && is_behind "$n" || continue
      any=1; cycle "$n"
    done <<<"$HOST_ROSTER"
    [ "$any" = 1 ] || echo "nothing behind."
    ;;
  all)
    while IFS= read -r n; do [ -z "$n" ] || cycle "$n"; done <<<"$HOST_ROSTER"
    off="$(grep -Fxv -f <(printf '%s\n' "$HOST_ROSTER") <<<"$ROSTER" | paste -sd' ' - || true)"
    [ -z "$off" ] || echo "not on this host, left alone: $off"
    ;;
  names) for n in "${names[@]}"; do cycle "$n"; done ;;
esac
