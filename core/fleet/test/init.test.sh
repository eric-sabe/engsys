#!/usr/bin/env bash
# init.test.sh — tests for `engsys fleet init` and its scaffold (run by `npm test`; no network, no real tmux/gh).
#
# 1. Scaffold checks: init into temp dirs with the full options (instance marketplace, GitHub App,
#    Azure) and the minimal ones (none, none): the exact file set, no leftover {{…}} tokens, the
#    fleet kit's __NAME__ tokens surviving unrendered, JSON that parses, bash -n and shellcheck on the
#    shim and the hook, and the --force / --dry-run / validation behavior.
# 2. The instance-plugin hook: what it injects, and that it fails open.
# 3. The most important part: run the REAL fleet kit against each scaffold — `fleet launch` with stub
#    tmux/claude (as fleet.test.sh does), `fleet supervise`, `fleet install-jobs --dry-run` — and prove
#    the rendered roster, env files, supervisor conf and job plists come out complete (no unset __NAME__).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_SRC="$(cd "$HERE/.." && pwd -P)"       # core/fleet
CORE_SRC="$(cd "$KIT_SRC/.." && pwd -P)"   # core
ROOT_SRC="$(cd "$CORE_SRC/.." && pwd -P)"  # the engsys repo root (has ./install)
T="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() { rm -rf "$T"; }
trap cleanup EXIT

REAL_CLAUDE="$(command -v claude 2>/dev/null || true)"   # for `claude plugin validate`, before the stub shadows it

: >"$T/pass.log"; : >"$T/fail.log"
ok() { echo . >>"$T/pass.log"; echo "  ok   $1"; }
bad() { echo . >>"$T/fail.log"; echo "  FAIL $1"; shift; if [ $# -gt 0 ]; then printf '%s\n' "$@" | sed 's/^/         /'; fi; }
has() { if grep -Fq -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "want: $3" "got:" "$2"; fi; }
hasnt() { if grep -Fq -- "$3" <<<"$2"; then bad "$1" "did not want: $3" "got:" "$2"; else ok "$1"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got:  $2"; fi; }
RC=0 OUT=""
run() { RC=0; OUT="$("$@" 2>&1)" || RC=$?; }
rc_is() { if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1" "want rc $2, got $RC; output:" "$OUT"; fi; }
file_has() { # file_has <desc> <file> <fixed substring>
  if grep -Fq -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1" "want: $3" "in $2:" "$(cat "$2" 2>/dev/null || echo '(missing)')"; fi
}
file_hasnt() {
  if grep -Fq -- "$3" "$2" 2>/dev/null; then bad "$1" "did not want: $3" "in $2:" "$(cat "$2")"; else ok "$1"; fi
}
file_list() { (cd "$1" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | paste -sd' ' -); }

# --- sandbox environment ---------------------------------------------------------------------
export HOME="$T/home" FAKE="$T/fake" GIT_CONFIG_GLOBAL="$T/home/.gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
mkdir -p "$HOME/.config/acme" "$HOME/git" "$T/bin" "$FAKE"
unset FLEET_INSTANCE ENGSYS_REF INSTANCE_REF PIN_SETTINGS GH_TOKEN GITHUB_TOKEN FLEET_CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR TMUX_SESSION LOG_DIR CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR
export GH_APP_API_URL="http://127.0.0.1:9"   # the identity preflight must never reach a real network
cat >"$HOME/.gitconfig" <<EOF
[user]
	name = Sandbox
	email = sandbox@example.invalid
[init]
	defaultBranch = main
[commit]
	gpgsign = false
[tag]
	gpgsign = false
EOF
: >"$FAKE/tmux.log"; : >"$FAKE/gh.log"; : >"$FAKE/claude.log"

# Stubs, the same shape as in fleet.test.sh. The tmux stub keeps windows and command lines in files.
cat >"$T/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "claude $*" >>"$FAKE/claude.log"
exit 0
SH
cat >"$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
F="$FAKE/tmux"; mkdir -p "$F"; touch "$F/windows"
{ printf 'tmux'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >>"$FAKE/tmux.log"
sub="${1:-}"; shift || true
t="" nm="" prev=""
for a in "$@"; do
  case "$prev" in -t) t="$a" ;; -n) nm="$a" ;; esac
  prev="$a"
done
w="${t#*:}"
add_window() { grep -Fxq "$1" "$F/windows" || echo "$1" >>"$F/windows"; echo node >"$F/cmd-$1"; }
case "$sub" in
  list-windows) cat "$F/windows" ;;
  list-panes) cat "$F/cmd-$w" 2>/dev/null || exit 1 ;;
  capture-pane) cat "$F/cap-$w" 2>/dev/null || true ;;
  has-session) [ -f "$F/session" ] || exit 1 ;;
  new-session) touch "$F/session"; add_window "$nm" ;;
  new-window) add_window "$nm" ;;
esac
exit 0
SH
cat >"$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE/gh.log"
[ "${1:-} ${2:-}" != "issue view" ] || exit 1   # the ledgers do not exist yet
exit 0
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

INIT_COMMON=(--org acme --namespace acme --pin-repo acme/app)
init() { node "$ROOT_SRC/install" fleet init "$@"; }

FULL_FILES=".claude-plugin/marketplace.json .gitignore README.md docs/TRANSITION.md fleet/env/security.env.tmpl fleet/env/session.env.tmpl fleet/fleet.conf fleet/roster.tmpl fleet/supervisor.conf.tmpl jobs/launchd/az-sp-login.plist.tmpl plugin/.claude-plugin/plugin.json plugin/context/org.md plugin/hooks/fleet-context.sh plugin/hooks/hooks.json plugin/repos/acme/app/context.md plugin/repos/acme/app/maintenance-monster.yml plugin/repos/acme/app/merge-monster.yml scripts/fleet"
MIN_FILES=".gitignore README.md docs/TRANSITION.md fleet/env/security.env.tmpl fleet/env/session.env.tmpl fleet/fleet.conf fleet/repos/acme/app/maintenance-monster.yml fleet/repos/acme/app/merge-monster.yml fleet/roster.tmpl fleet/supervisor.conf.tmpl scripts/fleet"

