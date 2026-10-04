#!/usr/bin/env bash
# notify.sh — thin dispatch wrapper for `fleet notify`: sources fleet-env.sh (so FLEET_STATE,
# SLACK_ENV and NOTIFY_FALLBACK_ISSUE resolve the same way every other fleet command resolves its
# config), then execs the implementation. See notify.mjs for the contract.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

exec node "$HERE/notify.mjs" "$@"
