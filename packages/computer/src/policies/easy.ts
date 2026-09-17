/**
 * The easy policy: buys the cheapest voters and spreads them around, never uses a power or
 * a trick, passes every reaction and auction, rejects every trade.
 *
 * It is the autoplay driver's `spread` ladder with the trick rungs removed and a seeded
 * coin flip for the policy answer.
 */
import type { GameCommand, PlayerView } from '@gerrymander/protocol';
import { NO_RESOURCES, RESOURCE_ORDER, printedTotal } from '@gerrymander/seat';

import {
  IDENTITY_ORDER,
  answerChoice,
  discardVector,
  enumerateActions,
  evenStartingResources,
  firstPlayerVote,
  heldBy,
  placementSlots,
} from '../enumerate.js';
import type { Random } from '../random.js';
import { auctionDecision, coinFlipAnswer, reactionDecision, tradeDecision } from './shared.js';

export function decideEasy(view: PlayerView, seatId: string, random: Random): readonly GameCommand[] {
  const prompt = view.prompt;
  if (prompt !== undefined) {
    switch (prompt.kind) {
      case 'firstPlayerVote':
        return firstPlayerVote(view, seatId);
      case 'startingResources':
        return [{ type: 'ChooseStartingResources', resources: evenStartingResources(view, seatId) }];
      case 'policyAnswer':
        return coinFlipAnswer(random);
      case 'capDiscard':
        return [{ type: 'DiscardExcessResources', resources: discardVector(heldBy(view, seatId), prompt.excess) }];
      case 'majoritySelection': {
        const voterIds = prompt.eligibleVoterIds.slice(0, prompt.required);
        return voterIds.length < prompt.required
          ? []
          : [{
            type: 'SubmitChoice',
            interactionId: prompt.interactionId,
            selection: { kind: 'voters', voterIds: [...voterIds] },
          }];
      }
      case 'choice':
        if (prompt.context.op === 'trickPriority') return reactionDecision(view, seatId, prompt, 'easy');
        if (prompt.context.op === 'auction') return auctionDecision(view, seatId, prompt, 'easy');
        return answerChoice(view, seatId, prompt, IDENTITY_ORDER, { order: RESOURCE_ORDER, available: view.publicReserve });
    }
  }

  const actions = enumerateActions(view, seatId);
  if (actions.trades.length > 0 && view.activePlayerId !== seatId) {
    return tradeDecision(view, seatId, actions, 'easy');
  }
  if (view.activePlayerId !== seatId) return [];

  const out: GameCommand[] = [...actions.obligations, ...actions.debts];
  for (const group of actions.dueGroups) {
    const slotIds = placementSlots(view, seatId, group, 'spread');
    if (slotIds.length === group.count) {
      out.push({ type: 'PlaceVoterGroup', groupId: group.id, slotIds: [...slotIds] });
    }
  }
  if (actions.discard !== null) {
    out.push(actions.discard);
    return out;
  }
  out.push(...tradeDecision(view, seatId, actions, 'easy'));

  for (const entry of [...actions.purchases].sort((left, right) => printedTotal(left.cost) - printedTotal(right.cost))) {
    out.push({
      type: 'InfluenceVoterCard',
      cardId: entry.cardId,
      payment: { resources: entry.payment, discounts: { ...NO_RESOURCES } },
    });
  }

  // Arbitrage only when nothing in the market can be paid for, as the driver does.
  if (actions.arbitrage && actions.purchases.length === 0 && actions.unaffordable.length > 0) {
    const held = actions.held;
    const order = [...(['cash', 'influence', 'press', 'faith'] as const)].sort((a, b) => held[b] - held[a]);
    for (const give of order) {
      if (held[give] < 1) continue;
      for (const take of [...order].reverse()) {
        if (give === take) continue;
        out.push({
          type: 'UseProspecting',
          payment: { ...NO_RESOURCES, [give]: 1 },
          gain: { ...NO_RESOURCES, [take]: 2 },
        });
      }
    }
  }

  if (actions.endTurn) out.push({ type: 'RequestEndTurn' });
  return out;
}