# =============================================================================================
echo "== A. the full scaffold: instance marketplace, GitHub App, Azure"
FULL="$T/full"
run init --into "$FULL" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --instance-marketplace acme \
  --identity github-app --cloud azure --engsys-dir "$HOME/git/engsys"
rc_is "init exits 0" 0
has "init prints the next steps" "$OUT" "Next steps:"
has "…ledgers via the setup scripts" "$OUT" "$HOME/git/engsys/core/skills/merge-monster/scripts/mm-setup.sh --repo acme/app"
has "…both monsters" "$OUT" "$HOME/git/engsys/core/skills/maintenance-monster/scripts/mnt-setup.sh --repo acme/app"
has "…identity" "$OUT" "core/fleet/identity/README.md"
has "…the Azure setup" "$OUT" "stacks/cloud/azure/fleet/README.md"
has "…the plugin pins" "$OUT" '"acme@acme": true'
has "…sync, launch, install-jobs" "$OUT" "scripts/fleet install-jobs"
eq "file set" "$(file_list "$FULL")" "$FULL_FILES"
eq "no {{…}} token is left" "$(grep -rlF '{{' "$FULL" | paste -sd' ' -)" ""
for f in fleet/roster.tmpl fleet/env/session.env.tmpl fleet/env/security.env.tmpl jobs/launchd/az-sp-login.plist.tmpl; do
  if grep -Eq '__[A-Z][A-Z0-9_]*__' "$FULL/$f"; then ok "__NAME__ tokens survive in $f"; else bad "__NAME__ tokens survive in $f"; fi
done
file_has "roster: __PIN_DIR__ passes through" "$FULL/fleet/roster.tmpl" "acme-mm|__PIN_DIR__|/engsys:merge-monster|"
file_has "az job: __AZURE_SP_ENV__ passes through" "$FULL/jobs/launchd/az-sp-login.plist.tmpl" "<string>__AZURE_SP_ENV__</string>"
file_has "az job: calls the azure pack script" "$FULL/jobs/launchd/az-sp-login.plist.tmpl" "__ENGSYS_DIR__/stacks/cloud/azure/fleet/az-sp-login.sh"
for f in .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json plugin/hooks/hooks.json; do
  if jq -e . "$FULL/$f" >/dev/null 2>&1; then ok "$f is valid JSON"; else bad "$f is valid JSON"; fi
done
eq "marketplace: name" "$(jq -r .name "$FULL/.claude-plugin/marketplace.json")" acme
eq "marketplace: owner is the org" "$(jq -r .owner.name "$FULL/.claude-plugin/marketplace.json")" acme
eq "marketplace: version 0.1.0" "$(jq -r .metadata.version "$FULL/.claude-plugin/marketplace.json")" 0.1.0
eq "marketplace: the plugin" "$(jq -c '.plugins | map({name, source})' "$FULL/.claude-plugin/marketplace.json")" '[{"name":"acme","source":"./plugin"}]'
eq "plugin.json: name and version" "$(jq -r '.name + " " + .version' "$FULL/plugin/.claude-plugin/plugin.json")" "acme 0.1.0"
eq "hooks.json: one SessionStart hook on fleet-context.sh" "$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$FULL/plugin/hooks/hooks.json")" 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/fleet-context.sh"'
for f in scripts/fleet plugin/hooks/fleet-context.sh; do
  if [ -x "$FULL/$f" ]; then ok "$f is executable"; else bad "$f is executable"; fi
  if bash -n "$FULL/$f"; then ok "bash -n $f"; else bad "bash -n $f"; fi
  if command -v shellcheck >/dev/null 2>&1; then
    if sc="$(shellcheck -S warning "$FULL/$f" 2>&1)"; then ok "shellcheck $f"; else bad "shellcheck $f" "$sc"; fi
  fi
done
command -v shellcheck >/dev/null 2>&1 || echo "  skip shellcheck (not installed)"
CONF="$FULL/fleet/fleet.conf"
for k in FLEET_ORG PIN_REPO PIN_DIR ENGSYS_DIR ENGSYS_MARKETPLACE INSTANCE_MARKETPLACE WORKTREES_DIR GH_APP_ENV AZURE_SP_ENV \
  REVIEW_CMD REVIEW_MARKER REVIEW_BLOCK_REGEX READY_LABEL PREPUSH_SETUP_CMD PIN_WAIT_MAX_MIN \
  OPUS_MODEL SONNET_MODEL FABLE_MODEL HAIKU_MODEL SECURITY_MODEL INTERACTIVE_PERMISSION_MODE \
  MM_MODEL MM_EFFORT MAINTAIN_MODEL MAINTAIN_EFFORT BUILD_MODEL BUILD_EFFORT INVESTIGATE_MODEL INVESTIGATE_EFFORT DESIGN_MODEL DESIGN_EFFORT; do
  if grep -Eq "^#? ?$k=" "$CONF"; then ok "fleet.conf documents $k"; else bad "fleet.conf documents $k"; fi
done
file_has "fleet.conf: org" "$CONF" "FLEET_ORG=acme"
file_has "fleet.conf: pin repo" "$CONF" "PIN_REPO=acme/app"
file_has "fleet.conf: pin dir" "$CONF" "PIN_DIR=$HOME/git/app"
file_has "fleet.conf: engsys dir" "$CONF" "ENGSYS_DIR=$HOME/git/engsys"
file_has "fleet.conf: instance marketplace" "$CONF" "INSTANCE_MARKETPLACE=acme"
file_has "fleet.conf: github-app sets GH_APP_ENV" "$CONF" "GH_APP_ENV=~/.config/acme/gh-app.env"
file_has "fleet.conf: azure sets AZURE_SP_ENV" "$CONF" "AZURE_SP_ENV=~/.config/acme/azure-sp.env"
file_has "fleet.conf: worktrees default beside the pin checkout" "$CONF" "WORKTREES_DIR=$HOME/git/worktrees"
file_has "fleet.conf: model defaults (opus)" "$CONF" "OPUS_MODEL=claude-opus-5-5"
file_has "fleet.conf: model defaults (sonnet)" "$CONF" "SONNET_MODEL=claude-sonnet-5"
file_has "fleet.conf: model defaults (fable)" "$CONF" "FABLE_MODEL=claude-fable-5-1"
file_has "fleet.conf: model defaults (haiku)" "$CONF" "HAIKU_MODEL=claude-haiku-4-5"
file_has "fleet.conf: security model" "$CONF" "SECURITY_MODEL=claude-opus-4-8"
file_has "fleet.conf: interactive permission mode" "$CONF" "INTERACTIVE_PERMISSION_MODE=auto"
file_has "gitignore: .fleet/" "$FULL/.gitignore" ".fleet/"
file_has "gitignore: logs/" "$FULL/.gitignore" "logs/"
file_has "gitignore: *.pem" "$FULL/.gitignore" "*.pem"
file_has "gitignore: *.env" "$FULL/.gitignore" "*.env"
file_has "gitignore: but not *.env.tmpl" "$FULL/.gitignore" "!*.env.tmpl"
git -C "$FULL" init -q
for f in fleet/env/leak.env .fleet/roster logs/x.log key.pem; do
  if git -C "$FULL" check-ignore -q "$f"; then ok "gitignore drops $f"; else bad "gitignore drops $f"; fi
