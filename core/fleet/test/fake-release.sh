#!/usr/bin/env bash
# fake-release.sh: make a fleet sandbox's engsys plugin verifiable (sourced, not run). Since engsys#86
# (review H1) `fleet launch` and the supervisor hold merge and maintain sessions unless `fleet verify`
# passes, so a sandbox that launches monsters needs a release `fleet verify` can check.
#
#   fake_release <engsys git dir> [<marketplace>]
#
# puts two front stubs first on PATH, ahead of the test's own stubs (which still get everything else):
#   gh      answers the release calls `fleet verify` makes (the tag ref, the default branch, the compare,
#           the tree), from the sandbox engsys repo at that tag. The tag's commit is reported on the
#           default branch.
#   claude  `plugin list --json` run in a directory whose .claude/settings.json pins the marketplace to a
#           tag: the test stub's list plus an enabled engsys@<marketplace> install at that version,
#           materialized under $HOME/.claude/plugins/cache/ from the tag's core/ (exactly what the
#           release holds, so it verifies). Anything else passes through.
# Requires $T (the sandbox root) and jq; `verify.test.sh` tests the verifier itself and does not use it.

fake_release() {
  local dir="$T/fake-release"
  mkdir -p "$dir"
  printf '%s\n' "$1" >"$dir/gitdir"
  printf '%s\n' "${2:-engsys}" >"$dir/marketplace"
  cat >"$dir/next.sh" <<'SH'
# next_bin <name>: the first <name> on PATH AFTER this directory. (Not "the first one that isn't me": a
# pass-through shim earlier on PATH does that, and the two would hand the call back and forth forever.)
next_bin() {
  local here d past=0
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  IFS=: read -r -a _ds <<<"$PATH"
  for d in "${_ds[@]}"; do
    [ -n "$d" ] || continue
    if [ "$(cd "$d" 2>/dev/null && pwd -P)" = "$here" ]; then past=1; continue; fi
    [ "$past" = 1 ] && [ -x "$d/$1" ] && { printf '%s\n' "$d/$1"; return 0; }
  done
  return 1
}
SH
  cat >"$dir/gh" <<'SH'
#!/usr/bin/env bash
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; . "$D/next.sh"
G="$(cat "$D/gitdir")"
if [ "${1:-}" = api ] && [ $# = 2 ]; then
  case "$2" in
    repos/*/git/ref/tags/*)
      c="$(git -C "$G" rev-parse -q --verify "refs/tags/${2##*/}^{commit}")" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
      printf '{"object":{"type":"commit","sha":"%s"}}\n' "$c"; exit 0 ;;
    repos/*/compare/*) echo '{"status":"ahead"}'; exit 0 ;;
    repos/*/git/trees/*)
      c="${2##*/}"; c="${c%%\?*}"
      git -C "$G" ls-tree -r "$c" | awk -F'\t' '{ split($1, a, " "); printf "%s\t%s\n", a[3], $2 }' \
        | jq -R -s '{truncated: false, tree: [split("\n")[] | select(length > 0) | split("\t") | {type: "blob", sha: .[0], path: .[1]}]}'
      exit 0 ;;
  esac
  if [[ "$2" =~ ^repos/[^/]+/[^/]+$ ]]; then echo '{"default_branch":"main"}'; exit 0; fi
fi
n="$(next_bin gh)" || exit 127
exec "$n" "$@"
SH
  cat >"$dir/claude" <<'SH'
#!/usr/bin/env bash
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; . "$D/next.sh"
n="$(next_bin claude)" || exit 127
[ "$*" = "plugin list --json" ] || exec "$n" "$@"
G="$(cat "$D/gitdir")" M="$(cat "$D/marketplace")"
base="$("$n" "$@" 2>/dev/null || true)"
printf '%s' "$base" | jq -e 'type == "array"' >/dev/null 2>&1 || base='[]'
ref="$(jq -r --arg m "$M" '.extraKnownMarketplaces[$m].source.ref // empty' .claude/settings.json 2>/dev/null || true)"
if [[ "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && git -C "$G" rev-parse -q --verify "refs/tags/$ref" >/dev/null; then
  root="$HOME/.claude/plugins/cache/$M/engsys/${ref#v}"
  if [ ! -d "$root" ]; then
    tmp="$(mktemp -d)"; git -C "$G" archive "$ref" core | tar -x -C "$tmp"
    mkdir -p "$(dirname "$root")"; mv "$tmp/core" "$root"; rm -rf "$tmp"
  fi
  printf '%s' "$base" | jq --arg id "engsys@$M" --arg v "${ref#v}" --arg p "$root" \
    'map(select(.id != $id)) + [{id: $id, version: $v, scope: "user", enabled: true, installPath: $p}]'
else
  printf '%s\n' "$base"
fi
SH
  chmod +x "$dir/gh" "$dir/claude"
  export PATH="$dir:$PATH"
}
