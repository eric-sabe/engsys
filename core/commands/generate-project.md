---
description: Generate a feature spec, plan, and tracker project from a goal (multi-agent design loop through Leith, Melvin, Nyx, Gary, Marcelo, Jody)
argument-hint: <goal description, plus any attachment paths or links>
---

Follow the 8-phase workflow in [.claude/workflows/generate-project.md](.claude/workflows/generate-project.md).

Tracker project + issue writes go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) and its named operations (`create-issue`, `create-board`, `add-to-board`, `set-board-field`, `query-board`) — the same flow works whether the tracker is GitHub or Linear. On GitHub the skill carries the `gh project` / `gh api graphql` specifics.

Goal: $ARGUMENTS

## Quick orientation

You (the main session) are the orchestrator. Subagents enrich the spec; you reconcile and own the merge.

**Subagents** (`.claude/agents/`):

- **leith** — product/UX, user stories, acceptance criteria from a user perspective
- **melvin** — architecture, service impact, data/consistency, scale/latency/cost
- **nyx** — security/privacy, threat model, tenant isolation, abuse cases
- **gary** — design expert, comprehension/usability audit of the spec's user-facing sections
- **marcelo** — testing strategy, input validation matrix, quality gates
- **jody** — phased plan, tracker project + issues, dependencies, owner/labels

**Phase sequence** (per the workflow doc):

1. **Intake** — capture goal, attachments, constraints.
2. **Explore** — `docs/agent-lessons/` (project-local lessons), `docs/architecture/`, `CLAUDE.md`, existing specs, related code, existing issues/projects.
3. **Clarifying questions** — one batched set, 5–8 max, each unlocks a decision.
4. **Draft spec** — `docs/specs/<feature-slug>.md` with the section skeleton from the workflow doc.
5. **Design loop** — Leith and Melvin in parallel, then Nyx and Gary in parallel, reconcile findings, then Marcelo, then Jody.
6. **Tracker project mechanics** — use the issue-tracker skill's `create-board` / `add-to-board` / `set-board-field` operations to stand up the board and set Phase/Priority/Owner (on GitHub these run `gh project` / `gh api graphql` for ProjectV2; the `github` MCP doesn't do projects). Issue bodies in `tmp/issue-body-<slug>.md` via `create-issue` — never heredoc.
7. **Sanity check** — fresh subagent (e.g. `Plan` or `general-purpose`) reviews spec/project/issues with no design-loop context.
8. **Reflect** — durable lessons → `docs/agent-lessons/` (and PR generalizable ones back to the engsys `lessons-library/`); agent role changes → `.claude/agents/*.md`; automatic behaviors → `CLAUDE.md` or `.claude/commands/*.md`.

## Key invariants

- Don't ask generic questions before exploring the repo.
- Don't proceed past Nyx until security-required product/architecture changes are reconciled.
- One project phase = one implementation PR. Each issue = one commit. This shape must hold in Jody's plan so [/implement-issue](implement-issue.md) and [/implement-project](implement-project.md) work cleanly downstream.
- Boards and custom fields go through the issue-tracker skill's `create-board` / `set-board-field` operations. On GitHub those **must** use `gh project` / `gh api graphql` (the `github` MCP server doesn't support ProjectV2); the skill handles that.
- Every project carries a `Phase` single-select field with `P<n>: <name>` options — without it `/implement-project` can't batch. No item may be left with an empty Phase.
- Issue bodies in `tmp/issue-body-<slug>.md`, created via the skill's `create-issue` operation (GitHub: `gh issue create --body-file …`). Never HEREDOC.
- Final report: spec path, project URL, issues by phase, subagent contributions, sanity-check result, learning updates, open questions, explicit request for operator review before implementation starts.

See `CLAUDE.md` for the project's tool-preference order and filing-issue conventions, and the installed issue-tracker skill (`.claude/skills/issue-tracker-*/`) for the concrete board/issue mechanics on the active tracker.
