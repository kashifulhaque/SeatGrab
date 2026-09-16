import { describe, expect, it } from 'vitest';
import type { Cost, Archetype, ResourceVector } from '@seatgrab/content';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  createGame,
  getLegalActions,
  getZoneSnapshot,
  loadGame,
  projectGame,
  resourceTotal,
  scorePlayer,
  serializeGame,
  type GameCommand,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'ordinary-flow',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) {
    throw new Error(`${result.response.code}: ${result.response.message}`);
  }
  expect(result.ok).toBe(true);
  return result.state;
}

function startedGame(seed = 17): GameState {
  let state = createGame(config, CORE_CONTENT, seed);
  state = accepted(state, 'p1', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
  state = accepted(state, 'p2', { type: 'VoteForFirstPlayer', candidateId: 'p1' });
  state = accepted(state, 'p3', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
  state = accepted(state, 'p2', {
    type: 'ChooseStartingResources',
    resources: { cash: 1, influence: 0, press: 0, faith: 0 },
  });
  state = accepted(state, 'p3', {
    type: 'ChooseStartingResources',
    resources: { cash: 0, influence: 1, press: 1, faith: 0 },
  });
  return accepted(state, 'p1', {
    type: 'ChooseStartingResources',
    resources: { cash: 0, influence: 0, press: 1, faith: 2 },
  });
}

function provision(state: GameState, playerId: string, resources: ResourceVector): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) {
    throw new Error('fixture player missing');
  }
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    state.publicReserve[resource] -= resources[resource];
    player.resources[resource] += resources[resource];
  }
}

function paymentFor(cost: Cost): ResourceVector {
  return {
    cash: cost.cash + cost.generic,
    influence: cost.influence,
    press: cost.press,
    faith: cost.faith,
  };
}

function putInFirstMarketSlot(state: GameState, cardId: string): void {
  const current = state.voterDeck.market[0];
  const targetIndex = state.voterDeck.drawPile.indexOf(cardId);
  if (current === undefined || targetIndex < 0) {
    throw new Error(`fixture cannot move ${cardId} into the market`);
  }
  state.voterDeck.market[0] = cardId;
  state.voterDeck.drawPile[targetIndex] = current;
  state.voterDeck.marketRevision += 1;
}

function buyAndPlace(state: GameState, playerId: string, cardId: string, slotIds: string[]): GameState {
  const card = CORE_CONTENT.voterCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    throw new Error(`fixture card ${cardId} missing`);
  }
  putInFirstMarketSlot(state, cardId);
  const resources = paymentFor(card.cost);
  provision(state, playerId, resources);
  state = accepted(state, playerId, {
    type: 'InfluenceVoterCard',
    cardId,
    payment: { resources },
  });
  const group = state.pendingVoterGroups.at(-1);
  if (group === undefined) {
    throw new Error('purchase did not create a pending voter group');
  }
  return accepted(state, playerId, { type: 'PlaceVoterGroup', groupId: group.id, slotIds });
}

function rejected(
  state: GameState,
  playerId: string,
  command: GameCommand,
  errorCode: string,
): void {
  const revision = state.revision;
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('fixture command unexpectedly succeeded');
  }
  expect(result.response.code).toBe(errorCode);
  expect(result.state).toBe(state);
  expect(state.revision).toBe(revision);
}

function unlock(state: GameState, playerId: string, archetype: Archetype, count: number): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) {
    throw new Error('unlock fixture player missing');
  }
  for (let index = 0; index < count; index += 1) {
    const drawIndex = state.policyDeck.drawPile.findIndex((cardId) => {
      const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId);
      return card?.answers.some((answer) => answer.archetype === archetype) === true;
    });
    const cardId = state.policyDeck.drawPile[drawIndex];
    const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId);
    if (drawIndex < 0 || cardId === undefined || card === undefined) {
      throw new Error(`not enough ${archetype} fixture cards`);
    }
    const answerIndex = card.answers[0].archetype === archetype ? 0 : 1;
    state.policyDeck.drawPile.splice(drawIndex, 1);
    player.retainedPolicy.push({ cardId, answerIndex, archetype });
  }
}

