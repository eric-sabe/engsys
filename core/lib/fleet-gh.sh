#!/usr/bin/env bash
# fleet-gh.sh: source me. Resolve the `gh` a kit script must use and fail loudly when it is not
# authenticated (engsys#90).
#
# Why: a fleet session's bare `gh` can resolve to an unauthenticated binary (a login shell that
# re-prepends Homebrew puts it ahead of the identity shim). Scripts that swallowed the failure
# reported "no alerts / nothing to do", which reads as healthy. So:
#   fleet_gh_resolve      sets FLEET_GH: the identity shim by absolute path when the fleet identity is
#                         configured (GH_APP_ENV_FILE set), else `gh`. A caller-supplied FLEET_GH wins.
#   assert_gh_auth NAME [event]
#                         one cheap authenticated call. On failure prints `GH_AUTH_ERROR NAME: <why>`
#                         (stderr; stdout with `event`, for Monitor-driven watch scripts) and returns 1.
# Usage in a script:  . "$here/../../../lib/fleet-gh.sh"; fleet_gh_resolve; assert_gh_auth NAME || exit 1

_FLEET_GH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

fleet_gh_resolve() {
  if [ -z "${FLEET_GH:-}" ]; then
    FLEET_GH="gh"
    if [ -n "${GH_APP_ENV_FILE:-}" ]; then
      local c
      for c in "${ENGSYS_DIR:+$ENGSYS_DIR/core/fleet/identity/bin/gh}" "$(cd "$_FLEET_GH_LIB_DIR/../fleet/identity/bin" 2>/dev/null && pwd -P)/gh"; do
        if [ -n "$c" ] && [ -x "$c" ]; then FLEET_GH="$c"; break; fi
      done
    fi
  fi
  export FLEET_GH
}

assert_gh_auth() {
  local name="${1:-script}" mode="${2:-}" err rc=0
  [ -n "${FLEET_GH:-}" ] || fleet_gh_resolve
  err="$("$FLEET_GH" api rate_limit --jq .resources.core.limit 2>&1 >/dev/null)" || rc=$?
  [ "$rc" -ne 0 ] || return 0
  err="$(printf '%s' "${err:-gh exited $rc}" | tr '\n' ' ' | cut -c1-300)"
  if [ "$mode" = event ]; then
    echo "GH_AUTH_ERROR $name: gh ($FLEET_GH) is not authenticated: $err"
  else
    echo "GH_AUTH_ERROR $name: gh ($FLEET_GH) is not authenticated: $err" >&2
  fi
  return 1
}
