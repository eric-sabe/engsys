#!/usr/bin/env bash
# mnt-baton.sh — Maintenance Monster's hold on the `maintain` role: the github lease with the caller
# rule built in. Thin wrapper over <engsys-root>/lib/lease/baton.mjs; same ops, exit codes and rules as
# <engsys-root>/skills/merge-monster/scripts/mm-baton.sh, with --role maintain. Fenced mutations go
# through mnt-act.sh.
#
# Usage: mnt-baton.sh startup|renew|fence|release|status --repo owner/name --state-dir DIR [--session NAME]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/../../../lib/lease/baton.mjs"
command -v node >/dev/null || { echo "mnt-baton: node not found" >&2; exit 3; }
[ -f "$lib" ] || { echo "mnt-baton: $lib not found (engsys core lib/ missing from this install)" >&2; exit 3; }
op="${1:-}"
case "$op" in
  startup | renew | fence | release | status) shift ;;
  *) echo "usage: mnt-baton.sh startup|renew|fence|release|status --repo owner/name --state-dir DIR [--session NAME]" >&2; exit 2 ;;
esac
exec node "$lib" "$op" "$@" --role maintain