function placeFixtureVoter(
  state: GameState,
  ownerId: string,
  slotId: string,
  majority = false,
): string {
  const voter = state.voters.find((candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply');
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (voter === undefined || slot === undefined || slot.voterId !== null) {
    throw new Error('board fixture target unavailable');
  }
  voter.location = { kind: 'board', slotId, majority };
  slot.voterId = voter.id;
  return voter.id;
}

function discountedPayment(cost: Cost, amount: number): { resources: ResourceVector; discounts: ResourceVector } {
  const resources = paymentFor(cost);
  const discounts: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };
  let remaining = amount;
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    const discounted = Math.min(remaining, resources[resource]);
    resources[resource] -= discounted;
    discounts[resource] += discounted;
    remaining -= discounted;
  }
  if (remaining !== 0) {
    throw new Error('fixture cost cannot absorb requested discount');
  }
  return { resources, discounts };
}

describe('ordinary deterministic game flow', () => {
  it('keeps an unresolved policy reward out of the answering player projection', () => {
    const state = startedGame();
    expect(state.pendingInteraction?.kind).toBe('policyAnswer');
    if (state.pendingInteraction?.kind !== 'policyAnswer') {
      throw new Error('fixture did not reach policy answer');
    }
    const hiddenCardId = state.pendingInteraction.cardId;
    const view = projectGame(state, { kind: 'player', playerId: 'p2' }, CORE_CONTENT);
    const serialized = JSON.stringify(view);
    expect(view.prompt?.kind).toBe('policyAnswer');
    expect(serialized).not.toContain(hiddenCardId);
    expect(serialized).not.toContain('reward');
    expect(serialized).not.toContain('drawPile');
  });

  it('awards printed income, newly unlocked passive income, and forces exact cap discard', () => {
    let state = startedGame(31);
    if (state.pendingInteraction?.kind !== 'policyAnswer') {
      throw new Error('fixture did not reach policy answer');
    }
    const card = CORE_CONTENT.policyCards.find(
      (candidate) => candidate.id === (state.pendingInteraction?.kind === 'policyAnswer' ? state.pendingInteraction.cardId : ''),
    );
    if (card === undefined) {
      throw new Error('pending policy card missing');
    }
    const answer = card.answers[0];
    const prior = CORE_CONTENT.policyCards.find(
      (candidate) => candidate.id !== card.id && candidate.answers.some((face) => face.archetype === answer.archetype),
    );
    if (prior === undefined) {
      throw new Error('matching policy fixture card missing');
    }
    const priorAnswerIndex = prior.answers[0].archetype === answer.archetype ? 0 : 1;
    const drawIndex = state.policyDeck.drawPile.indexOf(prior.id);
    if (drawIndex < 0) {
      throw new Error('matching policy card not in draw pile');
    }
    state.policyDeck.drawPile.splice(drawIndex, 1);
    state.players.find((player) => player.id === 'p2')?.retainedPolicy.push({
      cardId: prior.id,
      answerIndex: priorAnswerIndex,
      archetype: answer.archetype,
    });
    const player = state.players.find((candidate) => candidate.id === 'p2');
    if (player === undefined) {
      throw new Error('fixture player missing');
    }
    const needed = 11 - (player.resources.cash + player.resources.influence + player.resources.press + player.resources.faith);
    provision(state, 'p2', { cash: needed, influence: 0, press: 0, faith: 0 });
    assertGameState(state, CORE_CONTENT);

    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    expect(state.pendingInteraction?.kind).toBe('capDiscard');
    if (state.pendingInteraction?.kind !== 'capDiscard') {
      throw new Error('income did not open cap discard');
    }
    expect(state.pendingInteraction.excess).toBe(3);
    const discard: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };
    const playerAfterIncome = state.players.find((candidate) => candidate.id === 'p2');
    if (playerAfterIncome === undefined) {
      throw new Error('income player missing');
    }
    let remaining = 3;
    for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
      const amount = Math.min(remaining, playerAfterIncome.resources[resource]);
      discard[resource] = amount;
      remaining -= amount;
    }
    state = accepted(state, 'p2', { type: 'DiscardExcessResources', resources: discard });
    expect(state.turn.phase).toBe('action');
    const cappedPlayer = state.players.find((candidate) => candidate.id === 'p2');
    expect(cappedPlayer === undefined ? -1 : resourceTotal(cappedPlayer.resources)).toBe(12);
  });

  it('persists a one-zone group, forms exactly threshold majority, and spends rights to move a surplus voter', () => {
    let state = startedGame(49);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    const northWest = CORE_CONTENT.board.slots.filter((slot) => slot.zoneId === 'northWest');
    state = buyAndPlace(state, 'p2', 'V0041', northWest.slice(0, 3).map((slot) => slot.slotId));

    putInFirstMarketSlot(state, 'V0042');
    const second = CORE_CONTENT.voterCards.find((card) => card.id === 'V0042');
    if (second === undefined) {
      throw new Error('second voter card missing');
    }
    const resources = paymentFor(second.cost);
    provision(state, 'p2', resources);
    state = accepted(state, 'p2', {
      type: 'InfluenceVoterCard',
      cardId: second.id,
      payment: { resources },
    });
    state = loadGame(serializeGame(state), CORE_CONTENT);
    const secondGroup = state.pendingVoterGroups.at(-1);
    if (secondGroup === undefined) {
      throw new Error('pending group did not survive reload');
    }
    state = accepted(state, 'p2', {
      type: 'PlaceVoterGroup',
      groupId: secondGroup.id,
      slotIds: northWest.slice(3, 6).map((slot) => slot.slotId),
    });
    expect(state.pendingInteraction?.kind).toBe('majoritySelection');
    if (state.pendingInteraction?.kind !== 'majoritySelection') {
      throw new Error('majority selection did not open');
    }
    state = accepted(state, 'p2', {
      type: 'SubmitChoice',
      interactionId: state.pendingInteraction.id,
      selection: { kind: 'voters', voterIds: state.pendingInteraction.eligibleVoterIds.slice(0, 6) },
    });
    expect(scorePlayer(state, 'p2')).toBe(6);

    state = buyAndPlace(state, 'p2', 'V0001', [northWest[6]?.slotId ?? 'missing']);
    const snapshot = getZoneSnapshot(state, CORE_CONTENT, 'northWest');
    expect(snapshot.counts.p2).toBe(7);
    expect(snapshot.rightsOwnerId).toBe('p2');
    const surplus = state.voters.find(
      (voter) => voter.ownerId === 'p2' && voter.location.kind === 'board' && !voter.location.majority,
    );
    const destination = CORE_CONTENT.board.slots.find(
      (slot) => slot.zoneId === 'north' && !slot.volatile,
    );
    if (surplus === undefined || destination === undefined) {
      throw new Error('gerrymander fixture target missing');
    }
    state = accepted(state, 'p2', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: surplus.id,
      destinationSlotId: destination.slotId,
    });
    expect(getZoneSnapshot(state, CORE_CONTENT, 'northWest').counts.p2).toBe(6);
    expect(getZoneSnapshot(state, CORE_CONTENT, 'north').counts.p2).toBe(1);
    expect(state.turn.usage.gerrymandersByRightsZone.northWest).toBe(1);
    expect(scorePlayer(state, 'p2')).toBe(6);
  });

  it('latches the full-board final-turn sequence when the last empty slot is legally filled', () => {
    let state = startedGame(63);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    const finalSlot = CORE_CONTENT.board.slots.find((slot) => !slot.volatile);
    if (finalSlot === undefined) {
      throw new Error('nonvolatile final slot missing');
    }
    const pendingVoter = state.voters[128];
    if (pendingVoter === undefined) {
      throw new Error('pending voter fixture missing');
    }
    const votersByOwner = state.players.map((player) =>
      state.voters.filter((voter) => voter.ownerId === player.id && voter.id !== pendingVoter.id),
    );
    const boardVoters = Array.from({ length: 128 }, (_, index) => {
      const ownerVoters = votersByOwner[index % votersByOwner.length];
      const voter = ownerVoters?.[Math.floor(index / votersByOwner.length)];
      if (voter === undefined) {
        throw new Error('full-board fixture voter underflow');
      }
      return voter;
    });
    const occupiedSlots = CORE_CONTENT.board.slots.filter((slot) => slot.slotId !== finalSlot.slotId);
    for (let index = 0; index < occupiedSlots.length; index += 1) {
      const slot = occupiedSlots[index];
      const voter = boardVoters[index];
      if (slot === undefined || voter === undefined) {
        throw new Error('full-board fixture underflow');
      }
      voter.location = { kind: 'board', slotId: slot.slotId, majority: false };
      const slotState = state.slots.find((candidate) => candidate.slotId === slot.slotId);
      if (slotState === undefined) {
        throw new Error('slot state missing');
      }
      slotState.voterId = voter.id;
    }
    const groupId = 'full-board-group';
    pendingVoter.location = { kind: 'pending', groupId };
    state.pendingVoterGroups.push({
      id: groupId,
      ownerId: pendingVoter.ownerId,
      controllerId: 'p2',
      voterIds: [pendingVoter.id],
      origin: { kind: 'effect', sourceCardId: 'fixture' },
      sameZone: true,
      deadlineTurnOrdinal: state.turn.ordinal,
    });
    assertGameState(state, CORE_CONTENT);
    state = accepted(state, 'p2', { type: 'PlaceVoterGroup', groupId, slotIds: [finalSlot.slotId] });
    expect(state.endgame.fullBoard?.remainingFinalPlayerIds).toEqual(['p3', 'p1']);
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    expect(state.turn.activePlayerId).toBe('p3');
    expect(state.endgame.fullBoard?.latchedOnTurnOrdinal).toBe(1);
  });

  it('finishes only at the turn checkpoint when all nine majorities exist', () => {
    let state = startedGame(79);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    const owners = ['p1', 'p2', 'p3'] as const;
    for (let zoneIndex = 0; zoneIndex < CORE_CONTENT.board.zones.length; zoneIndex += 1) {
      const zone = CORE_CONTENT.board.zones[zoneIndex];
      const ownerId = owners[zoneIndex % owners.length];
      if (zone === undefined || ownerId === undefined) {
        throw new Error('majority fixture zone missing');
      }
      const slots = CORE_CONTENT.board.slots
        .filter((slot) => slot.zoneId === zone.id)
        .slice(0, zone.majorityThreshold);
      const voters = state.voters
        .filter((voter) => voter.ownerId === ownerId && voter.location.kind === 'supply')
        .slice(0, zone.majorityThreshold);
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        const voter = voters[index];
        if (slot === undefined || voter === undefined) {
          throw new Error('majority fixture underflow');
        }
        voter.location = { kind: 'board', slotId: slot.slotId, majority: true };
        const slotState = state.slots.find((candidate) => candidate.slotId === slot.slotId);
        if (slotState === undefined) {
          throw new Error('majority fixture slot missing');
        }
        slotState.voterId = voter.id;
      }
    }
    assertGameState(state, CORE_CONTENT);
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    expect(state.status).toBe('finished');
    expect(state.endgame.reason).toBe('allMajorities');
    expect(state.endgame.finalScores).toEqual({ p1: 21, p2: 27, p3: 21 });
    expect(state.endgame.winners).toEqual(['p2']);

    // A client cannot say why a match ended unless the projection carries the reason,
    // and the local adapter is not the only client this contract has to serve.
    const view = projectGame(state, { kind: 'public' }, CORE_CONTENT);
    expect(view.status).toBe('finished');
    expect(view.endReason).toBe('allMajorities');
    expect(view.finalScores).toEqual({ p1: 21, p2: 27, p3: 21 });
    expect(view.winners).toEqual(['p2']);
    expect(view.legalActions).toEqual([]);
  });

  it('publishes no end reason while the match is still being played', () => {
    const state = startedGame(79);
    expect(projectGame(state, { kind: 'public' }, CORE_CONTENT).endReason).toBeUndefined();
  });
});

