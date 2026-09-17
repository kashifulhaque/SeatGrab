/**
 * Two complete matches, played end to end through the real local adapter.
 *
 * Everything else in this suite proves a rule in isolation. This proves the thing no
 * isolated test can: that a match started from `createLocalMatch` can be carried, one
 * legal command at a time and reading nothing but each seat's own projection, all the
 * way to a finish that scores. Section 16's brief asks for one seeded three-player game
 * and one seeded five-player game; both are here, and between them they reach both of
 * the engine's two endings.
 *
 * The driver is `autoplay.ts`. It answers every question from the same derivations the
 * composers use, so a full game also exercises `actions.ts` against states no
 * hand-written fixture would think to build.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD } from '@seatgrab/content';
import { CORE_CONTENT, createGame, projectGame, type GameConfig, type GameState } from '@seatgrab/engine';
import type { PlayerView } from '@seatgrab/protocol';

import { createLocalMatch, createMemoryStore, type LocalMatchOptions } from '../src/local';
import { RESOURCE_ORDER, handCards } from '../src/app/actions';
import { summarizeResults, type MatchResults } from '../src/app/results';
import { autoplay, candidateCommands, type AutoplayResult } from './autoplay';
import { playComputers } from './computerPlay';

const PARTIES = ['kite', 'cog', 'sprout', 'lantern', 'compass'] as const;
const NAMES = ['Asha', 'Bikram', 'Chandni', 'Devi', 'Ejaz'] as const;

function config(matchId: string, playerCount: number): GameConfig {
  return {
    matchId,
    players: Array.from({ length: playerCount }, (_unused, index) => ({
      id: `p${index + 1}`,
      displayName: NAMES[index] ?? `Seat ${index + 1}`,
      partyId: PARTIES[index] ?? 'kite',
    })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

function options(): LocalMatchOptions {
  let tick = 0;
  return {
    store: createMemoryStore(),
    content: CORE_CONTENT,
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
  };
}

/** The last few commands, which is what a stalled run has to be read from. */
function transcript(result: AutoplayResult): string {
  return result.steps
    .slice(-8)
    .map((step) => `${step.seatId} ${step.command.type}${step.accepted ? '' : ` [${step.code}]`}`)
    .join('\n');
}

async function playOut(
  matchId: string,
  playerCount: number,
  seed: number,
  placement: 'concentrate' | 'spread',
): Promise<AutoplayResult> {
  const settings = config(matchId, playerCount);
  const match = await createLocalMatch(options(), settings, seed);
  return autoplay(match, settings.players.map((player) => player.id), { placement, maxSteps: 6000 });
}

/** `summarizeResults` answers `null` for a match that has not finished. */
function resultsOf(result: AutoplayResult): MatchResults {
  const summary = summarizeResults(result.view);
  if (summary === null) throw new Error('the match did not finish, so it has no results');
  return summary;
}

