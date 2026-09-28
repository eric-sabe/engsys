#!/usr/bin/env bash
# repo-gates.test.sh — tests for the repo-gates templates (run by `npm test`; no network).
#
#   1. shellcheck (-x -S warning) over every shell template, hook and this file
#   2. precheck.sh.tmpl gate matrix in a temp git repo (stub gate table)
#   3. husky hooks (pre-push override + propagation, pre-commit gitleaks handling)
#   4. git-prune-merged-branches.sh in a temp repo
#   5. worktree-bootstrap.sh.tmpl in a temp repo + worktree
#   6. workflow YAML parses (+ actionlint when installed); JSON/JSONC configs parse
#   7. public-neutrality scan of everything this task ships
#
# Sections 2, 4 and 5 run under every bash they can find (PATH bash, and macOS
# /bin/bash 3.2 when different) so a bash-4-ism cannot slip in.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATES_DIR="$(cd "$HERE/.." && pwd -P)"          # core/templates/repo-gates
CORE="$(cd "$GATES_DIR/../.." && pwd -P)"       # core
PRECHECK_TMPL="$GATES_DIR/scripts/precheck.sh.tmpl"
BOOTSTRAP_TMPL="$GATES_DIR/scripts/worktree-bootstrap.sh.tmpl"
PRUNE="$CORE/scripts/git-prune-merged-branches.sh"

# Hermetic git: this test may itself run from inside a git hook (which exports
# GIT_DIR and friends), and must never read or write the caller's git config.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$T/gitconfig"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config --file "$GIT_CONFIG_GLOBAL" advice.detachedHead false

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ "${2:-}" ] && printf '       %s\n' "$2"; }
check() { # <desc> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}
eq() { # <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
has() { # <desc> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "missing [$2] in: $(printf '%s' "$3" | tail -n 6 | tr '\n' '~')" ;; esac
}
lacks() { # <desc> <needle> <haystack>
  case "$3" in *"$2"*) bad "$1" "unexpected [$2]" ;; *) ok "$1" ;; esac
}

SHELLS=()
for cand in "$(command -v bash)" /bin/bash; do
  [ -x "$cand" ] || continue
  dup=0
  for s in ${SHELLS[@]+"${SHELLS[@]}"}; do [ "$s" = "$cand" ] && dup=1; done
  [ "$dup" = 1 ] || SHELLS+=("$cand")
done

commit() { git -C "$1" add -A && git -C "$1" commit -q -m "${2:-c}"; }

# ---------------------------------------------------------------------------
echo "1. shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  if out="$(shellcheck -x -S warning \
      "$PRECHECK_TMPL" "$BOOTSTRAP_TMPL" "$GATES_DIR/husky/pre-commit" "$GATES_DIR/husky/pre-push" \
      "$PRUNE" "${BASH_SOURCE[0]}" 2>&1)"; then
    ok "shellcheck -S warning clean (templates, hooks, prune, this test)"
  else
    bad "shellcheck" "$out"
  fi
else
  echo "  skip shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# 2. precheck gate matrix
# ---------------------------------------------------------------------------
# Build scripts/precheck.sh from the template with the CONFIG block replaced by
# a stub gate table, exactly how an adopter edits it.
render_with_config() { # <template> <config-file> <dest>
  awk -v cfg="$2" '
    /^# >>> CONFIG/ { print; while ((getline l < cfg) > 0) print l; skip = 1; next }
    /^# <<< CONFIG/ { skip = 0 }
    !skip { print }' "$1" >"$3"
}

cat >"$T/precheck.cfg" <<'EOF'
BASE_REF="${PRECHECK_BASE:-origin/main}"
GATE_SEP='|'
DOCS_ONLY_REGEX='(\.md$|^docs/|^\.claude/|^\.agents/)'
DOCKER_REMEDIATION="start the stub engine"
GATES=(
  'build|:build|echo build >> "$LOG"'
  'unit|\.[jt]sx?$|echo unit >> "$LOG"'
  'docs|\.md$|echo docs >> "$LOG"'
  'e2e@docker@needs-build|e2e/|echo e2e >> "$LOG"'
  'files|\.txt$|echo files >> "$LOG"; echo "$PRECHECK_GATE_FILES" | tr "\n" " " > "$LOG.files"'
  'always|:always|echo always >> "$LOG"'
  'failing|failme\.txt$|echo failing >> "$LOG"; false'
  'after|:always|echo after >> "$LOG"'
)
EOF

