/**
 * The medium policy: goes for the cheapest majorities, uses its unlocked powers, and plays
 * tricks that help itself or hurt the leader.
 */
import type { GameCommand, PlayerView } from '@seatgrab/protocol';

import { answerChoice, enumerateActions, firstPlayerVote } from '../enumerate.js';
import type { Random } from '../random.js';
import {
  auctionDecision,
  capDiscardByNeed,
  coinFlipAnswer,
  decideActions,
  majorityNonVolatileFirst,
  optionOrderFor,
  reactionDecision,
  resourceFillFor,
  startingResourcesForMarket,
  tradeDecision,
} from './shared.js';

export function decideMedium(view: PlayerView, seatId: string, random: Random): readonly GameCommand[] {
  return decideRanked(view, seatId, random, 'medium');
}

/** The medium and hard policies share one shape; the level picks the filters. */
export function decideRanked(
  view: PlayerView,
  seatId: string,
  random: Random,
  level: 'medium' | 'hard',
): readonly GameCommand[] {
  const prompt = view.prompt;
  if (prompt !== undefined) {
    switch (prompt.kind) {
      case 'firstPlayerVote':
        return firstPlayerVote(view, seatId);
      case 'startingResources':
        return [{ type: 'ChooseStartingResources', resources: startingResourcesForMarket(view, seatId) }];
      case 'policyAnswer':
        return coinFlipAnswer(random);
      case 'capDiscard':
        return [capDiscardByNeed(view, seatId, prompt.excess)];
      case 'majoritySelection':
        return majorityNonVolatileFirst(view, prompt);
      case 'choice':
        if (prompt.context.op === 'trickPriority') return reactionDecision(view, seatId, prompt, level);
        if (prompt.context.op === 'auction') return auctionDecision(view, seatId, prompt, level);
        return answerChoice(view, seatId, prompt, optionOrderFor(view, seatId), resourceFillFor(view, seatId));
    }
  }

  if (view.activePlayerId !== seatId) {
    const actions = enumerateActions(view, seatId);
    return tradeDecision(view, seatId, actions, level);
  }
  const own = enumerateActions(view, seatId);
  const trades = tradeDecision(view, seatId, own, level);
  return [...trades, ...decideActions(view, seatId, random, level)];
}
