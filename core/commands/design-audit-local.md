---
description: Iterate on surface design fidelity live in the browser against the running app — compare a surface to the design reference, fix gaps in-loop, re-verify, repeat
argument-hint: <surface name or a route path>
---

# /design-audit-local

Tight, interactive fidelity loop: open the **design reference** (gallery/showcase or mockup) **and** the live local surface side by side in the browser, find where the surface diverges from the reference, **fix the gap in source**, let the dev server hot-reload, re-verify — repeat until it matches or a gap is escalated. The deliverable is working code on this branch, not a spec.

Target: $ARGUMENTS

## The mapping (read this first)

The **reference** is whatever the project uses as design truth (declared in `CLAUDE.md` / design docs): a **design system as code** rendered in a **gallery/showcase**, or a **mockup/proposal** pipeline. The audit checks whether the **live surfaces compose that reference faithfully** — right tokens, right components, right variants/states. So the side-by-side is *reference vs. live surface*.

## When to use this vs `/design-audit`

| You want…                                                              | Use                |
| ---------------------------------------------------------------------- | ------------------ |
| A fast compare-and-fix loop against the running app, edits land now    | **this command**   |
| A thorough remediation spec to review, then turn into a tracker project | `/design-audit`   |
| A pure design critique with no implementation in scope                 | `/design-critique` |

A gap this loop **escalates** (P0 structural / S0–S1 design concern) graduates into `/design-audit` for a proper spec, or `/file-issue`. The P0–P3 / S0–S3 vocabulary below is shared with `/design-audit` on purpose.

## Anchors (resolve to the project's actual paths)

| What                       | Where (project-defined)                                         |
| -------------------------- | -------------------------------------------------------------- |
| Component showcase (ref)   | the rendered gallery/showcase, if one exists                   |
| Design tokens (truth)      | colors / typography / spacing / elevation / motion sources      |
| Components                 | the project's component library                                 |
| Mockups / proposals        | the proposal pipeline, if one exists                           |
| Live surfaces              | the consuming app surfaces                                      |
| Routing / surface split    | the app's router                                               |
| Brand / voice / lexicon    | the project's design/brand brief                               |
| Local dev / git conventions | `CLAUDE.md`                                                    |
| Browser control            | a browser-control MCP (e.g. `chrome-devtools`)                 |

## Phase 0: Preflight — is the dev server up?

This loop is worthless if the app isn't running. Check before anything else. **Do not silently start services** — if it's down, report and stop.

```bash
# The dev server must be listening (port is project-defined)
lsof -nP -iTCP:<dev-port> -sTCP:LISTEN
```

- **Listening** → proceed.
- **Down** → tell the operator to start the project's dev server and stop.

**Worktree bootstrap — check this when the session runs inside a git worktree.** A freshly created worktree may have no installed dependencies. Detect a worktree:

```bash
# In a worktree, --git-dir differs from --git-common-dir; in the main checkout they're equal.
[ "$(cd "$(git rev-parse --git-dir)" && pwd)" != "$(cd "$(git rev-parse --git-common-dir)" && pwd)" ] && echo "worktree"
```

Bootstrap per the project (install deps + any codegen) before the dev server can start.

**Worktree gotcha — check this explicitly.** Hot reload only picks up edits if the dev server's working directory is inside *this* checkout. If the server is running from a different worktree or the main checkout, every fix will appear to do nothing. If you can't confirm the server's cwd, say so and ask the operator to restart it from this directory.

If the browser-control MCP tools are unavailable, stop and tell the operator — this command depends on them. A screenshot-only MCP is a fallback for capture but can't drive the interactive loop as well.

## Phase 1: Scope and route resolution

