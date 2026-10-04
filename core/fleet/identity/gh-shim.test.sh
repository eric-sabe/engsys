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

if [ "$FAILS" -gt 0 ]; then echo "gh-shim.test.sh: $FAILS failure(s)" >&2; exit 1; fi
echo "gh-shim.test.sh: all passed"
