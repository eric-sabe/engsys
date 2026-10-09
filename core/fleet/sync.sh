#!/usr/bin/env bash
# sync.sh — bring the fleet HOST in line with the pins. Never touches running sessions.
#
# The pins live in the pin repo's .claude/settings.json
# (extraKnownMarketplaces.<name>.source.ref; ENGSYS_MARKETPLACE, and INSTANCE_MARKETPLACE if set).
# This script, idempotently:
#   1. fast-forwards PIN_DIR (the pin repo checkout) so sessions — and this script — see the merged pins
#   2. checks out the INSTANCE repo at the instance pin, then re-execs (skipped when the instance has
#      no INSTANCE_MARKETPLACE)
#   3. checks out ENGSYS_DIR at the engsys pin, then re-execs — the kit's own code lives there
#   4. reinstalls the user-level plugins when a marketplace ref moved (remove -> add #ref -> install
#      each enabled plugin), installs any enabled plugin that's missing, and checks each one is at the
#      pinned version. Every `claude plugin` call is user-scope and runs outside any project; if the
#      pin repo's settings change anyway, sync restores them and fails (engsys#112)
#   5. re-installs the launchd jobs if their templates changed, or the files that decide which sessions
#      run on this host (roster, supervisor conf, registry); and, whatever changed, unloads a supervisor
#      job left installed on a host where no supervised session runs (lib/host-roles.sh)
# Anything that changed is stamped in .fleet/last-change; `fleet restart` uses that stamp to tell which
# running sessions are behind. Running sessions keep their loaded plugins (the old cache dirs stay on
# disk) until restarted.
#
# Usage: sync.sh [--instance <dir>]           # sync
#        sync.sh [--instance <dir>] --check   # report drift only; exit 1 if the host is behind the pins
set -euo pipefail

