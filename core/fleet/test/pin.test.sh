#!/usr/bin/env bash
# pin.test.sh — sandbox tests for `fleet pin` (run by `npm test`; no network, no real gh/claude).
#
# Same harness as fleet.test.sh (sandbox.sh): a temp HOME whose git config maps https://github.com/ to
# local bare remotes (an engsys repo, an instance repo, the pin repo), plus stub `gh` (a small PR /
# comment / label / release state machine that, like the real one, prints URLs on stdout), `claude`
# (validate) and a review command. The kit under test is a copy of this tree whose sync.sh is a stub
# that only records that it ran.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_SRC="$(cd "$HERE/.." && pwd -P)"      # core/fleet
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

G="$FAKE/gh"; mkdir -p "$G/comments"
: >"$FAKE/gh.log"; : >"$FAKE/claude.log"; : >"$FAKE/claude.env"; : >"$FAKE/review.log"; : >"$FAKE/sync.log"

# --- the kit under test ------------------------------------------------------------------------
KIT="$T/kit"
cp -R "$KIT_SRC" "$KIT"; rm -rf "$KIT/test"
cat >"$KIT/sync.sh" <<'SH'
#!/usr/bin/env bash
echo "SYNC-RAN $*" >>"$FAKE/sync.log"
echo "stub sync ran: $*"
SH

# --- stubs -------------------------------------------------------------------------------------
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$FAKE/claude.log"
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}" >>"$FAKE/claude.env"
if [ "${1:-} ${2:-}" = "plugin validate" ]; then
  [ ! -e "$FAKE/validate.fail" ] || { echo "stub claude: validation failed" >&2; exit 1; }
  echo "Validation passed"; exit 0
fi
exit 2
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
# stub gh: pr list|create|view|comment|edit, release create. State: one PR per repo — $FAKE/gh/pr.json for
# the pin repo (acme/app), $FAKE/gh/pr.<owner>_<repo>.json for any other —, $FAKE/gh/counter,
# $FAKE/gh/comments/NNN, $FAKE/gh/view-states (optional: `pr view --json state` answers, one per call).
G="$FAKE/gh"; mkdir -p "$G/comments"
echo "gh $*" >>"$FAKE/gh.log"
arg() { local want="$1" prev="" a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then echo "$a"; return; fi; prev="$a"; done; }
repo="$(arg -R "$@")"; repo="${repo:-acme/app}"
url="https://github.com/$repo/pull"
pj="$G/pr.json"; [ "$repo" = acme/app ] || pj="$G/pr.${repo//\//_}.json"
q="$(arg -q "$@")"
out() { if [ -n "$q" ]; then jq -r "$q"; else cat; fi; }
case "${1:-} ${2:-}" in
  "pr list")
    h="$(arg --head "$@")"; st="$(arg --state "$@" | tr '[:lower:]' '[:upper:]')"; st="${st:-OPEN}"
    if [ -f "$pj" ] && jq -e --arg h "$h" --arg st "$st" '.head == $h and ($st == "ALL" or .state == $st)' "$pj" >/dev/null; then
      jq -c --arg u "$url" '[{number, url: "\($u)/\(.number)", labels: [.labels[] | {name: .}]}]' "$pj" | out
    else
      echo '[]' | out
    fi ;;
  "pr create")
    n=$(( $(cat "$G/counter" 2>/dev/null || echo 40) + 1 )); echo "$n" >"$G/counter"
    jq -n --argjson n "$n" --arg h "$(arg --head "$@")" --arg t "$(arg --title "$@")" \
      '{number: $n, head: $h, title: $t, state: "OPEN", labels: []}' >"$pj"
    echo "$url/$n" ;;
  "pr view")
    case "$q" in
      .number) jq -r .number "$pj" ;;
      .url) echo "$url/$(jq -r .number "$pj")" ;;
      .state)
        if [ -s "$G/view-states" ]; then
          head -n1 "$G/view-states"
          if [ "$(wc -l <"$G/view-states")" -gt 1 ]; then tail -n +2 "$G/view-states" >"$G/view-states.new"; mv "$G/view-states.new" "$G/view-states"; fi
        else
          jq -r .state "$pj"
        fi ;;
    esac ;;
  "pr comment")
    f="$G/comments/$(printf '%03d' $(( $(ls "$G/comments" | wc -l) + 1 )))"
    cat >"$f"; echo "$url/$3#issuecomment-1" ;;
  "pr edit")
    l="$(arg --add-label "$@")"
    if [ -n "$l" ]; then jq --arg l "$l" '.labels += [$l] | .labels |= unique' "$pj" >"$G/pr.new" && mv "$G/pr.new" "$pj"; fi
    echo "$url/$3" ;;
  "release create")
    git ls-remote --exit-code --tags "https://github.com/$repo.git" "refs/tags/$3" >/dev/null || { echo "stub gh: no such tag on the remote: $3" >&2; exit 1; }
    echo "https://github.com/$repo/releases/tag/$3" ;;
