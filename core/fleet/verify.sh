#!/usr/bin/env bash
# verify.sh (`fleet verify`): do the engsys plugin files that guard the merge and maintain monsters
# (the whole install root: the fenced wrappers, every hook, the lease code, and nothing planted beside
# them) match the pinned engsys release on GitHub? (engsys#70; the comparison lives in
# lib/verify-wrappers.mjs.)
#
# The release is ENGSYS_REF on ENGSYS_MARKETPLACE's repo (PIN_SETTINGS, the same source `fleet sync` and
# `fleet pin` use), and it must be a release tag (vX.Y.Z). The files checked are the engsys installs
# that apply in PIN_DIR, the directory the sessions start in: `claude plugin list --json` is run there.
# When ENGSYS_REF is forced (fleet.local.conf or the environment) to something other than the pin in
# PIN_SETTINGS, it says so: a forced older tag is a way back to a weaker guard.
#
# The enabled plugins of INSTANCE_MARKETPLACE (the fleet's own plugin) are checked the same way against that
# marketplace's own pinned release (INSTANCE_REF, a vX.Y.Z tag), in every dir covered here (engsys#196).
#
# Also checked (lib/verify-wrappers.mjs): the pin checkout's .claude/ tree and every script its settings
# hooks run, against PIN_REPO's default branch on GitHub (PIN_DIR's HEAD must be that tip or behind it;
# behind is a warning to run fleet sync), and the user-scope settings of the Claude config dir the
# sessions use: FLEET_CLAUDE_CONFIG_DIR when fleet.conf sets it, else ~/.claude. A user-scope plugin the
# pin repo doesn't enable is a mismatch unless VERIFY_ALLOWED_USER_PLUGINS (fleet.conf, space-separated
# name@marketplace) lists it, and so is a user-scope hook or settings command (statusLine, *Helper, ...)
# unless VERIFY_ALLOWED_USER_HOOKS (fleet.conf, space-separated sha256 content hashes, printed in the
# mismatch line) lists it; listed ones are reported as `allowed`. The pin checkout's auto-loaded files
# (.claude/, CLAUDE.md files, .mcp.json, settings-command targets) must also be identical at the tip.
# User-scope agents, commands, skills, rules, CLAUDE.md, memory.yml (the memory brief's trust lists, engsys#230)
# and MCP server definitions in that config dir (and its .claude.json) are a mismatch unless
# VERIFY_ALLOWED_USER_FILES (fleet.conf, sha256 per item, printed in the mismatch line) lists them, and so is
# any CLAUDE.md / CLAUDE.local.md above PIN_DIR up to $HOME. When the federation file (FEDERATION_FILE) declares
# operators_team, a memory.yml in that config dir must list exactly the team's members in operator_user_ids; a team
# that can't be read is "not verified" (engsys#230). With one login per session, the fleet dir's memory.yml (the copy
# the sessions load, engsys#262) gets both checks too, with every session.
#
#   --alert          post `fleet notify --level alert` once per incident, and resolve it on the next pass:
#                      wrapper-integrity             a mismatch (latch: .fleet/verify-wrappers.alerted, holding
#                                                    the mismatch's fingerprint: a different mismatch alerts again)
#                      wrapper-integrity-unverified  the check could not run (latch: .fleet/verify-wrappers.unverified)
#                      engsys-ref-forced             ENGSYS_REF forced away from the pin (latch: .fleet/verify-ref-forced.alerted)
#                      wrapper-integrity-deferred-gone  a running session's deferred dir runs a release whose tag is gone
#                                                    (engsys#260, not held; latch: .fleet/verify-deferred-gone.<name>)
#   --auto-sync      (the supervisor's tick) when the only problems are `stale` (the pin checkout is behind
#                    the default branch and files the sessions load changed there) and PIN_DIR is on the
#                    default branch with a clean tracked tree, run `fleet sync --no-jobs` once (fast-forward +
#                    plugin reconcile, no restarts, never a launchd reload: changed job files are alerted)
#                    and verify again. Dirty, diverged or another branch: the
#                    mismatch stands, alerted as "behind main", not as tampering.
#   --max-age <min>  reuse a pass from the last <min> minutes while the local files are unchanged (the
#                    supervisor's throttle; cache: .fleet/verify-wrappers.json). `fleet launch` never
#                    passes it, so a launch always asks GitHub.
#   --session <name> (per-session mode) verify only that session's own config dir
#
# One login per session (FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, engsys#205): every session that uses the fleet's
# config dir has its own, <FLEET_CLAUDE_CONFIG_DIR>.sessions/<name>. `fleet verify` then checks each of them (plugins
# against the release, user-scope items, login) and prints one block per dir; the verdict, the latches and the
# alerts are per session (incidents wrapper-integrity-<name> and wrapper-integrity-unverified-<name>), so one
# logged-out or tampered dir holds only that session. `--session <name>` checks just one (what a launch and the
# supervisor ask). The exit code of the whole run is 1 if any dir mismatches, else 3 if any could not be
# verified, else 0. The auth status call and the plugin list on a dir are serialized per dir (fleet_dir_lock) and
# a logged-in answer is reused for --max-age minutes: the CLI contacts the API even for those, so they are
# extra processes on a credential that the session's own process already refreshes.
#
# A running session's credential is never touched by a periodic check (engsys#223). With --max-age (the supervisor's
# tick) and --session, when the session is running (a claude process in its tmux window, fleet_session_alive), verify
# spawns NO claude process on its dir: the plugin list is built from the dir's files (lib/plugin-list-from-files.mjs:
# plugins/installed_plugins.json plus enabledPlugins in the user, project and local settings; unreadable or malformed
# is "not verified", exit 3), and `claude auth status` is skipped (the supervisor's pane watch catches an expired
# login of a running session). A short-lived claude refreshing the access token near expiry rotates the refresh token
# out from under the live process (anthropics/claude-code#88583). Without --max-age (a launch), or when the session
# is not running, nothing shares the token, so the CLI is used and the check fails closed as before. Residual: a
# claude started by hand on that dir outside tmux is not seen.
#
# A dir `fleet sync` left behind while its session ran (engsys#253, .fleet/sync-deferred) is behind the pins on purpose
# until the session restarts. With --auto-sync and --session, once that session is down, verify first syncs its dir
# (`sync.sh --session`), so the supervisor's relaunch is not held by a dir that was only waiting. While it still runs, a
# periodic check (--max-age) whose every problem in it is an install at another version than the pin, each of which
# matches its OWN release file by file (deferred_check), prints it and passes (exit 0, no alert): the session is on
# what it loaded at start, and holding the gate would stop the supervisor
# from cycling a monster that sits idle after its rotation request. Any other problem (a hook, settings, user-scope
# config, memory, tampered files of the old version, ...) is alerted and held as always. That is no gap at the gate: `fleet launch` syncs the dir and verifies it again, without
# --max-age, before it starts the session. An old release whose tag GitHub no longer has (deleted, engsys#260) can't be
# checked: the rest still is (a problem there is a MISMATCH), and with none the dir is "behind, cannot re-verify": not held
# (holding it would last until someone ran fleet restart by hand, and the relaunch is what fixes it), alerted once
# (incident wrapper-integrity-deferred-gone, latch .fleet/verify-deferred-gone, resolved by the next definite verdict
# without it). A tag that was moved (re-cut) is not told apart from tampering: its changed files are a MISMATCH. Residual: the list is a file in .fleet/, so a process running as the fleet's
# user could add a live session's name to it and quiet that session's version-mismatch alert until it restarts (it could
# already edit fleet.conf or the verify cache, verify-wrappers.mjs).
#
# Exit: 0 match | 1 MISMATCH | 3 not verified (GitHub unreachable, no pin or not a tag, nothing installed)
#       | 2 usage. Merge and maintain sessions start only on 0 (engsys#86 review H1).
#
# Usage: verify.sh [--instance <dir>] [--alert] [--auto-sync] [--max-age <minutes>] [--session <name>]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
alert=0 max_age="" auto_sync=0 session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --alert) alert=1 ;;
    --auto-sync) auto_sync=1 ;;
    --max-age) max_age="${2:?--max-age needs minutes}"; shift ;;
    --session) session="${2:?--session needs a session name}"; shift ;;
    -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) echo "fleet verify: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$max_age" ] || [[ "$max_age" =~ ^[0-9]+$ ]] || { echo "fleet verify: --max-age takes whole minutes" >&2; exit 2; }
