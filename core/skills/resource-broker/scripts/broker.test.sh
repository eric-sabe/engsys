#!/usr/bin/env bash
# broker.test.sh — sandbox tests for the resource-broker scripts (run by `npm test`; no network).
#
# A temp git repo, a stub `gh` that keeps issues in files and records every call, and the REAL
# pool-cli / lease-cli on a two-slot fixture pool whose provision and health commands are stubs that
# log what they run. Covers: config discovery from the fleet config dir; setup (ledger + labels,
# idempotent); the heartbeat line the fleet supervisor parses; watch (a waiter, a stale grant that the
# pump reaps, dropped silent waiters, a grant nudge reaching a waiting session); reconcile after a
# crash; the host window (drain, lock, act, verify, all-clear, and its aborts); POOL_CLI override;
# multi-fleet mode (the fleet's status issue as the ledger, fleet-qualified owner fences, two fleets'
# brokers side by side, and the fail-closed cases).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
S="$HERE"                                          # the scripts under test
LIB="$(cd "$HERE/../../../lib/lease" && pwd -P)"   # core/lib/lease
T="$(cd "$(mktemp -d)" && pwd -P)"
WAITERS=()
cleanup() {
  local p
  for p in ${WAITERS[@]+"${WAITERS[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

: >"$T/pass.log"; : >"$T/fail.log"
ok() { echo . >>"$T/pass.log"; echo "  ok   $1"; }
bad() { echo . >>"$T/fail.log"; echo "  FAIL $1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$@" | sed 's/^/         /'; fi; }
has() { if grep -Fq -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "want: $3" "got:" "$2"; fi; }
hasnt() { if grep -Fq -- "$3" <<<"$2"; then bad "$1" "did not want: $3" "got:" "$2"; else ok "$1"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got:  $2"; fi; }
RC=0 OUT=""
run() { RC=0; OUT="$("$@" 2>&1)" || RC=$?; }
rc_is() { if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1" "want rc $2, got $RC; output:" "$OUT"; fi; }

# --- sandbox ---------------------------------------------------------------------------------
export HOME="$T/home" FAKE="$T/fake" GIT_CONFIG_GLOBAL="$T/home/.gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
mkdir -p "$HOME" "$FAKE" "$T/bin" "$T/repo/sub" "$T/fleetcfg/repos/acme/app"
unset LEASE_STORE LEASE_OWNER_PATTERN LEASE_POOL_FILE POOL_CLI LEASE_CLI POOL_PROVISION_CMD POOL_RESET_CMD POOL_HEALTH_CMD POOL_NUDGE_CMD
unset FLEET_ID FEDERATION_FILE FEDERATION_CLI FLEET_REPO FLEET_INSTANCE FLEET_INSTANCE_REPO
export TLIB="$LIB" TCFG="$T/fleetcfg/repos/acme/app" TSTORE="$T/store" TPAT='^acme-[a-z0-9][a-z0-9-]{0,62}$'
export POOL_POLL_MS=200 POOL_WAITER_TIMEOUT_MS=30000 BROKER_WINDOW_POLL_SECS=0.2
printf '[user]\n\tname = Sandbox\n\temail = sandbox@example.invalid\n[init]\n\tdefaultBranch = main\n' >"$HOME/.gitconfig"
git -C "$T/repo" init -q
: >"$FAKE/gh.log"; : >"$FAKE/actions.log"

# A stateful stub gh: issues live in $FAKE/gh/issues/<n>/{title,state,body,labels}; every call is logged.
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
ARGS="$*"
D="$FAKE/gh/issues"; mkdir -p "$D"
sub="${1:-} ${2:-}"; shift 2 || true
num="" title="" body="" bodyfile="" addl="" reml=""
[ "$sub" = "api repos/acme/app/issues" ] && :
if [ "${sub%% *}" = issue ] && [ "${sub#* }" != list ] && [ "${sub#* }" != create ]; then num="${1:-}"; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --title) title="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --body-file) bodyfile="$2"; shift 2 ;;
    --add-label) addl="$2"; shift 2 ;;
    --remove-label) reml="$2"; shift 2 ;;
    --jq) jqexpr="$2"; shift 2 ;;
    --json) shift 2 ;;
    *) shift ;;
  esac
done
case "$sub" in
  "label create") exit 0 ;;
  "issue list")
    for d in "$D"/*/; do [ -f "${d}title" ] || continue
      jq -cn --arg n "$(basename "$d")" --arg t "$(cat "${d}title")" --arg s "$(cat "${d}state")" '{number: ($n|tonumber), title: $t, state: $s}'
    done | jq -s . ;;
  "issue create")
    n=$(( 101 + $(ls "$D" | wc -l | tr -d ' ') )); mkdir -p "$D/$n"
    printf '%s' "$title" >"$D/$n/title"; printf '%s\n' "$body" >"$D/$n/body"; printf OPEN >"$D/$n/state"
    echo "https://github.com/acme/app/issues/$n" ;;
  "issue view")
    [ -d "$D/$num" ] || { echo "GraphQL: Could not resolve to an Issue with the number of $num." >&2; exit 1; }
    case "${jqexpr:-}" in
      .state) cat "$D/$num/state" ;;
      .body) cat "$D/$num/body" ;;
    esac ;;
  "issue edit")
    [ -z "$bodyfile" ] || cp "$bodyfile" "$D/$num/body"
    [ -z "$addl" ] || echo "+$addl" >>"$D/$num/labels"
    [ -z "$reml" ] || echo "-$reml" >>"$D/$num/labels"
    # a concurrent writer: the next edit of this issue is overwritten right after it lands
    if [ -f "$FAKE/clobber-$num" ]; then mv "$FAKE/clobber-$num" "$D/$num/body"; fi ;;
  "issue reopen"|"issue close") exit 0 ;;
  "api repos/acme/app/issues/"*) echo "NODE_${sub##*/}" ;;
  "api graphql") # the pin mutation records the node id; the isPinned query reads it back
    [[ "$ARGS" =~ id=(NODE_[0-9]+) ]] || exit 0
    if [[ "$ARGS" == *pinIssue* ]]; then echo "${BASH_REMATCH[1]}" >>"$FAKE/pinned"
    elif [ -f "$FAKE/pinned" ] && grep -qx "${BASH_REMATCH[1]}" "$FAKE/pinned"; then echo true
    else echo false; fi ;;
  api*) exit 0 ;;
esac
exit 0
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

# Stub provision / health commands the pool runs (in the beneficiary's process): they log what they saw.
CFG="$T/fleetcfg/repos/acme/app"
cat >"$CFG/provision-slot.sh" <<'SH'
#!/usr/bin/env bash
echo "${POOL_ACTION:-?} slot=$POOL_SLOT_ID db=$POOL_SLOT_DB arg=${1:-}" >>"$FAKE/actions.log"
SH
cat >"$CFG/check-slot.sh" <<'SH'
#!/usr/bin/env bash
echo "health slot=$POOL_SLOT_ID" >>"$FAKE/actions.log"
[ ! -f "$FAKE/unhealthy" ]
SH
cat >"$CFG/acme-pool.json" <<'JSON'
{
  "name": "acme-pool",
  "bookkeeper": "acme-broker",
  "ttlMinutes": 30,
  "waiterStaleMs": 1500,
  "provision": "bash provision-slot.sh --slot",
  "health": "bash check-slot.sh --slot",
  "grantEnv": { "APP_PORT": "{ports.api}", "DATABASE_URL": "postgresql://acme:acme@localhost:5432/{db}" },
  "slots": [
    { "id": 1, "ports": { "api": 3000, "web": 3001 }, "db": "acme_test_1", "cacheDb": 1 },
    { "id": 2, "ports": { "api": 3100, "web": 3101 }, "db": "acme_test_2", "cacheDb": 2 }
  ]
}
JSON
STORE="$T/store"; STATE="$T/state"; PAT='^acme-[a-z0-9][a-z0-9-]{0,62}$'
write_cfg() { # write_cfg <file> <ledger> [store]
  cat >"$1" <<YML
# resource-broker.yml for the sandbox
repo: acme/app
session_name: acme-broker # advertised in the ledger
ledger_issue: $2
state_dir: $STATE
poll_interval: 1
heartbeat_minutes: 30
stale_lock_minutes: 60
lease:
  pool_file: acme-pool.json   # relative to this file
  store: "${3-$STORE}"
  owner: acme-broker
  owner_pattern: '$PAT'
host:
  health_cmd: 'test -f "\$FAKE/runtime-up"'
  restart_cmd: 'echo restarted >> "\$FAKE/host.log"'
  window_minutes: 5
YML
}
write_cfg "$CFG/resource-broker.yml" 0

