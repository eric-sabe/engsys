#!/usr/bin/env bash
# mnt-fp.test.sh — sandbox tests for the standing false-positive policies (run by `npm test`; no network).
#
# A temp git history (a passwordless commit A, then a commit B that adds a `password` field to a
# schema.prisma, plus commits that exist only on refs/pull/<n>/...), a local bare "origin", and a stub
# `gh` on PATH that serves open PRs and code-scanning alerts per ref, page by page, and records every
# PATCH with its payload. Covers mnt-fp-candidates.sh (candidates, tripwires at the alert commit and
# at main, scope, invalid and placeholder policies, fetch failure, per-alert and per-PR errors,
# dependency and path checks, alert and PR pagination, PR refs and --prs, JSON, never a PATCH) and
# mnt-fp-dismiss.sh (exact payload, comment cap, journal, PR alerts, every refusal, the 403 message).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
S="$HERE"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT

: >"$T/pass.log"; : >"$T/fail.log"
ok() { echo . >>"$T/pass.log"; echo "  ok   $1"; }
bad() { echo . >>"$T/fail.log"; echo "  FAIL $1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$@" | sed 's/^/         /'; fi; }
has() { if grep -Fq -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "want: $3" "got:" "$2"; fi; }
hasnt() { if grep -Fq -- "$3" <<<"$2"; then bad "$1" "did not want: $3" "got:" "$2"; else ok "$1"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got:  $2"; fi; }
RC=0 OUT=""
rc_is() { if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1" "want rc $2, got $RC; output:" "$OUT"; fi; }
rc_not0() { if [ "$RC" != 0 ]; then ok "$1"; else bad "$1" "want a non-zero rc; output:" "$OUT"; fi; }

# --- sandbox ---------------------------------------------------------------------------------
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GH_TOKEN GITHUB_TOKEN
export HOME="$T/home" FAKE="$T/fake" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=Sandbox GIT_AUTHOR_EMAIL=sandbox@example.invalid GIT_COMMITTER_NAME=Sandbox GIT_COMMITTER_EMAIL=sandbox@example.invalid
mkdir -p "$HOME" "$FAKE/alerts" "$FAKE/override" "$T/bin"
: >"$FAKE/gh.log"; : >"$FAKE/patch.log"
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

RULE=js/insufficient-password-hash
POLICY=password-hash
SHAPE1="HMAC-SHA256 signing of a canonical request string with a shared secret"
SHAPE2="test, fixture or seed code"
SHAPE3="hashing a high-entropy generated secret such as an API key or bearer token purely so it can be looked up by digest, never a user chosen password"

# A stub gh: serves alert pages (?page=N) and single alerts, records PATCH calls with their -f fields.
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
# the wrapper's startup auth probe (engsys#90): answered, and not logged
[ "${1:-} ${2:-}" != "api rate_limit" ] || { echo 5000; exit 0; }
echo "gh $*" >>"$FAKE/gh.log"
[ "${1:-}" = api ] || [ "${1:-}" = pr ] || { echo "stub gh: unsupported: $*" >&2; exit 2; }
if [ "${2:-}" = list ] && [ "$1" = pr ]; then # gh pr list ... --limit L
  [ ! -e "$FAKE/prlist.fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }
  limit=30; prev=""
  for a in "$@"; do [ "$prev" = --limit ] && limit="$a"; prev="$a"; done
  if [ -f "$FAKE/prs.json" ]; then jq -c --argjson l "$limit" '.[:$l]' "$FAKE/prs.json"; else echo '[]'; fi
  exit 0
fi
shift
method=GET url="" fields=()
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -f) fields+=("$2"); shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
case "$method:$url" in
  GET:repos/acme/app/code-scanning/alerts\?*)
    page=1 ref=""
    IFS='&' read -ra kvs <<<"${url#*\?}"
    for kv in "${kvs[@]}"; do
      case "$kv" in page=*) page="${kv#page=}" ;; ref=*) ref="${kv#ref=}" ;; esac
    done
    key="${ref//\//-}"; key="${key:-default}"
    [ ! -e "$FAKE/list.fail" ] || [ "$key" != default ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    [ ! -e "$FAKE/fail-$key" ] || { echo "gh: HTTP 500" >&2; exit 1; }
    if [ ! -d "$FAKE/alerts/$key" ]; then
      [ "$key" = default ] || { echo "gh: no analysis found (HTTP 404)" >&2; exit 1; }
    fi
    f="$FAKE/alerts/$key/page-$page.json"
    if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi ;;
  GET:repos/acme/app/code-scanning/alerts/*)
    n="${url##*/}"
    if [ -f "$FAKE/override/$n.json" ]; then cat "$FAKE/override/$n.json"; exit 0; fi
    find "$FAKE/alerts" -name 'page-*.json' -exec cat {} + | jq -sec --argjson n "$n" 'flatten | map(select(.number == $n)) | .[0] // empty' || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  PATCH:repos/acme/app/code-scanning/alerts/*)
    if [ -e "$FAKE/patch.403" ]; then echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; fi
    rec="$(jq -cn --arg n "${url##*/}" '{alert: ($n | tonumber), fields: {}}')"
    for kv in ${fields[@]+"${fields[@]}"}; do
      rec="$(jq -c --arg k "${kv%%=*}" --arg v "${kv#*=}" '.fields[$k] = $v' <<<"$rec")"
    done
    echo "$rec" >>"$FAKE/patch.log"
    echo '{}' ;;
  *) echo "stub gh: unsupported: $method $url" >&2; exit 2 ;;
esac
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

