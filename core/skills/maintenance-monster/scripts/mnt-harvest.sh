#!/usr/bin/env bash
# mnt-harvest.sh — the weekly findings harvest: mnt-harvest.mjs, by literal path.
# `due` is read-only; `run` with findings_harvest.apply: true opens a draft docs PR through mnt-act.sh guard.
# MUTATING (run): deliberately not auto-approved.
#
# Usage: mnt-harvest.sh due --config FILE --state-dir DIR [--now ISO]
#        mnt-harvest.sh run --config FILE --state-dir DIR [--repo-dir DIR] [--now ISO] [--force]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "mnt-harvest: node not found" >&2; exit 3; }
exec env -u NODE_OPTIONS node "$here/mnt-harvest.mjs" "$@"