mkdir -p "$T/docker-down" "$T/docker-up"
printf '#!/bin/sh\nexit 1\n' >"$T/docker-down/docker"
printf '#!/bin/sh\nexit 0\n' >"$T/docker-up/docker"
chmod +x "$T/docker-down/docker" "$T/docker-up/docker"

# A repo whose `origin/main` is the base, with scripts/precheck.sh committed on main.
mk_precheck_repo() { # <dir>
  local d="$1"
  git init -q --bare "$d.origin.git"
  git init -q "$d"
  mkdir -p "$d/scripts"
  render_with_config "$PRECHECK_TMPL" "$T/precheck.cfg" "$d/scripts/precheck.sh"
  echo "# proj" >"$d/README.md"
  commit "$d" init
  git -C "$d" remote add origin "$d.origin.git"
  git -C "$d" push -q -u origin main
}

new_branch() { git -C "$1" checkout -q main && git -C "$1" branch -q -D feat 2>/dev/null; git -C "$1" checkout -q -b feat; }

# run_pc <repo> <docker-stub-dir|-> [env...] -- [args...]; sets OUT and RC.
run_pc() {
  local d="$1" dk="$2"; shift 2
  local envs=() args=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  args=("$@")
  : >"$T/gate.log"
  local pathv="$PATH"
  [ "$dk" != "-" ] && pathv="$dk:$PATH"
  OUT="$(cd "$d" && env LOG="$T/gate.log" PATH="$pathv" ${envs[@]+"${envs[@]}"} "$SH" scripts/precheck.sh ${args[@]+"${args[@]}"} 2>&1)"
  RC=$?
}
ran() { tr '\n' ' ' <"$T/gate.log" | sed 's/ $//'; }

