---
name: gh-cli
description: GitHub CLI (gh) reference for repositories, issues, pull requests, Actions, projects, releases, and GraphQL operations from the command line. Always prefer gh with --json and --jq over any GitHub MCP server.
---

# GitHub CLI (`gh`)

Use the `gh` CLI for all GitHub operations (issues, pull requests, Actions, ProjectsV2, releases, and GraphQL queries). Never use a GitHub MCP server (`mcp__github__*`): its tool schemas and responses are chatty, whereas `gh ... --json <fields> --jq <filter>` returns exact structured fields.

## Golden Rules

1. **Structured queries**: Always pass `--json <fields> --jq <filter>` when inspecting issues, PRs, runs, or releases so only the needed fields enter context.
2. **Never use HEREDOCs for bodies**: Write issue, PR, or comment markdown to `tmp/<slug>.md` using the file-write tool and pass `--body-file tmp/<slug>.md`.
3. **Explicit `--repo <owner>/<repo>`**: Pass `--repo <owner>/<repo>` when working across worktrees or multi-repo fleets.

## Common Workflows

### Issues

```bash
# List open issues with exact fields
gh issue list --repo <owner>/<repo> --state open --limit 50 \
  --json number,title,labels,assignees --jq '.[] | "\(.number)\t\(.title)"'

# View a single issue
gh issue view 42 --repo <owner>/<repo> --json number,title,body,labels,state

# Create an issue (write tmp/issue-body.md first)
gh issue create --repo <owner>/<repo> --title "feat(scope): summary" \
  --body-file tmp/issue-body.md --label "enhancement"

# Claim / update / comment
gh issue edit 42 --repo <owner>/<repo> --add-assignee @me --add-label "in-progress"
gh issue comment 42 --repo <owner>/<repo> --body-file tmp/comment.md
```

### Pull Requests

```bash
# Create PR (write tmp/pr-body-42.md first)
gh pr create --repo <owner>/<repo> --base main --head agent/42-slug \
  --title "feat(scope): summary (#42)" --body-file tmp/pr-body-42.md

# Check CI status and review state
gh pr view 42 --repo <owner>/<repo> --json state,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks 42 --repo <owner>/<repo>

# View diff or comments
gh pr diff 42 --repo <owner>/<repo>
gh api repos/<owner>/<repo>/pulls/42/comments --jq '.[] | {path, line, body}'
```

### GitHub Actions & Runs

```bash
# List recent workflow runs on a branch
gh run list --repo <owner>/<repo> --branch agent/42-slug --limit 5 \
  --json databaseId,name,status,conclusion

# Inspect failed job logs
gh run view <run-id> --repo <owner>/<repo> --log-failed
```

### GitHub ProjectsV2 (`gh project` & GraphQL)

```bash
# List projects and fields
gh project list --owner <owner> --format json
gh project field-list <number> --owner <owner> --format json
gh project item-list <number> --owner <owner> --limit 100 --format json

# Add an issue to a project board
gh project item-add <number> --owner <owner> --url https://github.com/<owner>/<repo>/issues/42

# Set a single-select or text field on a project item
gh project item-edit --id <item-id> --project-id <project-node-id> \
  --field-id <field-id> --single-select-option-id <option-id>
```

## Extended CLI Reference

For the full subcommand tree (`auth`, `codespace`, `gist`, `org`, `release`, `repo`, `secret`, `variable`, `search`, `api` pagination, and GraphQL mutations), see [`references/cli-reference.md`](references/cli-reference.md).
