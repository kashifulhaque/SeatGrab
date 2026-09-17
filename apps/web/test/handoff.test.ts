/**
 * The privacy cover, which is the session's other exit criterion.
 *
 * The claim under test is not "the cover is drawn" but "private data cannot be reached
 * without passing through the cover for that exact seat". The last test states that as a
 * property and checks it over every reachable action sequence of a bounded length rather
 * than over a handful of chosen ones.
 */
import { describe, expect, it } from 'vitest';

import type { PlayerView, PublicPlayerView, SeatController } from '@gerrymander/protocol';

import {
  SHARED_HANDOFF,
  coveredSeatId,
  handoffReducer,
  initialHandoff,
  revealedSeatId,
  type HandoffAction,
  type HandoffState,
} from '../src/app/handoff';

const SEATS = ['p1', 'p2', 'p3'] as const;

function run(actions: readonly HandoffAction[], from: HandoffState = SHARED_HANDOFF): HandoffState {
  return actions.reduce(handoffReducer, from);
}

describe('the pass-and-play privacy cover', () => {
  it('starts on the shared surface with nothing revealed', () => {
    expect(SHARED_HANDOFF).toEqual({ kind: 'shared' });
    expect(revealedSeatId(SHARED_HANDOFF)).toBeNull();
    expect(coveredSeatId(SHARED_HANDOFF)).toBeNull();
  });

  it('covers the screen when the device is passed, and reveals nothing yet', () => {
    const state = run([{ type: 'passTo', seatId: 'p2' }]);
    expect(state).toEqual({ kind: 'covered', seatId: 'p2' });
    expect(revealedSeatId(state)).toBeNull();
    expect(coveredSeatId(state)).toBe('p2');
  });

  it('reveals a seat only after that seat has been covered', () => {
    const state = run([{ type: 'passTo', seatId: 'p2' }, { type: 'reveal', seatId: 'p2' }]);
    expect(revealedSeatId(state)).toBe('p2');
  });

  it('ignores a reveal from the shared surface', () => {
    expect(run([{ type: 'reveal', seatId: 'p2' }])).toEqual(SHARED_HANDOFF);
  });

  it('ignores a reveal for a seat other than the one on the cover', () => {
    const state = run([{ type: 'passTo', seatId: 'p2' }, { type: 'reveal', seatId: 'p3' }]);
    expect(state).toEqual({ kind: 'covered', seatId: 'p2' });
    expect(revealedSeatId(state)).toBeNull();
  });

  it('covers again when the device moves to another seat', () => {
    const state = run([
      { type: 'passTo', seatId: 'p1' },
      { type: 'reveal', seatId: 'p1' },
      { type: 'passTo', seatId: 'p3' },
    ]);
    expect(state).toEqual({ kind: 'covered', seatId: 'p3' });
    expect(revealedSeatId(state)).toBeNull();
  });

  it('covers again even when the device is passed back to the seat already looking', () => {
    const state = run([
      { type: 'passTo', seatId: 'p1' },
      { type: 'reveal', seatId: 'p1' },
      { type: 'passTo', seatId: 'p1' },
    ]);
    expect(state).toEqual({ kind: 'covered', seatId: 'p1' });
  });

  it('conceals back to the same seat’s cover, and returns to the shared surface on request', () => {
    const covered = run([
      { type: 'passTo', seatId: 'p2' },
      { type: 'reveal', seatId: 'p2' },
      { type: 'conceal' },
    ]);
    expect(covered).toEqual({ kind: 'covered', seatId: 'p2' });
    expect(run([{ type: 'showShared' }], covered)).toEqual(SHARED_HANDOFF);
    expect(run([{ type: 'conceal' }], SHARED_HANDOFF)).toEqual(SHARED_HANDOFF);
  });

  it('never reaches a seat’s private surface except through that seat’s own cover', () => {
    const alphabet: HandoffAction[] = [
      { type: 'showShared' },
      { type: 'conceal' },
      ...SEATS.flatMap((seatId): HandoffAction[] => [
        { type: 'passTo', seatId },
        { type: 'reveal', seatId },
      ]),
    ];

    // Breadth-first over every reachable state, checking each transition into a
    // revealed state. The state space is tiny, so this is exhaustive, not sampled.
    const seen = new Set<string>();
    const queue: HandoffState[] = [SHARED_HANDOFF];
    let transitions = 0;
    while (queue.length > 0) {
      const state = queue.shift() as HandoffState;
      const key = JSON.stringify(state);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const action of alphabet) {
        const next = handoffReducer(state, action);
        transitions += 1;
        if (next.kind === 'revealed' && JSON.stringify(next) !== key) {
          expect(action).toEqual({ type: 'reveal', seatId: next.seatId });
          expect(state).toEqual({ kind: 'covered', seatId: next.seatId });
        }
        queue.push(next);
      }
    }
    // 1 shared + 3 covered + 3 revealed states, each with the full alphabet applied.
    expect(seen.size).toBe(1 + SEATS.length * 2);
    expect(transitions).toBe(seen.size * alphabet.length);
  });
});

/** Just the part of a view `initialHandoff` reads: who plays each seat. */
function viewOf(controllers: readonly SeatController[]): PlayerView {
  const players = controllers.map((controller, index) => ({
    id: `p${index + 1}`,
    controller,
  })) as unknown as readonly PublicPlayerView[];
  return { players } as unknown as PlayerView;
}

describe('where the cover starts', () => {
  it('opens on the shared surface whenever two or more people are at the table', () => {
    expect(initialHandoff(viewOf(['human', 'human', 'human']))).toEqual(SHARED_HANDOFF);
    expect(initialHandoff(viewOf(['human', 'human', 'computer']))).toEqual(SHARED_HANDOFF);
    // A table of computers only cannot be created, but the function is total, and the
    // safe answer for one is the surface that draws nothing private.
    expect(initialHandoff(viewOf(['computer', 'computer', 'computer']))).toEqual(SHARED_HANDOFF);
  });

  it('opens on the one person’s own seat when every other seat is a computer', () => {
    expect(initialHandoff(viewOf(['human', 'computer', 'computer'])))
      .toEqual({ kind: 'revealed', seatId: 'p1' });
    expect(initialHandoff(viewOf(['computer', 'human', 'computer'])))
      .toEqual({ kind: 'revealed', seatId: 'p2' });
  });

  it('treats a seat with no controller as a person, so an old save still passes the device', () => {
    const legacy = {
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    } as unknown as PlayerView;
    expect(initialHandoff(legacy)).toEqual(SHARED_HANDOFF);
  });

  it('reaches the same revealed state the reducer does, so the machine is unchanged', () => {
    const start = initialHandoff(viewOf(['human', 'computer', 'computer']));
    expect(start.kind).toBe('revealed');
    const throughTheReducer = run([
      { type: 'passTo', seatId: 'p1' },
      { type: 'reveal', seatId: 'p1' },
    ]);
    expect(throughTheReducer).toEqual(start);
  });
});
