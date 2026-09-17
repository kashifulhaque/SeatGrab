import type { ResourceVector } from '@seatgrab/content';
import { shuffle } from '../random/prng.js';
import type { GameContent } from '../content.js';
import {
  BASE_RESOURCE_CAP,
  GAME_SCHEMA_VERSION,
  RESOURCE_SUPPLY_PER_TYPE,
  VOTER_SUPPLY_PER_PLAYER,
  type GameConfig,
  type GameState,
  type RandomState,
  type UsageCounters,
} from '../model/state.js';
import { assertGameState } from '../rules/invariants.js';
import { validateEffectRegistry } from './effects.js';

export const ENGINE_VERSION = '0.1.0';

function initialUsage(): UsageCounters {
  return {
    arbitrage: 0,
    shakedown: 0,
    demolition: 0,
    crackdown: 0,
    groundswellCardIds: [],
    volunteers: 0,
    outreach: 0,
    threeVoterPurchases: 0,
    gerrymandersByRightsZone: {},
  };
}

function zeroResources(): ResourceVector {
  return { cash: 0, influence: 0, press: 0, faith: 0 };
}

export function createGame(config: GameConfig, content: GameContent, seed: number): GameState {
  if (config.players.length < 3 || config.players.length > 5) {
    throw new Error('SeatGrab seats 3 to 5 players');
  }
  const playerIds = config.players.map((player) => player.id);
  const partyIds = config.players.map((player) => player.partyId);
  if (new Set(playerIds).size !== playerIds.length || new Set(partyIds).size !== partyIds.length) {
    throw new Error('Player and party IDs must be unique');
  }
  if (!config.matchId) {
    throw new Error('matchId must not be empty');
  }
  for (const player of config.players) {
    const controller = player.controller ?? 'human';
    if (controller === 'computer' && player.difficulty === undefined) {
      throw new Error('A computer seat must name a difficulty');
    }
    if (controller !== 'computer' && player.difficulty !== undefined) {
      throw new Error('Only a computer seat may name a difficulty');
    }
  }
  if (!config.players.some((player) => (player.controller ?? 'human') === 'human')) {
    throw new Error('A table needs at least one human seat');
  }
  validateEffectRegistry(content);

  let random: RandomState = { value: seed >>> 0, draws: 0 };
  const voterShuffle = shuffle(content.voterCards.map((card) => card.id), random);
  random = voterShuffle.state;
  const policyShuffle = shuffle(
    content.policyCards
      .filter((card) => card.advisory === undefined || !config.contentAdvisories.includes(card.advisory))
      .map((card) => card.id),
    random,
  );
  random = policyShuffle.state;
  const newsShuffle = shuffle(
    content.newsCards
      .filter((card) => card.advisory === undefined || !config.contentAdvisories.includes(card.advisory))
      .map((card) => card.id),
    random,
  );
  random = newsShuffle.state;
  const trickShuffle = shuffle(
    content.trickCards
      .filter((card) => card.advisory === undefined || !config.contentAdvisories.includes(card.advisory))
      .map((card) => card.id),
    random,
  );
  random = trickShuffle.state;

  const market = voterShuffle.items.splice(0, 3);
  const completedTurns = Object.fromEntries(playerIds.map((playerId) => [playerId, 0]));
  const state: GameState = {
    schemaVersion: GAME_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    matchId: config.matchId,
    revision: 0,
    config: structuredClone(config),
    content: {
      contentPackId: content.contentPackId,
      contentVersion: content.contentVersion,
      rulesetId: content.rulesetId,
      rulesetVersion: content.rulesetVersion,
      boardId: content.board.id,
      boardVersion: content.board.version,
    },
    status: 'setup',
    players: config.players.map((player, seat) => ({
      id: player.id,
      displayName: player.displayName,
      partyId: player.partyId,
      seat,
      connected: true,
      resources: zeroResources(),
      retainedPolicy: [],
      trickHand: [],
      debts: [],
      obligations: [],
    })),
    publicReserve: {
      cash: RESOURCE_SUPPLY_PER_TYPE,
      influence: RESOURCE_SUPPLY_PER_TYPE,
      press: RESOURCE_SUPPLY_PER_TYPE,
      faith: RESOURCE_SUPPLY_PER_TYPE,
    },
    voters: config.players.flatMap((player) =>
      Array.from({ length: VOTER_SUPPLY_PER_PLAYER }, (_, index) => ({
        id: `${player.id}-voter-${String(index + 1).padStart(2, '0')}`,
        ownerId: player.id,
        location: { kind: 'supply' as const },
      })),
    ),
    slots: content.board.slots.map((slot) => ({ slotId: slot.slotId, voterId: null })),
    voterDeck: {
      drawPile: voterShuffle.items,
      discardPile: [],
      market,
      marketRevision: 0,
    },
    policyDeck: { drawPile: policyShuffle.items, discardPile: [] },
    newsDeck: { drawPile: newsShuffle.items, discardPile: [] },
    trickDeck: { drawPile: trickShuffle.items, discardPile: [] },
    pendingVoterGroups: [],
    newsQueue: [],
    activeEffects: [],
    turn: {
      activePlayerId: null,
      order: [...playerIds],
      ordinal: 0,
      completedTurns,
      phase: 'firstPlayerElection',
      usage: initialUsage(),
    },
    pendingInteraction: {
      id: 'interaction-1',
      kind: 'firstPlayerVote',
      responsiblePlayerIds: [...playerIds],
      ballots: {},
      round: 1,
    },
    interactionStack: [],
    tradeOffers: [],
    endTurnContext: null,
    endgame: { normalEndCandidate: false },
    random,
    events: [
      {
        id: 'event-1',
        type: 'GameCreated',
        message: 'First-player election opened.',
        visibility: 'public',
      },
    ],
    nextSequence: 2,
  };

  assertGameState(state, content);
  return state;
}

export { BASE_RESOURCE_CAP };