# Exit 1 means a definite mismatch and nothing else: a config error while loading the fleet env
# (fleet_die exits 1) or any other early exit 1 becomes 3, "not verified".
result=""
trap 'rc=$?; trap - EXIT; [ -z "${plist:-}" ] || rm -f "$plist"; if [ "$rc" = 1 ] && [ "$result" != mismatch ]; then exit 3; fi; exit "$rc"' EXIT
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
mkdir -p "$FLEET_STATE" && chmod 700 "$FLEET_STATE"
# shellcheck source=lib/session-dirs.sh
. "$FLEET_KIT_DIR/lib/session-dirs.sh"
SFX="" INC=""   # per-session mode: a suffix for this session's latches and cache, and for its incident keys
base_memory=""  # per-session mode: the fleet dir's memory.yml, which the session loads (engsys#262)
if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ]; then
  fleet_roster_prepare
  if [ -z "$session" ]; then
    names="$(fleet_session_dir_names)"
    if [ -z "$names" ]; then echo "fleet verify: not verified: FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, but no session on this host uses the fleet's config dir"; exit 3; fi
    worst=0
    missing="$(fleet_session_dirs_missing | paste -sd' ' -)"
    if [ -n "$missing" ]; then
      echo "fleet verify: WARNING FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on, but these sessions have no config dir yet: $missing. $(fleet_config_dir_fix)"
    fi
    reargs=(--instance "$FLEET_REPO"); [ "$alert" = 0 ] || reargs+=(--alert); [ "$auto_sync" = 0 ] || reargs+=(--auto-sync); [ -z "$max_age" ] || reargs+=(--max-age "$max_age")
    while IFS= read -r n; do
      echo "== session $n ($(fleet_session_config_dir "$n")) =="
      r=0; bash "$FLEET_KIT_DIR/verify.sh" "${reargs[@]}" --session "$n" </dev/null || r=$?
      case "$r" in 0) ;; 1) worst=1 ;; *) [ "$worst" = 1 ] || worst=3 ;; esac
    done <<<"$names"
    [ "$worst" != 1 ] || result=mismatch
    exit "$worst"
  fi
  # a refused --session is a usage error (2), never the verifier's MISMATCH (1) that callers read as tampering
  sdir="$(fleet_session_config_dir "$session")" || { echo "fleet verify: --session $session: not a name that can have its own config dir" >&2; exit 2; }
  names="$(fleet_session_dir_names --include-excluded)"
  grep -Fxq -- "$session" <<<"$names" || { echo "fleet verify: --session $session: not a session on this host that uses the fleet's config dir" >&2; exit 2; }
  # engsys#253: a dir fleet sync deferred while the session ran is synced now that it is down (before the env points at it)
  if [ "$auto_sync" = 1 ] && ! fleet_sync_deferred_run "$session"; then
    echo "fleet verify: could not sync $sdir, which fleet sync deferred while $session ran (above); checking it as it is"
  fi
  # engsys#230/#262: the session's monster reads the fleet dir's memory.yml (ENGSYS_MEMORY_CONFIG on its launch line),
  # not one in its own dir, so that copy is checked with this session too
  base_memory="$FLEET_CLAUDE_CONFIG_DIR/memory.yml"
  FLEET_CLAUDE_CONFIG_DIR="$sdir" CLAUDE_CONFIG_DIR="$sdir"; export FLEET_CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR
  SFX=".$session" INC="-$session"
elif [ -n "$session" ]; then
  echo "fleet verify: --session needs FLEET_CLAUDE_CONFIG_DIR_PER_SESSION=on" >&2; exit 2
fi

LATCH="$FLEET_STATE/verify-wrappers.alerted$SFX"
UNVERIFIED_LATCH="$FLEET_STATE/verify-wrappers.unverified$SFX"
FORCED_LATCH="$FLEET_STATE/verify-ref-forced.alerted"
OFFMAIN_LATCH="$FLEET_STATE/verify-instance-offmain.alerted$SFX"   # warn-only stage (engsys#227): only ever resolved now
host="$(hostname -s 2>/dev/null || echo this host)"
notify() { node "$FLEET_KIT_DIR/notify.mjs" --require-delivery "$@" >&2; } # undelivered: its latch stays as it was, retried next run
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

repo="$(fleet_pin_repo "$ENGSYS_MARKETPLACE")"
ref="$ENGSYS_REF"
pinned="$(fleet_pin "$ENGSYS_MARKETPLACE")"

