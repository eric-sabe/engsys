---
name: frontend-testing
description: Frontend test discipline — Vitest 4, Testing Library (RTL / React Testing Library), and Playwright E2E for React / Next.js apps. Use when writing or reviewing Vitest specs, vi.mock factories, fake-timer tests, RTL component tests, Radix portal tests, or Playwright E2E specs and their CI matrix wiring.
---

# Frontend Testing (Vitest 4 + Testing Library + Playwright)

Applies to: unit/component specs (`*.spec.{ts,tsx}`) and Playwright E2E (`e2e/**/*.spec.ts`) in the repository's web frontends. Stack assumed: Vitest 4.x, `@testing-library/react`, `testing-library` + `react-hooks` eslint plugins, Radix UI, and Playwright E2E with `@axe-core/playwright`.

> Naturalize: confirm the Vitest version, eslint test config, and Playwright CI workflow in `CLAUDE.md`. Paths below (`apps/web/...`, `.github/workflows/...`) are illustrative.

## Contents

- [Vitest: mock factories (`vi.hoisted`)](#vitest-mock-factories-vihoisted)
- [Vitest 4: pool config and gated suites](#vitest-4-pool-config-and-gated-suites)
- [Fake timers: the act() pattern](#fake-timers-the-act-pattern)
- [RTL: accessible queries, not container traversal](#rtl-accessible-queries-not-container-traversal)
- [RTL: double render and Radix portals](#rtl-double-render-and-radix-portals)
- [RTL: useLayoutEffect for test-observable accumulation](#rtl-uselayouteffect-for-test-observable-accumulation)
- [Playwright: register every spec in the CI matrix](#playwright-register-every-spec-in-the-ci-matrix)
- [Playwright: migrate the local DB before E2E](#playwright-migrate-the-local-db-before-e2e)
- [Playwright: assert containers for unbooted upstream services](#playwright-assert-containers-for-unbooted-upstream-services)
- [Playwright: spec-authoring footguns](#playwright-spec-authoring-footguns)
- [Playwright: strict mode and table rows](#playwright-strict-mode-and-table-rows)
- [Playwright: whole-document axe finds real a11y](#playwright-whole-document-axe-finds-real-a11y)
- [Playwright: copy / flow changes break E2E](#playwright-copy--flow-changes-break-e2e)
- [Review checklist](#review-checklist)

## Vitest: mock factories (`vi.hoisted`)

**`vi.mock` factories are hoisted above `const`/`let`.** Wrap any spy referenced inside a `vi.mock` factory in `vi.hoisted()`:

```ts
// Wrong — ReferenceError at runtime because vi.mock is hoisted above const
const mockCreateJob = vi.fn();
vi.mock("@/lib/api-client", () => ({ reportsExportApi: { createJob: mockCreateJob } }));

// Right — vi.hoisted runs before the factory
const { mockCreateJob } = vi.hoisted(() => ({ mockCreateJob: vi.fn() }));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, reportsExportApi: { createJob: mockCreateJob } };
});
```

**When adding an export to a mocked module, update every `vi.mock` factory of that module in the same commit.** Prefer `importOriginal` + `...actual` so existing exports survive automatically:

```bash
grep -rl 'vi.mock("@/lib/permissions"' --include='*.spec.*' apps/web
```

## Vitest 4: pool config and gated suites

`poolOptions.forks.singleFork` was removed in Vitest 4 — use top-level `fileParallelism: false` when specs must run sequentially:

```ts
export default defineConfig({
  test: { pool: "forks", fileParallelism: false },
});
```

**Separate configs for gated suites:** When a suite requires external infrastructure (live DB, LLM API keys, Docker stack), isolate it in `vitest.e2e.config.ts` and guard the spec (`if (!process.env.EXTERNAL_E2E) return`) so default `pnpm test` stays fast and hermetic.

## Fake timers: the act() pattern

Import `act` from **`react`** (not `@testing-library/react`) and wrap **only** `vi.advanceTimersByTime(ms)` — never wrap `render`/`rerender` inside `act`:

```ts
import { act } from "react";
import { renderHook } from "@testing-library/react";

function advanceTimers(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}
```

## RTL: accessible queries, not container traversal

Use `screen.getByRole`, `screen.queryByRole`, `screen.getByLabelText`, or `screen.getByTestId` — never `container.querySelector(...)` (except when asserting that an XSS payload injected zero `<script>` tags, with an explicit per-line eslint-disable rationale comment).

## RTL: double render and Radix portals

- **Never call `render()` twice in the same `it()` block** without calling `cleanup()` in between.
- **Radix portal items (`Select`, `DropdownMenu`, `Popover`, `Dialog`) do not open via pointer events in JSDOM.** In unit tests, assert the hook/props invariant directly and test the interactive portal flow in Playwright E2E:

```ts
it("client-side sort parameter is not sent to useItemsQuery", () => {
  renderTable({ sort: "recent" });
  for (const call of mockUseItemsQuery.mock.calls) {
    expect(call[0]).not.toHaveProperty("sort");
  }
});
```

## RTL: useLayoutEffect for test-observable accumulation

When a component accumulates pages across fetches ("Show more"), use `React.useLayoutEffect` + `React.useReducer` (with a `prevIdRef` guard for filter resets) so accumulated rows flush synchronously inside RTL's `render()` without flaky `waitFor` loops.

## Playwright: register every spec in the CI matrix

A new `e2e/*.spec.ts` file that isn't picked up by CI is test theater. Whenever adding an E2E spec, verify or update the CI workflow matrix in the same commit:

```bash
ls apps/web/e2e/*.spec.ts | xargs -n1 basename
grep -ni "playwright" .github/workflows/web-ci.yml
```

## Playwright: migrate the local DB before E2E

Apply pending local migrations before running Playwright locally so `beforeAll` seeds never abort on missing schema columns:

```bash
pnpm db:migrate:local
set -a && source apps/web/.env.local && set +a
cd apps/web && pnpm playwright test e2e/<spec>.spec.ts --project=chromium
```

## Playwright: assert containers for unbooted upstream services

When the CI E2E environment boots only the core web + API stack without optional upstream workers, assert the immediate container/skeleton state or provide a complete `page.route()` contract fixture:

```ts
await expect(page.getByTestId("items-grid")).toBeVisible();
```

## Playwright: spec-authoring footguns

- **No self-nested locators:** After `const panel = page.getByTestId("settings-panel")`, query child elements inside `panel`, not `panel.getByTestId("settings-panel")`.
- **Use `waitUntil: "domcontentloaded"`** instead of `networkidle` on pages with background polling.
- **Put expensive read-only seed setup in `beforeAll`**, not `beforeEach`.
- **Hydrate before clicking SSR controls** and assert navigation with `await expect(page).toHaveURL(/pattern/)`.
- **Anchor negative assertions** (`/^confirm action$/i`) after verifying the parent surface has mounted.

## Playwright: strict mode and table rows

Target table rows via `page.getByRole("row", { name: /Acme Corp/i })` instead of `page.getByText("Acme Corp")` (which matches `<tr>`, `<td>`, and `<p>` simultaneously in strict mode). For Radix tooltips (which duplicate a hidden accessibility node), qualify with `.first()` or exact role/name.

## Playwright: whole-document axe finds real a11y

Run `@axe-core/playwright` (`wcag2a`, `wcag2aa`) against rendered pages in Playwright to catch real CSS token contrast failures, focus-trap bugs, and broken ARIA IDs that JSDOM unit tests cannot observe. Fix violations in design tokens or component markup — never weaken contrast with `opacity-*` classes.

## Playwright: copy / flow changes break E2E

Whenever a PR modifies user-visible headings, button labels, or multi-step flows (such as adding a confirmation modal), grep all `e2e/` directories and update affected Playwright specs in the **same PR**.

## Review checklist

- [ ] Spies inside `vi.mock` factories use `vi.hoisted()` and `importOriginal`
- [ ] Vitest 4 uses `fileParallelism: false` (never removed `singleFork`)
- [ ] Fake-timer tests wrap only `vi.advanceTimersByTime` in `act` from `react`
- [ ] RTL specs use `screen.*` accessible queries and avoid double `render()` calls
- [ ] New Playwright E2E specs are registered in the CI workflow in the same commit
- [ ] Table-row actions use `getByRole("row")`; whole-document axe scan passes
- [ ] UI copy or flow changes update matching `e2e/` specs in the same PR
