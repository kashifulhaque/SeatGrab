import { describe, expect, it } from 'vitest';
import type { ChoicePromptContext, ChoicePromptOp, PlayerView } from '@gerrymander/protocol';
import {
  CORE_CONTENT,
  VOTER_SUPPLY_PER_PLAYER,
  applyCommand,
  createGame,
  projectGame,
  startAuction,
  startVote,
  type ChoiceContinuation,
  type ChoiceInteraction,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'projection-privacy',
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

function accepted(state: GameState, playerId: string, command: Parameters<typeof applyCommand>[2]): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) {
    throw new Error(`${result.response.code}: ${result.response.message}`);
  }
  return result.state;
}

/** Elects a first player without anyone voting for themselves. */
function startedVote(seed = 7): GameState {
  let state = createGame(config, CORE_CONTENT, seed);
  state = accepted(state, 'p1', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
  state = accepted(state, 'p2', { type: 'VoteForFirstPlayer', candidateId: 'p3' });
  return accepted(state, 'p3', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
}

/** Completes setup so the first player faces their hidden policy question. */
function startedGame(seed = 7): GameState {
  let state = startedVote(seed);
  const order = state.pendingInteraction?.kind === 'startingResources'
    ? [...state.pendingInteraction.remainingPlayerIds]
    : [];
  // Clockwise seats take a growing starting quota: one resource, then two, then three.
  order.forEach((playerId, index) => {
    state = accepted(state, playerId, {
      type: 'ChooseStartingResources',
      resources: { cash: index + 1, influence: 0, press: 0, faith: 0 },
    });
  });
  return state;
}

function viewFor(state: GameState, playerId: string): PlayerView {
  return projectGame(state, { kind: 'player', playerId }, CORE_CONTENT);
}

function publicView(state: GameState): PlayerView {
  return projectGame(state, { kind: 'public' }, CORE_CONTENT);
}

/** Every string, number, and key reachable from a projected view. */
function walk(value: unknown, path: string, visit: (path: string, key: string | null, leaf: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(`${path}.${key}`, key, child);
      walk(child, `${path}.${key}`, visit);
    }
    return;
  }
  visit(path, null, value);
}

function collectStrings(view: PlayerView): { path: string; value: string }[] {
  const found: { path: string; value: string }[] = [];
  walk(view, 'view', (path, key, leaf) => {
    if (key === null && typeof leaf === 'string') {
      found.push({ path, value: leaf });
    }
  });
  return found;
}

function collectKeys(view: PlayerView): string[] {
  const found: string[] = [];
  walk(view, 'view', (_path, key) => {
    if (key !== null) {
      found.push(key);
    }
  });
  return found;
}

function expectAbsent(view: PlayerView, forbidden: readonly string[], label: string): void {
  const strings = collectStrings(view);
  for (const needle of forbidden) {
    const hit = strings.find((entry) => entry.value === needle);
    expect(hit, `${label} leaked ${needle} at ${hit?.path}`).toBeUndefined();
  }
}

function openChoiceInteraction(
  state: GameState,
  responsiblePlayerIds: string[],
  continuation: ChoiceContinuation,
): void {
  const interaction: ChoiceInteraction = {
    id: 'interaction-fixture',
    kind: 'choice',
    responsiblePlayerIds,
    explanation: 'fixture',
    allowed: ['option', 'players', 'voters', 'slots', 'cards', 'resources'],
    allowPass: true,
    sourceCardId: 'SH4INHL001',
    continuation,
  };
  state.pendingInteraction = interaction;
}

function promptContext(state: GameState, playerId: string): ChoicePromptContext {
  const prompt = viewFor(state, playerId).prompt;
  if (prompt?.kind !== 'choice') {
    throw new Error(`Expected a choice prompt for ${playerId}`);
  }
  return prompt.context;
}

describe('setup, cap, and majority prompts', () => {
  it('shows the first-player vote only to players who have not voted', () => {
    const state = createGame(config, CORE_CONTENT, 7);
    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('firstPlayerVote');
    const voted = accepted(state, 'p1', { type: 'VoteForFirstPlayer', candidateId: 'p2' });

    expect(viewFor(voted, 'p1').prompt).toBeUndefined();
    const waiting = viewFor(voted, 'p2').prompt;
    expect(waiting?.kind).toBe('firstPlayerVote');
    expect(waiting?.kind === 'firstPlayerVote' && waiting.remainingPlayerIds).toEqual(['p2', 'p3']);
    expect(publicView(voted).prompt).toBeUndefined();
    expect(publicView(voted).legalActions).toEqual([]);
  });

  it('shows the starting-resource prompt only to the player still choosing', () => {
    let state = startedVote();
    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('startingResources');
    const order = interaction?.kind === 'startingResources' ? [...interaction.remainingPlayerIds] : [];
    expect(order).toHaveLength(3);

    for (const playerId of order) {
      expect(viewFor(state, playerId).prompt?.kind).toBe('startingResources');
    }
    expect(publicView(state).prompt).toBeUndefined();

    state = accepted(state, order[0]!, {
      type: 'ChooseStartingResources',
      resources: { cash: 1, influence: 0, press: 0, faith: 0 },
    });
    expect(viewFor(state, order[0]!).prompt).toBeUndefined();
    const waiting = viewFor(state, order[1]!).prompt;
    expect(waiting?.kind).toBe('startingResources');
    expect(waiting?.kind === 'startingResources' && waiting.remainingPlayerIds).toEqual(order.slice(1));
  });

  it('hides the drawn policy card ID, its answer rewards, and the draw pile', () => {
    const state = startedGame();
    const answerInteraction = state.pendingInteraction;
    expect(answerInteraction?.kind).toBe('policyAnswer');
    const cardId = answerInteraction?.kind === 'policyAnswer' ? answerInteraction.cardId : '';
    const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId);
    expect(card).toBeDefined();

    const owner = viewFor(state, answerInteraction?.kind === 'policyAnswer' ? answerInteraction.playerId : 'p1');
    expect(owner.prompt?.kind).toBe('policyAnswer');
    expect(owner.prompt?.kind === 'policyAnswer' && owner.prompt.question).toBe(card?.question);
    expectAbsent(owner, [cardId, card!.answers[0].archetype, card!.answers[1].archetype], 'policy prompt');

    for (const playerId of ['p1', 'p2', 'p3']) {
      expectAbsent(viewFor(state, playerId), [cardId, ...state.policyDeck.drawPile.slice(0, 20)], `player ${playerId}`);
    }
    expectAbsent(publicView(state), [cardId], 'public');
  });

  it('shows the cap-discard prompt only to the over-capped player', () => {
    const state = activeState();
    state.pendingInteraction = {
      id: 'interaction-cap',
      kind: 'capDiscard',
      responsiblePlayerIds: ['p2'],
      playerId: 'p2',
      excess: 3,
      continuation: 'resumeAction',
    };
    const owner = viewFor(state, 'p2').prompt;
    expect(owner?.kind).toBe('capDiscard');
    expect(owner?.kind === 'capDiscard' && owner.excess).toBe(3);
    expect(viewFor(state, 'p1').prompt).toBeUndefined();
    expect(viewFor(state, 'p3').prompt).toBeUndefined();
    expect(publicView(state).prompt).toBeUndefined();
  });

  it('shows the majority-selection prompt only to the zone owner', () => {
    const state = activeState();
    state.pendingInteraction = {
      id: 'interaction-majority',
      kind: 'majoritySelection',
      responsiblePlayerIds: ['p3'],
      playerId: 'p3',
      zoneId: 'central',
      required: 2,
      eligibleVoterIds: ['p3-voter-1', 'p3-voter-2', 'p3-voter-3'],
      continuation: 'action',
    };
    const owner = viewFor(state, 'p3').prompt;
    expect(owner?.kind).toBe('majoritySelection');
    expect(owner?.kind === 'majoritySelection' && owner.eligibleVoterIds).toHaveLength(3);
    expect(viewFor(state, 'p1').prompt).toBeUndefined();
    expect(publicView(state).prompt).toBeUndefined();
  });
});