done
for f in fleet/env/session.env.tmpl fleet/env/security.env.tmpl; do
  if git -C "$FULL" check-ignore -q "$f"; then bad "gitignore keeps $f"; else ok "gitignore keeps $f"; fi
done
rm -rf "$FULL/.git"
file_has "supervisor.conf: monsters with ledger 0" "$FULL/fleet/supervisor.conf.tmpl" "acme-mm|0|60"
file_has "…both" "$FULL/fleet/supervisor.conf.tmpl" "acme-maintain|0|60"
file_has "…the repo" "$FULL/fleet/supervisor.conf.tmpl" "REPO=acme/app"
file_has "roster: maintain runs in the security env (5th field)" "$FULL/fleet/roster.tmpl" "--dangerously-skip-permissions|__ENV_DIR__/security.env"
file_has "roster: the identity preflight" "$FULL/fleet/roster.tmpl" "PREFLIGHT=bash __ENGSYS_DIR__/core/fleet/identity/gh-app-login.sh __GH_APP_ENV__"
file_has "roster: the azure preflight" "$FULL/fleet/roster.tmpl" "PREFLIGHT=bash __ENGSYS_DIR__/stacks/cloud/azure/fleet/az-sp-login.sh __AZURE_SP_ENV__"
file_has "session env: azure sourced" "$FULL/fleet/env/session.env.tmpl" '. "__AZURE_SP_ENV__"'
file_has "session env: GH_TOKEN unset" "$FULL/fleet/env/session.env.tmpl" "unset GH_TOKEN GITHUB_TOKEN"
file_has "session env: alias pins" "$FULL/fleet/env/session.env.tmpl" 'ANTHROPIC_DEFAULT_HAIKU_MODEL="__HAIKU_MODEL__"'
file_has "security env: sources session.env" "$FULL/fleet/env/security.env.tmpl" '. "__ENV_DIR__/session.env"'
file_has "security env: opus and fable to SECURITY_MODEL" "$FULL/fleet/env/security.env.tmpl" 'ANTHROPIC_DEFAULT_FABLE_MODEL="__SECURITY_MODEL__"'
for sec in "Accounts and ownership" "Machine and role identities" "Secrets" "Host" "The fleet" "External services" "Handing over the operator role" "Change log"; do
  file_has "TRANSITION.md: section '$sec'" "$FULL/docs/TRANSITION.md" "$sec"
done
file_has "monster config: repo filled in" "$FULL/plugin/repos/acme/app/merge-monster.yml" "repo: acme/app"
file_has "monster config: session name filled in" "$FULL/plugin/repos/acme/app/maintenance-monster.yml" "session_name: acme-maintain"
file_hasnt "monster config: no leftover <ns>" "$FULL/plugin/repos/acme/app/maintenance-monster.yml" "<ns>"
eq "monster config: the skill's example, same length" "$(wc -l <"$FULL/plugin/repos/acme/app/merge-monster.yml" | tr -d ' ')" "$(wc -l <"$CORE_SRC/skills/merge-monster/config.example.yml" | tr -d ' ')"
if [ -n "$REAL_CLAUDE" ]; then
  run "$REAL_CLAUDE" plugin validate "$FULL"
  rc_is "claude plugin validate: the marketplace" 0
  run "$REAL_CLAUDE" plugin validate "$FULL/plugin"
  rc_is "claude plugin validate: the plugin" 0
else
  echo "  skip claude plugin validate (claude not installed); the structural checks above stand in"
fi

echo "== B. the minimal scaffold: no marketplace, no identity, no cloud"
MIN="$T/min"
run init --into "$MIN" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app"
rc_is "init exits 0" 0
eq "file set" "$(file_list "$MIN")" "$MIN_FILES"
eq "no {{…}} token is left" "$(grep -rlF '{{' "$MIN" | paste -sd' ' -)" ""
CONF="$MIN/fleet/fleet.conf"
file_has "fleet.conf: identity none leaves GH_APP_ENV empty" "$CONF" "GH_APP_ENV="
file_hasnt "…not set" "$CONF" "GH_APP_ENV=~"
file_has "fleet.conf: no instance marketplace" "$CONF" "INSTANCE_MARKETPLACE="
file_hasnt "fleet.conf: no azure key" "$CONF" "AZURE_SP_ENV"
file_has "fleet.conf: engsys dir defaults to ~/git/engsys" "$CONF" "ENGSYS_DIR=~/git/engsys"
file_hasnt "roster: no identity preflight" "$MIN/fleet/roster.tmpl" "gh-app-login"
file_hasnt "roster: no azure preflight" "$MIN/fleet/roster.tmpl" "az-sp-login"
file_has "roster: the monsters get their config dir in the prompt" "$MIN/fleet/roster.tmpl" "/engsys:merge-monster fleet config dir: __FLEET_REPO__/fleet/repos/acme/app|"
file_hasnt "session env: no azure" "$MIN/fleet/env/session.env.tmpl" "AZURE"
file_hasnt "session env: no gh shim" "$MIN/fleet/env/session.env.tmpl" "identity/bin"
file_has "TRANSITION.md: still complete" "$MIN/docs/TRANSITION.md" "Change log"
if bash -n "$MIN/scripts/fleet"; then ok "bash -n scripts/fleet"; else bad "bash -n scripts/fleet"; fi
if [ -x "$MIN/scripts/fleet" ]; then ok "shim is executable"; else bad "shim is executable"; fi

