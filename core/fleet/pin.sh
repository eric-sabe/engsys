#!/usr/bin/env bash
# pin.sh — release + pin in one step: move the fleet to new engsys / instance releases.
#
#   1. engsys: the tag must already exist on the engsys remote (its releases are cut by hand from the
#      maintainer's login); if it doesn't, the error prints the exact `gh release create` command.
#   2. instance (only when INSTANCE_MARKETPLACE is set): `--release next` (patch + 1 over the latest v*
#      tag) or `--release vX.Y.Z` cuts a release of the instance repo's origin/main: a stamp commit that
#      sets metadata.version in .claude-plugin/marketplace.json and version in every plugin listed there,
#      `claude plugin validate`, an annotated tag, the tag pushed, a GitHub release. An existing tag is
#      used as is. `next` with nothing new on main since the last release reuses the last release.
#   3. opens the pin PR in PIN_REPO: .claude/settings.json marketplace refs only (verified with a jq
#      strip-diff), PREPUSH_SETUP_CMD, a normal push, then REVIEW_CMD (if set) is run in the PR worktree
#      and its output posted as a comment opening with REVIEW_MARKER. READY_LABEL is added when the
#      review exited 0 and its output doesn't match REVIEW_BLOCK_REGEX (no REVIEW_CMD: label directly).
#      Re-running is safe: an open, labeled PR for the same pins is reused as is; an open, unlabeled one
#      just gets its review re-run.
#   4. waits for the merge (polls every 60 s, up to PIN_WAIT_MAX_MIN), then runs `fleet sync` (host
#      checkouts + plugin reinstall). Sessions are NOT restarted — that's `fleet restart`.
#
# Usage: pin.sh [--instance <dir>] [--engsys <tag>] [--release <tag>|next] [--no-wait]
#        fleet pin --release next                     # ship what's merged in the instance repo
#        fleet pin --engsys v1.2.0                    # adopt an engsys release
#        fleet pin --engsys v1.2.0 --release next     # both, one pin PR
#        add --no-wait to stop after the PR is queued (then run `fleet sync` after it merges)
# The instance-release flag is --release (not --instance): --instance names the instance DIRECTORY
# (`fleet --instance <dir> pin ...`). PIN_POLL_SECS (default 60) overrides the poll interval.
# Runs on the fleet host, where gh/git act as the fleet identity.
set -euo pipefail