pc() { node "$LIB/pool-cli.mjs" "$@" --pool "$CFG/acme-pool.json" --store "$STORE" --owner-pattern "$PAT"; }
slot_of() { jq -r .slot_id <<<"$1"; }
tok_of() { jq -r .token <<<"$1"; }
states() { pc status | jq -r '[.slots[] | "\(.slot_id)=\(.state)"] | join(" ")'; }
release_all_slots() { local s; for s in 1 2; do pc release --slot "$s" --force >/dev/null 2>&1 || true; done; }

# =============================================================================================
echo "== A. config discovery from the fleet config dir"
run bash "$S/broker-config.sh" --config-dir "$T/fleetcfg/repos/acme/app"
rc_is "broker-config finds resource-broker.yml in the fleet config dir" 0
has "…and names it" "$OUT" "config: $CFG/resource-broker.yml"
has "…top-level key" "$OUT" "repo: acme/app"
has "…a trailing comment is stripped" "$OUT" "session_name: acme-broker"
has "…a nested key" "$OUT" "lease.pool_file: acme-pool.json"
has "…a quoted value keeps its content" "$OUT" "lease.store: $STORE"
has "…a single-quoted regex is read whole" "$OUT" "lease.owner_pattern: $PAT"
has "…a host key" "$OUT" "host.window_minutes: 5"
run bash "$S/broker-config.sh" --config-dir "$T/nowhere" repo
rc_is "a fleet config dir without the file is an error" 1
has "…that says so" "$OUT" "no resource-broker.yml in the fleet config dir"
run bash "$S/broker-config.sh" --config "$T/nope.yml"
rc_is "an explicit missing --config is an error" 1
mkdir -p "$T/repo/.claude"
write_cfg "$T/repo/.claude/resource-broker.yml" 7
sed -i.bak 's#^repo: acme/app#repo: acme/in-repo#' "$T/repo/.claude/resource-broker.yml"; rm -f "$T/repo/.claude/resource-broker.yml.bak"
OUT="$(cd "$T/repo" && bash "$S/broker-config.sh" --config-dir "$CFG" repo)"
has "an in-repo .claude/resource-broker.yml wins over the fleet config dir" "$OUT" "repo: acme/in-repo"
rm -rf "$T/repo/.claude"
run bash -c "cd '$T/repo' && bash '$S/broker-heartbeat.sh'"
rc_is "with no config and no flags a script refuses (usage)" 2
run bash -c "cd '$T/repo' && bash '$S/broker-watch.sh' --repo acme/app --ledger 101 --interval 0 --pool '$CFG/acme-pool.json'"
rc_is "a zero poll interval is refused" 2
# a pool file that resolves against the config's directory, from any cwd
OUT="$(cd "$T" && bash "$S/broker-reconcile.sh" --config-dir "$CFG" 2>&1)" && RC=0 || RC=$?
rc_is "the pool file resolves relative to the config, whatever the cwd" 0
has "…and reconcile ran" "$OUT" "RECONCILE reaped=0 dropped=0 held=0 free=2 unknown=0 total=2 queued=0"

echo "== B. setup: labels and the ledger issue, idempotent"
: >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --config-dir "$CFG"
rc_is "setup exits 0" 0
G="$(cat "$FAKE/gh.log")"
has "creates the escalation label" "$G" "gh label create broker:escalated -R acme/app --force"
has "creates the host-window label" "$G" "gh label create broker:host-window -R acme/app --force"
has "looks for an existing ledger first (fail closed)" "$G" "gh issue list -R acme/app --state all"
has "creates the ledger issue" "$G" "gh issue create -R acme/app --title 🛰️ Resource Broker ledger"
has "pins it" "$G" "pinIssue"
has "reports the number" "$OUT" "created ledger issue #101"
has "prints the config lines" "$OUT" "ledger_issue: 101"
has "prints the supervisor conf line" "$OUT" "<ns>-broker|101|60"
BODY="$(cat "$FAKE/gh/issues/101/body")"
has "the ledger body carries the heartbeat block" "$BODY" "<!-- broker-heartbeat -->"
has "…initially 'not running'" "$BODY" "last: never — status: not running"
has "…and states the seam" "$BODY" "It actuates access"
: >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --config-dir "$CFG"
rc_is "a second setup exits 0" 0
has "…finds the existing ledger" "$OUT" "found existing ledger issue #101 (OPEN)"
hasnt "…without creating another" "$(cat "$FAKE/gh.log")" "gh issue create"
printf CLOSED >"$FAKE/gh/issues/101/state"
run bash "$S/broker-setup.sh" --repo acme/app
rc_is "--repo works without any config" 0
has "a closed ledger is flagged as the kill switch" "$OUT" "that is the kill switch"
printf OPEN >"$FAKE/gh/issues/101/state"
mkdir -p "$FAKE/gh/issues/150"; printf '%s' "🛰️ Resource Broker ledger" >"$FAKE/gh/issues/150/title"; printf OPEN >"$FAKE/gh/issues/150/state"
run bash "$S/broker-setup.sh" --repo acme/app
rc_is "two ledgers with the title are refused, never auto-picked" 1
has "…naming both" "$OUT" "#101, #150"
rm -rf "$FAKE/gh/issues/150"
write_cfg "$CFG/resource-broker.yml" 101

