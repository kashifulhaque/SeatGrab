/**
 * What the medium and hard policies have in common, and the easy policy's few tools.
 *
 * Every function here composes commands from the enumerator's categories and scores them
 * with the evaluator. Nothing here applies a rule; every command is one the composers
 * could have built, and the engine has the last word.
 */
import { POLICY_CARDS, type Archetype, type Cost, type ResourceType } from '@seatgrab/content';
import type {
  ChoicePromptContext,
  GameCommand,
  PlayerView,
  ResourceVectorDto,
  StructuredChoicePromptView,
} from '@seatgrab/protocol';
import {
  NO_RESOURCES,
  RESOURCE_ORDER,
  effectivePolicyCounts,
  printedTotal,
  purchaseCost,
  startingResourceQuota,
  totalOf,
  volunteersRemaining,
  voterSupply,
  type ChoiceOption,
} from '@seatgrab/seat';

import {
  affordablePayment,
  auctionFloor,
  bidCommand,
  chooseSlots,
  discardByOrder,
  enumerateActions,
  handlerOf as handlerOfCard,
  heldBy,
  reactionAnswers,
  shortfallOrder,
  zoneOf,
  type ActionCandidates,
  type OptionOrder,
  type OutreachPair,
  type Purchase,
  type ResourceFill,
  type ResourceOrder,
  type Target,
  type TrickPlay,
} from '../enumerate.js';
import {
  afterConversion,
  afterMove,
  afterPlacement,
  afterRemoval,
  afterResources,
  emptySlotsIn,
  evaluate,
  gain,
  leadingRivalId,
  leads,
  negate,
  rivalMax,
  standings,
} from '../evaluate.js';
import { shuffled, type Random } from '../random.js';

export type Level = 'easy' | 'medium' | 'hard';

/** The trick handlers whose play helps the seat that plays them. */
export const BENEFICIAL_TRICKS: ReadonlySet<string> = new Set([
  'trick.cornerstone',
  'trick.grandCoalition',
  'trick.starPower',
  'trick.turncoat',
  'trick.loyalBase',
  'trick.redevelopment',
]);

/** The trick handlers whose play hurts a chosen rival. */
export const HOSTILE_TRICKS: ReadonlySet<string> = new Set([
  'trick.skimming',
  'trick.blacklist',
  'trick.dragnet',
  'trick.rollPurge',
  'trick.longMarch',
  'trick.musicalChairs',
]);

/** Fixed values for candidates whose effect the policy cannot project. */
export const FIXED = {
  arbitrageEnablingPurchase: 2,
  shakedownWhenShort: 1.5,
  buyTrick: 0.5,
  beneficialPlay: 1.5,
  hostilePlay: 1,
  cornerstoneTriple: 6,
  flipFlopToPower: 2,
  vetoOpenEffect: 0.75,
  scorchedEarth: 0.25,
  leadingRivalTarget: 0.5,
} as const;

/* ------------------------------------------------------------ the placement */

/**
 * The placement score of one legal slot for one pick, as the brief specifies it.
 *
 * `endgame` adds the hard policy's two terms: prefer completing the last undecided zone
 * when leading, and avoid completing the ninth majority or filling the last empty area
 * when trailing.
 */
export function placementScore(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean },
  slotId: string,
  chosen: readonly string[],
  endgame: boolean,
): number {
  const zoneId = zoneOf(view, slotId);
  const zone = view.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) return -100;
  if (zone.majorityOwnerId !== undefined && zone.majorityOwnerId !== seatId) return -100;
  if (zone.majorityOwnerId === seatId) return -10;

  const chosenHere = chosen.filter((id) => zoneOf(view, id) === zone.id).length;
  const threshold = zone.majorityThreshold;
  const mine = (zone.counts[seatId] ?? 0) + chosenHere;
  const empty = emptySlotsIn(view, zone.id) - chosenHere;
  if (mine + empty < threshold) return -20;

  const remaining = group.count - chosen.length;
  const count = group.sameZone ? remaining : 1;
  const after = mine + count;
  const complete = after >= threshold;
  let score = complete ? threshold + 2 : 2 * after - threshold;

  const rival = rivalMax(zone, seatId);
  if (!complete && rival >= threshold - 1 && after <= rival) score -= 3;

  const slot = view.slots.find((candidate) => candidate.slotId === slotId);
  if (slot?.volatile === true) {
    const quietEmpty = view.slots.some((candidate) =>
      candidate.zoneId === zone.id && candidate.voter === undefined && !candidate.volatile
      && !chosen.includes(candidate.slotId));
    if (quietEmpty) score -= 1;
  }

  if (endgame) {
    const ahead = leads(view, seatId);
    if (complete) {
      const othersDecided = view.zones.every((candidate) =>
        candidate.id === zone.id || candidate.majorityOwnerId !== undefined);
      if (othersDecided) score += ahead ? 5 : -8;
    }
    if (!ahead) {
      const emptyOnBoard = view.slots.filter((candidate) =>
        candidate.voter === undefined && !chosen.includes(candidate.slotId)).length;
      if (emptyOnBoard <= remaining) score -= 8;
    }
  }
  return score;
}