main() {
  local check=0
  if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) check=1 ;;
      -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
      *) echo "fleet-sync: unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
  # shellcheck source=lib/fleet-env.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
  command -v claude >/dev/null || fleet_die "claude is required"

  # State carried across the re-execs below (a moved checkout means new code, so we start over).
  local resumed="${FLEET_SYNC_RESUMED:-}" prev_instance="${FLEET_SYNC_PREV_INSTANCE:-}" prev_engsys="${FLEET_SYNC_PREV_ENGSYS:-}"
  local changed="${FLEET_SYNC_CHANGED:-0}" drift=0
  unset FLEET_SYNC_RESUMED FLEET_SYNC_PREV_INSTANCE FLEET_SYNC_PREV_ENGSYS FLEET_SYNC_CHANGED

  # --- 1. pin repo checkout (pin source) ---------------------------------------------------------
  if [ -z "$resumed" ]; then
    git -C "$PIN_DIR" rev-parse --git-dir >/dev/null 2>&1 || fleet_die "PIN_DIR is not a git checkout: $PIN_DIR"
    git -C "$PIN_DIR" fetch -q origin
    local pin_branch default_branch
    pin_branch="$(git -C "$PIN_DIR" symbolic-ref --short -q HEAD || echo DETACHED)"
    default_branch="$(git -C "$PIN_DIR" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null || true)"
    default_branch="${default_branch#origin/}"; : "${default_branch:=main}"
    if [ "$(git -C "$PIN_DIR" rev-parse HEAD)" != "$(git -C "$PIN_DIR" rev-parse "origin/$default_branch")" ]; then
      if [ "$check" = 1 ]; then
        say "pin checkout is behind origin/$default_branch"; drift=1
      elif [ "$pin_branch" = "$default_branch" ] && git -C "$PIN_DIR" merge -q --ff-only "origin/$default_branch" 2>/dev/null; then
        say "pin checkout: fast-forwarded to $(git -C "$PIN_DIR" rev-parse --short HEAD)"
      else
        warn "pin checkout ($PIN_DIR) is on '$pin_branch' and can't fast-forward to origin/$default_branch — sessions read pins from its working tree. Using origin/$default_branch's pins; fix the checkout."
        mkdir -p "$FLEET_STATE"
        git -C "$PIN_DIR" show "origin/$default_branch:.claude/settings.json" >"$FLEET_STATE/pins.settings.json"
        PIN_SETTINGS="$FLEET_STATE/pins.settings.json"; export PIN_SETTINGS   # carried across the re-execs below
      fi
    fi
  fi
  fleet_refresh_refs
  local want_engsys="$ENGSYS_REF" want_instance="$INSTANCE_REF"
  [ -n "$want_engsys" ] || fleet_die "no '$ENGSYS_MARKETPLACE' pin found in $PIN_SETTINGS"
  if [ -n "$INSTANCE_MARKETPLACE" ]; then
    [ -n "$want_instance" ] || fleet_die "no '$INSTANCE_MARKETPLACE' pin found in $PIN_SETTINGS"
    say "pins: engsys $want_engsys · $INSTANCE_MARKETPLACE $want_instance   (from $PIN_SETTINGS)"
  else
    say "pins: engsys $want_engsys   (from $PIN_SETTINGS)"
  fi

  # --- 2. the instance repo at its pin (then continue from the NEW checkout) ---------------------
  if [ -n "$INSTANCE_MARKETPLACE" ]; then
    local have_instance
    have_instance="$(fleet_git_at "$FLEET_REPO")"
    if [ "$have_instance" != "$want_instance" ]; then
      if [ "$check" = 1 ]; then
        say "instance checkout is at $have_instance (pin $want_instance)"; drift=1
      else
        [ -z "$prev_instance" ] || fleet_die "instance checkout still at $have_instance after switching to $want_instance"
        require_clean "$FLEET_REPO"
        git -C "$FLEET_REPO" fetch -q --tags origin
        git -C "$FLEET_REPO" checkout -q "$want_instance"
        say "instance: $have_instance → $want_instance"
        FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$have_instance" FLEET_SYNC_CHANGED=1 \
          exec bash "$FLEET_KIT_DIR/sync.sh" --instance "$FLEET_REPO"
      fi
    fi
  fi

  # --- 3. engsys host checkout (the kit's own code — re-exec from it) ----------------------------
  [ -e "$ENGSYS_DIR/.git" ] || fleet_die "engsys checkout not found at $ENGSYS_DIR — git clone <engsys repo> $ENGSYS_DIR"
  local have_engsys
  have_engsys="$(fleet_git_at "$ENGSYS_DIR")"
  if [ "$have_engsys" != "$want_engsys" ]; then
    if [ "$check" = 1 ]; then
      say "engsys checkout is at $have_engsys (pin $want_engsys)"; drift=1
    else
      [ -z "$prev_engsys" ] || fleet_die "engsys checkout still at $have_engsys after switching to $want_engsys"
      require_clean "$ENGSYS_DIR"
      git -C "$ENGSYS_DIR" fetch -q --tags origin
      git -C "$ENGSYS_DIR" checkout -q "$want_engsys"
      say "engsys: $have_engsys → $want_engsys"
      [ -f "$ENGSYS_DIR/core/fleet/sync.sh" ] || fleet_die "engsys $want_engsys has no fleet kit (core/fleet/sync.sh) — the checkout is moved; pin a release that includes it"
      FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$prev_instance" FLEET_SYNC_PREV_ENGSYS="$have_engsys" FLEET_SYNC_CHANGED=1 \
        exec bash "$ENGSYS_DIR/core/fleet/sync.sh" --instance "$FLEET_REPO"
    fi
  fi

  # --- 4. user-level plugins ---------------------------------------------------------------------
  # Everything this step needs from PIN_SETTINGS is read into memory first and never re-read: a
  # `claude plugin` mutation can rewrite project settings (engsys#112). Every `claude plugin` call runs
  # through plugin_cli (user scope, cwd outside any project), and the settings files are guarded.
  local markets=("$ENGSYS_MARKETPLACE") m_refs=() m_repos=() m_plugins=() i m ref repo cur installed p
  [ -z "$INSTANCE_MARKETPLACE" ] || markets+=("$INSTANCE_MARKETPLACE")
  for i in "${!markets[@]}"; do
    m="${markets[$i]}"
    if [ "$m" = "$ENGSYS_MARKETPLACE" ]; then m_refs[i]="$want_engsys"; else m_refs[i]="$want_instance"; fi
    m_repos[i]="$(fleet_pin_repo "$m")"
    [ -n "${m_repos[$i]}" ] || fleet_die "no repo for marketplace '$m' in $PIN_SETTINGS"
    m_plugins[i]="$(fleet_enabled_plugins "$m")"
  done
  sync_tmp
  [ "$check" = 1 ] || settings_guard_begin
  installed="$(user_plugins)"
  for i in "${!markets[@]}"; do
    m="${markets[$i]}" ref="${m_refs[$i]}" repo="${m_repos[$i]}"
    cur="$(plugin_cli marketplace list --json | jq -r --arg m "$m" '.[] | select(.name == $m) | .ref // ""')"
    if [ "$cur" != "$ref" ]; then
      if [ "$check" = 1 ]; then
        say "marketplace $m is at '${cur:-absent}' (pin $ref)"; drift=1; continue
      fi
      # remove uninstalls every plugin from this marketplace; running sessions keep their cache dirs.
      if [ -n "$cur" ]; then plugin_cli marketplace remove "$m" --scope user >/dev/null; settings_guard_check "marketplace remove $m"; fi
      plugin_cli marketplace add "https://github.com/$repo.git#$ref" --scope user >/dev/null \
        || fleet_die "marketplace add $m#$ref failed — $m plugins are UNINSTALLED on this host. Re-run: fleet sync (running sessions are unaffected)."
      settings_guard_check "marketplace add $m"
      say "marketplace $m: ${cur:-absent} → $ref"; changed=1
      installed="$(user_plugins)"
    fi
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      installed_version "$p@$m" "$installed" >/dev/null && continue
      if [ "$check" = 1 ]; then say "plugin $p@$m not installed"; drift=1; continue; fi
      plugin_cli install "$p@$m" --scope user >/dev/null || fleet_die "plugin install $p@$m failed — re-run: fleet sync"
      settings_guard_check "plugin install $p@$m"
      say "installed $p@$m"; changed=1
    done <<<"${m_plugins[$i]}"
  done
  [ "$check" = 1 ] || settings_guard_check "the plugin step"
  # Every enabled plugin must now be installed at user scope, at the pinned version (a vX.Y.Z pin
  # stamps X.Y.Z into every plugin — fleet pin).
  installed="$(user_plugins)"
  local have want bad=""
  for i in "${!markets[@]}"; do
    m="${markets[$i]}" ref="${m_refs[$i]}"
    want=""; [[ "$ref" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]] && want="${ref#v}"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if ! have="$(installed_version "$p@$m" "$installed")"; then
        [ "$check" = 1 ] || bad+=" $p@$m (not installed)"
        continue
      fi
      [ -n "$want" ] && [ "$have" != "$want" ] || continue
      if [ -z "$have" ]; then warn "plugin $p@$m reports no version; can't check it against the pin $ref"; continue; fi
      if [ "$check" = 1 ]; then say "plugin $p@$m is at $have (pin $want)"; drift=1; else bad+=" $p@$m (at $have, pin $want)"; fi
    done <<<"${m_plugins[$i]}"
  done
  [ -z "$bad" ] || fleet_die "after the plugin step these enabled plugins are not installed at the pin:$bad. NOT synced. Re-run: fleet sync. If a plugin stays at the wrong version: claude plugin uninstall --scope user <plugin@marketplace> (from a directory outside any project), then fleet sync."
  GUARDED=(); sync_cleanup; trap - EXIT

  # --- report ------------------------------------------------------------------------------------
  if [ "$check" = 1 ]; then
    if [ "$drift" = 0 ]; then say "host is in sync with the pins"; else say "host is BEHIND the pins — run: fleet sync"; fi
    exit "$drift"
  fi

  # --- 5. launchd jobs, when their templates (or the config they render from) changed ------------
  local jobs_changed=0 fed_rel=()
  case "$FEDERATION_FILE" in "$FLEET_REPO"/*) fed_rel=("${FEDERATION_FILE#"$FLEET_REPO"/}") ;; esac
  if [ -n "$prev_instance" ] && ! git -C "$FLEET_REPO" diff --quiet "$prev_instance" HEAD -- jobs/launchd fleet/fleet.conf fleet/roster.tmpl fleet/supervisor.conf.tmpl ${fed_rel[@]+"${fed_rel[@]}"} 2>/dev/null; then jobs_changed=1; fi
  if [ -n "$prev_engsys" ] && ! git -C "$ENGSYS_DIR" diff --quiet "$prev_engsys" HEAD -- core/fleet/jobs core/fleet/install-jobs.sh core/fleet/lib/host-roles.sh 2>/dev/null; then jobs_changed=1; fi
  if [ "$jobs_changed" = 1 ]; then
    if command -v launchctl >/dev/null 2>&1; then
      say "launchd templates changed — reinstalling jobs"
      bash "$FLEET_KIT_DIR/install-jobs.sh" --instance "$FLEET_REPO"
    else
      say "launchd templates changed, but launchctl isn't available here — run: fleet install-jobs"
    fi
  elif [ -e "$HOME/Library/LaunchAgents/com.${FLEET_ORG}.fleet.fleet-supervisor.plist" ] && command -v launchctl >/dev/null 2>&1; then
    # ROLES / ROSTER_EXCLUDE live in fleet.local.conf, outside any diff: check the supervisor every sync.
    fleet_host_init
    if [ -n "$(fleet_ledger_sessions)" ] && [ -z "$(fleet_host_supervised)" ]; then
      say "the supervisor job is installed, but no supervised session runs on this host: unloading it"
      bash "$FLEET_KIT_DIR/install-jobs.sh" --instance "$FLEET_REPO" --only fleet-supervisor
    fi
  fi

  mkdir -p "$FLEET_STATE"
  if [ "$changed" = 1 ]; then
    date +%s >"$FLEET_STATE/last-change"
    printf '%s engsys=%s %s=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$want_engsys" "${INSTANCE_MARKETPLACE:-instance}" "${want_instance:-none}" >>"$FLEET_STATE/sync.log"
    say "synced. Running sessions are still on the old versions until restarted:"
  else
    say "already in sync."
  fi
  echo
  bash "$FLEET_KIT_DIR/restart.sh" --instance "$FLEET_REPO" --status
}

say() { echo "fleet-sync: $*"; }
warn() { echo "fleet-sync: WARNING $*" >&2; }

# --- the plugin CLI, kept away from project settings (engsys#112) -----------------------------------
# Claude Code applies `claude plugin` changes to the project settings of its cwd too: a `marketplace
# remove` without --scope removes the marketplace and its plugins "from every scope", so run from the pin
# checkout it emptied that repo's .claude/settings.json. So every call passes --scope user where the
# subcommand takes one, and runs from an empty temp dir outside any project.
SYNC_TMP=""
sync_tmp() { # call in the main shell (not in $(…)) so later calls share it; removed on exit
  [ -n "$SYNC_TMP" ] && return
  SYNC_TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/fleet-sync.XXXXXX")" && pwd -P)"
  mkdir -p "$SYNC_TMP/cwd" "$SYNC_TMP/snap"
  trap 'settings_guard_restore >/dev/null || true; sync_cleanup' EXIT
}
plugin_cli() { (cd "$SYNC_TMP/cwd" && claude plugin "$@"); }
user_plugins() { # "<id>\t<version>" for each user-scope install (the list also shows per-project installs)
  plugin_cli list --json | jq -r '.[] | select((.scope // "user") == "user") | [.id, (.version // "")] | @tsv'
}
installed_version() { # installed_version <id> <user_plugins output> → its version; exit 1 if not installed
  awk -F'\t' -v id="$1" '$1 == id { print $2; found = 1; exit } END { exit !found }' <<<"$2"
}

# The project settings files a stray plugin mutation could rewrite: PIN_SETTINGS (which may be a copy) and
# the pin checkout's own files. Snapshot before the plugin step; on any change, put them back and stop.
GUARDED=()
settings_guard_begin() {
  local f g seen i=0
  for f in "$PIN_SETTINGS" "$PIN_DIR/.claude/settings.json" "$PIN_DIR/.claude/settings.local.json"; do
    [ -f "$f" ] || continue
    seen=0; for g in ${GUARDED[@]+"${GUARDED[@]}"}; do [ "$g" != "$f" ] || seen=1; done
    [ "$seen" = 0 ] || continue
    cp -p "$f" "$SYNC_TMP/snap/$i"; GUARDED+=("$f"); i=$((i + 1))
  done
}
settings_guard_restore() { # puts back every guarded file that changed, printing each; exit 1 if none did
  local i restored=0
  for i in ${GUARDED[@]+"${!GUARDED[@]}"}; do
    cmp -s "$SYNC_TMP/snap/$i" "${GUARDED[$i]}" && continue
    cp -p "$SYNC_TMP/snap/$i" "${GUARDED[$i]}"; echo "${GUARDED[$i]}"; restored=1
  done
  [ "$restored" = 1 ]
}
settings_guard_check() { # settings_guard_check <what just ran>
  local touched
  touched="$(settings_guard_restore)" || return 0
  fleet_die "$1 changed project settings (${touched//$'\n'/, }); restored them from the snapshot. NOT synced: plugins on this host may be missing or half-installed. Re-run: fleet sync. If this repeats, the claude CLI is ignoring --scope user — report it (engsys#112)."
}
sync_cleanup() { [ -z "$SYNC_TMP" ] || rm -rf "$SYNC_TMP"; SYNC_TMP=""; }

require_clean() { # tracked changes would block (or be carried across) a checkout
  git -C "$1" diff --quiet && git -C "$1" diff --cached --quiet \
    || fleet_die "$1 has uncommitted changes to tracked files — inspect with: git -C $1 status (discard only if it's noise)"
}

# Wrapped in main so bash parses the whole file before steps 2 and 3 swap this code underneath it.
main "$@"
exit
