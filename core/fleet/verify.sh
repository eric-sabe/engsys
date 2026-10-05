#!/usr/bin/env bash
# verify.sh (`fleet verify`): do the engsys plugin files that guard the merge and maintain monsters
# (the fenced wrappers, the singleton-write guard hook and its registration, the baton lease code)
# match the pinned engsys release on GitHub? (engsys#70; the protected list and the comparison live in
# lib/verify-wrappers.mjs.)
#
# The release is the engsys pin (ENGSYS_MARKETPLACE's repo and ref in PIN_SETTINGS, the same source
# `fleet sync` and `fleet pin` use). The files checked are the installed engsys plugin at that version
# (`claude plugin list --json`: every install path of engsys@<marketplace> whose version is the pin's).
#
#   --alert          on a mismatch, post one `fleet notify --level alert --incident wrapper-integrity`
#                    per incident (latch: .fleet/verify-wrappers.alerted); resolve it on the next pass
#   --max-age <min>  reuse a pass from the last <min> minutes while the local files are unchanged (the
#                    supervisor's throttle; cache: .fleet/verify-wrappers.json). `fleet launch` never
#                    passes it, so a launch always asks GitHub.
#
# Exit: 0 match | 1 MISMATCH (merge/maintain sessions must not start) | 3 not verified (GitHub
# unreachable, no pin, plugin not installed at the pin: warn and go on) | 2 usage
#
# Usage: verify.sh [--instance <dir>] [--alert] [--max-age <minutes>]
set -euo pipefail
if [ "${1:-}" = --instance ]; then FLEET_INSTANCE="${2:?--instance needs a directory}"; export FLEET_INSTANCE; shift 2; fi
alert=0 max_age=""
while [ $# -gt 0 ]; do
  case "$1" in
    --alert) alert=1 ;;
    --max-age) max_age="${2:?--max-age needs minutes}"; shift ;;
    -h | --help) sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) echo "fleet verify: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$max_age" ] || [[ "$max_age" =~ ^[0-9]+$ ]] || { echo "fleet verify: --max-age takes whole minutes" >&2; exit 2; }
# Exit 1 means a definite mismatch and nothing else: a config error while loading the fleet env
# (fleet_die exits 1) or any other early exit 1 becomes 3, "not verified".
result=""
trap 'rc=$?; trap - EXIT; if [ "$rc" = 1 ] && [ "$result" != mismatch ]; then exit 3; fi; exit "$rc"' EXIT
# shellcheck source=lib/fleet-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fleet-env.sh"

LATCH="$FLEET_STATE/verify-wrappers.alerted"
INCIDENT=wrapper-integrity
host="$(hostname -s 2>/dev/null || echo this host)"
unverified() { echo "fleet verify: not verified: $*"; exit 3; }

repo="$(fleet_pin_repo "$ENGSYS_MARKETPLACE")"
ref="$ENGSYS_REF"
[ -n "$repo" ] && [ -n "$ref" ] || unverified "no '$ENGSYS_MARKETPLACE' marketplace with a repo and ref in $PIN_SETTINGS"
command -v node >/dev/null || unverified "node not found"
command -v claude >/dev/null || unverified "claude not found, so the installed plugin can't be located"
list="$(claude plugin list --json 2>/dev/null)" || unverified "claude plugin list failed"
roots=()
while IFS= read -r r; do [ -n "$r" ] && roots+=("$r"); done < <(jq -r --arg id "engsys@$ENGSYS_MARKETPLACE" --arg v "${ref#v}" \
  '[.[]? | select(.id == $id and .version == $v and ((.installPath // "") != "")) | .installPath] | unique | .[]' <<<"$list" 2>/dev/null || true)
[ "${#roots[@]}" -gt 0 ] || unverified "engsys@$ENGSYS_MARKETPLACE ${ref} is not installed on this host (run: fleet sync)"

args=(--repo "$repo" --ref "$ref")
for r in "${roots[@]}"; do args+=(--root "$r"); done
[ -z "$max_age" ] || args+=(--cache "$FLEET_STATE/verify-wrappers.json" --max-age-min "$max_age")
mkdir -p "$FLEET_STATE" && chmod 700 "$FLEET_STATE"
rc=0
out="$(node "$FLEET_KIT_DIR/lib/verify-wrappers.mjs" "${args[@]}" 2>&1)" || rc=$?
printf '%s\n' "$out"
# node exits 1 on its own crash (a missing module, a syntax error): only the verifier's MISMATCH line counts.
if [ "$rc" = 1 ] && ! grep -q '^verify: MISMATCH' <<<"$out"; then
  echo "fleet verify: not verified: the verifier failed (exit 1, above)"
  rc=3
fi

notify() { node "$FLEET_KIT_DIR/notify.mjs" "$@" >&2; } # a failed post leaves the latch as it was: retried next run
case "$rc" in
  0)
    if [ "$alert" = 1 ] && [ -f "$LATCH" ]; then
      notify --level info --incident "$INCIDENT" --resolve "Resolved: the engsys plugin files on $host match $repo@$ref again (mismatch since $(head -1 "$LATCH"))." \
        && rm -f "$LATCH"
    fi ;;
  1)
    if [ "$alert" = 1 ] && [ ! -f "$LATCH" ]; then
      files="$(printf '%s\n' "$out" | sed -n 's/^  [a-z-]* *//p' | head -n 5)"
      notify --level alert --incident "$INCIDENT" "Plugin check on $host: some engsys plugin files that guard the merge and maintain monsters differ from $repo@$ref, so they may have been changed on this host. Merge and maintain sessions will not be launched or relaunched here until the files match. Running sessions were left as they are: please check them and stop any you don't trust, then reinstall the plugin (claude plugin uninstall engsys@$ENGSYS_MARKETPLACE, delete ${roots[*]}, then fleet sync). Files:
$files
Details: fleet verify" && date -u +%Y-%m-%dT%H:%M:%SZ >"$LATCH"
    fi
    result=mismatch ;;
  3) ;;
  *) rc=3 ;;
esac
exit "$rc"