# A forced ENGSYS_REF that differs from the pin (engsys#86 review M1).
if [ "${FLEET_ENGSYS_REF_FORCED:-0}" = 1 ] && [ "$ref" != "$pinned" ]; then
  echo "fleet verify: WARNING ENGSYS_REF is forced to '$ref' (fleet.local.conf or the environment), but the pin in $PIN_SETTINGS is '${pinned:-none}'. Verifying against '$ref'; if it is older, it may carry a weaker guard."
  if [ "$alert" = 1 ] && [ "$(cat "$FORCED_LATCH" 2>/dev/null)" != "$ref|$pinned" ]; then
    notify --level alert --incident engsys-ref-forced "Plugin check on $host: ENGSYS_REF is set to $ref by an override (fleet.local.conf or the environment), while the pin is ${pinned:-none}. That can be a deliberate rollback, or a downgrade to an older guard. If nobody on the team set it, please remove the override and run fleet sync." \
      && printf '%s\n' "$ref|$pinned" >"$FORCED_LATCH"
  fi
elif [ "$alert" = 1 ] && [ -f "$FORCED_LATCH" ]; then
  notify --level info --incident engsys-ref-forced --resolve "Resolved: ENGSYS_REF on $host follows the pin ($pinned) again." && rm -f "$FORCED_LATCH"
fi

# live_session → 0 when this is a periodic check (--max-age) of a session that is running: its credential belongs to that
# process, so verify must not start a claude on it. Evaluated once.
LIVE=""
live_session() {
  if [ -z "$LIVE" ]; then
    LIVE=0
    if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ] && [ -n "$max_age" ] && [ -n "$session" ] && fleet_session_alive "$session"; then LIVE=1; fi
  fi
  [ "$LIVE" = 1 ]
}

# dir_logged_out → 0 only when claude says explicitly that the fleet's config dir is not logged in. In per-session mode
# the call is serialized per dir, and a logged-in answer is kept for --max-age minutes (a logged-out one never is).
dir_logged_out() {
  local ok="$FLEET_STATE/auth-ok$SFX" li at
  if live_session; then   # engsys#223: the running session owns the credential; the supervisor's pane watch sees its expiry
    echo "fleet verify: login not checked: session $session is running (the supervisor's pane watch covers it)"
    return 1
  fi
  if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ] && [ -n "$max_age" ] && at="$(cat "$ok" 2>/dev/null)" && [[ "$at" =~ ^[0-9]+$ ]] \
    && [ $(( $(date +%s) - at )) -lt $(( max_age * 60 )) ]; then return 1; fi
  li="$( (cd "${TMPDIR:-/tmp}" && CLAUDE_CONFIG_DIR="$FLEET_CLAUDE_CONFIG_DIR" fleet_dir_lock "$FLEET_CLAUDE_CONFIG_DIR" claude auth status --json </dev/null) 2>/dev/null | jq -r 'if .loggedIn == true then "true" elif .loggedIn == false then "false" else "" end' 2>/dev/null || true)"
  if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ]; then
    if [ "$li" = true ]; then date +%s >"$ok"; else rm -f "${ok:?}"; fi
  fi
  if [ "$li" = false ] && fleet_keychain_unreadable; then
    # engsys#210: an SSH shell can't read the login Keychain; that is no evidence of a logout, so don't hold
    echo "fleet verify: login state unknown (SSH, Keychain not readable) for $FLEET_CLAUDE_CONFIG_DIR; not holding. $(fleet_keychain_advice)" >&2
    return 1
  fi
  [ "$li" = false ]
}

# list_plugins → `claude plugin list --json` for the fleet's config dir into $plist. In per-session mode the call
# contacts the API, and verify runs every supervisor tick against each live session's dir, so with --max-age the list
# is reused for that many minutes while the key is unchanged: the pins (ENGSYS_REF / INSTANCE_REF), the dir, and the
# mtimes of its plugins/ files and settings and of the pin checkout's settings. A fleet sync, a pin change or any
# plugin change in the dir changes the key, so a real change is still re-checked at once. The cache lives in .fleet/, which
# a session can write; that is the same trade-off documented at verify-wrappers.mjs (the cache), and it is why a launch
# (no --max-age) never uses it: the gate that decides whether a monster starts re-checks every time.
list_plugins() {
  local d="${FLEET_CLAUDE_CONFIG_DIR:-}" cache="$FLEET_STATE/plugin-list$SFX.json" keyf="$FLEET_STATE/plugin-list$SFX.key" key f m
  if live_session; then   # engsys#223: from the dir's files, no claude process; a failure is "not verified" (the caller's rc 3)
    node "$FLEET_KIT_DIR/lib/plugin-list-from-files.mjs" --config-dir "$d" --project-dir "$PIN_DIR" >"$plist" 2>"$plist.err" || { tail -n 1 "$plist.err" >&2; rm -f "$plist.err"; return 1; }
    rm -f "$plist.err"; return 0
  fi
  if [ "$FLEET_CLAUDE_CONFIG_DIR_PER_SESSION" = on ] && [ -n "$max_age" ]; then
    key="${ENGSYS_REF:-}|${INSTANCE_REF:-}|$d"
    for f in "$d/plugins" "$d/plugins/installed_plugins.json" "$d/plugins/known_marketplaces.json" "$d/settings.json" "$d/.claude.json" "$PIN_DIR/.claude/settings.json" "${PIN_SETTINGS:-}"; do
      m="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"; key="$key|$m"
    done
    if [ -s "$cache" ] && [ "$(cat "$keyf" 2>/dev/null)" = "$key" ]; then
      m="$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)"
      if [ $(( $(date +%s) - m )) -lt $(( max_age * 60 )) ]; then cp "$cache" "$plist"; return 0; fi
    fi
  fi
  (cd "$PIN_DIR" && fleet_dir_lock "$d" claude plugin list --json </dev/null) >"$plist" 2>/dev/null || return 1
  if [ -n "${key:-}" ]; then cp "$plist" "$cache" && printf '%s' "$key" >"$keyf"; fi
}

