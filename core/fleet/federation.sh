#!/usr/bin/env bash
# federation.sh — thin dispatch wrapper for `fleet federation` (and the registry block of
# `fleet status`): sources fleet-env.sh so FLEET_ID and FEDERATION_FILE resolve from fleet.conf the
# way every other fleet command resolves its config, then execs the loader. See lib/federation.mjs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required for the federation registry"
exec node "$HERE/lib/federation.mjs" "$@"
