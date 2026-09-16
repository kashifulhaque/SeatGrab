import {
  ARCHETYPES,
  RESOURCE_TYPES,
  type BoardZoneId,
  type EffectCard,
  type Archetype,
} from '@seatgrab/content';
import type { ChoicePromptOp, ChoiceSelection } from '@seatgrab/protocol';
import type { GameContent } from '../content.js';
import {
  resourceEntries,
  resourceTotal,
  type ActiveEffect,
  type ChoiceInteraction,
  type DeckState,
  type GameState,
  type NewsTrigger,
  type PlayerId,
  type VoterState,
} from '../model/state.js';
import { getZoneSnapshot } from '../rules/board.js';
import { consumeEffectUse, isProtectedFromOpponent, placementBlocked } from '../rules/effectModifiers.js';
import { reconcileMajorities } from '../rules/majorities.js';
import { archetypeCount, nextTurnOrdinalForPlayer } from '../rules/powers.js';
import { grantFromReserve } from '../rules/resources.js';
import { shuffle } from '../random/prng.js';
import { completeInteraction } from './interactions.js';
import { openChoice, startAuction, startVote } from './campaign.js';
import { checkCap } from './turn.js';

export const SUPPORTED_EFFECT_HANDLERS = [
  'trick.skimming',
  'trick.turncoat',
  'trick.veto',
  'trick.boomerang',
  'trick.grandCoalition',
  'trick.flipFlop',
  'trick.longMarch',
  'trick.loyalBase',
  'trick.redevelopment',
  'trick.blacklist',
  'trick.dragnet',
  'trick.rollPurge',
  'trick.scorchedEarth',
  'trick.starPower',
  'trick.musicalChairs',
  'trick.cornerstone',
  'news.brainDrain',
  'news.guestEditor',
  'news.standoff',
  'news.ransomNote',
  'news.retraction',
  'news.dynasty',
  'news.leakedTapes',
  'news.backroomDeal',
  'news.floodRelief',
  'news.quarantine',
  'news.reliefFund',
  'news.tabloidScandal',
  'news.anonymousTip',
  'news.turfWar',
  'news.taxAudit',
  'news.dataBroker',
  'news.echoChamber',
  'news.hydra',
  'news.disqualified',
  'news.supplyShortage',
] as const;

const REVERSIBLE_TRICK_HANDLERS: Readonly<Record<string, true>> = {
  'trick.skimming': true,
  'trick.longMarch': true,
  'trick.blacklist': true,
  'trick.dragnet': true,
  'trick.rollPurge': true,
};

export function isReversibleTrick(card: EffectCard): boolean {
  return REVERSIBLE_TRICK_HANDLERS[card.handlerId] === true;
}

export type SupportedEffectHandler = (typeof SUPPORTED_EFFECT_HANDLERS)[number];

export interface EffectContext {
  ownerId: PlayerId;
  card: EffectCard;
  trigger?: NewsTrigger;
  mode?: string;
  reversedFromPlayerId?: PlayerId;
}

function addEffect(
  state: GameState,
  context: EffectContext,
  kind: string,
  data: ActiveEffect['data'] = {},
  targetPlayerIds: PlayerId[] = [],
  targetZoneIds: BoardZoneId[] = [],
  remainingUses?: number,
  expiresAfterPlayerTurn?: ActiveEffect['expiresAfterPlayerTurn'],
): ActiveEffect {
  const effect: ActiveEffect = {
    id: `effect-${state.nextSequence}`,
    sourceCardId: context.card.id,
    ownerId: context.ownerId,
    kind,
    targetPlayerIds,
    targetZoneIds,
    data,
  };
  if (remainingUses !== undefined) {
    effect.remainingUses = remainingUses;
  }
  if (expiresAfterPlayerTurn !== undefined) {
    effect.expiresAfterPlayerTurn = expiresAfterPlayerTurn;
  }
  state.nextSequence += 1;
  state.activeEffects.push(effect);
  return effect;
}
function turnOrderFrom(state: GameState, playerId: PlayerId, includePlayer: boolean): PlayerId[] {
  const start = state.turn.order.indexOf(playerId);
  if (start < 0) {
    return [];
  }
  const offset = includePlayer ? 0 : 1;
  const length = state.turn.order.length - offset;
  return Array.from({ length }, (_, index) =>
    state.turn.order[(start + index + offset) % state.turn.order.length])
    .filter((id): id is PlayerId => id !== undefined);
}

/* ------------------------------------------------- counting before opening (A18)
 *
 * Everything in this block answers one question: is there an answer? House rule R16 makes a fixed
 * quantity mandatory, and A18 says a card that cannot reach it resolves as no effect
 * rather than opening an interaction nobody can satisfy — because a pending interaction
 * blocks every command, so an unanswerable one ends the match instead of slowing it.
 *
 * Each helper mirrors the validation its own resolution branch performs. The resolution
 * remains the authority: a helper that is wrong the strict way swallows a live card, and
 * one that is wrong the loose way deadlocks the match, so both halves are tested.
 */

/** Total resources left in the bank, which every grant is drawn from. */
function reserveTotal(state: GameState): number {
  return resourceTotal(state.publicReserve);
}

/** Voters `ownerId` still has off the board, which every free placement needs. */
function supplyCount(state: GameState, ownerId: PlayerId): number {
  return state.voters.filter(
    (voter) => voter.ownerId === ownerId && voter.location.kind === 'supply',
  ).length;
}

/**
 * Board voters `actorId` may touch, before any card-specific narrowing.
 *
 * Volatile areas are immune and a Loyal Base zone is closed to everyone but
 * the seat that played it — including, deliberately, a voter's own owner, which is how
 * `removeBoardVoter` and `convertVoters` both read it.
 */
function reachableBoardVoters(
  state: GameState,
  content: GameContent,
  actorId: PlayerId,
): VoterState[] {
  return state.voters.filter((voter) =>
    voter.location.kind === 'board'
    && slotDefinition(state, content, voter)?.volatile === false
    && !isProtectedFromOpponent(state, content, voter, actorId));
}

/** True for a board voter that is not marked as part of a majority. */
function isUnmarked(voter: VoterState): boolean {
  return voter.location.kind === 'board' && !voter.location.majority;
}

/**
 * Voters Ransom Note can take hostage.
 *
 * The card holds the owner's own voters, but protection still applies: the rule
 * `removeBoardVoter` enforces closes a Cult-protected zone to every seat except the one
 * that played the card, and this has to agree with it or the card opens a question its
 * own resolution refuses.
 */
function heldableVoterCount(state: GameState, content: GameContent, ownerId: PlayerId): number {
  return reachableBoardVoters(state, content, ownerId)
    .filter((voter) => voter.ownerId === ownerId).length;
}

/**
 * True when Long March has five voters it could evict, matching `bharatVoters`.
 *
 * That branch asks only for five distinct, non-volatile board voters — it checks neither
 * majority marking nor protection — and the reversed form narrows them to the seat that
 * played the card. The eviction fires at the owner's end turn, so this is checked there:
 * an unanswerable prompt would refuse `RequestEndTurn` and end the match.
 */
export function canRunBharatEvictions(
  state: GameState,
  content: GameContent,
  reversedFromPlayerId: PlayerId | undefined,
): boolean {
  return state.voters.filter((voter) =>
    voter.location.kind === 'board'
    && slotDefinition(state, content, voter)?.volatile === false
    && (reversedFromPlayerId === undefined || voter.ownerId === reversedFromPlayerId)).length >= 5;
}

/**
 * True when `playerId` has a voter Cough & Cold can make them evict.
 *
 * Every seat in the queue evicts one of its own, so the eviction is checked against that
 * seat — not against the seat whose voter triggered the news. Checking it against the
 * wrong seat is how a Cult-protected zone could put an opponent in the queue and then
 * refuse everything they offered.
 */
function canEvictOwnVoter(state: GameState, content: GameContent, playerId: PlayerId): boolean {
  return reachableBoardVoters(state, content, playerId)
    .some((voter) => voter.ownerId === playerId);
}

/**
 * Voters Dragnet can imprison, matching the `imprisonVoters` branch.
 *
 * The card takes five, from anybody, and its reversed form may only take them from the
 * seat that played it.
 */
function imprisonableVoters(
  state: GameState,
  content: GameContent,
  ownerId: PlayerId,
  reversedFromPlayerId: PlayerId | undefined,
): VoterState[] {
  return reachableBoardVoters(state, content, ownerId).filter((voter) =>
    isUnmarked(voter)
    && (reversedFromPlayerId === undefined || voter.ownerId === reversedFromPlayerId));
}

/**
 * Voters Roll Purge can remove, matching the `documentsVoters` branch.
 *
 * The card takes one voter per zone where its owner holds redistricting rights, so a
 * seat holding no rights has nothing to choose even with a full board.
 */
function documentableVoters(
  state: GameState,
  content: GameContent,
  ownerId: PlayerId,
  reversedFromPlayerId: PlayerId | undefined,
): VoterState[] {
  const rightsZoneIds = new Set(
    content.board.zones
      .filter((zone) => getZoneSnapshot(state, content, zone.id).rightsOwnerId === ownerId)
      .map((zone) => zone.id as string),
  );
  return reachableBoardVoters(state, content, ownerId).filter((voter) => {
    const zoneId = slotDefinition(state, content, voter)?.zoneId;
    return zoneId !== undefined && rightsZoneIds.has(zoneId)
      && (reversedFromPlayerId === undefined || voter.ownerId === reversedFromPlayerId);
  });
}

/**
 * Voters Musical Chairs can swap, matching the `slumdogSwap` branch.
 *
 * That branch checks only non-majority and non-volatile — it never asks about protection
 * — so this does not either, and a swap is a pair, so two is the floor.
 */
function swappableVoters(state: GameState, content: GameContent): VoterState[] {
  return state.voters.filter((voter) =>
    voter.location.kind === 'board'
    && isUnmarked(voter)
    && slotDefinition(state, content, voter)?.volatile === false);
}

/**
 * True when some 6/11 zone can be converted whole, matching the `cornerstoneZone` branch.
 *
 * `convertVoters` needs one supply voter per opponent voter it replaces and refuses a
 * protected target outright, so a zone is only an answer if this seat can pay for all of
 * it. An already-uncontested zone is a legal answer that converts nothing.
 */
function canConvertSomeElevenZone(
  state: GameState,
  content: GameContent,
  ownerId: PlayerId,
): boolean {
  const supply = supplyCount(state, ownerId);
  return content.board.zones.filter((zone) => zone.capacity === 11).some((zone) => {
    const opponents = state.voters.filter((voter) => {
      const slot = slotDefinition(state, content, voter);
      return voter.location.kind === 'board'
        && slot?.zoneId === zone.id
        && slot.volatile === false
        && voter.ownerId !== ownerId;
    });
    return opponents.length <= supply
      && !opponents.some((voter) => isProtectedFromOpponent(state, content, voter, ownerId));
  });
}