esac
exit 0
SH
cat >"$T/bin/acme-review" <<'SH'
#!/usr/bin/env bash
echo "review $PWD $*" >>"$FAKE/review.log"
cat "$FAKE/review.out" 2>/dev/null || true
exit "$(cat "$FAKE/review.rc" 2>/dev/null || echo 0)"
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- remotes -----------------------------------------------------------------------------------
E="$T/seed/engsys"
seed_repo vendor/engsys "$E"
mkdir -p "$E/.claude-plugin" "$E/core/.claude-plugin"
seed_engsys_ver() {
  printf '{"name":"engsys","version":"%s"}\n' "$1" >"$E/package.json"
  printf '{"name":"engsys","metadata":{"version":"%s"}}\n' "$1" >"$E/.claude-plugin/marketplace.json"
  printf '{"name":"engsys","version":"%s"}\n' "$1" >"$E/core/.claude-plugin/plugin.json"
}
echo engsys >"$E/README"; seed_engsys_ver 1.0.0; commit_all "$E" "engsys 1.0.0"; git -C "$E" tag v1.0.0
seed_engsys_ver 1.1.0; commit_all "$E" "engsys 1.1.0"; git -C "$E" tag v1.1.0
git -C "$E" commit -q --allow-empty -m "engsys 1.1.1 without manifest bump"; git -C "$E" tag v1.1.1
push_all "$E"     # v1.2.0 is deliberately not released; v1.1.1 has stale 1.1.0 manifests

# the instance repo: main at "instance base"; v0.1.0 is a stamp commit ON TOP of it (as releases were cut
# before engsys#227), tagged and pushed as a tag only — main never carries the stamp
I="$T/seed/acme-fleet"
seed_repo acme/acme-fleet "$I"
mkdir -p "$I/fleet" "$I/.claude-plugin" "$I/plugin/.claude-plugin" "$I/plugins/tools/.claude-plugin"
cat >"$I/fleet/fleet.conf" <<'EOF'
FLEET_ORG=acme
PIN_REPO=acme/app
PIN_DIR=~/git/app
INSTANCE_MARKETPLACE=acme
REVIEW_CMD=acme-review --base origin/main
REVIEW_MARKER=<!-- local-review-findings -->
PREPUSH_SETUP_CMD=echo "$PWD" >"$FAKE/setup.cwd"; echo drift >>pnpm-lock.yaml; touch untracked.tmp
EOF
cat >"$I/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "acme",
  "owner": { "name": "Acme" },
  "metadata": { "description": "Acme fleet plugins", "version": "0.0.0" },
  "plugins": [
    { "name": "ctx", "source": "./plugin", "description": "context" },
    { "name": "tools", "source": "./plugins/tools", "description": "tools" },
    { "name": "remote", "source": { "source": "github", "repo": "acme/remote-plugin" } }
  ]
}
EOF
echo '{ "name": "ctx", "version": "0.0.0", "description": "context" }' >"$I/plugin/.claude-plugin/plugin.json"
echo '{ "name": "tools", "version": "0.0.0", "description": "tools" }' >"$I/plugins/tools/.claude-plugin/plugin.json"
printf '.fleet/\n' >"$I/.gitignore"
commit_all "$I" "instance base"
git -C "$I" commit -q --allow-empty -m "release: v0.1.0"; git -C "$I" tag -a v0.1.0 -m "acme v0.1.0"
git -C "$I" reset -q --hard HEAD~1
push_all "$I"

# the pin repo (mixed inline / multi-line formatting on purpose: the edit must keep it)
P="$T/seed/app"
seed_repo acme/app "$P"
mkdir -p "$P/.claude"
write_settings() { # write_settings <engsys-ref> <acme-ref>
  cat >"$P/.claude/settings.json" <<EOF
{
  "extraKnownMarketplaces": {
    "engsys": {
      "source": { "source": "github", "repo": "vendor/engsys", "ref": "$1" }
    },
    "acme": {
      "source": {
        "source": "github",
        "repo": "acme/acme-fleet",
        "ref": "$2"
      }
    }
  },
  "enabledPlugins": { "core@engsys": true, "ctx@acme": true },
  "permissions": { "allow": ["Bash(git status)"] }
}
EOF
}
write_settings v1.0.0 v0.1.0
echo "lock v1" >"$P/pnpm-lock.yaml"
commit_all "$P" "pins 1"; push_all "$P"

