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
#   broker_fleet_init                                 multi-fleet mode: sets BROKER_FLEET, BROKER_STATUS_REPO/_ISSUE
#   broker_fill_ledger <REPO_VAR> <ISSUE_VAR>         where the heartbeat and kill switch live (see below)
#   broker_fill_owner <OWNER_VAR> <PATTERN_VAR>       the lease owner and owner fence, fleet-qualified in multi-fleet mode
#
# Multi-fleet mode (docs/multi-fleet.md § 3) is on when FLEET_ID is set and the federation file exists
# (FEDERATION_FILE, which `fleet launch` writes into the session env; else <FLEET_REPO>/federation.yml).
# The same shared resource-broker.yml then serves every fleet, and the fleet-specific parts come from
# the registry at run time:
#   - the ledger is the fleet's own status issue (`fleets.<FLEET_ID>.status_issue`, in the instance
#     repo), not `repo` + `ledger_issue`, so two fleets' brokers never write the same heartbeat. If it
#     can't be resolved the scripts stop; they never fall back to the shared ledger;
#   - lease.owner and lease.owner_pattern are prefixed with the fleet id (`acme-broker` becomes
#     `bob-acme-broker`, `^acme-…` becomes `^bob-acme-…`) unless `lease.fleet_qualify: false`.
# A flag (--repo, --issue/--ledger, --owner, --owner-pattern) is always used as given. FLEET_ID unset,
# or no federation file: single-fleet mode, exactly as before.

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

# --- Multi-fleet ---------------------------------------------------------------------------------
BROKER_FLEET="" BROKER_STATUS_REPO="" BROKER_STATUS_ISSUE="" BROKER_FLEET_READY=""

broker_fleet_init() {
  [ -z "$BROKER_FLEET_READY" ] || return 0
  local fid="${FLEET_ID:-}" file="${FEDERATION_FILE:-federation.yml}" cli out
  if [ -z "$fid" ]; then BROKER_FLEET_READY=1; return 0; fi
  case "$file" in /*) ;; *) file="${FLEET_REPO:-${FLEET_INSTANCE:-$PWD}}/$file" ;; esac
  if [ ! -f "$file" ]; then BROKER_FLEET_READY=1; return 0; fi
  cli="${FEDERATION_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../fleet/lib/federation.mjs}"
  command -v node >/dev/null || { echo "resource-broker: multi-fleet mode (FLEET_ID=$fid, $file) needs node to read the registry" >&2; return 1; }
  [ -f "$cli" ] || { echo "resource-broker: registry reader not found at $cli (set FEDERATION_CLI)" >&2; return 1; }
  if ! out="$(node "$cli" status-issue --file "$file" 2>&1)"; then
    echo "resource-broker: multi-fleet mode (FLEET_ID=$fid, $file), but this fleet's status issue can't be resolved: ${out#federation: }" >&2
    echo "resource-broker: not falling back to the shared ledger_issue, where another fleet's broker may already heartbeat" >&2
    return 1
  fi
  BROKER_FLEET="$fid" BROKER_STATUS_REPO="${out%%#*}" BROKER_STATUS_ISSUE="${out##*#}" BROKER_FLEET_READY=1
}

# broker_fill_ledger <REPO_VAR> <ISSUE_VAR>: the fleet's status issue in multi-fleet mode, else `repo`
# and `ledger_issue`. A var that is already set (a flag) wins.
broker_fill_ledger() {
  broker_fleet_init || return 1
  if [ -n "$BROKER_FLEET" ]; then
    [ -n "${!1:-}" ] || printf -v "$1" '%s' "$BROKER_STATUS_REPO"
    [ -n "${!2:-}" ] || printf -v "$2" '%s' "$BROKER_STATUS_ISSUE"
  else
    broker_fill_var "$1" repo
    broker_fill_var "$2" ledger_issue
  fi
}

broker_qualify() { # broker_qualify owner|pattern <value> → the value with the fleet prefix (multi-fleet, fleet_qualify on)
  local v="$2"
  if [ -n "$BROKER_FLEET" ] && [ "$(broker_cfg lease.fleet_qualify)" != false ] && [ -n "$v" ]; then
    case "$1:$v" in
      "owner:$BROKER_FLEET-"* | "pattern:^$BROKER_FLEET-"*) ;;
      owner:*) v="$BROKER_FLEET-$v" ;;
      pattern:^*) v="^$BROKER_FLEET-${v#^}" ;;
    esac
  fi
  printf '%s\n' "$v"
}

# broker_fill_owner <OWNER_VAR> <PATTERN_VAR>: lease.owner (else session_name, else resource-broker)
# and lease.owner_pattern, fleet-qualified in multi-fleet mode. A var that is already set (a flag) is
# used as given; an empty pattern (no fence) stays empty.
broker_fill_owner() {
  broker_fleet_init || return 1
  local v
  if [ -z "${!1:-}" ]; then
    v="$(broker_cfg lease.owner)"
    [ -n "$v" ] || v="$(broker_cfg session_name)"
    printf -v "$1" '%s' "$(broker_qualify owner "${v:-resource-broker}")"
  fi
  [ -n "${!2:-}" ] || printf -v "$2" '%s' "$(broker_qualify pattern "$(broker_cfg lease.owner_pattern)")"
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
  all=0
  [ ${#keys[@]} -gt 0 ] || all=1 keys=(repo session_name ledger_issue state_dir poll_interval heartbeat_minutes stale_lock_minutes lease.pool_file lease.store lease.owner lease.owner_pattern lease.fleet_qualify host.health_cmd host.restart_cmd host.window_minutes)
  for k in "${keys[@]}"; do printf '%s: %s\n' "$k" "$(broker_cfg "$k")"; done
  [ "$all" = 1 ] || exit 0
  # What the scripts will actually use, after the multi-fleet resolution.
  broker_fleet_init || exit 1
  LREPO="" LISSUE="" LOWNER="" LPATTERN=""
  broker_fill_ledger LREPO LISSUE
  broker_fill_owner LOWNER LPATTERN
  if [ -n "$BROKER_FLEET" ]; then echo "mode: multi-fleet (fleet $BROKER_FLEET)"; else echo "mode: single-fleet"; fi
  echo "effective ledger: ${LREPO:-?}#${LISSUE:-?}"
  echo "effective owner: $LOWNER"
  echo "effective owner_pattern: $LPATTERN"
fi
