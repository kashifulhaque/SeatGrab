import type { BoardZoneId, Cost, ResourceVector } from '@gerrymander/content';
import { GameCommandSchema, type GameCommand } from '@gerrymander/protocol';
import type { GameContent } from '../content.js';
import { commandFailure as failure, commandSuccess as accept, createPublicEvent as publicEvent } from './commandResult.js';
import { applyCampaignCommand } from './campaign.js';
import {
  applyAcquireJumla,
  applyBuyTrick,
  applyBuyHeldVoter,
  applyEffectChoice,
  applyPayObligation,
  applyPlayTrick,
  applyReassignJumla,
  applyStealCult,
  beginNewsResolution,
} from './effectCommands.js';
import { latchFullBoardIfNeeded } from './turn.js';
import { applyPriorityCommand } from './effectPriority.js';
import { resolveEndTurnCheckpoint } from './endTurn.js';
import { completeInteraction } from './interactions.js';
import { openChoice } from './campaign.js';
import { canRunBharatEvictions } from './effects.js';
import type { AuthenticatedActor, CommandResult } from '../model/result.js';
import {
  resourceEntries,
  resourceTotal,
  type GameEvent,
  type GameState,
  type MajoritySelectionInteraction,
} from '../model/state.js';
import { shuffle } from '../random/prng.js';
import { getZoneSnapshot } from '../rules/board.js';
import { canBorrowRightsFrom, consumeEffectUse, isProtectedFromOpponent, matchingEffect, placementBlocked } from '../rules/effectModifiers.js';
import { applyMajoritySelection, reconcileMajorities } from '../rules/majorities.js';
import { spendToReserve, returnToReserve, grantFromReserve, validatePayment } from '../rules/resources.js';
import { assertGameState } from '../rules/invariants.js';
import { hasArchetypePower, level3UsageLimit, nextTurnOrdinalForPlayer, queueEvictedVotersForTurn } from '../rules/powers.js';
import {
  advanceTurn,
  currentResourceCap,
  allZonesHaveMajorities,
  checkCap,
  checkCaps,
  finishGame,
  openPolicyPrompt,
  passiveIncome,
  resetUsage,
} from './turn.js';


function resumeAfterCampaignInteraction(
  original: GameState,
  result: CommandResult,
  content: GameContent,
): CommandResult {
  if (!result.ok || result.state.turn.phase !== 'newsResolution' || result.state.pendingInteraction !== null) {
    return result;
  }
  const next = result.state;
  const endingPlayerId = next.endTurnContext?.playerId;
  if (endingPlayerId === undefined) {
    return failure(original, 'INVARIANT_VIOLATION', 'The campaign interaction lost its end-turn owner.');
  }
  if (next.newsQueue.length > 0) {
    const error = beginNewsResolution(next, content);
    if (error !== null) {
      return failure(original, 'CONTENT_NOT_EXECUTABLE', error);
    }
  }
  if (next.pendingInteraction === null && next.newsQueue.length === 0) {
    resolveEndTurnCheckpoint(next, endingPlayerId, content);
  }
  assertGameState(next, content);
  return result;
}

function applyFirstPlayerVote(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'VoteForFirstPlayer' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'firstPlayerElection' || state.pendingInteraction?.kind !== 'firstPlayerVote') {
    return failure(state, 'WRONG_PHASE', 'The first-player election is not open.');
  }
  if (command.candidateId === actor.playerId) {
    return failure(state, 'INVALID_TARGET_SET', 'A player cannot vote for themselves.');
  }
  if (!state.players.some((player) => player.id === command.candidateId)) {
    return failure(state, 'INVALID_TARGET_SET', 'The selected candidate is not in this match.');
  }
  if (state.pendingInteraction.ballots[actor.playerId] !== undefined) {
    return failure(state, 'INVALID_COMMAND', 'This player has already voted in the current round.');
  }

  const next = structuredClone(state);
  const interaction = next.pendingInteraction;
  if (interaction?.kind !== 'firstPlayerVote') {
    throw new Error('First-player vote interaction disappeared during clone');
  }
  interaction.ballots[actor.playerId] = command.candidateId;
  const events: GameEvent[] = [];
  if (Object.keys(interaction.ballots).length === next.players.length) {
    const counts = new Map<string, number>();
    for (const candidateId of Object.values(interaction.ballots)) {
      counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
    }
    const highest = Math.max(...counts.values());
    const winners = [...counts.entries()].filter(([, votes]) => votes === highest).map(([id]) => id);
    if (winners.length !== 1) {
      interaction.ballots = {};
      interaction.round += 1;
      events.push(publicEvent(next, 'FirstPlayerVoteTied', `Election round ${interaction.round - 1} tied; vote again.`));
    } else {
      const winnerId = winners[0];
      if (winnerId === undefined) {
        throw new Error('Completed election had no winner');
      }
      const winnerIndex = next.players.findIndex((player) => player.id === winnerId);
      const physicalOrder = next.players.map((player) => player.id);
      next.turn.order = [...physicalOrder.slice(winnerIndex), ...physicalOrder.slice(0, winnerIndex)];
      next.turn.activePlayerId = winnerId;
      next.turn.phase = 'startingResources';
      next.pendingInteraction = {
        id: `interaction-${next.nextSequence}`,
        kind: 'startingResources',
        responsiblePlayerIds: [...next.turn.order],
        remainingPlayerIds: [...next.turn.order],
      };
      next.nextSequence += 1;
      events.push(publicEvent(next, 'FirstPlayerElected', `${next.players[winnerIndex]?.displayName ?? winnerId} is first player.`, winnerId));
    }
  }
  return accept(state, next, events, content);
}

function applyStartingResources(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'ChooseStartingResources' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'startingResources' || state.pendingInteraction?.kind !== 'startingResources') {
    return failure(state, 'WRONG_PHASE', 'Starting resources are not being chosen.');
  }
  if (!state.pendingInteraction.remainingPlayerIds.includes(actor.playerId)) {
    return failure(state, 'INVALID_COMMAND', 'This player already chose starting resources.');
  }
  const orderIndex = state.turn.order.indexOf(actor.playerId);
  const required = orderIndex + 1;
  if (orderIndex < 0 || resourceTotal(command.resources) !== required) {
    return failure(state, 'INVALID_TARGET_SET', `This seat must choose exactly ${required} resources.`);
  }
  for (const [resource, amount] of resourceEntries(command.resources)) {
    if (amount > state.publicReserve[resource]) {
      return failure(state, 'RESOURCE_RESERVE_EXHAUSTED', `${resource} does not have ${amount} units available.`);
    }
  }

  const next = structuredClone(state);
  const player = next.players.find((candidate) => candidate.id === actor.playerId);
  const interaction = next.pendingInteraction;
  if (player === undefined || interaction?.kind !== 'startingResources') {
    throw new Error('Validated starting-resource state disappeared during clone');
  }
  for (const [resource, amount] of resourceEntries(command.resources)) {
    player.resources[resource] += amount;
    next.publicReserve[resource] -= amount;
  }
  interaction.remainingPlayerIds = interaction.remainingPlayerIds.filter((id) => id !== actor.playerId);
  const events = [publicEvent(next, 'StartingResourcesChosen', `${player.displayName} chose ${required} starting resources.`, player.id)];
  if (interaction.remainingPlayerIds.length === 0) {
    next.status = 'active';
    next.turn.ordinal = 1;
    next.pendingInteraction = null;
    openPolicyPrompt(next);
    events.push(publicEvent(next, 'SetupCompleted', 'Setup completed; the first turn begins.', next.turn.activePlayerId ?? undefined));
  }
  return accept(state, next, events, content);
}