# the host: pin checkout (with noisy hooks, like a lint-staged / pre-push gate) and the instance checkout
git clone -q https://github.com/acme/app.git "$HOME/git/app"
printf '#!/bin/sh\necho "HOOK-NOISE pre-commit"\n' >"$HOME/git/app/.git/hooks/pre-commit"
printf '#!/bin/sh\necho "HOOK-NOISE pre-push"\n' >"$HOME/git/app/.git/hooks/pre-push"
chmod +x "$HOME/git/app/.git/hooks/pre-commit" "$HOME/git/app/.git/hooks/pre-push"
git clone -q https://github.com/acme/acme-fleet.git "$T/inst"
printf '#!/bin/sh\necho "HOOK-NOISE instance pre-commit"\n' >"$T/inst/.git/hooks/pre-commit"
printf '#!/bin/sh\necho "HOOK-NOISE instance pre-push"\n' >"$T/inst/.git/hooks/pre-push"
chmod +x "$T/inst/.git/hooks/pre-commit" "$T/inst/.git/hooks/pre-push"

INST="$T/inst"
STATE="$INST/.fleet"
PINREM="$T/remotes/acme/app.git"
INSTREM="$T/remotes/acme/acme-fleet.git"
fleet() { bash "$KIT/bin/fleet" --instance "$INST" "$@"; }
conf() { printf '%s\n' "$@" >"$HOME/.config/acme/fleet.local.conf"; }
conf_reset() { rm -f "$HOME/.config/acme/fleet.local.conf"; }
gcount() { grep -cF -- "$1" "$FAKE/gh.log" || true; }
rev_lines() { wc -l <"$FAKE/review.log" | tr -d ' '; }
ncomments() { ls "$G/comments" | wc -l | tr -d ' '; }
last_comment() { local f; f="$(ls "$G/comments"/* | tail -n1)"; cat "$f"; }
pr_field() { jq -r "$1" "$G/pr.json"; }
rem_diff() { git --git-dir="$PINREM" diff -U0 main "$1" | grep -E '^[-+][^-+]' || true; } # changed content lines only
reset() { # a clean slate between scenarios: no PR, no branches on the remote, empty logs
  rm -rf "$G/pr.json" "$G/view-states" "$G/comments"; rm -f "$G"/pr.*.json; mkdir -p "$G/comments"
  local b
  for b in $(git --git-dir="$PINREM" for-each-ref --format='%(refname:short)' refs/heads/chore); do git --git-dir="$PINREM" branch -q -D "$b"; done
  for b in $(git --git-dir="$INSTREM" for-each-ref --format='%(refname:short)' refs/heads/release); do git --git-dir="$INSTREM" branch -q -D "$b"; done
  : >"$FAKE/gh.log"; : >"$FAKE/review.log"; : >"$FAKE/sync.log"; : >"$FAKE/claude.log"; : >"$FAKE/claude.env"
  rm -f "$FAKE/review.out" "$FAKE/review.rc" "$FAKE/setup.cwd" "$FAKE/validate.fail"
  conf_reset
}
noworktrees() { eq "$1: scratch worktrees are gone" "$(git -C "$2" worktree list | wc -l | tr -d ' ')" 1; }

# =============================================================================================
echo "== A. arguments and preconditions"
reset
run fleet pin
rc_is "no arguments is a usage error" 2; has "…that shows the usage" "$OUT" "usage: fleet pin"
run fleet pin --instance next
rc_is "--instance is not the release flag" 2; has "…and points at --release" "$OUT" "--release"
run fleet pin --frobnicate
rc_is "unknown flag exits 2" 2
run fleet pin --release 1.2 --no-wait
rc_is "a malformed release tag is refused" 1; has "…naming the format" "$OUT" "vX.Y.Z"
run fleet pin --release v0.0.5 --no-wait
rc_is "a new version below the latest tag is refused" 1; has "…saying why" "$OUT" "v0.0.5 is below the latest release v0.1.0"
eq "…no release PR" "$(gcount 'pr create')" 0
run fleet pin --engsys 'v1;rm' --no-wait
rc_is "an engsys tag with odd characters is refused" 1
run fleet pin --engsys v9.9.9 --no-wait
rc_is "a missing engsys tag dies" 1
has "…printing the exact release command" "$OUT" "gh release create v9.9.9 -R vendor/engsys --target main --generate-notes"
eq "…before anything is opened" "$(gcount 'pr create')" 0
eq "…or released" "$(gcount 'release create')" 0
run fleet pin --engsys v1.1.1 --release next --no-wait
rc_is "an engsys tag whose manifests don't match the tag version dies" 1
has "…reporting the mismatched manifest versions" "$OUT" "manifests don't match 1.1.1 (package.json=1.1.0, .claude-plugin/marketplace.json=1.1.0, core/.claude-plugin/plugin.json=1.1.0)"
has "…and printing the bump recipe" "$OUT" "npm run build:plugins"
eq "…before cutting an instance release" "$(gcount 'release create')" 0
eq "…or opening a pin PR" "$(gcount 'pr create')" 0

