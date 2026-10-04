#!/usr/bin/env bash
# git-env.test.sh — env-scoped git identity (git-env.sh): the fleet acts as the bot while a
# person's own global git config on the same machine stays untouched.
#
# Run: bash core/fleet/identity/git-env.test.sh   (needs git >= 2.31 and node; zsh cases skip without zsh)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
GIT_ENV_SH="$HERE/git-env.sh"

FAILS=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
contains() { # contains <desc> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 (no '$2' in: $3)" ;; esac
}
lacks() { # lacks <desc> <needle> <haystack>
  case "$3" in *"$2"*) bad "$1 ('$2' found in: $3)" ;; *) ok "$1" ;; esac
}

# --- a pretend person: their own identity + the macOS keychain credential helper --------------
export HOME="$T/home"
mkdir -p "$HOME" "$T/bin"
unset GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM FLEET_GIT_ENV GH_APP_ENV_FILE
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
cat > "$HOME/.gitconfig" <<'PERSON_CONFIG'
[user]
	name = Pat Person
	email = pat@example.com
[credential]
	helper = osxkeychain
PERSON_CONFIG
# Stub helper: records that it ran and answers with a personal credential. git looks up
# `git-credential-<name>` in its exec path before PATH (a real one ships with macOS git), so the
# stub goes in via GIT_EXEC_PATH to keep this test off the real keychain.
cat > "$T/bin/git-credential-osxkeychain" <<STUB_HELPER
#!/bin/sh
echo "\$1" >> "$T/keychain-called"
[ "\$1" = get ] && printf 'username=pat\npassword=personal-secret\n'
exit 0
STUB_HELPER
chmod +x "$T/bin/git-credential-osxkeychain"
export GIT_EXEC_PATH="$T/bin" PATH="$T/bin:$PATH"
GLOBAL_SUM="$(shasum "$HOME/.gitconfig" | cut -d' ' -f1)"

# --- a fleet App env file; the token cache is pre-seeded so no network is needed ---------------
mkdir -p "$T/it's a dir"
ENVF="$T/it's a dir/gh-app.env" # a quote and a space in the path exercise the helper's quoting
cat > "$ENVF" <<APP_ENV
GH_APP_ID=1
GH_APP_INSTALLATION_ID=2
GH_APP_PEM=$T/none.pem
GH_APP_CACHE=$T/cache.json
GH_APP_INSTALLATIONS=pat-person=3
GH_BOT_AUTHOR_NAME=acme-fleet[bot]
GH_BOT_AUTHOR_EMAIL=123+acme-fleet[bot]@users.noreply.github.com
APP_ENV
printf '{"token":"ghs_cached","expires_at":"2099-01-01T00:00:00Z","permissions":{}}' > "$T/cache.json"
printf '{"token":"ghs_pat","expires_at":"2099-01-01T00:00:00Z","permissions":{}}' > "$T/cache-3.json"

cred_fill() { printf 'protocol=https\nhost=github.com\n\n' | GIT_TRACE=1 git credential fill 2>&1; }

# 0. control: without the fleet env, git is the person's
check "control: person's identity outside the fleet" "Pat Person" "$(git config user.name)"
out="$(cred_fill)"
contains "control: keychain helper is what runs outside the fleet" "personal-secret" "$out"
rm -f "$T/keychain-called"

# 1. bash: fleet_git_env
(
  # shellcheck source=git-env.sh
  . "$GIT_ENV_SH"
  fleet_git_env "$ENVF"
  check "bash: user.name is the bot" "acme-fleet[bot]" "$(git config user.name)"
  check "bash: user.email is the bot" "123+acme-fleet[bot]@users.noreply.github.com" "$(git config user.email)"
  check "bash: GIT_CONFIG_COUNT is 5" "5" "$GIT_CONFIG_COUNT"
  check "bash: FLEET_GIT_ENV guard set" "1" "$FLEET_GIT_ENV"
  check "bash: GH_APP_ENV_FILE exported (absolute, resolved)" "$(cd "$(dirname "$ENVF")" && pwd -P)/gh-app.env" "$GH_APP_ENV_FILE"
  out="$(cred_fill)"
  contains "bash: credential fill runs the App helper" "gh-app-token.mjs" "$out"
  lacks "bash: credential fill does not run osxkeychain" "osxkeychain" "$out"
  contains "bash: credential fill returns the App token" "password=ghs_cached" "$out"
  contains "bash: credential fill returns the App username" "username=x-access-token" "$out"
  lacks "bash: personal credential not offered" "personal-secret" "$out"
  check "bash: useHttpPath set for github.com" "true" "$(git config credential.https://github.com.useHttpPath)"
  out="$(printf 'protocol=https\nhost=github.com\npath=pat-person/tools.git\n\n' | git credential fill 2>&1)"
  contains "bash: a listed owner's repo gets that installation's token" "password=ghs_pat" "$out"
  out="$(printf 'protocol=https\nhost=github.com\npath=acme/app.git\n\n' | git credential fill 2>&1)"
  contains "bash: any other owner gets the default installation's token" "password=ghs_cached" "$out"
  # a child process (as a session's tools would be) inherits the identity
  check "bash: child process inherits the bot identity" "acme-fleet[bot]" "$(sh -c 'git config user.name')"

  # idempotent: a second call (nested host scripts) must not grow the config
  fleet_git_env "$ENVF"
  check "bash: second call leaves GIT_CONFIG_COUNT at 5" "5" "$GIT_CONFIG_COUNT"
  check "bash: no sixth key appeared" "" "${GIT_CONFIG_KEY_5:-}"
)

