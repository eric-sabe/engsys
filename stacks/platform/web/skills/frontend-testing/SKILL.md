---
name: frontend-testing
description: Frontend test discipline for this repo — Vitest 4, Testing Library (RTL / React Testing Library), and Playwright E2E for React / Next.js apps. Use when writing or reviewing Vitest specs, vi.mock factories, fake-timer tests, RTL component tests, Radix portal tests, or Playwright E2E specs and their CI matrix wiring. Covers vi.hoisted mock-factory hoisting, keeping every vi.mock factory in sync, Vitest 4 pool config (fileParallelism), the fake-timers act() pattern, RTL accessible-query discipline, Radix-portal JSDOM limits, useLayoutEffect for test-observable accumulation, and Playwright spec-authoring footguns / CI-matrix registration / axe E2E.
---

# Frontend Testing (Vitest + Testing Library + Playwright)

Applies to: unit/component specs (`*.spec.{ts,tsx}`) and Playwright E2E (`e2e/**/*.spec.ts`) in the repo's web frontends. Stack assumed: Vitest 4.x, `@testing-library/react`, the `testing-library` + `react-hooks` eslint plugins, Radix UI, Playwright in a CI matrix against booted services.

> Naturalize: confirm the Vitest version, the eslint test config, and the Playwright CI job/matrix in `CLAUDE.md`. Paths below (`services/dashboard/...`, `.github/workflows/...`) are illustrative.

This skill is the React/Vitest/Playwright-specific **mechanism**. The cross-project **principles** behind it — "a change isn't done until every surface is updated", "register checks or they're silent gaps", "shift correctness left and distrust false greens" — live in the engsys `lessons-library/`. Here we carry the concrete test-tooling shape.

## Contents