echo "== C. heartbeat: the exact line the fleet supervisor parses"
run bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --status "session start"
rc_is "heartbeat exits 0" 0
BODY="$(cat "$FAKE/gh/issues/101/body")"
LINE="$(grep '^last: ' <<<"$BODY")"
if [[ "$LINE" =~ ^last:\ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\ —\ status:\ session\ start$ ]]; then ok "the line is exactly: last: <ISO-8601 UTC> — status: <text>"; else bad "the line is exactly: last: <ISO-8601 UTC> — status: <text>" "got: $LINE"; fi
eq "exactly one heartbeat line" "$(grep -c '^last: ' <<<"$BODY")" 1
has "the markers survive" "$BODY" "<!-- /broker-heartbeat -->"
has "the rest of the body is preserved" "$BODY" "Resource Broker baton"
PARSED="$(printf '%s\n' "$BODY" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1)"   # fleet-supervisor.sh's own parse
eq "the supervisor's parse reads the status" "${PARSED#*|}" "session start"
if [[ "${PARSED%%|*}" =~ ^[0-9TZ:-]+$ ]]; then ok "…and a timestamp it can convert"; else bad "…and a timestamp it can convert" "$PARSED"; fi
has "prints what it wrote" "$OUT" "(session start)"
run bash "$S/broker-heartbeat.sh" --repo acme/app --issue 101 --status 'rotation requested'
BODY="$(cat "$FAKE/gh/issues/101/body")"
has "flags work without a config; 'rotation requested' is written verbatim" "$BODY" "— status: rotation requested"
eq "…replacing, not appending" "$(grep -c '^last: ' <<<"$BODY")" 1
run bash "$S/broker-heartbeat.sh" --repo acme/app --issue 101 --status 'a\nb & c'
eq "a status with backslashes and ampersands is written literally" "$(grep '^last: ' "$FAKE/gh/issues/101/body" | sed 's/^.*status: //')" 'a\nb & c'
cp "$FAKE/gh/issues/101/body" "$T/body.good"
printf 'no markers here\n' >"$FAKE/gh/issues/101/body"
before="$(grep -c 'issue edit' "$FAKE/gh.log" || true)"
run bash "$S/broker-heartbeat.sh" --repo acme/app --issue 101
rc_is "a body without the markers is refused" 1
has "…loudly" "$OUT" "expected exactly one <!-- broker-heartbeat -->"
eq "…and never edited" "$(grep -c 'issue edit' "$FAKE/gh.log" || true)" "$before"
cp "$T/body.good" "$FAKE/gh/issues/101/body"

echo "== C2. setup adopts a configured ledger issue instead of creating one"
mkissue() { # mkissue <n> <state> <body text>: a pre-existing issue under some other title
  mkdir -p "$FAKE/gh/issues/$1"
  printf '%s' "Broker baton (old title)" >"$FAKE/gh/issues/$1/title"; printf '%s' "$2" >"$FAKE/gh/issues/$1/state"
  printf '%s\n' "$3" >"$FAKE/gh/issues/$1/body"
}
nmark() { grep -c -- "$2" <<<"$1" || true; }
write_cfg "$T/adopt.yml" 201
FOREIGN='Ledger for the acme broker.

<!-- acme-heartbeat -->
last: 2026-01-01T12:00:00Z — status: legacy running
<!-- /acme-heartbeat -->

Notes: keep this line.'
mkissue 201 OPEN "$FOREIGN"
mkissue 202 OPEN 'Just a ledger, no heartbeat line anywhere.'
mkissue 203 OPEN 'Head text.
last: 2026-02-02T02:02:02Z — status: plain
Tail text.'
mkissue 204 CLOSED 'closed ledger'
: >"$FAKE/gh.log"; rm -f "$FAKE/pinned"
run bash "$S/broker-setup.sh" --config "$T/adopt.yml"
rc_is "adopting an issue with foreign markers around a heartbeat line exits 0" 0
G="$(cat "$FAKE/gh.log")"
hasnt "…never creating another issue" "$G" "gh issue create"
hasnt "…nor even searching for one by title" "$G" "gh issue list"
has "…says it is adopting #201" "$OUT" "adopting configured ledger issue #201"
has "…and what it did to the body" "$OUT" "wrapped the existing heartbeat line, and the older <!-- acme-heartbeat --> pair around it"
has "…creates the labels" "$G" "gh label create broker:escalated -R acme/app --force"
has "…pins it" "$OUT" "pinned issue #201"
has "…prints the config lines with the adopted number" "$OUT" "ledger_issue: 201"
BODY="$(cat "$FAKE/gh/issues/201/body")"
eq "exactly one broker open marker" "$(nmark "$BODY" '<!-- broker-heartbeat -->')" 1
eq "…and one broker close marker" "$(nmark "$BODY" '<!-- /broker-heartbeat -->')" 1
has "the foreign open marker is kept" "$BODY" "<!-- acme-heartbeat -->"
has "…the foreign close marker" "$BODY" "<!-- /acme-heartbeat -->"
has "…the heartbeat line itself" "$BODY" "last: 2026-01-01T12:00:00Z — status: legacy running"
has "…and the surrounding text" "$BODY" "Notes: keep this line."
has "…and the head text" "$BODY" "Ledger for the acme broker."
ln() { grep -n -x -- "$2" <<<"$1" | head -1 | cut -d: -f1; }
o=$(ln "$BODY" '<!-- broker-heartbeat -->'); fo=$(ln "$BODY" '<!-- acme-heartbeat -->'); fc=$(ln "$BODY" '<!-- /acme-heartbeat -->'); c=$(ln "$BODY" '<!-- /broker-heartbeat -->')
if [ "$o" -lt "$fo" ] && [ "$fo" -lt "$fc" ] && [ "$fc" -lt "$c" ]; then ok "the broker pair wraps the older pair, foreign lines intact inside"; else bad "the broker pair wraps the older pair, foreign lines intact inside" "$BODY"; fi
PARSED="$(printf '%s\n' "$BODY" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1)"   # fleet-supervisor.sh's own parse
eq "the supervisor's parse still reads the adopted line" "$PARSED" "2026-01-01T12:00:00Z|legacy running"
run bash "$S/broker-heartbeat.sh" --config "$T/adopt.yml" --status "adopted"
rc_is "broker-heartbeat.sh now succeeds on the adopted body" 0
BODY="$(cat "$FAKE/gh/issues/201/body")"
PARSED="$(printf '%s\n' "$BODY" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1)"
eq "…and the supervisor's parse reads its line" "${PARSED#*|}" "adopted"
eq "…leaving one broker pair" "$(nmark "$BODY" '<!-- broker-heartbeat -->')/$(nmark "$BODY" '<!-- /broker-heartbeat -->')" "1/1"
has "…and the text outside it" "$BODY" "Notes: keep this line."
# a second run changes nothing
cp "$FAKE/gh/issues/201/body" "$T/body.201"; : >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --config "$T/adopt.yml"
rc_is "a second setup exits 0" 0
has "…reports the body unchanged" "$OUT" "already has the broker heartbeat markers: unchanged"
has "…and the issue already pinned" "$OUT" "issue #201 is already pinned"
G="$(cat "$FAKE/gh.log")"
hasnt "…no body edit" "$G" "gh issue edit"
hasnt "…no create" "$G" "gh issue create"
hasnt "…no second pin" "$G" "pinIssue"
if cmp -s "$T/body.201" "$FAKE/gh/issues/201/body"; then ok "…and the body is byte-identical"; else bad "…and the body is byte-identical"; fi

# no heartbeat line: a pair is appended
write_cfg "$T/adopt2.yml" 202
run bash "$S/broker-setup.sh" --config "$T/adopt2.yml"
rc_is "adopting a body with no heartbeat line exits 0" 0
has "…says it appended a block" "$OUT" "appended a broker heartbeat block"
BODY="$(cat "$FAKE/gh/issues/202/body")"
has "the original text is kept" "$BODY" "Just a ledger, no heartbeat line anywhere."
eq "one broker pair" "$(nmark "$BODY" '<!-- broker-heartbeat -->')/$(nmark "$BODY" '<!-- /broker-heartbeat -->')" "1/1"
has "…with a fresh line, status 'adopted by resource broker'" "$BODY" "— status: adopted by resource broker"
PARSED="$(printf '%s\n' "$BODY" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1)"
eq "…that the supervisor's parse reads" "${PARSED#*|}" "adopted by resource broker"
run bash "$S/broker-heartbeat.sh" --config "$T/adopt2.yml"
rc_is "broker-heartbeat.sh succeeds on it" 0
cp "$FAKE/gh/issues/202/body" "$T/body.202"; : >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --config "$T/adopt2.yml"
if cmp -s "$T/body.202" "$FAKE/gh/issues/202/body" && ! grep -q "issue edit" "$FAKE/gh.log"; then ok "a second run on it is a no-op"; else bad "a second run on it is a no-op"; fi