function applyPolicyAnswer(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'CommitPolicyAnswer' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (state.turn.phase !== 'policyAnswer'
      || interaction?.kind !== 'policyAnswer'
      || interaction.playerId !== actor.playerId) {
    return failure(state, 'WRONG_PHASE', 'This player does not have an policy answer to commit.');
  }
  const card = content.policyCards.find((candidate) => candidate.id === interaction.cardId);
  if (card === undefined) {
    return failure(state, 'INVARIANT_VIOLATION', 'The pending policy card is unavailable.');
  }
  const answer = card.answers[command.answerIndex];
  const next = structuredClone(state);
  const player = next.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined) {
    throw new Error('Validated policy player disappeared during clone');
  }
  player.retainedPolicy.push({
    cardId: card.id,
    answerIndex: command.answerIndex,
    archetype: answer.archetype,
  });
  const taxAudit = matchingEffect(next, 'taxAudit', player.id);
  const printedGrant: ResourceVector = taxAudit === undefined
    ? grantFromReserve(next, player, answer.reward)
    : { cash: 0, influence: 0, press: 0, faith: 0 };
  if (taxAudit !== undefined) {
    consumeEffectUse(next, taxAudit);
  }
  const passiveGrant = grantFromReserve(next, player, passiveIncome(next, player));
  const capPlayers = [player];
  const echoChamber = next.activeEffects.find(
    (effect) => effect.kind === 'echoChamber' && effect.ownerId === player.id,
  );
  if (echoChamber !== undefined) {
    const recipient = next.players.find((candidate) => candidate.id === echoChamber.targetPlayerIds[0]);
    if (recipient !== undefined) {
      grantFromReserve(next, recipient, {
        cash: printedGrant.cash + passiveGrant.cash,
        influence: printedGrant.influence + passiveGrant.influence,
        press: printedGrant.press + passiveGrant.press,
        faith: printedGrant.faith + passiveGrant.faith,
      });
      capPlayers.push(recipient);
    }
    consumeEffectUse(next, echoChamber);
  }
  next.pendingInteraction = null;
  next.turn.phase = 'action';
  checkCaps(next, capPlayers, 'resumeAction');
  const events = [
    publicEvent(
      next,
      'PolicyAnswered',
      `${player.displayName} chose the ${answer.archetype} answer and received `
        + `${resourceTotal(printedGrant)} printed plus ${resourceTotal(passiveGrant)} passive resources.`,
      player.id,
    ),
  ];
  return accept(state, next, events, content);
}

function applyPolicyRedraw(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'RedrawPolicy' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (state.turn.phase !== 'policyAnswer'
      || interaction?.kind !== 'policyAnswer'
      || interaction.playerId !== actor.playerId) {
    return failure(state, 'WRONG_PHASE', 'This player does not have an policy card to redraw.');
  }
  if (resourceTotal(command.payment.resources) !== 4
      || resourceTotal(command.payment.discounts ?? { cash: 0, influence: 0, press: 0, faith: 0 }) !== 0) {
    return failure(state, 'INVALID_DISCOUNT', 'An policy redraw costs exactly four resources with no discount.');
  }
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined
      || resourceEntries(command.payment.resources).some(([resource, amount]) => amount > player.resources[resource])) {
    return failure(state, 'INSUFFICIENT_RESOURCES', 'The offered redraw resources are not available.');
  }
  const next = structuredClone(state);
  const nextPlayer = next.players.find((candidate) => candidate.id === actor.playerId);
  const nextInteraction = next.pendingInteraction;
  if (nextPlayer === undefined || nextInteraction?.kind !== 'policyAnswer') {
    throw new Error('Validated redraw state disappeared during clone');
  }
  const interceptors = spendToReserve(next, nextPlayer, command.payment.resources);
  next.policyDeck.discardPile.push(nextInteraction.cardId);
  next.pendingInteraction = null;
  openPolicyPrompt(next);
  checkCaps(next, interceptors, 'continueEffect');
  return accept(
    state,
    next,
    [publicEvent(next, 'PolicyRedrawn', `${nextPlayer.displayName} paid four resources to redraw.`, nextPlayer.id)],
    content,
  );
}

function applyCapDiscard(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'DiscardExcessResources' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (state.turn.phase !== 'resourceCap'
      || interaction?.kind !== 'capDiscard'
      || interaction.playerId !== actor.playerId) {
    return failure(state, 'WRONG_PHASE', 'This player does not have a resource-cap discard pending.');
  }
  if (resourceTotal(command.resources) !== interaction.excess) {
    return failure(state, 'INVALID_TARGET_SET', `Discard exactly ${interaction.excess} resources.`);
  }
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined
      || resourceEntries(command.resources).some(([resource, amount]) => amount > player.resources[resource])) {
    return failure(state, 'INSUFFICIENT_RESOURCES', 'The discarded resources are not available.');
  }
  const next = structuredClone(state);
  const nextPlayer = next.players.find((candidate) => candidate.id === actor.playerId);
  if (nextPlayer === undefined) {
    throw new Error('Validated cap-discard player disappeared during clone');
  }
  returnToReserve(next, nextPlayer, command.resources);
  const remaining = [...(interaction.remainingPlayerIds ?? [])];
  let queuedPlayer = remaining.shift();
  while (queuedPlayer !== undefined) {
    const candidate = next.players.find((item) => item.id === queuedPlayer);
    if (candidate !== undefined && resourceTotal(candidate.resources) > currentResourceCap(next, candidate.id)) {
      next.pendingInteraction = {
        id: `interaction-${next.nextSequence}`,
        kind: 'capDiscard',
        responsiblePlayerIds: [candidate.id],
        playerId: candidate.id,
        excess: resourceTotal(candidate.resources) - currentResourceCap(next, candidate.id),
        continuation: interaction.continuation,
        remainingPlayerIds: remaining,
        ...(interaction.resumePhase === undefined ? {} : { resumePhase: interaction.resumePhase }),
      };
      next.nextSequence += 1;
      next.turn.phase = 'resourceCap';
      break;
    }
    queuedPlayer = remaining.shift();
  }
  if (queuedPlayer === undefined) {
    completeInteraction(next);
    if (next.pendingInteraction?.kind === 'policyAnswer') {
      next.turn.phase = 'policyAnswer';
    } else {
      next.turn.phase = interaction.resumePhase
        ?? (interaction.continuation === 'resumeAction' ? 'action' : next.turn.phase);
    }
  }
  if (next.turn.phase === 'newsResolution' && next.pendingInteraction === null) {
    const continuationError = beginNewsResolution(next, content);
    if (continuationError !== null) {
      return failure(state, 'CONTENT_NOT_EXECUTABLE', continuationError);
    }
    const endingPlayerId = next.endTurnContext?.playerId;
    if (next.pendingInteraction === null && next.newsQueue.length === 0 && endingPlayerId !== undefined) {
      resolveEndTurnCheckpoint(next, endingPlayerId, content);
    }
  }
  return accept(
    state,
    next,
    [publicEvent(next, 'ResourcesDiscardedToCap', `${nextPlayer.displayName} discarded ${interaction.excess} resources.`, nextPlayer.id)],
    content,
  );
}

function refillVoterMarket(state: GameState): void {
  if (state.activeEffects.some((effect) => effect.kind === 'disqualified')) {
    return;
  }
  while (state.voterDeck.market.length < 3) {
    if (state.voterDeck.drawPile.length === 0) {
      if (state.voterDeck.discardPile.length === 0) {
        return;
      }
      const recycled = shuffle(state.voterDeck.discardPile, state.random);
      state.voterDeck.drawPile = recycled.items;
      state.voterDeck.discardPile = [];
      state.random = recycled.state;
    }
    const nextCardId = state.voterDeck.drawPile.shift();
    if (nextCardId === undefined) {
      return;
    }
    state.voterDeck.market.push(nextCardId);
  }
}

