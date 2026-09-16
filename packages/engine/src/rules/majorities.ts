import type { BoardZoneId } from '@seatgrab/content';
import type { GameContent } from '../content.js';
import type { GameState, MajoritySelectionInteraction, PlayerId, VoterState } from '../model/state.js';

export function votersInZone(state: GameState, content: GameContent, zoneId: BoardZoneId): VoterState[] {
  const slots = new Set(content.board.slots.filter((slot) => slot.zoneId === zoneId).map((slot) => slot.slotId));
  return state.voters.filter((voter) => voter.location.kind === 'board' && slots.has(voter.location.slotId));
}
export function reconcileMajorities(
  state: GameState,
  content: GameContent,
  continuation: MajoritySelectionInteraction['continuation'] = 'action',
): MajoritySelectionInteraction | null {
  for (const zone of content.board.zones) {
    const voters = votersInZone(state, content, zone.id);
    const byOwner = new Map<PlayerId, VoterState[]>();
    for (const voter of voters) {
      const owned = byOwner.get(voter.ownerId) ?? [];
      owned.push(voter);
      byOwner.set(voter.ownerId, owned);
    }
    const marked = voters.filter(
      (voter) => voter.location.kind === 'board' && voter.location.majority,
    );
    const markedOwner = marked[0]?.ownerId;
    if (markedOwner !== undefined) {
      const owned = byOwner.get(markedOwner) ?? [];
      if (owned.length < zone.majorityThreshold) {
        for (const voter of marked) {
          if (voter.location.kind === 'board') {
            voter.location.majority = false;
          }
        }
      } else if (marked.length < zone.majorityThreshold) {
        return {
          id: `interaction-${state.nextSequence}`,
          kind: 'majoritySelection',
          continuation,
          responsiblePlayerIds: [markedOwner],
          playerId: markedOwner,
          zoneId: zone.id,
          required: zone.majorityThreshold - marked.length,
          eligibleVoterIds: owned
            .filter((voter) => voter.location.kind === 'board' && !voter.location.majority)
            .map((voter) => voter.id),
        };
      }
      continue;
    }
    const newMajority = [...byOwner.entries()].find(([, owned]) => owned.length >= zone.majorityThreshold);
    if (newMajority !== undefined) {
      return {
        id: `interaction-${state.nextSequence}`,
        kind: 'majoritySelection',
        continuation,
        responsiblePlayerIds: [newMajority[0]],
        playerId: newMajority[0],
        zoneId: zone.id,
        required: zone.majorityThreshold,
        eligibleVoterIds: newMajority[1].map((voter) => voter.id),
      };
    }
  }
  return null;
}

export function applyMajoritySelection(
  state: GameState,
  interaction: MajoritySelectionInteraction,
  voterIds: readonly string[],
): string | null {
  if (voterIds.length !== interaction.required || new Set(voterIds).size !== voterIds.length) {
    return `Select exactly ${interaction.required} distinct voters.`;
  }
  if (!voterIds.every((voterId) => interaction.eligibleVoterIds.includes(voterId))) {
    return 'Selection contains a voter that is not eligible for this majority.';
  }
  for (const voterId of voterIds) {
    const voter = state.voters.find((candidate) => candidate.id === voterId);
    if (voter?.location.kind !== 'board') {
      return 'A selected voter is no longer on the board.';
    }
    voter.location.majority = true;
  }
  return null;
}
