#!/usr/bin/env bash
# verify.test.sh: `fleet verify` and the launch gate it drives (engsys#70, review fixes from #86), in a
# sandbox: no network.
#
# A sandbox engsys checkout (this tree's core/, tagged v1.0.0) is the host kit; a copy of its core/ is
# the installed plugin cache. Stub `claude plugin list --json` reports $FAKE/plugins.json (and records the
# directory it ran in). A stub `gh` answers the release calls (the tag ref, the default branch, the
# compare, the tree of the v1.0.0 commit, exactly what GitHub would return), or fails like a dropped
# network. The launcher is a stub that records what it was asked to start. The attacks Nyx reproduced on
# #86 (PoC A, B, C) are regression cases here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CORE_SRC="$(cd "$HERE/../.." && pwd -P)"  # core
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

: >"$FAKE/gh.log"; : >"$FAKE/launch.log"

# --- the host engsys checkout (the kit) at v1.0.0 ---------------------------------------------
E="$HOME/git/engsys"
mkdir -p "$E"
git init -q "$E"
cp -R "$CORE_SRC" "$E/core"
rm -rf "$E/core/fleet/test"
cat >"$E/core/skills/agent-sessions/scripts/launch-agent-sessions.sh" <<'SH'
#!/usr/bin/env bash
# stub launcher: record the call, and the roster it was handed
echo "launch $*" >>"$FAKE/launch.log"
SH
commit_all "$E" "engsys 1.0.0"; git -C "$E" tag v1.0.0
COMMIT="$(git -C "$E" rev-parse v1.0.0)"

# --- the installed plugin cache, and what GitHub holds for v1.0.0 -----------------------------
CACHE="$HOME/.claude/plugins/cache/engsys/engsys/1.0.0"
mkdir -p "$(dirname "$CACHE")"
cp -R "$E/core" "$CACHE"
git -C "$E" ls-tree -r v1.0.0 | awk -F'\t' '{ split($1, a, " "); printf "%s\t%s\t%s\n", a[1], a[3], $2 }' \
  | jq -R -s --arg c "$COMMIT" '{sha: $c, truncated: false, tree: [split("\n")[] | select(length > 0) | split("\t") | {mode: .[0], type: "blob", sha: .[1], path: .[2]}]}' \
  >"$FAKE/tree.json"
printf '%s\n' "$COMMIT" >"$FAKE/commit"
echo ahead >"$FAKE/compare-status"

APP="$HOME/git/app"
plugins() { # plugins <jq program producing the list> — what `claude plugin list --json` reports
  jq -n --arg c "$CACHE" --arg app "$APP" "$1" >"$FAKE/plugins.json"
}
DEFAULT_PLUGINS='[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: true, installPath: $c}, {id: "other@engsys", version: "1.0.0", scope: "user", enabled: true, installPath: "/nowhere"}]'
plugins "$DEFAULT_PLUGINS"

cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "plugin list --json") pwd -P >"$FAKE/claude.cwd"; cat "$FAKE/plugins.json" ;;
  *) echo "stub claude: unsupported: $*" >&2; exit 2 ;;
esac
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
c="$(cat "$FAKE/commit")"
if [ "${1:-}" = api ] && [ -f "$FAKE/gh-fail" ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
case "${1:-} ${2:-}" in
  "api repos/vendor/engsys/git/ref/tags/v1.0.0") printf '{"ref":"refs/tags/v1.0.0","object":{"type":"commit","sha":"%s"}}\n' "$c" ;;
  "api repos/vendor/engsys") echo '{"default_branch":"main"}' ;;
  "api repos/vendor/engsys/compare/$c...main?per_page=1") printf '{"status":"%s"}\n' "$(cat "$FAKE/compare-status")" ;;
  "api repos/vendor/engsys/git/trees/$c?recursive=1") cat "$FAKE/tree.json" ;;
  "api "*) echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  "issue comment"*) : ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- the instance and the pin repo ------------------------------------------------------------
