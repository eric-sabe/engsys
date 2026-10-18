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
#        sync.sh [--instance <dir>] --no-jobs # never (re)load or unload launchd jobs: what `fleet verify
#                                             # --auto-sync` runs from inside the supervisor job, which a
#                                             # reload would kill. Changed job files are alerted instead.
set -euo pipefail

main() {
  local check=0
  if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) check=1 ;;
      --no-jobs) export FLEET_SYNC_NO_JOBS=1 ;; # carried across the re-execs below
      -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
      *) echo "fleet-sync: unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
  # shellcheck source=lib/fleet-env.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
  if [ "${PRIMARY_HARNESS:-${HARNESS:-claude}}" = "claude" ]; then
    command -v claude >/dev/null || fleet_die "claude is required"
  fi

  # State carried across the re-execs below (a moved checkout means new code, so we start over).
  local resumed="${FLEET_SYNC_RESUMED:-}" prev_instance="${FLEET_SYNC_PREV_INSTANCE:-}" prev_engsys="${FLEET_SYNC_PREV_ENGSYS:-}"
  local changed="${FLEET_SYNC_CHANGED:-0}" drift=0
  unset FLEET_SYNC_RESUMED FLEET_SYNC_PREV_INSTANCE FLEET_SYNC_PREV_ENGSYS FLEET_SYNC_CHANGED

  # --- 1. pin repo checkout (pin source) ---------------------------------------------------------
  if [ -z "$resumed" ]; then
    git -C "$PIN_DIR" rev-parse --git-dir >/dev/null 2>&1 || fleet_die "PIN_DIR is not a git checkout: $PIN_DIR"
    git -C "$PIN_DIR" fetch -q origin
    local pin_branch default_branch
    # Full ref names, never --short: a local branch or tag named origin/<x> makes --short ambiguous.
    pin_branch="$(git -C "$PIN_DIR" symbolic-ref -q HEAD || true)"
    case "$pin_branch" in refs/heads/*) pin_branch="${pin_branch#refs/heads/}" ;; *) pin_branch=DETACHED ;; esac
    default_branch="$(git -C "$PIN_DIR" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
    case "$default_branch" in refs/remotes/origin/?*) default_branch="${default_branch#refs/remotes/origin/}" ;; *) default_branch="" ;; esac
    : "${default_branch:=main}"
    # Fully qualified: a local branch or tag named origin/<x> must never stand in for the remote ref.
    local origin_ref="refs/remotes/origin/$default_branch"
    if [ "$(git -C "$PIN_DIR" rev-parse HEAD)" != "$(git -C "$PIN_DIR" rev-parse --verify -q "$origin_ref^{commit}")" ]; then
      if [ "$check" = 1 ]; then
        say "pin checkout is behind origin/$default_branch"; drift=1
      elif [ "$pin_branch" = "$default_branch" ] && git -C "$PIN_DIR" merge -q --ff-only "$origin_ref" 2>/dev/null; then
        say "pin checkout: fast-forwarded to $(git -C "$PIN_DIR" rev-parse --short HEAD)"
      else
        warn "pin checkout ($PIN_DIR) is on '$pin_branch' and can't fast-forward to origin/$default_branch — sessions read pins from its working tree. Using origin/$default_branch's pins; fix the checkout."
        mkdir -p "$FLEET_STATE"
        git -C "$PIN_DIR" show "$origin_ref:.claude/settings.json" >"$FLEET_STATE/pins.settings.json"
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
  local have_engsys engsys_target="$ENGSYS_DIR"
  if [ "${FLEET_ISOLATE_ENGSYS_WORKTREE:-0}" = 1 ]; then
    engsys_target="$FLEET_STATE/engsys"
    if [ -e "$engsys_target/.git" ]; then
      have_engsys="$(fleet_git_at "$engsys_target")"
    else
      have_engsys="absent"
    fi
    if [ "$have_engsys" != "$want_engsys" ]; then
      if [ "$check" = 1 ]; then
        say "engsys worktree is at $have_engsys (pin $want_engsys)"; drift=1
      else
        [ -z "$prev_engsys" ] || fleet_die "engsys worktree still at $have_engsys after switching to $want_engsys"
        git -C "$ENGSYS_DIR" fetch -q --tags origin 2>/dev/null || true
        mkdir -p "$FLEET_STATE"
        git -C "$ENGSYS_DIR" worktree remove --force "$engsys_target" >/dev/null 2>&1 || rm -rf "$engsys_target"
        git -C "$ENGSYS_DIR" worktree prune
        git -C "$ENGSYS_DIR" worktree add -q --force --detach "$engsys_target" "$want_engsys"
        say "engsys (isolated worktree): $have_engsys → $want_engsys"
        [ -f "$engsys_target/core/fleet/sync.sh" ] || fleet_die "engsys $want_engsys has no fleet kit (core/fleet/sync.sh)"
        FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$prev_instance" FLEET_SYNC_PREV_ENGSYS="$have_engsys" FLEET_SYNC_CHANGED=1 \
          exec bash "$engsys_target/core/fleet/sync.sh" --instance "$FLEET_REPO"
      fi
    fi
  else
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
  fi
  if [ "$check" = 1 ] && [ -e "$engsys_target/.git" ]; then
    local engsys_st=""
    if ! engsys_st="$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$engsys_target" status --porcelain 2>/dev/null)" || [ -n "$engsys_st" ]; then
      say "engsys checkout ($engsys_target) has uncommitted or untracked changes"; drift=1
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
  local primary_h="${PRIMARY_HARNESS:-${HARNESS:-claude}}"
  if [ "$primary_h" = "copilot" ] || [ "$primary_h" = "antigravity" ]; then
    sync_non_claude_plugins "$check" "$engsys_target" "$primary_h" 0
  else
    sync_tmp
    # The fleet's config dir (or ~/.claude when none is set); with FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised
    # the interactive roles run on ~/.claude, so that one gets the pinned plugins too (user scope only).
    local cfg_dirs=("${FLEET_CLAUDE_CONFIG_DIR:-}")
    if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" = supervised ]; then cfg_dirs+=(""); fi
    local cfg_dir
    for cfg_dir in "${cfg_dirs[@]}"; do
      SYNC_CFG="$cfg_dir"
      claude_config_report "$check" || drift=1
      sync_claude_plugins
    done
    SYNC_CFG="${FLEET_CLAUDE_CONFIG_DIR:-}"
    GUARDED=(); sync_cleanup; trap - EXIT
  fi
  if [ -n "${HARNESS_FALLBACK:-}" ]; then
    local fb_item fb_list=()
    IFS=',' read -r -a fb_list <<<"$HARNESS_FALLBACK"
    for fb_item in ${fb_list[@]+"${fb_list[@]}"}; do
      case "$fb_item" in
        copilot | antigravity)
          sync_non_claude_plugins "$check" "$engsys_target" "$fb_item" 1 ;;
      esac
    done
  fi

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
  if [ "${FLEET_SYNC_NO_JOBS:-0}" = 1 ]; then
    if [ "$jobs_changed" = 1 ]; then
      say "launchd job files changed, but this sync runs inside a fleet job (--no-jobs): not reloading them. Run: fleet install-jobs"
      node "$FLEET_KIT_DIR/notify.mjs" --level alert --incident fleet-jobs-changed "Fleet on $(hostname -s 2>/dev/null || echo this host): the pin advanced and the launchd job files changed. The supervisor synced the host but did not reload its own jobs. Please run: fleet install-jobs" >&2 || true
    fi
  elif [ "$jobs_changed" = 1 ]; then
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

# One config dir's plugin step (SYNC_CFG: the dir, '' = ~/.claude). Runs inside main(): it reads and sets
# main's locals (check, markets, m_refs, m_repos, m_plugins, changed, drift) through bash's dynamic scope.
sync_claude_plugins() {
  local i m ref repo cur installed p refused=" "
  # A fleet config dir (never ~/.claude) gets the claude.ai sync switches off, idempotently (engsys#200): without
  # them the first login syncs the account's claude.ai skills and plugins into the fleet dir.
  # An explicit FLEET_CLAUDE_CONFIG_DIR that resolves (realpath, so a symlink too) to ~/.claude is the operator's own
  # dir: never rewrite its settings.json (engsys#204; config-dir.sh refuses it the same way).
  local own_cfg=0
  if [ -n "$SYNC_CFG" ] && [ "$(cd "$SYNC_CFG" 2>/dev/null && pwd -P || echo "$SYNC_CFG")" = "$(cd "$HOME/.claude" 2>/dev/null && pwd -P || echo "$HOME/.claude")" ]; then
    own_cfg=1
    [ "$check" = 1 ] || warn "FLEET_CLAUDE_CONFIG_DIR $SYNC_CFG is your own ~/.claude: leaving its settings.json alone (the claude.ai sync switches stay as they are). Point it at a separate dir (fleet config-dir init)."
  fi
  if [ "$check" != 1 ] && [ "$own_cfg" = 0 ] && [ -n "$SYNC_CFG" ] && [ -f "$SYNC_CFG/settings.json" ] && jq -e 'type == "object"' "$SYNC_CFG/settings.json" >/dev/null 2>&1 \
    && ! jq -e '.syncClaudeAiSkills == false and .syncClaudeAiPlugins == false' "$SYNC_CFG/settings.json" >/dev/null 2>&1; then
    local sj_tmp; sj_tmp="$(mktemp "$SYNC_CFG/.settings.json.XXXXXX")"   # mktemp makes it 0600, like the seeded file
    jq '. + {syncClaudeAiSkills: false, syncClaudeAiPlugins: false}' "$SYNC_CFG/settings.json" >"$sj_tmp" \
      && mv "$sj_tmp" "$SYNC_CFG/settings.json" && say "$SYNC_CFG/settings.json: syncClaudeAiSkills / syncClaudeAiPlugins set to false"
  fi
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
    # In ~/.claude under scope supervised (the operator's own dir) that is allowed only when it takes
    # nothing but the fleet's own installs, which are reinstalled at the pin right after: a pinned plugin
    # at user scope, or at project scope for PIN_DIR itself. Another plugin of this marketplace, or a
    # project-scope install for any other project, makes the step refuse (drift, not damage).
    if [ -n "$cur" ] && [ -z "$SYNC_CFG" ] && [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then
      local keep pin_real
      pin_real="$(cd "$PIN_DIR" 2>/dev/null && pwd -P || printf '%s' "$PIN_DIR")"
      keep="$(plugin_cli list --json | jq -r --arg m "$m" --arg pin "$PIN_DIR" --arg pinr "$pin_real" --arg pins "$(printf '%s\n' "${m_plugins[$i]}")" '
        ($pins | split("\n") | map(select(length > 0))) as $p
        | .[] | select((.id // "") | endswith("@" + $m))
        | ((.id | sub("@" + $m + "$"; "")) as $n | ($p | index($n)) != null) as $pinned
        | ((.scope // "user") == "user") as $user
        | ((.scope // "") == "project" and ((.projectPath // "") == $pin or (.projectPath // "") == $pinr)) as $ours
        | select(($pinned and ($user or $ours)) | not)
        | "\(.id) (\(.scope // "user")\(if .projectPath then " " + .projectPath else "" end))"' | paste -sd, - | sed 's/,/, /g')"
      if [ -n "$keep" ]; then
        warn "marketplace $m in ~/.claude is at '$cur' (pin $ref), but moving it would uninstall plugins the fleet doesn't pin: $keep. Not moving it. Either uninstall those plugins (claude plugin uninstall <plugin> --scope <scope>), or move it yourself (claude plugin marketplace remove $m, then claude plugin marketplace add https://github.com/$repo.git#$ref and reinstall what you need), then fleet sync."
        drift=1; refused+=" $m "; continue
      fi
    fi
    if [ -n "$cur" ]; then marketplace_remove "$m"; settings_guard_check "marketplace remove $m"; fi
      plugin_cli marketplace add "https://github.com/$repo.git#$ref" --scope user >/dev/null \
        || fleet_die "marketplace add $m#$ref failed — $m plugins are UNINSTALLED on this host. Re-run: fleet sync (running sessions are unaffected)."
      settings_guard_check "marketplace add $m"
      say "marketplace $m: ${cur:-absent} → $ref"; changed=1
      installed="$(user_plugins)"
    fi
    case "$refused" in *" $m "*) continue ;; esac
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
    case "$refused" in *" $m "*) continue ;; esac   # refused above, with a warning: drift, not a failure
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
# The fleet's own Claude config dir when fleet.conf sets FLEET_CLAUDE_CONFIG_DIR (its user-scope plugins are
# what every fleet session loads), else the account's ~/.claude; never an inherited CLAUDE_CONFIG_DIR.
SYNC_CFG="${FLEET_CLAUDE_CONFIG_DIR:-}"   # the config dir the plugin step works on ('' = ~/.claude)
fleet_claude() {
  if [ -n "$SYNC_CFG" ]; then CLAUDE_CONFIG_DIR="$SYNC_CFG" claude "$@"
  else env -u CLAUDE_CONFIG_DIR claude "$@"; fi
}
plugin_cli() { (cd "$SYNC_TMP/cwd" && fleet_claude plugin "$@"); }
# A marketplace that only a project's settings declare (extraKnownMarketplaces) is not "declared in user
# settings", so `remove --scope user` refuses it (engsys#200). Retry once without --scope, which removes it
# from every scope; still from the empty cwd, and the pre-remove check above has already ruled out losing
# plugins the fleet doesn't reinstall. Any other failure stays fatal.
marketplace_remove() {
  local m="$1" err rc=0
  err="$(plugin_cli marketplace remove "$m" --scope user 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" = 0 ]; then [ -z "$err" ] || printf '%s\n' "$err" >&2; return 0; fi   # warnings stay visible
  case "$err" in
    *"not declared in user settings"*)
      printf '%s\n' "$err" >&2   # the refusal itself, then the retry below
      # Unscoped remove also uninstalls the marketplace's plugins at project scope. Refuse when another project
      # (anything but PIN_DIR itself, whose installs sync reinstalls) has one, as seen by the config dir being synced.
      local others pin_real
      pin_real="$(cd "$PIN_DIR" 2>/dev/null && pwd -P || printf '%s' "$PIN_DIR")"
      others="$(plugin_cli list --json | jq -r --arg m "$m" --arg pin "$PIN_DIR" --arg pinr "$pin_real" '
        .[] | select((.id // "") | endswith("@" + $m)) | select((.scope // "") == "project" and (.projectPath // "") != $pin and (.projectPath // "") != $pinr)
        | "\(.id) (\(.projectPath // "?"))"' | paste -sd, - | sed 's/,/, /g')"
      if [ -n "$others" ]; then
        fleet_die "marketplace $m is declared only by project settings, and removing it from every scope would uninstall plugins of other projects: $others. Not moving it. Uninstall those (claude plugin uninstall <plugin> --scope project, from that project), then fleet sync."
      fi
      plugin_cli marketplace remove "$m" >/dev/null ;;
    *) printf '%s\n' "$err" >&2; return "$rc" ;;
  esac
}
# claude_config_report <check> → which config dir the fleet uses and whether it is logged in (no account
# details, no token). A FLEET_CLAUDE_CONFIG_DIR that doesn't exist stops a sync: create it and log in first.
claude_config_report() {
  local dir="${SYNC_CFG:-$HOME/.claude}" li what
  if [ -n "$SYNC_CFG" ] && [ "$SYNC_CFG" = "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then what=" (FLEET_CLAUDE_CONFIG_DIR)"; [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" != supervised ] || what=" (FLEET_CLAUDE_CONFIG_DIR, scope supervised)"
  elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then what=" (interactive roles)"
  else what=""; fi
  if [ -n "$SYNC_CFG" ] && [ ! -d "$SYNC_CFG" ]; then
    [ "$1" = 1 ] || fleet_die "FLEET_CLAUDE_CONFIG_DIR $SYNC_CFG does not exist. One-time setup: fleet config-dir init, log in with CLAUDE_CONFIG_DIR=$SYNC_CFG claude, then fleet sync (fleet guide § 6.1)"
    say "claude config dir: $dir$what does not exist"; return 1
  fi
  li="$( (cd "$SYNC_TMP/cwd" && fleet_claude auth status --json) 2>/dev/null | jq -r 'if .loggedIn == true then "logged in" elif .loggedIn == false then "NOT logged in" else "login unknown" end' 2>/dev/null || true)"
  say "claude config dir: $dir$what, ${li:-login unknown}"
  if [ "$li" = "NOT logged in" ]; then
    if [ -n "$SYNC_CFG" ]; then
      warn "the fleet's Claude config dir is not logged in: CLAUDE_CONFIG_DIR=$dir claude, then /login. Until then fleet verify holds merge and maintain launches (and alerts)."
      return 1
    fi
    warn "$dir is not logged in: claude, then /login"
  fi
  return 0
}
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

sync_non_claude_plugins() { # sync_non_claude_plugins <check> <engsys_target> [target_harness] [is_fallback]
  local check_mode="$1" engsys_checkout="$2" target_h="${3:-${HARNESS:-claude}}" is_fb="${4:-0}" i m ref want p src_repo sub cache_dir cfg_file cur_ver
  local entries="[]"
  if [ "$target_h" = "copilot" ]; then
    cfg_file="${COPILOT_HOME:-$FLEET_STATE/copilot-home}/config.json"
  elif [ "$is_fb" = 1 ] && [ ! -d "$PIN_DIR/.agents" ]; then
    cfg_file="$FLEET_STATE/agy-plugins.json"
  else
    cfg_file="$PIN_DIR/.agents/plugins.json"
  fi
  for i in "${!markets[@]}"; do
    m="${markets[$i]}" ref="${m_refs[$i]}"
    want="${ref#v}"
    if [ "$m" = "$ENGSYS_MARKETPLACE" ]; then src_repo="$engsys_checkout"; else src_repo="$FLEET_REPO"; fi
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      [[ "$m" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$m" != "." ] && [ "$m" != ".." ] || fleet_die "unsafe marketplace name in settings: $m"
      [[ "$p" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$p" != "." ] && [ "$p" != ".." ] || fleet_die "unsafe plugin name in settings: $p"
      sub="$(jq -r --arg p "$p" '.plugins[]? | select(.name == $p) | .source // empty' "$src_repo/.claude-plugin/marketplace.json" 2>/dev/null || true)"
      sub="${sub#./}"
      [ -n "$sub" ] || sub="core"
      if [ "$target_h" = "copilot" ]; then
        cache_dir="${COPILOT_HOME:-$FLEET_STATE/copilot-home}/installed-plugins/$m/$p"
        cur_ver=""
        if [ -f "$cfg_file" ]; then
          cur_ver="$(sed '/^[[:space:]]*\/\//d' "$cfg_file" | jq -r --arg n "$p" --arg m "$m" '.installedPlugins[]? | select(.name == $n and .marketplace == $m) | .version // empty' 2>/dev/null || true)"
        fi
      else
        cache_dir="$FLEET_STATE/agy-plugins/$m/$p/$want"
        cur_ver=""
        if [ -f "$cfg_file" ]; then
          cur_ver="$(jq -r --arg id "$p@$m" '(.plugins // .)[]? | select(.id == $id) | .version // empty' "$cfg_file" 2>/dev/null || true)"
        fi
      fi
      if [ "$cur_ver" != "$want" ] || [ ! -d "$cache_dir" ]; then
        if [ "$check_mode" = 1 ]; then
          say "plugin $p@$m ($target_h) is at '${cur_ver:-absent}' (pin $want)"; drift=1
          continue
        fi
        [ -d "$src_repo/$sub" ] && [ ! -L "$src_repo/$sub" ] || fleet_die "plugin source $src_repo/$sub not found for $p@$m"
        src_root_real="$(cd "$src_repo" && pwd -P)"
        src_sub_real="$(cd "$src_repo/$sub" && pwd -P)"
        case "$src_sub_real/" in
          "$src_root_real/"*) ;;
          *) fleet_die "plugin source $src_repo/$sub escapes repository root for $p@$m" ;;
        esac
        if [ -n "$(find "$src_repo/$sub" -type l -print -quit 2>/dev/null)" ]; then
          fleet_die "plugin source $src_repo/$sub contains symlinks for $p@$m"
        fi
        rm -rf "$cache_dir"
        mkdir -p "$(dirname "$cache_dir")"
        cp -R "$src_repo/$sub" "$cache_dir"
        say "installed $p@$m ($want) -> $cache_dir"; changed=1
      fi
      entries="$(jq -cn --argjson arr "$entries" --arg id "$p@$m" --arg n "$p" --arg m "$m" --arg v "$want" --arg c "$cache_dir" \
        '$arr + [{id: $id, name: $n, marketplace: $m, version: $v, scope: "user", enabled: true, installPath: $c, cache_path: $c}]')"
    done <<<"${m_plugins[$i]}"
  done
  if [ "$check_mode" = 0 ]; then
    mkdir -p "$(dirname "$cfg_file")"
    if [ "$target_h" = "copilot" ]; then
      existing_cfg="{}"
      if [ -f "$cfg_file" ]; then
        existing_cfg="$(sed '/^[[:space:]]*\/\//d' "$cfg_file" | jq -c 'if type == "object" then . else {} end' 2>/dev/null || echo "{}")"
      fi
      {
        echo "// Managed by fleet sync (HARNESS=copilot)"
        jq -n --argjson base "$existing_cfg" --argjson p "$entries" '$base + {installedPlugins: $p}'
      } >"$cfg_file"
    else
      jq -n --argjson p "$entries" '{plugins: $p}' >"$cfg_file"
      mkdir -p "$FLEET_STATE"
      if [ "$cfg_file" != "$FLEET_STATE/agy-plugins.json" ]; then
        cp "$cfg_file" "$FLEET_STATE/agy-plugins.json" 2>/dev/null || true
      fi
    fi
  fi
}

# Wrapped in main so bash parses the whole file before steps 2 and 3 swap this code underneath it.
main "$@"
exit
