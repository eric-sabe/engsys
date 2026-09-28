#!/usr/bin/env bash
# review.test.sh — sandbox tests for review.sh.tmpl. Local bare remote + a stub `gh`; no network.
# Run: bash core/templates/review/test/review.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TMPL="$HERE/../review.sh.tmpl"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0 fail=0

ok()   { pass=$((pass + 1)); echo "  ok   $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL $1"; }
check() { # check <name> <condition-exit-code>
  if [[ "$2" == 0 ]]; then ok "$1"; else bad "$1"; fi
}
has()  { grep -qF -- "$2" "$1"; }

# --- sandbox repo with a local bare origin ----------------------------------------------------
git init -q --bare "$T/origin.git"
git init -q -b main "$T/work"
git -C "$T/work" config user.email t@example.com
git -C "$T/work" config user.name t
git -C "$T/work" commit -q --allow-empty -m init
git -C "$T/work" remote add origin "$T/origin.git"
git -C "$T/work" push -q origin main

# --- stub gh: behaviour selected by $GH_MODE ---------------------------------------------------
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
case "${GH_MODE:-pr}" in
  pr)    echo '{"number":7}' ;;
  nopr)  echo 'no pull requests found for branch "feature"' >&2; exit 1 ;;
  error) echo 'error connecting to api.github.com' >&2; exit 1 ;;
esac
SH
chmod +x "$T/bin/gh"

# run <name> [VAR=value ...] — runs the template in the sandbox; sets rc, $T/out, and $T/log.
run() {
  : >"$T/log"
  set +e
  (cd "$T/work" && env PATH="$T/bin:$PATH" LOG="$T/log" "$@" bash "$TMPL") >"$T/out" 2>&1
  rc=$?
  set -e
}

GATE='echo "gate base=$BASE_REF sha=${REVIEW_HEAD_SHA:0:7}" >>"$LOG"; exit "${GATE_EXIT:-0}"'
ADV='echo "advisory args=[$*]" >>"$LOG"; exit "${ADV_EXIT:-0}"'
# The advisory command receives the post flag as a trailing argument; wrap so "$@" is visible.
ADV_CMD="bash -c '$ADV' adv"

echo "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning "$TMPL" && check "template is shellcheck-clean" 0 || check "template is shellcheck-clean" 1
else
  echo "  skip shellcheck not installed"
fi

echo "configuration"
run GATE_CMD=
check "unconfigured GATE_CMD exits 2" "$([[ $rc == 2 ]] && echo 0 || echo 1)"
check "unconfigured GATE_CMD is explained" "$(has "$T/out" 'GATE_CMD is not configured' && echo 0 || echo 1)"

echo "stale base is fatal"
git -C "$T/work" remote set-url origin "$T/does-not-exist.git"
run GATE_CMD="$GATE"
check "fetch failure exits 1" "$([[ $rc == 1 ]] && echo 0 || echo 1)"
check "fetch failure never ran the gate" "$([[ ! -s $T/log ]] && echo 0 || echo 1)"
git -C "$T/work" remote set-url origin "$T/origin.git"

echo "gate exit code is the script's exit code"
run GATE_CMD="$GATE" GATE_EXIT=3 GH_MODE=pr ADVISORY_CMD="$ADV_CMD"
check "gate exit 3 -> script exit 3" "$([[ $rc == 3 ]] && echo 0 || echo 1)"
check "gate ran against the configured base" "$(has "$T/log" 'gate base=origin/main' && echo 0 || echo 1)"
check "reviewers are handed the HEAD sha" "$(grep -qE 'sha=[0-9a-f]{7}' "$T/log" && echo 0 || echo 1)"
check "advisory still ran after a failing gate" "$(has "$T/log" 'advisory args=' && echo 0 || echo 1)"
run GATE_CMD="$GATE" GATE_EXIT=0 ADVISORY_CMD="$ADV_CMD" GH_MODE=pr
check "clean gate -> exit 0" "$([[ $rc == 0 ]] && echo 0 || echo 1)"
run GATE_CMD="$GATE" BASE_REF=origin/main GH_MODE=pr
check "no ADVISORY_CMD -> advisory skipped" "$(! has "$T/out" 'Advisory review' && echo 0 || echo 1)"

echo "--post only when the branch has a PR"
run GATE_CMD="$GATE" ADVISORY_CMD="$ADV_CMD" GH_MODE=pr
check "PR exists -> advisory gets --post" "$(has "$T/log" 'advisory args=[--post]' && echo 0 || echo 1)"
run GATE_CMD="$GATE" ADVISORY_CMD="$ADV_CMD" GH_MODE=nopr
check "no PR -> advisory prints only" "$(has "$T/log" 'advisory args=[]' && echo 0 || echo 1)"
check "no PR -> says so" "$(has "$T/out" 'No PR for this branch yet' && echo 0 || echo 1)"
run GATE_CMD="$GATE" ADVISORY_CMD="$ADV_CMD" GH_MODE=error
check "other gh error -> advisory prints only" "$(has "$T/log" 'advisory args=[]' && echo 0 || echo 1)"
check "other gh error is NOT misread as 'no PR'" "$(! has "$T/out" 'No PR for this branch yet' && has "$T/out" 'Could not determine PR state' && echo 0 || echo 1)"
run GATE_CMD="$GATE" ADVISORY_CMD="$ADV_CMD" ADVISORY_POST_FLAG=--stamp GH_MODE=pr
check "post flag is configurable" "$(has "$T/log" 'advisory args=[--stamp]' && echo 0 || echo 1)"

echo "advisory never blocks"
run GATE_CMD="$GATE" ADVISORY_CMD="$ADV_CMD" ADV_EXIT=5 GH_MODE=pr
check "advisory failure -> script still exits 0" "$([[ $rc == 0 ]] && echo 0 || echo 1)"
check "advisory failure is surfaced as a warning" "$(has "$T/out" 'not blocking' && echo 0 || echo 1)"
run GATE_CMD="$GATE" GATE_EXIT=2 ADVISORY_CMD="$ADV_CMD" ADV_EXIT=5 GH_MODE=pr
check "advisory failure never masks the gate's code" "$([[ $rc == 2 ]] && echo 0 || echo 1)"

echo
echo "review.test.sh: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
