#!/usr/bin/env bash
# install-jobs.sh — render the fleet's launchd job templates for THIS host and (re)load them.
#
# Templates: core/fleet/jobs/launchd/*.plist.tmpl (engsys defaults), then the instance's
# jobs/launchd/*.plist.tmpl — a same-named instance file overrides the default. Every template can use
# __LABEL__ (com.<FLEET_ORG>.fleet.<basename>), __LOG_DIR__, __FLEET_REPO__, __HOME__ and any
# fleet.conf key. Each rendered plist is `plutil -lint`ed, then the old copy is booted out and the
# new one bootstrapped — never two copies running.
#   fleet-supervisor  installed only when the instance has fleet/supervisor.conf.tmpl
#   gh-app-login      installed only when GH_APP_ENV is set
#
# Usage: install-jobs.sh [--instance <dir>]                    # render + install + (re)load every job
#        install-jobs.sh --dry-run                             # print what would be written; change nothing
#        install-jobs.sh --only <job|label>                    # one job (basename or full label)
#        install-jobs.sh --unload                              # boot out every job (rollback/maintenance)
# (macOS launchd; a Linux/systemd equivalent is a documented follow-up.)
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
case "${1:-}" in -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;; esac
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"

AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

dry=0 unload=0 only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --unload) unload=1 ;;
    --only) only="${2:?--only needs a job name}"; shift ;;
    -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) echo "install-jobs: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# job name → template path; the instance overrides the engsys default of the same name
names=() paths=()
add_template() { # add_template <path>
  local i=0 base
  base="$(basename "$1" .plist.tmpl)"
  while [ "$i" -lt "${#names[@]}" ]; do   # index loop: bash 3.2 + set -u dislike empty-array expansion
    if [ "${names[$i]}" = "$base" ]; then paths[i]="$1"; return; fi
    i=$((i + 1))
  done
  names+=("$base"); paths+=("$1")
}
shopt -s nullglob
for t in "$FLEET_KIT_DIR"/jobs/launchd/*.plist.tmpl "$FLEET_REPO"/jobs/launchd/*.plist.tmpl; do add_template "$t"; done
[ ${#names[@]} -gt 0 ] || fleet_die "no job templates found (looked in $FLEET_KIT_DIR/jobs/launchd and $FLEET_REPO/jobs/launchd)"

label_of() { echo "com.${FLEET_ORG}.fleet.$1"; }
if [ -n "$only" ]; then
  found=0
  for n in "${names[@]}"; do
    if [ "$n" = "$only" ] || [ "$(label_of "$n")" = "$only" ]; then found=1; only="$n"; fi
  done
  [ "$found" = 1 ] || fleet_die "no job template named '$only' (have: ${names[*]})"
fi

skip_reason() { # skip_reason <job> → why it does not apply to this instance ('' = installs)
  case "$1" in
    fleet-supervisor) [ -f "$FLEET_REPO/fleet/supervisor.conf.tmpl" ] || echo "no fleet/supervisor.conf.tmpl" ;;
    gh-app-login) [ -n "${GH_APP_ENV:-}" ] || echo "GH_APP_ENV is not set" ;;
  esac
}

[ "$dry" = 1 ] || [ "$unload" = 1 ] || mkdir -p "$AGENTS_DIR" "$LOG_DIR"

for i in "${!names[@]}"; do
  job="${names[$i]}"; tmpl="${paths[$i]}"
  [ -z "$only" ] || [ "$only" = "$job" ] || continue
  LABEL="$(label_of "$job")"; export LABEL
  dest="$AGENTS_DIR/$LABEL.plist"

  if [ "$unload" = 1 ]; then
    if [ "$dry" = 1 ]; then echo "would boot out: $LABEL"; continue; fi
    if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then echo "booted out: $LABEL"; else echo "not loaded: $LABEL"; fi
    continue
  fi
  reason="$(skip_reason "$job")"
  if [ -n "$reason" ]; then echo "skipped: $LABEL ($reason)"; continue; fi

  rendered="$(fleet_render_text "$(cat "$tmpl")" "$tmpl")" || exit 1
  tmp="$(mktemp "${TMPDIR:-/tmp}/$LABEL.XXXXXX")"
  printf '%s\n' "$rendered" >"$tmp"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$tmp" >/dev/null || { echo "install-jobs: invalid plist rendered from $tmpl" >&2; rm -f "$tmp"; exit 1; }
  else
    echo "install-jobs: plutil not found — plist not linted" >&2
  fi

  if [ "$dry" = 1 ]; then
    echo "===== would write $dest  (from $tmpl) ====="
    printf '%s\n' "$rendered"
    rm -f "$tmp"
    continue
  fi
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true   # replace any running copy
  mv "$tmp" "$dest"
  chmod 644 "$dest"
  launchctl bootstrap "$DOMAIN" "$dest"
  echo "installed + loaded: $LABEL  -> $dest"
done

[ "$dry" = 1 ] || [ "$unload" = 1 ] || echo "logs: $LOG_DIR   (launchctl print $DOMAIN/<label> for status)"
