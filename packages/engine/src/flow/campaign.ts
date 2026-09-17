import { type ChoiceSelection, type GameCommand } from '@gerrymander/protocol';
import type { GameContent } from '../content.js';
import type { AuthenticatedActor, CommandResult } from '../model/result.js';
import {
  resourceEntries,
  resourceTotal,
  type CardId,
  type ChoiceInteraction,
  type GameState,
  type PlayerId,
} from '../model/state.js';
import { currentResourceCap, checkCap } from './turn.js';
import { commandFailure, commandSuccess, createPublicEvent } from './commandResult.js';
import { completeInteraction, interruptWith } from './interactions.js';
import { grantFromReserve } from '../rules/resources.js';

function continuationString(interaction: ChoiceInteraction, key: string): string | undefined {
  const value = interaction.continuation[key];
  return typeof value === 'string' ? value : undefined;
}

function continuationNumber(interaction: ChoiceInteraction, key: string): number | undefined {
  const value = interaction.continuation[key];
  return typeof value === 'number' ? value : undefined;
}

function continuationStrings(interaction: ChoiceInteraction, key: string): readonly string[] {
  const value = interaction.continuation[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export function openChoice(
  state: GameState,
  responsiblePlayerIds: PlayerId[],
  explanation: string,
  allowed: readonly ChoiceSelection['kind'][],
  allowPass: boolean,
  sourceCardId: CardId | undefined,
  continuation: ChoiceInteraction['continuation'],
): void {
  const interaction: ChoiceInteraction = {
    id: `interaction-${state.nextSequence}`,
    kind: 'choice',
    responsiblePlayerIds,
    explanation,
    allowed,
    allowPass,
    continuation,
  };
  if (sourceCardId !== undefined) {
    interaction.sourceCardId = sourceCardId;
  }
  state.nextSequence += 1;
  interruptWith(state, interaction);
}

export function startVote(
  state: GameState,
  sourceCardId: CardId,
  prizeCardId: CardId,
  voterIds: PlayerId[],
  candidateIds: PlayerId[],
): void {
  openChoice(
    state,
    voterIds,
    'Vote for a player to receive the revealed trick. You cannot vote for yourself.',
    ['option'],
    false,
    sourceCardId,
    {
      op: 'campaignVote',
      prizeCardId,
      voterIds,
      candidateIds,
      ballots: [],
      round: 1,
    },
  );
}

export function startAuction(
  state: GameState,
  sourceCardId: CardId,
  sellerId: PlayerId,
  cardId: CardId,
  minimumBid: number,
): void {
  const sellerIndex = state.turn.order.indexOf(sellerId);
  const bidders = sellerIndex < 0
    ? []
    : Array.from({ length: state.turn.order.length - 1 }, (_, offset) =>
      state.turn.order[(sellerIndex + offset + 1) % state.turn.order.length])
      .filter((playerId): playerId is PlayerId => playerId !== undefined);
  const firstBidder = bidders[0];
  if (firstBidder === undefined) {
    throw new Error('Auction has no eligible bidder.');
  }
  openChoice(
    state,
    [firstBidder],
    `Auction bidding starts at ${minimumBid} resources.`,
    ['option', 'pass'],
    true,
    sourceCardId,
    {
      op: 'auction',
      sellerId,
      cardId,
      minimumBid,
      currentBid: 0,
      currentBidderId: '',
      bidders,
      passed: [],
      cursor: 0,
    },
  );
}
function discardChoiceSource(state: GameState, interaction: ChoiceInteraction): void {
  const sourceCardId = interaction.sourceCardId;
  if (sourceCardId !== undefined && !state.newsDeck.discardPile.includes(sourceCardId)) {
    state.newsDeck.discardPile.push(sourceCardId);
  }
}

function settleAuction(
  state: GameState,
  interaction: ChoiceInteraction,
  winnerId: PlayerId | undefined,
  bid: number,
  content: GameContent,
): CommandResult {
  const sellerId = continuationString(interaction, 'sellerId');
  const cardId = continuationString(interaction, 'cardId');
  const minimumBid = continuationNumber(interaction, 'minimumBid');
  if (sellerId === undefined || cardId === undefined || minimumBid === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Auction continuation is incomplete.');
  }
  const next = structuredClone(state);
  const seller = next.players.find((player) => player.id === sellerId);
  if (seller === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Auction seller is missing.');
  }
  completeInteraction(next);
  discardChoiceSource(next, interaction);
  if (winnerId === undefined) {
    next.trickDeck.discardPile.push(cardId);
    grantFromReserve(next, seller, { cash: minimumBid, influence: 0, press: 0, faith: 0 });
    checkCap(next, seller, 'continueEffect');
    return commandSuccess(
      state,
      next,
      [createPublicEvent(next, 'AuctionUnbid', `No player bid; ${seller.displayName} received ${minimumBid} resources.`, seller.id)],
      content,
    );
  }
  const winner = next.players.find((player) => player.id === winnerId);
  if (winner === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Auction winner is missing.');
  }
  winner.trickHand.push(cardId);
  winner.debts.push({
    id: `debt-${next.nextSequence}`,
    creditorPlayerId: seller.id,
    amount: bid,
    reason: `Auction for ${cardId}`,
  });
  next.nextSequence += 1;
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'AuctionWon', `${winner.displayName} won the auction for ${bid} resources.`, winner.id)],
    content,
  );
}

