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
# engsys v2.0.1 round 2 (F5, Nyx F3): the Copilot seat-token relay is REMOVED entirely — the fleet
# is Claude-only, and the relay was dead code that could still be bypassed. The shim must now
# return the App token for `gh auth token`/`gh auth status` under EVERY circumstance that used to
# trigger the relay, including a correctly PID-matched one.
check "v2.0.1 round 2 F5: copilot-named parent with GH_TOKEN_COPILOT_CLI set still gets the App token, never the seat token" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" auth status)"
check "CT-09: mismatched ENGSYS_COPILOT_CLI_PID (now-irrelevant leftover env var) still gets the App token" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat ENGSYS_COPILOT_CLI_PID=999999 PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" auth token)"
# Positive control for the removal: even a PID that WOULD have matched under the old (now-deleted)
# relay logic still gets the App token, never the seat token. A tiny relay wrapper reads its OWN
# $PPID (its parent, i.e. the process about to become the shim's parent too) and exports it as
# ENGSYS_COPILOT_CLI_PID before `exec`'ing the shim in its place — exec never changes PPID, so the
# shim would have seen an exact PID match under the old code.
cat >"$T/relay.sh" <<'SH'
#!/usr/bin/env bash
export ENGSYS_COPILOT_CLI_PID="$PPID"
exec "$@"
SH
chmod +x "$T/relay.sh"
check "v2.0.1 round 2 F5: a PID that would have matched the old relay still gets the App token (relay fully removed)" tok_default "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/relay.sh" "$SHIM" auth status)"
# The seat token must never ride along into an agent-visible env for ANY gh invocation — a
# dedicated "real gh" stub reports whether it inherited GH_TOKEN_COPILOT_CLI at all.
mkdir -p "$T/envbin"
cat >"$T/envbin/gh" <<'SH'
#!/usr/bin/env bash
printf 'seen=%s\n' "${GH_TOKEN_COPILOT_CLI+yes}"
SH
chmod +x "$T/envbin/gh"
check "v2.0.1 round 2 F5: GH_TOKEN_COPILOT_CLI is unset before every gh invocation (auth status included — no relay branch exists any more)" "seen=" "$(cd "$T/norepo" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/envbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/relay.sh" "$SHIM" auth status)"
check "CT-09: copilot parent calling gh pr list still gets App token (NA-6)" tok_pat "$(cd "$T/repo-pat" && env -u GH_TOKEN GH_TOKEN_COPILOT_CLI=gho_seat PATH="$HERE/bin:$T/copilotps:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$SHIM" pr list)"

# engsys#190: two checkouts' copies of the shim on PATH must not exec each other forever. Each copy skips
# EVERY shim copy (by identity marker), not only its own directory, and reaches the real gh.
mkdir -p "$T/ckA/identity/bin" "$T/ckB/identity/bin"
for ck in ckA ckB; do cp "$SHIM" "$T/$ck/identity/bin/gh"; cp "$HERE/gh-app-token.mjs" "$T/$ck/identity/gh-app-token.mjs"; done
twin() { (cd "$T/norepo" && env -u GH_APP_OWNER -u ENGSYS_GH_SHIM_HOPS PATH="$T/ckA/identity/bin:$T/ckB/identity/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$1" "${@:2}"); }
check "190: shim copy A (B also on PATH) reaches the real gh"  tok_default "$(twin "$T/ckA/identity/bin/gh" pr list)"
check "190: shim copy B (A first on PATH) reaches the real gh" tok_default "$(twin "$T/ckB/identity/bin/gh" pr list)"
check "190: the in-tree shim with both copies ahead of the real gh" tok_default "$(twin "$SHIM" pr list)"
check "190: only shim copies on PATH: no real gh found, exit 127 (never a hang)" "127" "$(cd "$T/norepo" && env -u GH_APP_OWNER PATH="$T/ckA/identity/bin:$T/ckB/identity/bin:/usr/bin:/bin" GH_APP_ENV_FILE="$T/gh-app.env" "$T/ckA/identity/bin/gh" pr list >/dev/null 2>&1; echo $?)"
# Backstop: a wrapper that is not marked (here a copy with the marker stripped) is still bounded by the hop count.
mkdir -p "$T/ckC/identity/bin" "$T/ckD/identity/bin"
for ck in ckC ckD; do sed 's/engsys-fleet-gh-shim:/unmarked:/g' "$SHIM" >"$T/$ck/identity/bin/gh"; chmod +x "$T/$ck/identity/bin/gh"; cp "$HERE/gh-app-token.mjs" "$T/$ck/identity/gh-app-token.mjs"; done
sed -i.bak 's/^is_shim_copy() .*/is_shim_copy() { return 1; }/' "$T/ckC/identity/bin/gh" "$T/ckD/identity/bin/gh"; rm -f "$T"/ck?/identity/bin/gh.bak
loop_out="$(cd "$T/norepo" && env -u GH_APP_OWNER -u ENGSYS_GH_SHIM_HOPS PATH="$T/ckC/identity/bin:$T/ckD/identity/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$T/ckC/identity/bin/gh" pr list 2>&1; echo "rc=$?")"
check "190: unmarked shim copies are stopped by the hop guard (exit 126)" "rc=126" "$(printf '%s\n' "$loop_out" | tail -n 1)"
check "190: ...with an exec-loop message" "yes" "$(printf '%s' "$loop_out" | grep -q 'exec loop detected' && echo yes || echo no)"

# Mixed versions: a shim from before the marker (identified by its header) beside the new one.
mkdir -p "$T/ckOld/identity/bin"
cat >"$T/ckOld/identity/bin/gh" <<'SH'
#!/usr/bin/env bash
# gh (fleet shim) — run the real GitHub CLI as the fleet's GitHub App bot.
# (stand-in for a shim from before the identity marker: same header, dir-only "real gh" search)
echo "old shim reached: it should have been skipped" >&2; exit 99
SH
chmod +x "$T/ckOld/identity/bin/gh"; cp "$HERE/gh-app-token.mjs" "$T/ckOld/identity/gh-app-token.mjs"
mixed() { (cd "$T/norepo" && env -u GH_APP_OWNER -u ENGSYS_GH_SHIM_HOPS PATH="$T/ckOld/identity/bin:$T/ckA/identity/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$1" "${@:2}"); }
check "190: new shim skips an old (unmarked) shim on PATH" tok_default "$(mixed "$T/ckA/identity/bin/gh" pr list)"
mixed_rev() { (cd "$T/norepo" && env -u GH_APP_OWNER -u ENGSYS_GH_SHIM_HOPS PATH="$T/ckA/identity/bin:$T/ckOld/identity/bin:$T/realbin:$PATH" GH_APP_ENV_FILE="$T/gh-app.env" "$1" "${@:2}"); }
check "190: ...and in the reverse PATH order" tok_default "$(mixed_rev "$T/ckA/identity/bin/gh" pr list)"
# An old shim recognised only by its error-message prefix (header comment edited away).
printf '#!/usr/bin/env bash\necho "gh (fleet shim): real gh not found on PATH" >&2; exit 99\n' >"$T/ckOld/identity/bin/gh"
check "190: an old shim matched by its 'gh (fleet shim):' message prefix is skipped too" tok_default "$(mixed_rev "$T/ckA/identity/bin/gh" pr list)"

if [ "$FAILS" -gt 0 ]; then echo "gh-shim.test.sh: $FAILS failure(s)" >&2; exit 1; fi
echo "gh-shim.test.sh: all passed"