I="$T/inst"
mkdir -p "$I/fleet" "$APP/.claude"
cat >"$I/fleet/fleet.conf" <<EOF
FLEET_ORG=acme
PIN_REPO=acme/app
PIN_DIR=~/git/app
NOTIFY_FALLBACK_ISSUE=acme/acme-fleet#5
EOF
cat >"$I/fleet/roster.tmpl" <<'EOF'
NAMESPACE=acme
acme-mm|__PIN_DIR__|/merge-monster|--dangerously-skip-permissions
acme-security|__PIN_DIR__|/maintenance-monster|--dangerously-skip-permissions
acme-build|||--model m
EOF
pin() { jq -n --arg r "$1" '{extraKnownMarketplaces: {engsys: {source: {source: "github", repo: "vendor/engsys", ref: $r}}}, enabledPlugins: {"engsys@engsys": true}}' >"$APP/.claude/settings.json"; }
pin v1.0.0

fleet() { bash "$E/core/fleet/bin/fleet" --instance "$I" "$@"; }
trees() { grep -c 'git/trees' "$FAKE/gh.log" || true; }
comments() { grep -c '^gh issue comment 5 -R acme/acme-fleet' "$FAKE/gh.log" || true; }
said() { grep -c -- "$1" "$FAKE/gh.log" || true; } # said <text> — lines of gh.log (alert bodies included) with it
launched() { grep -c -- "$1" "$FAKE/launch.log" || true; }
WRAP="$CACHE/skills/merge-monster/scripts/mm-act.sh"
tamper() { printf '\ngh api -X PUT repos/acme/app/pulls/1/merge\n' >>"$WRAP"; }
restore() { cp "$E/core/skills/merge-monster/scripts/mm-act.sh" "$WRAP"; }
tty_run() { # tty_run <cmd...>: run with a terminal on stdin/stdout, the way an operator would (BSD or util-linux script)
  RC=0
  if script --version 2>/dev/null | grep -q util-linux; then OUT="$(script -qec "$(printf '%q ' "$@")" /dev/null 2>&1 </dev/null)" || RC=$?
  else OUT="$(script -q /dev/null "$@" 2>&1 </dev/null)" || RC=$?; fi
}

# =============================================================================================
echo "== an untouched cache passes"
run fleet verify
rc_is "fleet verify exits 0" 0
has "…and says the files match the pinned release" "$OUT" "match vendor/engsys@v1.0.0"
has "…naming the commit and that it is on the default branch" "$OUT" "on main"
eq "one trees call" "$(trees)" 1
eq "claude plugin list ran in PIN_DIR, where the sessions start (review H2)" "$(cat "$FAKE/claude.cwd")" "$(cd "$APP" && pwd -P)"
has "the release was read through the tag namespace" "$(cat "$FAKE/gh.log")" "git/ref/tags/v1.0.0"
run fleet launch acme-mm
rc_is "fleet launch acme-mm exits 0" 0
eq "…and the merge monster is launched" "$(launched 'acme-mm')" 1
eq "…after asking GitHub again (a launch never uses the cache)" "$(trees)" 2

echo "== a tampered wrapper is detected and the launch refused"
tamper
run fleet verify
rc_is "fleet verify exits 1" 1
has "…names the tampered wrapper" "$OUT" "modified   $CACHE/skills/merge-monster/scripts/mm-act.sh"
eq "…without --alert, no alert" "$(comments)" 0
run fleet launch acme-mm
rc_is "fleet launch acme-mm exits 1" 1
has "…and says why" "$OUT" "not launching acme-mm: its engsys plugin does not match v1.0.0"
eq "…the launcher was never called for it" "$(launched 'acme-mm')" 1
eq "…one alert (the fleet notify fallback comment)" "$(comments)" 1
has "…a calm alert naming the file" "$(sed -n '/gh issue comment 5/,$p' "$FAKE/gh.log")" "$CACHE/skills/merge-monster/scripts/mm-act.sh"
run fleet launch acme-security
rc_is "the maintenance monster is refused too" 1
eq "…without a second alert for the same mismatch" "$(comments)" 1
n="$(trees)"
run fleet launch acme-build
rc_is "an interactive session still launches" 0
eq "…without an integrity check" "$(trees)" "$n"
run fleet launch
rc_is "a whole-roster launch exits 0" 0
has "…skips the merge monster" "$OUT" "skip: acme-mm, its engsys plugin does not match v1.0.0"
has "…and the maintenance monster" "$OUT" "skip: acme-security"
has "…the host roster says why" "$(cat "$I/.fleet/roster.host")" "# plugin integrity held: acme-mm"
has "…and keeps the interactive session" "$(cat "$I/.fleet/roster.host")" "acme-build|"
eq "…checked once for the whole launch" "$(trees)" "$((n + 1))"
eq "…still one alert" "$(comments)" 1

