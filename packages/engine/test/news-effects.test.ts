import { describe, expect, it } from 'vitest';
import type { Cost, Archetype, ResourceVector } from '@gerrymander/content';
import type { ChoiceSelection, GameCommand } from '@gerrymander/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  createGame,
  loadGame,
  serializeGame,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'news-effects',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

const zero: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };

function activeState(seed = 201): GameState {
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

function rejected(state: GameState, playerId: string, command: GameCommand, code: string): void {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.code).toBe(code);
  expect(result.state).toBe(state);
}

function roundTripPending(state: GameState): GameState {
  expect(state.pendingInteraction).not.toBeNull();
  const restored = loadGame(serializeGame(state), CORE_CONTENT);
  expect(restored).toEqual(state);
  return restored;
}

function choose(state: GameState, playerId: string, selection: ChoiceSelection): GameState {
  const restored = roundTripPending(state);
  const interactionId = restored.pendingInteraction?.id;
  if (interactionId === undefined) throw new Error('fixture choice disappeared');
  return accepted(restored, playerId, { type: 'SubmitChoice', interactionId, selection });
}

function discardCap(state: GameState, playerId: string, resources: ResourceVector): GameState {
  const restored = roundTripPending(state);
  return accepted(restored, playerId, { type: 'DiscardExcessResources', resources });
}

function player(state: GameState, playerId: string) {
  const found = state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`fixture player ${playerId} missing`);
  return found;
}

function provision(state: GameState, playerId: string, resources: ResourceVector): void {
  const target = player(state, playerId);
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    state.publicReserve[resource] -= resources[resource];
    target.resources[resource] += resources[resource];
  }
}

function retain(state: GameState, playerId: string, archetype: Archetype): string {
  const drawIndex = state.policyDeck.drawPile.findIndex((cardId) =>
    CORE_CONTENT.policyCards
      .find((card) => card.id === cardId)
      ?.answers.some((answer) => answer.archetype === archetype));
  const cardId = state.policyDeck.drawPile[drawIndex];
  const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId);
  const answerIndex = card?.answers.findIndex((answer) => answer.archetype === archetype);
  if (drawIndex < 0 || cardId === undefined || card === undefined || (answerIndex !== 0 && answerIndex !== 1)) {
    throw new Error(`fixture ${archetype} policy card missing`);
  }
  state.policyDeck.drawPile.splice(drawIndex, 1);
  player(state, playerId).retainedPolicy.push({ cardId, answerIndex, archetype });
  return cardId;
}

function unlock(state: GameState, playerId: string, archetype: Archetype): void {
  for (let index = 0; index < 3; index += 1) retain(state, playerId, archetype);
}

function slotsIn(zoneId: string, volatile?: boolean): string[] {
  return CORE_CONTENT.board.slots
    .filter((slot) => slot.zoneId === zoneId && (volatile === undefined || slot.volatile === volatile))
    .map((slot) => slot.slotId);
}

function placeVoter(state: GameState, ownerId: string, slotId: string, majority = false): string {
  const voter = state.voters.find((candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply');
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (voter === undefined || slot === undefined || slot.voterId !== null) throw new Error(`fixture slot ${slotId} unavailable`);
  voter.location = { kind: 'board', slotId, majority };
  slot.voterId = voter.id;
  return voter.id;
}

// Majorities are built out of ordinary areas. A volatile one would let a card that may
// not touch volatile areas fail for a reason the test is not about, and which areas are
// volatile is the map's business, not this fixture's.
function formMajority(state: GameState, ownerId: string, zoneId: string): string[] {
  const zone = CORE_CONTENT.board.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) throw new Error(`fixture zone ${zoneId} missing`);
  return slotsIn(zoneId, false).slice(0, zone.majorityThreshold)
    .map((slotId) => placeVoter(state, ownerId, slotId, true));
}

function putNewsOnTop(state: GameState, cardIds: string[]): void {
  for (const cardId of cardIds) {
    const index = state.newsDeck.drawPile.indexOf(cardId);
    if (index < 0) throw new Error(`fixture news ${cardId} missing`);
    state.newsDeck.drawPile.splice(index, 1);
  }
  state.newsDeck.drawPile.unshift(...cardIds);
}

function queueNews(state: GameState, cardIds: string[], ownerId: string, slotId: string): string {
  putNewsOnTop(state, cardIds);
  const voterId = placeVoter(state, ownerId, slotId);
  state.newsQueue.push({
    id: `fixture-trigger-${state.nextSequence}`,
    voterId,
    slotId,
    voterOwnerId: ownerId,
    actorId: 'p1',
    turnOrdinal: state.turn.ordinal,
  });
  state.nextSequence += 1;
  return voterId;
}

function answerCurrent(state: GameState): GameState {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'policyAnswer') throw new Error('fixture policy prompt missing');
  return accepted(state, interaction.playerId, { type: 'CommitPolicyAnswer', answerIndex: 0 });
}