/**
 * The second ending, which no engine test reached until Session 20.
 *
 * `full-game.test.ts` played it, which is why it worked at all — and playing it is also
 * how the hole was found: a match whose last empty area was taken by a card's own
 * continuation rather than by `PlaceVoterGroup` never started its final turns, and since
 * a full board refuses every placement afterwards, it never could. One seeded match ran
 * 778 turns with seven zones undecided and no way to end.
 */
describe('the board filling', () => {
  /** Every area taken but `spare`, without routing a single voter through a command. */
  function nearlyFullBoard(spare: number): GameState {
    let state = answered(startedGame());
    const owners = ['p1', 'p2', 'p3'];
    const open = CORE_CONTENT.board.slots.slice(0, CORE_CONTENT.board.slots.length - spare);
    open.forEach((slot, index) => {
      placeFixtureVoter(state, owners[index % owners.length]!, slot.slotId);
    });
    return state;
  }

  /** Answer the hidden Policy Card so the active seat reaches its action phase. */
  function answered(state: GameState): GameState {
    if (state.pendingInteraction?.kind !== 'policyAnswer') return state;
    return accepted(state, state.pendingInteraction.playerId, {
      type: 'CommitPolicyAnswer',
      answerIndex: 0,
    });
  }

  it('starts the final turns however the last area was taken, and scores the match', () => {
    // One area left, taken the way a card's continuation takes it: straight onto the
    // board, with no `PlaceVoterGroup` to notice. The checkpoint is the only thing that
    // can see it, and this is the assertion that says it does.
    let state = nearlyFullBoard(1);
    state = accepted(state, state.turn.activePlayerId!, { type: 'RequestEndTurn' });
    expect(state.endgame.fullBoard).toBeUndefined();
    state = answered(state);
    const last = CORE_CONTENT.board.slots.at(-1)!;
    placeFixtureVoter(state, 'p2', last.slotId);
    expect(state.slots.filter((slot) => slot.voterId === null)).toHaveLength(0);

    const filler = state.turn.activePlayerId!;
    state = accepted(state, filler, { type: 'RequestEndTurn' });
    expect(state.endgame.fullBoard).toBeDefined();
    // Every seat after the one that ended on a full board takes one more turn, in seat
    // order — the same queue `PlaceVoterGroup` would have latched. The first of them is
    // already the active seat, because this checkpoint both latched the queue and took
    // the first entry off it.
    const fillerIndex = state.turn.order.indexOf(filler);
    expect([state.turn.activePlayerId, ...(state.endgame.fullBoard?.remainingFinalPlayerIds ?? [])])
      .toEqual([
        ...state.turn.order.slice(fillerIndex + 1),
        ...state.turn.order.slice(0, fillerIndex),
      ]);

    // And those turns run out rather than running on.
    for (let guard = 0; guard < 4 && state.status === 'active'; guard += 1) {
      state = answered(state);
      const active = state.turn.activePlayerId;
      if (active === null) break;
      state = accepted(state, active, { type: 'RequestEndTurn' });
    }
    expect(state.status).toBe('finished');
    expect(state.endgame.reason).toBe('fullBoardFinalTurns');
    assertGameState(state, CORE_CONTENT);
  });

  it('does not start them while an area is still open', () => {
    let state = nearlyFullBoard(2);
    state = accepted(state, state.turn.activePlayerId!, { type: 'RequestEndTurn' });
    expect(state.slots.filter((slot) => slot.voterId === null)).toHaveLength(2);
    expect(state.endgame.fullBoard).toBeUndefined();
    expect(state.status).toBe('active');
  });
});

