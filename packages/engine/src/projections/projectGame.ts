import type { BoardZoneId, Archetype } from '@gerrymander/content';
import type { MatchSetupView, PendingDecisionView, PlayerView, VisibleEvent } from '@gerrymander/protocol';
import type { GameContent } from '../content.js';
import type { GameEvent, GameState, PendingInteraction, PlayerId } from '../model/state.js';
import { BASE_RESOURCE_CAP } from '../model/state.js';
import { trickPurchaseCost } from '../flow/effectCommands.js';
import { getZoneSnapshot, scorePlayer } from '../rules/board.js';
import { projectChoiceContext, projectHeldVoters, projectJumlaHoldings } from './choicePrompt.js';

export type Viewer = { kind: 'public' } | { kind: 'player'; playerId: PlayerId };

export function projectEvents(events: readonly GameEvent[], viewer: Viewer): VisibleEvent[] {
  return events.flatMap((event) => {
    const visible = event.visibility === 'public'
      || (viewer.kind === 'player'
        && typeof event.visibility === 'object'
        && event.visibility.playerIds.includes(viewer.playerId));
    if (!visible) {
      return [];
    }
    const projected: VisibleEvent = { id: event.id, type: event.type, message: event.message };
    if (event.actorId !== undefined) {
      projected.actorId = event.actorId;
    }
    return [projected];
  });
}


/**
 * The settings frozen into the match, copied out of the state for every viewer.
 *
 * These never change after creation, so a client can cache them; they are projected on
 * every view anyway because an online client joins mid-match and has no other source.
 */
/**
 * The public price of the top trick, for one viewer.
 *
 * The identity of that card is secret and stays secret: only the two cost vectors leave
 * this function. A public viewer gets the printed price with no surcharge applied, since a
 * surcharge belongs to a seat rather than to the card.
 */
function projectTrickMarket(
  state: GameState,
  content: GameContent,
  viewer: Viewer,
): PlayerView['trickMarket'] {
  const cardId = state.trickDeck.drawPile[0];
  const card = content.trickCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return undefined;
  }
  const quote = trickPurchaseCost(state, viewer.kind === 'player' ? viewer.playerId : '', card);
  return quote === null ? undefined : { printed: { ...quote.printed }, payable: { ...quote.payable } };
}

function projectSetup(state: GameState): MatchSetupView {
  return {
    matchId: state.matchId,
    playerCount: state.config.players.length,
    tiePolicy: state.config.tiePolicy,
    contentAdvisories: [...state.config.contentAdvisories],
    contentPackId: state.content.contentPackId,
    contentVersion: state.content.contentVersion,
    rulesetId: state.content.rulesetId,
    rulesetVersion: state.content.rulesetVersion,
    boardId: state.content.boardId,
    boardVersion: state.content.boardVersion,
    engineVersion: state.engineVersion,
    schemaVersion: state.schemaVersion,
  };
}

/** Neutral public wording for each interaction that is not a card-driven choice. */
const DECISION_SUMMARIES: Record<
  Exclude<PendingInteraction['kind'], 'choice'>,
  string
> = {
  firstPlayerVote: 'Voting for the first player.',
  startingResources: 'Taking starting resources.',
  policyAnswer: 'Answering a hidden Policy Card.',
  capDiscard: 'Discarding down to the resource cap.',
  majoritySelection: 'Marking a majority.',
};

/**
 * Who the match is waiting on, for the shared surface.
 *
 * Every field here is something anyone at a physical table can see: which seats are
 * being waited on, what kind of decision it is, and which face-up card opened it. The
 * options themselves stay in the responsible seat's own prompt, so a shared screen can
 * name the decision owner without naming the decision's contents.
 *
 * `explanation` is engine-authored English about counts and public objects. No handler
 * interpolates a hidden card ID into it, and `projection-privacy.test.ts` scans the
 * whole projection for the hidden values that would matter if one ever did.
 */
function projectPendingDecision(interaction: PendingInteraction): PendingDecisionView {
  if (interaction.kind === 'choice') {
    return {
      interactionId: interaction.id,
      kind: 'choice',
      responsiblePlayerIds: [...interaction.responsiblePlayerIds],
      summary: interaction.explanation,
      ...(interaction.sourceCardId === undefined ? {} : { sourceCardId: interaction.sourceCardId }),
    };
  }
  const responsiblePlayerIds = interaction.kind === 'startingResources'
    ? [...interaction.remainingPlayerIds]
    : interaction.kind === 'firstPlayerVote'
      ? interaction.responsiblePlayerIds.filter(
        (playerId) => interaction.ballots[playerId] === undefined,
      )
      : [...interaction.responsiblePlayerIds];
  return {
    interactionId: interaction.id,
    kind: interaction.kind,
    responsiblePlayerIds,
    summary: DECISION_SUMMARIES[interaction.kind],
  };
}