function applyInfluenceVoterCard(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'InfluenceVoterCard' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'Voter cards can only be influenced in the active player’s action phase.');
  }
  const purchaseBlocked = state.players.find((player) => player.id === actor.playerId);
  if (purchaseBlocked?.debts.length) {
    return failure(state, 'PURCHASE_BLOCKED_BY_DEBT', 'Outstanding auction debt blocks purchases.');
  }
  if (purchaseBlocked?.obligations.some((obligation) => obligation.kind === 'reliefFund')) {
    return failure(state, 'WRONG_PHASE', 'Relief Fund blocks purchases until its obligation is paid.');
  }
  const card = content.voterCards.find((candidate) => candidate.id === command.cardId);
  if (card === undefined || !state.voterDeck.market.includes(card.id)) {
    return failure(state, 'CARD_NO_LONGER_AVAILABLE', 'That voter card is no longer in the market.');
  }
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined) {
    return failure(state, 'INVALID_COMMAND', 'The active player does not exist.');
  }
  const groundswell = command.groundswell === true;
  if (groundswell && !hasArchetypePower(state, player, 'populist', 3)) {
    return failure(state, 'POWER_NOT_UNLOCKED', 'Groundswell requires three Populist cards.');
  }
  if (groundswell && state.turn.usage.groundswellCardIds.length >= level3UsageLimit(state, player.id, 2)) {
    return failure(state, 'POWER_USAGE_EXHAUSTED', 'Groundswell has reached its per-turn limit.');
  }
  const voterCount = card.voters + (groundswell ? 1 : 0);
  const volunteersAvailable = hasArchetypePower(state, player, 'reformer', 3)
    ? level3UsageLimit(state, player.id, 2) - state.turn.usage.volunteers
    : 0;
  const surcharge = matchingEffect(state, 'tabloidScandal', player.id) === undefined ? 0 : 1;
  const effectiveCost: Cost = { ...card.cost, generic: card.cost.generic + surcharge };
  const payment = validatePayment(player, effectiveCost, command.payment, volunteersAvailable);
  if (!payment.ok) {
    return failure(state, volunteersAvailable > 0 ? 'INVALID_DISCOUNT' : 'INSUFFICIENT_RESOURCES', payment.message);
  }
  const supply = state.voters.filter((voter) => voter.ownerId === actor.playerId && voter.location.kind === 'supply');
  if (supply.length < voterCount) {
    return failure(state, 'INVALID_TARGET_SET', 'The player does not have enough voter tokens in supply.');
  }

  const next = structuredClone(state);
  const nextPlayer = next.players.find((candidate) => candidate.id === actor.playerId);
  if (nextPlayer === undefined) {
    throw new Error('Validated purchaser disappeared during clone');
  }
  const interceptors = spendToReserve(next, nextPlayer, command.payment.resources);
  next.turn.usage.volunteers += payment.discountsUsed;
  if (groundswell) {
    next.turn.usage.groundswellCardIds.push(card.id);
  }
  if (card.voters === 3) {
    next.turn.usage.threeVoterPurchases += 1;
  }
  next.voterDeck.market = next.voterDeck.market.filter((cardId) => cardId !== card.id);
  next.voterDeck.discardPile.push(card.id);
  next.voterDeck.marketRevision += 1;
  refillVoterMarket(next);

  const nextSupply = next.voters
    .filter((voter) => voter.ownerId === actor.playerId && voter.location.kind === 'supply')
    .slice(0, voterCount);
  const canFit = content.board.zones.some((zone) => {
    const slotIds = new Set(content.board.slots.filter((slot) => slot.zoneId === zone.id).map((slot) => slot.slotId));
    return next.slots.filter((slot) => slotIds.has(slot.slotId) && slot.voterId === null).length >= voterCount;
  });
  const events = [
    publicEvent(next, 'VoterCardInfluenced', `${nextPlayer.displayName} influenced ${voterCount} voter${voterCount === 1 ? '' : 's'}.`, nextPlayer.id),
  ];
  if (canFit) {
    const groupId = `group-${next.nextSequence}`;
    next.nextSequence += 1;
    for (const voter of nextSupply) {
      voter.location = { kind: 'pending', groupId };
    }
    next.pendingVoterGroups.push({
      id: groupId,
      ownerId: actor.playerId,
      controllerId: actor.playerId,
      voterIds: nextSupply.map((voter) => voter.id),
      origin: { kind: 'voterCard', cardId: card.id },
      sameZone: true,
      deadlineTurnOrdinal: next.turn.ordinal,
    });
  } else {
    events.push(publicEvent(next, 'VoterGroupDiscarded', 'No zone had enough empty areas for the group; all influenced voters were discarded.'));
  }
  checkCaps(next, interceptors, 'continueEffect');
  return accept(state, next, events, content);
}

function openMajoritySelectionIfNeeded(state: GameState, content: GameContent): void {
  const interaction = reconcileMajorities(state, content, 'action');
  if (interaction !== null) {
    state.pendingInteraction = interaction;
    state.nextSequence += 1;
  }
}

function applyPlaceVoterGroup(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PlaceVoterGroup' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'Voter groups can only be placed in the active player’s action phase.');
  }
  const group = state.pendingVoterGroups.find((candidate) => candidate.id === command.groupId);
  if (group === undefined || group.controllerId !== actor.playerId) {
    return failure(state, 'INVALID_TARGET_SET', 'That pending voter group is not controlled by this player.');
  }
  if (command.slotIds.length !== group.voterIds.length || new Set(command.slotIds).size !== command.slotIds.length) {
    return failure(state, 'VOTER_GROUP_MUST_STAY_TOGETHER', `Select exactly ${group.voterIds.length} distinct slots.`);
  }
  const selected = command.slotIds.map((slotId) => content.board.slots.find((slot) => slot.slotId === slotId));
  if (selected.some((slot) => slot === undefined)
      || command.slotIds.some((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId !== null)) {
    return failure(state, 'INVALID_TARGET_SET', 'Every selected slot must exist and be empty.');
  }
  const zoneIds = new Set(selected.map((slot) => slot?.zoneId));
  if ((group.sameZone && zoneIds.size !== 1)
      || (group.allowedZoneIds !== undefined
        && selected.some((slot) => slot !== undefined && !group.allowedZoneIds?.includes(slot.zoneId)))) {
    return failure(state, 'VOTER_GROUP_MUST_STAY_TOGETHER', 'This voter group must use allowed slots in one zone.');
  }
  const selectedZoneId = selected[0]?.zoneId;
  if (selectedZoneId !== undefined && placementBlocked(state, actor.playerId, selectedZoneId)) {
    return failure(state, 'INVALID_TARGET_SET', 'A card effect blocks this player from placing voters in that zone this turn.');
  }

  const next = structuredClone(state);
  const nextGroup = next.pendingVoterGroups.find((candidate) => candidate.id === command.groupId);
  if (nextGroup === undefined) {
    throw new Error('Validated pending group disappeared during clone');
  }
  const events: GameEvent[] = [];
  for (let index = 0; index < command.slotIds.length; index += 1) {
    const voterId = nextGroup.voterIds[index];
    const slotId = command.slotIds[index];
    const voter = next.voters.find((candidate) => candidate.id === voterId);
    const slotState = next.slots.find((candidate) => candidate.slotId === slotId);
    const slot = content.board.slots.find((candidate) => candidate.slotId === slotId);
    if (voter === undefined || slotState === undefined || slot === undefined || voterId === undefined || slotId === undefined) {
      throw new Error('Validated placement target disappeared during clone');
    }
    slotState.voterId = voter.id;
    voter.location = { kind: 'board', slotId, majority: false };
    if (slot.volatile) {
      next.newsQueue.push({
        id: `news-trigger-${next.nextSequence}`,
        voterId: voter.id,
        slotId,
        voterOwnerId: voter.ownerId,
        actorId: actor.playerId,
        turnOrdinal: next.turn.ordinal,
      });
      next.nextSequence += 1;
      events.push(publicEvent(next, 'NewsQueued', `A news was queued for ${voter.ownerId}.`, actor.playerId));
    }
  }
  next.pendingVoterGroups = next.pendingVoterGroups.filter((candidate) => candidate.id !== nextGroup.id);
  latchFullBoardIfNeeded(next, next.turn.activePlayerId);
  const placedCardId = nextGroup.origin.kind === 'voterCard' ? nextGroup.origin.cardId : undefined;
  const placedCard = placedCardId === undefined
    ? undefined
    : content.voterCards.find((card) => card.id === placedCardId);
  const redevelopment = placedCard?.voters === 2
    ? matchingEffect(next, 'redevelopment', actor.playerId)
    : undefined;
  if (redevelopment !== undefined && selectedZoneId !== undefined) {
    openChoice(
      next,
      [actor.playerId],
      'Redevelopment: discard exactly two non-majority voters from the placement zone, or pass.',
      ['voters', 'pass'],
      true,
      redevelopment.sourceCardId,
      {
        op: 'redevelopmentDiscard',
        ownerId: actor.playerId,
        deck: 'trick',
        zoneId: selectedZoneId,
        effectId: redevelopment.id,
      },
    );
  } else {
    openMajoritySelectionIfNeeded(next, content);
  }
  events.unshift(publicEvent(next, 'VoterGroupPlaced', `${nextGroup.voterIds.length} voters were placed.`, actor.playerId));
  return accept(state, next, events, content);
}