main() {
  local engsys="" release="" wait=1
  if [ "${1:-}" = --instance ] && [ -d "${2:-}" ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --engsys) engsys="${2:?--engsys needs a tag}"; shift ;;
      --release) release="${2:?--release needs a tag or next}"; shift ;;
      --no-wait) wait=0 ;;
      -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
      --instance) echo "fleet-pin: --instance is the instance directory (before the command); to release the instance use --release <vX.Y.Z|next>" >&2; exit 2 ;;
      *) echo "fleet-pin: unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
  [ -n "$engsys$release" ] || { echo "usage: fleet pin [--engsys <tag>] [--release <vX.Y.Z>|next] [--no-wait]   (fleet pin --help)" >&2; exit 2; }
  # shellcheck source=lib/fleet-env.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"
  local t; for t in jq gh git perl; do command -v "$t" >/dev/null || fleet_die "$t is required"; done
  [ -z "$engsys" ] || [[ "$engsys" =~ ^[A-Za-z0-9._-]+$ ]] || fleet_die "engsys tag has unexpected characters: $engsys"
  if [ -n "$release" ]; then
    [ -n "$INSTANCE_MARKETPLACE" ] || fleet_die "--release needs INSTANCE_MARKETPLACE (this fleet has no instance plugin, so there is nothing to release)"
    command -v claude >/dev/null || fleet_die "claude is required to validate the release"
  fi
  [[ "$PIN_WAIT_MAX_MIN" =~ ^[0-9]+$ ]] || fleet_die "PIN_WAIT_MAX_MIN must be a number of minutes (got '$PIN_WAIT_MAX_MIN')"

  git -C "$PIN_DIR" rev-parse --git-dir >/dev/null 2>&1 || fleet_die "PIN_DIR is not a git checkout: $PIN_DIR"
  git -C "$PIN_DIR" fetch -q origin
  local cur_engsys cur_inst="" engsys_repo inst_repo=""
  MAIN_SETTINGS="$FLEET_STATE/pin-main.settings.json"
  mkdir -p "$FLEET_STATE"
  git -C "$PIN_DIR" show origin/main:.claude/settings.json >"$MAIN_SETTINGS" \
    || fleet_die "$PIN_REPO has no .claude/settings.json on origin/main"
  cur_engsys="$(fleet_pin "$ENGSYS_MARKETPLACE" "$MAIN_SETTINGS")"
  engsys_repo="$(fleet_pin_repo "$ENGSYS_MARKETPLACE" "$MAIN_SETTINGS")"
  [ -n "$cur_engsys" ] && [ -n "$engsys_repo" ] || fleet_die "no '$ENGSYS_MARKETPLACE' marketplace with a source repo and ref in $PIN_REPO's .claude/settings.json"
  if [ -n "$INSTANCE_MARKETPLACE" ]; then
    cur_inst="$(fleet_pin "$INSTANCE_MARKETPLACE" "$MAIN_SETTINGS")"
    inst_repo="$(fleet_pin_repo "$INSTANCE_MARKETPLACE" "$MAIN_SETTINGS")"
    [ -n "$cur_inst" ] && [ -n "$inst_repo" ] || fleet_die "no '$INSTANCE_MARKETPLACE' marketplace with a source repo and ref in $PIN_REPO's .claude/settings.json"
    say "pinned on $PIN_REPO main: $ENGSYS_MARKETPLACE $cur_engsys · $INSTANCE_MARKETPLACE $cur_inst"
  else
    say "pinned on $PIN_REPO main: $ENGSYS_MARKETPLACE $cur_engsys"
  fi

  [ -z "$engsys" ] || check_engsys_tag "$engsys" "$engsys_repo"
  [ -z "$release" ] || release="$(release_instance "$release" "$inst_repo")" || exit $?

  local new_engsys="${engsys:-$cur_engsys}" new_inst="${release:-$cur_inst}" pr="" already
  already="$PIN_REPO already pins $ENGSYS_MARKETPLACE $new_engsys"
  [ -z "$INSTANCE_MARKETPLACE" ] || already="$already · $INSTANCE_MARKETPLACE $new_inst"
  if [ "$new_engsys" = "$cur_engsys" ] && [ "$new_inst" = "$cur_inst" ]; then
    say "$already — no PR needed"
  else
    pr="$(open_pin_pr "$cur_engsys" "$new_engsys" "$cur_inst" "$new_inst")" || exit $?
  fi

  [ "$wait" = 1 ] || { say "not waiting. After it merges: fleet sync"; exit 0; }
  [ -z "$pr" ] || wait_for_merge "$pr"
  exec bash "$FLEET_KIT_DIR/sync.sh" --instance "$FLEET_REPO"
}

say() { echo "fleet-pin: $*"; }
must() { "$@" || fleet_die "pin: failed: $*"; }
rm_worktree() { # rm_worktree <repo> <dir> — drop a (possibly stale) scratch worktree
  git -C "$1" worktree remove --force "$2" >/dev/null 2>&1 || true
  rm -rf "$2"
  git -C "$1" worktree prune
}

# The helpers below that return a value on stdout run inside $(...) and start with
# `exec 3>&1 1>&2`: their stdout is the caller's capture (fd 3, written only by `emit`), and every other
# thing they run (git hook output, gh output, setup and review commands) lands on stderr.
# Inside $(...) errexit is off, so every step that matters is wrapped in `must` / `|| fleet_die`.
emit() { echo "$1" >&3; }

check_engsys_tag() { # check_engsys_tag <tag> <owner/repo>
  local rc=0
  git ls-remote --exit-code --tags "https://github.com/$2.git" "refs/tags/$1" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) ;;
    2) fleet_die "$ENGSYS_MARKETPLACE $1 isn't released. From a machine logged in as the maintainer: gh release create $1 -R $2 --target main --generate-notes" ;;
    *) fleet_die "couldn't list tags of https://github.com/$2.git (git ls-remote exit $rc)" ;;
  esac
}

# --- instance release --------------------------------------------------------------------------
stamp_json() { # stamp_json <file> <version> <jq program using $v>
  jq --indent 2 --arg v "$2" "$3" "$1" >"$1.new" && cat "$1.new" >"$1" && rm -f "$1.new"
}