# a heartbeat line with no enclosing markers; --ledger works without a config
run bash "$S/broker-setup.sh" --repo acme/app --ledger 203
rc_is "--ledger adopts without a config" 0
has "…says it wrapped the line" "$OUT" "wrapped the existing heartbeat line in the broker heartbeat markers"
BODY="$(cat "$FAKE/gh/issues/203/body")"
eq "the line sits between the markers, the rest untouched" "$(printf '%s' "$BODY" | tr '\n' '|')" "Head text.|<!-- broker-heartbeat -->|last: 2026-02-02T02:02:02Z — status: plain|<!-- /broker-heartbeat -->|Tail text."
# a body edited in the web UI has CRLF line endings
mkdir -p "$FAKE/gh/issues/205"; printf 'x' >"$FAKE/gh/issues/205/title"; printf OPEN >"$FAKE/gh/issues/205/state"
printf 'Head\r\n<!-- old -->\r\nlast: 2026-03-03T03:03:03Z — status: crlf\r\n<!-- /old -->\r\nTail\r\n' >"$FAKE/gh/issues/205/body"
run bash "$S/broker-setup.sh" --repo acme/app --ledger 205 --no-pin
rc_is "a CRLF body is adopted" 0
has "…wrapping the older pair too" "$OUT" "the older <!-- old --> pair around it"
run bash "$S/broker-heartbeat.sh" --repo acme/app --issue 205
rc_is "…and the heartbeat then succeeds" 0

# refusals: closed, missing, malformed
: >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --repo acme/app --ledger 204
rc_is "a closed ledger issue is an error" 1
has "…naming the kill switch" "$OUT" "is CLOSED"
run bash "$S/broker-setup.sh" --repo acme/app --ledger 299
rc_is "a missing ledger issue is an error" 1
has "…which says it could not read it" "$OUT" "could not read the configured ledger issue #299"
mkissue 206 OPEN '<!-- broker-heartbeat -->
last: 2026-01-01T00:00:00Z — status: x'
run bash "$S/broker-setup.sh" --repo acme/app --ledger 206
rc_is "a body with an unpaired broker marker is refused" 1
has "…loudly" "$OUT" "expected one pair or none"
run bash "$S/broker-setup.sh" --repo acme/app --ledger abc
rc_is "a non-numeric ledger is a usage error" 2
G="$(cat "$FAKE/gh.log")"
hasnt "none of the refusals created an issue" "$G" "gh issue create"
hasnt "…or edited one" "$G" "gh issue edit"
hasnt "…or created labels first" "$G" "gh label create"
eq "…and the closed issue's body is untouched" "$(cat "$FAKE/gh/issues/204/body")" "closed ledger"

# no ledger configured (empty ledger_issue): create by title, exactly as before
rm -rf "$FAKE/gh/issues/2"??; mv "$FAKE/gh" "$FAKE/gh.saved"; rm -f "$FAKE/pinned"
write_cfg "$T/empty.yml" ""
: >"$FAKE/gh.log"
run bash "$S/broker-setup.sh" --config "$T/empty.yml"
rc_is "an empty ledger_issue still creates by title" 0
G="$(cat "$FAKE/gh.log")"
has "…searching by title first" "$G" "gh issue list -R acme/app --state all"
has "…creating the issue" "$G" "gh issue create -R acme/app --title 🛰️ Resource Broker ledger"
has "…reporting it" "$OUT" "created ledger issue #101"
has "…with the heartbeat block" "$(cat "$FAKE/gh/issues/101/body")" "last: never — status: not running"
run bash "$S/broker-setup.sh" --config "$T/empty.yml"
has "…and a second run finds it" "$OUT" "found existing ledger issue #101 (OPEN)"
has "…already pinned" "$OUT" "issue #101 is already pinned"
rm -rf "$FAKE/gh"; mv "$FAKE/gh.saved" "$FAKE/gh"

echo "== D. watch: a stale grant is reaped, a waiter is seen, silent waiters are dropped"
W="bash $S/broker-watch.sh --config-dir $CFG --once"
rm -rf "$STATE"
run $W
rc_is "the first tick (baseline) exits 0" 0
eq "…and emits nothing for an idle pool" "$OUT" ""
A="$(pc acquire --owner acme-build --no-wait)"
B="$(pc acquire --owner acme-worker --no-wait --ttl 0.02)"   # dies at once: its lease expires in ~1s
eq "two grants take both slots" "$(states | tr ' ' '\n' | sort | paste -sd' ' -)" "1=held 2=held"
has "the grant was provisioned before it was handed out" "$(cat "$FAKE/actions.log")" "provision slot=$(slot_of "$A") db=acme_test_$(slot_of "$A")"
has "…and health-checked" "$(cat "$FAKE/actions.log")" "health slot=$(slot_of "$A")"
sleep 1.6
run $W
rc_is "the next tick exits 0" 0
has "the stale grant is detected and reaped: SLOT_REAPED <slot> <previous owner>" "$OUT" "SLOT_REAPED $(slot_of "$B") acme-worker"
has "a live grant is visible as SLOT_GRANTED" "$OUT" "SLOT_GRANTED $(slot_of "$A") acme-build"
eq "the reap freed the slot" "$(pc status | jq -r --arg s "$(slot_of "$B")" '.slots[] | select((.slot_id|tostring) == $s) | .state')" free
eq "…and only the live grant is still held" "$(pc status | jq '[.slots[] | select(.state == "held")] | length')" 1
run $W
eq "an unchanged pool emits nothing" "$OUT" ""
C="$(pc acquire --owner acme-cache --no-wait)"
run $W
has "a second grant is visible" "$OUT" "SLOT_GRANTED $(slot_of "$C") acme-cache"
REQ="$(pc request --owner acme-agent --session acme-agent)"
WAITERS+=("$(jq -r .waiter_pid <<<"$REQ")")
eq "a saturated pool queues the request at position 1" "$(jq -r .position <<<"$REQ")" 1
run $W
has "watch detects the waiter: WAITER_QUEUED <session> <mode> <position>" "$OUT" "WAITER_QUEUED acme-agent async 1"
kill -9 "$(jq -r .waiter_pid <<<"$REQ")" 2>/dev/null || true
sleep 2
run $W
has "a waiter that went silent is dropped by the pump: QUEUE_DROPPED" "$OUT" "QUEUE_DROPPED 1"
eq "…and the queue is empty" "$(pc status | jq '.queue | length')" 0
run $W
has "a released slot is announced" "$(pc release --slot "$(slot_of "$C")" --owner acme-cache --token "$(tok_of "$C")" >/dev/null; $W 2>&1)" "SLOT_RELEASED $(slot_of "$C")"

