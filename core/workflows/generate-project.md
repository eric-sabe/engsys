# Generate Project Workflow

Use this workflow when the operator asks to generate a feature design, spec, plan, or project from a goal. Output is a reviewed draft spec in `docs/specs/`, an organized tracker project, phased issues, and updated agent learning where useful.

Invocation examples:

```text
/generate-project <goal> [attachments...]
generate project: <goal>
build a feature spec/plan for <goal>
```

---

## Operating Rules

- Explore first. Do not ask generic questions until you have read relevant code, docs, existing issues/projects, and attachments.
- Batch clarifying questions. Ask once, wait for answers, then proceed.
- Use subagents for perspective, not delegation drift. The parent agent owns the spec and reconciles conflicts.
- Make the spec the shared source of truth. Every subagent enriches `docs/specs/<slug>.md` directly or returns structured content for the parent to merge.
- Tracker project + issue writes go through the project's installed **issue-tracker skill** (`.claude/skills/issue-tracker-*/`) and its contract operations (`create-issue`, `create-board`, `add-to-board`, `set-board-field`, `query-board`). The skill maps them onto the active backend; on GitHub it uses `gh` (ProjectV2 MCP tools are unsupported there, so the skill drives `gh project` / `gh api graphql`).
- Write issue bodies to `tmp/` and create them via the skill's `create-issue` operation (GitHub: `gh issue create --body-file`). Never HEREDOC issue bodies — the tmp/-file discipline is universal.
- Issue-body invariants (every one of these has been a sanity-check finding at least once):
  - Every body carries one context line: `Part of [<project name> — project <N>](<board url>) · spec: docs/specs/<slug>.md`. Section citations ("spec §2.2") are unresolvable without it.
  - No placeholder cross-references (`#BUNDLE`, `#SERIALIZER`, ALL-CAPS tokens). Create issues in dependency order or backfill numbers after creation, then **grep all bodies for placeholders** before declaring done. Bare `#<small-number>` shorthand for non-issue concepts (e.g. "punch item 12") autolinks to the wrong issue — write "punch item 12" or use the real issue #.
  - Counts in acceptance criteria must be **call sites, not grep lines** (imports inflate grep counts) — state the exact grep that reproduces the number inside the issue.
  - One implementation PR per phase means a phase must be one-PR-sized; split infra (which may trigger a deploy workflow) from app code into separate phases.
- Optimize final specs, lessons, rules, and agent instructions for future LLM retrieval.

---

## Phase 0: Intake

The operator provides:

- The goal or product outcome.
- Relevant attachments: screenshots, docs, links, logs, issue lists, customer notes, designs, or code pointers.
- Optional constraints: deadline, scope, target user, tier, services, non-goals, project naming.

Record initial assumptions in the draft spec later, but do not freeze them before exploration.

---

## Phase 1: Explore Context

Build informed questions from evidence.

Read:

- `docs/agent-lessons/` (and the engsys lessons-library if linked)
- `docs/architecture/` relevant pages
- project rules / `CLAUDE.md`
- `.claude/agents/{leith,melvin,nyx,marcelo,jody}.md`
- Existing specs in `docs/specs/`
- Related source files, routes, services, schemas, UI components, tests, seed scripts
- Provided attachments and linked resources
- Existing tracker issues/projects if the goal references them

Capture: user/persona affected, current behavior, data model & API surface touched, service boundaries, security/auth/tenant implications, test surfaces and existing coverage, and unknowns that materially change product, architecture, security, testing, or plan shape.

Do not over-explore. Stop when questions are specific and answerable.

---

## Phase 2: Ask Clarifying Questions

Ask the operator one batched set of clarifying questions. Prefer structured options when possible.

Quality bar: no questions answerable from repo/docs; no more than 5–8 unless genuinely ambiguous; each question explains the decision it unlocks; include recommended defaults when useful.

Good categories: target users and primary job-to-be-done; must-have vs deferred; data visibility and tenant boundaries; integration/source-of-truth choices; rollout/entitlement/tier constraints; success metrics; design constraints from attachments.

After the operator answers, update assumptions and proceed. If answers conflict with repo reality, call that out and choose the safer interpretation.

---

## Phase 3: Start Draft Spec

Create `docs/specs/<feature-slug>.md`:

```markdown
# <Feature / Project Name>

Status: Draft
Owner: <operator or team>
Generated: <date>

## Goal

## Context

## Operator Inputs

## Assumptions

## Non-Goals

## Open Questions

## Product and UX Specification

## Architecture Specification

## Security and Privacy Specification

## Testing Strategy

## Phased Project Plan

## Tracker Project and Issues

## Implementation Notes

## Review Checklist
```

Frame the goal and context before launching subagents so each receives the same baseline.

---

## Phase 4: Design Loop

Launch Leith and Melvin in parallel when possible, then Nyx and Gary in parallel on the merged draft, then reconcile, then Marcelo, then Jody. Pass each subagent the goal, answered clarifications, an attachments summary, the spec path, and the exact requested output.