function nextAuctionBidder(
  bidders: readonly string[],
  passed: ReadonlySet<string>,
  leaderId: string | undefined,
  afterIndex: number,
): { playerId: string; cursor: number } | undefined {
  for (let offset = 1; offset <= bidders.length; offset += 1) {
    const cursor = (afterIndex + offset) % bidders.length;
    const playerId = bidders[cursor];
    if (playerId !== undefined && playerId !== leaderId && !passed.has(playerId)) {
      return { playerId, cursor };
    }
  }
  return undefined;
}

function applyAuctionCommand(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PlaceBid' | 'PassAuction' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'choice'
      || continuationString(interaction, 'op') !== 'auction'
      || interaction.id !== command.interactionId
      || !interaction.responsiblePlayerIds.includes(actor.playerId)) {
    return commandFailure(state, 'MANDATORY_CHOICE_PENDING', 'This player does not hold auction priority.');
  }
  const bidders = continuationStrings(interaction, 'bidders');
  const passed = new Set(continuationStrings(interaction, 'passed'));
  const currentBid = continuationNumber(interaction, 'currentBid') ?? 0;
  const minimumBid = continuationNumber(interaction, 'minimumBid') ?? 0;
  const leader = continuationString(interaction, 'currentBidderId') || undefined;
  const cursor = continuationNumber(interaction, 'cursor') ?? 0;
  if (command.type === 'PlaceBid') {
    const bidder = state.players.find((player) => player.id === actor.playerId);
    if (bidder === undefined || command.amount < Math.max(minimumBid, currentBid + 1)
        || command.amount > currentResourceCap(state, bidder.id)) {
      return commandFailure(state, 'INVALID_TARGET_SET', 'Bid must increase the auction and cannot exceed the bidder’s cap.');
    }
    const nextBidder = nextAuctionBidder(bidders, passed, bidder.id, cursor);
    if (nextBidder === undefined) {
      return settleAuction(state, interaction, bidder.id, command.amount, content);
    }
    const next = structuredClone(state);
    const nextInteraction = next.pendingInteraction;
    if (nextInteraction?.kind !== 'choice') {
      throw new Error('Validated auction disappeared during clone');
    }
    nextInteraction.responsiblePlayerIds = [nextBidder.playerId];
    nextInteraction.continuation = {
      ...nextInteraction.continuation,
      currentBid: command.amount,
      currentBidderId: bidder.id,
      cursor: nextBidder.cursor,
    };
    return commandSuccess(
      state,
      next,
      [createPublicEvent(next, 'AuctionBidPlaced', `${bidder.displayName} bid ${command.amount}.`, bidder.id)],
      content,
    );
  }

  passed.add(actor.playerId);
  const nextBidder = nextAuctionBidder(bidders, passed, leader, cursor);
  if (nextBidder === undefined) {
    return settleAuction(state, interaction, leader, currentBid, content);
  }
  const next = structuredClone(state);
  const nextInteraction = next.pendingInteraction;
  if (nextInteraction?.kind !== 'choice') {
    throw new Error('Validated auction disappeared during clone');
  }
  nextInteraction.responsiblePlayerIds = [nextBidder.playerId];
  nextInteraction.continuation = {
    ...nextInteraction.continuation,
    passed: [...passed],
    cursor: nextBidder.cursor,
  };
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'AuctionPassed', `${actor.playerId} passed the auction.`, actor.playerId)],
    content,
  );
}

