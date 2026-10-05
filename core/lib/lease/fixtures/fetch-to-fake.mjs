// fetch-to-fake.mjs: test preload (NODE_OPTIONS=--import …) for keepalive-lifetime.test.mjs. In every
// process of the test (startup, the watch bus's `keepalive --detach`, the detached renewer) it:
//   - routes https://api.github.com to FAKE_GITHUB_URL (an HTTP server around fixtures/fake-github.mjs);
//   - divides the renewer's two waits (KEEPALIVE_EVERY_MS 150 s, KEEPALIVE_RETRY_MS 30 s) by
//     BATON_TEST_TIME_SCALE, and nothing else (fetch's own timers keep their real values).
// Test-only: production code reads neither variable.
const target = process.env.FAKE_GITHUB_URL;
if (target) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace(/^https:\/\/api\.github\.com/, target), opts);
}
const scale = Number(process.env.BATON_TEST_TIME_SCALE || 0);
if (scale > 1) {
  const realSetTimeout = globalThis.setTimeout;
  const WAITS = new Set([150_000, 30_000]);
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, WAITS.has(ms) ? Math.ceil(ms / scale) : ms, ...args);
}