function applyMajorityChoice(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'SubmitChoice' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'majoritySelection'
      || interaction.id !== command.interactionId
      || interaction.playerId !== actor.playerId
      || command.selection.kind !== 'voters') {
    return failure(state, 'MANDATORY_CHOICE_PENDING', 'Resolve the current majority selection with voter identities.');
  }
  const next = structuredClone(state);
  const nextInteraction = next.pendingInteraction as MajoritySelectionInteraction;
  const error = applyMajoritySelection(next, nextInteraction, command.selection.voterIds);
  if (error !== null) {
    return failure(state, 'INVALID_TARGET_SET', error);
  }
  next.pendingInteraction = null;
  next.turn.phase = nextInteraction.continuation === 'action' ? 'action' : next.turn.phase;
  return accept(
    state,
    next,

    [publicEvent(next, 'MajorityFormed', `${actor.playerId} formed a majority in ${nextInteraction.zoneId}.`, actor.playerId)],
    content,
  );
}
function applyTradeCommand(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'ProposeTrade' | 'AcceptTrade' | 'RejectTrade' | 'CancelTrade' }>,
  content: GameContent,
): CommandResult {
  const activeId = state.turn.activePlayerId;
  const tradeWindow = state.status === 'active'
    && (state.turn.phase === 'policyAnswer' || state.turn.phase === 'action')
    && (state.pendingInteraction === null || state.pendingInteraction.kind === 'policyAnswer');
  if (!tradeWindow || activeId === null) {
    return failure(state, 'WRONG_PHASE', 'Trades are only available during the active player’s before-answer or action window.');
  }
  if (command.type === 'ProposeTrade') {
    const proposer = state.players.find((player) => player.id === actor.playerId);
    const opponent = state.players.find((player) => player.id === command.opponentId);
    if (proposer === undefined || opponent === undefined || proposer.id === opponent.id
        || (proposer.id !== activeId && opponent.id !== activeId)) {
      return failure(state, 'INVALID_TARGET_SET', 'A trade must be between distinct players and include the active player.');
    }
    if (resourceTotal(command.giveResources) < 1 || resourceTotal(command.receiveResources) < 1) {
      return failure(state, 'INVALID_TARGET_SET', 'Each side of an ordinary trade must give at least one resource.');
    }
    const distinctGiveCards = new Set(command.giveTrickIds);
    const distinctReceiveCards = new Set(command.receiveTrickIds);
    const invalidHoldings = resourceEntries(command.giveResources)
      .some(([resource, amount]) => amount > proposer.resources[resource])
      || resourceEntries(command.receiveResources)
        .some(([resource, amount]) => amount > opponent.resources[resource])
      || distinctGiveCards.size !== command.giveTrickIds.length
      || distinctReceiveCards.size !== command.receiveTrickIds.length
      || command.giveTrickIds.some((cardId) => !proposer.trickHand.includes(cardId))
      || command.receiveTrickIds.some((cardId) => !opponent.trickHand.includes(cardId));
    if (invalidHoldings) {
      return failure(state, 'INSUFFICIENT_RESOURCES', 'The proposed resources or trick cards are not held by their giver.');
    }
    const next = structuredClone(state);
    const offerId = `trade-${next.nextSequence}`;
    next.nextSequence += 1;
    next.tradeOffers.push({
      id: offerId,
      proposerId: proposer.id,
      opponentId: opponent.id,
      giveResources: command.giveResources,
      receiveResources: command.receiveResources,
      giveTrickIds: [...command.giveTrickIds],
      receiveTrickIds: [...command.receiveTrickIds],
      createdRevision: state.revision,
    });
    return accept(
      state,
      next,
      [publicEvent(next, 'TradeProposed', `${proposer.displayName} proposed a trade with ${opponent.displayName}.`, proposer.id)],
      content,
    );
  }

  const offer = state.tradeOffers.find((candidate) => candidate.id === command.tradeId);
  if (offer === undefined) {
    return failure(state, 'INVALID_TARGET_SET', 'That trade offer is no longer open.');
  }
  if (command.type === 'CancelTrade') {
    if (offer.proposerId !== actor.playerId) {
      return failure(state, 'INVALID_TARGET_SET', 'Only the proposer may cancel this trade.');
    }
    const next = structuredClone(state);
    next.tradeOffers = next.tradeOffers.filter((candidate) => candidate.id !== offer.id);
    return accept(state, next, [publicEvent(next, 'TradeCancelled', 'A trade offer was cancelled.', actor.playerId)], content);
  }
  if (offer.opponentId !== actor.playerId) {
    return failure(state, 'INVALID_TARGET_SET', 'Only the invited opponent may answer this trade.');
  }
  if (command.type === 'RejectTrade') {
    const next = structuredClone(state);
    next.tradeOffers = next.tradeOffers.filter((candidate) => candidate.id !== offer.id);
    return accept(state, next, [publicEvent(next, 'TradeRejected', 'A trade offer was rejected.', actor.playerId)], content);
  }

  const proposer = state.players.find((player) => player.id === offer.proposerId);
  const opponent = state.players.find((player) => player.id === offer.opponentId);
  if (proposer === undefined || opponent === undefined) {
    return failure(state, 'INVALID_TARGET_SET', 'A trade participant is no longer seated.');
  }
  const invalidated = resourceEntries(offer.giveResources)
    .some(([resource, amount]) => amount > proposer.resources[resource])
    || resourceEntries(offer.receiveResources)
      .some(([resource, amount]) => amount > opponent.resources[resource])
    || offer.giveTrickIds.some((cardId) => !proposer.trickHand.includes(cardId))
    || offer.receiveTrickIds.some((cardId) => !opponent.trickHand.includes(cardId));
  if (invalidated) {
    return failure(state, 'INSUFFICIENT_RESOURCES', 'The trade is no longer payable by both parties.');
  }
  const next = structuredClone(state);
  const nextProposer = next.players.find((player) => player.id === offer.proposerId);
  const nextOpponent = next.players.find((player) => player.id === offer.opponentId);
  if (nextProposer === undefined || nextOpponent === undefined) {
    throw new Error('Validated trade players disappeared during clone');
  }
  for (const [resource, amount] of resourceEntries(offer.giveResources)) {
    nextProposer.resources[resource] -= amount;
    nextOpponent.resources[resource] += amount;
  }
  for (const [resource, amount] of resourceEntries(offer.receiveResources)) {
    nextOpponent.resources[resource] -= amount;
    nextProposer.resources[resource] += amount;
  }
  for (const cardId of offer.giveTrickIds) {
    nextProposer.trickHand = nextProposer.trickHand.filter((candidate) => candidate !== cardId);
    nextOpponent.trickHand.push(cardId);
  }
  for (const cardId of offer.receiveTrickIds) {
    nextOpponent.trickHand = nextOpponent.trickHand.filter((candidate) => candidate !== cardId);
    nextProposer.trickHand.push(cardId);
  }
  next.tradeOffers = next.tradeOffers.filter((candidate) => candidate.id !== offer.id);
  checkCaps(next, [nextProposer, nextOpponent], 'continueEffect');
  return accept(
    state,
    next,
    [publicEvent(next, 'TradeAccepted', `${nextProposer.displayName} and ${nextOpponent.displayName} completed a trade.`, actor.playerId)],
    content,
  );
}