/**
 * One fixture per continuation the engine can open. `Record<ChoicePromptOp, …>`
 * makes the compiler reject a new operation until this file describes it.
 */
const OP_FIXTURES: Record<ChoicePromptOp, {
  responsible: string[];
  unrelated: string;
  continuation: Omit<ChoiceContinuation, 'op'>;
  check: (context: ChoicePromptContext) => void;
}> = {
  campaignVote: {
    responsible: ['p2', 'p3'],
    unrelated: 'p1',
    continuation: {
      prizeCardId: 'TRK004',
      voterIds: ['p1', 'p2', 'p3'],
      candidateIds: ['p1', 'p2', 'p3'],
      ballots: ['p1=p2'],
      round: 2,
    },
    check: (context) => {
      expect(context.op).toBe('campaignVote');
      if (context.op !== 'campaignVote') return;
      expect(context.prizeCardId).toBe('TRK004');
      expect(context.ballotsCast).toBe(1);
      expect(context.awaitingPlayerIds).toEqual(['p2', 'p3']);
      expect(context.round).toBe(2);
    },
  },
  auction: {
    responsible: ['p2'],
    unrelated: 'p3',
    continuation: {
      sellerId: 'p1',
      cardId: 'TRK009',
      minimumBid: 2,
      currentBid: 3,
      currentBidderId: 'p3',
      bidders: ['p2', 'p3'],
      passed: ['p3'],
      cursor: 1,
    },
    check: (context) => {
      expect(context.op).toBe('auction');
      if (context.op !== 'auction') return;
      expect(context.sellerId).toBe('p1');
      expect(context.currentBid).toBe(3);
      expect(context.bidderOrder).toEqual(['p2', 'p3']);
      expect(JSON.stringify(context)).not.toContain('TRK009');
    },
  },
  trickPriority: {
    responsible: ['p3'],
    unrelated: 'p2',
    continuation: {
      playedCardId: 'TRK002',
      actorId: 'p1',
      responders: ['p2', 'p3'],
      passed: ['p2'],
      mode: 'triple',
    },
    check: (context) => {
      expect(context.op).toBe('trickPriority');
      if (context.op !== 'trickPriority') return;
      expect(context.playedByPlayerId).toBe('p1');
      expect(context.passedPlayerIds).toEqual(['p2']);
    },
  },
  chaiOpponent: {
    responsible: ['p1'],
    unrelated: 'p2',
    // Reversed, because the unreversed shape was already covered and the reversed one was
    // not: `chaiOpponent` accepts only the original player, and until Session 20 it was
    // the one reversible continuation whose restriction never reached the prompt.
    continuation: { ownerId: 'p1', reversedFromPlayerId: 'p3' },
    check: (context) => {
      expect(context.op).toBe('chaiOpponent');
      if (context.op !== 'chaiOpponent') return;
      expect(context.eligiblePlayerIds).toEqual(['p2', 'p3']);
      expect(context.restrictToPlayerId).toBe('p3');
    },
  },
  chaiResource: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', opponentId: 'p2' },
    check: (context) => {
      expect(context.op).toBe('chaiResource');
      if (context.op !== 'chaiResource') return;
      expect(context.opponentId).toBe('p2');
      expect(context.optionIds).toEqual(['cash', 'influence', 'press', 'faith']);
    },
  },
  turncoatTrack: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('turncoatTrack');
      if (context.op !== 'turncoatTrack') return;
      expect(context.optionIds).toHaveLength(4);
    },
  },
  blockOpen: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('blockOpen');
      if (context.op !== 'blockOpen') return;
      expect(Array.isArray(context.openCardIds)).toBe(true);
    },
  },
  accentFlip: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('accentFlip');
      if (context.op !== 'accentFlip') return;
      expect(Array.isArray(context.policyCardIds)).toBe(true);
    },
  },
  bharatVoters: {
    responsible: ['p1'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', reversedFromPlayerId: 'p2' },
    check: (context) => {
      expect(context.op).toBe('bharatVoters');
      if (context.op !== 'bharatVoters') return;
      expect(context.exactly).toBe(5);
      expect(context.restrictToPlayerId).toBe('p2');
    },
  },
  bharatOwners: {
    responsible: ['p1'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', voterIds: ['p2-voter-1', 'p2-voter-2'] },
    check: (context) => {
      expect(context.op).toBe('bharatOwners');
      if (context.op !== 'bharatOwners') return;
      expect(context.voterIds).toHaveLength(2);
      expect(context.eligiblePlayerIds).toEqual(['p2', 'p3']);
    },
  },
  cultZone: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => expect(context.op).toBe('cultZone'),
  },
  cultStolenZone: {
    responsible: ['p2'],
    unrelated: 'p3',
    continuation: { ownerId: 'p2', effectId: 'effect-17' },
    check: (context) => {
      expect(context.op).toBe('cultStolenZone');
      expect(JSON.stringify(context)).not.toContain('effect-17');
    },
  },
  notOneTarget: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('notOneTarget');
      if (context.op !== 'notOneTarget') return;
      expect(context.optionFormat).toBe('playerZone');
      expect(context.eligibleZoneIds).toHaveLength(9);
    },
  },
  imprisonVoters: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('imprisonVoters');
      if (context.op !== 'imprisonVoters') return;
      expect(context.exactly).toBe(5);
    },
  },
  hostageVoters: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('hostageVoters');
      if (context.op !== 'hostageVoters') return;
      expect(context.exactly).toBe(4);
    },
  },
  redevelopmentDiscard: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', zoneId: 'central', effectId: 'effect-9' },
    check: (context) => {
      expect(context.op).toBe('redevelopmentDiscard');
      if (context.op !== 'redevelopmentDiscard') return;
      expect(context.zoneId).toBe('central');
      expect(JSON.stringify(context)).not.toContain('effect-9');
    },
  },
  documentsVoters: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('documentsVoters');
      if (context.op !== 'documentsVoters') return;
      expect(context.maximum).toBe(4);
    },
  },
  slumdogSwap: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('slumdogSwap');
      if (context.op !== 'slumdogSwap') return;
      expect(context.allowedCounts).toEqual([2, 4, 6]);
    },
  },
  cornerstoneGain: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('cornerstoneGain');
      if (context.op !== 'cornerstoneGain') return;
      expect(context.resourceTotal).toBe(4);
    },
  },
  cornerstoneZone: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('cornerstoneZone');
      if (context.op !== 'cornerstoneZone') return;
      expect(context.eligibleZoneIds).toEqual(['northWest', 'northEast', 'southWest', 'southEast']);
    },
  },
  dostiTarget: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => expect(context.op).toBe('dostiTarget'),
  },
  mansplainTarget: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => expect(context.op).toBe('mansplainTarget'),
  },
  nerosMoves: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', zoneId: 'south' },
    check: (context) => {
      expect(context.op).toBe('nerosMoves');
      if (context.op !== 'nerosMoves') return;
      expect(context.zoneId).toBe('south');
      expect(context.pairs).toBe(3);
    },
  },
  poloPlayers: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1' },
    check: (context) => {
      expect(context.op).toBe('poloPlayers');
      if (context.op !== 'poloPlayers') return;
      expect(context.eligiblePlayerIds).toEqual(['p1', 'p2', 'p3']);
    },
  },
  poloFallback: {
    responsible: ['p1'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', playerIds: ['p1', 'p2'] },
    check: (context) => {
      expect(context.op).toBe('poloFallback');
      if (context.op !== 'poloFallback') return;
      expect(context.playerIds).toEqual(['p1', 'p2']);
    },
  },
  karachiKeep: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', drawn: ['TRK011', 'TRK012', 'TRK013'] },
    check: (context) => {
      expect(context.op).toBe('karachiKeep');
      if (context.op !== 'karachiKeep') return;
      expect(context.drawnCardIds).toHaveLength(3);
    },
  },
  blessingsKeep: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', drawn: ['SH4INVC001', 'SH4INVC002'] },
    check: (context) => {
      expect(context.op).toBe('blessingsKeep');
      if (context.op !== 'blessingsKeep') return;
      expect(context.drawnCardIds).toHaveLength(2);
    },
  },
  blessingsDonate: {
    responsible: ['p1'],
    unrelated: 'p2',
    continuation: { ownerId: 'p1', keptCardId: 'SH4INVC001', donatedCardId: 'SH4INVC002' },
    check: (context) => {
      expect(context.op).toBe('blessingsDonate');
      if (context.op !== 'blessingsDonate') return;
      expect(context.donatedCardId).toBe('SH4INVC002');
    },
  },
  blessingsPlace: {
    responsible: ['p2'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', groupIds: ['group-fixture', 'group-second'] },
    check: (context) => {
      expect(context.op).toBe('blessingsPlace');
      if (context.op !== 'blessingsPlace') return;
      expect(context.groupId).toBe('group-fixture');
      expect(JSON.stringify(context)).not.toContain('group-second');
    },
  },
  greatLeaderMove: {
    responsible: ['p2'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', remaining: 2 },
    check: (context) => {
      expect(context.op).toBe('greatLeaderMove');
      if (context.op !== 'greatLeaderMove') return;
      expect(context.remainingMoves).toBe(2);
    },
  },
  floodReliefMove: {
    responsible: ['p1'],
    unrelated: 'p3',
    continuation: { ownerId: 'p1', queue: ['p1', 'p2', 'p3'] },
    check: (context) => {
      expect(context.op).toBe('floodReliefMove');
      if (context.op !== 'floodReliefMove') return;
      expect(context.queuePlayerIds).toEqual(['p1', 'p2', 'p3']);
    },
  },
  coughEvict: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'], broken: ['p2'] },
    check: (context) => {
      expect(context.op).toBe('coughEvict');
      if (context.op !== 'coughEvict') return;
      expect(context.exactly).toBe(1);
      expect(context.queuePlayerIds).toEqual(['p2', 'p3']);
    },
  },
  coughReward: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'], broken: ['p2'] },
    check: (context) => {
      expect(context.op).toBe('coughReward');
      if (context.op !== 'coughReward') return;
      expect(context.resourceTotal).toBe(1);
    },
  },
  limitsConvert: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'] },
    check: (context) => {
      expect(context.op).toBe('limitsConvert');
      if (context.op !== 'limitsConvert') return;
      expect(context.exactly).toBe(2);
      expect(context.leftPlayerId).toBe('p3');
    },
  },
  limitsReward: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', rewardPlayerId: 'p2', queue: ['p3'] },
    check: (context) => {
      expect(context.op).toBe('limitsReward');
      if (context.op !== 'limitsReward') return;
      expect(context.resourceTotal).toBe(2);
    },
  },
  goalparaCard: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'] },
    check: (context) => {
      expect(context.op).toBe('goalparaCard');
      if (context.op !== 'goalparaCard') return;
      expect(context.marketCardIds.length).toBeGreaterThan(0);
    },
  },
  goalparaReward: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', rewardPlayerId: 'p2', generic: 3, queue: ['p3'] },
    check: (context) => {
      expect(context.op).toBe('goalparaReward');
      if (context.op !== 'goalparaReward') return;
      expect(context.resourceTotal).toBe(3);
    },
  },
  oxyChoice: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'] },
    check: (context) => {
      expect(context.op).toBe('oxyChoice');
      if (context.op !== 'oxyChoice') return;
      expect(context.eligiblePlayerIds).toEqual(['p1', 'p3']);
    },
  },
  oxyPlace: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', groupId: 'group-oxy', queue: ['p3'] },
    check: (context) => {
      expect(context.op).toBe('oxyPlace');
      if (context.op !== 'oxyPlace') return;
      expect(context.groupId).toBe('group-oxy');
    },
  },
  donatePolicy: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', queue: ['p2', 'p3'] },
    check: (context) => {
      expect(context.op).toBe('donatePolicy');
      if (context.op !== 'donatePolicy') return;
      expect(context.recipientPlayerId).toBe('p3');
    },
  },
  donationReward: {
    responsible: ['p2'],
    unrelated: 'p1',
    continuation: { ownerId: 'p1', donorId: 'p2', queue: ['p3'] },
    check: (context) => {
      expect(context.op).toBe('donationReward');
      if (context.op !== 'donationReward') return;
      expect(context.resourceTotal).toBe(6);
    },
  },
};