function applyVote(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'SubmitVote' }>,
  content: GameContent,
): CommandResult {
  const interaction = state.pendingInteraction;
  if (interaction?.kind !== 'choice'
      || continuationString(interaction, 'op') !== 'campaignVote'
      || interaction.id !== command.interactionId
      || !interaction.responsiblePlayerIds.includes(actor.playerId)) {
    return commandFailure(state, 'MANDATORY_CHOICE_PENDING', 'This player does not have a campaign vote pending.');
  }
  const candidates = continuationStrings(interaction, 'candidateIds');
  if (!candidates.includes(command.optionId) || command.optionId === actor.playerId) {
    return commandFailure(state, 'INVALID_TARGET_SET', 'Vote for another eligible player.');
  }
  const ballots = [...continuationStrings(interaction, 'ballots'), `${actor.playerId}=${command.optionId}`];
  const voterIds = continuationStrings(interaction, 'voterIds');
  const voted = new Set(ballots.map((ballot) => ballot.slice(0, ballot.indexOf('='))));
  if (voted.size < voterIds.length) {
    const next = structuredClone(state);
    const nextInteraction = next.pendingInteraction;
    if (nextInteraction?.kind !== 'choice') {
      throw new Error('Validated campaign vote disappeared during clone');
    }
    nextInteraction.responsiblePlayerIds = voterIds.filter((playerId) => !voted.has(playerId));
    nextInteraction.continuation = { ...nextInteraction.continuation, ballots };
    return commandSuccess(state, next, [createPublicEvent(next, 'VoteSubmitted', `${actor.playerId} voted.`, actor.playerId)], content);
  }
  const counts = new Map<string, number>();
  for (const ballot of ballots) {
    const candidateId = ballot.slice(ballot.indexOf('=') + 1);
    counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
  }
  const highest = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === highest).map(([playerId]) => playerId);
  const next = structuredClone(state);
  const nextInteraction = next.pendingInteraction;
  if (nextInteraction?.kind !== 'choice') {
    throw new Error('Validated campaign vote disappeared during clone');
  }
  if (leaders.length !== 1) {
    nextInteraction.responsiblePlayerIds = [...voterIds];
    nextInteraction.continuation = {
      ...nextInteraction.continuation,
      ballots: [],
      round: (continuationNumber(interaction, 'round') ?? 1) + 1,
    };
    return commandSuccess(state, next, [createPublicEvent(next, 'VoteTied', 'The campaign vote tied and restarted.')], content);
  }
  const winner = next.players.find((player) => player.id === leaders[0]);
  const prizeCardId = continuationString(interaction, 'prizeCardId');
  if (winner === undefined || prizeCardId === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Campaign vote winner or prize is missing.');
  }
  winner.trickHand.push(prizeCardId);
  completeInteraction(next);
  discardChoiceSource(next, interaction);
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'VoteResolved', `${winner.displayName} received the voted trick.`, winner.id)],
    content,
  );
}

function applyDebtPayment(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'PayDebt' }>,
  content: GameContent,
): CommandResult {
  const player = state.players.find((candidate) => candidate.id === actor.playerId);
  const debt = player?.debts.find((candidate) => candidate.id === command.debtId);
  const amount = resourceTotal(command.payment);
  if (player === undefined || debt === undefined || amount < 1 || amount > debt.amount
      || resourceEntries(command.payment).some(([resource, paid]) => paid > player.resources[resource])) {
    return commandFailure(state, 'INSUFFICIENT_RESOURCES', 'Debt payment must be held and cannot exceed the outstanding amount.');
  }
  const next = structuredClone(state);
  const nextPlayer = next.players.find((candidate) => candidate.id === player.id);
  const creditor = next.players.find((candidate) => candidate.id === debt.creditorPlayerId);
  const nextDebt = nextPlayer?.debts.find((candidate) => candidate.id === debt.id);
  if (nextPlayer === undefined || creditor === undefined || nextDebt === undefined) {
    return commandFailure(state, 'INVARIANT_VIOLATION', 'Debt participants disappeared.');
  }
  for (const [resource, paid] of resourceEntries(command.payment)) {
    nextPlayer.resources[resource] -= paid;
    creditor.resources[resource] += paid;
  }
  nextDebt.amount -= amount;
  if (nextDebt.amount === 0) {
    nextPlayer.debts = nextPlayer.debts.filter((candidate) => candidate.id !== nextDebt.id);
  }
  checkCap(next, creditor, 'continueEffect');
  return commandSuccess(
    state,
    next,
    [createPublicEvent(next, 'DebtPaid', `${nextPlayer.displayName} paid ${amount} auction debt.`, nextPlayer.id)],
    content,
  );
}

export function applyCampaignCommand(
  state: GameState,
  actor: AuthenticatedActor,
  command: Extract<GameCommand, { type: 'SubmitVote' | 'PlaceBid' | 'PassAuction' | 'PayDebt' }>,
  content: GameContent,
): CommandResult {
  switch (command.type) {
    case 'SubmitVote':
      return applyVote(state, actor, command, content);
    case 'PlaceBid':
    case 'PassAuction':
      return applyAuctionCommand(state, actor, command, content);
    case 'PayDebt':
      return applyDebtPayment(state, actor, command, content);
  }
}
