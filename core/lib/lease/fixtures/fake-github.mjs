// fake-github.mjs — an in-process fake of GitHub's git data API for the lease tests (github-backend,
// baton). It implements the two guarantees the github backend rests on (POST refs 422 if the ref
// exists; PATCH force:false 422 unless the current tip is an ancestor of the new commit), with a
// controllable server clock (`Date` header), fault injection and seeded interleaving.

import { createHash } from "node:crypto";

export const REPO = "acme/app";
export const T0 = Date.parse("2026-10-04T12:00:00Z");

/** Deterministic PRNG (mulberry32) so an interleaving that fails can be replayed by seed. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-memory GitHub git data API for one repo.
 *   state.now           server clock (ms); every response carries it as the Date header
 *   state.refs          Map<ref, sha>
 *   state.commits       Map<sha, {message, parents, tree}>
 *   fault(matcher)      inject a failure: { when(method, path), status | throw, times, afterApply }
 *   state.log           every request, in order
 * Interleaving: with `interleave` set, each request yields a random number of macrotask ticks
 * before AND after touching state, so two concurrent callers interleave their reads and writes.
 */
export function fakeGitApi({ now = T0, interleave = null, repo = REPO, clockAdvanceMs = 0, lagMs = 0 } = {}) {
  // refs: current tip per ref. history: every (sha, writtenAt) per ref, so a lagging replica can
  // serve the newest version that is at least `lagMs` old (`lagMs` applies to GETs of a ref only).
  const state = { now, refs: new Map(), commits: new Map(), history: new Map(), log: [], faults: [], clockAdvanceMs, lagMs };
  const rand = interleave ? prng(interleave) : null;
  const tick = async () => {
    if (!rand) return;
    const n = Math.floor(rand() * 3);
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const headers = () => ({ date: new Date(state.now).toUTCString(), "x-fake": "1" });
  const reply = (status, json) => ({ status, json, headers: headers() });
  const base = `/repos/${repo}/git`;

  function setRef(ref, sha) {
    state.refs.set(ref, sha);
    if (!state.history.has(ref)) state.history.set(ref, []);
    state.history.get(ref).push({ sha, at: state.now });
  }
  state.setRef = setRef;
  /** What a (possibly lagging) read of `ref` returns: the newest version written >= lagMs ago, else the oldest. */
  function visibleTip(ref) {
    if (!state.refs.has(ref)) return undefined;
    if (!state.lagMs) return state.refs.get(ref);
    const hist = state.history.get(ref) ?? [];
    const old = hist.filter((h) => state.now - h.at >= state.lagMs);
    return (old.length ? old[old.length - 1] : hist[0]).sha;
  }

  function isAncestor(ancestor, sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = state.commits.get(cur);
      if (c) stack.push(...c.parents);
    }
    return false;
  }

  function apply(method, path, body) {
    let m;
    if (method === "GET" && (m = new RegExp(`^${base}/ref/(.+)$`).exec(path))) {
      const ref = `refs/${m[1]}`;
      const sha = visibleTip(ref);
      if (sha === undefined) return reply(404, { message: "Not Found" });
      return reply(200, { ref, object: { sha, type: "commit" } });
    }
    if (method === "GET" && (m = new RegExp(`^${base}/matching-refs/(.+)$`).exec(path))) {
      const prefix = `refs/${m[1]}`;
      const out = [...state.refs.entries()].filter(([r]) => r.startsWith(prefix)).map(([ref, sha]) => ({ ref, object: { sha, type: "commit" } }));
      return reply(200, out);
    }
    if (method === "GET" && (m = new RegExp(`^${base}/commits/([0-9a-f]{40})$`).exec(path))) {
      const c = state.commits.get(m[1]);
      if (!c) return reply(422, { message: "No commit found for SHA" });
      return reply(200, { sha: m[1], message: c.message, parents: c.parents.map((sha) => ({ sha })), tree: { sha: c.tree } });
    }
    if (method === "POST" && path === `${base}/commits`) {
      if (!Array.isArray(body?.parents) || typeof body?.message !== "string" || typeof body?.tree !== "string") return reply(422, { message: "Invalid request" });
      for (const p of body.parents) if (!state.commits.has(p)) return reply(422, { message: `Parent ${p} not found` });
      // Content-addressed like git: identical content -> identical sha (what makes a retried POST a no-op).
      const sha = createHash("sha1").update(JSON.stringify([body.message, body.parents, body.tree])).digest("hex");
      state.commits.set(sha, { message: body.message, parents: [...body.parents], tree: body.tree });
      return reply(201, { sha });
    }
    if (method === "POST" && path === `${base}/refs`) {
      if (typeof body?.ref !== "string" || !state.commits.has(body?.sha)) return reply(422, { message: "Object does not exist" });
      if (state.refs.has(body.ref)) return reply(422, { message: "Reference already exists" });
      setRef(body.ref, body.sha);
      return reply(201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
    }
    if (method === "PATCH" && (m = new RegExp(`^${base}/refs/(.+)$`).exec(path))) {
      const ref = `refs/${m[1]}`;
      if (!state.refs.has(ref)) return reply(422, { message: "Reference does not exist" });
      if (!state.commits.has(body?.sha)) return reply(422, { message: "Object does not exist" });
      const tip = state.refs.get(ref);
      if (!body.force && !isAncestor(tip, body.sha)) return reply(422, { message: "Reference cannot be updated" });
      setRef(ref, body.sha);
      return reply(200, { ref, object: { sha: body.sha, type: "commit" } });
    }
    if (method === "DELETE" && (m = new RegExp(`^${base}/refs/(.+)$`).exec(path))) {
      const ref = `refs/${m[1]}`;
      if (!state.refs.has(ref)) return reply(422, { message: "Reference does not exist" });
      state.refs.delete(ref);
      return { status: 204, json: null, headers: headers() };
    }
    return reply(404, { message: `fake: unhandled ${method} ${path}` });
  }

  function fault(spec) { state.faults.push({ times: 1, ...spec }); }

  function takeFault(method, path) {
    for (const f of state.faults) {
      if (f.times > 0 && f.when(method, path)) { f.times -= 1; return f; }
    }
    return null;
  }

  const api = {
    state,
    fault,
    async request(method, path, body) {
      state.log.push({ method, path });
      state.now += state.clockAdvanceMs; // time passes while a request is in flight
      await tick();
      const f = takeFault(method, path);
      if (f && !f.afterApply) {
        if (f.throw) throw new Error("socket hang up");
        return reply(f.status, { message: "Server Error" });
      }
      const res = apply(method, path, body);
      await tick();
      if (f && f.afterApply) {
        if (f.throw) throw new Error("socket hang up");
        return reply(f.status, { message: "Server Error" });
      }
      return res;
    },
  };
  return api;
}
