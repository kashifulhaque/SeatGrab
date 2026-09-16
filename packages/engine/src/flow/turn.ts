import type { Archetype, ResourceVector } from '@seatgrab/content';
import { shuffle } from '../random/prng.js';
import type { GameContent } from '../content.js';
import { BASE_RESOURCE_CAP, type GameEvent, type GameState, type PlayerId, type PlayerState, type UsageCounters } from '../model/state.js';
import { grantFromReserve } from '../rules/resources.js';
import { archetypeCount, queueEvictedVotersForTurn } from '../rules/powers.js';
import { interruptWith } from './interactions.js';
import { scorePlayer } from '../rules/board.js';

export function currentResourceCap(state: GameState, playerId: string): number {
  const modifier = state.activeEffects
    .filter((effect) => effect.ownerId === playerId && effect.kind === 'resourceCap')
    .reduce((total, effect) => total + (typeof effect.data.amount === 'number' ? effect.data.amount : 0), 0);
  return BASE_RESOURCE_CAP + modifier;
}

export function passiveIncome(state: GameState, player: PlayerState): ResourceVector {
  return {
    cash: Math.floor(archetypeCount(state, player, 'corporate') / 2),
    influence: Math.floor(archetypeCount(state, player, 'nationalist') / 2),
    press: Math.floor(archetypeCount(state, player, 'populist') / 2),
    faith: Math.floor(archetypeCount(state, player, 'reformer') / 2),
  };
}

export function resetUsage(): UsageCounters {
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

export function openPolicyPrompt(state: GameState): void {
  if (state.turn.activePlayerId === null) {
    throw new Error('Cannot open an policy prompt without an active player');
  }
  if (state.policyDeck.drawPile.length === 0 && state.policyDeck.discardPile.length > 0) {
    const recycled = shuffle(state.policyDeck.discardPile, state.random);
    state.policyDeck.drawPile = recycled.items;
    state.policyDeck.discardPile = [];
    state.random = recycled.state;
  }
  const cardId = state.policyDeck.drawPile.shift();
  if (cardId === undefined) {
    const player = state.players.find((candidate) => candidate.id === state.turn.activePlayerId);
    if (player === undefined) {
      throw new Error('Active player disappeared');
    }
    grantFromReserve(state, player, passiveIncome(state, player));
    state.turn.phase = 'action';
    state.pendingInteraction = null;
    return;
  }
  state.turn.phase = 'policyAnswer';
  state.pendingInteraction = {
    id: `interaction-${state.nextSequence}`,
    kind: 'policyAnswer',
    responsiblePlayerIds: [state.turn.activePlayerId],
    playerId: state.turn.activePlayerId,
    cardId,
  };
  state.nextSequence += 1;
}

export function finishGame(state: GameState, reason: 'allMajorities' | 'fullBoardFinalTurns'): void {
  const scores = Object.fromEntries(state.players.map((player) => [player.id, scorePlayer(state, player.id)]));
  const highest = Math.max(...Object.values(scores));
  state.status = 'finished';
  state.turn.phase = 'finished';
  state.interactionStack = [];
  state.pendingInteraction = null;
  state.endgame.reason = reason;
  state.endgame.finalScores = scores;
  state.endgame.winners = Object.entries(scores).filter(([, score]) => score === highest).map(([playerId]) => playerId);
}

export function allZonesHaveMajorities(state: GameState, content: GameContent): boolean {
  return content.board.zones.every((zone) => {
    const zoneSlots = new Set(content.board.slots.filter((slot) => slot.zoneId === zone.id).map((slot) => slot.slotId));
    return state.voters.filter(
      (voter) => voter.location.kind === 'board'
        && zoneSlots.has(voter.location.slotId)
        && voter.location.majority,
    ).length === zone.majorityThreshold;
  });
}

/**
 * Start the final turns once the board has filled, if it has and they have not started.
 *
 * The second ending: the last empty area is taken, every other seat takes one
 * more turn, and the match is scored where it stands. `remainingFinalPlayerIds` is that
 * queue — everyone after `activeId`, in seat order — and `resolveEndTurnCheckpoint`
 * consumes it one turn at a time.
 *
 * This is idempotent and cheap, so it is called from two places rather than one. It used
 * to be called only after `PlaceVoterGroup`, which is the route an ordinary purchase
 * takes and is not the only route: Dynasty and Supply Shortage each put a
 * voter on the board from inside their own continuation. A match whose last area was
 * taken by one of those never latched, and because a full board then refuses every
 * placement, it never could — 5 players, `spread`, seed 51890 ran 778 turns with nine
 * zones undecided and no way to end. So it is called again at the end-turn checkpoint,
 * where the condition is actually read: whatever route a voter took, it is on the board
 * by the time its controller's turn ends.
 */
export function latchFullBoardIfNeeded(state: GameState, activeId: PlayerId | null): void {
  if (state.endgame.fullBoard !== undefined || state.slots.some((slot) => slot.voterId === null)) {
    return;
  }
  if (activeId === null) {
    throw new Error('The board filled without an active player');
  }
  const currentIndex = state.turn.order.indexOf(activeId);
  state.endgame.fullBoard = {
    latchedOnTurnOrdinal: state.turn.ordinal,
    remainingFinalPlayerIds: [
      ...state.turn.order.slice(currentIndex + 1),
      ...state.turn.order.slice(0, currentIndex),
    ],
  };
}

export function advanceTurn(state: GameState): void {
  const currentId = state.turn.activePlayerId;
  if (currentId === null) {
    throw new Error('Cannot advance a game without an active player');
  }
  state.turn.completedTurns[currentId] = (state.turn.completedTurns[currentId] ?? 0) + 1;
  const currentIndex = state.turn.order.indexOf(currentId);
  const nextId = state.turn.order[(currentIndex + 1) % state.turn.order.length];
  if (nextId === undefined) {
    throw new Error('Turn order has no next player');
  }
  state.turn.activePlayerId = nextId;
  state.turn.ordinal += 1;
  state.turn.usage = resetUsage();
  queueEvictedVotersForTurn(state, nextId);
  state.turn.phase = 'beforeAnswer';
  state.pendingInteraction = null;
}

export function checkCaps(
  state: GameState,
  players: readonly PlayerState[],
  continuation: 'resumeAction' | 'continueSetup' | 'continueEffect',
): boolean {
  const overCap = players.filter((player) => {
    const total = player.resources.cash + player.resources.influence + player.resources.press + player.resources.faith;
    return total > currentResourceCap(state, player.id);
  });
  const first = overCap[0];
  if (first === undefined) {
    return false;
  }
  const resumePhase = state.turn.phase;
  state.turn.phase = 'resourceCap';
  interruptWith(state, {
    id: `interaction-${state.nextSequence}`,
    kind: 'capDiscard',
    responsiblePlayerIds: [first.id],
    playerId: first.id,
    excess: first.resources.cash + first.resources.influence + first.resources.press + first.resources.faith
      - currentResourceCap(state, first.id),
    continuation,
    remainingPlayerIds: overCap.slice(1).map((player) => player.id),
    resumePhase,
  });
  state.nextSequence += 1;
  return true;
}

export function checkCap(
  state: GameState,
  player: PlayerState,
  continuation: 'resumeAction' | 'continueSetup' | 'continueEffect',
): boolean {
  return checkCaps(state, [player], continuation);
}