function advanceToAction(state: GameState, targetPlayerId: string): GameState {
  for (let steps = 0; steps < 12; steps += 1) {
    if (state.turn.activePlayerId === targetPlayerId && state.turn.phase === 'action') return state;
    if (state.turn.phase === 'policyAnswer') {
      state = answerCurrent(state);
    } else if (state.turn.phase === 'action' && state.turn.activePlayerId !== null) {
      state = accepted(state, state.turn.activePlayerId, { type: 'RequestEndTurn' });
    } else {
      throw new Error(`cannot advance fixture from ${state.turn.phase}`);
    }
  }
  throw new Error(`fixture did not reach ${targetPlayerId}'s action phase`);
}

function paymentFor(cost: Cost): ResourceVector {
  return {
    cash: cost.cash + cost.generic,
    influence: cost.influence,
    press: cost.press,
    faith: cost.faith,
  };
}

function putVoterCardInMarket(state: GameState, voters: 1 | 2 | 3): string {
  const definition = CORE_CONTENT.voterCards.find((card) =>
    card.voters === voters && (state.voterDeck.market.includes(card.id) || state.voterDeck.drawPile.includes(card.id)));
  if (definition === undefined) throw new Error('fixture voter card missing');
  if (state.voterDeck.market.includes(definition.id)) return definition.id;
  const drawIndex = state.voterDeck.drawPile.indexOf(definition.id);
  const displaced = state.voterDeck.market[0];
  if (drawIndex < 0 || displaced === undefined) throw new Error('fixture voter market unavailable');
  state.voterDeck.drawPile.splice(drawIndex, 1, displaced);
  state.voterDeck.market[0] = definition.id;
  return definition.id;
}

function drawnVoterCard(state: GameState, voters: 1 | 2 | 3): string {
  const cardId = state.voterDeck.drawPile.find((candidate) =>
    CORE_CONTENT.voterCards.find((card) => card.id === candidate)?.voters === voters);
  if (cardId === undefined) throw new Error(`fixture ${voters}-voter draw card missing`);
  return cardId;
}

function putVoterCardsOnTop(state: GameState, cardIds: string[]): void {
  for (const cardId of cardIds) {
    const index = state.voterDeck.drawPile.indexOf(cardId);
    if (index < 0) throw new Error(`fixture voter card ${cardId} missing from draw pile`);
    state.voterDeck.drawPile.splice(index, 1);
  }
  state.voterDeck.drawPile.unshift(...cardIds);
}

function stable(state: GameState): void {
  assertGameState(state, CORE_CONTENT);
}