function applyArchetypePower(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, {
    type: 'UseProspecting' | 'UseDonations' | 'UseBreakingGround' | 'UsePayback' | 'UseToughLove';
  }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'Archetype powers are only available in the active player’s action phase.');
  }
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined) {
    return failure(state, 'INVALID_COMMAND', 'The active player does not exist.');
  }

  if (command.type === 'UseProspecting') {
    if (!hasArchetypePower(state, player, 'corporate', 3)) {
      return failure(state, 'POWER_NOT_UNLOCKED', 'Arbitrage requires three Corporate cards.');
    }
    if (state.turn.usage.arbitrage >= level3UsageLimit(state, player.id, 1)) {
      return failure(state, 'POWER_USAGE_EXHAUSTED', 'Arbitrage has reached its per-turn limit.');
    }
    if (resourceTotal(command.payment) !== 1
        || resourceEntries(command.payment).some(([resource, amount]) => amount > player.resources[resource])) {
      return failure(state, 'INSUFFICIENT_RESOURCES', 'Arbitrage requires one held resource.');
    }
    const availableAfterPayment = resourceEntries(state.publicReserve)
      .reduce((total, [resource, amount]) => total + amount + command.payment[resource], 0);
    const requiredGain = Math.min(2, availableAfterPayment);
    if (resourceTotal(command.gain) !== requiredGain
        || resourceEntries(command.gain).some(
          ([resource, amount]) => amount > state.publicReserve[resource] + command.payment[resource],
        )) {
      return failure(state, 'RESOURCE_RESERVE_EXHAUSTED', `Arbitrage must take exactly ${requiredGain} available resources.`);
    }
    const next = structuredClone(state);
    const nextPlayer = next.players.find((candidate) => candidate.id === actor.playerId);
    if (nextPlayer === undefined) {
      throw new Error('Validated Arbitrage player disappeared during clone');
    }
    returnToReserve(next, nextPlayer, command.payment);
    grantFromReserve(next, nextPlayer, command.gain);
    next.turn.usage.arbitrage += 1;
    checkCap(next, nextPlayer, 'resumeAction');
    return accept(
      state,
      next,
      [publicEvent(next, 'ArbitrageUsed', `${nextPlayer.displayName} exchanged one resource for ${requiredGain}.`, nextPlayer.id)],
      content,
    );
  }

  if (command.type === 'UseDonations') {
    if (!hasArchetypePower(state, player, 'nationalist', 3)) {
      return failure(state, 'POWER_NOT_UNLOCKED', 'Shakedown requires three Nationalist cards.');
    }
    if (state.turn.usage.shakedown >= level3UsageLimit(state, player.id, 2)) {
      return failure(state, 'POWER_USAGE_EXHAUSTED', 'Shakedown has reached its per-turn limit.');
    }
    const opponent = state.players.find((candidate) => candidate.id === command.opponentId);
    if (opponent === undefined || opponent.id === player.id || opponent.resources[command.resource] < 1) {
      return failure(state, 'INVALID_TARGET_SET', 'Select a resource held by another player.');
    }
    const next = structuredClone(state);
    const nextPlayer = next.players.find((candidate) => candidate.id === player.id);
    const nextOpponent = next.players.find((candidate) => candidate.id === opponent.id);
    if (nextPlayer === undefined || nextOpponent === undefined) {
      throw new Error('Validated Shakedown players disappeared during clone');
    }
    nextOpponent.resources[command.resource] -= 1;
    nextPlayer.resources[command.resource] += 1;
    next.turn.usage.shakedown += 1;
    checkCap(next, nextPlayer, 'resumeAction');
    return accept(
      state,
      next,
      [publicEvent(next, 'ShakedownUsed', `${nextPlayer.displayName} snatched one ${command.resource} from ${nextOpponent.displayName}.`, nextPlayer.id)],
      content,
    );
  }

  if (command.type === 'UseBreakingGround') {
    if (!hasArchetypePower(state, player, 'corporate', 5)) {
      return failure(state, 'POWER_NOT_UNLOCKED', 'Demolition requires five Corporate cards.');
    }
    if (state.turn.usage.demolition >= 3) {
      return failure(state, 'POWER_USAGE_EXHAUSTED', 'Demolition is limited to three voters per turn.');
    }
    const voter = state.voters.find((candidate) => candidate.id === command.voterId);
    if (voter?.location.kind !== 'board') {
      return failure(state, 'INVALID_TARGET_SET', 'Select a voter on the board.');
    }
    if (isProtectedFromOpponent(state, content, voter, actor.playerId)) {
      return failure(state, 'INVALID_TARGET_SET', 'A persistent effect protects this voter from opponents.');
    }
    const sourceSlotId = voter.location.slotId;
    const source = content.board.slots.find((slot) => slot.slotId === sourceSlotId);
    if (source?.volatile !== false) {
      return failure(state, source?.volatile ? 'VOLATILE_VOTER_IMMUNE' : 'INVALID_TARGET_SET', 'Voters in volatile areas cannot be evicted.');
    }
    const next = structuredClone(state);
    const nextVoter = next.voters.find((candidate) => candidate.id === voter.id);
    const nextSlot = next.slots.find((slot) => slot.slotId === sourceSlotId);
    if (nextVoter === undefined || nextSlot === undefined) {
      throw new Error('Validated Demolition target disappeared during clone');
    }
    nextSlot.voterId = null;
    if (nextVoter.ownerId === actor.playerId) {
      const groupId = `evicted:${nextVoter.id}:${next.turn.ordinal}`;
      nextVoter.location = { kind: 'pending', groupId };
      next.pendingVoterGroups.push({
        id: groupId,
        ownerId: nextVoter.ownerId,
        controllerId: actor.playerId,
        voterIds: [nextVoter.id],
        origin: { kind: 'eviction' },
        sameZone: false,
        deadlineTurnOrdinal: next.turn.ordinal,
      });
    } else {
      nextVoter.location = {
        kind: 'evicted',
        availableOnTurnOrdinal: nextTurnOrdinalForPlayer(state, nextVoter.ownerId),
      };
    }
    next.turn.usage.demolition += 1;
    reconcileMajorities(next, content, 'action');
    return accept(
      state,
      next,
      [publicEvent(next, 'DemolitionUsed', `${player.displayName} evicted a voter from ${source.zoneId}.`, player.id)],
      content,
    );
  }

  if (command.type === 'UsePayback') {
    if (!hasArchetypePower(state, player, 'nationalist', 5)) {
      return failure(state, 'POWER_NOT_UNLOCKED', 'Crackdown requires five Nationalist cards.');
    }
    if (state.turn.usage.crackdown >= 2) {
      return failure(state, 'POWER_USAGE_EXHAUSTED', 'Crackdown is limited to twice per turn.');
    }
    if (resourceTotal(command.payment) !== 1
        || resourceEntries(command.payment).some(([resource, amount]) => amount > player.resources[resource])) {
      return failure(state, 'INSUFFICIENT_RESOURCES', 'Crackdown costs one held resource.');
    }
    const voter = state.voters.find((candidate) => candidate.id === command.voterId);
    if (voter?.location.kind !== 'board' || voter.ownerId === player.id) {
      return failure(state, 'INVALID_TARGET_SET', 'Crackdown requires an opponent voter on the board.');
    }
    if (isProtectedFromOpponent(state, content, voter, actor.playerId)) {
      return failure(state, 'INVALID_TARGET_SET', 'A persistent effect protects this voter from opponents.');
    }
    const sourceSlotId = voter.location.slotId;
    const source = content.board.slots.find((slot) => slot.slotId === sourceSlotId);
    if (source?.volatile !== false) {
      return failure(state, source?.volatile ? 'VOLATILE_VOTER_IMMUNE' : 'INVALID_TARGET_SET', 'Voters in volatile areas cannot be discarded.');
    }
    const next = structuredClone(state);
    const nextPlayer = next.players.find((candidate) => candidate.id === player.id);
    const nextVoter = next.voters.find((candidate) => candidate.id === voter.id);
    const nextSlot = next.slots.find((slot) => slot.slotId === sourceSlotId);
    if (nextPlayer === undefined || nextVoter === undefined || nextSlot === undefined) {
      throw new Error('Validated Crackdown state disappeared during clone');
    }
    const interceptors = spendToReserve(next, nextPlayer, command.payment);
    nextSlot.voterId = null;
    nextVoter.location = { kind: 'supply' };
    next.turn.usage.crackdown += 1;
    reconcileMajorities(next, content, 'action');
    checkCaps(next, interceptors, 'continueEffect');
    return accept(
      state,
      next,
      [publicEvent(next, 'CrackdownUsed', `${nextPlayer.displayName} discarded an opponent voter.`, nextPlayer.id)],
      content,
    );
  }

  if (!hasArchetypePower(state, player, 'reformer', 5)) {
    return failure(state, 'POWER_NOT_UNLOCKED', 'Outreach requires five Reformer cards.');
  }
  if (state.turn.usage.outreach >= 1) {
    return failure(state, 'POWER_USAGE_EXHAUSTED', 'Outreach is limited to once per turn.');
  }
  const volunteersAvailable = hasArchetypePower(state, player, 'reformer', 3)
    ? level3UsageLimit(state, player.id, 2) - state.turn.usage.volunteers
    : 0;
  const payment = validatePayment(
    player,
    { cash: 0, influence: 0, press: 0, faith: 2, generic: 2 },
    command.payment,
    volunteersAvailable,
  );
  if (!payment.ok) {
    return failure(state, volunteersAvailable > 0 ? 'INVALID_DISCOUNT' : 'INSUFFICIENT_RESOURCES', payment.message);
  }
  const uniqueIds = new Set(command.voterIds);
  const targets = command.voterIds.map((voterId) => state.voters.find((voter) => voter.id === voterId));
  if (uniqueIds.size !== 2 || targets.some((voter) => voter?.location.kind !== 'board')) {
    return failure(state, 'INVALID_TARGET_SET', 'Outreach requires two distinct voters on the board.');
  }
  const first = targets[0];
  const second = targets[1];
  if (first?.location.kind !== 'board' || second?.location.kind !== 'board'
      || first.ownerId === player.id || second.ownerId !== first.ownerId) {
    return failure(state, 'INVALID_TARGET_SET', 'Both converted voters must belong to the same opponent.');
  }
  if (isProtectedFromOpponent(state, content, first, actor.playerId)
      || isProtectedFromOpponent(state, content, second, actor.playerId)) {
    return failure(state, 'INVALID_TARGET_SET', 'A persistent effect protects a selected voter from opponents.');
  }
  const firstSlotId = first.location.slotId;
  const secondSlotId = second.location.slotId;
  const firstSlot = content.board.slots.find((slot) => slot.slotId === firstSlotId);
  const secondSlot = content.board.slots.find((slot) => slot.slotId === secondSlotId);
  if (firstSlot === undefined || secondSlot === undefined || firstSlot.zoneId !== secondSlot.zoneId) {
    return failure(state, 'INVALID_TARGET_SET', 'Both converted voters must occupy the same zone.');
  }
  if (firstSlot.volatile || secondSlot.volatile) {
    return failure(state, 'VOLATILE_VOTER_IMMUNE', 'Voters in volatile areas cannot be converted.');
  }
  const replacements = state.voters
    .filter((voter) => voter.ownerId === player.id && voter.location.kind === 'supply')
    .slice(0, 2);
  if (replacements.length !== 2) {
    return failure(state, 'INVALID_TARGET_SET', 'The converting player needs two voter tokens in supply.');
  }
  const next = structuredClone(state);
  const nextPlayer = next.players.find((candidate) => candidate.id === player.id);
  if (nextPlayer === undefined) {
    throw new Error('Validated Outreach player disappeared during clone');
  }
  const interceptors = spendToReserve(next, nextPlayer, command.payment.resources);
  next.turn.usage.volunteers += payment.discountsUsed;
  next.turn.usage.outreach += 1;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const replacement = replacements[index];
    if (target?.location.kind !== 'board' || replacement === undefined) {
      throw new Error('Validated Outreach target disappeared');
    }
    const nextTarget = next.voters.find((voter) => voter.id === target.id);
    const nextReplacement = next.voters.find((voter) => voter.id === replacement.id);
    const targetSlotId = target.location.slotId;
    const nextSlot = next.slots.find((slot) => slot.slotId === targetSlotId);
    if (nextTarget === undefined || nextReplacement === undefined || nextSlot === undefined) {
      throw new Error('Validated Outreach state disappeared during clone');
    }
    nextTarget.location = { kind: 'supply' };
    nextReplacement.location = { kind: 'board', slotId: nextSlot.slotId, majority: false };
    nextSlot.voterId = nextReplacement.id;
  }
  reconcileMajorities(next, content, 'action');
  checkCaps(next, interceptors, 'continueEffect');
  return accept(
    state,
    next,
    [publicEvent(next, 'OutreachUsed', `${nextPlayer.displayName} converted two voters in ${firstSlot.zoneId}.`, nextPlayer.id)],
    content,
  );
}

