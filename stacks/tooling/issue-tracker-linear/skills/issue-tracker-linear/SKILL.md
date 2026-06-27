---
name: issue-tracker-linear
description: Issue tracking and project-board operations on Linear, via the Linear MCP. Implements the shared issue-tracker operation contract (create/list/get/update/comment/close issue; create/add-to/query board; set board field; link PR) mapped onto Linear issues, projects, milestones, priorities, and assignees. Activate when the active tracker is Linear and the work involves filing issues, managing a Linear project/board (Phase/Priority/Owner), or linking a PR to close a work item.
---

# Issue tracker: Linear

This skill is the Linear implementation of the **shared issue-tracker operation
contract**. Commands and agents call these operations *by name* without knowing the
backend; the GitHub pack (`issue-tracker-github`) implements the same names, so the two
are swappable. Keep the operation names below stable.

Linear is reached through the **Linear MCP** (tools prefixed `mcp__claude_ai_Linear__`).
There is no Linear CLI — every operation is an MCP tool call, so this pack adds no Bash
permissions. If the tools are not visible in the session, discover them via tool search;
the MCP connector must be enabled (see the pack's `claude.fragment.md`).

**Note — no separate create tool:** `save_issue`, `save_project`, and `save_milestone`
each do **both create and update** (omit the id to create, pass it to update).

## Project facts (naturalize)

The Linear **team** and **project** are project facts. Read the **team key** (e.g.
`ABC`) from `CLAUDE.md`. Resolve the team/project to their ids once via `list_teams` /
`list_projects` and reuse them.

### Identifier mapping

| Backend | Issue id form        |
| ------- | -------------------- |
| GitHub  | `#123`               |
| Linear  | `ABC-123` (team-prefixed) |

Callers may pass either the human identifier (`ABC-123`) or the issue's internal id;
`get_issue` / `save_issue` accept the identifier.

## Contract -> Linear mapping (board fields)

A contract "board" is a **Linear Project**. The board's three custom fields map onto
native Linear concepts — there are no ad-hoc custom fields:

| Contract field | Linear concept                        | Tool to set it                          |
| -------------- | ------------------------------------- | --------------------------------------- |
| Board          | **Project**                           | `save_project`                          |
| Phase          | **Milestone** (project milestone)     | `save_milestone` + `save_issue` (milestone) |
| Priority       | **Issue priority** (native, 0–4)      | `save_issue` (priority)                 |
| Owner          | **Assignee**                          | `save_issue` (assignee)                 |
| State/Status   | **Workflow state** (Todo/Done/…)      | `save_issue` (state via `list_issue_statuses`) |

(Phase may alternatively map to a **label set** instead of milestones; prefer milestones
— they are ordered, which makes "lowest open phase" a natural sort.)

## Contract operations

### create-issue(title, body-from-tmp-file, type/label, [project, phase]) -> id + URL

`save_issue` with no id creates. Set `team` (the team key), `title`, `description`
(the body), `labels` (the contract type/label), and optionally `assignee`, `project`,
`priority`. Read the long markdown body from `tmp/issue-body-<slug>.md` and pass its
contents as `description` (real newlines, not `\n`).

```text
save_issue(team: "ABC", title: "<title>", description: <contents of tmp/issue-body-<slug>.md>,
           labels: ["<type-or-label>"], assignee: <owner?>, project: <project?>)
-> returns the issue identifier (ABC-123) and URL.
```

If `[project, phase]` were supplied, follow with **add-to-board**.

### list-issues(filter: state | label/type | assignee | project/phase)

`list_issues` with the matching filter (filter by `team`, `project`, `state`/status,
`assignee`, `label`, or `cycle`). For a project/phase filter, list by `project` and
read each issue's milestone (see query-board).

### get-issue(id)

`get_issue(id: "ABC-123")` -> full issue (title, description, state, labels, assignee,
priority, project, milestone).

### update-issue(id, fields | labels | assignee)

`save_issue` **with the id** updates only the passed fields:

```text
save_issue(id: "ABC-123", title?: ..., description?: ..., labels?: [...], assignee?: ...)
```

### comment-issue(id, body) — records local-review findings on the work item

`save_comment(issueId: "ABC-123", body: <contents of tmp/comment-<slug>.md>)`.

### close-issue(id)

Linear has no "close" verb — set the issue to a **Done** (or **Canceled**) workflow
state. Resolve the state id once via `list_issue_statuses(team: "ABC")`, then:

```text
save_issue(id: "ABC-123", state: "Done")   # or "Canceled"
```

## Boards (Linear Projects + Milestones)

### create-board(name, fields: Phase, Priority, Owner)

`save_project(name: "<name>", teamId: <team>)` creates the project (board). Then create
one **milestone per Phase** (these are the Phase field's values):

```text
save_project(name: "<name>", teams: ["ABC"])         -> project id
save_milestone(projectId: <project>, name: "Phase 1")
save_milestone(projectId: <project>, name: "Phase 2")
save_milestone(projectId: <project>, name: "Phase 3")
```

Priority and Owner need no setup — they are native issue fields (priority, assignee).

### add-to-board(issue, phase, priority, owner)

One `save_issue` setting all four:

```text
save_issue(id: "ABC-123",
           project:  <project>,
           milestone: <milestone for "phase">,   # Phase
           priority:  <0–4>,                      # Priority (1=Urgent … 4=Low, 0=None)
           assignee:  "<owner>")                  # Owner
```

Resolve the milestone for a phase via `list_milestones(projectId: <project>)`.

### set-board-field(item, field, value)

All board fields are issue fields, so this is `save_issue` with the one field:

```text
save_issue(id: "ABC-123", milestone: <…>)   # Phase
save_issue(id: "ABC-123", priority: <0–4>)  # Priority
save_issue(id: "ABC-123", assignee: <…>)    # Owner
```

### query-board(board) -> items grouped by Phase

`list_issues(project: <project>)`, then group the results by each issue's **milestone**
(Phase). To "pick the lowest open phase": filter to non-Done issues, group by milestone,
and take the earliest milestone (milestones are ordered) that still has open issues.
Use `list_milestones(projectId: <project>)` for the canonical phase order.

### close-board(board) — close the project once every issue is done

Mark the Linear **project** Completed so it drops off the active board — but **only when
every issue in it is Done or Canceled**. Check with `list_issues(project: <project>)` and
confirm none remain in a non-terminal state (use `list_issue_statuses(team: "ABC")` to
know which states are terminal); the count of non-terminal issues must be zero.

```
save_project(id: <project>, state: "completed")   # Linear project status → Completed
```

- **Gate:** any issue still open / in progress → do NOT complete the project (it isn't
  done; stop and report).
- Reversible: re-open by setting the project state back (e.g. `"started"`). Completing
  drops it from the active view; it does not delete the project or its issues.

## link-pr(issue, pr) — how a merged PR closes/links the work item

PRs and CI stay on **GitHub** (`gh`). Linear's GitHub integration auto-links and
auto-closes the issue via **magic words**, no MCP call needed:

- Branch named `<team>-<n>-slug` (e.g. `abc-123-fix-login`) — Linear links it
  automatically, and
- a closing magic word in the **PR title or description**: `Fixes ABC-123`,
  `Closes ABC-123`, `Resolves ABC-123`.

When the PR merges, Linear moves `ABC-123` to its Done state and records the PR link.
So `link-pr` is realized by naming the branch / writing the magic word when the PR is
created via `gh` — there is no separate Linear tool call.

## See also

- The GitHub pack `issue-tracker-github` implements the same contract on GitHub Issues +
  Projects — same operation names, swappable backend.
- core `gh-cli` — PR creation (`gh pr create`) still goes through GitHub.
