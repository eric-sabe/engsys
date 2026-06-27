---
name: issue-tracker-github
description: Issue tracking and project-board operations on GitHub Issues + GitHub Projects (ProjectV2). Implements the shared issue-tracker operation contract (create/list/get/update/comment/close issue; create/add-to/query board; set board field; link PR) with concrete `gh` CLI and `gh api graphql` commands. Activate when the active tracker is GitHub and the work involves filing issues, managing a project board (Phase/Priority/Owner), or linking a PR to close a work item.
---

# Issue tracker: GitHub Issues + Projects

This skill is the GitHub implementation of the **shared issue-tracker operation
contract**. Commands and agents call these operations *by name* without knowing the
backend; the Linear pack (`issue-tracker-linear`) implements the same names so the two
are swappable. Keep the operation names below stable.

Builds on the knowledge already in the core `gh-cli` and `github-issues` skills — read
those for full `gh` flag coverage and issue-body templates. This skill does not repeat
them; it maps the **contract operations** onto concrete commands.

**Identifiers:** GitHub issues are referenced as `#123`. Boards are GitHub ProjectV2
("Projects"). The repo (`<owner>/<repo>`) and the Project number/owner are project facts —
read them from `CLAUDE.md`.

## Discipline: bodies come from tmp/ files, never heredocs

Every operation that writes multi-line markdown (issue body, comment, PR body) writes
the content to a `tmp/` file first and passes it with `--body-file`. Do **not** inline
multi-line bodies via heredoc/`echo` — it mangles backticks, quotes, and `$`. One-line
bodies may use `--body "..."`.

```bash
# Write the body, then reference it.
#   tmp/issue-body-<slug>.md
#   tmp/comment-<slug>.md
#   tmp/pr-body-<slug>.md
```

## Contract operations

### create-issue(title, body-from-tmp-file, type/label, [project, phase]) -> id + URL

```bash
# 1. Write the body to tmp/issue-body-<slug>.md (see github-issues for templates).
# 2. Create. --type/--label carries the contract "type/label". Prints the issue URL.
gh issue create \
  --repo <owner>/<repo> \
  --title "[Feature] <title>" \
  --body-file tmp/issue-body-<slug>.md \
  --label "<type-or-label>"
# Capture the number for downstream ops:
ISSUE_URL=$(gh issue create --repo <owner>/<repo> --title "<title>" \
  --body-file tmp/issue-body-<slug>.md --label "<label>")
ISSUE_NUM=$(basename "$ISSUE_URL")
```

If `[project, phase]` were supplied, follow with **add-to-board** below.

### list-issues(filter: state | label/type | assignee | project/phase)

```bash
gh issue list --repo <owner>/<repo> --state open
gh issue list --repo <owner>/<repo> --label bug
gh issue list --repo <owner>/<repo> --assignee @me
gh issue list --repo <owner>/<repo> --search "is:open label:bug" \
  --json number,title,labels,assignees
# Filter by project/phase => read the board (see query-board); Phase is a Project field,
# not an issue field, so it is queried through the Project, not `gh issue list`.
```

### get-issue(id)

```bash
gh issue view <id> --repo <owner>/<repo> \
  --json number,title,body,state,labels,assignees,comments
```

### update-issue(id, fields | labels | assignee)

```bash
gh issue edit <id> --repo <owner>/<repo> --title "<new title>"
gh issue edit <id> --repo <owner>/<repo> --body-file tmp/issue-body-<slug>.md
gh issue edit <id> --repo <owner>/<repo> --add-label ready --remove-label triage
gh issue edit <id> --repo <owner>/<repo> --add-assignee <user>
```

### comment-issue(id, body) — records local-review findings on the work item

```bash
# Write findings to tmp/comment-<slug>.md first, then:
gh issue comment <id> --repo <owner>/<repo> --body-file tmp/comment-<slug>.md
```

### close-issue(id)