describe('news behavior, cards 001-010', () => {
  it('Great Leader relocates one voter per influenced three-voter card before ending the turn', () => {
    let state = activeState();
    queueNews(state, ['NEWS001'], 'p1', slotsIn('central', true)[0]!);
    const sourceSlotId = slotsIn('northWest', false)[0]!;
    const destinationSlotId = slotsIn('north', false)[0]!;
    const movedVoterId = placeVoter(state, 'p1', sourceSlotId);
    const voterCardId = putVoterCardInMarket(state, 3);
    const voterCard = CORE_CONTENT.voterCards.find((card) => card.id === voterCardId)!;
    const payment = paymentFor(voterCard.cost);
    provision(state, 'p1', payment);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'brainDrain', ownerId: 'p1' }));
    state = advanceToAction(state, 'p1');
    state = accepted(state, 'p1', { type: 'InfluenceVoterCard', cardId: voterCardId, payment: { resources: payment } });
    const group = state.pendingVoterGroups.find((candidate) => candidate.origin.kind === 'voterCard' && candidate.origin.cardId === voterCardId)!;
    state = accepted(state, 'p1', { type: 'PlaceVoterGroup', groupId: group.id, slotIds: slotsIn('southEast', false).slice(0, 3) });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p2'], continuation: { op: 'greatLeaderMove', remaining: 1 } });
    state = choose(state, 'p2', { kind: 'slots', slotIds: [sourceSlotId, destinationSlotId] });

    expect(state.voters.find((voter) => voter.id === movedVoterId)?.location).toMatchObject({ kind: 'board', slotId: destinationSlotId });
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    stable(state);
  });

  it('Dosti remains available when its target owns the ending turn, then expires after that target’s next turn', () => {
    let state = activeState(202);
    queueNews(state, ['NEWS002'], 'p2', slotsIn('central', true)[0]!);
    placeVoter(state, 'p2', slotsIn('northWest', false)[0]!);
    placeVoter(state, 'p2', slotsIn('northWest', false)[1]!);
    const sourceSlotId = slotsIn('north', false)[0]!;
    const destinationSlotId = slotsIn('west', false)[0]!;
    const movedVoterId = placeVoter(state, 'p1', sourceSlotId);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p2', { kind: 'players', playerIds: ['p1'] });
    state = advanceToAction(state, 'p1');
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'guestEditor', ownerId: 'p2', targetPlayerIds: ['p1'] }));
    state = accepted(state, 'p1', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: movedVoterId,
      destinationSlotId,
    });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.activeEffects.some((effect) => effect.kind === 'guestEditor')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS002');
    stable(state);
  });

  it('Nero moves three voters out of the trigger zone and queues a new volatile news', () => {
    let state = activeState(203);
    queueNews(state, ['NEWS003', 'NEWS007'], 'p1', slotsIn('northWest', true)[0]!);
    const sources = slotsIn('northWest', false).slice(0, 3);
    const voterIds = sources.map((slotId) => placeVoter(state, 'p2', slotId));
    const destinations = [slotsIn('north', false)[0]!, slotsIn('north', false)[1]!, slotsIn('northEast', true)[0]!];

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', {
      kind: 'slots',
      slotIds: sources.flatMap((source, index) => [source, destinations[index]!]),
    });

    expect(voterIds.map((voterId) => state.voters.find((voter) => voter.id === voterId)?.location)).toEqual(
      destinations.map((slotId) => expect.objectContaining({ kind: 'board', slotId })),
    );
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ sourceCardId: 'NEWS007', kind: 'leakedTapes', ownerId: 'p2' }));
    expect(state.newsDeck.discardPile).toContain('NEWS003');
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('On The High Seas holds four voters and returns each through paid command-driven placement', () => {
    let state = activeState(204);
    queueNews(state, ['NEWS004'], 'p1', slotsIn('central', true)[0]!);
    const heldIds = slotsIn('north', false).slice(0, 4).map((slotId) => placeVoter(state, 'p1', slotId));
    provision(state, 'p1', { ...zero, cash: 4 });

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'voters', voterIds: heldIds });
    expect(heldIds.every((voterId) => state.voters.find((voter) => voter.id === voterId)?.location.kind === 'removed')).toBe(true);
    state = advanceToAction(state, 'p1');
    const placementSlots = slotsIn('south', false).slice(0, 4);
    for (let index = 0; index < heldIds.length; index += 1) {
      const voterId = heldIds[index]!;
      state = accepted(state, 'p1', {
        type: 'BuyHeldVoter',
        sourceCardId: 'NEWS004',
        voterId,
        payment: { ...zero, cash: 1 },
      });
      state = loadGame(serializeGame(state), CORE_CONTENT);
      const group = state.pendingVoterGroups.find((candidate) => candidate.voterIds.includes(voterId));
      if (group === undefined) throw new Error('held-voter placement group missing');
      state = accepted(state, 'p1', { type: 'PlaceVoterGroup', groupId: group.id, slotIds: [placementSlots[index]!] });
    }

    expect(state.activeEffects.some((effect) => effect.kind === 'ransomNote')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS004');
    stable(state);
  });

  it('Coward or Journalist resumes its clockwise donation queue after a resource-cap interruption', () => {
    let state = activeState(205);
    queueNews(state, ['NEWS005'], 'p1', slotsIn('central', true)[0]!);
    const donatedCardId = retain(state, 'p1', 'corporate');
    retain(state, 'p2', 'nationalist');
    retain(state, 'p3', 'reformer');
    provision(state, 'p1', { ...zero, cash: 8 });

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'cards', cardIds: [donatedCardId] });
    state = choose(state, 'p1', { kind: 'resources', resources: { ...zero, faith: 6 } });
    expect(state.pendingInteraction).toMatchObject({ kind: 'capDiscard', playerId: 'p1', excess: 2 });
    state = discardCap(state, 'p1', { ...zero, cash: 2 });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p2'], continuation: { op: 'donatePolicy' } });
    expect(state.turn.phase).toBe('newsResolution');
    state = choose(state, 'p2', { kind: 'pass' });
    state = choose(state, 'p3', { kind: 'pass' });

    expect(player(state, 'p2').retainedPolicy.map((card) => card.cardId)).toContain(donatedCardId);
    expect(player(state, 'p1').resources).toEqual({ cash: 6, influence: 0, press: 0, faith: 6 });
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Blessings places both freely influenced voter-card groups immediately before turn continuation', () => {
    let state = activeState(206);
    queueNews(state, ['NEWS006'], 'p1', slotsIn('central', true)[0]!);
    const keptCardId = drawnVoterCard(state, 2);
    const donatedCardId = drawnVoterCard(state, 1);
    putVoterCardsOnTop(state, [keptCardId, donatedCardId]);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'cards', cardIds: [keptCardId] });
    state = choose(state, 'p1', { kind: 'players', playerIds: ['p2'] });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p1'], continuation: { op: 'blessingsPlace' } });
    state = choose(state, 'p1', { kind: 'slots', slotIds: slotsIn('southWest', false).slice(0, 2) });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p2'], continuation: { op: 'blessingsPlace' } });
    state = choose(state, 'p2', { kind: 'slots', slotIds: slotsIn('southEast', false).slice(0, 1) });

    expect(state.pendingVoterGroups).toHaveLength(0);
    expect(state.voterDeck.discardPile).toEqual(expect.arrayContaining([keptCardId, donatedCardId]));
    expect(state.voters.filter((voter) => voter.ownerId === 'p1' && voter.location.kind === 'board')).toHaveLength(3);
    expect(state.voters.filter((voter) => voter.ownerId === 'p2' && voter.location.kind === 'board')).toHaveLength(1);
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Leaked Tapes remains open for its affected voter owner for the rest of the game', () => {
    const initial = activeState(207);
    queueNews(initial, ['NEWS007'], 'p2', slotsIn('central', true)[0]!);

    const state = accepted(initial, 'p1', { type: 'RequestEndTurn' });

    expect(state.activeEffects).toContainEqual(expect.objectContaining({ sourceCardId: 'NEWS007', kind: 'leakedTapes', ownerId: 'p2', targetPlayerIds: ['p2'] }));
    expect(state.newsDeck.discardPile).not.toContain('NEWS007');
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Polo fallback grants both selected players one shared level-three power through their next turns', () => {
    let state = activeState(208);
    queueNews(state, ['NEWS008'], 'p3', slotsIn('central', true)[0]!);
    unlock(state, 'p1', 'corporate');
    provision(state, 'p3', { ...zero, cash: 2 });

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p3', { kind: 'players', playerIds: ['p1', 'p2'] });
    state = choose(state, 'p3', { kind: 'option', optionId: 'nationalist' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'backroomDeal', targetPlayerIds: ['p1', 'p2'], data: expect.objectContaining({ fallbackArchetype: 'nationalist' }) }));

    state = answerCurrent(state);
    state = accepted(state, 'p2', { type: 'UseDonations', opponentId: 'p3', resource: 'cash' });
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p3', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p1', { type: 'UseDonations', opponentId: 'p2', resource: 'cash' });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.activeEffects.some((effect) => effect.kind === 'backroomDeal')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS008');
    stable(state);
  });

  it('Flood Relief permits an immediate majority-voter move only through current rights and outside volatile slots', () => {
    let state = activeState(209);
    queueNews(state, ['NEWS009'], 'p1', slotsIn('central', true)[0]!);
    const majorityIds = formMajority(state, 'p1', 'northWest');
    const movedVoterId = majorityIds[0]!;
    const movedVoter = state.voters.find((voter) => voter.id === movedVoterId);
    if (movedVoter?.location.kind !== 'board') throw new Error('fixture majority voter missing');
    const sourceSlotId = movedVoter.location.slotId;

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const restored = roundTripPending(state);
    rejected(restored, 'p1', {
      type: 'SubmitChoice',
      interactionId: restored.pendingInteraction!.id,
      selection: { kind: 'slots', slotIds: [sourceSlotId, slotsIn('southEast', false)[0]!] },
    }, 'INVALID_TARGET_SET');
    rejected(restored, 'p1', {
      type: 'SubmitChoice',
      interactionId: restored.pendingInteraction!.id,
      selection: { kind: 'slots', slotIds: [sourceSlotId, slotsIn('north', true)[0]!] },
    }, 'INVALID_TARGET_SET');
    state = choose(restored, 'p1', { kind: 'slots', slotIds: [sourceSlotId, slotsIn('north', false)[0]!] });
    state = choose(state, 'p2', { kind: 'pass' });
    state = choose(state, 'p3', { kind: 'pass' });

    expect(state.voters.find((voter) => voter.id === movedVoterId)?.location).toMatchObject({ kind: 'board', slotId: slotsIn('north', false)[0], majority: false });
    expect(state.newsQueue).toHaveLength(0);
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Cough evicts opponents clockwise and rewards every other player when the eviction breaks a majority', () => {
    let state = activeState(210);
    queueNews(state, ['NEWS010'], 'p1', slotsIn('central', true)[0]!);
    const p2Majority = formMajority(state, 'p2', 'northWest');
    const p2Target = p2Majority[0]!;
    const p3Target = placeVoter(state, 'p3', slotsIn('north', false)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p2', { kind: 'voters', voterIds: [p2Target] });
    state = choose(state, 'p3', { kind: 'voters', voterIds: [p3Target] });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p1'], continuation: { op: 'coughReward' } });
    state = choose(state, 'p1', { kind: 'resources', resources: { ...zero, cash: 1 } });
    state = choose(state, 'p3', { kind: 'resources', resources: { ...zero, faith: 1 } });

    expect(player(state, 'p1').resources.cash).toBe(1);
    expect(player(state, 'p2').resources).toEqual(zero);
    expect(player(state, 'p3').resources.faith).toBe(1);
    expect(state.voters.find((voter) => voter.id === p2Target)?.location.kind).toBe('pending');
    expect(state.voters.find((voter) => voter.id === p3Target)?.location.kind).toBe('evicted');
    expect(state.newsDeck.discardPile).toContain('NEWS010');
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });
});

