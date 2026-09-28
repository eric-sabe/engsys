#!/usr/bin/env bash
# pool-run.test.sh — sandbox tests for pool-run.sh (acquire, heartbeat, release-on-EXIT).
#
# Run: bash core/skills/durable-lease/scripts/pool-run.test.sh   (zero deps beyond bash + node)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/pool-run.sh"
CLI="$HERE/../../../lib/lease/pool-cli.mjs"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1" >&2; }
check() { # check <name> <condition-exit-status>
  if [[ "$2" == "0" ]]; then ok "$1"; else bad "$1"; fi
}

cat > "$T/pool.json" <<'JSON'
{
  "name": "test-pool",
  "kindPrefix": "test-slot-",
  "grantEnv": { "APP_PORT": "{port}", "APP_DB": "{db}" },
  "slots": [
    { "id": 1, "port": 4000, "db": "acme_test_1" },
    { "id": 2, "port": 4001, "db": "acme_test_2" }
  ]
}
JSON

export LEASE_POOL_FILE="$T/pool.json"
export POOL_POLL_MS=100
export POOL_PROVISION_CMD=true
export POOL_RUN_RETRY_SECS=1
STORE="$T/store"

slot_states() { node "$CLI" status --store "$STORE" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(s.slots.map((x)=>x.state).join(","))'; }

echo "pool-run.sh"

# 1. Runs the command with the grant env, holds the slot meanwhile, releases after, propagates the exit code.
rc=0
"$RUN" --owner ci-main --store "$STORE" -- bash -c '
  echo "port=$APP_PORT db=$APP_DB slot=$POOL_RUN_SLOT owner=$POOL_RUN_OWNER" > "$1"
  node "$2" status --store "$3" > "$4"
  exit 3
' _ "$T/env.txt" "$CLI" "$STORE" "$T/during.json" 2>"$T/err1.txt" || rc=$?
check "exit code of the command is propagated" "$([[ "$rc" == "3" ]] && echo 0 || echo 1)"
check "grant env is exported to the command" "$(grep -q '^port=4000 db=acme_test_1 slot=1 owner=ci-main$' "$T/env.txt" && echo 0 || echo 1)"
check "the slot is held while the command runs" "$(grep -q '"state":"held"' "$T/during.json" && echo 0 || echo 1)"
check "the slot is released after the command (even though it failed)" "$([[ "$(slot_states)" == "free,free" ]] && echo 0 || echo 1)"
check "release is announced" "$(grep -q 'released' "$T/err1.txt" && echo 0 || echo 1)"

# 2. SIGTERM: the command is terminated and the slot released via the EXIT trap.
"$RUN" --owner ci-main --store "$STORE" -- sleep 28.41 2>"$T/err2.txt" &
runner=$!
for _ in $(seq 1 100); do
  [[ "$(slot_states)" == "held,free" ]] && break
  sleep 0.1
done
check "slot held while a long command runs" "$([[ "$(slot_states)" == "held,free" ]] && echo 0 || echo 1)"
kill -TERM "$runner"
rc=0
wait "$runner" || rc=$?
check "SIGTERM exits 143" "$([[ "$rc" == "143" ]] && echo 0 || echo 1)"
check "slot released after SIGTERM" "$([[ "$(slot_states)" == "free,free" ]] && echo 0 || echo 1)"
check "SIGTERM terminated the command" "$(pgrep -f 'sleep 28.41' >/dev/null 2>&1 && echo 1 || echo 0)"

# 3. A run that outlives the TTL keeps its lease via the background heartbeat.
rc=0
"$RUN" --owner ci-main --store "$STORE" --ttl 0.05 --heartbeat-secs 1 -- sleep 5 2>"$T/err3.txt" || rc=$?
check "heartbeat keeps a run alive past the TTL (ttl 3s, run 5s)" "$([[ "$rc" == "0" ]] && echo 0 || echo 1)"

# 4. A lost lease terminates the command and exits 75. (Heartbeat slower than the TTL: the lease
#    expires, the first beat is refused as expired, the retry too.)
rc=0
"$RUN" --owner ci-main --store "$STORE" --ttl 0.05 --heartbeat-secs 4 -- sleep 29.37 2>"$T/err4.txt" || rc=$?
check "confirmed lease loss exits 75" "$([[ "$rc" == "75" ]] && echo 0 || echo 1)"
check "lease loss is reported" "$(grep -q 'confirmed slot 1 lost' "$T/err4.txt" && echo 0 || echo 1)"
check "the command was terminated, not left running" "$(pgrep -f 'sleep 29.37' >/dev/null 2>&1 && echo 1 || echo 0)"

# 5. Saturated pool with --no-wait: exit 1, the command never runs.
node "$CLI" acquire --owner holder-a --no-wait --store "$STORE" >/dev/null
node "$CLI" acquire --owner holder-b --no-wait --store "$STORE" >/dev/null
rc=0
"$RUN" --owner ci-main --store "$STORE" --no-wait -- bash -c 'echo ran > "$1"' _ "$T/never.txt" 2>"$T/err5.txt" || rc=$?
check "saturated + --no-wait exits 1" "$([[ "$rc" == "1" ]] && echo 0 || echo 1)"
check "the command never ran" "$([[ ! -e "$T/never.txt" ]] && echo 0 || echo 1)"

# 6. Usage errors.
rc=0
"$RUN" --store "$STORE" -- true 2>/dev/null || rc=$?
check "missing --owner is a usage error (2)" "$([[ "$rc" == "2" ]] && echo 0 || echo 1)"
rc=0
"$RUN" --owner ci-main --store "$STORE" 2>/dev/null || rc=$?
check "missing command is a usage error (2)" "$([[ "$rc" == "2" ]] && echo 0 || echo 1)"

echo "pool-run: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]]