/** Internal continuation keys that must never appear anywhere in a projection. */
const SERVER_ONLY_KEYS = [
  'handlerId',
  'deck',
  'effectId',
  'ballots',
  'reversedFromPlayerId',
  'triggerSlotId',
  'triggerVoterId',
  'drawn',
  'broken',
  'rewardPlayerId',
  'donorId',
  'groupIds',
  'cursor',
  'drawPile',
  'discardPile',
  'random',
  'continuation',
] as const;

describe('typed choice prompts', () => {
  const ops = Object.keys(OP_FIXTURES) as ChoicePromptOp[];

  it.each(ops)('projects %s as typed, authorized prompt data', (op) => {
    const fixture = OP_FIXTURES[op];
    const state = activeState();
    openChoiceInteraction(state, [...fixture.responsible], {
      ...fixture.continuation,
      op,
      handlerId: 'trick.skimming',
      deck: 'trick',
    } as ChoiceContinuation);

    for (const playerId of fixture.responsible) {
      const context = promptContext(state, playerId);
      expect(context.op).not.toBe('unsupported');
      fixture.check(context);
      const keys = collectKeys(viewFor(state, playerId));
      for (const forbidden of SERVER_ONLY_KEYS) {
        expect(keys, `${op} exposed ${forbidden}`).not.toContain(forbidden);
      }
      expectAbsent(viewFor(state, playerId), ['trick.skimming'], `${op} responsible view`);
    }

    expect(viewFor(state, fixture.unrelated).prompt, `${op} reached an unrelated player`).toBeUndefined();
    expect(publicView(state).prompt, `${op} reached the public view`).toBeUndefined();
  });

  it('marks an undescribed continuation unsupported instead of forwarding it', () => {
    const state = activeState();
    openChoiceInteraction(state, ['p1'], {
      op: 'notAnOperation',
      secretDeckOrder: ['TRK001', 'TRK002'],
    } as unknown as ChoiceContinuation);
    const context = promptContext(state, 'p1');
    expect(context).toEqual({ op: 'unsupported' });
  });
});