echo "== B. next never reuses an off-main tag; already pinned: no PR, straight to sync"
reset
# v0.1.0 is a pre-#227 stamp commit whose parent IS main: next must not pin it again, but release past it
run fleet pin --release next
rc_is "next over an off-main tag whose parent is main: exits 3" 3
has "…says the tag is off main" "$OUT" "v0.1.0 is not on acme/acme-fleet main"
hasnt "…does not reuse it" "$OUT" "pinning v0.1.0"
has "…opens the release PR for latest + 1" "$OUT" "opened the release PR for acme v0.1.1"
eq "…on the instance repo" "$(jq -r .title "$G/pr.acme_acme-fleet.json")" "release: v0.1.1"
eq "…no pin PR" "$(gcount 'pr create -R acme/app')" 0
eq "…no sync" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 0
reset
run fleet pin --release v0.1.0
rc_is "exits 0" 0
has "an existing tag is reused as is" "$OUT" "acme v0.1.0 already released — pinning it"
has "no PR needed" "$OUT" "no PR needed"
eq "no PR" "$(gcount 'pr ')" 0
eq "no release" "$(gcount 'release create')" 0
eq "no new tag" "$(git -C "$INST" tag -l 'v*' | paste -sd' ' -)" v0.1.0
has "sync runs (with the instance)" "$(cat "$FAKE/sync.log")" "SYNC-RAN --instance $INST"
run fleet pin --engsys v1.0.0 --release v0.1.0 --no-wait
rc_is "--no-wait when already pinned exits 0" 0; has "…says it isn't waiting" "$OUT" "not waiting"
eq "…and doesn't sync" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 1

echo "== C. pin PR: refs only, review comment with the marker, label; an existing release is reused"
reset
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "exits 0" 0
has "the existing v0.1.0 is reused" "$OUT" "acme v0.1.0 already released — pinning it"
eq "no instance release was cut" "$(gcount 'release create')" 0
BR=chore/pins-v1.1.0-v0.1.0
git --git-dir="$PINREM" rev-parse -q --verify "refs/heads/$BR" >/dev/null && ok "branch $BR pushed" || bad "branch $BR pushed"
eq "the branch touches one file" "$(git --git-dir="$PINREM" diff --name-only main "$BR")" ".claude/settings.json"
eq "the branch diff is exactly the engsys ref line (the instance ref didn't move)" "$(rem_diff "$BR")" \
  '-      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.0.0" }
+      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.1.0" }'
git --git-dir="$PINREM" diff --quiet main "$BR" -- pnpm-lock.yaml && ok "setup-step changes are not committed" || bad "setup-step changes are not committed"
eq "commit title" "$(git --git-dir="$PINREM" log -1 --format=%s "$BR")" "chore(fleet): pin engsys v1.1.0, acme v0.1.0"
eq "PR title" "$(pr_field .title)" "chore(fleet): pin engsys v1.1.0, acme v0.1.0"
eq "PREPUSH_SETUP_CMD ran in the pin worktree" "$(cat "$FAKE/setup.cwd")" "$STATE/wt-pin"
eq "the review ran in the pin worktree" "$(awk '{print $2}' "$FAKE/review.log")" "$STATE/wt-pin"
has "the review got its configured arguments" "$(cat "$FAKE/review.log")" "--base origin/main"
PRN="$(pr_field .number)"
has "PR body carries the from/to table" "$(cat "$FAKE/gh.log")" '| engsys | `v1.0.0` | `v1.1.0` |'
has "…for the instance too" "$(cat "$FAKE/gh.log")" '| acme | `v0.1.0` | `v0.1.0` |'
# stdout hygiene: hook noise and gh's URLs never leak into the captured PR number
has "the comment goes to the clean PR number" "$(cat "$FAKE/gh.log")" "gh pr comment $PRN -R acme/app --body-file -"
hasnt "no captured value is polluted (hooks)" "$(cat "$FAKE/gh.log")" "HOOK-NOISE"
has "the label goes to the clean PR number" "$(cat "$FAKE/gh.log")" "gh pr edit $PRN -R acme/app --add-label mm:ready"
eq "one review comment" "$(ncomments)" 1
eq "it opens with the marker" "$(last_comment | head -n1)" "<!-- local-review-findings -->"
has "…then the summary with the exit code" "$(last_comment)" "exit 0"
has "…and the output in a details block" "$(last_comment)" "<details><summary>Output</summary>"
eq "PR is labeled" "$(pr_field '.labels | join(",")')" "mm:ready"
has "the queue is announced" "$OUT" "queued (mm:ready)"
has "…and --no-wait stops" "$OUT" "not waiting"
eq "sync did not run" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 0
noworktrees "pin repo" "$HOME/git/app"
git -C "$HOME/git/app" rev-parse -q --verify "refs/heads/$BR" >/dev/null && bad "local pin branch is deleted" || ok "local pin branch is deleted"