# 1b. an inherited GIT_CONFIG_COUNT is appended to, not clobbered
(
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat
  # shellcheck source=git-env.sh
  . "$GIT_ENV_SH"
  fleet_git_env "$ENVF"
  check "bash: pre-existing env config kept, count is 6" "6" "$GIT_CONFIG_COUNT"
  check "bash: pre-existing env config still applies" "cat" "$(git config core.pager)"
  check "bash: bot still wins" "acme-fleet[bot]" "$(git config user.name)"
)

# 2. the person's global config is untouched, and the keychain helper never ran inside the fleet env
check "global gitconfig file is byte-identical" "$GLOBAL_SUM" "$(shasum "$HOME/.gitconfig" | cut -d' ' -f1)"
check "global user.name still the person" "Pat Person" "$(git config --global user.name)"
check "global credential.helper still osxkeychain" "osxkeychain" "$(git config --global credential.helper)"
check "keychain helper was never called inside the fleet env" "no" "$([ -e "$T/keychain-called" ] && echo yes || echo no)"
check "no fleet state leaked into this shell" "" "${GIT_CONFIG_COUNT:-}${FLEET_GIT_ENV:-}"

# 3. errors
(
  # shellcheck source=git-env.sh
  . "$GIT_ENV_SH"
  if fleet_git_env "$T/missing.env" 2>"$T/err"; then bad "missing env file should fail"; else ok "missing env file fails"; fi
  contains "missing env file names the problem" "env file not found" "$(cat "$T/err")"
  printf 'GH_BOT_AUTHOR_NAME=x\n' > "$T/noemail.env"
  if fleet_git_env "$T/noemail.env" 2>"$T/err"; then bad "missing author email should fail"; else ok "missing author email fails"; fi
  contains "missing author is explained" "GH_BOT_AUTHOR_EMAIL" "$(cat "$T/err")"
  check "failed calls set no guard" "" "${FLEET_GIT_ENV:-}"
)

# 4. fleet_git_env_lines: a sourceable env-file fragment
LINES_BASH="$T/lines.bash.env"
(
  # shellcheck source=git-env.sh
  . "$GIT_ENV_SH"
  fleet_git_env_lines "$ENVF" > "$LINES_BASH"
)
contains "lines: has the count" "GIT_CONFIG_COUNT=5" "$(cat "$LINES_BASH")"
contains "lines: has the guard" "FLEET_GIT_ENV=1" "$(cat "$LINES_BASH")"
contains "lines: carries the env file path" "GH_APP_ENV_FILE=" "$(cat "$LINES_BASH")"
(
  set -a
  # shellcheck source=/dev/null
  . "$LINES_BASH"
  set +a
  check "lines sourced in bash: bot identity" "acme-fleet[bot]" "$(git config user.name)"
  out="$(cred_fill)"
  contains "lines sourced in bash: App helper runs" "password=ghs_cached" "$out"
  lacks "lines sourced in bash: no osxkeychain" "osxkeychain" "$out"
)

# 5. zsh (the macOS default shell): source git-env.sh in zsh, and source the generated lines in zsh
if command -v zsh >/dev/null 2>&1; then
  ZSH_LINES="$T/lines.zsh.env"
  zsh -c '. "$1"; fleet_git_env_lines "$2"' zsh "$GIT_ENV_SH" "$ENVF" > "$ZSH_LINES"
  # zsh and bash quote `!` differently in %q output; what must match is the values they decode to
  decode() { ( # shellcheck source=/dev/null
      . "$1"; printf '%s|%s|%s|%s' "$GIT_CONFIG_VALUE_1" "$GIT_CONFIG_VALUE_2" "$GIT_CONFIG_COUNT" "$GH_APP_ENV_FILE"); }
  check "zsh-generated lines decode to the same values as bash-generated" "$(decode "$LINES_BASH")" "$(decode "$ZSH_LINES")"
  out="$(zsh -c '
    set -a; . "$1"; set +a
    git config user.name
    printf "protocol=https\nhost=github.com\n\n" | GIT_TRACE=1 git credential fill 2>&1
  ' zsh "$ZSH_LINES")"
  contains "lines sourced in zsh: bot identity" "acme-fleet[bot]" "$out"
  contains "lines sourced in zsh: App helper" "password=ghs_cached" "$out"
  lacks "lines sourced in zsh: no osxkeychain" "osxkeychain" "$out"
  out="$(zsh -c '
    . "$1"; fleet_git_env "$2"; fleet_git_env "$2"
    echo "count=$GIT_CONFIG_COUNT name=$(git config user.name)"
  ' zsh "$GIT_ENV_SH" "$ENVF")"
  check "zsh: fleet_git_env twice does not grow the count" "count=5 name=acme-fleet[bot]" "$out"
else
  echo "skip zsh cases (zsh not installed)"
fi

check "global gitconfig still byte-identical at the end" "$GLOBAL_SUM" "$(shasum "$HOME/.gitconfig" | cut -d' ' -f1)"

if [ "$FAILS" -gt 0 ]; then
  echo "git-env.test.sh: $FAILS failure(s)" >&2
  exit 1
fi
echo "git-env.test.sh: all passed"