t_precheck() {
  local R="$T/pc-$SHNAME"
  mk_precheck_repo "$R"

  new_branch "$R"; mkdir -p "$R/docs"; echo x >"$R/docs/a.md"; echo y >>"$R/README.md"; commit "$R" docs
  run_pc "$R" "$T/docker-up"
  eq "docs-only diff: rc 0" 0 "$RC"
  eq "docs-only diff: runs docs + always + after, skips build/unit (fast path)" "docs always after" "$(ran)"
  has "docs-only diff: fast path is announced" "skipped (only Markdown" "$OUT"
  has "docs-only diff: summary says PASSED" "PRECHECK PASSED" "$OUT"

  new_branch "$R"; mkdir -p "$R/src"; echo x >"$R/src/a.ts"; commit "$R" code
  run_pc "$R" "$T/docker-up"
  eq "code diff: rc 0" 0 "$RC"
  eq "code diff: build + unit + always + after (no docs, no e2e)" "build unit always after" "$(ran)"

  new_branch "$R"
  run_pc "$R" "$T/docker-up"
  eq "empty diff: rc 0" 0 "$RC"
  eq "empty diff: build (never fast-pathed) + always + after only" "build always after" "$(ran)"

  new_branch "$R"; mkdir -p "$R/e2e"; echo x >"$R/e2e/case.json"; commit "$R" e2e
  run_pc "$R" "$T/docker-down"
  eq "docker gate, docker down: rc 1" 1 "$RC"
  eq "docker gate, docker down: NO gate ran (fails fast, before anything slow)" "" "$(ran)"
  has "docker gate, docker down: names the gate" "e2e" "$OUT"
  has "docker gate, docker down: prints the remediation" "start the stub engine" "$OUT"

  run_pc "$R" "$T/docker-up"
  eq "docker gate, docker up: rc 0" 0 "$RC"
  eq "docker gate, docker up: e2e + build (needs-build) + always + after" "build e2e always after" "$(ran)"

  new_branch "$R"; mkdir -p "$R/docs/e2e"; echo x >"$R/docs/e2e/n.md"; commit "$R" docsdocker
  run_pc "$R" "$T/docker-up"
  eq "@needs-build promotes build even on a docs-only diff" "build docs e2e always after" "$(ran)"

  new_branch "$R"; echo x >"$R/failme.txt"; echo z >"$R/other.txt"; commit "$R" fail
  run_pc "$R" "$T/docker-up"
  eq "failing gate: rc 1 (FAILED propagates)" 1 "$RC"
  has "failing gate: [FAIL] printed" "[FAIL] failing" "$OUT"
  has "failing gate: summary says FAILED" "PRECHECK FAILED" "$OUT"
  lacks "failing gate: never claims PASSED" "PRECHECK PASSED" "$OUT"
  has "failing gate: later gates still ran (the run reports everything)" "after" "$(ran)"
  eq "failing gate: PRECHECK_GATE_FILES lists exactly the matching files" "failme.txt other.txt " "$(cat "$T/gate.log.files")"

  run_pc "$R" "$T/docker-down" PUSH_OVERRIDE=1
  eq "PUSH_OVERRIDE=1: rc 0" 0 "$RC"
  eq "PUSH_OVERRIDE=1: nothing ran (not even always, not the docker preflight)" "" "$(ran)"
  has "PUSH_OVERRIDE=1: says so" "PUSH_OVERRIDE=1" "$OUT"

  run_pc "$R" "$T/docker-up" -- --full
  eq "--full: every gate runs (even on a diff that selected few)" "build unit docs e2e files always failing after" "$(ran)"
  eq "--full: rc 1 because the failing gate ran" 1 "$RC"

  run_pc "$R" "$T/docker-up" -- --dry-run
  eq "--dry-run: nothing executed" "" "$(ran)"
  has "--dry-run: lists selected gates" "[DRY-RUN] would run: failing" "$OUT"

  new_branch "$R"; echo x >"$R/a.ts"; commit "$R" code2
  run_pc "$R" "$T/docker-up" PRECHECK_BASE=origin/does-not-exist
  has "unresolvable base: says it is running everything" "running EVERY gate" "$OUT"
  eq "unresolvable base: fails closed, every gate ran" "build unit docs e2e files always failing after" "$(ran)"

  # Separator override: regex alternation needs a different GATE_SEP.
  cat >"$T/alt.cfg" <<'EOF'
BASE_REF="origin/main"
GATE_SEP='@@'
DOCS_ONLY_REGEX='\.md$'
DOCKER_REMEDIATION="n/a"
GATES=(
  'alt@@\.(ts|js)$@@echo alt >> "$LOG"'
  'pipe@@:always@@echo a | tr a b >> "$LOG"'
)
EOF
  render_with_config "$PRECHECK_TMPL" "$T/alt.cfg" "$R/scripts/precheck-alt.sh"
  : >"$T/gate.log"
  OUT="$(cd "$R" && LOG="$T/gate.log" "$SH" scripts/precheck-alt.sh 2>&1)"; RC=$?
  eq "custom GATE_SEP: alternation regex + piped command work (rc 0)" 0 "$RC"
  eq "custom GATE_SEP: both gates ran" "alt b" "$(ran)"

  # Malformed row: loud, up front, non-zero.
  cat >"$T/bad.cfg" <<'EOF'
BASE_REF="origin/main"
GATE_SEP='|'
DOCS_ONLY_REGEX='\.md$'
DOCKER_REMEDIATION="n/a"
GATES=( 'oops|only-two-fields' )
EOF
  render_with_config "$PRECHECK_TMPL" "$T/bad.cfg" "$R/scripts/precheck-bad.sh"
  OUT="$(cd "$R" && "$SH" scripts/precheck-bad.sh 2>&1)"; RC=$?
  eq "malformed GATES row: rc 2" 2 "$RC"
  has "malformed GATES row: says which row" "only-two-fields" "$OUT"

  # The shipped table (unedited) must at least parse and dry-run.
  cp "$PRECHECK_TMPL" "$R/scripts/precheck-shipped.sh"
  OUT="$(cd "$R" && PATH="$T/docker-up:$PATH" "$SH" scripts/precheck-shipped.sh --dry-run 2>&1)"; RC=$?
  eq "shipped template: --dry-run parses its own table (rc 0)" 0 "$RC"
}

