import type { Archetype } from '@seatgrab/content';
import type { GameState, PlayerId, PlayerState } from '../model/state.js';

export function archetypeCount(state: GameState, player: PlayerState, archetype: Archetype): number {
  const retained = player.retainedPolicy.filter((card) => card.archetype === archetype).length;
  const temporary = state.activeEffects.filter(
    (effect) => effect.kind === 'turncoatArchetype'
      && effect.data.playerId === player.id
      && effect.data.archetype === archetype,
  ).length;
  return retained + temporary;
}

export function hasArchetypePower(
  state: GameState,
  player: PlayerState,
  archetype: Archetype,
  level: 3 | 5,
): boolean {
  if (archetypeCount(state, player, archetype) >= level) {
    return true;
  }
  if (level === 5) {
    return false;
  }
  return state.activeEffects.some((effect) => {
    if (effect.kind !== 'backroomDeal' || !effect.targetPlayerIds.includes(player.id)) {
      return false;
    }
    if (effect.data.fallbackArchetype === archetype) {
      return true;
    }
    return effect.targetPlayerIds.some((otherId) => {
      if (otherId === player.id) {
        return false;
      }
      const other = state.players.find((candidate) => candidate.id === otherId);
      return other !== undefined && archetypeCount(state, other, archetype) >= 3;
    });
  });
}

export function level3UsageLimit(state: GameState, playerId: PlayerId, printedLimit: number): number {
  return state.activeEffects.some((effect) => effect.kind === 'grandCoalition' && effect.ownerId === playerId)
    ? printedLimit * 2
    : printedLimit;
}

export function nextTurnOrdinalForPlayer(state: GameState, playerId: PlayerId): number {
  const activePlayerId = state.turn.activePlayerId;
  if (activePlayerId === null) {
    throw new Error('Cannot calculate a future turn without an active player.');
  }
  const currentIndex = state.turn.order.indexOf(activePlayerId);
  const targetIndex = state.turn.order.indexOf(playerId);
  if (currentIndex < 0 || targetIndex < 0) {
    throw new Error('Turn order does not contain the requested player.');
  }
  const distance = (targetIndex - currentIndex + state.turn.order.length) % state.turn.order.length;
  return state.turn.ordinal + (distance === 0 ? state.turn.order.length : distance);
}

export function queueEvictedVotersForTurn(state: GameState, playerId: PlayerId): void {
  const ready = state.voters.filter(
    (voter) => (voter.location.kind === 'evicted'
      && (voter.location.controllerId ?? voter.ownerId) === playerId
      && voter.location.availableOnTurnOrdinal <= state.turn.ordinal),
  );
  for (const voter of ready) {
    const groupId = `evicted:${voter.id}:${state.turn.ordinal}`;
    voter.location = { kind: 'pending', groupId };
    state.pendingVoterGroups.push({
      id: groupId,
      ownerId: voter.ownerId,
      controllerId: playerId,
      voterIds: [voter.id],
      origin: { kind: 'eviction' },
      sameZone: false,
      deadlineTurnOrdinal: state.turn.ordinal,
    });
  }
}