echo "== E. a grant nudge reaches a waiting session"
C="$(pc acquire --owner acme-cache --no-wait)"
$W >/dev/null 2>&1
: >"$FAKE/actions.log"
REQ="$(pc request --owner acme-agent --session acme-agent)"
RID="$(jq -r .request_id <<<"$REQ")"
WAITERS+=("$(jq -r .waiter_pid <<<"$REQ")")
run $W
has "the waiter is seen queued" "$OUT" "WAITER_QUEUED acme-agent async 1"
pc release --slot "$(slot_of "$C")" --owner acme-cache --token "$(tok_of "$C")" >/dev/null
NUDGES="$STORE/acme-pool/nudges.jsonl"
for _ in $(seq 1 50); do [ -s "$NUDGES" ] && break; sleep 0.2; done
if [ -s "$NUDGES" ]; then ok "the detached waiter granted itself and appended a nudge"; else bad "the detached waiter granted itself and appended a nudge"; fi
run $W
NUDGE_LINE="$(grep '^NUDGE ' <<<"$OUT" || true)"
has "watch relays: NUDGE <session> <json>" "$NUDGE_LINE" "NUDGE acme-agent {"
has "…naming the event" "$NUDGE_LINE" '"event":"lease-granted"'
has "…the session" "$NUDGE_LINE" '"session":"acme-agent"'
has "…the request id the session can claim with" "$NUDGE_LINE" "\"request_id\":\"$RID\""
hasnt "…and never the fencing token" "$NUDGE_LINE" "token"
hasnt "…nor the grant env" "$NUDGE_LINE" "DATABASE_URL"
run $W
hasnt "a nudge is relayed once (the cursor advances)" "$OUT" "NUDGE"
CLAIM="$(pc claim --request "$RID" --owner acme-agent)"
eq "the waiting session claims the durable grant the nudge pointed at" "$(jq -r .state <<<"$CLAIM")" ready
has "…provisioned on grant" "$(cat "$FAKE/actions.log")" "provision slot=$(jq -r .slot_id <<<"$CLAIM")"
# a fresh state dir starts at the end of the nudge history instead of replaying it
STATE_BAK="$STATE"; STATE="$T/state2"; write_cfg "$CFG/resource-broker.yml" 101
run $W
hasnt "a first run (no cursor) never replays old nudges" "$OUT" "NUDGE"
eq "…it starts at the end of the file" "$(cat "$STATE/.watch/nudge.cursor")" "$(wc -l <"$NUDGES" | tr -d ' ')"
STATE="$STATE_BAK"; write_cfg "$CFG/resource-broker.yml" 101
release_all_slots

echo "== F. the kill switch and a blind pump"
printf CLOSED >"$FAKE/gh/issues/101/state"
run $W
has "a closed ledger makes the watcher say STOP" "$OUT" "STOP"
rc_is "…and exit 0" 0
printf OPEN >"$FAKE/gh/issues/101/state"
cat >"$T/badpool-cli.mjs" <<'JS'
process.stderr.write("boom: pool unavailable\n");
process.exit(3);
JS
run env POOL_CLI="$T/badpool-cli.mjs" $W
has "a failing pump is reported (not silently an empty pool): PUMP_FAILED" "$OUT" "PUMP_FAILED boom: pool unavailable"
cat >"$T/okpool-cli.mjs" <<'JS'
process.stdout.write(JSON.stringify({ ok: true, reapedSlots: [], droppedEntries: [], status: { ok: true, poolDir: process.env.STUB_POOL_DIR, slots: [{ slot_id: "a", kind: "slot-a", attrs: {}, state: "free", holder: null }], queue: [] } }) + "\n");
JS
run env POOL_CLI="$T/okpool-cli.mjs" $W
eq "POOL_CLI overrides the CLI location (a stub CLI is used, string slot ids are fine)" "$OUT" ""
run env POOL_CLI="$T/nowhere.mjs" $W
rc_is "a POOL_CLI that does not exist is a usage-level error" 2
has "…naming it" "$OUT" "pool CLI not found at $T/nowhere.mjs"

echo "== G. reconcile classifies state after a crash"
rm -rf "$STORE" "$STATE"
: >"$FAKE/actions.log"
A="$(pc acquire --owner acme-build --no-wait)"                     # alive: heartbeating
B="$(pc acquire --owner acme-crashed --no-wait --ttl 0.02)"        # died mid-run: lease expires in ~1s
REQ="$(pc request --owner acme-agent --session acme-agent)"        # a waiter that then died too
kill -9 "$(jq -r .waiter_pid <<<"$REQ")" 2>/dev/null || true
OUTSIDER='^outsider$'
LEASE_OWNER_PATTERN="$OUTSIDER" node "$LIB/lease-cli.mjs" acquire --kind other-tool --owner outsider --ttl 0.001 --store "$STORE" >/dev/null
sleep 2
run bash "$S/broker-reconcile.sh" --config-dir "$CFG"
rc_is "reconcile exits 0" 0
has "it reaped the dead slot lease" "$OUT" "reaped 1 dead lease(s)"
has "…and dropped the silent waiter" "$OUT" "dropped 1 stale queue entry(ies) on startup"
has "…and the summary line is machine-readable" "$OUT" "RECONCILE reaped=1 dropped=1 held=1 free=1 unknown=0 total=2 queued=0"
has "the live lease is classified held, with its holder" "$OUT" "slot $(slot_of "$A") (slot-$(slot_of "$A")): held by acme-build"
has "the reaped slot is classified free" "$OUT" "slot $(slot_of "$B") (slot-$(slot_of "$B")): free"
has "a record outside the owner fence is reported, never touched" "$OUT" "other-tool"
if [ -f "$STORE/other-tool.json" ]; then ok "…the foreign lease file is still there"; else bad "…the foreign lease file is still there"; fi
eq "the pool agrees" "$(states)" "$(if [ "$(slot_of "$A")" = 1 ]; then echo '1=held 2=free'; else echo '1=free 2=held'; fi)"
run bash "$S/broker-reconcile.sh" --config-dir "$CFG"
has "a second reconcile is a no-op" "$OUT" "RECONCILE reaped=0 dropped=0 held=1 free=1 unknown=0 total=2 queued=0"
# a pool that cannot be read is a hard stop, never a fabricated empty pool
echo '{ not json' >"$T/broken-pool.json"
run bash "$S/broker-reconcile.sh" --config-dir "$CFG" --pool "$T/broken-pool.json"
rc_is "an unreadable pool makes reconcile a hard stop" 1
has "…refusing to fabricate an empty pool" "$OUT" "refusing to report a fabricated empty pool state"
hasnt "…and printing no summary line" "$OUT" "RECONCILE reaped"
run bash "$S/broker-reconcile.sh" --config-dir "$CFG" --pool "$T/no-such-pool.json"
rc_is "a missing pool file is refused" 1
release_all_slots

echo "== H. the default store is <git toplevel>/logs/leases, from any subdirectory"
write_cfg "$T/nostore.yml" 101 ""
cp "$CFG/acme-pool.json" "$CFG/provision-slot.sh" "$CFG/check-slot.sh" "$T/"
sed -i.bak "s#^  pool_file: .*#  pool_file: $T/acme-pool.json#" "$T/nostore.yml"; rm -f "$T/nostore.yml.bak"
run bash -c "cd '$T/repo/sub' && bash '$S/broker-reconcile.sh' --config '$T/nostore.yml'"
rc_is "reconcile from a subdirectory with no configured store" 0
if [ -d "$T/repo/logs/leases/acme-pool" ]; then ok "the store is at the git toplevel"; else bad "the store is at the git toplevel" "$(find "$T/repo" -name logs -not -path '*/.git/*')"; fi
if [ ! -e "$T/repo/sub/logs" ]; then ok "…and not beside the subdirectory"; else bad "…and not beside the subdirectory"; fi