# ---------------------------------------------------------------------------
# 3. husky hooks
# ---------------------------------------------------------------------------
t_hooks() {
  local out rc
  out="$(PUSH_OVERRIDE=1 PRECHECK_CMD="echo RAN; exit 1" sh "$GATES_DIR/husky/pre-push" 2>&1)"; rc=$?
  eq "pre-push: PUSH_OVERRIDE=1 exits 0" 0 "$rc"
  lacks "pre-push: PUSH_OVERRIDE=1 does not run the gate" "RAN" "$out"
  out="$(PRECHECK_CMD="echo RAN; exit 3" sh "$GATES_DIR/husky/pre-push" 2>&1)"; rc=$?
  eq "pre-push: gate exit code propagates" 3 "$rc"
  has "pre-push: runs PRECHECK_CMD" "RAN" "$out"
  out="$(cd "$T" && mkdir -p hk/scripts && printf '#!/bin/sh\necho DEFAULT-GATE\n' >hk/scripts/precheck.sh && cd hk && sh "$GATES_DIR/husky/pre-push" 2>&1)"; rc=$?
  eq "pre-push: default command is scripts/precheck.sh (rc)" 0 "$rc"
  has "pre-push: default command is scripts/precheck.sh" "DEFAULT-GATE" "$out"

  mkdir -p "$T/hk-bin"
  printf '#!/bin/sh\necho LINTSTAGED-RAN\n' >"$T/hk-bin/npx"; chmod +x "$T/hk-bin/npx"
  local base_path="$T/hk-bin:/usr/bin:/bin"
  if PATH="$base_path" command -v gitleaks >/dev/null 2>&1; then
    echo "  skip pre-commit missing-gitleaks case (gitleaks lives in /usr/bin or /bin)"
  else
    out="$(PATH="$base_path" sh "$GATES_DIR/husky/pre-commit" 2>&1)"; rc=$?
    eq "pre-commit: missing gitleaks does not block (rc 0)" 0 "$rc"
    has "pre-commit: lint-staged ran" "LINTSTAGED-RAN" "$out"
    has "pre-commit: missing gitleaks warns loudly" "gitleaks is NOT installed" "$out"
  fi
  mkdir -p "$T/gl-fail" "$T/gl-ok"
  printf '#!/bin/sh\necho FINDING\nexit 1\n' >"$T/gl-fail/gitleaks"
  printf '#!/bin/sh\nexit 0\n' >"$T/gl-ok/gitleaks"
  chmod +x "$T/gl-fail/gitleaks" "$T/gl-ok/gitleaks"
  out="$(PATH="$T/gl-fail:$base_path" sh "$GATES_DIR/husky/pre-commit" 2>&1)"; rc=$?
  eq "pre-commit: a gitleaks finding blocks the commit (rc 1)" 1 "$rc"
  has "pre-commit: finding message" "potential secret" "$out"
  out="$(PATH="$T/gl-ok:$base_path" sh "$GATES_DIR/husky/pre-commit" 2>&1)"; rc=$?
  eq "pre-commit: clean gitleaks passes (rc 0)" 0 "$rc"
  printf '#!/bin/sh\necho LINT-FAIL\nexit 1\n' >"$T/hk-bin/npx"
  out="$(PATH="$T/gl-ok:$base_path" sh "$GATES_DIR/husky/pre-commit" 2>&1)"; rc=$?
  eq "pre-commit: lint-staged failure blocks the commit (rc 1)" 1 "$rc"
}

# ---------------------------------------------------------------------------
# 4. prune
# ---------------------------------------------------------------------------
dated_commit() { # <repo> <iso-date> <msg>
  echo "$3" >>"$1/f"
  git -C "$1" add -A
  GIT_AUTHOR_DATE="$2" GIT_COMMITTER_DATE="$2" git -C "$1" commit -q -m "$3"
}
branches() { git -C "$1" for-each-ref refs/heads --format='%(refname:short)' | sort | tr '\n' ' ' | sed 's/ $//'; }

