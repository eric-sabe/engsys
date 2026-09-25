## Issue tracking

- **Active tracker: GitHub Issues + Projects.** Agents use the `issue-tracker-github`
  skill for all issue and board operations (create/list/get/update/comment/close issue;
  create/add-to/query board; set board field; link PR).
- **`gh` only — no GitHub MCP server.** The GitHub MCP server's tool schemas and responses are large and chatty; `gh … --json --jq` returns exactly what's needed (and
  `gh` covers ProjectV2, which the MCP server doesn't). If `gh` auth or network fails, fix `gh`.
- PRs and CI stay on GitHub via `gh`. A merged PR closes its work item through the
  `Closes #<n>` convention (one keyword per line).

<!-- naturalize: confirm the repo (<owner>/<repo>) and the GitHub Project number + owner
(user/org) that hold the board, plus the Phase/Priority/Owner field option values. -->