/**
 * Move `deck`'s eligible discards back under the draw pile when it cannot serve `needed`.
 *
 * A06 allows exactly this and nothing more: only discards of that deck, never a retained
 * or an active card. It answers with what the draw pile holds afterwards, which may still
 * be short — an exhausted family is a real state, and the caller decides what that means
 * for its own card.
 */
function recycleDrawPile(state: GameState, deck: DeckState, needed: number): number {
  if (deck.drawPile.length < needed && deck.discardPile.length > 0) {
    const recycled = shuffle(deck.discardPile.splice(0), state.random);
    deck.drawPile = [...deck.drawPile, ...recycled.items];
    state.random = recycled.state;
  }
  return deck.drawPile.length;
}

/**
 * True when `actorId` could convert two of the voters belonging to the seat on their left.
 *
 * This mirrors the checks in `convertVoters`, which remains the authority: this decides
 * only whether the question is worth asking, and a wrong answer here produces a refused
 * selection rather than an illegal conversion. It is used to filter the Stay In Your
 * Limits queue, so a seat is asked only when it has an answer.
 */
function canConvertTwoFromLeft(
  state: GameState,
  content: GameContent,
  actorId: PlayerId,
): boolean {
  const order = state.turn.order;
  const index = order.indexOf(actorId);
  if (index < 0) {
    return false;
  }
  const leftId = order[(index + 1) % order.length];
  if (leftId === undefined || leftId === actorId) {
    return false;
  }
  const supply = state.voters.filter(
    (voter) => voter.ownerId === actorId && voter.location.kind === 'supply',
  ).length;
  if (supply < 2) {
    return false;
  }
  return state.voters.filter((voter) =>
    voter.ownerId === leftId
    && voter.location.kind === 'board'
    && slotDefinition(state, content, voter)?.volatile === false
    && !isProtectedFromOpponent(state, content, voter, actorId)).length >= 2;
}

/**
 * True when Standoff has three voters to move and somewhere to move them.
 *
 * The card offers two modes — three moves that stay in the trigger zone, or three that
 * leave it — so it is satisfiable if either mode has three free areas to land in. A
 * volatile area is not a legal source, which is what keeps the card from feeding itself.
 */
function canRunNerosGuests(
  state: GameState,
  content: GameContent,
  zoneId: string,
  actorId: PlayerId,
): boolean {
  // Counted through `reachableBoardVoters` rather than off the slot table, because
  // `moveVoter` refuses a Cult-protected voter and a zone whose occupants are all
  // protected from this seat has no legal source at all.
  const occupiedInZone = reachableBoardVoters(state, content, actorId)
    .filter((voter) => slotDefinition(state, content, voter)?.zoneId === zoneId).length;
  if (occupiedInZone < 3) {
    return false;
  }
  const empty = (inZone: boolean): number => content.board.slots.filter((slot) =>
    (slot.zoneId === zoneId) === inZone
    && state.slots.find((candidate) => candidate.slotId === slot.slotId)?.voterId == null).length;
  return empty(true) >= 3 || empty(false) >= 3;
}

function openEffectChoice(
  state: GameState,
  context: EffectContext,
  responsiblePlayerIds: PlayerId[],
  explanation: string,
  allowed: readonly ChoiceSelection['kind'][],
  allowPass: boolean,
  op: ChoicePromptOp,
  extra: Readonly<Record<string, string | number | boolean | readonly string[]>> = {},
): void {
  openChoice(state, responsiblePlayerIds, explanation, allowed, allowPass, context.card.id, {
    ...extra,
    op,
    handlerId: context.card.handlerId,
    ownerId: context.ownerId,
    deck: context.card.deck,
    ...(context.reversedFromPlayerId === undefined ? {} : {
      reversedFromPlayerId: context.reversedFromPlayerId,
    }),
    ...(context.trigger === undefined ? {} : {
      triggerSlotId: context.trigger.slotId,
      triggerVoterId: context.trigger.voterId,
    }),
  });
}

function discardSource(state: GameState, interaction: ChoiceInteraction): void {
  const sourceCardId = interaction.sourceCardId;
  const deck = interaction.continuation.deck;
  if (sourceCardId === undefined || (deck !== 'trick' && deck !== 'news')) {
    return;
  }
  const pile = deck === 'trick' ? state.trickDeck.discardPile : state.newsDeck.discardPile;
  if (!pile.includes(sourceCardId)
      && !state.activeEffects.some((effect) => effect.sourceCardId === sourceCardId)) {
    pile.push(sourceCardId);
  }
}

function stringValue(interaction: ChoiceInteraction, key: string): string | undefined {
  const value = interaction.continuation[key];
  return typeof value === 'string' ? value : undefined;
}