describe('a complete match', () => {
  // Seed 4021, not the 1717 it shared with the five-player game until Session 20. Teaching
  // the driver to buy and play tricks moves every trajectory, and under 1717 the
  // three seats no longer complete all nine majorities before the board fills. The ending
  // itself is not rarer: across ten sampled seeds at three players and `concentrate`, five
  // still reach `allMajorities`, so this is a seed that moved rather than a capability that
  // went away. The assertion is unchanged and was not weakened to fit.
  it('carries a seeded three-player game to every zone having a majority', async () => {
    const result = await playOut('full-3p', 3, 4021, 'concentrate');

    expect(result.stalled).toBeUndefined();
    expect(result.finished, transcript(result)).toBe(true);

    const view = result.view;
    expect(view.status).toBe('finished');
    expect(view.endReason).toBe('allMajorities');
    // Nine zones, every one of them decided: that is what this ending means.
    expect(view.zones.filter((zone) => zone.majorityOwnerId !== undefined)).toHaveLength(9);

    // The results screen reads this projection and nothing else, so it is derived here
    // rather than asserted against a literal.
    const results = resultsOf(result);
    expect(results.standings).toHaveLength(3);
    expect(results.winners.length).toBeGreaterThanOrEqual(1);
    expect(results.unresolvedZones).toHaveLength(0);

    // Every point on the board is a marked voter in a won zone, and the engine's own
    // score is the sum of them. A standing that did not add up would be a wrong number
    // on the screen a player reads last.
    const counted = results.standings.reduce((sum, standing) => sum + standing.score, 0);
    const marked = view.slots.filter((slot) => slot.voter?.majority === true).length;
    expect(counted).toBe(marked);
    for (const standing of results.standings) {
      expect(standing.score).toBe(view.finalScores?.[standing.player.id]);
    }
  }, 120_000);

  it('carries a seeded five-player game to the full-board final turns and scores it', async () => {
    const result = await playOut('full-5p', 5, 1717, 'spread');

    expect(result.stalled).toBeUndefined();
    expect(result.finished, transcript(result)).toBe(true);

    const view = result.view;
    expect(view.status).toBe('finished');
    expect(view.endReason).toBe('fullBoardFinalTurns');

    // This is the ending 0.4 recorded as never having been scored end to end: the board
    // filled before all nine majorities existed, so some zones are undecided and the
    // results screen has to say which.
    const results = resultsOf(result);
    expect(results.standings).toHaveLength(5);
    expect(results.unresolvedZones.length).toBeGreaterThan(0);
    expect(results.unresolvedZones.length).toBe(
      view.zones.filter((zone) => zone.majorityOwnerId === undefined).length,
    );

    const counted = results.standings.reduce((sum, standing) => sum + standing.score, 0);
    const marked = view.slots.filter((slot) => slot.voter?.majority === true).length;
    expect(counted).toBe(marked);
  }, 120_000);

  /**
   * A net under the whole loop, not a sample of it.
   *
   * These nine seeds are fixed, and every one of them is a match that finishes today
   * without a single refused command — so any refusal at all, anywhere in roughly three
   * thousand commands, is a regression rather than noise. Between them they run every
   * supported table size through both endings. They are cheap: the whole set is a couple
   * of seconds, because nothing here renders.
   */
  it.each([
    { players: 3, seed: 555, placement: 'concentrate' as const },
    { players: 3, seed: 1717, placement: 'concentrate' as const },
    { players: 4, seed: 555, placement: 'concentrate' as const },
    { players: 4, seed: 1717, placement: 'concentrate' as const },
    { players: 4, seed: 4021, placement: 'concentrate' as const },
    { players: 5, seed: 555, placement: 'spread' as const },
    { players: 5, seed: 1717, placement: 'spread' as const },
    { players: 5, seed: 4021, placement: 'spread' as const },
    { players: 5, seed: 9137, placement: 'spread' as const },
  ])('finishes cleanly: $players players, seed $seed', async ({ players, seed, placement }) => {
    const result = await playOut(`sweep-${players}-${seed}`, players, seed, placement);

    expect(result.stalled).toBeUndefined();
    expect(result.finished, transcript(result)).toBe(true);
    expect(result.steps.filter((step) => !step.accepted)).toEqual([]);
    expect(result.view.endReason).toBeDefined();

    // The trick half, reached by playing. Until Session 20 the driver never bought a
    // card, so purchases, the cards' own effects, the reaction window and the eight A18
    // trick guards were proven by hand-built fixtures and by nothing that had been
    // played. A match that bought none would pass every other assertion here in silence,
    // which is why the count is asserted rather than assumed.
    const accepted = result.steps.filter((step) => step.accepted);
    expect(accepted.filter((step) => step.command.type === 'BuyTrick').length)
      .toBeGreaterThan(0);
    expect(accepted.filter((step) => step.command.type === 'PlayTrick').length)
      .toBeGreaterThan(0);

    // Whichever ending arrived, the scores have to be the marked voters on the board.
    const summary = resultsOf(result);
    const marked = result.view.slots.filter((slot) => slot.voter?.majority === true).length;
    expect(summary.countedTotal).toBe(marked);
  }, 120_000);

  /**
   * The same net, under the three policies rather than under the autoplay driver.
   *
   * `autoplay.ts` is instrument code with an opinion about candidate order that the
   * sweeps depend on; the policies are shipped code with three different opinions. A
   * match one finishes cleanly is no evidence about the others, so this plays a table
   * of one seat per difficulty through `stepComputer` — the same function both drivers
   * call — and holds it to the same standard: every command accepted, and a scored end.
   */
  it('carries a seeded mixed-difficulty table to a scored ending', async () => {
    const seats = { p1: 'easy', p2: 'medium', p3: 'hard' } as const;
    const settings = config('full-mixed', 3);
    const match = await createLocalMatch(options(), settings, 4021);
    const result = await playComputers(match, seats);

    expect(result.stalled).toBeUndefined();
    expect(result.refusals).toEqual([]);
    expect(result.finished).toBe(true);
    expect(result.view.status).toBe('finished');
    expect(result.view.endReason).toBeDefined();

    const summary = summarizeResults(result.view);
    expect(summary).not.toBeNull();
    const marked = result.view.slots.filter((slot) => slot.voter?.majority === true).length;
    expect(summary!.countedTotal).toBe(marked);
    expect(summary!.winners.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

/**
 * The driver's own candidate ladder, where a seeded match cannot reach the state.
 *
 * `candidateCommands` is instrument code, not shipped code, but a defect in it hides
 * defects in what it measures — which is how Session 20's three long-standing refusals
 * survived three sessions. This is here for one case the seeds do not reach: Session 21's
 * mutation check found that restoring `if (card.blocked !== undefined) continue;` changed
 * nothing observable, because the driver plays a card as soon as it can and so never
 * holds the three Cornerstone the case needs.
 */
describe('the autoplay driver’s candidate ladder', () => {
  /**
   * p1 holding three Cornerstone, with an empty bank and a board it can convert.
   *
   * Built out of the real engine rather than a literal: the guards this asserts read the
   * projection, so a hand-written view would be free to be a state the engine cannot
   * reach. Resources are parked on a seat that is not acting rather than deleted, because
   * the engine reconciles every unit after each command.
   */
  function blockedFourPillars(): PlayerView {
    const state: GameState = createGame(config('ladder', 3), CORE_CONTENT, 31);
    state.status = 'active';
    state.turn.activePlayerId = 'p1';
    state.turn.order = ['p1', 'p2', 'p3'];
    state.turn.ordinal = 1;
    state.turn.phase = 'action';
    state.pendingInteraction = null;

    // An opponent's voters in the quiet areas, so the conversion has an 11-area zone.
    const quiet = CORE_BOARD.slots.filter((slot) => !slot.volatile).slice(0, 12);
    for (const slot of quiet) {
      const voter = state.voters.find(
        (candidate) => candidate.ownerId === 'p2' && candidate.location.kind === 'supply',
      );
      if (voter === undefined) throw new Error('p2 ran out of voters');
      voter.location = { kind: 'board', slotId: slot.slotId, majority: false };
      state.slots.find((candidate) => candidate.slotId === slot.slotId)!.voterId = voter.id;
    }

    for (const cardId of ['TRK017', 'TRK018', 'TRK019']) {
      const index = state.trickDeck.drawPile.indexOf(cardId);
      if (index < 0) throw new Error(`fixture trick ${cardId} is not in the draw pile`);
      state.trickDeck.drawPile.splice(index, 1);
      state.players.find((player) => player.id === 'p1')!.trickHand.push(cardId);
    }

    const parked = state.players.find((player) => player.id === 'p3')!;
    for (const resource of RESOURCE_ORDER) {
      parked.resources[resource] += state.publicReserve[resource];
      state.publicReserve[resource] = 0;
    }
    return projectGame(state, { kind: 'player', playerId: 'p1' }, CORE_CONTENT);
  }

  it('offers a trick’s mode even when its ordinary play is blocked', () => {
    const view = blockedFourPillars();
    const card = handCards(view, 'p1')[0];
    // The state the case needs: ordinary Cornerstone blocked, its conversion available.
    expect(card?.blocked).toContain('bank');
    expect(card?.mode?.available).toBe(true);

    const plays = candidateCommands(view, 'p1', {}).filter(
      (command) => command.type === 'PlayTrick',
    );
    // The mode is offered for each copy, and the ordinary play the composer blocked for
    // none of them. Before Session 21 `blocked` skipped the whole card, so this was empty
    // and the seat's one legal play was never tried.
    expect(plays).toEqual([
      { type: 'PlayTrick', cardId: 'TRK017', mode: 'triple' },
      { type: 'PlayTrick', cardId: 'TRK018', mode: 'triple' },
      { type: 'PlayTrick', cardId: 'TRK019', mode: 'triple' },
    ]);
  });
});