t_prune() {
  local R="$T/prune-$SHNAME" out rc
  git init -q "$R"
  dated_commit "$R" 2020-01-01T00:00:00Z c1; git -C "$R" branch m1
  dated_commit "$R" 2020-02-01T00:00:00Z c2; git -C "$R" branch m2
  dated_commit "$R" 2020-03-01T00:00:00Z c3; git -C "$R" branch m3
  dated_commit "$R" 2020-04-01T00:00:00Z c4; git -C "$R" branch m4
  dated_commit "$R" 2020-05-01T00:00:00Z c5   # main tip
  git -C "$R" checkout -q -b wip m1
  dated_commit "$R" 2020-06-01T00:00:00Z unmerged-work
  git -C "$R" checkout -q main

  local before; before="$(branches "$R")"
  eq "prune fixture" "m1 m2 m3 m4 main wip" "$before"

  out="$(cd "$R" && "$SH" "$PRUNE" --keep 2 2>&1)"; rc=$?
  eq "prune dry run: rc 0" 0 "$rc"
  has "prune dry run: lists merged m1" "  m1" "$out"
  has "prune dry run: lists merged m4" "  m4" "$out"
  has "prune dry run: says it deleted nothing" "Dry run: nothing deleted" "$out"
  lacks "prune dry run: unmerged wip is not a candidate" "  wip" "${out#*Branches merged}"
  eq "prune dry run: deleted NOTHING" "$before" "$(branches "$R")"

  out="$(cd "$R" && "$SH" "$PRUNE" --apply --keep 4 2>&1)"; rc=$?
  eq "prune --apply --keep 4: rc 0" 0 "$rc"
  eq "prune --keep 4: deletes only the older merged branches; keeps 4 newest + unmerged" "m3 m4 main wip" "$(branches "$R")"

  git -C "$R" branch mw m3
  git -C "$R" worktree add -q "$T/prune-wt-$SHNAME" mw
  out="$(cd "$R" && "$SH" "$PRUNE" --apply --keep 0 2>&1)"; rc=$?
  eq "prune --apply --keep 0: rc 0" 0 "$rc"
  eq "prune --keep 0: deletes merged m3 m4; keeps main (base/current), wip (unmerged), mw (worktree)" "main mw wip" "$(branches "$R")"

  out="$(cd "$R" && "$SH" "$PRUNE" --keep abc 2>&1)"; rc=$?
  eq "prune: non-numeric --keep is rejected" 1 "$rc"
  out="$(cd "$R" && "$SH" "$PRUNE" --base nope/nope 2>&1)"; rc=$?
  eq "prune: unresolvable --base is rejected" 1 "$rc"
  git -C "$R" worktree remove --force "$T/prune-wt-$SHNAME"
}