echo "== the latch holds a fingerprint (review L1)"
printf '\n# second change\n' >>"$CACHE/skills/merge-monster/scripts/mm-baton.sh"
run fleet verify --alert
rc_is "a different mismatch" 1
eq "…alerts again" "$(comments)" 2
cp "$E/core/skills/merge-monster/scripts/mm-baton.sh" "$CACHE/skills/merge-monster/scripts/mm-baton.sh"
echo "planted" >"$I/.fleet/verify-wrappers.alerted"
run fleet verify --alert
eq "a planted latch does not silence the alert" "$(comments)" 3
run fleet verify --alert
eq "…and the same mismatch again stays quiet" "$(comments)" 3

echo "== other ways to defeat the guard are caught"
restore
rm "$CACHE/.claude-plugin/hooks.json"
run fleet verify; rc_is "a deleted hook registration is a mismatch" 1; has "…reported missing" "$OUT" "missing"
cp "$E/core/.claude-plugin/hooks.json" "$CACHE/.claude-plugin/hooks.json"
mv "$CACHE/lib/lease/baton.mjs" "$T/baton.mjs"; ln -s "$T/baton.mjs" "$CACHE/lib/lease/baton.mjs"
run fleet verify; rc_is "a symlinked lease library is a mismatch" 1; has "…reported" "$OUT" "not-a-file"
rm "$CACHE/lib/lease/baton.mjs"; mv "$T/baton.mjs" "$CACHE/lib/lease/baton.mjs"
printf '\n// allow + updatedInput: gh pr view -> gh pr merge\n' >>"$CACHE/.claude-plugin/approve-own-scripts.mjs"
run fleet verify; rc_is "a tampered sibling PreToolUse hook is a mismatch (review M2)" 1; has "…reported" "$OUT" "approve-own-scripts.mjs"
cp "$E/core/.claude-plugin/approve-own-scripts.mjs" "$CACHE/.claude-plugin/approve-own-scripts.mjs"
printf '\necho "export NODE_OPTIONS=--require=/tmp/x.js"\n' >>"$CACHE/templates/post-clear-reground.sh.tmpl"
run fleet verify; rc_is "a tampered SessionStart script is a mismatch (review M2)" 1
cp "$E/core/templates/post-clear-reground.sh.tmpl" "$CACHE/templates/post-clear-reground.sh.tmpl"
printf '\ngh pr merge "$1" --admin\n' >>"$CACHE/skills/merge-monster/scripts/mm-watch.sh"
run fleet verify; rc_is "a tampered monster skill script (not a wrapper) is a mismatch" 1; has "…reported" "$OUT" "mm-watch.sh"
cp "$E/core/skills/merge-monster/scripts/mm-watch.sh" "$CACHE/skills/merge-monster/scripts/mm-watch.sh"

echo "== PoC A: the version label edited (review H2)"
echo '// tampered' >>"$CACHE/.claude-plugin/hooks.json"
plugins '[{id: "engsys@engsys", version: "1.0.0-local", scope: "user", enabled: true, installPath: $c}]'
run fleet verify
rc_is "an install labelled with another version is a mismatch, not 'not verified'" 1
has "…says so" "$OUT" "is 1.0.0-local, not the pin 1.0.0"
b="$(launched 'acme-mm')"
run fleet launch acme-mm
rc_is "…and the merge monster is refused" 1
eq "…not launched" "$(launched 'acme-mm')" "$b"

