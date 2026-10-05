#!/usr/bin/env bash
# fleet-gh.test.sh — engsys#90: the shared gh resolver and the fail-loud auth check in every kit script
# that reads GitHub. Offline: gh is a stub on PATH. Run by `npm test`.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CORE="$(cd "$HERE/.." && pwd -P)"
# shellcheck source=../fleet/test/scrub-env.sh
. "$CORE/fleet/test/scrub-env.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (want '$2', got '$3')"; FAILS=$((FAILS + 1)); fi; }
has() { case "$3" in *"$2"*) echo "ok   $1" ;; *) echo "FAIL $1 (no '$2' in: $3)"; FAILS=$((FAILS + 1)) ;; esac; }

mkdir -p "$T/bad" "$T/good"
cat >"$T/bad/gh" <<'SH'
#!/usr/bin/env bash
echo "To get started with GitHub CLI, please run:  gh auth login" >&2
exit 4
SH
cat >"$T/good/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in "api rate_limit"*) echo 5000; exit 0 ;; *) exit 0 ;; esac
SH
chmod +x "$T/bad/gh" "$T/good/gh"
SYSBIN="$(dirname "$(command -v node)"):$(dirname "$(command -v jq)"):/usr/bin:/bin"

# --- resolver ---------------------------------------------------------------------------------
r() { env -i PATH="$SYSBIN" HOME="$T" "$@" bash -c '. "$0"; fleet_gh_resolve; printf %s "$FLEET_GH"' "$CORE/lib/fleet-gh.sh"; }
check "no identity: bare gh" gh "$(r)"
check "identity configured: the shim by absolute path" "$CORE/fleet/identity/bin/gh" "$(r GH_APP_ENV_FILE=/x)"
check "ENGSYS_DIR preferred when set" "$T/eng/core/fleet/identity/bin/gh" \
  "$(mkdir -p "$T/eng/core/fleet/identity/bin" && cp "$CORE/fleet/identity/bin/gh" "$T/eng/core/fleet/identity/bin/gh" && r GH_APP_ENV_FILE=/x ENGSYS_DIR="$T/eng")"
check "caller FLEET_GH wins" /opt/gh "$(r FLEET_GH=/opt/gh GH_APP_ENV_FILE=/x)"

# --- assert_gh_auth ---------------------------------------------------------------------------
a() { env -i PATH="$1:$SYSBIN" HOME="$T" bash -c '. "$0"; fleet_gh_resolve; assert_gh_auth probe '"${2:-}" "$CORE/lib/fleet-gh.sh"; }
out="$(a "$T/good" 2>&1)"; check "authenticated gh passes silently" "" "$out"
out="$(a "$T/bad" 2>&1 >/dev/null)"; rc=$?
has "unauthenticated: GH_AUTH_ERROR on stderr" "GH_AUTH_ERROR probe:" "$out"
out="$(a "$T/bad" event 2>/dev/null)"; has "event mode: GH_AUTH_ERROR on stdout" "GH_AUTH_ERROR probe:" "$out"

# --- every script: unauthenticated gh -> event line + non-zero ----------------------------------
S="$CORE/skills"
mkdir -p "$T/state"
cat >"$T/broker.yml" <<YML
repo: o/r
ledger_issue: 7
YML
run() { # name, stream (1=stdout 2=stderr), cmd...
  local name="$1" stream="$2"; shift 2
  local o rc
  if [ "$stream" = 1 ]; then
    o="$(env -i PATH="$T/bad:$SYSBIN" HOME="$T" timeout_s=1 "$@" 2>/dev/null)"; rc=$?
  else
    o="$(env -i PATH="$T/bad:$SYSBIN" HOME="$T" "$@" 2>&1 >/dev/null)"; rc=$?
  fi
  has "$name emits GH_AUTH_ERROR" "GH_AUTH_ERROR $name:" "$o"
  if [ "$rc" -ne 0 ]; then echo "ok   $name exits non-zero ($rc)"; else echo "FAIL $name exited 0"; FAILS=$((FAILS + 1)); fi
}
run mm-snapshot 2 bash "$S/merge-monster/scripts/mm-snapshot.sh" --repo o/r
run mnt-snapshot 2 bash "$S/maintenance-monster/scripts/mnt-snapshot.sh" --repo o/r
run mm-watch 1 bash "$S/merge-monster/scripts/mm-watch.sh" --repo o/r --state-dir "$T/state/mm"
run mnt-watch 1 bash "$S/maintenance-monster/scripts/mnt-watch.sh" --repo o/r --state-dir "$T/state/mnt"
cat >"$T/fp.yml" <<YML
repo: o/r
default_branch: main
fp_policies: []
YML
run mnt-fp-candidates 2 bash "$S/maintenance-monster/scripts/mnt-fp-candidates.sh" --repo o/r --config "$T/fp.yml"
run broker-watch 1 bash "$S/resource-broker/scripts/broker-watch.sh" --repo o/r --ledger 7 --state-dir "$T/state/br" --interval 1 --pool "$T/pool.json" --store "$T/store" --owner me --once

# --- a healthy gh does not trip the check (watch scripts get past startup) ----------------------
o="$(env -i PATH="$T/good:$SYSBIN" HOME="$T" bash "$S/merge-monster/scripts/mm-snapshot.sh" --repo o/r 2>&1)"
case "$o" in *GH_AUTH_ERROR*) echo "FAIL healthy gh flagged"; FAILS=$((FAILS + 1)) ;; *) echo "ok   healthy gh passes mm-snapshot" ;; esac

[ "$FAILS" -eq 0 ] && echo "all fleet-gh tests passed" || { echo "$FAILS failed"; exit 1; }
