import type { BoardZoneId } from '@gerrymander/content';
import type { GameContent } from '../content.js';
import type { GameState, PlayerId } from '../model/state.js';

export interface ZoneSnapshot {
  zoneId: BoardZoneId;
  counts: Record<PlayerId, number>;
  majorityOwnerId?: PlayerId;
  rightsOwnerId?: PlayerId;
  majorityVoterIds: string[];
}

export function getZoneSnapshot(state: GameState, content: GameContent, zoneId: BoardZoneId): ZoneSnapshot {
  const zoneSlotIds = new Set(
    content.board.slots.filter((slot) => slot.zoneId === zoneId).map((slot) => slot.slotId),
  );
  const counts: Record<PlayerId, number> = {};
  const majorityByOwner: Record<PlayerId, string[]> = {};
  for (const voter of state.voters) {
    if (voter.location.kind !== 'board' || !zoneSlotIds.has(voter.location.slotId)) {
      continue;
    }
    counts[voter.ownerId] = (counts[voter.ownerId] ?? 0) + 1;
    if (voter.location.majority) {
      (majorityByOwner[voter.ownerId] ??= []).push(voter.id);
    }
  }

  const majorityOwners = Object.entries(majorityByOwner).filter(([, voterIds]) => voterIds.length > 0);
  const majorityEntry = majorityOwners[0];
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const leader = ranked[0];
  const second = ranked[1];
  const rightsOwnerId = leader !== undefined && leader[1] > 0 && leader[1] !== second?.[1]
    ? leader[0]
    : undefined;

  const snapshot: ZoneSnapshot = {
    zoneId,
    counts,
    majorityVoterIds: majorityEntry?.[1] ?? [],
  };
  if (majorityEntry !== undefined) {
    snapshot.majorityOwnerId = majorityEntry[0];
  }
  if (rightsOwnerId !== undefined) {
    snapshot.rightsOwnerId = rightsOwnerId;
  }
  return snapshot;
}

export function scorePlayer(state: GameState, playerId: PlayerId): number {
  let score = 0;
  for (const voter of state.voters) {
    if (voter.ownerId === playerId && voter.location.kind === 'board' && voter.location.majority) {
      score += 1;
    }
  }
  return score;
}