echo "== B2. --resource-broker: the optional third monster"
RB="$T/rb"
run init --into "$RB" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --resource-broker
rc_is "init --resource-broker exits 0" 0
has "…next steps create the broker ledger too" "$OUT" "~/git/engsys/core/skills/resource-broker/scripts/broker-setup.sh --repo acme/app"
has "…and point at the pool file to edit" "$OUT" "fleet/repos/acme/app/acme-pool.json"
eq "file set: the minimal set plus the broker config and the pool file" "$(file_list "$RB")" "$(printf '%s\n' $MIN_FILES fleet/repos/acme/app/resource-broker.yml fleet/repos/acme/app/acme-pool.json | LC_ALL=C sort | paste -sd' ' -)"
eq "no {{…}} token is left" "$(grep -rlF '{{' "$RB" | paste -sd' ' -)" ""
file_has "roster: the broker is a monster with the launch prompt and no permission prompts" "$RB/fleet/roster.tmpl" "acme-broker|__PIN_DIR__|/engsys:resource-broker fleet config dir: __FLEET_REPO__/fleet/repos/acme/app|--model __BROKER_MODEL__ --effort __BROKER_EFFORT__ --remote-control --dangerously-skip-permissions"
file_has "supervisor.conf: the broker with a 0 ledger placeholder" "$RB/fleet/supervisor.conf.tmpl" "acme-broker|0|60"
file_has "supervisor.conf: its setup script is listed" "$RB/fleet/supervisor.conf.tmpl" "resource-broker/scripts/broker-setup.sh --repo acme/app"
file_has "fleet.conf: the broker's model" "$RB/fleet/fleet.conf" "BROKER_MODEL=claude-opus-5-5"
file_has "fleet.conf: …and effort" "$RB/fleet/fleet.conf" "BROKER_EFFORT=low"
file_has "TRANSITION.md: the broker ledger is in the ownership register" "$RB/docs/TRANSITION.md" "Resource Broker ledger"
BCFG="$RB/fleet/repos/acme/app"
file_has "resource-broker.yml: repo filled in" "$BCFG/resource-broker.yml" "repo: acme/app"
file_has "…session name" "$BCFG/resource-broker.yml" "session_name: acme-broker"
file_has "…owner" "$BCFG/resource-broker.yml" "owner: acme-broker"
file_has "…the owner fence is the namespace" "$BCFG/resource-broker.yml" "owner_pattern: '^acme-[a-z0-9][a-z0-9-]{0,62}\$'"
file_has "…the decider is the maintenance lane" "$BCFG/resource-broker.yml" "decider_session_name: acme-maintain"
file_hasnt "…no leftover <ns>" "$BCFG/resource-broker.yml" "<ns>"
if jq -e '.name == "acme-pool" and .bookkeeper == "acme-broker" and (.slots | length) == 2' "$BCFG/acme-pool.json" >/dev/null 2>&1; then ok "the pool file is valid JSON with two slots and the namespaced names"; else bad "the pool file is valid JSON with two slots and the namespaced names"; fi
# the scaffolded config and pool file work with the real reader and pool CLI
run bash "$CORE_SRC/skills/resource-broker/scripts/broker-config.sh" --config-dir "$BCFG"
rc_is "the broker's config reader finds the scaffolded config in the fleet config dir" 0
has "…and reads its pool file key" "$OUT" "lease.pool_file: acme-pool.json"
run node "$CORE_SRC/lib/lease/pool-cli.mjs" status --pool "$BCFG/acme-pool.json" --store "$T/rb-store" --owner-pattern '^acme-[a-z0-9][a-z0-9-]{0,62}$'
rc_is "pool-cli loads the scaffolded pool file" 0
eq "…both slots free" "$(jq -r '[.slots[].state] | join(",")' <<<"$OUT")" "free,free"
# a namespace other than acme renames the pool file and the owners inside it
ZED="$T/zed"
run init --into "$ZED" --org zed --namespace zed --pin-repo zed/app --pin-dir "$HOME/git/app" --resource-broker
rc_is "another namespace scaffolds" 0
if [ -f "$ZED/fleet/repos/zed/app/zed-pool.json" ]; then ok "the pool file is named for the namespace"; else bad "the pool file is named for the namespace" "$(file_list "$ZED")"; fi
file_has "…the config names it" "$ZED/fleet/repos/zed/app/resource-broker.yml" "pool_file: zed-pool.json"
file_has "…and its bookkeeper satisfies the config's fence" "$ZED/fleet/repos/zed/app/zed-pool.json" '"bookkeeper": "zed-broker"'
# without the flag there is no broker anywhere
file_hasnt "no flag: no broker in the roster" "$MIN/fleet/roster.tmpl" "broker"
file_hasnt "no flag: none in the supervisor conf" "$MIN/fleet/supervisor.conf.tmpl" "broker"
file_hasnt "no flag: no broker model keys" "$MIN/fleet/fleet.conf" "BROKER"

