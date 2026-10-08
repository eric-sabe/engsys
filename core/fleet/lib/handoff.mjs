// handoff.mjs — whose `<!-- mm-handoff -->` `session:` a monster may nudge (engsys#107).
//
// Merge Monster and Maintenance Monster nudge the session a PR's handoff block names. A bare name, or
// one in this fleet, goes by SendMessage, as before. A `<fleet>:<session>` naming ANOTHER fleet becomes
// an App-signed fleet-msg comment that the other fleet's relay delivers, so anyone who can comment on
// the PR could otherwise aim this fleet's App at any session of the federation. A cross-fleet address
// is honoured only from a handoff written by:
//
//   - the PR author (the PR body, or a comment by the same login),
//   - an actor who applied the `mm:ready` label (the issue events), or
//   - that fleet's App: performed_via_github_app.id === federation.yml fleets.<fleet>.github_app_id.
//
// Any other handoff naming another fleet is ignored (and reported, so the monster can journal it). The
// newest handoff that counts wins. `fleet msg route --handoff-pr owner/repo#N` (msg.mjs) is the CLI.
//
// Pure: the caller fetches the issue, its comments and its events and passes them in.

import { route, VIA } from './route.mjs';
import { FederationError } from './federation.mjs';

export const HANDOFF_MARKER = '<!-- mm-handoff -->';
export const READY_LABEL = 'mm:ready';

const KEY_LINE = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/;

/**
 * The `session:` value of the first mm-handoff block in `text`, or null. The block is the run of
 * `key: value` lines after the marker (blank lines and ``` fences before the first key are skipped);
 * a `# comment` after the value is dropped.
 */
export function parseHandoff(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(HANDOFF_MARKER);
  if (at < 0) return null;
  const lines = text.slice(at + HANDOFF_MARKER.length).split(/\r?\n/);
  let started = false;
  for (const line of lines) {
    if (/^\s*(```[\w-]*)?\s*$/.test(line)) {
      if (started) break;
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m) break;
    started = true;
    if (m[1] === 'session') {
      const value = m[2].replace(/\s+#.*$/, '').trim();
      return value || null;
    }
  }
  return null;
}

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : null);

/**
 * Decide which handoff address a monster may route.
 *   issue     the REST issue for the PR ({ user: { login }, body, html_url })
 *   comments  its REST issue comments, oldest first ({ user: { login }, body, html_url, performed_via_github_app })
 *   events    its REST issue events ({ event, label: { name }, actor: { login } })
 *   reg       loadFederation(...) output, or null
 *   fleetId   this fleet's FLEET_ID, or null (single-fleet mode: nothing crosses a fleet)
 * -> { session: <address> | null, source: <url> | null, ignored: [{ session, author, url, why }] }
 */
export function authoritativeHandoff({ issue, comments = [], events = [], reg = null, fleetId = null }) {
  const prAuthor = lower(issue?.user?.login);
  const labelers = new Set(events
    .filter((e) => e?.event === 'labeled' && e?.label?.name === READY_LABEL)
    .map((e) => lower(e?.actor?.login))
    .filter(Boolean));
  const candidates = [
    { body: issue?.body, login: issue?.user?.login, appId: null, url: issue?.html_url ?? null },
    ...comments.map((c) => ({ body: c?.body, login: c?.user?.login, appId: c?.performed_via_github_app?.id ?? null, url: c?.html_url ?? null })),
  ];
  let chosen = null;
  const ignored = [];
  for (const c of candidates) {
    const session = parseHandoff(c.body);
    if (!session) continue;
    let r;
    try { r = route(session, { fleetId }); } catch (e) {
      if (!(e instanceof FederationError)) throw e;
      r = null; // not an address: the route step reports it (exit 2), whoever wrote it
    }
    if (r?.via === VIA.FLEET_MSG) {
      const login = lower(c.login);
      const pinned = reg?.fleets?.[r.fleet]?.github_app_id;
      const trusted = (login && login === prAuthor)
        || (login && labelers.has(login))
        || (pinned !== undefined && pinned !== null && c.appId === pinned);
      if (!trusted) {
        ignored.push({ session, author: c.login ?? null, url: c.url, why: `a cross-fleet address from someone who is not the PR author, an ${READY_LABEL} labeler or fleet ${r.fleet}'s App` });
        continue;
      }
    }
    chosen = { session, source: c.url };
  }
  return { session: chosen?.session ?? null, source: chosen?.source ?? null, ignored };
}
