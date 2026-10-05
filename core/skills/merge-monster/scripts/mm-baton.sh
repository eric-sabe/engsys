#!/usr/bin/env bash
# mm-baton.sh — Merge Monster's hold on the `merge` role: the github lease with the caller rule built
# in. Thin wrapper over <engsys-root>/lib/lease/baton.mjs (rules in its header and in
# docs/multi-fleet.md § 2 "Caller rule"). Bookkeeping ops only; the fenced mutations (guard, merge)
# are mm-act.sh, which stays behind a permission prompt.
#
# Usage: mm-baton.sh startup|renew|fence|release|status --repo owner/name --state-dir DIR
#                    [--session NAME] [--if-due 150s] [--reason rotation|exit|handover]
#   startup  before anything else: home check (federation.yml), then acquire. Exit 0 = act;
#            1 = do NOT act (held elsewhere, not home, or wait_self); 3 = error (never act).
#   renew    on every heartbeat (mm-heartbeat.sh does it when given --state-dir); mm-watch.sh runs
#            the 2.5-minute keepalive. Exit 1 = LOST: stop at once.
#   fence    before a mutating act that mm-act.sh cannot wrap (dispatching a fix agent that will push).
#   release  on "rotation requested", clean exit and handover.
# The session name defaults to ENGSYS_SESSION (set by the launcher). Exit: 0 ok | 1 refused/lost |
# 2 usage | 3 error | 4 newer protocol | 5 no baton in this session.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/../../../lib/lease/baton.mjs"
command -v node >/dev/null || { echo "mm-baton: node not found" >&2; exit 3; }
[ -f "$lib" ] || { echo "mm-baton: $lib not found (engsys core lib/ missing from this install)" >&2; exit 3; }
op="${1:-}"
case "$op" in
  startup | renew | fence | release | status) shift ;;
  *) echo "usage: mm-baton.sh startup|renew|fence|release|status --repo owner/name --state-dir DIR [--session NAME]" >&2; exit 2 ;;
esac
exec node "$lib" "$op" "$@" --role merge