echo "== B3. --fleet: FLEET_ID and a one-fleet federation.yml"
FL="$T/fl"
run init --into "$FL" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --fleet alice
rc_is "init --fleet exits 0" 0
has "…next steps: the ledgers go in federation.yml too" "$OUT" "put the ledger numbers in federation.yml too (repos.acme/app.merge / .maintain ledger:)"
has "…and how to check it" "$OUT" "scripts/fleet federation validate"
eq "file set: the minimal set plus federation.yml" "$(file_list "$FL")" "$(printf '%s\n' $MIN_FILES federation.yml | LC_ALL=C sort | paste -sd' ' -)"
eq "no {{…}} token is left" "$(grep -rlF '{{' "$FL" | paste -sd' ' -)" ""
file_has "fleet.conf: FLEET_ID set" "$FL/fleet/fleet.conf" "FLEET_ID=alice"
file_has "fleet.conf: FEDERATION_FILE documented" "$FL/fleet/fleet.conf" "# FEDERATION_FILE=federation.yml"
FED="$FL/federation.yml"
file_has "federation.yml: version 1" "$FED" "version: 1"
file_has "federation.yml: this fleet" "$FED" "  alice:"
file_has "federation.yml: merge home is this fleet" "$FED" "merge: { home: alice, standby: [], failover: escalate }"
file_has "federation.yml: maintain too" "$FED" "maintain: { home: alice, standby: [], failover: escalate }"
file_has "federation.yml: operators_team TODO with the pin repo's owner" "$FED" "# operators_team: acme/fleet-operators"
file_has "federation.yml: the ledger TODO" "$FED" "TODO: add ledger:"
file_has "README: lists federation.yml" "$FL/README.md" "federation.yml"
run env FLEET_ID=alice node "$KIT_SRC/lib/federation.mjs" validate "$FED"
rc_is "the scaffolded federation.yml validates (with FLEET_ID=alice)" 0
run node "$KIT_SRC/lib/federation.mjs" home acme/app maintain --file "$FED"
eq "…and names alice as home" "$OUT" "alice"
if grep -q '^FLEET_ID=' "$MIN/fleet/fleet.conf"; then bad "no --fleet: FLEET_ID is not set"; else ok "no --fleet: FLEET_ID is not set"; fi
file_has "no --fleet: FLEET_ID is documented" "$MIN/fleet/fleet.conf" "# FLEET_ID="
if [ ! -e "$MIN/federation.yml" ]; then ok "no --fleet: no federation.yml"; else bad "no --fleet: no federation.yml"; fi
file_hasnt "no --fleet: README does not list federation.yml" "$MIN/README.md" "federation.yml"
for badid in Alice a 1abc a_b abcdefghijklmnopqrstuv; do
  run init --into "$T/badfleet" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --fleet "$badid"
  rc_is "--fleet $badid is refused" 1
done
has "…naming the flag" "$OUT" "--fleet must be"
if [ ! -e "$T/badfleet" ]; then ok "a refused --fleet writes nothing"; else bad "a refused --fleet writes nothing"; fi

echo "== C. refusing to overwrite, --force, --dry-run, validation"
sum_before="$(cat "$MIN"/fleet/fleet.conf "$MIN"/README.md | cksum)"
run init --into "$MIN" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app"
rc_is "a second init refuses" 1
has "…and says why" "$OUT" "refusing to overwrite"
has "…naming a file" "$OUT" "fleet/fleet.conf"
has "…and the way out" "$OUT" "--force"
eq "…touching nothing" "$(cat "$MIN"/fleet/fleet.conf "$MIN"/README.md | cksum)" "$sum_before"
printf 'edited by hand\n' >"$MIN/README.md"; printf 'mine\n' >"$MIN/extra.txt"
run init --into "$MIN" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --force
rc_is "--force overwrites" 0
has "…and reports it" "$OUT" "overwrote"
file_hasnt "the hand-edited file is regenerated" "$MIN/README.md" "edited by hand"
file_has "…and unrelated files are left alone" "$MIN/extra.txt" "mine"
rm -f "$MIN/extra.txt"
run init --into "$T/dry" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --dry-run
rc_is "--dry-run exits 0" 0; has "…says so" "$OUT" "dry run"
if [ ! -e "$T/dry" ]; then ok "--dry-run writes nothing"; else bad "--dry-run writes nothing"; fi
run init --into "$T/bad" --org Acme --namespace acme --pin-repo acme/app --pin-dir "$HOME/git/app"
rc_is "a non-slug org is refused" 1; has "…named" "$OUT" "--org"
run init --into "$T/bad" --org acme --namespace acme --pin-repo app --pin-dir "$HOME/git/app"
rc_is "a pin repo that is not owner/name is refused" 1; has "…named" "$OUT" "--pin-repo"
run init --into "$T/bad" --org acme --namespace acme --pin-repo acme/app
rc_is "a missing --pin-dir is refused" 1; has "…named" "$OUT" "--pin-dir is required"
run init --into "$T/bad" "${INIT_COMMON[@]}" --pin-dir relative/app
rc_is "a relative pin dir is refused" 1
run init --into "$T/bad" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --identity oauth
rc_is "an unknown identity is refused" 1; has "…named" "$OUT" "--identity"
run init --into "$T/bad" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app" --cloud gcp
rc_is "an unknown cloud is refused" 1; has "…named" "$OUT" "--cloud"
run init --into "$T/bad" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/my app"
rc_is "a pin dir with a space is refused" 1
if [ ! -e "$T/bad" ]; then ok "refusals write nothing"; else bad "refusals write nothing"; fi
run node "$ROOT_SRC/install" fleet
rc_is "fleet without a subcommand is an error" 1
run node "$ROOT_SRC/install" --help
has "engsys --help documents fleet init" "$OUT" "fleet init --into"
run bash "$KIT_SRC/bin/fleet" init --into "$T/viadisp" "${INIT_COMMON[@]}" --pin-dir "$HOME/git/app"
rc_is "bin/fleet init hands over to the engsys CLI" 0
if [ -f "$T/viadisp/fleet/fleet.conf" ]; then ok "…and scaffolds"; else bad "…and scaffolds"; fi