/** The slots the placement score chooses for a group, re-asking legality after each pick. */
export function scoredSlots(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean; allowedZoneIds?: readonly string[] },
  endgame: boolean,
): readonly string[] {
  return chooseSlots(view, seatId, group, (slotId, chosen) =>
    placementScore(view, seatId, group, slotId, chosen, endgame));
}

/** True when a full placement exists and its first pick is in a zone worth filling. */
export function placeable(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean; allowedZoneIds?: readonly string[] },
  endgame: boolean,
): readonly string[] | null {
  const slots = scoredSlots(view, seatId, group, endgame);
  if (slots.length < group.count) return null;
  const first = slots[0];
  if (first === undefined) return null;
  return placementScore(view, seatId, group, first, [], endgame) > -20 ? slots : null;
}

/* ------------------------------------------------------------- the prompts */

/**
 * Starting resources that make the cheapest open card affordable next turn, with the
 * remainder split evenly.
 */
export function startingResourcesForMarket(view: PlayerView, seatId: string): ResourceVectorDto {
  const quota = startingResourceQuota(view, seatId);
  const resources = { ...NO_RESOURCES };
  let left = quota;
  const cheapest = view.voterMarket
    .map((cardId) => purchaseCost(view, seatId, cardId))
    .filter((cost): cost is Cost => cost !== null)
    .sort((a, b) => printedTotal(a) - printedTotal(b))[0];
  if (cheapest !== undefined) {
    for (const resource of RESOURCE_ORDER) {
      const take = Math.min(cheapest[resource], left);
      resources[resource] += take;
      left -= take;
    }
  }
  for (let taken = 0; left > 0; taken += 1) {
    const resource = RESOURCE_ORDER[taken % RESOURCE_ORDER.length];
    if (resource === undefined) break;
    resources[resource] += 1;
    left -= 1;
  }
  return resources;
}

/** A seeded coin flip over the two answers, the other one as the fallback. */
export function coinFlipAnswer(random: Random): readonly GameCommand[] {
  const first = random.below(2) === 0 ? 0 : 1;
  return [
    { type: 'CommitPolicyAnswer', answerIndex: first },
    { type: 'CommitPolicyAnswer', answerIndex: first === 0 ? 1 : 0 },
  ];
}

/** Discard the types the open market needs least. */
export function capDiscardByNeed(view: PlayerView, seatId: string, excess: number): GameCommand {
  const held = heldBy(view, seatId);
  return {
    type: 'DiscardExcessResources',
    resources: discardByOrder(held, excess, shortfallOrder(view, seatId, held)),
  };
}

/** Mark non-volatile voters for a majority first, so the movable ones stay movable. */
export function majorityNonVolatileFirst(
  view: PlayerView,
  prompt: { interactionId: string; required: number; eligibleVoterIds: readonly string[] },
): readonly GameCommand[] {
  const volatile = new Set(
    view.slots.filter((slot) => slot.volatile && slot.voter !== undefined).map((slot) => slot.voter?.id),
  );
  const ordered = [...prompt.eligibleVoterIds].sort((left, right) => {
    const difference = Number(volatile.has(left)) - Number(volatile.has(right));
    return difference !== 0 ? difference : left.localeCompare(right);
  });
  const first = ordered.slice(0, prompt.required);
  const plain = prompt.eligibleVoterIds.slice(0, prompt.required);
  if (first.length < prompt.required) return [];
  const answers: GameCommand[] = [{
    type: 'SubmitChoice',
    interactionId: prompt.interactionId,
    selection: { kind: 'voters', voterIds: first },
  }];
  if (JSON.stringify(plain) !== JSON.stringify(first)) {
    answers.push({
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'voters', voterIds: [...plain] },
    });
  }
  return answers;
}

/** The resource types this seat needs most, front first, drawn from what the bank holds. */
export function resourceFillFor(view: PlayerView, seatId: string): ResourceFill {
  return {
    order: [...shortfallOrder(view, seatId, heldBy(view, seatId))].reverse(),
    available: view.publicReserve,
  };
}

/** The resource types this seat needs most, front first. */
export function resourceOrderFor(view: PlayerView, seatId: string): ResourceOrder {
  return resourceFillFor(view, seatId).order;
}

const POLICY_BY_ID = new Map(POLICY_CARDS.map((card) => [card.id as string, card]));

/**
 * The kept Policy Cards whose other face would put a track on 3 or 5.
 *
 * Both faces of a kept card are face up to its owner, so reading the other answer's
 * archetype is legitimate. The reward is never read.
 */
