import type { GameContent } from '../content.js';
import type { GameState, PlayerId } from '../model/state.js';
import { queueEvictedVotersForTurn } from '../rules/powers.js';
import {
  advanceTurn,
  allZonesHaveMajorities,
  finishGame,
  latchFullBoardIfNeeded,
  openPolicyPrompt,
  resetUsage,
} from './turn.js';
import { cleanupExpiredEffects } from './effects.js';

export type TurnCheckpointResult = 'advanced' | 'allMajorities' | 'fullBoardFinalTurns';

export function resolveEndTurnCheckpoint(
  state: GameState,
  endingPlayerId: PlayerId,
  content: GameContent,
): TurnCheckpointResult {
  state.endTurnContext = null;
  if (allZonesHaveMajorities(state, content)) {
    finishGame(state, 'allMajorities');
    return 'allMajorities';
  }
  // Read after latching, not before: a voter that reached the board through a card's own
  // continuation rather than through `PlaceVoterGroup` is on it by now, and this is the
  // only place every route is guaranteed to have passed through.
  latchFullBoardIfNeeded(state, endingPlayerId);
  const finalTurns = state.endgame.fullBoard;
  if (finalTurns !== undefined) {
    state.turn.completedTurns[endingPlayerId] = (state.turn.completedTurns[endingPlayerId] ?? 0) + 1;
    const nextFinalPlayer = finalTurns.remainingFinalPlayerIds.shift();
    if (nextFinalPlayer === undefined) {
      finishGame(state, 'fullBoardFinalTurns');
      cleanupExpiredEffects(state);
      return 'fullBoardFinalTurns';
    }
    state.turn.activePlayerId = nextFinalPlayer;
    state.turn.ordinal += 1;
    state.turn.usage = resetUsage();
    queueEvictedVotersForTurn(state, nextFinalPlayer);
    cleanupExpiredEffects(state);
    openPolicyPrompt(state);
    return 'advanced';
  }
  advanceTurn(state);
  cleanupExpiredEffects(state);
  openPolicyPrompt(state);
  return 'advanced';
}
