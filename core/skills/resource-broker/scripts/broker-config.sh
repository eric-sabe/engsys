#!/usr/bin/env bash
# broker-config.sh — find and read resource-broker.yml for the broker scripts.
#
# Source it (`. "$here/broker-config.sh"`) for the helpers below, or run it to see what a config
# resolves to:
#
#   broker-config.sh [--config FILE | --config-dir DIR] [KEY...]
#
# Discovery follows the other monsters: an explicit --config FILE; else `.claude/resource-broker.yml`
# in the current repo (in-repo wins); else `resource-broker.yml` in the fleet config dir (--config-dir,
# the `fleet config dir: /abs/path` line of the session context). None found: no config, and the
# scripts then need every value as a flag.
#
# The reader is deliberately small: top-level `key: value` lines and one level of nesting
# (`lease:` then `  pool_file: x`, addressed as `lease.pool_file`). Values may be single- or
# double-quoted; an unquoted value ends at ` #`. Lists, anchors and multi-line scalars are not read
# here: the model reads those parts of the file itself.
#
# Helpers (all set no shell options; safe under `set -eu`):
#   broker_find_config <explicit-file> <config-dir>   sets BROKER_CONFIG_FILE ('' if none)
#   broker_cfg <key|parent.key>                       prints the value ('' if absent)
#   broker_fill_var <VAR> <key>                       VAR from the config when VAR is empty
#   broker_fill_path <VAR> <key>                      likewise; a relative path resolves against the config's directory
#   broker_setup_pool                                 resolves POOL_CLI / LEASE_CLI and defines broker_pool / broker_lease

BROKER_CONFIG_FILE=""

broker_find_config() {
  local explicit="${1:-}" dir="${2:-}"
  BROKER_CONFIG_FILE=""
  if [ -n "$explicit" ]; then
    [ -f "$explicit" ] || { echo "resource-broker: config not found: $explicit" >&2; return 1; }
    BROKER_CONFIG_FILE="$explicit"
  elif [ -f ".claude/resource-broker.yml" ]; then
    BROKER_CONFIG_FILE=".claude/resource-broker.yml"
  elif [ -n "$dir" ] && [ -f "$dir/resource-broker.yml" ]; then
    BROKER_CONFIG_FILE="$dir/resource-broker.yml"
  elif [ -n "$dir" ]; then
    echo "resource-broker: no resource-broker.yml in the fleet config dir $dir" >&2
    return 1
  fi
  return 0
}

broker_cfg() {
  [ -n "$BROKER_CONFIG_FILE" ] || return 0
  # shellcheck disable=SC2016 # awk program, deliberately single-quoted
  awk -v want="$1" '
    function unq(v,   q, i) {
      sub(/^[ \t]+/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == "\047") {
        v = substr(v, 2)
        i = index(v, q)
        return (i > 0) ? substr(v, 1, i - 1) : v
      }
      sub(/^#.*$/, "", v)
      sub(/[ \t]+#.*$/, "", v)
      sub(/[ \t]+$/, "", v)
      return v
    }
    BEGIN { n = split(want, w, ".") }
    /^[ \t]*#/ || /^[ \t]*$/ { next }
    {
      match($0, /^ */); ind = RLENGTH
      line = substr($0, ind + 1)
      c = index(line, ":")
      if (c == 0) next
      key = substr(line, 1, c - 1)
      val = substr(line, c + 1)
      if (ind == 0) {
        top = key
        if (n == 1 && key == w[1]) { print unq(val); exit }
      } else if (n == 2 && top == w[1] && key == w[2]) {
        print unq(val); exit
      }
    }' "$BROKER_CONFIG_FILE"
}

broker_fill_var() {
  if [ -z "${!1:-}" ]; then
    local v
    v="$(broker_cfg "$2")"
    printf -v "$1" '%s' "$v"
  fi
}

broker_fill_path() {
  if [ -z "${!1:-}" ]; then
    local v
    v="$(broker_cfg "$2")"
    case "$v" in
      '') ;;
      \~) v="$HOME" ;;
      \~/*) v="$HOME/${v#\~/}" ;;
      /*) ;;
      *) v="$(cd "$(dirname "$BROKER_CONFIG_FILE")" && pwd)/$v" ;;
    esac
    printf -v "$1" '%s' "$v"
  fi
}

# The pool and lease CLIs are located the way durable-lease's pool-run.sh does: relative to this
# skill, overridable via POOL_CLI (and LEASE_CLI; it defaults to pool-cli's sibling).
# Needs POOL_FILE; uses STORE and OWNER_PATTERN when set.
broker_setup_pool() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  POOL_CLI="${POOL_CLI:-$here/../../../lib/lease/pool-cli.mjs}"
  LEASE_CLI="${LEASE_CLI:-$(dirname "$POOL_CLI")/lease-cli.mjs}"
  command -v node >/dev/null || { echo "resource-broker: node not found" >&2; return 1; }
  command -v jq >/dev/null || { echo "resource-broker: jq not found" >&2; return 1; }
  [ -f "$POOL_CLI" ] || { echo "resource-broker: pool CLI not found at $POOL_CLI (set POOL_CLI)" >&2; return 1; }
  [ -n "${POOL_FILE:-}" ] || { echo "resource-broker: no pool file (lease.pool_file in resource-broker.yml, or --pool FILE)" >&2; return 1; }
  [ -f "$POOL_FILE" ] || { echo "resource-broker: pool file not found: $POOL_FILE" >&2; return 1; }
  return 0
}

# broker_pool <op> [flags…]: one pool-cli call against the configured pool, store and owner fence.
broker_pool() {
  local extra=()
  [ -z "${STORE:-}" ] || extra+=(--store "$STORE")
  [ -z "${OWNER_PATTERN:-}" ] || extra+=(--owner-pattern "$OWNER_PATTERN")
  node "$POOL_CLI" "$@" --pool "$POOL_FILE" ${extra[@]+"${extra[@]}"}
}

# broker_lease <op> [flags…]: one lease-cli call against the same store and owner fence.
broker_lease() {
  local extra=()
  [ -z "${STORE:-}" ] || extra+=(--store "$STORE")
  [ -z "${OWNER_PATTERN:-}" ] || extra+=(--owner-pattern "$OWNER_PATTERN")
  node "$LEASE_CLI" "$@" ${extra[@]+"${extra[@]}"}
}

# Run directly: print the resolved config path and the requested keys (all the script-read keys by default).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  explicit="" cdir="" keys=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) [ $# -ge 2 ] || { echo "--config needs a value" >&2; exit 2; }; explicit="$2"; shift 2 ;;
      --config-dir) [ $# -ge 2 ] || { echo "--config-dir needs a value" >&2; exit 2; }; cdir="$2"; shift 2 ;;
      -*) echo "usage: broker-config.sh [--config FILE | --config-dir DIR] [KEY...]" >&2; exit 2 ;;
      *) keys+=("$1"); shift ;;
    esac
  done
  broker_find_config "$explicit" "$cdir" || exit 1
  [ -n "$BROKER_CONFIG_FILE" ] || { echo "resource-broker: no config found (.claude/resource-broker.yml, or resource-broker.yml in --config-dir)" >&2; exit 1; }
  echo "config: $BROKER_CONFIG_FILE"
  [ ${#keys[@]} -gt 0 ] || keys=(repo session_name ledger_issue state_dir poll_interval heartbeat_minutes stale_lock_minutes lease.pool_file lease.store lease.owner lease.owner_pattern host.health_cmd host.restart_cmd host.window_minutes)
  for k in "${keys[@]}"; do printf '%s: %s\n' "$k" "$(broker_cfg "$k")"; done
fi
