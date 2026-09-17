/**
 * Who needs the device, as one control.
 *
 * The first playtest showed a row of identical "Pass to" buttons with nothing to say which
 * seat the match was waiting on. This answers that question with one primary action —
 * pass to the seat that must act — and keeps every other seat and the table view behind a
 * menu. The revealed seat sees "Hide my cards" as its way back.
 *
 * It dispatches the same four actions to `handoffReducer` that the button row did, and
 * nothing else. The state machine in `handoff.ts` is unchanged: passing always lands on
 * the cover, revealing takes an explicit click on that cover, and concealing goes back to
 * the cover rather than to the table.
 */
import { useRef, type RefObject } from 'react';

import type { PublicPlayerView } from '@seatgrab/protocol';

import { PartyMark } from './PartyMark';
import { revealedSeatId, type HandoffAction, type HandoffState } from './handoff';

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
  const menu = useRef<HTMLDetailsElement>(null);
  const revealed = revealedSeatId(handoff);
  // A computer seat never holds the device, so it is not somewhere the device can be
  // passed. The reducer stays generic; the filtering is the shell's, and it is here.
  const passable = seats.filter((seat) => seat.controller !== 'computer');
  // A table with one person has nobody to pass to, so the passing controls are not drawn
  // at all rather than drawn with one entry that does nothing useful.
  const soloTable = passable.length <= 1;
  const choose = (action: HandoffAction) => () => {
    if (menu.current !== null) menu.current.open = false;
    dispatch(action);
  };

  return (
    <div className="switcher">
      {revealed === null || soloTable ? null : (
        <button type="button" className="button button--primary" onClick={choose({ type: 'conceal' })}>
          Hide my cards
        </button>
      )}
      {mustAct === null || mustAct.id === revealed || mustAct.controller === 'computer' ? null : (
        <button
          type="button"
          className={`button ${revealed === null ? 'button--primary' : ''}`}
          onClick={choose({ type: 'passTo', seatId: mustAct.id })}
        >
          <PartyMark partyId={mustAct.partyId} size={20} />
          Pass to {mustAct.displayName}
        </button>
      )}
      {soloTable ? null : (
      <details ref={menu} className="menu">
        <summary className="button button--quiet">Pass the device</summary>
        <ul className="menu__list">
          <li>
            <button
              ref={sharedButtonRef}
              type="button"
              className="button button--quiet"
              aria-pressed={handoff.kind === 'shared'}
              onClick={choose({ type: 'showShared' })}
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
                onClick={choose({ type: 'passTo', seatId: seat.id })}
              >
                <PartyMark partyId={seat.partyId} size={20} />
                Pass to {seat.displayName}
                {seat.id === revealed ? <span className="small"> · showing</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </details>
      )}
    </div>
  );
}
