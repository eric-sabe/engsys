// route.mjs — where a nudge to a session goes (multi-fleet P2-C, engsys#78): the one routing rule every
// sender uses, so the monsters and role skills never decide it on their own.
//
//   bare `<session>`, or `<fleet>:<session>` whose fleet is this FLEET_ID   → SendMessage to <session>
//   `<fleet>:<session>` naming another fleet                                → fleet msg send --to <fleet>:<session>
//   no FLEET_ID (single-fleet mode)                                         → SendMessage to <session>
//
// A bare name may be qualified by a role's home fleet first (`homeFleet`, from federation.yml
// repos.<repo>.<role>.home): Maintenance Monster addresses the merge orchestrator that way, since its
// home can sit in another fleet. `fleet msg route` (msg.mjs) is the CLI, and `fleet msg send` applies
// the same rule: its exit 3 ("same fleet") means the caller falls back to SendMessage.
// Design: docs/multi-fleet.md § 4; message format: fleet-msg.mjs.

import { parseAddress, FederationError } from './federation.mjs';
import { ADDRESS_RE } from './fleet-msg.mjs';

export const VIA = Object.freeze({ SEND_MESSAGE: 'sendmessage', FLEET_MSG: 'fleet-msg' });

/**
 * Route one address. Returns { via: 'sendmessage', session } or { via: 'fleet-msg', fleet, session, to }.
 * Throws FederationError for an address that is not `<session>` or `<fleet>:<session>`.
 */
export function route(address, { fleetId = null, homeFleet = null } = {}) {
  const own = fleetId || null;
  const bare = typeof address === 'string' && !address.includes(':');
  const { fleet, session } = parseAddress(address, (bare && homeFleet) || own);
  if (!own || !fleet || fleet === own) return { via: VIA.SEND_MESSAGE, session };
  const to = `${fleet}:${session}`;
  if (!ADDRESS_RE.test(to)) throw new FederationError(`address ${JSON.stringify(to)} is too long for a fleet-msg (session names are at most 64 characters)`);
  return { via: VIA.FLEET_MSG, fleet, session, to };
}

/** The one line `fleet msg route` prints for a route. */
export function routeLine(r) {
  return r.via === VIA.SEND_MESSAGE
    ? `same fleet: use SendMessage to ${r.session}`
    : `other fleet: fleet msg send --to ${r.to}`;
}