export function projectGame(state: GameState, viewer: Viewer, content: GameContent): PlayerView {
  const zones = content.board.zones.map((zone) => {
    const snapshot = getZoneSnapshot(state, content, zone.id);
    const projected = {
      id: zone.id,
      displayName: zone.displayName,
      capacity: zone.capacity,
      majorityThreshold: zone.majorityThreshold,
      counts: snapshot.counts,
    };
    return {
      ...projected,
      ...(snapshot.majorityOwnerId === undefined ? {} : { majorityOwnerId: snapshot.majorityOwnerId }),
      ...(snapshot.rightsOwnerId === undefined ? {} : { rightsOwnerId: snapshot.rightsOwnerId }),
    };
  });
  const market = projectTrickMarket(state, content, viewer);
  const slotById = new Map(content.board.slots.map((slot) => [slot.slotId, slot]));
  const voterById = new Map(state.voters.map((voter) => [voter.id, voter]));
  const slots = state.slots.map((slotState) => {
    const slot = slotById.get(slotState.slotId);
    if (slot === undefined) {
      throw new Error(`State references unknown slot ${slotState.slotId}`);
    }
    const voter = slotState.voterId === null ? undefined : voterById.get(slotState.voterId);
    return {
      slotId: slot.slotId,
      zoneId: slot.zoneId,
      volatile: slot.volatile,
      ...(voter?.location.kind === 'board'
        ? { voter: { id: voter.id, ownerId: voter.ownerId, majority: voter.location.majority } }
        : {}),
    };
  });
  const players = state.players.map((player) => {
    const policyCounts: Record<Archetype, number> = {
      corporate: 0,
      nationalist: 0,
      populist: 0,
      reformer: 0,
    };
    for (const card of player.retainedPolicy) {
      policyCounts[card.archetype] += 1;
    }
    const seat = state.config.players.find((entry) => entry.id === player.id);
    const controller = seat?.controller ?? 'human';
    const capModifier = state.activeEffects
      .filter((effect) => effect.ownerId === player.id && effect.kind === 'resourceCap')
      .reduce((total, effect) => total + (typeof effect.data.amount === 'number' ? effect.data.amount : 0), 0);
    return {
      id: player.id,
      displayName: player.displayName,
      partyId: player.partyId,
      seat: player.seat,
      resources: { ...player.resources },
      resourceCap: BASE_RESOURCE_CAP + capModifier,
      policyCounts,
      trickHandCount: player.trickHand.length,
      score: scorePlayer(state, player.id),
      connected: player.connected,
      controller,
      ...(controller === 'computer' && seat?.difficulty !== undefined
        ? { difficulty: seat.difficulty }
        : {}),
    };
  });

  const view: PlayerView = {
    matchId: state.matchId,
    revision: state.revision,
    status: state.status,
    phase: state.turn.phase,
    setup: projectSetup(state),
    players,
    turnOrdinal: state.turn.ordinal,
    publicReserve: { ...state.publicReserve },
    zones,
    slots,
    voterMarket: [...state.voterDeck.market],
    voterCards: state.voterDeck.market.flatMap((cardId) => {
      const card = content.voterCards.find((candidate) => candidate.id === cardId);
      return card === undefined ? [] : [{
        id: card.id,
        voters: card.voters,
        cost: { ...card.cost },
      }];
    }),
    activeEffects: state.activeEffects.map((effect) => {
      const definition = [...content.trickCards, ...content.newsCards]
        .find((card) => card.id === effect.sourceCardId);
      return {
        id: effect.id,
        sourceCardId: effect.sourceCardId,
        title: definition?.title ?? effect.kind,
        kind: effect.kind,
        ownerId: effect.ownerId,
        targetPlayerIds: [...effect.targetPlayerIds],
        targetZoneIds: [...effect.targetZoneIds],
        ...(effect.remainingUses === undefined ? {} : { remainingUses: effect.remainingUses }),
      };
    }),
    turncoatHoldings: projectJumlaHoldings(state),
    deckCounts: {
      policy: state.policyDeck.drawPile.length,
      voter: state.voterDeck.drawPile.length,
      news: state.newsDeck.drawPile.length,
      trick: state.trickDeck.drawPile.length,
    },
    ...(market === undefined ? {} : { trickMarket: market }),
    turnUsage: {
      arbitrage: state.turn.usage.arbitrage,
      shakedown: state.turn.usage.shakedown,
      groundswell: state.turn.usage.groundswellCardIds.length,
      volunteers: state.turn.usage.volunteers,
      demolition: state.turn.usage.demolition,
      crackdown: state.turn.usage.crackdown,
      outreach: state.turn.usage.outreach,
      gerrymandersByZoneId: { ...state.turn.usage.gerrymandersByRightsZone },
    },
    legalActions: viewer.kind === 'player' ? getLegalActions(state, viewer.playerId) : [],
    pendingVoterGroups: state.pendingVoterGroups.map((group) => ({
      id: group.id,
      ownerId: group.ownerId,
      controllerId: group.controllerId,
      count: group.voterIds.length,
      sameZone: group.sameZone,
      deadlineTurnOrdinal: group.deadlineTurnOrdinal,
      ...(group.allowedZoneIds === undefined ? {} : { allowedZoneIds: [...group.allowedZoneIds] }),
    })),
    history: projectEvents(state.events, viewer),
  };
  if (state.turn.activePlayerId !== null) {
    view.activePlayerId = state.turn.activePlayerId;
  }
  if (state.pendingInteraction !== null) {
    view.pendingDecision = projectPendingDecision(state.pendingInteraction);
  }
  if (viewer.kind === 'player') {
    const player = state.players.find((candidate) => candidate.id === viewer.playerId);
    if (player !== undefined) {
      view.privateTrickIds = [...player.trickHand];
      view.privateTradeOffers = state.tradeOffers
        .filter((offer) => offer.proposerId === player.id || offer.opponentId === player.id)
        .map((offer) => ({
          id: offer.id,
          proposerId: offer.proposerId,
          opponentId: offer.opponentId,
          giveResources: { ...offer.giveResources },
          receiveResources: { ...offer.receiveResources },
          giveTrickIds: [...offer.giveTrickIds],
          receiveTrickIds: [...offer.receiveTrickIds],
        }));
      view.privateDebts = player.debts.map((debt) => ({ ...debt }));
      view.privateObligations = player.obligations.map((obligation) => ({
        id: obligation.id,
        kind: obligation.kind,
        sourceCardId: obligation.sourceCardId,
      }));
      view.privateEvictedVoters = state.voters.flatMap((voter) =>
        voter.ownerId === player.id && voter.location.kind === 'evicted'
          ? [{ id: voter.id, availableOnTurnOrdinal: voter.location.availableOnTurnOrdinal }]
          : []);
      view.privatePolicyCards = player.retainedPolicy.map((card) => ({
        cardId: card.cardId,
        answerIndex: card.answerIndex,
        archetype: card.archetype,
      }));
      view.privateVoterSupply = state.voters.filter(
        (voter) => voter.ownerId === player.id && voter.location.kind === 'supply',
      ).length;
      view.privateHeldVoters = projectHeldVoters(state, player.id);
    }
  }

  const interaction = state.pendingInteraction;
  if (interaction?.kind === 'firstPlayerVote'
      && viewer.kind === 'player'
      && interaction.ballots[viewer.playerId] === undefined) {
    view.prompt = {
      kind: 'firstPlayerVote',
      interactionId: interaction.id,
      remainingPlayerIds: interaction.responsiblePlayerIds.filter((playerId) => interaction.ballots[playerId] === undefined),
    };
  } else if (interaction?.kind === 'startingResources'
      && viewer.kind === 'player'
      && interaction.remainingPlayerIds.includes(viewer.playerId)) {
    view.prompt = {
      kind: 'startingResources',
      interactionId: interaction.id,
      remainingPlayerIds: [...interaction.remainingPlayerIds],
    };
  } else if (interaction?.kind === 'policyAnswer'
      && viewer.kind === 'player'
      && interaction.playerId === viewer.playerId) {
    const card = content.policyCards.find((candidate) => candidate.id === interaction.cardId);
    if (card === undefined) {
      throw new Error(`Interaction references unknown policy card ${interaction.cardId}`);
    }
    view.prompt = {
      kind: 'policyAnswer',
      interactionId: interaction.id,
      question: card.question,
      answers: [{ text: card.answers[0].text }, { text: card.answers[1].text }],
    };
  } else if (interaction?.kind === 'capDiscard'
      && viewer.kind === 'player'
      && interaction.playerId === viewer.playerId) {
    view.prompt = {
      kind: 'capDiscard',
      interactionId: interaction.id,
      excess: interaction.excess,
    };
  } else if (interaction?.kind === 'majoritySelection'
      && viewer.kind === 'player'
      && interaction.playerId === viewer.playerId) {
    view.prompt = {
      kind: 'majoritySelection',
      interactionId: interaction.id,
      zoneId: interaction.zoneId,
      required: interaction.required,
      eligibleVoterIds: [...interaction.eligibleVoterIds],
    };
  } else if (interaction?.kind === 'choice'
      && viewer.kind === 'player'
      && interaction.responsiblePlayerIds.includes(viewer.playerId)) {
    view.prompt = {
      kind: 'choice',
      interactionId: interaction.id,
      explanation: interaction.explanation,
      allowed: [...interaction.allowed],
      allowPass: interaction.allowPass,
      ...(interaction.sourceCardId === undefined ? {} : { sourceCardId: interaction.sourceCardId }),
      context: projectChoiceContext(state, interaction, viewer.playerId, content),
    };
  }

  if (state.endgame.reason !== undefined) {
    view.endReason = state.endgame.reason;
  }
  if (state.endgame.finalScores !== undefined) {
    view.finalScores = { ...state.endgame.finalScores };
  }
  if (state.endgame.winners !== undefined) {
    view.winners = [...state.endgame.winners];
  }
  return view;
}

