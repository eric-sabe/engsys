#!/usr/bin/env bash
# mnt-security-reviews.sh — READ-ONLY. The open PRs that ask the security lane for a signed verdict (engsys#231): those
# carrying the review request label (merge config security_review_label, default security-review-requested), each
# with its head and whether THIS session authored it (an mm-handoff block names the session: skip it, there is no
# independent signer until eric-sabe/engsys#220). Thin wrapper over mnt-security-review.mjs `list`; see its header.
#
# Usage: mnt-security-reviews.sh --repo owner/name [--session NAME] [--label L] [--config FILE]...
#   --session  this session's name (default $ENGSYS_SESSION; none → every PR counts as self-authored, fail closed)
#   --label    overrides the label found in the merge configs
#   --config   an extra merge-monster.yml to read security_review_label from (adds to the discovered ones)
#
# Prints one JSON object {label, labelSource, session, signer, prs: [{number, head, url, author, isDraft,
# selfAuthored, selfWhy, skipNoted}]}. Exit: 0 listed, 1 error ({"ok":false,"reason":…}), 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo '{"ok":false,"reason":"node not found"}'; exit 1; }
# shellcheck source=../../../lib/fleet-gh.sh
. "$here/../../../lib/fleet-gh.sh"
fleet_gh_resolve
assert_gh_auth mnt-security-reviews || exit 1
exec node "$here/mnt-security-review.mjs" list "$@"