echo "== D. re-runs: open + labeled (nothing new); open + unlabeled (only the review re-runs)"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "re-run exits 0" 0
has "reuses the queued PR" "$OUT" "already open and queued — reusing it"
eq "no second PR" "$(gcount 'pr create')" 1
eq "no second review" "$(rev_lines)" 1
eq "no second comment" "$(ncomments)" 1
jq '.labels = []' "$G/pr.json" >"$G/pr.new" && mv "$G/pr.new" "$G/pr.json"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "re-run on an unlabeled PR exits 0" 0
has "re-runs its review" "$OUT" "already open — re-running its review"
eq "still one PR created" "$(gcount 'pr create')" 1
eq "the review ran again" "$(rev_lines)" 2
eq "…and commented again" "$(ncomments)" 2
eq "the second review ran in a worktree of the existing branch" "$(tail -n1 "$FAKE/review.log" | awk '{print $2}')" "$STATE/wt-pin"
eq "the label is back" "$(pr_field '.labels | join(",")')" "mm:ready"
eq "nothing new was pushed: still one file changed" "$(git --git-dir="$PINREM" diff --name-only main "$BR")" ".claude/settings.json"
noworktrees "pin repo" "$HOME/git/app"

echo "== E. review findings / failures stop the queue"
reset
# a half-finished earlier push left a diverged branch behind: --force on our own branch covers it
git -C "$P" checkout -q -b junk; echo junk >"$P/junk.txt"; commit_all "$P" "junk"
git -C "$P" push -q origin "junk:refs/heads/$BR"; git -C "$P" checkout -q main
printf 'Summary\nCritical: token leaks in the log\n' >"$FAKE/review.out"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "findings matching the block regex exit 1" 1
PRN="$(pr_field .number)"
eq "the force push replaced the diverged branch" "$(git --git-dir="$PINREM" diff --name-only main "$BR")" ".claude/settings.json"
eq "the review comment was still posted" "$(ncomments)" 1
has "…with the findings" "$(last_comment)" "Critical: token leaks"
eq "no label" "$(pr_field '.labels | length')" 0
eq "no label call" "$(gcount 'pr edit')" 0
has "prints the by-hand label command" "$OUT" "gh pr edit $PRN -R acme/app --add-label 'mm:ready'"
eq "not waiting or syncing after a block" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 0
noworktrees "pin repo" "$HOME/git/app"

reset
printf 'all good\n' >"$FAKE/review.out"; echo 3 >"$FAKE/review.rc"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "a review command that exits non-zero exits 1" 1
eq "…no label" "$(pr_field '.labels | length')" 0
has "…and the comment records the exit code" "$(last_comment)" "exit 3"

reset
conf 'REVIEW_BLOCK_REGEX=blocker'
printf 'warning: minor thing\n' >"$FAKE/review.out"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "a custom block regex replaces the default (no match: queued)" 0
eq "…labeled" "$(pr_field '.labels | join(",")')" "mm:ready"
reset
conf 'REVIEW_BLOCK_REGEX=blocker'
printf 'Found a BLOCKER here\n' >"$FAKE/review.out"
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "the custom regex matches case-insensitively" 1

reset
conf 'REVIEW_MARKER='
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "an empty marker is fine" 0
matches "…the comment then opens with the summary line" "$(last_comment | head -n1)" '^\*\*Review\*\*'

reset
conf 'REVIEW_CMD=' 'PREPUSH_SETUP_CMD='
run fleet pin --engsys v1.1.0 --release v0.1.0 --no-wait
rc_is "an empty REVIEW_CMD exits 0" 0
eq "no review ran" "$(rev_lines)" 0
eq "no comment" "$(ncomments)" 0
eq "labeled directly" "$(pr_field '.labels | join(",")')" "mm:ready"
has "…and says why" "$OUT" "no REVIEW_CMD configured"
[ ! -e "$FAKE/setup.cwd" ] && ok "an empty PREPUSH_SETUP_CMD runs nothing" || bad "an empty PREPUSH_SETUP_CMD runs nothing"

