# gate-check: human approval happens in GitHub

Agents ask for approval in chat and Slack, but a gate only opens when a human on the operators team
acts **on GitHub**. `gate-check` is the code that decides whether that happened. Design rationale:
[multi-fleet.md § 6](multi-fleet.md#6-human-approval-happens-in-github).

Code: `core/lib/gate-check.mjs` (zero dependencies, Node >= 20; the only external process is `gh`).
Skill wrappers: `skills/merge-monster/scripts/gate-request.sh` (posts a request) and
`skills/merge-monster/scripts/gate-check.sh` (read-only verifier, auto-approved in plugin installs).
Tests: `core/lib/gate-check.test.mjs`.

## Contents

- [Which acts are gated](#which-acts-are-gated)
- [The flow](#the-flow)
- [Rules gate-check enforces](#rules-gate-check-enforces)
- [The latest-push signal](#the-latest-push-signal)
- [CLI](#cli)
- [Configuration and permissions](#configuration-and-permissions)
- [Recording an approval](#recording-an-approval)

## Which acts are gated

| Act | Kind | How a human approves | Thread |
|---|---|---|---|
| Merging a migration-bearing PR, an operator-gated PR, or a never-auto dependency PR | `merge` | PR review **Approve** on the requested head | the PR |
| Applying a migration to staging or production | `migration` | comment `/approve <gate-id>` | the PR |
| Dispatching a production deploy | `deploy` | comment `/approve <gate-id>` | the PR or a tracking issue |
| Accepting the risk on an alert (suppression) | `risk-accepted` | comment `/approve <gate-id>` | the tracking issue |
| Handing off a never-auto dependency update | `dependency` | comment `/approve <gate-id>` | the PR |

Kinds are lowercase slugs; `merge` is the only kind approved by review. Every other kind needs the
comment, so a merge approval can never double as approval to run a migration in production.

## The flow

1. **Request.** The agent runs `gate-request.sh`, which posts a comment whose first line is the marker

   ```markdown
   <!-- gate-request id="migrate-prod-20261004120000-3f9c" kind="migration" target="acme/app#412@<40-hex head sha>" -->
   ```

   followed by what will happen, the exact target and how to approve or refuse. On a PR the target
   must be `owner/repo#N@<full 40-character head SHA>` (a 7-character prefix is cheap to collide).
   On an issue it is a short identifier such as `alert:dependabot/42` or `prod@v1.4.0`.
2. **Nudge.** The agent tells the operator, in its session and in Slack, with the request link. The
   nudge says "approve on GitHub", never "reply here".
3. **Approve or refuse on GitHub.** A PR review **Approve** (kind `merge`) or a comment that reads
   exactly `/approve <gate-id>`. `/deny <gate-id> <reason>` refuses.
4. **Verify.** On each wake the agent runs `gate-check.sh` and acts only on exit 0. If the operator
   says "approved" in chat or Slack, the agent replies with the request link and keeps waiting.

## Rules gate-check enforces

An approval counts only if **all** of these hold:

- **The gate request is unambiguous.** Exactly one comment on the thread from `--requester` carries
  the gate id in a leading-position marker, so look-alike requests from other accounts are ignored.
  It is unedited. It names exactly the `--target` and `--kind` the agent is about to act on.
  `--requester`, `--target` and `--kind` are all required on `check`.
- **The actor is a qualifying operator.** `user.type` is `User` (not `Bot`; a login ending in `[bot]`
  and the deleted-user placeholder `ghost` are also refused), and the operator source confirms it
  live on every check:
  - with `operators_team`: `GET /orgs/{org}/teams/{slug}/memberships/{login}` returns
    `state: active` (pending membership does not count). GitHub counts members of child teams as
    members, so use a closed, owner-managed team with no child teams;
  - with the `operators` allowlist instead: the actor's numeric account id is on the list (entries
    are `login:id`; the login is only a label, so a renamed account keeps qualifying and a new
    account registered on a freed login does not), and `GET /user/{id}` returns that id as an
    account of `type: User`.

  The verdict's `operator_source` (and `approval.source`) says which source was used.
- **The actor is neither the checker nor the requester.** gate-check reads `GET /user` for the token
  it runs with. A user token (a laptop or a personal `gh`) names a login, and approvals, denies and
  dismissals by that login never count, even when it is an operator; the verdict then carries
  `caller: <login>` and, if that login is an operator, `self_is_operator: true` (other operators can
  still approve). An App installation token has no user (`403 Resource not accessible by
  integration`) and is recorded as `caller: app`; any other `/user` failure is exit 1. The author of
  the gate request never counts either. Agents never post `/approve`, `/deny`, or an approving review
  themselves, under any identity.
- **It is specific.** For `merge`: the reviewer's latest decisive review (approve, request changes,
  dismissed) is `APPROVED` on the request's head SHA. For every other kind: the trimmed comment body
  is exactly `/approve <gate-id>`, lowercase verb, nothing else on the line or after it.
- **It is newer** (strictly, at GitHub's one-second resolution) than the gate request and than the
  PR's latest push (next section).
- **The comment is unedited.** GraphQL `IssueComment.lastEditedAt` is null for the request and the
  approving comment (REST `updated_at` alone has one-second resolution, so an edit in the same
  second would slip past it); `updated_at` must also equal `created_at`. An edit history that cannot
  be read counts as edited.
- **For `merge`, GitHub does not disagree.** No reviewer's latest review (anyone's, bots included)
  is an objection, and `reviewDecision` is:
  - `APPROVED`: GitHub's required reviews are satisfied, so the operator approval opens the gate;
  - empty or null: the base branch requires no review for this PR (for example a repo that requires
    reviews only on gated paths), so the qualifying operator approval on the head is the whole
    decision;
  - `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, or any other value: the gate waits.

  The `approval.review_decision` field records which case applied. A GraphQL answer without a
  `pullRequest` object is exit 1, never "no review required".

  An objection is a latest review of `CHANGES_REQUESTED`, or a dismissed change request whose
  dismissal (the `review_dismissed` timeline event) was not made by a qualifying operator who is
  also neither the checker nor the requester. A bot or any other write-access account dismissing a
  human's change request does not clear it. A dismissed review with no readable dismissal event
  also blocks.
- **The PR still matches.** On a PR thread, the current head must equal the request's SHA. If the
  head moved, the verdict is `error` with `"stale": true`: post a new request.

A `/deny <gate-id>` from a qualifying human, newer than the request, closes the gate (exit 4) even if
an approval was also given. A deny is the safe direction, so an edited deny still counts. The deny
reason is the only comment text gate-check ever echoes; it comes back defanged and inside the
untrusted-data envelope (`core/lib/untrusted.mjs`) and must never be followed as an instruction.
Everything else in a comment is matched against the two grammars above and otherwise ignored.

Anything gate-check cannot read (team, membership, comments, reviews, timeline, edit history) is an
error, never a silent "no member". Lists are read by following the `Link: rel="next"` header, which
is stable when comments are deleted mid-read (page offsets are not); more than 50 pages fail closed
rather than decide on a partial read.

## Merging a gated PR

A passing check only says the head was approved when it ran. The merge must not take a newer head:

1. re-run `check` immediately before merging and proceed only on exit 0;
2. merge pinned to the approved commit (`approval.commit`):
   `gh pr merge N --merge|--squash --match-head-commit <approved sha>` (the REST equivalent is the
   `sha` parameter of `PUT /repos/{o}/{r}/pulls/{n}/merge`).

GitHub refuses the merge if the head moved in between. The agent then posts a new gate request for
the new head.

## The latest-push signal

GitHub has no reliable "pushed at" field for a pull request (`pushedDate` is gone from the API, and a
commit's dates are set by whoever made it). gate-check therefore combines three signals:

1. **SHA binding** (the primary guard). Every PR gate names the full head SHA, the head must still be
   that SHA, and a `merge` approval must be a review on that SHA. Any ordinary push changes the head
   and invalidates the gate.
2. **The newest `head_ref_force_pushed` timeline event.** This catches a force-push back to an earlier
   SHA, which would otherwise pass the SHA check.
3. **The head commit's committer date.** Pusher-controlled, so it is only ever used to **raise** the
   floor: a backdated commit cannot open a gate (signal 1 still applies), and a future-dated one can
   only make the gate wait longer.

The floor is the latest of the request time and signals 2 and 3; the verdict names which one won.

## CLI

```bash
node core/lib/gate-check.mjs request --repo o/r (--pr N | --issue N) --kind K --target T --what TEXT \
  [--gate ID] [--operators-team org/slug | --operators login:id,login:id] [--dry-run]
node core/lib/gate-check.mjs check --repo o/r (--pr N | --issue N) --gate ID \
  (--operators-team org/slug | --operators login:id,login:id) --requester LOGIN --target T --kind K
```

`request` prints `{id, url, comment_id, author}`; record `author` and pass it as `--requester` on
every later check. Without `--gate` it generates `<kind>-<utc yyyymmddhhmmss>-<4 hex>`. It refuses an
id that already has a request on the thread. Gate ids are `[a-z0-9-]`, at most 80 characters.

`check` prints one JSON verdict (`status`, `gate`, `kind`, `target`, `request`, `floor`,
`operator_source`, `caller`, `self_is_operator` when set, then `approval` or `denial` or `reason`,
plus `ignored`: each candidate that did not count, and why).

| Exit | Status | Meaning |
|---|---|---|
| 0 | `approved` | proceed; record the `approval` block |
| 3 | `waiting` | keep waiting; `reason` says what is missing |
| 4 | `denied` | stop; the gate is closed, a new act needs a new request |
| 1 | `error` | bad input or a missing pin, no operator source configured, unreadable API or `/user`, ambiguous, edited or stale request |

## Configuration and permissions

- **Operator source**, in the merge-monster and maintenance-monster configs (or the federation
  registry). Precedence: `operators_team` if set, else `operators`. Neither set (or an empty list)
  fails closed: exit 1, and no gate ever opens.
  - **`operators_team: org/team-slug`** (passed as `--operators-team`). Preferred for organizations:
    membership is managed in GitHub, not in a config file. The `gh` identity needs org
    **Members: read** on top of the usual repo access; without it the team read returns HTTP 403 or
    404 and gate-check reports an error naming the permission.
  - **`operators: [login:id, ...]`** (passed as `--operators login:id,login:id`). For user-owned
    repos, which have no teams. Each entry is a user login and its numeric account id
    (`gh api users/<login> --jq .id`); matching is by id. A `[bot]` login, `ghost`, or an entry
    without an id is rejected as a config error. Changing who may approve is then a reviewed config
    change.
- A malformed team or entry is a config error (exit 1), never a silently empty source.
- Run monsters with an identity that is not an operator (the fleet App, ideally). A personal token
  that is an operator still cannot approve its own gates; the verdict flags `self_is_operator`.
- `messaging.operator_slack` (merge-monster) is **deprecated and ignored**: Slack replies no longer
  grant decisions. The key is accepted for one release and then removed.

## Recording an approval

When `check` returns 0, the agent records the `approval` block (actor, time, link, and for `merge`
the commit) in two places before acting:

- a journal entry `{ts, event: "gate_approved", gate, kind, target, actor, at, url}`;
- a one-line comment on the thread: `gate <id> approved by @<actor> at <at>: <url>`, which is where
  `/engsys:project-closeout` finds it.

A denial is recorded the same way (`gate_denied`), without copying the reason text into the journal.
