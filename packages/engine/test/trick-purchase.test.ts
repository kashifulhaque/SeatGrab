/**
 * Dirty Trick purchases: the face-down price, the deck, and the hand.
 *
 * Every trick carries a wholly generic back price of 4 or 5; the split is house rule R17.
 */
import { describe, expect, it } from 'vitest';
import { TRICK_CARDS, NEWS_CARDS, HOUSE_RULES } from '@gerrymander/content';
import type { Archetype, ResourceVector } from '@gerrymander/content';
import type { GameCommand } from '@gerrymander/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  createGame,
  projectGame,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'trick-purchase',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

const RESOURCES = ['cash', 'influence', 'press', 'faith'] as const;
const zero: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };

function activeState(seed = 77): GameState {
  const state = createGame(config, CORE_CONTENT, seed);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  return state;
}

function provision(state: GameState, playerId: string, resources: ResourceVector): void {
  const target = state.players.find((player) => player.id === playerId);
  if (target === undefined) throw new Error('fixture player missing');
  for (const resource of RESOURCES) {
    state.publicReserve[resource] -= resources[resource];
    target.resources[resource] += resources[resource];
  }
}

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) throw new Error(`${result.response.code}: ${result.response.message}`);
  return result.state;
}

function rejected(state: GameState, playerId: string, command: GameCommand, code: string): void {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.code).toBe(code);
  expect(result.state).toBe(state);
}

/** Retain enough Policy Cards to unlock an archetype's level-3 power. */
function unlock(state: GameState, playerId: string, archetype: Archetype, count: number): void {
  const target = state.players.find((player) => player.id === playerId);
  if (target === undefined) throw new Error('fixture player missing');
  for (let index = 0; index < count; index += 1) {
    const drawIndex = state.policyDeck.drawPile.findIndex((cardId) =>
      CORE_CONTENT.policyCards
        .find((card) => card.id === cardId)
        ?.answers.some((answer) => answer.archetype === archetype));
    const cardId = state.policyDeck.drawPile[drawIndex];
    const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId);
    if (drawIndex < 0 || cardId === undefined || card === undefined) {
      throw new Error('fixture policy card missing');
    }
    const answerIndex = card.answers[0].archetype === archetype ? 0 : 1;
    state.policyDeck.drawPile.splice(drawIndex, 1);
    target.retainedPolicy.push({ cardId, answerIndex, archetype });
  }
}

