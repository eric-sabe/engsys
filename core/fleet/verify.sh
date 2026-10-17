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
# Also checked (lib/verify-wrappers.mjs): the pin checkout's .claude/ tree and every script its settings
# hooks run, against PIN_REPO's default branch on GitHub (PIN_DIR's HEAD must be that tip or behind it;
# behind is a warning to run fleet sync), and the user-scope settings of the Claude config dir the
# sessions use: FLEET_CLAUDE_CONFIG_DIR when fleet.conf sets it, else ~/.claude. A user-scope plugin the
# pin repo doesn't enable is a mismatch unless VERIFY_ALLOWED_USER_PLUGINS (fleet.conf, space-separated
# name@marketplace) lists it, and so is a user-scope hook or settings command (statusLine, *Helper, ...)
# unless VERIFY_ALLOWED_USER_HOOKS (fleet.conf, space-separated sha256 content hashes, printed in the
# mismatch line) lists it; listed ones are reported as `allowed`. The pin checkout's auto-loaded files
# (.claude/, CLAUDE.md files, .mcp.json, settings-command targets) must also be identical at the tip.
# User-scope agents, commands, skills, rules, CLAUDE.md and MCP server definitions in that config dir (and
# its .claude.json) are a mismatch unless VERIFY_ALLOWED_USER_FILES (fleet.conf, sha256 per item, printed
# in the mismatch line) lists them, and so is any CLAUDE.md / CLAUDE.local.md above PIN_DIR up to $HOME.
#
#   --alert          post `fleet notify --level alert` once per incident, and resolve it on the next pass:
#                      wrapper-integrity             a mismatch (latch: .fleet/verify-wrappers.alerted, holding
#                                                    the mismatch's fingerprint: a different mismatch alerts again)
#                      wrapper-integrity-unverified  the check could not run (latch: .fleet/verify-wrappers.unverified)
#                      engsys-ref-forced             ENGSYS_REF forced away from the pin (latch: .fleet/verify-ref-forced.alerted)
#   --auto-sync      (the supervisor's tick) when the only problems are `stale` (the pin checkout is behind
#                    the default branch and files the sessions load changed there) and PIN_DIR is on the
#                    default branch with a clean tracked tree, run `fleet sync` once (fast-forward + plugin
#                    reconcile, no restarts) and verify again. Dirty, diverged or another branch: the
#                    mismatch stands, alerted as "behind main", not as tampering.
#   --max-age <min>  reuse a pass from the last <min> minutes while the local files are unchanged (the
#                    supervisor's throttle; cache: .fleet/verify-wrappers.json). `fleet launch` never
#                    passes it, so a launch always asks GitHub.
#
# Exit: 0 match | 1 MISMATCH | 3 not verified (GitHub unreachable, no pin or not a tag, nothing installed)
#       | 2 usage. Merge and maintain sessions start only on 0 (engsys#86 review H1).
#
# Usage: verify.sh [--instance <dir>] [--alert] [--auto-sync] [--max-age <minutes>]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
alert=0 max_age="" auto_sync=0
while [ $# -gt 0 ]; do
  case "$1" in
    --alert) alert=1 ;;
    --auto-sync) auto_sync=1 ;;
    --max-age) max_age="${2:?--max-age needs minutes}"; shift ;;
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

LATCH="$FLEET_STATE/verify-wrappers.alerted"
UNVERIFIED_LATCH="$FLEET_STATE/verify-wrappers.unverified"
FORCED_LATCH="$FLEET_STATE/verify-ref-forced.alerted"
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

rc=0 out="" plist=""
# The Claude Code config dir the fleet's sessions run with: FLEET_CLAUDE_CONFIG_DIR (fleet-env.sh exports
# it as CLAUDE_CONFIG_DIR for every fleet command and session, so `claude plugin list` below reads it
# too), else the account's ~/.claude. Its user-scope settings and plugins load in every fleet session.
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
elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && ! [ -d "$FLEET_CLAUDE_CONFIG_DIR" ]; then
  out="fleet verify: not verified: FLEET_CLAUDE_CONFIG_DIR not found: $FLEET_CLAUDE_CONFIG_DIR (see the fleet guide: a separate Claude config dir)"; rc=3