# The instance marketplace's enabled plugins (a fleet's own plugin pinned beside engsys, engsys#196): each one's install is
# held to that marketplace's own pinned release, in every dir this run covers. The directory a plugin is built from comes from
# the release's marketplace file, read by the verifier from GitHub. A plugin the pin enables but no pin repo/ref can name is
# "not verified" below, never skipped.
market_args=() inst_plugins="" inst_repo=""
# An instance release tag off its repo's default branch is a mismatch, like the engsys one (engsys#227). The
# INSTANCE_OFF_MAIN knob of the warn-only stage is gone; a fleet.conf that still sets it is told so, nothing else.
[ -z "${INSTANCE_OFF_MAIN:-}" ] || echo "fleet verify: INSTANCE_OFF_MAIN is obsolete and ignored (an instance release tag must be on its default branch); remove it from fleet.conf" >&2
if [ -n "${INSTANCE_MARKETPLACE:-}" ]; then
  inst_plugins="$(fleet_enabled_plugins "$INSTANCE_MARKETPLACE")"
  inst_repo="$(fleet_pin_repo "$INSTANCE_MARKETPLACE")"
  while IFS= read -r ip; do
    [ -z "$ip" ] || market_args+=(--market-plugin "$ip@$INSTANCE_MARKETPLACE|$inst_repo|${INSTANCE_REF:-}")
  done <<<"$inst_plugins"
fi

# The engsys marketplace's other enabled plugins (the stack packs, engsys#224): same check, against the engsys release itself
# (same repo and tag as the engsys plugin; the pack's directory comes from that release's marketplace file). A pack the pin
# enables but that isn't installed is "not verified" in the verifier, never skipped.
pack_plugins=""
if [ -n "$repo" ] && [ -n "$ref" ]; then
  pack_plugins="$(fleet_enabled_plugins "$ENGSYS_MARKETPLACE" | grep -vFx -e engsys || true)"
  while IFS= read -r pp; do
    [ -z "$pp" ] || market_args+=(--market-plugin "$pp@$ENGSYS_MARKETPLACE|$repo|$ref")
  done <<<"$pack_plugins"
fi

rc=0 out="" plist="" cfg_missing=0 deferred_pass=0 deferred_gone=""
# deferred_check (engsys#253): the session runs, and fleet sync left its dir behind the pins until it restarts; the launch
# syncs and re-verifies it. It passes (deferred_pass=1, rc 0, no alert) only when EVERY problem is an install at another
# version than the pin (`version` lines: what a deferred pin change looks like) AND each of those installs matches its OWN
# release, file by file (the verifier run again with each behind plugin's tag set to its installed version; the host kit,
# which is at the new pin, is left out of that run). Tampered files of the old version are a MISMATCH (rc 1, alerted); an
# old release that can't be checked is "not verified" (rc 3). Any other problem keeps the first run's verdict.
# engsys#260: an old release whose tag GitHub answers 404 for (the verifier's --release-gone-exit: exit 4, everything else
# checked and clean) passes as "behind, cannot re-verify" (deferred_gone, alerted once below). A 404 there is no outage:
# the first run read the same repos moments ago (a mismatch is never served from the cache), so only the tag is missing.
# The version comes from the dir's own files, so a forged one (a release that never was) lands here too: that is why it is
# alerted, worded as possible tampering, and never held on: holding changes nothing for the running session (running
# sessions are never stopped by the gate), and the relaunch, the one thing the gate decides, is verified in full.
deferred_check() {
  local probs line id ver map="" a=() i nx="" dout drc=0
  probs="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out")"
  [ -n "$probs" ] && ! grep -qv '^version ' <<<"$probs" || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^version\ +([^ ]+)\ .*\ is\ ([0-9]+\.[0-9]+\.[0-9]+),\ not\ the\ pin\  ]] || return 0
    id="${BASH_REMATCH[1]}" ver="${BASH_REMATCH[2]}"
    if grep -q "^$id " <<<"$map"; then grep -Fxq "$id $ver" <<<"$map" || return 0; else map+="$id $ver"$'\n'; fi
  done <<<"$probs"
  oldtag() { local v; v="$(awk -v i="$1" '$1 == i { print $2; exit }' <<<"$map")"; [ -n "$v" ] && printf 'v%s' "$v"; }
  for i in "${args[@]}"; do
    case "$nx" in
      tag) a+=("$(oldtag "engsys@$ENGSYS_MARKETPLACE" || printf '%s' "$i")"); nx=""; continue ;;
      market) id="${i%%|*}"; if ver="$(oldtag "$id")"; then a+=("${i%|*}|$ver"); else a+=("$i"); fi; nx=""; continue ;;
      skip) nx=""; continue ;;
      cache) a+=("$FLEET_STATE/verify-wrappers$SFX.deferred.json"); nx=""; continue ;;
    esac
    case "$i" in
      --tag) nx=tag ;; --market-plugin) nx=market ;; --engsys-dir) nx=skip; continue ;; --cache) nx=cache ;;
    esac
    a+=("$i")
  done
  a+=(--release-gone-exit)
  dout="$(node "$FLEET_KIT_DIR/lib/verify-wrappers.mjs" "${a[@]}" 2>&1)" || drc=$?
  if [ "$drc" = 1 ] && ! grep -q '^verify: MISMATCH' <<<"$dout"; then drc=3; fi
  # node exits 4 on an internal failure of its own too: only the verifier's line counts (engsys#260)
  if [ "$drc" = 4 ] && ! grep -q '^verify: release gone: [^(]*[^ (] (no such tag' <<<"$dout"; then drc=3; fi
  case "$drc" in
    0) out="$out"$'\n'"fleet verify: each install behind the pin matches its own release ($(awk 'NF { printf "%s%s v%s", s, $1, $2; s = ", " }' <<<"$map")): session $session is running on what it loaded before fleet sync, which left its dir alone while it runs; the dir is synced and verified again before it relaunches (fleet restart $session). Not held, not alerted."
       rc=0 deferred_pass=1 ;;
    1) out="$out"$'\n'"fleet verify: the dir of running session $session is behind the pin, and its installs do NOT match their own release either:"$'\n'"$dout"; rc=1 ;;
    4) deferred_gone="$(sed -n 's/^verify: release gone: \([^(]*[^ (]\) (no such tag.*$/\1/p' <<<"$dout" | tail -n 1)"
       out="$out"$'\n'"$dout"$'\n'"fleet verify: behind, cannot re-verify: session $session is running on what it loaded before fleet sync, and the release of ${deferred_gone:-an install behind the pin} is no longer on GitHub (its tag is gone), so those files can't be checked against it; everything else in its dir matches. Not held: the relaunch syncs the dir to the pin and verifies it in full first (fleet restart $session). Alerted once."
       rc=0 deferred_pass=1 ;;
    *) out="$out"$'\n'"fleet verify: not verified: the installs of running session $session are behind the pin, and their own release could not be checked:"$'\n'"$dout"; rc=3 ;;
  esac
}
# The Claude Code config dir the fleet's sessions run with: FLEET_CLAUDE_CONFIG_DIR (fleet-env.sh exports
# it as CLAUDE_CONFIG_DIR for every fleet command and session, so `claude plugin list` below reads it
# too), else the account's ~/.claude. It is what the monsters load. (With FLEET_CLAUDE_CONFIG_DIR_SCOPE=
# supervised the interactive roles run on ~/.claude instead, which is not integrity-gated.)
claude_cfg="${FLEET_CLAUDE_CONFIG_DIR:-$HOME/.claude}"
echo "fleet verify: Claude config dir: $claude_cfg${FLEET_CLAUDE_CONFIG_DIR:+ (FLEET_CLAUDE_CONFIG_DIR)}"
if [ -z "$repo" ] || [ -z "$ref" ]; then
  out="fleet verify: not verified: no '$ENGSYS_MARKETPLACE' marketplace with a repo and ref in $PIN_SETTINGS"; rc=3