/** Put a known card on top of the draw pile, so a test can assert what was bought. */
function stackTop(state: GameState, cardId: string): void {
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture trick ${cardId} missing`);
  state.trickDeck.drawPile.splice(index, 1);
  state.trickDeck.drawPile.unshift(cardId);
}

function pay(resources: Partial<ResourceVector>): GameCommand {
  return {
    type: 'BuyTrick',
    payment: { resources: { ...zero, ...resources }, discounts: zero },
  };
}

describe('trick back costs', () => {
  it('prices all 20 cards, and nothing in the news deck', () => {
    expect(TRICK_CARDS).toHaveLength(20);
    for (const card of TRICK_CARDS) {
      expect(card.backCost, card.id).toBeDefined();
    }
    for (const card of NEWS_CARDS) {
      expect(card.backCost, card.id).toBeUndefined();
    }
  });

  it('is wholly generic', () => {
    for (const card of TRICK_CARDS) {
      for (const resource of RESOURCES) {
        expect(card.backCost?.[resource], `${card.id} ${resource}`).toBe(0);
      }
    }
  });

  it('charges 4 or 5 and uses both', () => {
    const values = TRICK_CARDS.map((card) => card.backCost?.generic);
    for (const value of values) {
      expect([4, 5]).toContain(value);
    }
    expect(new Set(values)).toEqual(new Set([4, 5]));
  });

  it('never makes a purchase strictly profitable', () => {
    // Cornerstone grants any 4 resources of the buyer's choice. At a price of 4 the
    // purchase would pay for itself and leave the card over, so every copy must cost more
    // than it grants. This is the one price that a rule, not taste, decides.
    const granted = 4;
    for (const card of TRICK_CARDS.filter((c) => c.handlerId === 'trick.cornerstone')) {
      expect(card.backCost?.generic, card.id).toBeGreaterThan(granted);
    }
  });

  it('splits the deck closely enough that the public price is not a tell', () => {
    // The price is face up while the card is face down. If almost every card shared one
    // figure, reading the numeral would identify the top of the pile. Neither figure may
    // take more than two thirds of the deck.
    const expensive = TRICK_CARDS.filter((card) => card.backCost?.generic === 5).length;
    expect(expensive).toBeGreaterThanOrEqual(TRICK_CARDS.length / 3);
    expect(expensive).toBeLessThanOrEqual((TRICK_CARDS.length * 2) / 3);
  });

  it('states the price split as a house rule', () => {
    const rule = HOUSE_RULES.find((entry) => entry.id === 'R17');
    expect(rule).toBeDefined();
    expect(rule?.ruling).toContain('Cornerstone');
  });
});

describe('buying the top trick', () => {
  it('takes the printed price and puts that exact card in the buyer’s hand', () => {
    let state = activeState();
    stackTop(state, 'TRK004'); // Veto, 4
    provision(state, 'p1', { ...zero, cash: 3, influence: 1 });

    state = accepted(state, 'p1', pay({ cash: 3, influence: 1 }));

    const buyer = state.players.find((player) => player.id === 'p1');
    expect(buyer?.trickHand).toEqual(['TRK004']);
    expect(buyer?.resources).toEqual(zero);
    expect(state.trickDeck.drawPile).not.toContain('TRK004');
    expect(state.trickDeck.drawPile).toHaveLength(19);
  });

  it('refuses a payment that is short of the price, and one that overpays', () => {
    const state = activeState();
    stackTop(state, 'TRK017'); // Cornerstone, 5
    provision(state, 'p1', { ...zero, cash: 6 });

    rejected(state, 'p1', pay({ cash: 4 }), 'INSUFFICIENT_RESOURCES');
    rejected(state, 'p1', pay({ cash: 6 }), 'INSUFFICIENT_RESOURCES');
    expect(accepted(state, 'p1', pay({ cash: 5 })).players[0]?.trickHand)
      .toEqual(['TRK017']);
  });

  it('accepts any mix of resources, because the price is generic', () => {
    let state = activeState();
    stackTop(state, 'TRK017'); // Cornerstone, 5
    provision(state, 'p1', { cash: 2, influence: 1, press: 1, faith: 1 });

    state = accepted(state, 'p1', pay({ cash: 2, influence: 1, press: 1, faith: 1 }));
    expect(state.players.find((player) => player.id === 'p1')?.trickHand)
      .toEqual(['TRK017']);
  });

  it('adds the Leaked Tapes surcharge to the price it charges and the price it shows', () => {
    const state = activeState();
    stackTop(state, 'TRK004'); // Veto, 4
    provision(state, 'p1', { ...zero, cash: 5 });
    // Leaked Tapes is a news, so its card has to leave the draw pile as the engine would
    // take it: an active effect and a card still waiting to be dealt is an invalid state.
    state.newsDeck.drawPile = state.newsDeck.drawPile.filter((id) => id !== 'NEWS007');
    state.activeEffects.push({
      id: 'e-leakedTapes',
      kind: 'leakedTapes',
      sourceCardId: 'NEWS007',
      ownerId: 'p1',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: {},
    } as GameState['activeEffects'][number]);

    const view = projectGame(state, { kind: 'player', playerId: 'p1' }, CORE_CONTENT);
    expect(view.trickMarket?.printed.generic).toBe(4);
    expect(view.trickMarket?.payable.generic).toBe(5);

    rejected(state, 'p1', pay({ cash: 4 }), 'INSUFFICIENT_RESOURCES');
    expect(accepted(state, 'p1', pay({ cash: 5 })).players[0]?.trickHand)
      .toEqual(['TRK004']);
  });

  it('lets Volunteers take resources off the price instead of spending them', () => {
    let state = activeState();
    stackTop(state, 'TRK017'); // Cornerstone, 5
    unlock(state, 'p1', 'reformer', 3); // level 3: two one-resource discounts per turn
    provision(state, 'p1', { ...zero, cash: 4 });

    // Two of the five units come off as discounts, so only three are actually paid.
    state = accepted(state, 'p1', {
      type: 'BuyTrick',
      payment: {
        resources: { ...zero, cash: 3 },
        discounts: { ...zero, cash: 2 },
      },
    });

    const buyer = state.players.find((player) => player.id === 'p1');
    expect(buyer?.trickHand).toEqual(['TRK017']);
    expect(buyer?.resources.cash).toBe(1);
    expect(state.turn.usage.volunteers).toBe(2);
  });

  it('refuses a discount larger than Volunteers allows', () => {
    const state = activeState();
    stackTop(state, 'TRK017');
    provision(state, 'p1', { ...zero, cash: 5 });

    // No reformer level, so no discount at all is available.
    rejected(state, 'p1', {
      type: 'BuyTrick',
      payment: { resources: { ...zero, cash: 4 }, discounts: { ...zero, cash: 1 } },
    }, 'INSUFFICIENT_RESOURCES');
  });

  it('lets an unpaid debt block the purchase', () => {
    const state = activeState();
    stackTop(state, 'TRK004');
    provision(state, 'p1', { ...zero, cash: 4 });
    state.players.find((player) => player.id === 'p1')!.debts.push({
      id: 'd1',
      creditorPlayerId: 'p2',
      amount: 2,
      reason: 'fixture',
    });

    rejected(state, 'p1', pay({ cash: 4 }), 'PURCHASE_BLOCKED_BY_DEBT');
  });

  it('refuses a purchase outside the buyer’s own action phase', () => {
    const state = activeState();
    stackTop(state, 'TRK004');
    provision(state, 'p2', { ...zero, cash: 4 });

    rejected(state, 'p2', pay({ cash: 4 }), 'WRONG_PHASE');
  });

  it('shows the price to every seat and the identity to none', () => {
    const state = activeState();
    stackTop(state, 'TRK009'); // Loyal Base, 5

    for (const viewer of [
      { kind: 'public' } as const,
      { kind: 'player', playerId: 'p1' } as const,
      { kind: 'player', playerId: 'p2' } as const,
    ]) {
      const view = projectGame(state, viewer, CORE_CONTENT);
      expect(view.trickMarket?.printed.generic).toBe(5);
      // The whole point of a face-down pile: the price travels, the card does not.
      expect(JSON.stringify(view)).not.toContain('TRK009');
      expect(JSON.stringify(view)).not.toContain('Loyal Base');
    }
  });

  it('reports no market once the draw pile is empty', () => {
    const state = activeState();
    state.trickDeck.drawPile = [];

    const view = projectGame(state, { kind: 'player', playerId: 'p1' }, CORE_CONTENT);
    expect(view.trickMarket).toBeUndefined();
    expect(view.deckCounts.trick).toBe(0);

    provision(state, 'p1', { ...zero, cash: 5 });
    rejected(state, 'p1', pay({ cash: 5 }), 'CONTENT_NOT_EXECUTABLE');
  });
});