echo "== H2. lease.store: a leading ~ expands, a relative path resolves against the config's directory"
mkdir -p "$T/cwdx" "$T/cfgrel"
release_all_slots; touch "$FAKE/runtime-up" # the host window (health_cmd) needs the runtime up; it drains an idle pool
cp "$CFG/acme-pool.json" "$CFG/provision-slot.sh" "$CFG/check-slot.sh" "$T/cfgrel/"
# shellcheck disable=SC2088 # the literal ~ is the point: the config holds it unexpanded
write_cfg "$T/cfgrel/tilde.yml" 101 '~/tilde-store'
write_cfg "$T/cfgrel/rel.yml" 101 'rel-store'
write_cfg "$T/cfgrel/dotrel.yml" 101 './sub/dot-store'
for how in reconcile host-window watch; do
  rm -rf "$HOME/tilde-store" "$T/cfgrel/rel-store" "$T/cfgrel/sub"
  case "$how" in
    reconcile) cmd="bash '$S/broker-reconcile.sh'" ;;
    watch) cmd="bash '$S/broker-watch.sh' --once" ;;
    host-window) cmd="bash '$S/broker-host-window.sh' --restart-cmd 'true' --reason t" ;;
  esac
  run bash -c "cd '$T/cwdx' && $cmd --config '$T/cfgrel/tilde.yml'"
  rc_is "$how: a ~/… lease.store runs" 0
  if [ -d "$HOME/tilde-store/acme-pool" ]; then ok "$how: ~/tilde-store resolves under \$HOME"; else bad "$how: ~/tilde-store resolves under \$HOME" "$OUT"; fi
  if [ ! -e "$T/cwdx/~" ] && [ ! -e "$T/cfgrel/~" ]; then ok "$how: no directory named ~ is created"; else bad "$how: no directory named ~ is created" "$(ls -a "$T/cwdx" "$T/cfgrel")"; fi
  run bash -c "cd '$T/cwdx' && $cmd --config '$T/cfgrel/rel.yml'"
  rc_is "$how: a relative lease.store runs" 0
  if [ -d "$T/cfgrel/rel-store/acme-pool" ]; then ok "$how: rel-store resolves against the config's directory"; else bad "$how: rel-store resolves against the config's directory" "$OUT"; fi
  if [ ! -e "$T/cwdx/rel-store" ]; then ok "$how: …not against the cwd"; else bad "$how: …not against the cwd"; fi
done
run bash -c "cd '$T/cwdx' && bash '$S/broker-reconcile.sh' --config '$T/cfgrel/dotrel.yml'"
if [ -d "$T/cfgrel/./sub/dot-store/acme-pool" ]; then ok "a ./sub/… lease.store resolves against the config's directory"; else bad "a ./sub/… lease.store resolves against the config's directory" "$OUT"; fi
# an explicit --store still wins, verbatim
rm -rf "$T/flag-store" "$HOME/tilde-store"
run bash -c "cd '$T/cwdx' && bash '$S/broker-reconcile.sh' --config '$T/cfgrel/tilde.yml' --store '$T/flag-store'"
if [ -d "$T/flag-store/acme-pool" ] && [ ! -e "$HOME/tilde-store" ]; then ok "--store beats lease.store"; else bad "--store beats lease.store" "$OUT"; fi
rm -rf "$HOME/tilde-store"; rm -f "$FAKE/runtime-up" "$FAKE/host.log"

echo "== I. host window: drain, lock, act, verify, all-clear"
release_all_slots; rm -f "$FAKE/host.log" "$FAKE/runtime-up"
H="bash $S/broker-host-window.sh --config-dir $CFG"
: >"$FAKE/gh.log"
run $H --dry-run
rc_is "--dry-run exits 0" 0
has "…lists the slots it would drain" "$OUT" "would drain and lock: slot-1 slot-2"
has "…the restart it would run" "$OUT" "would run: echo restarted"
if [ ! -e "$FAKE/host.log" ]; then ok "…and touches nothing"; else bad "…and touches nothing"; fi
run $H --restart-cmd "runtime delete"
rc_is "a restart command that reads as destructive is refused" 2
has "…for the hard rule" "$OUT" "refusing a restart command that reads as destructive"
run $H --restart-cmd "docker system prune -af"
rc_is "…a prune too" 2
sed 's#^  restart_cmd: .*#  restart_cmd: ""#' "$CFG/resource-broker.yml" >"$T/no-host.yml"
run bash "$S/broker-host-window.sh" --config "$T/no-host.yml"
rc_is "with no restart command there is no host window" 2
has "…which says so" "$OUT" "a host-tier action is not configured"
# happy path; the restart command records who holds the slots at the moment it runs (everything drained)
touch "$FAKE/runtime-up"
run $H --reason "directed by acme-maintain" --restart-cmd 'node "$TLIB/pool-cli.mjs" status --pool "$TCFG/acme-pool.json" --store "$TSTORE" --owner-pattern "$TPAT" > "$FAKE/during.json"'
rc_is "a window on an idle pool exits 0" 0
has "it reports the fleet drained" "$OUT" "WINDOW_LOCKED"
has "…the restart" "$OUT" "WINDOW_ACTED"
has "…the verified health" "$OUT" "WINDOW_HEALTHY"
has "…and the all-clear last" "$OUT" "WINDOW_ALL_CLEAR"
eq "the events come in order" "$(grep -o 'WINDOW_[A-Z_]*' <<<"$OUT" | paste -sd' ' -)" "WINDOW_LOCKED WINDOW_ACTED WINDOW_HEALTHY WINDOW_ALL_CLEAR"
eq "during the restart the broker held every slot" "$(jq -r '[.slots[] | .holder] | unique | join(",")' "$FAKE/during.json")" "acme-broker"
eq "…all of them" "$(jq '[.slots[] | select(.state == "held")] | length' "$FAKE/during.json")" 2
eq "after the all-clear every slot is free" "$(states)" "1=free 2=free"
G="$(cat "$FAKE/gh.log")"
has "the ledger carried the host-window label for the window" "$G" "gh issue edit 101 -R acme/app --add-label broker:host-window"
has "…and lost it at the all-clear" "$G" "gh issue edit 101 -R acme/app --remove-label broker:host-window"
# the configured restart command runs by default
run $H
rc_is "the configured restart and health commands run by default" 0
has "…the restart ran" "$(cat "$FAKE/host.log")" "restarted"
# a held slot delays the drain; the drain times out and nothing is left locked
A="$(pc acquire --owner acme-build --no-wait)"
run $H --drain-timeout-secs 1
rc_is "a window that cannot drain aborts" 1
has "…says who it was waiting on" "$OUT" "WINDOW_DRAINING slot-$(slot_of "$A") acme-build"
has "…with the reason" "$OUT" "WINDOW_ABORTED drain_timeout"
eq "…and releases what it had locked (only the live lessee still holds)" "$(pc status | jq -r '[.slots[] | select(.state == "held") | .holder] | join(",")')" "acme-build"
pc release --slot "$(slot_of "$A")" --owner acme-build --token "$(tok_of "$A")" >/dev/null
# a slot released during the drain lets the window proceed
A="$(pc acquire --owner acme-build --no-wait)"
( sleep 1; pc release --slot "$(slot_of "$A")" --owner acme-build --token "$(tok_of "$A")" >/dev/null ) &
REL=$!
run $H --drain-timeout-secs 10
wait "$REL"
rc_is "a slot released mid-drain lets the window complete" 0
has "…after draining it" "$OUT" "WINDOW_DRAINING slot-$(slot_of "$A") acme-build"
has "…to the all-clear" "$OUT" "WINDOW_ALL_CLEAR"
# failure paths never leave the pool locked
run $H --restart-cmd "exit 3"
rc_is "a failing restart aborts the window" 1
has "…as restart_failed" "$OUT" "WINDOW_ABORTED restart_failed"
eq "…leaving every slot free" "$(states)" "1=free 2=free"
rm -f "$FAKE/runtime-up"
run $H --health-timeout-secs 1
rc_is "a runtime that never comes back healthy aborts" 1
has "…as unhealthy" "$OUT" "WINDOW_ABORTED unhealthy"
eq "…leaving every slot free" "$(states)" "1=free 2=free"
sed 's#^  health_cmd: .*#  health_cmd: ""#' "$CFG/resource-broker.yml" >"$T/no-health.yml"
run bash "$S/broker-host-window.sh" --config "$T/no-health.yml" --restart-cmd "true"
rc_is "with no health command the window verifies nothing and completes" 0
has "…still reaching the all-clear" "$OUT" "WINDOW_ALL_CLEAR"
eq "the window's leases are gone from the store" "$(pc status | jq '[.slots[] | select(.state != "free")] | length')" 0

