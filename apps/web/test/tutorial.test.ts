/**
 * The tutorial's model: the table it starts, and which lesson it offers when.
 *
 * The lessons are predicates over a projected `PlayerView`, so they are tested against
 * real projections from the real engine rather than against hand-built literals. That is
 * the point of the design: a change to the projection contract that a lesson reads —
 * `pendingVoterGroups`, `policyCounts`, `rightsOwnerId` — fails here rather than showing
 * a first-time player the wrong rule.
 *
 * What is asserted is the teaching order and the two ways a lesson ends:
 *
 * - The opening lesson is offered first, and is finished by reading it.
 * - A lesson whose moment has not come is passed over, so a rule that never comes up in a
 *   match never interrupts a turn to explain itself.
 * - A lesson with a `done` is finished by the board rather than by the reader: buying a
 *   card retires the market lesson whether or not the player pressed anything on it.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD } from '@seatgrab/content';
import { CORE_CONTENT, createGame, projectGame } from '@seatgrab/engine';
import type { GameConfig, GameState } from '@seatgrab/engine';
import type { PlayerView } from '@seatgrab/protocol';

import { createLocalMatch, createMemoryStore, randomSeed } from '../src/local';
import { toGameConfig, validateSetup } from '../src/app/setup';
import {
  TUTORIAL_LESSONS,
  TUTORIAL_MATCH_PREFIX,
  isTutorialMatchId,
  lessonsCompleted,
  newTutorialMatchId,
  nextLesson,
  tutorialFacts,
  tutorialSetupDraft,
} from '../src/app/tutorial';

const ME = 'p1';

const config: GameConfig = {
  matchId: 'tutorial-model',
  players: [
    { id: 'p1', displayName: 'You', partyId: 'kite' },
    { id: 'p2', displayName: 'Computer 1', partyId: 'cog', controller: 'computer', difficulty: 'easy' },
    { id: 'p3', displayName: 'Computer 2', partyId: 'sprout', controller: 'computer', difficulty: 'easy' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function seatView(state: GameState): PlayerView {
  return projectGame(state, { kind: 'player', playerId: ME }, CORE_CONTENT);
}

/** A fresh match, still electing a first player. */
function opening(): GameState {
  return createGame(config, CORE_CONTENT, 17);
}

/**
 * The player's own action phase, with nothing bought and nothing on the board.
 *
 * `funded` says whether the seat holds enough to buy from the market, because the market
 * lesson waits until something in it is within reach. Both cases are real: a turn where
 * nothing is affordable is an ordinary turn, not a stuck one.
 */
function myActionPhase(funded = true): GameState {
  const state = opening();
  state.status = 'active';
  state.turn.activePlayerId = ME;
  state.turn.order = ['p1', 'p2', 'p3'];
  state.turn.ordinal = 1;
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  state.interactionStack = [];
  if (funded) {
    const me = state.players.find((player) => player.id === ME)!;
    for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
      me.resources[resource] = 3;
      state.publicReserve[resource] -= 3;
    }
  }
  return state;
}

/** Stand `count` voters of `ownerId` in North West, marking them for the majority or not. */
function place(state: GameState, ownerId: string, count: number, majority: boolean): void {
  const free = CORE_BOARD.slots
    .filter((slot) => slot.zoneId === 'northWest')
    .filter((slot) => state.slots.find((entry) => entry.slotId === slot.slotId)?.voterId == null);
  for (let index = 0; index < count; index += 1) {
    const slot = free[index]!;
    const voter = state.voters.find(
      (candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply',
    )!;
    voter.location = { kind: 'board', slotId: slot.slotId, majority };
    state.slots.find((candidate) => candidate.slotId === slot.slotId)!.voterId = voter.id;
  }
}

const NOTHING_READ: ReadonlySet<string> = new Set();

describe('the tutorial table', () => {
  it('seats one person and two Easy computers, and is valid without editing', () => {
    const draft = tutorialSetupDraft();
    expect(validateSetup(draft)).toEqual([]);
    expect(draft.seats).toHaveLength(3);
    expect(draft.seats.filter((seat) => seat.controller === 'human')).toHaveLength(1);
    expect(draft.seats[0]!.displayName).toBe('You');
    for (const seat of draft.seats.slice(1)) {
      expect(seat.controller).toBe('computer');
      expect(seat.difficulty).toBe('easy');
    }
    expect(new Set(draft.seats.map((seat) => seat.partyId)).size).toBe(3);
  });

  it('starts a real local match that the engine and the store both accept', async () => {
    const store = createMemoryStore();
    const matchId = newTutorialMatchId(new Date(Date.UTC(2026, 0, 1)), 0.5);
    const match = await createLocalMatch(
      { store, content: CORE_CONTENT },
      toGameConfig(tutorialSetupDraft(), matchId),
      randomSeed(),
    );
    expect(match.matchId).toBe(matchId);
    expect(isTutorialMatchId(match.matchId)).toBe(true);
    expect(match.viewFor({ kind: 'public' }).view.players).toHaveLength(3);
  });
});

describe('recognizing a tutorial match', () => {
  it('reads the prefix and nothing else', () => {
    expect(isTutorialMatchId(`${TUTORIAL_MATCH_PREFIX}abc-0001`)).toBe(true);
    expect(isTutorialMatchId('local-abc-0001')).toBe(false);
    expect(isTutorialMatchId('')).toBe(false);
  });

  it('gives two matches created in the same millisecond different identifiers', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    expect(newTutorialMatchId(now, 0.1)).not.toBe(newTutorialMatchId(now, 0.9));
  });
});