1. Resolve `$ARGUMENTS` to a live surface and its route (confirm by navigating, don't assume) — the surface→route→source mapping is project-defined.
2. If the surface carries a **demo/state switcher** (so you can reach empty/loading/error and any lifecycle states without a backend), use it to cover those states.
3. If `$ARGUMENTS` is ambiguous, ask the operator once with `AskUserQuestion`.

## Phase 2: Side-by-side capture

Open both in the browser so every comparison is concrete:

1. **Reference** — open the gallery/showcase (or the mockup) for the component(s) in scope.
2. **Live surface** — open the resolved route from Phase 1.
3. Resize both to **1440×900** (primary desktop). Screenshot each. This pair is the comparison anchor.
4. If responsive is in scope, repeat at **768** (tablet) and **375** (mobile).
5. Audit **both themes** if the project ships light/dark — drift often hides in one theme only.

Use the accessibility-tree snapshot to find/identify elements, and computed-style reads when a visual diff is ambiguous (e.g. is that the token, or a magic hex?). Use screenshots for the visual record.

## Phase 3: Interactive audit walk

Walk the live surface against the reference. Because this is the *running* app, you can exercise things a source read can't.

**Fidelity dimensions** (same as `/design-audit` — don't skip any): Layout & IA · Components (system vs hand-rolled, right variant/state) · Copy (lexicon + voice) · Design tokens (**magic hex / magic px = P1 gap**) · States (drive lifecycle + hover/focus/loading/error) · Interactions (hover/active/focus, motion tokens, `prefers-reduced-motion`, disabled, form validation — actually click and observe) · Responsive (1440 / 768 / 375, no horizontal scroll) · Accessibility (run an a11y audit; contrast, focus ring, ARIA on icon-only buttons, heading order).

**Live-only checks — capture these too** (a static `/design-audit` misses them):

- Console messages — JS errors, framework warnings, prop-type complaints.
- Layout shift / flashes on load.

For each divergence, log a gap (Phase 5 format). Triage immediately into two buckets:

- **Fix-live** — P1 visual drift, P2 polish, wrong tokens, wrong copy, wrong component, wrong hover/focus/transition. Goes into Phase 4.
- **Escalate** — P0 structural (a whole component or section missing — may be unbuilt work, not drift), or an S0/S1 design concern (the *design itself* is questionable). Surface to the operator; don't hack a structural feature into place to chase a screenshot. For an S0/S1 judgment call, pull in the **leith** subagent for a brand/UX second opinion (and **nyx** if it touches a security boundary).

## Phase 4: Rapid fix loop

The core of the command. For each **fix-live** gap the operator greenlights, one at a time:

1. **Locate** the source — the surface file, or a shared component. Use the snapshot + visible text/classes to pin the element to a file.
2. **Edit** — make the smallest change that closes the gap. Prefer fixing the **surface to use the system** (swap hand-rolled markup for the design-system component, swap a magic hex for the token) over patching pixels locally. Never introduce a magic hex/px.
3. **Reload** — hot reload usually reflects the change in ~1s. Navigate with reload if it didn't catch. Watch console messages for new errors.
4. **Re-verify** — re-screenshot the live route at the same viewport (and both themes if relevant), compare to the reference again. Fixed → mark resolved. Not fixed → iterate.
5. **Iteration cap** — if a single gap isn't closed after **3** attempts, stop, write down what's blocking it, move on.

Work the buckets in order: **P0 escalations first** (operator decides scope), then **P1**, then **P2**. Leave **P3** unless the operator pulls them in.

Keep the operator in the loop — this is interactive. After a cluster of related fixes, show the before/after and let them react before moving on.

## Phase 5: Gap log (lightweight)

Track findings in `tmp/design-audit-local-<surface>-<YYYY-MM-DD>.md` (`mkdir -p tmp` first; gitignored). A working scratchpad, **not** a `docs/specs/` deliverable — keep it terse. It exists so nothing is lost and so escalated gaps can graduate into a `/design-audit` spec.

Per gap:

```markdown
### Gap: <one-line summary>

- **Severity**: P0 broken | P1 visual drift | P2 polish | P3 nice-to-have (or S0–S3 for a design concern)
- **Type**: missing | wrong-state | wrong-tokens | wrong-copy | wrong-component | wrong-interaction | wrong-layout | a11y | runtime-error
- **Reference**: <gallery demo / mockup / component / token file>
- **Implementation**: `<surface file>:<line>`
- **Observed (live)**: <what the running app does — attach screenshot ref>
- **Expected (system)**: <what the reference prescribes>
- **Disposition**: FIXED-LIVE (commit <pending>) | ESCALATED (<why — needs spec / unbuilt feature / S0-S1 design concern>) | BLOCKED (<what stopped the fix>)
```

## Phase 6: Handoff

Final report to the operator:

- **Surface + route audited**, viewports + themes covered.
- **Fixed live** — count + one line each. These are uncommitted edits on this branch.
- **Escalated** — gaps that need a spec or are unbuilt features. Recommend `/design-audit <surface>` for a full remediation spec, or `/file-issue` per gap.
- **Blocked** — gaps that resisted 3 fix attempts, with the blocker.
- **Live-only findings** — console errors, a11y misses.
- **State coverage** — which lifecycle/empty/error states you verified, which you couldn't (and why).
- **Next step** — remind the operator the fixes are uncommitted: run `/pre-push` to gate, then commit per `CLAUDE.md` § Git / PR conventions. Don't auto-commit or auto-push.

## Operating rules

- **Preflight is non-negotiable.** Don't start the loop against an app that isn't running, and don't silently boot services — report and let the operator start it.
- **Fix-live means visual fidelity, not feature work.** A whole missing component or section is a P0 escalation, not something to scaffold mid-loop.
- **Use the system, don't reinvent it.** The best fix is usually making the surface consume the design-system component instead of hand-rolled markup. Token compliance is not optional — any color/spacing/type/radius not from the project's tokens is a P1, even if it looks identical.
- **One gap at a time.** Edit → reload → re-verify → next. Batching makes it impossible to tell which edit broke what.
- **The system is the reference, not gospel.** If the *design itself* is wrong (S0/S1), escalate it — don't faithfully implement a bad design. That's a `/design-audit` Phase 3 / `/design-critique` conversation.
- **Sanity before fidelity.** If the surface has a fundamental design problem, surface it loudly before grinding pixel gaps.
- **Cite, don't summarize.** Every gap references the reference side and `<surface file>:<line>` so the operator can verify in 30 seconds.
- **States are the product.** Use the demo switcher to reach lifecycle/empty/error states; don't log a gap for a state you couldn't actually observe.
- **Don't commit or push.** This loop ends with uncommitted edits. The operator runs `/pre-push` and commits.

See `CLAUDE.md` § Pre-push gate and § Git / PR conventions for the gate and commit rules, and the project's design/brand brief for brand/voice.
