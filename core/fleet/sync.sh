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
#      (steps 2 and 3 treat a pinned release tag that was re-cut on origin as a move too: the local copy of the tag is
#      compared with origin's, and the checkout, or the isolated worktree, follows origin's commit)
#   4. reinstalls the user-level plugins when a marketplace ref moved (remove -> add #ref -> install
#      each enabled plugin), installs any enabled plugin that's missing, and checks each one is at the
#      pinned version. Every `claude plugin` call is user-scope and runs outside any project; if the
#      pin repo's settings change anyway, sync restores them and fails (engsys#112)
#   5. re-installs the launchd jobs if their templates changed, or the files that decide which sessions
#      run on this host (roster, supervisor conf, registry); and, whatever changed, unloads a supervisor
#      job left installed on a host where no supervised session runs (lib/host-roles.sh)
# With FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on (engsys#205) step 4 runs in every session's own config dir
# (<FLEET_CLAUDE_CONFIG_DIR>.sessions/<name>; one that does not exist yet is reported as drift and skipped),
# each with its own login report.
# A RUNNING session's own dir is left alone (engsys#253): a second claude process on its login can rotate the refresh
# token out from under the session (anthropics/claude-code#88583), and `claude auth status` / `plugin list` /
# `marketplace` / `install` are all such processes. Sync reads that dir's files instead; one that is behind is skipped,
# reported as "running — restart to pick up" and recorded in .fleet/sync-deferred; the dir is synced when the session is down, right before it starts again
# (`fleet launch`, and the supervisor's `fleet verify --auto-sync --session`, both run `sync.sh --session <name>`). So
# `fleet sync`, then `fleet restart --stale` is still the whole pin cycle. `--check` (what `fleet status` runs) reads a
# running session's dir from its files (lib/plugin-list-from-files.mjs) and skips the login check, so it starts no
# claude on it either. (A shared dir, FLEET_CLAUDE_CONFIG_DIR without per-session mode or ~/.claude, is synced and
# checked as before: its sessions share one login and race each other anyway; per-session mode is the fix for that.)
# Anything that changed is stamped in .fleet/last-change; `fleet restart` uses that stamp to tell which
# running sessions are behind. Running sessions keep their loaded plugins (the old cache dirs stay on
# disk) until restarted.
#
# Usage: sync.sh [--instance <dir>]           # sync
#        sync.sh [--instance <dir>] --check   # report drift only; exit 1 if the host is behind the pins
#        sync.sh [--instance <dir>] --no-jobs # never (re)load or unload launchd jobs: what `fleet verify
#                                             # --auto-sync` runs from inside the supervisor job, which a
#                                             # reload would kill. Changed job files are alerted instead.
#        sync.sh [--instance <dir>] --include-running
#                                             # RISKY: sync running sessions' own dirs too (claude on their live
#                                             # logins; it can log a session out). Only when a restart is not an option.
#        sync.sh [--instance <dir>] --session <name> [--no-jobs]
#                                             # (per-session mode) just that session's own dir, at the pins as
#                                             # they stand; no checkouts, no jobs. Refused while it runs.
set -euo pipefail

