---
name: web-platform-conventions
description: Web platform conventions for this repo — Content-Security-Policy discipline and (for Next.js 16+) the proxy.ts-not-middleware convention. Use when editing CSP headers, adding a third-party SDK / analytics / external API origin, touching request-edge code (middleware/proxy), or wiring auth/redirects/headers on a web frontend.
---

# Web Platform Conventions

Applies to: the web frontend(s) in this repo. Mostly framework-agnostic; the proxy.ts section is Next.js-specific.

> Naturalize: confirm the framework/version and where the CSP is built in `CLAUDE.md`. The defaults below assume a same-origin BFF/proxy architecture.

## Content-Security-Policy is a security-critical surface

Treat the CSP as code that gates every network origin the page may reach. **Any new XHR/fetch origin, script host, or asset host must be added explicitly.** Never relax a directive to a wildcard to "make it work."

### `connect-src` policy

- **Production: `'self'` only** — no `https:` wildcard, no `data:` / `blob:` / `javascript:`. Browser-initiated API calls should go through a same-origin BFF/proxy (e.g. `/api/proxy/*`), so `'self'` covers them.
- Auth flows that navigate the browser to another origin (OAuth login/callback) use `window.location` navigations, which are governed by `form-action` / navigation directives, **not** `connect-src`.
- Development may add `ws:` / `wss:` for the dev server's hot-reload.

### Before adding a new third-party SDK / analytics / external API

1. Add the **explicit origin** to `connect-src` (e.g. `https://browser.sentry-cdn.com`). Do NOT relax to `https:`.
2. If the SDK loads a script, also add the script host to `script-src`.
3. Add a test asserting both that the new origin is present **and** that the old strictness is preserved (no wildcard regression).
4. Smoke-test in dev — open DevTools console and look for CSP violation reports on the affected path.

### Sensible directive defaults

| Directive         | Sources                                              | Notes                                                  |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `default-src`     | `'self'`                                             | Fallback for everything not listed.                    |
| `connect-src`     | `'self'` (+ `ws:` `wss:` in dev)                    | All XHRs same-origin via BFF.                          |
| `script-src`      | `'self'`, per-request nonce, `'strict-dynamic'`     | Add explicit CDN hosts; avoid `'unsafe-inline'` in prod. |
| `style-src`       | `'self'`, `'unsafe-inline'` (if the CSS framework requires it) | Tailwind/Next often need inline styles. |
| `img-src`         | `'self'`, `data:`, your asset/storage host          |                                                        |
| `frame-ancestors` | `'none'`                                             | Plus `X-Frame-Options: DENY` belt-and-suspenders.      |
| `object-src`      | `'none'`                                             | No Flash, no PDF embed.                                 |
| `base-uri`        | `'self'`                                             | Blocks `<base>` injection.                              |
| `form-action`     | `'self'`                                             | All forms post same-origin.                            |

Prefer a per-request nonce + `'strict-dynamic'` over host allowlists for scripts where the framework supports it.

## Next.js 16+: `proxy.ts`, not `middleware.ts`

Next.js 16 **replaced `middleware.ts` with `proxy.ts`**. Having both present is a build error ("use ./proxy.ts only").

**Rule:** on Next.js 16+, there is no `middleware.ts` anywhere in the service. Auth, redirects, headers, request rewriting, and the CSP header all go through `proxy.ts`.

Background: <https://nextjs.org/docs/messages/middleware-to-proxy>.

## Logging

Use the project logger, not `console.*`, on web frontends — so logs are structured, domain-scoped, and routable. Check `CLAUDE.md` for the logger import and the domain/level conventions.
