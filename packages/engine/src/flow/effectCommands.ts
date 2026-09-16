import type { Cost, EffectCard, ResourceVector } from '@seatgrab/content';
import type { GameCommand } from '@seatgrab/protocol';
import type { GameContent } from '../content.js';
import type { AuthenticatedActor, CommandResult } from '../model/result.js';
import { resourceEntries, resourceTotal, type ChoiceInteraction, type GameState } from '../model/state.js';
import { shuffle } from '../random/prng.js';
import { getZoneSnapshot } from '../rules/board.js';
import { consumeEffectUse } from '../rules/effectModifiers.js';
import { reconcileMajorities } from '../rules/majorities.js';
import { archetypeCount, hasArchetypePower, level3UsageLimit } from '../rules/powers.js';
import { grantFromReserve, returnToReserve, spendToReserve, validatePayment } from '../rules/resources.js';
import { commandFailure, commandSuccess, createPublicEvent } from './commandResult.js';
import { resolveEndTurnCheckpoint } from './endTurn.js';
import { beginEffect, cleanupExpiredEffects, isReversibleTrick, resolveEffectChoice } from './effects.js';
import { openChoice } from './campaign.js';
import { openInteractionForPriority } from './effectPriority.js';
import { checkCap, checkCaps } from './turn.js';

function rotatedAfter(state: GameState, playerId: string): string[] {
  const index = state.turn.order.indexOf(playerId);
  if (index < 0) {
    return [];
  }
  return Array.from({ length: state.turn.order.length - 1 }, (_, offset) =>
    state.turn.order[(index + offset + 1) % state.turn.order.length]).filter((id): id is string => id !== undefined);
}


function hasPendingSourceCard(state: GameState, cardId: string): boolean {
  const current = state.pendingInteraction;
  return (current?.kind === 'choice' && current.sourceCardId === cardId)
    || state.interactionStack.some(
      (interaction) => interaction.kind === 'choice' && interaction.sourceCardId === cardId,
    );
}

function discardResolvedTrick(state: GameState, card: EffectCard): void {
  if (!state.activeEffects.some((effect) => effect.sourceCardId === card.id)
      && !hasPendingSourceCard(state, card.id)
      && !state.trickDeck.discardPile.includes(card.id)) {
    state.trickDeck.discardPile.push(card.id);
  }
}

/**
 * What a seat pays for the top trick, printed price and all.
 *
 * `applyBuyTrick` charges this and `projectGame` shows it, from this one function, so
 * the figure a seat is quoted is by construction the figure it is charged. The surcharge
 * is Leaked Tapes (NEWS007), which adds one generic unit to every trick the seat
 * buys for the rest of the game.
 */
export function trickPurchaseCost(
  state: GameState,
  playerId: string,
  card: EffectCard,
): { printed: Cost; payable: Cost } | null {
  if (card.backCost === undefined) {
    return null;
  }
  const surcharge = state.activeEffects.some(
    (effect) => effect.kind === 'leakedTapes' && effect.targetPlayerIds.includes(playerId),
  ) ? 1 : 0;
  return {
    printed: card.backCost,
    payable: { ...card.backCost, generic: card.backCost.generic + surcharge },
  };
}

export function applyBuyTrick(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'BuyTrick' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return commandFailure(state, 'WRONG_PHASE', 'Tricks may only be bought in the active action phase.');
  }
  const buyer = state.players.find((player) => player.id === actor.playerId);
  if (buyer === undefined || buyer.debts.length > 0 || buyer.obligations.some((item) => item.kind === 'reliefFund')) {
    return commandFailure(state, buyer?.debts.length ? 'PURCHASE_BLOCKED_BY_DEBT' : 'WRONG_PHASE', 'An unpaid debt or obligation blocks this purchase.');
  }
  const cardId = state.trickDeck.drawPile[0];
  const card = content.trickCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return commandFailure(state, 'CONTENT_NOT_EXECUTABLE', 'The trick deck is exhausted.');
  }
  // Every trick in this pack carries a back cost, so this guard is unreachable here.
  // It stays because the price is a content field: a pack that ships a trick without
  // one must refuse the purchase rather than charge nothing for it.
  const quote = trickPurchaseCost(state, buyer.id, card);
  if (quote === null) {
    return commandFailure(state, 'CONTENT_NOT_EXECUTABLE', `The content pack sets no back cost for ${card.id}.`);
  }
  const cost: Cost = quote.payable;
  const discountAvailable = hasArchetypePower(state, buyer, 'reformer', 3)
    ? level3UsageLimit(state, buyer.id, 2) - state.turn.usage.volunteers
    : 0;
  const payment = validatePayment(buyer, cost, command.payment, discountAvailable);
  if (!payment.ok) {
    return commandFailure(state, discountAvailable > 0 ? 'INVALID_DISCOUNT' : 'INSUFFICIENT_RESOURCES', payment.message);
  }
  const next = structuredClone(state);
  const nextBuyer = next.players.find((player) => player.id === buyer.id);
  if (nextBuyer === undefined) {
    throw new Error('Validated trick buyer disappeared.');
  }
  const interceptors = spendToReserve(next, nextBuyer, command.payment.resources);
  next.turn.usage.volunteers += payment.discountsUsed;
  next.trickDeck.drawPile.shift();
  nextBuyer.trickHand.push(card.id);
  checkCaps(next, interceptors, 'continueEffect');
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'TrickBought', `${nextBuyer.displayName} bought a hidden trick.`, nextBuyer.id)],
    content,
  );
}