# Alert fixtures: the fields code-scanning returns that the scripts read.
alert_json() { # number state rule tool sha path line [ref]
  jq -cn --argjson n "$1" --arg st "$2" --arg rule "$3" --arg tool "$4" --arg sha "$5" --arg p "$6" --argjson l "$7" --arg ref "${8:-refs/heads/main}" '{
    number: $n, state: $st,
    html_url: ("https://github.com/acme/app/security/code-scanning/" + ($n | tostring)),
    rule: {id: $rule, security_severity_level: "high"}, tool: {name: $tool},
    most_recent_instance: {ref: $ref, commit_sha: $sha, location: {path: $p, start_line: $l}}}'
}
page() { local n="$1"; shift; mkdir -p "$FAKE/alerts/default"; printf '%s\n' "$@" | jq -s . >"$FAKE/alerts/default/page-$n.json"; }
prpage() { local pr="$1" kind="$2" n="$3"; shift 3; mkdir -p "$FAKE/alerts/refs-pull-$pr-$kind"; printf '%s\n' "$@" | jq -s . >"$FAKE/alerts/refs-pull-$pr-$kind/page-$n.json"; }
set_prs() { printf '%s\n' "$@" | jq -s 'map({number: .})' >"$FAKE/prs.json"; }
clear_alerts() { rm -rf "$FAKE/alerts" "$FAKE/override" "$FAKE"/fail-* "$FAKE/prs.json"; mkdir -p "$FAKE/alerts" "$FAKE/override"; rm -f "$FAKE/list.fail" "$FAKE/patch.403" "$FAKE/prlist.fail"; }
patches() { wc -l <"$FAKE/patch.log" | tr -d ' '; }

# --- git history ------------------------------------------------------------------------------
git init -q --bare -b main "$T/origin.git"
git -C "$T/origin.git" config uploadpack.allowAnySHA1InWant true
git init -q -b main "$T/work"
g() { git -C "$T/work" "$@"; }
g remote add origin "$T/origin.git"
mkdir -p "$T/work/prisma" "$T/work/src" "$T/work/test" "$T/work/docs"
printf 'model User {\n  id    String @id\n  email String\n}\n' >"$T/work/prisma/schema.prisma"
printf '{"name":"app","dependencies":{"express":"4"}}\n' >"$T/work/package.json"
printf 'export const sign = 1;\n' >"$T/work/src/sign.ts"
printf 'export const t = 1;\n' >"$T/work/test/x.test.ts"
printf '# docs\n' >"$T/work/docs/readme.md"
g add -A; g commit -q -m "A: passwordless"
A="$(g rev-parse HEAD)"
g push -q origin main
# The clone under test is made now, so it has A and none of the later commits (the alert commit must be fetched).
git clone -q "$T/origin.git" "$T/clone"
CL="$T/clone"

printf 'model User {\n  id    String @id\n  email String\n  password String\n}\n' >"$T/work/prisma/schema.prisma"
g commit -q -am "B: adds a password field"
B="$(g rev-parse HEAD)"
g push -q origin "$B:refs/heads/feature"
g checkout -q -b dep-a "$A"
printf '{"name":"app","dependencies":{"bcrypt":"5"}}\n' >"$T/work/package.json"
g commit -q -am "dep-a: bcrypt in dependencies"; DEPA="$(g rev-parse HEAD)"; g push -q origin HEAD:refs/heads/dep-a
g checkout -q -b dep-b "$A"
mkdir -p "$T/work/packages/api"
printf '{"name":"api","devDependencies":{"argon2":"0"}}\n' >"$T/work/packages/api/package.json"
g add -A; g commit -q -m "dep-b: argon2 in a nested devDependencies"; DEPB="$(g rev-parse HEAD)"; g push -q origin HEAD:refs/heads/dep-b
g checkout -q -b dep-c "$A"
printf '{"name":"app","optionalDependencies":{"scrypt":"1"}}\n' >"$T/work/package.json"
g commit -q -am "dep-c: scrypt in optionalDependencies"; DEPC="$(g rev-parse HEAD)"; g push -q origin HEAD:refs/heads/dep-c
g checkout -q -b path-a "$A"
mkdir -p "$T/work/src/auth"
printf 'export const p = 1;\n' >"$T/work/src/auth/password-utils.ts"
g add -A; g commit -q -m "path-a: a password*.ts file"; PATHA="$(g rev-parse HEAD)"; g push -q origin HEAD:refs/heads/path-a
# Commits that exist only on pull refs (the clone never has them until an alert points there).
g checkout -q -b prc "$A"
printf 'export const sign = 2;\n' >"$T/work/src/sign.ts"
g commit -q -am "prc: a clean PR change"; PRC="$(g rev-parse HEAD)"
g push -q origin "$PRC:refs/pull/5/merge" "$PRC:refs/pull/5/head" "$PRC:refs/pull/8/head"
g checkout -q -b prb "$A"
printf 'model User {\n  id    String @id\n  email String\n  password String\n}\n' >"$T/work/prisma/schema.prisma"
g commit -q -am "prb: a PR that adds a password field"; PRB="$(g rev-parse HEAD)"
g push -q origin "$PRB:refs/pull/6/head"
g checkout -q -b prd "$A"
printf 'export const sign = 3;\n' >"$T/work/src/sign.ts"; g commit -q -am "prd1"
printf 'export const sign = 4;\n' >"$T/work/src/sign.ts"; g commit -q -am "prd2"; PRD2="$(g rev-parse HEAD)"
g push -q origin "$PRD2:refs/pull/7/head"
g checkout -q -b pre "$A"
printf 'export const sign = 5;\n' >"$T/work/src/sign.ts"; g commit -q -am "pre1"; PRE1="$(g rev-parse HEAD)"
printf 'export const sign = 6;\n' >"$T/work/src/sign.ts"; g commit -q -am "pre2"; PRE2="$(g rev-parse HEAD)"
g push -q origin "$PRE2:refs/pull/11/head"
set_main() { g push -q -f origin "$1:refs/heads/main"; }
set_main "$A"