# ---------------------------------------------------------------------------
# 5. worktree bootstrap
# ---------------------------------------------------------------------------
t_bootstrap() {
  local M="$T/bs-$SHNAME" W="$T/bs-wt-$SHNAME" L="$T/bs-log-$SHNAME" out rc
  mkdir -p "$L"
  cat >"$T/bootstrap.cfg" <<EOF
INSTALL_CMD="echo installed >> $L/install.log && touch installed.marker"
INSTALL_SENTINEL="installed.marker"
ENV_GLOBS=(".env" "pkg/*/.env.local" ".env.staging" ".env.absent")
CODEGEN_STEPS=(
  "gen|generated.out|echo gen >> $L/gen.log; touch generated.out"
  "always||echo always | cat >> $L/always.log"
)
HUSKY_SHIM_DIR=".husky/_"
EOF
  git init -q "$M"
  mkdir -p "$M/scripts"
  render_with_config "$BOOTSTRAP_TMPL" "$T/bootstrap.cfg" "$M/scripts/worktree-bootstrap.sh"
  printf '.env\n.env.*\n.husky/_\ninstalled.marker\ngenerated.out\npkg/*/.env.local\n' >"$M/.gitignore"
  echo "# p" >"$M/README.md"
  commit "$M" init
  # Gitignored local state that exists only in the main checkout.
  echo "SECRET=main" >"$M/.env"
  echo "STAGING=main" >"$M/.env.staging"
  mkdir -p "$M/pkg/a" "$M/.husky/_"
  echo "LOCAL=a" >"$M/pkg/a/.env.local"
  echo "# husky shim" >"$M/.husky/_/husky.sh"

  out="$(cd "$M" && "$SH" scripts/worktree-bootstrap.sh 2>&1)"; rc=$?
  eq "bootstrap in the main checkout: rc 0" 0 "$rc"
  has "bootstrap in the main checkout: no-op" "nothing to bootstrap" "$out"
  check "bootstrap in the main checkout: ran no install" test ! -e "$L/install.log"

  git -C "$M" worktree add -q "$W" -b feat
  echo "STAGING=keep-me" >"$W/.env.staging"      # pre-existing file must not be overwritten

  out="$(cd "$W" && "$SH" scripts/worktree-bootstrap.sh 2>&1)"; rc=$?
  eq "bootstrap in a worktree: rc 0" 0 "$rc"
  eq "bootstrap: env file copied by literal glob" "SECRET=main" "$(cat "$W/.env" 2>/dev/null)"
  eq "bootstrap: env file copied by nested glob" "LOCAL=a" "$(cat "$W/pkg/a/.env.local" 2>/dev/null)"
  eq "bootstrap: existing env file NOT overwritten" "STAGING=keep-me" "$(cat "$W/.env.staging")"
  check "bootstrap: a glob matching nothing is fine" test ! -e "$W/.env.absent"
  check "bootstrap: husky shim is a symlink" test -L "$W/.husky/_"
  eq "bootstrap: husky shim points at the main checkout's" "$(cd "$M/.husky/_" && pwd -P)" "$(cd "$W/.husky/_" && pwd -P)"
  check "bootstrap: the shim resolves (husky.sh reachable through the link)" test -f "$W/.husky/_/husky.sh"
  eq "bootstrap: install ran once" "installed" "$(cat "$L/install.log" 2>/dev/null)"
  eq "bootstrap: codegen step ran once" "gen" "$(cat "$L/gen.log" 2>/dev/null)"

  out="$(cd "$W" && "$SH" scripts/worktree-bootstrap.sh 2>&1)"; rc=$?
  eq "bootstrap re-run: rc 0 (idempotent)" 0 "$rc"
  eq "bootstrap re-run: install NOT repeated (sentinel)" 1 "$(wc -l <"$L/install.log" | tr -d ' ')"
  eq "bootstrap re-run: sentinel'd codegen NOT repeated" 1 "$(wc -l <"$L/gen.log" | tr -d ' ')"
  eq "bootstrap re-run: sentinel-less codegen runs every time" 2 "$(wc -l <"$L/always.log" | tr -d ' ')"
  check "bootstrap re-run: shim still a symlink" test -L "$W/.husky/_"
  has "bootstrap re-run: says the shim is already present" "already present" "$out"

  # Missing shim in the main checkout: warn, do not fail.
  local W2="$T/bs-wt2-$SHNAME"
  rm -rf "$M/.husky/_"
  git -C "$M" worktree add -q "$W2" -b feat2
  out="$(cd "$W2" && "$SH" scripts/worktree-bootstrap.sh 2>&1)"; rc=$?
  eq "bootstrap: missing main shim is a warning, not a failure" 0 "$rc"
  has "bootstrap: missing main shim warns" "WARNING" "$out"
  git -C "$M" worktree remove --force "$W2"
  git -C "$M" worktree remove --force "$W"
}

for SH in ${SHELLS[@]+"${SHELLS[@]}"}; do
  SHNAME="$(printf '%s' "$SH" | tr -c 'A-Za-z0-9' '_')"
  echo "2. precheck gate matrix [$SH, bash $("$SH" -c 'echo ${BASH_VERSION%%[(-]*}')]"
  t_precheck
  echo "4. prune [$SH]"
  t_prune
  echo "5. worktree bootstrap [$SH]"
  t_bootstrap
done
echo "3. husky hooks"
t_hooks

# ---------------------------------------------------------------------------
# 6. workflow YAML + configs
# ---------------------------------------------------------------------------
echo "6. workflow YAML and configs"
WF_DIR="$GATES_DIR/github/workflows"
WF_FILES=("$WF_DIR/auto-draft-pr.yml" "$WF_DIR/secret-scan.yml" "$WF_DIR/required-check-skip.yml.example")
for f in "${WF_FILES[@]}"; do check "exists: $(basename "$f")" test -f "$f"; done

