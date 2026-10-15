<!-- pack: platform/web -->
## Platform — Web (React 19 / Next.js 16+)

This project ships a web application on React 19 / Next.js 16+:
- **Isabelle**, **Leith**, and **Sandy** load **`web-platform-conventions`** for Next.js 16+ `proxy.ts` (replacing legacy `middleware.ts`), Content Security Policy (CSP), SSR/hydration safety, and Core Web Vitals (`LCP`, `INP`, `CLS`).
- **Isabelle** and **Leith** load **`react-conventions`** for React 19 hooks (`set-state-in-effect` avoidance), TanStack Query optimistic cache completeness, accessible Radix UI primitives, and shared API client discipline.
- **Marcelo** and **Isabelle** load **`frontend-testing`** for Vitest 4 (`vi.hoisted`, `fileParallelism`), React Testing Library accessible queries, and Playwright E2E + whole-document axe accessibility gates.
- **Gary**, **Leith**, and **Sandy** pair these with core `web-design-reviewer` and `chrome-devtools` during `/design-critique` and `/design-audit`.

<!-- naturalize: record web app directory, dev server port, shared API helper path, and Playwright E2E workflow in Project facts. -->
