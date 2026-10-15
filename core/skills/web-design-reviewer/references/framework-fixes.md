# Framework-Specific UI & Styling Fix Patterns

> Reference for [`SKILL.md`](../SKILL.md) Step 3.3 (`Applying Fixes`).

## 1. Tailwind CSS v4 (React / Next.js / Vue / Svelte)

- **Responsive overflow**: Replace fixed widths (`w-[600px]`) with fluid max-widths (`w-full max-w-xl`) and `min-w-0` on flex/grid children so long text truncates or wraps instead of overflowing the viewport.
- **Flex/Grid truncation**: Add `min-w-0` on the flex/grid item container before applying `truncate` (`overflow-hidden text-ellipsis whitespace-nowrap`) on the child text node.
- **Focus states**: Always pair interactive controls with `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2`.
- **Touch targets**: Ensure mobile interactive targets meet a minimum `44x44px` hit area (`min-h-11 min-w-11` or equivalent padding).

## 2. CSS Modules & Vanilla CSS / SCSS

- **Scoped fixes**: Modify the component's `.module.css` class rather than global element selectors (`button`, `div`) to prevent cross-page regressions.
- **Container queries & fluid spacing**: Prefer `clamp()` and `minmax(0, 1fr)` in CSS Grid definitions so narrow viewports (`375px`) never trigger horizontal scrollbars.
- **Z-index stacking**: Use semantic stacking tokens or `isolation: isolate` on component roots rather than arbitrary high `z-index` values.

## 3. Next.js App Router & React 19

- **Layout shift (CLS)**: Always provide explicit `width`/`height` or `fill` + sized parent container on `<Image />` components, and reserve space for async Suspense boundaries with matching skeleton heights.
- **Hydration-safe responsive rendering**: Prefer CSS media queries (`hidden md:flex`) over `window.innerWidth` checks during initial render to avoid hydration mismatches and layout flash.