export function applyPlayTrick(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PlayTrick' }>,
  content: GameContent,
): CommandResult {
  const owner = state.players.find((player) => player.id === actor.playerId);
  const card = content.trickCards.find((candidate) => candidate.id === command.cardId);
  const normalWindow = state.status === 'active'
    && ((state.turn.phase === 'action' && state.turn.activePlayerId === actor.playerId && state.pendingInteraction === null)
      || (state.turn.phase === 'policyAnswer' && state.pendingInteraction?.kind === 'policyAnswer'));
  if (!normalWindow || owner === undefined || card === undefined || !owner.trickHand.includes(card.id)) {
    return commandFailure(state, 'WRONG_PHASE', 'This trick cannot be played in the current window.');
  }
  if (card.handlerId === 'trick.boomerang') {
    return commandFailure(state, 'WRONG_PHASE', 'Boomerang may only be played as a reaction.');
  }
  const next = structuredClone(state);
  const nextOwner = next.players.find((player) => player.id === owner.id);
  if (nextOwner === undefined) {
    throw new Error('Validated trick owner disappeared.');
  }
  nextOwner.trickHand = nextOwner.trickHand.filter((cardId) => cardId !== card.id);
  const immuneTriple = card.handlerId === 'trick.cornerstone' && command.mode === 'triple';
  const responders = rotatedAfter(next, owner.id).filter((playerId) => {
    const hand = next.players.find((player) => player.id === playerId)?.trickHand ?? [];
    return hand.some((cardId) => {
      const reaction = content.trickCards.find((candidate) => candidate.id === cardId);
      return reaction?.handlerId === 'trick.veto'
        || (reaction?.handlerId === 'trick.boomerang' && isReversibleTrick(card));
    });
  });
  if (!immuneTriple && responders.length > 0) {
    openInteractionForPriority(next, card, owner.id, responders, command.mode);
  } else {
    const error = beginEffect(next, {
      ownerId: owner.id,
      card,
      ...(command.mode === undefined ? {} : { mode: command.mode }),
    }, content);
    if (error !== null) {
      return commandFailure(state, 'INVALID_TARGET_SET', error);
    }
    discardResolvedTrick(next, card);
  }
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'TrickPlayed', `${owner.displayName} played ${card.title}.`, owner.id)],
    content,
  );
}

export function applyEffectChoice(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'SubmitChoice' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'choice' || interaction.id !== command.interactionId) {
    return commandFailure(state, 'MANDATORY_CHOICE_PENDING', 'The referenced choice is not pending.');
  }
  const next = structuredClone(state);
  const nextInteraction = next.pendingInteraction;
  if (nextInteraction?.kind !== 'choice') {
    throw new Error('Validated effect choice disappeared.');
  }
  const error = resolveEffectChoice(next, actor.playerId, nextInteraction, command.selection, content);
  if (error !== null) {
    return commandFailure(state, 'INVALID_TARGET_SET', error);
  }
  cleanupExpiredEffects(next);
  if (next.turn.phase === 'newsResolution' && next.pendingInteraction === null) {
    const continuationError = beginNewsResolution(next, content);
    if (continuationError !== null) {
      return commandFailure(state, 'CONTENT_NOT_EXECUTABLE', continuationError);
    }
    const endingPlayerId = next.endTurnContext?.playerId;
    if (next.pendingInteraction === null && next.newsQueue.length === 0 && endingPlayerId !== undefined) {
      resolveEndTurnCheckpoint(next, endingPlayerId, content);
    }
  }
  if (next.turn.phase === 'endTurn' && next.pendingInteraction === null) {
    const endingPlayerId = next.endTurnContext?.playerId;
    if (endingPlayerId === undefined) {
      return commandFailure(state, 'INVARIANT_VIOLATION', 'The end-turn continuation lost its owner.');
    }
    if (next.newsQueue.length > 0) {
      const continuationError = beginNewsResolution(next, content);
      if (continuationError !== null) {
        return commandFailure(state, 'CONTENT_NOT_EXECUTABLE', continuationError);
      }
      if (next.pendingInteraction === null && next.newsQueue.length === 0) {
        resolveEndTurnCheckpoint(next, endingPlayerId, content);
      }
    } else {
      resolveEndTurnCheckpoint(next, endingPlayerId, content);
    }
  }
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'EffectChoiceResolved', `${actor.playerId} resolved an effect choice.`, actor.playerId)],
    content,
  );
}

