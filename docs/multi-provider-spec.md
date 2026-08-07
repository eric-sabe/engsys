# EngSys Multi-Provider Worker Layer — POV & Upgrade Spec

> Status: **draft for operator review** · 2026-08-07
> Provenance: the 07AUG2026 Perplexity transcript (three-turn design conversation),
> a first-hand audit of the campos27 runners (`scripts/codex-implement.mjs`,
> `scripts/codex-review.mjs`) and briefs, and the current engsys core
> (`docs/architecture.md`, `core/workflows/implement-project-workflow.md`).
> Decisions locked with the operator on 2026-08-07: all three external providers
> (Codex, DeepSeek, Grok) are installed/authed/billed today; DeepSeek workers run
> via the env-remapped `claude` CLI; parallel dispatch is **designed in now, built
> later**; this document ships first, implementation follows review.

---

## 1. POV — what this upgrade is, and what it is not

engsys today is a Claude-native engineering operating system: three layers
(persona / capability / project facts), a deterministic installer, and a serial
implement loop with one independent-review merge gate. campos27 separately
invented a second-provider control plane — attributable Codex workers, materialized
issue contracts, provider-agnostic briefs, hard exit-code semantics, and a
loud-unavailable discipline — as project-local scripts.

**The upgrade is a promotion, not an invention.** The hard problems are already
solved in campos27, and solved better than the transcript conveys: every guard in
`codex-review.mjs` is annotated with the specific false green that motivated it
(the zero-width-space brief, the mistyped `--repo` that reviewed the wrong
contract, the reviewer that quoted `VERDICT: CLEAN` from its own instructions, the
`assume-unchanged` tree mutation). That corpus of paranoia is the asset. The work
is to lift it into engsys core, generalize it across providers, and keep the
installer deterministic while doing it.

### 1.1 Adopted from the Perplexity assessment, wholesale

- **Providers as packs.** `stacks/tooling/provider-*` on the existing pack
  contract. Provider choice is configuration, never a persona rewrite.
- **One worker contract.** A single `worker-run` entry with per-provider
  adapters, shared exit-code semantics, shared package format. Never three copies
  of `codex-*.mjs`.
- **Briefs as shared priors** in `core/workflows/briefs/`, with thin per-provider
  adapter notes.
- **Orchestrator owns diligence.** Fresh base, contract materialization, gates,
  commits, PR creation, cross-family review dispatch, merge decision. Workers
  never push, never open PRs, never rule on mergeability.
- **Author family ≠ reviewer family** whenever a second family is available —
  the lane flip is a hard rule, validated in campos27 (S8: Anthropic missed the
  safety gap Codex found).
- **Work packages over scavenger hunts.** "Read `docs/specs/`" is a discovery
  burden, not a handoff.
- **`exit 0` from implement means "attributable transcript exists," never
  "mergeable."** Gates are external and always re-run by the merge owner.

### 1.2 Where this spec deliberately departs

**(a) The communication protocol is adopted in spirit, collapsed in form.**
The transcript proposes seven force-ranked channel files (`constraints.md`,
`hypotheses.md`, `notes.md`, `lessons-relevant.md`, …). Seven files recreate the
long-prompt attention problem as a filesystem: force levels implied by filename
are exactly as ignorable as force levels implied by paragraph position. This spec
keeps **five package files plus a manifest that declares force explicitly**
(§ 4), and puts the machine-checkable part where it belongs: a required
**RECEIPT footer** the runner parses, not more prose the worker may skim.

**(b) The commit contradiction is resolved by design, not by prompt.**
campos27's implement brief demands one commit per issue *and* documents that four
runs out of four produced correct, uncommitted work. Workers resolving
contradictions unpredictably is a self-inflicted wound. The engsys contract makes
it normative for **all** providers: **workers produce a working-tree diff plus a
per-issue file map in their final message; the orchestrator stages and commits
per issue with a provenance trailer.** No worker is ever asked to run git for
anything but reading. This deletes the contradiction, keeps diffs attributable
(clean-tree-before check stays), and gives every commit a uniform
`Worker: <provider>/<model>` trailer for later archaeology.