elif ! [[ "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  out="fleet verify: not verified: the engsys ref '$ref' is not a release tag (vX.Y.Z)"; rc=3
elif ! command -v node >/dev/null; then
  out="fleet verify: not verified: node not found"; rc=3
elif [ "${HARNESS:-claude}" = "claude" ] && ! command -v claude >/dev/null; then
  out="fleet verify: not verified: claude not found, so the installed plugin can't be located"; rc=3
elif ! [ -d "$PIN_DIR" ]; then
  out="fleet verify: not verified: PIN_DIR not found: $PIN_DIR"; rc=3
elif [ -n "$inst_plugins" ] && { [ -z "$inst_repo" ] || [ -z "${INSTANCE_REF:-}" ]; }; then
  out="fleet verify: not verified: no '$INSTANCE_MARKETPLACE' marketplace with a repo and ref in $PIN_SETTINGS, so its plugins can't be checked"; rc=3
elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && ! [ -d "$FLEET_CLAUDE_CONFIG_DIR" ]; then
  cfg_missing=1
  out="fleet verify: not verified: FLEET_CLAUDE_CONFIG_DIR not found: $FLEET_CLAUDE_CONFIG_DIR ($(fleet_config_dir_fix "$session"))"; rc=3
elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${HARNESS:-claude}" = claude ] && dir_logged_out; then
  # A rotation must not relaunch a monster into a login prompt: hold until the fleet seat is logged in.
  out="fleet verify: not verified: the fleet's Claude config dir $FLEET_CLAUDE_CONFIG_DIR is not logged in (CLAUDE_CONFIG_DIR=$FLEET_CLAUDE_CONFIG_DIR claude, then /login)"; rc=3
else
  plist="$(mktemp "$FLEET_STATE/plugin-list.XXXXXX")"
  if [ "${HARNESS:-claude}" = "copilot" ]; then
    cfile="${COPILOT_HOME:-$FLEET_STATE/copilot-home}/config.json"
    if [ ! -f "$cfile" ]; then
      out="fleet verify: not verified: copilot config.json not found at $cfile (run: fleet sync)"; rc=3
    else
      cp "$cfile" "$plist"
    fi
  elif [ "${HARNESS:-claude}" = "antigravity" ]; then
    afile="$PIN_DIR/.agents/plugins.json"
    [ -f "$afile" ] || afile="$FLEET_STATE/agy-plugins.json"
    if [ -f "$afile" ]; then
      cp "$afile" "$plist"
    else
      echo '[]' >"$plist"
    fi
  else
    # The cwd decides which project-scope installs apply: the sessions start in PIN_DIR (engsys#86 review H2).
    if ! list_plugins; then
      if live_session; then out="fleet verify: not verified: the plugin list could not be read from the files of $FLEET_CLAUDE_CONFIG_DIR (a running session's login is not touched)"
      else out="fleet verify: not verified: claude plugin list failed in $PIN_DIR"; fi
      rc=3
    fi
  fi
  if [ "$rc" = 0 ]; then
    args=(--repo "$repo" --tag "$ref" --plugin-id "engsys@$ENGSYS_MARKETPLACE" --project-dir "$PIN_DIR" --plugins "$plist" --harness "${HARNESS:-claude}" --check-settings --user-settings-dir "$claude_cfg")
    args+=(${market_args[@]+"${market_args[@]}"})
    [ -z "${VERIFY_ALLOWED_USER_PLUGINS:-}" ] || args+=(--allowed-user-plugins "$VERIFY_ALLOWED_USER_PLUGINS")
    [ -z "${VERIFY_ALLOWED_USER_HOOKS:-}" ] || args+=(--allowed-user-hooks "$VERIFY_ALLOWED_USER_HOOKS")
    # User-scope config besides settings (agents, commands, skills, rules, memory, MCP servers) and memory
    # files above PIN_DIR: each must be on VERIFY_ALLOWED_USER_FILES. The user state file is
    # <dir>/.claude.json with a fleet config dir, else ~/.claude.json.
    args+=(--check-user-config --claude-json "${FLEET_CLAUDE_CONFIG_DIR:+$FLEET_CLAUDE_CONFIG_DIR/.claude.json}")
    [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || args[${#args[@]}-1]="$HOME/.claude.json"
    [ -z "${VERIFY_ALLOWED_USER_FILES:-}" ] || args+=(--allowed-user-files "$VERIFY_ALLOWED_USER_FILES")
    # engsys#230: a memory.yml in that dir must list exactly the federation's operators_team in operator_user_ids.
    # verify-wrappers reads the team with PIN_DIR as the cwd (the gh shim picks its App installation from the cwd's
    # origin, eric-sabe/engsys#257). A federation file that can't be read is "not verified", never a skipped check.
    [ -z "$base_memory" ] || args+=(--memory-config "$base_memory")
    fed_err=""
    if [ -f "$FEDERATION_FILE" ]; then
      ot_rc=0; ot="$(node "$FLEET_KIT_DIR/lib/federation.mjs" get operators_team --file "$FEDERATION_FILE" 2>&1)" || ot_rc=$?
      case "$ot_rc" in
        0) [ -z "$ot" ] || [ "$ot" = null ] || args+=(--operators-team "$ot") ;;
        3) ;;   # no operators_team declared
        *) fed_err="$(tail -n 1 <<<"$ot")" ;;
      esac
    fi
    # a dir of the fleet's own: its claude.ai sync must be off (engsys#201). Never ~/.claude itself, which sync and config-dir
    # init leave alone (engsys#204): the warning's fix would not work there
    if [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] \
      && [ "$(cd "$FLEET_CLAUDE_CONFIG_DIR" 2>/dev/null && pwd -P || echo "$FLEET_CLAUDE_CONFIG_DIR")" != "$(cd "$HOME/.claude" 2>/dev/null && pwd -P || echo "$HOME/.claude")" ]; then
      args+=(--fleet-config-dir)
    fi
    # The launcher's messaging settings (--settings on every session, monsters included): only the keys it writes.
    ns="$(fleet_roster_header NAMESPACE)"
    [ -z "$ns" ] || args+=(--messaging-settings "$HOME/.claude/$ns-messaging-settings.json")
    if [ -e "$ENGSYS_DIR" ] || [ -L "$ENGSYS_DIR" ]; then
      args+=(--engsys-dir "$ENGSYS_DIR")
    fi
    # Project settings and hooks: checked against PIN_REPO's default branch on GitHub (never a local
    # ref). A PIN_DIR that is not a git checkout can't be: its settings hooks are then a mismatch.
    if [ "$(git -C "$PIN_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ]; then
      args+=(--pin-repo "$PIN_REPO")
    else
      echo "fleet verify: WARNING PIN_DIR ($PIN_DIR) is not a git checkout, so its .claude/ can't be checked against $PIN_REPO; any settings hook there is a mismatch"
    fi
    [ -z "$max_age" ] || args+=(--cache "$FLEET_STATE/verify-wrappers$SFX.json" --max-age-min "$max_age")
    if [ -n "$fed_err" ]; then out="fleet verify: not verified: can't read operators_team from $FEDERATION_FILE ($fed_err)"; rc=3
    else out="$(node "$FLEET_KIT_DIR/lib/verify-wrappers.mjs" "${args[@]}" 2>&1)" || rc=$?; fi
    # node exits 1 on its own crash (a missing module, a syntax error): only the verifier's MISMATCH line counts.
    if [ "$rc" = 1 ] && ! grep -q '^verify: MISMATCH' <<<"$out"; then
      out="$out"$'\n'"fleet verify: not verified: the verifier failed (exit 1, above)"; rc=3
    fi
    case "$rc" in 0 | 1 | 3) ;; *) out="$out"$'\n'"fleet verify: not verified: the verifier exited $rc"; rc=3 ;; esac
    # engsys#253: a running session whose dir fleet sync deferred is behind the pins until it restarts (see the header)
    if [ "$rc" = 1 ] && live_session && fleet_sync_deferred "$session"; then deferred_check; fi
    # FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised: the interactive roles run on ~/.claude, and the security
    # reviews they dispatch (whose verdicts gate merges) load the engsys plugin from there. So its engsys
    # install is held to the same release check: a mismatch there holds the monsters too. Only that
    # plugin; the operator's other plugins, skills and MCP servers in ~/.claude are not checked.
    if [ "$rc" = 0 ] && [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${FLEET_CLAUDE_CONFIG_DIR_SCOPE:-all}" = supervised ] \
      && [ "${HARNESS:-claude}" = claude ]; then
      plist_u="$(mktemp "$FLEET_STATE/plugin-list-user.XXXXXX")"
      # ~/.claude belongs to the live interactive roles: a periodic check (--max-age) reads its files, never starts a claude on it (engsys#223)
      # (a launch has no --max-age, but an interactive role may be live on ~/.claude too: then its files, the same way)
      u_files=0
      if [ -n "$max_age" ]; then u_files=1
      else fleet_roster_prepare; while IFS= read -r un; do if [ -n "$un" ] && is_interactive "$un"; then u_files=1; break; fi; done < <(fleet_live_sessions); fi
      if [ "$u_files" = 1 ]; then u_list=(node "$FLEET_KIT_DIR/lib/plugin-list-from-files.mjs" --config-dir "$HOME/.claude" --project-dir "$PIN_DIR")
      else fleet_log_claude_call "$HOME/.claude" claude plugin list --json; u_list=(env -u CLAUDE_CONFIG_DIR claude plugin list --json); fi
      if ! (cd "$PIN_DIR" && "${u_list[@]}") >"$plist_u" 2>/dev/null; then
        if [ "$u_files" = 1 ]; then out="$out"$'\n'"fleet verify: not verified: the plugin list could not be read from the files of ~/.claude (the interactive roles; their login is not touched)"
        else out="$out"$'\n'"fleet verify: not verified: claude plugin list failed in $PIN_DIR for ~/.claude (the interactive roles)"; fi
        rc=3
      else
        uargs=(--repo "$repo" --tag "$ref" --plugin-id "engsys@$ENGSYS_MARKETPLACE" --project-dir "$PIN_DIR" --plugins "$plist_u" --harness claude)
        uargs+=(${market_args[@]+"${market_args[@]}"})
        [ -z "$max_age" ] || uargs+=(--cache "$FLEET_STATE/verify-wrappers-user.json" --max-age-min "$max_age")
        urc=0; uout="$(node "$FLEET_KIT_DIR/lib/verify-wrappers.mjs" "${uargs[@]}" 2>&1)" || urc=$?
        if [ "$urc" = 1 ] && ! grep -q '^verify: MISMATCH' <<<"$uout"; then urc=3; fi
        case "$urc" in 0 | 1 | 3) ;; *) urc=3 ;; esac
        out="$out"$'\n'"fleet verify: ~/.claude (interactive roles, FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised): the engsys plugin${pack_plugins:+, its stack packs}${inst_plugins:+ and the $INSTANCE_MARKETPLACE plugin(s)}"$'\n'"$uout"
        rc="$urc"
      fi
      rm -f "$plist_u"
    fi
  fi