release_instance() { # release_instance <vX.Y.Z|next> <owner/repo> → echoes the tag to pin
  exec 3>&1 1>&2
  local want="$1" repo="$2" latest base ver wt mf src dir manifest n_all n_src
  local plugin_dirs=()
  must git -C "$FLEET_REPO" fetch -q --tags origin
  latest="$(git -C "$FLEET_REPO" tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
  if [ "$want" = next ]; then
    if [ -z "$latest" ]; then
      want=v0.1.0
    else
      # a release tag sits on a stamp commit ("release: vX") on top of the main commit it shipped
      base="$(git -C "$FLEET_REPO" rev-parse "$latest^{commit}")" || fleet_die "can't resolve $latest"
      case "$(git -C "$FLEET_REPO" log -1 --format=%s "$base")" in
        'release: '*) base="$(git -C "$FLEET_REPO" rev-parse "$base^")" || fleet_die "can't resolve the base of $latest" ;;
      esac
      if [ "$(git -C "$FLEET_REPO" rev-parse origin/main)" = "$base" ]; then
        say "nothing new on $repo main since $latest — pinning $latest"
        emit "$latest"; return 0
      fi
      ver="${latest#v}"; want="v${ver%.*}.$(( ${ver##*.} + 1 ))"
    fi
  fi
  [[ "$want" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fleet_die "instance release tag must look like vX.Y.Z or 'next' (got '$want')"
  if git -C "$FLEET_REPO" rev-parse -q --verify "refs/tags/$want" >/dev/null; then
    say "$INSTANCE_MARKETPLACE $want already released — pinning it"
    emit "$want"; return 0
  fi
  ver="${want#v}"
  wt="$FLEET_STATE/wt-release"
  rm_worktree "$FLEET_REPO" "$wt"
  must git -C "$FLEET_REPO" worktree add -q --detach "$wt" origin/main

  # Stamp: marketplace version, then every plugin the marketplace lists (its source is a relative
  # directory holding .claude-plugin/plugin.json; an entry that carries its own version is stamped too).
  mf="$wt/.claude-plugin/marketplace.json"
  [ -f "$mf" ] || fleet_die "$repo origin/main has no .claude-plugin/marketplace.json"
  must stamp_json "$mf" "$ver" '.metadata.version = $v | (.plugins[]? | select(has("version")) | .version) = $v'
  n_all="$(jq '.plugins // [] | length' "$mf")"
  n_src=0
  while IFS= read -r src; do
    n_src=$((n_src + 1))
    dir="${src#./}"; [ "$dir" != . ] || dir=""
    case "$dir" in /* | ../* | */../* | */.. | ..) fleet_die "plugin source '$src' in the marketplace must stay inside the repo" ;; esac
    manifest="$wt${dir:+/$dir}/.claude-plugin/plugin.json"
    if [ ! -f "$manifest" ]; then
      say "WARNING plugin source '$src' has no .claude-plugin/plugin.json — not stamped"
      continue
    fi
    must stamp_json "$manifest" "$ver" '.version = $v'
    [ "$(jq -r .version "$manifest")" = "$ver" ] || fleet_die "version stamp failed in $manifest"
    plugin_dirs+=("$wt${dir:+/$dir}")
  done < <(jq -r '.plugins[]? | .source | strings' "$mf")
  [ "$n_src" = "$n_all" ] || say "WARNING $((n_all - n_src)) plugin(s) in the marketplace have a non-directory source — not stamped"
  [ "$(jq -r .metadata.version "$mf")" = "$ver" ] || fleet_die "version stamp failed in $mf"

  must claude plugin validate "$wt"
  for dir in ${plugin_dirs[@]+"${plugin_dirs[@]}"}; do must claude plugin validate "$dir"; done

  must git -C "$wt" commit -q --allow-empty -am "release: $want"
  must git -C "$wt" tag -a "$want" -m "$INSTANCE_MARKETPLACE $want"
  git -C "$wt" push -q origin "refs/tags/$want" || {
    git -C "$FLEET_REPO" tag -d "$want" >/dev/null   # never leave an unpushed tag that a re-run would treat as released
    fleet_die "pushing tag $want to $repo failed (the local tag was removed; re-run to retry)"
  }
  gh release create "$want" -R "$repo" --verify-tag --generate-notes \
    || fleet_die "tag $want is pushed but the GitHub release failed. Create it: gh release create $want -R $repo --verify-tag --generate-notes   then re-run"
  rm_worktree "$FLEET_REPO" "$wt"
  say "released $INSTANCE_MARKETPLACE $want ($(git -C "$FLEET_REPO" rev-parse --short origin/main) + version stamp)"
  emit "$want"
}