elif [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] && [ "${HARNESS:-claude}" = claude ] \
  && [ "$( (cd "${TMPDIR:-/tmp}" && CLAUDE_CONFIG_DIR="$FLEET_CLAUDE_CONFIG_DIR" claude auth status --json) 2>/dev/null | jq -r 'if .loggedIn == false then "false" else "" end' 2>/dev/null || true)" = false ]; then
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
    if ! (cd "$PIN_DIR" && claude plugin list --json) >"$plist" 2>/dev/null; then
      out="fleet verify: not verified: claude plugin list failed in $PIN_DIR"; rc=3
    fi
  fi
  if [ "$rc" = 0 ]; then
    args=(--repo "$repo" --tag "$ref" --plugin-id "engsys@$ENGSYS_MARKETPLACE" --project-dir "$PIN_DIR" --plugins "$plist" --harness "${HARNESS:-claude}" --check-settings --user-settings-dir "$claude_cfg")
    [ -z "${VERIFY_ALLOWED_USER_PLUGINS:-}" ] || args+=(--allowed-user-plugins "$VERIFY_ALLOWED_USER_PLUGINS")
    [ -z "${VERIFY_ALLOWED_USER_HOOKS:-}" ] || args+=(--allowed-user-hooks "$VERIFY_ALLOWED_USER_HOOKS")
    # User-scope config besides settings (agents, commands, skills, rules, memory, MCP servers) and memory
    # files above PIN_DIR: each must be on VERIFY_ALLOWED_USER_FILES. The user state file is
    # <dir>/.claude.json with a fleet config dir, else ~/.claude.json.
    args+=(--check-user-config --claude-json "${FLEET_CLAUDE_CONFIG_DIR:+$FLEET_CLAUDE_CONFIG_DIR/.claude.json}")
    [ -n "${FLEET_CLAUDE_CONFIG_DIR:-}" ] || args[${#args[@]}-1]="$HOME/.claude.json"
    [ -z "${VERIFY_ALLOWED_USER_FILES:-}" ] || args+=(--allowed-user-files "$VERIFY_ALLOWED_USER_FILES")
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
    [ -z "$max_age" ] || args+=(--cache "$FLEET_STATE/verify-wrappers.json" --max-age-min "$max_age")
    out="$(node "$FLEET_KIT_DIR/lib/verify-wrappers.mjs" "${args[@]}" 2>&1)" || rc=$?
    # node exits 1 on its own crash (a missing module, a syntax error): only the verifier's MISMATCH line counts.
    if [ "$rc" = 1 ] && ! grep -q '^verify: MISMATCH' <<<"$out"; then
      out="$out"$'\n'"fleet verify: not verified: the verifier failed (exit 1, above)"; rc=3
    fi
    case "$rc" in 0 | 1 | 3) ;; *) out="$out"$'\n'"fleet verify: not verified: the verifier exited $rc"; rc=3 ;; esac
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
  # Full ref names, never --short: a local branch or tag named origin/<x> makes --short ambiguous.
  pin_branch="$(git -C "$PIN_DIR" symbolic-ref -q HEAD 2>/dev/null || true)"
  case "$pin_branch" in refs/heads/*) pin_branch="${pin_branch#refs/heads/}" ;; *) pin_branch="" ;; esac
  def_branch="$(git -C "$PIN_DIR" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
  case "$def_branch" in refs/remotes/origin/?*) def_branch="${def_branch#refs/remotes/origin/}" ;; *) def_branch="" ;; esac
  : "${def_branch:=main}"
  if [ "$pin_branch" != "$def_branch" ]; then sync_why="the pin checkout is on '${pin_branch:-a detached HEAD}', not $def_branch"
  elif [ -n "$(git -C "$PIN_DIR" status --porcelain --untracked-files=no 2>/dev/null || echo dirty)" ]; then sync_why="the pin checkout has uncommitted changes to tracked files"
  elif [ -n "$(git -C "$PIN_DIR" status --porcelain -- .claude ':(exclude,icase).claude/settings.local.json' \
      ':(exclude,icase).claude/scheduled_tasks.lock' ':(exclude,icase).claude/worktrees' 2>/dev/null || echo dirty)" ]; then sync_why="the pin checkout's .claude/ has untracked files"
  else
    echo "fleet verify: the pin checkout is behind $def_branch and files the sessions load changed there: auto-syncing (fleet sync, no restarts)"
    if bash "$FLEET_KIT_DIR/sync.sh" --instance "$FLEET_REPO" </dev/null >&2; then
      [ -z "${plist:-}" ] || rm -f "$plist"
      reargs=(--instance "$FLEET_REPO"); [ "$alert" = 0 ] || reargs+=(--alert); [ -z "$max_age" ] || reargs+=(--max-age "$max_age")
      exec bash "$FLEET_KIT_DIR/verify.sh" "${reargs[@]}"   # once: the re-run has no --auto-sync
    fi
    sync_why="fleet sync failed (above)"
  fi
  out="$out"$'\n'"fleet verify: could not auto-sync: $sync_why"
fi
printf '%s\n' "$out"

if [ "$alert" = 1 ]; then
  case "$rc" in
    0)
      if [ -f "$LATCH" ]; then
        notify --level info --incident wrapper-integrity --resolve "Resolved: the engsys plugin files on $host match $repo@$ref again." && rm -f "$LATCH"
      fi
      if [ -f "$UNVERIFIED_LATCH" ]; then
        notify --level info --incident wrapper-integrity-unverified --resolve "Resolved: the engsys plugin check on $host runs again, and passes." && rm -f "$UNVERIFIED_LATCH"
      fi ;;
    1)
      fp="$(sed -n 's/^fingerprint: //p' <<<"$out" | tail -1)"
      if [ "$only_stale" = 1 ] && [ "$(cat "$LATCH" 2>/dev/null)" != "$fp|$sync_why" ]; then
        lines="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | head -n 8)"
        notify --level alert --incident wrapper-integrity "Plugin check on $host: the pin checkout ($PIN_DIR) is behind main, and files the sessions load changed there. $(if [ -n "$sync_why" ]; then printf 'Auto-sync could not fast-forward it: %s. Please bring the checkout back to main and run fleet sync.' "$sync_why"; else printf 'Auto-syncing: the supervisor runs fleet sync on its next tick.'; fi) Merge and maintain sessions are held until it matches; running sessions are left as they are. This is not a sign of tampering. Behind on:
$lines
Details: fleet verify" && printf '%s\n' "$fp|$sync_why" >"$LATCH"
      elif [ "$only_stale" = 0 ] && [ "$(cat "$LATCH" 2>/dev/null)" != "$fp" ]; then
        lines="$(sed -n 's/^  \(.*\)$/\1/p' <<<"$out" | head -n 8)"
        notify --level alert --incident wrapper-integrity "Plugin check on $host: what the merge and maintain monsters load does not match $repo@$ref (the engsys plugin and host kit), $PIN_REPO's default branch on GitHub (the pin checkout's .claude/ and hook scripts), or the allowed Claude settings in $claude_cfg, so it may have been changed on this host. Merge and maintain sessions will not be launched or relaunched here until it matches. Running sessions and their batons were left as they are: please check them and stop any you don't trust. Then fix what differs: for plugin files, reinstall (from a directory outside any project: claude plugin uninstall --scope user engsys@$ENGSYS_MARKETPLACE, delete its cache directory, then fleet sync); for the pin checkout, restore it to GitHub's main; for a user-scope plugin, remove it or list it in VERIFY_ALLOWED_USER_PLUGINS. What differs:
$lines
Details: fleet verify" && printf '%s\n' "$fp" >"$LATCH"
      fi ;;
    3)
      if [ ! -f "$UNVERIFIED_LATCH" ]; then
        notify --level alert --incident wrapper-integrity-unverified "Plugin check on $host could not run: $(tail -n 1 <<<"$out" | sed 's/^.*not verified[^:]*: //' | cut -c1-300). Merge and maintain sessions are held until it can confirm the plugin matches $repo@${ref:-the pin}. If GitHub is having trouble this resolves on its own; otherwise see fleet verify." \
          && now >"$UNVERIFIED_LATCH"
      fi ;;
  esac
fi
[ "$rc" != 1 ] || result=mismatch
exit "$rc"
