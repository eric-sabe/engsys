# An E2E smoke can pass vacuously against the auth-redirect page

**Trigger:** A page-level E2E spec for an unauthenticated route asserts only generic landmarks (any heading, non-empty body, status below 500), or a route has been added or renamed behind a default-deny auth proxy.

**Failure mode:** The route later gets caught by an auth gate (a default-deny public-paths list where every new public route must be registered). The spec follows the redirect to the login page, which satisfies the generic assertions, so it stays green for months while the surface it claims to cover is unreachable. Nobody notices until someone needs a specific string on the real page. A related trap in the same family: a framework's permanent route-announcer element has `role="alert"`, so a bare alert query always matches it.

**Correct behavior:**
- Assert at least one string or test id unique to the surface under test, something the login page (the universal redirect target) can never satisfy. Generic role and non-empty checks prove nothing.
- Also assert the final URL, or that no redirect happened.
- When adding a pre-auth page, register it in the proxy's public-paths list; a component having its own logged-out state does not make it reachable.
- Scope alert and status queries with a test id.

**Check:** If this route silently redirected to login tomorrow, would the spec fail?

**Seen in:** recurring in web apps with default-deny auth middleware.