function setVoterMarket(state: GameState, cardIds: [string, string, string]): void {
  const available = [...state.voterDeck.market, ...state.voterDeck.drawPile];
  if (cardIds.some((cardId) => !available.includes(cardId))) {
    throw new Error('fixture voter card unavailable');
  }
  const selected = new Set(cardIds);
  state.voterDeck.market = [...cardIds];
  state.voterDeck.drawPile = available.filter((cardId) => !selected.has(cardId));
}

function submitVote(state: GameState, playerId: string, optionId: string): GameState {
  const restored = roundTripPending(state);
  const interactionId = restored.pendingInteraction?.id;
  if (interactionId === undefined) throw new Error('fixture vote disappeared');
  return accepted(restored, playerId, { type: 'SubmitVote', interactionId, optionId });
}

function placeBid(state: GameState, playerId: string, amount: number): GameState {
  const restored = roundTripPending(state);
  const interactionId = restored.pendingInteraction?.id;
  if (interactionId === undefined) throw new Error('fixture auction disappeared');
  return accepted(restored, playerId, { type: 'PlaceBid', interactionId, amount });
}

function passAuction(state: GameState, playerId: string): GameState {
  const restored = roundTripPending(state);
  const interactionId = restored.pendingInteraction?.id;
  if (interactionId === undefined) throw new Error('fixture auction disappeared');
  return accepted(restored, playerId, { type: 'PassAuction', interactionId });
}

