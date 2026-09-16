import type { Archetype } from '@seatgrab/content';
import type { ChoicePromptContext } from '@seatgrab/protocol';
import type { GameContent } from '../content.js';
import type { ChoiceInteraction, GameState, PlayerId } from '../model/state.js';
import { getZoneSnapshot } from '../rules/board.js';
import { archetypeCount } from '../rules/powers.js';

const ARCHETYPE_OPTIONS: readonly Archetype[] = ['corporate', 'nationalist', 'populist', 'reformer'];
const RESOURCE_OPTIONS = ['cash', 'influence', 'press', 'faith'] as const;

function text(interaction: ChoiceInteraction, key: string): string | undefined {
  const value = interaction.continuation[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(interaction: ChoiceInteraction, key: string, fallback: number): number {
  const value = interaction.continuation[key];
  return typeof value === 'number' ? value : fallback;
}

function list(interaction: ChoiceInteraction, key: string): readonly string[] {
  const value = interaction.continuation[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : [];
}

/** The effect owner, or an empty string for continuations that have no owner. */
function ownerOf(interaction: ChoiceInteraction): string {
  return text(interaction, 'ownerId') ?? '';
}

function opponentsOf(state: GameState, playerId: string): readonly string[] {
  return state.players.filter((player) => player.id !== playerId).map((player) => player.id);
}

function majorityZonesOf(state: GameState, content: GameContent, playerId: string): readonly string[] {
  return content.board.zones
    .filter((zone) => getZoneSnapshot(state, content, zone.id).majorityOwnerId === playerId)
    .map((zone) => zone.id);
}

function rightsZonesOf(state: GameState, content: GameContent, playerId: string): readonly string[] {
  return content.board.zones
    .filter((zone) => getZoneSnapshot(state, content, zone.id).rightsOwnerId === playerId)
    .map((zone) => zone.id);
}

function policyCardIdsOf(state: GameState, playerId: string): readonly string[] {
  return state.players
    .find((player) => player.id === playerId)
    ?.retainedPolicy.map((card) => card.cardId) ?? [];
}

/** The player seated to the viewer's left, whose voters several news cards target. */
function leftOf(state: GameState, playerId: string): string | undefined {
  const index = state.turn.order.indexOf(playerId);
  return index < 0 ? undefined : state.turn.order[(index + 1) % state.turn.order.length];
}

function optionalRestriction(interaction: ChoiceInteraction): { restrictToPlayerId?: string } {
  const reversedFromPlayerId = text(interaction, 'reversedFromPlayerId');
  return reversedFromPlayerId === undefined ? {} : { restrictToPlayerId: reversedFromPlayerId };
}

/**
 * Builds the authorized prompt payload for one choice interaction and one
 * responsible viewer.
 *
 * Callers must already have established that `viewerId` is responsible for
 * `interaction`. Every branch copies named values out of the continuation, so a
 * continuation field that this function does not name can never reach a client.
 */
export function projectChoiceContext(
  state: GameState,
  interaction: ChoiceInteraction,
  viewerId: PlayerId,
  content: GameContent,
): ChoicePromptContext {
  const op = text(interaction, 'op');
  const ownerId = ownerOf(interaction);
  switch (op) {
    case 'campaignVote': {
      const voterIds = list(interaction, 'voterIds');
      return {
        op: 'campaignVote',
        prizeCardId: text(interaction, 'prizeCardId') ?? '',
        candidateIds: list(interaction, 'candidateIds'),
        round: count(interaction, 'round', 1),
        ballotsCast: list(interaction, 'ballots').length,
        awaitingPlayerIds: voterIds.filter((playerId) => interaction.responsiblePlayerIds.includes(playerId)),
      };
    }
    case 'auction': {
      // `cardId` is the trick the seller chose in secret and is withheld.
      const currentBidderId = text(interaction, 'currentBidderId');
      return {
        op: 'auction',
        sellerId: text(interaction, 'sellerId') ?? '',
        minimumBid: count(interaction, 'minimumBid', 0),
        currentBid: count(interaction, 'currentBid', 0),
        ...(currentBidderId === undefined ? {} : { currentBidderId }),
        bidderOrder: list(interaction, 'bidders'),
        passedPlayerIds: list(interaction, 'passed'),
      };
    }
    case 'trickPriority':
      return {
        op: 'trickPriority',
        playedCardId: text(interaction, 'playedCardId') ?? '',
        playedByPlayerId: text(interaction, 'actorId') ?? '',
        responderOrder: list(interaction, 'responders'),
        passedPlayerIds: list(interaction, 'passed'),
      };
    case 'chaiOpponent':
      // A reversed Skimming may only skim the seat that played it, and `chaiOpponent`
      // refuses anyone else — the one reversible continuation that was not carrying the
      // restriction its four siblings already carry, so the screen offered every opponent
      // and the seat found out by refusal.
      return {
        op: 'chaiOpponent',
        ownerId,
        eligiblePlayerIds: opponentsOf(state, ownerId),
        ...optionalRestriction(interaction),
      };
    case 'chaiResource':
      return {
        op: 'chaiResource',
        ownerId,
        opponentId: text(interaction, 'opponentId') ?? '',
        optionIds: [...RESOURCE_OPTIONS],
      };
    case 'turncoatTrack':
      return { op: 'turncoatTrack', ownerId, optionIds: [...ARCHETYPE_OPTIONS] };
    case 'blockOpen':
      return {
        op: 'blockOpen',
        ownerId,
        openCardIds: [...new Set(state.activeEffects.map((effect) => effect.sourceCardId))],
      };
    case 'accentFlip':
      return { op: 'accentFlip', ownerId, policyCardIds: policyCardIdsOf(state, ownerId) };
    case 'bharatVoters':
      return { op: 'bharatVoters', ownerId, exactly: 5, ...optionalRestriction(interaction) };
    case 'bharatOwners':
      return {
        op: 'bharatOwners',
        ownerId,
        voterIds: list(interaction, 'voterIds'),
        eligiblePlayerIds: opponentsOf(state, ownerId),
        ...optionalRestriction(interaction),
      };
    case 'cultZone':
      return { op: 'cultZone', ownerId, eligibleZoneIds: majorityZonesOf(state, content, ownerId) };
    case 'cultStolenZone':
      return { op: 'cultStolenZone', ownerId, eligibleZoneIds: majorityZonesOf(state, content, viewerId) };
    case 'notOneTarget':
      return {
        op: 'notOneTarget',
        ownerId,
        optionFormat: 'playerZone',
        eligiblePlayerIds: opponentsOf(state, ownerId),
        eligibleZoneIds: content.board.zones.map((zone) => zone.id),
        ...optionalRestriction(interaction),
      };
    case 'imprisonVoters':
      return { op: 'imprisonVoters', ownerId, exactly: 5, ...optionalRestriction(interaction) };
    case 'hostageVoters':
      return { op: 'hostageVoters', ownerId, exactly: 4 };
    case 'redevelopmentDiscard':
      return {
        op: 'redevelopmentDiscard',
        ownerId,
        zoneId: text(interaction, 'zoneId') ?? '',
        exactly: 2,
      };
    case 'documentsVoters':
      return {
        op: 'documentsVoters',
        ownerId,
        minimum: 1,
        maximum: 4,
        rightsZoneIds: rightsZonesOf(state, content, ownerId),
        ...optionalRestriction(interaction),
      };
    case 'slumdogSwap':
      return { op: 'slumdogSwap', ownerId, allowedCounts: [2, 4, 6] };
    case 'cornerstoneGain':
      return { op: 'cornerstoneGain', ownerId, resourceTotal: 4 };
    case 'cornerstoneZone':
      return {
        op: 'cornerstoneZone',
        ownerId,
        eligibleZoneIds: content.board.zones.filter((zone) => zone.capacity === 11).map((zone) => zone.id),
      };
    case 'dostiTarget':
      return { op: 'dostiTarget', ownerId, eligiblePlayerIds: opponentsOf(state, ownerId) };
    case 'mansplainTarget':
      return { op: 'mansplainTarget', ownerId, eligiblePlayerIds: opponentsOf(state, ownerId) };
    case 'nerosMoves':
      return { op: 'nerosMoves', ownerId, zoneId: text(interaction, 'zoneId') ?? '', pairs: 3 };
    case 'poloPlayers':
      return {
        op: 'poloPlayers',
        ownerId,
        exactly: 2,
        eligiblePlayerIds: state.players.map((player) => player.id),
      };
    case 'poloFallback':
      return {
        op: 'poloFallback',
        ownerId,
        playerIds: list(interaction, 'playerIds'),
        optionIds: [...ARCHETYPE_OPTIONS],
      };
    case 'karachiKeep':
      // Only the seller is responsible here, so the three drawn cards stay with them.
      return { op: 'karachiKeep', ownerId, drawnCardIds: list(interaction, 'drawn') };
    case 'blessingsKeep':
      return { op: 'blessingsKeep', ownerId, drawnCardIds: list(interaction, 'drawn') };
    case 'blessingsDonate':
      return {
        op: 'blessingsDonate',
        ownerId,
        keptCardId: text(interaction, 'keptCardId') ?? '',
        donatedCardId: text(interaction, 'donatedCardId') ?? '',
        eligiblePlayerIds: opponentsOf(state, ownerId),
      };
    case 'blessingsPlace': {
      const groupId = list(interaction, 'groupIds')[0] ?? '';
      const group = state.pendingVoterGroups.find((candidate) => candidate.id === groupId);
      return { op: 'blessingsPlace', ownerId, groupId, voterCount: group?.voterIds.length ?? 0 };
    }
    case 'greatLeaderMove':
      return { op: 'greatLeaderMove', ownerId, remainingMoves: count(interaction, 'remaining', 1) };
    case 'floodReliefMove':
      return { op: 'floodReliefMove', ownerId, queuePlayerIds: list(interaction, 'queue') };
    case 'coughEvict':
      return { op: 'coughEvict', ownerId, exactly: 1, queuePlayerIds: list(interaction, 'queue') };
    case 'coughReward':
      return { op: 'coughReward', ownerId, resourceTotal: 1, queuePlayerIds: list(interaction, 'queue') };
    case 'limitsConvert': {
      const leftPlayerId = leftOf(state, viewerId);
      return {
        op: 'limitsConvert',
        ownerId,
        exactly: 2,
        ...(leftPlayerId === undefined ? {} : { leftPlayerId }),
        queuePlayerIds: list(interaction, 'queue'),
      };
    }
    case 'limitsReward':
      return { op: 'limitsReward', ownerId, resourceTotal: 2, queuePlayerIds: list(interaction, 'queue') };
    case 'goalparaCard':
      return {
        op: 'goalparaCard',
        ownerId,
        marketCardIds: [...state.voterDeck.market],
        queuePlayerIds: list(interaction, 'queue'),
      };
    case 'goalparaReward':
      return {
        op: 'goalparaReward',
        ownerId,
        resourceTotal: count(interaction, 'generic', 0),
        queuePlayerIds: list(interaction, 'queue'),
      };
    case 'oxyChoice':
      return {
        op: 'oxyChoice',
        ownerId,
        eligiblePlayerIds: opponentsOf(state, viewerId),
        queuePlayerIds: list(interaction, 'queue'),
      };
    case 'oxyPlace':
      return { op: 'oxyPlace', ownerId, groupId: text(interaction, 'groupId') ?? '' };
    case 'donatePolicy': {
      const recipientPlayerId = leftOf(state, viewerId);
      return {
        op: 'donatePolicy',
        ownerId,
        policyCardIds: policyCardIdsOf(state, viewerId),
        ...(recipientPlayerId === undefined ? {} : { recipientPlayerId }),
        queuePlayerIds: list(interaction, 'queue'),
      };
    }
    case 'donationReward':
      return { op: 'donationReward', ownerId, resourceTotal: 6 };
    default:
      return { op: 'unsupported' };
  }
}

/** Turncoat placements and their current acquisition price, which are public. */
export function projectJumlaHoldings(state: GameState): {
  effectId: string;
  ownerId: string;
  archetype: Archetype;
  acquisitionCost: number;
}[] {
  return state.activeEffects.flatMap((effect) => {
    if (effect.kind !== 'turncoatArchetype') {
      return [];
    }
    const archetype = effect.data.archetype;
    const owner = state.players.find((player) => player.id === effect.ownerId);
    if (typeof archetype !== 'string' || !ARCHETYPE_OPTIONS.includes(archetype as Archetype) || owner === undefined) {
      return [];
    }
    return [{
      effectId: effect.id,
      ownerId: effect.ownerId,
      archetype: archetype as Archetype,
      acquisitionCost: archetypeCount(state, owner, archetype as Archetype),
    }];
  });
}

/** Voters of `viewerId` that an opponent effect currently holds off the board. */
export function projectHeldVoters(state: GameState, viewerId: PlayerId): {
  voterId: string;
  sourceCardId: string;
  holderId: string;
  buybackCost: number;
}[] {
  return state.activeEffects.flatMap((effect) => {
    if (effect.kind !== 'dragnet' && effect.kind !== 'ransomNote') {
      return [];
    }
    const heldVoterIds = Array.isArray(effect.data.heldVoterIds) ? effect.data.heldVoterIds : [];
    return heldVoterIds.flatMap((voterId) => {
      const voter = state.voters.find((candidate) => candidate.id === voterId);
      if (voter === undefined || voter.ownerId !== viewerId || voter.location.kind !== 'removed') {
        return [];
      }
      return [{
        voterId: voter.id,
        sourceCardId: effect.sourceCardId,
        holderId: effect.ownerId,
        buybackCost: 1,
      }];
    });
  });
}
