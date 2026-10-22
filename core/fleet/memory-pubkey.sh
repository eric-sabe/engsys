#!/usr/bin/env bash
# memory-pubkey.sh — `fleet memory-pubkey`: print this host's memory signing public key (F5,
# FeedFrwd/ff-engsys-fleet#60) as the `fleet_memory_pubkeys` entry for the fleet's reviewed memory.yml, so the
# operator can paste it into the fleet PR. Prints the PUBLIC half only; the private key never leaves
# $FLEET_STATE/memory-signing.key. Needs FLEET_MEMORY_SIGNING_KEY=on and a key `fleet launch` has created.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/fleet-env.sh
. "$HERE/lib/fleet-env.sh"

command -v node >/dev/null || fleet_die "node is required"
[ "${FLEET_MEMORY_SIGNING_KEY:-off}" = on ] || fleet_die "FLEET_MEMORY_SIGNING_KEY is off: set it to on in fleet.conf, then fleet launch creates the key"
[ -e "$FLEET_MEMORY_SIGNING_KEY_FILE" ] || fleet_die "no memory signing key yet at $FLEET_MEMORY_SIGNING_KEY_FILE: fleet launch creates it"
[ -n "${FLEET_ID:-}" ] || fleet_die "FLEET_ID is not set: the key is published under this fleet's id (fleet_memory_pubkeys: {<fleet>: <key>})"
exec node "$HERE/../lib/memory/signing.mjs" pubkey --key-file "$FLEET_MEMORY_SIGNING_KEY_FILE" --fleet "$FLEET_ID"
