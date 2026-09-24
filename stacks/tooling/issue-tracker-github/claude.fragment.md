## Issue tracking

- **Active tracker: GitHub Issues + Projects.** Agents use the `issue-tracker-github`
  skill for all issue and board operations (create/list/get/update/comment/close issue;
  create/add-to/query board; set board field; link PR).
- The `github` MCP (remote, OAuth) is only the fallback when `gh` auth/network fails — it
  can't do ProjectV2. If the remote endpoint refuses your account, add a local-scope
  override (`claude mcp add --scope local github …`) running the Docker image
  `ghcr.io/github/github-mcp-server` (`GITHUB_PERSONAL_ACCESS_TOKEN` from `GH_TOKEN`); don't use the deprecated
  `@modelcontextprotocol/server-github` npm package.
- PRs and CI stay on GitHub via `gh`. A merged PR closes its work item through the
  `Closes #<n>` convention (one keyword per line).

<!-- naturalize: confirm the repo (<owner>/<repo>) and the GitHub Project number + owner
(user/org) that hold the board, plus the Phase/Priority/Owner field option values. -->
