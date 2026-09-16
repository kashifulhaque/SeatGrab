/**
 * The table's derivations: zone summaries, seat summaries, the decision banner, and the
 * keyboard geometry of the board.
 *
 * These are the decisions the table makes about what to say. They are tested against a
 * real projected `PlayerView` from the real engine rather than a hand-built literal, so
 * a change to the projection contract that the table depends on fails here.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD } from '@seatgrab/content';
import { CORE_CONTENT, applyCommand, createGame, projectGame } from '@seatgrab/engine';
import type { GameConfig, GameState } from '@seatgrab/engine';
import type { PlayerView } from '@seatgrab/protocol';

import {
  describeDecision,
  describePhase,
  describeTurn,
  mustActSeat,
  describeDecks,
  describeSlot,
  describeStep,
  summarizePlayers,
  summarizeZones,
  turnSteps,
} from '../src/app/table';
import {
  FIRST_SLOT_ID,
  slotAtZoneEdge,
  slotInAdjacentZone,
  slotInDirection,
} from '../src/board/boardNavigation';

const config: GameConfig = {
  matchId: 'table-model',
  players: [
    { id: 'p1', displayName: 'Asha', partyId: 'kite' },
    { id: 'p2', displayName: 'Bikram', partyId: 'cog' },
    { id: 'p3', displayName: 'Chandni', partyId: 'sprout' },
  ],
  contentAdvisories: ['trigger'],
  tiePolicy: 'jointWinners',
};

function publicView(state: GameState): PlayerView {
  return projectGame(state, { kind: 'public' }, CORE_CONTENT);
}

/** A match with voters standing in one zone, two of them marked for the majority. */
function seededBoard(): GameState {
  const state = createGame(config, CORE_CONTENT, 21);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.phase = 'action';
  state.pendingInteraction = null;

  const northWestSlots = CORE_BOARD.slots.filter((slot) => slot.zoneId === 'northWest');
  const place = (index: number, ownerId: string, majority: boolean): void => {
    const slot = northWestSlots[index]!;
    const voter = state.voters.find(
      (candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply',
    )!;
    voter.location = { kind: 'board', slotId: slot.slotId, majority };
    state.slots.find((candidate) => candidate.slotId === slot.slotId)!.voterId = voter.id;
  };
  place(0, 'p1', true);
  place(1, 'p1', true);
  place(2, 'p1', false);
  place(3, 'p2', false);
  return state;
}

describe('zone summaries', () => {
  it('counts voters, marked voters and empty areas from the projected slots', () => {
    const view = publicView(seededBoard());
    const northWest = summarizeZones(view).find((zone) => zone.id === 'northWest')!;

    expect(northWest.filled).toBe(4);
    expect(northWest.empty).toBe(northWest.capacity - 4);
    expect(northWest.holdings.map((holding) => [holding.displayName, holding.voters])).toEqual([
      ['Asha', 3],
      ['Bikram', 1],
    ]);
    expect(northWest.holdings[0]!.majorityVoters).toBe(2);
  });

  it('gives a screen reader the threshold, the counts and the empty areas', () => {
    const view = publicView(seededBoard());
    const northWest = summarizeZones(view).find((zone) => zone.id === 'northWest')!;

    // Marked voters are what claims a zone, so Asha holds this one: the engine's
    // majority owner is whoever has marked voters here, not whoever has the most.
    expect(northWest.spoken).toBe(
      `${northWest.displayName}, ${northWest.majorityThreshold} of ${northWest.capacity} `
      + `required, Asha 3, Bikram 1, ${northWest.empty} empty, majority Asha.`,
    );
    expect(northWest.majorityOwner?.displayName).toBe('Asha');
    // Asha also has the most voters here, so the zone's redistricting rights are Asha's.
    expect(northWest.rightsOwner?.displayName).toBe('Asha');
  });

  it('summarizes every zone of the board, including the untouched ones', () => {
    const view = publicView(seededBoard());
    const zones = summarizeZones(view);

    expect(zones).toHaveLength(9);
    const untouched = zones.find((zone) => zone.id === 'south')!;
    expect(untouched.filled).toBe(0);
    expect(untouched.holdings).toEqual([]);
    expect(untouched.spoken).toContain('no voters yet');
    expect(zones.reduce((total, zone) => total + zone.capacity, 0))
      .toBe(CORE_BOARD.slots.length);
  });
});

describe('slot descriptions', () => {
  it('names the zone, the area number, the owner and whether the voter is marked', () => {
    const view = publicView(seededBoard());
    const occupied = view.slots.filter((slot) => slot.voter !== undefined);
    const zoneOf = (zoneId: string) => view.zones.find((zone) => zone.id === zoneId);

    const marked = describeSlot(occupied[0]!, zoneOf(occupied[0]!.zoneId), view.players);
    expect(marked).toContain('area 1');
    expect(marked).toContain('Asha voter');
    expect(marked).toContain('marked for majority');

    const unmarked = describeSlot(occupied[3]!, zoneOf(occupied[3]!.zoneId), view.players);
    expect(unmarked).toContain('Bikram voter');
    expect(unmarked).toContain('not marked');
  });

  it('says an empty area is empty, and says when it is volatile', () => {
    const view = publicView(seededBoard());
    const volatileSlot = view.slots.find(
      (slot) => slot.volatile && slot.voter === undefined,
    )!;
    const spoken = describeSlot(
      volatileSlot,
      view.zones.find((zone) => zone.id === volatileSlot.zoneId),
      view.players,
    );
    expect(spoken).toContain('volatile area');
    expect(spoken).toContain('empty');
  });
});

describe('seat summaries', () => {
  it('separates board voters, majority score, zones held and resources', () => {
    const view = publicView(seededBoard());
    const summaries = summarizePlayers(view, summarizeZones(view));

    const asha = summaries.find((summary) => summary.player.id === 'p1')!;
    expect(asha.boardVoters).toBe(3);
    expect(asha.majorityVoters).toBe(view.players.find((player) => player.id === 'p1')!.score);
    expect(asha.zonesPresent).toBe(1);
    expect(asha.zonesLed).toEqual(['North West']);
    expect(asha.zonesWithRights).toEqual(['North West']);
    expect(asha.active).toBe(true);
    expect(asha.deciding).toBe(false);

    const chandni = summaries.find((summary) => summary.player.id === 'p3')!;
    expect(chandni.boardVoters).toBe(0);
    expect(chandni.zonesLed).toEqual([]);
  });

  it('keeps seats in clockwise order regardless of the projection order', () => {
    const view = publicView(seededBoard());
    const summaries = summarizePlayers(view, summarizeZones(view));
    expect(summaries.map((summary) => summary.player.seat)).toEqual([0, 1, 2]);
  });
});

describe('the decision banner', () => {
  it('names every seat still to vote at the start of a match', () => {
    const state = createGame(config, CORE_CONTENT, 7);
    const banner = describeDecision(publicView(state));

    expect(banner.news).toBe('Waiting on Asha, Bikram and Chandni');
    expect(banner.detail).toBe('Voting for the first player.');
    expect(banner.awayFromActiveSeat).toBe(false);
  });

  it('marks a decision that belongs to someone other than the active seat', () => {
    const state = seededBoard();
    state.pendingInteraction = {
      id: 'interaction-1',
      kind: 'capDiscard',
      responsiblePlayerIds: ['p2'],
      playerId: 'p2',
      excess: 2,
      continuation: 'resumeAction',
    };
    const view = publicView(state);
    const banner = describeDecision(view);

    expect(view.activePlayerId).toBe('p1');
    expect(banner.news).toBe('Waiting on Bikram');
    expect(banner.detail).toBe('Discarding down to the resource cap.');
    expect(banner.awayFromActiveSeat).toBe(true);
    expect(summarizePlayers(view, summarizeZones(view)).find((s) => s.player.id === 'p2')!.deciding)
      .toBe(true);
  });

  it('falls back to the active seat when nothing is pending', () => {
    const banner = describeDecision(publicView(seededBoard()));
    expect(banner.news).toBe('Asha is acting');
    expect(banner.waitingOn).toEqual([]);
  });
});

describe('deck counts', () => {
  it('reports the market and every draw pile as counts', () => {
    const view = publicView(seededBoard());
    expect(describeDecks(view)).toEqual([
      { label: 'Voter market', value: `${view.voterCards.length} face up` },
      { label: 'Voter draw pile', value: `${view.deckCounts.voter} cards` },
      { label: 'Policy draw pile', value: `${view.deckCounts.policy} cards` },
      { label: 'News draw pile', value: `${view.deckCounts.news} cards` },
      { label: 'Trick draw pile', value: `${view.deckCounts.trick} cards` },
    ]);
  });
});

describe('the immutable setup summary', () => {
  it('lets the table report its settings without touching the authoritative state', () => {
    const view = publicView(createGame(config, CORE_CONTENT, 3));
    expect(view.setup.playerCount).toBe(3);
    expect(view.setup.contentAdvisories).toEqual(['trigger']);
    expect(view.setup.tiePolicy).toBe('jointWinners');
    expect(view.setup.boardId).toBe(CORE_BOARD.id);
  });
});

describe('keyboard movement across the board', () => {
  it('moves to a different area in each direction, and stops at the edges', () => {
    const start = CORE_BOARD.slots.find((slot) => slot.zoneId === 'central')!.slotId;
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      const next = slotInDirection(start, direction);
      expect(next, `no area ${direction} of ${start}`).not.toBeNull();
      expect(next).not.toBe(start);
    }
    // The first slot in board order sits at the top of the map; nothing is above it.
    const topMost = [...CORE_BOARD.slots]
      .sort((left, right) => left.position.y - right.position.y)[0]!;
    expect(slotInDirection(topMost.slotId, 'up')).toBeNull();
  });

  it('moves right to an area that is actually to the right', () => {
    const from = CORE_BOARD.slots.find((slot) => slot.zoneId === 'west')!;
    const toId = slotInDirection(from.slotId, 'right')!;
    const to = CORE_BOARD.slots.find((slot) => slot.slotId === toId)!;
    expect(to.position.x).toBeGreaterThan(from.position.x);
  });

  it('reaches every area from the first one, so no area is keyboard-unreachable', () => {
    const seen = new Set<string>([FIRST_SLOT_ID]);
    const queue = [FIRST_SLOT_ID];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        const next = slotInDirection(current, direction);
        if (next !== null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
      for (const edge of ['first', 'last'] as const) {
        const next = slotAtZoneEdge(current, edge);
        if (next !== null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
      for (const step of [1, -1] as const) {
        const next = slotInAdjacentZone(current, step);
        if (next !== null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(CORE_BOARD.slots.length);
  });

  it('Home and End stay inside the zone; Page Down leaves it', () => {
    const central = CORE_BOARD.slots.filter((slot) => slot.zoneId === 'central');
    const middle = central[Math.floor(central.length / 2)]!.slotId;

    expect(slotAtZoneEdge(middle, 'first')).toBe(central[0]!.slotId);
    expect(slotAtZoneEdge(middle, 'last')).toBe(central[central.length - 1]!.slotId);

    const nextZone = slotInAdjacentZone(middle, 1)!;
    const nextSlot = CORE_BOARD.slots.find((slot) => slot.slotId === nextZone)!;
    expect(nextSlot.zoneId).not.toBe('central');
  });

  it('answers with nothing for a slot the board does not have', () => {
    expect(slotInDirection('not-a-slot', 'left')).toBeNull();
    expect(slotAtZoneEdge('not-a-slot', 'first')).toBeNull();
    expect(slotInAdjacentZone('not-a-slot', 1)).toBeNull();
  });
});

describe('the projection stays the table’s only source', () => {
  it('reads a decision owner the engine moved away from the active seat', () => {
    let state = createGame(config, CORE_CONTENT, 7);
    const result = applyCommand(
      state,
      { playerId: 'p1' },
      { type: 'VoteForFirstPlayer', candidateId: 'p2' },
      CORE_CONTENT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state = result.state;

    const banner = describeDecision(publicView(state));
    expect(banner.waitingOn.map((player) => player.displayName)).toEqual(['Bikram', 'Chandni']);
  });
});


describe('the status bar', () => {
  it('names the turn and the phase in plain words', () => {
    const state = seededBoard();
    state.turn.ordinal = 4;
    const view = publicView(state);
    expect(describePhase(view)).toBe('Actions');
    expect(describeTurn(view)).toBe('Turn 4 · Actions');
  });

  it('calls setup what it is, and a finished match final', () => {
    expect(describeTurn(publicView(createGame(config, CORE_CONTENT, 7))))
      .toBe('Setup · First-player vote');
    const state = seededBoard();
    state.status = 'finished';
    state.turn.phase = 'finished';
    expect(describeTurn(publicView(state))).toBe('Final');
  });

  it('hands the device to the first seat a decision waits on, else the active seat', () => {
    expect(mustActSeat(publicView(seededBoard()))?.id).toBe('p1');
    const state = seededBoard();
    state.pendingInteraction = {
      id: 'interaction-1',
      kind: 'capDiscard',
      responsiblePlayerIds: ['p2'],
      playerId: 'p2',
      excess: 2,
      continuation: 'resumeAction',
    };
    expect(mustActSeat(publicView(state))?.id).toBe('p2');
    state.pendingInteraction = null;
    state.status = 'finished';
    expect(mustActSeat(publicView(state))).toBeNull();
  });
});

describe('the turn steps', () => {
  it('reads a turn as answer, buy and place, end turn, with the current one marked', () => {
    const state = seededBoard();
    state.turn.ordinal = 4;
    state.turn.phase = 'action';
    expect(turnSteps(publicView(state)).map((step) => `${step.label}:${step.state}`)).toEqual([
      'Answer the question:done',
      'Buy and place voters:current',
      'End turn:todo',
    ]);
    expect(describeStep(publicView(state))).toBe('Step 2 of 3 · Buy and place voters');
  });

  it('counts the cap discard as part of answering, and the news as part of ending', () => {
    const state = seededBoard();
    state.turn.ordinal = 2;
    state.turn.phase = 'resourceCap';
    expect(turnSteps(publicView(state))[0]?.state).toBe('current');
    state.turn.phase = 'newsResolution';
    expect(turnSteps(publicView(state))[2]?.state).toBe('current');
    expect(turnSteps(publicView(state))[1]?.state).toBe('done');
  });

  it('gives setup its own two steps and a finished match one', () => {
    const fresh = publicView(createGame(config, CORE_CONTENT, 7));
    expect(turnSteps(fresh).map((step) => `${step.label}:${step.state}`)).toEqual([
      'Vote for first player:current',
      'Take starting resources:todo',
    ]);
    const state = seededBoard();
    state.status = 'finished';
    state.turn.phase = 'finished';
    expect(turnSteps(publicView(state))).toEqual([{ id: 'final', label: 'Final', state: 'current' }]);
    expect(describeStep(publicView(state))).toBe('Final');
  });
});
