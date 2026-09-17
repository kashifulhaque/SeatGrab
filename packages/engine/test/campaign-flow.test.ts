import { describe, expect, it } from 'vitest';
import type { GameCommand } from '@gerrymander/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  createGame,
  getLegalActions,
  projectGame,
  serializeGame,
  loadGame,
  startAuction,
  startVote,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'campaign-flow',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function activeState(seed = 29): GameState {
  const state = createGame(config, CORE_CONTENT, seed);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  return state;
}

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) {
    throw new Error(`${result.response.code}: ${result.response.message}`);
  }
  return result.state;
}

function provision(state: GameState, playerId: string, resource: 'cash' | 'influence' | 'press' | 'faith', amount: number): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error('fixture player missing');
  state.publicReserve[resource] -= amount;
  player.resources[resource] += amount;
}

function takeNews(state: GameState, cardId: string): void {
  const index = state.newsDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture news ${cardId} missing`);
  state.newsDeck.drawPile.splice(index, 1);
}
function takeTrick(state: GameState): string {
  const cardId = state.trickDeck.drawPile.shift();
  if (cardId === undefined) throw new Error('fixture trick deck empty');
  return cardId;
}

describe('campaign interactions', () => {
  it('accepts a trade atomically, exposes it only to participants, and stacks cap cleanup', () => {
    let state = activeState();
    provision(state, 'p1', 'cash', 10);
    provision(state, 'p2', 'influence', 7);
    state = accepted(state, 'p1', {
      type: 'ProposeTrade',
      opponentId: 'p2',
      giveResources: { cash: 10, influence: 0, press: 0, faith: 0 },
      receiveResources: { cash: 0, influence: 1, press: 0, faith: 0 },
      giveTrickIds: [],
      receiveTrickIds: [],
    });
    const tradeId = state.tradeOffers[0]?.id;
    expect(tradeId).toBeDefined();
    expect(projectGame(state, { kind: 'player', playerId: 'p1' }, CORE_CONTENT).privateTradeOffers).toHaveLength(1);
    expect(projectGame(state, { kind: 'player', playerId: 'p3' }, CORE_CONTENT).privateTradeOffers).toHaveLength(0);
    expect(getLegalActions(state, 'p2')).toContain('AcceptTrade');

    state = accepted(state, 'p2', { type: 'AcceptTrade', tradeId: tradeId! });
    expect(state.tradeOffers).toHaveLength(0);
    expect(state.players.find((player) => player.id === 'p1')?.resources).toEqual({ cash: 0, influence: 1, press: 0, faith: 0 });
    expect(state.players.find((player) => player.id === 'p2')?.resources).toEqual({ cash: 10, influence: 6, press: 0, faith: 0 });
    expect(state.pendingInteraction).toMatchObject({ kind: 'capDiscard', playerId: 'p2', excess: 4 });

    state = accepted(state, 'p2', {
      type: 'DiscardExcessResources',
      resources: { cash: 4, influence: 0, press: 0, faith: 0 },
    });
    expect(state.pendingInteraction).toBeNull();
    expect(state.turn.phase).toBe('action');
    assertGameState(state, CORE_CONTENT);
  });

  it('restarts tied campaign votes and grants the prize only after a unique result', () => {
    let state = activeState();
    const prizeCardId = takeTrick(state);
    takeNews(state, 'NEWS016');
    startVote(state, 'NEWS016', prizeCardId, ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']);
    let interactionId = state.pendingInteraction?.id;
    if (interactionId === undefined) throw new Error('vote fixture did not open');
    expect(getLegalActions(state, 'p1')).toEqual(['SubmitVote']);
    state = accepted(state, 'p1', { type: 'SubmitVote', interactionId, optionId: 'p2' });
    state = accepted(state, 'p2', { type: 'SubmitVote', interactionId, optionId: 'p3' });
    state = accepted(state, 'p3', { type: 'SubmitVote', interactionId, optionId: 'p1' });
    expect(state.pendingInteraction).toMatchObject({ kind: 'choice', continuation: { round: 2, ballots: [] } });

    interactionId = state.pendingInteraction?.id;
    if (interactionId === undefined) throw new Error('tied vote fixture disappeared');
    state = accepted(state, 'p1', { type: 'SubmitVote', interactionId, optionId: 'p2' });
    state = accepted(state, 'p2', { type: 'SubmitVote', interactionId, optionId: 'p1' });
    state = accepted(state, 'p3', { type: 'SubmitVote', interactionId, optionId: 'p1' });
    expect(state.pendingInteraction).toBeNull();
    expect(state.players.find((player) => player.id === 'p1')?.trickHand).toContain(prizeCardId);
    expect(state.players.filter((player) => player.id !== 'p1').flatMap((player) => player.trickHand)).not.toContain(prizeCardId);
  });

  it('orders an auction after the seller, records debt, blocks purchases, and accepts partial payment', () => {
    let state = activeState();
    const cardId = takeTrick(state);
    takeNews(state, 'NEWS013');
    startAuction(state, 'NEWS013', 'p2', cardId, 2);
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p3'] });
    const interactionId = state.pendingInteraction?.id;
    if (interactionId === undefined) throw new Error('auction fixture did not open');
    expect(getLegalActions(state, 'p3')).toEqual(['PlaceBid', 'PassAuction']);
    state = accepted(state, 'p3', { type: 'PlaceBid', interactionId, amount: 5 });
    state = accepted(state, 'p1', { type: 'PassAuction', interactionId });
    expect(state.players.find((player) => player.id === 'p3')?.trickHand).toContain(cardId);
    const debt = state.players.find((player) => player.id === 'p3')?.debts[0];
    expect(debt).toMatchObject({ creditorPlayerId: 'p2', amount: 5 });

    state.turn.activePlayerId = 'p3';
    const purchase = applyCommand(state, { playerId: 'p3' }, {
      type: 'InfluenceVoterCard',
      cardId: state.voterDeck.market[0]!,
      payment: { resources: { cash: 0, influence: 0, press: 0, faith: 0 } },
    }, CORE_CONTENT);
    expect(purchase.ok).toBe(false);
    if (!purchase.ok) expect(purchase.response.code).toBe('PURCHASE_BLOCKED_BY_DEBT');

    provision(state, 'p3', 'cash', 5);
    state = accepted(state, 'p3', {
      type: 'PayDebt',
      debtId: debt!.id,
      payment: { cash: 3, influence: 0, press: 0, faith: 0 },
    });
    expect(state.players.find((player) => player.id === 'p3')?.debts[0]?.amount).toBe(2);
    state = accepted(state, 'p3', {
      type: 'PayDebt',
      debtId: debt!.id,
      payment: { cash: 2, influence: 0, press: 0, faith: 0 },
    });
    expect(state.players.find((player) => player.id === 'p3')?.debts).toHaveLength(0);
    expect(state.players.find((player) => player.id === 'p2')?.resources.cash).toBe(5);
  });

  it('round-trips a pending serializable continuation without changing legal actions', () => {
    const state = activeState(77);
    const prizeCardId = takeTrick(state);
    takeNews(state, 'NEWS016');
    startVote(state, 'NEWS016', prizeCardId, ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']);
    const restored = loadGame(serializeGame(state), CORE_CONTENT);
    expect(restored).toEqual(state);
    expect(getLegalActions(restored, 'p1')).toEqual(['SubmitVote']);
  });
});
