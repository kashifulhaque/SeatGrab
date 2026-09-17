/**
 * The results derivations of section 13.11.
 *
 * Every case here drives the real engine to a real finish and projects a real
 * `PlayerView`. Nothing is asserted against a hand-built literal, so a change to the
 * projection contract or to how the engine scores a finished game fails in this file
 * rather than reaching the results screen as a wrong number.
 *
 * The distinction these tests exist to protect is the one a physical table gets wrong
 * most often: a voter standing in a zone scores nothing unless it was marked for that
 * zone's majority. The breakdown has to report both halves separately, and the totals
 * have to add up to the engine's own score and no more.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD } from '@gerrymander/content';
import { CORE_CONTENT, applyCommand, createGame, projectGame } from '@gerrymander/engine';
import type { GameConfig, GameState } from '@gerrymander/engine';
import type { PlayerView } from '@gerrymander/protocol';

import {
  describeWinners,
  rematchConfig,
  rematchSeats,
  summarizeResults,
} from '../src/app/results';

const config: GameConfig = {
  matchId: 'results-model',
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

function accepted(state: GameState, playerId: string, command: Parameters<typeof applyCommand>[2]): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) throw new Error(`command refused: ${result.response.message}`);
  return result.state;
}

/** Put one of `ownerId`'s supply voters on `slotId`, marked or not. */
function place(state: GameState, ownerId: string, slotId: string, majority: boolean): void {
  const voter = state.voters.find(
    (candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply',
  );
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (voter === undefined || slot === undefined) throw new Error('results fixture underflow');
  voter.location = { kind: 'board', slotId, majority };
  slot.voterId = voter.id;
}

/**
 * A match finished the ordinary way: every zone carries exactly its majority.
 *
 * `owners` assigns the zones round-robin, and `surplus` adds unmarked voters on top so
 * the breakdown has something that did not count to report.
 */
function finishedGame(
  owners: readonly string[],
  surplus: readonly { ownerId: string; zoneId: string; count: number }[] = [],
): GameState {
  let state = createGame(config, CORE_CONTENT, 79);
  state.status = 'active';
  state.turn.activePlayerId = 'p2';
  state.turn.phase = 'action';
  state.pendingInteraction = null;

  for (let index = 0; index < CORE_BOARD.zones.length; index += 1) {
    const zone = CORE_BOARD.zones[index]!;
    const ownerId = owners[index % owners.length]!;
    const zoneSlots = CORE_BOARD.slots.filter((slot) => slot.zoneId === zone.id);
    for (let taken = 0; taken < zone.majorityThreshold; taken += 1) {
      place(state, ownerId, zoneSlots[taken]!.slotId, true);
    }
    const extra = surplus.filter((entry) => entry.zoneId === zone.id);
    let next = zone.majorityThreshold;
    for (const entry of extra) {
      for (let placed = 0; placed < entry.count; placed += 1) {
        place(state, entry.ownerId, zoneSlots[next]!.slotId, false);
        next += 1;
      }
    }
  }

  state = accepted(state, 'p2', { type: 'RequestEndTurn' });
  if (state.status !== 'finished') throw new Error('fixture did not finish the match');
  return state;
}

describe('summarizeResults', () => {
  it('returns null while the match is still live', () => {
    const state = createGame(config, CORE_CONTENT, 5);
    expect(summarizeResults(publicView(state))).toBeNull();
  });

  it('reports the engine score, not a recount, and ranks the seats by it', () => {
    const state = finishedGame(['p1', 'p2', 'p3']);
    const view = publicView(state);
    const results = summarizeResults(view)!;

    expect(view.finalScores).toEqual({ p1: 21, p2: 27, p3: 21 });
    expect(results.standings.map((standing) => [standing.player.id, standing.score])).toEqual([
      ['p2', 27],
      ['p1', 21],
      ['p3', 21],
    ]);
    // Standard competition ranking: the two seats level on 21 share second place.
    expect(results.standings.map((standing) => standing.rank)).toEqual([1, 2, 2]);
    expect(results.countedTotal).toBe(21 + 27 + 21);
  });

  it('names the winner the engine named, and says why the match ended', () => {
    const results = summarizeResults(publicView(finishedGame(['p1', 'p2', 'p3'])))!;

    expect(results.winners.map((player) => player.id)).toEqual(['p2']);
    expect(results.jointWinners).toBe(false);
    expect(results.reason).toBe('allMajorities');
    expect(results.reasonSentence).toContain('Every zone had a majority');
    expect(describeWinners(results)).toBe('Bikram wins on 27 majority voters.');
  });

  it('supports joint winners and says the tie policy applied', () => {
    // The nine thresholds are 6, 11, 6, 9, 5, 9, 6, 11, 6 in board order, which splits
    // into three groups of 23: the northern three, the middle three, the southern three.
    const results = summarizeResults(publicView(
      finishedGame(['p1', 'p1', 'p1', 'p2', 'p2', 'p2', 'p3', 'p3', 'p3']),
    ))!;

    expect(new Set(results.standings.map((standing) => standing.score))).toEqual(new Set([23]));
    expect(results.jointWinners).toBe(true);
    expect(results.winners.map((player) => player.displayName).sort()).toEqual([
      'Asha',
      'Bikram',
      'Chandni',
    ]);
    expect(results.standings.every((standing) => standing.rank === 1)).toBe(true);
    expect(describeWinners(results)).toContain('win together');
    expect(results.tiePolicySentence).toContain('joint winners');
    expect(results.tiePolicySentence).toContain('that is what happened');
  });

  it('separates the voters that scored from the voters that did not', () => {
    const state = finishedGame(['p1', 'p2', 'p3'], [
      { ownerId: 'p3', zoneId: 'northWest', count: 4 },
      { ownerId: 'p1', zoneId: 'north', count: 2 },
    ]);
    const view = publicView(state);
    const results = summarizeResults(view)!;

    const northWest = results.zones.find((zone) => zone.id === 'northWest')!;
    expect(northWest.majorityOwner?.displayName).toBe('Asha');
    expect(northWest.majorityOwner?.counted).toBe(northWest.majorityThreshold);
    const chandni = northWest.holdings.find((holding) => holding.playerId === 'p3')!;
    expect(chandni.counted).toBe(0);
    expect(chandni.surplus).toBe(4);
    expect(northWest.surplusTotal).toBe(4);
    expect(northWest.filled).toBe(northWest.majorityThreshold + 4);

    // Surplus is reported, never added to a score.
    expect(results.surplusTotal).toBe(6);
    expect(results.standings.find((s) => s.player.id === 'p3')!.surplusVoters).toBe(4);
    expect(results.standings.find((s) => s.player.id === 'p3')!.score)
      .toBe(view.finalScores!['p3']);
    expect(results.standings.find((s) => s.player.id === 'p1')!.boardVoters)
      .toBe(view.finalScores!['p1']! + 2);
  });

  it('gives every zone a sentence naming what counted and what did not', () => {
    const results = summarizeResults(publicView(
      finishedGame(['p1', 'p2', 'p3'], [{ ownerId: 'p2', zoneId: 'northWest', count: 3 }]),
    ))!;
    const northWest = results.zones.find((zone) => zone.id === 'northWest')!;

    expect(northWest.spoken).toContain('majority Asha');
    expect(northWest.spoken).toContain('Bikram scored 0, 3 did not count');
  });

  it('records zones with no majority, and scores nothing in them', () => {
    // A finished match always has nine majorities, so an unresolved zone can only come
    // from the other ending. This asserts the reporting path rather than that ending.
    const state = finishedGame(['p1', 'p2', 'p3']);
    const view = publicView(state);
    expect(summarizeResults(view)!.unresolvedZones).toEqual([]);

    // `exactOptionalPropertyTypes` is on, so an absent majority owner is an absent key.
    const stripped: PlayerView = {
      ...view,
      zones: view.zones.map((zone, index) => {
        if (index !== 0) return zone;
        const { majorityOwnerId: _unresolved, ...rest } = zone;
        return rest;
      }),
    };
    const results = summarizeResults(stripped)!;
    expect(results.unresolvedZones).toEqual([view.zones[0]!.displayName]);
    expect(results.zones[0]!.majorityOwner).toBeNull();
  });

  it('claims no end reason when the projection carries none', () => {
    const view = publicView(finishedGame(['p1', 'p2', 'p3']));
    const { endReason: _dropped, ...withoutReason } = view;
    const results = summarizeResults(withoutReason as PlayerView)!;

    expect(results.reason).toBeNull();
    expect(results.reasonSentence).toContain('no end reason');
  });
});

describe('rematch', () => {
  it('preserves the seats, the order, the parties, the filters and the tie policy', () => {
    const view = publicView(finishedGame(['p1', 'p2', 'p3']));
    const next = rematchConfig(view, 'local-rematch');

    expect(next.matchId).toBe('local-rematch');
    expect(next.players).toEqual([
      { id: 'p1', displayName: 'Asha', partyId: 'kite', controller: 'human' },
      { id: 'p2', displayName: 'Bikram', partyId: 'cog', controller: 'human' },
      { id: 'p3', displayName: 'Chandni', partyId: 'sprout', controller: 'human' },
    ]);
    expect(next.contentAdvisories).toEqual(['trigger']);
    expect(next.tiePolicy).toBe('jointWinners');
    expect(rematchSeats(view).map((seat) => seat.seat)).toEqual([0, 1, 2]);
  });

  it('carries no board, score or resource across, and reshuffles on a new seed', () => {
    const finished = finishedGame(['p1', 'p2', 'p3']);
    const next = createGame(rematchConfig(publicView(finished), 'local-rematch'), CORE_CONTENT, 4242);

    expect(next.status).toBe('setup');
    expect(next.endgame.finalScores).toBeUndefined();
    expect(next.slots.every((slot) => slot.voterId === null)).toBe(true);
    expect(next.voters.every((voter) => voter.location.kind === 'supply')).toBe(true);
    // A different seed is a different shuffle, which is what "fresh shuffle" has to mean.
    const same = createGame(rematchConfig(publicView(finished), 'local-rematch'), CORE_CONTENT, 79);
    expect(next.policyDeck.drawPile).not.toEqual(same.policyDeck.drawPile);
  });
});
