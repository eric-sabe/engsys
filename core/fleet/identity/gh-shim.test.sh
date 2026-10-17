#!/usr/bin/env bash
# gh-shim.test.sh — the fleet gh shim picks the App installation for the repo owner a command names.
# Run by `npm test`. Offline: token caches are pre-seeded, and the "real" gh is a stub that prints
# the GH_TOKEN it was handed.
set -uo pipefail
# Under a git hook GIT_DIR points at the enclosing repo; a child `git init` would then rewrite it.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_CONFIG_COUNT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SHIM="$HERE/bin/gh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (want '$2', got '$3')"; FAILS=$((FAILS + 1)); fi; }

mkdir -p "$T/realbin" "$T/repo-pat" "$T/repo-acme" "$T/norepo"
cat >"$T/realbin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$GH_TOKEN"
SH
chmod +x "$T/realbin/gh"

cat >"$T/gh-app.env" <<APP_ENV
GH_APP_ID=1
GH_APP_INSTALLATION_ID=2
GH_APP_PEM=$T/none.pem
GH_APP_CACHE=$T/cache.json
GH_APP_INSTALLATIONS=pat-person=3,FeedFrwd=4
APP_ENV
printf '{"token":"tok_default","expires_at":"2099-01-01T00:00:00Z","permissions":{}}' >"$T/cache.json"
printf '{"token":"tok_pat","expires_at":"2099-01-01T00:00:00Z","permissions":{}}' >"$T/cache-3.json"
printf '{"token":"tok_feedfrwd","expires_at":"2099-01-01T00:00:00Z","permissions":{}}' >"$T/cache-4.json"

git -C "$T/repo-pat" init -q && git -C "$T/repo-pat" remote add origin https://github.com/pat-person/tools.git
git -C "$T/repo-acme" init -q && git -C "$T/repo-acme" remote add origin git@github.com:acme/app.git

run() { (cd "$1" && shift && env -u GH_APP_OWNER \
  PATH="$HERE/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" "$@"); }

check "-R names a listed owner"            tok_pat     "$(run "$T/norepo" pr list -R pat-person/tools)"
check "--repo <x> names a listed owner"    tok_pat     "$(run "$T/norepo" pr create --repo pat-person/tools)"
check "--repo=<x> names a listed owner"    tok_pat     "$(run "$T/norepo" pr view 1 --repo=pat-person/tools)"
check "-R<x> (attached) names it too"      tok_pat     "$(run "$T/norepo" pr list -Rpat-person/tools)"
check "gh api repos/<owner>/..."           tok_pat     "$(run "$T/norepo" api repos/pat-person/tools/pulls)"
check "gh api /repos/<owner>/..."          tok_pat     "$(run "$T/norepo" api /repos/pat-person/tools)"
check "a github.com URL argument"          tok_pat     "$(run "$T/norepo" pr view https://github.com/pat-person/tools/pull/1)"
check "an unlisted owner gets the default" tok_default "$(run "$T/norepo" pr list -R acme/app)"
check "no owner anywhere: default"         tok_default "$(run "$T/norepo" api /rate_limit)"
check "origin (https) of the current repo" tok_pat     "$(run "$T/repo-pat" pr list)"
check "origin (ssh) of the current repo"   tok_default "$(run "$T/repo-acme" pr list)"
check "an explicit -R beats origin"        tok_default "$(run "$T/repo-pat" pr list -R acme/app)"
check "GH_APP_OWNER beats everything"      tok_pat     "$(cd "$T/repo-acme" && env PATH="$HERE/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" GH_APP_OWNER=pat-person "$SHIM" pr list -R acme/app)"
check "--owner <x> names a listed owner"       tok_feedfrwd "$(run "$T/norepo" project item-list 11 --owner FeedFrwd)"
check "--owner=<x> names a listed owner"       tok_feedfrwd "$(run "$T/norepo" project item-list 11 --owner=FeedFrwd)"
check "--owner beats a URL argument (#55)"     tok_feedfrwd "$(run "$T/norepo" project item-add 89 --owner FeedFrwd --url https://github.com/pat-person/tools/issues/53)"
check "--owner beats -R/--repo"                tok_feedfrwd "$(run "$T/norepo" pr list -R pat-person/tools --owner FeedFrwd)"
check "--owner beats origin of current repo"   tok_feedfrwd "$(run "$T/repo-pat" project item-list 11 --owner FeedFrwd)"
check "GH_APP_OWNER beats --owner"              tok_pat      "$(cd "$T/norepo" && env PATH="$HERE/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" GH_APP_OWNER=pat-person "$SHIM" project item-list 11 --owner FeedFrwd)"
mkdir -p "$T/copilotps"
cat >"$T/copilotps/ps" <<'SH'
#!/usr/bin/env bash
echo "copilot"
SH
chmod +x "$T/copilotps/ps"

