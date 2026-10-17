#!/usr/bin/env bash
# xray.sh — Live operational X-Ray & diagnostic self-test (`fleet xray` / `fleet doctor`).
#
# Inspects all 10 subsystems of engsys v2.0.0, executes the live synthetic 9-hook self-test
# in an isolated sandbox, and displays the live Hook Flight Recorder + Subagent Memory telemetry.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -z "${ENGSYS_DIR:-}" ] || [ ! -d "${ENGSYS_DIR:-}" ]; then
  ENGSYS_DIR="$(cd "$KIT/../.." && pwd -P)"
fi
export ENGSYS_DIR

exec node "$KIT/lib/xray.mjs" "$@"
