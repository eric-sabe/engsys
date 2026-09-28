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
: >"$FAKE/gh.log"; : >"$FAKE/claude.log"; : >"$FAKE/review.log"; : >"$FAKE/sync.log"

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
if [ "${1:-} ${2:-}" = "plugin validate" ]; then
  [ ! -e "$FAKE/validate.fail" ] || { echo "stub claude: validation failed" >&2; exit 1; }
  echo "Validation passed"; exit 0
fi
exit 2
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
# stub gh: pr list|create|view|comment|edit, release create. State: $FAKE/gh/pr.json (the one PR),
# $FAKE/gh/counter, $FAKE/gh/comments/NNN, $FAKE/gh/view-states (optional: `pr view --json state` answers, one per call).
G="$FAKE/gh"; mkdir -p "$G/comments"
echo "gh $*" >>"$FAKE/gh.log"
arg() { local want="$1" prev="" a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then echo "$a"; return; fi; prev="$a"; done; }
url="https://github.com/acme/app/pull"
case "${1:-} ${2:-}" in
  "pr list")
    h="$(arg --head "$@")"
    if [ -f "$G/pr.json" ] && jq -e --arg h "$h" '.head == $h and .state == "OPEN"' "$G/pr.json" >/dev/null; then
      jq -c '[{number, labels: [.labels[] | {name: .}]}]' "$G/pr.json"
    else
      echo '[]'
    fi ;;
  "pr create")
    n=$(( $(cat "$G/counter" 2>/dev/null || echo 40) + 1 )); echo "$n" >"$G/counter"
    jq -n --argjson n "$n" --arg h "$(arg --head "$@")" --arg t "$(arg --title "$@")" \
      '{number: $n, head: $h, title: $t, state: "OPEN", labels: []}' >"$G/pr.json"
    echo "$url/$n" ;;
  "pr view")
    q="$(arg -q "$@")"
    case "$q" in
      .number) jq -r .number "$G/pr.json" ;;
      .state)
        if [ -s "$G/view-states" ]; then
          head -n1 "$G/view-states"
          if [ "$(wc -l <"$G/view-states")" -gt 1 ]; then tail -n +2 "$G/view-states" >"$G/view-states.new"; mv "$G/view-states.new" "$G/view-states"; fi
        else
          jq -r .state "$G/pr.json"
        fi ;;
    esac ;;
  "pr comment")
    f="$G/comments/$(printf '%03d' $(( $(ls "$G/comments" | wc -l) + 1 )))"
    cat >"$f"; echo "$url/$3#issuecomment-1" ;;
  "pr edit")
    l="$(arg --add-label "$@")"
    if [ -n "$l" ]; then jq --arg l "$l" '.labels += [$l] | .labels |= unique' "$G/pr.json" >"$G/pr.new" && mv "$G/pr.new" "$G/pr.json"; fi
    echo "$url/$3" ;;
  "release create")
    git ls-remote --exit-code --tags "https://github.com/$(arg -R "$@").git" "refs/tags/$3" >/dev/null || { echo "stub gh: no such tag on the remote: $3" >&2; exit 1; }
    echo "https://github.com/$(arg -R "$@")/releases/tag/$3" ;;
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
echo engsys >"$E/README"; commit_all "$E" "engsys 1.0.0"; git -C "$E" tag v1.0.0
git -C "$E" commit -q --allow-empty -m "engsys 1.1.0"; git -C "$E" tag v1.1.0
push_all "$E"     # v1.2.0 is deliberately not released

# the instance repo: main at "instance base"; v0.1.0 is a stamp commit ON TOP of it (as real releases are),
# tagged and pushed as a tag only — main never carries the stamp
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
  rm -rf "$G/pr.json" "$G/view-states" "$G/comments"; mkdir -p "$G/comments"
  local b
  for b in $(git --git-dir="$PINREM" for-each-ref --format='%(refname:short)' refs/heads/chore); do git --git-dir="$PINREM" branch -q -D "$b"; done
  : >"$FAKE/gh.log"; : >"$FAKE/review.log"; : >"$FAKE/sync.log"; : >"$FAKE/claude.log"
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
run fleet pin --engsys 'v1;rm' --no-wait
rc_is "an engsys tag with odd characters is refused" 1
run fleet pin --engsys v9.9.9 --no-wait
rc_is "a missing engsys tag dies" 1
has "…printing the exact release command" "$OUT" "gh release create v9.9.9 -R vendor/engsys --target main --generate-notes"
eq "…before anything is opened" "$(gcount 'pr create')" 0
eq "…or released" "$(gcount 'release create')" 0

echo "== B. already pinned: no PR, straight to sync (and next reuses the latest release)"
reset
run fleet pin --release next
rc_is "exits 0" 0
has "nothing new on main: the latest release is reused" "$OUT" "nothing new on acme/acme-fleet main since v0.1.0 — pinning v0.1.0"
has "no PR needed" "$OUT" "no PR needed"
eq "no PR" "$(gcount 'pr ')" 0
eq "no release" "$(gcount 'release create')" 0
eq "no new tag" "$(git -C "$INST" tag -l 'v*' | paste -sd' ' -)" v0.1.0
has "sync runs (with the instance)" "$(cat "$FAKE/sync.log")" "SYNC-RAN --instance $INST"
run fleet pin --engsys v1.0.0 --release v0.1.0 --no-wait
rc_is "--no-wait when already pinned exits 0" 0; has "…says it isn't waiting" "$OUT" "not waiting"
eq "…and doesn't sync" "$(wc -l <"$FAKE/sync.log" | tr -d ' ')" 1