check "CT-09: child bash calling gh auth token gets App token" tok_default "$(run "$T/norepo" auth token)"
check "CT-09: copilot parent without GH_TOKEN_COPILOT_CLI still gets App token (never operator keychain)" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" auth token)"
# engsys v2.0.1 (L2): a process merely NAMED "copilot" (ps -o comm=) must NOT be enough to get the
# seat token without ENGSYS_COPILOT_CLI_PID also being set and matching $PPID exactly.
check "v2.0.1 L2: copilot-named parent with NO ENGSYS_COPILOT_CLI_PID gets App token, never the seat token" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" auth status)"
check "CT-09: mismatched ENGSYS_COPILOT_CLI_PID rejects spoofed copilot child process" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat ENGSYS_COPILOT_CLI_PID=999999 PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" auth token)"
# Positive control: the legitimate relay still works when ENGSYS_COPILOT_CLI_PID correctly names
# the shim's real parent PID. A tiny relay wrapper reads its OWN $PPID (its parent, i.e. the
# process that is about to become the shim's parent too) and exports it before `exec`'ing the
# shim in its place — exec never changes PPID, so the shim sees the exact same $PPID it just set.
# ($BASHPID/$$ from the calling subshell are NOT reliable stand-ins here: which PID ends up as the
# shim's PPID depends on bash's fork-elision for the last command in a subshell, which this test
# observed to NOT be $BASHPID.)
cat >"$T/relay.sh" <<'SH'
#!/usr/bin/env bash
export ENGSYS_COPILOT_CLI_PID="$PPID"
exec "$@"
SH
chmod +x "$T/relay.sh"
check "v2.0.1 L2: correct ENGSYS_COPILOT_CLI_PID still relays the seat token" "gho_seat" "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/relay.sh" "$SHIM" auth status)"
# The gate no longer looks at the parent process's name at all: a correct PID relays the seat token
# even when the parent isn't named "copilot" (PATH has no $T/copilotps here).
check "v2.0.1 L2: correct ENGSYS_COPILOT_CLI_PID relays regardless of parent process name" "gho_seat" "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/relay.sh" "$SHIM" auth status)"
# The seat token must never ride along into an agent-visible env for an ordinary (non-auth-relay)
# call: a dedicated "real gh" stub reports whether it inherited GH_TOKEN_COPILOT_CLI at all.
mkdir -p "$T/envbin"
cat >"$T/envbin/gh" <<'SH'
#!/usr/bin/env bash
printf 'seen=%s\n' "${GH_TOKEN_COPILOT_CLI+yes}"
SH
chmod +x "$T/envbin/gh"
# Not "auth token"/"auth status" (so this does NOT take the seat-token relay branch at all) — a
# PID-matched Copilot-launcher session's GH_TOKEN_COPILOT_CLI must not leak into env for any other
# gh subcommand either.
check "v2.0.1 L2: GH_TOKEN_COPILOT_CLI is unset before any other gh invocation" "seen=" "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/envbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/relay.sh" "$SHIM" pr list)"
check "CT-09: copilot parent calling gh pr list still gets App token (NA-6)" tok_pat "$(cd "$T/repo-pat" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" pr list)"

if [ "$FAILS" -gt 0 ]; then echo "gh-shim.test.sh: $FAILS failure(s)" >&2; exit 1; fi
echo "gh-shim.test.sh: all passed"