function stringsValue(interaction: ChoiceInteraction, key: string): readonly string[] {
  const value = interaction.continuation[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function player(state: GameState, playerId: string | undefined) {
  return state.players.find((candidate) => candidate.id === playerId);
}

function boardVoter(state: GameState, voterId: string | undefined): VoterState | undefined {
  const voter = state.voters.find((candidate) => candidate.id === voterId);
  return voter?.location.kind === 'board' ? voter : undefined;
}

function slotDefinition(_state: GameState, content: GameContent, voter: VoterState | undefined) {
  if (voter?.location.kind !== 'board') {
    return undefined;
  }
  const slotId = voter.location.slotId;
  return content.board.slots.find((slot) => slot.slotId === slotId);
}

function removeBoardVoter(
  state: GameState,
  content: GameContent,
  voterId: string,
  actorId: PlayerId,
  destination: 'supply' | 'removed',
  reason: string,
): string | null {
  const voter = boardVoter(state, voterId);
  const definition = slotDefinition(state, content, voter);
  if (voter?.location.kind !== 'board' || definition === undefined) {
    return 'Select a voter on the board.';
  }
  if (definition.volatile) {
    return 'Voters in volatile areas are immune.';
  }
  if (isProtectedFromOpponent(state, content, voter, actorId)) {
    return 'A persistent effect protects this voter from opponents.';
  }
  const slotId = voter.location.slotId;
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) {
    return 'The voter slot is missing.';
  }
  slot.voterId = null;
  voter.location = destination === 'supply' ? { kind: 'supply' } : { kind: 'removed', reason };
  return null;
}

function makePendingGroup(
  state: GameState,
  ownerId: PlayerId,
  controllerId: PlayerId,
  count: number,
  sourceCardId: string,
  sameZone: boolean,
): string | null {
  const voters = state.voters
    .filter((voter) => voter.ownerId === ownerId && voter.location.kind === 'supply')
    .slice(0, count);
  if (voters.length !== count) {
    return `${ownerId} does not have ${count} voters in supply.`;
  }
  const groupId = `effect-group-${state.nextSequence}`;
  state.nextSequence += 1;
  for (const voter of voters) {
    voter.location = { kind: 'pending', groupId };
  }
  state.pendingVoterGroups.push({
    id: groupId,
    ownerId,
    controllerId,
    voterIds: voters.map((voter) => voter.id),
    origin: { kind: 'effect', sourceCardId },
    sameZone,
    deadlineTurnOrdinal: state.turn.ordinal,
  });
  return null;
}

function queueVolatileNews(
  state: GameState,
  content: GameContent,
  voterId: string,
  destinationSlotId: string,
  actorId: PlayerId,
): void {
  const destination = content.board.slots.find((slot) => slot.slotId === destinationSlotId);
  const voter = boardVoter(state, voterId);
  if (destination?.volatile !== true || voter === undefined) {
    return;
  }
  state.newsQueue.push({
    id: `news-trigger-${state.nextSequence}`,
    voterId: voter.id,
    slotId: destination.slotId,
    voterOwnerId: voter.ownerId,
    actorId,
    turnOrdinal: state.turn.ordinal,
  });
  state.nextSequence += 1;
}

function convertVoters(
  state: GameState,
  content: GameContent,
  newOwnerId: PlayerId,
  voterIds: readonly string[],
  requireSameOwner = false,
  requireSameZone = false,
): string | null {
  const targets = voterIds.map((voterId) => boardVoter(state, voterId));
  if (targets.some((voter) => voter === undefined)) {
    return 'Every selected voter must be on the board.';
  }
  const concrete = targets as VoterState[];
  if (concrete.some((voter) => voter.ownerId === newOwnerId)) {
    return 'Converted voters must belong to an opponent.';
  }
  if (requireSameOwner && new Set(concrete.map((voter) => voter.ownerId)).size !== 1) {
    return 'Selected voters must belong to the same opponent.';
  }
  if (concrete.some((voter) => isProtectedFromOpponent(state, content, voter, newOwnerId))) {
    return 'A persistent effect protects a selected voter from opponents.';
  }
  const definitions = concrete.map((voter) => slotDefinition(state, content, voter));
  if (definitions.some((slot) => slot === undefined || slot.volatile)) {
    return 'Voters in volatile areas cannot be converted.';
  }
  if (requireSameZone && new Set(definitions.map((slot) => slot?.zoneId)).size !== 1) {
    return 'Selected voters must occupy the same zone.';
  }
  const replacements = state.voters
    .filter((voter) => voter.ownerId === newOwnerId && voter.location.kind === 'supply')
    .slice(0, concrete.length);
  if (replacements.length !== concrete.length) {
    return 'The converting player does not have enough voters in supply.';
  }
  for (let index = 0; index < concrete.length; index += 1) {
    const target = concrete[index];
    const replacement = replacements[index];
    if (target?.location.kind !== 'board' || replacement === undefined) {
      return 'A conversion target disappeared.';
    }
    const slotId = target.location.slotId;
    const slot = state.slots.find((candidate) => candidate.slotId === slotId);
    if (slot === undefined) {
      return 'A conversion slot disappeared.';
    }
    target.location = { kind: 'supply' };
    replacement.location = { kind: 'board', slotId, majority: false };
    slot.voterId = replacement.id;
  }
  return null;
}

function moveVoter(
  state: GameState,
  content: GameContent,
  voterId: string,
  actorId: PlayerId,
  destinationSlotId: string,
  allowVolatileDestination: boolean,
): string | null {
  const voter = boardVoter(state, voterId);
  if (voter?.location.kind !== 'board') {
    return 'Select a voter on the board.';
  }
  const sourceId = voter.location.slotId;
  const source = content.board.slots.find((slot) => slot.slotId === sourceId);
  const destination = content.board.slots.find((slot) => slot.slotId === destinationSlotId);
  const sourceState = state.slots.find((slot) => slot.slotId === sourceId);
  const destinationState = state.slots.find((slot) => slot.slotId === destinationSlotId);
  if (source === undefined || destination === undefined || sourceState === undefined || destinationState?.voterId !== null) {
    return 'Select an occupied source and empty destination.';
  }
  if (isProtectedFromOpponent(state, content, voter, actorId)) {
    return 'A persistent effect protects this voter from opponents.';
  }
  if (source.volatile || (destination.volatile && !allowVolatileDestination)) {
    return 'This movement cannot use a volatile area.';
  }
  sourceState.voterId = null;
  destinationState.voterId = voter.id;
  voter.location = { kind: 'board', slotId: destinationSlotId, majority: false };
  return null;
}

function expireAfterNextTurn(state: GameState, playerId: PlayerId) {
  return { playerId, completedTurn: (state.turn.completedTurns[playerId] ?? 0) + 1 };
}


export function beginEffect(state: GameState, context: EffectContext, content: GameContent): string | null {
  const owner = player(state, context.ownerId);
  if (owner === undefined) {
    return 'Effect owner is not seated.';
  }
  switch (context.card.handlerId as SupportedEffectHandler) {
    case 'trick.skimming':
      openEffectChoice(state, context, [owner.id], 'Choose an opponent for Skimming.', ['players'], false, 'chaiOpponent');
      return null;
    case 'trick.turncoat':
      openEffectChoice(state, context, [owner.id], 'Choose the Archetype track for Turncoat.', ['option'], false, 'turncoatTrack');
      return null;
    case 'trick.veto':
      // A16 under A18: a trick is chosen, so the play is refused rather than
      // resolved away. Every guard below a played card reads this way.
      if (state.activeEffects.length === 0) {
        return 'Veto needs an open trick or news effect to discard.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose an open trick or news effect to discard.', ['cards'], false, 'blockOpen');
      return null;
    case 'trick.boomerang':
      return 'Boomerang may only be played in a reaction window.';
    case 'trick.grandCoalition':
      addEffect(state, context, 'grandCoalition', {}, [owner.id], [], undefined, expireAfterNextTurn(state, owner.id));
      return null;
    case 'trick.flipFlop':
      if (!owner.retainedPolicy.some((retained) =>
        content.policyCards.some((card) => card.id === retained.cardId))) {
        return 'Flip-Flop needs one of your own Policy Cards to flip.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose one of your Policy Cards to flip.', ['cards'], false, 'accentFlip');
      return null;
    case 'trick.longMarch':
      addEffect(state, context, 'longMarch', context.reversedFromPlayerId === undefined
        ? {}
        : { reversedFromPlayerId: context.reversedFromPlayerId }, [], [], 1);
      return null;
    case 'trick.loyalBase':
      // The same guard `applyStealCult` already applies to the stolen copy.
      if (!content.board.zones.some((zone) =>
        getZoneSnapshot(state, content, zone.id).majorityOwnerId === owner.id)) {
        return 'Loyal Base needs one of your own majorities to protect.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose one of your majority zones to protect.', ['option'], false, 'cultZone');
      return null;
    case 'trick.redevelopment':
      addEffect(state, context, 'redevelopment', {}, [owner.id], [], 2);
      return null;
    case 'trick.blacklist':
      openEffectChoice(state, context, [owner.id], 'Choose an opponent and zone, encoded as player|zone.', ['option'], false, 'notOneTarget');
      return null;
    case 'trick.dragnet':
      if (imprisonableVoters(state, content, owner.id, context.reversedFromPlayerId).length < 5) {
        return 'Dragnet needs five non-majority, non-volatile voters it can reach.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose exactly five non-majority, non-volatile voters to imprison.', ['voters'], false, 'imprisonVoters');
      return null;
    case 'trick.rollPurge':
      if (documentableVoters(state, content, owner.id, context.reversedFromPlayerId).length === 0) {
        return 'Roll Purge needs a reachable voter in a zone where you hold redistricting rights.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose up to four non-volatile voters, one in each rights zone.', ['voters'], false, 'documentsVoters');
      return null;
    case 'trick.scorchedEarth':
      addEffect(state, context, 'scorchedEarth', {}, [owner.id], [], 3);
      return null;
    case 'trick.starPower':
      addEffect(state, context, 'starPower', {}, [owner.id]);
      return null;
    case 'trick.musicalChairs':
      if (swappableVoters(state, content).length < 2) {
        return 'Musical Chairs needs two non-majority, non-volatile voters to swap.';
      }
      openEffectChoice(state, context, [owner.id], 'Choose two, four, or six non-majority voters as swap pairs.', ['voters'], false, 'slumdogSwap');
      return null;
    case 'trick.cornerstone': {
      if (context.mode === 'triple') {
        const otherPillars = owner.trickHand.filter((cardId) => {
          const card = content.trickCards.find((candidate) => candidate.id === cardId);
          return card?.handlerId === 'trick.cornerstone' && card.id !== context.card.id;
        }).slice(0, 2);
        if (otherPillars.length !== 2) {
          return 'Three Cornerstone cards are required for the conversion mode.';
        }
        // Checked before the other two cards leave the hand: a refusal after that point
        // would cost the seat two cards for nothing.
        if (!canConvertSomeElevenZone(state, content, owner.id)) {
          return 'Cornerstone x3 needs a 6/11 zone this player can convert completely.';
        }
        owner.trickHand = owner.trickHand.filter((cardId) => !otherPillars.includes(cardId));
        state.trickDeck.discardPile.push(...otherPillars);
        openEffectChoice(state, context, [owner.id], 'Choose a 6/11 zone to convert completely.', ['option'], false, 'cornerstoneZone');
      } else {
        if (reserveTotal(state) < 4) {
          return 'Cornerstone needs four resources left in the bank.';
        }
        openEffectChoice(state, context, [owner.id], 'Choose exactly four resources from the bank.', ['resources'], false, 'cornerstoneGain');
      }
      return null;
    }
    case 'news.brainDrain':
      addEffect(state, context, 'brainDrain', {}, [owner.id]);
      return null;
    case 'news.guestEditor':
      openEffectChoice(state, context, [owner.id], 'Choose an opponent who may use your rights next turn.', ['players'], false, 'dostiTarget');
      return null;
    case 'news.standoff': {
      // Three is printed, and the card cannot be declined, so the same reading applies as
      // for Ransom Note: with too few voters to move, or nowhere to move them, the
      // card resolves as no effect rather than opening an unanswerable question (A18).
      const nerosZoneId = content.board.slots
        .find((slot) => slot.slotId === context.trigger?.slotId)?.zoneId ?? '';
      if (!canRunNerosGuests(state, content, nerosZoneId, owner.id)) {
        return null;
      }
      openEffectChoice(state, context, [owner.id], 'Choose three source/destination slot pairs for this zone.', ['slots'], false, 'nerosMoves', {
        zoneId: nerosZoneId,
      });
      return null;
    }
    case 'news.ransomNote':
      // Four is a printed quantity, not a maximum, so the card is not reduced to "up to
      // four" (A16). A news cannot be declined either, so the only remaining reading
      // is the one `news.quarantine` already uses: with too few voters to take, the
      // card resolves as no effect rather than opening a question nobody can answer.
      if (heldableVoterCount(state, content, owner.id) < 4) {
        return null;
      }
      openEffectChoice(state, context, [owner.id], 'Choose four of your non-volatile board voters to hold hostage.', ['voters'], false, 'hostageVoters');
      return null;
    case 'news.retraction':
      openEffectChoice(state, context, [owner.id], 'Donate one Policy Card left, or pass.', ['cards', 'pass'], true, 'donatePolicy', {
        queue: turnOrderFrom(state, owner.id, true),
      });
      return null;
    case 'news.dynasty': {
      // A06 is the whole fix: a short draw pile reshuffles its own eligible discards, and
      // refusing instead is what stalled a match — the refusal propagates out of
      // `beginNewsResolution` and fails the command that dealt the card, every time.
      // The no-effect branch below is defensive only. Sixty voter cards reconcile to the
      // two piles, the market and any in-flight continuation, so the piles cannot both be
      // empty and the recycle always finds two (A18).
      if (recycleDrawPile(state, state.voterDeck, 2) < 2) {
        return null;
      }
      const drawn = state.voterDeck.drawPile.splice(0, 2);
      openEffectChoice(state, context, [owner.id], 'Choose one drawn Voter Card to keep.', ['cards'], false, 'blessingsKeep', { drawn });
      return null;
    }
    case 'news.leakedTapes':
      addEffect(state, context, 'leakedTapes', {}, [owner.id]);
      return null;
    case 'news.backroomDeal':
      openEffectChoice(state, context, [owner.id], 'Choose exactly two players for Backroom Deal.', ['players'], false, 'poloPlayers');
      return null;
    case 'news.floodRelief':
      openEffectChoice(state, context, turnOrderFrom(state, owner.id, true).slice(0, 1), 'Choose one source and destination slot for your immediate move.', ['slots', 'pass'], true, 'floodReliefMove', {
        queue: turnOrderFrom(state, owner.id, true),
      });
      return null;
    case 'news.quarantine': {
      const opponents = turnOrderFrom(state, owner.id, false)
        .filter((playerId) => canEvictOwnVoter(state, content, playerId));
      if (opponents.length === 0) {
        return null;
      }
      openEffectChoice(state, context, opponents.slice(0, 1), 'Evict one of your non-volatile board voters.', ['voters'], false, 'coughEvict', {
        queue: opponents,
        broken: [],
      });
      return null;
    }
    case 'news.reliefFund':
      owner.obligations.push({ id: `obligation-${state.nextSequence}`, kind: 'reliefFund', sourceCardId: context.card.id, data: {} });
      state.nextSequence += 1;
      addEffect(state, context, 'reliefFund', {}, [owner.id]);
      return null;
    case 'news.tabloidScandal':
      addEffect(state, context, 'tabloidScandal', {}, [owner.id], [], 1, {
        playerId: owner.id,
        completedTurn: (state.turn.completedTurns[owner.id] ?? 0) + 2,
      });
      return null;
    case 'news.anonymousTip': {
      if (recycleDrawPile(state, state.trickDeck, 3) < 3) {
        return null;
      }
      const drawn = state.trickDeck.drawPile.splice(0, 3);
      openEffectChoice(state, context, [owner.id], 'Secretly choose one trick to auction.', ['cards'], false, 'karachiKeep', { drawn });
      return null;
    }
    case 'news.turfWar': {
      // Only seats that can actually convert two are put in the queue, for the reason
      // above: each one is asked for an exact pair, and a seat whose left neighbour has
      // fewer than two on the board would hold the match open for good.
      const limitsQueue = turnOrderFrom(state, owner.id, true)
        .filter((playerId) => canConvertTwoFromLeft(state, content, playerId));
      if (limitsQueue.length === 0) {
        return null;
      }
      openEffectChoice(state, context, limitsQueue.slice(0, 1), 'Convert exactly two voters belonging to the player on your left.', ['voters'], false, 'limitsConvert', {
        queue: limitsQueue,
      });
      return null;
    }
    case 'news.taxAudit':
      addEffect(state, context, 'taxAudit', {}, [owner.id], [], 1);
      return null;
    case 'news.dataBroker': {
      if (recycleDrawPile(state, state.trickDeck, 1) < 1) {
        return null;
      }
      const prizeCardId = state.trickDeck.drawPile.shift();
      if (prizeCardId === undefined) {
        return null;
      }
      startVote(state, context.card.id, prizeCardId, [...state.turn.order], [...state.turn.order]);
      return null;
    }
    case 'news.echoChamber':
      openEffectChoice(state, context, [owner.id], 'Choose an opponent to copy your next-turn resource income.', ['players'], false, 'mansplainTarget');
      return null;
    case 'news.hydra':
      addEffect(state, context, 'hydra', {}, [owner.id], [], undefined, {
        playerId: owner.id,
        completedTurn: (state.turn.completedTurns[owner.id] ?? 0) + 2,
      });
      return null;
    case 'news.disqualified': {
      // Nothing open to discard is nothing to do. The market is topped up first, because
      // the effect suspends the ordinary refill for as long as it is active.
      while (state.voterDeck.market.length < 3) {
        if (recycleDrawPile(state, state.voterDeck, 1) < 1) break;
        const refill = state.voterDeck.drawPile.shift();
        if (refill === undefined) break;
        state.voterDeck.market.push(refill);
      }
      if (state.voterDeck.market.length === 0) {
        return null;
      }
      const ownerIndex = state.turn.order.indexOf(owner.id);
      const queue = Array.from({ length: Math.min(3, state.turn.order.length) }, (_, offset) =>
        state.turn.order[(ownerIndex + offset + 1) % state.turn.order.length])
        .filter((playerId): playerId is PlayerId => playerId !== undefined);
      addEffect(state, context, 'disqualified', { queue }, [owner.id], [], 3);
      openEffectChoice(state, context, queue.slice(0, 1), 'Choose an open voter card to discard.', ['cards'], false, 'goalparaCard', { queue });
      return null;
    }
    case 'news.supplyShortage': {
      const start = (state.turn.order.indexOf(owner.id) + 1) % state.turn.order.length;
      const queue = Array.from({ length: state.turn.order.length }, (_, offset) =>
        state.turn.order[(start + offset) % state.turn.order.length]).filter((id): id is string => id !== undefined);
      openEffectChoice(state, context, queue.slice(0, 1), 'Discard one of your voters, or choose an opponent to gain a voter.', ['voters', 'players'], false, 'oxyChoice', { queue });
      return null;
    }
  }
  return `Unsupported effect handler ${context.card.handlerId}.`;
}

function continueQueue(
  state: GameState,
  interaction: ChoiceInteraction,
  queue: readonly string[],
  explanation: string,
  allowed: readonly ChoiceSelection['kind'][],
  allowPass: boolean,
  continuation: ChoiceInteraction['continuation'],
): void {
  const nextPlayerId = queue[0];
  if (nextPlayerId === undefined) {
    completeInteraction(state);
    discardSource(state, interaction);
    return;
  }
  const current = state.pendingInteraction;
  if (current?.kind !== 'choice') {
    throw new Error('Queued effect interaction disappeared.');
  }
  current.responsiblePlayerIds = [nextPlayerId];
  current.explanation = explanation;
  current.allowed = allowed;
  current.allowPass = allowPass;
  current.continuation = continuation;
}

/**
 * The Trip To Goalpara queue after one seat has discarded, and the market it reads.
 *
 * Every seat in the queue picks from the *same* three open cards, which is why the market
 * is refilled only once the queue empties — refilling between seats would hand the second
 * one a fresh choice. The truncation is the A18 half: a seat asked to discard an open card
 * when none is open has no answer, so the queue stops rather than asking. It does not fire
 * today, because the market starts at three and the queue is capped at three seats, and
 * the deck invariant keeps the piles from ever both being empty — it is here so a change
 * to either figure cannot reintroduce the deadlock silently.
 */
function advanceGoalparaQueue(state: GameState, queue: readonly string[]): readonly string[] {
  const advanced = state.voterDeck.market.length > 0 ? queue : [];
  if (advanced.length > 0) {
    return advanced;
  }
  // The queue is over, so the effect is spent whatever its use count says. That matters
  // most when the truncation above ended it early: the effect suspends the ordinary
  // market refill while it is active, so one left behind with uses remaining would freeze
  // the voter market for the rest of the match — a guard against a deadlock is no good if
  // it trades for that. The caller's own `consumeEffectUse` closes it from here.
  for (const effect of state.activeEffects) {
    if (effect.kind === 'disqualified' && effect.remainingUses !== undefined) {
      effect.remainingUses = 1;
    }
  }
  while (state.voterDeck.market.length < 3) {
    if (recycleDrawPile(state, state.voterDeck, 1) < 1) break;
    const nextCard = state.voterDeck.drawPile.shift();
    if (nextCard === undefined) break;
    state.voterDeck.market.push(nextCard);
  }
  return advanced;
}

function finishEffectChoice(state: GameState, interaction: ChoiceInteraction): void {
  completeInteraction(state);
  discardSource(state, interaction);
}

function canPlacePendingGroup(state: GameState, content: GameContent, groupId: string): boolean {
  const group = state.pendingVoterGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) {
    return false;
  }
  return content.board.zones.some((zone) => {
    if (placementBlocked(state, group.controllerId, zone.id)) {
      return false;
    }
    const zoneSlotIds = new Set(
      content.board.slots.filter((slot) => slot.zoneId === zone.id).map((slot) => slot.slotId),
    );
    return state.slots.filter((slot) => zoneSlotIds.has(slot.slotId) && slot.voterId === null).length
      >= group.voterIds.length;
  });
}

