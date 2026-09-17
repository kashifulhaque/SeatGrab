import type { EffectCard } from '@gerrymander/content';
import type { GameCommand } from '@gerrymander/protocol';
import type { GameContent } from '../content.js';
import type { AuthenticatedActor, CommandResult } from '../model/result.js';
import type { ChoiceInteraction, GameState, PlayerId } from '../model/state.js';
import { commandFailure, commandSuccess, createPublicEvent } from './commandResult.js';
import { beginEffect, isReversibleTrick } from './effects.js';
import { completeInteraction, interruptWith } from './interactions.js';

function strings(interaction: ChoiceInteraction, key: string): readonly string[] {
  const value = interaction.continuation[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function text(interaction: ChoiceInteraction, key: string): string | undefined {
  const value = interaction.continuation[key];
  return typeof value === 'string' ? value : undefined;
}

function discardPlayedCard(state: GameState, cardId: string): void {
  if (!state.trickDeck.discardPile.includes(cardId)
      && !state.activeEffects.some((effect) => effect.sourceCardId === cardId)
      && !(state.pendingInteraction?.kind === 'choice' && state.pendingInteraction.sourceCardId === cardId)
      && !state.interactionStack.some(
        (interaction) => interaction.kind === 'choice' && interaction.sourceCardId === cardId,
      )) {
    state.trickDeck.discardPile.push(cardId);
  }
}

export function openInteractionForPriority(
  state: GameState,
  card: EffectCard,
  actorId: PlayerId,
  responders: PlayerId[],
  mode?: string,
): void {
  const first = responders[0];
  if (first === undefined) {
    throw new Error('A priority window requires a responder.');
  }
  const interaction: ChoiceInteraction = {
    id: `interaction-${state.nextSequence}`,
    kind: 'choice',
    responsiblePlayerIds: [first],
    explanation: `React to ${card.title}, or pass priority.`,
    allowed: ['cards', 'pass'],
    allowPass: true,
    sourceCardId: card.id,
    continuation: {
      op: 'trickPriority',
      playedCardId: card.id,
      actorId,
      responders,
      passed: [],
      ...(mode === undefined ? {} : { mode }),
    },
  };
  state.nextSequence += 1;
  interruptWith(state, interaction);
}

function resolvePlayedCard(
  state: GameState,
  interaction: ChoiceInteraction,
  ownerId: PlayerId,
  content: GameContent,
  reversedFromPlayerId?: PlayerId,
): string | null {
  const playedCardId = text(interaction, 'playedCardId');
  const card = content.trickCards.find((candidate) => candidate.id === playedCardId);
  if (card === undefined) {
    return 'The trick awaiting priority is missing.';
  }
  completeInteraction(state);
  const mode = text(interaction, 'mode');
  const error = beginEffect(state, {
    ownerId,
    card,
    ...(mode === undefined ? {} : { mode }),
    ...(reversedFromPlayerId === undefined ? {} : { reversedFromPlayerId }),
  }, content);
  if (error !== null) {
    return error;
  }
  discardPlayedCard(state, card.id);
  return null;
}

export function applyPriorityCommand(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PlayReaction' | 'PassPriority' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'choice'
      || text(interaction, 'op') !== 'trickPriority'
      || !interaction.responsiblePlayerIds.includes(actor.playerId)
      || (command.type === 'PassPriority' && interaction.id !== command.interactionId)
      || (command.type === 'PlayReaction' && interaction.id !== command.targetEffectId)) {
    return commandFailure(state, 'MANDATORY_CHOICE_PENDING', 'This player does not hold trick reaction priority.');
  }
  const responders = strings(interaction, 'responders');
  const passed = [...strings(interaction, 'passed')];
  const next = structuredClone(state);
  const nextInteraction = next.pendingInteraction;
  if (nextInteraction?.kind !== 'choice') {
    throw new Error('Validated priority interaction disappeared.');
  }

  if (command.type === 'PlayReaction') {
    const reactor = next.players.find((player) => player.id === actor.playerId);
    const reaction = content.trickCards.find((card) => card.id === command.cardId);
    const playedCardId = text(nextInteraction, 'playedCardId') ?? '';
    const playedCard = content.trickCards.find((card) => card.id === playedCardId);
    if (reactor === undefined || reaction === undefined || playedCard === undefined
        || !reactor.trickHand.includes(reaction.id)
        || (reaction.handlerId !== 'trick.veto' && reaction.handlerId !== 'trick.boomerang')
        || (reaction.handlerId === 'trick.boomerang' && !isReversibleTrick(playedCard))) {
      return commandFailure(state, 'INVALID_TARGET_SET', 'Choose a legal Veto or Boomerang card held by this player.');
    }
    reactor.trickHand = reactor.trickHand.filter((cardId) => cardId !== reaction.id);
    next.trickDeck.discardPile.push(reaction.id);
    if (reaction.handlerId === 'trick.veto') {
      completeInteraction(next);
      next.trickDeck.discardPile.push(playedCardId);
      return commandSuccess(
        state,
        next,
        [createPublicEvent(next, 'TrickBlocked', `${reactor.displayName} blocked ${playedCardId}.`, reactor.id)],
        content,
      );
    }
    const originalActorId = text(nextInteraction, 'actorId');
    if (originalActorId === undefined) {
      return commandFailure(state, 'INVARIANT_VIOLATION', 'Priority window has no original actor.');
    }
    const error = resolvePlayedCard(next, nextInteraction, reactor.id, content, originalActorId);
    if (error !== null) {
      return commandFailure(state, 'INVALID_TARGET_SET', error);
    }
    return commandSuccess(
      state,
      next,
      [createPublicEvent(next, 'TrickReversed', `${reactor.displayName} reversed ${playedCardId}.`, reactor.id)],
      content,
    );
  }

  passed.push(actor.playerId);
  const nextResponder = responders.find((playerId) => !passed.includes(playerId));
  if (nextResponder !== undefined) {
    nextInteraction.responsiblePlayerIds = [nextResponder];
    nextInteraction.continuation = { ...nextInteraction.continuation, passed };
    return commandSuccess(
      state,
      next,
      [createPublicEvent(next, 'PriorityPassed', `${actor.playerId} passed reaction priority.`, actor.playerId)],
      content,
    );
  }
  const originalActorId = text(nextInteraction, 'actorId');
  if (originalActorId === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Priority window has no original actor.');
  }
  const error = resolvePlayedCard(next, nextInteraction, originalActorId, content);
  if (error !== null) {
    return commandFailure(state, 'INVALID_TARGET_SET', error);
  }
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'PriorityClosed', 'All eligible reactions passed.')],
    content,
  );
}

export { completeInteraction } from './interactions.js';