describe('archetype powers', () => {
  it('recomputes Corporate unlocks, exchanges reserve resources, and schedules evicted voters', () => {
    let state = startedGame(101);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    unlock(state, 'p2', 'corporate', 5);
    const player = state.players.find((candidate) => candidate.id === 'p2');
    if (player === undefined) {
      throw new Error('Corporate fixture player missing');
    }
    const removed = player.retainedPolicy.splice(2);
    state.policyDeck.discardPile.push(...removed.map((card) => card.cardId));
    rejected(
      state,
      'p2',
      {
        type: 'UseProspecting',
        payment: { cash: 1, influence: 0, press: 0, faith: 0 },
        gain: { cash: 0, influence: 1, press: 1, faith: 0 },
      },
      'POWER_NOT_UNLOCKED',
    );
    for (const card of removed) {
      state.policyDeck.discardPile = state.policyDeck.discardPile.filter((cardId) => cardId !== card.cardId);
      player.retainedPolicy.push(card);
    }
    provision(state, 'p2', { cash: 1, influence: 0, press: 0, faith: 0 });
    const before = resourceTotal(player.resources);
    state = accepted(state, 'p2', {
      type: 'UseProspecting',
      payment: { cash: 1, influence: 0, press: 0, faith: 0 },
      gain: { cash: 0, influence: 1, press: 1, faith: 0 },
    });
    expect(resourceTotal(state.players.find((candidate) => candidate.id === 'p2')?.resources ?? {
      cash: 0, influence: 0, press: 0, faith: 0,
    })).toBe(before + 1);
    rejected(
      state,
      'p2',
      {
        type: 'UseProspecting',
        payment: { cash: 1, influence: 0, press: 0, faith: 0 },
        gain: { cash: 0, influence: 1, press: 1, faith: 0 },
      },
      'POWER_USAGE_EXHAUSTED',
    );

    const ownSlot = CORE_CONTENT.board.slots.find((slot) => slot.zoneId === 'northWest' && !slot.volatile);
    const opponentSlot = CORE_CONTENT.board.slots.find(
      (slot) => slot.zoneId === 'northWest' && !slot.volatile && slot.slotId !== ownSlot?.slotId,
    );
    if (ownSlot === undefined || opponentSlot === undefined) {
      throw new Error('Corporate fixture slots missing');
    }
    const ownVoterId = placeFixtureVoter(state, 'p2', ownSlot.slotId);
    const opponentVoterId = placeFixtureVoter(state, 'p1', opponentSlot.slotId);
    state = accepted(state, 'p2', { type: 'UseBreakingGround', voterId: ownVoterId });
    expect(state.pendingVoterGroups.some((group) => group.voterIds.includes(ownVoterId))).toBe(true);
    state = accepted(state, 'p2', { type: 'UseBreakingGround', voterId: opponentVoterId });
    expect(state.voters.find((voter) => voter.id === opponentVoterId)?.location.kind).toBe('evicted');
    const expiring = state.pendingVoterGroups
      .filter((group) => group.controllerId === 'p2')
      .map((group) => group.id);
    state = accepted(state, 'p2', { type: 'ConfirmPendingVoterDiscard', groupIds: expiring });
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    state = accepted(state, 'p3', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    state = accepted(state, 'p3', { type: 'RequestEndTurn' });
    expect(state.turn.activePlayerId).toBe('p1');
    expect(state.pendingVoterGroups.some((group) => group.voterIds.includes(opponentVoterId))).toBe(true);
  });

  it('applies Nationalist snatching and paid majority-voter discard with per-turn limits', () => {
    let state = startedGame(103);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    unlock(state, 'p2', 'nationalist', 5);
    provision(state, 'p1', { cash: 0, influence: 2, press: 0, faith: 0 });
    const before = state.players.find((player) => player.id === 'p2')?.resources.influence ?? 0;
    state = accepted(state, 'p2', { type: 'UseDonations', opponentId: 'p1', resource: 'influence' });
    state = accepted(state, 'p2', { type: 'UseDonations', opponentId: 'p1', resource: 'influence' });
    expect(state.players.find((player) => player.id === 'p2')?.resources.influence).toBe(before + 2);
    rejected(
      state,
      'p2',
      { type: 'UseDonations', opponentId: 'p1', resource: 'influence' },
      'POWER_USAGE_EXHAUSTED',
    );

    const slots = CORE_CONTENT.board.slots
      .filter((slot) => slot.zoneId === 'northWest' && !slot.volatile)
      .slice(0, 6);
    const voterIds = slots.map((slot) => placeFixtureVoter(state, 'p1', slot.slotId, true));
    provision(state, 'p2', { cash: 1, influence: 0, press: 0, faith: 0 });
    state = accepted(state, 'p2', {
      type: 'UsePayback',
      voterId: voterIds[0] ?? 'missing',
      payment: { cash: 1, influence: 0, press: 0, faith: 0 },
    });
    expect(state.voters.find((voter) => voter.id === voterIds[0])?.location.kind).toBe('supply');
    expect(getZoneSnapshot(state, CORE_CONTENT, 'northWest').majorityOwnerId).toBeUndefined();
  });

  it('adds Groundswell voters and lets Landslide move majority voters twice per rights zone', () => {
    let state = startedGame(107);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    unlock(state, 'p2', 'populist', 5);
    const voterCard = CORE_CONTENT.voterCards.find((card) => card.id === 'V0001');
    if (voterCard === undefined) {
      throw new Error('Groundswell fixture card missing');
    }
    putInFirstMarketSlot(state, voterCard.id);
    const resources = paymentFor(voterCard.cost);
    provision(state, 'p2', resources);
    state = accepted(state, 'p2', {
      type: 'InfluenceVoterCard',
      cardId: voterCard.id,
      payment: { resources },
      groundswell: true,
    });
    const viralGroup = state.pendingVoterGroups.at(-1);
    expect(viralGroup?.voterIds).toHaveLength(voterCard.voters + 1);
    if (viralGroup === undefined) {
      throw new Error('Groundswell group missing');
    }
    state = accepted(state, 'p2', { type: 'ConfirmPendingVoterDiscard', groupIds: [viralGroup.id] });

    const rightsSlots = CORE_CONTENT.board.slots
      .filter((slot) => slot.zoneId === 'northWest' && !slot.volatile)
      .slice(0, 6);
    const rightsVoters = rightsSlots.map((slot) => placeFixtureVoter(state, 'p2', slot.slotId, true));
    const destinations = CORE_CONTENT.board.slots
      .filter((slot) => slot.zoneId === 'north' && !slot.volatile)
      .slice(0, 2);
    state = accepted(state, 'p2', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: rightsVoters[0] ?? 'missing',
      destinationSlotId: destinations[0]?.slotId ?? 'missing',
      landslideUse: 1,
    });
    state = accepted(state, 'p2', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: rightsVoters[1] ?? 'missing',
      destinationSlotId: destinations[1]?.slotId ?? 'missing',
      landslideUse: 2,
    });
    expect(state.turn.usage.gerrymandersByRightsZone.northWest).toBe(2);
    rejected(
      state,
      'p2',
      {
        type: 'Gerrymander',
        rightsZoneId: 'northWest',
        voterId: rightsVoters[2] ?? 'missing',
        destinationSlotId: CORE_CONTENT.board.slots.find(
          (slot) => slot.zoneId === 'north' && !slot.volatile && !destinations.includes(slot),
        )?.slotId ?? 'missing',
      },
      'GERRYMANDER_ALLOWANCE_EXHAUSTED',
    );
  });

  it('combines Volunteers discounts on Outreach and converts exactly two same-zone voters', () => {
    let state = startedGame(109);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    unlock(state, 'p2', 'reformer', 5);
    const targetSlots = CORE_CONTENT.board.slots
      .filter((slot) => slot.zoneId === 'central' && !slot.volatile)
      .slice(0, 2);
    const targets = targetSlots.map((slot) => placeFixtureVoter(state, 'p1', slot.slotId, true));
    const payment = discountedPayment({ cash: 0, influence: 0, press: 0, faith: 2, generic: 2 }, 2);
    provision(state, 'p2', payment.resources);
    state = accepted(state, 'p2', {
      type: 'UseToughLove',
      voterIds: [targets[0] ?? 'missing', targets[1] ?? 'missing'],
      payment,
    });
    expect(state.turn.usage.volunteers).toBe(2);
    expect(state.turn.usage.outreach).toBe(1);
    expect(targets.map((id) => state.voters.find((voter) => voter.id === id)?.location.kind)).toEqual([
      'supply',
      'supply',
    ]);
    expect(targetSlots.map((slot) => {
      const voterId = state.slots.find((candidate) => candidate.slotId === slot.slotId)?.voterId;
      return state.voters.find((voter) => voter.id === voterId)?.ownerId;
    })).toEqual(['p2', 'p2']);
    rejected(
      state,
      'p2',
      {
        type: 'UseToughLove',
        voterIds: [targets[0] ?? 'missing', targets[1] ?? 'missing'],
        payment,
      },
      'POWER_USAGE_EXHAUSTED',
    );
  });

  it('never rests in beforeAnswer, so nothing is advertised or accepted there', () => {
    let state = startedGame(17);
    state = accepted(state, 'p2', { type: 'CommitPolicyAnswer', answerIndex: 0 });
    state = accepted(state, 'p2', { type: 'RequestEndTurn' });
    // `advanceTurn` sets `beforeAnswer` and `openPolicyPrompt` is always the next
    // statement, so a turn boundary is never observed in it.
    expect(state.turn.phase).not.toBe('beforeAnswer');

    // Force the phase the engine never leaves behind and check that the table and the
    // handlers agree. Before Session 18 they did not: `getLegalActions` offered a trade
    // and a trick here that `applyTradeCommand` and `applyPlayTrick` refuse.
    const activeId = state.turn.activePlayerId;
    if (activeId === null) throw new Error('the fixture lost its active player');
    state.turn.phase = 'beforeAnswer';
    state.pendingInteraction = null;
    expect(getLegalActions(state, activeId)).toEqual([]);
    rejected(
      state,
      activeId,
      {
        type: 'ProposeTrade',
        opponentId: activeId === 'p1' ? 'p2' : 'p1',
        giveResources: { cash: 1, influence: 0, press: 0, faith: 0 },
        receiveResources: { cash: 0, influence: 1, press: 0, faith: 0 },
        giveTrickIds: [],
        receiveTrickIds: [],
      },
      'WRONG_PHASE',
    );
  });
});
