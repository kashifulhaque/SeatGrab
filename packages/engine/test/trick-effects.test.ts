import { describe, expect, it } from 'vitest';
import type { Cost, Archetype, ResourceVector } from '@gerrymander/content';
import type { ChoiceSelection, GameCommand } from '@gerrymander/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  beginEffect,
  createGame,
  loadGame,
  serializeGame,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'trick-effects',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

const zero: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };

function activeState(seed = 101): GameState {
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

function putTrickInHand(state: GameState, playerId: string, cardId: string): void {
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture trick ${cardId} missing`);
  state.trickDeck.drawPile.splice(index, 1);
  state.players.find((player) => player.id === playerId)!.trickHand.push(cardId);
}

function play(state: GameState, playerId: string, cardId: string, mode?: string): GameState {
  putTrickInHand(state, playerId, cardId);
  return accepted(state, playerId, {
    type: 'PlayTrick',
    cardId,
    ...(mode === undefined ? {} : { mode }),
  });
}


function reverse(state: GameState, cardId: string): GameState {
  putTrickInHand(state, 'p1', cardId);
  putTrickInHand(state, 'p2', 'TRK005');
  state = accepted(state, 'p1', { type: 'PlayTrick', cardId });
  state = roundTripPending(state);
  return accepted(state, 'p2', {
    type: 'PlayReaction',
    cardId: 'TRK005',
    targetEffectId: state.pendingInteraction!.id,
  });
}
function provision(state: GameState, playerId: string, resources: ResourceVector): void {
  const target = state.players.find((player) => player.id === playerId);
  if (target === undefined) throw new Error('fixture player missing');
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    state.publicReserve[resource] -= resources[resource];
    target.resources[resource] += resources[resource];
  }
}

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
    if (drawIndex < 0 || cardId === undefined || card === undefined) throw new Error('fixture policy card missing');
    const answerIndex = card.answers[0].archetype === archetype ? 0 : 1;
    state.policyDeck.drawPile.splice(drawIndex, 1);
    target.retainedPolicy.push({ cardId, answerIndex, archetype });
  }
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

function formMajority(state: GameState, ownerId: string, zoneId: string): string[] {
  const zone = CORE_CONTENT.board.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) throw new Error('fixture zone missing');
  return slotsIn(zoneId).slice(0, zone.majorityThreshold).map((slotId) => placeVoter(state, ownerId, slotId, true));
}

function paymentFor(cost: Cost): ResourceVector {
  return {
    cash: cost.cash + cost.generic,
    influence: cost.influence,
    press: cost.press,
    faith: cost.faith,
  };
}

function putVoterCardInMarket(state: GameState, voters: 1 | 2 | 3, requireFunds = false): string {
  const definition = CORE_CONTENT.voterCards.find((card) =>
    card.voters === voters
      && (!requireFunds || card.cost.cash + card.cost.generic > 0)
      && (state.voterDeck.market.includes(card.id) || state.voterDeck.drawPile.includes(card.id)));
  if (definition === undefined) throw new Error('fixture voter card missing');
  if (state.voterDeck.market.includes(definition.id)) return definition.id;
  const drawIndex = state.voterDeck.drawPile.indexOf(definition.id);
  const displaced = state.voterDeck.market[0];
  if (displaced === undefined) throw new Error('fixture market empty');
  state.voterDeck.drawPile.splice(drawIndex, 1, displaced);
  state.voterDeck.market[0] = definition.id;
  return definition.id;
}

function influence(state: GameState, playerId: string, voters: 1 | 2 | 3, requireFunds = false): GameState {
  const cardId = putVoterCardInMarket(state, voters, requireFunds);
  const card = CORE_CONTENT.voterCards.find((candidate) => candidate.id === cardId)!;
  const payment = paymentFor(card.cost);
  provision(state, playerId, payment);
  return accepted(state, playerId, { type: 'InfluenceVoterCard', cardId, payment: { resources: payment } });
}

function stable(state: GameState): void {
  assertGameState(state, CORE_CONTENT);
}

describe('trick behavior', () => {
  it('Skimming selects one opponent and intercepts the chosen spent resource', () => {
    let state = play(activeState(), 'p1', 'TRK001');
    state = choose(state, 'p1', { kind: 'players', playerIds: ['p2'] });
    state = choose(state, 'p1', { kind: 'option', optionId: 'cash' });
    const before = state.players.find((player) => player.id === 'p1')!.resources.cash;
    state.turn.activePlayerId = 'p2';
    state = influence(state, 'p2', 1, true);
    const cardId = state.pendingVoterGroups[0]?.origin.kind === 'voterCard'
      ? state.pendingVoterGroups[0].origin.cardId
      : undefined;
    const paid = CORE_CONTENT.voterCards.find((card) => card.id === cardId)!.cost;
    expect(state.players.find((player) => player.id === 'p1')!.resources.cash).toBe(before + paid.cash + paid.generic);
    stable(state);
  });

  it('Turncoat contributes to a track, transfers for its effective level, and can be reassigned', () => {
    let state = play(activeState(), 'p1', 'TRK003');
    state = choose(state, 'p1', { kind: 'option', optionId: 'corporate' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ kind: 'turncoatArchetype', ownerId: 'p1' }));
    state.turn.activePlayerId = 'p2';
    provision(state, 'p2', { ...zero, cash: 1 });
    state = accepted(state, 'p2', {
      type: 'AcquireJumla',
      ownerId: 'p1',
      payment: { ...zero, cash: 1 },
    });
    state = accepted(state, 'p2', { type: 'ReassignJumla', archetype: 'reformer' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({ ownerId: 'p2', data: expect.objectContaining({ archetype: 'reformer' }) }));
    stable(state);
  });

  it('Veto negates a played card and cleans every persistent card location', () => {
    let reaction = activeState();
    putTrickInHand(reaction, 'p1', 'TRK006');
    putTrickInHand(reaction, 'p2', 'TRK004');
    reaction = accepted(reaction, 'p1', { type: 'PlayTrick', cardId: 'TRK006' });
    reaction = roundTripPending(reaction);
    reaction = accepted(reaction, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK004',
      targetEffectId: reaction.pendingInteraction!.id,
    });
    expect(reaction.activeEffects.some((effect) => effect.sourceCardId === 'TRK006')).toBe(false);
    stable(reaction);

    const persistentCards = [
      ['TRK001', 'skimming'],
      ['TRK003', 'turncoatArchetype'],
      ['TRK006', 'grandCoalition'],
      ['TRK008', 'longMarch'],
      ['TRK009', 'loyalBase'],
      ['TRK010', 'redevelopment'],
      ['TRK011', 'blacklist'],
      ['TRK014', 'scorchedEarth'],
      ['TRK015', 'starPower'],
    ] as const;
    for (const [sourceCardId, kind] of persistentCards) {
      let persistent = activeState(sourceCardId.charCodeAt(sourceCardId.length - 1));
      const sourceIndex = persistent.trickDeck.drawPile.indexOf(sourceCardId);
      persistent.trickDeck.drawPile.splice(sourceIndex, 1);
      persistent.activeEffects.push({
        id: `fixture-${sourceCardId}`,
        sourceCardId,
        ownerId: 'p2',
        kind,
        targetPlayerIds: ['p2'],
        targetZoneIds: [],
        data: {},
      });
      persistent = play(persistent, 'p1', 'TRK004');
      persistent = choose(persistent, 'p1', { kind: 'cards', cardIds: [sourceCardId] });
      expect(persistent.activeEffects.some((effect) => effect.sourceCardId === sourceCardId)).toBe(false);
      expect(persistent.trickDeck.discardPile).toEqual(expect.arrayContaining([sourceCardId, 'TRK004']));
      stable(persistent);
    }

    let held = activeState(102);
    const heldIds = slotsIn('north', false).slice(0, 5).map((slotId) => placeVoter(held, 'p2', slotId));
    held = play(held, 'p1', 'TRK012');
    held = choose(held, 'p1', { kind: 'voters', voterIds: heldIds });
    held = play(held, 'p1', 'TRK004');
    held = choose(held, 'p1', { kind: 'cards', cardIds: ['TRK012'] });
    expect(heldIds.every((id) => held.voters.find((voter) => voter.id === id)?.location.kind === 'evicted')).toBe(true);
    expect(held.activeEffects.some((effect) => effect.sourceCardId === 'TRK012')).toBe(false);
    stable(held);

    let obligation = activeState(103);
    const newsIndex = obligation.newsDeck.drawPile.indexOf('NEWS011');
    obligation.newsDeck.drawPile.splice(newsIndex, 1);
    const khaki = CORE_CONTENT.newsCards.find((card) => card.id === 'NEWS011')!;
    expect(beginEffect(obligation, { ownerId: 'p2', card: khaki }, CORE_CONTENT)).toBeNull();
    obligation = play(obligation, 'p1', 'TRK004');
    obligation = choose(obligation, 'p1', { kind: 'cards', cardIds: ['NEWS011'] });
    expect(obligation.players.find((player) => player.id === 'p2')!.obligations).toHaveLength(0);
    expect(obligation.activeEffects.some((effect) => effect.sourceCardId === 'NEWS011')).toBe(false);
    stable(obligation);
  });

  it('Boomerang applies only to targeted tricks and forces every later target back to the actor', () => {
    let selfEffect = activeState();
    putTrickInHand(selfEffect, 'p2', 'TRK005');
    selfEffect = play(selfEffect, 'p1', 'TRK006');
    expect(selfEffect.pendingInteraction).toBeNull();
    expect(selfEffect.players.find((player) => player.id === 'p2')!.trickHand).toContain('TRK005');

    let chai = reverse(activeState(104), 'TRK001');
    rejected(chai, 'p2', {
      type: 'SubmitChoice',
      interactionId: chai.pendingInteraction!.id,
      selection: { kind: 'players', playerIds: ['p3'] },
    }, 'INVALID_TARGET_SET');
    chai = choose(chai, 'p2', { kind: 'players', playerIds: ['p1'] });
    chai = choose(chai, 'p2', { kind: 'option', optionId: 'faith' });
    expect(chai.activeEffects).toContainEqual(expect.objectContaining({
      kind: 'skimming',
      ownerId: 'p2',
      targetPlayerIds: ['p1'],
    }));
    stable(chai);

    let exclusion = reverse(activeState(105), 'TRK011');
    rejected(exclusion, 'p2', {
      type: 'SubmitChoice',
      interactionId: exclusion.pendingInteraction!.id,
      selection: { kind: 'option', optionId: 'p3|northWest' },
    }, 'INVALID_TARGET_SET');
    exclusion = choose(exclusion, 'p2', { kind: 'option', optionId: 'p1|northWest' });
    expect(exclusion.activeEffects).toContainEqual(expect.objectContaining({
      kind: 'blacklist',
      ownerId: 'p2',
      targetPlayerIds: ['p1'],
    }));
    stable(exclusion);

    let imprisonment = activeState(106);
    const imprisonedActorVoters = slotsIn('north', false).slice(0, 5)
      .map((slotId) => placeVoter(imprisonment, 'p1', slotId));
    const unrelatedVoter = placeVoter(imprisonment, 'p3', slotsIn('north', false)[5]!);
    imprisonment = reverse(imprisonment, 'TRK012');
    rejected(imprisonment, 'p2', {
      type: 'SubmitChoice',
      interactionId: imprisonment.pendingInteraction!.id,
      selection: { kind: 'voters', voterIds: [...imprisonedActorVoters.slice(0, 4), unrelatedVoter] },
    }, 'INVALID_TARGET_SET');
    imprisonment = choose(imprisonment, 'p2', { kind: 'voters', voterIds: imprisonedActorVoters });
    expect(imprisonment.activeEffects).toContainEqual(expect.objectContaining({
      kind: 'dragnet',
      ownerId: 'p2',
      data: expect.objectContaining({ heldVoterIds: imprisonedActorVoters }),
    }));
    stable(imprisonment);

    let documents = activeState(107);
    const documentTargets: string[] = [];
    for (const zoneId of ['northWest', 'northEast']) {
      const slots = slotsIn(zoneId, false);
      placeVoter(documents, 'p2', slots[0]!);
      placeVoter(documents, 'p2', slots[1]!);
      documentTargets.push(placeVoter(documents, 'p1', slots[2]!));
    }
    const unrelatedDocument = placeVoter(documents, 'p3', slotsIn('northWest', false)[3]!);
    documents = reverse(documents, 'TRK013');
    rejected(documents, 'p2', {
      type: 'SubmitChoice',
      interactionId: documents.pendingInteraction!.id,
      selection: { kind: 'voters', voterIds: [unrelatedDocument] },
    }, 'INVALID_TARGET_SET');
    documents = choose(documents, 'p2', { kind: 'voters', voterIds: documentTargets });
    expect(documentTargets.every((id) => documents.voters.find((voter) => voter.id === id)?.location.kind === 'supply')).toBe(true);
    stable(documents);

    let bharat = activeState(108);
    const bharatActorVoters = slotsIn('north', false).slice(0, 5)
      .map((slotId) => placeVoter(bharat, 'p1', slotId));
    const unrelatedBharatVoter = placeVoter(bharat, 'p3', slotsIn('north', false)[5]!);
    bharat = reverse(bharat, 'TRK008');
    bharat.turn.activePlayerId = 'p2';
    bharat = accepted(bharat, 'p2', { type: 'RequestEndTurn' });
    rejected(bharat, 'p2', {
      type: 'SubmitChoice',
      interactionId: bharat.pendingInteraction!.id,
      selection: { kind: 'voters', voterIds: [...bharatActorVoters.slice(0, 4), unrelatedBharatVoter] },
    }, 'INVALID_TARGET_SET');
    bharat = choose(bharat, 'p2', { kind: 'voters', voterIds: bharatActorVoters });
    rejected(bharat, 'p2', {
      type: 'SubmitChoice',
      interactionId: bharat.pendingInteraction!.id,
      selection: { kind: 'players', playerIds: bharatActorVoters.map(() => 'p3') },
    }, 'INVALID_TARGET_SET');
    bharat = choose(bharat, 'p2', {
      kind: 'players',
      playerIds: bharatActorVoters.map(() => 'p1'),
    });
    expect(bharatActorVoters.every((id) => {
      const location = bharat.voters.find((voter) => voter.id === id)?.location;
      return location?.kind === 'evicted' && location.controllerId === 'p1';
    })).toBe(true);
    stable(bharat);
  });

  it('Grand Coalition doubles the current turn allowance of unlocked level-three powers', () => {
    let state = activeState();
    unlock(state, 'p1', 'corporate', 3);
    provision(state, 'p1', { ...zero, cash: 2 });
    state = play(state, 'p1', 'TRK006');
    const command: GameCommand = {
      type: 'UseProspecting',
      payment: { ...zero, cash: 1 },
      gain: { ...zero, influence: 2 },
    };
    state = accepted(state, 'p1', command);
    state = accepted(state, 'p1', command);
    rejected(state, 'p1', command, 'POWER_USAGE_EXHAUSTED');
    stable(state);
  });

  it('Flip-Flop flips one retained policy card to its opposite printed side', () => {
    let state = activeState();
    unlock(state, 'p1', 'corporate', 1);
    const before = state.players[0]!.retainedPolicy[0]!;
    const definition = CORE_CONTENT.policyCards.find((card) => card.id === before.cardId)!;
    state = play(state, 'p1', 'TRK007');
    state = choose(state, 'p1', { kind: 'cards', cardIds: [before.cardId] });
    expect(state.players[0]!.retainedPolicy[0]).toEqual({
      cardId: before.cardId,
      answerIndex: before.answerIndex === 0 ? 1 : 0,
      archetype: definition.answers[before.answerIndex === 0 ? 1 : 0].archetype,
    });
    stable(state);
  });

  it('Long March evicts five selected voters at end turn for opponent placement', () => {
    let state = activeState();
    const voters = slotsIn('north', false).slice(0, 5).map((slotId) => placeVoter(state, 'p1', slotId));
    state = play(state, 'p1', 'TRK008');
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    state = choose(state, 'p1', { kind: 'voters', voterIds: voters });
    state = choose(state, 'p1', { kind: 'players', playerIds: voters.map(() => 'p2') });
    expect(state.turn.activePlayerId).toBe('p2');
    expect(state.pendingVoterGroups.filter((group) => group.controllerId === 'p2').map((group) => group.voterIds[0])).toEqual(voters);
    expect(state.activeEffects.some((effect) => effect.sourceCardId === 'TRK008')).toBe(false);
    stable(state);
  });

  it('Loyal Base protects a majority and transfers after the printed voter conversion', () => {
    let state = activeState();
    formMajority(state, 'p1', 'northWest');
    formMajority(state, 'p2', 'northEast');
    const sacrifice = slotsIn('west').slice(0, 3).map((slotId) => placeVoter(state, 'p2', slotId));
    state = play(state, 'p1', 'TRK009');
    state = choose(state, 'p1', { kind: 'option', optionId: 'northWest' });
    state.turn.activePlayerId = 'p2';
    state = accepted(state, 'p2', { type: 'StealBase', sourceCardId: 'TRK009', voterIds: sacrifice as [string, string, string] });
    state = choose(state, 'p2', { kind: 'option', optionId: 'northEast' });
    expect(state.activeEffects).toContainEqual(expect.objectContaining({
      kind: 'loyalBase',
      ownerId: 'p2',
      targetZoneIds: ['northEast'],
    }));
    expect(sacrifice.every((id) => state.voters.find((voter) => voter.id === id)?.location.kind === 'supply')).toBe(true);
    stable(state);
  });

  it('Redevelopment applies to the next two placed two-voter cards and then expires', () => {
    let state = activeState();
    const targets = slotsIn('north', false).slice(0, 4).map((slotId) => placeVoter(state, 'p3', slotId));
    state = play(state, 'p1', 'TRK010');
    for (let use = 0; use < 2; use += 1) {
      state = influence(state, 'p1', 2);
      const group = state.pendingVoterGroups.find((candidate) => candidate.controllerId === 'p1')!;
      const empty = slotsIn('north', false).filter((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId === null).slice(0, 2);
      state = accepted(state, 'p1', { type: 'PlaceVoterGroup', groupId: group.id, slotIds: empty });
      state = choose(state, 'p1', { kind: 'voters', voterIds: targets.slice(use * 2, use * 2 + 2) });
    }
    expect(state.activeEffects.some((effect) => effect.sourceCardId === 'TRK010')).toBe(false);
    expect(targets.every((id) => state.voters.find((voter) => voter.id === id)?.location.kind === 'supply')).toBe(true);
    stable(state);
  });

  it('Blacklist blocks the selected opponent zone for exactly their next turn', () => {
    let state = play(activeState(), 'p1', 'TRK011');
    state = choose(state, 'p1', { kind: 'option', optionId: 'p2|northWest' });
    state.turn.activePlayerId = 'p2';
    state.turn.ordinal += 1;
    const voter = state.voters.find((candidate) => candidate.ownerId === 'p2' && candidate.location.kind === 'supply')!;
    voter.location = { kind: 'pending', groupId: 'blocked-group' };
    state.pendingVoterGroups.push({
      id: 'blocked-group',
      ownerId: 'p2',
      controllerId: 'p2',
      voterIds: [voter.id],
      origin: { kind: 'effect', sourceCardId: 'TRK011' },
      sameZone: true,
      deadlineTurnOrdinal: state.turn.ordinal,
    });
    rejected(state, 'p2', {
      type: 'PlaceVoterGroup',
      groupId: 'blocked-group',
      slotIds: [slotsIn('northWest', false)[0]!],
    }, 'INVALID_TARGET_SET');
    state = accepted(state, 'p2', { type: 'ConfirmPendingVoterDiscard', groupIds: ['blocked-group'] });
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    expect(state.activeEffects.some((effect) => effect.sourceCardId === 'TRK011')).toBe(false);
    stable(state);
  });

  it('Dragnet holds five voters, permits buyback, and releases survivors when blocked', () => {
    let state = activeState();
    const voters = slotsIn('north', false).slice(0, 5).map((slotId, index) => placeVoter(state, index === 0 ? 'p2' : 'p3', slotId));
    state = play(state, 'p1', 'TRK012');
    state = choose(state, 'p1', { kind: 'voters', voterIds: voters });
    state.turn.activePlayerId = 'p2';
    provision(state, 'p2', { ...zero, cash: 1 });
    state = accepted(state, 'p2', {
      type: 'BuyHeldVoter',
      sourceCardId: 'TRK012',
      voterId: voters[0]!,
      payment: { ...zero, cash: 1 },
    });
    expect(state.pendingVoterGroups.some((group) => group.voterIds.includes(voters[0]!))).toBe(true);
    state.turn.activePlayerId = 'p1';
    state = play(state, 'p1', 'TRK004');
    state = choose(state, 'p1', { kind: 'cards', cardIds: ['TRK012'] });
    expect(voters.slice(1).every((id) => state.voters.find((voter) => voter.id === id)?.location.kind === 'evicted')).toBe(true);
    stable(state);
  });

  it('Roll Purge discards one eligible voter in each selected rights zone', () => {
    let state = activeState();
    const targets: string[] = [];
    for (const zoneId of ['northWest', 'northEast', 'west', 'east']) {
      const slots = slotsIn(zoneId, false);
      placeVoter(state, 'p1', slots[0]!);
      placeVoter(state, 'p1', slots[1]!);
      targets.push(placeVoter(state, 'p2', slots[2]!));
    }
    state = play(state, 'p1', 'TRK013');
    state = choose(state, 'p1', { kind: 'voters', voterIds: targets });
    expect(targets.every((id) => state.voters.find((voter) => voter.id === id)?.location.kind === 'supply')).toBe(true);
    stable(state);
  });

  it('Scorched Earth discards exactly the next three voters gerrymandered by its owner', () => {
    let state = activeState();
    const targets: string[] = [];
    const moves: Array<{ rightsZoneId: string; destinationZoneId: string }> = [];
    for (const zoneId of ['northWest', 'northEast', 'west']) {
      const triple = CORE_CONTENT.board.movementTriples.find(([rights, source, destination]) =>
        rights === zoneId && source === zoneId && destination !== zoneId);
      if (triple === undefined) throw new Error('fixture movement triple missing');
      const sourceSlots = slotsIn(zoneId, false);
      placeVoter(state, 'p1', sourceSlots[0]!);
      placeVoter(state, 'p1', sourceSlots[1]!);
      targets.push(placeVoter(state, 'p2', sourceSlots[2]!));
      moves.push({ rightsZoneId: zoneId, destinationZoneId: triple[2] });
    }
    state = play(state, 'p1', 'TRK014');
    for (let index = 0; index < targets.length; index += 1) {
      state = accepted(state, 'p1', {
        type: 'Gerrymander',
        rightsZoneId: moves[index]!.rightsZoneId,
        voterId: targets[index]!,
        destinationSlotId: slotsIn(moves[index]!.destinationZoneId, false)
          .find((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId === null)!,
      });
    }
    expect(targets.every((id) => state.voters.find((voter) => voter.id === id)?.location.kind === 'supply')).toBe(true);
    expect(state.activeEffects.some((effect) => effect.sourceCardId === 'TRK014')).toBe(false);
    stable(state);
  });

  it('Star Power influences every open one-voter card for free at end turn', () => {
    let state = activeState();
    const oneVoter = CORE_CONTENT.voterCards.filter((card) => card.voters === 1).slice(0, 3).map((card) => card.id);
    for (const cardId of [...state.voterDeck.market]) {
      if (!oneVoter.includes(cardId)) state.voterDeck.drawPile.push(cardId);
    }
    state.voterDeck.drawPile = state.voterDeck.drawPile.filter((cardId) => !oneVoter.includes(cardId));
    state.voterDeck.market = [...oneVoter];
    state = play(state, 'p1', 'TRK015');
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.pendingVoterGroups).toHaveLength(3);
    expect(state.voterDeck.discardPile).toEqual(expect.arrayContaining(oneVoter));
    state = accepted(state, 'p1', {
      type: 'ConfirmPendingVoterDiscard',
      groupIds: state.pendingVoterGroups.map((group) => group.id),
    });
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    expect(state.turn.activePlayerId).toBe('p2');
    stable(state);
  });

  it('Musical Chairs swaps one to three distinct non-majority voter pairs', () => {
    let state = activeState();
    const slotIds = slotsIn('north', false).slice(0, 6);
    const voterIds = slotIds.map((slotId, index) => placeVoter(state, index % 2 === 0 ? 'p1' : 'p2', slotId));
    state = play(state, 'p1', 'TRK016');
    state = choose(state, 'p1', { kind: 'voters', voterIds });
    for (let index = 0; index < voterIds.length; index += 2) {
      expect(state.voters.find((voter) => voter.id === voterIds[index])?.location).toMatchObject({ slotId: slotIds[index + 1] });
      expect(state.voters.find((voter) => voter.id === voterIds[index + 1])?.location).toMatchObject({ slotId: slotIds[index] });
    }
    stable(state);
  });

  it('Cornerstone grants four chosen resources or consumes three immune cards for a 6/11 conversion', () => {
    let gain = play(activeState(), 'p1', 'TRK017');
    gain = choose(gain, 'p1', { kind: 'resources', resources: { ...zero, press: 4 } });
    expect(gain.players[0]!.resources.press).toBe(4);
    stable(gain);

    let triple = activeState(105);
    putTrickInHand(triple, 'p1', 'TRK018');
    putTrickInHand(triple, 'p1', 'TRK019');
    const ordinary = placeVoter(triple, 'p2', slotsIn('northWest', false)[0]!);
    const volatile = placeVoter(triple, 'p2', slotsIn('northWest', true)[0]!);
    putTrickInHand(triple, 'p2', 'TRK004');
    triple = play(triple, 'p1', 'TRK017', 'triple');
    expect(triple.pendingInteraction).toMatchObject({ kind: 'choice', continuation: { op: 'cornerstoneZone' } });
    triple = choose(triple, 'p1', { kind: 'option', optionId: 'northWest' });
    expect(triple.voters.find((voter) => voter.id === ordinary)?.location.kind).toBe('supply');
    expect(triple.voters.find((voter) => voter.id === volatile)?.ownerId).toBe('p2');
    expect(triple.trickDeck.discardPile).toEqual(expect.arrayContaining(['TRK017', 'TRK018', 'TRK019']));
    expect(triple.players.find((player) => player.id === 'p2')!.trickHand).toContain('TRK004');
    stable(triple);
  });
});
