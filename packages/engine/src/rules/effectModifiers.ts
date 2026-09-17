import type { BoardZoneId } from '@gerrymander/content';
import type { GameContent } from '../content.js';
import type { ActiveEffect, GameState, PlayerId, VoterState } from '../model/state.js';

export function voterZoneId(voter: VoterState, content: GameContent): BoardZoneId | undefined {
  if (voter.location.kind !== 'board') {
    return undefined;
  }
  const slotId = voter.location.slotId;
  return content.board.slots.find((slot) => slot.slotId === slotId)?.zoneId;
}

export function isProtectedFromOpponent(
  state: GameState,
  content: GameContent,
  voter: VoterState,
  actorId: PlayerId,
): boolean {
  const zoneId = voterZoneId(voter, content);
  return zoneId !== undefined && state.activeEffects.some(
    (effect) => effect.kind === 'loyalBase'
      && effect.ownerId !== actorId
      && effect.targetZoneIds.includes(zoneId),
  );
}

export function placementBlocked(
  state: GameState,
  playerId: PlayerId,
  zoneId: BoardZoneId,
): boolean {
  return state.activeEffects.some(
    (effect) => effect.kind === 'blacklist'
      && effect.targetPlayerIds.includes(playerId)
      && effect.targetZoneIds.includes(zoneId),
  );
}

export function canBorrowRightsFrom(
  state: GameState,
  actorId: PlayerId,
  rightsOwnerId: PlayerId | undefined,
): boolean {
  return rightsOwnerId !== undefined && state.activeEffects.some(
    (effect) => effect.kind === 'guestEditor'
      && effect.ownerId === rightsOwnerId
      && effect.targetPlayerIds.includes(actorId),
  );
}

export function matchingEffect(
  state: GameState,
  kind: string,
  playerId: PlayerId,
): ActiveEffect | undefined {
  return state.activeEffects.find(
    (effect) => effect.kind === kind
      && (effect.ownerId === playerId || effect.targetPlayerIds.includes(playerId)),
  );
}

export function consumeEffectUse(state: GameState, effect: ActiveEffect): void {
  if (effect.remainingUses === undefined) {
    return;
  }
  effect.remainingUses -= 1;
  if (effect.remainingUses <= 0) {
    state.activeEffects = state.activeEffects.filter((candidate) => candidate.id !== effect.id);
    const deck = effect.sourceCardId.startsWith('TRK') ? state.trickDeck : state.newsDeck;
    if (!deck.discardPile.includes(effect.sourceCardId)) {
      deck.discardPile.push(effect.sourceCardId);
    }
  }
}