echo "== F. a new instance release: a release PR first, then the tag on main"
reset
echo "later work" >"$I/notes.txt"; commit_all "$I" "post-release work on main"; git -C "$I" push -q origin main
NEWMAIN="$(git -C "$I" rev-parse HEAD)"
IPR="$G/pr.acme_acme-fleet.json"
touch "$FAKE/validate.fail"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "a failing plugin validation stops the release" 1
eq "…nothing was tagged on the remote" "$(git --git-dir="$INSTREM" tag -l | paste -sd' ' -)" v0.1.0
eq "…no release, no PR" "$(gcount 'release create')$(gcount 'pr create')" 00
eq "…no release branch pushed" "$(git --git-dir="$INSTREM" for-each-ref --format='%(refname:short)' refs/heads/release)" ""
[ -z "$(ls -d "$STATE"/validate-cfg.* 2>/dev/null)" ] && ok "…and the scratch config dir is gone" || bad "…and the scratch config dir is gone"
rm -f "$FAKE/validate.fail"; : >"$FAKE/claude.log"; : >"$FAKE/claude.env"

# main doesn't carry 0.1.1: the stamp goes out as a PR on the instance repo, and the run stops
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "version not on main: exits 3 (release PR open)" 3
has "…names the PR" "$OUT" "opened the release PR for acme v0.1.1: https://github.com/acme/acme-fleet/pull/"
has "…and says what to do" "$OUT" "Merge https://github.com/acme/acme-fleet/pull/"
has "…then re-run" "$OUT" "then re-run the same command"
has "the release PR is opened on the instance repo" "$(cat "$FAKE/gh.log")" "gh pr create -R acme/acme-fleet --head release/v0.1.1 --base main --title release: v0.1.1"
eq "…titled release: vX.Y.Z" "$(jq -r .title "$IPR")" "release: v0.1.1"
eq "no tag on the remote" "$(git --git-dir="$INSTREM" tag -l | paste -sd' ' -)" v0.1.0
eq "no local tag left behind" "$(git -C "$INST" tag -l 'v0.1.1')" ""
eq "no GitHub release" "$(gcount 'release create')" 0
eq "no pin PR (the --engsys bump waits too)" "$(gcount 'pr create -R acme/app')" 0
eq "no pin branch" "$(git --git-dir="$PINREM" for-each-ref --format='%(refname:short)' refs/heads/chore)" ""
eq "main itself is untouched" "$(git --git-dir="$INSTREM" rev-parse main)" "$NEWMAIN"
eq "the branch holds one stamp commit" "$(git --git-dir="$INSTREM" log -1 --format=%s release/v0.1.1)" "release: v0.1.1"
eq "…on top of main" "$(git --git-dir="$INSTREM" rev-parse 'release/v0.1.1^')" "$NEWMAIN"
at() { git --git-dir="$INSTREM" show "$1:$2"; }
eq "marketplace metadata.version stamped" "$(at release/v0.1.1 .claude-plugin/marketplace.json | jq -r .metadata.version)" 0.1.1
eq "plugin ctx stamped" "$(at release/v0.1.1 plugin/.claude-plugin/plugin.json | jq -r .version)" 0.1.1
eq "plugin tools stamped" "$(at release/v0.1.1 plugins/tools/.claude-plugin/plugin.json | jq -r .version)" 0.1.1
eq "the marketplace changed only its version" \
  "$(at release/v0.1.1 .claude-plugin/marketplace.json | jq -S 'del(.metadata.version)')" "$(at "$NEWMAIN" .claude-plugin/marketplace.json | jq -S 'del(.metadata.version)')"
eq "the plugin manifests changed only their version" \
  "$(at release/v0.1.1 plugins/tools/.claude-plugin/plugin.json | jq -S 'del(.version)')" "$(at "$NEWMAIN" plugins/tools/.claude-plugin/plugin.json | jq -S 'del(.version)')"
has "the non-directory plugin source is called out" "$OUT" "non-directory source"
matches "the marketplace was validated" "$(cat "$FAKE/claude.log")" "plugin validate ${STATE}/wt-release\$"
has "plugin ctx was validated" "$(cat "$FAKE/claude.log")" "plugin validate $STATE/wt-release/plugin"
has "plugin tools was validated" "$(cat "$FAKE/claude.log")" "plugin validate $STATE/wt-release/plugins/tools"
matches "…with a scratch config dir" "$(sort -u "$FAKE/claude.env")" "^CLAUDE_CONFIG_DIR=$STATE/validate-cfg\.[A-Za-z0-9]+\$"
[ -z "$(ls -d "$STATE"/validate-cfg.* 2>/dev/null)" ] && ok "…removed afterwards" || bad "…removed afterwards"
noworktrees "instance repo" "$INST"

