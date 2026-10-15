---
name: react-conventions
description: React + Next.js client conventions (React 19 / Next.js 16+, TanStack Query, Radix UI, shadcn-style cards/dialogs). Use when writing or reviewing React components, hooks, optimistic cache patches, data-fetching code, dialogs, Radix Select usage, JSX, interactive cards/rows, or Next.js 16 proxy.ts / runtime boundary code.
---

# React + Next.js Client Conventions

Applies to: client components and hooks in the repository's web frontends. Stack assumed: React 19 / Next.js 16+ (App Router, `proxy.ts`), TanStack Query (React Query), Radix UI primitives, a shared `api` client helper, and a same-origin BFF/proxy. Test runner is Vitest + Testing Library (see the sibling `frontend-testing` skill).

> Naturalize: confirm framework versions, the query-client setup, and the shared API helper path in `CLAUDE.md`. Paths below (`apps/web/lib/...`) are illustrative.

## Contents

- [Optimistic cache patches must be complete](#optimistic-cache-patches-must-be-complete)
- [Derived parent fields: inherit the server's rule](#derived-parent-fields-inherit-the-servers-rule)
- [Error states on data fetch](#error-states-on-data-fetch)
- [Destructive dialogs own their error + pending state](#destructive-dialogs-own-their-error--pending-state)
- [No setState inside useEffect (React 19)](#no-setstate-inside-useeffect-react-19)
- [Radix Select inside a form: guard the empty reset](#radix-select-inside-a-form-guard-the-empty-reset)
- [No JSX comment inside a ternary branch](#no-jsx-comment-inside-a-ternary-branch)
- [Composite interactive a11y](#composite-interactive-a11y)
- [Next.js 16 proxy.ts & Edge-reachable import boundaries](#nextjs-16-proxyts--edge-reachable-import-boundaries)
- [Data fetching goes through the shared API helper](#data-fetching-goes-through-the-shared-api-helper)
- [Common mistakes](#common-mistakes)
- [Review checklist](#review-checklist)

## Optimistic cache patches must be complete

An optimistic React Query patch is a hand-written mirror of the server's write. It is correct only when it touches **every** surface the mutation touches:

1. **Update every projected/derived field.** Mirror the exact server projection rule for fields derived from child rows.
2. **Re-sort when the mutation changes a sort key.** If the patch updates a field the list sorts by, re-sort a copy before returning: `[...nodes].sort(sortFn)`.
3. **Refresh sibling derived caches.** Patch or invalidate count/stats/rollup/badge caches that read the mutated collection (`queryClient.invalidateQueries({ queryKey: queryKeys.nodes.stats(scopeId) })`).
4. **Reconcile placeholders by a stable id.** Generate an `optimisticId` at `onMutate` time and match by `node.id === optimisticId` only — never by `label` or array index.
5. **Return new references — never mutate in place.** Use `[...arr].sort(fn)` and `{ ...obj, field: x }`.

```ts
// Wrong — mutates the cached array in place, no sibling refresh
const node = cache.find((n) => n.id === id);
node.sortOrder = next;
updated.sort(sortDepth1);

// Right — new references, re-sort a copy, refresh siblings
const patched = cache.map((n) => (n.id === id ? { ...n, sortOrder: next } : n));
const sorted = [...patched].sort(sortDepth1);
queryClient.setQueryData(listKey, sorted);
queryClient.invalidateQueries({ queryKey: queryKeys.nodes.stats(scopeId) });
```

**Cache-KEY completeness:** any new query parameter that changes the result set MUST be included in the cache key so distinct filter values never collide on one cached entry.

## Derived parent fields: inherit the server's rule

When a mutation on a child rolls up into a parent summary field, **re-derive the parent field from the full updated state, not from the mutation result alone:**

```ts
// Wrong — ignores an already-decided primary child item
const newStatus = remainingPending.length > 0 ? "PENDING" : result.status;

// Right — inherit the primary item's decided status; fall back to result when none decided yet
const primaryDecidedStatus = parent.primaryItemId
  ? parent.decidedItems?.find((item) => item.id === parent.primaryItemId)?.status
  : undefined;
const newStatus =
  remainingPending.length > 0 ? "PENDING" : (primaryDecidedStatus ?? result.status);
```

Apply identical derived-state logic to **both** the list cache and the detail cache (`STATUS_PRECEDENCE_RANK`).

## Error states on data fetch

Never silently `return null` on a fetch error for primary content — the user gets a blank section with no signal. Handle `isError` with user-visible UI (`null` is acceptable only for decorative secondary tiles):

```tsx
const { data, isError } = useAccountInvoices();

// Primary content card — show an explicit error state and recovery hint:
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

## Destructive dialogs own their error + pending state

A confirm dialog for a destructive action (remove/suspend/delete) must own its own `isPending` and `error` state — not inherit them from the parent, and not route failures to a toast that leaves the modal open with no inline explanation:

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

React 19 / Next.js 16+ eslint rules ratchet `react-hooks/set-state-in-effect` and `react-hooks/cannot-access-refs-during-render` to **error**:

- **Reset-on-close → push into the close callback** (`handleOpenChange(next)`).
- **Derived-from-prop → `useMemo` + controlled fallback** (`const effective = form.value || derivedDefault`).
- **Filter-linked resets on dependency change** → wrap in `startTransition`:
  ```tsx
  import { startTransition, useEffect } from "react";
  useEffect(() => {
    startTransition(() => setShown(PAGE_SIZE));
  }, [period, scopeId]);
  ```
- Reset any `saving`/`pending` flag in **both** the success path and the open-reset callback.

## Radix Select inside a form: guard the empty reset

A controlled Radix `<Select value={x} onValueChange={setter}>` inside a `<form>` with an empty initial value fires a spurious `onValueChange("")` when its hidden `<select>` remounts:

```tsx
<Select
  value={form.unit}
  onValueChange={(v) => {
    if (v) patch({ unit: v }); // guard against Radix's empty remount event
  }}
>
```

## No JSX comment inside a ternary branch

`{/* ... */}` is a JSX expression node. Put comments outside the ternary or wrap the branch in a fragment:

```tsx
// Right — comment outside the ternary, or wrap the branch in a fragment
{kind === "badge" ? (
  <>
    {/* comment */}
    <StatusBadge variant={variant!} />
  </>
) : null}
```

## Composite interactive a11y

- **No nested interactives** (`<a>`/`<button>` inside `<a>`/`<button>`).
- **`stopPropagation` on nested control clicks** and verify with keyboard (`Enter` and `Space`).
- **Gate ARIA relationships on target presence:** `aria-controls={expanded ? regionId : undefined}`.

## Next.js 16 proxy.ts & Edge-reachable import boundaries

As documented in `web-platform-conventions`, Next.js 16 replaced legacy `middleware.ts` with `proxy.ts` (running on the Node.js runtime by default). If any route or helper is configured to run in an Edge or client-shared bundle, never place top-level database or native Node imports at module scope where restricted bundlers evaluate them on load:

```ts
// Right — lazy import inside server-only helper when shared across runtime boundaries
export async function ensureSessionClaimed(id: string) {
  const { getPrisma } = await import("./prisma");
  const prisma = await getPrisma();
  return prisma.session.findUnique({ where: { id } });
}
```

## Data fetching goes through the shared API helper

Use the shared `api` helper (`api.get/post/put/delete`) for all client → gateway calls, never raw `fetch`. The helper provides 401 token refresh, tenant header injection (`X-Tenant-Id`), correlation-id forwarding, and structured error parsing:

```ts
// Wrong — bypasses auth refresh + tenant headers
const res = await fetch("/api/proxy/api/v1/reports/export", {
  method: "POST", credentials: "include", body: JSON.stringify(payload),
});

// Right — the helper prepends the proxy prefix and handles auth/headers/errors
const result = await api.post<ExportReportResult>("/api/v1/reports/export", payload);
```

When adding a query parameter or response field on the client, implement and test it at the **owning backend service** in the same PR.

## Common mistakes

1. Optimistic patch updates the active list but misses a sibling rollup/badge cache.
2. Mutating a cached array/object in place (`arr.sort()`, `obj.x = y`).
3. Adding a filter param to the request without adding it to the TanStack Query `queryKey`.
4. `return null` on `isError` for primary user-facing content.
5. Destructive dialog routes failures to a toast instead of inline error state.
6. `setState` inside `useEffect` instead of close callbacks / `useMemo` / `startTransition`.
7. Unguarded `onValueChange` on a controlled empty-start Radix Select inside a `<form>`.
8. `{/* comment */}` directly inside a JSX ternary branch.
9. Nested interactive elements or dangling `aria-controls` IDs.
10. Raw `fetch` instead of the shared `api` client helper.

## Review checklist

- [ ] Optimistic patch updates derived fields, re-sorts copies, invalidates sibling caches, reconciles by stable ID
- [ ] New query parameter included in `queryKey`
- [ ] `isError` renders a visible error state for primary content
- [ ] Destructive dialog owns `isPending` + inline `error` and resets on close
- [ ] Zero `react-hooks/set-state-in-effect` violations
- [ ] Controlled Radix Select inside `<form>` guards `onValueChange` against `""`
- [ ] No nested interactive elements; `aria-controls` gated on target DOM presence
- [ ] Next.js 16+ uses `proxy.ts` (never legacy `middleware.ts`)
- [ ] All gateway calls use the shared `api` helper with `async/await`
