# Copy Rules — Sandy's bar for every visible string

An explainer earns attention with its picture and loses it with its prose. These rules apply to **every string a reader can see**: title, subtitle, node labels, edge labels, panel details, step text, legend, buttons. If the `sandy` agent is installed, she runs this pass; these rules are the fallback.

## Budgets (hard limits)

| Surface | Budget | Note |
|---|---|---|
| Title | ≤ 8 words | What the thing is, not a slogan |
| Subtitle | 1 line | **The question the explainer answers**, phrased as a question |
| Node label | ≤ 3 words | Verbs for actions ("Merge to main"), nouns for things ("Artifact store") |
| Edge label | ≤ 3 words | The event/condition only; mechanism goes in detail |
| Node/edge detail | ≤ 3 sentences | Mechanism, not description. ~60 words |
| Step title | ≤ 6 words | |
| Step body | ≤ 2 sentences | The one thing to get before the next step |
| Legend entry | ≤ 4 words | Plain words: "what it needs", not "upstream ancestry set" |

## Rules

1. **Start at the picture.** No intro paragraph, no "This page explains…". The title, the question, the diagram. If context is genuinely needed, it's a step, not a preamble.
2. **Mechanism over description.** "CI blocks the merge until tests pass" beats "quality is ensured by our pipeline". A detail that could caption *any* system is a detail for *no* system.
3. **Don't caption the arrow.** If the diagram shows A → B, the detail must not say "A goes to B". Say what the arrow *can't*: why, what's carried, what fails.
4. **One term per concept.** If the diagram says "Deploy", the steps say "Deploy" — never "ship", "release", and "roll out" for the same box. Match the codebase's own vocabulary.
5. **Name the failure.** Every loop-back and fail edge gets an honest label ("changes requested", "regression detected") — skeptical readers trust diagrams that admit failure paths.
6. **Second person or no person.** "Click a node to trace it" — never "users can click…".
7. **Controls state their object and their effect.** "Start the tour (6 steps)" beats "Next"; "Resume step 3" beats an ambiguous arrow. A button label is the shortest explainer on the page — budget it like one.

## Banned words

`leverage` · `seamless` · `robust` · `powerful` · `simply` · `just` · `easy` · `comprehensive` · `streamline` · `enable` (as filler) · `utilize` · `revolutionary` · `next-generation` · `unlock` · `elegant` · `intuitive` · `handles everything` · any adjective doing a mechanism's job

If a sentence dies without its adjective, the sentence had no content.

## The graveyard

Cut lines don't vanish — they move to a comment at the bottom of the file:

```html
<!-- graveyard:
  "Our robust pipeline seamlessly ensures quality"  → replaced by the CI node detail
-->
```

This keeps the diff honest and stops the next editor from resurrecting a killed darling.

## Before / after

| Before | After |
|---|---|
| "The system leverages a comprehensive CI/CD pipeline to seamlessly deliver value" | "Every merge deploys to canary. Metrics decide if it goes further." |
| Node: "Continuous Integration Validation Phase" | Node: "CI: build + test" |
| Step: "In this step we can see how the review process works" | Step: "Review gates the merge" |
| "Errors are handled gracefully" | "A failed canary rolls back within 5 minutes" |

## The test

Read every string as the reader with their arms crossed. If any line exists to sound smart rather than to explain, it goes to the graveyard. If they have to read it twice, you wrote it once too many times.
