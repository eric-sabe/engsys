#!/usr/bin/env bash
# verify.test.sh: `fleet verify` and the launch gate it drives (engsys#70), in a sandbox: no network.
#
# A sandbox engsys checkout (this tree's core/, tagged v1.0.0) is the host kit; a copy of its core/ is
# the installed plugin cache. Stub `claude plugin list --json` reports that cache, and a stub `gh`
# answers the git trees call with the tree of the v1.0.0 tag (exactly what GitHub would return), or
# fails like a dropped network. The launcher is a stub that records what it was asked to start.
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

# --- the installed plugin cache, and the tree GitHub holds for v1.0.0 -------------------------
CACHE="$HOME/.claude/plugins/cache/engsys/engsys/1.0.0"
mkdir -p "$(dirname "$CACHE")"
cp -R "$E/core" "$CACHE"
git -C "$E" ls-tree -r v1.0.0 | awk -F'\t' '{ split($1, a, " "); printf "%s\t%s\t%s\n", a[1], a[3], $2 }' \
  | jq -R -s '{sha: "c0ffee", truncated: false, tree: [split("\n")[] | select(length > 0) | split("\t") | {mode: .[0], type: "blob", sha: .[1], path: .[2]}]}' \
  >"$FAKE/tree.json"

cat >"$T/bin/claude" <<SH
#!/usr/bin/env bash
case "\$*" in
  "plugin list --json") printf '[{"id":"engsys@engsys","version":"1.0.0","scope":"user","enabled":true,"installPath":"%s"},{"id":"other@engsys","version":"1.0.0","installPath":"/nowhere"}]\n' "$CACHE" ;;
  *) echo "stub claude: unsupported: \$*" >&2; exit 2 ;;
esac
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
case "${1:-} ${2:-}" in
  "api repos/vendor/engsys/git/trees/v1.0.0?recursive=1")
    if [ -f "$FAKE/gh-fail" ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
    cat "$FAKE/tree.json" ;;
  "issue comment"*) : ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- the instance and the pin repo ------------------------------------------------------------
I="$T/inst"
mkdir -p "$I/fleet" "$HOME/git/app/.claude"
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
jq -n '{extraKnownMarketplaces: {engsys: {source: {source: "github", repo: "vendor/engsys", ref: "v1.0.0"}}}, enabledPlugins: {"engsys@engsys": true}}' \
  >"$HOME/git/app/.claude/settings.json"

fleet() { bash "$E/core/fleet/bin/fleet" --instance "$I" "$@"; }
trees() { grep -c 'git/trees' "$FAKE/gh.log" || true; }
comments() { grep -c '^gh issue comment 5 -R acme/acme-fleet' "$FAKE/gh.log" || true; }
launched() { grep -c -- "$1" "$FAKE/launch.log" || true; }
WRAP="$CACHE/skills/merge-monster/scripts/mm-act.sh"
tamper() { printf '\ngh api -X PUT repos/acme/app/pulls/1/merge\n' >>"$WRAP"; }
restore() { cp "$E/core/skills/merge-monster/scripts/mm-act.sh" "$WRAP"; }

# =============================================================================================
echo "== an untouched cache passes"
run fleet verify
rc_is "fleet verify exits 0" 0
has "…and says the files match the pinned release" "$OUT" "match vendor/engsys@v1.0.0"
eq "one call to the trees API" "$(trees)" 1
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
has "…and says why" "$OUT" "not launching acme-mm: the engsys plugin files guarding it differ from v1.0.0"
eq "…the launcher was never called for it" "$(launched 'acme-mm')" 1
eq "…one alert (the fleet notify fallback comment)" "$(comments)" 1
has "…a calm alert naming the file" "$(sed -n '/gh issue comment 5/,$p' "$FAKE/gh.log")" "$CACHE/skills/merge-monster/scripts/mm-act.sh"
[ -f "$I/.fleet/verify-wrappers.alerted" ] && ok "…latched" || bad "…latched"
run fleet launch acme-security
rc_is "the maintenance monster is refused too" 1
eq "…without a second alert for the same incident" "$(comments)" 1
n="$(trees)"
run fleet launch acme-build
rc_is "an interactive session still launches" 0
eq "…without an integrity check" "$(trees)" "$n"
run fleet launch
rc_is "a whole-roster launch exits 0" 0
has "…skips the merge monster" "$OUT" "skip: acme-mm, its engsys plugin files differ from v1.0.0"
has "…and the maintenance monster" "$OUT" "skip: acme-security"
has "…the host roster says why" "$(cat "$I/.fleet/roster.host")" "# plugin integrity mismatch: acme-mm"
has "…and keeps the interactive session" "$(cat "$I/.fleet/roster.host")" "acme-build|"
eq "…checked once for the whole launch" "$(trees)" "$((n + 1))"
eq "…still one alert" "$(comments)" 1

