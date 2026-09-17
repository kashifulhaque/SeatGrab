/**
 * A seat as a small card: the party emblem large, the name, and one action.
 *
 * The first-player vote is a choice between people, so each candidate is a card with a
 * face rather than a line of text in a button. The button's accessible name is the whole
 * sentence, `Vote for Asha`, so it reads the same as the old text button did.
 */
import { PARTY_BY_ID } from '../../assets/manifest';

import './cards.css';

export function SeatCard({
  partyId,
  name,
  action,
  ariaLabel,
  disabled = false,
  onPress,
  index = 0,
  /** Marks this seat as the viewer's own; drawn without an action. */
  note,
}: {
  partyId: string;
  name: string;
  /** The visible verb on the card, for example `Vote`. */
  action?: string | undefined;
  /** The button's full accessible name, for example `Vote for Asha`. */
  ariaLabel?: string | undefined;
  disabled?: boolean;
  onPress?: (() => void) | undefined;
  index?: number;
  note?: string | undefined;
}) {
  const party = PARTY_BY_ID.get(partyId);
  const style = {
    '--card-index': index,
    '--party': party?.color ?? 'var(--trim)',
  } as React.CSSProperties;
  const body = (
    <>
      <span className="card-seat__emblem" aria-hidden="true">
        {party === undefined ? null : <img src={party.url} alt="" width={56} height={56} />}
      </span>
      <span className="card-seat__name">{name}</span>
      {party === undefined ? null : <span className="card-seat__party">{party.displayName}</span>}
      {note === undefined ? null : <span className="card-seat__note">{note}</span>}
      {action === undefined ? null : <span className="card-seat__cta">{action}</span>}
    </>
  );
  if (onPress === undefined) {
    return (
      <span className="card card--seat" style={style}>
        <span className="card__face">{body}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="card card--seat card--pressable"
      style={style}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onPress}
    >
      <span className="card__face">{body}</span>
    </button>
  );
}