export function applyPayObligation(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PayObligation' }>,
  content: GameContent,
): CommandResult {
  const owner = state.players.find((player) => player.id === actor.playerId);
  const obligation = owner?.obligations.find((item) => item.id === command.obligationId);
  if (owner === undefined || obligation?.kind !== 'reliefFund' || command.selection.kind !== 'resources') {
    return commandFailure(state, 'INVALID_TARGET_SET', 'That payable obligation is not held by this player.');
  }
  const required: ResourceVector = { cash: 1, influence: 1, press: 1, faith: 1 };
  if (RESOURCE_KEYS.some((resource) => command.selection.kind !== 'resources'
      || command.selection.resources[resource] !== required[resource]
      || owner.resources[resource] < required[resource])) {
    return commandFailure(state, 'INSUFFICIENT_RESOURCES', 'Relief Fund requires one resource of each type.');
  }
  const next = structuredClone(state);
  const nextOwner = next.players.find((player) => player.id === owner.id);
  if (nextOwner === undefined) {
    throw new Error('Validated obligation owner disappeared.');
  }
  returnToReserve(next, nextOwner, required);
  nextOwner.obligations = nextOwner.obligations.filter((item) => item.id !== obligation.id);
  const effects = next.activeEffects.filter((effect) => effect.sourceCardId === obligation.sourceCardId);
  next.activeEffects = next.activeEffects.filter((effect) => effect.sourceCardId !== obligation.sourceCardId);
  if (effects.length > 0) {
    next.newsDeck.discardPile.push(obligation.sourceCardId);
  }
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'ObligationPaid', `${nextOwner.displayName} settled Relief Fund.`, nextOwner.id)],
    content,
  );
}

const RESOURCE_KEYS = ['cash', 'influence', 'press', 'faith'] as const;

export function applyReassignJumla(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'ReassignJumla' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return commandFailure(state, 'WRONG_PHASE', 'Turncoat may be reassigned only at the end of its owner’s active turn.');
  }
  const effect = state.activeEffects.find((candidate) => candidate.kind === 'turncoatArchetype' && candidate.ownerId === actor.playerId);
  if (effect === undefined) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'This player does not control Turncoat.');
  }
  const next = structuredClone(state);
  const nextEffect = next.activeEffects.find((candidate) => candidate.id === effect.id);
  if (nextEffect === undefined) {
    throw new Error('Validated Turncoat effect disappeared.');
  }
  nextEffect.data = { ...nextEffect.data, archetype: command.archetype, playerId: actor.playerId };
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'TurncoatReassigned', `${actor.playerId} moved Turncoat to ${command.archetype}.`, actor.playerId)],
    content,
  );
}

