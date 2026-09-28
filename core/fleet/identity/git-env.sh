# shellcheck shell=bash
# git-env.sh — the fleet's git identity, scoped to the fleet's OWN processes (sourced; bash or zsh).
#
# git reads config from the environment (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>,
# git >= 2.31) at the highest precedence. Exporting the App credential helper and the bot author
# there means every git process the fleet starts — host scripts, launchd jobs, sessions and
# everything they spawn — acts as the bot (for example acme-fleet[bot]), while ~/.gitconfig, the
# Keychain and the person's own `gh` login are never touched. The same code serves a dedicated
# fleet macOS user and a machine shared with someone's other projects.
#
# The env file (see README.md) must set GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PEM,
# GH_BOT_AUTHOR_NAME and GH_BOT_AUTHOR_EMAIL.
#
#   fleet_git_env <gh-app.env>        export into the current shell (host scripts)
#   fleet_git_env_lines <gh-app.env>  print KEY=VALUE lines for a sourced env file (session env)
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _fleet_identity_src="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  eval '_fleet_identity_src="${(%):-%x}"' # zsh: path of the file being sourced
else
  _fleet_identity_src="$0"
fi
FLEET_IDENTITY_DIR="$(cd "$(dirname "$_fleet_identity_src")" && pwd -P)"
unset _fleet_identity_src

_fleet_sq() { # shell-single-quote $1 (same result in bash and zsh)
  local s="$1" q="'" bs='\'
  printf "'%s'" "${s//$q/$q$bs$q$q}"
}

_fleet_git_kv() { # → "key<TAB>value" lines: reset inherited github.com helpers, then the App helper + bot author
  local envf="$1" node name email abs helper
  [ -f "$envf" ] || { echo "fleet-git-env: GitHub App env file not found: $envf" >&2; return 1; }
  abs="$(cd "$(dirname "$envf")" && pwd -P)/$(basename "$envf")"
  node="$(command -v node)" || { echo "fleet-git-env: node not found on PATH" >&2; return 1; }
  # shellcheck source=/dev/null
  name="$(set -a; . "$abs"; printf '%s' "${GH_BOT_AUTHOR_NAME:-}")"
  # shellcheck source=/dev/null
  email="$(set -a; . "$abs"; printf '%s' "${GH_BOT_AUTHOR_EMAIL:-}")"
  [ -n "$name" ] && [ -n "$email" ] || { echo "fleet-git-env: $envf must set GH_BOT_AUTHOR_NAME and GH_BOT_AUTHOR_EMAIL" >&2; return 1; }
  # The helper carries its own env-file path, so it works even where GH_APP_ENV_FILE isn't exported.
  helper="!GH_APP_ENV_FILE=$(_fleet_sq "$abs") $(_fleet_sq "$node") $(_fleet_sq "$FLEET_IDENTITY_DIR/gh-app-token.mjs") git-credential"
  printf '%s\t%s\n' \
    credential.https://github.com.helper "" \
    credential.https://github.com.helper "$helper" \
    user.name "$name" \
    user.email "$email"
}

fleet_git_env() {
  [ "${FLEET_GIT_ENV:-}" = 1 ] && return 0 # already applied in this process tree
  local kv n="${GIT_CONFIG_COUNT:-0}" k v abs
  kv="$(_fleet_git_kv "$1")" || return 1
  abs="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
  while IFS=$'\t' read -r k v; do
    export "GIT_CONFIG_KEY_$n=$k" "GIT_CONFIG_VALUE_$n=$v"
    n=$((n + 1))
  done <<<"$kv"
  export GIT_CONFIG_COUNT="$n" FLEET_GIT_ENV=1 GH_APP_ENV_FILE="$abs"
}

fleet_git_env_lines() {
  local kv n=0 k v abs
  kv="$(_fleet_git_kv "$1")" || return 1
  abs="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
  echo "# Fleet git identity (core/fleet/identity/git-env.sh): App credential + bot author, this session only."
  while IFS=$'\t' read -r k v; do
    printf 'GIT_CONFIG_KEY_%d=%q\nGIT_CONFIG_VALUE_%d=%q\n' "$n" "$k" "$n" "$v"
    n=$((n + 1))
  done <<<"$kv"
  printf 'GIT_CONFIG_COUNT=%d\nFLEET_GIT_ENV=1\nGH_APP_ENV_FILE=%q\n' "$n" "$abs"
}