echo "== K. multi-fleet: the fleet's status issue is the ledger, owners are fleet-qualified"
INST="$T/instance"; mkdir -p "$INST"
cat >"$INST/federation.yml" <<'YML'
version: 1
fleets:
  alice:
    status_issue: 11
  bob:
    status_issue: 12
  carol:
    enabled: true
YML
# The status issues as the supervisor (#58) leaves them: a fleet-heartbeat block, no broker block yet.
mkstatus() { # mkstatus <n> <fleet>
  mkdir -p "$FAKE/gh/issues/$1"; printf '%s' "Fleet $2 status" >"$FAKE/gh/issues/$1/title"; printf OPEN >"$FAKE/gh/issues/$1/state"
  printf 'Status of fleet %s.\n\n<!-- fleet-heartbeat -->\nlast: 2026-10-04T12:00:00Z — status: 3 up, 0 down\n<!-- /fleet-heartbeat -->\n' "$2" >"$FAKE/gh/issues/$1/body"
}
mkstatus 11 alice; mkstatus 12 bob
block() { awk -v m="$2" '$0 == "<!-- " m " -->" { on = 1; next } $0 == "<!-- /" m " -->" { on = 0 } on' <<<"$1" | sed -n 's/^last: \([0-9TZ:-]*\) — status: \(.*\)$/\1|\2/p' | head -1; }  # fleet-supervisor.sh's marker parse
write_cfg "$CFG/resource-broker.yml" 101
LEDGER_BEFORE="$(cat "$FAKE/gh/issues/101/body")"
AS_ALICE=(env FLEET_ID=alice FEDERATION_FILE="$INST/federation.yml" FLEET_INSTANCE_REPO=acme/acme-fleet)
AS_BOB=(env FLEET_ID=bob FEDERATION_FILE="$INST/federation.yml" FLEET_INSTANCE_REPO=acme/acme-fleet)

run "${AS_ALICE[@]}" bash "$S/broker-config.sh" --config-dir "$CFG"
rc_is "broker-config resolves multi-fleet mode" 0
has "…says so" "$OUT" "mode: multi-fleet (fleet alice)"
has "…the ledger is alice's status issue in the instance repo" "$OUT" "effective ledger: acme/acme-fleet#11"
has "…the owner is fleet-qualified" "$OUT" "effective owner: alice-acme-broker"
has "…and so is the fence" "$OUT" "effective owner_pattern: ^alice-acme-[a-z0-9][a-z0-9-]{0,62}\$"
has "…while the shared config still says ledger_issue 101" "$OUT" "ledger_issue: 101"
run bash "$S/broker-config.sh" --config-dir "$CFG"
has "single-fleet mode with the same config" "$OUT" "mode: single-fleet"
has "…keeps the configured ledger" "$OUT" "effective ledger: acme/app#101"
has "…and the unqualified owner" "$OUT" "effective owner: acme-broker"
run env FLEET_ID=alice FEDERATION_FILE="$T/no-such/federation.yml" bash "$S/broker-config.sh" --config-dir "$CFG"
has "FLEET_ID with no federation file is still single-fleet" "$OUT" "effective ledger: acme/app#101"

: >"$FAKE/gh.log"
run "${AS_ALICE[@]}" bash "$S/broker-setup.sh" --config-dir "$CFG"
rc_is "setup in multi-fleet mode exits 0" 0
G="$(cat "$FAKE/gh.log")"
has "…adopts the status issue" "$OUT" "adopting configured ledger issue #11"
has "…reading it from the instance repo" "$G" "gh issue view 11 -R acme/acme-fleet"
has "…creates the labels there" "$G" "gh label create broker:host-window -R acme/acme-fleet --force"
hasnt "…never creates an issue" "$G" "gh issue create"
hasnt "…never pins the fleet's issue" "$G" "pinIssue"
hasnt "…never touches the shared ledger" "$G" "issue edit 101"
has "…says nothing needs pasting" "$OUT" "multi-fleet: nothing to paste"
BODY="$(cat "$FAKE/gh/issues/11/body")"
has "…appends a broker block" "$OUT" "appended a broker heartbeat block to the status issue"
eq "the fleet-heartbeat block is left alone, not wrapped" "$(block "$BODY" fleet-heartbeat)" "2026-10-04T12:00:00Z|3 up, 0 down"
eq "…and the broker block reads separately" "$(block "$BODY" broker-heartbeat | cut -d'|' -f2)" "adopted by resource broker"
o=$(ln "$BODY" '<!-- broker-heartbeat -->'); fc=$(ln "$BODY" '<!-- /fleet-heartbeat -->')
if [ "$o" -gt "$fc" ]; then ok "…after the fleet-heartbeat block, not around it"; else bad "…after the fleet-heartbeat block, not around it" "$BODY"; fi
cp "$FAKE/gh/issues/11/body" "$T/body.11"; : >"$FAKE/gh.log"
run "${AS_ALICE[@]}" bash "$S/broker-setup.sh" --config-dir "$CFG"
if cmp -s "$T/body.11" "$FAKE/gh/issues/11/body" && ! grep -q "issue edit" "$FAKE/gh.log"; then ok "a second multi-fleet setup is a no-op"; else bad "a second multi-fleet setup is a no-op" "$(cat "$FAKE/gh.log")"; fi

run "${AS_ALICE[@]}" bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --status "alice working"
rc_is "heartbeat in multi-fleet mode exits 0" 0
BODY="$(cat "$FAKE/gh/issues/11/body")"
eq "it lands in the broker block of alice's status issue" "$(block "$BODY" broker-heartbeat | cut -d'|' -f2)" "alice working"
eq "…leaving the supervisor's fleet-heartbeat line as it was" "$(block "$BODY" fleet-heartbeat)" "2026-10-04T12:00:00Z|3 up, 0 down"
if [ "$(cat "$FAKE/gh/issues/101/body")" = "$LEDGER_BEFORE" ]; then ok "…and the shared ledger #101 is untouched"; else bad "…and the shared ledger #101 is untouched"; fi

