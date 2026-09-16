import { describe, expect, it } from 'vitest';
import type { GameCommand } from '@seatgrab/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  beginEffect,
  createGame,
  getLegalActions,
  openPolicyPrompt,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'effects',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function activeState(seed = 41): GameState {
  const state = createGame(config, CORE_CONTENT, seed);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  return state;
}

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) throw new Error(`${result.response.code}: ${result.response.message}`);
  return result.state;
}

function putTrickInHand(state: GameState, playerId: string, cardId: string): void {
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture trick ${cardId} missing`);
  state.trickDeck.drawPile.splice(index, 1);
  state.players.find((player) => player.id === playerId)!.trickHand.push(cardId);
}

function removeNews(state: GameState, cardId: string): void {
  const index = state.newsDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture news ${cardId} missing`);
  state.newsDeck.drawPile.splice(index, 1);
}

describe('trick priority', () => {
  it('lets the first eligible responder block a trick before it resolves', () => {
    let state = activeState();
    putTrickInHand(state, 'p1', 'TRK006');
    putTrickInHand(state, 'p2', 'TRK004');
    state = accepted(state, 'p1', { type: 'PlayTrick', cardId: 'TRK006' });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p2'] });
    expect(getLegalActions(state, 'p2')).toEqual(['PlayReaction', 'PassPriority']);
    const interactionId = state.pendingInteraction!.id;
    state = accepted(state, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK004',
      targetEffectId: interactionId,
    });
    expect(state.pendingInteraction).toBeNull();
    expect(state.activeEffects.some((effect) => effect.sourceCardId === 'TRK006')).toBe(false);
    expect(state.trickDeck.discardPile).toEqual(expect.arrayContaining(['TRK004', 'TRK006']));
    assertGameState(state, CORE_CONTENT);
  });


  it('resolves a targetable trick only after responders pass in deterministic turn order', () => {
    let state = activeState();
    putTrickInHand(state, 'p1', 'TRK001');
    putTrickInHand(state, 'p2', 'TRK004');
    putTrickInHand(state, 'p3', 'TRK005');
    state = accepted(state, 'p1', { type: 'PlayTrick', cardId: 'TRK001' });
    const interactionId = state.pendingInteraction!.id;
    state = accepted(state, 'p2', { type: 'PassPriority', interactionId });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p3'] });
    state = accepted(state, 'p3', { type: 'PassPriority', interactionId });
    expect(state.pendingInteraction).toMatchObject({
      responsiblePlayerIds: ['p1'],
      sourceCardId: 'TRK001',
      continuation: { op: 'chaiOpponent', ownerId: 'p1' },
    });
  });
});