**(c) The scheduler is designed in now and built later — and specced honestly.**
The transcript's DAG dispatcher is the least-proven idea in the conversation.
What ships now: Jody emits `depends_on` / `touches` / `risk` / `needs_judgment`
on every issue (§ 8), so the dependency data accrues from day one — and
`touches` immediately feeds the package churn list, so the field pays rent before
any parallelism exists. What waits: dispatch itself, gated on explicit
preconditions (§ 8.3). One correction to the transcript's model: since the
orchestrator owns all commits, "parallel issues on one phase branch" is really
**parallel worker worktrees whose diffs the orchestrator applies serially** to
the phase branch. File-overlap is the mutex; the integration is inherently
serial at the commit step. That is the honest shape, and it is fine.

**(d) Routing is capability- and independence-first; cost is a tiebreaker.**
The transcript assumes "Anthropic budget scarce → offload to cheap providers."
With Claude and Codex both on flat-rate subscriptions, their marginal cost is
~zero; DeepSeek's metered pennies buy **parallel overflow capacity and family
diversity**, not savings. The routing table (§ 6) is therefore ordered by what
each family is best at and who must *not* review whom — not by the price sheet.
If billing posture changes (API-metered Claude), the config carries the change;
the table's structure doesn't.

**(e) Workers are not personas.** Personas (Isabelle, Patricia, Melvin…) are
judgment identities inside the Claude harness — stable, naturalized, opinionated.
Workers are contract labor: anonymous, package-fed, receipt-bound. Blurring these
would reintroduce the re-naturalization tax engsys exists to kill. When Anthropic
implements a judgment-heavy surface, that's Isabelle, as today. When Anthropic
serves as a *worker* (fallback reviewer, overflow implementer), it runs under the
same worker contract as everyone else — package in, receipt out.

### 1.3 Non-goals

- No free-form multi-agent swarm. Claude remains conductor and merge authority.
- No worker-initiated PRs or merges, ever.
- No parallel-by-default. Serial stays the default until § 8.3 preconditions pass.
- No aggregator/proxy layer (OpenRouter etc.) — direct provider endpoints only.
- No change to the design loop (Leith ∥ Melvin → Nyx ∥ Gary) — it already
  parallelizes judgment correctly.

---

## 2. Target architecture

```text
Claude Code session (conductor: judgment, gates, commits, merge authority)
  │
  ├─ builds work package            tmp/worker-package/<run-id>/
  ├─ dispatches via                 .claude/scripts/worker-run.mjs
  │     --provider codex|deepseek|grok|anthropic
  │     --role implement|review|critique|investigate
  │
  ├─ adapters (thin, per provider pack)
  │     codex      → codex exec  (proven; lifted from campos27)
  │     deepseek   → claude -p, env-remapped to api.deepseek.com/anthropic
  │     grok       → review/critique lane (harness confirmed at M2, § 10)
  │     anthropic  → fresh claude -p / subagent under the same contract
  │
  ├─ runner validates protocol      exit 0/1/2 + RECEIPT + STATUS|VERDICT
  ├─ orchestrator re-runs verify.md gates (source of truth)
  ├─ cross-family review            author family ≠ reviewer family
  └─ commits per issue with Worker: trailer → PR → merge policy (unchanged)
```

The three-layer model gains no fourth layer. Provider packs are capability packs;
the worker contract is core plumbing (deterministic scripts, installer-managed);
routing preferences are project facts (config → rendered CLAUDE.md table).

---

## 3. The worker contract

### 3.1 Invocation

One entry point, installed to `.claude/scripts/worker-run.mjs`, zero-dep Node
like the installer. Per-provider adapters live beside it in
`.claude/scripts/workers/<provider>.mjs`.

```text
worker-run
  --role      implement | review | critique | investigate
  --provider  codex | deepseek | grok | anthropic
  --package   tmp/worker-package/<run-id>     # § 4; required
  --worktree  <path>
  --base      <ref>                           # review/critique only
  --model     <id>        # defaults from providers: config, per role
  --effort    <level>
  --out       <transcript path>
  --check                 # readiness probe only: binary, auth, model reachability
```

`--issues` / `--focus` survive only as sugar that the *package builder* consumes;
`worker-run` itself reads everything from the package. One envelope, one truth.