echo "== D. the instance plugin's SessionStart hook"
HOOK="$FULL/plugin/hooks/fleet-context.sh"
PLUGIN="$FULL/plugin"
W="$T/work"; mkdir -p "$W"; git -C "$W" init -q; git -C "$W" remote add origin https://github.com/acme/app.git
hook() { # hook <cwd> — as the harness runs it: cwd as JSON on stdin
  printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$1" | CLAUDE_PLUGIN_ROOT="$PLUGIN" bash "$HOOK"
}
run hook "$W"
rc_is "hook exits 0" 0
eq "hook emits SessionStart additionalContext JSON" "$(jq -r '.hookSpecificOutput.hookEventName' <<<"$OUT")" SessionStart
CTX="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
has "injects the fleet config dir for the repo" "$CTX" "fleet config dir: $PLUGIN/repos/acme/app"
has "…the repo context" "$CTX" "Fleet protocol: acme/app"
has "…the org context" "$CTX" "acme fleet: org-wide"
if [ -f "$PLUGIN/repos/acme/app/merge-monster.yml" ]; then ok "the injected dir holds the monster config"; else bad "the injected dir holds the monster config"; fi
git -C "$W" remote set-url origin git@github.com:Acme/App.git
run hook "$W"; ok_case="$(jq -r .hookSpecificOutput.additionalContext <<<"$OUT" | grep -ci "^fleet config dir: .*/repos/acme/app$" || true)"; eq "ssh remote with different case still finds the repo dir" "$ok_case" 1
git -C "$W" remote set-url origin https://github.com/acme/other.git
run hook "$W"
rc_is "an unknown repo exits 0" 0
CTX="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
hasnt "…gets no config dir" "$CTX" "fleet config dir:"
has "…but still the org context" "$CTX" "org-wide"
mkdir -p "$T/nogit"
run hook "$T/nogit"
rc_is "a directory that is not a git repo exits 0" 0; has "…with the org context" "$OUT" "org-wide"
run env CLAUDE_PLUGIN_ROOT="$T/does-not-exist" bash "$HOOK" </dev/null
rc_is "a missing plugin root fails open" 0; eq "…silently" "$OUT" ""
run env CLAUDE_PLUGIN_ROOT="$PLUGIN" CLAUDE_PROJECT_DIR="$W" bash "$HOOK" </dev/null
rc_is "no stdin at all still exits 0" 0

# =============================================================================================
echo "== E. the real kit runs the scaffold as-is"
# A sandbox engsys checkout built from this tree (the kit, the launcher, the azure pack), tagged like a release.
E="$HOME/git/engsys"
mkdir -p "$E/core/skills" "$E/stacks/cloud/azure"
cp -R "$KIT_SRC" "$E/core/fleet"; rm -rf "$E/core/fleet/test" "$E/core/fleet/scaffold"
cp -R "$CORE_SRC/lib" "$E/core/lib"   # federation.mjs reads gate-check's operator-source rules
cp -R "$CORE_SRC/skills/agent-sessions" "$E/core/skills/agent-sessions"
cp -R "$ROOT_SRC/stacks/cloud/azure/fleet" "$E/stacks/cloud/azure/fleet"
git -C "$E" init -q && git -C "$E" add -A && git -C "$E" commit -q -m "engsys" && git -C "$E" tag v1.2.0
# The pin repo: a local checkout whose .claude/settings.json pins engsys (and the instance marketplace).
P="$HOME/git/app"
mkdir -p "$P/.claude"
jq -n '{extraKnownMarketplaces: {
  engsys: {source: {source: "github", repo: "vendor/engsys", ref: "v1.2.0"}},
  acme: {source: {source: "github", repo: "acme/acme-fleet", ref: "v0.1.0"}}},
  enabledPlugins: {"engsys@engsys": true, "acme@acme": true}}' >"$P/.claude/settings.json"
git -C "$P" init -q && git -C "$P" add -A && git -C "$P" commit -q -m "pins"
printf 'GH_APP_ID=1\nGH_APP_INSTALLATION_ID=2\nGH_APP_PEM=%s/none.pem\nGH_BOT_AUTHOR_NAME=acme-fleet[bot]\nGH_BOT_AUTHOR_EMAIL=1+acme-fleet[bot]@users.noreply.github.com\n' "$HOME" >"$HOME/.config/acme/gh-app.env"
printf 'AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000\n' >"$HOME/.config/acme/azure-sp.env"

launched() { grep -F "[send-keys] [-t] [acme:$1]" "$FAKE/tmux.log" | head -1 || true; }
unrendered() { grep -REn '__[A-Z][A-Z0-9_]*__' "$@" 2>/dev/null || true; }