export function powerReachingFlips(view: PlayerView, seatId: string): readonly string[] {
  const counts = effectivePolicyCounts(view, seatId);
  return (view.privatePolicyCards ?? []).flatMap((kept) => {
    const card = POLICY_BY_ID.get(kept.cardId);
    const other: Archetype | undefined = card?.answers[kept.answerIndex === 0 ? 1 : 0]?.archetype;
    if (other === undefined || other === kept.archetype) return [];
    const reached = counts[other] + 1;
    return reached === 3 || reached === 5 ? [kept.cardId] : [];
  });
}

/**
 * Puts the options of a choice control in the order the medium and hard policies prefer.
 *
 * Players: the strongest rival first where a rival is a victim, the weakest first where a
 * rival receives something. Voters: rivals' voters first, the leading rival's before the
 * rest, own voters last. Slots: by placement score. Zones and cards: per operation.
 */
export function optionOrderFor(view: PlayerView, seatId: string): OptionOrder {
  const ranking = new Map(standings(view).map((entry, index) => [entry.seatId, index]));
  const rankOf = (playerId: string): number => ranking.get(playerId) ?? view.players.length;
  const strongestFirst = (left: ChoiceOption, right: ChoiceOption): number => {
    if (left.id === seatId) return 1;
    if (right.id === seatId) return -1;
    return rankOf(left.id) - rankOf(right.id);
  };
  const weakestFirst = (left: ChoiceOption, right: ChoiceOption): number => {
    if (left.id === seatId) return 1;
    if (right.id === seatId) return -1;
    return rankOf(right.id) - rankOf(left.id);
  };
  const leader = leadingRivalId(view, seatId);
  const rivalVotersFirst = (left: ChoiceOption, right: ChoiceOption): number =>
    voterPriority(view, seatId, leader, right.id) - voterPriority(view, seatId, leader, left.id);
  const zoneOrder = (op: ChoicePromptContext['op']) => (left: ChoiceOption, right: ChoiceOption): number =>
    zonePriority(view, seatId, leader, op, right.id) - zonePriority(view, seatId, leader, op, left.id);

  return (control, prompt) => {
    const op = prompt.context.op;
    switch (control.select) {
      case 'players':
        return { ...control, options: [...control.options].sort(op === 'blessingsDonate' ? weakestFirst : strongestFirst) };
      case 'assign':
        return { ...control, options: [...control.options].sort(weakestFirst) };
      case 'option': {
        if (op === 'campaignVote') return { ...control, options: [...control.options].sort(weakestFirst) };
        if (op === 'turncoatTrack') {
          const counts = effectivePolicyCounts(view, seatId);
          const worth = (id: string): number => {
            const count = counts[id as Archetype] ?? 0;
            return (count + 1 === 3 || count + 1 === 5 ? 10 : 0) + count;
          };
          return { ...control, options: [...control.options].sort((left, right) => worth(right.id) - worth(left.id)) };
        }
        if (op === 'chaiResource') {
          const order = resourceOrderFor(view, seatId);
          return {
            ...control,
            options: [...control.options].sort((left, right) =>
              order.indexOf(left.id as ResourceType) - order.indexOf(right.id as ResourceType)),
          };
        }
        if (control.options.some((option) => view.zones.some((zone) => zone.id === option.id))) {
          return { ...control, options: [...control.options].sort(zoneOrder(op)) };
        }
        return control;
      }
      case 'cards': {
        if (op === 'accentFlip') {
          const wanted = new Set(powerReachingFlips(view, seatId));
          return {
            ...control,
            options: [...control.options].sort((left, right) =>
              Number(wanted.has(right.id)) - Number(wanted.has(left.id))),
          };
        }
        if (op === 'blockOpen') {
          const rivalEffect = (cardId: string): number =>
            view.activeEffects.some((effect) => effect.sourceCardId === cardId && effect.ownerId !== seatId) ? 1 : 0;
          return {
            ...control,
            options: [...control.options].sort((left, right) => rivalEffect(right.id) - rivalEffect(left.id)),
          };
        }
        return control;
      }
      case 'board':
        if (control.of === 'voters') {
          return { ...control, options: [...control.options].sort(rivalVotersFirst) };
        }
        return {
          ...control,
          options: [...control.options].sort((left, right) =>
            placementScore(view, seatId, { count: 1, sameZone: true }, right.id, [], false)
            - placementScore(view, seatId, { count: 1, sameZone: true }, left.id, [], false)),
        };
      case 'resources':
        return control;
    }
  };
}

/** How much this policy wants to touch a rival's voter: higher first. Own voters last. */
function voterPriority(view: PlayerView, seatId: string, leader: string | null, voterId: string): number {
  const slot = view.slots.find((candidate) => candidate.voter?.id === voterId);
  if (slot?.voter === undefined) return -100;
  const zone = view.zones.find((candidate) => candidate.id === slot.zoneId);
  if (slot.voter.ownerId === seatId) return slot.voter.majority ? -50 : -10;
  const count = zone?.counts[slot.voter.ownerId] ?? 0;
  const threshold = zone?.majorityThreshold ?? 1;
  return (slot.voter.ownerId === leader ? 5 : 0) + (10 * count) / threshold + (slot.voter.majority ? 1 : 0);
}