function applyGerrymander(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'Gerrymander' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'Gerrymandering is only available in the active player’s action phase.');
  }
  const rightsZone = content.board.zones.find((zone) => zone.id === command.rightsZoneId);
  const rightsOwnerId = rightsZone === undefined
    ? undefined
    : getZoneSnapshot(state, content, rightsZone.id).rightsOwnerId;
  if (rightsZone === undefined
      || (rightsOwnerId !== actor.playerId && !canBorrowRightsFrom(state, actor.playerId, rightsOwnerId))) {
    return failure(state, 'NO_GERRYMANDERING_RIGHTS', 'This player does not hold or borrow rights in the authorizing zone.');
  }
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined) {
    return failure(state, 'INVALID_COMMAND', 'The active player does not exist.');
  }
  const landslide = hasArchetypePower(state, player, 'populist', 5);
  const uses = state.turn.usage.gerrymandersByRightsZone[rightsZone.id] ?? 0;
  if (uses >= (landslide ? 2 : 1)) {
    return failure(state, 'GERRYMANDER_ALLOWANCE_EXHAUSTED', 'This zone’s gerrymander allowance was already used.');
  }
  const voter = state.voters.find((candidate) => candidate.id === command.voterId);
  if (voter?.location.kind !== 'board') {
    return failure(state, 'INVALID_TARGET_SET', 'The selected voter is not on the board.');
  }
  const sourceSlotId = voter.location.slotId;
  const sourceSlot = content.board.slots.find((slot) => slot.slotId === sourceSlotId);
  const destinationSlot = content.board.slots.find((slot) => slot.slotId === command.destinationSlotId);
  const destinationState = state.slots.find((slot) => slot.slotId === command.destinationSlotId);
  if (sourceSlot === undefined || destinationSlot === undefined || destinationState?.voterId !== null) {
    return failure(state, 'INVALID_TARGET_SET', 'The destination must be an empty board slot.');
  }
  if (isProtectedFromOpponent(state, content, voter, actor.playerId)) {
    return failure(state, 'INVALID_TARGET_SET', 'A persistent effect protects this voter from opponents.');
  }
  if (sourceSlot.volatile) {
    return failure(state, 'VOLATILE_VOTER_IMMUNE', 'A volatile voter cannot be moved.');
  }
  if (voter.location.majority && !landslide) {
    return failure(state, 'MAJORITY_VOTER_PROTECTED', 'Moving a majority voter requires Landslide.');
  }
  const tripleExists = content.board.movementTriples.some(
    ([rights, source, destination]) =>
      rights === rightsZone.id && source === sourceSlot.zoneId && destination === destinationSlot.zoneId,
  );
  if (!tripleExists) {
    return failure(state, 'INVALID_TARGET_SET', 'The selected source and destination are outside this rights-zone influence.');
  }
  if (voter.ownerId === actor.playerId && sourceSlot.zoneId === rightsZone.id) {
    const ownCount = getZoneSnapshot(state, content, rightsZone.id).counts[actor.playerId] ?? 0;
    if (ownCount === 1) {
      return failure(state, 'INVALID_TARGET_SET', 'The sole authorizing voter cannot leave its rights-zone.');
    }
  }

  const next = structuredClone(state);
  const nextVoter = next.voters.find((candidate) => candidate.id === voter.id);
  const nextSource = next.slots.find((slot) => slot.slotId === sourceSlot.slotId);
  const nextDestination = next.slots.find((slot) => slot.slotId === destinationSlot.slotId);
  if (nextVoter?.location.kind !== 'board' || nextSource === undefined || nextDestination === undefined) {
    throw new Error('Validated gerrymander state disappeared during clone');
  }
  nextSource.voterId = null;
  const scorchedEarth = matchingEffect(next, 'scorchedEarth', actor.playerId);
  const events: GameEvent[] = [];
  if (scorchedEarth !== undefined) {
    nextVoter.location = { kind: 'supply' };
    consumeEffectUse(next, scorchedEarth);
    events.push(publicEvent(next, 'VoterGerrymandered', `A voter from ${sourceSlot.zoneId} was discarded by Scorched Earth.`, actor.playerId));
  } else {
    nextDestination.voterId = nextVoter.id;
    nextVoter.location = { kind: 'board', slotId: destinationSlot.slotId, majority: false };
    events.push(publicEvent(next, 'VoterGerrymandered', `A voter moved from ${sourceSlot.zoneId} to ${destinationSlot.zoneId}.`, actor.playerId));
    if (destinationSlot.volatile) {
      next.newsQueue.push({
        id: `news-trigger-${next.nextSequence}`,
        voterId: nextVoter.id,
        slotId: destinationSlot.slotId,
        voterOwnerId: nextVoter.ownerId,
        actorId: actor.playerId,
        turnOrdinal: next.turn.ordinal,
      });
      next.nextSequence += 1;
      events.push(publicEvent(next, 'NewsQueued', `A news was queued for ${nextVoter.ownerId}.`, actor.playerId));
    }
  }
  next.turn.usage.gerrymandersByRightsZone[rightsZone.id] = uses + 1;
  const dissent = next.activeEffects.find(
    (effect) => effect.kind === 'hydra'
      && effect.ownerId === nextVoter.ownerId
      && effect.ownerId !== actor.playerId,
  );
  if (dissent !== undefined) {
    const bonus = next.voters.find(
      (candidate) => candidate.ownerId === dissent.ownerId && candidate.location.kind === 'supply',
    );
    if (bonus !== undefined) {
      bonus.location = {
        kind: 'evicted',
        availableOnTurnOrdinal: nextTurnOrdinalForPlayer(next, dissent.ownerId),
      };
      events.push(publicEvent(next, 'HydraTriggered', `${dissent.ownerId} gained a voter.`, dissent.ownerId));
    }
  }
  openMajoritySelectionIfNeeded(next, content);
  return accept(state, next, events, content);
}

