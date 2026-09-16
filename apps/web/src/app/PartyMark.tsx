/**
 * A party emblem with its name available to assistive technology.
 *
 * Ownership never depends on color: the emblem silhouette differs for every party, and
 * the accessible name is the party name, so a screen reader and a color-blind player get
 * the same information a sighted player gets from the mark.
 */
import { PARTY_BY_ID } from '../assets/manifest';

export function PartyMark({ partyId, size = 24 }: { partyId: string; size?: number }) {
  const party = PARTY_BY_ID.get(partyId);
  if (party === undefined) {
    return <span className="party-mark party-mark--unknown">Unknown party “{partyId}”</span>;
  }
  return (
    <img
      className="party-mark"
      src={party.url}
      alt={party.label}
      title={party.description}
      width={size}
      height={size}
      style={{ background: party.color, borderRadius: '999px' }}
    />
  );
}