run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "re-run with the release PR open: exits 3 again" 3
has "…reports the open PR" "$OUT" "the release PR for acme v0.1.1 is already open: https://github.com/acme/acme-fleet/pull/"
eq "…no duplicate PR" "$(gcount 'pr create')" 1
eq "…still no tag" "$(git --git-dir="$INSTREM" tag -l | paste -sd' ' -)" v0.1.0
run fleet pin --release v0.1.1 --no-wait
rc_is "an explicit version not on main stops the same way" 3; eq "…same PR" "$(gcount 'pr create')" 1
noworktrees "instance repo" "$INST"
# closed without merging: a re-run says so and re-creates it
jq '.state = "CLOSED"' "$IPR" >"$IPR.new" && mv "$IPR.new" "$IPR"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "re-run after the release PR was closed: exits 3" 3
has "…says it is re-creating it" "$OUT" "was closed without merging — re-creating it"
eq "…a new PR" "$(gcount 'pr create')" 2
eq "…open" "$(jq -r .state "$IPR")" OPEN
eq "…the branch is still one stamp commit on main" "$(git --git-dir="$INSTREM" rev-parse 'release/v0.1.1^')" "$NEWMAIN"
noworktrees "instance repo" "$INST"

# the release PR is squash-merged; next must tag that version on main, not bump again
git -C "$I" fetch -q origin release/v0.1.1 && git -C "$I" merge -q --squash FETCH_HEAD >/dev/null
git -C "$I" commit -q -m "release: v0.1.1 (#$(jq -r .number "$IPR"))"; git -C "$I" push -q origin main
jq '.state = "MERGED"' "$IPR" >"$IPR.new" && mv "$IPR.new" "$IPR"
RELMAIN="$(git -C "$I" rev-parse HEAD)"
: >"$FAKE/gh.log"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "after the merge: exits 0" 0
has "next tags the version main carries" "$OUT" "released acme v0.1.1 (tagged on acme/acme-fleet main at"
eq "…no new release PR" "$(gcount 'pr create -R acme/acme-fleet')" 0
git --git-dir="$INSTREM" rev-parse -q --verify refs/tags/v0.1.1 >/dev/null && ok "tag v0.1.1 pushed" || bad "tag v0.1.1 pushed"
eq "the tag is annotated" "$(git --git-dir="$INSTREM" cat-file -t v0.1.1)" tag
eq "the tag is main's commit itself" "$(git --git-dir="$INSTREM" rev-parse 'v0.1.1^{commit}')" "$RELMAIN"
git --git-dir="$INSTREM" merge-base --is-ancestor v0.1.1 main && ok "the tag is on main" || bad "the tag is on main"
eq "main is untouched by the tagging" "$(git --git-dir="$INSTREM" rev-parse main)" "$RELMAIN"
eq "the tagged tree carries 0.1.1" "$(at v0.1.1 plugins/tools/.claude-plugin/plugin.json | jq -r .version)" 0.1.1
has "the GitHub release was created for the tag" "$(cat "$FAKE/gh.log")" "gh release create v0.1.1 -R acme/acme-fleet --verify-tag --generate-notes"
eq "…once" "$(gcount 'release create')" 1
noworktrees "instance repo" "$INST"
BR=chore/pins-v1.1.0-v0.1.1
eq "the pin PR pins the new release (refs only)" "$(rem_diff "$BR")" \
  '-      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.0.0" }
+      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.1.0" }
-        "ref": "v0.1.0"
+        "ref": "v0.1.1"'
has "the pin PR title names both" "$(pr_field .title)" "chore(fleet): pin engsys v1.1.0, acme v0.1.1"
eq "and it is labeled" "$(pr_field '.labels | join(",")')" "mm:ready"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "next with nothing new since a tag on main" 0
has "…reuses it (a merged release: commit on main counts as shipped)" "$OUT" "nothing new on acme/acme-fleet main since v0.1.1 — pinning v0.1.1"
eq "…no second release" "$(gcount 'release create')" 1
run fleet pin --release v0.0.9 --no-wait
rc_is "a version below the latest tag is refused" 1; has "…saying why" "$OUT" "v0.0.9 is below the latest release v0.1.1"
eq "…no PR" "$(gcount 'pr create -R acme/acme-fleet')" 0
run fleet pin --engsys v1.1.0 --release v0.1.1 --no-wait
rc_is "an explicit existing tag is reused" 0; has "…said so" "$OUT" "acme v0.1.1 already released — pinning it"
eq "…no second release" "$(gcount 'release create')" 1
has "…and the same pin PR is reused" "$OUT" "already open and queued — reusing it"