function putPolicyAnswerAt(state: GameState, drawIndex: number, archetype: Archetype): string {
  const index = state.policyDeck.drawPile.findIndex((cardId) =>
    CORE_CONTENT.policyCards.find((card) => card.id === cardId)?.answers[0].archetype === archetype);
  const cardId = state.policyDeck.drawPile[index];
  if (index < 0 || cardId === undefined) throw new Error(`fixture ${archetype} answer missing`);
  state.policyDeck.drawPile.splice(index, 1);
  state.policyDeck.drawPile.splice(drawIndex, 0, cardId);
  return cardId;
}

describe('news behavior, cards 011-020', () => {
  it('Relief Fund blocks purchases until one resource of each type is returned', () => {
    let state = activeState(211);
    queueNews(state, ['NEWS011'], 'p1', slotsIn('central', true)[0]!);
    provision(state, 'p1', { cash: 1, influence: 1, press: 1, faith: 1 });

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const obligation = player(state, 'p1').obligations[0];
    expect(obligation).toMatchObject({ kind: 'reliefFund', sourceCardId: 'NEWS011' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'reliefFund', ownerId: 'p1' }));

    state = advanceToAction(state, 'p1');
    const voterCardId = state.voterDeck.market[0]!;
    rejected(state, 'p1', {
      type: 'InfluenceVoterCard',
      cardId: voterCardId,
      payment: { resources: zero },
    }, 'WRONG_PHASE');
    rejected(state, 'p1', {
      type: 'PayObligation',
      obligationId: obligation!.id,
      selection: { kind: 'resources', resources: { ...zero, cash: 4 } },
    }, 'INSUFFICIENT_RESOURCES');

    state = loadGame(serializeGame(state), CORE_CONTENT);
    const beforePayment = { ...player(state, 'p1').resources };
    state = accepted(state, 'p1', {
      type: 'PayObligation',
      obligationId: obligation!.id,
      selection: { kind: 'resources', resources: { cash: 1, influence: 1, press: 1, faith: 1 } },
    });

    expect(player(state, 'p1').resources).toEqual({
      cash: beforePayment.cash - 1,
      influence: beforePayment.influence - 1,
      press: beforePayment.press - 1,
      faith: beforePayment.faith - 1,
    });
    expect(player(state, 'p1').obligations).toHaveLength(0);
    expect(state.activeEffects.some((effect) => effect.kind === 'reliefFund')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS011');
    stable(state);
  });

  it('Tabloid Scandal adds one generic voter-card cost for exactly the owner’s next turn', () => {
    let state = activeState(212);
    queueNews(state, ['NEWS012'], 'p1', slotsIn('central', true)[0]!);
    const voterCardId = putVoterCardInMarket(state, 1);
    const voterCard = CORE_CONTENT.voterCards.find((card) => card.id === voterCardId)!;
    const basePayment = paymentFor(voterCard.cost);
    const surchargedPayment = { ...basePayment, cash: basePayment.cash + 1 };
    provision(state, 'p1', surchargedPayment);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'tabloidScandal', ownerId: 'p1' }));
    state = advanceToAction(state, 'p1');
    rejected(state, 'p1', {
      type: 'InfluenceVoterCard',
      cardId: voterCardId,
      payment: { resources: basePayment },
    }, 'INSUFFICIENT_RESOURCES');
    state = accepted(state, 'p1', {
      type: 'InfluenceVoterCard',
      cardId: voterCardId,
      payment: { resources: surchargedPayment },
    });
    const group = state.pendingVoterGroups.find((candidate) => candidate.origin.kind === 'voterCard'
      && candidate.origin.cardId === voterCardId);
    if (group === undefined) throw new Error('surcharged voter group missing');
    state = accepted(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: group.id,
      slotIds: [slotsIn('southWest', false)[0]!],
    });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.activeEffects.some((effect) => effect.kind === 'tabloidScandal')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS012');
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Anonymous Tip shuffles two cards back and completes its auction through debt', () => {
    let state = activeState(213);
    queueNews(state, ['NEWS013'], 'p1', slotsIn('central', true)[0]!);
    const drawn = state.trickDeck.drawPile.slice(0, 3);
    const keptCardId = drawn[0]!;
    const returned = drawn.slice(1);
    const unshuffledReturn = [...state.trickDeck.drawPile.slice(3), ...returned];
    const randomDrawsBefore = state.random.draws;

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'cards', cardIds: [keptCardId] });
    expect(state.pendingInteraction).toMatchObject({
      responsiblePlayerIds: ['p2'],
      continuation: { op: 'auction', sellerId: 'p1', cardId: keptCardId, minimumBid: 2 },
    });
    expect(state.trickDeck.drawPile).not.toEqual(unshuffledReturn);
    expect(state.random.draws).toBeGreaterThan(randomDrawsBefore);
    expect(returned.every((cardId) => state.trickDeck.drawPile.includes(cardId))).toBe(true);

    const restored = roundTripPending(state);
    rejected(restored, 'p2', {
      type: 'PlaceBid',
      interactionId: restored.pendingInteraction!.id,
      amount: 1,
    }, 'INVALID_TARGET_SET');
    state = placeBid(restored, 'p2', 2);
    state = passAuction(state, 'p3');

    expect(player(state, 'p2').trickHand).toContain(keptCardId);
    expect(player(state, 'p2').debts).toContainEqual(expect.objectContaining({
      creditorPlayerId: 'p1',
      amount: 2,
    }));
    expect(state.newsDeck.discardPile).toContain('NEWS013');
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    stable(state);
  });

  it('Turf War converts clockwise, rewarding only players who preserve majorities', () => {
    let state = activeState(214);
    queueNews(state, ['NEWS014'], 'p1', slotsIn('central', true)[0]!);
    const p2Targets = formMajority(state, 'p2', 'northWest').slice(0, 2);
    const p3Slots = slotsIn('north', false).slice(0, 2);
    const p3Targets = p3Slots.map((slotId) => placeVoter(state, 'p3', slotId));
    const p2Slots = p2Targets.map((voterId) => {
      const voter = state.voters.find((candidate) => candidate.id === voterId);
      if (voter?.location.kind !== 'board') throw new Error('fixture p2 target missing');
      return voter.location.slotId;
    });
    const p1Slots = slotsIn('west', false).slice(0, 2);
    const p1Targets = p1Slots.map((slotId) => placeVoter(state, 'p1', slotId));

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'voters', voterIds: p2Targets });
    expect(state.pendingInteraction).toMatchObject({ responsiblePlayerIds: ['p2'], continuation: { op: 'limitsConvert' } });
    state = choose(state, 'p2', { kind: 'voters', voterIds: p3Targets });
    state = choose(state, 'p2', { kind: 'resources', resources: { ...zero, press: 2 } });
    state = choose(state, 'p3', { kind: 'voters', voterIds: p1Targets });
    state = choose(state, 'p3', { kind: 'resources', resources: { ...zero, faith: 2 } });

    expect(player(state, 'p1').resources).toEqual(zero);
    expect(player(state, 'p2').resources).toEqual({ ...zero, press: 2 });
    expect(player(state, 'p3').resources).toEqual({ ...zero, faith: 2 });
    expect(p2Slots.map((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId)
      .every((voterId) => state.voters.find((voter) => voter.id === voterId)?.ownerId === 'p1')).toBe(true);
    expect(p3Slots.map((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId)
      .every((voterId) => state.voters.find((voter) => voter.id === voterId)?.ownerId === 'p2')).toBe(true);
    expect(p1Slots.map((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId)
      .every((voterId) => state.voters.find((voter) => voter.id === voterId)?.ownerId === 'p3')).toBe(true);
    expect(state.newsDeck.discardPile).toContain('NEWS014');
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Tax Audit suppresses printed income once while preserving passive income', () => {
    let state = activeState(215);
    queueNews(state, ['NEWS015'], 'p1', slotsIn('central', true)[0]!);
    retain(state, 'p1', 'corporate');
    putPolicyAnswerAt(state, 2, 'corporate');

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p3', { type: 'RequestEndTurn' });
    const before = { ...player(state, 'p1').resources };
    state = accepted(state, 'p1', { type: 'CommitPolicyAnswer', answerIndex: 0 });

    expect(player(state, 'p1').resources).toEqual({ ...before, cash: before.cash + 1 });
    expect(state.activeEffects.some((effect) => effect.kind === 'taxAudit')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS015');
    stable(state);
  });

  it('Data Broker repeats tied voting and resumes the ending turn after a winner', () => {
    let state = activeState(216);
    queueNews(state, ['NEWS016'], 'p1', slotsIn('central', true)[0]!);
    const prizeCardId = state.trickDeck.drawPile[0]!;

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const firstRound = roundTripPending(state);
    rejected(firstRound, 'p1', {
      type: 'SubmitVote',
      interactionId: firstRound.pendingInteraction!.id,
      optionId: 'p1',
    }, 'INVALID_TARGET_SET');
    state = submitVote(firstRound, 'p1', 'p2');
    state = submitVote(state, 'p2', 'p3');
    state = submitVote(state, 'p3', 'p1');
    expect(state.pendingInteraction).toMatchObject({ continuation: { op: 'campaignVote', round: 2, ballots: [] } });
    state = submitVote(state, 'p1', 'p2');
    state = submitVote(state, 'p2', 'p1');
    state = submitVote(state, 'p3', 'p1');

    expect(player(state, 'p1').trickHand).toContain(prizeCardId);
    expect(state.newsDeck.discardPile).toContain('NEWS016');
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    stable(state);
  });

  it('Echo Chamber copies exact printed and passive income, then resumes after recipient cap cleanup', () => {
    let state = activeState(217);
    queueNews(state, ['NEWS017'], 'p1', slotsIn('central', true)[0]!);
    retain(state, 'p1', 'corporate');
    const answerCardId = putPolicyAnswerAt(state, 2, 'corporate');
    const answer = CORE_CONTENT.policyCards.find((card) => card.id === answerCardId)!.answers[0];

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'players', playerIds: ['p2'] });
    state = answerCurrent(state);
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p3', { type: 'RequestEndTurn' });
    const currentRecipientTotal = Object.values(player(state, 'p2').resources).reduce((sum, amount) => sum + amount, 0);
    provision(state, 'p2', { ...zero, cash: 10 - currentRecipientTotal });
    const ownerBefore = { ...player(state, 'p1').resources };
    const recipientBefore = { ...player(state, 'p2').resources };

    state = accepted(state, 'p1', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    const copied = { ...answer.reward, cash: answer.reward.cash + 1 };
    expect(player(state, 'p1').resources).toEqual({
      cash: ownerBefore.cash + copied.cash,
      influence: ownerBefore.influence + copied.influence,
      press: ownerBefore.press + copied.press,
      faith: ownerBefore.faith + copied.faith,
    });
    expect(player(state, 'p2').resources).toEqual({
      cash: recipientBefore.cash + copied.cash,
      influence: recipientBefore.influence + copied.influence,
      press: recipientBefore.press + copied.press,
      faith: recipientBefore.faith + copied.faith,
    });
    expect(state.pendingInteraction).toMatchObject({ kind: 'capDiscard', playerId: 'p2', excess: 2 });
    state = discardCap(state, 'p2', { ...zero, cash: 2 });

    expect(state.turn.phase).toBe('action');
    expect(state.turn.activePlayerId).toBe('p1');
    expect(state.activeEffects.some((effect) => effect.kind === 'echoChamber')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS017');
    stable(state);
  });

  it('Hydra grants a recoverable voter for an opponent gerrymander and expires after one round', () => {
    let state = activeState(218);
    queueNews(state, ['NEWS018'], 'p1', slotsIn('central', true)[0]!);
    placeVoter(state, 'p2', slotsIn('northWest', false)[0]!);
    placeVoter(state, 'p2', slotsIn('northWest', false)[1]!);
    const movedVoterId = placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    const destinationSlotId = slotsIn('west', false)[0]!;

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = advanceToAction(state, 'p2');
    state = accepted(state, 'p2', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: movedVoterId,
      destinationSlotId,
    });
    const gainedVoter = state.voters.find((voter) =>
      voter.ownerId === 'p1' && voter.location.kind === 'evicted');
    expect(gainedVoter?.location).toMatchObject({ kind: 'evicted' });

    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    state = accepted(state, 'p3', { type: 'RequestEndTurn' });
    state = answerCurrent(state);
    expect(state.turn.activePlayerId).toBe('p1');
    const group = state.pendingVoterGroups.find((candidate) => candidate.voterIds.includes(gainedVoter!.id));
    if (group === undefined) throw new Error('Hydra voter group missing');
    state = accepted(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: group.id,
      slotIds: [slotsIn('southEast', false)[0]!],
    });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.activeEffects.some((effect) => effect.kind === 'hydra')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS018');
    expect(state.voters.find((voter) => voter.id === gainedVoter!.id)?.location).toMatchObject({
      kind: 'board',
      slotId: slotsIn('southEast', false)[0],
    });
    stable(state);
  });

  it('Disqualified awards printed and generic card resources without refilling early', () => {
    let state = activeState(219);
    queueNews(state, ['NEWS019'], 'p1', slotsIn('central', true)[0]!);
    setVoterMarket(state, ['V0001', 'V0013', 'V0055']);
    provision(state, 'p1', { ...zero, cash: 8 });

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p2', { kind: 'cards', cardIds: ['V0001'] });
    expect(state.voterDeck.market).toEqual(['V0013', 'V0055']);
    expect(player(state, 'p2').resources).toEqual({ cash: 2, influence: 1, press: 0, faith: 0 });
    state = choose(state, 'p3', { kind: 'cards', cardIds: ['V0013'] });
    expect(state.voterDeck.market).toEqual(['V0055']);
    expect(player(state, 'p3').resources).toEqual({ cash: 2, influence: 1, press: 1, faith: 0 });
    state = choose(state, 'p1', { kind: 'cards', cardIds: ['V0055'] });
    expect(state.pendingInteraction).toMatchObject({
      responsiblePlayerIds: ['p1'],
      continuation: { op: 'goalparaReward', generic: 1 },
    });
    state = choose(state, 'p1', { kind: 'resources', resources: { ...zero, faith: 1 } });
    expect(state.pendingInteraction).toMatchObject({ kind: 'capDiscard', playerId: 'p1', excess: 1 });
    state = discardCap(state, 'p1', { ...zero, cash: 1 });

    expect(player(state, 'p1').resources).toEqual({ cash: 8, influence: 1, press: 1, faith: 2 });
    expect(state.voterDeck.market).toHaveLength(3);
    expect(state.activeEffects.some((effect) => effect.kind === 'disqualified')).toBe(false);
    expect(state.newsDeck.discardPile).toContain('NEWS019');
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    stable(state);
  });

  it('Supply Shortage resolves both branches, immediate placement, and newly queued news cards in FIFO order', () => {
    let state = activeState(220);
    queueNews(state, ['NEWS020', 'NEWS012', 'NEWS011'], 'p1', slotsIn('central', true)[0]!);
    const secondTriggerSlotId = slotsIn('northWest', true)[0]!;
    const secondTriggerVoterId = placeVoter(state, 'p2', secondTriggerSlotId);
    state.newsQueue.push({
      id: `fixture-trigger-${state.nextSequence}`,
      voterId: secondTriggerVoterId,
      slotId: secondTriggerSlotId,
      voterOwnerId: 'p2',
      actorId: 'p1',
      turnOrdinal: state.turn.ordinal,
    });
    state.nextSequence += 1;
    const p2DiscardId = placeVoter(state, 'p2', slotsIn('north', false)[0]!);
    const p1DiscardId = placeVoter(state, 'p1', slotsIn('west', false)[0]!);
    const freePlacementSlotId = slotsIn('northEast', true)[0]!;

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p2', { kind: 'voters', voterIds: [p2DiscardId] });
    state = choose(state, 'p3', { kind: 'players', playerIds: ['p1'] });
    expect(state.pendingInteraction).toMatchObject({
      responsiblePlayerIds: ['p1'],
      continuation: { op: 'oxyPlace' },
    });
    state = choose(state, 'p1', { kind: 'slots', slotIds: [freePlacementSlotId] });
    state = choose(state, 'p1', { kind: 'voters', voterIds: [p1DiscardId] });

    expect(state.voters.find((voter) => voter.id === p2DiscardId)?.location.kind).toBe('supply');
    expect(state.voters.find((voter) => voter.id === p1DiscardId)?.location.kind).toBe('supply');
    const placedVoterId = state.slots.find((slot) => slot.slotId === freePlacementSlotId)?.voterId;
    expect(state.voters.find((voter) => voter.id === placedVoterId)?.ownerId).toBe('p1');
    expect(state.pendingVoterGroups).toHaveLength(0);
    expect(state.newsQueue).toHaveLength(0);
    expect(state.activeEffects.slice(-2).map((effect) => effect.sourceCardId)).toEqual(['NEWS012', 'NEWS011']);
    expect(player(state, 'p1').obligations).toContainEqual(expect.objectContaining({ sourceCardId: 'NEWS011' }));
    expect(state.newsDeck.discardPile).toContain('NEWS020');
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.turn.phase).toBe('policyAnswer');
    stable(state);
  });
});
