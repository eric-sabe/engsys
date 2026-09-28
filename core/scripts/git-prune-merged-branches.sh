#!/usr/bin/env bash
# git-prune-merged-branches.sh — delete local branches already merged into the
# default branch, keeping a buffer of recently touched ones.
#
# Agent sessions and worktrees leave a long tail of local branches. This clears
# the ones whose work has landed, without touching anything unmerged.
#
# DRY RUN BY DEFAULT: it prints what it would delete and deletes nothing until
# you pass --apply.
#
# Usage:
#   git-prune-merged-branches.sh [--apply] [--keep N] [--base REF] [--fetch]
#
# Options:
#   --apply       actually delete (default is a dry run). --execute is an alias.
#   --keep N      protect the N local branches whose tips have the most recent
#                 committer date (default 10; --buffer is an alias). Git stores no
#                 branch-creation time, so tip date is the proxy for "recently
#                 touched work stays safe".
#   --base REF    the ref "merged" is measured against. Default: origin/HEAD's
#                 target if set, else origin/main, else main, else master.
#   --fetch       run `git fetch --prune` first, so the base is current.
#
# Safety:
#   - Uses `git branch -d` (safe delete): a branch not fully merged is refused
#     by git even if it slips through.
#   - Never touches the base branch, the current branch, main/master/develop,
#     or any branch checked out in another worktree.
#   - "Merged" is git's own notion (`git branch --merged`): the branch tip is
#     reachable from the base. A branch landed by SQUASH or REBASE merge is not
#     reachable, so it is not listed. Delete those by hand once the PR is
#     merged (`git branch -D`), or after `git fetch --prune` if your remote
#     deletes head branches on merge.

set -euo pipefail

KEEP=10
BASE_REF=""
DO_FETCH=false
APPLY=false

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--base) BASE_REF="${2:?--base needs a ref}"; shift 2 ;;
    --keep|--buffer) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --fetch) DO_FETCH=true; shift ;;
    --apply|--execute) APPLY=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 >&2 ;;
  esac
done

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a Git repository." >&2
  exit 1
fi

if ! [[ "$KEEP" =~ ^[0-9]+$ ]]; then
  echo "--keep must be a non-negative integer (got: $KEEP)" >&2
  exit 1
fi

if [[ "$DO_FETCH" == true ]]; then
  echo "Running: git fetch --prune"
  git fetch --prune
fi

resolve_base() {
  if [[ -n "$BASE_REF" ]]; then
    echo "$BASE_REF"
    return
  fi
  local head_ref
  head_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$head_ref" ]] && git rev-parse --verify --quiet "$head_ref" >/dev/null; then
    echo "$head_ref"
    return
  fi
  local cand
  for cand in origin/main main master; do
    if git rev-parse --verify --quiet "$cand" >/dev/null; then
      echo "$cand"
      return
    fi
  done
  echo "Could not resolve a base ref (tried origin/HEAD, origin/main, main, master). Pass --base <ref>." >&2
  exit 1
}

BASE="$(resolve_base)"
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "Base ref does not exist locally: $BASE (try: git fetch origin)" >&2
  exit 1
fi
BASE_SHORT="${BASE#origin/}"

CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ "$CURRENT" == "HEAD" ]]; then
  echo "Detached HEAD; check out a branch before pruning." >&2
  exit 1
fi

# The KEEP most recently touched local branches (by tip committer date).
PROTECTED_NAMES="$(
  git for-each-ref refs/heads/ --format='%(refname:short)' --sort=-committerdate |
    awk -v keep="$KEEP" 'NR <= keep'   # not `head -n 0`: BSD head rejects a zero count
)"

# Branches checked out in any worktree (git refuses to delete these anyway;
# skipping them up front keeps the run clean).
WORKTREE_BRANCHES="$(
  git worktree list --porcelain |
    sed -n 's|^branch refs/heads/||p'
)"

is_in_list() { # <needle> <newline-separated list>
  [[ -n "$2" ]] && printf '%s\n' "$2" | grep -Fxq -- "$1"
}

CANDIDATES=()
while IFS= read -r b; do
  [[ -n "$b" ]] || continue
  [[ "$b" == "$BASE_SHORT" || "$b" == "$CURRENT" ]] && continue
  case "$b" in main|master|develop) continue ;; esac
  is_in_list "$b" "$PROTECTED_NAMES" && continue
  is_in_list "$b" "$WORKTREE_BRANCHES" && continue
  CANDIDATES+=("$b")
done < <(git branch --merged "$BASE" --format='%(refname:short)')

echo "Base: $BASE"
echo "Current branch: $CURRENT"
echo "Keeping the $KEEP most recently touched local branch(es):"
if [[ -n "$PROTECTED_NAMES" ]]; then
  printf '%s\n' "$PROTECTED_NAMES" | sed 's/^/  /'
else
  echo "  (none)"
fi
echo ""

if ((${#CANDIDATES[@]} == 0)); then
  echo "No merged branches to prune (after keep / reserved / worktree rules)."
  exit 0
fi

echo "Branches merged into $BASE and eligible for deletion:"
printf '  %s\n' "${CANDIDATES[@]}"

if [[ "$APPLY" != true ]]; then
  echo ""
  echo "Dry run: nothing deleted. Re-run with --apply to delete these branches."
  exit 0
fi

echo ""
echo "Deleting..."
failed=0
for b in "${CANDIDATES[@]}"; do
  git branch -d "$b" || failed=$((failed + 1))
done
if ((failed > 0)); then
  echo "Done, but $failed branch(es) could not be deleted (see above)." >&2
  exit 1
fi
echo "Done."