# --- configs ----------------------------------------------------------------------------------
CFG="$T/cfg.yml"
GOOD_POLICY="  - id: $POLICY
    rule: $RULE
    tool: CodeQL
    approved_by: \"Ada 2026-01-01 https://example.invalid/review/1\"
    known_fp_shapes:
      - $SHAPE1
      - $SHAPE2
      - $SHAPE3
    paths:
      include: [\"**/*.ts\"]
      exclude: [\"**/*.test.ts\"]
    tripwire:
      - { type: absent_regex, glob: \"**/schema.prisma\", pattern: \"password\", ignore_case: true }
      - { type: absent_dependency, manifests: \"**/package.json\", names: [bcrypt, bcryptjs, argon2, scrypt, pbkdf2] }
      - { type: absent_path, glob: \"**/password*.ts\" }"
write_cfg() { # file, policy-yaml…  (the policies are indented list items)
  local f="$1"; shift
  { printf 'repo: acme/app\ndefault_branch: main\nstate_dir: %s\nfp_policies:\n' "$T/state"; printf '%s\n' "$@"; } >"$f"
}
write_cfg "$CFG" "$GOOD_POLICY"

cd "$CL"
run_c() { # candidates run with the standard flags; a PATCH from it is a failure
  : >"$FAKE/gh.log"
  RC=0; OUT="$("$S/mnt-fp-candidates.sh" --repo acme/app --repo-dir "$CL" "$@" 2>&1)" || RC=$?
  if grep -q -- 'PATCH' "$FAKE/gh.log"; then bad "candidates issued a PATCH" "$(cat "$FAKE/gh.log")"; fi
}
run_d() { # alert shape evidence [extra flags] — an operator run (--no-baton); run_db below runs as a monster
  local a="$1" sh="$2" ev="$3"; shift 3
  RC=0; OUT="$("$S/mnt-fp-dismiss.sh" --repo acme/app --repo-dir "$CL" --config "$CFG" --alert "$a" --policy "$POLICY" --shape "$sh" --evidence "$ev" --no-baton "$@" 2>&1)" || RC=$?
}
run_db() { # same, without --no-baton: the baton fence applies
  local a="$1" sh="$2" ev="$3"; shift 3
  RC=0; OUT="$("$S/mnt-fp-dismiss.sh" --repo acme/app --repo-dir "$CL" --config "$CFG" --alert "$a" --policy "$POLICY" --shape "$sh" --evidence "$ev" "$@" 2>&1)" || RC=$?
}

echo "candidates"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
run_c --config "$CFG"
eq "candidate at A with main at A" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"
rc_is "  exits 0" 0
eq "no PATCH was made" "$(patches)" 0

echo "tripwire failed at the alert commit"
clear_alerts
git -C "$CL" cat-file -e "$B^{commit}" 2>/dev/null && bad "precondition: B should not be in the clone yet"
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)" "$(alert_json 2 open "$RULE" CodeQL "$B" src/sign.ts 20)"
run_c --config "$CFG"
has "alert 2 (password field at its commit): TRIPWIRE_FAILED commit" "$OUT" "TRIPWIRE_FAILED 2 $POLICY absent_regex#0 commit"
hasnt "  and it is not a candidate" "$OUT" "CANDIDATE 2 "
has "alert 1 is still a candidate (main is clean)" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"
hasnt "main did not fail" "$OUT" " main "
git -C "$CL" cat-file -e "$B^{commit}" 2>/dev/null && ok "the missing alert commit was fetched" || bad "the alert commit was not fetched"

echo "tripwire failed on main (alert at A, main at B)"
set_main "$B"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
run_c --config "$CFG"
has "TRIPWIRE_FAILED main" "$OUT" "TRIPWIRE_FAILED 1 $POLICY absent_regex#0 main"
hasnt "  no CANDIDATE" "$OUT" "CANDIDATE"
run_c --config "$CFG" --json
eq "  --json reports the same status" "$(jq -r '.[0].status' <<<"$OUT")" TRIPWIRE_FAILED
eq "  and which check failed where" "$(jq -r '[.[0].tripwire[] | select(.ok | not) | "\(.type)#\(.index)@\(.where)"] | join(",")' <<<"$OUT")" "absent_regex#0@main"

echo "out of scope by path"
set_main "$A"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" docs/readme.md 1)" "$(alert_json 2 open "$RULE" CodeQL "$A" test/x.test.ts 3)" "$(alert_json 3 open "$RULE" CodeQL "$A" src/sign.ts 4)"
run_c --config "$CFG"
has "no include match" "$OUT" "OUT_OF_SCOPE 1 $POLICY docs/readme.md path matches no paths.include glob"
has "excluded by glob" "$OUT" "OUT_OF_SCOPE 2 $POLICY test/x.test.ts path excluded by **/*.test.ts"
has "the in-scope alert is still a candidate" "$OUT" "CANDIDATE 3 $POLICY src/sign.ts:4 $A"

echo "matching: rule, tool and state"
clear_alerts
page 1 "$(alert_json 1 open js/other-rule CodeQL "$A" src/sign.ts 1)" "$(alert_json 2 open "$RULE" OtherTool "$A" src/sign.ts 2)" "$(alert_json 3 dismissed "$RULE" CodeQL "$A" src/sign.ts 3)" "$(alert_json 4 open "$RULE" CodeQL "$A" src/sign.ts 4)"
run_c --config "$CFG"
eq "only the open alert of the exact rule and tool is listed" "$OUT" "CANDIDATE 4 $POLICY src/sign.ts:4 $A"

echo "candidate JSON"
run_c --config "$CFG" --json
eq "one element" "$(jq 'length' <<<"$OUT")" 1
eq "carries html_url" "$(jq -r '.[0].html_url' <<<"$OUT")" "https://github.com/acme/app/security/code-scanning/4"
eq "carries severity" "$(jq -r '.[0].severity' <<<"$OUT")" high
eq "carries the location" "$(jq -r '"\(.[0].path):\(.[0].line)@\(.[0].sha)"' <<<"$OUT")" "src/sign.ts:4@$A"
eq "carries tripwire detail for both revisions" "$(jq -r '[.[0].tripwire[] | .where] | sort | join(",")' <<<"$OUT")" "commit,commit,commit,main,main,main"
eq "  and the files each check scanned" "$(jq -r '.[0].tripwire[0].files_scanned' <<<"$OUT")" 1

echo "hermetic git: a hook's GIT_DIR must not redirect the clone reads"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
mkdir -p "$T/decoy"
GIT_DIR="$T/decoy" GIT_WORK_TREE="$T/decoy" GIT_INDEX_FILE="$T/decoy/idx" run_c --config "$CFG"
eq "still a candidate with GIT_DIR pointing elsewhere" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"

echo "invalid policies: errors, never candidates"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
check_invalid() { # name policy-yaml expected-fragment
  write_cfg "$T/bad.yml" "$2"
  run_c --config "$T/bad.yml"
  has "$1: ERROR" "$OUT" "ERROR policy "
  has "  names the problem" "$OUT" "$3"
  hasnt "  no CANDIDATE" "$OUT" "CANDIDATE"
  rc_is "  exits 1" 1
}
check_invalid "missing approved_by" "$(printf '%s\n' "$GOOD_POLICY" | grep -v '^    approved_by:')" "approved_by is required"
check_invalid "blank approved_by" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    approved_by:.*/    approved_by: "  "/')" "approved_by is required"
check_invalid "unknown tripwire type" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/absent_path/absent_symlink/')" 'unknown type "absent_symlink"'
check_invalid "empty known_fp_shapes" "$(printf '%s\n' "$GOOD_POLICY" | awk '/^    known_fp_shapes:/{print "    known_fp_shapes: []"; skip=1; next} /^    paths:/{skip=0} !skip')" "known_fp_shapes must be a non-empty list"
check_invalid "missing known_fp_shapes" "$(printf '%s\n' "$GOOD_POLICY" | awk '/^    known_fp_shapes:/{skip=1; next} /^    paths:/{skip=0} !skip')" "known_fp_shapes must be a non-empty list"
check_invalid "invalid id" "$(printf '%s\n' "$GOOD_POLICY" | sed "s/^  - id: $POLICY/  - id: Bad_ID/")" "id must be a slug"
check_invalid "no tripwire" "$(printf '%s\n' "$GOOD_POLICY" | awk '/^    tripwire:/{exit} {print}')" "tripwire must be a non-empty list"
check_invalid "placeholder approved_by (<who> ...)" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    approved_by:.*/    approved_by: "<who> <yyyy-mm-dd> <link to the reviewed change that added this policy>"/')" "template placeholder"
check_invalid "placeholder <yyyy-mm-dd> alone" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    approved_by:.*/    approved_by: "Ada <yyyy-mm-dd> https:\/\/example.invalid\/1"/')" "template placeholder"
check_invalid "unclosed <link placeholder" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    approved_by:.*/    approved_by: "Ada 2026-01-01 <link to the change"/')" "template placeholder"
check_invalid "any <...> token" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    approved_by:.*/    approved_by: "Ada 2026-01-01 <https:\/\/example.invalid\/1>"/')" "template placeholder"
check_invalid "unknown policy key" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/^    tool: CodeQL/    tool: CodeQL\n    autodismiss: true/')" 'unknown key "autodismiss"'
check_invalid "unknown tripwire key" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/pattern: "password",/pattern: "password", flags: g,/')" 'unknown key "flags"'
check_invalid "bad regex" "$(printf '%s\n' "$GOOD_POLICY" | sed 's/pattern: "password"/pattern: "pass(word"/')" "not a valid regular expression"
check_invalid "duplicate ids" "$(printf '%s\n%s\n' "$GOOD_POLICY" "$GOOD_POLICY")" 'duplicate policy id "password-hash"'
write_cfg "$T/mixed.yml" "$GOOD_POLICY" "$(printf '%s\n' "$GOOD_POLICY" | sed "s/^  - id: $POLICY/  - id: second/" | grep -v '^    approved_by:')"
run_c --config "$T/mixed.yml"
has "an invalid policy does not stop a valid one: candidate" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"
has "  the invalid one still errors" "$OUT" "ERROR policy second: invalid policy"
run_c --config "$T/mixed.yml" --policy second
hasnt "--policy selects only that policy" "$OUT" "CANDIDATE"
run_c --config "$T/mixed.yml" --policy nope
has "an unknown --policy is an ERROR" "$OUT" "ERROR policy nope: not found"
printf 'fp_policies: [oops\n' >"$T/broken.yml"
run_c --config "$T/broken.yml"
has "unparseable fp_policies is an ERROR" "$OUT" "ERROR config fp_policies:"
printf 'repo: acme/app\n' >"$T/none.yml"
run_c --config "$T/none.yml"
eq "no fp_policies: nothing to do" "$OUT" ""
rc_is "  exits 0" 0
run_c --config "$T/does-not-exist.yml"
has "a missing config is an ERROR" "$OUT" "ERROR cannot read config"

echo "fail closed: fetch and gh errors"
git -C "$CL" remote set-url origin "$T/no-such-origin.git"
run_c --config "$CFG"
has "a failed fetch of the default branch: ERROR" "$OUT" "ERROR policy $POLICY"
has "  says why" "$OUT" "default branch not available"
hasnt "  no CANDIDATE from a possibly stale origin/main" "$OUT" "CANDIDATE"
run_c --config "$CFG" --json
eq "  --json: an ERROR element, no candidate" "$(jq -r '[.[].status] | join(",")' <<<"$OUT")" ERROR
git -C "$CL" remote set-url origin "$T/origin.git"
touch "$FAKE/list.fail"
run_c --config "$CFG"
has "a failing default-branch alert listing: ERROR" "$OUT" "ERROR policy $POLICY"
hasnt "  no CANDIDATE (policy-wide)" "$OUT" "CANDIDATE"
rm -f "$FAKE/list.fail"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)" "$(alert_json 2 open "$RULE" CodeQL "0000000000000000000000000000000000000001" src/sign.ts 20)"
run_c --config "$CFG"
has "an unfetchable alert commit: ERROR for that alert only" "$OUT" "ERROR alert 2: commit 000000000000 is not available locally"
has "  the policy's other alert still evaluates: CANDIDATE" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"
eq "  exactly one ERROR and one CANDIDATE" "$(grep -c '^ERROR' <<<"$OUT") $(grep -c '^CANDIDATE' <<<"$OUT")" "1 1"
rc_is "  exits 1" 1
run_c --config "$CFG" --json
eq "  --json: the ERROR element carries the alert and the policy" "$(jq -r '[.[] | select(.status == "ERROR") | "\(.alert)/\(.policy)"] | join(",")' <<<"$OUT")" "2/$POLICY"
run_c --config "$CFG" --repo-dir "$T/not-a-repo"
has "a --repo-dir that is not a git repo: ERROR" "$OUT" "ERROR policy $POLICY"

echo "absent_dependency: dependencies, devDependencies, optionalDependencies, nested manifests"
DEPCFG="$T/dep.yml"
write_cfg "$DEPCFG" "  - id: deps-only
    rule: $RULE
    approved_by: \"Ada 2026-01-01 https://example.invalid/review/2\"
    known_fp_shapes: [\"$SHAPE2\"]
    tripwire:
      - type: absent_dependency
        manifests: \"**/package.json\"
        names: [bcrypt, bcryptjs, argon2, scrypt, pbkdf2]"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 1)" "$(alert_json 2 open "$RULE" CodeQL "$DEPA" src/sign.ts 2)" "$(alert_json 3 open "$RULE" CodeQL "$DEPB" src/sign.ts 3)" "$(alert_json 4 open "$RULE" CodeQL "$DEPC" src/sign.ts 4)"
run_c --config "$DEPCFG"
has "no hashing dependency: candidate (block-style YAML tripwire)" "$OUT" "CANDIDATE 1 deps-only src/sign.ts:1 $A"
has "bcrypt in dependencies" "$OUT" "TRIPWIRE_FAILED 2 deps-only absent_dependency#0 commit dependency present: bcrypt (dependencies) in package.json"
has "argon2 in a nested devDependencies" "$OUT" "TRIPWIRE_FAILED 3 deps-only absent_dependency#0 commit dependency present: argon2 (devDependencies) in packages/api/package.json"
has "scrypt in optionalDependencies" "$OUT" "TRIPWIRE_FAILED 4 deps-only absent_dependency#0 commit dependency present: scrypt (optionalDependencies) in package.json"
set_main "$DEPA"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 1)"
run_c --config "$DEPCFG"
has "the dependency on main fails an alert at a clean commit" "$OUT" "TRIPWIRE_FAILED 1 deps-only absent_dependency#0 main"
set_main "$A"

echo "absent_path"
PATHCFG="$T/path.yml"
write_cfg "$PATHCFG" "  - id: paths-only
    rule: $RULE
    approved_by: \"Ada 2026-01-01 https://example.invalid/review/3\"
    known_fp_shapes: [\"$SHAPE2\"]
    tripwire:
      - { type: absent_path, glob: \"**/password*.ts\" }"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 1)" "$(alert_json 2 open "$RULE" CodeQL "$PATHA" src/sign.ts 2)"
run_c --config "$PATHCFG"
has "no password*.ts path: candidate" "$OUT" "CANDIDATE 1 paths-only src/sign.ts:1 $A"
has "src/auth/password-utils.ts present" "$OUT" "TRIPWIRE_FAILED 2 paths-only absent_path#0 commit path present: src/auth/password-utils.ts"

echo "pagination (two pages, then an empty one)"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 1)" "$(alert_json 2 open "$RULE" CodeQL "$A" src/sign.ts 2)"
page 2 "$(alert_json 3 open "$RULE" CodeQL "$A" src/sign.ts 3)"
MNT_FP_PER_PAGE=2 run_c --config "$CFG"
has "page 1 alert" "$OUT" "CANDIDATE 1 $POLICY"
has "page 1 alert" "$OUT" "CANDIDATE 2 $POLICY"
has "page 2 alert" "$OUT" "CANDIDATE 3 $POLICY"
run_c --config "$CFG"
has "the default page size (100) also walks to the empty page" "$(cat "$FAKE/gh.log")" "per_page=100&page=2"

echo "pull requests: alerts that exist only on a PR ref"
PRCFG_LOG="$FAKE/gh.log"
clear_alerts
set_prs 5
prpage 5 merge 1 "$(alert_json 10 open "$RULE" CodeQL "$PRC" src/sign.ts 9 refs/pull/5/merge)"
run_c --config "$CFG"
eq "a PR-only alert is a CANDIDATE (its commit fetched from the pull ref), with pr=" "$OUT" "CANDIDATE 10 $POLICY src/sign.ts:9 $PRC pr=5"
has "the PR list and the PR's merge ref were queried" "$(cat "$PRCFG_LOG")" "ref=refs/pull/5/merge"
run_c --config "$CFG" --json
eq "  --json carries pr" "$(jq -r '.[0].pr' <<<"$OUT")" 5
eq "  and the instance" "$(jq -r '.[0].instances[0] | "\(.pr) \(.sha) \(.path) \(.line)"' <<<"$OUT")" "5 $PRC src/sign.ts 9"
: >"$FAKE/patch.log"; rm -rf "$T/state"
run_d 10 "$SHAPE1" "HMAC-SHA256 over the canonical request string"
eq "the PR-only alert dismisses (re-evaluated at its PR commit)" "$OUT" "DISMISSED 10 $POLICY src/sign.ts:9 $PRC pr=5"
eq "  one PATCH, exact payload" "$(jq -cS . "$FAKE/patch.log")" "$(jq -cnS --arg c "fp-policy $POLICY: $SHAPE1 — HMAC-SHA256 over the canonical request string" '{alert: 10, fields: {state: "dismissed", dismissed_reason: "false positive", dismissed_comment: $c}}')"
eq "  the journal records the PR" "$(jq -r '"\(.alert) \(.pr) \(.sha)"' "$T/state/fp-dispositions.jsonl")" "10 5 $PRC"

echo "pull requests: tripwire at the PR commit, /head fallback, empty merge ref"
clear_alerts
set_prs 5 6 8
prpage 5 merge 1 "$(alert_json 10 open "$RULE" CodeQL "$PRC" src/sign.ts 9 refs/pull/5/merge)"
prpage 6 head 1 "$(alert_json 11 open "$RULE" CodeQL "$PRB" src/sign.ts 4 refs/pull/6/head)"
prpage 8 merge 1
prpage 8 head 1 "$(alert_json 13 open "$RULE" CodeQL "$PRC" src/sign.ts 5 refs/pull/8/head)"
run_c --config "$CFG"
has "PR 6 (its commit adds a password field): TRIPWIRE_FAILED at the commit" "$OUT" "TRIPWIRE_FAILED 11 $POLICY absent_regex#0 commit /password/ matches in prisma/schema.prisma pr=6"
hasnt "  and it is not a candidate" "$OUT" "CANDIDATE 11 "
has "PR 5 is unaffected by PR 6" "$OUT" "CANDIDATE 10 $POLICY src/sign.ts:9 $PRC pr=5"
has "a merge ref with no alerts falls back to /head" "$OUT" "CANDIDATE 13 $POLICY src/sign.ts:5 $PRC pr=8"
has "  (404 merge ref for PR 6 fell back to /head too)" "$(cat "$FAKE/gh.log")" "ref=refs/pull/6/head"
git -C "$CL" cat-file -e "$PRB^{commit}" 2>/dev/null && ok "PR commits were fetched into the clone" || bad "PR commit not fetched"

echo "pull requests: an alert seen on the default branch and on a PR is one alert, checked at every instance"
clear_alerts
set_prs 6
page 1 "$(alert_json 20 open "$RULE" CodeQL "$A" src/sign.ts 3)"
prpage 6 head 1 "$(alert_json 20 open "$RULE" CodeQL "$PRB" src/sign.ts 3 refs/pull/6/head)"
run_c --config "$CFG"
eq "one alert number, one verdict" "$(grep -c ' 20 ' <<<"$OUT")" 1
has "the PR instance's password field fails it even though the default-branch instance is clean" "$OUT" "TRIPWIRE_FAILED 20 $POLICY absent_regex#0 commit /password/ matches in prisma/schema.prisma pr=6"
clear_alerts
set_prs 5
page 1 "$(alert_json 21 open "$RULE" CodeQL "$A" src/sign.ts 3)"
prpage 5 merge 1 "$(alert_json 21 open "$RULE" CodeQL "$A" src/sign.ts 3 refs/pull/5/merge)"
run_c --config "$CFG"
eq "the same instance on both lists is deduped" "$OUT" "CANDIDATE 21 $POLICY src/sign.ts:3 $A"

echo "pull requests: --prs"
clear_alerts
set_prs 5 6
prpage 5 merge 1 "$(alert_json 10 open "$RULE" CodeQL "$PRC" src/sign.ts 9 refs/pull/5/merge)"
prpage 6 head 1 "$(alert_json 11 open "$RULE" CodeQL "$PRB" src/sign.ts 4 refs/pull/6/head)"
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
run_c --config "$CFG" --prs none
eq "--prs none: only the default branch" "$OUT" "CANDIDATE 1 $POLICY src/sign.ts:12 $A"
hasnt "  no PR listing and no PR ref query" "$(cat "$FAKE/gh.log")" "pull"
hasnt "  (no pr list either)" "$(cat "$FAKE/gh.log")" "pr list"
run_c --config "$CFG" --prs 5
has "--prs 5: PR 5 is scanned" "$OUT" "CANDIDATE 10 $POLICY src/sign.ts:9 $PRC pr=5"
hasnt "  PR 6 is not" "$OUT" " 11 "
hasnt "  and the open PRs are not listed" "$(cat "$FAKE/gh.log")" "pr list"
run_c --config "$CFG" --prs 5,6
has "--prs 5,6" "$OUT" "TRIPWIRE_FAILED 11 $POLICY"
run_c --config "$CFG" --prs nope
rc_is "--prs with a bad value is a usage error" 2
run_c --config "$CFG" --prs all
has "--prs all (the default) scans every open PR" "$OUT" "pr=6"

echo "pull requests: the PR list is paginated"
clear_alerts
set_prs 5 6 7
prpage 7 head 1 "$(alert_json 30 open "$RULE" CodeQL "$PRD2" src/sign.ts 2 refs/pull/7/head)"
MNT_FP_PR_LIMIT=2 run_c --config "$CFG"
eq "a PR beyond the first page of the list is scanned" "$OUT" "CANDIDATE 30 $POLICY src/sign.ts:2 $PRD2 pr=7"
eq "  the list was widened once (limit 2, then 8)" "$(grep -c 'pr list' "$FAKE/gh.log") $(grep -c -- '--limit 8' "$FAKE/gh.log")" "2 1"

echo "pull requests: the fetch falls back to the PR ref when the sha itself cannot be fetched"
git -C "$T/origin.git" config uploadpack.allowAnySHA1InWant false
clear_alerts
set_prs 11
prpage 11 head 1 "$(alert_json 31 open "$RULE" CodeQL "$PRE1" src/sign.ts 2 refs/pull/11/head)"
git -C "$CL" cat-file -e "$PRE1^{commit}" 2>/dev/null && bad "precondition: PRE1 should not be in the clone yet"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.version GIT_CONFIG_VALUE_0=0 run_c --config "$CFG"
eq "an earlier commit of the PR (not a tip) is fetched via refs/pull/11/head" "$OUT" "CANDIDATE 31 $POLICY src/sign.ts:2 $PRE1 pr=11"
git -C "$CL" rev-parse --verify -q refs/mnt-fp/pr-11-head >/dev/null && ok "  into a scratch ref" || bad "  no scratch ref"
git -C "$T/origin.git" config uploadpack.allowAnySHA1InWant true

echo "pull requests: errors are per PR and per alert"
clear_alerts
set_prs 5 6 9
touch "$FAKE/fail-refs-pull-9-merge"
prpage 5 merge 1 "$(alert_json 10 open "$RULE" CodeQL "$PRC" src/sign.ts 9 refs/pull/5/merge)"
prpage 6 head 1 "$(alert_json 11 open "$RULE" CodeQL "$PRB" src/sign.ts 4 refs/pull/6/head)"
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
run_c --config "$CFG"
has "listing one PR's alerts fails: ERROR for that PR" "$OUT" "ERROR pr 9: could not list code-scanning alerts"
has "  the default branch still evaluates" "$OUT" "CANDIDATE 1 $POLICY"
has "  and the other PRs" "$OUT" "CANDIDATE 10 $POLICY src/sign.ts:9 $PRC pr=5"
rc_is "  exit 1" 1
clear_alerts
set_prs 5
touch "$FAKE/prlist.fail"
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)"
run_c --config "$CFG"
has "listing the open PRs fails: ERROR, no PR scanned" "$OUT" "ERROR cannot list open PRs"
has "  the default branch still evaluates" "$OUT" "CANDIDATE 1 $POLICY"
clear_alerts
set_prs 5 6
prpage 5 merge 1 "$(alert_json 10 open "$RULE" CodeQL "$PRC" src/sign.ts 9 refs/pull/5/merge)"
prpage 6 merge 1 "$(alert_json 12 open "$RULE" CodeQL "1111111111111111111111111111111111111111" src/sign.ts 2 refs/pull/6/merge)"
run_c --config "$CFG"
has "a PR alert whose commit is gone (force-pushed): ERROR for that alert" "$OUT" "ERROR alert 12: commit 111111111111 is not available locally and could not be fetched (PR 6)"
has "  the other PR's alert is still a CANDIDATE" "$OUT" "CANDIDATE 10 $POLICY src/sign.ts:9 $PRC pr=5"
git -C "$CL" remote set-url origin "$T/no-such-origin.git"
run_c --config "$CFG"
hasnt "the default-branch fetch failing is still policy-wide: no CANDIDATE" "$OUT" "CANDIDATE"
has "  ERROR names the policy" "$OUT" "ERROR policy $POLICY: default branch not available"
git -C "$CL" remote set-url origin "$T/origin.git"

echo "the example config's fp_policies block is valid as shipped"
EXAMPLE="$S/../config.example.yml"
{ sed -n '/^repo:/,/^$/p' "$EXAMPLE" | head -2; printf 'state_dir: %s\n' "$T/state"; sed -n '/^# fp_policies:/,/^$/p' "$EXAMPLE" | sed 's/^# \{0,1\}//'; } >"$T/example.yml"
grep -q '^fp_policies:' "$T/example.yml" && ok "found a commented fp_policies example" || bad "no commented fp_policies example in config.example.yml"
clear_alerts
page 1 "$(alert_json 1 open js/insufficient-password-hash CodeQL "$A" src/sign.ts 7)"
run_c --config "$T/example.yml"
has "the example, unedited, is rejected for its approved_by placeholder" "$OUT" "template placeholder"
hasnt "  and yields no candidate" "$OUT" "CANDIDATE"
sed -i.bak 's|^  *approved_by:.*|    approved_by: "Ada 2026-01-01 https://example.invalid/review/9"|' "$T/example.yml"
run_c --config "$T/example.yml"
has "the uncommented example evaluates (candidate)" "$OUT" "CANDIDATE 1 password-hash-on-passwordless src/sign.ts:7 $A"
echo "a real-shaped config (multi-line flow lists, comments, other blocks) reads"
{ cat "$EXAMPLE"; printf '\n'; sed -n '/^# fp_policies:/,/^$/p' "$EXAMPLE" | sed 's/^# \{0,1\}//; s|^  *approved_by:.*|    approved_by: "Ada 2026-01-01 https://example.invalid/review/9"|'; } >"$T/full.yml"
run_c --config "$T/full.yml"
has "fp_policies read out of the whole example file" "$OUT" "CANDIDATE 1 password-hash-on-passwordless src/sign.ts:7 $A"

echo "dismiss: happy path"
: >"$FAKE/patch.log"; rm -rf "$T/state"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)" "$(alert_json 5 open "$RULE" CodeQL "$A" src/sign.ts 40)"
run_d 1 "$SHAPE1" "HMAC-SHA256 over the canonical request string in signRequest(); the key is the shared secret"
eq "DISMISSED line" "$OUT" "DISMISSED 1 $POLICY src/sign.ts:12 $A"
rc_is "  exits 0" 0
eq "exactly one PATCH" "$(patches)" 1
WANT_COMMENT="fp-policy $POLICY: $SHAPE1 — HMAC-SHA256 over the canonical request string in signRequest(); the key is the shared secret"
eq "  exact payload" "$(jq -cS . "$FAKE/patch.log")" "$(jq -cnS --arg c "$WANT_COMMENT" '{alert: 1, fields: {state: "dismissed", dismissed_reason: "false positive", dismissed_comment: $c}}')"
eq "  comment is at most 280 characters" "$(jq -r '.fields.dismissed_comment | length <= 280' "$FAKE/patch.log")" true
JOURNAL="$T/state/fp-dispositions.jsonl"
eq "journal has one line" "$(wc -l <"$JOURNAL" | tr -d ' ')" 1
eq "  alert/policy/sha/path/shape/evidence" "$(jq -r '[.alert, .policy, .sha, .path, .shape, .evidence] | @tsv' "$JOURNAL")" "$(printf '1\t%s\t%s\tsrc/sign.ts\t%s\t%s' "$POLICY" "$A" "$SHAPE1" "HMAC-SHA256 over the canonical request string in signRequest(); the key is the shared secret")"
eq "  and a timestamp" "$(jq -r '.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' "$JOURNAL")" true

echo "dismiss: a long shape plus 200 characters of evidence stays within 280"
LONGEV="$(printf 'x%.0s' $(seq 1 250))"
: >"$FAKE/patch.log"
run_d 5 "$SHAPE3" "$LONGEV"
has "still dismissed" "$OUT" "DISMISSED 5 $POLICY"
eq "  comment length is exactly the 280 cap" "$(jq -r '.fields.dismissed_comment | length' "$FAKE/patch.log")" 280
eq "  truncated with an ellipsis" "$(jq -r '.fields.dismissed_comment | endswith("…")' "$FAKE/patch.log")" true
eq "  evidence in the journal is capped at 200" "$(tail -1 "$JOURNAL" | jq -r '.evidence | length')" 200

echo "dismiss: refusals (each makes no PATCH and no journal line)"
: >"$FAKE/patch.log"
JLINES="$(wc -l <"$JOURNAL" | tr -d ' ')"
no_side_effects() {
  eq "  no PATCH" "$(patches)" 0
  eq "  no journal line" "$(wc -l <"$JOURNAL" | tr -d ' ')" "$JLINES"
  rc_not0 "  non-zero exit"
}
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)" "$(alert_json 2 open "$RULE" CodeQL "$B" src/sign.ts 20)" "$(alert_json 6 open "$RULE" CodeQL "$A" docs/readme.md 2)"
run_d 2 "$SHAPE1" "hmac"
has "tripwire failing at the alert commit" "$OUT" "REFUSED 2 $POLICY tripwire now failing: absent_regex#0 @commit"
no_side_effects
set_main "$B"
run_d 1 "$SHAPE1" "hmac"
has "tripwire failing on main since the candidate list (TOCTOU)" "$OUT" "REFUSED 1 $POLICY tripwire now failing: absent_regex#0 @main"
no_side_effects
set_main "$A"
run_d 1 "not a listed shape" "hmac"
has "shape that is not a known_fp_shape" "$OUT" "REFUSED 1 $POLICY --shape does not exactly equal"
no_side_effects
run_d 1 "hmac-sha256 signing of a canonical request string with a shared secret" "hmac"
has "a shape that differs only by case" "$OUT" "REFUSED 1 $POLICY --shape does not exactly equal"
no_side_effects
run_d 6 "$SHAPE1" "hmac"
has "out of scope by path" "$OUT" "REFUSED 6 $POLICY alert is out of scope"
no_side_effects
alert_json 1 dismissed "$RULE" CodeQL "$A" src/sign.ts 12 >"$FAKE/override/1.json"
run_d 1 "$SHAPE1" "hmac"
has "an alert that is already closed" "$OUT" "REFUSED 1 $POLICY alert is already closed (state: dismissed)"
no_side_effects
rm -f "$FAKE/override/1.json"
run_d 99 "$SHAPE1" "hmac"
has "an alert that does not exist" "$OUT" "REFUSED 99 $POLICY cannot re-read the alert"
no_side_effects
alert_json 1 open js/other-rule CodeQL "$A" src/sign.ts 12 >"$FAKE/override/1.json"
run_d 1 "$SHAPE1" "hmac"
has "an alert of a different rule" "$OUT" "REFUSED 1 $POLICY alert rule/tool is not covered"
no_side_effects
rm -f "$FAKE/override/1.json"
touch "$FAKE/patch.403"
run_d 1 "$SHAPE1" "hmac"
has "HTTP 403: says what permission is missing" "$OUT" "Code scanning alerts: Read and write"
has "  names the API permission" "$OUT" "security_events: write"
no_side_effects
rm -f "$FAKE/patch.403"
# The baton fence (engsys#62, review M1): without --no-baton a dismissal goes out only under a passing
# fence, whatever files the state dir holds, and --no-baton is refused inside a launched session. Every
# case below is refused before any request, so it runs offline.
export ENGSYS_SESSION=acme-maintain
run_db 1 "$SHAPE1" "hmac"
has "a launched session with no baton at all (archived by a standing-down startup)" "$OUT" "REFUSED 1 $POLICY baton: fence refused: not_started"
no_side_effects
run_d 1 "$SHAPE1" "hmac"
has "--no-baton inside a launched session" "$OUT" "REFUSED 1 $POLICY baton: --no-baton is refused inside a launched session"
no_side_effects
printf '{"v":1,"holder":"zed:acme-maintain","token":"00000000-0000-4000-8000-000000000000","deadlineMs":0}\n' >"$T/state/baton-maintain.json"
run_db 1 "$SHAPE1" "hmac"
has "a baton in the state dir that this session does not hold" "$OUT" "REFUSED 1 $POLICY baton: fence refused: not_started"
no_side_effects
rm -f "$T/state/baton-maintain.json"
printf '{"at":"2026-10-04T12:00:00.000Z","code":"lost"}\n' >"$T/state/baton-maintain.lost"
run_db 1 "$SHAPE1" "hmac"
has "a lost baton" "$OUT" "REFUSED 1 $POLICY baton: fence refused: lost_earlier"
no_side_effects
rm -f "$T/state/baton-maintain.lost"
unset ENGSYS_SESSION
run_db 1 "$SHAPE1" "hmac"
has "outside a session, no --no-baton: still fenced (no session name, so refused)" "$OUT" "REFUSED 1 $POLICY baton: fence refused"
no_side_effects
CFG_KEEP="$CFG"
CFG="$T/bad.yml"
write_cfg "$CFG" "$(printf '%s\n' "$GOOD_POLICY" | grep -v '^    approved_by:')"
run_d 1 "$SHAPE1" "hmac"
has "an invalid policy" "$OUT" "REFUSED 1 $POLICY policy is invalid"
no_side_effects
write_cfg "$CFG" "$GOOD_POLICY"
run_d 1 "$SHAPE1" "hmac" --repo-dir "$T/not-a-repo"
has "git failing (fail-closed)" "$OUT" "REFUSED 1 $POLICY re-check failed"
no_side_effects
git -C "$CL" remote set-url origin "$T/no-such-origin.git"
run_d 1 "$SHAPE1" "hmac"
has "a failed fetch of the default branch (fail-closed)" "$OUT" "default branch not available"
no_side_effects
git -C "$CL" remote set-url origin "$T/origin.git"
CFG="$CFG_KEEP"
RC=0; OUT="$("$S/mnt-fp-dismiss.sh" --repo acme/app --repo-dir "$CL" --config "$CFG" --alert 1 --policy "$POLICY" --shape "$SHAPE1" --no-baton 2>&1)" || RC=$?
rc_is "missing --evidence is a usage error" 2
no_side_effects
run_d 1 "$SHAPE1" "hmac" --state-dir /dev/null/nope
has "a state dir it cannot write to" "$OUT" "cannot write the disposition journal"
no_side_effects

echo "candidates never PATCH"
clear_alerts
page 1 "$(alert_json 1 open "$RULE" CodeQL "$A" src/sign.ts 12)" "$(alert_json 2 open "$RULE" CodeQL "$B" src/sign.ts 20)"
run_c --config "$CFG"
run_c --config "$CFG" --json
eq "PATCH calls made by every candidates run" "$(patches)" 0

PASS="$(wc -l <"$T/pass.log" | tr -d ' ')" FAIL="$(wc -l <"$T/fail.log" | tr -d ' ')"
echo
echo "mnt-fp: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