- [Vitest: mock factories](#vitest-mock-factories)
- [Vitest 4: pool config and gated suites](#vitest-4-pool-config-and-gated-suites)
- [Fake timers: the act() pattern](#fake-timers-the-act-pattern)
- [RTL: accessible queries, not container traversal](#rtl-accessible-queries-not-container-traversal)
- [RTL: double render and Radix portals](#rtl-double-render-and-radix-portals)
- [RTL: useLayoutEffect for test-observable accumulation](#rtl-uselayouteffect-for-test-observable-accumulation)
- [Playwright: register every spec in the CI matrix](#playwright-register-every-spec-in-the-ci-matrix)
- [Playwright: migrate the local DB before E2E](#playwright-migrate-the-local-db-before-e2e)
- [Playwright: assert containers for services not booted in CI](#playwright-assert-containers-for-services-not-booted-in-ci)
- [Playwright: spec-authoring footguns](#playwright-spec-authoring-footguns)
- [Playwright: strict mode and table rows](#playwright-strict-mode-and-table-rows)
- [Playwright: whole-document axe finds real a11y](#playwright-whole-document-axe-finds-real-a11y)
- [Playwright: copy / flow changes break E2E](#playwright-copy--flow-changes-break-e2e)
- [Review checklist](#review-checklist)

## Vitest: mock factories

**`vi.mock` factories are hoisted above `const`/`let`.** A spy declared with `const mockFn = vi.fn()` *before* a `vi.mock` factory that references it throws `Cannot access 'mockFn' before initialization` at runtime — the factory is hoisted above the declaration. Linters don't catch it. Wrap such spies in `vi.hoisted()`:

```ts
// Wrong — ReferenceError at runtime
const mockCreateJob = vi.fn();
vi.mock("@/lib/api-client", () => ({ signalsExportApi: { createJob: mockCreateJob } }));

// Right — vi.hoisted runs before the factory
const { mockCreateJob } = vi.hoisted(() => ({ mockCreateJob: vi.fn() }));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, signalsExportApi: { createJob: mockCreateJob } };
});
```

**When you add an export to a mocked module, update EVERY `vi.mock` factory of it — in the same commit.** A factory replaces the whole module; a missing new export is `undefined` (or throws `No "X" export is defined on the mock`), and *pre-existing* specs go red in code you only added an export to. Use `importOriginal` and spread `...actual` so real exports survive and you only override what you need.

```ts
vi.mock("@app/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/database")>();
  return { ...actual, prisma: prismaMock }; // keep the rest real
});
```

Grep for mock factories of a path **before** running the suite, not after it fails:

```bash
grep -rl 'vi.mock("@/lib/access"' --include='*.spec.*' services/dashboard
```

When a new export reads a model the prisma mock doesn't define, add that model returning the "no override" row (`findUnique: vi.fn().mockResolvedValue(null)`) so pre-change behavior holds. Run **every** consuming service's full suite after a cross-cutting shared-package change — the break is in the OLD specs.

## Vitest 4: pool config and gated suites

`poolOptions.forks.singleFork` was **removed in Vitest 4** — it's replaced by the top-level `fileParallelism`. CodeRabbit may cite v2/v3 doc URLs that still list `singleFork`; trust the installed package's types, not the doc URL.

```ts
// Vitest 4 — correct: all files run sequentially in one pool process
export default defineConfig({
  test: { pool: "forks", fileParallelism: false },
});
```

Use `fileParallelism: false` for E2E specs that depend on ordered external-service state and for suites that manage their own concurrency. Verify the option exists in your install:

```bash
grep -n "singleFork\|fileParallelism" node_modules/vitest/dist/chunks/*.d.ts
```

**Separate configs for gated suites.** When a suite needs external infra (live DB, LLM key, docker stack), give it its own config so plain `pnpm test` never triggers it: `vitest.config.ts` (unit), `vitest.e2e.config.ts`, `vitest.ai-regression.config.ts`, with matching `test:e2e` / `test:ai-regression` scripts. Put the env gate (`if (!process.env.INGESTION_E2E) return`) in the spec so `pnpm test` skips the whole file rather than silently passing.

## Fake timers: the act() pattern

Advancing fake timers fires `setTimeout` callbacks synchronously, which call `setState` inside the hook. Without `act`, React queues but doesn't flush the update and the assertion sees stale state. But `testing-library/no-unnecessary-act` (error) flags any `act()` wrapping an RTL utility.

Resolution: import `act` from **`react`** (not `@testing-library/react`) and wrap **only** the `vi.advanceTimersByTime()` call — never an RTL utility in the same `act` scope.

```ts
import { act } from "react";                  // NOT @testing-library/react
import { renderHook } from "@testing-library/react";

function advanceTimers(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); }); // act wraps only the timer advance
}

it("debounce fires after quiet period", () => {
  const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
    initialProps: { v: "" },
  });
  rerender({ v: "a" });
  advanceTimers(250);
  expect(result.current).toBe("a");
});
```

Don't: `act(() => { rerender(...); vi.advanceTimersByTime(50); })` (lint error — rerender inside act), and don't advance timers without `act` (state not flushed).

## RTL: accessible queries, not container traversal

The `testing-library` eslint plugin (`no-container`, `no-node-access`, error) forbids `container.querySelector(...)` / `element.querySelectorAll(...)`. Use `screen.*` accessible queries:

```tsx
expect(screen.queryByTestId("my-element")).toBeNull();          // not container.querySelector
expect(screen.getAllByTestId("row").length).toBeGreaterThan(0);  // not querySelectorAll
expect(screen.queryAllByRole("button")).toHaveLength(0);         // not querySelectorAll("button,...")
```

Only exception: **security assertions** with no accessible query (checking no `<script>`/`iframe[srcdoc]` was injected by an XSS payload) — use `// eslint-disable-next-line testing-library/no-container, testing-library/no-node-access` with a rationale comment. (`container.innerHTML` is property access, not traversal, and is allowed.)

## RTL: double render and Radix portals

**Two `render()` calls in one `it()` accumulate DOM** — RTL appends, both renders coexist, and `getByTestId` throws "Found multiple elements". RTL runs `cleanup()` after each test (`afterEach`), not between renders within one. Split into separate `it()` blocks, or call `cleanup()` between renders.

**Radix portal items are unreachable in JSDOM.** `DropdownMenu`/`Select`/`Popover`/`Tooltip`/`Dialog` content renders in a portal via pointer/popover APIs JSDOM doesn't implement — clicking the trigger never opens the content, so `getByTestId("the-item")` throws. Don't simulate the interaction; **test the invariant**:

```ts
// Wrong — portal item never mounts in JSDOM
fireEvent.click(screen.getByTestId("sort-dropdown"));
fireEvent.click(screen.getByTestId("sort-option-movers")); // throws

// Right — assert the invariant (sort is client-side, never a query param)
it("sort param is never passed to useThemeGrid", () => {
  renderTable({ sort: "volume" });
  for (const call of mockUseThemeGrid.mock.calls) {
    expect(call[0]).not.toHaveProperty("sort");
  }
});
```

For "correct option selected", check the trigger's visible label / `aria-label`. The codebase pattern for unit-testing Radix Select is to mock the whole Select component. The real interaction is the job of Playwright E2E (real browser).

## RTL: useLayoutEffect for test-observable accumulation

When a component accumulates data across fetches (e.g. "Show more" appends rows), `useEffect` fires **asynchronously** and is not flushed by the `act()` that wraps `render()` — so `accumulated` stays empty and queries time out even though the mock data was synchronous. Use **`useLayoutEffect`** (fires synchronously inside RTL's `act`) with **`useReducer`** for correct multi-action sequencing:

```tsx
const [accumulated, dispatchAcc] = React.useReducer(accReducer, []);
React.useLayoutEffect(() => {
  if (data?.data) dispatchAcc({ type: "merge", items: data.data });
}, [data?.data]);

// Guard reset against the spurious initial-mount fire (ordering wipes page 1 otherwise):
const prevIdRef = React.useRef(metricId);
React.useLayoutEffect(() => {
  if (prevIdRef.current !== metricId) { prevIdRef.current = metricId; dispatchAcc({ type: "reset" }); }
}, [metricId]);
```

The ref-during-render alternative is `react-hooks/refs`-illegal; `useLayoutEffect + useReducer` is the lint-clean answer. Use it whenever an accumulating, RTL-tested component needs its accumulated state visible in assertions without `waitFor`.

## Playwright: register every spec in the CI matrix

A new Playwright spec that isn't in the CI matrix is theater — it passes locally forever and **never runs in CI**, a silent gap indistinguishable from coverage. Writing the spec **includes registering it in the matrix, in the same commit / AC**. Treat the matrix entry like an import: the spec doesn't exist until something runs it. Reviewers: any PR adding `e2e/*.spec.ts` must show a matching workflow/matrix diff (or a verified glob that picks it up).

```bash
ls services/dashboard/e2e/*.spec.ts | xargs -n1 basename
grep -ni "playwright" .github/workflows/services-ci.yml
```

## Playwright: migrate the local DB before E2E

After a migration-bearing phase merges, local Postgres lacks the new migrations — the next phase's E2E `beforeAll` seed throws Prisma `P2022` and the whole spec aborts (zero tests run), which looks like a flake but is an environment gap. Apply migrations locally first, and source env (`JWT_SECRET` etc.) before any local Playwright run:

```bash
pnpm db:migrate:local                                  # prod-safe, localhost-hardcoded
set -a && source services/dashboard/.env.local && set +a
cd services/dashboard && pnpm playwright test e2e/<spec>.spec.ts --project=chromium
```

A `PUSH_OVERRIDE`'d E2E is **not** verified — confirm the specific changed specs go green in CI (`gh pr checks <n> --watch`), not just the unit gate. An unverified E2E once hid a real Radix-Select feature bug because it was the only test exercising the flow.

## Playwright: assert containers for services not booted in CI

The CI Playwright stack boots only some services (e.g. api-gateway + dashboard, not Insights). For pages whose data is fetched client-side from a **not-booted** service, you can only assert the **container / loading state** that renders immediately on mount — **not** its data-dependent children, which spin forever.

```ts
await expect(page.getByTestId("all-themes-grid")).toBeVisible();  // container — renders immediately
// NOT: await expect(page.getByTestId("theme-card")).toBeVisible(); // data from Insights — never loads in CI
```

Before asserting data content: trace the hook → API call → proxy controller; if the route proxies to a not-booted service, assert container only and document why. When the UX *depends* on that service's data (a strip that renders from an embedded projection field), the spec's `page.route()` interception must supply that service's **full data contract** for the branch under test — not just the fields you happen to need locally — or CI stubs an incomplete fixture and the UX silently doesn't render. "Passes locally" is never the gate.

## Playwright: spec-authoring footguns

- **No self-nested locators.** After `const panel = page.getByTestId("widget-config-panel")`, a `panel.getByTestId("widget-config-panel")` searches *inside* panel and finds nothing. Query a **child** testid/role instead.
- **`domcontentloaded`, not `networkidle`, for routes with background retries.** Any route whose layout fires hooks to services that are down in CI never reaches `networkidle` (requests retry forever) and times out. Use `waitUntil: "domcontentloaded"`. Reserve `networkidle` for fully self-contained pages.
- **One-time setup in `beforeAll`, not `beforeEach`.** A ~60s `seedScenario()` in `beforeEach` blows the per-test budget. Use `beforeAll` for read-only suites; `beforeEach` only when each test needs fresh state. Sanity: `setupCost × testCount` under ~80s.
- **Hydrate before clicking.** A click on an SSR-rendered tab/control before React hydrates is a silent no-op (`toBeVisible`/`networkidle` don't prove hydration). Interact with a controlled input first (`fill`/`selectOption` auto-wait for actionability and double as a hydration gate), then click. Use `await expect(page).toHaveURL(/pattern/)` (auto-retries) — not synchronous `page.url()`, which reads before navigation commits.
- **`forceMount` panels that own cross-tab effects/state.** A custom `TabsContent` that `return null`s inactive panels unmounts effects/state a panel must keep while another tab is active — a product bug, not just a test issue. Keep it mounted via `hidden={!isSelected}`.
- **Stub the LANDING panel's on-mount fetches**, not only the panel under test — an unmocked background fetch on the initially-active panel can stall a later tab switch.
- **Exact matchers in negative assertions.** Broad regexes in absence checks match unintended controls (false failures) or miss renamed ones (silent false passes). Anchor: `/^confirm kpi$/i` or testids. Establish the page surface first so "absent" can't mean "never rendered".

## Playwright: strict mode and table rows

`page.getByText("Acme Corp").click()` violates strict mode — `getByText` matches every element whose subtree contains the text (`<tr>`, `<td>`, `<div>`, `<p>`). With `workers: 1` it's a hard error, not a flake. Target the row by role or testid:

```ts
await page.getByRole("row", { name: /Acme Corp/i }).click(); // exactly one row
```

Related: Radix tooltips render **two** `role="tooltip"` nodes — bare `getByRole("tooltip")` violates strict mode; use `.first()` or an exact name.

## Playwright: whole-document axe finds real a11y

Component-level `jest-axe` (mounted in isolation, JSDOM) **structurally cannot** see real CSS-token contrast as rendered, focus order, dialog trapping, opacity-dimmed text, or Radix's portal/aria id plumbing. A **whole-document** axe E2E (wcag2a+2aa) against the running app catches real shipped violations component-axe misses — `Badge variant="success"` white-on-green at 2.3:1, `text-muted-foreground/60` opacity-dimmed text, a custom `id` on a Radix `Dialog.Title` that overrides Radix's `aria-labelledby` wiring, `<label>` with no `htmlFor`/`id` pairing.

Treat a whole-document axe failure as a **real product bug** to fix at the source (design token / markup), not a reason to weaken the audit. Read the axe `fgColor`/`bgColor`/`message` and fix the **exact** element in the **state the seed renders** (it often flags a placeholder, not the snippet). Run the whole-page scan against the rebuilt bundle when introducing composite ARIA (treegrid/tablist/menu). When scoping a gate to a feature's subtree, exclude specific rule ids and file a tracking issue — don't drop whole rule categories. Never use `opacity-*` to soften text that must meet AA.

## Playwright: copy / flow changes break E2E

`pnpm test` runs **Vitest only** — E2E is a separate runner against the full stack. A green unit suite can sit alongside an E2E `getByRole('heading', { name: /old copy/i })` that times out. When a change touches headings/CTA labels/option names **or the interaction FLOW** (a new gating step, confirm dialog, required control, re-routed commit), grep the specs and update locators in the **same PR**:

```bash
grep -rnE "Welcome to <App>|Get started|<old label>" <app>/e2e/
```

Use substring regexes that dodge punctuation (`/set up your first workspace/i`). A renamed label is an API change to the test suite. Note derived strings reuse labels (a `${col.label} ${verb}` aria-label breaks too — grep every occurrence, not just the header). And remember separate Playwright surfaces run in their own CI job that the default precheck may NOT cover — grep them too.

## Review checklist

- [ ] Spies referenced in a `vi.mock` factory are wrapped in `vi.hoisted()`
- [ ] Every `vi.mock` factory of a module updated when an export is added (same commit; `importOriginal` + spread)
- [ ] Vitest 4 uses `fileParallelism: false` (not `poolOptions.forks.singleFork`); gated suites have their own config + spec-level env gate
- [ ] Fake-timer tests wrap only `vi.advanceTimersByTime` in `act` from `react`
- [ ] RTL uses `screen.*` queries; no `container.querySelector` (except justified security checks)
- [ ] No double `render()` per test; Radix portal tests assert the invariant, not the interaction
- [ ] Accumulate-across-fetches uses `useLayoutEffect` + `useReducer` to be test-observable
- [ ] Every new Playwright spec registered in the CI matrix in the same commit
- [ ] Local DB migrated + env sourced before local E2E; CI legs confirmed green (not just unit)
- [ ] Data assertions only for services booted in CI; container/loading otherwise; interceptions supply the full contract
- [ ] No self-nested locators; `domcontentloaded` for background-retry routes; `beforeAll` for read-only setup; hydrate before clicking; `forceMount` cross-tab panels
- [ ] Table-row clicks use `getByRole('row')`/testid, not `getByText`
- [ ] Whole-document axe run for new/changed UI; violations fixed at source
- [ ] Copy/flow changes: specs grepped and locators updated in the same PR (all Playwright surfaces)