function applyPendingGroupDiscard(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'ConfirmPendingVoterDiscard' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'Pending voter groups can only be discarded before ending the active turn.');
  }
  const due = state.pendingVoterGroups.filter(
    (group) => group.controllerId === actor.playerId && group.deadlineTurnOrdinal <= state.turn.ordinal,
  );
  if (command.groupIds.length !== due.length
      || !command.groupIds.every((groupId) => due.some((group) => group.id === groupId))) {
    return failure(state, 'INVALID_TARGET_SET', 'Confirm every voter group expiring at this turn end.');
  }
  const next = structuredClone(state);
  const dueIds = new Set(command.groupIds);
  for (const voter of next.voters) {
    if (voter.location.kind === 'pending' && dueIds.has(voter.location.groupId)) {
      voter.location = { kind: 'supply' };
    }
  }
  next.pendingVoterGroups = next.pendingVoterGroups.filter((group) => !dueIds.has(group.id));
  return accept(
    state,
    next,
    [publicEvent(next, 'PendingVotersDiscarded', `${actor.playerId} discarded unplaced voter groups.`, actor.playerId)],
    content,
  );
}

function applyEndTurn(
  state: GameState,
  actor: AuthenticatedActor,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return failure(state, 'WRONG_PHASE', 'The active action phase is not ready to end.');
  }
  const superstar = state.activeEffects.find(
    (effect) => effect.kind === 'starPower'
      && effect.ownerId === actor.playerId
      && effect.data.lastTurnOrdinal !== state.turn.ordinal,
  );
  const freeCards = superstar === undefined
    ? []
    : state.voterDeck.market
      .map((cardId) => content.voterCards.find((card) => card.id === cardId))
      .filter((card): card is NonNullable<typeof card> => card?.voters === 1);
  if (superstar !== undefined && freeCards.length > 0) {
    const next = structuredClone(state);
    const nextEffect = next.activeEffects.find((effect) => effect.id === superstar.id);
    if (nextEffect === undefined) {
      throw new Error('Validated Star Power effect disappeared.');
    }
    nextEffect.data = { ...nextEffect.data, lastTurnOrdinal: next.turn.ordinal };
    for (const card of freeCards) {
      next.voterDeck.market = next.voterDeck.market.filter((cardId) => cardId !== card.id);
      next.voterDeck.discardPile.push(card.id);
      const voter = next.voters.find(
        (candidate) => candidate.ownerId === actor.playerId && candidate.location.kind === 'supply',
      );
      if (voter !== undefined && next.slots.some((slot) => slot.voterId === null)) {
        const groupId = `superstar-group-${next.nextSequence}`;
        next.nextSequence += 1;
        voter.location = { kind: 'pending', groupId };
        next.pendingVoterGroups.push({
          id: groupId,
          ownerId: actor.playerId,
          controllerId: actor.playerId,
          voterIds: [voter.id],
          origin: { kind: 'effect', sourceCardId: superstar.sourceCardId },
          sameZone: true,
          deadlineTurnOrdinal: next.turn.ordinal,
        });
      }
    }
    refillVoterMarket(next);
    return accept(
      state,
      next,
      [publicEvent(next, 'StarPowerTriggered', `${actor.playerId} influenced open one-voter cards for free.`, actor.playerId)],
      content,
    );
  }
  if (state.pendingVoterGroups.some(
    (group) => group.controllerId === actor.playerId && group.deadlineTurnOrdinal <= state.turn.ordinal,
  )) {
    return failure(state, 'MANDATORY_CHOICE_PENDING', 'Place or explicitly discard every voter group expiring this turn.');
  }
  const bharat = state.activeEffects.find(
    (effect) => effect.kind === 'longMarch' && effect.ownerId === actor.playerId,
  );
  // Five is a fixed quantity (house rule R16), and the prompt below blocks every command — so a
  // board holding fewer than five reachable voters would refuse this seat's end turn for
  // good. The effect is left active rather than consumed: unlike a dealt news, this
  // one is anchored to the owner's end turn and simply waits for the next one, by which
  // time an ordinary game has filled the board (A18).
  const bharatCanRun = bharat !== undefined && canRunBharatEvictions(
    state,
    content,
    typeof bharat.data.reversedFromPlayerId === 'string' ? bharat.data.reversedFromPlayerId : undefined,
  );
  if (bharat !== undefined && bharatCanRun) {
    const next = structuredClone(state);
    next.endTurnContext = { playerId: actor.playerId };
    next.turn.phase = 'endTurn';
    openChoice(
      next,
      [actor.playerId],
      'Choose exactly five non-volatile voters to evict.',
      ['voters'],
      false,
      bharat.sourceCardId,
      {
        op: 'bharatVoters',
        ownerId: actor.playerId,
        deck: 'trick',
        ...(typeof bharat.data.reversedFromPlayerId === 'string'
          ? { reversedFromPlayerId: bharat.data.reversedFromPlayerId }
          : {}),
      },
    );
    return accept(
      state,
      next,
      [publicEvent(next, 'Long MarchJodoYatraTriggered', `${actor.playerId} began end-turn evictions.`, actor.playerId)],
      content,
    );
  }
  const greatLeader = state.activeEffects.find(
    (effect) => effect.kind === 'brainDrain' && effect.ownerId === actor.playerId,
  );
  if (greatLeader !== undefined && state.turn.usage.threeVoterPurchases > 0) {
    const next = structuredClone(state);
    const activeIndex = next.turn.order.indexOf(actor.playerId);
    const moverId = next.turn.order[(activeIndex + 1) % next.turn.order.length];
    if (moverId === undefined) {
      throw new Error('Great Leader has no following player.');
    }
    next.endTurnContext = { playerId: actor.playerId };
    next.turn.phase = 'endTurn';
    openChoice(
      next,
      [moverId],
      'Brain Drain: move one affected non-majority voter to an adjacent zone, or pass.',
      ['slots', 'pass'],
      true,
      greatLeader.sourceCardId,
      {
        op: 'greatLeaderMove',
        ownerId: actor.playerId,
        deck: 'news',
        remaining: state.turn.usage.threeVoterPurchases,
      },
    );
    return accept(
      state,
      next,
      [publicEvent(next, 'GreatLeaderTriggered', `${moverId} may relocate ${actor.playerId} voters.`, actor.playerId)],
      content,
    );
  }
  const next = structuredClone(state);
  const events: GameEvent[] = [];
  if (next.newsQueue.length > 0) {
    next.endTurnContext = { playerId: actor.playerId };
    const error = beginNewsResolution(next, content);
    if (error !== null) {
      return failure(state, 'CONTENT_NOT_EXECUTABLE', error);
    }
    events.push(publicEvent(next, 'NewsResolutionStarted', 'Queued news cards began resolving.', actor.playerId));
    if (next.pendingInteraction === null && next.newsQueue.length === 0) {
      const result = resolveEndTurnCheckpoint(next, actor.playerId, content);
      events.push(publicEvent(next, result === 'advanced' ? 'TurnEnded' : 'GameFinished', result === 'advanced'
        ? `${actor.playerId} ended their turn.`
        : 'The end-game checkpoint completed.', actor.playerId));
    }
  } else {
    const result = resolveEndTurnCheckpoint(next, actor.playerId, content);
    events.push(publicEvent(next, result === 'advanced' ? 'TurnEnded' : 'GameFinished', result === 'advanced'
      ? `${actor.playerId} ended their turn.`
      : 'The end-game checkpoint completed.', actor.playerId));
  }
  return accept(state, next, events, content);
}