main() {
  local check=0 only_session=""
  if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
  # only the flag sets it (an inherited value is dropped); it is carried across the re-execs below
  [ -n "${FLEET_SYNC_RESUMED:-}" ] || unset FLEET_SYNC_INCLUDE_RUNNING
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) check=1 ;;
      --no-jobs) export FLEET_SYNC_NO_JOBS=1 ;; # carried across the re-execs below
      --include-running) export FLEET_SYNC_INCLUDE_RUNNING=1 ;;
      --session) only_session="${2:?--session needs a session name}"; shift ;;
      -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
      *) echo "fleet-sync: unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
  # shellcheck source=lib/fleet-env.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
  # shellcheck source=lib/session-dirs.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/session-dirs.sh"
  if [ "${PRIMARY_HARNESS:-${HARNESS:-claude}}" = "claude" ]; then
    command -v claude >/dev/null || fleet_die "claude is required"
  fi
  if [ -n "$only_session" ]; then
    [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ] && [ "${PRIMARY_HARNESS:-${HARNESS:-claude}}" = claude ] \
      || fleet_die "--session needs FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on (and the claude harness)"
    fleet_roster_prepare
    local own_names; own_names="$(fleet_session_dir_names --include-excluded)"   # captured: grep -q would SIGPIPE the producer
    fleet_session_config_dir "$only_session" >/dev/null && grep -Fxq -- "$only_session" <<<"$own_names" \
      || fleet_die "--session $only_session: not a session on this host that uses the fleet's config dir"
    if [ "$check" = 0 ] && [ "${FLEET_SYNC_INCLUDE_RUNNING:-0}" != 1 ] && fleet_session_alive "$only_session"; then
      fleet_die "session $only_session is running: its dir is synced when it restarts (fleet restart $only_session)"
    fi
  fi

  # State carried across the re-execs below (a moved checkout means new code, so we start over).
  local resumed="${FLEET_SYNC_RESUMED:-}" prev_instance="${FLEET_SYNC_PREV_INSTANCE:-}" prev_engsys="${FLEET_SYNC_PREV_ENGSYS:-}"
  local changed="${FLEET_SYNC_CHANGED:-0}" drift=0 deferred=
  unset FLEET_SYNC_RESUMED FLEET_SYNC_PREV_INSTANCE FLEET_SYNC_PREV_ENGSYS FLEET_SYNC_CHANGED
  # recut_markets: the marketplaces whose pinned tag was re-cut and adopted (engsys#219). The ref and the plugin version are
  # unchanged, so step 4 would see nothing to do: it reinstalls these anyway. The list lives on disk (pin-recut.reinstall)
  # until every config dir and cache this sync covers has been reinstalled, so a sync that was interrupted, or that had to
  # refuse a marketplace, is finished by the next one. recut_keep: what this run could not finish (' * ' = a whole dir).
  # Each config dir and cache that has been reinstalled is recorded in pin-recut.done (engsys#253): it is not reinstalled
  # again, so a dir left to a running session's restart (and reinstalled by it) does not keep the others churning.
  local recut_markets="" recut_keep="" recut_file="$FLEET_STATE/pin-recut.reinstall" rm_line
  if [ -f "$recut_file" ]; then
    while IFS= read -r rm_line; do
      [[ "$rm_line" =~ ^[A-Za-z0-9._-]+$ ]] && recut_markets+=" $rm_line"
    done <"$recut_file"
  fi
  # engsys#217: an alert that could not be delivered when a pinned tag moved is retried here
  [ "$check" = 1 ] || pin_moved_flush

  # --- 1. pin repo checkout (pin source) ---------------------------------------------------------
  # --session: one session's dir at the pins as they stand; steps 1-3 (and 5) are the full sync's
  if [ -z "$resumed" ] && [ -z "$only_session" ]; then
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
  if [ -n "$INSTANCE_MARKETPLACE" ] && [ -z "$only_session" ]; then
    local have_instance irecut=0
    have_instance="$(fleet_git_at "$FLEET_REPO")"
    # engsys#216: HEAD can sit on a stale local copy of the pinned instance tag too (a re-cut release)
    if fleet_pin_recut "$FLEET_REPO" "$have_instance" "$want_instance"; then irecut=1; fi
    if [ "$have_instance" != "$want_instance" ] || [ "$irecut" = 1 ]; then
      if [ "$check" = 1 ]; then
        if [ "$irecut" = 1 ]; then say "instance checkout is at a stale local copy of $want_instance (origin's tag moved: re-cut release)"
        else say "instance checkout is at $have_instance (pin $want_instance)"; fi
        drift=1
      else
        [ -z "$prev_instance" ] || fleet_die "instance checkout still at $have_instance after switching to $want_instance"
        require_clean "$FLEET_REPO"
        # after a re-cut the tag name no longer names the old commit, so the re-exec's job diff needs the sha
        [ "$irecut" = 0 ] || have_instance="$(git -C "$FLEET_REPO" rev-parse HEAD)"
        # recorded before the fetch moves the local tag: a sync killed after it still reinstalls the plugins next time
        [ "$irecut" = 0 ] || recut_note "$INSTANCE_MARKETPLACE"
        fleet_fetch_tags "$FLEET_REPO" "$want_instance" || fleet_die "could not fetch the instance tags into $FLEET_REPO (see above)"
        # the alert goes out from the code that is running now, before the checkout moves to the re-cut commit
        if [ "$irecut" = 1 ]; then
          pin_moved_alert instance "$want_instance" "$have_instance" "$(git -C "$FLEET_REPO" rev-parse -q --verify "refs/tags/$want_instance^{commit}" || true)"
        fi
        git -C "$FLEET_REPO" checkout -q "$want_instance"
        if [ "$irecut" = 1 ]; then say "instance: $want_instance was re-cut upstream; moved the checkout to origin's commit"; else say "instance: $have_instance → $want_instance"; fi
        FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$have_instance" FLEET_SYNC_CHANGED=1 \
          exec bash "$FLEET_KIT_DIR/sync.sh" --instance "$FLEET_REPO"
      fi
    fi
  fi

  # --- 3. engsys host checkout (the kit's own code — re-exec from it) ----------------------------
  [ -e "$ENGSYS_DIR/.git" ] || fleet_die "engsys checkout not found at $ENGSYS_DIR — git clone <engsys repo> $ENGSYS_DIR"
  local have_engsys engsys_target="$ENGSYS_DIR"
  if [ -n "$only_session" ]; then
    :
  elif [ "${FLEET_ISOLATE_ENGSYS_WORKTREE:-0}" = 1 ]; then
    engsys_target="$FLEET_STATE/engsys"
    if [ -e "$engsys_target/.git" ]; then
      have_engsys="$(fleet_git_at "$engsys_target")"
    else
      have_engsys="absent"
    fi
    # engsys#216: the worktree can sit on a stale copy of the pinned tag too; the tags live in the repo it shares with ENGSYS_DIR
    local wrecut=0
    if fleet_pin_recut "$ENGSYS_DIR" "$have_engsys" "$want_engsys"; then wrecut=1; fi
    if [ "$have_engsys" != "$want_engsys" ] || [ "$wrecut" = 1 ]; then
      if [ "$check" = 1 ]; then
        if [ "$wrecut" = 1 ]; then say "engsys worktree is at a stale local copy of $want_engsys (origin's tag moved: re-cut release)"
        else say "engsys worktree is at $have_engsys (pin $want_engsys)"; fi
        drift=1
      else
        [ -z "$prev_engsys" ] || fleet_die "engsys worktree still at $have_engsys after switching to $want_engsys"
        [ "$wrecut" = 0 ] || have_engsys="$(git -C "$engsys_target" rev-parse HEAD)"
        # recorded before the fetch moves the local tag: a sync killed after it still reinstalls the plugins next time
        [ "$wrecut" = 0 ] || recut_note "$ENGSYS_MARKETPLACE"
        fleet_fetch_tags "$ENGSYS_DIR" "$want_engsys" || fleet_die "could not fetch the engsys tags into $ENGSYS_DIR (see above)"
        if [ "$wrecut" = 1 ]; then
          pin_moved_alert engsys "$want_engsys" "$have_engsys" "$(git -C "$ENGSYS_DIR" rev-parse -q --verify "refs/tags/$want_engsys^{commit}" || true)"
        fi
        mkdir -p "$FLEET_STATE"
        git -C "$ENGSYS_DIR" worktree remove --force "$engsys_target" >/dev/null 2>&1 || rm -rf "$engsys_target"
        git -C "$ENGSYS_DIR" worktree prune
        git -C "$ENGSYS_DIR" worktree add -q --force --detach "$engsys_target" "$want_engsys"
        if [ "$wrecut" = 1 ]; then say "engsys (isolated worktree): $want_engsys was re-cut upstream; moved the worktree to origin's commit"; else say "engsys (isolated worktree): $have_engsys → $want_engsys"; fi
        [ -f "$engsys_target/core/fleet/sync.sh" ] || fleet_die "engsys $want_engsys has no fleet kit (core/fleet/sync.sh)"
        FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$prev_instance" FLEET_SYNC_PREV_ENGSYS="$have_engsys" FLEET_SYNC_CHANGED=1 \
          exec bash "$engsys_target/core/fleet/sync.sh" --instance "$FLEET_REPO"
      fi
    fi
  else
    have_engsys="$(fleet_git_at "$ENGSYS_DIR")"
    local recut=0
    # engsys#214: HEAD can sit on a stale local copy of the pinned tag (a re-cut release); compare it with origin's
    if fleet_pin_recut "$ENGSYS_DIR" "$have_engsys" "$want_engsys"; then recut=1; fi
    if [ "$have_engsys" != "$want_engsys" ] || [ "$recut" = 1 ]; then
      if [ "$check" = 1 ]; then
        if [ "$recut" = 1 ]; then say "engsys checkout is at a stale local copy of $want_engsys (origin's tag moved: re-cut release)"
        else say "engsys checkout is at $have_engsys (pin $want_engsys)"; fi
        drift=1
      else
        [ -z "$prev_engsys" ] || fleet_die "engsys checkout still at $have_engsys after switching to $want_engsys"
        require_clean "$ENGSYS_DIR"
        # after a re-cut the tag name no longer names the old commit, so the re-exec's job diff needs the sha
        [ "$recut" = 0 ] || have_engsys="$(git -C "$ENGSYS_DIR" rev-parse HEAD)"
        # recorded before the fetch moves the local tag: a sync killed after it still reinstalls the plugins next time
        [ "$recut" = 0 ] || recut_note "$ENGSYS_MARKETPLACE"
        fleet_fetch_tags "$ENGSYS_DIR" "$want_engsys" || fleet_die "could not fetch the engsys tags into $ENGSYS_DIR (see above)"
        # engsys#217: the alert goes out from the code that is running now, before the checkout moves to the re-cut commit
        if [ "$recut" = 1 ]; then
          pin_moved_alert engsys "$want_engsys" "$have_engsys" "$(git -C "$ENGSYS_DIR" rev-parse -q --verify "refs/tags/$want_engsys^{commit}" || true)"
        fi
        git -C "$ENGSYS_DIR" checkout -q "$want_engsys"
        if [ "$recut" = 1 ]; then say "engsys: $want_engsys was re-cut upstream; moved the checkout to origin's commit"; else say "engsys: $have_engsys → $want_engsys"; fi
        [ -f "$ENGSYS_DIR/core/fleet/sync.sh" ] || fleet_die "engsys $want_engsys has no fleet kit (core/fleet/sync.sh) — the checkout is moved; pin a release that includes it"
        FLEET_SYNC_RESUMED=1 FLEET_SYNC_PREV_INSTANCE="$prev_instance" FLEET_SYNC_PREV_ENGSYS="$have_engsys" FLEET_SYNC_CHANGED=1 \
          exec bash "$ENGSYS_DIR/core/fleet/sync.sh" --instance "$FLEET_REPO"
      fi
    fi
  fi
  if [ "$check" = 1 ] && [ -z "$only_session" ] && [ -e "$engsys_target/.git" ]; then
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
    local cfg_dirs=("${FLEET_CLAUDE_CONFIG_DIR:-}") sess_n
    if [ -n "$only_session" ]; then
      cfg_dirs=("$(fleet_session_config_dir "$only_session")")
      # this run covers one dir: a re-cut reinstall pending for the others stays pending
      recut_keep=" * "
    elif [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ]; then
      # one login per session (engsys#205): the pinned plugins go into every session's own dir, not a shared one
      cfg_dirs=()
      fleet_roster_prepare
      while IFS= read -r sess_n; do
        [ -z "$sess_n" ] || cfg_dirs+=("$(fleet_session_config_dir "$sess_n")")
      done < <(fleet_session_dir_names)
      [ "${#cfg_dirs[@]}" -gt 0 ] || fleet_die "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, but no session on this host uses the fleet's config dir"
    fi
    if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" = supervised ] && [ -z "$only_session" ]; then cfg_dirs+=(""); fi
    local cfg_dir ps_bad="" own_sess drift_before
    for cfg_dir in "${cfg_dirs[@]}"; do
      SYNC_CFG="$cfg_dir" SYNC_LIVE=0 own_sess=""
      [ -z "$cfg_dir" ] || [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" != on ] || own_sess="${cfg_dir##*/}"
      if [ -n "$own_sess" ] && [ -d "$cfg_dir" ] && fleet_session_alive "$own_sess"; then
        SYNC_LIVE=1
        if [ "$check" = 0 ] && [ "${FLEET_SYNC_INCLUDE_RUNNING:-0}" != 1 ]; then
          # read from its files whether it is behind at all (a subshell: --check's own logic, quiet; unreadable = behind)
          if ( check=1 drift=0; sync_claude_plugins >/dev/null 2>&1; [ "$drift" = 0 ] ); then
            say "claude config dir: $cfg_dir (session $own_sess, own login): session running, its dir is at the pins"
            fleet_sync_deferred_set drop "$own_sess"
          else
            say "claude config dir: $cfg_dir (session $own_sess, own login): session running, not synced now — restart to pick up (fleet restart --stale, or fleet restart $own_sess)"
            fleet_sync_deferred_set add "$own_sess"; deferred+=" $own_sess"; recut_keep=" * "
          fi
          continue
        fi
        if [ "$check" = 0 ]; then   # --include-running: as before engsys#253, the CLI on the live login
          warn "--include-running: syncing $cfg_dir while session $own_sess runs on it; a second claude on its login can log it out (anthropics/claude-code#88583)"
          SYNC_LIVE=0
        fi
      fi
      # a session dir that does not exist yet must not stop the other sessions' sync: report it as drift
      if [ -n "$cfg_dir" ] && [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ] && [ ! -d "$cfg_dir" ]; then
        say "claude config dir: $cfg_dir (session ${cfg_dir##*/}) does not exist"
        warn "session ${cfg_dir##*/} has no config dir yet: fleet config-dir init --session ${cfg_dir##*/}, then log in with CLAUDE_CONFIG_DIR=$cfg_dir claude (fleet guide § 6.1). Its plugins are not synced."
        drift=1; ps_bad="$ps_bad ${cfg_dir##*/}"; recut_keep=" * "; continue
      fi
      drift_before="$drift"
      if ! claude_config_report "$check"; then
        drift=1
        [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" != on ] || ps_bad="$ps_bad ${cfg_dir##*/}"
      fi
      sync_claude_plugins
      # --check: a running session's own dir that is behind waits for its restart (sync leaves it alone), not for a sync
      if [ "$check" = 1 ] && [ "$SYNC_LIVE" = 1 ] && [ -n "$own_sess" ] && [ "$drift" = 1 ] && [ "$drift_before" = 0 ]; then
        drift=0; deferred+=" $own_sess"
      fi
      [ "$check" = 1 ] || [ -z "$own_sess" ] || fleet_sync_deferred_set drop "$own_sess"
    done
    # engsys#212: turning the flag on before the dirs exist and are logged in is the common adoption slip; say so once
    if [ -n "$ps_bad" ]; then
      warn "FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, but these sessions have no config dir or no login yet:$ps_bad. $(fleet_config_dir_fix)"
    fi
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

  [ "$check" = 1 ] || [ -z "$recut_markets" ] || recut_settle

  # --- report ------------------------------------------------------------------------------------
  if [ "$check" = 1 ]; then
    if [ "$drift" = 0 ]; then say "host is in sync with the pins"; else say "host is BEHIND the pins — run: fleet sync"; fi
    [ -z "$deferred" ] || say "running, behind the pins until restarted:$deferred (fleet restart --stale; their dirs are synced as they relaunch)"
    exit "$drift"
  fi
  if [ -n "$only_session" ]; then
    # it started while this ran: its dir was left alone, like any running session's (and stays recorded for its restart)
    [ -z "$deferred" ] || fleet_die "session $only_session started while its dir was being synced: left behind the pins until it restarts (fleet restart $only_session)"
    say "session $only_session: its config dir is at the pins"
    exit 0
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
  [ -z "$deferred" ] || say "not synced, running:$deferred. Each one's dir is synced when it restarts (fleet restart --stale), before the new process starts. To sync them now anyway: fleet sync --include-running (risky: a second claude on a live login can log the session out)"
  echo
  bash "$FLEET_KIT_DIR/restart.sh" --instance "$FLEET_REPO" --status
}

# One config dir's plugin step (SYNC_CFG: the dir, '' = ~/.claude). Runs inside main(): it reads and sets
# main's locals (check, markets, m_refs, m_repos, m_plugins, changed, drift) through bash's dynamic scope.
sync_claude_plugins() {
  local i m ref repo cur installed p moved refused=" "
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
    cur="$(marketplace_list_json | jq -r --arg m "$m" '.[] | select(.name == $m) | .ref // ""')"
    # engsys#219: a re-cut pinned tag moved the checkout to a new commit under the same ref, so the installed plugin files are
    # behind it although the marketplace ref and the plugin version still match: reinstall this marketplace like a moved ref
    moved=0; ! recut_pending "$m" "${SYNC_CFG:-$HOME/.claude}" || moved=1
    if [ "$cur" != "$ref" ] || [ "$moved" = 1 ]; then
      if [ "$check" = 1 ]; then
        if [ "$moved" = 1 ] && [ "$cur" = "$ref" ]; then say "marketplace $m is waiting for a plugin reinstall (its pinned tag was re-cut)"
        else say "marketplace $m is at '${cur:-absent}' (pin $ref)"; fi
        drift=1; continue
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
        drift=1; refused+=" $m "; recut_keep+=" $m "; continue
      fi
    fi
    if [ -n "$cur" ]; then marketplace_remove "$m"; settings_guard_check "marketplace remove $m"; fi
      plugin_cli marketplace add "https://github.com/$repo.git#$ref" --scope user >/dev/null \
        || fleet_die "marketplace add $m#$ref failed — $m plugins are UNINSTALLED on this host. Re-run: fleet sync (running sessions are unaffected)."
      settings_guard_check "marketplace add $m"
      if [ "$moved" = 1 ] && [ "$cur" = "$ref" ]; then say "marketplace $m: re-added at $ref, whose tag was re-cut upstream; its plugins are reinstalled"
      else say "marketplace $m: ${cur:-absent} → $ref"; fi
      changed=1
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
  # every marketplace not refused is now installed afresh at the pin in this dir: a re-cut reinstall is done here
  if [ "$check" != 1 ]; then
    for m in "${markets[@]}"; do case "$refused" in *" $m "*) ;; *) recut_done "$m" "${SYNC_CFG:-$HOME/.claude}" ;; esac; done
  fi
}

say() { echo "fleet-sync: $*"; }
warn() { echo "fleet-sync: WARNING $*" >&2; }

# --- the alert for a pinned release tag that moved (engsys#217) -------------------------------------
# Origin is the trust root for the pin and adopting a re-cut is intended, but a release tag moving under a pinned fleet is
# security-relevant (a re-cut, a mistake, or a compromised push), so the operator hears about it. One alert per
# <tag, old commit, new commit>: $FLEET_STATE/pin-recut.alerted latches a pair once it was DELIVERED (like
# verify-ref-forced.alerted: an undelivered alert stays pending and is retried by the next sync, whatever it adopts).
# It is sent by the kit that is running, before the checkout moves to the re-cut commit: the new code must not be what decides
# whether the alert goes out. The text carries the tag and two commit ids and nothing else: no paths, no probe output, no tokens;
# anything that is not a plain tag name and two full commit ids is not sent at all.
PIN_MOVED_LATCH="" PIN_MOVED_PENDING=""
pin_moved_alert() { # pin_moved_alert <engsys|instance> <tag> <old sha> <new sha>
  local what="$1" tag="$2" old="$3" new="$4"
  PIN_MOVED_LATCH="$FLEET_STATE/pin-recut.alerted" PIN_MOVED_PENDING="$FLEET_STATE/pin-recut.pending"
  if [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$old" =~ ^[0-9a-f]{40}$ ]] && [[ "$new" =~ ^[0-9a-f]{40}$ ]] && [ "$old" != "$new" ]; then
    mkdir -p "$FLEET_STATE"
    printf '%s|%s|%s|%s\n' "$what" "$tag" "$old" "$new" >>"$PIN_MOVED_PENDING"
  else
    warn "the pinned tag '$tag' moved, but its old and new commits could not be read, so no alert was sent; check who pushed it"
  fi
  pin_moved_flush
}
pin_moved_flush() { # send every pending alert not yet latched; keep what could not be delivered for the next run
  PIN_MOVED_LATCH="$FLEET_STATE/pin-recut.alerted" PIN_MOVED_PENDING="$FLEET_STATE/pin-recut.pending"
  [ -s "$PIN_MOVED_PENDING" ] || return 0
  local keep="" key what tag old new host
  host="$(hostname -s 2>/dev/null || echo this host)"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    ! grep -Fxq -- "$key" "$PIN_MOVED_LATCH" 2>/dev/null || continue
    IFS='|' read -r what tag old new <<<"$key"
    if [[ "$what" =~ ^(engsys|instance)$ ]] && [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$old" =~ ^[0-9a-f]{40}$ ]] && [[ "$new" =~ ^[0-9a-f]{40}$ ]] \
      && node "$FLEET_KIT_DIR/notify.mjs" --level alert --incident "pin-tag-moved-$what-$tag-${new:0:12}" --require-delivery \
        "Fleet on $host: the pinned $what release tag $tag moved on origin. This host had $old, origin now has $new, and fleet sync adopted origin's commit (origin is the trust root for the pin). A re-cut can be deliberate. If nobody on the team moved $tag, treat it as a possible compromise: check who pushed it and what changed between the two commits. Nothing else on the host was changed." >&2; then
      printf '%s\n' "$key" >>"$PIN_MOVED_LATCH"
    else
      keep+="$key"$'\n'
      warn "the alert for the moved pinned tag $tag was not delivered; the next fleet sync retries it"
    fi
  done <"$PIN_MOVED_PENDING"
  if [ -n "$keep" ]; then printf '%s' "$keep" >"$PIN_MOVED_PENDING"; else rm -f "$PIN_MOVED_PENDING"; fi
}

# --- the pending plugin reinstall after a re-cut pinned tag (engsys#219) --------------------------------
recut_note() { # recut_note <marketplace>: this run adopted a re-cut tag of it; its plugins are reinstalled until settled
  local m="$1" f="$FLEET_STATE/pin-recut.reinstall"
  mkdir -p "$FLEET_STATE"
  case " $recut_markets " in *" $m "*) ;; *) recut_markets+=" $m"; printf '%s\n' "$m" >>"$f" ;; esac
  # a re-cut adopted now needs every dir again, whatever an earlier one of the same marketplace recorded
  local d="$FLEET_STATE/pin-recut.done" dl
  [ -f "$d" ] || return 0
  dl="$(awk -F'|' -v m="$m" '$1 != m' "$d")"
  if [ -n "$dl" ]; then printf '%s\n' "$dl" >"$d"; else rm -f "$d"; fi
}
recut_settle() { # drop from the pending file every marketplace this run reinstalled everywhere; keep the rest
  local f="$FLEET_STATE/pin-recut.reinstall" d="$FLEET_STATE/pin-recut.done" m left="" dl
  for m in $recut_markets; do
    case "$recut_keep" in *" * "* | *" $m "*) left+="$m"$'\n' ;; esac
  done
  if [ -n "$left" ]; then printf '%s' "$left" >"$f"; else rm -f "$f"; fi
  [ -f "$d" ] || return 0
  # the per-dir record of a settled marketplace goes with it
  dl="$(RECUT_LEFT="$left" awk -F'|' 'BEGIN { n = split(ENVIRON["RECUT_LEFT"], k, "\n"); for (i = 1; i <= n; i++) if (k[i] != "") kept[k[i]] = 1 } NF > 1 && ($1 in kept)' "$d")"
  if [ -n "$dl" ]; then printf '%s\n' "$dl" >"$d"; else rm -f "$d"; fi
}
# recut_pending <marketplace> <dir | harness:<h>> → 0 when that dir or cache still needs the re-cut reinstall
recut_pending() {
  case " $recut_markets " in *" $1 "*) ;; *) return 1 ;; esac
  ! grep -Fxq -- "$1|$2" "$FLEET_STATE/pin-recut.done" 2>/dev/null
}
recut_done() { # recut_done <marketplace> <dir | harness:<h>>: the re-cut reinstall is done there
  recut_pending "$1" "$2" || return 0
  mkdir -p "$FLEET_STATE"; printf '%s|%s\n' "$1" "$2" >>"$FLEET_STATE/pin-recut.done"
}

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
SYNC_LIVE=0                              # 1: a session runs on SYNC_CFG; --check reads its files, sync never gets here
fleet_claude() {
  if [ -n "$SYNC_CFG" ]; then CLAUDE_CONFIG_DIR="$SYNC_CFG" fleet_dir_lock "$SYNC_CFG" claude "$@"
  else fleet_log_claude_call "$HOME/.claude" claude "$@"; env -u CLAUDE_CONFIG_DIR claude "$@"; fi
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
  elif [ "${FLEET_CLAUDE_CONFIG_DIR_PER_SESSION:-off}" = on ] && [ -n "$SYNC_CFG" ]; then what=" (session ${SYNC_CFG##*/}, own login)"
  elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ]; then what=" (interactive roles)"
  else what=""; fi
  if [ -n "$SYNC_CFG" ] && [ ! -d "$SYNC_CFG" ]; then
    [ "$1" = 1 ] || fleet_die "FLEET_CLAUDE_CONFIG_DIR $SYNC_CFG does not exist. One-time setup: fleet config-dir init, log in with CLAUDE_CONFIG_DIR=$SYNC_CFG claude, then fleet sync (fleet guide § 6.1)"
    say "claude config dir: $dir$what does not exist"; return 1
  fi
  if [ "$SYNC_LIVE" = 1 ]; then   # engsys#253: no claude on a live login; the supervisor's pane watch sees an expired one
    say "claude config dir: $dir$what, login not checked (a session is running on it)"
    return 0
  fi
  li="$( (cd "$SYNC_TMP/cwd" && fleet_claude auth status --json) 2>/dev/null | jq -r 'if .loggedIn == true then "logged in" elif .loggedIn == false then "NOT logged in" else "login unknown" end' 2>/dev/null || true)"
  if [ "$li" = "NOT logged in" ] && fleet_keychain_unreadable; then
    # engsys#210: not a login problem; don't hold, don't skip the plugin work
    say "claude config dir: $dir$what, login state unknown (SSH, Keychain not readable)"
    warn "this SSH shell can't read the login Keychain, so claude can't say whether $dir is logged in; do NOT /login. $(fleet_keychain_advice)"
    return 0
  fi
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
  plugin_list_json | jq -r '.[] | select((.scope // "user") == "user") | [.id, (.version // "")] | @tsv'
}
# A live dir (SYNC_LIVE=1, only ever read in --check) is read from its files: no claude process on the session's login
# (engsys#253). Unreadable or malformed files fail like a failed CLI call.
plugin_list_json() {
  if [ "$SYNC_LIVE" = 1 ]; then node "$FLEET_KIT_DIR/lib/plugin-list-from-files.mjs" --config-dir "${SYNC_CFG:-$HOME/.claude}" --project-dir "$SYNC_TMP/cwd"
  else plugin_cli list --json; fi
}
marketplace_list_json() {
  if [ "$SYNC_LIVE" = 1 ]; then node "$FLEET_KIT_DIR/lib/plugin-list-from-files.mjs" --config-dir "${SYNC_CFG:-$HOME/.claude}" --marketplaces
  else plugin_cli marketplace list --json; fi
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
  local check_mode="$1" engsys_checkout="$2" target_h="${3:-${HARNESS:-claude}}" is_fb="${4:-0}" i m ref want p src_repo sub cache_dir cfg_file cur_ver moved
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
      # engsys#219: a re-cut pinned tag leaves the version and the cache dir as they were: copy the plugin again from the moved checkout
      moved=0; ! recut_pending "$m" "harness:$target_h" || moved=1
      if [ "$cur_ver" != "$want" ] || [ ! -d "$cache_dir" ] || [ "$moved" = 1 ]; then
        if [ "$check_mode" = 1 ]; then
          if [ "$moved" = 1 ] && [ "$cur_ver" = "$want" ]; then say "plugin $p@$m ($target_h) is waiting for a reinstall (its pinned tag was re-cut)"
          else say "plugin $p@$m ($target_h) is at '${cur_ver:-absent}' (pin $want)"; fi
          drift=1
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
    for m in "${markets[@]}"; do recut_done "$m" "harness:$target_h"; done   # engsys#253: this cache has the re-cut now
  fi
}

# Wrapped in main so bash parses the whole file before steps 2 and 3 swap this code underneath it.
main "$@"
exit