fi

# Only `stale` problems: the checkout is behind main and an auto-loaded file moved there. Not tampering.
only_stale=0
if [ "$rc" = 1 ]; then
  probs="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out")"
  if [ -n "$probs" ] && ! grep -qv '^stale ' <<<"$probs"; then only_stale=1; fi
fi
sync_why=""
if [ "$only_stale" = 1 ] && [ "$auto_sync" = 1 ]; then
  # engsys#223: the common case, a pin checkout that is merely behind with the pins unchanged, is fixed by a git
  # fast-forward alone, with no claude. A change of the pins runs fleet sync, also while sessions run: since engsys#253
  # sync itself starts no claude on a running session's own dir (it leaves that dir to the session's restart).
  pins_same=0
  # Full ref names, never --short: a local branch or tag named origin/<x> makes --short ambiguous.
  pin_branch="$(git -C "$PIN_DIR" symbolic-ref -q HEAD 2>/dev/null || true)"
  case "$pin_branch" in refs/heads/*) pin_branch="${pin_branch#refs/heads/}" ;; *) pin_branch="" ;; esac
  def_branch="$(git -C "$PIN_DIR" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
  case "$def_branch" in refs/remotes/origin/?*) def_branch="${def_branch#refs/remotes/origin/}" ;; *) def_branch="" ;; esac
  : "${def_branch:=main}"
  if [ "$pin_branch" != "$def_branch" ]; then sync_why="the pin checkout is on '${pin_branch:-a detached HEAD}', not $def_branch"
  elif [ -n "$(git -C "$PIN_DIR" status --porcelain --untracked-files=no 2>/dev/null || echo dirty)" ]; then sync_why="the pin checkout has uncommitted changes to tracked files"
  elif [ -n "$(git -C "$PIN_DIR" status --porcelain -- .claude ':(exclude,icase).claude/settings.local.json' \
      ':(exclude,icase).claude/scheduled_tasks.lock' ':(exclude,icase).claude/worktrees' ':(exclude,icase).claude/checkpoints' \
      ':(exclude,icase).claude/mailbox' ':(exclude,icase).claude/routines/.state' ':(exclude,icase).claude/agent-registry.json' \
      ':(exclude,icase).claude/agent-memory-local' ':(exclude,icase).claude/first-run' \
      ':(exclude,icase).claude/assistant-daemon-state.json' 2>/dev/null || echo dirty)" ]; then sync_why="the pin checkout's .claude/ has untracked files"
  else
    # a fetch and a fast-forward are git only; compare the pins (marketplaces and enabled plugins) of HEAD and the tip
    fetched=0
    if git -C "$PIN_DIR" fetch -q origin 2>/dev/null; then
      fetched=1
      pins_head="$(git -C "$PIN_DIR" show HEAD:.claude/settings.json 2>/dev/null | jq -cS '{extraKnownMarketplaces, enabledPlugins}' 2>/dev/null || echo head)"
      pins_tip="$(git -C "$PIN_DIR" show "refs/remotes/origin/$def_branch:.claude/settings.json" 2>/dev/null | jq -cS '{extraKnownMarketplaces, enabledPlugins}' 2>/dev/null || echo tip)"
      [ "$pins_head" != "$pins_tip" ] || pins_same=1
    fi
    if [ "$fetched" = 0 ]; then
      sync_why="git fetch of origin failed in the pin checkout (offline?); nothing was changed, the next tick tries again"
    elif [ "$pins_same" = 1 ]; then
      echo "fleet verify: the pin checkout is behind $def_branch and the pins are unchanged: fast-forwarding it (git only, no claude)"
      if git -C "$PIN_DIR" merge -q --ff-only "refs/remotes/origin/$def_branch" 2>/dev/null; then
        [ -z "${plist:-}" ] || rm -f "$plist"
        reargs=(--instance "$FLEET_REPO"); [ "$alert" = 0 ] || reargs+=(--alert); [ -z "$max_age" ] || reargs+=(--max-age "$max_age"); [ -z "$session" ] || reargs+=(--session "$session")
        exec bash "$FLEET_KIT_DIR/verify.sh" "${reargs[@]}"   # once: the re-run has no --auto-sync
      fi
      sync_why="the pin checkout could not fast-forward to origin/$def_branch"
    else
    echo "fleet verify: the pin checkout is behind $def_branch and the pins changed: auto-syncing (fleet sync, no restarts; a running session's own dir is left to its restart)"
    # --no-jobs: this runs inside the supervisor's own launchd job, which a job reload would kill.
    if bash "$FLEET_KIT_DIR/sync.sh" --instance "$FLEET_REPO" --no-jobs </dev/null >&2; then
      [ -z "${plist:-}" ] || rm -f "$plist"
      reargs=(--instance "$FLEET_REPO"); [ "$alert" = 0 ] || reargs+=(--alert); [ -z "$max_age" ] || reargs+=(--max-age "$max_age"); [ -z "$session" ] || reargs+=(--session "$session")
      exec bash "$FLEET_KIT_DIR/verify.sh" "${reargs[@]}"   # once: the re-run has no --auto-sync
    fi
    sync_why="fleet sync failed (above)"
    fi
  fi
  out="$out"$'\n'"fleet verify: could not auto-sync: $sync_why"
fi
if [ "$rc" = 1 ] && [ -f "$FLEET_STATE/sync-deferred.user-claude" ]; then
  out="$out"$'\n'"fleet verify: the supervisor's auto-sync left ~/.claude alone while interactive roles run on it (engsys#253): run fleet sync yourself"
fi
printf '%s\n' "$out"

# engsys#260: "behind, cannot re-verify" (deferred_check) is one incident, posted once per set of gone releases and resolved
# by the next definite verdict (0 or 1) that is not that; a check that could not run (3) leaves it as it is
GONE_LATCH="$FLEET_STATE/verify-deferred-gone$SFX"
if [ "$alert" = 1 ] && [ -n "$deferred_gone" ]; then
  if [ "$(cat "$GONE_LATCH" 2>/dev/null)" != "$deferred_gone" ]; then
    notify --level alert --incident "wrapper-integrity-deferred-gone$INC" "Plugin check on $host (session $session): the session runs on plugins it loaded before a pin change (fleet sync leaves its config dir alone while it runs), and the release they came from ($deferred_gone) is not on GitHub: its tag was deleted, or the version its dir reports was never released. So those files can't be checked while it runs; everything else in its dir matches. It is not held: its next relaunch syncs the dir to the pin ($ref) and verifies it in full before it starts. Please restart it now to bring it back under the check: fleet restart $session. If nobody deleted that tag on purpose, treat it as possible tampering of that dir and check who changed it." \
      && printf '%s\n' "$deferred_gone" >"$GONE_LATCH"
  fi
elif [ "$alert" = 1 ] && [ -f "$GONE_LATCH" ] && [ "$rc" != 3 ]; then
  notify --level info --incident "wrapper-integrity-deferred-gone$INC" --resolve "Resolved: session ${session:-} on $host no longer runs on a release that can't be checked." && rm -f "$GONE_LATCH"
fi

if [ "$alert" = 1 ] && { [ "$deferred_pass" = 0 ] || [ "$rc" != 0 ]; }; then
  # the info-level incident of the warn-only stage (engsys#227): closed once by a check that completed (0 or 1, engsys#248:
  # never on a usage error or a check that couldn't run), whatever it found — an off-main instance tag is now a mismatch,
  # alerted (and held) below like any other
  if [ -f "$OFFMAIN_LATCH" ] && { [ "$rc" = 0 ] || [ "$rc" = 1 ]; }; then
    notify --level info --incident "instance-release-off-main$INC" --resolve "Resolved: an instance release off its default branch is now a plugin-check mismatch (alerted as one if it still is), no longer a separate warning." && rm -f "$OFFMAIN_LATCH"
  fi
  case "$rc" in
    0)
      if [ -f "$LATCH" ]; then
        notify --level info --incident "wrapper-integrity$INC" --resolve "Resolved: the engsys plugin files on $host match $repo@$ref again." && rm -f "$LATCH" "$LATCH.at"
      fi
      if [ -f "$UNVERIFIED_LATCH" ]; then
        notify --level info --incident "wrapper-integrity-unverified$INC" --resolve "Resolved: the engsys plugin check on $host runs again, and passes." && rm -f "$UNVERIFIED_LATCH"
      fi
      ;;
    1)
      fp="$(sed -n 's/^fingerprint: //p' <<<"$out" | tail -1)"
      # latch on a fixed reason for a deferral: the list of running sessions changes with every start and stop
      if [ "$only_stale" = 1 ] && [ "$(cat "$LATCH" 2>/dev/null)" != "$fp|$auto_sync|$sync_why" ]; then
        lines="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | awk 'NR <= 8')"
        notify --level alert --incident "wrapper-integrity$INC" "Plugin check on $host${session:+ (session $session)}: the pin checkout ($PIN_DIR) is behind main, and files the sessions load changed there. $(if [ -n "$sync_why" ]; then printf 'Auto-sync could not fast-forward it: %s. Please bring the checkout back to main and run fleet sync.' "$sync_why"; elif [ "$auto_sync" = 1 ]; then printf 'Auto-syncing: fleet sync is running for it now.'; else printf 'Run fleet sync (a supervised host also does it on its own, through fleet verify --auto-sync).'; fi) Merge and maintain sessions are held until it matches; running sessions are left as they are. This is not a sign of tampering. Behind on:
$lines
Details: fleet verify" && printf '%s\n' "$fp|$auto_sync|$sync_why" >"$LATCH"
      elif [ "$only_stale" = 0 ] && [ "$(cat "$LATCH" 2>/dev/null)" != "$fp" ]; then
        summary="$(sed -n 's/^summary: //p' <<<"$out" | tail -1)"
        hint="$(sed -n 's/^hint: //p' <<<"$out" | tail -1)"
        # engsys#253: the supervisor's auto-sync leaves ~/.claude alone while an interactive role runs on it
        unote=""; [ ! -f "$FLEET_STATE/sync-deferred.user-claude" ] || unote=" The supervisor's auto-sync did not sync ~/.claude, because interactive roles were running on it: if the mismatch is there, run fleet sync yourself."
        lines="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | awk 'NR <= 5')"
        # engsys#248: when every mismatch is a release tag off its repo's default branch, reinstalling fixes nothing: the
        # recovery is a release on that branch
        fix="for plugin files, reinstall (claude plugin uninstall --scope user engsys@$ENGSYS_MARKETPLACE from outside any project, delete its cache directory, fleet sync); for the pin checkout, restore it to GitHub's main and check who changed it; for a user-scope item, remove it or allowlist it (VERIFY_ALLOWED_USER_PLUGINS / _HOOKS / _FILES)"
        if sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | grep -q . && ! sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | grep -qv '^release '; then
          fix="the release tag must be a commit on its repo's default branch, and reinstalling won't change that. For the instance plugin, cut a release on its default branch (fleet pin --release next, merge its release PR, then run it again); for engsys, pin a release tagged on main (fleet pin --engsys vX.Y.Z), or re-tag this one on main if it was cut off main by mistake, and check who tagged it"
        fi
        notify --level alert --incident "wrapper-integrity$INC" "Plugin check on $host${session:+ (session $session)}: ${summary:-a mismatch}. What the merge and maintain monsters load does not match $repo@$ref (the engsys plugin and host kit), $PIN_REPO's default branch on GitHub (the pin checkout), or the allowed Claude settings in $claude_cfg. Merge and maintain sessions will not be launched or relaunched here until it matches; running sessions and their batons were left as they are.$unote${hint:+ For the user-scope items: $hint.} To fix: $fix. First of them:
$lines
Details: fleet verify" && printf '%s\n' "$fp" >"$LATCH"
      fi ;;
    3)
      # The latch holds "<time> <reason>". A change of reason alerts again: a missing config dir that turns up while a
      # generic "could not run" alert is latched must not keep the "may resolve on its own" text (engsys#212).
      reason=other; [ "$cfg_missing" != 1 ] || reason=missing
      prev_reason="$(awk '{print $2}' "$UNVERIFIED_LATCH" 2>/dev/null || true)"; [ "$prev_reason" = missing ] || prev_reason=other
      if [ -f "$UNVERIFIED_LATCH" ] && [ "$prev_reason" = "$reason" ]; then :
      elif [ "$reason" = missing ]; then
        notify --level alert --incident "wrapper-integrity-unverified$INC" "Plugin check on $host${session:+ (session $session)} could not run: its Claude config dir $FLEET_CLAUDE_CONFIG_DIR does not exist. This does not clear by itself. Fix: $(fleet_config_dir_fix "$session"). Merge and maintain sessions are held until it can confirm the plugin matches $repo@${ref:-the pin}." \
          && echo "$(now) $reason" >"$UNVERIFIED_LATCH"
      else
        notify --level alert --incident "wrapper-integrity-unverified$INC" "Plugin check on $host${session:+ (session $session)} could not run: $(tail -n 1 <<<"$out" | sed 's/^.*not verified[^:]*: //' | cut -c1-300). Merge and maintain sessions are held until it can confirm the plugin matches $repo@${ref:-the pin}. If GitHub is having trouble this resolves on its own; otherwise see fleet verify." \
          && echo "$(now) $reason" >"$UNVERIFIED_LATCH"
      fi ;;
  esac
fi
[ "$rc" != 1 ] || result=mismatch
exit "$rc"