echo "== C. pin PR: refs only, review comment with the marker, label; next reuses the release"
reset
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "exits 0" 0
has "next reuses v0.1.0 (nothing new)" "$OUT" "nothing new on acme/acme-fleet main since v0.1.0"
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
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "re-run exits 0" 0
has "reuses the queued PR" "$OUT" "already open and queued — reusing it"
eq "no second PR" "$(gcount 'pr create')" 1
eq "no second review" "$(rev_lines)" 1
eq "no second comment" "$(ncomments)" 1
jq '.labels = []' "$G/pr.json" >"$G/pr.new" && mv "$G/pr.new" "$G/pr.json"
run fleet pin --engsys v1.1.0 --release next --no-wait
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
run fleet pin --engsys v1.1.0 --release next --no-wait
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
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "a review command that exits non-zero exits 1" 1
eq "…no label" "$(pr_field '.labels | length')" 0
has "…and the comment records the exit code" "$(last_comment)" "exit 3"

reset
conf 'REVIEW_BLOCK_REGEX=blocker'
printf 'warning: minor thing\n' >"$FAKE/review.out"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "a custom block regex replaces the default (no match: queued)" 0
eq "…labeled" "$(pr_field '.labels | join(",")')" "mm:ready"
reset
conf 'REVIEW_BLOCK_REGEX=blocker'
printf 'Found a BLOCKER here\n' >"$FAKE/review.out"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "the custom regex matches case-insensitively" 1

reset
conf 'REVIEW_MARKER='
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "an empty marker is fine" 0
matches "…the comment then opens with the summary line" "$(last_comment | head -n1)" '^\*\*Review\*\*'

reset
conf 'REVIEW_CMD=' 'PREPUSH_SETUP_CMD='
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "an empty REVIEW_CMD exits 0" 0
eq "no review ran" "$(rev_lines)" 0
eq "no comment" "$(ncomments)" 0
eq "labeled directly" "$(pr_field '.labels | join(",")')" "mm:ready"
has "…and says why" "$OUT" "no REVIEW_CMD configured"
[ ! -e "$FAKE/setup.cwd" ] && ok "an empty PREPUSH_SETUP_CMD runs nothing" || bad "an empty PREPUSH_SETUP_CMD runs nothing"

echo "== F. a new instance release"
reset
echo "later work" >"$I/notes.txt"; commit_all "$I" "post-release work on main"; git -C "$I" push -q origin main
NEWMAIN="$(git -C "$I" rev-parse HEAD)"
touch "$FAKE/validate.fail"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "a failing plugin validation stops the release" 1
eq "…nothing was tagged on the remote" "$(git --git-dir="$INSTREM" tag -l | paste -sd' ' -)" v0.1.0
eq "…no release, no PR" "$(gcount 'release create')$(gcount 'pr create')" 00
rm -f "$FAKE/validate.fail"; : >"$FAKE/claude.log"
run fleet pin --engsys v1.1.0 --release next --no-wait
rc_is "exits 0" 0
has "patch + 1 over the latest" "$OUT" "released acme v0.1.1"
has "the non-directory plugin source is called out" "$OUT" "non-directory source"
git --git-dir="$INSTREM" rev-parse -q --verify refs/tags/v0.1.1 >/dev/null && ok "tag v0.1.1 pushed" || bad "tag v0.1.1 pushed"
eq "the tag is annotated" "$(git -C "$INST" cat-file -t v0.1.1)" tag
eq "the tag sits on a stamp commit" "$(git -C "$INST" log -1 --format=%s 'v0.1.1^{commit}')" "release: v0.1.1"
eq "…on top of the main commit it shipped" "$(git -C "$INST" rev-parse 'v0.1.1^')" "$NEWMAIN"
eq "main itself is untouched" "$(git --git-dir="$INSTREM" rev-parse main)" "$NEWMAIN"
at() { git -C "$INST" show "v0.1.1:$1"; }
eq "marketplace metadata.version stamped" "$(at .claude-plugin/marketplace.json | jq -r .metadata.version)" 0.1.1
eq "plugin ctx stamped" "$(at plugin/.claude-plugin/plugin.json | jq -r .version)" 0.1.1
eq "plugin tools stamped" "$(at plugins/tools/.claude-plugin/plugin.json | jq -r .version)" 0.1.1
eq "the marketplace changed only its version" \
  "$(at .claude-plugin/marketplace.json | jq -S 'del(.metadata.version)')" "$(git -C "$INST" show "$NEWMAIN:.claude-plugin/marketplace.json" | jq -S 'del(.metadata.version)')"
eq "the plugin manifests changed only their version" \
  "$(at plugins/tools/.claude-plugin/plugin.json | jq -S 'del(.version)')" "$(git -C "$INST" show "$NEWMAIN:plugins/tools/.claude-plugin/plugin.json" | jq -S 'del(.version)')"
matches "the marketplace was validated" "$(cat "$FAKE/claude.log")" "plugin validate ${STATE}/wt-release\$"
has "plugin ctx was validated" "$(cat "$FAKE/claude.log")" "plugin validate $STATE/wt-release/plugin"
has "plugin tools was validated" "$(cat "$FAKE/claude.log")" "plugin validate $STATE/wt-release/plugins/tools"
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

finish pin.test