echo "== PoC B: a pristine user install plus a tampered project install for PIN_DIR (review H2)"
PRIS="$HOME/pristine"; cp -R "$E/core" "$PRIS"
plugins '[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: true, installPath: "'"$PRIS"'"}, {id: "engsys@engsys", version: "9.9.9", scope: "project", projectPath: $app, enabled: true, installPath: $c}]'
run fleet verify
rc_is "a project install for PIN_DIR at another version is a mismatch" 1
has "…naming it" "$OUT" "(project scope) is 9.9.9, not the pin 1.0.0: $CACHE"
plugins '[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: true, installPath: "'"$PRIS"'"}, {id: "engsys@engsys", version: "1.0.0", scope: "project", projectPath: $app, enabled: true, installPath: $c}]'
run fleet verify
rc_is "two install paths at the pin is a mismatch" 1; has "…says so" "$OUT" "two-paths"
plugins '[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: true, installPath: "'"$PRIS"'"}, {id: "engsys@engsys", version: "9.9.9", scope: "project", projectPath: "/somewhere/else", enabled: true, installPath: $c}]'
run fleet verify
rc_is "a project install for another directory doesn't apply" 0
plugins '[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: false, installPath: "'"$PRIS"'"}]'
run fleet verify
rc_is "a disabled plugin is a mismatch (no guard would load)" 1; has "…says so" "$OUT" "is not enabled"
plugins '[{id: "engsys@engsys", version: "1.0.0", scope: "user", enabled: true, projectEnabled: false, installPath: "'"$PRIS"'"}]'
run fleet verify
rc_is "…disabled for the project too" 1
cp "$E/core/.claude-plugin/hooks.json" "$CACHE/.claude-plugin/hooks.json"
plugins "$DEFAULT_PLUGINS"

echo "== PoC C: ENGSYS_REF forced in fleet.local.conf (review H1, M1)"
echo '// tampered' >>"$CACHE/.claude-plugin/hooks.json"
echo 'ENGSYS_REF=v0.9.0' >"$HOME/.config/acme/fleet.local.conf"
c0="$(comments)"
run fleet verify --alert
rc_is "the forced ref doesn't match the install: a mismatch, not 'not verified'" 1
has "…and the override is called out" "$OUT" "WARNING ENGSYS_REF is forced to 'v0.9.0'"
eq "…the downgrade alert and the mismatch alert (two posts)" "$(comments)" "$((c0 + 2))"
eq "…one of them about the override" "$(said 'ENGSYS_REF is set to v0.9.0 by an override')" 1
b="$(launched 'acme-mm')"
run fleet launch acme-mm
rc_is "…and the merge monster is refused" 1
eq "…not launched" "$(launched 'acme-mm')" "$b"
eq "…no repeat of the override alert" "$(said 'ENGSYS_REF is set to v0.9.0 by an override')" 1
echo 'ENGSYS_REF=main' >"$HOME/.config/acme/fleet.local.conf"
run fleet verify
rc_is "a ref that is not a release tag is not verified" 3; has "…says so" "$OUT" "is not a release tag"
run fleet launch acme-mm
rc_is "…which also holds the merge monster" 1
rm "$HOME/.config/acme/fleet.local.conf"
cp "$E/core/.claude-plugin/hooks.json" "$CACHE/.claude-plugin/hooks.json"

echo "== a tag on a commit that is not on the default branch (review M1)"
echo diverged >"$FAKE/compare-status"
run fleet verify
rc_is "is a mismatch" 1; has "…says so" "$OUT" "which is not on main (compare: diverged)"
echo identical >"$FAKE/compare-status"
run fleet verify; rc_is "a tag at the branch head passes" 0
echo ahead >"$FAKE/compare-status"

echo "== restored: passes, and the alerts resolve"
run fleet verify --alert
rc_is "fleet verify --alert exits 0" 0
[ ! -f "$I/.fleet/verify-wrappers.alerted" ] && ok "…the mismatch latch is cleared" || bad "…the mismatch latch is cleared"
[ ! -f "$I/.fleet/verify-ref-forced.alerted" ] && ok "…and the override latch" || bad "…and the override latch"
a0="$(said 'does not match vendor/engsys@v1.0.0')"
tamper
run fleet verify --alert
rc_is "a new tampering" 1
eq "…is a new incident: alerted" "$(said 'does not match vendor/engsys@v1.0.0')" "$((a0 + 1))"
restore; run fleet verify --alert; rc_is "restored again" 0