describe('recursive privacy guarantees', () => {
  it('never exposes deck order, RNG state, or opponent trick hands', () => {
    const state = activeState();
    const p2 = state.players.find((player) => player.id === 'p2')!;
    p2.trickHand = [state.trickDeck.drawPile.shift()!, state.trickDeck.drawPile.shift()!];
    state.random = { value: 1234567, draws: 9 };

    const forbidden = [
      ...state.policyDeck.drawPile,
      ...state.voterDeck.drawPile,
      ...state.newsDeck.drawPile,
      ...state.trickDeck.drawPile,
      ...p2.trickHand,
    ];
    const view = viewFor(state, 'p1');
    expectAbsent(view, forbidden, 'opponent view');

    const numbers: number[] = [];
    walk(view, 'view', (_path, key, leaf) => {
      if (key === null && typeof leaf === 'number') {
        numbers.push(leaf);
      }
    });
    expect(numbers).not.toContain(1234567);

    const owner = viewFor(state, 'p2');
    expect(owner.privateTrickIds).toEqual(p2.trickHand);
    expect(viewFor(state, 'p1').privateTrickIds).toEqual([]);
    expect(publicView(state).privateTrickIds).toBeUndefined();
  });

  it('keeps submitted campaign ballots out of every view', () => {
    let state = activeState();
    const prizeCardId = state.trickDeck.drawPile.shift()!;
    startVote(state, 'SH4INHL017', prizeCardId, ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']);
    const interactionId = state.pendingInteraction!.id;
    state = accepted(state, 'p1', { type: 'SubmitVote', interactionId, optionId: 'p2' });

    for (const playerId of ['p1', 'p2', 'p3']) {
      const view = viewFor(state, playerId);
      expectAbsent(view, ['p1=p2'], `voter ${playerId}`);
      expect(collectKeys(view)).not.toContain('ballots');
    }
    const remaining = promptContext(state, 'p2');
    expect(remaining.op).toBe('campaignVote');
    expect(remaining.op === 'campaignVote' && remaining.ballotsCast).toBe(1);
    expect(remaining.op === 'campaignVote' && remaining.awaitingPlayerIds).toEqual(['p2', 'p3']);
  });

  it('keeps the secretly chosen auction card hidden from bidders', () => {
    const state = activeState();
    const secretCardId = state.trickDeck.drawPile[0]!;
    startAuction(state, 'SH4INHL013', 'p1', secretCardId, 2);

    for (const playerId of ['p1', 'p2', 'p3']) {
      expectAbsent(viewFor(state, playerId), [secretCardId], `auction participant ${playerId}`);
    }
    const bidder = promptContext(state, 'p2');
    expect(bidder.op).toBe('auction');
    expect(bidder.op === 'auction' && bidder.sellerId).toBe('p1');
    expect(bidder.op === 'auction' && bidder.minimumBid).toBe(2);
  });

  it('exposes committed policy cards only to their owner', () => {
    const state = activeState();
    const card = CORE_CONTENT.policyCards[0]!;
    state.players[0]!.retainedPolicy.push({
      cardId: card.id,
      answerIndex: 0,
      archetype: card.answers[0].archetype,
    });

    expect(viewFor(state, 'p1').privatePolicyCards).toEqual([
      { cardId: card.id, answerIndex: 0, archetype: card.answers[0].archetype },
    ]);
    expectAbsent(viewFor(state, 'p2'), [card.id], 'opponent policy view');
    expectAbsent(publicView(state), [card.id], 'public policy view');
    expect(viewFor(state, 'p2').players.find((player) => player.id === 'p1')?.policyCounts[card.answers[0].archetype])
      .toBe(1);
  });

  it('exposes held voters and their buyback price only to the voters’ owner', () => {
    const state = activeState();
    const heldVoter = state.voters.find((voter) => voter.ownerId === 'p2')!;
    heldVoter.location = { kind: 'removed', reason: 'TRK006' };
    state.activeEffects.push({
      id: 'effect-held',
      sourceCardId: 'TRK006',
      ownerId: 'p1',
      kind: 'dragnet',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: { heldVoterIds: [heldVoter.id] },
    });

    expect(viewFor(state, 'p2').privateHeldVoters).toEqual([
      { voterId: heldVoter.id, sourceCardId: 'TRK006', holderId: 'p1', buybackCost: 1 },
    ]);
    expect(viewFor(state, 'p1').privateHeldVoters).toEqual([]);
    expect(publicView(state).privateHeldVoters).toBeUndefined();
  });

  it('gives each seat its own voter supply and no other seat’s', () => {
    const state = activeState();
    const placed = state.voters.filter((voter) => voter.ownerId === 'p1').slice(0, 3);
    const slots = state.slots.slice(0, placed.length);
    placed.forEach((voter, index) => {
      const slot = slots[index]!;
      voter.location = { kind: 'board', slotId: slot.slotId, majority: false };
      slot.voterId = voter.id;
    });
    const evicted = state.voters.find(
      (voter) => voter.ownerId === 'p1' && voter.location.kind === 'supply',
    )!;
    evicted.location = { kind: 'evicted', availableOnTurnOrdinal: 4 };

    // The figure is the seat's own pile, which is exactly what a player at a table counts.
    expect(viewFor(state, 'p1').privateVoterSupply).toBe(VOTER_SUPPLY_PER_PLAYER - 4);
    expect(viewFor(state, 'p2').privateVoterSupply).toBe(VOTER_SUPPLY_PER_PLAYER);
    expect(publicView(state).privateVoterSupply).toBeUndefined();

    // And it is on the viewer's own seat rather than on every seat, because the public
    // board plus a public supply would publish `evicted + held` by subtraction — the one
    // count `privateEvictedVoters` and `privateHeldVoters` exist to keep private. p2's
    // view carries its own figure and nothing about p1's four missing tokens.
    const p2 = viewFor(state, 'p2');
    expect(p2.privateEvictedVoters).toEqual([]);
    expect(collectKeys(p2).filter((key) => key.toLowerCase().includes('supply')))
      .toEqual(['privateVoterSupply']);
  });

  it('publishes the Turncoat track and its exact acquisition price', () => {
    const state = activeState();
    const card = CORE_CONTENT.policyCards[1]!;
    for (let index = 0; index < 3; index += 1) {
      state.players[0]!.retainedPolicy.push({ cardId: card.id, answerIndex: 0, archetype: 'nationalist' });
    }
    state.activeEffects.push({
      id: 'effect-turncoat',
      sourceCardId: 'TRK005',
      ownerId: 'p1',
      kind: 'turncoatArchetype',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: { playerId: 'p1', archetype: 'nationalist' },
    });

    expect(viewFor(state, 'p2').turncoatHoldings).toEqual([
      // Three retained Nationalist cards plus the Turncoat placement itself.
      { effectId: 'effect-turncoat', ownerId: 'p1', archetype: 'nationalist', acquisitionCost: 4 },
    ]);
    expect(publicView(state).turncoatHoldings).toHaveLength(1);
  });

  it('shows a trade offer only to its two participants', () => {
    let state = activeState();
    state.publicReserve.cash -= 4;
    state.players[0]!.resources.cash += 4;
    state.publicReserve.influence -= 1;
    state.players[1]!.resources.influence += 1;
    state = accepted(state, 'p1', {
      type: 'ProposeTrade',
      opponentId: 'p2',
      giveResources: { cash: 4, influence: 0, press: 0, faith: 0 },
      receiveResources: { cash: 0, influence: 1, press: 0, faith: 0 },
      giveTrickIds: [],
      receiveTrickIds: [],
    });

    expect(viewFor(state, 'p1').privateTradeOffers).toHaveLength(1);
    expect(viewFor(state, 'p2').privateTradeOffers).toHaveLength(1);
    expect(viewFor(state, 'p3').privateTradeOffers).toHaveLength(0);
    expect(publicView(state).privateTradeOffers).toBeUndefined();
  });
});

/**
 * The two facts the shared table surface needs and previously had to read from the
 * authoritative state: who the match is waiting on, and what it was created with.
 */
describe('public setup summary and pending decision', () => {
  it('projects the immutable setup to every viewer, including the public one', () => {
    const state = createGame(
      { ...config, contentAdvisories: ['trigger'] },
      CORE_CONTENT,
      11,
    );
    const expected = {
      matchId: 'projection-privacy',
      playerCount: 3,
      tiePolicy: 'jointWinners',
      contentAdvisories: ['trigger'],
      contentPackId: state.content.contentPackId,
      contentVersion: state.content.contentVersion,
      rulesetId: state.content.rulesetId,
      rulesetVersion: state.content.rulesetVersion,
      boardId: state.content.boardId,
      boardVersion: state.content.boardVersion,
      engineVersion: state.engineVersion,
      schemaVersion: state.schemaVersion,
    };
    expect(publicView(state).setup).toEqual(expected);
    expect(viewFor(state, 'p2').setup).toEqual(expected);
  });

  it('names every seat still to vote for the first player', () => {
    const state = accepted(
      createGame(config, CORE_CONTENT, 7),
      'p1',
      { type: 'VoteForFirstPlayer', candidateId: 'p2' },
    );
    const decision = publicView(state).pendingDecision;
    expect(decision?.kind).toBe('firstPlayerVote');
    // p1 has voted, so the match is no longer waiting on p1.
    expect(decision?.responsiblePlayerIds).toEqual(['p2', 'p3']);
    expect(decision?.sourceCardId).toBeUndefined();
  });

  it('names the answering seat without naming the card it drew', () => {
    const state = startedGame();
    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('policyAnswer');
    const cardId = interaction?.kind === 'policyAnswer' ? interaction.cardId : '';

    const decision = publicView(state).pendingDecision;
    expect(decision?.kind).toBe('policyAnswer');
    expect(decision?.responsiblePlayerIds).toEqual([
      interaction?.kind === 'policyAnswer' ? interaction.playerId : '',
    ]);
    expect(decision?.summary).toBe('Answering a hidden Policy Card.');
    expectAbsent(publicView(state), [cardId], 'public pending decision');
  });

  it('names a decision owner who is not the active player', () => {
    const state = activeState();
    // The active seat is p1; an auction moves the pending decision to the next bidder.
    startAuction(state, 'SH4INHL013', 'p1', state.trickDeck.drawPile[0]!, 2);

    const decision = publicView(state).pendingDecision;
    expect(publicView(state).activePlayerId).toBe('p1');
    expect(decision?.kind).toBe('choice');
    expect(decision?.responsiblePlayerIds).toEqual(['p2']);
    expect(decision?.sourceCardId).toBe('SH4INHL013');
    // The trick on the block is still secret in the public decision.
    expectAbsent(publicView(state), [state.trickDeck.drawPile[0]!], 'public auction decision');
  });

  it('omits the pending decision when no interaction is open', () => {
    expect(publicView(activeState()).pendingDecision).toBeUndefined();
  });
});

/**
 * Session 21's four public additions.
 *
 * Every one of them is something anyone at a physical table can see, so each is asserted
 * to reach the *public* viewer as well as a seat's own. They are here rather than in a
 * flow suite because the recursive scan above is what proves nothing private came along
 * with them, and these assert the other half: that the field is really there for everyone.
 */
describe('public projection gaps closed in session 21', () => {
  it('publishes the effect kind beside the printed title', () => {
    const state = activeState();
    state.activeEffects.push({
      id: 'effect-1',
      sourceCardId: 'NEWS012',
      ownerId: 'p1',
      kind: 'tabloidScandal',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: {},
    });
    for (const view of [viewFor(state, 'p1'), viewFor(state, 'p2'), publicView(state)]) {
      expect(view.activeEffects[0]!.kind).toBe('tabloidScandal');
      expect(view.activeEffects[0]!.title).toBe('Tabloid Scandal');
    }
  });

  it('publishes the bank and the current turn ordinal to every viewer', () => {
    const state = activeState();
    state.publicReserve = { cash: 3, influence: 0, press: 7, faith: 1 };
    state.turn.ordinal = 12;
    for (const view of [viewFor(state, 'p1'), viewFor(state, 'p3'), publicView(state)]) {
      expect(view.publicReserve).toEqual({ cash: 3, influence: 0, press: 7, faith: 1 });
      expect(view.turnOrdinal).toBe(12);
    }
    // A copy, so a client cannot write through the projection into the authority.
    viewFor(state, 'p1').publicReserve.cash = 99;
    expect(state.publicReserve.cash).toBe(3);
  });

  it('publishes a pending group’s deadline and its allowed zones', () => {
    const state = activeState();
    state.turn.ordinal = 5;
    const voters = state.voters.filter((voter) => voter.ownerId === 'p1').slice(0, 2);
    for (const voter of voters) voter.location = { kind: 'pending', groupId: 'group-1' };
    state.pendingVoterGroups.push({
      id: 'group-1',
      ownerId: 'p1',
      controllerId: 'p1',
      voterIds: voters.map((voter) => voter.id),
      origin: { kind: 'effect', sourceCardId: 'TRK001' },
      sameZone: true,
      allowedZoneIds: ['northWest'],
      deadlineTurnOrdinal: 5,
    });
    for (const view of [viewFor(state, 'p1'), viewFor(state, 'p2'), publicView(state)]) {
      const group = view.pendingVoterGroups[0]!;
      expect(group.deadlineTurnOrdinal).toBe(5);
      expect(group.allowedZoneIds).toEqual(['northWest']);
    }
  });

  it('omits allowedZoneIds for an unrestricted group rather than publishing an empty list', () => {
    // Absent means unrestricted, exactly as it does on the engine's own group. An empty
    // array would read as "no zone is allowed", which is the opposite.
    const state = activeState();
    const voters = state.voters.filter((voter) => voter.ownerId === 'p1').slice(0, 1);
    for (const voter of voters) voter.location = { kind: 'pending', groupId: 'group-2' };
    state.pendingVoterGroups.push({
      id: 'group-2',
      ownerId: 'p1',
      controllerId: 'p1',
      voterIds: voters.map((voter) => voter.id),
      origin: { kind: 'eviction' },
      sameZone: false,
      deadlineTurnOrdinal: 1,
    });
    const group = publicView(state).pendingVoterGroups[0]!;
    expect(group.allowedZoneIds).toBeUndefined();
    expect('allowedZoneIds' in group).toBe(false);
  });
});
