/**
 * The pass-and-play privacy cover, as a state machine rather than a rendering habit.
 *
 * Section 13.9 requires that private cards and unresolved reward data are covered on
 * every handoff and that revealing them takes an explicit action by the seat that owns
 * them. A screen that merely remembers to draw a cover will eventually forget, so the
 * rule lives here instead: `revealedSeatId` is the only way to learn whose private data
 * may be drawn, and it answers with a seat only in the `revealed` state.
 *
 * `reveal` is deliberately narrow. It advances only a cover that is already showing the
 * same seat, so no sequence of actions can move from the shared screen, or from another
 * seat's cover, straight into a seat's private data.
 */

import type { PlayerView } from '@seatgrab/protocol';

/** Which surface the shared device is showing. */
export type HandoffState =
  /** The public projection. Nothing private is drawn. */
  | { kind: 'shared' }
  /** The cover for `seatId`. Nothing private is drawn until that seat reveals it. */
  | { kind: 'covered'; seatId: string }
  /** `seatId` has revealed their own surface, so their private data may be drawn. */
  | { kind: 'revealed'; seatId: string };

export type HandoffAction =
  /** Return to the public projection. */
  | { type: 'showShared' }
  /** Hand the device to a seat. Always lands on the cover, never on private data. */
  | { type: 'passTo'; seatId: string }
  /** The seat named on the cover confirms it is holding the device. */
  | { type: 'reveal'; seatId: string }
  /** Put the cover back without changing seats, for a seat that is done looking. */
  | { type: 'conceal' };

export const SHARED_HANDOFF: HandoffState = { kind: 'shared' };

export function handoffReducer(state: HandoffState, action: HandoffAction): HandoffState {
  switch (action.type) {
    case 'showShared':
      return SHARED_HANDOFF;
    case 'passTo':
      // Unconditional: passing to the seat already revealed still re-covers, because
      // "pass" is the gesture of putting the device down in front of someone.
      return { kind: 'covered', seatId: action.seatId };
    case 'reveal':
      return state.kind === 'covered' && state.seatId === action.seatId
        ? { kind: 'revealed', seatId: action.seatId }
        : state;
    case 'conceal':
      return state.kind === 'shared' ? state : { kind: 'covered', seatId: state.seatId };
  }
}

/**
 * The seat whose private data may be drawn, or `null`.
 *
 * Every private panel reads its seat from here. There is no other accessor, so a state
 * that is not `revealed` cannot render private data by accident.
 */
export function revealedSeatId(state: HandoffState): string | null {
  return state.kind === 'revealed' ? state.seatId : null;
}

/**
 * Where the cover starts for a table, read from the match's own view.
 *
 * A table with exactly one human seat has nobody to hide anything from: the person
 * holding the device plays that seat and every other seat is the computer, which never
 * reveals. Such a table opens on that seat's own surface and never shows a cover. Every
 * other table opens on the shared projection, exactly as before.
 *
 * This decides only the starting state. `handoffReducer` is unchanged and still refuses
 * to move into a seat's private data except through that seat's own cover.
 */
export function initialHandoff(view: PlayerView): HandoffState {
  const humans = view.players.filter((player) => player.controller !== 'computer');
  const only = humans.length === 1 ? humans[0] : undefined;
  return only === undefined ? SHARED_HANDOFF : { kind: 'revealed', seatId: only.id };
}

/** The seat the cover is waiting on, or `null` when no cover is showing. */
export function coveredSeatId(state: HandoffState): string | null {
  return state.kind === 'covered' ? state.seatId : null;
}