### 3.2 Exit codes — one grammar for every role

| Exit | Meaning | Consumer action |
|---|---|---|
| `0` | Protocol complete + positive outcome (`STATUS: IMPLEMENTED` / `VERDICT: CLEAN`) | Orchestrator still re-runs gates; then proceed |
| `1` | Protocol complete + negative outcome (`VERDICT: FINDINGS`, `STATUS: REFUSED\|BLOCKED`) | Route findings / read refusal evidence; this is a *successful* communication |
| `2` | Did not run, could not be attributed, or **protocol violated** (no receipt, malformed footer, tree drift, missing binary, auth failure, package incomplete) | Loud fallback to next provider in chain; never read as green, never as findings |

This unifies campos27's asymmetry: review already had 0/1/2; implement conflated
"process ran" with success. Under this contract a refusal with premise evidence
is exit 1 — a valuable outcome, distinct from both success and breakage.

All of `codex-review.mjs`'s proven guards are lifted into the shared runner,
provider-independent: brief-must-contain-letters, `--repo`-must-match-origin,
artifact invalidation before any fallible step, tree fingerprint
(`ls-files` + content hash, not `git status`) for read-only roles,
clean-tree-before for implement, last-line-only verdict parsing, contradictory-
verdict refusal, value-taking-flag-with-no-value refusal.

### 3.3 The receipt — communication becomes checkable

Every worker's final message must **end** with (review shown; implement swaps
`VERDICT` for `STATUS`):

```text
RECEIPT: package=<sha256:8> issues=#464,#476 hypotheses=2-confirmed,1-refuted findings-acked=4/4
VERDICT: FINDINGS
```

- `package=` echoes the manifest's content hash → proves the worker saw *this*
  envelope. Runner compares; mismatch or absence → exit 2.
- `issues=` must equal the manifest's issue list → proves the binding contract
  was enumerated, not inferred.
- `hypotheses=` forces the premise-check the campos27 brief already demands into
  a parseable slot (counts, with refuted ones named in the body).
- `findings-acked=` appears on fix rounds only: every Critical/Warning id from
  `prior-findings.md` must be acked in the body as
  `FINDING-ACK: <id> → fixed | disputed | deferred + evidence`. An unacked
  finding → exit 2. "The finding did not land" stops being a vibe.

Silence handling: wall-clock timeout per role (config), and *no receipt ⇒ exit
2*, which also covers the Claude-subagent idle-without-report failure campos27
documented. After two consecutive exit-2s from one provider in a phase, the
runner refuses that provider for the rest of the phase (anti-thrash; matches the
"change who runs the step, not the volume" lesson).

Deliberate scope limit: the receipt proves *enumeration* (the worker listed what
it accepted as binding), not *obedience*. Obedience is proven where it always
was — by the orchestrator's independent gate run and the cross-family review.
No grammar can prompt a model into compliance; the grammar just makes
non-compliance cheap to detect and loud.

### 3.4 Roles

| Role | Tree | Output contract | Notes |
|---|---|---|---|
| `implement` | May write; never commits | Per-issue file map + gate numbers + mutation evidence + `STATUS` | Orchestrator splits/commits from the file map |
| `review` | Read + run + mutate-and-revert; fingerprint must match after | Severity-tagged `file:line` findings + `VERDICT` | The § 3.5 merge gate |
| `critique` | Read-only | Ranked findings, no verdict binding on merge | Design lens (Gary-style brief), rescue opinions |
| `investigate` | Read + run; no writes survive | Observations + hypothesis status | Stuck-loop rescue, premise verification |

---

## 4. The work package

Built by the orchestrator (a deterministic builder script, not prose), consumed
by every provider identically:

```text
tmp/worker-package/<run-id>/
  manifest.json        # role, provider, model, issues[], base, head,
                       # force map {binding:[...], priors:[...], hypothesis:[...]},
                       # per-file sha256 + package hash, timeout, timestamp
  contract/issue-N.md  # BINDING — materialized bodies (gh runs outside sandbox)
  brief.md             # PRIORS — rendered role brief (§ 5): core + project overlay
  verify.md            # BINDING — exact gate commands the orchestrator will run
  focus.md             # HYPOTHESIS — numbered, each marked unverified; optional
  prior-findings.md    # BINDING on fix rounds — severity-tagged file:line list
```