describe('choosing the lesson to show', () => {
  it('opens on the goal, and retires it once the reader marks it read', () => {
    const facts = tutorialFacts(seatView(opening()), ME);

    expect(nextLesson(facts, NOTHING_READ)?.lesson.id).toBe('goal');
    expect(lessonsCompleted(facts, NOTHING_READ)).toBe(0);

    const read = new Set(['goal']);
    expect(nextLesson(facts, read)?.lesson.id).toBe('firstPlayer');
    expect(lessonsCompleted(facts, read)).toBe(1);
  });

  it('teaches each setup prompt at the prompt, and passes over both once setup is done', () => {
    const vote = tutorialFacts(seatView(opening()), ME);
    expect(vote.promptKind).toBe('firstPlayerVote');
    expect(nextLesson(vote, new Set(['goal']))?.lesson.id).toBe('firstPlayer');

    // Past setup, both setup lessons are behind the player whether or not they were read.
    const acting = tutorialFacts(seatView(myActionPhase()), ME);
    const after = nextLesson(acting, new Set(['goal']));
    expect(after?.lesson.id).not.toBe('firstPlayer');
    expect(after?.lesson.id).not.toBe('startingResources');
  });

  it('asks for a purchase on a free action phase, and stops asking once voters are waiting', () => {
    const state = myActionPhase();
    const read = new Set(['goal']);
    expect(nextLesson(tutorialFacts(seatView(state), ME), read)?.lesson.id).toBe('buy');

    // A bought card puts a group in front of the player, which is the placement lesson.
    const mine = state.voters
      .filter((voter) => voter.ownerId === ME && voter.location.kind === 'supply')
      .slice(0, 2);
    for (const voter of mine) voter.location = { kind: 'pending', groupId: 'group-1' };
    state.pendingVoterGroups.push({
      id: 'group-1',
      ownerId: ME,
      controllerId: ME,
      voterIds: mine.map((voter) => voter.id),
      origin: { kind: 'voterCard', cardId: state.voterDeck.market[0]! },
      sameZone: true,
      deadlineTurnOrdinal: state.turn.ordinal,
    });
    const waiting = tutorialFacts(seatView(state), ME);
    expect(waiting.votersToPlace).toBe(2);
    expect(nextLesson(waiting, read)?.lesson.id).toBe('place');
  });

  it('moves on to ending the turn when nothing in the market is within reach', () => {
    const broke = tutorialFacts(seatView(myActionPhase(false)), ME);
    expect(broke.canBuyVoters).toBe(false);
    expect(nextLesson(broke, new Set(['goal']))?.lesson.id).toBe('endTurn');
  });

  it('retires the market lesson from the board rather than from a button', () => {
    const state = myActionPhase();
    place(state, ME, 3, false);
    const facts = tutorialFacts(seatView(state), ME);

    expect(facts.votersOnBoard).toBe(3);
    // Nothing has been read, yet neither the market nor the placement lesson is offered.
    const offered = nextLesson(facts, NOTHING_READ);
    expect(offered?.lesson.id).toBe('goal');
    expect(nextLesson(facts, new Set(['goal']))?.lesson.id).toBe('endTurn');
  });

  it('teaches redistricting only where the player holds the rights', () => {
    const state = myActionPhase();
    place(state, ME, 3, false);
    const read = new Set(['goal', 'endTurn']);
    expect(tutorialFacts(seatView(state), ME).rightsZones).toBe(1);
    expect(nextLesson(tutorialFacts(seatView(state), ME), read)?.lesson.id).toBe('redistricting');

    // A rival with more voters in the same zone holds the rights instead, so the lesson
    // waits rather than explaining a control the player does not have.
    place(state, 'p2', 4, false);
    const outnumbered = tutorialFacts(seatView(state), ME);
    expect(outnumbered.rightsZones).toBe(0);
    expect(nextLesson(outnumbered, read)?.lesson.id).not.toBe('redistricting');
  });

  it('closes with the scoring lesson when the match is over', () => {
    const state = myActionPhase();
    state.status = 'finished';
    state.turn.phase = 'finished';
    const facts = tutorialFacts(seatView(state), ME);

    expect(facts.finished).toBe(true);
    const read = new Set(TUTORIAL_LESSONS.map((lesson) => lesson.id).filter((id) => id !== 'finished'));
    expect(nextLesson(facts, read)?.lesson.id).toBe('finished');
  });

  it('offers nothing once every lesson is behind the player', () => {
    const facts = tutorialFacts(seatView(myActionPhase()), ME);
    const read = new Set(TUTORIAL_LESSONS.map((lesson) => lesson.id));
    expect(nextLesson(facts, read)).toBeNull();
    expect(lessonsCompleted(facts, read)).toBe(TUTORIAL_LESSONS.length);
  });
});

describe('the lessons themselves', () => {
  it('carry distinct identifiers and say something', () => {
    const ids = TUTORIAL_LESSONS.map((lesson) => lesson.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lesson of TUTORIAL_LESSONS) {
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(lesson.body.length).toBeGreaterThan(0);
    }
  });
});
