#!/usr/bin/env bash
# pool-run.sh — run a command while holding a pool slot.
#
#   pool-run.sh --owner OWNER [--pool FILE] [--store DIR] [--ttl MIN] [--heartbeat-secs N]
#               [--wait-ms N | --no-wait] [--cli PATH] -- COMMAND [ARGS...]
#
# Acquires a slot from the pool (blocking, with queue position + ETA on stderr), exports the
# grant env to COMMAND (the pool file's grantEnv, else POOL_SLOT_*), plus POOL_RUN_SLOT,
# POOL_RUN_TOKEN and POOL_RUN_OWNER. Heartbeats in the background so a run that outlives the TTL
# never loses its lease, and releases on EXIT — normal completion, a failing command, SIGINT or
# SIGTERM, an early `exit` — never leaking the slot.
#
# If the heartbeat confirms the lease was lost (reaped or taken over), COMMAND is terminated
# rather than left running against a slot it no longer holds, and the exit status is 75.
#
# Exit status: COMMAND's own; 75 lease lost; the pool CLI's (1 refused/timeout, 2 usage,
# 3 internal) when no slot could be acquired — COMMAND never runs then.
#
# COMMAND's stdin is not connected (it runs as a background job so the heartbeat can supervise it).
#
# Env: POOL_CLI (path to pool-cli.mjs; default: this skill's sibling core/lib/lease/pool-cli.mjs),
#      LEASE_POOL_FILE / LEASE_STORE / LEASE_OWNER_PATTERN as for the CLI.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="${POOL_CLI:-$here/../../../lib/lease/pool-cli.mjs}"
owner="" ttl="" hb_secs="" retry_secs="${POOL_RUN_RETRY_SECS:-5}"
common=() acquire_extra=()

