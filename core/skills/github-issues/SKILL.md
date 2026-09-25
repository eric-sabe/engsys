---
name: github-issues
description: 'Create, update, and manage GitHub issues with the gh CLI. Use this skill when users want to create bug reports, feature requests, or task issues, update existing issues, add labels/assignees/milestones, or manage issue workflows. Triggers on requests like "create an issue", "file a bug", "request a feature", "update issue X", or any GitHub issue management task.'
---

# GitHub Issues

Manage GitHub issues with the **`gh` CLI** — issues, labels, assignees, milestones, comments, and
Projects (`gh project` / `gh api graphql`). Don't use a GitHub MCP server for this: its tool schemas
and responses are large and chatty, while `gh … --json <fields> --jq <filter>` returns exactly what
you asked for.

## Workflow

1. **Determine action**: create, update, or query?
2. **Gather context**: repo, existing labels, milestones if needed (`gh label list`, `gh api repos/<owner>/<repo>/milestones`)
3. **Structure content**: use the matching template from [references/templates.md](references/templates.md)
4. **Execute** with `gh` (below)
5. **Confirm**: report the issue URL

## Creating Issues

Write the body to a file first (long bodies and backticks survive intact), then:

```bash
gh issue create \
  --repo <owner>/<repo> \
  --title "[Bug] Description" \
  --body-file tmp/issue-body-slug.md \
  --label "bug,<component>" \
  [--assignee <user>] [--milestone "<milestone title>"]
```

### Title Guidelines

- Start with type prefix when useful: `[Bug]`, `[Feature]`, `[Docs]`
- Be specific and actionable
- Keep under 72 characters
- Examples:
  - `[Bug] Login fails with SSO enabled`
  - `[Feature] Add dark mode support`
  - `Add unit tests for auth module`

### Body Structure

Always use the templates in [references/templates.md](references/templates.md). Choose based on issue type:

| User Request                    | Template        |
| ------------------------------- | --------------- |
| Bug, error, broken, not working | Bug Report      |
| Feature, enhancement, add, new  | Feature Request |
| Task, chore, refactor, update   | Task            |

## Updating Issues

Change only what's needed — fetch first so you don't clobber fields:

```bash
gh issue view <n> --repo <owner>/<repo> --json title,body,labels,assignees,milestone,state
gh issue edit <n> --repo <owner>/<repo> [--title …] [--body-file …] \
  [--add-label …] [--remove-label …] [--add-assignee …] [--milestone "…"]
gh issue comment <n> --repo <owner>/<repo> --body-file tmp/comment.md
gh issue close <n> --repo <owner>/<repo> [--comment "…"]   # or: gh issue reopen <n>
```

## Querying Issues

```bash
gh issue list --repo <owner>/<repo> --state open --label bug --json number,title,labels --jq '.[] | "\(.number) \(.title)"'
gh search issues --repo <owner>/<repo> "<text>" --json number,title,state
```

## Examples

### Bug report

**User**: "Create a bug issue — the login page crashes when using SSO"

Write `tmp/issue-sso-crash.md` from the Bug Report template (description, steps to reproduce,
expected vs actual behavior, environment, context), then:

```bash
gh issue create --repo <owner>/<repo> --title "[Bug] Login page crashes when using SSO" \
  --body-file tmp/issue-sso-crash.md --label bug
```

### Feature request

**User**: "Create a feature request for dark mode with high priority"

Write `tmp/issue-dark-mode.md` from the Feature Request template (summary, motivation, proposed
solution, acceptance criteria), then:

```bash
gh issue create --repo <owner>/<repo> --title "[Feature] Add dark mode support" \
  --body-file tmp/issue-dark-mode.md --label "enhancement,high-priority"
```

## Common Labels

Use these standard labels when applicable:

| Label              | Use For                       |
| ------------------ | ----------------------------- |
| `bug`              | Something isn't working       |
| `enhancement`      | New feature or improvement    |
| `documentation`    | Documentation updates         |
| `good first issue` | Good for newcomers            |
| `help wanted`      | Extra attention needed        |
| `question`         | Further information requested |
| `wontfix`          | Will not be addressed         |
| `duplicate`        | Already exists                |
| `high-priority`    | Urgent issues                 |

## Tips

- Always confirm the repository context before creating issues
- Ask for missing critical information rather than guessing
- Link related issues when known: `Related to #123`
- For updates, fetch current issue first to preserve unchanged fields
