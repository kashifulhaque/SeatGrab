/**
 * Who holds the device, as a short list of controls inside the match menu.
 *
 * The seat the match is waiting on has its own primary control in the action sheet's
 * header — "Pass the device to Bikram" — so this list is the rest: hide the revealed
 * seat's cards, go back to the table view, or pass to any other person at the table. It
 * dispatches the same four actions to `handoffReducer` that the first button row did,
 * and nothing else. The state machine in `handoff.ts` is unchanged: passing always lands
 * on the cover, revealing takes an explicit click on that cover, and concealing goes back
 * to the cover rather than to the table.
 *
 * A computer seat never holds the device, so it is not somewhere the device can be
 * passed. A table with one person has nobody to pass to, so this renders nothing at all,
 * and the menu draws no section for it: `match-shell.test.tsx` asserts that no passing
 * words appear on a solo table.
 */
import type { RefObject } from 'react';

import type { PublicPlayerView } from '@gerrymander/protocol';

import { PartyMark } from './PartyMark';
import { revealedSeatId, type HandoffAction, type HandoffState } from './handoff';

/** True when the table has more than one person, so passing means something. */
export function hasSeatsToPass(seats: readonly PublicPlayerView[]): boolean {
  return seats.filter((seat) => seat.controller !== 'computer').length > 1;
}

export function SeatSwitcher({
  seats,
  handoff,
  mustAct,
  dispatch,
  sharedButtonRef,
}: {
  /** Every seat, in clockwise order. */
  seats: readonly PublicPlayerView[];
  handoff: HandoffState;
  /** The seat the match is waiting on, or `null` once it is over. */
  mustAct: PublicPlayerView | null;
  dispatch: (action: HandoffAction) => void;
  /** The table-view control, so the cover can give focus back to it. */
  sharedButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const revealed = revealedSeatId(handoff);
  const passable = seats.filter((seat) => seat.controller !== 'computer');
  if (passable.length <= 1) return null;

  return (
    <div className="ms-switch">
      {revealed === null ? null : (
        <button
          type="button"
          className="button button--primary ms-switch__hide"
          onClick={() => dispatch({ type: 'conceal' })}
        >
          Hide my cards
        </button>
      )}
      <ul className="ms-switch__list">
        <li>
          <button
            ref={sharedButtonRef}
            type="button"
            className="button button--quiet"
            aria-pressed={handoff.kind === 'shared'}
            onClick={() => dispatch({ type: 'showShared' })}
          >
            Table view
          </button>
        </li>
        {passable.map((seat) => (
          <li key={seat.id}>
            <button
              type="button"
              className="button button--quiet"
              aria-pressed={handoff.kind !== 'shared' && handoff.seatId === seat.id}
              onClick={() => dispatch({ type: 'passTo', seatId: seat.id })}
            >
              <PartyMark partyId={seat.partyId} size={20} />
              Pass to {seat.displayName}
              {seat.id === revealed ? (
                <span className="small"> · showing</span>
              ) : seat.id === mustAct?.id ? (
                <span className="small"> · to act</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