export function applyAcquireJumla(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'AcquireJumla' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return commandFailure(state, 'WRONG_PHASE', 'Turncoat may only be acquired in the active action phase.');
  }
  const effect = state.activeEffects.find((candidate) => candidate.kind === 'turncoatArchetype' && candidate.ownerId === command.ownerId);
  const buyer = state.players.find((player) => player.id === actor.playerId);
  const seller = state.players.find((player) => player.id === command.ownerId);
  const archetype = effect?.data.archetype;
  if (effect === undefined || buyer === undefined || seller === undefined || buyer.id === seller.id
      || typeof archetype !== 'string') {
    return commandFailure(state, 'INVALID_TARGET_SET', 'The selected player does not hold an acquirable Turncoat.');
  }
  const price = archetypeCount(state, seller, archetype as Parameters<typeof archetypeCount>[2]);
  if (resourceTotal(command.payment) !== price
      || resourceEntries(command.payment).some(([resource, amount]) => amount > buyer.resources[resource])) {
    return commandFailure(state, 'INSUFFICIENT_RESOURCES', `Turncoat currently costs exactly ${price} resources.`);
  }
  const next = structuredClone(state);
  const nextBuyer = next.players.find((player) => player.id === buyer.id);
  const nextSeller = next.players.find((player) => player.id === seller.id);
  const nextEffect = next.activeEffects.find((candidate) => candidate.id === effect.id);
  if (nextBuyer === undefined || nextSeller === undefined || nextEffect === undefined) {
    throw new Error('Validated Turncoat acquisition state disappeared.');
  }
  for (const [resource, amount] of resourceEntries(command.payment)) {
    nextBuyer.resources[resource] -= amount;
    nextSeller.resources[resource] += amount;
  }
  nextEffect.ownerId = nextBuyer.id;
  nextEffect.targetPlayerIds = [nextBuyer.id];
  nextEffect.data = { ...nextEffect.data, playerId: nextBuyer.id };
  checkCap(next, nextSeller, 'continueEffect');
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'TurncoatAcquired', `${nextBuyer.displayName} acquired Turncoat from ${nextSeller.displayName}.`, nextBuyer.id)],
    content,
  );
}

export function applyBuyHeldVoter(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'BuyHeldVoter' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return commandFailure(state, 'WRONG_PHASE', 'Held voters may only be bought during their owner’s action phase.');
  }
  const effect = state.activeEffects.find(
    (candidate) => candidate.sourceCardId === command.sourceCardId
      && (candidate.kind === 'dragnet' || candidate.kind === 'ransomNote'),
  );
  const heldIds = effect?.data.heldVoterIds;
  const voter = state.voters.find((candidate) => candidate.id === command.voterId);
  const buyer = state.players.find((candidate) => candidate.id === actor.playerId);
  if (effect === undefined || !Array.isArray(heldIds) || !heldIds.includes(command.voterId)
      || voter?.ownerId !== actor.playerId || voter.location.kind !== 'removed' || buyer === undefined) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'That voter is not held for this player.');
  }
  if (resourceTotal(command.payment) !== 1
      || resourceEntries(command.payment).some(([resource, amount]) => amount > buyer.resources[resource])) {
    return commandFailure(state, 'INSUFFICIENT_RESOURCES', 'Buying back a held voter costs exactly one held resource.');
  }
  const next = structuredClone(state);
  const nextEffect = next.activeEffects.find((candidate) => candidate.id === effect.id);
  const nextVoter = next.voters.find((candidate) => candidate.id === voter.id);
  const nextBuyer = next.players.find((candidate) => candidate.id === buyer.id);
  if (nextEffect === undefined || nextVoter === undefined || nextBuyer === undefined) {
    throw new Error('Validated held-voter state disappeared.');
  }
  const capPlayers = [];
  if (nextEffect.kind === 'dragnet') {
    const jailer = next.players.find((candidate) => candidate.id === nextEffect.ownerId);
    if (jailer === undefined) {
      throw new Error('Dragnet jailer disappeared.');
    }
    for (const [resource, amount] of resourceEntries(command.payment)) {
      nextBuyer.resources[resource] -= amount;
      jailer.resources[resource] += amount;
    }
    capPlayers.push(jailer);
  } else {
    capPlayers.push(...spendToReserve(next, nextBuyer, command.payment));
  }
  const groupId = `held-voter-group-${next.nextSequence}`;
  next.nextSequence += 1;
  nextVoter.location = { kind: 'pending', groupId };
  next.pendingVoterGroups.push({
    id: groupId,
    ownerId: nextBuyer.id,
    controllerId: nextBuyer.id,
    voterIds: [nextVoter.id],
    origin: { kind: 'effect', sourceCardId: nextEffect.sourceCardId },
    sameZone: true,
    deadlineTurnOrdinal: next.turn.ordinal,
  });
  const remaining = heldIds.filter((id) => id !== nextVoter.id);
  nextEffect.data = { ...nextEffect.data, heldVoterIds: remaining };
  if (remaining.length === 0) {
    next.activeEffects = next.activeEffects.filter((candidate) => candidate.id !== nextEffect.id);
    const deck = nextEffect.kind === 'dragnet' ? next.trickDeck : next.newsDeck;
    if (!deck.discardPile.includes(nextEffect.sourceCardId)) {
      deck.discardPile.push(nextEffect.sourceCardId);
    }
  }
  checkCaps(next, capPlayers, 'continueEffect');
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'HeldVoterBoughtBack', `${nextBuyer.displayName} bought back a held voter.`, nextBuyer.id)],
    content,
  );
}