function discardPendingGroup(state: GameState, groupId: string): void {
  const group = state.pendingVoterGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) {
    return;
  }
  for (const voterId of group.voterIds) {
    const voter = state.voters.find((candidate) => candidate.id === voterId);
    if (voter?.location.kind === 'pending' && voter.location.groupId === group.id) {
      voter.location = { kind: 'supply' };
    }
  }
  state.pendingVoterGroups = state.pendingVoterGroups.filter((candidate) => candidate.id !== group.id);
}

function continueBlessingsPlacement(
  state: GameState,
  interaction: ChoiceInteraction,
  groupIds: readonly string[],
  content: GameContent,
): void {
  const remaining = [...groupIds];
  let group = state.pendingVoterGroups.find((candidate) => candidate.id === remaining[0]);
  while (group !== undefined && !canPlacePendingGroup(state, content, group.id)) {
    discardPendingGroup(state, group.id);
    remaining.shift();
    group = state.pendingVoterGroups.find((candidate) => candidate.id === remaining[0]);
  }
  if (group === undefined) {
    finishEffectChoice(state, interaction);
    return;
  }
  const current = state.pendingInteraction;
  if (current?.kind !== 'choice') {
    throw new Error('Blessings placement interaction disappeared.');
  }
  current.responsiblePlayerIds = [group.controllerId];
  current.explanation = `Place the ${group.voterIds.length} freely influenced Blessings voter${group.voterIds.length === 1 ? '' : 's'} in one zone.`;
  current.allowed = ['slots'];
  current.allowPass = false;
  current.continuation = {
    op: 'blessingsPlace',
    handlerId: 'news.dynasty',
    ownerId: stringValue(interaction, 'ownerId') ?? '',
    deck: 'news',
    groupIds: remaining,
  };
}

