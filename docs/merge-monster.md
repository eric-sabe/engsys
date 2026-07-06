# 🧌 Merge Monster — design spec

**Status:** v1 design, ratified 2026-07-06 (design session, FeedFrwd/keystone).
**Component:** `core/skills/merge-monster/` (+ `core/commands/merge-monster.md`,
`core/workflows/merge-monster-protocol.md`).
**Audience:** anyone operating, extending, or porting the orchestrator.

Merge Monster (MM) is a **merge orchestrator**: a long-running Claude Code
session that owns the merge baton for a repository. Other sessions finish their
PRs and hand off; MM decides the order, pilots each PR through
ready → CI → merge, autonomously handles easy Dependabot PRs, dispatches
background agents when a PR needs hands-on help, and escalates to a human when
judgment is required. While MM runs, **nothing else merges**.

## 1. Why an orchestrator

Serialized merging with an explicit owner solves four recurring problems:

1. **Order matters.** Stacked branches, project phases, migration-bearing PRs,
   and conflict-magnet files (lockfiles, CI workflows, schemas) all impose
   ordering constraints that ad-hoc merging violates.
2. **CI minutes cost money.** Marking a PR ready triggers the expensive test
   matrix; racing several PRs multiplies runs and makes failures
   unattributable. One PR in flight keeps CI spend minimal and diagnosis crisp.
3. **Rebase churn.** Every merge can invalidate every queued sibling. A single
   scheduler can sequence merges to minimize total rebase work instead of
   letting each session pay it repeatedly.
4. **Nobody watches the queue.** PRs that are "done" rot while their session is
   gone. MM is the thing that is always watching.

### Why not GitHub's native merge queue

GitHub Merge Queue solves ordering by brute CI: every queued PR gets a
speculative full-matrix run against the moving target. That is exactly the CI
spend profile cost-conscious repos avoid, it can't express domain ordering
(phases, migrations, security-first), it can't dispatch an agent to *fix* a
red PR, and it can't handle the draft→ready ceremony many repos use as a CI
gate. MM trades GitHub's parallel speculation for sequenced, attributable,
agent-assisted merging.

## 2. The model: baton-holder, not service

MM is **a session, not a daemon**. It runs on an always-on machine (e.g. a Mac
mini) inside a normal Claude Code session. It holds a *baton* — an advisory
lock, visible on GitHub — and the social contract (encoded in each project's
`CLAUDE.md`) is that while the baton is fresh, other sessions enqueue instead
of merging. If MM dies, the baton goes stale and manual merging is allowed
again. There is no infrastructure to deploy, no webhook receiver, no database:
GitHub is the bus and the durable store; local files are the working memory.

## 3. Runtime architecture

```text
┌────────────────────────── MM session (always-on machine) ─────────────────────────┐
│                                                                                   │
│  persistent Monitor ──► mm-watch.sh: shell poll loop (~30s), diffs GitHub state,  │
│      (event bus)        emits one line per EVENT → wakes the model instantly      │
│                                                                                   │
│  ScheduleWakeup ──► heartbeat tick (~30 min): refresh baton, rewrite state.md,    │
│    (fallback)       Dependabot idle work, self-heal if the Monitor died           │
│                                                                                   │
│  model loop ──► on each wake: rebuild queue, decide, act (label / rebase-agent /  │
│                 mark-ready / merge / fix-agent / escalate), log, sleep            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

The cost insight: **polling is fine — model polling is not.** Waking the model
every few minutes to run `gh pr list` burns tokens on nothing. The watch script
polls in bash (free), keeps a snapshot, and emits a line only on a *state
change* — new enqueue, check completion, new conflict, pause/stop. The model
sleeps at zero cost between events and wakes within one poll interval of any
event. Net: webhook-grade responsiveness with no infrastructure. (True webhook
ingress is a v2 drop-in; see § 13.)

Events emitted by `mm-watch.sh` (one line each):

| Event | Meaning |
|---|---|
| `READY #N <title>` | a PR gained the ready label — new enqueue |
| `UNREADY #N` | ready label removed (session withdrew it) |
| `CHECK #N <name>: <state>` | a required/watched check on the **active** PR reached a terminal state |
| `CONFLICT #N` | a queued PR's `mergeStateStatus` turned `DIRTY` |
| `DEPENDABOT #N <title>` | new Dependabot PR opened |
| `MAIN_RED <workflow>` | latest default-branch run concluded failure |
| `STOP` | the ledger issue was closed (kill switch) |

The script reads the currently active PR number from a state file
(`<state-dir>/active`) so one persistent Monitor serves the whole session even
as the in-flight PR changes.