yaml_parse() { # <file> -> rc 0 parses to a mapping with `jobs`
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 -c 'import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); sys.exit(0 if isinstance(d, dict) and "jobs" in d else 1)' "$1"
  elif command -v ruby >/dev/null 2>&1; then
    ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0]), aliases: true); exit((d.is_a?(Hash) && d.key?("jobs")) ? 0 : 1)' "$1"
  else
    return 99
  fi
}
yaml_parse "$WF_DIR/secret-scan.yml"; yrc=$?
if [ "$yrc" = 99 ]; then
  echo "  skip YAML parse: neither python3 yaml nor ruby available"
else
  for f in "${WF_FILES[@]}"; do check "YAML parses: $(basename "$f")" yaml_parse "$f"; done
fi

if command -v actionlint >/dev/null 2>&1; then
  if out="$(actionlint "${WF_FILES[@]}" 2>&1)"; then ok "actionlint clean"; else bad "actionlint" "$out"; fi
else
  echo "  skip actionlint not installed"
fi

ad="$(cat "$WF_DIR/auto-draft-pr.yml")"
has "auto-draft: uses the convertPullRequestToDraft mutation" "convertPullRequestToDraft" "$ad"
has "auto-draft: FORBIDDEN-specific branch" "FORBIDDEN" "$ad"
has "auto-draft: names the repo setting in the comment" "Allow GitHub Actions to create and approve pull requests" "$ad"
has "auto-draft: multi-line error goes through a heredoc output" "convert_error<<" "$ad"
has "auto-draft: comment step is not always()" '!cancelled()' "$ad"
lacks "auto-draft: no inline \${{ github.* }} in run bodies (PR number via env)" 'gh pr comment ${{' "$ad"
ss="$(cat "$WF_DIR/secret-scan.yml")"
has "secret-scan: gitleaks CLI image, not the licensed Action" "ghcr.io/gitleaks/gitleaks" "$ss"
lacks "secret-scan: does not USE the licensed Action" "uses: gitleaks/" "$ss"
has "secret-scan: range scoped with --log-opts" "--log-opts" "$ss"
has "secret-scan: SARIF report" "sarif" "$ss"
has "secret-scan: artifact upload" "upload-artifact" "$ss"
rs="$(cat "$WF_DIR/required-check-skip.yml.example")"
has "required-check-skip: paths-ignore mirrors the main CI" "paths-ignore" "$rs"
has "required-check-skip: documents the !cancelled() aggregator" 'if: ${{ !cancelled() }}' "$rs"

if command -v node >/dev/null 2>&1; then
  check "lint-staged.example.json is valid JSON" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$GATES_DIR/lint-staged.example.json"
  check "markdownlint-cli2.jsonc parses (comments stripped) and is an allowlist" node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8")
      .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
    const j = JSON.parse(s);
    if (j.config.default !== false) process.exit(1);
    if (!j.config.MD031 || !j.config.MD051 || !Array.isArray(j.ignores)) process.exit(1);' "$GATES_DIR/markdownlint-cli2.jsonc"
else
  echo "  skip JSON/JSONC parse: node not available"
fi

# ---------------------------------------------------------------------------
# 7. public-neutrality scan
# ---------------------------------------------------------------------------
echo "7. public-neutrality scan"
# Patterns are assembled from fragments so this file does not contain them itself.
pat="fee""dfrwd|key""stone|ff-eng""sys|ff""-fleet|#[0-9]{3,}|orb""start|@feed"
scan_targets=("$GATES_DIR" "$PRUNE" "$CORE/skills/github-actions/SKILL.md" "$CORE/skills/pre-push/SKILL.md")
hits="$(grep -rniE "$pat" "${scan_targets[@]}" 2>/dev/null | grep -v '/test/repo-gates.test.sh:' || true)"
if [ -z "$hits" ]; then ok "no product-specific names or issue numbers"; else bad "neutrality" "$hits"; fi

echo
echo "repo-gates tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