Rules:

- **Force lives in the manifest**, echoed in a ~10-line stdin frame that also
  orders reading (`contract/ first, focus.md last, disk beats stdin on
  conflict`). stdin is a table of contents, not the library.
- **Spec slices, not spec catalogs.** When an issue cites a spec section, the
  builder extracts that section into `contract/` beside the issue (campos27
  already has `splice-spec-sections.mjs` to generalize). Pointers to
  `docs/specs/` are how constraints get missed under time pressure.
- **Churn list.** `touches:` from the issue (§ 8.1) renders into each issue's
  contract file. The campos27 brief claimed a churn list the runner never
  produced; this closes that gap.
- **Package hash in the transcript header.** Every run records
  `PACKAGE_HASH` + per-file hashes, so "what did it actually see?" is answerable
  forever — the same instinct as attributable commits.
- **Do not pass:** the parent transcript, unbounded spec dumps, another model's
  chain-of-thought, diagnoses labeled as fact, merge authority.
- **Richness tiers by model class, same schema:** execution-tier workers
  (Terra, DeepSeek Flash) get narrow packages and low exploration budget;
  judgment-tier workers (Sol, DeepSeek Pro, Opus) add broader excerpts and
  named suspects. One builder, one flag.

---

## 5. Briefs — core skeletons, project overlays

