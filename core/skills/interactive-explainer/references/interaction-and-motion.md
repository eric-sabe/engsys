# Interaction & Motion — patterns beyond the starter

The starter ships the core set (focus+context, ancestry highlighting, stepper, keyboard map, reduced-motion). This file is the reasoning behind them and the recipes for going further.

## The three-tier read

Every explainer serves three depths of attention, in order:

1. **Overview (0 clicks)** — the whole shape, legible, on the first screen. A reader who leaves after five seconds should still have the gist.
2. **Focus (1 click)** — click anything → its neighborhood lights up, the rest dims, the panel explains it. Dim, don't hide: context is the point (~25% opacity, not `display:none`).
3. **Detail (on demand)** — the panel, not tooltips. Tooltips die on touch screens and can't be the only home of real content.

If a fact matters, it's reachable at tier 3. If a fact shapes the structure, it's *visible* at tier 1.

## Two-color ancestry

On node click: BFS the reverse adjacency for upstream (one color), forward for downstream (another), dim everything else, color the edges along each direction to match. Exclude `kind: 'loop'` edges from the BFS or every node in a cycle becomes its own ancestor. Put both colors in the legend with plain words: "what it needs" / "what needs it".

## Step-through vs scrollytelling

- **Stepper** (starter): ≤ 12 steps, one diagram, reader in control, works at any viewport. Default choice.
- **Scrollytelling** (diagram pinned, prose scrolls past, scroll position drives state): choose only when the *narrative* dominates and runs long — essays, postmortems. Costs more, breaks more, and hijacking scroll badly is worse than not doing it. If in doubt, stepper.

Either way: every step names its focus explicitly (`focus: [ids]`). A step whose text doesn't match its highlight is a bug, not a style issue.

## Hover vs click

Hover *hints* (cursor, slight emphasis, edge label reveal); click *commits* (focus, panel, state). Everything reachable by hover must be reachable by click — touch has no hover. Never attach the only path to information to hover.

## Motion recipes

Motion answers exactly one question in an explainer: **which way does it flow?** Everything else is decoration.

- **Edge flow:** `stroke-dasharray` + animated `stroke-dashoffset` on *active* edges only (starter). Never animate every edge at rest — a diagram where everything moves shows nothing moving.
- **Cycle token:** a dot on `animateMotion` along the ring path, one full lap 6–10s, started by a "play" affordance or the stepper — not autoplaying on load.
- **State transitions:** animate the state marker along the fired edge (200–300ms, ease-out), then settle. Log the event textually too.
- **Focus transitions:** opacity/transform only, 150–200ms. No layout-shifting animation; no bouncing.

**Reduced motion is a contract:** inside `@media (prefers-reduced-motion: reduce)`, all of the above stop; direction falls back to arrowheads and the step counter. The explainer must be fully legible with zero motion — motion is reinforcement, never the only carrier of meaning.

## Keyboard map (standard across explainers)

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move through nodes (and controls) |
| `Enter` / `Space` | Focus the node under the cursor |
| `←` / `→` | Previous / next step |
| `Esc` | Reset — clear focus, exit steps |

Keep this map; readers who learn one explainer have learned them all. Nodes are `role="button"` with `tabindex="0"` and an `aria-label`; the panel is `aria-live="polite"` so step changes are announced.

## Touch & small screens

- Node hit areas ≥ 44px tall (pad the shape, not the label).
- At ≤ 720px the panel stacks below the diagram; the diagram scales via `viewBox` — no horizontal scroll.
- Stepper buttons stay on screen (sticky) so a thumb can drive the story.

## Performance envelope

- SVG + DOM events is fine to ~300 nodes; you should have clustered long before that (see visual-grammar scale limits).
- One `drop-shadow`/glow on the *current* node is fine; filters on every node kill paint time.
- Build the SVG once from data; interactions toggle classes. Never rebuild the DOM per click.

## Don'ts

- No autoplaying motion on load. The reader starts the story.
- No meaning in color alone — pair with dash pattern, weight, shape, or label (color-blind readers, grayscale prints).
- No zoom/pan unless the diagram genuinely exceeds a screen *after* clustering — fit-to-viewBox first.
- No scroll hijacking that fights the reader.