Subagents do not automatically know parent context. Include enough detail in every prompt for autonomous work.

### 4A: Leith — Product/UX

Enrich the spec with: product problem and target persona; user stories and jobs-to-be-done; happy path, sad paths, empty/loading/error states; information architecture and navigation entry points; UI behavior, copy intent, accessibility expectations; acceptance criteria from a user perspective; product tradeoffs and recommended scope boundaries. Returns structured markdown for `Product and UX Specification`.

### 4B: Melvin — Architecture

Enrich the spec with: whole-app architecture impact; affected services, modules, APIs, schemas, queues, jobs, integrations; data ownership and consistency model; latency, scale, cost, observability, failure modes; migration/backfill/rollout strategy; implementation invariants and constraints; architecture acceptance criteria. Returns structured markdown for `Architecture Specification`.

### 4C: Nyx — Security

Given the merged Leith+Melvin draft, enrich with: threat model and trust boundaries; tenant isolation risks; authn/authz requirements; abuse cases and attacker stories; input validation and output encoding; secrets, logging, audit, PII, data retention; security tests and required mitigations; must-fix design changes vs acceptable follow-ups. Returns `Security and Privacy Specification` and a list of required changes.

### 4D: Gary — Comprehension

Given the merged Leith+Melvin draft, walk it the way he'd audit a shipped surface: cognitive walkthrough of the happy and sad paths, unambiguous and testable acceptance criteria, states or flows a real user could get stuck in, copy and IA a skeptical reader would actually follow. Returns severity-ranked findings (0–4) — comprehension problems are cheaper to catch on paper than after Isabelle builds them.

### 4E: Reconcile Nyx and Gary Findings

If Nyx or Gary identify required changes: send product/interaction and comprehension findings back to Leith, architecture/platform findings back to Melvin; ask for revised spec patches (not new standalone opinions); merge revisions; keep unresolved disagreements in `Open Questions` with a recommended decision. **Do not proceed to testing strategy while security-required product or architecture changes, or severity 3–4 comprehension findings, are unresolved.**

### 4F: Marcelo — Testing Strategy

Given the reconciled sections, enrich with: testability assessment; unit/integration/E2E/contract/security/performance/accessibility test strategy; input validation matrix for every accepted input; regression impact; seed data/fixtures/factories/local dev data needs; CI quality gates; manual verification paths; test ownership and issue recommendations. Returns `Testing Strategy` and test work items for Jody.

### 4G: Jody — Planning and Project Creation

Given the full reconciled spec, ask Jody to: convert it into a phased project plan; define phases that map to future implementation PR batches; create ordered, labeled tracker issues (with dependencies, acceptance criteria, owner persona, labels, test obligations) via the issue-tracker skill's `create-issue` operation; create the tracker board with the skill's `create-board` operation; add issues to the board (`add-to-board`) and set Phase/Priority/Owner/Status fields with `set-board-field` (on GitHub these run `gh project` / `gh api graphql`); enrich the spec with project number, issue list, phase order, dependencies, and implementation handoff notes.

Jody's output must be concrete enough that Isabelle can implement each phase using [agent-implementation-workflow.md](agent-implementation-workflow.md).

---

## Phase 5: Tracker Project Mechanics

All project and issue writes go through the issue-tracker skill's contract operations — `create-board`, `create-issue`, `add-to-board`, `set-board-field`, `query-board`. The skill (`.claude/skills/issue-tracker-*/`) carries the backend specifics; the GitHub commands below are what that skill runs on a GitHub project.

On GitHub, check auth and project scope first:

```bash
gh auth status
gh auth refresh -h github.com --scopes project   # if project scope is missing
```

Create the board (`create-board`) and issues (`create-issue` — issue bodies in `tmp/`, GitHub `gh issue create --body-file`), then add each issue to the board (`add-to-board` — GitHub `gh project item-add`). `<OWNER>` is the project owner (user or org).

### 5.1 Required custom fields (MANDATORY — not optional)

Every project created by this workflow **must** carry a `Phase` single-select field. Without it `/implement-project` cannot batch issues into phase-PRs and the plan reverts to a flat "Todo" status that `/implement-issue` has to walk one issue at a time. Skipping this creates weeks of avoidable retrofit work — do not.

**Required fields:**

| Field      | Type          | Options                                                                                          |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `Phase`    | Single select | `P0: <name>`, `P1: <name>`, `P2: <name>`, … (one per implementation PR; name describes the batch) |
| `Priority` | Single select | `P0` (must ship), `P1` (should ship), `P2` (nice to have), `P3` (deferred)                        |
| `Owner`    | Single select | the project's agent personas (e.g. `Isabelle`, `Aaron`, `Otto`, `Bert`, `Melvin`, `Nyx`, `Marcelo`, `Leith`, `Jody`) |

`Status` (created by the tracker by default — `Todo`, `In Progress`, `Done`) is reused as-is; do not duplicate.

