#!/usr/bin/env bash
# mnt-act.sh — Maintenance Monster's mutating acts, fenced by its baton: mm-act.sh with --role maintain.
# MUTATING: deliberately not auto-approved.
#
# Usage: mnt-act.sh guard --repo owner/name --state-dir DIR -- gh <args…>
#        mnt-act.sh guard --repo owner/name --state-dir DIR -- <engsys-root>/skills/merge-monster/scripts/gate-request.sh <args…>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
op="${1:-}"
case "$op" in
  guard) shift ;;
  *) echo "usage: mnt-act.sh guard --repo owner/name --state-dir DIR -- <command…>" >&2; exit 2 ;;
esac
exec bash "$here/../../merge-monster/scripts/mm-act.sh" guard --role maintain "$@"