usage() {
  echo "usage: pool-run.sh --owner OWNER [--pool FILE] [--store DIR] [--ttl MIN] [--heartbeat-secs N] [--wait-ms N | --no-wait] [--cli PATH] -- COMMAND [ARGS...]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) [[ $# -ge 2 ]] || usage; owner="$2"; shift 2 ;;
    --pool) [[ $# -ge 2 ]] || usage; common+=(--pool "$2"); shift 2 ;;
    --store) [[ $# -ge 2 ]] || usage; common+=(--store "$2"); shift 2 ;;
    --ttl) [[ $# -ge 2 ]] || usage; ttl="$2"; shift 2 ;;
    --heartbeat-secs) [[ $# -ge 2 ]] || usage; hb_secs="$2"; shift 2 ;;
    --wait-ms) [[ $# -ge 2 ]] || usage; acquire_extra+=(--wait-ms "$2"); shift 2 ;;
    --no-wait) acquire_extra+=(--no-wait); shift ;;
    --cli) [[ $# -ge 2 ]] || usage; cli="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "pool-run: unknown argument '$1'" >&2; usage ;;
  esac
done
[[ -n "$owner" && $# -gt 0 ]] || usage
[[ -f "$cli" ]] || { echo "pool-run: pool CLI not found at $cli (set POOL_CLI or --cli)" >&2; exit 2; }
[[ -z "$ttl" ]] || common+=(--ttl "$ttl")

pool() { node "$cli" "$@"; }

slot="" token="" acquired=0 cmd_pid="" hb_pid="" lost_marker=""
lost_marker="$(mktemp -u "${TMPDIR:-/tmp}/pool-run-lost.XXXXXX")"

# Release MUST be unconditional: a leaked slot starves every other waiter. Wired as an EXIT trap
# before the acquire even runs, so it fires on every path out. Idempotent; a failed release stays
# armed and is retried, and the pool's dead-man's switch reaps the slot after the TTL regardless.
# shellcheck disable=SC2329 # invoked via the EXIT trap
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "$hb_pid" ]]; then
    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true
  fi
  if [[ -n "$cmd_pid" ]] && kill -0 "$cmd_pid" 2>/dev/null; then
    kill -TERM "$cmd_pid" 2>/dev/null || true
    wait "$cmd_pid" 2>/dev/null || true
  fi
  if [[ "$acquired" == "1" ]]; then
    local attempt released=0
    for attempt in 1 2 3; do
      if pool release --slot "$slot" --owner "$owner" --token "$token" ${common[@]+"${common[@]}"} >/dev/null 2>&1; then
        released=1
        break
      fi
      sleep "$attempt"
    done
    if [[ "$released" == "1" ]]; then
      echo "pool-run: slot ${slot} released." >&2
    else
      echo "pool-run: WARN release of slot ${slot} did not confirm; the pool reaps it after the TTL." >&2
    fi
  fi
  rm -f "$lost_marker"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Acquire (blocking unless --no-wait/--wait-ms). Only stdout is captured; queue position and ETA
# print to stderr while waiting, so a saturated pool does not look hung.
grant_json="" acquire_rc=0
grant_json="$(pool acquire --owner "$owner" ${common[@]+"${common[@]}"} ${acquire_extra[@]+"${acquire_extra[@]}"})" || acquire_rc=$?
if [[ "$acquire_rc" != "0" ]]; then
  echo "pool-run: could not acquire a slot (pool CLI exit ${acquire_rc}): ${grant_json:-see output above}" >&2
  exit "$acquire_rc"
fi

# Parse the grant with node (no jq dependency): slot id, fencing token, and the env to export.
# shellcheck disable=SC2016 # the JS is deliberately single-quoted
parsed="$(node -e '
  const g = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const q = (v) => "\x27" + String(v).replaceAll("\x27", "\x27\\\x27\x27") + "\x27";
  const lines = [`slot=${q(g.slot_id)}`, `token=${q(g.token)}`];
  for (const [k, v] of Object.entries(g.env ?? {})) lines.push(`export ${k}=${q(v)}`);
  process.stdout.write(lines.join("\n") + "\n");
' <<<"$grant_json")"
eval "$parsed"
acquired=1
export POOL_RUN_SLOT="$slot" POOL_RUN_TOKEN="$token" POOL_RUN_OWNER="$owner"
echo "pool-run: granted slot ${slot}." >&2

# Heartbeat interval: an eighth of the TTL unless given (a lease must beat well inside its TTL).
if [[ -z "$hb_secs" ]]; then
  hb_secs="$(awk -v t="${ttl:-30}" 'BEGIN { h = t * 60 / 8; if (h < 1) h = 1; printf "%d", h }')"
fi

"$@" &
cmd_pid=$!

# Background heartbeat. One failed beat retries once (a transient blip) before the lease counts as
# CONFIRMED lost; then it drops the marker and terminates the command, never silently. Its naps are
# interruptible (`sleep & wait`) so stopping the heartbeat never orphans a sleeping child that would
# hold the caller's stdout open (a `$(pool-run.sh ...)` would otherwise hang until it woke).
(
  nap_pid=""
  trap 'if [[ -n "$nap_pid" ]]; then kill "$nap_pid" 2>/dev/null || true; fi; exit 0' TERM
  nap() {
    sleep "$1" &
    nap_pid=$!
    wait "$nap_pid" || true
    nap_pid=""
  }
  while :; do
    nap "$hb_secs"
    if ! pool heartbeat --slot "$slot" --owner "$owner" --token "$token" ${common[@]+"${common[@]}"} >/dev/null 2>&1; then
      nap "$retry_secs"
      if ! pool heartbeat --slot "$slot" --owner "$owner" --token "$token" ${common[@]+"${common[@]}"} >/dev/null 2>&1; then
        : >"$lost_marker"
        kill -TERM "$cmd_pid" 2>/dev/null || true
        exit 1
      fi
    fi
  done
) >/dev/null 2>&1 &
hb_pid=$!

# Forward termination to the command; `wait` returns early on a trapped signal, so reap in a loop.
trap 'kill -TERM "$cmd_pid" 2>/dev/null || true; exit 143' TERM
trap 'kill -TERM "$cmd_pid" 2>/dev/null || true; exit 130' INT
rc=0
wait "$cmd_pid" || rc=$?
cmd_pid=""

if [[ -f "$lost_marker" ]]; then
  echo "pool-run: heartbeat confirmed slot ${slot} lost (reaped or taken over); command terminated." >&2
  exit 75
fi
exit "$rc"