echo "== K2. two fleets' brokers, each on its own host, never interfere"
run "${AS_BOB[@]}" bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --status "bob working"
rc_is "bob's first heartbeat exits 0 with no setup run" 0
B12="$(cat "$FAKE/gh/issues/12/body")"; B11="$(cat "$FAKE/gh/issues/11/body")"
eq "…appending its broker block to bob's status issue" "$(block "$B12" broker-heartbeat | cut -d'|' -f2)" "bob working"
eq "…beside bob's fleet-heartbeat" "$(block "$B12" fleet-heartbeat)" "2026-10-04T12:00:00Z|3 up, 0 down"
eq "alice's broker heartbeat is not bob's" "$(block "$B11" broker-heartbeat | cut -d'|' -f2)" "alice working"
run "${AS_ALICE[@]}" bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --status "rotation requested"
eq "alice rotating does not change bob's block" "$(block "$(cat "$FAKE/gh/issues/12/body")" broker-heartbeat | cut -d'|' -f2)" "bob working"
eq "…only alice's" "$(block "$(cat "$FAKE/gh/issues/11/body")" broker-heartbeat | cut -d'|' -f2)" "rotation requested"
# Each host's store: the same shared config, a different lease.store per host.
SA="$T/store-alice" SB="$T/store-bob"
run "${AS_ALICE[@]}" bash "$S/broker-reconcile.sh" --config-dir "$CFG" --store "$SA"
rc_is "alice's reconcile runs with the qualified fence" 0
run "${AS_BOB[@]}" bash "$S/broker-reconcile.sh" --config-dir "$CFG" --store "$SB"
rc_is "bob's too" 0
touch "$FAKE/runtime-up"
HOLD='node "$TLIB/pool-cli.mjs" status --pool "$TCFG/acme-pool.json" --store "$WSTORE" > "$FAKE/during-$WHO.json"'
run "${AS_ALICE[@]}" WSTORE="$SA" WHO=alice bash "$S/broker-host-window.sh" --config-dir "$CFG" --store "$SA" --restart-cmd "$HOLD"
rc_is "alice's host window completes" 0
eq "…holding every slot as alice-acme-broker" "$(jq -r '[.slots[] | .holder] | unique | join(",")' "$FAKE/during-alice.json")" "alice-acme-broker"
has "…labelling alice's status issue for the window" "$(cat "$FAKE/gh.log")" "gh issue edit 11 -R acme/acme-fleet --add-label broker:host-window"
A="$(node "$LIB/pool-cli.mjs" acquire --owner bob-acme-build --no-wait --pool "$CFG/acme-pool.json" --store "$SB" --owner-pattern '^bob-acme-[a-z0-9][a-z0-9-]{0,62}$')"
run "${AS_ALICE[@]}" WSTORE="$SA" WHO=alice2 bash "$S/broker-host-window.sh" --config-dir "$CFG" --store "$SA" --drain-timeout-secs 2 --restart-cmd "$HOLD"
rc_is "a slot held on bob's host never blocks alice's window" 0
eq "bob's lessee still holds its slot" "$(node "$LIB/pool-cli.mjs" status --pool "$CFG/acme-pool.json" --store "$SB" | jq -r '[.slots[] | select(.state == "held") | .holder] | join(",")')" "bob-acme-build"
node "$LIB/pool-cli.mjs" release --slot "$(slot_of "$A")" --owner bob-acme-build --token "$(tok_of "$A")" --pool "$CFG/acme-pool.json" --store "$SB" --owner-pattern '^bob-acme-[a-z0-9][a-z0-9-]{0,62}$' >/dev/null
run "${AS_BOB[@]}" bash "$S/broker-reconcile.sh" --config-dir "$CFG" --store "$SB" --owner bob-acme-x --owner-pattern '^alice-acme-[a-z0-9-]+$'
rc_is "a fence that does not admit the owner is refused (flags are taken as given)" 1
printf CLOSED >"$FAKE/gh/issues/11/state"
OUT="$("${AS_ALICE[@]}" bash "$S/broker-watch.sh" --config-dir "$CFG" --store "$SA" --once 2>&1)"
has "closing alice's status issue is alice's broker kill switch" "$OUT" "STOP"
OUT="$("${AS_BOB[@]}" bash "$S/broker-watch.sh" --config-dir "$CFG" --store "$SB" --once 2>&1)"
hasnt "…not bob's" "$OUT" "STOP"
printf OPEN >"$FAKE/gh/issues/11/state"

echo "== K3. opt-outs, flags, the concurrent writer, and the fail-closed cases"
sed 's#^  owner_pattern: .*#&\n  fleet_qualify: false#' "$CFG/resource-broker.yml" >"$CFG/noqual.yml"
run "${AS_ALICE[@]}" bash "$S/broker-config.sh" --config "$CFG/noqual.yml"
has "lease.fleet_qualify: false keeps the owner as configured" "$OUT" "effective owner: acme-broker"
has "…and the fence" "$OUT" "effective owner_pattern: $PAT"
has "…while the ledger is still the status issue" "$OUT" "effective ledger: acme/acme-fleet#11"
run "${AS_ALICE[@]}" bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --repo acme/app --issue 101 --status "by flag"
has "--repo/--issue win over the status issue" "$(cat "$FAKE/gh/issues/101/body")" "— status: by flag"
cp "$T/body.good" "$FAKE/gh/issues/101/body"; LEDGER_BEFORE="$(cat "$FAKE/gh/issues/101/body")"
cp "$FAKE/gh/issues/11/body" "$FAKE/clobber-11"
run "${AS_ALICE[@]}" BROKER_HEARTBEAT_RETRY_SECS=0 bash "$S/broker-heartbeat.sh" --config-dir "$CFG" --status "after a race"
rc_is "a heartbeat overwritten by a concurrent edit is retried" 0
has "…saying so" "$OUT" "lost to a concurrent edit of acme/acme-fleet#11, retrying"
eq "…and it sticks" "$(block "$(cat "$FAKE/gh/issues/11/body")" broker-heartbeat | cut -d'|' -f2)" "after a race"
: >"$FAKE/gh.log"
run env FLEET_ID=carol FEDERATION_FILE="$INST/federation.yml" FLEET_INSTANCE_REPO=acme/acme-fleet bash "$S/broker-heartbeat.sh" --config-dir "$CFG"
rc_is "a fleet with no status_issue: heartbeat refuses" 1
has "…naming the gap" "$OUT" "fleets.carol.status_issue is not declared"
has "…and never falls back to the shared ledger" "$OUT" "not falling back to the shared ledger_issue"
run env FLEET_ID=dave FEDERATION_FILE="$INST/federation.yml" FLEET_INSTANCE_REPO=acme/acme-fleet bash "$S/broker-watch.sh" --config-dir "$CFG" --once
rc_is "a FLEET_ID the registry does not declare: watch refuses" 2
has "…naming it" "$OUT" "FLEET_ID \"dave\" is not declared"
run env FLEET_ID=alice FEDERATION_FILE="$INST/federation.yml" bash "$S/broker-setup.sh" --config-dir "$CFG"
rc_is "no instance repo to be found: setup refuses" 1
has "…saying how to name it" "$OUT" "set FLEET_INSTANCE_REPO=owner/name"
printf 'version: 1\nfleets: [unterminated\n' >"$T/bad-federation.yml"
run env FLEET_ID=alice FEDERATION_FILE="$T/bad-federation.yml" bash "$S/broker-reconcile.sh" --config-dir "$CFG" --store "$SA"
rc_is "an unreadable registry: reconcile refuses" 1
eq "none of them touched GitHub" "$(grep -c 'issue edit' "$FAKE/gh.log" || true)" 0
if [ "$(cat "$FAKE/gh/issues/101/body")" = "$LEDGER_BEFORE" ]; then ok "…least of all the shared ledger"; else bad "…least of all the shared ledger"; fi
rm -f "$FAKE/runtime-up"

echo "== J. scripts are shellcheck-clean and parse"
for f in "$S"/*.sh; do
  if bash -n "$f"; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
  if command -v shellcheck >/dev/null 2>&1; then
    if sc="$(shellcheck -S warning -x "$f" 2>&1)"; then ok "shellcheck $(basename "$f")"; else bad "shellcheck $(basename "$f")" "$sc"; fi
  fi
done
command -v shellcheck >/dev/null 2>&1 || echo "  skip shellcheck (not installed)"

# =============================================================================================
pass="$(wc -l <"$T/pass.log" | tr -d ' ')"; fail="$(wc -l <"$T/fail.log" | tr -d ' ')"
echo
echo "broker.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