echo "-- full scaffold: launch through the shim"
INST="$FULL"; STATE="$INST/.fleet"
rm -rf "$FAKE/tmux"; : >"$FAKE/tmux.log"
run "$INST/scripts/fleet" launch
rc_is "scripts/fleet launch exits 0" 0
has "the shim reached the kit (identity preflight ran)" "$OUT" "gh-app-login"
if [ -d "$HOME/git/worktrees" ]; then ok "WORKTREES_DIR was created"; else bad "WORKTREES_DIR was created"; fi
eq "roster: every token rendered" "$(unrendered "$STATE/roster")" ""
eq "env files: every token rendered" "$(unrendered "$STATE"/env/*.env)" ""
R="$(cat "$STATE/roster")"
has "roster: namespace" "$R" "NAMESPACE=acme"
has "roster: ENV_FILE is the rendered session env" "$R" "ENV_FILE=$STATE/env/session.env"
has "roster: identity preflight rendered" "$R" "PREFLIGHT=bash $E/core/fleet/identity/gh-app-login.sh $HOME/.config/acme/gh-app.env"
has "roster: azure preflight rendered" "$R" "PREFLIGHT=bash $E/stacks/cloud/azure/fleet/az-sp-login.sh $HOME/.config/acme/azure-sp.env"
has "roster: merge monster" "$R" "acme-mm|$P|/engsys:merge-monster|--model claude-opus-5-5 --effort high --remote-control --dangerously-skip-permissions"
has "roster: maintenance monster with the security env" "$R" "acme-maintain|$P|/engsys:maintenance-monster|--model claude-opus-4-8 --effort high --remote-control --dangerously-skip-permissions|$STATE/env/security.env"
has "roster: build" "$R" "acme-build|$P||--add-dir $HOME/git/worktrees --model claude-opus-5-5 --effort medium --remote-control --permission-mode auto"
has "roster: investigate" "$R" "acme-investigate|$P||--add-dir $HOME/git/worktrees --model claude-opus-5-5 --effort medium --remote-control --permission-mode auto"
has "roster: design" "$R" "acme-design|$P||--add-dir $HOME/git/worktrees --model claude-opus-5-5 --effort medium --remote-control --permission-mode auto"
eq "five windows launched" "$(grep -c . "$FAKE/tmux/windows")" 5
has "mm runs in the session env" "$(launched acme-mm)" "set -a && . $STATE/env/session.env && set +a && claude --name acme-mm"
has "mm gets its session name and a launch id (the baton's holder, engsys#62)" "$(launched acme-mm)" "export ENGSYS_SESSION=acme-mm ENGSYS_SESSION_RUN="
has "the prompt precedes the flags" "$(launched acme-mm)" "/engsys:merge-monster --model claude-opus-5-5"
has "maintain: the 5th field replaces the session env" "$(launched acme-maintain)" "set -a && . $STATE/env/security.env && set +a && claude --name acme-maintain"
S="$(cat "$STATE/env/session.env")"
X="$(cat "$STATE/env/security.env")"
has "session env: alias pins rendered (opus)" "$S" 'ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-5-5"'
has "…sonnet" "$S" 'ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-5"'
has "…fable" "$S" 'ANTHROPIC_DEFAULT_FABLE_MODEL="claude-fable-5-1"'
has "…haiku" "$S" 'ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"'
has "session env: azure env sourced" "$S" ". \"$HOME/.config/acme/azure-sp.env\""
# behavioral: source the rendered env the way the launcher does and check what a session actually gets
SRC="$(env -i HOME="$HOME" PATH=/usr/bin:/bin GH_TOKEN=personal bash -c "set -a; . '$STATE/env/session.env' 2>/dev/null; set +a; printf '%s|%s|%s' \"\${PATH%%:*}\" \"\${GH_APP_ENV_FILE:-}\" \"\${GH_TOKEN:-none}\"")"
eq "session env: gh shim first on PATH" "${SRC%%|*}" "$E/core/fleet/identity/bin"
has "session env: GH_APP_ENV_FILE set" "$SRC" "|$HOME/.config/acme/gh-app.env|"
has "session env: inherited GH_TOKEN dropped" "$SRC" "|none"
has "session env: env-scoped git identity appended by launch" "$S" "GIT_CONFIG_COUNT="
has "security env: sources the session env" "$X" ". \"$STATE/env/session.env\""
has "security env: opus aliased to the security model" "$X" 'ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-8"'
has "security env: fable aliased to the security model" "$X" 'ANTHROPIC_DEFAULT_FABLE_MODEL="claude-opus-4-8"'
# Source the rendered env the way a session's login shell would (POSIX sh, exported), with a token in the way.
got="$(env -i HOME="$HOME" PATH="/usr/bin:/bin" GH_TOKEN=leaked sh -c "set -a; . '$STATE/env/security.env'; set +a; echo \"\$ANTHROPIC_DEFAULT_OPUS_MODEL \$ANTHROPIC_DEFAULT_SONNET_MODEL \${GH_TOKEN-unset}\"")"
eq "sourcing security.env in sh: opus is the security model, sonnet stays, GH_TOKEN is dropped" "$got" "claude-opus-4-8 claude-sonnet-5 unset"

echo "-- full scaffold: supervise and install-jobs"
run "$INST/scripts/fleet" supervise
rc_is "supervise ticks" 0
SUP="$(cat "$STATE/supervisor.conf")"
has "supervisor.conf: repo" "$SUP" "REPO=acme/app"
has "supervisor.conf: both monsters" "$SUP" "acme-maintain|0|60"
has "supervisor.conf: LAUNCH_CMD points back at the kit" "$SUP" "LAUNCH_CMD=bash $E/core/fleet/bin/fleet --instance $INST launch"
has "supervisor.conf: tmux session" "$SUP" "TMUX_SESSION=acme"
run "$INST/scripts/fleet" install-jobs --dry-run
rc_is "install-jobs --dry-run exits 0" 0
has "jobs: the supervisor" "$OUT" "would write $HOME/Library/LaunchAgents/com.acme.fleet.fleet-supervisor.plist"
has "jobs: the identity check" "$OUT" "com.acme.fleet.gh-app-login.plist"
has "jobs: the azure login (from the instance)" "$OUT" "com.acme.fleet.az-sp-login.plist"
has "jobs: the azure plist calls the pack script" "$OUT" "<string>$E/stacks/cloud/azure/fleet/az-sp-login.sh</string>"
has "jobs: …with the env file" "$OUT" "<string>$HOME/.config/acme/azure-sp.env</string>"
has "jobs: the azure log path" "$OUT" "Library/Logs/acme-fleet/az-sp-login.log"
eq "jobs: nothing left unrendered" "$(grep -E '__[A-Z][A-Z0-9_]*__' <<<"$OUT" || true)" ""
if command -v plutil >/dev/null 2>&1; then
  # install-jobs lints every rendered plist (plutil -lint) and exits non-zero on a bad one
  ok "the rendered plists pass plutil -lint (the dry run above exited 0)"
fi
# The library view of the same instance
(
  export FLEET_INSTANCE="$INST"
  # shellcheck source=/dev/null
  . "$E/core/fleet/lib/fleet-env.sh"
  eq "kit: TMUX_SESSION from the roster header" "$TMUX_SESSION" acme
  eq "kit: roster sessions" "$(fleet_roster_sessions | paste -sd' ' -)" "acme-mm acme-maintain acme-build acme-investigate acme-design"
  eq "kit: the monsters are the supervisor's" "$(fleet_ledger_sessions | paste -sd' ' -)" "acme-mm acme-maintain"
  eq "kit: pins read from the pin repo" "$ENGSYS_REF $INSTANCE_REF" "v1.2.0 v0.1.0"
  eq "kit: READY_LABEL default" "$READY_LABEL" "mm:ready"
) || bad "kit library checks aborted"
# The shim honors a per-machine override, and says so when the checkout is missing
printf 'ENGSYS_DIR=%s/nowhere\n' "$HOME" >"$HOME/.config/acme/fleet.local.conf"
run "$INST/scripts/fleet" status
rc_is "shim: fleet.local.conf overrides ENGSYS_DIR" 1; has "…and names the missing checkout" "$OUT" "engsys checkout not found at $HOME/nowhere"
rm -f "$HOME/.config/acme/fleet.local.conf"