The campos27 briefs interleave two kinds of content: **general engineering
priors** (premise-checking, the vacuous-gate taxonomy, mutation-from-outside-
your-pattern, resolve-don't-match, merge-invisible defects, consistency pairs)
and **project facts** (bird surnames, SvelteKit CSRF, drizzle drift, `meta.now`).
The general half is some of the best prompt engineering in either repo and is
currently trapped in one project.

Split them on the engsys pattern:

```text
core/workflows/briefs/
  implement.md            # premise-check discipline, read-before-write,
                          # deliverable discipline, final-message contract
  review-correctness.md   # generalized failure families: vacuous gates,
                          # merge-invisible defects, claims-to-distrust,
                          # consistency pairs, behavioural-sweep failure modes
  review-design.md        # Gary-lens critique skeleton
  critique.md  investigate.md
```

The project half lives in **one project-owned overlay file**,
`.claude/workflows/briefs/project-brief-overlay.md` — seeded once from a
template at install, filled by `/naturalize` (house-defect corpus, invariants,
framework traps, the exact verify commands), never overwritten by `update`.
The package builder appends it to every role brief, so one source feeds all
roles without duplication. (Implementation note: this replaced the draft's
fenced-region-per-brief design — a managed-vs-owned file split is cleaner than
five generated files with preserved regions, and it keeps core briefs
hash-verifiable by `engsys verify`.) The builder refuses to build a
`review-correctness` package while the overlay still carries its TODO sentinel
(a reviewer with no local priors is a review in name only — the letter-check
generalized). Provider packs append only a thin adapter note ("no `gh` in
sandbox", "read-only lane").

Project-closeout gains one step: newly memorialized failure families get
promoted into the project brief region, not just `docs/agent-lessons/` — the
lesson loop starts feeding reviewers directly.

---

## 6. Provider packs and routing

### 6.1 Pack contents (extends the existing pack contract)

```text
stacks/tooling/provider-<name>/
  scripts/<name>.mjs        # adapter: spawn, env, model pinning, --check probe
  briefs/adapter-note.md    # ≤10 lines appended to rendered briefs
  claude.fragment.md        # when-to-use guidance spliced into CLAUDE.md
  settings.fragment.json    # permissions (e.g. Bash(codex:*)), env keys named
  capabilities.json         # { can_gh, can_network, writes_tree, runs_tests,
                            #   roles: [...], models: {...}, harness: "..." }
```

Installer changes: `lib/manifest.js` learns pack `scripts/` and `briefs/`
(copied to `.claude/scripts/workers/` and merged into brief rendering);
`worker-run.mjs` + the package builder install with core whenever any provider
pack is selected. `engsys verify` gains a provider doctor: run each enabled
adapter's `--check`, print the readiness matrix (binary, auth, model
reachability, and for DeepSeek the returned-model assertion below).

### 6.2 The four adapters

**provider-codex** — the campos27 runners, generalized: `codex exec -m <model>
--sandbox workspace-write`, stdin frame, `--output-last-message` for the footer.
Buildable at M1 with high confidence; it is a refactor of proven code.

**provider-deepseek** — env-remapped `claude` CLI (operator decision):

```text
spawn claude -p --output-format json ... with EXPLICIT env (not inherited):
  ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
  ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY
  ANTHROPIC_MODEL=<pinned per role>  (+ SMALL/SUBAGENT slots → deepseek-v4-flash)
```

Two mandatory defenses: **(1) env isolation** — the adapter constructs the child
environment from scratch (allowlist), so the worker can never inherit the
conductor's session, settings, or push credentials; run with a restricted
tool allowlist and `--dangerously-skip-permissions` *not* set. **(2) the alias
trap** — DeepSeek's Anthropic-compat endpoint silently maps unknown model names
to `deepseek-v4-flash`; the adapter must read the returned model id from the
JSON result and **exit 2 on mismatch**. A Flash run billed as a Pro review is a
false green with extra steps.

**provider-grok** — review / critique / rescue lane only (routing below).
**Harness decided 2026-08-07, revised same day to dual-route** (`via: cli |
api | auto`, auto prefers cli). The `cli` route is the **subscription** path:
the Grok Build CLI (`grok`, SuperGrok tiers) invoked the way xAI's own
grok-build Claude Code plugin shells out to it — `-p` prompt, explore agent,
plan permission mode, **read-only sandbox**, plain output; login probed by
`grok models` succeeding; binary overridable via `$GROK_BINARY`. Tool-capable:
Grok opens the package and reads the repo itself. The `api` route is the
**metered** fallback (`XAI_API_KEY`): no tools, so the adapter inlines the
whole package plus the `base...HEAD` diff into one request (size-capped,
refusing loudly when over). The chosen route is printed on every run — which
route a verdict came from changes what it could have seen. Either way Grok
generally cannot *run* gates; its brief requires disclosing that, and its
verdict is never the sole gate on execution-dependent work.

**provider-anthropic** — the explicit fallback, not ambient: a fresh `claude -p`
(or subagent) run under the same package/receipt contract. This is what makes
"Claude reviews Codex's work" symmetric with every other lane, and gives the
§ 3.5 gate a terminal fallback that still ends in a parseable verdict. The
campos27 idle-without-report failure is handled by the same timeout + no-receipt
⇒ exit 2 path as everyone else.

### 6.3 Routing (Terra ≈ Sonnet-class, Sol ≈ Opus-class)

Machine-readable in config, rendered as a CLAUDE.md table at install. The
existing `naturalize.model_strategy` prose stays as judgment guidance; this
block is what scripts enforce:

```yaml
providers:
  conductor: anthropic
  workers:
    codex:    { enabled: true,  binary: codex,
                models: { implement: gpt-5.6-terra, implement_hard: gpt-5.6-sol,
                          review: gpt-5.6-sol } }
    deepseek: { enabled: true,  via: claude-cli-remap,
                models: { implement: deepseek-v4-flash,
                          implement_hard: deepseek-v4-pro,
                          review: deepseek-v4-pro } }
    grok:     { enabled: true,  roles: [review, critique, investigate],
                models: { review: grok-4.5 } }
    anthropic:{ enabled: true,  via: claude-cli,
                models: { implement: sonnet, review: opus } }
  routing:
    implement_default: codex
    review: cross_family          # hard rule: reviewer family ≠ author family
    review_fallback_chain: [codex, grok, deepseek, anthropic]  # minus author's family
    overflow: deepseek
    critique: grok
  parallel:
    enabled: false                # § 8.3 gates flipping this
    max_workers: 3
    require_nonoverlapping_touches: true
  timeouts: { implement: 3600, review: 2700 }
```

| Work type | Worker | Reviewer family |
|---|---|---|
| Well-specified domain/infra issue | Codex Terra | Anthropic or Grok |
| Hard multi-file / subtle correctness | Codex Sol | Anthropic Opus or Grok |
| High-volume mechanical / tests / boilerplate | DeepSeek Flash | Codex Terra or Anthropic |
| Capable low-cost overflow | DeepSeek Pro | Codex or Anthropic |
| UX / copy / error surfaces / product judgment | Anthropic (Isabelle/Leith) | Grok or Codex Terra |
| Architecture / security hard calls | Anthropic Opus → Fable escalation | Codex Sol or Grok, mandatory |
| Adversarial correctness review | Codex Sol and/or Grok | ≠ author |
| Stuck-loop rescue / alternate plan | Grok investigate | Anthropic synthesizes |

Escalation *within* a family stays the existing three-tier policy (Sonnet →
Opus → Fable); this table only decides *which family* holds the pen and which
holds the red one. Sol is reached the same way Fable is: Terra failed once, the
issue spans many modules, or the review needs mutation-hunting depth.

### 6.4 `/implement-project` § 3.5 becomes the cross-family gate

The objective-review step changes from "fresh Opus subagent" to:

1. Determine author family for the phase (from the commits' `Worker:` trailers).
2. Walk `review_fallback_chain` minus the author's family; dispatch
   `worker-run --role review` with a fresh package.
3. Exit 2 → next in chain, loudly logged. Exhausted chain → **stop and report**
   (never degrade to the author's family silently; conductor-Anthropic
   reviewing worker-Anthropic requires explicit operator sign-off, logged as a
   same-family exception).
4. Verdict semantics, merge policy, Merge Monster handoff: unchanged.
5. High-risk phases (`risk: high` from Jody, § 8.1): **two** families must
   return CLEAN before merge — the transcript's M6, gated to where it earns its
   cost.

---

## 7. Orchestrator diligence (unchanged in ownership, now enumerated)

The conductor always owns, in order: fresh base (fetch + branch from updated
tip), package build (incl. issue pre-audit — stale/wrong bodies poison every
downstream step), dispatch, receipt validation against the manifest,
independent `verify.md` gate run (worker numbers are never the gate), per-issue
commits with `Worker:` trailers, PR creation, cross-family review dispatch,
merge decision. If a worker fails the same diligence request twice, the step
changes owner — not volume, not brief length.

---

## 8. Scheduler: designed in now, built later

### 8.1 Jody emits DAG fields now (M1)

`generate-project.md` § issue creation gains a structured block in every issue
body:

```yaml
depends_on: [12, 15]     # issue numbers, empty ok
touches: ["src/lib/points/**", "src/routes/awards/+page*"]
risk: low | med | high
needs_judgment: false    # UX/copy/architecture vs mechanical
```

Immediate payback, zero parallelism required: `touches` → package churn lists;
`risk` → dual-review trigger and Sol/Pro tier selection; `needs_judgment` →
routes to Anthropic personas instead of workers; `depends_on` → ordering sanity
inside the phase (today's "in the order listed" becomes verifiable). Jody's
sanity check (Phase 6) asserts the block parses on every issue.

### 8.2 The eventual dispatcher (M4 — specced, not built)

```text
ready = open issues: deps satisfied ∧ touches ∩ in-flight = ∅ ∧ ¬needs_judgment
dispatch ≤ max_workers, each in its own worker worktree off the phase branch
on return: validate receipt → orchestrator applies diff to phase branch,
           runs gates, commits per issue (serial integration point)
recompute ready; issues with overlapping touches serialize;
migrations / schema / shared APIs / auth-tenant boundaries always serialize;
final integration issue always last and always serial
```

Speculative cross-phase parallelism (N+1 stacked on unmerged N) stays operator-
opt-in and out of scope for M4. For a solo fleet the ROI is intra-phase.

### 8.3 Preconditions for flipping `parallel.enabled`

All of: ≥ 3 projects' phases dispatched serially through worker-run with zero
protocol-violation surprises; receipt compliance ≥ 95% per enabled provider
(exit-2 rate tracked in dispatch logs); the fix-round ACK loop demonstrated
end-to-end; churn lists present on ≥ 90% of issues (else the mutex has no
input). Until then `parallel.enabled: true` warns and is ignored. Throughput
before that comes from the cheaper win: cross-family review running while the
conductor plans the next phase, and DeepSeek overflow on mechanical batches.

---

## 9. Milestones

| # | Scope | Exit criterion |
|---|---|---|
| **M1** | Worker contract + package builder + receipt validation in core; provider-codex generalized from campos27; briefs split core/overlay; `providers:` schema + rendered routing table; § 3.5 cross-family chain; Jody DAG fields | A campos27-style phase runs end-to-end through engsys-installed machinery in a second project, Codex implement → Anthropic review, receipts validated |
| **M2** | provider-deepseek (env-remap + alias-trap assertion) and provider-grok (harness confirmed, review lane); provider doctor in `engsys verify` | Doctor matrix green for all four; one real review each from DeepSeek-Pro and Grok with parsed verdicts |
| **M3** | Fix-round protocol proven (prior-findings + ACK); dual-review on `risk: high`; dispatch telemetry (per-run provider/model/tokens/exit) | One FINDINGS → fix → CLEAN cycle fully machine-tracked; telemetry answers "who worked, who caught what" |
| **M4** | Intra-phase parallel dispatcher per § 8.2 | Gated on § 8.3; a phase of ≥ 4 non-overlapping issues lands via 2–3 parallel workers with zero semantic-merge incidents |

M1 is the leverage: it multiplies review quality in every project engsys touches
before any new provider or any parallelism exists.

---

## 10. Risks & open questions

- **Grok harness** — RESOLVED (2026-08-07): dual-route, subscription CLI
  preferred with metered-API fallback (§ 6.2). Residual risks: the read-only
  lane cannot execute gates, so a Grok CLEAN on execution-dependent work is
  weaker than a tool-capable family's CLEAN (routing and the `risk: high`
  dual-review rule absorb this); and the CLI-route invocation mirrors the
  official plugin's flags, which are beta-era — a flag rename in a Grok Build
  release surfaces as a loud exit 2, never a silent degrade.
- **Receipt compliance variance.** Codex honors last-line contracts today;
  DeepSeek/Grok discipline is unproven. Mitigation: the footer demand sits in
  the stdin frame's final lines (recency), and exit 2 + retry-once-smaller +
  fallback chain makes non-compliance cheap. If a provider can't hold ≥ 95%,
  it self-demotes (§ 8.3) — the protocol measures its own channels.
- **`claude`-as-worker recursion/bleed.** The conductor spawning `claude`
  children risks settings/env inheritance and confusing session state.
  Allowlist-constructed env, worker-specific `--settings`, and worktree cwd are
  mandatory in the adapter, not optional hygiene.
- **Package ceremony overhead** on small phases. The builder is a script;
  marginal cost is seconds. If it ever feels heavy, the fix is a `--lite`
  builder profile, never regression to prose dispatch.
- **DeepSeek data posture.** Worker packages contain issue bodies and spec
  slices; anything that must not leave Anthropic/OpenAI boundaries needs a
  `no_external: true` flag on the issue → routes to codex/anthropic only.
  (Also the standing alias trap, § 6.2.)
- **Sunset check.** If a provider's family diversity stops paying (models
  converge, blind spots align), the config deletes it in one line. Packs keep
  the exit as cheap as the entry.

---

## Appendix A — receipt grammar (normative)

```text
final message body …
FINDING-ACK: <id> → fixed | disputed | deferred — <evidence>     # fix rounds, one per finding
RECEIPT: package=<sha256:8> issues=#<n>[,#<n>…] hypotheses=<c>-confirmed,<r>-refuted[ findings-acked=<a>/<t>]
STATUS: IMPLEMENTED | REFUSED | BLOCKED        # implement/investigate
VERDICT: CLEAN | FINDINGS                      # review (last non-empty line)
```

Parsing: last-lines only, never transcript grep (the prompt echoes its own
examples). Contradictory verdicts → exit 2. Missing any required line → exit 2.

## Appendix B — what not to do (inherited, still binding)

No linear per-provider slash commands that re-implement dispatch. No worker
PRs/merges. No parallel-by-default. No same-family review counted as
independence. No diligence encoded only in briefs. No provider choice via
persona rewrite. No degrade-to-green, anywhere, ever.
