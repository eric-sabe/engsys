// handoff.mjs — whose `<!-- mm-handoff -->` `session:` a monster may nudge (engsys#107).
//
// Merge Monster and Maintenance Monster nudge the session a PR's handoff block names. A bare name, or
// one in this fleet, goes by SendMessage; a `<fleet>:<session>` naming ANOTHER fleet becomes an
// App-signed fleet-msg comment that the other fleet's relay delivers, so anyone who can comment on the
// PR could otherwise aim this fleet's App at any session of the federation, or (#109 review L1) post a
// later handoff that redirects or mutes the real one. So a handoff counts only when written by:
//
//   - the PR author (the PR body, or a comment by the same login),
//   - an actor who applied the `mm:ready` label (the issue events), or
//   - the App of the fleet the address names (a bare address: this fleet): a Bot comment whose login
//     is fleets.<fleet>.github_app + "[bot]" and whose performed_via_github_app.id is that fleet's
//     github_app_id, the check the relay's verify() makes (#109 review L2).
//
// Any other handoff is ignored and reported, so the monster can journal it. The newest handoff that
// counts wins. The marker counts only at the start of a line, outside a code fence or blockquote, and
// never in a fleet-msg comment (which quotes another fleet's text). `fleet msg route --handoff-pr
// owner/repo#N` (msg.mjs) is the CLI.
//
// Pure: the caller fetches the issue, its comments and its events and passes them in.

import { route, VIA } from './route.mjs';
import { FederationError } from './federation.mjs';
import { hasMarker } from './fleet-msg.mjs';

export const HANDOFF_MARKER = '<!-- mm-handoff -->';
export const READY_LABEL = 'mm:ready';

const KEY_LINE = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const MARKER_LINE = /^ {0,3}<!-- mm-handoff -->\s*$/;

/**
 * The `session:` value of the first mm-handoff block in `text`, or null. The marker must be a line of
 * its own, outside a code fence (a `>` quote line never matches). The block is the run of `key: value`
 * lines after it (blank lines and ``` fences before the first key are skipped); a `# comment` after
 * the value is dropped.
 */
export function parseHandoff(text) {
  if (typeof text !== 'string') return null;
  const all = text.split(/\r?\n/);
  let fenced = false;
  let at = -1;
  for (let k = 0; k < all.length; k++) {
    if (FENCE.test(all[k])) { fenced = !fenced; continue; }
    if (!fenced && MARKER_LINE.test(all[k])) { at = k; break; }
  }
  if (at < 0) return null;
  const lines = all.slice(at + 1);
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
 *   comments  its REST issue comments, oldest first ({ user: { login, type }, body, html_url, performed_via_github_app })
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
    { body: issue?.body, login: issue?.user?.login, type: issue?.user?.type ?? null, appId: null, url: issue?.html_url ?? null },
    ...comments.map((c) => ({ body: c?.body, login: c?.user?.login, type: c?.user?.type ?? null, appId: c?.performed_via_github_app?.id ?? null, url: c?.html_url ?? null })),
  ];
  // The App of `fleet` wrote it: a Bot with that App's login and pinned id (fleet-msg.mjs verify()).
  const byFleetApp = (c, fleet) => {
    const f = fleet ? reg?.fleets?.[fleet] : null;
    if (!f?.github_app || f.github_app_id === undefined || f.github_app_id === null) return false;
    return c.type === 'Bot' && lower(c.login) === `${f.github_app}[bot]`.toLowerCase() && c.appId === f.github_app_id;
  };
  let chosen = null;
  const ignored = [];
  for (const c of candidates) {
    if (hasMarker(c.body)) continue; // a fleet-msg carries another fleet's text, never a handoff
    const session = parseHandoff(c.body);
    if (!session) continue;
    let r;
    try { r = route(session, { fleetId }); } catch (e) {
      if (!(e instanceof FederationError)) throw e;
      r = null; // not an address: the route step reports it (exit 2)
    }
    const fleet = r?.via === VIA.FLEET_MSG ? r.fleet : fleetId;
    const login = lower(c.login);
    const trusted = (login && login === prAuthor) || (login && labelers.has(login)) || byFleetApp(c, fleet);
    if (!trusted) {
      ignored.push({ session, author: c.login ?? null, url: c.url, why: `a handoff from someone who is not the PR author, an ${READY_LABEL} labeler or ${fleet ? `fleet ${fleet}'s` : 'the fleet\'s'} App` });
      continue;
    }
    chosen = { session, source: c.url };
  }
  return { session: chosen?.session ?? null, source: chosen?.source ?? null, ignored };
}