function zonePriority(
  view: PlayerView,
  seatId: string,
  leader: string | null,
  op: ChoicePromptContext['op'],
  zoneId: string,
): number {
  const zone = view.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) return -100;
  const mine = zone.counts[seatId] ?? 0;
  const theirs = leader === null ? 0 : zone.counts[leader] ?? 0;
  switch (op) {
    case 'cultZone':
      // Protect the most valuable majority of this seat's.
      return zone.majorityOwnerId === seatId ? zone.majorityThreshold : -100;
    case 'cornerstoneZone':
      // Convert the zone with the most rival voters, a rival majority above all.
      return (zone.majorityOwnerId !== undefined && zone.majorityOwnerId !== seatId ? 20 : 0)
        + Object.entries(zone.counts).filter(([id]) => id !== seatId).reduce((sum, [, n]) => sum + n, 0);
    default:
      // Shut the leading rival out of where they are closest to a majority.
      return zone.majorityOwnerId === undefined ? (10 * theirs) / zone.majorityThreshold - mine / zone.majorityThreshold : -100;
  }
}

/* ------------------------------------------------------------ the purchases */

export interface PaymentShape {
  resources: ResourceVectorDto;
  discounts: ResourceVectorDto;
}

/**
 * Pay what is held and discount the rest, or `null` when the discount cannot cover it.
 *
 * Named icons are paid in kind as far as the holding allows and the gap is discounted on
 * that type; the generic icons are paid from what is left and any remainder is discounted
 * on the first type. `paymentBreakdown` reads paid and discounted units together per type.
 */
export function discountedPayment(cost: Cost, held: ResourceVectorDto, maximumDiscount: number): PaymentShape | null {
  const resources = { ...NO_RESOURCES };
  const discounts = { ...NO_RESOURCES };
  const left = { ...held };
  for (const resource of RESOURCE_ORDER) {
    const pay = Math.min(cost[resource], left[resource]);
    resources[resource] += pay;
    left[resource] -= pay;
    discounts[resource] += cost[resource] - pay;
  }
  let generic = cost.generic;
  for (const resource of [...RESOURCE_ORDER].sort((a, b) => left[b] - left[a])) {
    const take = Math.min(generic, left[resource]);
    resources[resource] += take;
    left[resource] -= take;
    generic -= take;
  }
  const first = RESOURCE_ORDER[0];
  if (first !== undefined) discounts[first] += generic;
  return totalOf(discounts) <= maximumDiscount ? { resources, discounts } : null;
}

/** Move up to `units` paid resources into discounts, largest pile first. */
export function applyDiscount(payment: ResourceVectorDto, held: ResourceVectorDto, units: number): PaymentShape {
  const resources = { ...payment };
  const discounts = { ...NO_RESOURCES };
  let left = units;
  for (const resource of [...RESOURCE_ORDER].sort((a, b) => held[b] - held[a])) {
    const move = Math.min(left, resources[resource]);
    resources[resource] -= move;
    discounts[resource] += move;
    left -= move;
  }
  return { resources, discounts };
}

export interface PlannedPurchase {
  cardId: string;
  voters: number;
  cost: Cost;
  payment: PaymentShape;
  groundswell: boolean;
  slots: readonly string[];
  delta: number;
  command: GameCommand;
}

/**
 * Every purchase worth making, in the order the medium and hard policies buy.
 *
 * Volunteers is spent first on a card it turns affordable, otherwise on the largest
 * purchase. Groundswell goes on the largest card while it has uses left and the supply
 * covers the extra voter. A card whose group has no zone worth filling is skipped.
 */
