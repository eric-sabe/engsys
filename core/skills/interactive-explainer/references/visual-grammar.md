# Visual Grammar — layout recipes per shape

Each shape below: when it's right, how to lay it out, the interaction that earns its keep, and the trap that ruins it. All of them assume the starter's data model (`nodes` / `edges` / `steps`).

## 1. Workflow / pipeline

**Right when:** steps with a direction, one actor or one system. Builds, request paths, approval flows.

**Layout:** left→right, ranked by longest path from the sources (the starter does this). Vertical on mobile. Keep the happy path on one visual line; branches hang off it.

**Interaction:** step-through narration is the whole game. Each step focuses 1–3 nodes and says the one thing the reader must get before moving on.

**Trap:** decision diamonds everywhere. Prefer one bold happy path with failure/alternate edges drawn muted (`kind: 'fail'`, dashed) until a step or click brings them forward.

## 2. Swimlanes (workflow across actors)

**Right when:** the *handoffs* are the story — who does what, where responsibility crosses a boundary.

**Layout:** one horizontal band per actor, time flowing left→right, nodes pinned to their actor's band. Add a `group` per actor and render band backgrounds behind the ranked layout. 3–5 lanes max; beyond that, cluster actors.

**Interaction:** step-through, plus lane emphasis — the active step lights its lane label. Clicking a lane label focuses everything in the lane.

**Trap:** lanes force geometry. If one actor owns 80% of the nodes, swimlanes waste the screen — fall back to a plain workflow with group-tinted nodes.

## 3. Cycle / loop

**Right when:** the *return* is the point — lifecycles, feedback loops, retry/reconcile loops, control loops.

**Layout:** nodes on a ring, clockwise, first node at 12 o'clock. Edges along the ring as arcs; branch/escape edges point outward from the ring. For a workflow that merely *contains* a loop, don't build a ring — keep the flow layout and mark the return edge `kind: 'loop'` (the starter draws it as a curved back-edge and excludes it from ranking).

**Interaction:** a token walking the loop (SVG `animateMotion` along the ring path, or step-through advancing node by node). The moment of "…and then it starts again" should be *seen*, not read.

**Trap:** rings above ~8 nodes become clock faces nobody can follow. Collapse sub-sequences into one node with a detail panel, or switch to flow-with-back-edge.

## 4. Dependency graph (DAG)

**Right when:** "what needs what" — imports, service dependencies, build targets, data lineage.

**Layout:** layered left→right (dependencies left, dependents right — or the reverse, but pick one and put it in the legend). One barycenter ordering pass per rank kills most crossings at this scale. Hand-tune with an explicit `rank` override on stubborn nodes rather than writing a better algorithm.

**Interaction:** **two-color ancestry** — click a node: everything upstream (what it needs) in one color, everything downstream (what needs it) in another, rest dimmed. It answers "what breaks if this changes?" for every node. The starter ships it.

**Trap:** showing every edge. Past ~30 nodes, cluster by package/team/layer into collapsible group nodes; an unreadable hairball is *worse* than markdown.

## 5. State machine

**Right when:** a thing has modes and events move it between them — order status, connection lifecycle, auth session.

**Layout:** states as nodes, transitions as labeled edges (the event is the label; guard/effect go in the edge's detail). Layered layout works; put the initial state left, terminal states right. Self-transitions as small loops on the node.

**Interaction:** **simulate.** Show the current state; render the legal events as buttons; firing one animates the transition and appends to a visible event log. Readers trust a machine they've driven.

**Trap:** labeling edges with prose. The edge label is the event name only — three words max; everything else is detail-on-demand.

## 6. Layered architecture / stack

**Right when:** containment and levels — runtime layers, network stacks, permission boundaries.

**Layout:** full-width horizontal bands, top-down. Components as nodes *inside* their band. Boundaries that matter (trust, network, process) drawn as heavy band borders with a label — a boundary nobody drew is a boundary nobody sees.

**Interaction:** click a layer to expand it in place (others compress); click a component for detail. A "trace a request" step-through that pierces the layers top-to-bottom is the best narration this shape has.

**Trap:** making it a picture of boxes that says nothing. Every band must answer "what does this layer *refuse* to know about the ones above it?" in its detail — that's the content that earns the diagram.

## 7. Timeline / sequence

**Right when:** order and causality over time — incident timelines, protocol exchanges, migration phases.

**Layout:** time on one axis (horizontal for phases, vertical for message sequences). For sequences: actor lanes as columns, message arrows between them, time flowing down.

**Interaction:** scrub or step — a time cursor the reader drags/advances, with the panel narrating the moment. Everything after the cursor sits dimmed: the future shouldn't distract from the now.

**Trap:** uniform spacing for non-uniform time. If gaps matter (incident timelines), space proportionally and label the gaps; if only order matters, say so in the legend.

## Scale limits (all shapes)

| Node count | Treatment |
|---|---|
| ≤ 12 | Show everything |
| 13–30 | Show everything, but focus-mode is mandatory and default view dims secondary edges |
| 31–100 | Cluster into collapsible groups; overview shows clusters only |
| > 100 | Wrong tool — generate per-cluster explainers with an index page |

## Multi-scene explainers

When the story is bigger than one question, don't cram one diagram — split into **scenes** (chapter tabs), each its own shape with its own worked-example opening, plus **one tour that spans scenes**: each step names its scene and the engine switches automatically. Keep one panel, one stepper, one keyboard map across all scenes; track visited marks per scene. The reader gets both paths — the guided story end to end, and free exploration per chapter — without ever leaving the file.