**Phase naming rule:** `P<n>: <short batch name>`. The `P<n>` prefix is what `/implement-project` reads to order phases; the short name is for humans. Use `P-1: <name>` for "must happen before P0" prework. Skip-level numbering (`P1.5`) is allowed when a phase is inserted late.

### 5.2 Create the custom fields

The Phase/Priority/Owner fields are part of the `create-board` operation. On GitHub the skill creates each field — prefer `gh project field-create`, fall back to GraphQL:

```bash
gh project field-create <PROJECT_NUMBER> --owner <OWNER> \
  --name "Phase" --data-type SINGLE_SELECT \
  --single-select-options "P0: <name>,P1: <name>,P2: <name>"
# repeat for Priority and Owner
```

GraphQL fallback when `gh project field-create` is unavailable: `createProjectV2Field` mutation with `dataType: SINGLE_SELECT` and `singleSelectOptions` (each option needs a `name` and a `color` — valid: `GRAY`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `RED`, `PURPLE`, `PINK`).

### 5.3 Set field values on every issue

Set each item's Phase/Priority/Owner via the skill's `set-board-field` operation. On GitHub: look up field IDs + option IDs once, then `gh project item-edit --id <ITEM> --field-id <FIELD> --project-id <PROJECT> --single-select-option-id <OPTION>` (GraphQL `updateProjectV2ItemFieldValue` is the scripting fallback).

**Verification before declaring Phase 5 complete:** every project item must have a non-null `Phase` AND `Owner` value (the "no empty Phase" rule is part of the contract). Re-query items via `query-board` and assert no item's `Phase` is null; if any are, set them and re-verify. The verification output must be empty.

---

## Phase 6: Sanity Check

Run a fresh general-purpose or planning subagent with **no prior design-loop context**. Give it the final spec path, project number, issue numbers, and the rule: one phase = one implementation PR; each issue = one commit.

Ask it to verify: the spec goal maps to phases and issues; every acceptance criterion has an issue; every security requirement has an issue or explicit AC; every testing requirement has an issue or AC; dependencies are ordered correctly; phase boundaries are implementation-friendly; labels and owners match conventions; no duplicate/missing/vague issues; no hidden work outside the project; **the project has `Phase`, `Priority`, `Owner` fields populated for every item** (re-query via the skill's `query-board` — if any item is missing a `Phase`, the sanity check fails and Jody must fix it before handoff).

Merge sanity-check fixes into the spec. If issues must change, update the tracker immediately.

---

## Phase 7: Reflect and Update Memory

Before reporting back, reflect: did tool choice slow the workflow? Did subagents lack context because prompts were too thin? Did board creation require steps the issue-tracker skill should document (e.g. undocumented `gh`/GraphQL steps on GitHub)? Did any agent disagree in a way future agents should anticipate? Did attachments need a better parsing pattern? Did the spec miss a section until late?

Actions: create/update `docs/agent-lessons/` (PR generalizable lessons back to the engsys lessons-library); update relevant `.claude/agents/*.md` if a role should change; update rules / prompt docs if a behavior should become automatic. Keep memory concise and LLM-optimized: trigger, failure mode, correct behavior, commands/files.

---

## Phase 8: Report Back

Final response to the operator must include: spec path; tracker project link/number; issue list grouped by phase; subagents used and what each contributed; sanity-check result; learning/rule/profile updates made; open questions or decisions needing operator review; explicit request for operator review of the spec/plan before implementation starts. Keep the report short — the spec and project are the durable artifacts.

---

## Spec Quality Checklist

```text
[ ] Goal and context grounded in repo/docs/attachments
[ ] Clarifying questions asked in one batch and answered
[ ] Draft spec created in docs/specs/
[ ] Leith enriched product/UX
[ ] Melvin enriched architecture
[ ] Nyx enriched security/privacy
[ ] Leith/Melvin revised after Nyx findings if needed
[ ] Marcelo enriched testing strategy
[ ] Jody created the phased plan
[ ] Tracker board created via the issue-tracker skill (create-board)
[ ] Issues created via the skill (create-issue) with tmp/ body files
[ ] Issues added to project and organized by phase (add-to-board / set-board-field)
[ ] Phase / Priority / Owner single-select fields created (5.1, 5.2)
[ ] Every project item has a non-null Phase value (5.3) — verified via re-query
[ ] Fresh sanity-check subagent reviewed spec/project/issues
[ ] Spec updated after sanity check
[ ] Agent lessons/rules/profiles updated if the workflow revealed reusable lessons
[ ] Operator received a concise report and review request
```

---

## Handoff to Implementation

After the operator approves the spec/plan, implementation follows [agent-implementation-workflow.md](agent-implementation-workflow.md) for a single phase or single issue, or [implement-project-workflow.md](implement-project-workflow.md) for an entire project walked phase-by-phase.

Implementation rule: one project phase becomes one PR; every issue in that phase becomes one implementation commit; local review and reflection are required before human handoff. `/implement-project <num>` reads the `Phase` field this workflow created — projects without a populated `Phase` field cannot be auto-implemented and must be retrofitted first (see § 5.1–5.3).
