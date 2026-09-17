/**
 * A voter token: a round disc in a party's colour, carrying that party's emblem.
 *
 * It is the piece a player puts on the board, drawn small enough for a seat list and a
 * tutorial sentence. Colour never carries the party alone: the emblem differs for every
 * party and the accessible name says which one it is.
 */
import { PARTY_BY_ID } from '../../assets/manifest';

import './cards.css';

export function VoterToken({
  partyId,
  size = 28,
  /** Replaces the default `{Party} voter` name, for example a count. */
  label,
}: {
  partyId: string;
  size?: number;
  label?: string;
}) {
  const party = PARTY_BY_ID.get(partyId);
  if (party === undefined) {
    return <span className="card-token card-token--unknown">Unknown party “{partyId}”</span>;
  }
  return (
    <span
      className="card-token"
      role="img"
      aria-label={label ?? `${party.displayName} voter`}
      style={{ width: size, height: size, '--party': party.color } as React.CSSProperties}
    >
      <img src={party.url} alt="" aria-hidden="true" width={size} height={size} />
    </span>
  );
}
