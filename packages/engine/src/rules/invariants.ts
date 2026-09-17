import { RESOURCE_TYPES } from '@gerrymander/content';
import type { GameContent } from '../content.js';
import {
  GAME_SCHEMA_VERSION,
  RESOURCE_SUPPLY_PER_TYPE,
  VOTER_SUPPLY_PER_PLAYER,
  resourceEntries,
  type GameState,
} from '../model/state.js';

export class GameInvariantError extends Error {
  override name = 'GameInvariantError';
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new GameInvariantError(message);
  }
}
function continuationCardIds(state: GameState): Set<string> {
  const found = new Set<string>();
  for (const interaction of [
    ...(state.pendingInteraction === null ? [] : [state.pendingInteraction]),
    ...state.interactionStack,
  ]) {
    if (interaction.kind !== 'choice') {
      continue;
    }
    for (const value of Object.values(interaction.continuation)) {
      if (typeof value === 'string') {
        found.add(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            found.add(item);
          }
        }
      }
    }
    if (interaction.sourceCardId !== undefined) {
      found.add(interaction.sourceCardId);
    }
  }
  return found;
}

export function assertGameState(state: GameState, content: GameContent): void {
  invariant(state.schemaVersion === GAME_SCHEMA_VERSION, 'Unsupported game schema version');
  invariant(state.matchId === state.config.matchId, 'Match identity differs from immutable config');
  invariant(state.content.contentPackId === content.contentPackId, 'Content pack ID mismatch');
  invariant(state.content.contentVersion === content.contentVersion, 'Content version mismatch');
  invariant(state.content.rulesetId === content.rulesetId, 'Ruleset ID mismatch');
  invariant(state.content.rulesetVersion === content.rulesetVersion, 'Ruleset version mismatch');
  invariant(state.content.boardId === content.board.id, 'Board ID mismatch');
  invariant(state.content.boardVersion === content.board.version, 'Board version mismatch');
  invariant(state.players.length >= 3 && state.players.length <= 5, 'Base game requires 3 to 5 players');

  const playerIds = state.players.map((player) => player.id);
  const knownPlayers = new Set(playerIds);
  invariant(knownPlayers.size === state.players.length, 'Player IDs are not unique');
  invariant(new Set(state.players.map((player) => player.partyId)).size === state.players.length, 'Party IDs are not unique');
  invariant(new Set(state.players.map((player) => player.seat)).size === state.players.length, 'Seats are not unique');
  invariant(state.turn.order.length === state.players.length && state.turn.order.every((id) => knownPlayers.has(id)), 'Turn order is not a permutation of players');
  invariant(state.turn.activePlayerId === null || knownPlayers.has(state.turn.activePlayerId), 'Active player does not exist');

  for (const resource of RESOURCE_TYPES) {
    let total = state.publicReserve[resource];
    invariant(Number.isSafeInteger(total) && total >= 0, `Reserve ${resource} is invalid`);
    for (const player of state.players) {
      const value = player.resources[resource];
      invariant(Number.isSafeInteger(value) && value >= 0, `${player.id} has invalid ${resource}`);
      total += value;
    }
    invariant(total === RESOURCE_SUPPLY_PER_TYPE, `${resource} supply does not reconcile to ${RESOURCE_SUPPLY_PER_TYPE}`);
  }

  const voterIds = new Set<string>();
  const votersByOwner = new Map<string, number>();
  const boardVoters = new Map<string, string>();
  for (const voter of state.voters) {
    invariant(!voterIds.has(voter.id), `Duplicate voter ${voter.id}`);
    voterIds.add(voter.id);
    invariant(knownPlayers.has(voter.ownerId), `Voter ${voter.id} has unknown owner`);
    votersByOwner.set(voter.ownerId, (votersByOwner.get(voter.ownerId) ?? 0) + 1);
    if (voter.location.kind === 'board') {
      invariant(!boardVoters.has(voter.location.slotId), `Two voters occupy ${voter.location.slotId}`);
      boardVoters.set(voter.location.slotId, voter.id);
    }
  }
  for (const playerId of playerIds) {
    invariant(votersByOwner.get(playerId) === VOTER_SUPPLY_PER_PLAYER, `${playerId} does not own exactly ${VOTER_SUPPLY_PER_PLAYER} voters`);
  }

  const contentSlotIds = new Set(content.board.slots.map((slot) => slot.slotId));
  invariant(contentSlotIds.size === 129, 'Base board does not contain exactly 129 slots');
  invariant(content.board.slots.filter((slot) => slot.volatile).length === 11, 'Base board does not contain exactly 11 volatile slots');
  invariant(state.slots.length === contentSlotIds.size, 'State slot count differs from board');
  const stateSlotIds = new Set<string>();
  for (const slot of state.slots) {
    invariant(contentSlotIds.has(slot.slotId), `Unknown slot ${slot.slotId}`);
    invariant(!stateSlotIds.has(slot.slotId), `Duplicate slot state ${slot.slotId}`);
    stateSlotIds.add(slot.slotId);
    if (slot.voterId === null) {
      invariant(!boardVoters.has(slot.slotId), `Voter points to empty slot ${slot.slotId}`);
    } else {
      invariant(voterIds.has(slot.voterId), `Slot ${slot.slotId} references unknown voter`);
      invariant(boardVoters.get(slot.slotId) === slot.voterId, `Slot ${slot.slotId} and voter location disagree`);
    }
  }

  const pendingGroupIds = new Set(state.pendingVoterGroups.map((group) => group.id));
  invariant(pendingGroupIds.size === state.pendingVoterGroups.length, 'Pending voter group IDs are not unique');
  for (const voter of state.voters) {
    if (voter.location.kind === 'pending') {
      invariant(pendingGroupIds.has(voter.location.groupId), `Voter ${voter.id} references missing pending group`);
    }
  }
  for (const group of state.pendingVoterGroups) {
    invariant(knownPlayers.has(group.ownerId) && knownPlayers.has(group.controllerId), `Pending group ${group.id} references unknown player`);
    invariant(group.voterIds.length > 0 && new Set(group.voterIds).size === group.voterIds.length, `Pending group ${group.id} has invalid voters`);
    for (const voterId of group.voterIds) {
      const voter = state.voters.find((candidate) => candidate.id === voterId);
      invariant(voter?.location.kind === 'pending' && voter.location.groupId === group.id, `Pending group ${group.id} disagrees with voter ${voterId}`);
    }
  }

  const continuationCards = continuationCardIds(state);
  const voterCardIds = [
    ...state.voterDeck.drawPile,
    ...state.voterDeck.discardPile,
    ...state.voterDeck.market,
  ];
  invariant(new Set(voterCardIds).size === voterCardIds.length, 'A voter card appears in multiple deck locations');
  const expectedVoterCardIds = new Set(content.voterCards.map((card) => card.id));
  const inFlightVoterCards = new Set(
    [...continuationCards].filter((cardId) => expectedVoterCardIds.has(cardId)),
  );
  invariant(
    voterCardIds.every((cardId) => !inFlightVoterCards.has(cardId)),
    'A voter card appears in a deck location and an interaction',
  );
  invariant(
    new Set([...voterCardIds, ...inFlightVoterCards]).size === content.voterCards.length,
    'Voter deck does not reconcile to content',
  );

  const expectedPolicy = content.policyCards.filter((card) => card.advisory === undefined || !state.config.contentAdvisories.includes(card.advisory));
  const policyIds = [
    ...state.policyDeck.drawPile,
    ...state.policyDeck.discardPile,
    ...state.players.flatMap((player) => player.retainedPolicy.map((card) => card.cardId)),
    ...[state.pendingInteraction, ...state.interactionStack]
      .filter((interaction) => interaction?.kind === 'policyAnswer')
      .map((interaction) => {
        if (interaction?.kind !== 'policyAnswer') {
          throw new Error('Interaction narrowing failed');
        }
        return interaction.cardId;
      }),
  ];
  invariant(new Set(policyIds).size === policyIds.length, 'An policy card appears in multiple locations');
  invariant(policyIds.length === expectedPolicy.length, 'Policy deck does not reconcile to filtered content');
  const expectedNews = content.newsCards
    .filter((card) => card.advisory === undefined || !state.config.contentAdvisories.includes(card.advisory))
    .map((card) => card.id);
  const expectedTricks = content.trickCards
    .filter((card) => card.advisory === undefined || !state.config.contentAdvisories.includes(card.advisory))
    .map((card) => card.id);
  const activeOrInFlight = new Set([
    ...state.activeEffects.map((effect) => effect.sourceCardId),
    ...continuationCards,
  ]);
  const reconcileEffectDeck = (
    expectedIds: readonly string[],
    directLocations: readonly string[],
    label: string,
  ): void => {
    const expected = new Set(expectedIds);
    invariant(
      directLocations.every((cardId) => expected.has(cardId)),
      `${label} deck contains an unknown or filtered card`,
    );
    invariant(new Set(directLocations).size === directLocations.length, `${label} card appears in multiple direct locations`);
    const inFlight = new Set([...activeOrInFlight].filter((cardId) => expected.has(cardId)));
    invariant(
      directLocations.every((cardId) => !inFlight.has(cardId)),
      `${label} card appears both directly and in flight`,
    );
    invariant(
      new Set([...directLocations, ...inFlight]).size === expectedIds.length,
      `${label} deck does not reconcile to filtered content`,
    );
  };
  reconcileEffectDeck(
    expectedNews,
    [...state.newsDeck.drawPile, ...state.newsDeck.discardPile],
    'News',
  );
  reconcileEffectDeck(
    expectedTricks,
    [
      ...state.trickDeck.drawPile,
      ...state.trickDeck.discardPile,
      ...state.players.flatMap((player) => player.trickHand),
    ],
    'Trick',
  );

  const interactions = [
    ...(state.pendingInteraction === null ? [] : [state.pendingInteraction]),
    ...state.interactionStack,
  ];
  invariant(
    new Set(interactions.map((interaction) => interaction.id)).size === interactions.length,
    'An interaction appears more than once',
  );
  for (const interaction of interactions) {
    invariant(interaction.responsiblePlayerIds.length > 0, 'Pending interaction has no responsible player');
    invariant(interaction.responsiblePlayerIds.every((id) => knownPlayers.has(id)), 'Pending interaction references unknown player');
  }

  for (const player of state.players) {
    for (const [, amount] of resourceEntries(player.resources)) {
      invariant(Number.isSafeInteger(amount) && amount >= 0, `Player ${player.id} has invalid resources`);
    }
  }
}