export function applyCommand(
  state: GameState,
  actor: AuthenticatedActor,
  rawCommand: unknown,
  content: GameContent,
): CommandResult {
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  if (player === undefined) {
    return failure(state, 'INVALID_COMMAND', 'The authenticated seat is not part of this match.');
  }
  const parsed = GameCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return failure(state, 'INVALID_COMMAND', 'The command payload is invalid.');
  }
  switch (parsed.data.type) {
    case 'VoteForFirstPlayer':
      return applyFirstPlayerVote(state, actor, parsed.data, content);
    case 'ChooseStartingResources':
      return applyStartingResources(state, actor, parsed.data, content);
    case 'CommitPolicyAnswer':
      return applyPolicyAnswer(state, actor, parsed.data, content);
    case 'RedrawPolicy':
      return applyPolicyRedraw(state, actor, parsed.data, content);
    case 'DiscardExcessResources':
      return applyCapDiscard(state, actor, parsed.data, content);
    case 'InfluenceVoterCard':
      return applyInfluenceVoterCard(state, actor, parsed.data, content);
    case 'PlaceVoterGroup':
      return applyPlaceVoterGroup(state, actor, parsed.data, content);
    case 'SubmitChoice':
      return state.pendingInteraction?.kind === 'majoritySelection'
        ? applyMajorityChoice(state, actor, parsed.data, content)
        : applyEffectChoice(state, actor, parsed.data, content);
    case 'ProposeTrade':
    case 'AcceptTrade':
    case 'RejectTrade':
    case 'CancelTrade':
      return applyTradeCommand(state, actor, parsed.data, content);
    case 'SubmitVote':
    case 'PlaceBid':
    case 'PassAuction':
    case 'PayDebt':
      return resumeAfterCampaignInteraction(
        state,
        applyCampaignCommand(state, actor, parsed.data, content),
        content,
      );
    case 'BuyTrick':
      return applyBuyTrick(state, actor, parsed.data, content);
    case 'PlayTrick':
      return applyPlayTrick(state, actor, parsed.data, content);
    case 'PlayReaction':
    case 'PassPriority':
      return applyPriorityCommand(state, actor, parsed.data, content);
    case 'PayObligation':
      return applyPayObligation(state, actor, parsed.data, content);
    case 'BuyHeldVoter':
      return applyBuyHeldVoter(state, actor, parsed.data, content);
    case 'StealBase':
      return applyStealCult(state, actor, parsed.data, content);
    case 'ReassignJumla':
      return applyReassignJumla(state, actor, parsed.data, content);
    case 'AcquireJumla':
      return applyAcquireJumla(state, actor, parsed.data, content);
    case 'UseProspecting':
    case 'UseDonations':
    case 'UseBreakingGround':
    case 'UsePayback':
    case 'UseToughLove':
      return applyArchetypePower(state, actor, parsed.data, content);
    case 'Gerrymander':
      return applyGerrymander(state, actor, parsed.data, content);
    case 'ConfirmPendingVoterDiscard':
      return applyPendingGroupDiscard(state, actor, parsed.data, content);
    case 'RequestEndTurn':
      return applyEndTurn(state, actor, content);
    default:
      return failure(state, 'WRONG_PHASE', `Command is not available in phase ${state.turn.phase}.`);
  }
}
