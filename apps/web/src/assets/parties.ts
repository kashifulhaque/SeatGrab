/**
 * How the five party identities are drawn.
 *
 * *Which* identities exist is not decided here: `SEATABLE_PARTY_IDS` in `@seatgrab/protocol`
 * is the one source, because the server has to refuse an identity no client can draw and
 * a client must offer only identities the server seats. This module gives each of those
 * slugs a name, a colour and a mark, which are presentation and belong in the browser.
 * The two are joined at import time below, so adding a slug to the protocol without
 * drawing it — or drawing one the protocol does not seat — fails to load rather than
 * failing in a lobby.
 *
 * This module imports no asset, so the lobby's setup model can read the roster in a plain
 * unit test while `manifest.ts` joins each identity to its bundled emblem. Keep those two
 * in step as well: `manifest.ts` fails at import time if an identity here has no mark.
 *
 * The names and emblems are invented for this adaptation. They deliberately avoid the
 * insignia of real parties, and every one has a distinct silhouette so ownership never
 * depends on colour alone.
 */
import { SEATABLE_PARTY_IDS, type SeatablePartyId } from '@seatgrab/protocol';

export interface PartyIdentity {
  /** Stable party identity a lobby seat is assigned. Stored in the match config. */
  partyId: SeatablePartyId;
  displayName: string;
  /** Token and mat color. Shape always carries the same information. */
  color: string;
  /** Readable ink for text drawn on `color`. */
  onColor: string;
  /** What the drawn mark is, in words, for the asset review table and for alt text. */
  description: string;
}

export const PARTY_IDENTITIES: readonly PartyIdentity[] = [
  {
    partyId: 'kite',
    displayName: 'Kite',
    color: '#C2557F',
    onColor: '#FFFFFF',
    description: 'Diamond kite with crossed spars.',
  },
  {
    partyId: 'cog',
    displayName: 'Cog',
    color: '#7B5EA7',
    onColor: '#FFFFFF',
    description: 'Eight-tooth gear with an open hub.',
  },
  {
    partyId: 'sprout',
    displayName: 'Sprout',
    color: '#4E7A4A',
    onColor: '#FFFFFF',
    description: 'Two-leaf seedling on a stem.',
  },
  {
    partyId: 'lantern',
    displayName: 'Lantern',
    color: '#B4763A',
    onColor: '#FFFFFF',
    description: 'Hooded lantern with a cut-out flame.',
  },
  {
    partyId: 'compass',
    displayName: 'Compass',
    color: '#3E7C8C',
    onColor: '#FFFFFF',
    description: 'Eight-point compass rose.',
  },
];

export const PARTY_IDENTITY_BY_ID: ReadonlyMap<string, PartyIdentity> = new Map(
  PARTY_IDENTITIES.map((party) => [party.partyId, party]),
);

/**
 * Every identity the protocol seats has a drawn mark here, and no more than those.
 *
 * The check runs at import time rather than in a test, so a roster that has drifted
 * cannot be shipped and then discovered by a player who cannot pick a party.
 */
for (const partyId of SEATABLE_PARTY_IDS) {
  if (!PARTY_IDENTITY_BY_ID.has(partyId)) {
    throw new Error(
      `The protocol seats the party "${partyId}" but this browser has no identity for it. `
      + 'Add it here, or remove it from SEATABLE_PARTY_IDS in @seatgrab/protocol.',
    );
  }
}
if (PARTY_IDENTITIES.length !== SEATABLE_PARTY_IDS.length) {
  throw new Error(
    `This browser draws ${PARTY_IDENTITIES.length} party identities but the protocol seats `
    + `${SEATABLE_PARTY_IDS.length}. The two lists are one roster and must be changed together.`,
  );
}
