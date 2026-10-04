#!/usr/bin/env bash
# notify.test.sh — sandbox test for `fleet notify` dispatch (run by `npm test`; no network).
#
# This exercises the wiring the unit tests in notify.test.mjs don't: bin/fleet dispatching to
# notify.sh, notify.sh sourcing fleet-env.sh to resolve SLACK_ENV/NOTIFY_FALLBACK_ISSUE/FLEET_STATE
# from a real fleet/fleet.conf, and notify.mjs talking to a stub Slack HTTP server plus a stub `gh`.
# The core behavior matrix (levels, mentions, latch, resolve, fallback) is covered by notify.test.mjs
# against notify.mjs directly; this file only has to prove the shell plumbing around it works.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT="$(cd "$HERE/.." && pwd -P)" # core/fleet
# shellcheck source=sandbox.sh
. "$HERE/sandbox.sh"

command -v node >/dev/null || { echo "notify.test.sh: node is required" >&2; exit 1; }

# --- a minimal fleet instance (just enough for fleet-env.sh; no sync/pin machinery needed) -------
I="$T/instance"
mkdir -p "$I/fleet" "$I/.claude"
echo '{}' >"$I/.claude/settings.json"

SLACK_ENV_FILE="$T/slack.env"
cat >"$SLACK_ENV_FILE" <<EOF
SLACK_BOT_TOKEN=xoxb-test-token
SLACK_CHANNEL_ID=C123
SLACK_OPERATORS_GROUP_ID=S999
FLEET_ID=acme
EOF
chmod 600 "$SLACK_ENV_FILE"

cat >"$I/fleet/fleet.conf" <<EOF
FLEET_ORG=acme
PIN_REPO=acme/acme-fleet
PIN_DIR=$I
SLACK_ENV=$SLACK_ENV_FILE
NOTIFY_FALLBACK_ISSUE=acme/app#5
EOF

# --- stub gh (records every call) ---------------------------------------------------------------
: >"$FAKE/gh.log"
cat >"$T/bin/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$FAKE/gh.log"
cat >/dev/null || true
SH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

# --- a tiny stub Slack server (node; chat.postMessage only) --------------------------------------
POSTS_FILE="$T/posts.ndjson"
: >"$POSTS_FILE"
cat >"$T/slack-stub.mjs" <<'JS'
import http from 'node:http';
import fs from 'node:fs';
const postsFile = process.env.POSTS_FILE;
const fail = () => fs.existsSync(`${postsFile}.fail`);
let n = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/chat.postMessage') {
      fs.appendFileSync(postsFile, body + '\n');
      n += 1;
      if (fail()) { res.end(JSON.stringify({ ok: false, error: 'channel_not_found' })); return; }
      res.end(JSON.stringify({ ok: true, ts: `${1700000000 + n}.000100` }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
});
server.listen(0, '127.0.0.1', () => { process.stdout.write(`${server.address().port}\n`); });
JS
coproc SLACK_STUB { POSTS_FILE="$POSTS_FILE" node "$T/slack-stub.mjs"; }
read -r -u "${SLACK_STUB[0]}" PORT
PIDS+=("$SLACK_STUB_PID")
export SLACK_API_URL="http://127.0.0.1:$PORT"

# --- run: info level, no incident --------------------------------------------------------------
run bash "$KIT/bin/fleet" --instance "$I" notify --level info "hello from the sandbox"
rc_is "info notify exits 0" 0
POST1="$(tail -1 "$POSTS_FILE")"
has "posted text carries the fleet prefix and emoji, no mention" "$POST1" '"text":"[acme] ℹ️ hello from the sandbox"'
has "posted to the configured channel" "$POST1" '"channel":"C123"'
hasnt "no thread_ts on a first, non-incident post" "$POST1" 'thread_ts'

# --- run: alert level with an incident, then resolve --------------------------------------------
run bash "$KIT/bin/fleet" --instance "$I" notify --level alert --incident sandbox-down "it is down"
rc_is "alert notify (first post of an incident) exits 0" 0
POST2="$(tail -1 "$POSTS_FILE")"
has "alert mentions the operators group" "$POST2" '<!subteam^S999>'
LATCH="$I/.fleet/notify/sandbox-down.json"
[ -f "$LATCH" ] && ok "incident latch file was written under FLEET_STATE/notify/" || bad "incident latch file was written under FLEET_STATE/notify/"

run bash "$KIT/bin/fleet" --instance "$I" notify --level alert --incident sandbox-down --resolve
rc_is "resolve exits 0" 0
POST3="$(tail -1 "$POSTS_FILE")"
has "resolve posts the standard resolved text" "$POST3" '"text":"✅ resolved"'
[ -f "$LATCH" ] && bad "latch cleared after resolve" || ok "latch cleared after resolve"

# --- run: Slack API failure falls back to gh issue comment, never fails the caller --------------
touch "$POSTS_FILE.fail"
run bash "$KIT/bin/fleet" --instance "$I" notify --level action --re "https://github.com/acme/app/pull/9" "needs a human"
rc_is "Slack-down action notify still exits 0 (falls back)" 0
GHLOG="$(cat "$FAKE/gh.log")"
has "fallback used gh issue comment on NOTIFY_FALLBACK_ISSUE" "$GHLOG" "issue comment 5 -R acme/app --body"
has "fallback comment carries the GitHub link line" "$GHLOG" "Approve or act on GitHub: https://github.com/acme/app/pull/9"

finish "notify.test.sh"