```bash
gh issue close <id> --repo <owner>/<repo>
gh issue close <id> --repo <owner>/<repo> --comment "Resolved by #<pr>"
```

## Boards (GitHub ProjectV2)

The GitHub MCP does **not** support Projects — always use `gh project` / `gh api graphql`
for board operations. ProjectV2 lives at the **user or org** level (not the repo), so
board ops take `--owner <owner>` and the project **number**. Custom fields (Phase,
Priority, Owner) are ProjectV2 fields.

### create-board(name, fields: Phase, Priority, Owner)

```bash
# Create the project (board). --format json yields its number + id.
gh project create --owner <owner> --title "<name>" --format json
PROJECT_NUM=<number from output>

# Add the three contract fields.
#   Phase + Priority => single-select (their options are the allowed values)
#   Owner            => single-select of usernames, or text
gh project field-create <PROJECT_NUM> --owner <owner> \
  --name "Phase"    --data-type SINGLE_SELECT \
  --single-select-options "Phase 1,Phase 2,Phase 3,Phase 4"
gh project field-create <PROJECT_NUM> --owner <owner> \
  --name "Priority" --data-type SINGLE_SELECT \
  --single-select-options "P0,P1,P2,P3"
gh project field-create <PROJECT_NUM> --owner <owner> \
  --name "Owner"    --data-type TEXT
gh project field-list <PROJECT_NUM> --owner <owner>   # capture field ids + option ids
```

### add-to-board(issue, phase, priority, owner)

```bash
# Add the issue to the board; capture the item id it returns.
gh project item-add <PROJECT_NUM> --owner <owner> \
  --url https://github.com/<owner>/<repo>/issues/<issue>
ITEM_ID=<item id from item-add --format json>

# Set the three fields on that item (see set-board-field for the field/option ids).
```

### set-board-field(item, field, value)

```bash
# Single-select field (Phase, Priority): pass the option id.
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <PHASE_FIELD_ID> --single-select-option-id <PHASE_OPTION_ID>
# Text field (Owner):
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <OWNER_FIELD_ID> --text "<owner-username>"
```

`add-to-board` = `item-add` followed by one `set-board-field` per field (Phase, Priority,
Owner). Get the `<PROJECT_ID>`, field ids, and option ids from `field-list --format json`
once and reuse them.

### query-board(board) -> items grouped by Phase

The "pick the lowest open phase" read. `gh project item-list` flattens fields; group by
the Phase value. For full fidelity use GraphQL:

```bash
gh project item-list <PROJECT_NUM> --owner <owner> --format json \
  --jq '.items
        | map({num: .content.number, title: .content.title, phase: .phase, status: .status})
        | group_by(.phase)'

# GraphQL equivalent (open items, their Phase field value):
gh api graphql -f query='
  query($org:String!, $num:Int!){
    organization(login:$org){
      projectV2(number:$num){
        items(first:100){
          nodes{
            content{ ... on Issue { number title state } }
            fieldValueByName(name:"Phase"){
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }' -f org=<owner> -F num=<PROJECT_NUM>
```

To pick the lowest open phase: filter to open issues, take the minimum `Phase` value
present.

### close-board(board) — close the project once every issue is done

Close the ProjectV2 so the board drops out of the active list — but **only when every
issue on it is closed**. The project `item-list` `state` field is UNRELIABLE (often
returns null/`?`), so do not trust it: intersect the board's issue numbers with the
actually-open issues and require the intersection to be empty.

```bash
# issue numbers on the board…
gh project item-list <PROJECT_NUM> --owner <owner> --format json --limit 400 \
  | jq -r '.items[].content | select(.type=="Issue") | .number' | sort -u > /tmp/proj_issues.txt
# …cross-checked against actually-open issues (NOT the board's state field)
gh issue list --repo <owner>/<repo> --state open --limit 900 --json number --jq '.[].number' \
  | sort -u > /tmp/open_issues.txt
comm -12 /tmp/proj_issues.txt /tmp/open_issues.txt   # ← MUST be empty before closing

# if the intersection is empty:
gh project close <PROJECT_NUM> --owner <owner>
```