describe('news resolution and persistent effects', () => {
  it('drains queued news cards FIFO and advances only after the queue is empty', () => {
    let state = activeState(83);
    for (const cardId of ['NEWS015', 'NEWS012']) {
      const index = state.newsDeck.drawPile.indexOf(cardId);
      state.newsDeck.drawPile.splice(index, 1);
    }
    state.newsDeck.drawPile.unshift('NEWS015', 'NEWS012');
    const slot = CORE_CONTENT.board.slots.find((candidate) => candidate.volatile)!;
    state.newsQueue.push(
      { id: 'trigger-a', voterId: 'p1-voter-01', slotId: slot.slotId, voterOwnerId: 'p1', actorId: 'p1', turnOrdinal: state.turn.ordinal },
      { id: 'trigger-b', voterId: 'p1-voter-02', slotId: slot.slotId, voterOwnerId: 'p1', actorId: 'p1', turnOrdinal: state.turn.ordinal },
    );
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.newsQueue).toHaveLength(0);
    expect(state.activeEffects.slice(-2).map((effect) => effect.sourceCardId)).toEqual(['NEWS015', 'NEWS012']);
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    assertGameState(state, CORE_CONTENT);
  });

  it('suppresses only printed policy income and mirrors actual passive income', () => {
    let state = activeState(97);
    const retainedDefinitions = CORE_CONTENT.policyCards
      .filter((card) => card.answers[0].archetype === 'corporate')
      .slice(0, 2);
    for (const definition of retainedDefinitions) {
      const index = state.policyDeck.drawPile.indexOf(definition.id);
      if (index < 0) throw new Error(`retained fixture ${definition.id} missing`);
      state.policyDeck.drawPile.splice(index, 1);
      state.players[0]!.retainedPolicy.push({
        cardId: definition.id,
        answerIndex: 0,
        archetype: definition.answers[0].archetype,
      });
    }
    removeNews(state, 'NEWS015');
    removeNews(state, 'NEWS017');
    state.activeEffects.push(
      { id: 'it-raid', sourceCardId: 'NEWS015', ownerId: 'p1', kind: 'taxAudit', targetPlayerIds: ['p1'], targetZoneIds: [], remainingUses: 1, data: {} },
      { id: 'mansplain', sourceCardId: 'NEWS017', ownerId: 'p1', kind: 'echoChamber', targetPlayerIds: ['p2'], targetZoneIds: [], remainingUses: 1, data: {} },
    );
    state.turn.phase = 'beforeAnswer';
    openPolicyPrompt(state);
    const prompt = state.pendingInteraction;
    if (prompt?.kind !== 'policyAnswer') throw new Error('policy fixture did not open');
    const pendingDefinition = CORE_CONTENT.policyCards.find((card) => card.id === prompt.cardId)!;
    const answer = pendingDefinition.answers[0];
    const counts = { corporate: 0, nationalist: 0, populist: 0, reformer: 0 };
    for (const retained of state.players[0]!.retainedPolicy) counts[retained.archetype] += 1;
    counts[answer.archetype] += 1;
    const expectedPassive = {
      cash: Math.floor(counts.corporate / 2),
      influence: Math.floor(counts.nationalist / 2),
      press: Math.floor(counts.populist / 2),
      faith: Math.floor(counts.reformer / 2),
    };
    const beforeReserve = { ...state.publicReserve };
    state = accepted(state, 'p1', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    const p1 = state.players.find((player) => player.id === 'p1')!;
    const p2 = state.players.find((player) => player.id === 'p2')!;
    expect(p1.resources).toEqual(expectedPassive);
    expect(p2.resources).toEqual(expectedPassive);
    for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
      expect(state.publicReserve[resource]).toBe(beforeReserve[resource] - expectedPassive[resource] * 2);
    }
    expect(state.activeEffects.some((effect) => effect.id === 'it-raid' || effect.id === 'mansplain')).toBe(false);
    expect(state.newsDeck.discardPile).toEqual(expect.arrayContaining(['NEWS015', 'NEWS017']));
  });

  /**
   * Every physical card is executable, and the two decks answer an empty board
   * differently.
   *
   * This runs each handler against a bare opening state — nothing on the board, no open
   * effects, no rights anywhere — which is the hardest case for a fixed printed quantity.
   * A trick is chosen, so refusing the play is the right answer there (A16). A
   * news is dealt by a volatile area and cannot be declined, so it must never refuse:
   * a refusal propagates out of `beginNewsResolution` and fails the command that dealt
   * the card, and every retry fails the same way (A18). What neither may do is report an
   * unsupported handler, which is the original point of this test.
   */
  it('executes every non-reaction physical card handler, and never refuses a news', () => {
    for (const card of [...CORE_CONTENT.trickCards, ...CORE_CONTENT.newsCards]) {
      if (card.handlerId === 'trick.boomerang') continue;
      const state = activeState(card.id.charCodeAt(card.id.length - 1));
      const deck = card.deck === 'trick' ? state.trickDeck : state.newsDeck;
      const index = deck.drawPile.indexOf(card.id);
      if (index < 0) throw new Error(`handler fixture ${card.id} missing`);
      deck.drawPile.splice(index, 1);
      const slot = CORE_CONTENT.board.slots[0]!;
      const error = beginEffect(state, {
        ownerId: 'p1',
        card,
        trigger: { id: `trigger-${card.id}`, voterId: 'p1-voter-01', slotId: slot.slotId, voterOwnerId: 'p1', actorId: 'p1', turnOrdinal: state.turn.ordinal },
      }, CORE_CONTENT);
      expect(error ?? '', `${card.id} ${card.handlerId}`).not.toContain('Unsupported effect handler');
      if (card.deck === 'news') {
        expect(error, `${card.id} ${card.handlerId} refused a dealt news`).toBeNull();
      }
      if (!state.activeEffects.some((effect) => effect.sourceCardId === card.id)
          && !(state.pendingInteraction?.kind === 'choice' && state.pendingInteraction.sourceCardId === card.id)) {
        deck.discardPile.push(card.id);
      }
      expect(() => assertGameState(state, CORE_CONTENT), `${card.id} ${card.handlerId}`).not.toThrow();
    }
  });
});