export function applyStealCult(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'StealBase' }>,
  content: GameContent,
): CommandResult {
  if (state.turn.phase !== 'action' || state.turn.activePlayerId !== actor.playerId || state.pendingInteraction !== null) {
    return commandFailure(state, 'WRONG_PHASE', 'Loyal Base may only be stolen during the active action phase.');
  }
  const effect = state.activeEffects.find(
    (candidate) => candidate.kind === 'loyalBase'
      && candidate.sourceCardId === command.sourceCardId
      && candidate.ownerId !== actor.playerId,
  );
  const selected = command.voterIds.map((voterId) => state.voters.find((voter) => voter.id === voterId));
  const invalidSelection = selected.some((voter) => {
    if (voter?.ownerId !== actor.playerId || voter.location.kind !== 'board') {
      return true;
    }
    const slotId = voter.location.slotId;
    return content.board.slots.find((slot) => slot.slotId === slotId)?.volatile !== false;
  });
  if (effect === undefined || new Set(command.voterIds).size !== 3 || invalidSelection) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'Select three distinct non-volatile board voters of your own.');
  }
  const replacements = state.voters.filter(
    (voter) => voter.ownerId === effect.ownerId && voter.location.kind === 'supply',
  ).slice(0, 3);
  if (replacements.length !== 3) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'The current Cult owner lacks three supply voters for conversion.');
  }
  const next = structuredClone(state);
  const nextEffect = next.activeEffects.find((candidate) => candidate.id === effect.id);
  if (nextEffect === undefined) {
    throw new Error('Validated Cult effect disappeared.');
  }
  for (let index = 0; index < command.voterIds.length; index += 1) {
    const target = next.voters.find((voter) => voter.id === command.voterIds[index]);
    const replacement = next.voters.find((voter) => voter.id === replacements[index]?.id);
    if (target?.location.kind !== 'board' || replacement === undefined) {
      throw new Error('Validated Cult conversion voter disappeared.');
    }
    const slotId = target.location.slotId;
    target.location = { kind: 'supply' };
    replacement.location = { kind: 'board', slotId, majority: false };
    const slot = next.slots.find((candidate) => candidate.slotId === slotId);
    if (slot === undefined) {
      throw new Error('Validated Cult conversion slot disappeared.');
    }
    slot.voterId = replacement.id;
  }
  reconcileMajorities(next, content, 'effect');
  const eligibleZones = content.board.zones
    .filter((zone) => getZoneSnapshot(next, content, zone.id).majorityOwnerId === actor.playerId);
  if (eligibleZones.length === 0) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'The stealing player must retain a majority to protect.');
  }
  nextEffect.ownerId = actor.playerId;
  nextEffect.targetPlayerIds = [actor.playerId];
  nextEffect.targetZoneIds = [];
  openChoice(
    next,
    [actor.playerId],
    'Choose one of your majorities for the stolen Loyal Base card.',
    ['option'],
    false,
    nextEffect.sourceCardId,
    { op: 'cultStolenZone', ownerId: actor.playerId, deck: 'trick', effectId: nextEffect.id },
  );
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'CultStolen', `${actor.playerId} stole Loyal Base.`, actor.playerId)],
    content,
  );
}

export function beginNewsResolution(state: GameState, content: GameContent): string | null {
  state.turn.phase = 'newsResolution';
  while (state.newsQueue.length > 0 && state.pendingInteraction === null) {
    const trigger = state.newsQueue.shift();
    if (trigger === undefined) {
      break;
    }
    if (state.newsDeck.drawPile.length === 0 && state.newsDeck.discardPile.length > 0) {
      const recycled = shuffle(state.newsDeck.discardPile.splice(0), state.random);
      state.newsDeck.drawPile = recycled.items;
      state.random = recycled.state;
    }
    const cardId = state.newsDeck.drawPile.shift();
    const card = content.newsCards.find((candidate) => candidate.id === cardId);
    if (card === undefined) {
      return 'The news deck is exhausted with a trigger still pending.';
    }
    const error = beginEffect(state, { ownerId: trigger.voterOwnerId, card, trigger }, content);
    if (error !== null) {
      return error;
    }
    if (!state.activeEffects.some((effect) => effect.sourceCardId === card.id)
        && !hasPendingSourceCard(state, card.id)) {
      state.newsDeck.discardPile.push(card.id);
    }
  }
  return null;
}