export function resolveEffectChoice(
  state: GameState,
  actorId: PlayerId,
  interaction: ChoiceInteraction,
  selection: ChoiceSelection,
  content: GameContent,
): string | null {
  if (!interaction.responsiblePlayerIds.includes(actorId)
      || (!interaction.allowed.includes(selection.kind) && !(selection.kind === 'pass' && interaction.allowPass))) {
    return 'The submitted choice is not legal for this interaction.';
  }
  const op = stringValue(interaction, 'op');
  const ownerId = stringValue(interaction, 'ownerId');
  const owner = player(state, ownerId);
  const sourceCardId = interaction.sourceCardId ?? '';
  if (owner === undefined && op !== 'campaignVote' && op !== 'auction') {
    return 'Effect owner is missing.';
  }

  switch (op) {
    case 'chaiOpponent': {
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      if (selection.kind !== 'players' || selection.playerIds.length !== 1
          || selection.playerIds[0] === ownerId || player(state, selection.playerIds[0]) === undefined
          || (reversedFromPlayerId !== undefined && selection.playerIds[0] !== reversedFromPlayerId)) {
        return reversedFromPlayerId === undefined
          ? 'Choose exactly one opponent.'
          : 'A reversed trick must target the player who originally played it.';
      }
      const current = state.pendingInteraction;
      if (current?.kind !== 'choice') {
        return 'Skimming interaction disappeared.';
      }
      current.explanation = 'Choose the resource Skimming intercepts.';
      current.allowed = ['option'];
      current.continuation = { ...current.continuation, op: 'chaiResource', opponentId: selection.playerIds[0] ?? '' };
      return null;
    }
    case 'chaiResource': {
      if (selection.kind !== 'option' || !RESOURCE_TYPES.includes(selection.optionId as typeof RESOURCE_TYPES[number])) {
        return 'Choose one resource type.';
      }
      const replaced = state.activeEffects.filter((effect) => effect.kind === 'skimming');
      state.activeEffects = state.activeEffects.filter((effect) => effect.kind !== 'skimming');
      for (const effect of replaced) {
        if (!state.trickDeck.discardPile.includes(effect.sourceCardId)) {
          state.trickDeck.discardPile.push(effect.sourceCardId);
        }
      }
      addEffect(state, { ownerId: ownerId ?? '', card: content.trickCards.find((card) => card.id === sourceCardId)! }, 'skimming', {
        resource: selection.optionId,
      }, [stringValue(interaction, 'opponentId') ?? '']);
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'turncoatTrack': {
      if (selection.kind !== 'option' || !ARCHETYPES.includes(selection.optionId as Archetype)) {
        return 'Choose an Archetype track.';
      }
      addEffect(state, { ownerId: ownerId ?? '', card: content.trickCards.find((card) => card.id === sourceCardId)! }, 'turncoatArchetype', {
        playerId: ownerId ?? '', archetype: selection.optionId,
      }, [ownerId ?? '']);
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'blockOpen': {
      if (selection.kind !== 'cards' || selection.cardIds.length !== 1) {
        return 'Choose one open card.';
      }
      const effect = state.activeEffects.find((candidate) => candidate.sourceCardId === selection.cardIds[0]);
      if (effect === undefined) {
        return 'The selected card is not open.';
      }
      const heldVoterIds = Array.isArray(effect.data.heldVoterIds) ? effect.data.heldVoterIds : [];
      for (const voterId of heldVoterIds) {
        const voter = state.voters.find((candidate) => candidate.id === voterId);
        if (voter?.location.kind === 'removed') {
          voter.location = {
            kind: 'evicted',
            availableOnTurnOrdinal: nextTurnOrdinalForPlayer(state, voter.ownerId),
          };
        }
      }
      for (const affectedPlayer of state.players) {
        affectedPlayer.obligations = affectedPlayer.obligations.filter(
          (obligation) => obligation.sourceCardId !== effect.sourceCardId,
        );
      }
      state.activeEffects = state.activeEffects.filter((candidate) => candidate.id !== effect.id);
      const targetCard = [...content.trickCards, ...content.newsCards].find((card) => card.id === effect.sourceCardId);
      const pile = targetCard?.deck === 'trick' ? state.trickDeck.discardPile : state.newsDeck.discardPile;
      if (!pile.includes(effect.sourceCardId)) {
        pile.push(effect.sourceCardId);
      }
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'accentFlip': {
      if (selection.kind !== 'cards' || selection.cardIds.length !== 1) {
        return 'Choose one Policy Card.';
      }
      const retained = owner?.retainedPolicy.find((card) => card.cardId === selection.cardIds[0]);
      const definition = content.policyCards.find((card) => card.id === retained?.cardId);
      if (retained === undefined || definition === undefined) {
        return 'Choose one of your retained Policy Cards.';
      }
      retained.answerIndex = retained.answerIndex === 0 ? 1 : 0;
      retained.archetype = definition.answers[retained.answerIndex].archetype;
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'bharatVoters': {
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      if (selection.kind !== 'voters' || selection.voterIds.length !== 5
          || new Set(selection.voterIds).size !== 5
          || selection.voterIds.some((voterId) => {
            const voter = boardVoter(state, voterId);
            return slotDefinition(state, content, voter)?.volatile !== false
              || (reversedFromPlayerId !== undefined && voter?.ownerId !== reversedFromPlayerId);
          })) {
        return reversedFromPlayerId === undefined
          ? 'Choose exactly five distinct non-volatile board voters.'
          : 'A reversed trick must target five voters owned by the original player.';
      }
      const current = state.pendingInteraction;
      if (current?.kind !== 'choice') {
        return 'Long March interaction disappeared.';
      }
      current.explanation = 'Assign one opponent owner to receive each evicted voter.';
      current.allowed = ['players'];
      current.continuation = { ...current.continuation, op: 'bharatOwners', voterIds: selection.voterIds };
      return null;
    }
    case 'bharatOwners': {
      const voterIds = stringsValue(interaction, 'voterIds');
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      if (selection.kind !== 'players' || selection.playerIds.length !== voterIds.length
          || selection.playerIds.some((id) => id === ownerId || player(state, id) === undefined)
          || (reversedFromPlayerId !== undefined
            && selection.playerIds.some((id) => id !== reversedFromPlayerId))) {
        return reversedFromPlayerId === undefined
          ? 'Assign one valid opponent per evicted voter.'
          : 'A reversed trick must return every evicted voter to the original player.';
      }
      for (let index = 0; index < voterIds.length; index += 1) {
        const voter = boardVoter(state, voterIds[index]);
        const recipientId = selection.playerIds[index];
        if (voter?.location.kind !== 'board' || recipientId === undefined) {
          return 'An eviction target disappeared.';
        }
        const sourceSlotId = voter.location.slotId;
        const sourceSlot = state.slots.find((slot) => slot.slotId === sourceSlotId);
        if (sourceSlot === undefined) {
          return 'An eviction slot disappeared.';
        }
        sourceSlot.voterId = null;
        voter.location = {
          kind: 'evicted',
          availableOnTurnOrdinal: nextTurnOrdinalForPlayer(state, recipientId),
          controllerId: recipientId,
        };
      }
      const bharat = state.activeEffects.find(
        (effect) => effect.kind === 'longMarch' && effect.ownerId === ownerId,
      );
      if (bharat === undefined) {
        return 'Long March is no longer active.';
      }
      consumeEffectUse(state, bharat);
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'cultZone': {
      if (selection.kind !== 'option') {
        return 'Choose a majority zone.';
      }
      const snapshot = getZoneSnapshot(state, content, selection.optionId as BoardZoneId);
      if (snapshot.majorityOwnerId !== ownerId) {
        return 'Choose one of your current majorities.';
      }
      addEffect(state, { ownerId: ownerId ?? '', card: content.trickCards.find((card) => card.id === sourceCardId)! }, 'loyalBase', {}, [ownerId ?? ''], [selection.optionId as BoardZoneId]);
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'cultStolenZone': {
      if (selection.kind !== 'option') {
        return 'Choose a majority zone.';
      }
      const effectId = stringValue(interaction, 'effectId');
      const effect = state.activeEffects.find((candidate) => candidate.id === effectId);
      const snapshot = getZoneSnapshot(state, content, selection.optionId as BoardZoneId);
      if (effect === undefined || effect.kind !== 'loyalBase' || snapshot.majorityOwnerId !== actorId) {
        return 'Choose one of your current majorities.';
      }
      effect.targetZoneIds = [selection.optionId as BoardZoneId];
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'notOneTarget': {
      if (selection.kind !== 'option') {
        return 'Choose an opponent and zone.';
      }
      const [targetId, zoneId] = selection.optionId.split('|');
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      if (targetId === ownerId || player(state, targetId) === undefined
          || !content.board.zones.some((zone) => zone.id === zoneId)
          || (reversedFromPlayerId !== undefined && targetId !== reversedFromPlayerId)) {
        return reversedFromPlayerId === undefined
          ? 'Choose a valid opponent and zone.'
          : 'A reversed trick must target the player who originally played it.';
      }
      addEffect(state, { ownerId: ownerId ?? '', card: content.trickCards.find((card) => card.id === sourceCardId)! }, 'blacklist', {}, [targetId ?? ''], [zoneId as BoardZoneId], 1, expireAfterNextTurn(state, targetId ?? ''));
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'imprisonVoters':
    case 'hostageVoters': {
      const required = op === 'imprisonVoters' ? 5 : 4;
      if (selection.kind !== 'voters' || selection.voterIds.length !== required
          || new Set(selection.voterIds).size !== required) {
        return `Choose exactly ${required} distinct voters.`;
      }
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      if (op === 'imprisonVoters' && selection.voterIds.some((id) => {
        const voter = boardVoter(state, id);
        return (voter?.location.kind === 'board' && voter.location.majority)
          || (reversedFromPlayerId !== undefined && voter?.ownerId !== reversedFromPlayerId);
      })) {
        return reversedFromPlayerId === undefined
          ? 'Dragnet only targets non-majority voters.'
          : 'A reversed trick must target voters owned by the original player.';
      }
      for (const voterId of selection.voterIds) {
        const voter = boardVoter(state, voterId);
        if (op === 'hostageVoters' && voter?.ownerId !== ownerId) {
          return 'On The High Seas only holds your voters.';
        }
        const error = removeBoardVoter(state, content, voterId, ownerId ?? '', 'removed', sourceCardId);
        if (error !== null) {
          return error;
        }
      }
      addEffect(state, {
        ownerId: ownerId ?? '',
        card: [...content.trickCards, ...content.newsCards].find((card) => card.id === sourceCardId)!,
      }, op === 'imprisonVoters' ? 'dragnet' : 'ransomNote', {
        heldVoterIds: selection.voterIds,
      }, [ownerId ?? '']);
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'redevelopmentDiscard': {
      const zoneId = stringValue(interaction, 'zoneId');
      const effectId = stringValue(interaction, 'effectId');
      const effect = state.activeEffects.find((candidate) => candidate.id === effectId);
      if (effect === undefined || zoneId === undefined) {
        return 'The Redevelopment effect is no longer active.';
      }
      if (selection.kind !== 'pass') {
        if (selection.kind !== 'voters' || selection.voterIds.length !== 2
            || new Set(selection.voterIds).size !== 2) {
          return 'Choose exactly two distinct voters or pass.';
        }
        for (const voterId of selection.voterIds) {
          const voter = boardVoter(state, voterId);
          const slot = slotDefinition(state, content, voter);
          if (voter?.location.kind !== 'board' || voter.location.majority || slot?.zoneId !== zoneId) {
            return 'Redevelopment targets non-majority voters in the placement zone.';
          }
          const error = removeBoardVoter(state, content, voterId, ownerId ?? '', 'supply', sourceCardId);
          if (error !== null) {
            return error;
          }
        }
      }
      consumeEffectUse(state, effect);
      finishEffectChoice(state, interaction);
      reconcileMajorities(state, content, 'effect');
      return null;
    }
    case 'documentsVoters': {
      if (selection.kind !== 'voters' || selection.voterIds.length < 1 || selection.voterIds.length > 4) {
        return 'Choose between one and four voters.';
      }
      const zones = new Set<string>();
      const reversedFromPlayerId = stringValue(interaction, 'reversedFromPlayerId');
      for (const voterId of selection.voterIds) {
        const voter = boardVoter(state, voterId);
        const slot = slotDefinition(state, content, voter);
        if (voter === undefined || slot === undefined || slot.volatile || zones.has(slot.zoneId)
            || getZoneSnapshot(state, content, slot.zoneId).rightsOwnerId !== ownerId
            || (reversedFromPlayerId !== undefined && voter.ownerId !== reversedFromPlayerId)) {
          return reversedFromPlayerId === undefined
            ? 'Choose one eligible voter in each distinct zone where you hold rights.'
            : 'A reversed trick must target voters owned by the original player.';
      }
        zones.add(slot.zoneId);
      }
      for (const voterId of selection.voterIds) {
        const error = removeBoardVoter(state, content, voterId, ownerId ?? '', 'supply', sourceCardId);
        if (error !== null) {
          return error;
        }
      }
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'slumdogSwap': {
      if (selection.kind !== 'voters' || ![2, 4, 6].includes(selection.voterIds.length)
          || new Set(selection.voterIds).size !== selection.voterIds.length) {
        return 'Choose one to three distinct voter pairs.';
      }
      for (let index = 0; index < selection.voterIds.length; index += 2) {
        const first = boardVoter(state, selection.voterIds[index]);
        const second = boardVoter(state, selection.voterIds[index + 1]);
        if (first?.location.kind !== 'board' || second?.location.kind !== 'board'
            || first.location.majority || second.location.majority
            || slotDefinition(state, content, first)?.volatile !== false
            || slotDefinition(state, content, second)?.volatile !== false) {
          return 'Every swap pair must contain movable non-majority voters.';
        }
        const firstSlotId = first.location.slotId;
        const secondSlotId = second.location.slotId;
        first.location = { kind: 'board', slotId: secondSlotId, majority: false };
        second.location = { kind: 'board', slotId: firstSlotId, majority: false };
        const firstSlot = state.slots.find((slot) => slot.slotId === firstSlotId);
        const secondSlot = state.slots.find((slot) => slot.slotId === secondSlotId);
        if (firstSlot === undefined || secondSlot === undefined) {
          return 'A swap slot disappeared.';
        }
        firstSlot.voterId = second.id;
        secondSlot.voterId = first.id;
      }
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'cornerstoneGain': {
      if (selection.kind !== 'resources' || resourceTotal(selection.resources) !== 4
          || resourceEntries(selection.resources).some(([resource, amount]) => amount > state.publicReserve[resource])) {
        return 'Choose exactly four available resources.';
      }
      grantFromReserve(state, owner!, selection.resources);
      finishEffectChoice(state, interaction);
      checkCap(state, owner!, 'continueEffect');
      return null;
    }
    case 'cornerstoneZone': {
      if (selection.kind !== 'option') {
        return 'Choose a 6/11 zone.';
      }
      const zone = content.board.zones.find((candidate) => candidate.id === selection.optionId && candidate.capacity === 11);
      if (zone === undefined) {
        return 'Cornerstone x3 targets only a 6/11 zone.';
      }
      const voterIds = state.voters.filter((voter) => {
        const slot = slotDefinition(state, content, voter);
        return voter.location.kind === 'board'
          && slot?.zoneId === zone.id
          && slot.volatile === false
          && voter.ownerId !== ownerId;
      }).map((voter) => voter.id);
      const error = convertVoters(state, content, ownerId ?? '', voterIds);
      if (error !== null) {
        return error;
      }
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'dostiTarget':
    case 'mansplainTarget': {
      if (selection.kind !== 'players' || selection.playerIds.length !== 1
          || selection.playerIds[0] === ownerId || player(state, selection.playerIds[0]) === undefined) {
        return 'Choose exactly one opponent.';
      }
      const targetId = selection.playerIds[0] ?? '';
      const expiryPlayerId = op === 'dostiTarget' ? targetId : ownerId ?? '';
      const completedOffset = expiryPlayerId === state.turn.activePlayerId ? 2 : 1;
      addEffect(state, {
        ownerId: ownerId ?? '', card: content.newsCards.find((card) => card.id === sourceCardId)!,
      }, op === 'dostiTarget' ? 'guestEditor' : 'echoChamber', {}, [targetId], [], 1, {
        playerId: expiryPlayerId,
        completedTurn: (state.turn.completedTurns[expiryPlayerId] ?? 0) + completedOffset,
      });
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'nerosMoves': {
      if (selection.kind !== 'slots' || selection.slotIds.length !== 6) {
        return 'Choose exactly three source/destination slot pairs.';
      }
      const zoneId = stringValue(interaction, 'zoneId');
      const destinationDefinitions = selection.slotIds
        .filter((_, index) => index % 2 === 1)
        .map((slotId) => content.board.slots.find((slot) => slot.slotId === slotId));
      const destinationsStayInZone = destinationDefinitions.every((slot) => slot?.zoneId === zoneId);
      const destinationsLeaveZone = destinationDefinitions.every((slot) => slot !== undefined && slot.zoneId !== zoneId);
      if (!destinationsStayInZone && !destinationsLeaveZone) {
        return 'All three Standoff moves must stay in the trigger zone or leave it.';
      }
      for (let index = 0; index < 6; index += 2) {
        const sourceId = selection.slotIds[index];
        const destinationId = selection.slotIds[index + 1];
        const sourceDefinition = content.board.slots.find((slot) => slot.slotId === sourceId);
        const destinationDefinition = content.board.slots.find((slot) => slot.slotId === destinationId);
        const sourceState = state.slots.find((slot) => slot.slotId === sourceId);
        const sourceVoterId = sourceState?.voterId;
        if (sourceId === undefined || destinationId === undefined || sourceDefinition?.zoneId !== zoneId
            || destinationDefinition === undefined || sourceVoterId == null) {
          return 'Each Standoff voter must start in the trigger zone.';
        }
        const error = moveVoter(state, content, sourceVoterId, ownerId ?? '', destinationId, true);
        if (error !== null) {
          return error;
        }
        queueVolatileNews(state, content, sourceVoterId, destinationId, ownerId ?? '');
      }
      reconcileMajorities(state, content, 'effect');
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'poloPlayers': {
      if (selection.kind !== 'players' || selection.playerIds.length !== 2 || new Set(selection.playerIds).size !== 2
          || selection.playerIds.some((playerId) => player(state, playerId) === undefined)) {
        return 'Choose exactly two distinct players.';
      }
      const selectedPlayers = selection.playerIds
        .map((playerId) => player(state, playerId))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
      const missingLevelThree = selectedPlayers.some((candidate) =>
        ARCHETYPES.every((archetype) => archetypeCount(state, candidate, archetype) < 3));
      if (missingLevelThree) {
        const current = state.pendingInteraction;
        if (current?.kind !== 'choice') {
          return 'Backroom Deal interaction disappeared.';
        }
        current.explanation = 'Choose the shared fallback Level 3 Archetype power.';
        current.allowed = ['option'];
        current.continuation = { ...current.continuation, op: 'poloFallback', playerIds: selection.playerIds };
        return null;
      }
      addEffect(state, {
        ownerId: ownerId ?? '', card: content.newsCards.find((card) => card.id === sourceCardId)!,
      }, 'backroomDeal', {
        expiryTurns: selection.playerIds.map((playerId) =>
          `${playerId}=${(state.turn.completedTurns[playerId] ?? 0) + (playerId === state.turn.activePlayerId ? 2 : 1)}`),
      }, selection.playerIds, [], 1);
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'poloFallback': {
      if (selection.kind !== 'option' || !ARCHETYPES.includes(selection.optionId as Archetype)) {
        return 'Choose one Archetype for the shared Level 3 power.';
      }
      const selectedPlayers = [...stringsValue(interaction, 'playerIds')];
      addEffect(state, {
        ownerId: ownerId ?? '', card: content.newsCards.find((card) => card.id === sourceCardId)!,
      }, 'backroomDeal', {
        fallbackArchetype: selection.optionId,
        expiryTurns: selectedPlayers.map((playerId) =>
          `${playerId}=${(state.turn.completedTurns[playerId] ?? 0) + (playerId === state.turn.activePlayerId ? 2 : 1)}`),
      }, selectedPlayers, [], 1);
      finishEffectChoice(state, interaction);
      return null;
    }
    case 'karachiKeep': {
      const drawn = stringsValue(interaction, 'drawn');
      if (selection.kind !== 'cards' || selection.cardIds.length !== 1 || !drawn.includes(selection.cardIds[0] ?? '')) {
        return 'Choose one of the three drawn trick cards.';
      }
      const kept = selection.cardIds[0] ?? '';
      const returned = drawn.filter((cardId) => cardId !== kept);
      const shuffled = shuffle([...state.trickDeck.drawPile, ...returned], state.random);
      state.trickDeck.drawPile = shuffled.items;
      state.random = shuffled.state;
      completeInteraction(state);
      startAuction(state, sourceCardId, ownerId ?? '', kept, 2);
      return null;
    }
    case 'blessingsKeep': {
      const drawn = stringsValue(interaction, 'drawn');
      if (selection.kind !== 'cards' || selection.cardIds.length !== 1 || !drawn.includes(selection.cardIds[0] ?? '')) {
        return 'Choose one of the two drawn voter cards.';
      }
      const current = state.pendingInteraction;
      if (current?.kind !== 'choice') {
        return 'Blessings interaction disappeared.';
      }
      current.explanation = 'Choose an opponent to receive the other voter card.';
      current.allowed = ['players'];
      current.continuation = {
        ...current.continuation,
        op: 'blessingsDonate',
        keptCardId: selection.cardIds[0] ?? '',
        donatedCardId: drawn.find((cardId) => cardId !== selection.cardIds[0]) ?? '',
      };
      return null;
    }
    case 'blessingsDonate': {
      if (selection.kind !== 'players' || selection.playerIds.length !== 1
          || selection.playerIds[0] === ownerId || player(state, selection.playerIds[0]) === undefined) {
        return 'Choose exactly one opponent.';
      }
      const groupIds: string[] = [];
      for (const [cardId, recipientId] of [
        [stringValue(interaction, 'keptCardId'), ownerId],
        [stringValue(interaction, 'donatedCardId'), selection.playerIds[0]],
      ] as const) {
        const card = content.voterCards.find((candidate) => candidate.id === cardId);
        if (card === undefined || recipientId === undefined) {
          return 'A Blessings voter card disappeared.';
        }
        // A seat with all fifty voters on the board or held cannot receive any, and no
        // other answer to this prompt would change that — so that half of the card
        // resolves as no effect and the card is spent either way (A18).
        if (supplyCount(state, recipientId) < card.voters) {
          state.voterDeck.discardPile.push(card.id);
          continue;
        }
        const error = makePendingGroup(state, recipientId, recipientId, card.voters, sourceCardId, true);
        if (error !== null) {
          return error;
        }
        const group = state.pendingVoterGroups[state.pendingVoterGroups.length - 1];
        if (group === undefined) {
          return 'A Blessings voter group disappeared.';
        }
        groupIds.push(group.id);
        state.voterDeck.discardPile.push(card.id);
      }
      continueBlessingsPlacement(state, interaction, groupIds, content);
      return null;
    }
    case 'blessingsPlace': {
      if (selection.kind !== 'slots') {
        return 'Choose slots for the freely influenced voters.';
      }
      const groupIds = stringsValue(interaction, 'groupIds');
      const group = state.pendingVoterGroups.find((candidate) => candidate.id === groupIds[0]);
      if (group === undefined || group.controllerId !== actorId
          || selection.slotIds.length !== group.voterIds.length
          || new Set(selection.slotIds).size !== selection.slotIds.length) {
        return 'Choose exactly one empty slot per freely influenced voter.';
      }
      const definitions = selection.slotIds.map((slotId) =>
        content.board.slots.find((slot) => slot.slotId === slotId));
      const zoneIds = new Set(definitions.map((slot) => slot?.zoneId));
      const zoneId = definitions[0]?.zoneId;
      if (definitions.some((slot) => slot === undefined)
          || selection.slotIds.some((slotId) => state.slots.find((slot) => slot.slotId === slotId)?.voterId !== null)
          || zoneIds.size !== 1 || zoneId === undefined || placementBlocked(state, actorId, zoneId)) {
        return 'Place every freely influenced voter in empty slots in one legal zone.';
      }
      for (let index = 0; index < group.voterIds.length; index += 1) {
        const voterId = group.voterIds[index];
        const slotId = selection.slotIds[index];
        const voter = state.voters.find((candidate) => candidate.id === voterId);
        const slot = state.slots.find((candidate) => candidate.slotId === slotId);
        if (voter?.location.kind !== 'pending' || slot === undefined || voterId === undefined || slotId === undefined) {
          return 'A freely influenced voter or slot disappeared.';
        }
        voter.location = { kind: 'board', slotId, majority: false };
        slot.voterId = voter.id;
        queueVolatileNews(state, content, voter.id, slotId, actorId);
      }
      state.pendingVoterGroups = state.pendingVoterGroups.filter((candidate) => candidate.id !== group.id);
      reconcileMajorities(state, content, 'effect');
      continueBlessingsPlacement(state, interaction, groupIds.slice(1), content);
      return null;
    }
    case 'greatLeaderMove': {
      if (selection.kind !== 'pass' && (selection.kind !== 'slots' || selection.slotIds.length !== 2)) {
        return 'Choose one source/destination slot pair or pass.';
      }
      if (selection.kind === 'slots') {
        const sourceSlotId = selection.slotIds[0];
        const destinationSlotId = selection.slotIds[1];
        const sourceState = state.slots.find((slot) => slot.slotId === sourceSlotId);
        const voter = boardVoter(state, sourceState?.voterId ?? '');
        const sourceDefinition = content.board.slots.find((slot) => slot.slotId === sourceSlotId);
        const destinationDefinition = content.board.slots.find((slot) => slot.slotId === destinationSlotId);
        if (voter?.location.kind !== 'board' || voter.ownerId !== ownerId || voter.location.majority
            || sourceDefinition === undefined || destinationDefinition === undefined
            || !content.board.zones.find((zone) => zone.id === sourceDefinition.zoneId)?.adjacency.includes(destinationDefinition.zoneId)) {
          return 'Move an affected non-majority voter to an adjacent zone.';
        }
        const error = moveVoter(state, content, voter.id, actorId, destinationSlotId ?? '', true);
        if (error !== null) {
          return error;
        }
        queueVolatileNews(state, content, voter.id, destinationDefinition.slotId, actorId);
        reconcileMajorities(state, content, 'effect');
      }
      const rawRemaining = interaction.continuation.remaining;
      const remaining = (typeof rawRemaining === 'number' ? rawRemaining : 1) - 1;
      if (remaining > 0) {
        const current = state.pendingInteraction;
        if (current?.kind !== 'choice') {
          return 'Great Leader interaction disappeared.';
        }
        current.continuation = { ...current.continuation, remaining };
      } else {
        finishEffectChoice(state, interaction);
      }
      return null;
    }
    case 'floodReliefMove': {
      if (selection.kind !== 'pass' && (selection.kind !== 'slots' || selection.slotIds.length !== 2)) {
        return 'Choose one source/destination pair or pass.';
      }
      if (selection.kind === 'slots') {
        const sourceState = state.slots.find((slot) => slot.slotId === selection.slotIds[0]);
        const voter = boardVoter(state, sourceState?.voterId ?? '');
        const source = slotDefinition(state, content, voter);
        const destination = content.board.slots.find((slot) => slot.slotId === selection.slotIds[1]);
        if (voter === undefined || source === undefined || destination === undefined) {
          return 'Choose an occupied source and empty destination.';
        }
        const authorizingZone = content.board.zones.find((zone) => {
          const snapshot = getZoneSnapshot(state, content, zone.id);
          const permitsMove = content.board.movementTriples.some(
            ([rightsZoneId, sourceZoneId, destinationZoneId]) =>
              rightsZoneId === zone.id && sourceZoneId === source.zoneId && destinationZoneId === destination.zoneId,
          );
          const soleAuthorizingVoter = voter.ownerId === actorId && source.zoneId === zone.id
            && (snapshot.counts[actorId] ?? 0) === 1;
          return snapshot.rightsOwnerId === actorId && permitsMove && !soleAuthorizingVoter;
        });
        if (authorizingZone === undefined) {
          return 'This player has no current redistricting rights that authorize the move.';
        }
        const error = moveVoter(state, content, voter.id, actorId, destination.slotId, false);
        if (error !== null) {
          return error;
        }
        reconcileMajorities(state, content, 'effect');
      }
      const queue = stringsValue(interaction, 'queue').filter((playerId) => playerId !== actorId);
      continueQueue(state, interaction, queue, interaction.explanation, ['slots', 'pass'], true, {
        ...interaction.continuation, queue,
      });
      return null;
    }
    case 'coughEvict': {
      if (selection.kind !== 'voters' || selection.voterIds.length !== 1) {
        return 'Evict exactly one voter.';
      }
      const target = boardVoter(state, selection.voterIds[0]);
      if (target?.ownerId !== actorId) {
        return 'Each opponent must evict their own voter.';
      }
      const sourceZoneId = slotDefinition(state, content, target)?.zoneId;
      const hadMajority = sourceZoneId !== undefined
        && getZoneSnapshot(state, content, sourceZoneId).majorityOwnerId === actorId;
      const error = removeBoardVoter(state, content, target.id, actorId, 'removed', sourceCardId);
      if (error !== null) {
        return error;
      }
      target.location = {
        kind: 'evicted',
        availableOnTurnOrdinal: nextTurnOrdinalForPlayer(state, actorId),
      };
      reconcileMajorities(state, content, 'effect');
      const brokeMajority = hadMajority && sourceZoneId !== undefined
        && getZoneSnapshot(state, content, sourceZoneId).majorityOwnerId !== actorId;
      // Re-filtered rather than only shortened: an eviction can break a majority, and
      // `reconcileMajorities` can then move one, so a seat that could answer when the
      // card was dealt may have nothing reachable left (A18).
      const queue = stringsValue(interaction, 'queue')
        .filter((playerId) => playerId !== actorId)
        .filter((playerId) => canEvictOwnVoter(state, content, playerId));
      const broken = [...stringsValue(interaction, 'broken'), ...(brokeMajority ? [actorId] : [])];
      if (queue.length === 0 && broken.length > 0 && reserveTotal(state) > 0) {
        const rewardQueue = broken.flatMap((brokenPlayerId) =>
          state.players.filter((candidate) => candidate.id !== brokenPlayerId).map((candidate) => candidate.id));
        continueQueue(
          state,
          interaction,
          rewardQueue,
          'Choose one resource to receive from Cough & Cold.',
          ['resources'],
          false,
          { ...interaction.continuation, op: 'coughReward', queue: rewardQueue },
        );
      } else if (queue.length === 0) {
        finishEffectChoice(state, interaction);
      } else {
        continueQueue(state, interaction, queue, interaction.explanation, ['voters'], false, {
          ...interaction.continuation, queue, broken,
        });
      }
      return null;
    }
    case 'coughReward': {
      if (selection.kind !== 'resources' || resourceTotal(selection.resources) !== 1
          || resourceEntries(selection.resources).some(([resource, amount]) => amount > state.publicReserve[resource])) {
        return 'Choose exactly one resource.';
      }
      const recipient = player(state, actorId);
      if (recipient === undefined) {
        return 'Cough & Cold recipient disappeared.';
      }
      grantFromReserve(state, recipient, selection.resources);
      // The grant just emptied the reserve for whoever is next: a reward queue asking a
      // seat for one resource the reserve does not hold has no answer (A18).
      const queue = reserveTotal(state) > 0 ? stringsValue(interaction, 'queue').slice(1) : [];
      continueQueue(
        state,
        interaction,
        queue,
        interaction.explanation,
        ['resources'],
        false,
        { ...interaction.continuation, queue },
      );
      return null;
    }
    case 'limitsConvert': {
      if (selection.kind !== 'voters' || selection.voterIds.length !== 2) {
        return 'Choose exactly two voters.';
      }
      const actorIndex = state.turn.order.indexOf(actorId);
      const leftId = state.turn.order[(actorIndex + 1) % state.turn.order.length];
      if (selection.voterIds.some((voterId) => boardVoter(state, voterId)?.ownerId !== leftId)) {
        return 'Both voters must belong to the player on your left.';
      }
      const brokeMajority = selection.voterIds.some((voterId) => {
        const voter = boardVoter(state, voterId);
        return voter?.location.kind === 'board' && voter.location.majority;
      });
      const error = convertVoters(state, content, actorId, selection.voterIds);
      if (error !== null) {
        return error;
      }
      reconcileMajorities(state, content, 'effect');
      // Re-filtered rather than only shortened: the conversion just moved voters, so a
      // seat that was eligible when the card was dealt may no longer have two to take.
      const queue = stringsValue(interaction, 'queue')
        .filter((playerId) => playerId !== actorId)
        .filter((playerId) => canConvertTwoFromLeft(state, content, playerId));
      // The reward is two resources from the reserve, so it is only offered when the
      // reserve holds two; otherwise the queue advances and the reward is forgone (A18).
      if (!brokeMajority && reserveTotal(state) >= 2) {
        const current = state.pendingInteraction;
        if (current?.kind !== 'choice') {
          return 'Turf War interaction disappeared.';
        }
        current.explanation = 'Choose exactly two resources for preserving the majority.';
        current.allowed = ['resources'];
        current.continuation = {
          ...current.continuation,
          op: 'limitsReward',
          rewardPlayerId: actorId,
          queue,
        };
      } else {
        continueQueue(state, interaction, queue, interaction.explanation, ['voters'], false, {
          ...interaction.continuation, queue,
        });
      }
      return null;
    }
    case 'limitsReward': {
      if (selection.kind !== 'resources' || resourceTotal(selection.resources) !== 2
          || resourceEntries(selection.resources).some(([resource, amount]) => amount > state.publicReserve[resource])) {
        return 'Choose exactly two available resources.';
      }
      const recipient = player(state, stringValue(interaction, 'rewardPlayerId'));
      if (recipient === undefined || recipient.id !== actorId) {
        return 'Turf War reward recipient disappeared.';
      }
      grantFromReserve(state, recipient, selection.resources);
      const queue = stringsValue(interaction, 'queue')
        .filter((playerId) => canConvertTwoFromLeft(state, content, playerId));
      continueQueue(state, interaction, queue, 'Convert exactly two voters belonging to the player on your left.', ['voters'], false, {
        ...interaction.continuation,
        op: 'limitsConvert',
        queue,
      });
      checkCap(state, recipient, 'continueEffect');
      return null;
    }
    case 'goalparaCard': {
      if (selection.kind !== 'cards' || selection.cardIds.length !== 1 || !state.voterDeck.market.includes(selection.cardIds[0] ?? '')) {
        return 'Choose one open voter card.';
      }
      const cardId = selection.cardIds[0] ?? '';
      const card = content.voterCards.find((candidate) => candidate.id === cardId);
      const actor = player(state, actorId);
      if (card === undefined || actor === undefined) {
        return 'The selected voter card disappeared.';
      }
      state.voterDeck.market = state.voterDeck.market.filter((candidate) => candidate !== cardId);
      const trip = state.activeEffects.find(
        (effect) => effect.kind === 'disqualified' && effect.ownerId === ownerId,
      );
      if (trip === undefined) {
        return 'Trip To Goalpara is no longer active.';
      }
      state.voterDeck.discardPile.push(cardId);
      grantFromReserve(state, actor, {
        cash: card.cost.cash,
        influence: card.cost.influence,
        press: card.cost.press,
        faith: card.cost.faith,
      });
      const queue = stringsValue(interaction, 'queue').filter((playerId) => playerId !== actorId);
      // The generic half of the reward is only asked for when the reserve can pay it in
      // full; the card names an exact figure, so a short reserve has no answer (A18).
      if (card.cost.generic > 0 && reserveTotal(state) >= card.cost.generic) {
        const current = state.pendingInteraction;
        if (current?.kind !== 'choice') {
          return 'Trip To Goalpara interaction disappeared.';
        }
        current.explanation = `Choose ${card.cost.generic} generic reward resources.`;
        current.allowed = ['resources'];
        current.continuation = {
          ...current.continuation,
          op: 'goalparaReward',
          rewardPlayerId: actorId,
          generic: card.cost.generic,
          queue,
        };
      } else {
        const advanced = advanceGoalparaQueue(state, queue);
        continueQueue(state, interaction, advanced, interaction.explanation, ['cards'], false, {
          ...interaction.continuation, queue: advanced,
        });
        consumeEffectUse(state, trip);
      }
      checkCap(state, actor, 'continueEffect');
      return null;
    }
    case 'goalparaReward': {
      const required = interaction.continuation.generic;
      if (selection.kind !== 'resources' || typeof required !== 'number'
          || resourceTotal(selection.resources) !== required
          || resourceEntries(selection.resources).some(([resource, amount]) => amount > state.publicReserve[resource])) {
        return 'Choose the exact available generic reward.';
      }
      const recipient = player(state, stringValue(interaction, 'rewardPlayerId'));
      if (recipient === undefined || recipient.id !== actorId) {
        return 'Trip To Goalpara reward recipient disappeared.';
      }
      const trip = state.activeEffects.find(
        (effect) => effect.kind === 'disqualified' && effect.ownerId === ownerId,
      );
      if (trip === undefined) {
        return 'Trip To Goalpara is no longer active.';
      }
      grantFromReserve(state, recipient, selection.resources);
      const queue = advanceGoalparaQueue(state, stringsValue(interaction, 'queue'));
      continueQueue(state, interaction, queue, 'Choose an open voter card to discard.', ['cards'], false, {
        ...interaction.continuation,
        op: 'goalparaCard',
        queue,
      });
      consumeEffectUse(state, trip);
      checkCap(state, recipient, 'continueEffect');
      return null;
    }
    case 'oxyChoice': {
      const queue = stringsValue(interaction, 'queue').filter((playerId) => playerId !== actorId);
      if (selection.kind === 'voters') {
        if (selection.voterIds.length !== 1 || boardVoter(state, selection.voterIds[0])?.ownerId !== actorId) {
          return 'Discard exactly one of your own board voters.';
        }
        const error = removeBoardVoter(state, content, selection.voterIds[0] ?? '', actorId, 'supply', sourceCardId);
        if (error !== null) return error;
        reconcileMajorities(state, content, 'effect');
        continueQueue(state, interaction, queue, interaction.explanation, ['voters', 'players'], false, {
          ...interaction.continuation, queue,
        });
        return null;
      }
      if (selection.kind !== 'players' || selection.playerIds.length !== 1
          || selection.playerIds[0] === actorId || player(state, selection.playerIds[0]) === undefined) {
        return 'Choose exactly one opponent to gain a voter.';
      }
      const recipientId = selection.playerIds[0] ?? '';
      // As in Blessings: a seat with nothing left in supply gains nothing, and the queue
      // moves on rather than refusing every opponent this seat could name (A18).
      if (supplyCount(state, recipientId) < 1) {
        continueQueue(state, interaction, queue, interaction.explanation, ['voters', 'players'], false, {
          ...interaction.continuation, queue,
        });
        return null;
      }
      const error = makePendingGroup(state, recipientId, recipientId, 1, sourceCardId, false);
      if (error !== null) return error;
      const group = state.pendingVoterGroups[state.pendingVoterGroups.length - 1];
      if (group === undefined) {
        return 'The Supply Shortage voter group disappeared.';
      }
      if (!canPlacePendingGroup(state, content, group.id)) {
        discardPendingGroup(state, group.id);
        continueQueue(state, interaction, queue, interaction.explanation, ['voters', 'players'], false, {
          ...interaction.continuation, queue,
        });
        return null;
      }
      const current = state.pendingInteraction;
      if (current?.kind !== 'choice') {
        return 'Supply Shortage interaction disappeared.';
      }
      current.responsiblePlayerIds = [recipientId];
      current.explanation = 'Place the free Supply Shortage voter in one empty legal slot.';
      current.allowed = ['slots'];
      current.continuation = {
        ...current.continuation,
        op: 'oxyPlace',
        groupId: group.id,
        queue,
      };
      return null;
    }
    case 'oxyPlace': {
      const groupId = stringValue(interaction, 'groupId');
      const group = state.pendingVoterGroups.find((candidate) => candidate.id === groupId);
      const slotId = selection.kind === 'slots' ? selection.slotIds[0] : undefined;
      const slot = state.slots.find((candidate) => candidate.slotId === slotId);
      const definition = content.board.slots.find((candidate) => candidate.slotId === slotId);
      const voterId = group?.voterIds[0];
      const voter = state.voters.find((candidate) => candidate.id === voterId);
      if (selection.kind !== 'slots' || selection.slotIds.length !== 1
          || group === undefined || group.controllerId !== actorId
          || slot === undefined || slot.voterId !== null || definition === undefined
          || voter?.location.kind !== 'pending'
          || placementBlocked(state, actorId, definition.zoneId)) {
        return 'Place the free Supply Shortage voter in one empty legal slot.';
      }
      voter.location = { kind: 'board', slotId: definition.slotId, majority: false };
      slot.voterId = voter.id;
      state.pendingVoterGroups = state.pendingVoterGroups.filter((candidate) => candidate.id !== group.id);
      queueVolatileNews(state, content, voter.id, definition.slotId, actorId);
      reconcileMajorities(state, content, 'effect');
      const queue = stringsValue(interaction, 'queue');
      continueQueue(state, interaction, queue, 'Discard one of your voters, or choose an opponent to gain a voter.', ['voters', 'players'], false, {
        ...interaction.continuation,
        op: 'oxyChoice',
        queue,
      });
      return null;
    }
    case 'donatePolicy': {
      if (selection.kind !== 'pass' && (selection.kind !== 'cards' || selection.cardIds.length !== 1)) {
        return 'Donate one Policy Card or pass.';
      }
      if (selection.kind === 'cards') {
        const donor = player(state, actorId);
        const cardIndex = donor?.retainedPolicy.findIndex((card) => card.cardId === selection.cardIds[0]) ?? -1;
        const leftId = state.turn.order[(state.turn.order.indexOf(actorId) + 1) % state.turn.order.length];
        const recipient = player(state, leftId);
        const card = donor?.retainedPolicy[cardIndex];
        if (donor === undefined || recipient === undefined || card === undefined) {
          return 'Choose one of your retained Policy Cards.';
        }
        donor.retainedPolicy.splice(cardIndex, 1);
        recipient.retainedPolicy.push(card);
        // The donation stands either way; only the reward depends on the reserve, and
        // six is an exact figure with no answer below it (A18).
        if (reserveTotal(state) < 6) {
          const donated = stringsValue(interaction, 'queue').filter((playerId) => playerId !== actorId);
          continueQueue(state, interaction, donated, 'Donate one Policy Card left, or pass.', ['cards', 'pass'], true, {
            ...interaction.continuation, op: 'donatePolicy', queue: donated,
          });
          return null;
        }
        const current = state.pendingInteraction;
        if (current?.kind !== 'choice') return 'Donation interaction disappeared.';
        current.explanation = 'Choose exactly six resources for the donation reward.';
        current.allowed = ['resources'];
        current.allowPass = false;
        current.continuation = { ...current.continuation, op: 'donationReward', donorId: actorId };
        return null;
      }
      const queue = stringsValue(interaction, 'queue').filter((playerId) => playerId !== actorId);
      continueQueue(state, interaction, queue, interaction.explanation, ['cards', 'pass'], true, {
        ...interaction.continuation, queue,
      });
      return null;
    }
    case 'donationReward': {
      if (selection.kind !== 'resources' || resourceTotal(selection.resources) !== 6) {
        return 'Choose exactly six resources.';
      }
      const donor = player(state, stringValue(interaction, 'donorId'));
      if (donor === undefined || resourceEntries(selection.resources).some(([resource, amount]) => amount > state.publicReserve[resource])) {
        return 'The chosen donation reward is unavailable.';
      }
      grantFromReserve(state, donor, selection.resources);
      const queue = stringsValue(interaction, 'queue').filter((playerId) => playerId !== donor.id);
      continueQueue(state, interaction, queue, 'Donate one Policy Card left, or pass.', ['cards', 'pass'], true, {
        ...interaction.continuation, op: 'donatePolicy', queue,
      });
      checkCap(state, donor, 'continueEffect');
      return null;
    }
    default:
      return `Unsupported effect continuation ${op ?? 'missing'}.`;
  }
}

export function cleanupExpiredEffects(state: GameState): void {
  const expired = state.activeEffects.filter((effect) => {
    if (effect.kind === 'backroomDeal') {
      const thresholds = Array.isArray(effect.data.expiryTurns) ? effect.data.expiryTurns : [];
      return thresholds.length > 0 && thresholds.every((entry) => {
        const [playerId, printedThreshold] = String(entry).split('=');
        const threshold = Number(printedThreshold);
        return playerId !== undefined && Number.isSafeInteger(threshold)
          && (state.turn.completedTurns[playerId] ?? 0) >= threshold;
      });
    }
    const expiry = effect.expiresAfterPlayerTurn;
    return expiry !== undefined && (state.turn.completedTurns[expiry.playerId] ?? 0) >= expiry.completedTurn;
  });
  if (expired.length === 0) {
    return;
  }
  for (const effect of expired) {
    const card = effect.sourceCardId.startsWith('TRK') ? state.trickDeck : state.newsDeck;
    if (!card.discardPile.includes(effect.sourceCardId)) {
      card.discardPile.push(effect.sourceCardId);
    }
  }
  const expiredIds = new Set(expired.map((effect) => effect.id));
  state.activeEffects = state.activeEffects.filter((effect) => !expiredIds.has(effect.id));
}

export function validateEffectRegistry(content: GameContent): void {
  const supported = new Set<string>(SUPPORTED_EFFECT_HANDLERS);
  const unsupported = [...content.trickCards, ...content.newsCards]
    .filter((card) => !supported.has(card.handlerId));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported campaign effect handlers: ${unsupported.map((card) => card.handlerId).join(', ')}`);
  }
}