echo "== other ways to defeat the guard are caught"
restore
rm "$CACHE/.claude-plugin/hooks.json"
run fleet verify; rc_is "a deleted hook registration is a mismatch" 1; has "…reported missing" "$OUT" "missing"
cp "$E/core/.claude-plugin/hooks.json" "$CACHE/.claude-plugin/hooks.json"
mv "$CACHE/lib/lease/baton.mjs" "$T/baton.mjs"; ln -s "$T/baton.mjs" "$CACHE/lib/lease/baton.mjs"
run fleet verify; rc_is "a symlinked lease library is a mismatch" 1; has "…reported" "$OUT" "not-a-file"
rm "$CACHE/lib/lease/baton.mjs"; mv "$T/baton.mjs" "$CACHE/lib/lease/baton.mjs"

echo "== restored: passes, and the alert is resolved"
run fleet verify --alert
rc_is "fleet verify --alert exits 0" 0
[ ! -f "$I/.fleet/verify-wrappers.alerted" ] && ok "…the latch is cleared" || bad "…the latch is cleared"
tamper
run fleet verify --alert
rc_is "a new tampering" 1
eq "…is a new incident: alerted again" "$(comments)" 2
restore; run fleet verify --alert; rc_is "restored again" 0

echo "== GitHub unreachable: warn and launch"
touch "$FAKE/gh-fail"
run fleet verify
rc_is "fleet verify exits 3 (not verified)" 3
has "…and says why" "$OUT" "not verified against vendor/engsys@v1.0.0"
b="$(launched 'acme-mm')"
run fleet launch acme-mm
rc_is "fleet launch acme-mm exits 0 (fail open)" 0
has "…with a warning" "$OUT" "WARNING the plugin integrity check could not run"
eq "…and the merge monster is launched" "$(launched 'acme-mm')" "$((b + 1))"
tamper
run fleet launch acme-mm
rc_is "…even a tampered cache is not caught while GitHub is down (fail open, warned)" 0
restore; rm -f "$FAKE/gh-fail"

echo "== not installed at the pin: warn"
jq '.extraKnownMarketplaces.engsys.source.ref = "v1.0.1"' "$HOME/git/app/.claude/settings.json" >"$T/s.json" && mv "$T/s.json" "$HOME/git/app/.claude/settings.json"
run fleet verify
rc_is "pin moved but the plugin not reinstalled: not verified" 3
has "…says to sync" "$OUT" "engsys@engsys v1.0.1 is not installed on this host (run: fleet sync)"
jq '.extraKnownMarketplaces.engsys.source.ref = "v1.0.0"' "$HOME/git/app/.claude/settings.json" >"$T/s.json" && mv "$T/s.json" "$HOME/git/app/.claude/settings.json"

echo "== only a real mismatch is exit 1"
mv "$E/core/.claude-plugin/singleton-write-guard.mjs" "$T/guard.mjs"
run fleet verify
rc_is "the verifier itself crashing (a missing module) is not verified, not a mismatch" 3
has "…and says so" "$OUT" "the verifier failed"
mv "$T/guard.mjs" "$E/core/.claude-plugin/singleton-write-guard.mjs"
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