## 4. Communication protocol — GitHub is the bus

Sessions are separate processes, possibly on separate machines. GitHub is the
only shared, durable, inspectable channel every session already has. Everything
flows through **labels** and **comments**.

### Enqueue (what a finishing session does)

When a PR is genuinely done — the project's local review is clean, the local
pre-push gate passed, the PR body is correct — the session adds the label
**`mm:ready`** and (optionally, but encouraged) a handoff comment:

```markdown
<!-- mm-handoff -->
depends_on: [2783]          # PR numbers that must merge first (optional)
migration: false            # does this PR carry a DB migration?
project: 62                 # project/phase for ordering (optional)
phase: P3
notes: touches the lockfile; owner: worktree agent/p62-hub
```

MM works without the comment — it infers dependencies from base branches,
changed files, and PR bodies — but the comment sharpens ordering and removes
guesswork.

`mm:ready` is a **claim**, not a command: MM verifies it (§ 6 preflight) and
will bounce PRs whose claims don't hold.

### MM's replies (labels it owns)

| Label | Meaning |
|---|---|
| `mm:queued` | acknowledged; a comment states queue position and the reasoning |
| `mm:active` | currently being piloted through ready → CI → merge |
| `mm:blocked` | parked with a stated reason (e.g. waiting on a migration window) |
| `mm:escalated` | needs a human; diagnosis in a comment |

Every label transition comes with a PR comment explaining *why* — the PR
thread is the per-PR audit trail, and a project's closeout ceremony can mine
it later.

## 5. The lock

A pinned issue, **`🧌 Merge Monster ledger`**, is the baton:

- **Heartbeat:** while running, MM updates a timestamp marker in the issue body
  every cycle (Monitor event or heartbeat tick, whichever comes first).
