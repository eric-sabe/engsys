---
name: react-conventions
description: React + Next.js client conventions for this repo (React 19 / Next.js 16, React Query / TanStack Query, Radix UI, shadcn-style cards/dialogs). Use when writing or reviewing React components, hooks, optimistic cache patches, data-fetching code, dialogs, Radix Select usage, JSX, interactive cards/rows, or Next.js Edge Runtime / middleware code. Covers optimistic-cache completeness, fetch error states, destructive-dialog error handling, the React 19 set-state-in-effect rule, a Radix Select form footgun, a JSX-ternary-comment parse error, composite-interactive a11y, the Edge-Runtime/Prisma import boundary, and the shared API-helper convention.
---

# React + Next.js Client Conventions

Applies to: client components and hooks in the repo's web frontends. Stack assumed: React 19 / Next.js 16 (App Router), TanStack Query (React Query), Radix UI primitives, a shared `api` client helper, and a same-origin BFF/proxy. Test runner is Vitest + Testing Library (see the sibling `frontend-testing` skill).

> Naturalize: confirm framework versions, the query-client setup, and the shared API helper path in `CLAUDE.md`. Paths below (`services/dashboard/lib/...`) are illustrative.

These conventions are the React/Next.js-specific **mechanism**. The cross-project **principles** behind several of them — "a change isn't done until every surface is updated", "shift correctness left and distrust false greens" — live in the engsys `lessons-library/`. This skill carries the concrete React shape.

## Contents

