/**
 * The party identities a seat may take.
 *
 * This list is the one source for both sides of the wire. The server has to refuse an
 * identity no client can draw, and a client has to offer only identities the server
 * seats, so the slugs are part of the protocol rather than of either application. What
 * each identity *looks* like — its emblem, its colour, its display name — is
 * presentation and stays in the browser, at `apps/web/src/assets/parties.ts`, which
 * fails at import time if it does not cover exactly these slugs.
 *
 * The identities are invented for this adaptation. They deliberately avoid the insignia
 * of real parties.
 */
export const SEATABLE_PARTY_IDS = ['kite', 'cog', 'sprout', 'lantern', 'compass'] as const;

export type SeatablePartyId = (typeof SEATABLE_PARTY_IDS)[number];

export function isSeatablePartyId(value: string): value is SeatablePartyId {
  return (SEATABLE_PARTY_IDS as readonly string[]).includes(value);
}