- **The rule** (encoded in each project's `CLAUDE.md`): *if the heartbeat is
  fresher than `stale_lock_minutes`, do not mark-ready or merge yourself —
  label `mm:ready` and walk away.* Stale heartbeat ⇒ MM is presumed dead and
  manual merging is permitted again. Mutual exclusion without deadlock.
- **Kill switch:** close the issue. The watch script emits `STOP`; MM finishes
  or safely parks its in-flight PR, posts a session digest, and idles.
  Reopening re-arms it.
- **Session digests:** MM comments on the issue at session start and end
  (merged N, escalated M, Dependabot auto-merged K, notable decisions).

## 6. Ordering principles

Applied top-down; earlier rules dominate. The queue is re-evaluated on every
wake — ordering is a *function of current state*, not a static list.

1. **Unblock the default branch first.** If main is red, or a queued PR fixes
   CI/infrastructure that other queued PRs need to go green, it jumps the
   queue.
2. **Respect declared order.** `depends_on` handoffs, stacked branches (a PR
   whose base is another PR's branch merges after its base), and project phase
   order. Never merge a child before its base.
3. **Security before features.** CVE and dependency-security fixes outrank
   routine work.
4. **Minimize queue-wide churn.** Among otherwise-equal PRs, ones touching the
   repo's *conflict magnets* (configured per repo: lockfiles, schema files, CI
   workflow files, shared-package APIs) merge first, so the rest of the queue
   absorbs the rebase once, early, instead of repeatedly. If the ruleset does
   not require up-to-date branches, MM only forces a rebase when a PR is
   actually conflicting or semantically overlaps files a just-merged PR
   changed (in which case it wants a fresh CI run anyway).
5. **Migration-bearing PRs get an operator window, not priority.** Where
   applying migrations is an operator-only action, such PRs are parked
   `mm:blocked (migration)` and the operator is pinged; they merge when acked.
   They never block the rest of the queue.
6. **Small-and-old beats big-and-fresh** (tiebreak). FIFO by ready-time, but a
   five-line fix doesn't rot behind a two-thousand-line phase PR that arrived
   an hour ago.
7. **Dependabot is idle work.** Touched only when the human queue is empty.
8. **One PR in flight at a time.** Serializing the ready → CI → merge pipeline
   conserves CI minutes and keeps failures attributable. (Overlapping the next
   PR's CI with the current merge is a v2 option; see § 13.)

## 7. Per-PR pipeline

```text
mm:ready ──► preflight ──► [rebase if conflicting] ──► mark ready ──► watch CI ──► merge ──► post-merge
                │                    │                                    │
                └─ bounce w/ reason  └─ rebase agent (worktree,           ├─ flake/zombie → 1 re-run
                   (label removed)      --force-with-lease only)          ├─ real failure → fix agent ≤ 2 attempts
                                                                          └─ still red → mm:escalated, move on
```

- **Preflight** verifies the enqueuer's claims: review threads resolved; the
  project's review-evidence marker present (if configured); issue-closing
  syntax correct (one `Closes #N` per line); mergeable; no zombie required
  checks left over from a force-push; base branch correct.
- **Rebase** (only when needed): dispatch a background agent into a worktree —
  `git rebase origin/<default>`, regenerate lockfiles per project convention,
  `git push --force-with-lease`. Never plain `--force`; never rebase a branch
  whose head moved since the queue snapshot (re-verify first).
- **Mark ready** is the CI trigger in draft-PR workflows; MM does it as late
  as possible, one PR at a time.
- **Merge method:** configured per repo — typically merge-commit for
  multi-commit batch PRs (preserves per-issue commits), squash for
  single-issue PRs.
- **Post-merge:** verify the intended issues auto-closed (and reopen
  mis-closes), comment a digest on the PR, notify the owner if follow-up is
  needed, then re-evaluate the whole queue for new conflicts/staleness.
- **No head-of-line blocking:** an escalated PR is set aside with a diagnosis
  and MM moves to the next PR.

### Failure classification

CI red on the active PR is classified before any action: **flake/infra**
(known-flaky suite, runner death, zombie check) gets exactly one re-run;
**real** failure gets a fix agent — the project's infra agent for CI/workflow
failures, the implementation agent for code — capped at `fix_attempts_max`
(default 2); anything still red is escalated with the failure summary, the
attempted fixes, and MM's read on the root cause.

## 8. Dependabot autonomy

Bounded, and biased by a hard-won lesson: **a Dependabot "quick check" green is
not full CI** — repos commonly skip the real build/test/lint on Dependabot PRs
to save minutes. So MM never trusts the badge:

- **Auto-handle** (when the human queue is empty): patch/minor bumps of
  dev-dependencies and CI actions, and the repo's grouped patch-bump PR — but
  only after running the repo's **full local gate** (configured
  `local_gate`, e.g. `install --frozen-lockfile && build && test && lint`) in
  a clean worktree. Green → merge → log. Red → close the loop with a comment
  and escalate or leave for triage.
- **Never auto:** major bumps, runtime-dependency bumps, Docker base images,
  language/runtime engine bumps. When several accumulate, MM spawns one agent
  to run the repo's Dependabot-triage playbook as a batch, or escalates.

## 9. Help agents & escalation

MM itself is a thin decision loop; hands-on work is dispatched:

| Situation | Dispatch |
|---|---|
| Conflicting branch | rebase agent in a worktree |
| CI red (code) | implementation agent, ≤ 2 attempts |
| CI red (workflow/infra) | infra/CI agent, ≤ 2 attempts |
| Unresolved nit threads | thread-resolver under standing operator authority (never resolves substantive threads just to unblock) |
| Dependabot batch | triage agent following the repo's playbook |

**Escalation** = `mm:escalated` label + a diagnosis comment on the PR +
a message on the configured channel (e.g. Slack). The message says what's
blocked, what MM tried, and what decision or action is needed. Escalations
never stall the queue.

## 10. Ledger & inspectability

Three surfaces, one per audience:

| Surface | Audience | Content |
|---|---|---|
| `<state-dir>/state.md` | "what's happening right now" | current queue table (position, PR, state, one-line reason), active PR, last events — rewritten every cycle |
| `<state-dir>/journal-YYYY-MM.md` + `.jsonl` | post-hoc review, tooling | append-only: every ordering decision with reasoning, merges, rebases, fix agents, escalations, Dependabot actions |
| the pinned ledger issue | anyone, anywhere | heartbeat, session start/end digests, escalation pings |

`<state-dir>` defaults to `logs/merge-monster/` (gitignored in most setups).
Per-PR reasoning lives on the PR itself. The journal's `.jsonl` twin is the
substrate for the v2 metrics dashboard.

## 11. Configuration

One YAML per repo — `.claude/merge-monster.yml` — read by the model at session
start. Scripts take everything as flags/env so nothing shells out to parse
YAML. Reference (see `config.example.yml` in the skill for the annotated
version):

```yaml
repo: owner/name
default_branch: main
ledger_issue: 0              # written by mm-setup.sh
state_dir: logs/merge-monster
poll_interval: 30            # seconds, watch-script cadence
heartbeat_minutes: 30        # ScheduleWakeup fallback tick
stale_lock_minutes: 45       # baton freshness contract
merge_method:
  multi_commit: merge        # preserve per-issue commits in batches
  single_commit: squash
ready_requirements:
  review_marker: ""          # e.g. "<!-- cr-cli-findings -->" — evidence comment MM requires
conflict_magnets: []         # globs whose PRs merge early (churn minimization)
migration_globs: []          # globs marking migration-bearing PRs (operator window)
local_gate: ""               # full local validation command (Dependabot gate)
dependabot:
  auto_merge: [patch_dev, minor_dev, patch_ci, minor_ci, grouped_patch]
escalation:
  slack_channel: ""          # empty → GitHub-only escalation
fix_attempts_max: 2
ci_reruns_max: 1
```

## 12. Guardrails

- Never merge red required checks; never admin-bypass; never plain
  `--force`; never push to the default branch.
- Never resolve substantive review threads to unblock a merge.
- Never apply database migrations where that is operator-only — ping instead.
- Hard caps: fix attempts (2), CI re-runs (1 per cause), then escalate.
- Everything MM cannot resolve becomes an **escalation with a diagnosis**,
  never a silent stall — and never a silent drop.
- The baton is advisory: MM must tolerate a human merging out from under it
  (re-snapshot, reconcile, log the anomaly, continue).

## 13. v2 expansions

Deliberately out of v1 scope; the design leaves each a clean seam.

1. **Webhook ingress.** Replace the watch script's poll loop with a true push
   path: GitHub repo webhook → tunnel (Tailscale Funnel / Cloudflare Tunnel)
   → tiny receiver appending JSON lines to an events file → the Monitor
   becomes `tail -f`. Only `mm-watch.sh` changes; the event vocabulary is
   already the interface. Buys ~28s of latency; worth it only if the poll
   cadence ever matters.
2. **Cloud baton takeover.** A scheduled cloud routine that can hold the baton
   when the local machine is down. Requires the state files to round-trip
   through GitHub (ledger issue body or a state branch) since cloud runs have
   no local disk continuity. The heartbeat/stale-lock contract already
   supports handover.
3. **CI pipelining.** Overlap the *next* PR's CI run with the current PR's
   merge+post-merge window when the two touch disjoint files. Cuts queue
   latency ~in half at the cost of occasionally wasted runs; gate it on a
   file-overlap check.
4. **Merge trains.** Speculative batch: rebase PR B onto A's result before A
   merges, run CI once on the combined head. Big CI savings for long queues;
   meaningful complexity — only worth it at sustained queue depth > 3.
5. **Multi-repo monster.** One session, several repos: per-repo config +
   per-repo Monitor, shared decision loop and journal. The label protocol and
   baton are already repo-scoped.
6. **Metrics dashboard.** Render the `.jsonl` journal into engsys's dashboard:
   queue depth over time, ready→merge lead time, CI re-run rate, escalation
   rate, Dependabot throughput, CI minutes saved vs. naive merging.
7. **Learning loop.** At project closeout, mine the journal for recurring
   escalation families and feed them back as ordering-principle or preflight
   tweaks (and lessons-library entries).
8. **Thread-resolution policies.** Configurable classes of review threads the
   resolver may close autonomously (typo nits, formatting), with everything
   else escalated. Today it's conservative-by-default.
9. **Auto-enqueue.** A repo Action that applies `mm:ready` automatically when
   a draft PR's checklist conditions are met, removing the human/agent step.

## 14. Portability & requirements

- **Ships as** an engsys core skill — installed into any project by the
  engsys installer (`core/skills/` is always-all), alongside the
  `/merge-monster` command and the enqueue-protocol workflow doc.
- **Requires:** `gh` (authed, `repo` scope; `project` scope if phase ordering
  reads GitHub Projects), `jq`, bash, and a Claude Code environment with the
  Monitor tool. Optional: a Slack integration for escalations.
- **Repo-specifics live in config**, not prose: required checks, conflict
  magnets, migration globs, merge methods, the local gate command, escalation
  channel. The SKILL.md contains no repo names.
- **Setup is deterministic:** `mm-setup.sh` idempotently creates the labels
  and the ledger issue and prints the config lines to paste.

## 15. Rollout checklist (per repo)

1. Install the skill (engsys installer, or copy `core/skills/merge-monster/`
   + `core/commands/merge-monster.md` into `.claude/`).
2. Write `.claude/merge-monster.yml` (start from `config.example.yml`).
3. Run `mm-setup.sh --repo <owner/name>`; record the ledger issue number in
   the config.
4. Add the enqueue convention + baton rule to the repo's `CLAUDE.md` (template
   in `core/workflows/merge-monster-protocol.md`).
5. Start a session on the always-on machine: `/merge-monster`.
6. First week: watch `state.md` and the journal; tune conflict magnets and
   Dependabot policy.