echo "-- minimal scaffold: launch through the shim (~ in ENGSYS_DIR), no identity, no marketplace"
INST="$MIN"; STATE="$INST/.fleet"
rm -rf "$FAKE/tmux" "$HOME/git/worktrees"; : >"$FAKE/tmux.log"
run "$INST/scripts/fleet" launch
rc_is "scripts/fleet launch exits 0" 0
eq "roster: every token rendered" "$(unrendered "$STATE/roster")" ""
eq "env files: every token rendered" "$(unrendered "$STATE"/env/*.env)" ""
R="$(cat "$STATE/roster")"
CFG="$INST/fleet/repos/acme/app"
has "roster: merge monster gets its config dir in the prompt" "$R" "acme-mm|$P|/engsys:merge-monster fleet config dir: $CFG|--model claude-opus-5-5"
has "roster: maintain too, with the security env" "$R" "acme-maintain|$P|/engsys:maintenance-monster fleet config dir: $CFG|--model claude-opus-4-8 --effort high --remote-control --dangerously-skip-permissions|$STATE/env/security.env"
if [ -f "$CFG/merge-monster.yml" ] && [ -f "$CFG/maintenance-monster.yml" ]; then ok "the config dir the prompt names exists with both configs"; else bad "the config dir the prompt names exists"; fi
hasnt "roster: no preflights" "$R" "PREFLIGHT="
hasnt "env: no identity lines without an identity" "$(cat "$STATE/env/session.env")" "GIT_CONFIG_COUNT"
hasnt "env: no azure without the cloud option" "$(cat "$STATE/env/session.env")" "azure"
has "env: GH_TOKEN still unset" "$(cat "$STATE/env/session.env")" "unset GH_TOKEN GITHUB_TOKEN"
eq "five windows launched" "$(grep -c . "$FAKE/tmux/windows")" 5
has "launched command carries the config dir (quoted by the launcher)" "$(launched acme-mm)" "fleet\\ config\\ dir:\\ $CFG"
if [ -d "$HOME/git/worktrees" ]; then ok "worktrees dir created"; else bad "worktrees dir created"; fi
run "$INST/scripts/fleet" install-jobs --dry-run
rc_is "install-jobs --dry-run exits 0" 0
has "jobs: the supervisor" "$OUT" "com.acme.fleet.fleet-supervisor.plist"
has "jobs: the identity check is skipped" "$OUT" "skipped: com.acme.fleet.gh-app-login (GH_APP_ENV is not set)"
hasnt "jobs: no azure login" "$OUT" "az-sp-login"
run "$INST/scripts/fleet" supervise
rc_is "supervise ticks" 0
has "supervisor.conf rendered" "$(cat "$STATE/supervisor.conf")" "acme-mm|0|60"

echo "-- resource broker scaffold: the kit launches and supervises the third monster"
INST="$RB"; STATE="$INST/.fleet"
rm -rf "$FAKE/tmux" "$HOME/git/worktrees"; : >"$FAKE/tmux.log"
run "$INST/scripts/fleet" launch
rc_is "scripts/fleet launch exits 0" 0
eq "roster: every token rendered (BROKER_MODEL and BROKER_EFFORT included)" "$(unrendered "$STATE/roster")" ""
R="$(cat "$STATE/roster")"
CFG="$INST/fleet/repos/acme/app"
has "roster: the broker line, rendered" "$R" "acme-broker|$P|/engsys:resource-broker fleet config dir: $CFG|--model claude-opus-5-5 --effort low --remote-control --dangerously-skip-permissions"
eq "six windows launched" "$(grep -c . "$FAKE/tmux/windows")" 6
has "the broker runs in the session env with its prompt before the flags" "$(launched acme-broker)" "set -a && . $STATE/env/session.env && set +a && claude --name acme-broker"
has "…and the command file's prompt" "$(launched acme-broker)" "/engsys:resource-broker"
if [ -f "$CFG/resource-broker.yml" ] && [ -f "$CFG/acme-pool.json" ]; then ok "the config dir the prompt names holds the broker config and its pool file"; else bad "the config dir the prompt names holds the broker config and its pool file"; fi
run "$INST/scripts/fleet" supervise
rc_is "supervise ticks" 0
has "supervisor.conf rendered with the broker" "$(cat "$STATE/supervisor.conf")" "acme-broker|0|60"
(
  export FLEET_INSTANCE="$INST"
  # shellcheck source=/dev/null
  . "$E/core/fleet/lib/fleet-env.sh"
  eq "kit: the broker is a supervisor monster" "$(fleet_ledger_sessions | paste -sd' ' -)" "acme-mm acme-maintain acme-broker"
  eq "kit: it is in the roster" "$(fleet_roster_sessions | paste -sd' ' -)" "acme-mm acme-maintain acme-broker acme-build acme-investigate acme-design"
) || bad "kit library checks aborted (resource broker)"
if [ -f "$CORE_SRC/commands/resource-broker.md" ] && grep -Fq 'argument-hint: "[fleet config dir: /abs/path]"' "$CORE_SRC/commands/resource-broker.md"; then ok "the /engsys:resource-broker command exists and takes the fleet config dir"; else bad "the /engsys:resource-broker command exists and takes the fleet config dir"; fi

echo "-- --fleet scaffold: launch carries FLEET_ID, status shows the registry"
INST="$FL"; STATE="$INST/.fleet"
rm -rf "$FAKE/tmux" "$HOME/git/worktrees"; : >"$FAKE/tmux.log"
run "$INST/scripts/fleet" launch
rc_is "scripts/fleet launch exits 0" 0
hasnt "…the scaffolded registry raises no warning" "$OUT" "federation registry"
eq "env files: every token rendered" "$(unrendered "$STATE"/env/*.env)" ""
has "session env: FLEET_ID" "$(cat "$STATE/env/session.env")" "FLEET_ID=alice"
has "session env: FEDERATION_FILE" "$(cat "$STATE/env/session.env")" "FEDERATION_FILE=$INST/federation.yml"
has "security env: FLEET_ID too" "$(cat "$STATE/env/security.env")" "FLEET_ID=alice"
run "$INST/scripts/fleet" federation status
rc_is "scripts/fleet federation status exits 0" 0
has "status: the fleet" "$OUT" "fleet: alice"
has "status: merge is this fleet's" "$OUT" "home alice (this fleet)"

# =============================================================================================
pass="$(wc -l <"$T/pass.log" | tr -d ' ')"; fail="$(wc -l <"$T/fail.log" | tr -d ' ')"
echo
echo "init.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