# --- pin PR ------------------------------------------------------------------------------------
set_ref() { # set_ref <settings-file> <marketplace> <ref> — text edit of that marketplace's source.ref only
  MK="$2" NEWREF="$3" perl -0pe \
    's/("\Q$ENV{MK}\E"\s*:\s*\{\s*"source"\s*:\s*\{[^}]*?"ref"\s*:\s*")[^"]*/$1$ENV{NEWREF}/' "$1" >"$1.new" \
    && cat "$1.new" >"$1" && rm -f "$1.new"
}

open_pin_pr() { # open_pin_pr <cur_engsys> <new_engsys> <cur_inst> <new_inst> → echoes the PR number
  exec 3>&1 1>&2
  local ce="$1" ne="$2" ci="$3" ni="$4" branch wt title body pr existing markets s files
  branch="chore/pins-$ne"; title="chore(fleet): pin $ENGSYS_MARKETPLACE $ne"
  markets="$(jq -cn --arg e "$ENGSYS_MARKETPLACE" '[$e]')"
  if [ -n "$INSTANCE_MARKETPLACE" ]; then
    branch="$branch-$ni"; title="$title, $INSTANCE_MARKETPLACE $ni"
    markets="$(jq -cn --arg e "$ENGSYS_MARKETPLACE" --arg i "$INSTANCE_MARKETPLACE" '[$e, $i]')"
  fi
  wt="$FLEET_STATE/wt-pin"
  rm_worktree "$PIN_DIR" "$wt"

  # Re-run after an interruption: reuse the open PR for these exact pins.
  existing="$(gh pr list -R "$PIN_REPO" --head "$branch" --state open --json number,labels \
    | jq -r --arg l "$READY_LABEL" '.[0] // empty | "\(.number) \(any(.labels[]?; .name == $l))"')" \
    || fleet_die "couldn't list open PRs in $PIN_REPO"
  if [ -n "$existing" ]; then
    pr="${existing%% *}"
    if [ "${existing#* }" = true ]; then
      say "$PIN_REPO#$pr (these pins) is already open and queued — reusing it"
      emit "$pr"; return 0
    fi
    say "$PIN_REPO#$pr (these pins) is already open — re-running its review"
    must git -C "$PIN_DIR" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"
    must git -C "$PIN_DIR" worktree add -q --detach "$wt" "origin/$branch"
    review_and_queue "$pr" "$wt" "$branch"
    emit "$pr"; return 0
  fi

  must git -C "$PIN_DIR" worktree add -q -B "$branch" "$wt" origin/main
  s="$wt/.claude/settings.json"
  set_ref "$s" "$ENGSYS_MARKETPLACE" "$ne" || fleet_die "couldn't edit $s"
  [ -z "$INSTANCE_MARKETPLACE" ] || set_ref "$s" "$INSTANCE_MARKETPLACE" "$ni" || fleet_die "couldn't edit $s"
  [ "$(fleet_pin "$ENGSYS_MARKETPLACE" "$s")" = "$ne" ] || fleet_die "couldn't set the $ENGSYS_MARKETPLACE ref in $s"
  [ -z "$INSTANCE_MARKETPLACE" ] || [ "$(fleet_pin "$INSTANCE_MARKETPLACE" "$s")" = "$ni" ] || fleet_die "couldn't set the $INSTANCE_MARKETPLACE ref in $s"
  # the edit must move the refs and nothing else
  local strip='del(.extraKnownMarketplaces[$ms[]].source.ref)'
  [ "$(jq -S --argjson ms "$markets" "$strip" "$s")" = "$(jq -S --argjson ms "$markets" "$strip" "$MAIN_SETTINGS")" ] \
    || fleet_die "the pin edit touched more than the refs — inspect $wt"

  if [ -n "${PREPUSH_SETUP_CMD:-}" ]; then
    say "running PREPUSH_SETUP_CMD…"
    (cd "$wt" && bash -c "$PREPUSH_SETUP_CMD") || fleet_die "PREPUSH_SETUP_CMD failed in $wt"
  fi
  must git -C "$wt" commit -q -m "$title" -- .claude/settings.json   # only the settings file, whatever the setup step touched
  files="$(git -C "$wt" diff --name-only origin/main HEAD)"
  [ "$files" = ".claude/settings.json" ] || fleet_die "the pin commit changed more than .claude/settings.json ($files) — inspect $wt"
  say "pushing $branch…"
  must git -C "$wt" push -q -u --force origin "$branch"   # our own generated branch; --force covers a re-run after a half-finished push
  body="Moves the fleet's plugin pins in \`.claude/settings.json\` (nothing else):

| Marketplace | From | To |
|---|---|---|
| $ENGSYS_MARKETPLACE | \`$ce\` | \`$ne\` |"
  [ -z "$INSTANCE_MARKETPLACE" ] || body="$body
| $INSTANCE_MARKETPLACE | \`$ci\` | \`$ni\` |"
  body="$body

Opened by \`fleet pin\` on the fleet host. After merge the host runs \`fleet sync\` (checkouts + plugin reinstall); sessions pick the new versions up when they're cycled (\`fleet restart\`)."
  must gh pr create -R "$PIN_REPO" --head "$branch" --base main --title "$title" --body "$body"
  pr="$(gh pr view "$branch" -R "$PIN_REPO" --json number -q .number)" && [[ "$pr" =~ ^[0-9]+$ ]] \
    || fleet_die "couldn't find the PR just created for $branch in $PIN_REPO"
  review_and_queue "$pr" "$wt" "$branch"
  emit "$pr"
}

review_and_queue() { # review_and_queue <pr> <worktree> <branch> — review → marker comment → READY_LABEL (exit 1 if it needs a look)
  local pr="$1" wt="$2" branch="$3" review rc=0 summary
  review="$FLEET_STATE/pin-review.txt"
  if [ -z "${REVIEW_CMD:-}" ]; then
    rm_worktree "$PIN_DIR" "$wt"; git -C "$PIN_DIR" branch -q -D "$branch" 2>/dev/null || true
    must gh pr edit "$pr" -R "$PIN_REPO" --add-label "$READY_LABEL"
    say "$PIN_REPO#$pr queued ($READY_LABEL) — no REVIEW_CMD configured"
    return 0
  fi
  say "review: $REVIEW_CMD"
  (cd "$wt" && bash -c "$REVIEW_CMD") >"$review" 2>&1 || rc=$?
  summary="**Review** (\`$REVIEW_CMD\`, exit $rc) — pin-only change posted by \`fleet pin\`."
  {
    [ -z "${REVIEW_MARKER:-}" ] || printf '%s\n' "$REVIEW_MARKER"
    printf '%s\n\n<details><summary>Output</summary>\n\n````\n' "$summary"
    head -c 60000 "$review"
    printf '\n````\n</details>\n'
  } | gh pr comment "$pr" -R "$PIN_REPO" --body-file - || fleet_die "couldn't post the review comment on $PIN_REPO#$pr"
  rm_worktree "$PIN_DIR" "$wt"; git -C "$PIN_DIR" branch -q -D "$branch" 2>/dev/null || true
  if [ "$rc" = 0 ] && { [ -z "${REVIEW_BLOCK_REGEX:-}" ] || ! grep -iq -- "$REVIEW_BLOCK_REGEX" "$review"; }; then
    must gh pr edit "$pr" -R "$PIN_REPO" --add-label "$READY_LABEL"
    say "$PIN_REPO#$pr queued ($READY_LABEL)"
  else
    say "review needs a look before it's queued: $review (exit $rc)."
    say "if it's fine: gh pr edit $pr -R $PIN_REPO --add-label '$READY_LABEL'   then: fleet sync after it merges"
    exit 1
  fi
}

# --- wait --------------------------------------------------------------------------------------
wait_for_merge() { # wait_for_merge <pr> — returns on MERGED; dies on CLOSED; exits 0 on timeout
  local pr="$1" st start="$SECONDS" max=$((PIN_WAIT_MAX_MIN * 60))
  say "waiting for $PIN_REPO#$pr to merge (up to ${PIN_WAIT_MAX_MIN} min; Ctrl-C is safe — run fleet sync after it merges)"
  trap 'echo; say "stopped waiting. Run fleet sync after it merges."; exit 130' INT
  while :; do
    st="$(gh pr view "$pr" -R "$PIN_REPO" --json state -q .state 2>/dev/null || echo UNKNOWN)"
    case "$st" in
      MERGED) say "merged."; break ;;
      CLOSED) fleet_die "$PIN_REPO#$pr was closed without merging" ;;
    esac
    if [ $((SECONDS - start)) -ge "$max" ]; then
      say "still not merged after ${PIN_WAIT_MAX_MIN} min. Run fleet sync after $PIN_REPO#$pr merges."
      exit 0
    fi
    sleep "${PIN_POLL_SECS:-60}"
  done
  trap - INT
}

# Wrapped in main so bash parses the whole file before the exec into sync.sh swaps code underneath it.
main "$@"
exit
