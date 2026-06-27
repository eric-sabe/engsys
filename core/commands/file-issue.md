---
description: File a tracker issue using Bert's workflow (investigate, write body to tmp/, create via the issue-tracker skill)
argument-hint: <brief description of the issue>
---

Use the **bert** subagent to investigate and file an issue. Full reference: [.claude/workflows/issue-tracking.md](.claude/workflows/issue-tracking.md).

Relies on the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) for the issue write; its named operations work the same whether the tracker is GitHub or Linear.

Issue context: $ARGUMENTS

Bert should:

1. **Investigate** the codebase for the real root cause — no surface-level fixes, no band-aids.
2. **Write the body** to `tmp/issue-body-<slug>.md` using the Write tool. No heredocs / cat pipes.
3. **Classify the issue** by type and lead the title with the matching emoji: 🐛 bug · ✨ feature · 💄 enhancement · 📄 content · 🏗️ infrastructure. Body should cover problem/RCA, evidence with `file:line`, fix direction, and acceptance criteria.
4. **Create the issue** via the project's issue-tracker skill's `create-issue` operation (`.claude/skills/issue-tracker-*/`), passing the `tmp/issue-body-<slug>.md` body file, the title, and the `<type>[,<area>]` label(s). On GitHub the skill runs `gh issue create --body-file …`.
5. **Report back**: number/ID, URL, short RCA + fix summary, labels.

Conventions: `CLAUDE.md` § Filing issues.

If unsure whether to file or fix: ask. Typos and one-liners just fix.
