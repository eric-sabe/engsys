#!/usr/bin/env bash
# sandbox.sh — shared harness for the fleet kit tests (sourced, not run): assertions, a temp HOME whose
# git config rewrites https://github.com/ to bare remotes under the sandbox, and helpers to seed them.
# The sourcing test sets nothing up in advance; it gets $T (sandbox root), $HOME, $FAKE, remotes/ and PATH
# with $T/bin first (the test installs its stubs there).

# shellcheck source=scrub-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/scrub-env.sh"

T="$(cd "$(mktemp -d)" && pwd -P)"
PIDS=()
cleanup() {
  local p
  for p in ${PIDS[@]+"${PIDS[@]}"}; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

# Results are counted in files so assertions inside subshells count too.
: >"$T/pass.log"; : >"$T/fail.log"
ok() { echo . >>"$T/pass.log"; echo "  ok   $1"; }
bad() { echo . >>"$T/fail.log"; echo "  FAIL $1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$@" | sed 's/^/         /'; fi; }
has() { # has <desc> <text> <fixed substring>
  if grep -Fq -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "want: $3" "got:" "$2"; fi
}
hasnt() { # hasnt <desc> <text> <fixed substring>
  if grep -Fq -- "$3" <<<"$2"; then bad "$1" "did not want: $3" "got:" "$2"; else ok "$1"; fi
}
matches() { # matches <desc> <text> <extended regex>
  if grep -Eq -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "want /$3/" "got:" "$2"; fi
}
eq() { # eq <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got:  $2"; fi
}
RC=0 OUT=""
run() { RC=0; OUT="$("$@" 2>&1)" || RC=$?; }
rc_is() { # rc_is <desc> <expected rc> — checks the last `run`
  if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1" "want rc $2, got $RC; output:" "$OUT"; fi
}

# --- sandbox environment ---------------------------------------------------------------------
export HOME="$T/home" FAKE="$T/fake" GIT_CONFIG_GLOBAL="$T/home/.gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
mkdir -p "$HOME/.config/acme" "$HOME/git" "$T/bin" "$FAKE" "$T/remotes" "$T/seed"
unset FLEET_INSTANCE ENGSYS_REF INSTANCE_REF PIN_SETTINGS GH_TOKEN GITHUB_TOKEN FLEET_CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR TMUX_SESSION LOG_DIR
cat >"$HOME/.gitconfig" <<EOF
[user]
	name = Sandbox
	email = sandbox@example.invalid
[init]
	defaultBranch = main
[advice]
	detachedHead = false
[commit]
	gpgsign = false
[tag]
	gpgsign = false
[url "file://$T/remotes/"]
	insteadOf = https://github.com/
EOF

seed_repo() { # seed_repo <slug> <dir> — a work repo wired (via insteadOf) to a fresh bare remote
  git init -q --bare "$T/remotes/$1.git"
  git init -q "$2"
  git -C "$2" remote add origin "https://github.com/$1.git"
}
commit_all() { git -C "$1" add -A && git -C "$1" commit -q -m "$2"; }
push_all() { git -C "$1" push -q origin main --tags; }

finish() { # finish <name> — print the tally, fail if anything failed
  local pass fail
  pass="$(wc -l <"$T/pass.log" | tr -d ' ')"; fail="$(wc -l <"$T/fail.log" | tr -d ' ')"
  echo; echo "$1: $pass passed, $fail failed"
  [ "$fail" = 0 ]
}