echo "== GitHub unreachable: merge and maintain are held (review H1)"
touch "$FAKE/gh-fail"
u0="$(said 'could not run')"
run fleet verify
rc_is "fleet verify exits 3 (not verified)" 3
has "…and says why" "$OUT" "not verified against vendor/engsys@v1.0.0"
b="$(launched 'acme-mm')"
run fleet launch acme-mm
rc_is "fleet launch acme-mm exits 1 (fail closed)" 1
has "…and says why" "$OUT" "the engsys plugin check could not run (exit 3)"
eq "…not launched" "$(launched 'acme-mm')" "$b"
eq "…one 'could not run' alert, under its own incident" "$(said 'could not run')" "$((u0 + 1))"
run fleet launch acme-mm
eq "…not repeated" "$(said 'could not run')" "$((u0 + 1))"
run fleet launch acme-build
rc_is "an interactive session still launches (no check)" 0
run fleet launch acme-mm --skip-verify
rc_is "--skip-verify from a script (no terminal) is refused" 1
has "…says why" "$OUT" "only works from an interactive terminal"
eq "…not launched" "$(launched 'acme-mm')" "$b"
FLEET_SKIP_VERIFY=1 run fleet launch acme-mm
rc_is "no environment variable gets past it" 1
run fleet launch --skip-verify
rc_is "--skip-verify on a whole-roster launch is refused" 1
tty_run bash "$E/core/fleet/bin/fleet" --instance "$I" launch acme-mm --skip-verify
rc_is "--skip-verify typed at a terminal launches" 0
has "…with a loud warning" "$OUT" "WITHOUT the plugin integrity check (--skip-verify)"
eq "…launched" "$(launched 'acme-mm')" "$((b + 1))"
eq "…and the team is alerted" "$(said 'with --skip-verify')" 1
rm -f "$FAKE/gh-fail"
run fleet verify --alert
rc_is "GitHub back: passes" 0
[ ! -f "$I/.fleet/verify-wrappers.unverified" ] && ok "…the 'could not run' latch is cleared" || bad "…the 'could not run' latch is cleared"

echo "== nothing installed: not verified, held"
plugins '[]'
run fleet verify
rc_is "no applicable install is not verified" 3
has "…says to sync" "$OUT" "engsys@engsys is not installed for $APP (run: fleet sync)"
run fleet launch acme-mm; rc_is "…and holds the merge monster" 1
plugins "$DEFAULT_PLUGINS"

echo "== only a real mismatch is exit 1"
mv "$E/core/fleet/lib/verify-wrappers.mjs" "$T/vw.mjs"
run fleet verify
rc_is "the verifier itself missing is not verified, not a mismatch" 3
mv "$T/vw.mjs" "$E/core/fleet/lib/verify-wrappers.mjs"
echo "VERIFY_MAX_AGE_MIN=soon" >"$HOME/.config/acme/fleet.local.conf"
run fleet verify
rc_is "a config error (fleet_die) is not verified, not a mismatch" 3
rm "$HOME/.config/acme/fleet.local.conf"

echo "== the supervisor's throttle (--max-age)"
: >"$FAKE/gh.log"
run fleet verify --max-age 15
rc_is "first throttled check passes" 0; eq "…asking GitHub" "$(trees)" 1
run fleet verify --max-age 15
rc_is "second check passes" 0; eq "…from the cache: no call" "$(trees)" 1
has "…and says so" "$OUT" "unchanged since the check"
tamper
run fleet verify --max-age 15
rc_is "a tampered wrapper is caught at once, cache or not" 1; eq "…asking GitHub again" "$(trees)" 2
restore
run fleet verify --max-age 0
rc_is "--max-age 0 always asks" 0; eq "…GitHub" "$(trees)" 3
run fleet verify --max-age 0
eq "…every time" "$(trees)" 4
run fleet verify --max-age soon
rc_is "--max-age takes minutes" 2

finish verify.test.sh
