---
spec_id: SPEC-2026-SDD-UPGRADE
status: draft
tier: L
owner: eric-sabe
owners: [leith, melvin, nyx, gary, marcelo, jody]
generated: 2026-10-15
project: 39
issues: [147, 150, 152, 154]
supercedes: []
supersedes: []
epic: docs/specs/engsys-2026-unified-epic.md
non_negotiable_anchors:
  - "NA-SDD-1: spec-slice.mjs MUST canonicalize paths and reject any path outside docs/specs/ or containing .."
  - "NA-SDD-2: Untrusted issue/PR text ingested during spec/contract checks MUST NOT execute shell interpolation"
  - "NA-SDD-3: Escalation tripwire TW-3 (Security/Trust Boundary) MUST always invoke Nyx regardless of file count"
  - "NA-SDD-4: contract-check.mjs MUST fail on undeclared touches globs unless PR body contains ### Co-commit justification"
---

# Spec: 2026 Adaptive Spec-Driven Development (SDD) Upgrade for `engsys`

**Target Repository:** `eric-sabe/engsys` (`/Users/eric/git/engineering/engsys` — generic mechanism, zero org-specific leaks)  
**Spec Path (target):** `docs/specs/adaptive-sdd-upgrade.md`  
**Companion Epic Specs:**
- [engsys-unified-epic-spec.md](file:///Users/eric/git/engineering/engsys-unified-epic-spec.md) *(Master Epic: Phases 1–8)*
- [engsys_personas_skills_evaluation.md](file:///Users/eric/git/engineering/engsys_personas_skills_evaluation.md) *(Track B: 15 Personas & 58 Skills Upgrade)*
- [multi-harness-antigravity-spec.md](file:///Users/eric/git/engineering/multi-harness-antigravity-spec.md) *(Track C: Multi-Harness Support `claude` | `copilot` | `antigravity`)*

### Scope & Spec Tier Recommendation (from Phase 1 Exploration)
- **Blast radius**: `12 core workflow, command, script, and library files in Track A (plus persona wiring in Epic Phase 3 and installer wiring in Epic Phase 6)`
- **Tripwires**: `[x] TW-1 Data/Contract Mutation` · `[x] TW-2 Security/Trust Boundary` · `[x] TW-3 Multi-Phase` · `[x] TW-4 Net-New Operator UX` · `[x] TW-5 AI/LLM/Agentic Pipeline` · `[ ] TW-6 Infra/CI/Deploy`
- **Recommended Tier**: **Tier L** (Mutates `<!-- engsys:issue-meta -->` and spec frontmatter schemas, enforces mechanical `touches` scope gates in `mm-preflight.sh` and `worker-run.mjs`, restructures `/design-change` and `/generate-project` subagent orchestration, and introduces a new operator front-door command).

---

## Goal

Evolve `engsys` from a rigid 2-mode model (either heavyweight 7-subagent `/generate-project` waterfall OR unstructured `/file-issue`) into a **3-Tier Adaptive, Living, Executable-Contract SDD System** fronted by an intuitive **`/design-change`** command (with `/generate-project` preserved as an alias), first-class **Warm-Chat Ideation Intake**, **6 deterministic Escalation Tripwires (`TW-1..TW-6`)**, universal `<!-- engsys:issue-meta -->` contracts, mechanical `touches` scope enforcement (`contract-check.mjs`), shared `spec_refs` slicing (`spec-slice.mjs`), and closeout spec-lifecycle hygiene (`draft` $\rightarrow$ `active` $\rightarrow$ `shipped` / `archived`).

---

## Context & 6 Concrete Gaps in `engsys` Today

`engsys` v1.13.1 already has strong SDD foundations in [`core/workflows/generate-project.md`](file:///Users/eric/git/engineering/engsys/core/workflows/generate-project.md) (multi-persona adversarial synthesis), `<!-- engsys:issue-meta -->` (`touches`, `spec_refs`, `risk`), and [`core/scripts/worker-package.mjs`](file:///Users/eric/git/engineering/engsys/core/scripts/worker-package.mjs) (`extractSection()` slicing `docs/specs/<slug>.md#Heading` into `contract/spec-*.md`). However, auditing the current workflows alongside the Personas/Skills evaluation and Multi-Harness evaluation reveals **six concrete gaps**:

1. **Slash-Command Discoverability & "Hidden Ideation" Gap (`/design-change` vs. `/generate-project`)**:
   - The interactive fleet window for architecture/feature design is named `*-design` (`keystone-design`). Yet typing `/design` in that window surfaces `/design-audit`, `/design-audit-local`, and `/design-critique`—all of which are **visual UI/CSS audits** (`Gary`), while actual feature/system design is hidden under `/generate-project`.
   - Worse, `/generate-project` sounds like "create a massive multi-week ProjectV2 board" and assumes a **cold start from `$ARGUMENTS`**. In reality, operators naturally **ideate in freeform chat first** and then trigger the spec workflow—or want a command (`/design-change`) that guides ideation, explores the repo, right-sizes the change (`Tier S / M / L`), and only generates a multi-PR project if warranted.
   - Because subagents (`Leith`, `Melvin`, `Nyx`, `Gary`, `Otto`, `Aaron`, `Marcelo`, `Jody`) start with fresh context and **cannot see the parent session's prior chat history**, any decisions made during pre-command chat ideation are **lost when subagents spawn** unless Phase 0 explicitly distills prior chat context into the spec baseline (`## Context`, `## Operator Inputs`, `## Assumptions`).
2. **The Ceremony Cliff (`/generate-project` vs. `/file-issue`) & Missing Domain Lenses (`Otto` & `Aaron`)**:
   - [`core/workflows/generate-project.md`](file:///Users/eric/git/engineering/engsys/core/workflows/generate-project.md) always runs an 8-phase, 7-subagent waterfall (`Leith`, `Melvin`, `Nyx`, `Gary`, `Marcelo`, `Jody`, `Sanity Check`) + GitHub ProjectV2 board creation, even for a 1–3 PR backend feature.
   - Meanwhile, **`Otto`** (LLM/Prompt/Agentic Optimizer) and **`Aaron`** (IaC/CI/Deploy) are completely omitted from Phase 4 of `generate-project.md`, even when a change is an LLM pipeline or infrastructure topology update!
   - Conversely, [`core/workflows/issue-tracking.md`](file:///Users/eric/git/engineering/engsys/core/workflows/issue-tracking.md) (`/file-issue`) jumps straight to filing a standalone issue with **no escalation tripwires** and **no mandatory `<!-- engsys:issue-meta -->` block**!
3. **Unconstrained Tier Selection**:
   - Without deterministic escalation tripwires evaluated *after* `Phase 1: Explore Context`, an LLM orchestrator either under-scopes deceptive security/schema changes on short prompts (optimism bias) or over-ceremonializes small features when invoked via `/generate-project` (compliance bias).
4. **"Spec Rot" in `docs/specs/` (No Post-Draft Lifecycle)**:
   - [`generate-project.md:84`](file:///Users/eric/git/engineering/engsys/core/workflows/generate-project.md#L84) stamps every spec `Status: Draft` and never touches it again. Over P0..Pn implementation, schemas, routes, and edge cases evolve, leaving stale `Status: Draft` files in `docs/specs/`. Because `generate-project.md:55` instructs future runs to read `docs/specs/`, stale specs poison future planning and memory indexing.
5. **Prose-Only Specs & Tautological Tests**:
   - In [`generate-project.md:149-151`](file:///Users/eric/git/engineering/engsys/core/workflows/generate-project.md#L149-L151), `Marcelo` writes prose test strategies, and the implementing agent (`Isabelle`, `Aaron`, or a worker) writes both code and tests from prose in the same commit—inviting tautological tests that assert what the code *happens to do* rather than what the contract requires.
6. **Advisory-Only `touches` & Split Contract Tooling**:
   - [`worker-package.mjs:180-184`](file:///Users/eric/git/engineering/engsys/core/scripts/worker-package.mjs#L180-L184) prints `touches` globs as prose advice (*"Touching anything else is a review finding"*), but neither [`worker-run.mjs`](file:///Users/eric/git/engineering/engsys/core/scripts/worker-run.mjs) nor [`mm-preflight.sh`](file:///Users/eric/git/engineering/engsys/core/skills/merge-monster/scripts/mm-preflight.sh) mechanically checks `git diff --name-only` against `touches`. Worse, in-session `Isabelle` and `Aaron` runs ([`agent-implementation-workflow.md`](file:///Users/eric/git/engineering/engsys/core/workflows/agent-implementation-workflow.md)) do not run `extractSection()` on `spec_refs` at all.

---

## Operator Inputs (Consolidated from Warm-Chat Ideation)

1. **`/design-change` as Primary Front Door, `/generate-project` Preserved**: Operators sitting in `*-design` panes expect `/design-change` to work seamlessly whether invoked cold with `$ARGUMENTS` or warm after freeform chat ideation, while keeping `/generate-project` as a full alias.
2. **Harmonize with Persona/Skills Upgrade (`TW-5` & `TW-6`) and Multi-Harness (`claude` | `copilot` | `antigravity`)**:
   - Extend the escalation tripwires from 4 (`TW-1..TW-4`) to **6 (`TW-1..TW-6`)** so **`Otto`** (`TW-5: AI/LLM/Agentic Pipeline`) and **`Aaron`** (`TW-6: Infra/CI/Deploy Topology`) are deterministically brought into spec authoring when their domains are touched.
   - Ensure `/design-change` is materialized in all harnesses (`claude` commands, `copilot` commands/skills, and `antigravity` `.agents/skills/design-change/SKILL.md`).

---

## Assumptions

- Node.js $\ge 22$ (`path.matchesGlob(filepath, pattern)`) is available in the `engsys` runtime environment (already required by `engsys` v1.13.1).
- Issue bodies across GitHub (`issue-tracker-github`) and Linear (`issue-tracker-linear`) preserve HTML comments (`<!-- engsys:issue-meta ... -->`).

---

## Non-Goals

- Replacing visual UI review commands (`/design-critique`, `/design-audit`, `/design-audit-local`), which remain dedicated to visual/DOM critique via `Gary` and `web-design-reviewer`.
- Hard-blocking a developer's local `git commit` when `touches` is exceeded during exploratory coding; instead, `contract-check.mjs` surfaces structured `undeclared_touches` findings in `worker-run.mjs`, `/code-review`, and `mm-preflight.sh`.

---

## Product and UX Specification (`Leith` & `Gary`)

### 1. Operator-Intuitive Command Taxonomy (Aligned to Fleet Windows)

Add **`/design-change`** (`core/commands/design-change.md`) as the primary front door for ideating, shaping, right-sizing, and speccing any non-trivial change, while preserving **`/generate-project`** as a backwards-compatible alias:

| Interactive Window | Primary Job | Front-Door Slash Command | What It Does |
| :--- | :--- | :--- | :--- |
| **`*-design`** | Ideate, shape, spec & plan changes | **`/design-change [goal]`**<br>*(alias: `/generate-project`)* | **Works cold OR warm after freeform chat ideation.** Explores repo context, shapes tradeoffs, evaluates `TW-1..TW-6` tripwires, recommends **Tier S / M / L**, and produces the matching artifacts (1 issue, Mini-Spec + 1–3 issues, or Full Spec + ProjectV2 board). *(Visual UI review stays under `/design-critique` & `/design-audit`).* |
| **`*-investigate`** | Root-cause bugs & file scoped issues | **`/file-issue <desc>`** | Runs `Bert` RCA + writes mandatory `<!-- engsys:issue-meta -->`. Evaluates `TW-1..TW-6`: if `≥2` tripwires fire, offers 1-click escalation into `/design-change` (**Tier M**). |
| **`*-build`** | Implement issues/projects & close out | **`/implement-issue <N>`**<br>**`/implement-project <N>`** | Executes worktree implementation, mechanical `touches` + `spec_refs` contract verification (`spec-slice.mjs` + `contract-check.mjs`), objective review, Merge Monster handoff, and `/project-closeout <N>`. |

### 2. Warm-Chat vs. Cold-Start Intake (`Phase 0: Intake & Ideation Consolidation`)

Update `Phase 0: Intake` in [`core/workflows/generate-project.md`](file:///Users/eric/git/engineering/engsys/core/workflows/generate-project.md) to support both **Warm-Chat Invocation** and **Cold Invocation**:

1. **Warm-Chat Mode (Prior Discussion Exists in Current Session)**:
   - When invoked after freeform chat ideation (with empty or minimal `$ARGUMENTS`), the orchestrator **harvests the current conversation thread first**:
     - Extracts the problem statement, agreed product/architecture decisions, rejected alternatives, constraints, and already-read files from the chat history.
     - Runs a targeted `Phase 1: Explore Context` pass **only for gaps not yet inspected during the chat**.
     - **Never re-asks questions in Phase 2 that the operator already answered during the chat ideation.**
     - **Critical Subagent Bridge**: Because subagents (`Leith`, `Melvin`, `Nyx`, `Gary`, `Otto`, `Aaron`, `Marcelo`, `Jody`) start with fresh context and **cannot see the parent chat transcript**, the orchestrator MUST write all decisions and constraints from the prior chat into the draft spec's `## Context`, `## Operator Inputs`, and `## Assumptions` sections *before* spawning any subagent.
2. **Cold-Start Mode (Invoked Directly with a Goal / Idea)**:
   - Runs `Phase 1: Explore Context` first, then in `Phase 2` presents:
     1. A brief **Approach / Premise Check** (if exploration revealed 2 competing architectural approaches or a premise mismatch with repo reality).
     2. The **Tier Recommendation (`Tier S / M / L`)**.
     3. The batched **Clarifying Questions** (max 5–8).

### 3. The 6 Hard Escalation Tripwires (Harmonized Across Track A & Track B)

Evaluated deterministically *after* `Phase 1: Explore Context`:

| Tripwire ID | Name | Trigger Condition (From Actual Repo Exploration in Phase 1) | Mandatory Lens Unlocked |
| :--- | :--- | :--- | :--- |
| **`TW-1`** | **Data / Contract Mutation** | Touches DB schema/migrations (`schema.prisma`, SQL migrations), config/lockfile schemas, queue/event payloads, or public/cross-service API contracts. | **`Melvin`** (Architecture & Migration/Rollback contract) |
| **`TW-2`** | **Security / Trust Boundary** | Touches authn/authz, tenant isolation, permissions, hooks/guards, secrets, PII, untrusted input parsing, or billing/ledger math. Sets `risk: high`. | **`Nyx`** (Threat model & Negative Security Assertions) |
| **`TW-3`** | **Multi-Phase Blast Radius** | Requires `>1` PR phase (e.g., splitting infra/migrations from app code per `generate-project.md:27`), or touches `>6` files across `>2` modules. | **`Jody`** (Phased dependency ordering & `engsys:issue-meta`) |
| **`TW-4`** | **Net-New UX State Machine** | Introduces a new multi-state user or operator CLI workflow where sad/empty/error states and IA are non-obvious. | **`Leith` + `Gary`** (UX spec + cognitive walkthrough) |
| **`TW-5`** | **AI / LLM / Agentic Pipeline** | Adds or modifies prompts, model routing, structured outputs (`output_config.format`), agent personas/skills, hooks, or evals. | **`Otto` + `Marcelo`** (`llm-structured-outputs` + `agentic-eval`) |
| **`TW-6`** | **Infra / CI / Deploy Topology** | Modifies Terraform/OpenTofu/CDK/Bicep, GitHub Actions workflows, container/Dockerfile builds, cloud preflight, or fleet supervision. | **`Aaron`** (`<cloud>-deployment-preflight`, `github-actions`, `gate-check.sh`) |

### 4. Deterministic 3-Tier Selection Matrix

| Tier | Entry / Flag | Rule from Phase 1 Evidence | Subagents Dispatched | Output Artifacts |
| :--- | :--- | :--- | :--- | :--- |
| **Tier S**<br>*(Inline Issue Contract)* | `/file-issue` or `/design-change` (`0` tripwires) | **0 tripwires**, fits in **1 PR** (`≤6` files), follows existing repo patterns (`risk: low`). *(If only `TW-2` fires on a `<3`-file bugfix, run a 1-shot `Nyx` review of the issue body).* | **0 design subagents** (`Bert` / Orchestrator drafts directly) | **1 tracker issue** carrying a mandatory `<!-- engsys:issue-meta -->` block + inline 4-part contract (`Invariants`, `Interface/Schema Delta`, `Touches`, `Verify Gate`). **No `docs/specs/` file.** |
| **Tier M**<br>*(Mini-Spec / RFC)* | `/design-change` or `/generate-project` (auto / `--tier M`) | **1–3 PR phases**, `1–2` technical tripwires fired (`TW-1`, `TW-2`, `TW-3`, `TW-5`, or `TW-6`), and **`TW-4` is FALSE** (no net-new multi-state UX). | **2–3 targeted subagents in parallel**: `Melvin + Nyx` (+ `Otto` if `TW-5`, + `Aaron` if `TW-6`) $\rightarrow$ Orchestrator reconciles, compiles executable test matrix, and creates 1–3 phased issues. | Compact **`≤150-line` `docs/specs/<slug>.md`** + **1–3 tracker issues** with `engsys:issue-meta` (ProjectV2 board optional if `≤2` issues; required if `3` phases). |
| **Tier L**<br>*(Full Multi-Persona Spec)* | `/design-change` or `/generate-project` (auto / `--tier L`) | **`>3` PR phases**, OR **`TW-4` fired** alongside Arch/Security, OR **`≥3` tripwires fired**. | **Full persona loop**: `Leith` + `Melvin` (+ `Otto` if `TW-5`, + `Aaron` if `TW-6`) $\rightarrow$ `Nyx` + `Gary` $\rightarrow$ reconcile $\rightarrow$ `Marcelo` $\rightarrow$ `Jody` $\rightarrow$ fresh `Sanity Check`. | Full **`docs/specs/<slug>.md`** + **Tracker Project Board** (`Phase`, `Priority`, `Owner`) + phased issues with `engsys:issue-meta`. |

### 5. Zero-Extra-Turn Operator Ratification in Phase 2 (`generate-project.md`)

In `Phase 2: Ask Clarifying Questions`, the orchestrator prepends a **5-line Tier Recommendation block**:
```markdown
### Scope & Spec Tier Recommendation (from Phase 1 Exploration)
- **Blast radius**: `<N> files across <modules>; <N> PR phases`
- **Tripwires**: `[x/ ] TW-1 Data/Contract` · `[x/ ] TW-2 Security/Auth` · `[x/ ] TW-3 Multi-Phase` · `[x/ ] TW-4 Net-New UX` · `[x/ ] TW-5 AI/LLM` · `[x/ ] TW-6 Infra/CI`
- **Recommended Tier**: **Tier <S|M|L>** (<1-line rationale>)
*(Reply `tier S`, `tier M`, or `tier L` with your answers below to override; otherwise I will proceed with Tier <X>.)*
```

---

## Architecture Specification (`Melvin`)

### 1. Spec Frontmatter & Issue Metadata Contract (`core/lib/spec-slice.mjs`)

Extract `parseIssueMeta()` and `extractSection()` from [`core/scripts/worker-package.mjs:130-238`](file:///Users/eric/git/engineering/engsys/core/scripts/worker-package.mjs#L130-L238) into a zero-dependency shared module `core/lib/spec-slice.mjs` used by `worker-package.mjs`, in-session implementation (`agent-implementation-workflow.md`), and closeout hygiene (`project-closeout-ceremony.md`):

```typescript
// core/lib/spec-slice.mjs
export type SpecStatus = 'draft' | 'active' | 'shipped' | 'archived';
export type SpecTier = 'S' | 'M' | 'L';
export type IssueRisk = 'low' | 'med' | 'high';

export interface SpecFrontmatter {
  status: SpecStatus;
  tier: SpecTier;
  owner: string;
  generated: string;         // YYYY-MM-DD
  project: number | null;
  issues: number[];
  supersedes: string[];
  superseded_by?: string;
}

export interface IssueMeta {
  depends_on: number[];
  touches: string[];         // repo-relative glob patterns
  risk: IssueRisk;
  needs_judgment: boolean;
  spec_refs: string[];       // e.g. ["docs/specs/foo.md#Architecture Specification"]
  no_external: boolean;
}

/** Parses `<!-- engsys:issue-meta ... -->` from an issue body. Throws on malformed block. */
export function parseIssueMeta(issueBody: string): IssueMeta | null;

/** Extracts a markdown section by `#Heading` anchor (inclusive of subheadings until next peer/higher heading). */
export function extractSection(markdownContent: string, headingAnchor: string): string | null;

/** Parses YAML frontmatter of `docs/specs/<slug>.md` and flags stale drafts (>14 days) or archived specs. */
export function inspectSpecLifecycle(specPath: string, nowMs?: number): {
  frontmatter: SpecFrontmatter | null;
  skipInExploration: boolean; // true when status === 'archived'
  staleDraftWarning: string | null; // non-null when status === 'draft' && ageDays > 14
};
```

### 2. Mechanical Scope & Contract Checker (`core/lib/contract-check.mjs`)

Create `core/lib/contract-check.mjs` using Node 22's built-in `path.matchesGlob(file, pattern)`:

```typescript
// core/lib/contract-check.mjs
export interface ScopeCheckResult {
  ok: boolean;
  declaredTouches: string[];
  changedFiles: string[];
  allowedCompanions: string[]; // files matched by implicit test/doc companion rules
  undeclaredTouches: string[]; // changed files matching neither declaredTouches nor companion rules
}

/**
 * Implicit companion globs always permitted alongside declared touches:
 * -ocated test files (`**/*.test.*`, `**/*.spec.*`, `**/test/**`)
 * - spec/lesson docs (`docs/specs/**`, `docs/agent-lessons/**`, `docs/architecture/**`)
 */
export const DEFAULT_COMPANION_GLOBS: readonly string[];

export function checkTouchesScope(params: {
  changedFiles: string[];
  touchesGlobs: string[];
  companionGlobs?: string[];
}): ScopeCheckResult;
```

- **Integration into [`core/scripts/worker-run.mjs`](file:///Users/eric/git/engineering/engsys/core/scripts/worker-run.mjs)**: After the external worker completes and before emitting the final run summary, run `checkTouchesScope()` against `git diff --name-only <base>...HEAD` and the union of `touches` from packaged issues. If `undeclaredTouches.length > 0`, append `SCOPE_WARNING: <files> outside declared touches`.
- **Integration into [`core/skills/merge-monster/scripts/mm-preflight.sh`](file:///Users/eric/git/engineering/engsys/core/skills/merge-monster/scripts/mm-preflight.sh)**: When the PR body links one or more issues carrying `<!-- engsys:issue-meta -->`, compute `undeclared_touches: [...]` and include it in the preflight JSON output so Merge Monster and reviewers immediately see out-of-scope file churn.

### 3. Bi-Directional Spec Reconciliation at Closeout (`project-closeout-ceremony.md` Step 4.5)

Add **Step 4.5 — Reconcile Spec Lifecycle (`docs/specs/<slug>.md`)** to [`core/workflows/project-closeout-ceremony.md`](file:///Users/eric/git/engineering/engsys/core/workflows/project-closeout-ceremony.md):
1. When all project PRs are `MERGED`:
   - Reconcile any implementation deviations in `Product`, `Architecture`, and `Security` sections so the spec matches **as-built reality**.
   - Collapse completed execution scaffolding (`## Phased Project Plan` and `## Tracker Project and Issues`) into a compact `## Shipped PRs` table (`Phase | Issue | PR | Merge Commit`).
   - Update YAML frontmatter from `status: active` (or `draft`) to `status: shipped` (or `status: archived` + `superseded_by: docs/architecture/<doc>.md`).
2. **Exploration Filter (`generate-project.md` Phase 1)**:
   - `Phase 1: Explore Context` calls `inspectSpecLifecycle()` (or checks frontmatter): skips any spec with `status: archived` and prints a staleness warning if reading a `status: draft` spec older than 14 days.

---

## Security and Privacy Specification (`Nyx`)

### Threat Model & Negative Assertions

- **`NA-SDD-1` (Path Traversal in `spec_refs` Extraction)**: Given an issue body whose `<!-- engsys:issue-meta -->` contains a `spec_refs` entry with `..` traversal, an absolute path (`/etc/passwd`), or a symlink escaping the repository root, `spec-slice.mjs` MUST reject the reference and read zero bytes outside `<repoRoot>/docs/specs/`.
- **`NA-SDD-2` (Silent Security Bypass on Small Prompts in `/file-issue`)**: Given a bug report or feature request touching authn/authz, session tokens, hooks/guards, or tenant isolation (`TW-2`), `/file-issue` and `/design-change` MUST set `risk: high` in `<!-- engsys:issue-meta -->` and MUST NOT allow Tier S filing without a `Nyx` negative-assertion review (or escalation to Tier M when combined with any second tripwire).
- **`NA-SDD-3` (Out-of-Scope File Mutation in `touches` Check)**: Given a worker or PR whose issue declares `touches: ["src/routes/awards/**"]` and whose diff modifies `core/.claude-plugin/singleton-write-guard.mjs` or `.github/workflows/deploy.yml`, `checkTouchesScope()` in `contract-check.mjs` MUST report those paths in `undeclaredTouches` (`ok: false`) and NEVER classify hook/CI/config files as implicit test/doc companions.
- **`NA-SDD-4` (Archived / Stale Draft Spec Poisoning)**: Given a spec in `docs/specs/` with `status: archived`, `inspectSpecLifecycle()` MUST return `skipInExploration: true` so obsolete contracts are never injected into subagent prompts.

---

## Testing Strategy (`Marcelo`)

### Executable Contract Test Table

| Case ID | Input / Caller State | Expected Outcome / Invariant | Test File |
| :--- | :--- | :--- | :--- |
| **`CT-SDD-01`** | `parseIssueMeta()` given a valid `<!-- engsys:issue-meta -->` block in a `/file-issue` or project issue body | Returns parsed `{ depends_on, touches, risk, needs_judgment, spec_refs, no_external }` | `core/lib/spec-slice.test.mjs` *(new)* |
| **`CT-SDD-02`** | `extractSection()` given `docs/specs/sample.md#Architecture Specification` | Returns exact markdown subtree under `## Architecture Specification` including `###` subheadings, stopping before `## Security` | `core/lib/spec-slice.test.mjs` *(new)* |
| **`CT-SDD-03`** | `extractSection()` / `spec-slice.mjs` given `spec_refs: ["../../etc/passwd#root"]` | Rejects path traversal and reads zero files (`NA-SDD-1`) | `core/lib/spec-slice.test.mjs` *(new)* |
| **`CT-SDD-04`** | `inspectSpecLifecycle()` given `status: archived` vs. `status: draft` (`generated: 2026-09-01`) vs. `status: shipped` | `archived` $\rightarrow$ `skipInExploration: true`; 44-day-old `draft` $\rightarrow$ `staleDraftWarning` set; `shipped` $\rightarrow$ clean (`NA-SDD-4`) | `core/lib/spec-slice.test.mjs` *(new)* |
| **`CT-SDD-05`** | `checkTouchesScope()` given `touches: ["core/lib/**"]` and `changedFiles: ["core/lib/foo.mjs", "core/lib/foo.test.mjs", "core/fleet/launch.sh"]` | `ok: false`, `allowedCompanions: ["core/lib/foo.test.mjs"]`, `undeclaredTouches: ["core/fleet/launch.sh"]` (`NA-SDD-3`) | `core/lib/contract-check.test.mjs` *(new)* |
| **`CT-SDD-06`** | `worker-package.mjs` refactored to import `core/lib/spec-slice.mjs` | All existing `worker-package.test.mjs` cases pass with 0 regressions | `core/scripts/worker-package.test.mjs` |

---

## Phased Project Plan (`Jody` — Harmonized with Unified Epic)

This specification executes primarily in **Epic Phase 1 (Issue #1)**, with persona prompt alignment in **Epic Phase 3 (Issue #3)** and multi-harness command materialization in **Epic Phase 6 (Issue #6)**.

### Epic Phase 1 (Issue #1): Core SDD & Contract Engine (`spec-slice.mjs`, `contract-check.mjs`, `/design-change`, `TW-1..TW-6`)

Implements `core/lib/spec-slice.mjs` and `core/lib/contract-check.mjs`, wires them into `worker-package.mjs` and `mm-preflight.sh`, creates `core/commands/design-change.md` (with `/generate-project` preserved), and updates `generate-project.md`, `issue-tracking.md`, `file-issue.md`, `agent-implementation-workflow.md`, and `project-closeout-ceremony.md`.

```markdown
<!-- engsys:issue-meta
depends_on: []
touches: [
  "core/lib/spec-slice.mjs",
  "core/lib/spec-slice.test.mjs",
  "core/lib/contract-check.mjs",
  "core/lib/contract-check.test.mjs",
  "core/commands/design-change.md",
  "core/commands/generate-project.md",
  "core/commands/file-issue.md",
  "core/workflows/generate-project.md",
  "core/workflows/issue-tracking.md",
  "core/workflows/agent-implementation-workflow.md",
  "core/workflows/project-closeout-ceremony.md",
  "core/scripts/worker-package.mjs",
  "core/scripts/worker-package.test.mjs",
  "core/skills/merge-monster/scripts/mm-preflight.sh"
]
risk: med
needs_judgment: true
spec_refs: [
  "docs/specs/adaptive-sdd-upgrade.md#Product and UX Specification (Leith & Gary)",
  "docs/specs/adaptive-sdd-upgrade.md#Architecture Specification (Melvin)",
  "docs/specs/adaptive-sdd-upgrade.md#Security and Privacy Specification (Nyx)"
]
no_external: false
-->
```