export function planPurchases(view: PlayerView, seatId: string, actions: ActionCandidates, endgame: boolean): readonly PlannedPurchase[] {
  if (actions.purchasesBlocked) return [];
  const held = actions.held;
  const supply = voterSupply(view);
  const discount = volunteersRemaining(view, seatId);
  const groundswell = actions.powers.find((power) => power.id === 'groundswell');
  const groundswellLeft = groundswell?.unlocked === true && groundswell.usage !== undefined
    ? groundswell.usage.limit - groundswell.usage.used
    : 0;

  const shaped: { purchase: Purchase; payment: PaymentShape; viaDiscount: boolean }[] = actions.purchases
    .map((purchase) => ({ purchase, payment: { resources: purchase.payment, discounts: { ...NO_RESOURCES } }, viaDiscount: false }));
  let discountSpent = false;
  if (discount > 0) {
    const rescued = actions.unaffordable
      .filter((entry) => entry.short.total <= discount)
      .sort((a, b) => b.voters - a.voters)[0];
    const payment = rescued === undefined ? null : discountedPayment(rescued.cost, held, discount);
    if (rescued !== undefined && payment !== null) {
      shaped.push({
        purchase: { cardId: rescued.cardId, cost: rescued.cost, voters: rescued.voters, payment: payment.resources },
        payment,
        viaDiscount: true,
      });
      discountSpent = true;
    }
  }
  if (discount > 0 && !discountSpent) {
    const largest = [...shaped].sort((a, b) => b.purchase.voters - a.purchase.voters || printedTotal(b.purchase.cost) - printedTotal(a.purchase.cost))[0];
    if (largest !== undefined) largest.payment = applyDiscount(largest.purchase.payment, held, discount);
  }

  const mostVoters = Math.max(0, ...shaped.map((entry) => entry.purchase.voters));
  const planned: PlannedPurchase[] = [];
  for (const entry of shaped) {
    const withGroundswell = groundswellLeft > 0
      && entry.purchase.voters === mostVoters
      && (supply === null || supply >= entry.purchase.voters + 1);
    const count = entry.purchase.voters + (withGroundswell ? 1 : 0);
    const paid = afterResources(view, seatId, negate(entry.payment.resources));
    const slots = placeable(paid, seatId, { count, sameZone: true }, endgame);
    if (slots === null) continue;
    const delta = gain(view, seatId, afterPlacement(paid, seatId, slots));
    planned.push({
      cardId: entry.purchase.cardId,
      voters: count,
      cost: entry.purchase.cost,
      payment: entry.payment,
      groundswell: withGroundswell,
      slots,
      delta,
      command: {
        type: 'InfluenceVoterCard',
        cardId: entry.purchase.cardId,
        payment: { resources: entry.payment.resources, discounts: entry.payment.discounts },
        ...(withGroundswell ? { groundswell: true } : {}),
      },
    });
  }
  // Most voters per resource first, then cheapest.
  return planned.sort((left, right) => {
    const perResource = right.voters / Math.max(1, printedTotal(right.cost)) - left.voters / Math.max(1, printedTotal(left.cost));
    if (perResource !== 0) return perResource;
    return printedTotal(left.cost) - printedTotal(right.cost);
  });
}

/* ------------------------------------------------------------- the powers */

/** A command with the value the policy puts on it. */
export interface Scored {
  command: GameCommand;
  delta: number;
}

/** The resource this seat is short of for the best card it cannot afford, or `null`. */
export function neededResource(view: PlayerView, seatId: string, actions: ActionCandidates): ResourceType | null {
  const best = [...actions.unaffordable].sort((a, b) => b.voters - a.voters || a.short.total - b.short.total)[0];
  if (best === undefined) return null;
  const named = RESOURCE_ORDER.find((resource) => best.short.named[resource] > 0);
  return named ?? resourceOrderFor(view, seatId)[0] ?? null;
}

/** Arbitrage that turns a card one resource short into an affordable one. */
export function arbitrageCandidates(view: PlayerView, seatId: string, actions: ActionCandidates): readonly Scored[] {
  if (!actions.arbitrage) return [];
  const held = actions.held;
  const oneShort = actions.unaffordable.filter((entry) => entry.short.total === 1);
  if (oneShort.length === 0) return [];
  const out: Scored[] = [];
  const spare = shortfallOrder(view, seatId, held);
  for (const entry of oneShort.sort((a, b) => b.voters - a.voters)) {
    const need = RESOURCE_ORDER.find((resource) => entry.short.named[resource] > 0) ?? resourceOrderFor(view, seatId)[0];
    if (need === undefined) continue;
    // Arbitrage takes two of one type out of the public reserve. A reserve that has run
    // dry makes the command a certain refusal, and a seat that spends its whole decision
    // on one ends its turn having done nothing — which, on a board where nobody can place
    // any more, is a turn the table then repeats forever.
    if (view.publicReserve[need] < 2) continue;
    const give = spare.find((resource) => resource !== need && held[resource] >= 1);
    if (give === undefined) continue;
    out.push({
      command: {
        type: 'UseProspecting',
        payment: { ...NO_RESOURCES, [give]: 1 },
        gain: { ...NO_RESOURCES, [need]: 2 },
      },
      delta: FIXED.arbitrageEnablingPurchase + entry.voters * 0.1,
    });
  }
  return out;
}

/** Shakedown for the resource this seat is short of. */
export function shakedownCandidates(
  view: PlayerView,
  seatId: string,
  actions: ActionCandidates,
  from: 'richest' | 'leader',
): readonly Scored[] {
  // `actions.shakedown` is the whole test: it already asks whether the power is unlocked
  // and has a use left this turn. `view.legalActions` does not name the power commands at
  // all — it lists the ordinary actions of a turn — so asking it here left Shakedown
  // unreachable at every difficulty, which is not what the difficulty table says.
  if (!actions.shakedown) return [];
  // Only when one resource is the whole gap, as Arbitrage is. A seat four short of every
  // open card gains nothing it can spend by taking one, and a rule that took one anyway
  // would take one every turn for the rest of the match without ever buying anything.
  const oneShort = actions.unaffordable.filter((entry) => entry.short.total === 1);
  if (oneShort.length === 0) return [];
  const need = neededResource(view, seatId, { ...actions, unaffordable: oneShort });
  if (need === null) return [];
  const rivals = view.players.filter((player) => player.id !== seatId && player.resources[need] >= 1);
  if (rivals.length === 0) return [];
  const ranking = new Map(standings(view).map((entry, index) => [entry.seatId, index]));
  const chosen = [...rivals].sort((left, right) =>
    from === 'richest'
      ? right.resources[need] - left.resources[need] || left.seat - right.seat
      : (ranking.get(left.id) ?? 9) - (ranking.get(right.id) ?? 9))[0];
  if (chosen === undefined) return [];
  return [{
    command: { type: 'UseDonations', opponentId: chosen.id, resource: need },
    delta: FIXED.shakedownWhenShort,
  }];
}