echo "== G. waiting for the merge"
: >"$FAKE/sync.log"
echo MERGED >"$G/view-states"
run fleet pin --engsys v1.1.0 --release v0.1.1
rc_is "merged: exits 0" 0
has "says it is waiting" "$OUT" "to merge"; has "…then that it merged" "$OUT" "merged."
has "…and runs sync" "$(cat "$FAKE/sync.log")" "SYNC-RAN --instance $INST"
: >"$FAKE/sync.log"
printf 'OPEN\nMERGED\n' >"$G/view-states"
PIN_POLL_SECS=1 run fleet pin --engsys v1.1.0 --release v0.1.1
rc_is "polls until it merges" 0; eq "…then syncs" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 1
: >"$FAKE/sync.log"
echo CLOSED >"$G/view-states"
run fleet pin --engsys v1.1.0 --release v0.1.1
rc_is "closed without merging: exits 1" 1; has "…says so" "$OUT" "closed without merging"
eq "…and does not sync" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 0
echo OPEN >"$G/view-states"
PIN_WAIT_MAX_MIN=0 run fleet pin --engsys v1.1.0 --release v0.1.1
rc_is "timeout: exits 0" 0; has "…with a note to sync later" "$OUT" "Run fleet sync after"
eq "…and does not sync" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 0
rm -f "$G/view-states"

echo "== H. no instance marketplace: engsys ref only"
reset
conf 'INSTANCE_MARKETPLACE='
run fleet pin --release next --no-wait
rc_is "--release without an instance marketplace is an error" 1; has "…that says why" "$OUT" "INSTANCE_MARKETPLACE"
run fleet pin --engsys v1.1.0 --no-wait
rc_is "engsys-only pin exits 0" 0
eq "branch has only the engsys ref in its name" "$(git --git-dir="$PINREM" for-each-ref --format='%(refname:short)' refs/heads/chore)" "chore/pins-v1.1.0"
eq "title" "$(pr_field .title)" "chore(fleet): pin engsys v1.1.0"
eq "only the engsys ref line changed" "$(rem_diff chore/pins-v1.1.0)" \
  '-      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.0.0" }
+      "source": { "source": "github", "repo": "vendor/engsys", "ref": "v1.1.0" }'
hasnt "the body has no instance row" "$(cat "$FAKE/gh.log")" '| acme |'
eq "labeled" "$(pr_field '.labels | join(",")')" "mm:ready"
eq "no instance release happened" "$(gcount 'release create')" 0
reset
conf 'INSTANCE_MARKETPLACE='
run fleet pin --engsys v1.0.0
rc_is "already pinned (engsys only) exits 0" 0; has "…no PR" "$OUT" "already pins engsys v1.0.0 — no PR needed"
has "…and syncs" "$(cat "$FAKE/sync.log")" "SYNC-RAN --instance $INST"
reset

echo "== I. the dispatcher hands over to pin.sh and passes flags through"
run bash "$KIT/bin/fleet" --instance "$INST" pin --help
rc_is "fleet pin --help exits 0" 0; has "…documents --release" "$OUT" "--release"
run bash "$KIT/pin.sh" --instance "$INST" --engsys v1.0.0 --release v0.1.0
rc_is "pin.sh run directly takes a leading --instance <dir>" 0; has "…and works" "$OUT" "no PR needed"

echo "== J. next after a merged, untagged release PR tags that version (not latest + 1)"
reset
IPR="$G/pr.acme_acme-fleet.json"
echo "minor work" >"$I/minor.txt"; commit_all "$I" "a feature on main"; git -C "$I" push -q origin main
run fleet pin --release v0.2.0 --no-wait
rc_is "an explicit minor release opens its PR" 3
has "…for v0.2.0" "$OUT" "opened the release PR for acme v0.2.0"
git -C "$I" fetch -q origin release/v0.2.0 && git -C "$I" merge -q --ff-only FETCH_HEAD
echo "more work" >>"$I/minor.txt"
# a formatter on main lays the stamped manifests out differently: the values, not the bytes, decide
jq -c . "$I/.claude-plugin/marketplace.json" >"$I/mf.tmp" && mv "$I/mf.tmp" "$I/.claude-plugin/marketplace.json"
commit_all "$I" "more work after the release PR merged"; git -C "$I" push -q origin main
jq '.state = "MERGED"' "$IPR" >"$IPR.new" && mv "$IPR.new" "$IPR"
run fleet pin --release v0.1.5 --no-wait
rc_is "a new version past the latest tag but below main's is refused" 1
has "…saying why" "$OUT" "main already carries version 0.2.0, past v0.1.5"
eq "…no release PR" "$(gcount 'pr create -R acme/acme-fleet')" 1
run fleet pin --release next --no-wait
rc_is "next exits 0" 0
has "…releases v0.2.0, the version main carries" "$OUT" "released acme v0.2.0"
eq "…no v0.1.2 bump" "$(git --git-dir="$INSTREM" tag -l v0.1.2)" ""
eq "…on main's head" "$(git --git-dir="$INSTREM" rev-parse 'v0.2.0^{commit}')" "$(git --git-dir="$INSTREM" rev-parse main)"
eq "…no second release PR" "$(gcount 'pr create -R acme/acme-fleet')" 1
has "…and the pin PR moves acme to it" "$(pr_field .title)" "acme v0.2.0"

finish pin.test
