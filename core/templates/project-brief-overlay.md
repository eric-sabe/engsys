# Project brief overlay

_Project-owned: seeded once by the installer, filled by `/naturalize`, never
overwritten by `engsys update`. worker-package.mjs appends this to every worker
brief — it is where THIS repo's priors live. A review package refuses to build
while this file still carries the TODO sentinel, because a reviewer with no
local priors is a review in name only._

<!-- TODO(naturalize): fill every section below, then delete this comment and
     the sentinel lines. Mine docs/agent-lessons/ and past review findings for
     the failure corpus — "here is how this repo fails" is the highest-leverage
     context a worker gets. -->

## Hard invariants

TODO(naturalize): the rules with no exceptions. Examples of the *kind* of thing
that belongs here (from a real project): no real people's data anywhere, ever —
fixtures use synthetic names; every tenant-owned query scoped by the tenant
key; a DB row id never round-trips through the client; the injected clock is
threaded deliberately — no inline `new Date()`.

## House failure corpus

TODO(naturalize): the defect families THIS repo has actually shipped, so
reviewers hunt in the right place and implementers do not re-ship them. Write
each as shape → how it hides → the concrete instance that shipped. Seed from
`docs/agent-lessons/` and past objective-review findings; keep it current at
project closeout — newly memorialized families get promoted here, not just to
the lessons folder.

## Framework traps

TODO(naturalize): the stack-specific traps that have each cost a diagnosis
round — the CSRF header a test must send, the hydration race, the ORM drift
check, the stale-closure shape. One paragraph each: symptom, cause, fix.

## Verify commands

TODO(naturalize): the EXACT gate commands the conductor runs, in order. Workers
see these in `verify.md`; the conductor re-runs them as the gate. Include the
honest notes (which command is NOT the real gate, what a listing does not
prove).

```sh
# TODO(naturalize): e.g.
# npm run check
# npx vitest run
# npm run build
```

## Notes for reviewers

TODO(naturalize): where the bodies are buried — modules with known debt,
surfaces with subtle contracts, the consistency pairs (interval vs rate limit,
TTL vs cadence) worth checking in this repo.