/** True when this seat alone holds the most voters in the zone after the change. */
function uniqueHighest(view: PlayerView, seatId: string, zoneId: string): boolean {
  const zone = view.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) return false;
  const mine = zone.counts[seatId] ?? 0;
  return mine > 0 && mine > rivalMax(zone, seatId);
}

export function moveCandidates(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly Scored[] {
  const leader = leadingRivalId(view, seatId);
  const out: Scored[] = [];
  for (const move of actions.moves) {
    const projected = afterMove(view, move.voterId, move.destinationSlotId);
    const delta = gain(view, seatId, projected);
    const destination = projected.zones.find((zone) => zone.id === move.destinationZoneId);
    if (move.ownerId === seatId) {
      const completes = destination?.majorityOwnerId === seatId
        && view.zones.find((zone) => zone.id === move.destinationZoneId)?.majorityOwnerId === undefined;
      const takesLead = !uniqueHighest(view, seatId, move.destinationZoneId)
        && uniqueHighest(projected, seatId, move.destinationZoneId);
      if (level === 'medium' && !completes && !takesLead) continue;
      if (level === 'hard' && delta <= 0) continue;
      out.push({ command: move.command, delta: delta + (completes ? 2 : 0) });
      continue;
    }
    if (level !== 'hard') continue;
    const source = view.zones.find((zone) => zone.id === move.sourceZoneId);
    const threatening = source !== undefined
      && source.majorityOwnerId === undefined
      && (source.counts[move.ownerId] ?? 0) >= source.majorityThreshold - 2;
    if (!threatening || delta <= 0) continue;
    out.push({ command: move.command, delta: delta + (move.ownerId === leader ? FIXED.leadingRivalTarget : 0) });
  }
  return out;
}

/** Whether removing this rival voter breaks a majority in the making. */
function breaksThreat(view: PlayerView, target: Target): boolean {
  const zone = view.zones.find((candidate) => candidate.id === target.zoneId);
  return zone !== undefined
    && zone.majorityOwnerId === undefined
    && (zone.counts[target.ownerId] ?? 0) >= zone.majorityThreshold - 1;
}

export function removalCandidates(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly Scored[] {
  const leader = leadingRivalId(view, seatId);
  const held = actions.held;
  const spare = shortfallOrder(view, seatId, held).find((resource) => held[resource] >= 1);
  const out: Scored[] = [];
  const consider = (target: Target, command: GameCommand, projected: PlayerView): void => {
    if (target.ownerId === seatId || target.majority) return;
    const delta = gain(view, seatId, projected);
    if (level === 'medium' && !breaksThreat(view, target)) return;
    if (delta <= 0) return;
    out.push({ command, delta: delta + (target.ownerId === leader ? FIXED.leadingRivalTarget : 0) });
  };
  for (const target of actions.demolition) {
    consider(target, { type: 'UseBreakingGround', voterId: target.voterId }, afterRemoval(view, [target.voterId]));
  }
  if (spare !== undefined) {
    const payment = { ...NO_RESOURCES, [spare]: 1 };
    for (const target of actions.crackdown) {
      consider(
        target,
        { type: 'UsePayback', voterId: target.voterId, payment },
        afterResources(afterRemoval(view, [target.voterId]), seatId, negate(payment)),
      );
    }
  }
  return out;
}

export function outreachCandidates(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly Scored[] {
  if (actions.outreach.length === 0) return [];
  const cost: Cost = { cash: 0, influence: 0, press: 0, faith: 2, generic: 2 };
  const payment = affordablePayment(cost, actions.held);
  if (payment === null) return [];
  const leader = leadingRivalId(view, seatId);
  const out: Scored[] = [];
  const winnable = (pair: OutreachPair): boolean => {
    const zone = view.zones.find((candidate) => candidate.id === pair.zoneId);
    if (zone === undefined || zone.majorityOwnerId !== undefined) return false;
    const mine = (zone.counts[seatId] ?? 0) + 2;
    return mine + emptySlotsIn(view, zone.id) >= zone.majorityThreshold;
  };
  for (const pair of actions.outreach) {
    if (level === 'medium' && !winnable(pair)) continue;
    const projected = afterResources(afterConversion(view, seatId, pair.voterIds), seatId, negate(payment));
    const delta = gain(view, seatId, projected);
    if (delta <= 0) continue;
    out.push({
      command: {
        type: 'UseToughLove',
        voterIds: [pair.voterIds[0], pair.voterIds[1]],
        payment: { resources: payment, discounts: { ...NO_RESOURCES } },
      },
      delta: delta + (pair.ownerId === leader ? FIXED.leadingRivalTarget : 0),
    });
  }
  return out;
}

/* --------------------------------------------------------------- the tricks */

export function trickPurchase(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly Scored[] {
  if (actions.trick === null) return [];
  const held = totalOf(actions.held);
  if (held - printedTotal(actions.trick.cost) < 3) return [];
  if (level === 'hard' && (view.privateTrickIds ?? []).length >= 2) return [];
  return [{
    command: { type: 'BuyTrick', payment: { resources: actions.trick.payment, discounts: { ...NO_RESOURCES } } },
    delta: FIXED.buyTrick,
  }];
}

/** True when a 6-of-11 zone holds a rival majority Cornerstone's triple could convert. */
function rivalHoldsElevenZone(view: PlayerView, seatId: string): boolean {
  return view.zones.some((zone) =>
    zone.capacity === 11 && zone.majorityOwnerId !== undefined && zone.majorityOwnerId !== seatId);
}

export function trickPlays(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly Scored[] {
  const out: Scored[] = [];
  const level3Unlocked = actions.powers.some((power) => power.level === 3 && power.unlocked);
  const rivalEffectOpen = view.activeEffects.some((effect) => effect.ownerId !== seatId);
  const rivalMoves = actions.moves.some((move) => move.ownerId !== seatId);
  const flips = powerReachingFlips(view, seatId);
  for (const play of actions.plays) {
    const scored = scorePlay(play, level, { level3Unlocked, rivalEffectOpen, rivalMoves, flips, view, seatId });
    if (scored !== null) out.push({ command: play.command, delta: scored });
  }
  return out;
}

function scorePlay(
  play: TrickPlay,
  level: Level,
  facts: { level3Unlocked: boolean; rivalEffectOpen: boolean; rivalMoves: boolean; flips: readonly string[]; view: PlayerView; seatId: string },
): number | null {
  if (level === 'easy') return null;
  if (play.mode !== undefined) {
    // Cornerstone's triple conversion, the only printed mode.
    return level === 'hard' && rivalHoldsElevenZone(facts.view, facts.seatId) ? FIXED.cornerstoneTriple : null;
  }
  const handler = play.handlerId;
  if (handler === 'trick.grandCoalition') return facts.level3Unlocked ? FIXED.beneficialPlay : null;
  if (BENEFICIAL_TRICKS.has(handler)) return FIXED.beneficialPlay;
  if (HOSTILE_TRICKS.has(handler)) return FIXED.hostilePlay;
  if (level !== 'hard') return null;
  if (handler === 'trick.flipFlop') return facts.flips.length > 0 ? FIXED.flipFlopToPower : null;
  if (handler === 'trick.veto') return facts.rivalEffectOpen ? FIXED.vetoOpenEffect : null;
  if (handler === 'trick.scorchedEarth') return facts.rivalMoves ? FIXED.scorchedEarth : null;
  return null;
}

/* ------------------------------------------------------------- the prompts */

export function reactionDecision(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  level: Level,
): readonly GameCommand[] {
  const { reactions, pass } = reactionAnswers(view, seatId, prompt);
  if (level === 'easy' || prompt.context.op !== 'trickPriority') return [pass];
  const played = prompt.context;
  const handler = handlerOfCard(played.playedCardId);
  const hostile = HOSTILE_TRICKS.has(handler) || handler === 'trick.scorchedEarth';
  const leader = leadingRivalId(view, seatId);
  const vetoWorthy = hostile
    || (level === 'hard' && BENEFICIAL_TRICKS.has(handler) && played.playedByPlayerId === leader);
  const answers: GameCommand[] = [];
  for (const reaction of reactions) {
    const mine = handlerOfCard(reaction.cardId);
    if (mine === 'trick.boomerang' && hostile) answers.push(reaction.command);
    if (mine === 'trick.veto' && vetoWorthy) answers.push(reaction.command);
  }
  answers.push(pass);
  return answers;
}


export function auctionDecision(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  level: Level,
): readonly GameCommand[] {
  const pass: GameCommand = { type: 'PassAuction', interactionId: prompt.interactionId };
  const floor = auctionFloor(prompt, seatId);
  if (floor === null || floor.leading || level === 'easy') return [pass];
  const held = totalOf(heldBy(view, seatId));
  const willing = level === 'medium'
    ? (held >= 8 ? floor.floor : -1)
    : (floor.floor <= Math.min(4, held - 3) ? floor.floor : -1);
  if (willing < floor.floor || willing > held) return [pass];
  const bid = bidCommand(view, seatId, prompt, willing);
  return bid === null ? [pass] : [bid, pass];
}

/* --------------------------------------------------------------- the trades */

export function tradeDecision(view: PlayerView, seatId: string, actions: ActionCandidates, level: Level): readonly GameCommand[] {
  const out: GameCommand[] = [];
  for (const trade of actions.trades) {
    const offer = trade.offer;
    // The offer is written from the proposer's side: what they give is what this seat
    // receives, and what they receive is what this seat gives.
    const givesCards = offer.receiveTrickIds.length > 0;
    const projected = afterResources(
      afterResources(view, seatId, offer.giveResources),
      seatId,
      negate(offer.receiveResources),
    );
    const accept = level === 'hard' && !givesCards && gain(view, seatId, projected) >= 0
      && RESOURCE_ORDER.every((resource) => actions.held[resource] >= offer.receiveResources[resource]);
    out.push(accept ? trade.accept : trade.reject);
    out.push(accept ? trade.reject : trade.accept);
  }
  return out;
}

/* ------------------------------------------------------------- the ranking */

/** Shuffle for ties, then a stable sort by value, best first. Drops nothing. */
export function ranked(entries: readonly Scored[], random: Random): readonly Scored[] {
  return shuffled(entries, random).sort((left, right) => right.delta - left.delta);
}

/** Every legal group placement for the due groups, then the discard. */
export function dueGroupCommands(view: PlayerView, seatId: string, actions: ActionCandidates, endgame: boolean): readonly GameCommand[] {
  const out: GameCommand[] = [];
  for (const group of actions.dueGroups) {
    const slots = scoredSlots(view, seatId, group, endgame);
    if (slots.length === group.count) {
      out.push({ type: 'PlaceVoterGroup', groupId: group.id, slotIds: [...slots] });
    }
  }
  if (actions.discard !== null) out.push(actions.discard);
  return out;
}

/**
 * The action window for the medium and hard policies.
 *
 * Debts and obligations first, then due groups, then resource fixes that unlock a
 * purchase, then purchases in the brief's order, then every other candidate by evaluated
 * value, then the end of the turn. Nothing with a non-positive value is offered before the
 * end of the turn.
 */
export function decideActions(view: PlayerView, seatId: string, random: Random, level: Level): readonly GameCommand[] {
  const actions = enumerateActions(view, seatId);
  const endgame = level === 'hard';
  const out: GameCommand[] = [...actions.obligations, ...actions.debts];
  if (actions.dueGroups.length > 0) {
    out.push(...dueGroupCommands(view, seatId, actions, endgame));
    return out;
  }

  const fixes = ranked([
    ...arbitrageCandidates(view, seatId, actions),
    ...shakedownCandidates(view, seatId, actions, level === 'hard' ? 'leader' : 'richest'),
  ], random);
  out.push(...fixes.map((entry) => entry.command));

  const purchases = planPurchases(view, seatId, actions, endgame).filter((entry) => entry.delta > 0);
  out.push(...purchases.map((entry) => entry.command));
  if (purchases.length === 0) out.push(...matchMustEnd(view, seatId, actions));

  const rest = ranked([
    ...moveCandidates(view, seatId, actions, level),
    ...removalCandidates(view, seatId, actions, level),
    ...outreachCandidates(view, seatId, actions, level),
    ...trickPurchase(view, seatId, actions, level),
    ...trickPlays(view, seatId, actions, level),
  ], random).filter((entry) => entry.delta > 0);
  out.push(...rest.map((entry) => entry.command));

  if (actions.endTurn) out.push({ type: 'RequestEndTurn' });
  return out;
}

/**
 * The purchase that keeps a finished position moving, when this seat has no zone left to
 * win.
 *
 * A board where every zone this seat could still take is decided or full has nothing a
 * placement can improve, and a policy that only ever buys for a positive value would end
 * every turn forever while the last empty areas stayed empty. The engine ends such a match
 * only when the board fills, so the cheapest affordable card is bought and placed where
 * the score says, or discarded when no area fits, until it does. Every seat at the table
 * plays the same rule, so the match ends the way the rules say rather than by refusal.
 */
export function matchMustEnd(view: PlayerView, seatId: string, actions: ActionCandidates): readonly GameCommand[] {
  const canStillWin = view.zones.some((zone) =>
    zone.majorityOwnerId === undefined
    && (zone.counts[seatId] ?? 0) + emptySlotsIn(view, zone.id) >= zone.majorityThreshold);
  if (canStillWin) return [];
  if (!view.slots.some((slot) => slot.voter === undefined)) return [];
  const cheapest = [...actions.purchases].sort((left, right) => printedTotal(left.cost) - printedTotal(right.cost))[0];
  if (cheapest === undefined) return [];
  return [{
    type: 'InfluenceVoterCard',
    cardId: cheapest.cardId,
    payment: { resources: cheapest.payment, discounts: { ...NO_RESOURCES } },
  }];
}

export function evaluateFor(view: PlayerView, seatId: string): number {
  return evaluate(view, seatId);
}

