---
name: interactive-explainer
description: Build single-file interactive HTML explainers/explorers that visually explain systems — cycles, workflows, pipelines, dependency graphs, state machines, architectures, timelines. Use when asked for an "interactive explainer", "HTML explorer", "explain this visually", "make an interactive diagram of how X works", or when a markdown explanation of structure (who calls what, what depends on what, what loops back) is getting long. Produces a self-contained, offline-safe .html with focus+context highlighting, step-through narration, and copy that passes the copy rules.
---

# Interactive Explainer

Turn "how does X work?" into a single HTML file the reader can *explore*: click a node to see what feeds it and what it feeds, step through the story, read details on demand. The picture carries the structure; the words carry only what the picture can't.

## When to use — and when not

| Situation | Verdict |
|---|---|
| Cycles, workflows, dependencies, state machines, lifecycles, request paths | **Yes** — this is the target case |
| A concept with real structure that markdown flattens into "and then… and then…" | **Yes** |
| Live data, dashboards, real metrics | **No** — that's an app; use the project's data/dashboard tooling |
| A list, a comparison table, three bullet points | **No** — markdown wins; don't build a page to say what a sentence says |

## The contract

1. **One self-contained `.html` file.** No build step, no CDN, no external requests. It must open from disk, offline, forever. (Embed a font via `@font-face` data-URI only if the file budget allows; otherwise pick a deliberate local stack and let weight/size/spacing do the typographic work.)
2. **Data-driven.** Nodes, edges, and steps live in one JS object at the top of the file. The rendering reads the data; nobody should ever edit SVG coordinates to fix a typo.
3. **The picture carries structure; words carry mechanism.** If the text restates what an arrow already shows, cut the text.
4. **Overview first, zoom and filter, details on demand.** The first screen is the whole shape, legible — with the interaction model *demonstrated*, never a blank slate a prose hint has to explain. Open on a worked example (a pre-lit focus via `opening:` or an active step 0) so the first screen shows what clicking does. The legend may not name a state the reader hasn't seen. Detail appears when asked — click, hover, step — never as a wall of prose beside the diagram.
5. **Accessible or unshipped.** Keyboard operable (Tab/Enter on nodes, ←/→ steps, Esc reset), `prefers-reduced-motion` honored, AA contrast, meaning never encoded in color alone, readable at 375px.
6. **A deliberate aesthetic.** Commit to a direction (editorial, technical-manual, blueprint, terminal…) with a dominant color and one sharp accent. No default-looking gradient-card slop.
7. **SVG, not canvas.** Crisp, inspectable, DOM events, screen-reader reachable. Canvas only past ~300 nodes — and past ~30 unclustered nodes you should be collapsing groups anyway.

## Workflow

### 1. Frame
Name **the one question the explainer answers** (it becomes the subtitle). Name the reader. If you can't state the question in one line, the scope is wrong — split it.

### 2. Pick the shape
| The content is… | Shape | Signature interaction |
|---|---|---|
| Steps with a direction, one actor | Workflow / pipeline | Step-through narration |
| Steps across actors/systems | Swimlanes | Step-through + lane highlight |
| A loop (lifecycle, feedback, retry) | Cycle ring | Token walking the loop |
| "What needs what" (imports, services, builds) | Dependency DAG | Two-color ancestry: click → upstream vs downstream |
| Modes and transitions | State machine | Simulate: fire events, watch state move |
| Containment / levels | Layered stack | Click layer to expand |
| Ordered events, causality over time | Timeline / sequence | Scrub / step |

Mixed shapes are normal — a workflow with a feedback loop is a flow plus a marked back-edge, not two diagrams. Full recipes and traps: [references/visual-grammar.md](references/visual-grammar.md).

### 3. Model the data
Write the `EXPLAINER` object first — nodes (id, label, group, detail), edges (from, to, kind), steps (title, body, focus). If the data model is muddy, the diagram will be too. Get the model reviewed against the source of truth (code, spec) before styling anything.

### 4. Build from the starter
Copy [assets/starter.html](assets/starter.html) and replace the data. It already has: layered DAG layout with cycle-aware back-edges, click-to-focus with upstream/downstream ancestry highlighting, a step-through narrator, detail panel, legend, keyboard map, reduced-motion handling, and a themable token block. Restyle the tokens to the chosen aesthetic; don't re-derive the machinery. Interaction and motion recipes beyond the starter: [references/interaction-and-motion.md](references/interaction-and-motion.md).

### 5. Copy pass — Sandy's bar
Every visible string obeys [references/copy-rules.md](references/copy-rules.md): title ≤ 8 words, node labels ≤ 3, details ≤ 3 sentences of mechanism, banned-word list enforced, cut lines moved to the graveyard comment. **If the `sandy` agent is installed, hand her the draft copy for the pass; the rules file is the fallback when she isn't.**

### 6. Quality gate
Open the file in a browser (use the `webapp-testing` or `chrome-devtools` skill if available). **If the `gary` agent is installed, hand him the artifact for a first-contact audit — his cold-open/walkthrough/severity method is this gate, run properly.** Verify:

- [ ] Cold open, ten seconds, no reading: it's evident that nodes are clickable and a tour exists
- [ ] The opening state demonstrates focus and the legend colors — a worked example, not a hint
- [ ] Clicking a node mid-tour pauses the tour — position preserved, resume offered
- [ ] The whole shape is legible on the first screen — no scroll to understand
- [ ] Click any node → upstream/downstream highlight correct (spot-check against the data)
- [ ] Step-through: ←/→ work, every step's focus matches its text
- [ ] Esc resets; Tab reaches every node; Enter activates
- [ ] OS reduced-motion set → nothing moves
- [ ] 375px wide → panel stacks, nothing clips
- [ ] Zero console errors; zero network requests
- [ ] Every visible string passed the copy rules
- [ ] File opens from `file://` with no server

## Files

- [references/visual-grammar.md](references/visual-grammar.md) — layout recipes per shape, and their traps
- [references/interaction-and-motion.md](references/interaction-and-motion.md) — focus+context, steppers, motion, a11y
- [references/copy-rules.md](references/copy-rules.md) — the clarity bar for every visible string
- [assets/starter.html](assets/starter.html) — working scaffold; copy it, replace the data, restyle the tokens
