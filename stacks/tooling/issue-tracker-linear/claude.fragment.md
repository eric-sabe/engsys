## Issue tracking

- **Active tracker: Linear.** Agents use the `issue-tracker-linear` skill for all issue
  and board operations (via the Linear MCP): create/list/get/update/comment/close issue;
  create/add-to/query board; set board field; link PR.
- PRs and CI stay on GitHub via `gh`; Linear auto-links them through its GitHub
  integration (magic words like `Fixes ABC-123` in the PR title/description, or a branch
  named `<team>-<n>-slug`).
- The board maps to a Linear **Project**; **Phase**→milestone, **Priority**→native issue
  priority, **Owner**→assignee.

The Linear MCP connector (`https://mcp.linear.app/mcp`, configured in this pack's
`settings.fragment.json`) must be enabled and authorized in the session for the skill to
reach Linear.

<!-- naturalize: set the Linear team key (e.g. ABC) and the project that holds the board.
team-key: <TEAM_KEY> -->