export function getLegalActions(state: GameState, actorId: PlayerId): string[] {
  if (!state.players.some((player) => player.id === actorId)) {
    return [];
  }
  const tradeActions = state.tradeOffers.some(
    (offer) => offer.proposerId === actorId || offer.opponentId === actorId,
  ) ? ['AcceptTrade', 'RejectTrade', 'CancelTrade'] : [];
  if (state.pendingInteraction?.kind === 'firstPlayerVote'
      && state.pendingInteraction.ballots[actorId] === undefined) {
    return ['VoteForFirstPlayer'];
  }
  if (state.pendingInteraction?.kind === 'startingResources'
      && state.pendingInteraction.remainingPlayerIds.includes(actorId)) {
    return ['ChooseStartingResources'];
  }
  if (state.pendingInteraction?.kind === 'policyAnswer') {
    const policyActions = state.pendingInteraction.playerId === actorId
      ? ['CommitPolicyAnswer', 'RedrawPolicy', 'ProposeTrade', 'PlayTrick']
      : [];
    return [...policyActions, ...tradeActions];
  }
  if (state.pendingInteraction?.kind === 'capDiscard') {
    return state.pendingInteraction.playerId === actorId ? ['DiscardExcessResources'] : [];
  }
  if (state.pendingInteraction?.kind === 'majoritySelection') {
    return state.pendingInteraction.playerId === actorId ? ['SubmitChoice'] : [];
  }
  if (state.pendingInteraction?.kind === 'choice') {
    if (!state.pendingInteraction.responsiblePlayerIds.includes(actorId)) {
      return [];
    }
    const op = state.pendingInteraction.continuation.op;
    if (op === 'campaignVote') {
      return ['SubmitVote'];
    }
    if (op === 'auction') {
      return ['PlaceBid', 'PassAuction'];
    }
    if (op === 'trickPriority') {
      return ['PlayReaction', 'PassPriority'];
    }
    return ['SubmitChoice'];
  }
  if (state.pendingInteraction !== null) {
    return [];
  }
  if (state.turn.activePlayerId !== actorId) {
    return tradeActions;
  }
  // `beforeAnswer` is deliberately absent. It is never a resting phase: `advanceTurn` sets
  // it and `openPolicyPrompt` is always the next statement, which moves it to
  // `policyAnswer` or straight to `action`. The row that used to be here listed four
  // commands and every one of them disagreed with its own handler — `applyTradeCommand`
  // takes a trade only in `policyAnswer` or `action`, `applyPlayTrick` only in
  // those same two windows, and the two policy commands need an open `policyAnswer`
  // interaction, which the branch above answers for. Unreachable rather than wrong, but a
  // table that contradicts the handlers is a trap for whoever reads it next.
  const byPhase: Partial<Record<GameState['turn']['phase'], string[]>> = {
    action: [
      'InfluenceVoterCard',
      'Gerrymander',
      'BuyTrick',
      'BuyHeldVoter',
      'StealBase',
      'PayDebt',
      'PayObligation',
      'ReassignJumla',
      'AcquireJumla',
      'PlayTrick',
      'ProposeTrade',
      'RequestEndTurn',
    ],
  };
  return [...(byPhase[state.turn.phase] ?? []), ...tradeActions];
}
