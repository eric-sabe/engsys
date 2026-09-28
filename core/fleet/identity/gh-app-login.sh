#!/usr/bin/env bash
# gh-app-login.sh — keep the fleet's GitHub identity healthy as its GitHub App bot
# (for example `acme-fleet[bot]`). GitHub twin of az-sp-login.sh.
#
# Machine-safe: it changes NOTHING global. The fleet's git credential + bot author are carried in
# the fleet's own environment (git-env.sh — exported by the host scripts and written into every
# session's env), so ~/.gitconfig, the Keychain and a person's own `gh` login on the same
# machine are untouched.
#
# What it does (idempotent):
#   1. Mints a fresh App installation token and verifies it, and its permissions, against the API
#      (gh-app-token.mjs --check). Exit 3 from --check (permissions short) is a warning; any other
#      failure is a failure.
#   2. Verifies the env-scoped git identity resolves to the App helper + bot author.
#
# Runs under launchd (every 30 min) and as a preflight in the session launcher.
#
# Usage: gh-app-login.sh [path-to-env-file]
#   The env file is the argument, or GH_APP_ENV_FILE; there is no default location. It is
#   machine-local, chmod 600, never committed — shape in README.md (next to this script).
set -euo pipefail

ENV_FILE="${1:-${GH_APP_ENV_FILE:-}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TOKEN_JS="$HERE/gh-app-token.mjs"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "$ENV_FILE" ]; then
  echo "gh-app-login: no env file — pass it as the first argument or set GH_APP_ENV_FILE" >&2
  echo "  (shape in $HERE/README.md)" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "gh-app-login: env file not found: $ENV_FILE" >&2
  echo "  (no fleet GitHub identity configured — see $HERE/README.md)" >&2
  exit 1
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd -P)/$(basename "$ENV_FILE")"
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a
: "${GH_APP_ID:?env file must set GH_APP_ID}"
: "${GH_APP_INSTALLATION_ID:?env file must set GH_APP_INSTALLATION_ID}"
: "${GH_APP_PEM:?env file must set GH_APP_PEM}"
: "${GH_BOT_AUTHOR_NAME:?env file must set GH_BOT_AUTHOR_NAME}"
: "${GH_BOT_AUTHOR_EMAIL:?env file must set GH_BOT_AUTHOR_EMAIL}"
export GH_APP_ENV_FILE="$ENV_FILE"

NODE="$(command -v node)" || { echo "gh-app-login: node not found on PATH" >&2; exit 1; }

# 1. Token: mint fresh + verify (fails loudly — this is the health signal). Exit 3 = the token works
#    but the installation lacks a required permission: warn loudly and keep going (git/gh still work).
rc=0; "$NODE" "$TOKEN_JS" --check || rc=$?
case "$rc" in
  0) ;;
  3) echo "gh-app-login: WARNING the App installation is missing permissions (above) — fleet features that need them will fail" >&2 ;;
  *) exit "$rc" ;;
esac

# 2. Env-scoped git identity (what every fleet process and session gets).
# shellcheck source=git-env.sh
. "$HERE/git-env.sh"
fleet_git_env "$ENV_FILE"
HELPER_NOW="$(git config --get-all credential.https://github.com.helper | tail -1)"
case "$HELPER_NOW" in
  *gh-app-token.mjs*git-credential) ;;
  *) echo "gh-app-login: ERROR env-scoped git credential helper didn't take (got '$HELPER_NOW')" >&2; exit 1 ;;
esac
[ "$(git config --get user.name)" = "$GH_BOT_AUTHOR_NAME" ] \
  || { echo "gh-app-login: ERROR env-scoped git author didn't take" >&2; exit 1; }
[ "$(git config --get user.email)" = "$GH_BOT_AUTHOR_EMAIL" ] \
  || { echo "gh-app-login: ERROR env-scoped git author email didn't take" >&2; exit 1; }

echo "gh-app-login: OK ($(ts))"