- [Optimistic cache patches must be complete](#optimistic-cache-patches-must-be-complete)
- [Derived parent fields: inherit the server's rule](#derived-parent-fields-inherit-the-servers-rule)
- [Error states on data fetch](#error-states-on-data-fetch)
- [Destructive dialogs own their error + pending state](#destructive-dialogs-own-their-error--pending-state)
- [No setState inside useEffect (React 19)](#no-setstate-inside-useeffect-react-19)
- [Radix Select inside a form: guard the empty reset](#radix-select-inside-a-form-guard-the-empty-reset)
- [No JSX comment inside a ternary branch](#no-jsx-comment-inside-a-ternary-branch)
- [Composite interactive a11y](#composite-interactive-a11y)
- [Next.js Edge Runtime: no Node-only imports at module scope](#nextjs-edge-runtime-no-node-only-imports-at-module-scope)
- [Data fetching goes through the shared API helper](#data-fetching-goes-through-the-shared-api-helper)
- [Common mistakes](#common-mistakes)
- [Review checklist](#review-checklist)

## Optimistic cache patches must be complete

An optimistic React Query patch is a hand-written mirror of the server's write. It is correct only when it touches **every** surface the mutation touches. Five recurring incompleteness shapes:

1. **Update every projected/derived field.** For each field the server derives from child rows, mirror the exact server projection rule — ranking (`ACCEPTED` outranks `DECLINED`), last-pending checks, primary-vs-non-primary. Do not assume `result.status` is authoritative; check what the server would compute. A missed projection causes optimistic → server-returned flicker.
2. **Re-sort when the mutation changes a sort key.** If the patch updates a field the list sorts by, re-sort before returning: `[...nodes].sort(sortFn)`. Guard with `'sortOrder' in node` to skip unrelated updates.
3. **Refresh sibling derived caches.** Count/stats/rollup/badge caches that read the mutated collection go stale. Patch or invalidate them explicitly (e.g. pass `derivedKeys: [queryKeys.nodes.stats(scopeId)]`). Never assume an unrelated refetch will eventually fix it.
4. **Reconcile placeholders by a stable id.** Generate an `optimisticId` at `onMutate` time and thread it through to `onSuccess`. Match/remove the placeholder by `node.id === optimisticId` only — never by `label`, `index`, or any user-controlled field, or two concurrent creates with the same label silently drop one.
5. **Return new references — never mutate in place.** React Query uses reference equality to decide whether to notify subscribers. `arr.sort()` / `obj.field = x` mutate the cached object without notifying. Use `[...arr].sort(fn)` and `{ ...obj, field: x }`. When a mapper returns the original reference on a no-match, skip `setQueryData` entirely.

```ts
// Wrong — mutates the cached array, no sibling refresh, stale derived field
const node = cache.find((n) => n.id === id);
node.sortOrder = next;            // in-place mutation: no notify
updated.sort(sortDepth1);         // mutates the cached array

// Right — new references, re-sort a copy, refresh siblings
const patched = cache.map((n) => (n.id === id ? { ...n, sortOrder: next } : n));
const sorted = [...patched].sort(sortDepth1);
queryClient.setQueryData(listKey, sorted);
queryClient.invalidateQueries({ queryKey: queryKeys.nodes.stats(scopeId) });
```

**Cache-KEY completeness** is the same family: any new query parameter that changes the result set MUST be in the cache key, or two parameter values collide on one cached entry and serve wrong data. When adding a filter param, grep every queryKey/cache-key builder for that query's shape and add the param in the same commit.

**The full statement:** a mutation (or a new query param) touches three cache surfaces — (1) the patched/invalidated entries, (2) every sibling family that *displays* the entity (list, detail, rollup, badge/count), and (3) the cache KEY itself. Enumerate all three before declaring the cache handling done.

## Derived parent fields: inherit the server's rule

When a mutation on a child rolls up into a parent summary field, **re-derive the parent field from the full updated state, not from the mutation result alone.** Inherit the server's calc/precedence rule exactly; fall back to `result` only when there is no better signal.

```ts
// Wrong — ignores an already-decided primary
const newStatus = remainingPending.length > 0 ? "PENDING" : result.status;

// Right — inherit the primary's decided status; fall back to result when none decided yet
const primaryDecidedStatus = rec.themeImpactId
  ? rec.decidedSuggestions?.find((s) => s.id === rec.themeImpactId)?.status
  : undefined;
const newStatus =
  remainingPending.length > 0 ? "PENDING" : (primaryDecidedStatus ?? result.status);
```

Apply identical derived-state logic to **both** the list cache and the detail cache (separate `setQueryData` calls) — copy/paste divergence here makes the card and the detail panel disagree. Grep the owning server service for the projection rule (e.g. an `IMPACT_STATUS_RANK`) and confirm the patch matches every branch.

## Error states on data fetch

Never silently `return null` on a fetch error for primary content — the user gets a blank section with no signal. Handle `isError` with user-visible UI. `null` is acceptable only for decorative tiles where the page still renders meaningfully.

```tsx
const { data, isError } = useSubscriptionInvoices();

// Decorative strip / tile — page still meaningful without it:
if (isError || !data) return null;

// Primary content card — show an error and a recovery hint:
if (isError) {
  return (
    <Card>
      <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Could not load invoices. Please refresh the page to try again.
        </p>
      </CardContent>
    </Card>
  );
}
```

Anything user-actionable (invoices, past-due status, anything with a `refetch()`) gets the error card. Inline `text-destructive` error for action failures (e.g. a "Manage billing" portal-session failure).

## Destructive dialogs own their error + pending state

A confirm dialog for a destructive action (remove/suspend/delete) must own its own `isPending` and `error` state — not inherit them from the parent, and not route failures to a far-away toast that leaves the modal open with no explanation.

Rules:
1. Dialog owns local `isPending` + `error`.
2. `onConfirm` is typed `() => Promise<void>` and **throws on failure**.
3. Inside the dialog: `setError(null)`, `setPending(true)`, `await onConfirm()`; on success close, on catch `setError(msg)` and do **not** close; `setPending(false)` in `finally`.
4. Render `error` inline; reset it when the dialog **closes** (`if (!next) setError(null)`).
5. The page-level handler throws instead of toasting — the dialog catches and surfaces it.

```tsx
async function handleConfirm() {
  setError(null);
  setIsPending(true);
  try {
    await onConfirm();        // throws on failure
    onOpenChange(false);      // success closes the dialog
  } catch (err) {
    setError(errorMessage(err)); // failure stays open, shows inline
  } finally {
    setIsPending(false);
  }
}
```

## No setState inside useEffect (React 19)

The React 19 / Next.js 16 eslint config ratchets `react-hooks/set-state-in-effect` (and `react-hooks/cannot-access-refs-during-render`) to **error**. `useEffect(() => { if (!open) setForm(EMPTY) }, [open])` and the ref-reset-during-render workaround both fail and block the PR.

- **Reset-on-close → push into the close callback.** Wrap the parent's `onOpenChange` in a local `handleOpenChange(next)` that calls `setForm(EMPTY)` before delegating, and wire it to every close path (Radix Root `onOpenChange`, Cancel button, close-on-success).
- **Derived-from-prop → `useMemo` + controlled fallback** (`const effective = form.value || derivedDefault`) instead of writing state from an effect.
- **Filter-linked resets that must run on dependency change** → wrap the write in `startTransition` so it is scheduled as a non-urgent update outside the synchronous commit:

  ```tsx
  import { startTransition, useEffect } from "react";
  useEffect(() => {
    startTransition(() => setShown(PAGE_SIZE));
  }, [period, scopeId]);
  ```
- **When the reset legitimately fires mid-session** (e.g. on a `provider` change while still open) the close-callback can't cover it — use a targeted per-line `// eslint-disable-next-line react-hooks/set-state-in-effect` with a rationale comment. Every suppressed setter needs its own disable line.

Paired obligation: whenever you set a `saving`/`pending` flag before an async call, reset it (`setSaving(false)`) in **both** the success path and the open-reset — otherwise the confirm button stays disabled when the dialog reopens.

## Radix Select inside a form: guard the empty reset

A controlled Radix `<Select value={x} onValueChange={setter}>` **inside a `<form>`** with an **empty initial value** resets to `""` after the user picks an option. Radix renders an aria-hidden native `<select>` for form participation; when the content closes it remounts with no `<option>`s and fires a spurious `onValueChange("")`. The trigger may still show the right label (it reads props) while the underlying state is empty and the submit stays disabled.

```tsx
// Fixed — ignore the spurious empty-reset (safe when no option has an empty value)
<Select
  value={form.unit}
  onValueChange={(v) => {
    if (v) patch({ unit: v }); // guard against Radix's empty remount event
  }}
>
```

Only triggers with all three: inside a `<form>`, controlled, empty initial value. Initializing to a derived non-empty value avoids it entirely.

## No JSX comment inside a ternary branch

`{/* ... */}` is itself a JSX expression node. A ternary branch expects a **single** expression, so a comment node before the element makes a second child and the parser errors (`Expected '</', got 'ident'`).

```tsx
// Wrong
{kind === "chip" ? (
  {/* comment */}
  <JudgmentChip bucket={bucket!} />
) : ...}

// Right — comment outside the ternary, or wrap the branch in a fragment
{kind === "chip" ? (
  <>
    {/* comment */}
    <JudgmentChip bucket={bucket!} />
  </>
) : ...}
```

## Composite interactive a11y

Making a whole card/row clickable, or adding expand/collapse controls with ARIA relationships:

- **No nested interactives.** No `<a>`/`<button>` descendant of an `<a>`/`<button>` ancestor. If a card is a `<Link>`, inner CTAs become handler-based controls (`e.preventDefault(); e.stopPropagation(); router.push(...)`) — or restructure so the card link is an overlay sibling, not an ancestor.
- **`stopPropagation` on nested control clicks** so activating an inner control does not also activate the clickable container. Verify with both Enter and Space.
- **Gate ARIA relationships on the target's presence.** A trigger pointing `aria-controls` at a region that isn't rendered while collapsed dangles. Gate it: `aria-controls={expanded ? regionId : undefined}`. Every `aria-controls`/`aria-owns`/`aria-describedby` id must exist in the DOM while the attribute is present.

`aria-required-parent`-family violations only fire when the elements actually render, so seeded states can mask them in unit tests — confirm with whole-document axe E2E (see `frontend-testing`).

## Next.js Edge Runtime: no Node-only imports at module scope

Next.js middleware runs in the **Edge Runtime**, which can't load Node-only modules (Prisma, `fs`, native crypto). A *top-level* `import { prisma } from './prisma'` in any module the middleware imports runs at module-load time and crashes — even if `prisma` is only used inside one function.

```ts
// Wrong — top-level import runs in Edge Runtime when middleware loads this module
import { prisma } from "./prisma";
export async function ensureSessionClaimed(id: string) {
  return prisma.session.findUnique({ where: { id } });
}

// Right — lazy import inside the function, which only runs in the Node runtime
export async function ensureSessionClaimed(id: string) {
  const { getPrisma } = await import("./prisma"); // runs only when called from a Node route
  const prisma = await getPrisma();
  return prisma.session.findUnique({ where: { id } });
}
```

Rule: any module reachable from `middleware.ts` must be Edge-safe at module scope — pure functions, constants, types only. Push Node-only access into lazy `await import(...)` calls inside functions that run only in the Node runtime (API routes).

## Data fetching goes through the shared API helper

Use the shared `api` helper (`api.get/post/put/delete`) for all client → gateway calls, never raw `fetch`. The helper provides 401 silent token-refresh + one retry, `X-Tenant-Id` injection, correlation-id forwarding, and centralized JSON error parsing. Raw `fetch` bypasses all of it and a 401 fails silently.

```ts
// Wrong — bypasses auth refresh + tenant headers
const res = await fetch("/api/proxy/api/v1/signals/export", {
  method: "POST", credentials: "include", body: JSON.stringify(payload),
});

// Right — the helper prepends /api/proxy and handles auth/headers/errors
const result = await api.post<SignalExportResult>("/api/v1/signals/export", payload);
```

Exceptions: anchor-click downloads (browser-native `Content-Disposition` streaming) and `rawGet()` when you need the raw `Response` (e.g. inspecting a 404 before throwing).

Use `async/await` for every new API-client method and React Query `queryFn` (`queryFn: async () => await api.get(...)`) — direct promise returns get flagged.

**Param parity:** when you add a query param or response field to the client types/hooks, implement it at the **owning backend service**, not just in the client. A param the client sends but the service ignores makes the UI look wired while the backend silently drops it. Trace every client API change through the gateway/proxy to the owning service and add coverage there in the same change.

## Common mistakes

1. Optimistic patch updates the surface you were looking at but misses a sibling rollup/badge cache.
2. Mutating a cached array/object in place (`arr.sort()`, `obj.x = y`) — no subscriber notify.
3. A new filter param reaches the query but not the cache key — values collide and serve wrong data.
4. Deriving a parent rollup from `result.status` instead of the server's precedence rule.
5. `return null` on `isError` for primary content — silent blank section.
6. Destructive dialog routes failures to a toast and stays open with no inline error.
7. `setState` inside `useEffect` for reset-on-close instead of the close callback.
8. Setting a `saving` flag without resetting it on the success path / open-reset.
9. Unguarded `onValueChange` on a controlled empty-start Radix Select inside a `<form>`.
10. `{/* comment */}` directly inside a JSX ternary branch.
11. Nested anchors/buttons, or `aria-controls` pointing at a not-yet-rendered region.
12. Top-level Prisma/Node import in a module the Edge middleware loads.
13. Raw `fetch` instead of the `api` helper; or extending client types without the owning service.

## Review checklist

- [ ] Optimistic patch updates every derived field, re-sorts on sort-key change, refreshes sibling caches, reconciles by stable id, returns new references
- [ ] New query param is in the cache KEY, not just the query
- [ ] Parent rollup field re-derived with the server's precedence rule, on list AND detail caches
- [ ] `isError` shows visible UI for primary content; `null` only for decorative tiles
- [ ] Destructive dialog owns `isPending`+`error`; `onConfirm` throws; errors inline; reset on close
- [ ] No `setState` in `useEffect` (close callback / `useMemo` / `startTransition` / justified suppression)
- [ ] `saving` flags reset on success and on open-reset
- [ ] Controlled empty-start Radix Select in a form guards `onValueChange` against `""`
- [ ] No JSX comment inside a ternary branch
- [ ] No nested interactives; `stopPropagation` on inner controls; `aria-controls` gated on presence
- [ ] No Node-only imports at module scope in any Edge-middleware-reachable module
- [ ] All gateway calls use the `api` helper with `async/await`; new params implemented at the owning service
