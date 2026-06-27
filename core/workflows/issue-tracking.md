# Issue Tracking Workflow

How to investigate, file, and track tracker issues. Covers Bert's investigation + filing role. For implementation, see [agent-implementation-workflow.md](agent-implementation-workflow.md).

This workflow relies on the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) for the actual issue reads/writes. It calls the skill's contract operations by name (`create-issue`, `list-issues`, `get-issue`, `update-issue`, `comment-issue`, `close-issue`, `link-pr`); the skill maps them onto the active backend (GitHub `gh` shown below, or Linear).

---

## Filing an Issue

### 1. Investigate first

Before creating an issue, locate the root cause — don't file on symptoms.

- Search the codebase for the relevant code paths.
- Read the actual files (don't guess from filenames).
- Identify affected files with line numbers.
- Check `docs/architecture/` for context.
- Formulate the **correct, robust solution** — no workarounds, no "fix later" stubs.

### 2. Create the issue body in tmp/

**Never use HEREDOC or pipes for issue bodies. Always write to `tmp/` first** — this tmp/-file discipline is universal across trackers.

Write the body with the Write tool → `tmp/issue-body-<slug>.md`, then create the issue via the issue-tracker skill's **`create-issue`** operation, passing the body file, title, and `<type>,<area>` label(s). On GitHub the skill runs:

```bash
# After tmp/issue-body-<slug>.md is written:
gh issue create \
  --title "<emoji> <Type>: <description>" \
  --body-file tmp/issue-body-<slug>.md \
  --label "<type>,<area>"

rm tmp/issue-body-<slug>.md
```

### 3. The issue body must include

- **Summary** — what's broken or what's being added.
- **Root cause** (bugs) or **motivation** (features/enhancements).
- **Affected files** with line numbers.
- **Recommended solution** — the correct approach, not a workaround.
- **Acceptance criteria** — testable, specific.
- **Dependencies** — what must be done first.
- **Effort** — S / M / L.
- **Owner** — which agent persona.

---

## Title Format

| Type           | Format                          |
| -------------- | ------------------------------- |
| Bug            | `🐛 Bug: <description>`         |
| Feature        | `✨ Feature: <description>`     |
| Enhancement    | `💄 Enhancement: <description>` |
| Content        | `📄 Content: <description>`     |
| Infrastructure | `🏗️ Infra: <description>`       |
| Epic           | `Epic: <description>`           |

---

## Labels

**Type** (pick one): `bug`, `feature`, `enhancement`, `content`, `infrastructure`.

**Area** (pick one): the project's service/module areas (declared in `CLAUDE.md` / the project's label set).

**Implementation-ready signal**: if the issue has clear acceptance criteria and no architectural ambiguity, note it in the body (e.g. "Self-contained, ready for implementation").

---

## Commit Message Format

Reference the issue number in every commit on the implementing branch:

```text
feat(<scope>): add invite endpoint (#131)
fix(auth): clean up placeholder user on login (#136)
refactor(tenant): extract PLAN_LIMITS constant (#133)
```

---

## When Implementation is Ready

Follow [agent-implementation-workflow.md](agent-implementation-workflow.md) — worktree setup, verify, push, PR.

Link/close the work item per the issue-tracker skill's **`link-pr`** operation. On GitHub, `Closes #<number>` in the PR body auto-closes the issue on merge; batch PRs must use one closing keyword per issue, one per line (a comma-list only closes the first). Other trackers close the work item per the skill. (PR creation itself stays on `gh pr create` — PRs are a code-host concern.)
