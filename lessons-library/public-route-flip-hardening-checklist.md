# Making a route public is a threat-model change: run the anonymous-surface checklist

**Trigger:** A change makes a previously auth-gated route reachable without login (adding to a public-paths list, marking a handler public, adding an unauthenticated backend-for-frontend route).

**Failure mode:** The exposure itself may be sound, but the route's *robustness class* silently changes. A server-rendered page whose upstream fetch has no timeout and no catch is fine behind auth; anonymous, it is a slow-connection lever and a 500 on any network blip. All anonymous server-side fetches from one container often share a single rate-limit bucket, so junk-URL floods can starve legitimate users cross-tenant. Nothing in a normal implementation flow surfaces this; it is found by a dedicated review, if at all.

**Correct behavior:** Run this as part of the change, not as a hoped-for review catch:
1. **Enumerate the delta.** Exactly which routes and data become reachable. A path prefix is a directory grant: any future route under it is public too, so leave a tripwire comment on the constant.
2. **Upstream fetch discipline.** Timeout plus try/catch that renders the existing failure UI; anonymous requests must never pin a worker or 500 on network failure.
3. **Response caching.** Make an explicit `Cache-Control` decision (`no-store` for anything flag-dependent or per-request); framework "dynamic" flags do not govern what a CDN does.
4. **Rate-limit attribution.** Decide whether the upstream needs its own budget or client-IP forwarding.
5. **Enumeration and leak review.** What does the response disclose to an unauthenticated capability holder; are error messages less informative than the page?
6. **Adversarial eyes.** A targeted security pass on the flip is cheap.

**Check:** Does this anonymous route have a timeout, a failure UI, a cache header, and its own rate-limit story?

**Seen in:** recurring when invite, share-link, and landing pages are opened up.