- **Gate:** any issue still open → do NOT close (the project isn't done; stop and
  report). Draft cards / notes (non-issue items) do **not** gate — only real issues do.
- Reversible: `gh project close <PROJECT_NUM> --owner <owner> --undo` reopens it.
  Closing archives the board from the active view; it does not delete the project or its
  items.

## link-pr(issue, pr) — how a merged PR closes/links the work item

GitHub auto-closes linked issues when a PR merges if the PR body contains a closing
keyword. **One keyword per line — never comma-separated** (GitHub closes only the first
issue on a comma-separated line).

```bash
# Write the PR body to tmp/pr-body-<slug>.md with one closing keyword per line:
#   Closes #<issue>
#   Closes #<other-issue>
gh pr create --repo <owner>/<repo> --title "<title>" \
  --body-file tmp/pr-body-<slug>.md
```

On merge, GitHub closes each referenced issue and records the PR link on it. PRs and CI
stay on GitHub (`gh`).

## Hard-won lessons

GitHub Issues/Projects API gotchas that fail silently or destructively. Each is
Symptom / Cause / Fix.

### Verify a label exists before filing an issue with it

- **Symptom:** `gh issue create --label X` errors with `could not add label: 'X' not found`
  and the issue is **not** created — no partial success. Batch issue-filing runs waste every
  `gh` call when an assumed label (`dashboard`, `recommendation-engine`) isn't the repo's
  actual label (`frontend`, `recommendation`).
- **Cause:** `gh` rejects the whole create when any `--label` doesn't exist in the repo.
- **Fix:** List labels first and map your intent → real names before filing:
  ```bash
  gh label list --repo <owner>/<repo> --limit 100 --json name --jq '.[].name' | sort
  ```
  Don't trust cached label lists from prior runs — query the live list each time.

### ProjectV2 single-select fields are GraphQL-only

- **Symptom:** A fresh `gh project create` board has only built-in fields (`Title`,
  `Assignees`, `Status`, `Labels`, …). There's no `gh` shortcut to add a single-select field
  with options (Phase / Priority / Owner), so operators end up configuring them by hand in the
  UI for every issue.
- **Cause:** The `gh` CLI has no subcommand to create or edit a single-select field's option
  list — `field-create` makes a field, `field-delete` removes one, `item-edit` sets a value on
  an item; none append/rename options on an existing single-select field.
- **Fix:** Create and edit single-select fields with `gh api graphql` (`createProjectV2Field`
  with `dataType: SINGLE_SELECT` and `singleSelectOptions`). Verify with
  `gh project field-list <num> --owner <owner>` before assuming `Status` is the only field.

### updateProjectV2Field preserves option IDs verbatim — pass the full set

- **Symptom:** Adding one new option to an existing single-select field (e.g. a new Phase)
  silently orphans **every** previously-categorized item to "(no phase)" — the value vanishes
  from each item even though the field still exists. Observed: 21 items lost their Phase on one
  add.
- **Cause:** `updateProjectV2Field` treats `singleSelectOptions` as the **authoritative state**,
  not a delta. Omitting existing options regenerates all option IDs, orphaning every board item
  that referenced an old ID.
- **Fix:** First fetch the existing options + IDs, then call `updateProjectV2Field` with the
  **full** array — every existing option's `id` reused verbatim plus the new one appended.
  Afterward audit immediately and re-set any orphans:
  ```bash
  gh project item-list <num> --owner <owner> --format json \
    | jq '[.items[] | select(.phase == null)] | length'   # must be 0
  ```

## See also

- core `gh-cli` — full `gh` command/flag reference.
- core `github-issues` — issue-body templates, labels, MCP fallback.
- core `github-actions` — workflow expression/injection/draft-gate/rate-limit lessons.
